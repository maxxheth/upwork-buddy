package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/scoring"
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

func TestBuildAnalysisContextAndAnalyzeJobWithActiveProjects(t *testing.T) {
	s := setupTestServer(t)
	clearServerLLMEnv(t)
	gormDB := s.db.GetGorm()

	// Seed profile + portfolio item
	prof := dbservice.Profile{
		Description: "Senior Go & React Engineer",
		Skills:      "Go, PostgreSQL, React",
		PortfolioItems: []dbservice.PortfolioItem{
			{
				Title:       "Go Billing Service",
				Link:        "https://example.com/billing",
				Description: "High-throughput Go + PostgreSQL billing engine",
			},
		},
	}
	if err := gormDB.Create(&prof).Error; err != nil {
		t.Fatalf("create profile: %v", err)
	}

	// Seed active projects: anonymized, public, private, archived
	projects := []dbservice.ActiveProject{
		{
			ProjectKey:         "marvenio-secret",
			Slug:               "marvenio-secret",
			Name:               "Marvenio Secret Platform",
			Path:               "/var/www/marvenio-secret",
			GroupName:          "marvenio",
			ActivityTier:       "active",
			Status:             "in_progress",
			Client:             "Marvenio Corp",
			ProposalVisibility: "anonymized",
			Summary:            "Marvenio Corp Go microservice at /var/www/marvenio-secret",
			LastCommitSubject:  "fix: Marvenio secret billing bug",
			TechStackJSON:      dbservice.JSONB(`["Go","PostgreSQL","Docker"]`),
			Pinned:             true,
		},
		{
			ProjectKey:         "open-go-kit",
			Slug:               "open-go-kit",
			Name:               "OpenGoKit",
			Path:               "/var/www/open-go-kit",
			GroupName:          "oss",
			ActivityTier:       "recent",
			Status:             "active",
			ProposalVisibility: "public",
			Summary:            "Public Go CLI toolkit",
			LastCommitSubject:  "feat: add postgres helper",
			TechStackJSON:      dbservice.JSONB(`["Go","PostgreSQL"]`),
		},
		{
			ProjectKey:         "stealth-private",
			Slug:               "stealth-private",
			Name:               "StealthPrivateApp",
			Path:               "/var/www/stealth",
			GroupName:          "stealth",
			ActivityTier:       "active",
			Status:             "in_progress",
			Client:             "StealthClient",
			ProposalVisibility: "private",
			Summary:            "Stealth Go backend",
			TechStackJSON:      dbservice.JSONB(`["Go"]`),
		},
		{
			ProjectKey:         "old-archived",
			Slug:               "old-archived",
			Name:               "OldArchivedApp",
			Path:               "/var/www/old-archived",
			ActivityTier:       "archived",
			ProposalVisibility: "public",
			Summary:            "Archived Go app",
			TechStackJSON:      dbservice.JSONB(`["Go"]`),
		},
		{
			ProjectKey:         "status-archived",
			Slug:               "status-archived",
			Name:               "StatusArchivedApp",
			Path:               "/var/www/status-archived",
			ActivityTier:       "active",
			Status:             "archived",
			ProposalVisibility: "public",
			Summary:            "Archived by status Go app",
			TechStackJSON:      dbservice.JSONB(`["Go"]`),
		},
	}
	for i := range projects {
		if err := gormDB.Create(&projects[i]).Error; err != nil {
			t.Fatalf("create active project %s: %v", projects[i].ProjectKey, err)
		}
	}

	// 1. Verify buildAnalysisContext NDA sanitization & workload summary
	_, portfolioCtx, activeProjCtx, workloadSummary, matchedRefs := s.buildAnalysisContext(context.Background(), scoring.JobInput{
		Title:       "Go + PostgreSQL Backend Engineer",
		Description: "Build a Go API with PostgreSQL and Docker",
		Skills:      []string{"Go", "PostgreSQL"},
	})

	if len(portfolioCtx) != 1 || portfolioCtx[0].Title != "Go Billing Service" {
		t.Fatalf("unexpected portfolioCtx: %+v", portfolioCtx)
	}
	// 2 active (marvenio-secret + stealth-private), 1 recent (open-go-kit), archived excluded
	if workloadSummary != "2 active projects (<=72h), 1 recent (<=14d)" {
		t.Fatalf("workloadSummary = %q, want %q", workloadSummary, "2 active projects (<=72h), 1 recent (<=14d)")
	}
	if len(activeProjCtx) != 2 {
		t.Fatalf("expected 2 non-private non-archived active projects, got %d: %+v", len(activeProjCtx), activeProjCtx)
	}

	serializedCtx, _ := json.Marshal(activeProjCtx)
	serializedStr := string(serializedCtx)
	for _, forbidden := range []string{"Marvenio", "marvenio-secret", "/var/www/marvenio-secret", "fix: Marvenio secret billing bug", "StealthPrivateApp", "StealthClient", "OldArchivedApp", "StatusArchivedApp"} {
		if strings.Contains(serializedStr, forbidden) {
			t.Fatalf("activeProjCtx leaked forbidden token %q in %s", forbidden, serializedStr)
		}
	}
	if !strings.Contains(serializedStr, "OpenGoKit") {
		t.Fatalf("expected public project OpenGoKit in activeProjCtx: %s", serializedStr)
	}
	if len(matchedRefs) != 3 { // 1 matched portfolio + 2 active projects
		t.Fatalf("expected 3 matchedRefs, got %d: %+v", len(matchedRefs), matchedRefs)
	}

	// Verify loadScoringProfile excludes status=archived, private, and sanitizes anonymized entries
	scProfile := loadScoringProfile(gormDB)
	if scProfile == nil {
		t.Fatal("expected non-nil ScoringProfile")
	}
	scBytes, _ := json.Marshal(scProfile.ActiveProjects)
	scStr := string(scBytes)
	for _, forbidden := range []string{"Marvenio", "marvenio-secret", "StealthPrivateApp", "OldArchivedApp", "StatusArchivedApp"} {
		if strings.Contains(scStr, forbidden) {
			t.Fatalf("loadScoringProfile leaked forbidden token %q in %s", forbidden, scStr)
		}
	}

	// 2. Verify analyzeJobHandler auto-enriches prompt from DB
	var capturedPrompt string
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode llm payload: %v", err)
		}
		if len(payload.Messages) > 0 {
			capturedPrompt = payload.Messages[0].Content
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"message": {
				"role": "assistant",
				"content": "{\"proposal\":\"Enriched proposal\",\"execution_prompt\":\"Build\",\"time_estimate\":\"12h\",\"workload_division\":\"50/50\",\"questions_for_client\":[\"Q1\"],\"tips_and_advice\":[\"T1\"],\"tone_analysis\":\"Direct\"}"
			}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	req := httptest.NewRequest(http.MethodPost, "/api/analyze-job", strings.NewReader(`{"job_title":"Go Backend","job_description":"Need Go and PostgreSQL","skills":"Go, PostgreSQL","user_profile":"Go dev","user_skills":"Go"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.analyzeJobHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("analyzeJobHandler status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	for _, want := range []string{"RELEVANT PORTFOLIO & ACTIVE WORK:", "Go Billing Service", "OpenGoKit", "[ANONYMIZED/NDA]", "2 active projects (<=72h), 1 recent (<=14d)"} {
		if !strings.Contains(capturedPrompt, want) {
			t.Fatalf("expected enriched prompt to contain %q", want)
		}
	}
	for _, forbidden := range []string{"Marvenio", "StealthPrivateApp", "OldArchivedApp"} {
		if strings.Contains(capturedPrompt, forbidden) {
			t.Fatalf("enriched prompt leaked forbidden token %q", forbidden)
		}
	}

	// 3. Verify Server.AnalyzeJob persists PortfolioReferences and returns MatchedProjects
	job := dbservice.Job{
		Title:        "Go + PostgreSQL Engineer",
		Description:  "Build Go API with PostgreSQL and Docker",
		Skills:       "Go, PostgreSQL, Docker",
		ContractType: "fixed",
		BudgetAmount: "$3000",
	}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	useLLM := true
	res, err := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useLLM,
	})
	if err != nil {
		t.Fatalf("AnalyzeJob failed: %v", err)
	}
	if len(res.MatchedProjects) != 3 {
		t.Fatalf("expected 3 MatchedProjects on result, got %d: %+v", len(res.MatchedProjects), res.MatchedProjects)
	}

	var reloaded dbservice.Job
	if err := gormDB.First(&reloaded, job.ID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	var savedRefs []PortfolioReferenceEntry
	if err := json.Unmarshal([]byte(reloaded.PortfolioReferences), &savedRefs); err != nil {
		t.Fatalf("unmarshal PortfolioReferences: %v (raw=%s)", err, string(reloaded.PortfolioReferences))
	}
	if len(savedRefs) != 3 {
		t.Fatalf("expected 3 persisted PortfolioReferences, got %d", len(savedRefs))
	}
}

func TestAnalyzeJob_ZeroProfilesStillLoadsActiveProjects(t *testing.T) {
	s := setupTestServer(t)
	clearServerLLMEnv(t)
	gormDB := s.db.GetGorm()

	// Ensure profiles table has 0 rows
	if err := gormDB.Exec("DELETE FROM profiles").Error; err != nil {
		t.Fatalf("clear profiles: %v", err)
	}

	// Seed an eligible active project
	proj := dbservice.ActiveProject{
		ProjectKey:         "go-billing-kit",
		Slug:               "go-billing-kit",
		Name:               "GoBillingKit",
		Path:               "/var/www/go-billing-kit",
		GroupName:          "oss",
		ActivityTier:       "active",
		Status:             "active",
		ProposalVisibility: "public",
		Summary:            "Go and PostgreSQL billing CLI",
		TechStackJSON:      dbservice.JSONB(`["Go","PostgreSQL"]`),
	}
	if err := gormDB.Create(&proj).Error; err != nil {
		t.Fatalf("create active project: %v", err)
	}

	job := dbservice.Job{
		Title:        "Go + PostgreSQL Developer",
		Description:  "Need Go and PostgreSQL backend",
		Skills:       "Go, PostgreSQL",
		ContractType: "fixed",
		BudgetAmount: "$1500",
	}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	useLLM := false
	res, err := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useLLM,
	})
	if err != nil {
		t.Fatalf("AnalyzeJob failed: %v", err)
	}

	rawBreakdown, err := json.Marshal(res.ScoreBreakdown)
	if err != nil {
		t.Fatalf("marshal score_breakdown: %v", err)
	}
	var bd scoring.ScoreBreakdown
	if err := json.Unmarshal(rawBreakdown, &bd); err != nil {
		t.Fatalf("unmarshal score_breakdown: %v", err)
	}
	if len(bd.MatchedActiveProjects) != 1 || bd.MatchedActiveProjects[0] != "GoBillingKit" {
		t.Fatalf("expected MatchedActiveProjects=[GoBillingKit], got %v", bd.MatchedActiveProjects)
	}
}

func TestDecodeScreeningQuestions(t *testing.T) {
	if got := decodeScreeningQuestions(nil); got != nil {
		t.Fatalf("expected nil for empty JSONB, got %v", got)
	}
	if got := decodeScreeningQuestions(dbservice.JSONB(`null`)); got != nil {
		t.Fatalf("expected nil for null JSONB, got %v", got)
	}

	gotStrings := decodeScreeningQuestions(dbservice.JSONB(`["Describe Go API work", "  ", "Availability?"]`))
	if len(gotStrings) != 2 || gotStrings[0] != "Describe Go API work" || gotStrings[1] != "Availability?" {
		t.Fatalf("unexpected string slice questions: %v", gotStrings)
	}

	gotObjects := decodeScreeningQuestions(dbservice.JSONB(`[
		{"index": 0, "prompt": "Share Postgres tuning experience", "required": true},
		{"id": "q2", "question": "Preferred timezone?", "required": false},
		{"text": "GitHub link"}
	]`))
	if len(gotObjects) != 3 {
		t.Fatalf("expected 3 decoded object questions, got %d: %v", len(gotObjects), gotObjects)
	}
	if gotObjects[0] != "Share Postgres tuning experience (required)" ||
		gotObjects[1] != "Preferred timezone?" ||
		gotObjects[2] != "GitHub link" {
		t.Fatalf("unexpected object questions: %v", gotObjects)
	}
}

func TestAnalyzeJob_MetadataPersistenceAndDetailSignals_WithDB(t *testing.T) {
	s := setupTestServer(t)
	clearServerLLMEnv(t)
	gormDB := s.db.GetGorm()

	hireRate := 88.5
	job := dbservice.Job{
		Title:              "Senior Go + Postgres Architect",
		Description:        "Design high-throughput microservices.",
		Skills:             "Go, PostgreSQL",
		ContractType:       "hourly",
		RateRange:          "$90-$120/hr",
		Duration:           "3 to 6 months",
		HoursPerWeek:       "30+ hrs/week",
		ProposalsTier:      "Less than 5",
		ClientCountry:      "United States",
		ClientSpent:        "$80k+ spent",
		ClientHireRate:     &hireRate,
		ScreeningQuestions: dbservice.JSONB(`[{"index":0,"prompt":"Describe Go concurrency work","required":true}]`),
	}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	// 1. UseLLM=false must leave ai_enrichment_status untouched ("none")
	useFalse := false
	noLLMRes, err := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useFalse,
	})
	if err != nil {
		t.Fatalf("AnalyzeJob(UseLLM=false) failed: %v", err)
	}
	if noLLMRes.Job.AIEnrichmentStatus != "none" || noLLMRes.Usage != nil || noLLMRes.AIModel != "" || noLLMRes.AITokensUsed != nil {
		t.Fatalf("expected UseLLM=false to leave AI metadata empty/none, got %+v", noLLMRes)
	}

	var reloadedNoLLM dbservice.Job
	if err := gormDB.First(&reloadedNoLLM, job.ID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if reloadedNoLLM.AIEnrichmentStatus != "none" || reloadedNoLLM.AIEnrichedAt != nil {
		t.Fatalf("expected DB ai_enrichment_status='none' and nil ai_enriched_at, got status=%q at=%v", reloadedNoLLM.AIEnrichmentStatus, reloadedNoLLM.AIEnrichedAt)
	}

	// 2. UseLLM=true with unconfigured LLM returns 503 AND persists ai_enrichment_status='failed'
	useTrue := true
	_, unavailErr := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useTrue,
	})
	var se *ServiceError
	if !errors.As(unavailErr, &se) || se.Code != "OLLAMA_UNAVAILABLE" {
		t.Fatalf("expected OLLAMA_UNAVAILABLE ServiceError, got %v", unavailErr)
	}
	var reloadedUnavail dbservice.Job
	if err := gormDB.First(&reloadedUnavail, job.ID).Error; err != nil {
		t.Fatalf("reload job after unavailable: %v", err)
	}
	if reloadedUnavail.AIEnrichmentStatus != "failed" || strings.TrimSpace(reloadedUnavail.AIEnrichmentError) == "" {
		t.Fatalf("expected failed status and error after OLLAMA_UNAVAILABLE, got status=%q err=%q", reloadedUnavail.AIEnrichmentStatus, reloadedUnavail.AIEnrichmentError)
	}

	// 3. UseLLM=true with upstream 500 returns 502 AND persists ai_enrichment_status='failed'
	var failMode atomic.Bool
	failMode.Store(true)
	var capturedPrompt string
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failMode.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`upstream failure`))
			return
		}
		var payload struct {
			Model    string `json:"model"`
			Effort   string `json:"effort"`
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode mock AGY payload: %v", err)
		}
		if len(payload.Messages) > 0 {
			capturedPrompt = payload.Messages[0].Content
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-4-neon",
			"applied_effort": "high",
			"usage": {"inputTokens": 120, "outputTokens": 280, "thoughtTokens": 50, "totalTokens": 450},
			"message": {
				"role": "assistant",
				"content": "{\"proposal\":\"Strong Go proposal\",\"execution_prompt\":\"Build it\",\"time_estimate\":\"2 weeks\",\"workload_division\":\"50/50\",\"questions_for_client\":[\"Timeline?\"],\"tips_and_advice\":[\"Benchmark\"],\"tone_analysis\":\"Confident\"}"
			}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	_, err502 := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useTrue,
	})
	if !errors.As(err502, &se) || se.Code != "OLLAMA_ERROR" {
		t.Fatalf("expected OLLAMA_ERROR ServiceError, got %v", err502)
	}
	var reloadedFailed dbservice.Job
	if err := gormDB.First(&reloadedFailed, job.ID).Error; err != nil {
		t.Fatalf("reload job after 502: %v", err)
	}
	if reloadedFailed.AIEnrichmentStatus != "failed" || strings.TrimSpace(reloadedFailed.AIEnrichmentError) == "" {
		t.Fatalf("expected failed status and error after OLLAMA_ERROR, got status=%q err=%q", reloadedFailed.AIEnrichmentStatus, reloadedFailed.AIEnrichmentError)
	}

	// 4. UseLLM=true success injects all detail signals and persists completed metadata + usage
	failMode.Store(false)
	okRes, err := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useTrue,
		Model:  "gemini-4-neon",
		Effort: "high",
	})
	if err != nil {
		t.Fatalf("AnalyzeJob success failed: %v", err)
	}
	if okRes.Usage == nil || okRes.Usage.TotalTokens != 450 || okRes.AIModel != "gemini-4-neon" || okRes.AIEffort != "high" || okRes.AITokensUsed == nil || *okRes.AITokensUsed != 450 || okRes.AIEnrichedAt == nil {
		t.Fatalf("unexpected AnalyzeJobResult AI metadata: %+v", okRes)
	}
	if okRes.Job.AIEnrichmentStatus != "completed" || okRes.Job.AIEnrichmentError != "" {
		t.Fatalf("expected completed job entry without error, got %+v", okRes.Job)
	}
	for _, want := range []string{
		"3 to 6 months",
		"30+ hrs/week",
		"Less than 5",
		"United States",
		"$80k+ spent",
		"88.5%",
		"Describe Go concurrency work (required)",
	} {
		if !strings.Contains(capturedPrompt, want) {
			t.Fatalf("expected prompt to contain detail signal %q; prompt=%s", want, capturedPrompt)
		}
	}

	var reloadedOK dbservice.Job
	if err := gormDB.First(&reloadedOK, job.ID).Error; err != nil {
		t.Fatalf("reload completed job: %v", err)
	}
	if reloadedOK.AIEnrichmentStatus != "completed" || reloadedOK.AIEnrichedAt == nil || reloadedOK.AIEnrichmentError != "" ||
		reloadedOK.AIModel != "gemini-4-neon" || reloadedOK.AIEffort != "high" || reloadedOK.AITokensUsed == nil || *reloadedOK.AITokensUsed != 450 {
		t.Fatalf("unexpected persisted AI metadata on Job: %+v", reloadedOK)
	}
}

func TestAnalyzeJob_EnsureDetails_WithDB(t *testing.T) {
	s := setupTestServer(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()

	var capturedPrompt string
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if len(payload.Messages) > 0 {
			capturedPrompt = payload.Messages[0].Content
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 50, "outputTokens": 100, "thoughtTokens": 10, "totalTokens": 160},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Detailed proposal\",\"execution_prompt\":\"Run\",\"time_estimate\":\"5h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	// 1. Offline Chrome fallback when require_details=false vs error when require_details=true
	uidOffline := "~01offlineensure"
	offlineJob := dbservice.Job{
		UpworkJobID: &uidOffline,
		Title:       "Offline EnsureDetails Job",
		Description: "Stored fallback description",
		URL:         "https://www.upwork.com/jobs/" + uidOffline + "/",
	}
	if err := gormDB.Create(&offlineJob).Error; err != nil {
		t.Fatalf("create offline job: %v", err)
	}

	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "false")
	useTrue := true
	fallbackRes, err := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:         offlineJob.ID,
		EnsureDetails: true,
		UseLLM:        &useTrue,
	})
	if err != nil {
		t.Fatalf("expected offline fallback to succeed when ENRICHMENT_REQUIRE_DETAILS=false, got %v", err)
	}
	if fallbackRes.Job.AIEnrichmentStatus != "completed" || !strings.Contains(capturedPrompt, "Stored fallback description") {
		t.Fatalf("expected stored text fallback analysis, got res=%+v prompt=%s", fallbackRes, capturedPrompt)
	}

	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "true")
	_, reqDetailsErr := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:         offlineJob.ID,
		EnsureDetails: true,
		UseLLM:        &useTrue,
	})
	if !errors.Is(reqDetailsErr, bridge.ErrExtensionDisconnected) {
		t.Fatalf("expected ErrExtensionDisconnected when ENRICHMENT_REQUIRE_DETAILS=true, got %v", reqDetailsErr)
	}
	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "false")

	// 2. Live extension detail pre-fetch via analyzeSavedJobHandler
	var detailCalls atomic.Int32
	var challengeMode atomic.Bool
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method != "jobs.detail" {
			return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "method not found"}
		}
		detailCalls.Add(1)
		if challengeMode.Load() {
			return nil, &bridge.WireRPCError{
				Code:    json.RawMessage(`"HUMAN_ACTION_REQUIRED"`),
				Message: "Cloudflare verification required",
			}
		}
		nowStr := time.Now().UTC().Format(time.RFC3339)
		return map[string]any{
			"ok": true,
			"job": map[string]any{
				"upwork_job_id":   "~01liveensure",
				"job_title":       "Live EnsureDetails Job",
				"job_description": "Full scraped Core Web Vitals and 30+ hrs/week scope.",
				"url":             "https://www.upwork.com/jobs/~01liveensure/",
				"hours_per_week":  "30+ hrs/week",
				"client_country":  "Canada",
				"last_enriched_at": nowStr,
			},
		}, nil
	})

	uidLive := "~01liveensure"
	liveJob := dbservice.Job{
		UpworkJobID: &uidLive,
		Title:       "Live EnsureDetails Job",
		Description: "Short snippet",
		URL:         "https://www.upwork.com/jobs/~01liveensure/",
	}
	if err := gormDB.Create(&liveJob).Error; err != nil {
		t.Fatalf("create live job: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/jobs/"+strconv.FormatUint(uint64(liveJob.ID), 10)+"/analyze", strings.NewReader(`{"ensure_details":true,"use_llm":true}`))
	req.SetPathValue("id", strconv.FormatUint(uint64(liveJob.ID), 10))
	rec := httptest.NewRecorder()
	s.analyzeSavedJobHandler(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("analyzeSavedJobHandler ensure_details status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if detailCalls.Load() != 1 {
		t.Fatalf("expected 1 jobs.detail call, got %d", detailCalls.Load())
	}
	if !strings.Contains(capturedPrompt, "Core Web Vitals") || !strings.Contains(capturedPrompt, "Canada") {
		t.Fatalf("expected LLM prompt to include scraped detail signals, got %s", capturedPrompt)
	}

	// Second call with LastEnrichedAt already populated skips jobs.detail
	req2 := httptest.NewRequest(http.MethodPost, "/api/jobs/"+strconv.FormatUint(uint64(liveJob.ID), 10)+"/analyze", strings.NewReader(`{"ensure_details":true,"use_llm":true}`))
	req2.SetPathValue("id", strconv.FormatUint(uint64(liveJob.ID), 10))
	rec2 := httptest.NewRecorder()
	s.analyzeSavedJobHandler(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("second analyzeSavedJobHandler status = %d, want 200", rec2.Code)
	}
	if detailCalls.Load() != 1 {
		t.Fatalf("expected jobs.detail to be skipped when last_enriched_at is set, got %d calls", detailCalls.Load())
	}

	// 3. HUMAN_ACTION_REQUIRED propagates as HTTP 428
	uidChallenge := "~01challengeensure"
	challengeJob := dbservice.Job{
		UpworkJobID: &uidChallenge,
		Title:       "Challenge EnsureDetails Job",
		Description: "Snippet",
		URL:         "https://www.upwork.com/jobs/~01challengeensure/",
	}
	if err := gormDB.Create(&challengeJob).Error; err != nil {
		t.Fatalf("create challenge job: %v", err)
	}
	challengeMode.Store(true)
	req3 := httptest.NewRequest(http.MethodPost, "/api/jobs/"+strconv.FormatUint(uint64(challengeJob.ID), 10)+"/analyze", strings.NewReader(`{"ensure_details":true,"use_llm":true}`))
	req3.SetPathValue("id", strconv.FormatUint(uint64(challengeJob.ID), 10))
	rec3 := httptest.NewRecorder()
	s.analyzeSavedJobHandler(rec3, req3)
	if rec3.Code != http.StatusPreconditionRequired {
		t.Fatalf("expected HTTP 428 on HUMAN_ACTION_REQUIRED, got %d body=%s", rec3.Code, rec3.Body.String())
	}

	// 4. Backfill LastEnrichedAt when jobs.detail RPC omits last_enriched_at
	var noTSCalls atomic.Int32
	sNoTS := setupTestServer(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
	srvNoTS, _ := attachTestBridgeHub(t, sNoTS)
	dialAuthenticatedMockExtension(t, srvNoTS, sNoTS.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		noTSCalls.Add(1)
		return map[string]any{
			"ok": true,
			"job": map[string]any{
				"upwork_job_id":   "~01notsensure",
				"job_title":       "No Timestamp Detail Job",
				"job_description": "Full scraped description without last_enriched_at.",
				"url":             "https://www.upwork.com/jobs/~01notsensure/",
			},
		}, nil
	})

	uidNoTS := "~01notsensure"
	noTSJob := dbservice.Job{
		UpworkJobID: &uidNoTS,
		Title:       "No Timestamp Detail Job",
		Description: "Short",
		URL:         "https://www.upwork.com/jobs/~01notsensure/",
	}
	if err := sNoTS.db.GetGorm().Create(&noTSJob).Error; err != nil {
		t.Fatalf("create noTSJob: %v", err)
	}

	resFirst, err := sNoTS.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:         noTSJob.ID,
		EnsureDetails: true,
		UseLLM:        &useTrue,
	})
	if err != nil {
		t.Fatalf("first AnalyzeJob failed: %v", err)
	}
	if resFirst.Job.LastEnrichedAt == nil || *resFirst.Job.LastEnrichedAt == "" || noTSCalls.Load() != 1 {
		t.Fatalf("expected backfilled LastEnrichedAt and 1 detail call, got lastEnrichedAt=%v calls=%d", resFirst.Job.LastEnrichedAt, noTSCalls.Load())
	}

	if _, err := sNoTS.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:         noTSJob.ID,
		EnsureDetails: true,
		UseLLM:        &useTrue,
	}); err != nil {
		t.Fatalf("second AnalyzeJob failed: %v", err)
	}
	if noTSCalls.Load() != 1 {
		t.Fatalf("expected second AnalyzeJob to skip jobs.detail after backfill, got %d calls", noTSCalls.Load())
	}
}
