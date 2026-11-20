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
