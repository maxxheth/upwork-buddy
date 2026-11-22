package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"upwork-buddy/internal/bridge"
	"upwork-buddy/internal/webui"
)

func TestMcpAuthCORSAndDisabled(t *testing.T) {
	// 1. MCP_ENABLED=false returns 404 on /mcp and /mcp/
	disabled := false
	sDisabled := NewServerWithDeps(ServerDeps{
		APIToken:   "mcp-route-secret-token",
		MCPEnabled: &disabled,
	})
	if sDisabled.MCPEnabled() {
		t.Fatal("expected MCPEnabled() == false")
	}
	srvDisabled := httptest.NewServer(sDisabled.RegisterRoutes())
	defer srvDisabled.Close()

	reqDisabled, _ := http.NewRequest(http.MethodPost, srvDisabled.URL+"/mcp", strings.NewReader(`{}`))
	reqDisabled.Header.Set("Authorization", "Bearer mcp-route-secret-token")
	respDisabled, err := http.DefaultClient.Do(reqDisabled)
	if err != nil {
		t.Fatalf("POST /mcp (disabled) failed: %v", err)
	}
	respDisabled.Body.Close()
	if respDisabled.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 when MCP disabled, got %d", respDisabled.StatusCode)
	}

	// 2. Enabled MCP enforces Bearer auth (401), CORS Mcp-Session-Id headers, and shutdown hook
	enabled := true
	hookCalled := false
	sEnabled := NewServerWithDeps(ServerDeps{
		APIToken:   "mcp-route-secret-token",
		MCPEnabled: &enabled,
	})
	sEnabled.SetMCPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Mcp-Session-Id", "sess-test-1")
		w.WriteHeader(http.StatusOK)
	}))
	sEnabled.SetMCPShutdownHook(func() {
		hookCalled = true
	})

	srvEnabled := httptest.NewServer(sEnabled.RegisterRoutes())
	defer srvEnabled.Close()

	// Unauthenticated -> 401 without leaking token
	noAuthResp, err := http.Post(srvEnabled.URL+"/mcp", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("unauth POST /mcp failed: %v", err)
	}
	noAuthBody, _ := io.ReadAll(noAuthResp.Body)
	noAuthResp.Body.Close()
	if noAuthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without token, got %d", noAuthResp.StatusCode)
	}
	if strings.Contains(string(noAuthBody), "mcp-route-secret-token") {
		t.Fatal("401 response leaked API token")
	}

	// OPTIONS preflight with allowed chrome-extension origin
	optReq, _ := http.NewRequest(http.MethodOptions, srvEnabled.URL+"/mcp", nil)
	optReq.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
	optResp, err := http.DefaultClient.Do(optReq)
	if err != nil {
		t.Fatalf("OPTIONS /mcp failed: %v", err)
	}
	optResp.Body.Close()
	if optResp.StatusCode != http.StatusNoContent {
		t.Fatalf("expected 204 on allowed OPTIONS /mcp, got %d", optResp.StatusCode)
	}
	allowHeaders := optResp.Header.Get("Access-Control-Allow-Headers")
	for _, want := range []string{"Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"} {
		if !strings.Contains(allowHeaders, want) {
			t.Fatalf("Access-Control-Allow-Headers %q missing %q", allowHeaders, want)
		}
	}
	if expose := optResp.Header.Get("Access-Control-Expose-Headers"); !strings.Contains(expose, "Mcp-Session-Id") {
		t.Fatalf("Access-Control-Expose-Headers %q missing Mcp-Session-Id", expose)
	}

	// Disallowed Origin -> 403
	badOptReq, _ := http.NewRequest(http.MethodOptions, srvEnabled.URL+"/mcp", nil)
	badOptReq.Header.Set("Origin", "https://evil.example.com")
	badOptResp, err := http.DefaultClient.Do(badOptReq)
	if err != nil {
		t.Fatalf("bad OPTIONS /mcp failed: %v", err)
	}
	badOptResp.Body.Close()
	if badOptResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 on disallowed Origin OPTIONS /mcp, got %d", badOptResp.StatusCode)
	}

	// Authenticated -> reaches MCP handler
	okReq, _ := http.NewRequest(http.MethodPost, srvEnabled.URL+"/mcp", strings.NewReader(`{}`))
	okReq.Header.Set("Authorization", "Bearer mcp-route-secret-token")
	okResp, err := http.DefaultClient.Do(okReq)
	if err != nil {
		t.Fatalf("auth POST /mcp failed: %v", err)
	}
	okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK || okResp.Header.Get("Mcp-Session-Id") != "sess-test-1" {
		t.Fatalf("unexpected authenticated /mcp response: status=%d sid=%q", okResp.StatusCode, okResp.Header.Get("Mcp-Session-Id"))
	}

	if err := sEnabled.Close(); err != nil {
		t.Fatalf("Server.Close failed: %v", err)
	}
	if !hookCalled {
		t.Fatal("expected Server.Close to invoke MCP shutdown hook")
	}
}

