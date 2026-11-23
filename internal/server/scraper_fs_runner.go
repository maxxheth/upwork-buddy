package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultScraperFSDir            = "/var/www/upwork-scraper-fs"
	defaultScraperFSTimeoutSeconds = 120
	maxScraperFSStdoutBytes        = 16 * 1024 * 1024
	maxScraperFSStderrBytes        = 64 * 1024
	maxScraperFSErrSnippetBytes    = 1024
)

var (
	scraperFSJobIDRegex        = regexp.MustCompile(`~[0-9a-zA-Z]+`)
	errScraperFSStdoutOverflow = errors.New("upwork-scraper-fs stdout exceeded 16 MiB limit")
)

// ScraperFSConfig configures how upwork-buddy invokes upwork-scraper-fs.
type ScraperFSConfig struct {
	Dir            string
	PythonBin      string
	TimeoutSeconds int
}

// DiscoveryConfig holds shared discovery parameters for both Chrome and scraper_fs backends.
type DiscoveryConfig struct {
	Source              string   `json:"source,omitempty"`
	Query               string   `json:"query,omitempty"`
	Queries             []string `json:"queries,omitempty"`
	Sort                string   `json:"sort,omitempty"`
	PerPage             *int     `json:"per_page,omitempty"`
	MaxPages            int      `json:"max_pages,omitempty"`
	ContractorTier      []int    `json:"contractor_tier,omitempty"`
	ContractType        string   `json:"contract_type,omitempty"`
	ProposalTiers       []string `json:"proposal_tiers,omitempty"`
	Amount              string   `json:"amount,omitempty"`
	BudgetMin           *int     `json:"budget_min,omitempty"`
	BudgetMax           *int     `json:"budget_max,omitempty"`
	HourlyRateMin       *float64 `json:"hourly_rate_min,omitempty"`
	HourlyRateMax       *float64 `json:"hourly_rate_max,omitempty"`
	PaymentVerifiedOnly *bool    `json:"payment_verified_only,omitempty"`
	Category            string   `json:"category,omitempty"`
	SearchURL           string   `json:"search_url,omitempty"`
	FromActiveProjects  bool     `json:"from_active_projects,omitempty"`
	ActiveProjectKeys   []string `json:"active_project_keys,omitempty"`
	ActiveProjectTiers  []string `json:"active_project_tiers,omitempty"`
	ScraperFSProfile    string   `json:"scraper_fs_profile,omitempty"`
	ScraperFSAdapter    string   `json:"scraper_fs_adapter,omitempty"`
	ScraperFSProxyMode  string   `json:"scraper_fs_proxy_mode,omitempty"`
}

