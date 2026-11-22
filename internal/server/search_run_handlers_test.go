package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	dbservice "upwork-buddy/internal/database/service"
)

func TestSearchRunHandlers_NilDBValidationAndDashboardURL(t *testing.T) {
	s := &Server{}

	if _, _, err := s.ListSearchRuns(context.Background(), 20, 0); err == nil {
		t.Fatal("expected error from ListSearchRuns with nil db")
	}
	if _, err := s.GetSearchRun(context.Background(), 1); err == nil {
		t.Fatal("expected error from GetSearchRun with nil db")
	}

	// Nil DB HTTP checks
	wList := httptest.NewRecorder()
	s.listSearchRunsHandler(wList, httptest.NewRequest(http.MethodGet, "/api/search-runs", nil))
	if wList.Result().StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("listSearchRunsHandler nil DB status = %d, want 503", wList.Result().StatusCode)
	}

	wGet := httptest.NewRecorder()
	reqGet := httptest.NewRequest(http.MethodGet, "/api/search-runs/1", nil)
	reqGet.SetPathValue("id", "1")
	s.getSearchRunHandler(wGet, reqGet)
	if wGet.Result().StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("getSearchRunHandler nil DB status = %d, want 503", wGet.Result().StatusCode)
	}

	// Method checks
	wMethod := httptest.NewRecorder()
	s.listSearchRunsHandler(wMethod, httptest.NewRequest(http.MethodPost, "/api/search-runs", nil))
	if wMethod.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("listSearchRunsHandler POST status = %d, want 405", wMethod.Result().StatusCode)
	}

	wMethodGet := httptest.NewRecorder()
	s.getSearchRunHandler(wMethodGet, httptest.NewRequest(http.MethodDelete, "/api/search-runs/1", nil))
	if wMethodGet.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("getSearchRunHandler DELETE status = %d, want 405", wMethodGet.Result().StatusCode)
	}

	// Dashboard URL helper respects WEB_UI_ENABLED and port/host
	t.Setenv("WEB_UI_ENABLED", "true")
	t.Setenv("UPWORK_BUDDY_URL", "")
	t.Setenv("BUDDY_API_URL", "")
	t.Setenv("APP_HOST", "127.0.0.1")
	t.Setenv("APP_PORT", "9191")

	if got := (&Server{host: "127.0.0.1", port: 9095}).buildSearchRunDashboardURL(0); got != "" {
		t.Fatalf("expected empty dashboard URL for runID=0, got %q", got)
	}
	portSrv := &Server{host: "127.0.0.1", port: 9095}
	gotPortURL := portSrv.buildSearchRunDashboardURL(7)
	assertTicketedDashboardURL(t, portSrv, gotPortURL, "http://127.0.0.1:9095", "run", "7")

	fallbackSrv := &Server{}
	gotFallbackURL := fallbackSrv.buildSearchRunDashboardURL(12)
	assertTicketedDashboardURL(t, fallbackSrv, gotFallbackURL, "http://127.0.0.1:9191", "run", "12")

	t.Setenv("WEB_UI_ENABLED", "false")
	if got := (&Server{host: "127.0.0.1", port: 9095}).buildSearchRunDashboardURL(7); got != "" {
		t.Fatalf("expected empty dashboard URL when WEB_UI_ENABLED=false, got %q", got)
	}
}