func TestHandler(t *testing.T) {
	s := &Server{}
	server := httptest.NewServer(http.HandlerFunc(s.HelloWorldHandler))
	defer server.Close()
	resp, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("error making request to server. Err: %v", err)
	}
	defer resp.Body.Close()
	// Assertions
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status OK; got %v", resp.Status)
	}
	expected := "{\"message\":\"Hello World\"}"
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("error reading response body. Err: %v", err)
	}
	if expected != string(body) {
		t.Errorf("expected response body to be %v; got %v", expected, string(body))
	}
}

func TestSessionAndBridgeStatusAndWSWiring(t *testing.T) {
	t.Setenv("POLICY_MODE", "confirm_in_ui")

	s := &Server{
		apiToken: "test-route-token",
	}
	hub := bridge.NewHub(bridge.HubConfig{
		AuthTimeout:        2 * time.Second,
		DefaultCallTimeout: 5 * time.Second,
		PreAuthCheck: func(r *http.Request) bool {
			return s.AuthenticateWSRequest(r) == WSAuthAuthenticated
		},
		ValidateAuthFrame: s.ValidateWSAuthFrame,
		AllowOrigin:       s.IsAllowedOrigin,
	})
	defer hub.Close()
	s.bridgeHub = hub
	s.wsHandler = hub

	srv := httptest.NewServer(s.RegisterRoutes())
	defer srv.Close()

	// 1. Disallowed Origin on /ws/extension fails with 403 Forbidden
	reqOrigin, _ := http.NewRequest(http.MethodGet, srv.URL+"/ws/extension", nil)
	reqOrigin.Header.Set("Origin", "https://evil.example.com")
	respOrigin, err := http.DefaultClient.Do(reqOrigin)
	if err != nil {
		t.Fatalf("origin request failed: %v", err)
	}
	respOrigin.Body.Close()
	if respOrigin.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed Origin on /ws/extension, got %d", respOrigin.StatusCode)
	}

	// 2. Unauthenticated /api/session/status & /api/bridge/status fail with 401
	for _, path := range []string{"/api/session/status", "/api/bridge/status"} {
		resp, gErr := http.Get(srv.URL + path)
		if gErr != nil {
			t.Fatalf("GET %s failed: %v", path, gErr)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expected 401 on %s, got %d", path, resp.StatusCode)
		}
	}

	// 3. Connect WS with allowed chrome-extension:// origin and first-frame auth
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/extension"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"chrome-extension://abcdefghijklmnop"}},
	})
	if err != nil {
		t.Fatalf("WS dial failed: %v", err)
	}
	defer conn.CloseNow()

	authMsg := `{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"test-route-token","extension_version":"2.0.0","browser":"chrome"}}`
	if err := conn.Write(ctx, websocket.MessageText, []byte(authMsg)); err != nil {
		t.Fatalf("WS auth write failed: %v", err)
	}
	_, rawAck, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("WS auth ack read failed: %v", err)
	}
	if !strings.Contains(string(rawAck), `"ok":true`) {
		t.Fatalf("expected ok:true ack, got %s", string(rawAck))
	}

	// 4. Both /api/session/status and /api/bridge/status report connected=true and policy_mode=confirm_in_ui
	for _, path := range []string{"/api/session/status", "/api/bridge/status"} {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer test-route-token")
		resp, rErr := http.DefaultClient.Do(req)
		if rErr != nil {
			t.Fatalf("GET %s failed: %v", path, rErr)
		}
		var st bridge.BridgeStatus
		if dErr := json.NewDecoder(resp.Body).Decode(&st); dErr != nil {
			resp.Body.Close()
			t.Fatalf("decode %s failed: %v", path, dErr)
		}
		resp.Body.Close()
		if !st.ExtensionConnected || st.SessionID == "" || st.PolicyMode != "confirm_in_ui" || st.Browser != "chrome" {
			t.Fatalf("unexpected status on %s: %+v", path, st)
		}
	}
}

