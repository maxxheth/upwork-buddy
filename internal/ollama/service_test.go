package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseResponseMarkdownWrappedJSON(t *testing.T) {
	service := &Service{}

	result := service.parseResponse("```json\n{\n  \"proposal\": \"Hello\",\n  \"execution_prompt\": \"Build it\",\n  \"time_estimate\": \"10 hours\",\n  \"workload_division\": \"50/50\",\n  \"questions_for_client\": [\"Question 1\"],\n  \"tips_and_advice\": [\"Tip 1\"],\n  \"tone_analysis\": \"Professional\"\n}\n```")

	if result.Proposal != "Hello" {
		t.Fatalf("expected proposal to be parsed, got %q", result.Proposal)
	}
	if result.ExecutionPrompt != "Build it" {
		t.Fatalf("expected execution prompt to be parsed, got %q", result.ExecutionPrompt)
	}
	if len(result.QuestionsForClient) != 1 {
		t.Fatalf("expected one client question, got %d", len(result.QuestionsForClient))
	}
	if len(result.TipsAndAdvice) != 1 {
		t.Fatalf("expected one tip, got %d", len(result.TipsAndAdvice))
	}
	if result.ToneAnalysis != "Professional" {
		t.Fatalf("expected tone analysis to be parsed, got %q", result.ToneAnalysis)
	}
}

func TestParseResponseStructuredTimeEstimateAndWorkloadDivision(t *testing.T) {
	service := &Service{}

	result := service.parseResponse(`{
  "proposal": "Structured proposal",
  "execution_prompt": "Execute step by step",
  "time_estimate": {"total_hours": 24, "phases": ["Setup", "Build"]},
  "workload_division": {"ai_percent": 70, "human_percent": 30},
  "questions_for_client": ["What is the target launch date?"],
  "tips_and_advice": ["Set weekly milestones"],
  "tone_analysis": "Technical"
}`)

	if result.ExecutionPrompt != "Execute step by step" {
		t.Fatalf("expected execution prompt, got %q", result.ExecutionPrompt)
	}
	if !strings.Contains(string(result.TimeEstimate), `"total_hours"`) {
		t.Fatalf("expected structured time_estimate JSON, got %s", string(result.TimeEstimate))
	}
	if !strings.Contains(string(result.WorkloadDivision), `"ai_percent"`) {
		t.Fatalf("expected structured workload_division JSON, got %s", string(result.WorkloadDivision))
	}
}

func TestParseResponseInvalidJSONFallsBackToRawText(t *testing.T) {
	service := &Service{}

	result := service.parseResponse("this is not valid json")

	if result.Proposal != "this is not valid json" {
		t.Fatalf("expected raw text fallback, got %q", result.Proposal)
	}
	if result.ExecutionPrompt == "" {
		t.Fatal("expected fallback execution prompt message")
	}
}

