package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	dbservice "upwork-buddy/internal/database/service"
)

func registerTestEnrichmentRoutes(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/enrichment-config", s.enrichmentConfigHandler)
	mux.HandleFunc("POST /api/jobs/enrich", s.enrichJobsHandler)
	mux.HandleFunc("GET /api/enrichment-batches", s.listEnrichmentBatchesHandler)
	mux.HandleFunc("GET /api/enrichment-batches/{id}", s.getEnrichmentBatchHandler)
	mux.HandleFunc("POST /api/enrichment-batches/{id}/cancel", s.cancelEnrichmentBatchHandler)
	return mux
}

func TestEnrichmentHandlers_ConfigNilDBMethodsAndDashboardURL(t *testing.T) {
	clearEnrichmentEnv(t)
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "12")
	t.Setenv("ENRICHMENT_CONFIRM_THRESHOLD", "3")
	t.Setenv("ENRICHMENT_DEFAULT_MODE", "ai_only")
	t.Setenv("WEB_UI_ENABLED", "true")
	t.Setenv("UPWORK_BUDDY_URL", "")
	t.Setenv("BUDDY_API_URL", "")
	t.Setenv("APP_HOST", "127.0.0.1")
	t.Setenv("APP_PORT", "9191")

	s := &Server{}

	// GET /api/enrichment-config
	wCfg := httptest.NewRecorder()
	s.enrichmentConfigHandler(wCfg, httptest.NewRequest(http.MethodGet, "/api/enrichment-config", nil))
	if wCfg.Result().StatusCode != http.StatusOK {
		t.Fatalf("enrichmentConfigHandler status = %d, want 200", wCfg.Result().StatusCode)
	}
	var cfg EnrichmentConfig
	if err := json.NewDecoder(wCfg.Body).Decode(&cfg); err != nil {
		t.Fatalf("decode enrichment config: %v", err)
	}
	if cfg.MaxBatchSize != 12 || cfg.ConfirmThreshold != 3 || cfg.DefaultMode != "ai_only" || !cfg.WebUIEnabled {
		t.Fatalf("unexpected config response: %+v", cfg)
	}

	// Wrong HTTP methods -> 405
	methodChecks := []struct {
		fn     func(http.ResponseWriter, *http.Request)
		method string
		path   string
	}{
		{s.enrichmentConfigHandler, http.MethodPost, "/api/enrichment-config"},
		{s.enrichJobsHandler, http.MethodGet, "/api/jobs/enrich"},
		{s.listEnrichmentBatchesHandler, http.MethodPost, "/api/enrichment-batches"},
		{s.getEnrichmentBatchHandler, http.MethodDelete, "/api/enrichment-batches/1"},
		{s.cancelEnrichmentBatchHandler, http.MethodGet, "/api/enrichment-batches/1/cancel"},
	}
	for _, mc := range methodChecks {
		w := httptest.NewRecorder()
		mc.fn(w, httptest.NewRequest(mc.method, mc.path, nil))
		if w.Result().StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s status = %d, want 405", mc.method, mc.path, w.Result().StatusCode)
		}
	}

	// Nil DB -> 503 DB_UNAVAILABLE with error_code
	nilDBChecks := []struct {
		fn     func(http.ResponseWriter, *http.Request)
		method string
		path   string
		body   string
	}{
		{s.enrichJobsHandler, http.MethodPost, "/api/jobs/enrich", `{"job_ids":[1]}`},
		{s.listEnrichmentBatchesHandler, http.MethodGet, "/api/enrichment-batches", ""},
		{s.getEnrichmentBatchHandler, http.MethodGet, "/api/enrichment-batches/1", ""},
		{s.cancelEnrichmentBatchHandler, http.MethodPost, "/api/enrichment-batches/1/cancel", ""},
	}
	for _, nc := range nilDBChecks {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(nc.method, nc.path, strings.NewReader(nc.body))
		nc.fn(w, req)
		if w.Result().StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("nil DB %s %s status = %d, want 503", nc.method, nc.path, w.Result().StatusCode)
		}
		var errBody map[string]any
		_ = json.NewDecoder(w.Body).Decode(&errBody)
		if errBody["error_code"] != "DB_UNAVAILABLE" {
			t.Fatalf("nil DB %s %s expected error_code=DB_UNAVAILABLE, got %+v", nc.method, nc.path, errBody)
		}
	}

	// Dashboard URL builder
	if got := (&Server{host: "127.0.0.1", port: 9095}).buildEnrichmentBatchDashboardURL(0); got != "" {
		t.Fatalf("expected empty URL for batchID=0, got %q", got)
	}
	portSrv := &Server{host: "127.0.0.1", port: 9095}
	gotPortURL := portSrv.buildEnrichmentBatchDashboardURL(5)
	assertTicketedDashboardURL(t, portSrv, gotPortURL, "http://127.0.0.1:9095", "batch", "5")

	fallbackSrv := &Server{}
	gotFallbackURL := fallbackSrv.buildEnrichmentBatchDashboardURL(8)
	assertTicketedDashboardURL(t, fallbackSrv, gotFallbackURL, "http://127.0.0.1:9191", "batch", "8")
	t.Setenv("WEB_UI_ENABLED", "false")
	if got := (&Server{host: "127.0.0.1", port: 9095}).buildEnrichmentBatchDashboardURL(5); got != "" {
		t.Fatalf("expected empty URL when WEB_UI_ENABLED=false, got %q", got)
	}
}

