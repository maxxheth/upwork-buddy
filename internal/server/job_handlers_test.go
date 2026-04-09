package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	dbservice "upwork-buddy/internal/database/service"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// testDBService implements service.DatabaseService using the Docker PostgreSQL database
type testDBService struct {
	gorm *gorm.DB
}

func (t *testDBService) Health() map[string]string {
	return map[string]string{"status": "up"}
}

func (t *testDBService) Close() error {
	return nil
}

func (s *testDBService) GetDB() *sql.DB {
	return nil
}

func (t *testDBService) GetGorm() *gorm.DB {
	return t.gorm
}

// setupTestServer creates a Server with the Docker PostgreSQL database for testing.
// Requires `docker compose up -d app_db` to be running.
func setupTestServer(t *testing.T) *Server {
	t.Helper()
	dsn := "host=localhost port=5443 user=postgres password=password dbname=upwork_buddy sslmode=disable"
	db, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Skip("PostgreSQL not available, skipping integration test")
	}

	// Clean up any existing test data and auto-migrate
	db.Exec("DELETE FROM jobs")
	if err := db.AutoMigrate(&dbservice.Job{}); err != nil {
		t.Fatalf("failed to migrate test database: %v", err)
	}

	return &Server{
		port: 0,
		db:   &testDBService{gorm: db},
	}
}

// cleanupTestServer removes test data after the test
func cleanupTestServer(t *testing.T, s *Server) {
	t.Helper()
	s.db.GetGorm().Exec("DELETE FROM jobs")
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
	json.NewDecoder(w.Result().Body).Decode(&saveResp)

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
	json.NewDecoder(w.Result().Body).Decode(&listResp)

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