func TestNormalizeHost(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "local host without scheme", in: "0.0.0.0:11434", want: "http://0.0.0.0:11434"},
		{name: "localhost without scheme", in: "localhost:11434/", want: "http://localhost:11434"},
		{name: "https host preserved", in: "https://ollama.com/", want: "https://ollama.com"},
		{name: "http host preserved", in: "http://127.0.0.1:11434", want: "http://127.0.0.1:11434"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeHost(tt.in); got != tt.want {
				t.Fatalf("normalizeHost(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func clearLLMEnv(t *testing.T) {
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

func TestProviderSelection(t *testing.T) {
	t.Run("auto unconfigured", func(t *testing.T) {
		clearLLMEnv(t)
		if got := ActiveProvider(); got != "" {
			t.Fatalf("ActiveProvider() = %q, want empty", got)
		}
		if IsConfigured() {
			t.Fatal("IsConfigured() = true, want false")
		}
		if _, err := New(); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("New() err = %v, want ErrUnavailable", err)
		}
	})

	t.Run("auto falls back to ollama", func(t *testing.T) {
		clearLLMEnv(t)
		t.Setenv("OLLAMA_API_KEY", "test-ollama-key")
		if got := ActiveProvider(); got != "ollama" {
			t.Fatalf("ActiveProvider() = %q, want ollama", got)
		}
		if !IsConfigured() {
			t.Fatal("IsConfigured() = false, want true")
		}
		svc, err := New()
		if err != nil {
			t.Fatalf("New() failed: %v", err)
		}
		if svc.provider != "ollama" || svc.host != defaultHost || svc.model != defaultModel {
			t.Fatalf("unexpected service config: %+v", svc)
		}
	})

	t.Run("auto prefers agy when AGY_ENDPOINT_URL is set", func(t *testing.T) {
		clearLLMEnv(t)
		t.Setenv("AGY_ENDPOINT_URL", "http://127.0.0.1:18435/")
		t.Setenv("OLLAMA_API_KEY", "test-ollama-key")
		if got := ActiveProvider(); got != "agy" {
			t.Fatalf("ActiveProvider() = %q, want agy", got)
		}
		svc, err := New()
		if err != nil {
			t.Fatalf("New() failed: %v", err)
		}
		if svc.provider != "agy" || svc.host != "http://127.0.0.1:18435" || svc.model != defaultAGYModel || svc.effort != defaultAGYEffort {
			t.Fatalf("unexpected service config: %+v", svc)
		}
	})

	t.Run("explicit agy uses default endpoint", func(t *testing.T) {
		clearLLMEnv(t)
		t.Setenv("LLM_PROVIDER", "agy")
		if got := ActiveProvider(); got != "agy" {
			t.Fatalf("ActiveProvider() = %q, want agy", got)
		}
		svc, err := New()
		if err != nil {
			t.Fatalf("New() failed: %v", err)
		}
		if svc.host != defaultAGYEndpoint {
			t.Fatalf("host = %q, want %q", svc.host, defaultAGYEndpoint)
		}
	})

	t.Run("explicit ollama requires OLLAMA_API_KEY", func(t *testing.T) {
		clearLLMEnv(t)
		t.Setenv("LLM_PROVIDER", "ollama")
		t.Setenv("AGY_ENDPOINT_URL", "http://127.0.0.1:11435")
		if got := ActiveProvider(); got != "" {
			t.Fatalf("ActiveProvider() = %q, want empty", got)
		}
		if _, err := New(); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("New() err = %v, want ErrUnavailable", err)
		}
	})
}

func TestAGYTokenAndTimeoutResolution(t *testing.T) {
	clearLLMEnv(t)
	tokenFile := filepath.Join(t.TempDir(), "agy-token")
	if err := os.WriteFile(tokenFile, []byte("  file-secret-token \n"), 0600); err != nil {
		t.Fatalf("write token file: %v", err)
	}
	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_TOKEN_PATH", tokenFile)
	t.Setenv("LLM_TIMEOUT_SECONDS", "3")

	svc, err := New()
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	if svc.apiKey != "file-secret-token" {
		t.Fatalf("apiKey = %q, want file-secret-token", svc.apiKey)
	}
	if svc.client.Timeout != 10*time.Second {
		t.Fatalf("Timeout = %v, want 10s (clamped minimum)", svc.client.Timeout)
	}

	t.Setenv("AGY_API_KEY", "env-secret-token")
	t.Setenv("LLM_TIMEOUT_SECONDS", "45")
	svc2, err := New()
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	if svc2.apiKey != "env-secret-token" {
		t.Fatalf("apiKey = %q, want env-secret-token", svc2.apiKey)
	}
	if svc2.client.Timeout != 45*time.Second {
		t.Fatalf("Timeout = %v, want 45s", svc2.client.Timeout)
	}
}

func TestAnalyzeJobAGYMockAndOverrides(t *testing.T) {
	clearLLMEnv(t)

	var gotAuth string
	var gotReq chatRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotReq); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(chatResponse{
			Model: gotReq.Model,
			Message: chatMessage{
				Role: "assistant",
				Content: `{
  "proposal": "Great fit for your Go backend.",
  "execution_prompt": "Step 1: Build it.",
  "time_estimate": "8 hours",
  "workload_division": "60/40",
  "questions_for_client": ["Any deadline?"],
  "tips_and_advice": ["Keep it simple"],
  "tone_analysis": "Direct and technical"
}`,
			},
		})
	}))
	defer srv.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", srv.URL)
	t.Setenv("AGY_API_KEY", "agy-test-token")

	svc, err := New()
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	res, err := svc.AnalyzeJob(context.Background(), JobAnalysisRequest{
		JobTitle:       "Go API Engineer",
		JobDescription: "Build a REST API",
		UserProfile:    "Senior Go dev",
		UserSkills:     "Go, Postgres",
		Model:          "gemini-4-neon",
		Effort:         "high",
	})
	if err != nil {
		t.Fatalf("AnalyzeJob() failed: %v", err)
	}

	if gotAuth != "Bearer agy-test-token" {
		t.Fatalf("Authorization = %q, want Bearer agy-test-token", gotAuth)
	}
	if gotReq.Model != "gemini-4-neon" {
		t.Fatalf("request model = %q, want gemini-4-neon", gotReq.Model)
	}
	if gotReq.Effort != "high" {
		t.Fatalf("request effort = %q, want high", gotReq.Effort)
	}
	if gotReq.Format != "json" {
		t.Fatalf("request format = %q, want json", gotReq.Format)
	}
	if len(gotReq.Messages) != 1 || !strings.Contains(gotReq.Messages[0].Content, "Do not call any tools. Return valid JSON only") {
		t.Fatalf("prompt missing single-turn no-tools instruction")
	}
	if res.Proposal != "Great fit for your Go backend." {
		t.Fatalf("unexpected proposal: %q", res.Proposal)
	}
}