func TestEnrichmentHandlers_CRUDAsyncWaitCancelAndErrors_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mux := registerTestEnrichmentRoutes(s)

	var delayMS atomic.Int64
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if d := time.Duration(delayMS.Load()) * time.Millisecond; d > 0 {
			select {
			case <-time.After(d):
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 40, "outputTokens": 60, "thoughtTokens": 0, "totalTokens": 100},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Handler proposal\",\"execution_prompt\":\"Go\",\"time_estimate\":\"2h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "3")
	t.Setenv("WEB_UI_ENABLED", "true")

	// Seed 4 jobs
	var jobIDs []uint
	for _, uid := range []string{"~01hdl1", "~01hdl2", "~01hdl3", "~01hdl4"} {
		u := uid
		j := dbservice.Job{UpworkJobID: &u, Title: "Handler Job " + uid, Description: "Desc"}
		if err := gormDB.Create(&j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
		jobIDs = append(jobIDs, j.ID)
	}

	// 1. 400 INVALID_PARAMS checks
	badPosts := []string{
		`{invalid`,
		`{"job_ids":[]}`,
		`{"job_ids":[1,2,3,4],"mode":"ai_only"}`,
		`{"job_ids":[` + strconv.FormatUint(uint64(jobIDs[0]), 10) + `],"mode":"bad"}`,
		`{"job_ids":[` + strconv.FormatUint(uint64(jobIDs[0]), 10) + `],"effort":"bad"}`,
		`{"job_ids":[` + strconv.FormatUint(uint64(jobIDs[0]), 10) + `],"max_concurrency":0}`,
		`{"job_ids":[1.5]}`,
	}
	for _, payload := range badPosts {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/jobs/enrich", strings.NewReader(payload)))
		if w.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("POST /api/jobs/enrich %s status = %d, want 400 body=%s", payload, w.Result().StatusCode, w.Body.String())
		}
		var errBody map[string]any
		_ = json.NewDecoder(w.Body).Decode(&errBody)
		if errBody["error_code"] != "INVALID_PARAMS" {
			t.Fatalf("expected INVALID_PARAMS, got %+v", errBody)
		}
	}

	badGets := []string{
		"/api/enrichment-batches?status=unknown",
		"/api/enrichment-batches?limit=0",
		"/api/enrichment-batches?offset=-1",
		"/api/enrichment-batches/0",
		"/api/enrichment-batches/abc",
	}
	for _, path := range badGets {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("GET %s status = %d, want 400", path, w.Result().StatusCode)
		}
	}

	// 2. 404 NOT_FOUND checks
	w404Jobs := httptest.NewRecorder()
	mux.ServeHTTP(w404Jobs, httptest.NewRequest(http.MethodPost, "/api/jobs/enrich", strings.NewReader(`{"job_ids":[999998,"~01missing"]}`)))
	if w404Jobs.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("missing job_ids status = %d, want 404", w404Jobs.Result().StatusCode)
	}
	w404Get := httptest.NewRecorder()
	mux.ServeHTTP(w404Get, httptest.NewRequest(http.MethodGet, "/api/enrichment-batches/999999", nil))
	if w404Get.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("missing batch GET status = %d, want 404", w404Get.Result().StatusCode)
	}
	w404Cancel := httptest.NewRecorder()
	mux.ServeHTTP(w404Cancel, httptest.NewRequest(http.MethodPost, "/api/enrichment-batches/999999/cancel", nil))
	if w404Cancel.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("missing batch cancel status = %d, want 404", w404Cancel.Result().StatusCode)
	}

	// 3. Synchronous wait=true -> 200 OK with dashboard_url
	wSync := httptest.NewRecorder()
	syncBody := `{"job_ids":[` + strconv.FormatUint(uint64(jobIDs[0]), 10) + `,"~01hdl2"],"mode":"ai_only","wait":true}`
	mux.ServeHTTP(wSync, httptest.NewRequest(http.MethodPost, "/api/jobs/enrich", strings.NewReader(syncBody)))
	if wSync.Result().StatusCode != http.StatusOK {
		t.Fatalf("wait=true status = %d, want 200 body=%s", wSync.Result().StatusCode, wSync.Body.String())
	}
	var syncResp EnrichmentBatchDetailResponse
	if err := json.NewDecoder(wSync.Body).Decode(&syncResp); err != nil {
		t.Fatalf("decode syncResp: %v", err)
	}
	if syncResp.Batch.Status != EnrichmentBatchStatusCompleted || syncResp.Batch.CompletedCount != 2 || len(syncResp.Items) != 2 || !strings.Contains(syncResp.DashboardURL, "/dashboard/?batch=") {
		t.Fatalf("unexpected wait=true response: %+v", syncResp)
	}

	// 4. WEB_UI_ENABLED=false omits dashboard_url, wait=false returns 202 Accepted, and cancel works
	t.Setenv("WEB_UI_ENABLED", "false")
	delayMS.Store(250)
	wAsync := httptest.NewRecorder()
	asyncBody := `{"job_ids":[` + strconv.FormatUint(uint64(jobIDs[2]), 10) + `,` + strconv.FormatUint(uint64(jobIDs[3]), 10) + `],"mode":"ai_only","max_concurrency":1,"wait":false}`
	mux.ServeHTTP(wAsync, httptest.NewRequest(http.MethodPost, "/api/jobs/enrich", strings.NewReader(asyncBody)))
	if wAsync.Result().StatusCode != http.StatusAccepted {
		t.Fatalf("wait=false status = %d, want 202 body=%s", wAsync.Result().StatusCode, wAsync.Body.String())
	}
	var asyncResp EnrichmentBatchDetailResponse
	if err := json.NewDecoder(wAsync.Body).Decode(&asyncResp); err != nil {
		t.Fatalf("decode asyncResp: %v", err)
	}
	if asyncResp.DashboardURL != "" || (asyncResp.Batch.Status != EnrichmentBatchStatusQueued && asyncResp.Batch.Status != EnrichmentBatchStatusRunning) {
		t.Fatalf("unexpected async response: %+v", asyncResp)
	}

	// Cancel running batch -> 200 OK
	wCancel := httptest.NewRecorder()
	mux.ServeHTTP(wCancel, httptest.NewRequest(http.MethodPost, "/api/enrichment-batches/"+strconv.FormatUint(uint64(asyncResp.Batch.ID), 10)+"/cancel", nil))
	if wCancel.Result().StatusCode != http.StatusOK {
		t.Fatalf("cancel status = %d, want 200 body=%s", wCancel.Result().StatusCode, wCancel.Body.String())
	}
	var cancelResp EnrichmentBatchDetailResponse
	if err := json.NewDecoder(wCancel.Body).Decode(&cancelResp); err != nil {
		t.Fatalf("decode cancelResp: %v", err)
	}
	if cancelResp.Batch.Status != EnrichmentBatchStatusCanceled {
		t.Fatalf("expected canceled batch status, got %q", cancelResp.Batch.Status)
	}

	// GET /api/enrichment-batches/{id}
	wGet := httptest.NewRecorder()
	mux.ServeHTTP(wGet, httptest.NewRequest(http.MethodGet, "/api/enrichment-batches/"+strconv.FormatUint(uint64(syncResp.Batch.ID), 10), nil))
	if wGet.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET batch status = %d, want 200", wGet.Result().StatusCode)
	}
	var getResp EnrichmentBatchDetailResponse
	if err := json.NewDecoder(wGet.Body).Decode(&getResp); err != nil {
		t.Fatalf("decode getResp: %v", err)
	}
	if getResp.Batch.ID != syncResp.Batch.ID || len(getResp.Items) != 2 {
		t.Fatalf("unexpected getResp: %+v", getResp)
	}

	// GET /api/enrichment-batches with filtering & pagination
	wListAll := httptest.NewRecorder()
	mux.ServeHTTP(wListAll, httptest.NewRequest(http.MethodGet, "/api/enrichment-batches?limit=1&offset=1", nil))
	if wListAll.Result().StatusCode != http.StatusOK {
		t.Fatalf("list batches status = %d, want 200", wListAll.Result().StatusCode)
	}
	var listAll struct {
		Batches []EnrichmentBatchSummary `json:"batches"`
		Total   int                      `json:"total"`
	}
	if err := json.NewDecoder(wListAll.Body).Decode(&listAll); err != nil {
		t.Fatalf("decode listAll: %v", err)
	}
	if listAll.Total != 2 || len(listAll.Batches) != 1 || listAll.Batches[0].ID != syncResp.Batch.ID {
		t.Fatalf("unexpected paginated list: %+v", listAll)
	}

	wListCompleted := httptest.NewRecorder()
	mux.ServeHTTP(wListCompleted, httptest.NewRequest(http.MethodGet, "/api/enrichment-batches?status=completed", nil))
	if wListCompleted.Result().StatusCode != http.StatusOK {
		t.Fatalf("list completed status = %d, want 200", wListCompleted.Result().StatusCode)
	}
	var listCompleted struct {
		Batches []EnrichmentBatchSummary `json:"batches"`
		Total   int                      `json:"total"`
	}
	_ = json.NewDecoder(wListCompleted.Body).Decode(&listCompleted)
	if listCompleted.Total != 1 || len(listCompleted.Batches) != 1 || listCompleted.Batches[0].ID != syncResp.Batch.ID {
		t.Fatalf("unexpected filtered completed list: %+v", listCompleted)
	}
}

