package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	_ "github.com/jackc/pgx/v5/stdlib"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// testDBService implements service.DatabaseService using an isolated schema in the test PostgreSQL database.
type testDBService struct {
	sqlDB *sql.DB
	gorm  *gorm.DB
}

func (t *testDBService) Health() map[string]string {
	return map[string]string{"status": "up"}
}

func (t *testDBService) Close() error {
	if t.sqlDB != nil {
		return t.sqlDB.Close()
	}
	return nil
}

func (t *testDBService) GetDB() *sql.DB {
	return t.sqlDB
}

func (t *testDBService) GetGorm() *gorm.DB {
	return t.gorm
}

// setupTestServer creates an isolated per-test PostgreSQL schema using TEST_DATABASE_URL.
// Skips cleanly when TEST_DATABASE_URL is unset so unit runs without DB never touch dev data.
func setupTestServer(t *testing.T) *Server {
	t.Helper()

	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping integration test")
	}

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("invalid TEST_DATABASE_URL: %v", err)
	}
	dbName := strings.ToLower(strings.TrimPrefix(parsed.Path, "/"))
	if os.Getenv("UPWORK_BUDDY_ALLOW_TEST_DSN") != "1" &&
		!strings.Contains(dbName, "test") &&
		!strings.Contains(dbName, "verify") {
		t.Fatalf("refusing to run integration tests against non-test database %q (name must contain 'test' or 'verify')", dbName)
	}

	adminDB, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("failed to open test admin db: %v", err)
	}
	if err := adminDB.Ping(); err != nil {
		_ = adminDB.Close()
		t.Fatalf("failed to ping test database: %v", err)
	}

	schemaName := fmt.Sprintf("test_srv_%d_%d", os.Getpid(), time.Now().UnixNano())
	if _, err := adminDB.Exec(fmt.Sprintf(`CREATE SCHEMA "%s"`, schemaName)); err != nil {
		_ = adminDB.Close()
		t.Fatalf("failed to create isolated test schema %q: %v", schemaName, err)
	}

	q := parsed.Query()
	q.Set("search_path", schemaName)
	parsed.RawQuery = q.Encode()
	scopedDSN := parsed.String()

	sqlDB, err := sql.Open("pgx", scopedDSN)
	if err != nil {
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to open scoped test db: %v", err)
	}

	gormDB, err := gorm.Open(postgres.New(postgres.Config{
		Conn: sqlDB,
	}), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to open gorm test db: %v", err)
	}

	if err := gormDB.AutoMigrate(dbservice.AllModels()...); err != nil {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to migrate isolated test schema: %v", err)
	}

	t.Cleanup(func() {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
	})

	return &Server{
		host:          "127.0.0.1",
		port:          0,
		apiToken:      "test-api-token",
		selectorsPath: "../../configs/selectors/upwork.yaml",
		db:            &testDBService{sqlDB: sqlDB, gorm: gormDB},
	}
}

// cleanupTestServer is kept as a no-op hook for test readability; schema teardown runs via t.Cleanup.
func cleanupTestServer(t *testing.T, s *Server) {
	t.Helper()
}

func TestSaveJobHandler_ValidPayload(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	payload := saveJobRequest{
		JobTitle:        "Build a React Dashboard",
		JobDescription:  "We need a modern dashboard built with React and TypeScript",
		Budget:          "$500-$1000",
		Skills:          FlexibleSkills{Text: "React, TypeScript, Node.js"},
		Proposal:        "I have 5 years of experience...",
		TimeEstimate:    "2 weeks",
		ExecutionPrompt:  "Create a comprehensive spec for a dashboard app",
		ToneAnalysis:    "Professional and concise",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/jobs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.saveJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var result saveJobResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if result.ID == 0 {
		t.Error("expected non-zero job ID")
	}
	if result.JobTitle != payload.JobTitle {
		t.Errorf("expected job_title %q, got %q", payload.JobTitle, result.JobTitle)
	}
	if result.CreatedAt == "" {
		t.Error("expected non-empty created_at")
	}
}

func TestSaveJobHandler_InvalidJSON(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	req := httptest.NewRequest(http.MethodPost, "/api/jobs", bytes.NewReader([]byte("not json")))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.saveJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", resp.StatusCode)
	}
}

func TestSaveJobHandler_WrongMethod(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	w := httptest.NewRecorder()

	s.saveJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", resp.StatusCode)
	}
}

