package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	dbservice "upwork-buddy/internal/database/service"
)

func clearServerLLMEnv(t *testing.T) {
	t.Helper()
	t.Setenv("LLM_PROVIDER", "")
	t.Setenv("AGY_ENDPOINT_URL", "")
	t.Setenv("AGY_API_KEY", "")
	t.Setenv("AGY_TOKEN_PATH", filepath.Join(t.TempDir(), "nonexistent-token"))
	t.Setenv("AGY_MODEL", "")
	t.Setenv("AGY_EFFORT", "")
	t.Setenv("OLLAMA_API_KEY", "")
	t.Setenv("OLLAMA_HOST", "")
	t.Setenv("OLLAMA_MODEL", "")
	t.Setenv("LLM_TIMEOUT_SECONDS", "")
}

func TestAnalyzeJobHandlerAGYMock(t *testing.T) {
	clearServerLLMEnv(t)

	var gotModel, gotEffort string
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Model  string `json:"model"`
			Effort string `json:"effort"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode upstream payload: %v", err)
		}
		gotModel = payload.Model
		gotEffort = payload.Effort
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "` + payload.Model + `",
			"message": {
				"role": "assistant",
				"content": "{\"proposal\":\"Custom proposal\",\"execution_prompt\":\"Run tests\",\"time_estimate\":\"5 hours\",\"workload_division\":\"50/50\",\"questions_for_client\":[\"Timeline?\"],\"tips_and_advice\":[\"Test early\"],\"tone_analysis\":\"Direct\"}"
			}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	s := &Server{}
	body := `{"job_title":"Go Backend","job_description":"Build API","user_profile":"Go dev","user_skills":"Go","model":"gemini-4-neon","effort":"high"}`
	req := httptest.NewRequest(http.MethodPost, "/api/analyze-job", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	s.analyzeJobHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if gotModel != "gemini-4-neon" || gotEffort != "high" {
		t.Fatalf("upstream received model=%q effort=%q, want gemini-4-neon / high", gotModel, gotEffort)
	}
	if !strings.Contains(rec.Body.String(), "Custom proposal") {
		t.Fatalf("unexpected response body: %s", rec.Body.String())
	}
}

func TestAnalyzeJobHandlerErrorStatusCodes(t *testing.T) {
	t.Run("unconfigured returns 503", func(t *testing.T) {
		clearServerLLMEnv(t)
		s := &Server{}
		req := httptest.NewRequest(http.MethodPost, "/api/analyze-job", strings.NewReader(`{"job_title":"Go"}`))
		rec := httptest.NewRecorder()
		s.analyzeJobHandler(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
	})

	t.Run("upstream 503 returns 503", func(t *testing.T) {
		clearServerLLMEnv(t)
		mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":"AGY_AUTH_REQUIRED"}`))
		}))
		defer mockLLM.Close()

		t.Setenv("LLM_PROVIDER", "agy")
		t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
		s := &Server{}
		req := httptest.NewRequest(http.MethodPost, "/api/analyze-job", strings.NewReader(`{"job_title":"Go"}`))
		rec := httptest.NewRecorder()
		s.analyzeJobHandler(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
	})

	t.Run("upstream 500 returns 502", func(t *testing.T) {
		clearServerLLMEnv(t)
		mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`boom`))
		}))
		defer mockLLM.Close()

		t.Setenv("LLM_PROVIDER", "agy")
		t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
		s := &Server{}
		req := httptest.NewRequest(http.MethodPost, "/api/analyze-job", strings.NewReader(`{"job_title":"Go"}`))
		rec := httptest.NewRecorder()
		s.analyzeJobHandler(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Fatalf("status = %d, want 502", rec.Code)
		}
	})
}

func TestAnalyzeSavedJobHandlerInvalidBody(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/123/analyze", strings.NewReader(`{invalid`))
	req.SetPathValue("id", "123")
	rec := httptest.NewRecorder()

	s.analyzeSavedJobHandler(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAnalyzeSavedJobHandlerWithDB(t *testing.T) {
	s := setupTestServer(t)
	clearServerLLMEnv(t)

	job := dbservice.Job{
		Title:        "Go Microservices Developer",
		Description:  "Need Go and Postgres API",
		Skills:       "Go, PostgreSQL",
		ContractType: "fixed",
		BudgetAmount: "$2000",
	}
	if err := s.db.GetGorm().Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"message": {
				"role": "assistant",
				"content": "{\"proposal\":\"Saved job proposal\",\"execution_prompt\":\"Build\",\"time_estimate\":\"10h\",\"workload_division\":\"50/50\",\"questions_for_client\":[\"Q1\"],\"tips_and_advice\":[\"T1\"],\"tone_analysis\":\"Professional\"}"
			}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	// Empty body should be accepted (io.EOF)
	req := httptest.NewRequest(http.MethodPost, "/api/jobs/"+strconv.FormatUint(uint64(job.ID), 10)+"/analyze", nil)
	req.SetPathValue("id", strconv.FormatUint(uint64(job.ID), 10))
	rec := httptest.NewRecorder()
	s.analyzeSavedJobHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty body analyze status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}

	var result AnalyzeJobResult
	if err := json.NewDecoder(bytes.NewReader(rec.Body.Bytes())).Decode(&result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.LLMAnalysis == nil || result.LLMAnalysis.Proposal != "Saved job proposal" {
		t.Fatalf("expected LLMAnalysis proposal, got %+v", result.LLMAnalysis)
	}
}