func TestDoChatErrorClassification(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		wantErr    error
	}{
		{
			name:       "503 unavailable",
			statusCode: http.StatusServiceUnavailable,
			body:       `{"error":"gateway warming"}`,
			wantErr:    ErrUnavailable,
		},
		{
			name:       "503 auth required",
			statusCode: http.StatusServiceUnavailable,
			body:       `{"error":"AGY_AUTH_REQUIRED: please login"}`,
			wantErr:    ErrAuthRequired,
		},
		{
			name:       "401 unauthorized",
			statusCode: http.StatusUnauthorized,
			body:       `{"error":"unauthorized"}`,
			wantErr:    ErrAuthRequired,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clearLLMEnv(t)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tt.statusCode)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer srv.Close()

			t.Setenv("LLM_PROVIDER", "agy")
			t.Setenv("AGY_ENDPOINT_URL", srv.URL)
			svc, err := New()
			if err != nil {
				t.Fatalf("New() failed: %v", err)
			}
			_, err = svc.doChat(context.Background(), chatRequest{Model: defaultAGYModel})
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("doChat() err = %v, want %v", err, tt.wantErr)
			}
		})
	}
}

func TestGenerateAgentUnauthenticatedAGY(t *testing.T) {
	clearLLMEnv(t)
	var hasAuthHeader bool
	var gotEffort string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hasAuthHeader = r.Header["Authorization"]
		var req chatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		gotEffort = req.Effort
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(chatResponse{
			Model: req.Model,
			Message: chatMessage{
				Role:    "assistant",
				Content: "---\nname: go-agent\ndescription: Helps with Go\ntools: Read, Edit\n---\nBody",
			},
		})
	}))
	defer srv.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", srv.URL)
	svc, err := New()
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	resp, err := svc.GenerateAgent(context.Background(), GenerateAgentRequest{
		TemplateName: "go-api",
		AgentName:    "go-agent",
		AgentTitle:   "Go Agent",
		AgentDesc:    "Go helper",
		Format:       "claude",
	})
	if err != nil {
		t.Fatalf("GenerateAgent() failed: %v", err)
	}
	if hasAuthHeader {
		t.Fatal("expected no Authorization header when AGY token is unset")
	}
	if gotEffort != defaultAGYEffort {
		t.Fatalf("effort = %q, want %q", gotEffort, defaultAGYEffort)
	}
	if resp.FileName != "go-agent.md" {
		t.Fatalf("FileName = %q, want go-agent.md", resp.FileName)
	}
}