func TestListJobsHandler(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	// First save a job
	payload := saveJobRequest{
		JobTitle:       "Test Job",
		JobDescription: "A test job description",
		Budget:         "$100",
		Skills:         FlexibleSkills{Text: "Go, Testing"},
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/jobs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.saveJobHandler(w, req)

	if w.Result().StatusCode != http.StatusOK {
		t.Fatalf("failed to save job: %d", w.Result().StatusCode)
	}

	// Now list jobs
	req = httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	w = httptest.NewRecorder()
	s.listJobsHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}

	var result listJobsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if len(result.Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(result.Jobs))
	}
	if result.Jobs[0].JobTitle != "Test Job" {
		t.Errorf("expected job_title %q, got %q", "Test Job", result.Jobs[0].JobTitle)
	}
}

func TestListJobsHandler_WrongMethod(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	req := httptest.NewRequest(http.MethodPost, "/api/jobs", nil)
	w := httptest.NewRecorder()

	s.listJobsHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", resp.StatusCode)
	}
}

func TestDeleteJobHandler(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	// First save a job
	payload := saveJobRequest{
		JobTitle:       "Job to Delete",
		JobDescription: "Will be deleted",
	}
	body, _ := json.Marshal(payload)

	req := httptest.NewRequest(http.MethodPost, "/api/jobs", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.saveJobHandler(w, req)

	var saveResp saveJobResponse
	if err := json.NewDecoder(w.Result().Body).Decode(&saveResp); err != nil {
		t.Fatalf("failed to decode save response: %v", err)
	}

	// Delete the job
	req = httptest.NewRequest(http.MethodDelete, "/api/jobs/"+uintToStr(saveResp.ID), nil)
	w = httptest.NewRecorder()
	s.deleteJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected status 204, got %d", resp.StatusCode)
	}

	// Verify job is gone
	req = httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	w = httptest.NewRecorder()
	s.listJobsHandler(w, req)

	var listResp listJobsResponse
	if err := json.NewDecoder(w.Result().Body).Decode(&listResp); err != nil {
		t.Fatalf("failed to decode list response: %v", err)
	}

	if len(listResp.Jobs) != 0 {
		t.Errorf("expected 0 jobs after deletion, got %d", len(listResp.Jobs))
	}
}

func TestDeleteJobHandler_NotFound(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	req := httptest.NewRequest(http.MethodDelete, "/api/jobs/99999", nil)
	w := httptest.NewRecorder()

	s.deleteJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected status 404, got %d", resp.StatusCode)
	}
}

func TestDeleteJobHandler_InvalidID(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	req := httptest.NewRequest(http.MethodDelete, "/api/jobs/abc", nil)
	w := httptest.NewRecorder()

	s.deleteJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected status 400, got %d", resp.StatusCode)
	}
}

func TestDeleteJobHandler_WrongMethod(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	req := httptest.NewRequest(http.MethodGet, "/api/jobs/1", nil)
	w := httptest.NewRecorder()

	s.deleteJobHandler(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("expected status 405, got %d", resp.StatusCode)
	}
}

// Helper to convert uint to string
func uintToStr(n uint) string {
	return strconv.FormatUint(uint64(n), 10)
}

