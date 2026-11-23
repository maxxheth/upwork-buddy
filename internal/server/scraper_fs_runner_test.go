package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestScraperFSRunner_BuildArgs(t *testing.T) {
	r := NewScraperFSRunner(ScraperFSConfig{Dir: t.TempDir()})
	perPage := 20
	bMin := 500
	bMax := 5000
	pv := true
	cfg := DiscoveryConfig{
		ScraperFSProfile:    "profiles/golang.yaml",
		Query:               "golang",
		Queries:             []string{"golang", "rust"},
		Sort:                "recency",
		PerPage:             &perPage,
		MaxPages:            2,
		ScraperFSAdapter:    "flaresolverr",
		ScraperFSProxyMode:  "rotation",
		ContractType:        "fixed",
		BudgetMin:           &bMin,
		BudgetMax:           &bMax,
		PaymentVerifiedOnly: &pv,
	}

	gotPy := r.BuildArgs(cfg, false)
	wantPy := []string{
		"-m", "src.main", "--json-stdout", "--no-save",
		"--config", "profiles/golang.yaml",
		"--queries", "golang,rust",
		"--sort", "recency",
		"--per-page", "20",
		"--max-pages", "2",
		"--adapter", "flaresolverr",
		"--proxy-mode", "rotation",
		"--contract-type", "fixed",
		"--budget-min", "500",
		"--budget-max", "5000",
		"--payment-verified-only",
	}
	if !reflect.DeepEqual(gotPy, wantPy) {
		t.Fatalf("python args mismatch:\ngot:  %v\nwant: %v", gotPy, wantPy)
	}

	gotUV := r.BuildArgs(DiscoveryConfig{Query: "python"}, true)
	wantUV := []string{"run", "python", "-m", "src.main", "--json-stdout", "--no-save", "--query", "python"}
	if !reflect.DeepEqual(gotUV, wantUV) {
		t.Fatalf("uv args mismatch:\ngot:  %v\nwant: %v", gotUV, wantUV)
	}
}