func TestBuildAnalysisPromptPortfolioActiveProjectsAndWorkload(t *testing.T) {
	svc := &Service{}

	t.Run("omits optional sections when empty", func(t *testing.T) {
		prompt := svc.buildAnalysisPrompt(JobAnalysisRequest{
			JobTitle:       "Go Backend",
			JobDescription: "Build API",
			UserProfile:    "Go dev",
			UserSkills:     "Go",
		})
		if strings.Contains(prompt, "RELEVANT PORTFOLIO & ACTIVE WORK") {
			t.Fatal("expected RELEVANT PORTFOLIO & ACTIVE WORK to be omitted when empty")
		}
		if strings.Contains(prompt, "CURRENT WORKLOAD CONTEXT") {
			t.Fatal("expected CURRENT WORKLOAD CONTEXT to be omitted when empty")
		}
		for _, key := range []string{
			`"proposal"`, `"execution_prompt"`, `"time_estimate"`,
			`"workload_division"`, `"questions_for_client"`, `"tips_and_advice"`, `"tone_analysis"`,
		} {
			if !strings.Contains(prompt, key) {
				t.Fatalf("expected JSON key %s in prompt", key)
			}
		}
	})

	t.Run("renders portfolio, public and anonymized active projects, and workload summary", func(t *testing.T) {
		prompt := svc.buildAnalysisPrompt(JobAnalysisRequest{
			JobTitle:       "Go + Postgres API",
			JobDescription: "Build scalable REST API",
			UserProfile:    "Senior Go Engineer",
			UserSkills:     "Go, PostgreSQL",
			PortfolioItems: []PortfolioContext{
				{
					Title:       "Ledger Engine",
					Link:        "https://example.com/ledger",
					Description: "High-throughput accounting API",
				},
			},
			ActiveProjects: []ActiveProjectContext{
				{
					DisplayName:  "OpenGoKit",
					Visibility:   "public",
					ActivityTier: "active",
					Summary:      "Open source Go toolkit",
					RecentFocus:  "v2 router",
					TechStack:    []string{"Go", "Redis"},
				},
				{
					DisplayName:  "Enterprise FinTech API",
					Visibility:   "anonymized",
					ActivityTier: "recent",
					Summary:      "Multi-tenant billing service",
					TechStack:    []string{"Go", "PostgreSQL"},
				},
			},
			WorkloadSummary: "4 active projects (<=72h), 2 recent (<=14d)",
		})

		for _, want := range []string{
			"RELEVANT PORTFOLIO & ACTIVE WORK:",
			"For any entry tagged [ANONYMIZED/NDA], NEVER disclose client names, company names, or internal repo paths",
			"[PORTFOLIO] Ledger Engine (https://example.com/ledger): High-throughput accounting API",
			"[PUBLIC] OpenGoKit (active) [Go, Redis]: Open source Go toolkit | Recent focus: v2 router",
			"[ANONYMIZED/NDA] Enterprise FinTech API (recent) [Go, PostgreSQL]: Multi-tenant billing service",
			"CURRENT WORKLOAD CONTEXT:",
			"4 active projects (<=72h), 2 recent (<=14d)",
			"time_estimate",
			"tips_and_advice",
		} {
			if !strings.Contains(prompt, want) {
				t.Fatalf("expected prompt to contain %q, got:\n%s", want, prompt)
			}
		}
	})

	t.Run("skips private, defaults unknown/empty visibility to ANONYMIZED/NDA, and suppresses RecentFocus for non-public", func(t *testing.T) {
		prompt := svc.buildAnalysisPrompt(JobAnalysisRequest{
			JobTitle:       "Go Backend",
			JobDescription: "Build API",
			UserProfile:    "Go dev",
			UserSkills:     "Go",
			ActiveProjects: []ActiveProjectContext{
				{
					DisplayName: "SecretPrivateProj",
					Visibility:  "private",
					Summary:     "Should never appear",
					RecentFocus: "secret commit",
				},
				{
					DisplayName: "UnknownVisProj",
					Visibility:  "",
					Summary:     "Generic summary",
					RecentFocus: "should-be-suppressed-focus",
				},
				{
					DisplayName: "AnonWithFocus",
					Visibility:  "anonymized",
					Summary:     "Anon summary",
					RecentFocus: "another-suppressed-focus",
				},
			},
		})

		if strings.Contains(prompt, "SecretPrivateProj") || strings.Contains(prompt, "Should never appear") {
			t.Fatalf("private project leaked into prompt:\n%s", prompt)
		}
		if strings.Contains(prompt, "should-be-suppressed-focus") || strings.Contains(prompt, "another-suppressed-focus") {
			t.Fatalf("RecentFocus leaked for non-public project:\n%s", prompt)
		}
		if !strings.Contains(prompt, "[ANONYMIZED/NDA] UnknownVisProj") {
			t.Fatalf("expected unknown/empty visibility to default to [ANONYMIZED/NDA], got:\n%s", prompt)
		}
		if !strings.Contains(prompt, "[ANONYMIZED/NDA] AnonWithFocus") {
			t.Fatalf("expected anonymized tag, got:\n%s", prompt)
		}
	})
}