func TestDashboardRoutes_CSPHeadersMethodsAndM2M3Wiring(t *testing.T) {
	t.Setenv("WEB_UI_ENABLED", "true")

	s := &Server{
		host:     "127.0.0.1",
		port:     9095,
		apiToken: "route-master-secret",
	}
	router := s.RegisterRoutes()

	// 1. GET / preserves Hello World invariant
	rootW := httptest.NewRecorder()
	router.ServeHTTP(rootW, httptest.NewRequest(http.MethodGet, "/", nil))
	if rootW.Result().StatusCode != http.StatusOK || rootW.Body.String() != `{"message":"Hello World"}` {
		t.Fatalf("GET / = (%d, %q), want (200, Hello World JSON)", rootW.Result().StatusCode, rootW.Body.String())
	}

	// 2. GET /dashboard redirects to /dashboard/ preserving query params
	redirW := httptest.NewRecorder()
	router.ServeHTTP(redirW, httptest.NewRequest(http.MethodGet, "/dashboard?run=7&ticket=abc", nil))
	if redirW.Result().StatusCode != http.StatusFound {
		t.Fatalf("GET /dashboard status = %d, want 302", redirW.Result().StatusCode)
	}
	if loc := redirW.Result().Header.Get("Location"); loc != "/dashboard/?run=7&ticket=abc" {
		t.Fatalf("GET /dashboard Location = %q, want /dashboard/?run=7&ticket=abc", loc)
	}

	// 3. GET /dashboard/ returns HTML with strict CSP headers and no master token
	dashW := httptest.NewRecorder()
	router.ServeHTTP(dashW, httptest.NewRequest(http.MethodGet, "/dashboard/", nil))
	if dashW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /dashboard/ status = %d, want 200", dashW.Result().StatusCode)
	}
	if got := dashW.Result().Header.Get("Content-Security-Policy"); got != webui.DashboardCSP {
		t.Fatalf("CSP = %q, want %q", got, webui.DashboardCSP)
	}
	if got := dashW.Result().Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := dashW.Result().Header.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
	if strings.Contains(dashW.Body.String(), "route-master-secret") {
		t.Fatal("GET /dashboard/ body leaked master API token")
	}

	// 4. Non-GET/HEAD methods on /dashboard* NEVER fall through to HelloWorldHandler
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/dashboard"},
		{http.MethodDelete, "/dashboard"},
		{http.MethodPost, "/dashboard/"},
		{http.MethodPut, "/dashboard/assets/app.js"},
		{http.MethodPatch, "/dashboard/runs/1"},
		{http.MethodGet, "/dashboard/auth/exchange"},
		{http.MethodDelete, "/dashboard/auth/exchange"},
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Result().StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s status = %d, want 405 (body=%s)", tc.method, tc.path, w.Result().StatusCode, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "Hello World") {
			t.Fatalf("%s %s fell through to HelloWorldHandler", tc.method, tc.path)
		}
	}

	// 5. Missing asset returns 404; extensionless SPA route returns 200
	missW := httptest.NewRecorder()
	router.ServeHTTP(missW, httptest.NewRequest(http.MethodGet, "/dashboard/assets/missing.js", nil))
	if missW.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("GET /dashboard/assets/missing.js status = %d, want 404", missW.Result().StatusCode)
	}
	spaW := httptest.NewRecorder()
	router.ServeHTTP(spaW, httptest.NewRequest(http.MethodGet, "/dashboard/batches/1", nil))
	if spaW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /dashboard/batches/1 status = %d, want 200", spaW.Result().StatusCode)
	}

	// 6. M2/M3/M4 API routes fail closed with 401 when unauthenticated, and route properly with auth
	apiTargets := []struct {
		method string
		path   string
		authed int
	}{
		{http.MethodGet, "/api/search-runs", http.StatusServiceUnavailable},
		{http.MethodGet, "/api/search-runs/1", http.StatusServiceUnavailable},
		{http.MethodGet, "/api/enrichment-config", http.StatusOK},
		{http.MethodPost, "/api/jobs/enrich", http.StatusServiceUnavailable},
		{http.MethodGet, "/api/enrichment-batches", http.StatusServiceUnavailable},
		{http.MethodGet, "/api/enrichment-batches/1", http.StatusServiceUnavailable},
		{http.MethodPost, "/api/enrichment-batches/1/cancel", http.StatusServiceUnavailable},
		{http.MethodPost, "/api/web-session/ticket", http.StatusOK},
	}

	ticket, _, err := s.MintWebTicket()
	if err != nil {
		t.Fatalf("MintWebTicket failed: %v", err)
	}
	sessTok, _, ok := s.ExchangeWebTicket(ticket)
	if !ok {
		t.Fatal("ExchangeWebTicket failed")
	}

	for _, at := range apiTargets {
		unauthW := httptest.NewRecorder()
		router.ServeHTTP(unauthW, httptest.NewRequest(at.method, at.path, nil))
		if unauthW.Result().StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauth %s %s status = %d, want 401", at.method, at.path, unauthW.Result().StatusCode)
		}

		for _, tok := range []string{"route-master-secret", sessTok} {
			req := httptest.NewRequest(at.method, at.path, nil)
			req.Header.Set("Authorization", "Bearer "+tok)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Result().StatusCode != at.authed {
				t.Fatalf("authed %s %s status = %d, want %d (body=%s)", at.method, at.path, w.Result().StatusCode, at.authed, w.Body.String())
			}
		}
	}

	// 7. WEB_UI_ENABLED=false returns 404 on all /dashboard* routes
	t.Setenv("WEB_UI_ENABLED", "false")
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/dashboard"},
		{http.MethodGet, "/dashboard/"},
		{http.MethodGet, "/dashboard/index.html"},
		{http.MethodPost, "/dashboard/auth/exchange"},
	} {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(tc.method, tc.path, nil))
		if w.Result().StatusCode != http.StatusNotFound {
			t.Fatalf("disabled %s %s status = %d, want 404", tc.method, tc.path, w.Result().StatusCode)
		}
	}
}