func TestScraperFSRunner_Availability(t *testing.T) {
	missingDir := filepath.Join(t.TempDir(), "does-not-exist")
	rMissing := NewScraperFSRunner(ScraperFSConfig{Dir: missingDir})
	ok, _, reason := rMissing.CheckScraperFSAvailability()
	if ok || reason == "" {
		t.Fatalf("expected unavailable for missing dir, got ok=%v reason=%q", ok, reason)
	}

	dir := t.TempDir()
	venvBin := filepath.Join(dir, ".venv", "bin")
	if err := os.MkdirAll(venvBin, 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	pyPath := filepath.Join(venvBin, "python")
	if err := os.WriteFile(pyPath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write python failed: %v", err)
	}
	rVenv := NewScraperFSRunner(ScraperFSConfig{Dir: dir})
	ok, gotDir, reason := rVenv.CheckScraperFSAvailability()
	if !ok || gotDir != dir || reason != "" {
		t.Fatalf("expected available with .venv/bin/python, got ok=%v dir=%q reason=%q", ok, gotDir, reason)
	}

	// Test uv fallback when .venv does not exist.
	dirNoVenv := t.TempDir()
	rUV := NewScraperFSRunner(ScraperFSConfig{Dir: dirNoVenv})
	rUV.lookPath = func(file string) (string, error) {
		if file == "uv" {
			return "/usr/local/bin/uv", nil
		}
		return "", errors.New("not found")
	}
	ok, _, reason = rUV.CheckScraperFSAvailability()
	if !ok || reason != "" {
		t.Fatalf("expected available via uv fallback, got ok=%v reason=%q", ok, reason)
	}
}

func TestScraperFSRunner_RunAndFieldMapping(t *testing.T) {
	dir := t.TempDir()
	r := NewScraperFSRunner(ScraperFSConfig{Dir: dir, PythonBin: "uv"})
	r.lookPath = func(file string) (string, error) { return "/usr/bin/uv", nil }

	var capturedBin string
	var capturedArgs []string
	r.execFn = func(_ context.Context, _ string, bin string, args []string) ([]byte, []byte, error) {
		capturedBin = bin
		capturedArgs = args
		payload := `{
			"ok": true,
			"query": "golang",
			"total_found": 1,
			"elapsed_seconds": 1.25,
			"errors": [],
			"jobs": [{
				"title": "Senior Go Backend Engineer",
				"url": "https://www.upwork.com/jobs/Go-Backend_~01abcDEF123456/",
				"upwork_job_id": "~01abcDEF123456",
				"description": "Build Go microservices and Postgres APIs.",
				"budget": "$4,000",
				"hourly_rate": "$80-$110",
				"experience_level": "Expert",
				"duration": "3 to 6 months",
				"skills": ["Go", "PostgreSQL"],
				"posted": "5 minutes ago",
				"country": "United States",
				"proposals": "Less than 5",
				"proposals_count": 3,
				"client_rating": 4.95,
				"client_reviews": 22,
				"client_hires": 15,
				"client_spent": "$50K+"
			}]
		}`
		return []byte(payload), nil, nil
	}

	reqs, out, err := r.Run(context.Background(), DiscoveryConfig{Query: "golang"})
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if capturedBin != "/usr/bin/uv" || len(capturedArgs) < 3 || capturedArgs[0] != "run" {
		t.Fatalf("unexpected exec call: bin=%q args=%v", capturedBin, capturedArgs)
	}
	if out == nil || out.TotalFound != 1 || len(reqs) != 1 {
		t.Fatalf("unexpected output: out=%+v reqs=%d", out, len(reqs))
	}
	job := reqs[0]
	if job.UpworkJobID != "~01abcDEF123456" || job.JobTitle != "Senior Go Backend Engineer" ||
		job.RateRange != "$80-$110" || job.PostedText != "5 minutes ago" ||
		job.ClientCountry != "United States" || job.ProposalsTier != "Less than 5" ||
		job.Source != "upwork-scraper-fs" || len(job.Skills.Slice) != 2 {
		t.Fatalf("unexpected mapped saveJobRequest: %+v", job)
	}
}

func TestScraperFSRunner_ErrorClassification(t *testing.T) {
	dir := t.TempDir()
	r := NewScraperFSRunner(ScraperFSConfig{Dir: dir, PythonBin: "uv"})
	r.lookPath = func(file string) (string, error) { return "/usr/bin/uv", nil }

	cases := []struct {
		name     string
		stdout   string
		stderr   string
		runErr   error
		wantCode string
	}{
		{
			name:     "rate_limited",
			stdout:   `{"ok":false,"errors":["HTTP 429 Too Many Requests"]}`,
			runErr:   errors.New("exit status 1"),
			wantCode: "RATE_LIMITED",
		},
		{
			name:     "cloudflare",
			stdout:   `{"ok":false,"errors":["Cloudflare Turnstile challenge detected"]}`,
			runErr:   errors.New("exit status 1"),
			wantCode: "CLOUDFLARE_CHALLENGE",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r.execFn = func(_ context.Context, _ string, _ string, _ []string) ([]byte, []byte, error) {
				return []byte(tc.stdout), []byte(tc.stderr), tc.runErr
			}
			_, _, err := r.Run(context.Background(), DiscoveryConfig{Query: "go"})
			var se *ServiceError
			if !errors.As(err, &se) || se.Code != tc.wantCode {
				t.Fatalf("expected ServiceError %q, got %v", tc.wantCode, err)
			}
		})
	}
}

func TestScraperFSRunner_TimeoutAndBoundedOutput(t *testing.T) {
	dir := t.TempDir()
	r := NewScraperFSRunner(ScraperFSConfig{Dir: dir, PythonBin: "uv", TimeoutSeconds: 1})
	r.lookPath = func(file string) (string, error) { return "/usr/bin/uv", nil }

	// 1. Timeout classification -> SCRAPER_FS_TIMEOUT (504)
	r.execFn = func(ctx context.Context, _ string, _ string, _ []string) ([]byte, []byte, error) {
		<-ctx.Done()
		return nil, []byte(strings.Repeat("x", 2048)), ctx.Err()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	_, _, err := r.Run(ctx, DiscoveryConfig{Query: "go"})
	var se *ServiceError
	if !errors.As(err, &se) || se.Code != "SCRAPER_FS_TIMEOUT" || se.HTTPStatus != http.StatusGatewayTimeout {
		t.Fatalf("expected SCRAPER_FS_TIMEOUT (504), got %v", err)
	}
	if len(se.Message) > 1200 {
		t.Fatalf("expected truncated stderr snippet in error message, got len=%d", len(se.Message))
	}

	// 2. Bounded buffer overflow
	b := &boundedBuffer{limit: 16, failOnCap: true}
	if _, wErr := b.Write([]byte("0123456789abcdef0123")); !errors.Is(wErr, errScraperFSStdoutOverflow) || !b.overflowed {
		t.Fatalf("expected errScraperFSStdoutOverflow, got wErr=%v overflowed=%v", wErr, b.overflowed)
	}
}