func TestParseResponseRepairMalformedJSON(t *testing.T) {
	svc := &Service{}

	t.Run("unescaped interior quotes like Copy for Billing Sheet", func(t *testing.T) {
		raw := `{
  "proposal": "Great fit.",
  "execution_prompt": "Add a **"Copy for Billing Sheet"** button in the header.",
  "time_estimate": "8 hours",
  "workload_division": "50/50",
  "questions_for_client": ["Any deadline?"],
  "tips_and_advice": ["Test early"],
  "tone_analysis": "Direct"
}`
		res := svc.parseResponse(raw)
		want := `Add a **"Copy for Billing Sheet"** button in the header.`
		if res.ExecutionPrompt != want {
			t.Fatalf("ExecutionPrompt = %q, want %q", res.ExecutionPrompt, want)
		}
		if res.Proposal != "Great fit." {
			t.Fatalf("Proposal = %q, want %q", res.Proposal, "Great fit.")
		}
	})

	t.Run("raw unescaped newlines and tabs inside JSON strings", func(t *testing.T) {
		raw := "{\n  \"proposal\": \"Line one\nLine two\tindented\",\n  \"execution_prompt\": \"Step 1\nStep 2\",\n  \"time_estimate\": \"4h\",\n  \"workload_division\": \"60/40\",\n  \"questions_for_client\": [\"Q1\"],\n  \"tips_and_advice\": [\"T1\"],\n  \"tone_analysis\": \"Casual\"\n}"
		res := svc.parseResponse(raw)
		if res.Proposal != "Line one\nLine two\tindented" {
			t.Fatalf("Proposal = %q, want %q", res.Proposal, "Line one\nLine two\tindented")
		}
		if res.ExecutionPrompt != "Step 1\nStep 2" {
			t.Fatalf("ExecutionPrompt = %q, want %q", res.ExecutionPrompt, "Step 1\nStep 2")
		}
	})

	t.Run("quote before comma in prose", func(t *testing.T) {
		raw := `{
  "proposal": "The client said "hello", then described the API.",
  "execution_prompt": "Build it",
  "time_estimate": "5h",
  "workload_division": "50/50",
  "questions_for_client": ["Ask about "scope", then timeline?"],
  "tips_and_advice": ["Keep it simple"],
  "tone_analysis": "Friendly"
}`
		res := svc.parseResponse(raw)
		wantProp := `The client said "hello", then described the API.`
		if res.Proposal != wantProp {
			t.Fatalf("Proposal = %q, want %q", res.Proposal, wantProp)
		}
		if len(res.QuestionsForClient) != 1 || res.QuestionsForClient[0] != `Ask about "scope", then timeline?` {
			t.Fatalf("QuestionsForClient = %v", res.QuestionsForClient)
		}
	})

	t.Run("leading and trailing non-JSON prose around JSON object", func(t *testing.T) {
		raw := `Here is the analysis you requested:
{
  "proposal": "Wrapped proposal",
  "execution_prompt": "Click **"Run"**",
  "time_estimate": "6h",
  "workload_division": "70/30",
  "questions_for_client": ["Q1"],
  "tips_and_advice": ["T1"],
  "tone_analysis": "Technical"
}
Hope that helps!`
		res := svc.parseResponse(raw)
		if res.Proposal != "Wrapped proposal" {
			t.Fatalf("Proposal = %q, want %q", res.Proposal, "Wrapped proposal")
		}
		if res.ExecutionPrompt != `Click **"Run"**` {
			t.Fatalf("ExecutionPrompt = %q, want %q", res.ExecutionPrompt, `Click **"Run"**`)
		}
	})

	t.Run("inline JSON snippet and multi-byte UTF-8 inside string value", func(t *testing.T) {
		raw := `{
  "proposal": "Café — modern API",
  "execution_prompt": "Return {"status": "ok"} from the health endpoint — café ready.",
  "time_estimate": "5h",
  "workload_division": "50/50",
			"questions_for_client": ["Support {"v1": true}?"],
			"tips_and_advice": ["Keep it simple"],
			"tone_analysis": "Technical"
		}`
		res := svc.parseResponse(raw)
		wantExec := `Return {"status": "ok"} from the health endpoint — café ready.`
		if res.ExecutionPrompt != wantExec {
			t.Fatalf("ExecutionPrompt = %q, want %q", res.ExecutionPrompt, wantExec)
		}
		if res.Proposal != "Café — modern API" {
			t.Fatalf("Proposal = %q, want %q", res.Proposal, "Café — modern API")
		}
		if len(res.QuestionsForClient) != 1 || res.QuestionsForClient[0] != `Support {"v1": true}?` {
			t.Fatalf("QuestionsForClient = %v", res.QuestionsForClient)
		}
	})

	t.Run("non-JSON text still falls back cleanly", func(t *testing.T) {
		raw := "Sorry, I cannot complete this request right now."
		res := svc.parseResponse(raw)
		if res.Proposal != raw {
			t.Fatalf("Proposal = %q, want %q", res.Proposal, raw)
		}
		if !strings.Contains(res.ExecutionPrompt, "Failed to parse response") {
			t.Fatalf("expected fallback execution prompt, got %q", res.ExecutionPrompt)
		}
	})
}