// UnmarshalJSON decodes DiscoveryConfig while accepting legacy "adapter" / "proxy_mode" keys.
func (d *DiscoveryConfig) UnmarshalJSON(data []byte) error {
	type discoveryConfigAlias DiscoveryConfig
	var raw struct {
		discoveryConfigAlias
		LegacyAdapter   string `json:"adapter,omitempty"`
		LegacyProxyMode string `json:"proxy_mode,omitempty"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	*d = DiscoveryConfig(raw.discoveryConfigAlias)
	if strings.TrimSpace(d.ScraperFSAdapter) == "" && strings.TrimSpace(raw.LegacyAdapter) != "" {
		d.ScraperFSAdapter = raw.LegacyAdapter
	}
	if strings.TrimSpace(d.ScraperFSProxyMode) == "" && strings.TrimSpace(raw.LegacyProxyMode) != "" {
		d.ScraperFSProxyMode = raw.LegacyProxyMode
	}
	return nil
}

// ScraperFSOutput mirrors the JSON object emitted on stdout by upwork-scraper-fs --json-stdout.
type ScraperFSOutput struct {
	OK             bool           `json:"ok"`
	Query          string         `json:"query"`
	TotalFound     int            `json:"total_found"`
	ElapsedSeconds float64        `json:"elapsed_seconds"`
	Errors         []string       `json:"errors"`
	Jobs           []ScraperFSJob `json:"jobs"`
}

// ScraperFSJob represents a single job item emitted by upwork-scraper-fs --json-stdout.
type ScraperFSJob struct {
	Title           string   `json:"title"`
	URL             string   `json:"url"`
	UpworkJobID     string   `json:"upwork_job_id"`
	Description     string   `json:"description"`
	Budget          *string  `json:"budget"`
	HourlyRate      *string  `json:"hourly_rate"`
	ExperienceLevel *string  `json:"experience_level"`
	Duration        *string  `json:"duration"`
	Skills          []string `json:"skills"`
	Posted          *string  `json:"posted"`
	Country         *string  `json:"country"`
	Proposals       *string  `json:"proposals"`
	ProposalsCount  *int     `json:"proposals_count"`
	ClientRating    *float64 `json:"client_rating"`
	ClientReviews   *int     `json:"client_reviews"`
	ClientHires     *int     `json:"client_hires"`
	ClientSpent     *string  `json:"client_spent"`
	ScrapedAt       string   `json:"scraped_at"`
}

// ScraperFSExecFunc executes a subprocess in dir and returns stdout, stderr, and error.
type ScraperFSExecFunc func(ctx context.Context, dir, bin string, args []string) (stdout []byte, stderr []byte, err error)

// ScraperFSRunner executes upwork-scraper-fs and maps results into saveJobRequest slices.
type ScraperFSRunner struct {
	cfg      ScraperFSConfig
	execFn   ScraperFSExecFunc
	lookPath func(file string) (string, error)
}

// LoadScraperFSConfigFromEnv reads SCRAPER_FS_* environment variables with defaults.
func LoadScraperFSConfigFromEnv() ScraperFSConfig {
	dir := strings.TrimSpace(os.Getenv("SCRAPER_FS_DIR"))
	if dir == "" {
		dir = defaultScraperFSDir
	}
	pyBin := strings.TrimSpace(os.Getenv("SCRAPER_FS_PYTHON_BIN"))
	timeout := defaultScraperFSTimeoutSeconds
	if raw := strings.TrimSpace(os.Getenv("SCRAPER_FS_TIMEOUT_SECONDS")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			timeout = parsed
		}
	}
	return ScraperFSConfig{
		Dir:            dir,
		PythonBin:      pyBin,
		TimeoutSeconds: timeout,
	}
}

// NewScraperFSRunner constructs a ScraperFSRunner with default env config.
func NewScraperFSRunner(cfg ScraperFSConfig) *ScraperFSRunner {
	if strings.TrimSpace(cfg.Dir) == "" {
		cfg.Dir = defaultScraperFSDir
	}
	if cfg.TimeoutSeconds <= 0 {
		cfg.TimeoutSeconds = defaultScraperFSTimeoutSeconds
	}
	return &ScraperFSRunner{
		cfg:      cfg,
		execFn:   defaultScraperFSExec,
		lookPath: exec.LookPath,
	}
}

type boundedBuffer struct {
	buf        bytes.Buffer
	limit      int
	failOnCap  bool
	overflowed bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.limit <= 0 {
		return b.buf.Write(p)
	}
	remaining := b.limit - b.buf.Len()
	if remaining <= 0 {
		b.overflowed = true
		if b.failOnCap {
			return 0, errScraperFSStdoutOverflow
		}
		return len(p), nil
	}
	if len(p) > remaining {
		_, _ = b.buf.Write(p[:remaining])
		b.overflowed = true
		if b.failOnCap {
			return remaining, errScraperFSStdoutOverflow
		}
		return len(p), nil
	}
	return b.buf.Write(p)
}

func defaultScraperFSExec(ctx context.Context, dir, bin string, args []string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.WaitDelay = 5 * time.Second
	stdoutBuf := &boundedBuffer{limit: maxScraperFSStdoutBytes, failOnCap: true}
	stderrBuf := &boundedBuffer{limit: maxScraperFSStderrBytes, failOnCap: false}
	cmd.Stdout = stdoutBuf
	cmd.Stderr = stderrBuf
	err := cmd.Run()
	if stdoutBuf.overflowed {
		return nil, stderrBuf.buf.Bytes(), errScraperFSStdoutOverflow
	}
	return stdoutBuf.buf.Bytes(), stderrBuf.buf.Bytes(), err
}

func (r *ScraperFSRunner) resolveBinary() (string, bool, error) {
	if r == nil {
		return "", false, &ServiceError{Code: "SCRAPER_FS_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "scraper_fs runner not configured"}
	}
	dirInfo, err := os.Stat(r.cfg.Dir)
	if err != nil || !dirInfo.IsDir() {
		return "", false, &ServiceError{
			Code:       "SCRAPER_FS_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    fmt.Sprintf("SCRAPER_FS_DIR %q does not exist or is not a directory", r.cfg.Dir),
		}
	}

	lookPath := r.lookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}

	if py := strings.TrimSpace(r.cfg.PythonBin); py != "" {
		isUV := filepath.Base(py) == "uv"
		if filepath.IsAbs(py) || strings.ContainsRune(py, filepath.Separator) {
			info, statErr := os.Stat(py)
			if statErr != nil || info.IsDir() {
				return "", isUV, &ServiceError{
					Code:       "SCRAPER_FS_UNAVAILABLE",
					HTTPStatus: http.StatusServiceUnavailable,
					Message:    fmt.Sprintf("SCRAPER_FS_PYTHON_BIN %q not found", py),
				}
			}
			return py, isUV, nil
		}
		resolved, lookErr := lookPath(py)
		if lookErr != nil {
			return "", isUV, &ServiceError{
				Code:       "SCRAPER_FS_UNAVAILABLE",
				HTTPStatus: http.StatusServiceUnavailable,
				Message:    fmt.Sprintf("SCRAPER_FS_PYTHON_BIN %q not found in PATH", py),
			}
		}
		return resolved, isUV, nil
	}

	for _, rel := range []string{
		filepath.Join(".venv", "bin", "python"),
		filepath.Join(".venv", "bin", "python3"),
	} {
		candidate := filepath.Join(r.cfg.Dir, rel)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate, false, nil
		}
	}

	if uvPath, lookErr := lookPath("uv"); lookErr == nil && uvPath != "" {
		return uvPath, true, nil
	}

	return "", false, &ServiceError{
		Code:       "SCRAPER_FS_UNAVAILABLE",
		HTTPStatus: http.StatusServiceUnavailable,
		Message:    fmt.Sprintf("neither %s/.venv/bin/python nor uv was found", r.cfg.Dir),
	}
}

// CheckScraperFSAvailability checks whether SCRAPER_FS_DIR and a python/uv binary exist.
func (r *ScraperFSRunner) CheckScraperFSAvailability() (bool, string, string) {
	if r == nil {
		return false, defaultScraperFSDir, "scraper_fs runner not configured"
	}
	_, _, err := r.resolveBinary()
	if err != nil {
		return false, r.cfg.Dir, err.Error()
	}
	return true, r.cfg.Dir, ""
}

// CheckScraperFSAvailability checks availability using environment configuration.
func CheckScraperFSAvailability() (bool, string, string) {
	return NewScraperFSRunner(LoadScraperFSConfigFromEnv()).CheckScraperFSAvailability()
}

// BuildArgs constructs the explicit CLI argument slice for upwork-scraper-fs without shell interpolation.
func (r *ScraperFSRunner) BuildArgs(cfg DiscoveryConfig, isUV bool) []string {
	var args []string
	if isUV {
		args = append(args, "run", "python")
	}
	args = append(args, "-m", "src.main", "--json-stdout", "--no-save")

	if profile := strings.TrimSpace(cfg.ScraperFSProfile); profile != "" {
		args = append(args, "--config", profile)
	}

	var queries []string
	if q := strings.TrimSpace(cfg.Query); q != "" {
		queries = append(queries, q)
	}
	for _, q := range cfg.Queries {
		q = strings.TrimSpace(q)
		if q == "" {
			continue
		}
		dup := false
		for _, existing := range queries {
			if strings.EqualFold(existing, q) {
				dup = true
				break
			}
		}
		if !dup {
			queries = append(queries, q)
		}
	}
	if len(queries) == 1 {
		args = append(args, "--query", queries[0])
	} else if len(queries) > 1 {
		args = append(args, "--queries", strings.Join(queries, ","))
	}

	if sort := strings.TrimSpace(cfg.Sort); sort != "" {
		args = append(args, "--sort", sort)
	}
	if cfg.PerPage != nil && *cfg.PerPage > 0 {
		args = append(args, "--per-page", strconv.Itoa(*cfg.PerPage))
	}
	if cfg.MaxPages > 0 {
		args = append(args, "--max-pages", strconv.Itoa(cfg.MaxPages))
	}
	if adapter := strings.TrimSpace(cfg.ScraperFSAdapter); adapter != "" {
		args = append(args, "--adapter", adapter)
	}
	if proxyMode := strings.TrimSpace(cfg.ScraperFSProxyMode); proxyMode != "" {
		args = append(args, "--proxy-mode", proxyMode)
	}
	if ct := strings.TrimSpace(cfg.ContractType); ct != "" {
		args = append(args, "--contract-type", ct)
	}
	if cfg.BudgetMin != nil {
		args = append(args, "--budget-min", strconv.Itoa(*cfg.BudgetMin))
	}
	if cfg.BudgetMax != nil {
		args = append(args, "--budget-max", strconv.Itoa(*cfg.BudgetMax))
	}
	if cfg.PaymentVerifiedOnly != nil && *cfg.PaymentVerifiedOnly {
		args = append(args, "--payment-verified-only")
	}

	return args
}

// Run executes upwork-scraper-fs with the given DiscoveryConfig and returns mapped saveJobRequest items.
func (r *ScraperFSRunner) Run(ctx context.Context, cfg DiscoveryConfig) ([]saveJobRequest, *ScraperFSOutput, error) {
	bin, isUV, err := r.resolveBinary()
	if err != nil {
		return nil, nil, err
	}

	timeout := time.Duration(r.cfg.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Duration(defaultScraperFSTimeoutSeconds) * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	args := r.BuildArgs(cfg, isUV)
	execFn := r.execFn
	if execFn == nil {
		execFn = defaultScraperFSExec
	}

	stdout, stderr, runErr := execFn(runCtx, r.cfg.Dir, bin, args)

	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return nil, nil, classifyScraperFSError(runCtx.Err(), runErr, nil, stderr)
	}
	if errors.Is(runErr, errScraperFSStdoutOverflow) {
		return nil, nil, &ServiceError{
			Code:       "SCRAPER_FS_ERROR",
			HTTPStatus: http.StatusBadGateway,
			Message:    errScraperFSStdoutOverflow.Error(),
		}
	}

	var out ScraperFSOutput
	trimmedStdout := bytes.TrimSpace(stdout)
	if len(trimmedStdout) > 0 {
		if parseErr := json.Unmarshal(trimmedStdout, &out); parseErr != nil && runErr == nil {
			return nil, nil, classifyScraperFSError(runCtx.Err(), fmt.Errorf("invalid scraper_fs JSON output: %w", parseErr), nil, stderr)
		}
	}

	if runErr != nil || !out.OK {
		return nil, &out, classifyScraperFSError(runCtx.Err(), runErr, out.Errors, stderr)
	}

	reqs := make([]saveJobRequest, 0, len(out.Jobs))
	for _, j := range out.Jobs {
		reqs = append(reqs, mapScraperFSJobToSaveRequest(j))
	}
	return reqs, &out, nil
}

func mapScraperFSJobToSaveRequest(j ScraperFSJob) saveJobRequest {
	upworkID := strings.TrimSpace(j.UpworkJobID)
	if upworkID == "" && j.URL != "" {
		upworkID = scraperFSJobIDRegex.FindString(j.URL)
	}
	skills := make([]string, 0, len(j.Skills))
	for _, s := range j.Skills {
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			skills = append(skills, trimmed)
		}
	}
	return saveJobRequest{
		UpworkJobID:     upworkID,
		URL:             strings.TrimSpace(j.URL),
		JobTitle:        strings.TrimSpace(j.Title),
		JobDescription:  strings.TrimSpace(j.Description),
		Budget:          derefTrimmedString(j.Budget),
		RateRange:       derefTrimmedString(j.HourlyRate),
		ExperienceLevel: derefTrimmedString(j.ExperienceLevel),
		Duration:        derefTrimmedString(j.Duration),
		Skills: FlexibleSkills{
			Text:  strings.Join(skills, ", "),
			Slice: skills,
			Set:   len(skills) > 0,
		},
		PostedText:     derefTrimmedString(j.Posted),
		ClientCountry:  derefTrimmedString(j.Country),
		ProposalsTier:  derefTrimmedString(j.Proposals),
		ProposalsCount: j.ProposalsCount,
		ClientRating:   j.ClientRating,
		ClientReviews:  j.ClientReviews,
		ClientHires:    j.ClientHires,
		ClientSpent:    derefTrimmedString(j.ClientSpent),
		Source:         "upwork-scraper-fs",
	}
}

func derefTrimmedString(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

func classifyScraperFSError(ctxErr, runErr error, outputErrors []string, stderr []byte) error {
	var parts []string
	for _, e := range outputErrors {
		if trimmed := strings.TrimSpace(e); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	if s := strings.TrimSpace(string(stderr)); s != "" {
		if len(s) > maxScraperFSErrSnippetBytes {
			s = s[:maxScraperFSErrSnippetBytes] + "...[truncated]"
		}
		parts = append(parts, s)
	}
	if runErr != nil {
		parts = append(parts, runErr.Error())
	}
	combined := strings.Join(parts, "; ")
	lower := strings.ToLower(combined)

	switch {
	case errors.Is(ctxErr, context.DeadlineExceeded) || errors.Is(runErr, context.DeadlineExceeded):
		return &ServiceError{
			Code:       "SCRAPER_FS_TIMEOUT",
			HTTPStatus: http.StatusGatewayTimeout,
			Message:    "upwork-scraper-fs timed out: " + combined,
		}
	case strings.Contains(lower, "cloudflare") || strings.Contains(lower, "turnstile") || strings.Contains(lower, "captcha") || strings.Contains(lower, "challenge") || strings.Contains(lower, "http 403") || strings.Contains(lower, "status 403"):
		return &ServiceError{
			Code:       "CLOUDFLARE_CHALLENGE",
			HTTPStatus: http.StatusBadGateway,
			Message:    "upwork-scraper-fs blocked by Cloudflare challenge: " + combined,
		}
	case strings.Contains(lower, "429") || strings.Contains(lower, "rate limit") || strings.Contains(lower, "rate_limit") || strings.Contains(lower, "too many requests"):
		return &ServiceError{
			Code:       "RATE_LIMITED",
			HTTPStatus: http.StatusTooManyRequests,
			Message:    "upwork-scraper-fs rate limited: " + combined,
		}
	case strings.Contains(lower, "executable file not found") || strings.Contains(lower, "no such file or directory"):
		return &ServiceError{
			Code:       "SCRAPER_FS_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "upwork-scraper-fs unavailable: " + combined,
		}
	default:
		if combined == "" {
			combined = "upwork-scraper-fs execution failed"
		}
		return &ServiceError{
			Code:       "SCRAPER_FS_ERROR",
			HTTPStatus: http.StatusBadGateway,
			Message:    combined,
		}
	}
}
