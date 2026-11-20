package agyacp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultGatewayHost = "127.0.0.1"
	defaultGatewayPort = 11435
	maxRequestBodySize = 4 * 1024 * 1024
)

// ServerConfig configures the local Antigravity ACP HTTP gateway.
type ServerConfig struct {
	Host          string
	Port          int
	Token         string
	DefaultModel  string
	DefaultEffort string
	Logger        *slog.Logger
}

// Server exposes Ollama-compatible and OpenAI-compatible HTTP endpoints backed by ACPClient.
type Server struct {
	cfg    ServerConfig
	client ACPClient
	logger *slog.Logger
	mux    *http.ServeMux
}

// NewServer constructs an HTTP gateway server around an ACPClient.
func NewServer(client ACPClient, cfg ServerConfig) *Server {
	if strings.TrimSpace(cfg.Host) == "" {
		cfg.Host = defaultGatewayHost
	}
	if cfg.Port <= 0 {
		cfg.Port = defaultGatewayPort
	}
	if strings.TrimSpace(cfg.DefaultModel) == "" {
		cfg.DefaultModel = defaultModelName
	}
	if strings.TrimSpace(cfg.DefaultEffort) == "" {
		cfg.DefaultEffort = defaultEffortLevel
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}

	s := &Server{
		cfg:    cfg,
		client: client,
		logger: logger,
		mux:    http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

// Handler returns the root HTTP handler for the gateway.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// ListenAddr returns the host:port address for the gateway.
func (s *Server) ListenAddr() string {
	return fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
}

func (s *Server) registerRoutes() {
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.Handle("GET /api/tags", s.authMiddleware(http.HandlerFunc(s.handleOllamaTags)))
	s.mux.Handle("GET /v1/models", s.authMiddleware(http.HandlerFunc(s.handleOpenAIModels)))
	s.mux.Handle("POST /api/chat", s.authMiddleware(http.HandlerFunc(s.handleOllamaChat)))
	s.mux.Handle("POST /v1/chat/completions", s.authMiddleware(http.HandlerFunc(s.handleOpenAIChatCompletions)))
}

// ValidateToken verifies provided against the configured gateway Bearer token in constant time.
func (s *Server) ValidateToken(provided string) bool {
	if s == nil {
		return false
	}
	expected := strings.TrimSpace(s.cfg.Token)
	candidate := strings.TrimSpace(provided)
	if expected == "" || candidate == "" {
		return false
	}
	expectedSum := sha256.Sum256([]byte(expected))
	candidateSum := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(expectedSum[:], candidateSum[:]) == 1
}

// ExtractBearerToken extracts a Bearer token from the Authorization request header.
func ExtractBearerToken(r *http.Request) (string, bool) {
	if r == nil {
		return "", false
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader == "" {
		return "", false
	}
	scheme, rest, ok := strings.Cut(authHeader, " ")
	if !ok || !strings.EqualFold(strings.TrimSpace(scheme), "Bearer") {
		return "", false
	}
	token := strings.TrimSpace(rest)
	if token == "" {
		return "", false
	}
	return token, true
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, ok := ExtractBearerToken(r)
		if !ok || !s.ValidateToken(tok) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeJSONError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	st := s.client.Status()
	statusText := "degraded"
	if st.Ready {
		statusText = "ok"
	}
	defModel := st.DefaultModel
	if defModel == "" {
		defModel = s.cfg.DefaultModel
	}
	defEffort := st.DefaultEffort
	if defEffort == "" {
		defEffort = s.cfg.DefaultEffort
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"status":          statusText,
		"acp_ready":       st.Ready,
		"default_model":   defModel,
		"default_effort":  defEffort,
		"active_sessions": st.ActiveSessions,
	})
}

func (s *Server) handleOllamaTags(w http.ResponseWriter, r *http.Request) {
	models, err := s.client.ListModels(r.Context())
	if err != nil {
		s.writeClientError(w, err)
		return
	}
	type tagModel struct {
		Name    string `json:"name"`
		Model   string `json:"model"`
		Details struct {
			DisplayName string `json:"display_name"`
		} `json:"details"`
	}
	out := make([]tagModel, 0, len(models))
	for _, m := range models {
		item := tagModel{
			Name:  m.ID,
			Model: m.ID,
		}
		item.Details.DisplayName = m.Name
		out = append(out, item)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"models": out,
	})
}

func (s *Server) handleOpenAIModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.client.ListModels(r.Context())
	if err != nil {
		s.writeClientError(w, err)
		return
	}
	type openAIModel struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		OwnedBy string `json:"owned_by"`
	}
	out := make([]openAIModel, 0, len(models))
	for _, m := range models {
		out = append(out, openAIModel{
			ID:      m.ID,
			Object:  "model",
			OwnedBy: "antigravity",
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"object": "list",
		"data":   out,
	})
}