func assertDashboardSecurityHeaders(t *testing.T, h http.Header, target string) {
	t.Helper()
	if got := h.Get("Content-Security-Policy"); got != webui.DashboardCSP {
		t.Fatalf("%s Content-Security-Policy = %q, want %q", target, got, webui.DashboardCSP)
	}
	if got := h.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("%s X-Content-Type-Options = %q, want nosniff", target, got)
	}
	if got := h.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("%s Referrer-Policy = %q, want no-referrer", target, got)
	}
}

func TestDashboardRoutes_PathTraversalBlockedPreServeMux(t *testing.T) {
	s := &Server{
		host:     "127.0.0.1",
		port:     9095,
		apiToken: "route-master-secret",
	}
	router := s.RegisterRoutes()
	srv := httptest.NewServer(router)
	defer srv.Close()

	// Default http.Client follows redirects; noRedirectClient verifies the server never emits 307.
	client := srv.Client()
	noRedirectClient := &http.Client{
		Transport: client.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	traversalPaths := []string{
		"/dashboard/../etc/passwd",
		"/dashboard/sub/../../etc/passwd",
		"/dashboard//../etc/passwd",
		"/dashboard/./../etc/passwd",
		"/dashboard/%2e%2e/etc/passwd",
		"/dashboard/..%2fetc%2fpasswd",
		"/dashboard/sub/..%2fetc/passwd",
		"/dashboard%2f../etc/passwd",
		"/dashboard/..%5cetc%5cpasswd",
		"/dashboard/..",
	}

	for _, enabled := range []string{"true", "false"} {
		t.Setenv("WEB_UI_ENABLED", enabled)

		for _, target := range traversalPaths {
			// 1. Direct ServeHTTP check (no 307 canonicalization redirect)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
			res := rec.Result()
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()

			if res.StatusCode != http.StatusNotFound {
				t.Fatalf("[enabled=%s] ServeHTTP GET %s status = %d, want 404 (location=%q, body=%q)",
					enabled, target, res.StatusCode, res.Header.Get("Location"), string(body))
			}
			if strings.Contains(string(body), "Hello World") {
				t.Fatalf("[enabled=%s] ServeHTTP GET %s reached HelloWorldHandler", enabled, target)
			}
			assertDashboardSecurityHeaders(t, res.Header, "ServeHTTP "+target)

			// 2. Live HTTP client check (both non-redirecting and redirect-following)
			for _, tc := range []struct {
				name string
				cli  *http.Client
			}{
				{"no-redirect", noRedirectClient},
				{"follow-redirect", client},
			} {
				resp, err := tc.cli.Get(srv.URL + target)
				if err != nil {
					t.Fatalf("[enabled=%s] %s GET %s failed: %v", enabled, tc.name, target, err)
				}
				liveBody, _ := io.ReadAll(resp.Body)
				resp.Body.Close()

				if resp.StatusCode != http.StatusNotFound {
					t.Fatalf("[enabled=%s] %s GET %s status = %d, want 404 (location=%q, finalURL=%s, body=%q)",
						enabled, tc.name, target, resp.StatusCode, resp.Header.Get("Location"), resp.Request.URL.String(), string(liveBody))
				}
				if strings.Contains(string(liveBody), "Hello World") {
					t.Fatalf("[enabled=%s] %s GET %s fell through to HelloWorldHandler", enabled, tc.name, target)
				}
				assertDashboardSecurityHeaders(t, resp.Header, tc.name+" "+target)
			}
		}
	}

	// Legitimate SPA subpath containing ".." inside a segment still works when WEB_UI_ENABLED=true.
	t.Setenv("WEB_UI_ENABLED", "true")
	spaResp, err := client.Get(srv.URL + "/dashboard/foo..bar/overview")
	if err != nil {
		t.Fatalf("live GET /dashboard/foo..bar/overview failed: %v", err)
	}
	spaBody, _ := io.ReadAll(spaResp.Body)
	spaResp.Body.Close()
	if spaResp.StatusCode != http.StatusOK || !strings.Contains(string(spaBody), "Upwork Buddy") {
		t.Fatalf("live GET /dashboard/foo..bar/overview = (%d, %q), want 200 index.html", spaResp.StatusCode, string(spaBody))
	}
	assertDashboardSecurityHeaders(t, spaResp.Header, "live /dashboard/foo..bar/overview")
}