func TestSaveJobHandler_StructuredFlexibleFieldsRoundTrip(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	rawBody := `{
		"job_title": "Structured AI Job",
		"job_description": "Testing flexible JSON normalization",
		"time_estimate": {"total_hours": 12, "phases": ["Design", "Build"]},
		"workload_division": {"ai_percent": 60, "human_percent": 40},
		"questions_for_client": ["What is the timeline?", "Any existing APIs?"],
		"tips_and_advice": ["Define milestones upfront"],
		"execution_prompt": "Run tests after each step"
	}`

	req := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(rawBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.saveJobHandler(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 for structured JSON fields, got %d", resp.StatusCode)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	listW := httptest.NewRecorder()
	s.listJobsHandler(listW, listReq)

	listResp := listW.Result()
	defer listResp.Body.Close()
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 on list, got %d", listResp.StatusCode)
	}

	var listed listJobsResponse
	if err := json.NewDecoder(listResp.Body).Decode(&listed); err != nil {
		t.Fatalf("failed to decode list response: %v", err)
	}
	if len(listed.Jobs) != 1 {
		t.Fatalf("expected 1 job, got %d", len(listed.Jobs))
	}
	got := listed.Jobs[0]
	if !strings.Contains(got.TimeEstimate, `"total_hours":12`) {
		t.Errorf("expected normalized time_estimate JSON, got %q", got.TimeEstimate)
	}
	if !strings.Contains(got.WorkloadDivision, `"ai_percent":60`) {
		t.Errorf("expected normalized workload_division JSON, got %q", got.WorkloadDivision)
	}
	if !strings.Contains(got.QuestionsForClient, `"What is the timeline?"`) {
		t.Errorf("expected normalized questions_for_client JSON, got %q", got.QuestionsForClient)
	}
	if !strings.Contains(got.TipsAndAdvice, `"Define milestones upfront"`) {
		t.Errorf("expected normalized tips_and_advice JSON, got %q", got.TipsAndAdvice)
	}
}

func TestProfileHandler_IncludesUpdatedAtAndLastSyncedAt(t *testing.T) {
	s := setupTestServer(t)
	defer cleanupTestServer(t, s)

	payload := `{
		"description": "Go + TS Engineer",
		"skills": "Go, TypeScript, PostgreSQL",
		"portfolio_items": [{"title": "Repo", "link": "https://example.com", "description": "Demo"}]
	}`
	postReq := httptest.NewRequest(http.MethodPost, "/api/profile", strings.NewReader(payload))
	postReq.Header.Set("Content-Type", "application/json")
	postW := httptest.NewRecorder()
	s.profileHandler(postW, postReq)

	postResp := postW.Result()
	defer postResp.Body.Close()
	if postResp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 on POST /api/profile, got %d", postResp.StatusCode)
	}

	var saved profileResponse
	if err := json.NewDecoder(postResp.Body).Decode(&saved); err != nil {
		t.Fatalf("failed to decode POST profile response: %v", err)
	}
	if saved.UpdatedAt == "" || saved.LastSyncedAt == "" || saved.LastSyncedAtCamel == "" {
		t.Fatalf("expected updated_at, last_synced_at, and lastSyncedAt to be populated, got %+v", saved)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/profile", nil)
	getW := httptest.NewRecorder()
	s.profileHandler(getW, getReq)

	getResp := getW.Result()
	defer getResp.Body.Close()
	if getResp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200 on GET /api/profile, got %d", getResp.StatusCode)
	}

	var fetched profileResponse
	if err := json.NewDecoder(getResp.Body).Decode(&fetched); err != nil {
		t.Fatalf("failed to decode GET profile response: %v", err)
	}
	if fetched.UpdatedAt == "" || fetched.LastSyncedAt == "" || fetched.LastSyncedAtCamel == "" {
		t.Fatalf("expected GET profile timestamps to be populated, got %+v", fetched)
	}
}