type ollamaChatRequest struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   *bool         `json:"stream,omitempty"`
	Format   string        `json:"format,omitempty"`
	Effort   string        `json:"effort,omitempty"`
	Options  struct {
		Effort string `json:"effort,omitempty"`
	} `json:"options,omitempty"`
}

func (s *Server) handleOllamaChat(w http.ResponseWriter, r *http.Request) {
	var req ollamaChatRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Stream != nil && *req.Stream {
		writeJSONError(w, http.StatusBadRequest, "streaming is not supported")
		return
	}
	if len(req.Messages) == 0 {
		writeJSONError(w, http.StatusBadRequest, "messages must not be empty")
		return
	}

	effort := strings.TrimSpace(req.Effort)
	if effort == "" {
		effort = strings.TrimSpace(req.Options.Effort)
	}

	res, err := s.client.Chat(r.Context(), ChatRequest{
		Model:    req.Model,
		Effort:   effort,
		Format:   req.Format,
		Messages: req.Messages,
	})
	if err != nil {
		s.writeClientError(w, err)
		return
	}

	appliedModel := res.AppliedModel
	if appliedModel == "" {
		appliedModel = res.Model
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"model":      appliedModel,
		"created_at": time.Now().UTC().Format(time.RFC3339),
		"message": map[string]any{
			"role":    "assistant",
			"content": res.Content,
		},
		"done":           true,
		"effort_applied": res.EffortApplied,
		"applied_effort": res.AppliedEffort,
		"usage":          res.Usage,
	})
}

