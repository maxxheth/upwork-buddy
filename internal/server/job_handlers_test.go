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

	if err := gormDB.AutoMigrate(
		&dbservice.User{},
		&dbservice.Job{},
		&dbservice.Profile{},
		&dbservice.PortfolioItem{},
	); err != nil {
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
		port: 0,
		db:   &testDBService{sqlDB: sqlDB, gorm: gormDB},
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
		Skills:          "React, TypeScript, Node.js",
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
		Skills:         "Go, Testing",
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