func TestSaveJobHandler_UpsertAndV1Compatibility(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	// 1. Multiple legacy URL-less jobs should still insert without unique index collision
	for i := 0; i < 2; i++ {
		legacyReq := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(`{"job_title":"Manual Job","job_description":"No URL"}`))
		legacyReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		legacyReq.Header.Set("Content-Type", "application/json")
		legacyW := httptest.NewRecorder()
		router.ServeHTTP(legacyW, legacyReq)
		if legacyW.Result().StatusCode != http.StatusOK {
			t.Fatalf("legacy job %d failed: %d %s", i, legacyW.Result().StatusCode, legacyW.Body.String())
		}
	}

	// 2. v1.0 proposal_to_buddy_job payload (stringified proposal_json & portfolio_references, comma skills)
	v1Payload := `{
		"job_title": "Golang API Engineer",
		"job_description": "Initial short summary",
		"url": "/jobs/Golang-API-Engineer-span-class-highlight-Go-span_~022115332344639171/?referrer_url_path=/nx/search/jobs/",
		"job_url": "https://www.upwork.com/jobs/Golang-API-Engineer_~022115332344639171/",
		"source": "upwork-scraper-fs",
		"status": "ready",
		"contract_type": "hourly",
		"budget": "$60.00 - $80.00",
		"rate_range": "$60.00 - $80.00",
		"experience_level": "Expert",
		"skills": "Golang, PostgreSQL, Docker",
		"proposal": "Full proposal body",
		"proposal_subject": "Golang Engineer",
		"proposal_tone": "professional",
		"proposal_json": "{\"schema_version\":\"1.0\",\"id\":\"022115332344639171\"}",
		"score": 84,
		"score_reasoning": "Overall score is 84/100.",
		"fit_assessment": "hot",
		"portfolio_references": "[{\"title\":\"UpWork Buddy\"}]",
		"time_estimate": {"hours": 20},
		"execution_prompt": "Keep prompt",
		"tone_analysis": "concise"
	}`

	req1 := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(v1Payload))
	req1.Header.Set("Authorization", "Bearer "+s.apiToken)
	req1.Header.Set("Content-Type", "application/json")
	w1 := httptest.NewRecorder()
	router.ServeHTTP(w1, req1)
	if w1.Result().StatusCode != http.StatusOK {
		t.Fatalf("v1 POST /api/jobs failed: %d %s", w1.Result().StatusCode, w1.Body.String())
	}

	var resp1 saveJobResponse
	if err := json.NewDecoder(w1.Body).Decode(&resp1); err != nil {
		t.Fatalf("decode resp1: %v", err)
	}
	if resp1.UpworkJobID != "~022115332344639171" || resp1.Upserted {
		t.Fatalf("unexpected resp1: %+v", resp1)
	}

	// 3. v2 re-enrichment payload with same upwork_job_id merges richly and preserves existing proposal/execution_prompt
	v2Payload := `{
		"job_title": "Golang API Engineer",
		"job_description": "Much longer authenticated detail description with full architecture requirements and acceptance criteria.",
		"url": "https://www.upwork.com/jobs/Golang-API-Engineer_~022115332344639171/",
		"source_feed": "best_matches",
		"skills": ["Golang", "PostgreSQL", "Docker", "Kubernetes"],
		"posted_text": "Posted 2 hours ago",
		"proposals_tier": "Less than 5",
		"connects_required": 12,
		"client_spent": "10k",
		"client_hires": 15,
		"client_hire_rate": 65.0,
		"payment_verified": true,
		"screening_questions": [{"index": 0, "prompt": "Describe Go experience", "required": true}],
		"client_activity": {"interviewing": 1, "invites_sent": 0}
	}`

	req2 := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(v2Payload))
	req2.Header.Set("Authorization", "Bearer "+s.apiToken)
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	router.ServeHTTP(w2, req2)
	if w2.Result().StatusCode != http.StatusOK {
		t.Fatalf("v2 upsert POST /api/jobs failed: %d %s", w2.Result().StatusCode, w2.Body.String())
	}

	var resp2 saveJobResponse
	if err := json.NewDecoder(w2.Body).Decode(&resp2); err != nil {
		t.Fatalf("decode resp2: %v", err)
	}
	if resp2.ID != resp1.ID || !resp2.Upserted {
		t.Fatalf("expected upsert onto existing ID %d, got %+v", resp1.ID, resp2)
	}

	// 4. Verify GET /api/jobs/{id} & PATCH /api/jobs/{id} & GET /api/jobs?fit=hot&min_score=80
	getReq := httptest.NewRequest(http.MethodGet, "/api/jobs/"+uintToStr(resp1.ID), nil)
	getReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	getW := httptest.NewRecorder()
	router.ServeHTTP(getW, getReq)
	if getW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/jobs/{id} failed: %d", getW.Result().StatusCode)
	}
	var gotEnv struct {
		Job jobEntry `json:"job"`
	}
	if err := json.NewDecoder(getW.Body).Decode(&gotEnv); err != nil {
		t.Fatalf("decode getJob: %v", err)
	}
	if gotEnv.Job.Proposal != "Full proposal body" || gotEnv.Job.ExecutionPrompt != "Keep prompt" {
		t.Fatalf("expected existing proposal/execution_prompt preserved, got %+v", gotEnv.Job)
	}
	if gotEnv.Job.ClientSpentUSD == nil || *gotEnv.Job.ClientSpentUSD != 10000 {
		t.Fatalf("expected ClientSpentUSD=10000, got %v", gotEnv.Job.ClientSpentUSD)
	}
	if gotEnv.Job.ProposalsCount == nil || *gotEnv.Job.ProposalsCount != 4 {
		t.Fatalf("expected ProposalsCount=4, got %v", gotEnv.Job.ProposalsCount)
	}

	patchReq := httptest.NewRequest(http.MethodPatch, "/api/jobs/"+uintToStr(resp1.ID), strings.NewReader(`{"status":"applied"}`))
	patchReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	patchReq.Header.Set("Content-Type", "application/json")
	patchW := httptest.NewRecorder()
	router.ServeHTTP(patchW, patchReq)
	if patchW.Result().StatusCode != http.StatusOK {
		t.Fatalf("PATCH /api/jobs/{id} failed: %d %s", patchW.Result().StatusCode, patchW.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/jobs?status=applied&fit=hot&min_score=80&q=Golang", nil)
	listReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	listW := httptest.NewRecorder()
	router.ServeHTTP(listW, listReq)
	if listW.Result().StatusCode != http.StatusOK {
		t.Fatalf("filtered GET /api/jobs failed: %d", listW.Result().StatusCode)
	}
	var filtered listJobsResponse
	if err := json.NewDecoder(listW.Body).Decode(&filtered); err != nil {
		t.Fatalf("decode filtered jobs: %v", err)
	}
	if len(filtered.Jobs) != 1 || filtered.Jobs[0].ID != resp1.ID {
		t.Fatalf("expected 1 filtered job id=%d, got %+v", resp1.ID, filtered.Jobs)
	}
}

func TestJobHandlers_NilDBReturns503(t *testing.T) {
	s := &Server{apiToken: "test-token"}
	router := s.RegisterRoutes()

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"saveJob", http.MethodPost, "/api/jobs", `{"job_title":"Test"}`},
		{"listJobs", http.MethodGet, "/api/jobs", ""},
		{"getJob", http.MethodGet, "/api/jobs/1", ""},
		{"updateJob", http.MethodPatch, "/api/jobs/1", `{"status":"applied"}`},
		{"deleteJob", http.MethodDelete, "/api/jobs/1", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var bodyReader *strings.Reader
			if tc.body != "" {
				bodyReader = strings.NewReader(tc.body)
			} else {
				bodyReader = strings.NewReader("")
			}
			req := httptest.NewRequest(tc.method, tc.path, bodyReader)
			req.Header.Set("Authorization", "Bearer test-token")
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Result().StatusCode != http.StatusServiceUnavailable {
				t.Fatalf("%s %s status = %d %s, want 503", tc.method, tc.path, w.Result().StatusCode, w.Body.String())
			}
		})
	}
}