type openAIChatRequest struct {
	Model          string        `json:"model"`
	Messages       []ChatMessage `json:"messages"`
	Stream         *bool         `json:"stream,omitempty"`
	ResponseFormat *struct {
		Type string `json:"type"`
	} `json:"response_format,omitempty"`
	Effort          string `json:"effort,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

func (s *Server) handleOpenAIChatCompletions(w http.ResponseWriter, r *http.Request) {
	var req openAIChatRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Stream != nil && *req.Stream {
		writeJSONError(w, http.StatusBadRequest, "streaming is not supported")
		return
	}
	if len(req.Messages) == 0 {
		writeJSONError(w, http.StatusBadRequest, "messages must not be empty")
		return
	}

	format := ""
	if req.ResponseFormat != nil {
		rfType := strings.ToLower(strings.TrimSpace(req.ResponseFormat.Type))
		if rfType == "json_object" || rfType == "json_schema" {
			format = "json"
		}
	}

	effort := strings.TrimSpace(req.Effort)
	if effort == "" {
		effort = strings.TrimSpace(req.ReasoningEffort)
	}

	res, err := s.client.Chat(r.Context(), ChatRequest{
		Model:    req.Model,
		Effort:   effort,
		Format:   format,
		Messages: req.Messages,
	})
	if err != nil {
		s.writeClientError(w, err)
		return
	}

	appliedModel := res.AppliedModel
	if appliedModel == "" {
		appliedModel = res.Model
	}
	finishReason := "stop"
	if res.StopReason != "" && res.StopReason != "end_turn" {
		finishReason = res.StopReason
	}
	totalTokens := res.Usage.TotalTokens
	if totalTokens == 0 {
		totalTokens = res.Usage.InputTokens + res.Usage.OutputTokens + res.Usage.ThoughtTokens
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":      fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano()),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   appliedModel,
		"choices": []map[string]any{
			{
				"index": 0,
				"message": map[string]any{
					"role":    "assistant",
					"content": res.Content,
				},
				"finish_reason": finishReason,
			},
		},
		"usage": map[string]any{
			"prompt_tokens":     res.Usage.InputTokens,
			"completion_tokens": res.Usage.OutputTokens,
			"total_tokens":      totalTokens,
		},
	})
}

func (s *Server) writeClientError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrAuthRequired):
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error_code": "AGY_AUTH_REQUIRED",
			"error":      "Antigravity authentication required; run 'agy acp --login'",
		})
	case errors.Is(err, context.DeadlineExceeded):
		writeJSONError(w, http.StatusGatewayTimeout, "request timed out")
	case errors.Is(err, context.Canceled):
		writeJSONError(w, 499, "request canceled")
	default:
		writeJSONError(w, http.StatusBadGateway, err.Error())
	}
}

func decodeJSONBody(r *http.Request, dst any) error {
	if r.Body == nil {
		return errors.New("empty request body")
	}
	limited := io.LimitReader(r.Body, maxRequestBodySize)
	dec := json.NewDecoder(limited)
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{
		"error": msg,
	})
}

// ResolveOrCreateGatewayToken resolves the gateway Bearer token from AGY_GATEWAY_TOKEN or
// a local 0600 file at AGY_GATEWAY_TOKEN_PATH / ~/.config/upwork-buddy/agy-gateway-token.
// It never logs the raw token value.
func ResolveOrCreateGatewayToken() (token string, source string, err error) {
	if envTok := strings.TrimSpace(os.Getenv("AGY_GATEWAY_TOKEN")); envTok != "" {
		return envTok, "env:AGY_GATEWAY_TOKEN", nil
	}

	tokenPath, err := resolveGatewayTokenPath()
	if err != nil {
		return "", "", err
	}

	info, statErr := os.Stat(tokenPath)
	if statErr == nil {
		data, readErr := os.ReadFile(tokenPath)
		if readErr != nil {
			return "", "", fmt.Errorf("read token file %q: %w", tokenPath, readErr)
		}
		existing := strings.TrimSpace(string(data))
		if existing != "" {
			if info.Mode().Perm()&0o077 != 0 {
				if chmodErr := os.Chmod(tokenPath, 0o600); chmodErr != nil {
					return "", "", fmt.Errorf("tighten token file permissions on %q: %w", tokenPath, chmodErr)
				}
			}
			return existing, tokenPath, nil
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", "", fmt.Errorf("stat token file %q: %w", tokenPath, statErr)
	}

	dir := filepath.Dir(tokenPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", fmt.Errorf("create token directory %q: %w", dir, err)
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", fmt.Errorf("generate random gateway token: %w", err)
	}
	generated := hex.EncodeToString(raw[:])

	tmp, err := os.CreateTemp(dir, ".agy-gateway-token-*")
	if err != nil {
		return "", "", fmt.Errorf("create temp token file in %q: %w", dir, err)
	}
	tmpName := tmp.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", "", fmt.Errorf("chmod temp token file: %w", err)
	}
	if _, err := tmp.WriteString(generated + "\n"); err != nil {
		_ = tmp.Close()
		return "", "", fmt.Errorf("write temp token file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", "", fmt.Errorf("sync temp token file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", "", fmt.Errorf("close temp token file: %w", err)
	}
	if err := os.Rename(tmpName, tokenPath); err != nil {
		return "", "", fmt.Errorf("rename token file to %q: %w", tokenPath, err)
	}
	cleanupTmp = false
	if err := os.Chmod(tokenPath, 0o600); err != nil {
		return "", "", fmt.Errorf("chmod token file %q: %w", tokenPath, err)
	}

	return generated, tokenPath, nil
}

func resolveGatewayTokenPath() (string, error) {
	if p := strings.TrimSpace(os.Getenv("AGY_GATEWAY_TOKEN_PATH")); p != "" {
		return p, nil
	}
	cfgDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(cfgDir) == "" {
		homeDir, hErr := os.UserHomeDir()
		if hErr != nil || strings.TrimSpace(homeDir) == "" {
			return "", fmt.Errorf("cannot resolve config or home directory for token path: %w", err)
		}
		cfgDir = filepath.Join(homeDir, ".config")
	}
	return filepath.Join(cfgDir, "upwork-buddy", "agy-gateway-token"), nil
}
