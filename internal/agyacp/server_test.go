package agyacp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type stubACPClient struct {
	status ClientStatus
	models []ModelInfo
	chatFn func(ctx context.Context, req ChatRequest) (ChatResult, error)
}

func (s *stubACPClient) Start(ctx context.Context) error { return nil }
func (s *stubACPClient) Warm(ctx context.Context) error  { return nil }
func (s *stubACPClient) Healthy() bool                   { return s.status.Ready }
func (s *stubACPClient) Status() ClientStatus            { return s.status }
func (s *stubACPClient) ListModels(ctx context.Context) ([]ModelInfo, error) {
	return s.models, nil
}
func (s *stubACPClient) Chat(ctx context.Context, req ChatRequest) (ChatResult, error) {
	return s.chatFn(ctx, req)
}
func (s *stubACPClient) Close() error { return nil }

func TestServerHealthAndAuth(t *testing.T) {
	client := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(nil),
	})
	defer client.Close()

	srv := NewServer(client, ServerConfig{
		Token: "test-secret-token",
	})

	// Before Warm, /health should be unauthenticated and report degraded.
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 on /health, got %d", rec.Code)
	}
	var health map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &health)
	if health["status"] != "degraded" || health["acp_ready"] != false {
		t.Fatalf("expected degraded health before warm, got %+v", health)
	}

	// Authenticated routes must reject missing/invalid token.
	for _, hdr := range []string{"", "Bearer wrong", "Basic abc"} {
		r := httptest.NewRequest(http.MethodGet, "/api/tags", nil)
		if hdr != "" {
			r.Header.Set("Authorization", hdr)
		}
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("expected 401 for auth header %q, got %d", hdr, w.Code)
		}
	}

	// Warm client and check /health -> ok.
	if err := client.Warm(context.Background()); err != nil {
		t.Fatalf("Warm failed: %v", err)
	}
	rec2 := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/health", nil))
	_ = json.Unmarshal(rec2.Body.Bytes(), &health)
	if health["status"] != "ok" || health["acp_ready"] != true {
		t.Fatalf("expected ok health after warm, got %+v", health)
	}
}