func TestAnalyzeJobAGYUsageAndAppliedEffort(t *testing.T) {
	t.Run("camelCase usage and applied_effort", func(t *testing.T) {
		clearLLMEnv(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"model": "gemini-pro-orchestrator-neon",
				"created_at": "2026-11-21T00:00:00Z",
				"effort_applied": true,
				"applied_effort": "high",
				"usage": {"inputTokens": 1200, "outputTokens": 350, "thoughtTokens": 150, "totalTokens": 1700},
				"message": {"role": "assistant", "content": "{\"proposal\":\"P\",\"execution_prompt\":\"E\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
			}`))
		}))
		defer srv.Close()

		t.Setenv("LLM_PROVIDER", "agy")
		t.Setenv("AGY_ENDPOINT_URL", srv.URL)
		svc, err := New()
		if err != nil {
			t.Fatalf("New() failed: %v", err)
		}

		res, err := svc.AnalyzeJob(context.Background(), JobAnalysisRequest{
			JobTitle:       "Go Backend",
			JobDescription: "Build API",
			UserProfile:    "Go dev",
			UserSkills:     "Go",
			Effort:         "medium",
		})
		if err != nil {
			t.Fatalf("AnalyzeJob() failed: %v", err)
		}
		if res.Model != "gemini-pro-orchestrator-neon" {
			t.Errorf("Model = %q, want gemini-pro-orchestrator-neon", res.Model)
		}
		if res.Effort != "high" {
			t.Errorf("Effort = %q, want 'high'", res.Effort)
		}
		if res.Usage == nil || res.Usage.InputTokens != 1200 || res.Usage.OutputTokens != 350 || res.Usage.ThoughtTokens != 150 || res.Usage.TotalTokens != 1700 {
			t.Fatalf("unexpected Usage: %+v", res.Usage)
		}
	})

	t.Run("snake_case usage, totalTokens fallback sum, and effort_applied false", func(t *testing.T) {
		clearLLMEnv(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"model": "",
				"effort_applied": false,
				"usage": {"input_tokens": 500, "output_tokens": 200, "thought_tokens": 50},
				"message": {"role": "assistant", "content": "not valid json fallback"}
			}`))
		}))
		defer srv.Close()

		t.Setenv("LLM_PROVIDER", "agy")
		t.Setenv("AGY_ENDPOINT_URL", srv.URL)
		svc, err := New()
		if err != nil {
			t.Fatalf("New() failed: %v", err)
		}

		res, err := svc.AnalyzeJob(context.Background(), JobAnalysisRequest{
			JobTitle:       "Go Backend",
			JobDescription: "Build API",
			UserProfile:    "Go dev",
			UserSkills:     "Go",
			Model:          "custom-model",
			Effort:         "high",
		})
		if err != nil {
			t.Fatalf("AnalyzeJob() failed: %v", err)
		}
		if res.Model != "custom-model" {
			t.Errorf("Model = %q, want 'custom-model' fallback", res.Model)
		}
		if res.Effort != "" {
			t.Errorf("Effort = %q, want '' when effort_applied=false", res.Effort)
		}
		if res.Usage == nil || res.Usage.TotalTokens != 750 {
			t.Fatalf("expected summed TotalTokens=750, got %+v", res.Usage)
		}
	})

	t.Run("omitted usage returns nil Usage", func(t *testing.T) {
		clearLLMEnv(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"model": "gemini-pro-orchestrator-neon",
				"message": {"role": "assistant", "content": "{\"proposal\":\"P\",\"execution_prompt\":\"E\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
			}`))
		}))
		defer srv.Close()

		t.Setenv("LLM_PROVIDER", "agy")
		t.Setenv("AGY_ENDPOINT_URL", srv.URL)
		svc, err := New()
		if err != nil {
			t.Fatalf("New() failed: %v", err)
		}

		res, err := svc.AnalyzeJob(context.Background(), JobAnalysisRequest{
			JobTitle:       "Go Backend",
			JobDescription: "Build API",
			UserProfile:    "Go dev",
			UserSkills:     "Go",
		})
		if err != nil {
			t.Fatalf("AnalyzeJob() failed: %v", err)
		}
		if res.Usage != nil {
			t.Fatalf("expected nil Usage when omitted, got %+v", res.Usage)
		}
		if res.Effort != defaultAGYEffort {
			t.Errorf("Effort = %q, want %q when effort_applied omitted", res.Effort, defaultAGYEffort)
		}
	})
}

func TestAnalyzeJobOllamaTokenCounts(t *testing.T) {
	clearLLMEnv(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gpt-oss:120b",
			"prompt_eval_count": 900,
			"eval_count": 250,
			"message": {"role": "assistant", "content": "{\"proposal\":\"P\",\"execution_prompt\":\"E\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer srv.Close()

	t.Setenv("LLM_PROVIDER", "ollama")
	t.Setenv("OLLAMA_API_KEY", "test-ollama-key")
	t.Setenv("OLLAMA_HOST", srv.URL)

	svc, err := New()
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}

	res, err := svc.AnalyzeJob(context.Background(), JobAnalysisRequest{
		JobTitle:       "Go Backend",
		JobDescription: "Build API",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
	})
	if err != nil {
		t.Fatalf("AnalyzeJob() failed: %v", err)
	}
	if res.Model != "gpt-oss:120b" {
		t.Errorf("Model = %q, want 'gpt-oss:120b'", res.Model)
	}
	if res.Effort != "" {
		t.Errorf("Effort = %q, want '' for ollama", res.Effort)
	}
	if res.Usage == nil || res.Usage.InputTokens != 900 || res.Usage.OutputTokens != 250 || res.Usage.TotalTokens != 1150 {
		t.Fatalf("unexpected Ollama Usage: %+v", res.Usage)
	}
}

func TestBuildAnalysisPromptDetailSignals(t *testing.T) {
	svc := &Service{}

	t.Run("omits detail lines when empty", func(t *testing.T) {
		prompt := svc.buildAnalysisPrompt(JobAnalysisRequest{
			JobTitle:       "Go Backend",
			JobDescription: "Build API",
			UserProfile:    "Go dev",
			UserSkills:     "Go",
		})
		for _, label := range []string{
			"Duration:",
			"Hours Per Week:",
			"Proposals:",
			"Client Country:",
			"Client Spent:",
			"Client Hire Rate:",
			"Screening Questions:",
		} {
			if strings.Contains(prompt, label) {
				t.Errorf("expected %q to be omitted when empty", label)
			}
		}
		if !strings.Contains(prompt, "Experience Level: Not specified\n\nCONTRACTOR PROFILE:") {
			t.Errorf("unexpected spacing between JOB POSTING and CONTRACTOR PROFILE:\n%s", prompt)
		}
	})

	t.Run("renders all 7 detail fields inside JOB POSTING before CONTRACTOR PROFILE", func(t *testing.T) {
		hireRate := 87.5
		prompt := svc.buildAnalysisPrompt(JobAnalysisRequest{
			JobTitle:           "Go Backend",
			JobDescription:     "Build API",
			ExperienceLevel:    "Expert",
			Duration:           "3 to 6 months",
			HoursPerWeek:       "30+ hrs/week",
			ProposalsTier:      "5 to 10",
			ClientCountry:      "United States",
			ClientSpent:        "$50K+",
			ClientHireRate:     &hireRate,
			ScreeningQuestions: []string{" Describe your Postgres tuning experience ", "  ", "Availability?"},
			UserProfile:        "Go dev",
			UserSkills:         "Go",
		})

		jobIdx := strings.Index(prompt, "JOB POSTING:")
		profIdx := strings.Index(prompt, "CONTRACTOR PROFILE:")
		if jobIdx < 0 || profIdx <= jobIdx {
			t.Fatalf("missing JOB POSTING / CONTRACTOR PROFILE markers")
		}
		jobSection := prompt[jobIdx:profIdx]

		for _, want := range []string{
			"Duration: 3 to 6 months",
			"Hours Per Week: 30+ hrs/week",
			"Proposals: 5 to 10",
			"Client Country: United States",
			"Client Spent: $50K+",
			"Client Hire Rate: 87.5%",
			"Screening Questions:\n- Describe your Postgres tuning experience\n- Availability?",
		} {
			if !strings.Contains(jobSection, want) {
				t.Errorf("expected JOB POSTING section to contain %q, got:\n%s", want, jobSection)
			}
		}
	})
}
