package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveOrCreateAPIToken(t *testing.T) {
	t.Run("auto_generates_0700_dir_and_0600_file_via_BUDDY_TOKEN_PATH", func(t *testing.T) {
		tmpDir := t.TempDir()
		tokenPath := filepath.Join(tmpDir, "nested", "token")
		t.Setenv("BUDDY_API_TOKEN", "")
		t.Setenv("BUDDY_TOKEN_PATH", tokenPath)
		t.Setenv("TOKEN_PATH", "")

		tok1, src1, err := resolveOrCreateAPIToken()
		if err != nil {
			t.Fatalf("resolveOrCreateAPIToken failed: %v", err)
		}
		if len(tok1) != 64 {
			t.Fatalf("expected 64-char hex token (32 bytes), got len=%d", len(tok1))
		}
		if src1 != tokenPath {
			t.Fatalf("expected source %q, got %q", tokenPath, src1)
		}

		dirInfo, err := os.Stat(filepath.Dir(tokenPath))
		if err != nil {
			t.Fatalf("stat dir: %v", err)
		}
		if dirInfo.Mode().Perm()&0o077 != 0 {
			t.Fatalf("token dir permissions too open: %o", dirInfo.Mode().Perm())
		}

		fileInfo, err := os.Stat(tokenPath)
		if err != nil {
			t.Fatalf("stat file: %v", err)
		}
		if fileInfo.Mode().Perm()&0o077 != 0 {
			t.Fatalf("token file permissions too open: %o", fileInfo.Mode().Perm())
		}

		// Subsequent load returns exact persisted token
		tok2, _, err := resolveOrCreateAPIToken()
		if err != nil {
			t.Fatalf("second resolveOrCreateAPIToken failed: %v", err)
		}
		if tok2 != tok1 {
			t.Fatalf("expected persisted token %q, got %q", tok1, tok2)
		}
	})

	t.Run("supports_TOKEN_PATH_fallback_and_tightens_broad_perms", func(t *testing.T) {
		tmpDir := t.TempDir()
		tokenPath := filepath.Join(tmpDir, "token")
		if err := os.WriteFile(tokenPath, []byte("custom-persisted-token\n"), 0o644); err != nil {
			t.Fatalf("write token: %v", err)
		}
		t.Setenv("BUDDY_API_TOKEN", "")
		t.Setenv("BUDDY_TOKEN_PATH", "")
		t.Setenv("TOKEN_PATH", tokenPath)

		tok, src, err := resolveOrCreateAPIToken()
		if err != nil {
			t.Fatalf("resolveOrCreateAPIToken failed: %v", err)
		}
		if tok != "custom-persisted-token" || src != tokenPath {
			t.Fatalf("unexpected token/source: %q %q", tok, src)
		}
		info, err := os.Stat(tokenPath)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("expected tightened 0600 perms, got %o", info.Mode().Perm())
		}
	})

	t.Run("env_BUDDY_API_TOKEN_overrides_file", func(t *testing.T) {
		t.Setenv("BUDDY_API_TOKEN", "override-secret-token")
		t.Setenv("BUDDY_TOKEN_PATH", filepath.Join(t.TempDir(), "unused"))

		tok, src, err := resolveOrCreateAPIToken()
		if err != nil {
			t.Fatalf("resolveOrCreateAPIToken failed: %v", err)
		}
		if tok != "override-secret-token" || src != "env:BUDDY_API_TOKEN" {
			t.Fatalf("unexpected override result: %q %q", tok, src)
		}
	})
}

