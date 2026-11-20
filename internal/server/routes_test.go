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
