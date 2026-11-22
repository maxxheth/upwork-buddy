package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	dbservice "upwork-buddy/internal/database/service"
)

func TestDefaultProposalVisibility(t *testing.T) {
	cases := []struct {
		group string
		want  string
	}{
		{"marvenio", "anonymized"},
		{"Marvenio", "anonymized"},
		{"  brandon-johnson-ventures ", "anonymized"},
		{"BRANDON-JOHNSON-VENTURES", "anonymized"},
		{"edfx-labs", "public"},
		{"standalone", "public"},
		{"", "public"},
	}
	for _, tc := range cases {
		if got := DefaultProposalVisibility(tc.group); got != tc.want {
			t.Errorf("DefaultProposalVisibility(%q) = %q, want %q", tc.group, got, tc.want)
		}
	}
}

func TestSanitizedActiveProjectDisplay(t *testing.T) {
	tech, _ := json.Marshal([]string{"Go", "PostgreSQL", "Docker", "React", "TypeScript", "Redis"})

	t.Run("private project is excluded", func(t *testing.T) {
		p := dbservice.ActiveProject{
			Name:               "SecretVault",
			ProposalVisibility: "private",
			Summary:            "Internal tool",
		}
		_, _, _, ok := SanitizedActiveProjectDisplay(p)
		if ok {
			t.Fatalf("expected ok=false for private project")
		}
	})

	t.Run("anonymized project with empty alias and summary uses safe fallbacks", func(t *testing.T) {
		p := dbservice.ActiveProject{
			Name:               "MarvenioCore",
			Client:             "Marvenio Inc",
			Path:               "/var/www/marvenio/core-api",
			GroupName:          "marvenio",
			ProposalVisibility: "anonymized",
			TechStackJSON:      dbservice.JSONB(tech),
			ReadmeHint:         "MarvenioCore secret readme",
			LastCommitSubject:  "fix: Marvenio billing webhook",
		}
		name, summary, focus, ok := SanitizedActiveProjectDisplay(p)
		if !ok {
			t.Fatalf("expected ok=true for anonymized project")
		}
		if focus != "" {
			t.Fatalf("expected empty safeRecentFocus for anonymized project, got %q", focus)
		}
		if name != "Active client project (Go, PostgreSQL, Docker)" {
			t.Fatalf("unexpected displayName: %q", name)
		}
		if summary != "Ongoing client engineering engagement using Go, PostgreSQL, Docker, React, TypeScript" {
			t.Fatalf("unexpected safeSummary: %q", summary)
		}
		combined := strings.ToLower(name + " " + summary + " " + focus)
		for _, forbidden := range []string{"marvenio", "core-api", "billing webhook", "secret readme"} {
			if strings.Contains(combined, forbidden) {
				t.Fatalf("anonymized output leaked %q: %q", forbidden, combined)
			}
		}
	})

	t.Run("anonymized project strips accidental sensitive tokens and handles UTF-8 safely", func(t *testing.T) {
		p := dbservice.ActiveProject{
			ProjectKey:         "brandon-johnson-ventures/bjv-portal",
			Name:               "BJVPortal",
			Client:             "brandon-johnson-ventures",
			Path:               "/var/www/brandon-johnson-ventures/bjv-portal",
			GroupName:          "brandon-johnson-ventures",
			ProposalVisibility: "anonymized",
			PublicAlias:        "B2B SaaS Analytics Platform",
			Summary:            "İstanbul BJVPortal for Brandon Johnson Ventures (brandon-johnson-ventures/bjv-portal) at /var/www/brandon-johnson-ventures/bjv-portal with Go.",
			LastCommitSubject:  "deploy BJVPortal prod",
		}
		name, summary, focus, ok := SanitizedActiveProjectDisplay(p)
		if !ok {
			t.Fatalf("expected ok=true")
		}
		if name != "B2B SaaS Analytics Platform" {
			t.Fatalf("unexpected displayName: %q", name)
		}
		if focus != "" {
			t.Fatalf("expected empty focus, got %q", focus)
		}
		lowerSummary := strings.ToLower(summary)
		for _, forbidden := range []string{"bjvportal", "brandon johnson ventures", "brandon-johnson-ventures", "/var/www"} {
			if strings.Contains(lowerSummary, forbidden) {
				t.Fatalf("anonymized summary leaked %q: %q", forbidden, summary)
			}
		}
		if !strings.Contains(summary, "İstanbul") {
			t.Fatalf("expected UTF-8 prefix preserved cleanly, got %q", summary)
		}
	})

	t.Run("public project exposes public details", func(t *testing.T) {
		p := dbservice.ActiveProject{
			Name:               "upwork-buddy",
			ProposalVisibility: "public",
			ReadmeHint:         "Local-first Go + Chrome extension Upwork copilot",
			LastCommitSubject:  "feat: active projects inventory",
		}
		name, summary, focus, ok := SanitizedActiveProjectDisplay(p)
		if !ok {
			t.Fatalf("expected ok=true")
		}
		if name != "upwork-buddy" {
			t.Fatalf("got name=%q", name)
		}
		if summary != "Local-first Go + Chrome extension Upwork copilot" {
			t.Fatalf("got summary=%q", summary)
		}
		if focus != "feat: active projects inventory" {
			t.Fatalf("got focus=%q", focus)
		}
	})
}