func TestRouteAuthProtectionAndMinimalHealth(t *testing.T) {
	s := &Server{
		env:           "test",
		apiToken:      "secret-token-123",
		selectorsPath: "../../configs/selectors/upwork.yaml",
	}
	router := s.RegisterRoutes()

	// Unauthenticated GET /health returns minimal liveness JSON only (no pool stats or raw errors)
	healthReq := httptest.NewRequest(http.MethodGet, "/health", nil)
	healthW := httptest.NewRecorder()
	router.ServeHTTP(healthW, healthReq)
	if healthW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /health status = %d, want 200", healthW.Result().StatusCode)
	}
	var healthBody map[string]string
	if err := json.NewDecoder(healthW.Body).Decode(&healthBody); err != nil {
		t.Fatalf("decode /health: %v", err)
	}
	if len(healthBody) != 2 || healthBody["status"] != "degraded" || healthBody["db"] != "down" {
		t.Fatalf("unexpected /health payload: %+v", healthBody)
	}

	// Protected routes must reject missing or wrong Bearer token with 401
	protectedTargets := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/health"},
		{http.MethodGet, "/api/jobs"},
		{http.MethodGet, "/api/selectors"},
		{http.MethodGet, "/api/unknown-endpoint"},
		{http.MethodPost, "/mcp"},
		{http.MethodGet, "/ws/extension"},
	}

	for _, target := range protectedTargets {
		// Missing header
		req := httptest.NewRequest(target.method, target.path, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s without token = %d, want 401", target.method, target.path, w.Result().StatusCode)
		}

		// Wrong token
		badReq := httptest.NewRequest(target.method, target.path, nil)
		badReq.Header.Set("Authorization", "Bearer wrong-token")
		badW := httptest.NewRecorder()
		router.ServeHTTP(badW, badReq)
		if badW.Result().StatusCode != http.StatusUnauthorized {
			t.Errorf("%s %s with wrong token = %d, want 401", target.method, target.path, badW.Result().StatusCode)
		}
	}

	// Valid Bearer token reaches protected /api/health and /mcp (501 stub in M2)
	okHealthReq := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	okHealthReq.Header.Set("Authorization", "Bearer secret-token-123")
	okHealthW := httptest.NewRecorder()
	router.ServeHTTP(okHealthW, okHealthReq)
	if okHealthW.Result().StatusCode != http.StatusOK {
		t.Fatalf("authenticated GET /api/health = %d, want 200", okHealthW.Result().StatusCode)
	}

	okMCPReq := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	okMCPReq.Header.Set("Authorization", "Bearer secret-token-123")
	okMCPW := httptest.NewRecorder()
	router.ServeHTTP(okMCPW, okMCPReq)
	if okMCPW.Result().StatusCode != http.StatusNotImplemented {
		t.Fatalf("authenticated POST /mcp = %d, want 501 stub in M2", okMCPW.Result().StatusCode)
	}
}

func TestStrictCORSPolicyAndPreflight(t *testing.T) {
	s := &Server{
		apiToken:           "secret-token-123",
		corsAllowedOrigins: "*",
	}
	router := s.RegisterRoutes()

	allowedOrigins := []string{
		"chrome-extension://abcdefghijklmnop",
		"moz-extension://12345678-1234-1234-1234-1234567890ab",
		"http://127.0.0.1:5173",
		"http://localhost:3000",
		"http://[::1]:9090",
	}
	for _, origin := range allowedOrigins {
		// Preflight OPTIONS without Authorization must succeed with 204 and echo Origin
		req := httptest.NewRequest(http.MethodOptions, "/api/jobs", nil)
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Result().StatusCode != http.StatusNoContent {
			t.Errorf("OPTIONS origin %q = %d, want 204", origin, w.Result().StatusCode)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Errorf("OPTIONS origin %q ACAO = %q, want %q", origin, got, origin)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got == "*" {
			t.Errorf("must never emit wildcard * ACAO")
		}
		if !strings.Contains(w.Header().Get("Vary"), "Origin") {
			t.Errorf("OPTIONS origin %q missing Vary: Origin", origin)
		}
		allowHeaders := w.Header().Get("Access-Control-Allow-Headers")
		if !strings.Contains(allowHeaders, "Authorization") || !strings.Contains(allowHeaders, "Mcp-Session-Id") {
			t.Errorf("Allow-Headers missing Authorization/Mcp-Session-Id: %q", allowHeaders)
		}
	}

	disallowedOrigins := []string{
		"https://evil.com",
		"https://www.upwork.com",
		"http://localhost.evil.com",
		"http://127.0.0.1.evil.com",
		"null",
		"chrome-extension://bad:8080",
	}
	for _, origin := range disallowedOrigins {
		req := httptest.NewRequest(http.MethodOptions, "/api/jobs", nil)
		req.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Result().StatusCode != http.StatusForbidden {
			t.Errorf("disallowed OPTIONS origin %q = %d, want 403", origin, w.Result().StatusCode)
		}
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("disallowed origin %q must not emit ACAO, got %q", origin, got)
		}
	}

	// Explicit CORS_ALLOWED_ORIGINS restricts localhost to configured pattern while keeping extensions allowed
	restricted := &Server{
		apiToken:           "secret-token-123",
		corsAllowedOrigins: "http://localhost:4173",
	}
	if !restricted.IsAllowedOrigin("http://localhost:4173") {
		t.Error("expected configured origin http://localhost:4173 to be allowed")
	}
	if restricted.IsAllowedOrigin("http://localhost:9999") {
		t.Error("expected unconfigured origin http://localhost:9999 to be rejected")
	}
	if !restricted.IsAllowedOrigin("chrome-extension://abcdefghijklmnop") {
		t.Error("expected chrome-extension origin to remain allowed")
	}
}