func TestSaveJobHandler_ConcurrentNewUpworkJobID(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	const workers = 8
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]saveJobResponse, workers)
	statuses := make([]int, workers)
	errs := make([]error, workers)

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			<-start
			payload := fmt.Sprintf(`{
				"job_title": "Concurrent Go Job %d",
				"job_description": "Testing concurrent brand-new upwork_job_id upsert",
				"upwork_job_id": "~02998877665544",
				"url": "https://www.upwork.com/jobs/Concurrent-Go-Job_~02998877665544/",
				"skills": ["Go", "PostgreSQL"]
			}`, idx)
			req := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(payload))
			req.Header.Set("Authorization", "Bearer "+s.apiToken)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			statuses[idx] = w.Result().StatusCode
			if statuses[idx] != http.StatusOK {
				errs[idx] = fmt.Errorf("status=%d body=%s", statuses[idx], w.Body.String())
				return
			}
			errs[idx] = json.NewDecoder(w.Body).Decode(&results[idx])
		}(i)
	}

	close(start)
	wg.Wait()

	var jobID uint
	createdCount := 0
	for i := 0; i < workers; i++ {
		if errs[i] != nil {
			t.Fatalf("worker %d failed: %v", i, errs[i])
		}
		if statuses[i] != http.StatusOK {
			t.Fatalf("worker %d status = %d, want 200", i, statuses[i])
		}
		if results[i].ID == 0 {
			t.Fatalf("worker %d returned ID=0", i)
		}
		if jobID == 0 {
			jobID = results[i].ID
		} else if results[i].ID != jobID {
			t.Fatalf("worker %d returned ID=%d, expected single merged ID=%d", i, results[i].ID, jobID)
		}
		if !results[i].Upserted {
			createdCount++
		}
	}
	if createdCount != 1 {
		t.Fatalf("expected exactly 1 initial insert (upserted=false), got %d", createdCount)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
	listReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	listW := httptest.NewRecorder()
	router.ServeHTTP(listW, listReq)
	if listW.Result().StatusCode != http.StatusOK {
		t.Fatalf("list jobs failed: %d", listW.Result().StatusCode)
	}
	var listed listJobsResponse
	if err := json.NewDecoder(listW.Body).Decode(&listed); err != nil {
		t.Fatalf("decode list jobs: %v", err)
	}
	if len(listed.Jobs) != 1 || listed.Jobs[0].ID != jobID {
		t.Fatalf("expected exactly 1 persisted job id=%d, got %+v", jobID, listed.Jobs)
	}
}