func TestEnrichmentHandlers_OverflowTrailingGarbageAndInvalidRefs_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mux := registerTestEnrichmentRoutes(s)

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "low",
			"usage": {"inputTokens": 10, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 30},
			"message": {"role": "assistant", "content": "{\"proposal\":\"OK\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()
	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	uid := "~01hval1"
	job := dbservice.Job{UpworkJobID: &uid, Title: "Validation Job", Description: "Desc"}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	idStr := strconv.FormatUint(uint64(job.ID), 10)

	// 1. Out-of-range (> MaxInt64), float 1.0, invalid ~ refs, and trailing garbage -> all 400 INVALID_PARAMS (never 500 or 404)
	badPayloads := []string{
		`{"job_ids":[9223372036854775808],"mode":"ai_only"}`,
		`{"job_ids":[18446744073709551615],"mode":"ai_only"}`,
		`{"job_ids":["9223372036854775808"],"mode":"ai_only"}`,
		`{"job_ids":["18446744073709551615"],"mode":"ai_only"}`,
		`{"job_ids":[1.0],"mode":"ai_only"}`,
		`{"job_ids":["~"],"mode":"ai_only"}`,
		`{"job_ids":["~!"],"mode":"ai_only"}`,
		`{"job_ids":["~a b"],"mode":"ai_only"}`,
		`{"job_ids":[` + idStr + `],"mode":"ai_only"} trailing garbage`,
		`{"job_ids":[` + idStr + `],"mode":"ai_only"} {}`,
	}
	for _, payload := range badPayloads {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/jobs/enrich", strings.NewReader(payload)))
		if w.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("POST /api/jobs/enrich %s status = %d, want 400; body=%s", payload, w.Result().StatusCode, w.Body.String())
		}
		var errBody map[string]any
		_ = json.NewDecoder(w.Body).Decode(&errBody)
		if errBody["error_code"] != "INVALID_PARAMS" {
			t.Fatalf("POST /api/jobs/enrich %s expected INVALID_PARAMS, got %+v", payload, errBody)
		}
	}

	var batchCount int64
	if err := gormDB.Model(&dbservice.EnrichmentBatch{}).Count(&batchCount).Error; err != nil {
		t.Fatalf("count batches: %v", err)
	}
	if batchCount != 0 {
		t.Fatalf("expected 0 batches created by invalid payloads, got %d", batchCount)
	}

	// 2. GET / POST cancel with ID > math.MaxInt64 -> 400 INVALID_PARAMS (never 500 DB_ERROR)
	overflowPaths := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/enrichment-batches/9223372036854775808"},
		{http.MethodGet, "/api/enrichment-batches/18446744073709551615"},
		{http.MethodPost, "/api/enrichment-batches/9223372036854775808/cancel"},
		{http.MethodPost, "/api/enrichment-batches/18446744073709551615/cancel"},
	}
	for _, tc := range overflowPaths {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("%s %s status = %d, want 400; body=%s", tc.method, tc.path, w.Result().StatusCode, w.Body.String())
		}
		var errBody map[string]any
		_ = json.NewDecoder(w.Body).Decode(&errBody)
		if errBody["error_code"] != "INVALID_PARAMS" {
			t.Fatalf("%s %s expected INVALID_PARAMS, got %+v", tc.method, tc.path, errBody)
		}
	}

	// 3. Trailing whitespace is accepted, and cancel with trailing garbage -> 400 INVALID_PARAMS without canceling
	wOK := httptest.NewRecorder()
	mux.ServeHTTP(wOK, httptest.NewRequest(http.MethodPost, "/api/jobs/enrich", strings.NewReader("{\"job_ids\":["+idStr+"],\"mode\":\"ai_only\",\"wait\":true}  \n\t ")))
	if wOK.Result().StatusCode != http.StatusOK {
		t.Fatalf("trailing whitespace POST /api/jobs/enrich status = %d, want 200; body=%s", wOK.Result().StatusCode, wOK.Body.String())
	}
	var okResp EnrichmentBatchDetailResponse
	if err := json.NewDecoder(wOK.Body).Decode(&okResp); err != nil {
		t.Fatalf("decode okResp: %v", err)
	}

	// Create a queued batch to verify trailing garbage on cancel rejects before touching DB
	queuedBatch := dbservice.EnrichmentBatch{Mode: "ai_only", TriggeredBy: "api", Status: EnrichmentBatchStatusQueued, TotalCount: 1, QueuedCount: 1}
	if err := gormDB.Create(&queuedBatch).Error; err != nil {
		t.Fatalf("create queued batch: %v", err)
	}
	wCancelBad := httptest.NewRecorder()
	mux.ServeHTTP(wCancelBad, httptest.NewRequest(http.MethodPost, "/api/enrichment-batches/"+strconv.FormatUint(uint64(queuedBatch.ID), 10)+"/cancel", strings.NewReader(`{} junk`)))
	if wCancelBad.Result().StatusCode != http.StatusBadRequest {
		t.Fatalf("cancel trailing garbage status = %d, want 400; body=%s", wCancelBad.Result().StatusCode, wCancelBad.Body.String())
	}
	var reloadQueued dbservice.EnrichmentBatch
	_ = gormDB.First(&reloadQueued, queuedBatch.ID).Error
	if reloadQueued.Status != EnrichmentBatchStatusQueued {
		t.Fatalf("expected queued batch untouched after 400 cancel, got %q", reloadQueued.Status)
	}
	_ = okResp
}