func TestActiveProjectsHTTPValidation_NoDB(t *testing.T) {
	s := &Server{apiToken: "test-token"}
	router := s.RegisterRoutes()

	req := httptest.NewRequest(http.MethodGet, "/api/active-projects?limit=abc", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid limit, got %d (%s)", rec.Code, rec.Body.String())
	}

	body := bytes.NewBufferString(`{"projects":[{"project_key":"p1","name":"P1","proposal_visibility":"bogus"}]}`)
	reqSync := httptest.NewRequest(http.MethodPost, "/api/active-projects/sync", body)
	reqSync.Header.Set("Authorization", "Bearer test-token")
	recSync := httptest.NewRecorder()
	router.ServeHTTP(recSync, reqSync)
	if recSync.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without DB, got %d (%s)", recSync.Code, recSync.Body.String())
	}
}

func TestActiveProjects_SyncPreserveFilterUpdate_DB(t *testing.T) {
	s := setupTestServer(t)
	ctx := context.Background()
	router := s.RegisterRoutes()

	now := time.Now().UTC().Truncate(time.Millisecond)
	earlier := now.Add(-2 * time.Hour)
	later := now.Add(2 * time.Hour)

	// 1. Invalid proposal_visibility via HTTP returns 400
	badBody := bytes.NewBufferString(`{"projects":[{"project_key":"bad","name":"Bad","proposal_visibility":"invalid_vis"}]}`)
	badReq := httptest.NewRequest(http.MethodPost, "/api/active-projects/sync", badBody)
	if s.apiToken != "" {
		badReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	}
	badRec := httptest.NewRecorder()
	router.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid proposal_visibility, got %d: %s", badRec.Code, badRec.Body.String())
	}

	// 2. Initial bulk sync: marvenio defaults to anonymized, edfx-labs defaults to public
	syncPayload := SyncActiveProjectsRequest{
		Projects: []SyncActiveProjectItem{
			{
				ProjectKey:        "marvenio/core-api",
				Slug:              "core-api",
				Name:              "Core API",
				Path:              "/var/www/marvenio/core-api",
				Group:             "marvenio", // tests "group" alias
				ActivityTier:      "active",
				TechStack:         []string{"Go", "PostgreSQL"},
				ReadmeHint:        "Marvenio backend",
				IsGitRepo:         true,
				GitBranch:         "main",
				Commits7d:         12,
				LastCommitSubject: "feat: billing",
				LastActivityAt:    &earlier,
			},
			{
				ProjectKey:        "edfx-labs/upwork-buddy",
				Slug:              "upwork-buddy",
				Name:              "upwork-buddy",
				Path:              "/var/www/upwork-buddy",
				GroupName:         "edfx-labs",
				ActivityTier:      "recent",
				TechStack:         []string{"Go", "TypeScript"},
				Summary:           "Upwork automation copilot",
				LastActivityAt:    &now,
				CuratedUpdatedAt:  &now,
				CuratedUpdatedBy:  "scanner",
			},
		},
	}
	res, err := s.SyncActiveProjects(ctx, syncPayload)
	if err != nil {
		t.Fatalf("SyncActiveProjects failed: %v", err)
	}
	if res.Created != 2 || res.Updated != 0 || res.Synced != 2 {
		t.Fatalf("unexpected sync counts: %+v", res)
	}

	// 3. Update curated fields on marvenio/core-api via PATCH /api/active-projects/{id}
	patchBody := bytes.NewBufferString(`{
		"summary": "High-throughput Go microservice",
		"public_alias": "Fintech API Platform",
		"pinned": true,
		"next_actions": ["Ship v2", "Add metrics"],
		"blockers": ["Waiting on QA"],
		"notes": "Keep anonymized"
	}`)
	patchReq := httptest.NewRequest(http.MethodPatch, "/api/active-projects/core-api", patchBody)
	if s.apiToken != "" {
		patchReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	}
	patchRec := httptest.NewRecorder()
	router.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("PATCH /api/active-projects/core-api failed: %d %s", patchRec.Code, patchRec.Body.String())
	}

	// 4. Re-sync with older curated_updated_at: telemetry updates, curated fields preserved!
	res2, err := s.SyncActiveProjects(ctx, SyncActiveProjectsRequest{
		Projects: []SyncActiveProjectItem{
			{
				ProjectKey:        "marvenio/core-api",
				Slug:              "core-api",
				Name:              "Core API",
				Path:              "/var/www/marvenio/core-api",
				GroupName:         "marvenio",
				ActivityTier:      "active",
				ProposalVisibility: "public", // should NOT overwrite existing anonymized since older
				Summary:           "Stale summary",
				PublicAlias:       "Stale alias",
				NextActions:       []string{"Stale action"},
				Notes:             "Stale notes",
				Commits7d:         25, // telemetry MUST update
				GitBranch:         "release/v2",
				CuratedUpdatedAt:  &earlier,
			},
		},
	})
	if err != nil {
		t.Fatalf("re-sync failed: %v", err)
	}
	if res2.Updated != 1 || res2.Created != 0 {
		t.Fatalf("unexpected re-sync counts: %+v", res2)
	}
	got := res2.Projects[0]
	if got.Commits7d != 25 || got.GitBranch != "release/v2" {
		t.Fatalf("telemetry did not update: commits=%d branch=%q", got.Commits7d, got.GitBranch)
	}
	if got.Summary != "High-throughput Go microservice" || got.ProposalVisibility != "anonymized" || got.PublicAlias != "Fintech API Platform" || !got.Pinned {
		t.Fatalf("curated fields were overwritten on stale sync: %+v", got)
	}

	// 5. Re-sync with strictly newer curated_updated_at updates curated fields & explicit empty [] clears next_actions/blockers
	res3, err := s.SyncActiveProjects(ctx, SyncActiveProjectsRequest{
		Projects: []SyncActiveProjectItem{
			{
				ProjectKey:       "edfx-labs/upwork-buddy",
				Name:             "upwork-buddy",
				GroupName:        "edfx-labs",
				ActivityTier:     "active",
				Summary:          "Updated copilot summary",
				CuratedUpdatedAt: &later,
				CuratedUpdatedBy: "cli",
			},
			{
				ProjectKey:       "marvenio/core-api",
				Name:             "Core API",
				GroupName:        "marvenio",
				ActivityTier:     "active",
				NextActions:      []string{},
				Blockers:         []string{},
				CuratedUpdatedAt: &later,
				CuratedUpdatedBy: "cli",
			},
		},
	})
	if err != nil {
		t.Fatalf("newer curated sync failed: %v", err)
	}
	if res3.Projects[0].Summary != "Updated copilot summary" {
		t.Fatalf("expected newer curated summary, got %q", res3.Projects[0].Summary)
	}
	if len(res3.Projects[1].NextActions) != 0 || len(res3.Projects[1].Blockers) != 0 {
		t.Fatalf("expected explicit empty slices on newer curated sync to clear DB values, got next=%v blockers=%v", res3.Projects[1].NextActions, res3.Projects[1].Blockers)
	}

	// 6. ListActiveProjects filtering & sorting (pinned first)
	all, err := s.ListActiveProjects(ctx, ListActiveProjectsFilter{})
	if err != nil {
		t.Fatalf("ListActiveProjects failed: %v", err)
	}
	if len(all) != 2 || all[0].ProjectKey != "marvenio/core-api" {
		t.Fatalf("expected pinned marvenio/core-api first, got %+v", all)
	}

	filtered, err := s.ListActiveProjects(ctx, ListActiveProjectsFilter{
		Visibility: "anonymized",
		Query:      "PostgreSQL",
	})
	if err != nil {
		t.Fatalf("filtered ListActiveProjects failed: %v", err)
	}
	if len(filtered) != 1 || filtered[0].ProjectKey != "marvenio/core-api" {
		t.Fatalf("unexpected filtered result: %+v", filtered)
	}

	// 7. Numeric ID bounds validation on PATCH /api/active-projects/{id}: 0 and > math.MaxInt64 -> 400 INVALID_PARAMS
	for _, badID := range []string{"0", "9223372036854775808", "18446744073709551615", "99999999999999999999999"} {
		badPatchReq := httptest.NewRequest(http.MethodPatch, "/api/active-projects/"+badID, strings.NewReader(`{"notes":"test"}`))
		if s.apiToken != "" {
			badPatchReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		}
		badPatchRec := httptest.NewRecorder()
		router.ServeHTTP(badPatchRec, badPatchReq)
		if badPatchRec.Code != http.StatusBadRequest {
			t.Fatalf("PATCH /api/active-projects/%s status = %d, want 400; body=%s", badID, badPatchRec.Code, badPatchRec.Body.String())
		}
		var errBody map[string]any
		_ = json.NewDecoder(badPatchRec.Body).Decode(&errBody)
		if errBody["error_code"] != "INVALID_PARAMS" {
			t.Fatalf("PATCH /api/active-projects/%s expected INVALID_PARAMS, got %+v", badID, errBody)
		}
	}
}