func TestSearchRunHandlers_CRUDPaginationOrderingAndErrors_WithDB(t *testing.T) {
	s := setupTestServer(t)
	gormDB := s.db.GetGorm()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/search-runs", s.listSearchRunsHandler)
	mux.HandleFunc("GET /api/search-runs/{id}", s.getSearchRunHandler)

	// Invalid params -> 400 INVALID_PARAMS
	for _, path := range []string{
		"/api/search-runs?limit=0",
		"/api/search-runs?limit=-2",
		"/api/search-runs?limit=abc",
		"/api/search-runs?offset=-1",
		"/api/search-runs/0",
		"/api/search-runs/not-an-id",
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("GET %s status = %d, want 400 body=%s", path, w.Result().StatusCode, w.Body.String())
		}
		var errBody map[string]any
		_ = json.NewDecoder(w.Body).Decode(&errBody)
		if errBody["error_code"] != "INVALID_PARAMS" {
			t.Fatalf("GET %s expected error_code=INVALID_PARAMS, got %+v", path, errBody)
		}
	}

	// Nonexistent run -> 404 NOT_FOUND
	w404 := httptest.NewRecorder()
	mux.ServeHTTP(w404, httptest.NewRequest(http.MethodGet, "/api/search-runs/999999", nil))
	if w404.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("GET /api/search-runs/999999 status = %d, want 404", w404.Result().StatusCode)
	}

	// Seed 3 search runs with explicit timestamps and linked jobs
	t1 := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	t2 := time.Date(2026, 11, 20, 11, 0, 0, 0, time.UTC)
	t3 := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

	run1 := dbservice.SearchRun{
		Label:         "Run 1",
		Source:        "search",
		TriggeredBy:   "api",
		QueriesJSON:   dbservice.JSONB(`["golang"]`),
		TotalScraped:  2,
		FilteredCount: 2,
		PersistedCount: 2,
		StoppedReason: "completed",
		CreatedAt:     t1,
	}
	run2 := dbservice.SearchRun{
		Label:           "Run 2 Empty",
		Source:          "best_matches",
		TriggeredBy:     "ui",
		ProjectKeysJSON: dbservice.JSONB(`["proj-a"]`),
		QueriesJSON:     dbservice.JSONB(`["postgres"]`),
		StoppedReason:   "empty_page",
		CreatedAt:       t2,
	}
	run3 := dbservice.SearchRun{
		Label:         "Run 3 Latest",
		Source:        "search",
		TriggeredBy:   "mcp",
		QueriesJSON:   dbservice.JSONB(`["docker"]`),
		CriteriaJSON:  dbservice.JSONB(`{"hourly_rate_min":70}`),
		TotalScraped:  3,
		FilteredCount: 2,
		PersistedCount: 2,
		StoppedReason: "completed",
		CreatedAt:     t3,
	}
	for _, r := range []*dbservice.SearchRun{&run1, &run2, &run3} {
		if err := gormDB.Create(r).Error; err != nil {
			t.Fatalf("create search run: %v", err)
		}
	}

	scoreLow := 45
	scoreHigh := 92
	uidA := "~01runjobA"
	uidB := "~01runjobB"
	uidC := "~01runjobC"
	jobA := dbservice.Job{UpworkJobID: &uidA, Title: "Low Score Job", Score: &scoreLow, LastSearchRunID: &run1.ID}
	jobB := dbservice.Job{UpworkJobID: &uidB, Title: "High Score Shared Job", Score: &scoreHigh, LastSearchRunID: &run3.ID}
	jobC := dbservice.Job{UpworkJobID: &uidC, Title: "Unscored Job", Score: nil, LastSearchRunID: &run3.ID}
	for _, j := range []*dbservice.Job{&jobA, &jobB, &jobC} {
		if err := gormDB.Create(j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
	}

	links := []dbservice.SearchRunJob{
		{SearchRunID: run1.ID, JobID: jobA.ID},
		{SearchRunID: run1.ID, JobID: jobB.ID},
		{SearchRunID: run3.ID, JobID: jobB.ID},
		{SearchRunID: run3.ID, JobID: jobC.ID},
	}
	for _, link := range links {
		if err := gormDB.Create(&link).Error; err != nil {
			t.Fatalf("create search_run_job: %v", err)
		}
	}

	// List with pagination: limit=2&offset=1 -> returns [run2, run1] and total=3
	wList := httptest.NewRecorder()
	mux.ServeHTTP(wList, httptest.NewRequest(http.MethodGet, "/api/search-runs?limit=2&offset=1", nil))
	if wList.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/search-runs status = %d body=%s", wList.Result().StatusCode, wList.Body.String())
	}
	var listResp struct {
		SearchRuns []SearchRunSummary `json:"search_runs"`
		Total      int                `json:"total"`
	}
	if err := json.NewDecoder(wList.Body).Decode(&listResp); err != nil {
		t.Fatalf("decode listSearchRuns: %v", err)
	}
	if listResp.Total != 3 || len(listResp.SearchRuns) != 2 {
		t.Fatalf("expected total=3 & 2 runs, got total=%d len=%d", listResp.Total, len(listResp.SearchRuns))
	}
	if listResp.SearchRuns[0].ID != run2.ID || listResp.SearchRuns[1].ID != run1.ID {
		t.Fatalf("expected order [run2, run1], got [%d, %d]", listResp.SearchRuns[0].ID, listResp.SearchRuns[1].ID)
	}
	if listResp.SearchRuns[1].ProjectKeys == nil {
		t.Fatalf("expected non-nil ProjectKeys slice on SearchRunSummary")
	}

	// GetSearchRun for run3 -> ordered by score desc: jobB (92), then jobC (nil -> -1)
	wDetail3 := httptest.NewRecorder()
	mux.ServeHTTP(wDetail3, httptest.NewRequest(http.MethodGet, "/api/search-runs/"+uintToStr(run3.ID), nil))
	if wDetail3.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/search-runs/%d status = %d body=%s", run3.ID, wDetail3.Result().StatusCode, wDetail3.Body.String())
	}
	var detail3 SearchRunDetailResponse
	if err := json.NewDecoder(wDetail3.Body).Decode(&detail3); err != nil {
		t.Fatalf("decode detail3: %v", err)
	}
	if detail3.SearchRun.ID != run3.ID || len(detail3.Jobs) != 2 {
		t.Fatalf("expected run3 with 2 jobs, got %+v", detail3)
	}
	if detail3.Jobs[0].ID != jobB.ID || detail3.Jobs[1].ID != jobC.ID {
		t.Fatalf("expected jobs ordered [jobB(92), jobC(nil)], got [%d, %d]", detail3.Jobs[0].ID, detail3.Jobs[1].ID)
	}
	if detail3.Jobs[0].AIEnrichmentStatus != "none" {
		t.Fatalf("expected default ai_enrichment_status='none', got %q", detail3.Jobs[0].AIEnrichmentStatus)
	}

	// GetSearchRun for run2 (0 linked jobs) -> empty non-nil Jobs slice
	wDetail2 := httptest.NewRecorder()
	mux.ServeHTTP(wDetail2, httptest.NewRequest(http.MethodGet, "/api/search-runs/"+uintToStr(run2.ID), nil))
	if wDetail2.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/search-runs/%d status = %d", run2.ID, wDetail2.Result().StatusCode)
	}
	var detail2 SearchRunDetailResponse
	if err := json.NewDecoder(wDetail2.Body).Decode(&detail2); err != nil {
		t.Fatalf("decode detail2: %v", err)
	}
	if detail2.Jobs == nil || len(detail2.Jobs) != 0 {
		t.Fatalf("expected empty non-nil jobs slice for run2, got %+v", detail2.Jobs)
	}

	// ID overflow (> math.MaxInt64) -> 400 INVALID_PARAMS (never 500 DB_ERROR)
	for _, overflowID := range []string{"0", "9223372036854775808", "18446744073709551615"} {
		wOver := httptest.NewRecorder()
		mux.ServeHTTP(wOver, httptest.NewRequest(http.MethodGet, "/api/search-runs/"+overflowID, nil))
		if wOver.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("GET /api/search-runs/%s status = %d, want 400; body=%s", overflowID, wOver.Result().StatusCode, wOver.Body.String())
		}
		var errBody map[string]any
		_ = json.NewDecoder(wOver.Body).Decode(&errBody)
		if errBody["error_code"] != "INVALID_PARAMS" {
			t.Fatalf("GET /api/search-runs/%s expected INVALID_PARAMS, got %+v", overflowID, errBody)
		}
	}
}