func TestListJobsHandler_MaxAgeMaxProposalsAndSortScoreDesc(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	oldTime := time.Now().UTC().Add(-10 * 24 * time.Hour)
	recentTime := time.Now().UTC().Add(-2 * time.Hour)

	payloads := []saveJobRequest{
		{
			UpworkJobID:    "~01old",
			JobTitle:       "Old High Score Job",
			JobDescription: "Go Postgres Docker AWS",
			Skills:         FlexibleSkills{Text: "Go, PostgreSQL, Docker"},
			ProposalsTier:  "Less than 5",
			PostedAtEst:    &oldTime,
		},
		{
			UpworkJobID:    "~02crowded",
			JobTitle:       "Crowded Recent Job",
			JobDescription: "Simple HTML",
			ProposalsTier:  "20 to 50",
			PostedAtEst:    &recentTime,
		},
		{
			UpworkJobID:    "~03ideal",
			JobTitle:       "Ideal Recent Go Job",
			JobDescription: "Build Go PostgreSQL backend services with Docker and AWS.",
			RateRange:      "$60 - $80",
			Budget:         "$60 - $80/hr",
			ContractType:   "hourly",
			Skills:         FlexibleSkills{Text: "Go, PostgreSQL, Docker"},
			ProposalsTier:  "5 to 10",
			ClientSpent:    "$50K",
			PostedAtEst:    &recentTime,
		},
	}

	for _, p := range payloads {
		b, _ := json.Marshal(p)
		req := httptest.NewRequest(http.MethodPost, "/api/jobs", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusOK {
			t.Fatalf("save job %s failed: %d %s", p.UpworkJobID, w.Result().StatusCode, w.Body.String())
		}
	}

	// Filter max_age_days=3 & max_proposals=15 & sort=score_desc -> only ~03ideal
	req := httptest.NewRequest(http.MethodGet, "/api/jobs?max_age_days=3&max_proposals=15&sort=score_desc", nil)
	req.Header.Set("Authorization", "Bearer "+s.apiToken)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/jobs filtered failed: %d", w.Result().StatusCode)
	}
	var out listJobsResponse
	if err := json.NewDecoder(w.Body).Decode(&out); err != nil {
		t.Fatalf("decode listJobsResponse: %v", err)
	}
	if len(out.Jobs) != 1 || out.Jobs[0].UpworkJobID != "~03ideal" {
		t.Fatalf("expected only ~03ideal, got %+v", out.Jobs)
	}

	// Verify sort=score_desc orders highest score first
	sortReq := httptest.NewRequest(http.MethodGet, "/api/jobs?sort=score_desc", nil)
	sortReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	sortW := httptest.NewRecorder()
	router.ServeHTTP(sortW, sortReq)
	var sorted listJobsResponse
	_ = json.NewDecoder(sortW.Body).Decode(&sorted)
	if len(sorted.Jobs) != 3 || *sorted.Jobs[0].Score < *sorted.Jobs[1].Score || *sorted.Jobs[1].Score < *sorted.Jobs[2].Score {
		t.Fatalf("expected descending scores, got %+v", sorted.Jobs)
	}
}