func TestWebSocketAuthHelpers(t *testing.T) {
	s := &Server{apiToken: "ws-secret-token"}

	// Bearer header
	r1 := httptest.NewRequest(http.MethodGet, "/ws/extension", nil)
	r1.Header.Set("Authorization", "Bearer ws-secret-token")
	if got := s.AuthenticateWSRequest(r1); got != WSAuthAuthenticated {
		t.Errorf("expected WSAuthAuthenticated for Bearer header, got %v", got)
	}

	// Query token
	r2 := httptest.NewRequest(http.MethodGet, "/ws/extension?token=ws-secret-token", nil)
	if got := s.AuthenticateWSRequest(r2); got != WSAuthAuthenticated {
		t.Errorf("expected WSAuthAuthenticated for ?token=, got %v", got)
	}

	// Empty ?token= is invalid credentials, not missing
	r3 := httptest.NewRequest(http.MethodGet, "/ws/extension?token=", nil)
	if got := s.AuthenticateWSRequest(r3); got != WSAuthInvalidCredentials {
		t.Errorf("expected WSAuthInvalidCredentials for empty ?token=, got %v", got)
	}

	// First-frame JSON-RPC auth
	id, ok := s.ValidateWSAuthFrame([]byte(`{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"ws-secret-token"}}`))
	if !ok || string(id) != `"auth-1"` {
		t.Fatalf("expected valid first-frame auth, got ok=%v id=%s", ok, id)
	}
	if _, ok := s.ValidateWSAuthFrame([]byte(`{"jsonrpc":"2.0","id":"auth-2","method":"auth","params":{"token":"wrong"}}`)); ok {
		t.Fatal("expected invalid token in first-frame auth to fail")
	}
}

func TestAuthAndCORS_AdversarialEdgeCases(t *testing.T) {
	emptyServer := &Server{apiToken: "   "}
	if emptyServer.ValidateToken("") || emptyServer.ValidateToken("anything") {
		t.Fatal("ValidateToken must fail-closed when apiToken is empty/whitespace")
	}

	s := &Server{
		apiToken:           "secret-token-123",
		corsAllowedOrigins: "http://localhost:*",
	}
	router := s.RegisterRoutes()

	badAuthHeaders := []string{
		"",
		"Basic secret-token-123",
		"Bearer\tsecret-token-123",
		"Bearer   ",
		"Bearer secret-token-123 extra",
	}
	for _, hdr := range badAuthHeaders {
		req := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
		if hdr != "" {
			req.Header.Set("Authorization", hdr)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusUnauthorized {
			t.Errorf("Authorization %q: status=%d, want 401", hdr, w.Result().StatusCode)
		}
	}

	for _, hdr := range []string{"bearer secret-token-123", "Bearer   secret-token-123  "} {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		req.Header.Set("Authorization", hdr)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusOK {
			t.Errorf("Authorization %q: status=%d, want 200", hdr, w.Result().StatusCode)
		}
	}

	disallowed := []string{
		"http://chrome-extension.evil.com",
		"http://moz-extension.evil.com",
		"chrome-extension://abcdefghijklmnop/subpath",
		"chrome-extension://user@abcdefghijklmnop",
		"chrome-extension://abcdefghijklmnop?x=1",
		"chrome-extension://abcdefghijklmnop#frag",
		"https://localhost:5173",
		"http://localhost.evil.com:5173",
	}
	for _, origin := range disallowed {
		if s.IsAllowedOrigin(origin) {
			t.Errorf("IsAllowedOrigin(%q) = true, want false", origin)
		}
		getReq := httptest.NewRequest(http.MethodGet, "/health", nil)
		getReq.Header.Set("Origin", origin)
		getW := httptest.NewRecorder()
		router.ServeHTTP(getW, getReq)
		if acao := getW.Header().Get("Access-Control-Allow-Origin"); acao != "" {
			t.Errorf("non-OPTIONS with disallowed origin %q emitted ACAO=%q", origin, acao)
		}
	}

	if !s.IsAllowedOrigin("http://localhost:5173") {
		t.Error("expected http://localhost:* to allow http://localhost:5173")
	}
}