func TestServerRoutesWithHelperACP(t *testing.T) {
	client := NewClient(Config{
		AgyBin:         os.Args[0],
		ScratchDir:     t.TempDir(),
		RequestTimeout: 10 * time.Second,
		CommandFactory: newHelperCommandFactory(nil),
	})
	defer client.Close()

	srv := NewServer(client, ServerConfig{Token: "tok-123"})

	doReq := func(method, path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		r := httptest.NewRequest(method, path, &buf)
		r.Header.Set("Authorization", "Bearer tok-123")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		srv.Handler().ServeHTTP(w, r)
		return w
	}

	// GET /api/tags
	wTags := doReq(http.MethodGet, "/api/tags", nil)
	if wTags.Code != http.StatusOK {
		t.Fatalf("GET /api/tags status=%d body=%s", wTags.Code, wTags.Body.String())
	}
	var tagsResp struct {
		Models []struct {
			Name    string `json:"name"`
			Model   string `json:"model"`
			Details struct {
				DisplayName string `json:"display_name"`
			} `json:"details"`
		} `json:"models"`
	}
	_ = json.Unmarshal(wTags.Body.Bytes(), &tagsResp)
	if len(tagsResp.Models) != 2 || tagsResp.Models[0].Name != "gemini-pro-orchestrator-neon" {
		t.Fatalf("unexpected /api/tags response: %+v", tagsResp)
	}

	// GET /v1/models
	wModels := doReq(http.MethodGet, "/v1/models", nil)
	if wModels.Code != http.StatusOK {
		t.Fatalf("GET /v1/models status=%d", wModels.Code)
	}
	var modelsResp struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	_ = json.Unmarshal(wModels.Body.Bytes(), &modelsResp)
	if modelsResp.Object != "list" || len(modelsResp.Data) != 2 || modelsResp.Data[0].OwnedBy != "antigravity" {
		t.Fatalf("unexpected /v1/models response: %+v", modelsResp)
	}

	// POST /api/chat stream:true -> 400
	wStream := doReq(http.MethodPost, "/api/chat", map[string]any{
		"stream":   true,
		"messages": []ChatMessage{{Role: "user", Content: "hi"}},
	})
	if wStream.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for stream:true on /api/chat, got %d", wStream.Code)
	}

	// POST /api/chat
	wChat := doReq(http.MethodPost, "/api/chat", map[string]any{
		"model":    "gemini-4-neon",
		"messages": []ChatMessage{{Role: "user", Content: "hi"}},
		"options":  map[string]any{"effort": "high"},
	})
	if wChat.Code != http.StatusOK {
		t.Fatalf("POST /api/chat status=%d body=%s", wChat.Code, wChat.Body.String())
	}
	var chatResp struct {
		Model   string `json:"model"`
		Done    bool   `json:"done"`
		Message struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"message"`
		EffortApplied bool   `json:"effort_applied"`
		AppliedEffort string `json:"applied_effort"`
	}
	_ = json.Unmarshal(wChat.Body.Bytes(), &chatResp)
	if !chatResp.Done || chatResp.Message.Content != "Hello world!" || !chatResp.EffortApplied || chatResp.AppliedEffort != "high" {
		t.Fatalf("unexpected /api/chat response: %+v", chatResp)
	}

	// POST /v1/chat/completions stream:true -> 400
	wOAIStream := doReq(http.MethodPost, "/v1/chat/completions", map[string]any{
		"stream":   true,
		"messages": []ChatMessage{{Role: "user", Content: "hi"}},
	})
	if wOAIStream.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for stream:true on /v1/chat/completions, got %d", wOAIStream.Code)
	}

	// POST /v1/chat/completions
	wOAI := doReq(http.MethodPost, "/v1/chat/completions", map[string]any{
		"model":            "gemini-4-neon",
		"reasoning_effort": "low",
		"response_format":  map[string]string{"type": "json_object"},
		"messages":         []ChatMessage{{Role: "user", Content: "hi"}},
	})
	if wOAI.Code != http.StatusOK {
		t.Fatalf("POST /v1/chat/completions status=%d body=%s", wOAI.Code, wOAI.Body.String())
	}
	var oaiResp struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	_ = json.Unmarshal(wOAI.Body.Bytes(), &oaiResp)
	if oaiResp.Object != "chat.completion" || len(oaiResp.Choices) != 1 || oaiResp.Choices[0].Message.Content != "Hello world!" || oaiResp.Usage.TotalTokens != 17 {
		t.Fatalf("unexpected /v1/chat/completions response: %+v", oaiResp)
	}
}

func TestServerErrorMapping(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		wantCode int
		wantBody string
	}{
		{
			name:     "auth_required",
			err:      ErrAuthRequired,
			wantCode: http.StatusServiceUnavailable,
			wantBody: "AGY_AUTH_REQUIRED",
		},
		{
			name:     "deadline_exceeded",
			err:      context.DeadlineExceeded,
			wantCode: http.StatusGatewayTimeout,
			wantBody: "timed out",
		},
		{
			name:     "canceled",
			err:      context.Canceled,
			wantCode: 499,
			wantBody: "canceled",
		},
		{
			name:     "upstream",
			err:      errors.New("boom"),
			wantCode: http.StatusBadGateway,
			wantBody: "boom",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &stubACPClient{
				status: ClientStatus{Ready: true},
				chatFn: func(ctx context.Context, req ChatRequest) (ChatResult, error) {
					return ChatResult{}, tc.err
				},
			}
			srv := NewServer(stub, ServerConfig{Token: "tok"})
			r := httptest.NewRequest(http.MethodPost, "/api/chat", bytes.NewBufferString(`{"messages":[{"role":"user","content":"hi"}]}`))
			r.Header.Set("Authorization", "Bearer tok")
			w := httptest.NewRecorder()
			srv.Handler().ServeHTTP(w, r)
			if w.Code != tc.wantCode {
				t.Fatalf("want status %d, got %d (%s)", tc.wantCode, w.Code, w.Body.String())
			}
			if !bytes.Contains(w.Body.Bytes(), []byte(tc.wantBody)) {
				t.Fatalf("expected body to contain %q, got %s", tc.wantBody, w.Body.String())
			}
		})
	}
}

func TestResolveOrCreateGatewayToken(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "sub", "agy-gateway-token")
	t.Setenv("AGY_GATEWAY_TOKEN", "")
	t.Setenv("AGY_GATEWAY_TOKEN_PATH", tokenPath)

	tok1, src1, err := ResolveOrCreateGatewayToken()
	if err != nil {
		t.Fatalf("ResolveOrCreateGatewayToken create failed: %v", err)
	}
	if len(tok1) != 64 || src1 != tokenPath {
		t.Fatalf("unexpected token/source: len=%d src=%q", len(tok1), src1)
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatalf("stat token file: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 perms, got %o", info.Mode().Perm())
	}

	tok2, _, err := ResolveOrCreateGatewayToken()
	if err != nil {
		t.Fatalf("ResolveOrCreateGatewayToken read failed: %v", err)
	}
	if tok2 != tok1 {
		t.Fatalf("expected existing token to be reused")
	}

	t.Setenv("AGY_GATEWAY_TOKEN", "explicit-env-token")
	tok3, src3, err := ResolveOrCreateGatewayToken()
	if err != nil {
		t.Fatalf("ResolveOrCreateGatewayToken env failed: %v", err)
	}
	if tok3 != "explicit-env-token" || src3 != "env:AGY_GATEWAY_TOKEN" {
		t.Fatalf("unexpected env token/source: %q %q", tok3, src3)
	}
}