func TestListJobsHandler_MaxAgeDaysZeroIncludesJustNow(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	for _, payload := range []string{
		`{"upwork_job_id":"~01justnow","job_title":"Just Now Job","job_description":"Posted right now","posted_text":"Just now"}`,
		`{"upwork_job_id":"~02dayold","job_title":"25 Hours Ago Job","job_description":"Posted yesterday","posted_text":"Posted 25 hours ago"}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusOK {
			t.Fatalf("save job failed: %d %s", w.Result().StatusCode, w.Body.String())
		}
	}

	// Small delay so time.Now() is strictly after posted_at_est recorded at POST time
	time.Sleep(15 * time.Millisecond)

	reqZero := httptest.NewRequest(http.MethodGet, "/api/jobs?max_age_days=0", nil)
	reqZero.Header.Set("Authorization", "Bearer "+s.apiToken)
	wZero := httptest.NewRecorder()
	router.ServeHTTP(wZero, reqZero)
	if wZero.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/jobs?max_age_days=0 failed: %d", wZero.Result().StatusCode)
	}
	var outZero listJobsResponse
	if err := json.NewDecoder(wZero.Body).Decode(&outZero); err != nil {
		t.Fatalf("decode outZero: %v", err)
	}
	if len(outZero.Jobs) != 1 || outZero.Jobs[0].UpworkJobID != "~01justnow" {
		t.Fatalf("expected only ~01justnow for max_age_days=0, got %+v", outZero.Jobs)
	}

	reqOne := httptest.NewRequest(http.MethodGet, "/api/jobs?max_age_days=1", nil)
	reqOne.Header.Set("Authorization", "Bearer "+s.apiToken)
	wOne := httptest.NewRecorder()
	router.ServeHTTP(wOne, reqOne)
	var outOne listJobsResponse
	if err := json.NewDecoder(wOne.Body).Decode(&outOne); err != nil {
		t.Fatalf("decode outOne: %v", err)
	}
	if len(outOne.Jobs) != 2 {
		t.Fatalf("expected 2 jobs for max_age_days=1, got %+v", outOne.Jobs)
	}
}

func TestListJobsHandler_MaxAgeDaysUpperBound(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	saveReq := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(`{"upwork_job_id":"~01maxage","job_title":"Boundary Job","job_description":"Testing max_age_days=36500","posted_text":"Just now"}`))
	saveReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	saveReq.Header.Set("Content-Type", "application/json")
	saveW := httptest.NewRecorder()
	router.ServeHTTP(saveW, saveReq)
	if saveW.Result().StatusCode != http.StatusOK {
		t.Fatalf("save job failed: %d %s", saveW.Result().StatusCode, saveW.Body.String())
	}

	for _, invalidAge := range []string{"36501", "106751", "-1"} {
		req := httptest.NewRequest(http.MethodGet, "/api/jobs?max_age_days="+invalidAge, nil)
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("max_age_days=%s status=%d, want 400", invalidAge, w.Result().StatusCode)
		}
	}

	reqValid := httptest.NewRequest(http.MethodGet, "/api/jobs?max_age_days=36500", nil)
	reqValid.Header.Set("Authorization", "Bearer "+s.apiToken)
	wValid := httptest.NewRecorder()
	router.ServeHTTP(wValid, reqValid)
	if wValid.Result().StatusCode != http.StatusOK {
		t.Fatalf("max_age_days=36500 status=%d body=%s, want 200", wValid.Result().StatusCode, wValid.Body.String())
	}
	var listed listJobsResponse
	if err := json.NewDecoder(wValid.Body).Decode(&listed); err != nil {
		t.Fatalf("decode listJobsResponse: %v", err)
	}
	if len(listed.Jobs) != 1 || listed.Jobs[0].UpworkJobID != "~01maxage" {
		t.Fatalf("expected seeded job for max_age_days=36500, got %+v", listed.Jobs)
	}
}

func TestSaveJobHandler_PreservesAppliedStatusOnReingest(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	post := func(body string) saveJobResponse {
		req := httptest.NewRequest(http.MethodPost, "/api/jobs", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusOK {
			t.Fatalf("POST /api/jobs status=%d body=%s", w.Result().StatusCode, w.Body.String())
		}
		var out saveJobResponse
		_ = json.NewDecoder(w.Body).Decode(&out)
		return out
	}

	r1 := post(`{"upwork_job_id":"~01applied1","job_title":"Go Role","job_description":"Desc","status":"applied"}`)
	r2 := post(`{"upwork_job_id":"~01applied1","job_title":"Go Role","job_description":"Desc","status":"new"}`)
	if r2.ID != r1.ID || r2.Status != "applied" {
		t.Fatalf("expected applied status preserved on re-ingest, got %+v", r2)
	}

	// Also verify rejected and archived statuses are preserved on re-ingest
	for _, st := range []string{"rejected", "archived"} {
		uid := "~01" + st
		first := post(fmt.Sprintf(`{"upwork_job_id":%q,"job_title":"Go Role","job_description":"Desc","status":%q}`, uid, st))
		second := post(fmt.Sprintf(`{"upwork_job_id":%q,"job_title":"Go Role","job_description":"Desc","status":"new"}`, uid))
		if second.ID != first.ID || second.Status != st {
			t.Fatalf("expected %s status preserved on re-ingest, got %+v", st, second)
		}
	}
}
