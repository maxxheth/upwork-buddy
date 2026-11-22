package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

var reHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func assertTicketedDashboardURL(t *testing.T, s *Server, rawURL, wantOrigin, paramKey, paramVal string) string {
	t.Helper()
	if rawURL == "" {
		t.Fatalf("expected non-empty dashboard URL")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse(%q) failed: %v", rawURL, err)
	}
	if gotOrigin := u.Scheme + "://" + u.Host; gotOrigin != wantOrigin {
		t.Fatalf("dashboard URL origin = %q, want %q (full=%q)", gotOrigin, wantOrigin, rawURL)
	}
	if u.Path != "/dashboard/" {
		t.Fatalf("dashboard URL path = %q, want /dashboard/", u.Path)
	}
	q := u.Query()
	if paramKey != "" && q.Get(paramKey) != paramVal {
		t.Fatalf("dashboard URL param %s = %q, want %q (full=%q)", paramKey, q.Get(paramKey), paramVal, rawURL)
	}
	ticket := q.Get("ticket")
	if !reHex64.MatchString(ticket) {
		t.Fatalf("dashboard URL ticket = %q, want 64 hex chars (full=%q)", ticket, rawURL)
	}
	if s != nil {
		sessTok, _, ok := s.ExchangeWebTicket(ticket)
		if !ok || !reHex64.MatchString(sessTok) {
			t.Fatalf("expected single-use ticket exchange to succeed for %q", rawURL)
		}
		if _, _, replayOK := s.ExchangeWebTicket(ticket); replayOK {
			t.Fatalf("expected ticket replay to fail for %q", rawURL)
		}
	}
	return ticket
}

func TestWebSession_MintExchangeValidateAndExpiry(t *testing.T) {
	t.Setenv("WEB_UI_ENABLED", "true")
	t.Setenv("WEB_SESSION_TTL_MINUTES", "15")

	now := time.Date(2026, 11, 21, 4, 0, 0, 0, time.UTC)
	s := &Server{apiToken: "master-secret-token"}
	mgr := s.getWebSessionManager()
	mgr.nowFn = func() time.Time { return now }

	// Mint ticket
	ticket, ticketExp, err := s.MintWebTicket()
	if err != nil {
		t.Fatalf("MintWebTicket failed: %v", err)
	}
	if !reHex64.MatchString(ticket) {
		t.Fatalf("expected 64-hex ticket, got %q", ticket)
	}
	if !ticketExp.Equal(now.Add(5 * time.Minute)) {
		t.Fatalf("ticket expiry = %v, want %v", ticketExp, now.Add(5*time.Minute))
	}

	// Exchange once -> session token; replay -> false
	sessTok, sessExp, ok := s.ExchangeWebTicket(ticket)
	if !ok || !reHex64.MatchString(sessTok) {
		t.Fatalf("ExchangeWebTicket failed: ok=%v tok=%q", ok, sessTok)
	}
	if !sessExp.Equal(now.Add(15 * time.Minute)) {
		t.Fatalf("session expiry = %v, want %v", sessExp, now.Add(15*time.Minute))
	}
	if _, _, replayOK := s.ExchangeWebTicket(ticket); replayOK {
		t.Fatal("expected immediate ticket replay to fail")
	}
	if !s.ValidateWebSessionToken(sessTok) {
		t.Fatal("expected freshly minted session token to validate")
	}
	if s.ValidateWebSessionToken("bogus-token") || s.ValidateWebSessionToken("") {
		t.Fatal("expected bogus/empty session token to fail")
	}

	// Deterministic ticket expiry burns ticket on attempt
	expTicket, _, err := s.MintWebTicket()
	if err != nil {
		t.Fatalf("MintWebTicket(exp) failed: %v", err)
	}
	now = now.Add(5 * time.Minute) // exact boundary -> expired
	if _, _, ok := s.ExchangeWebTicket(expTicket); ok {
		t.Fatal("expected expired ticket exchange to fail")
	}
	mgr.mu.Lock()
	remainingTickets := len(mgr.tickets)
	mgr.mu.Unlock()
	if remainingTickets != 0 {
		t.Fatalf("expected expired ticket to be deleted on exchange, remaining=%d", remainingTickets)
	}

	// Session still valid before 15m from mint (currently at +5m), expires at +15m
	if !s.ValidateWebSessionToken(sessTok) {
		t.Fatal("expected session token to still be valid at +5m")
	}
	now = now.Add(10 * time.Minute) // total +15m -> expired
	if s.ValidateWebSessionToken(sessTok) {
		t.Fatal("expected session token to expire at +15m")
	}

	// WEB_UI_ENABLED=false disables minting, exchange, and validation
	now = now.Add(-14 * time.Minute)
	freshTicket, _, err := s.MintWebTicket()
	if err != nil {
		t.Fatalf("MintWebTicket(fresh) failed: %v", err)
	}
	t.Setenv("WEB_UI_ENABLED", "false")
	if _, _, err := s.MintWebTicket(); err == nil {
		t.Fatal("expected MintWebTicket to fail when WEB_UI_ENABLED=false")
	}
	if _, _, ok := s.ExchangeWebTicket(freshTicket); ok {
		t.Fatal("expected ExchangeWebTicket to fail when WEB_UI_ENABLED=false")
	}
	if s.ValidateWebSessionToken(sessTok) {
		t.Fatal("expected ValidateWebSessionToken to return false when WEB_UI_ENABLED=false")
	}
}

func TestWebSession_ConcurrentExchangeSingleWinnerAndCapacityBounds(t *testing.T) {
	t.Setenv("WEB_UI_ENABLED", "true")
	s := &Server{apiToken: "master-secret-token"}

	ticket, _, err := s.MintWebTicket()
	if err != nil {
		t.Fatalf("MintWebTicket failed: %v", err)
	}

	const goroutines = 16
	var wg sync.WaitGroup
	results := make(chan bool, goroutines)
	start := make(chan struct{})

	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, _, ok := s.ExchangeWebTicket(ticket)
			results <- ok
		}()
	}
	close(start)
	wg.Wait()
	close(results)

	wins := 0
	for ok := range results {
		if ok {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("concurrent ExchangeWebTicket wins = %d, want 1", wins)
	}

	// Bounded ticket capacity eviction
	mgr := s.getWebSessionManager()
	for i := 0; i < maxPendingWebTickets+10; i++ {
		if _, _, err := s.MintWebTicket(); err != nil {
			t.Fatalf("MintWebTicket(%d) failed: %v", i, err)
		}
	}
	mgr.mu.Lock()
	ticketCount := len(mgr.tickets)
	mgr.mu.Unlock()
	if ticketCount != maxPendingWebTickets {
		t.Fatalf("ticket map size = %d, want capped at %d", ticketCount, maxPendingWebTickets)
	}
}

func TestBuildDashboardURL_HostNormalizationAndTicketStripping(t *testing.T) {
	t.Setenv("WEB_UI_ENABLED", "true")
	t.Setenv("UPWORK_BUDDY_URL", "")
	t.Setenv("BUDDY_API_URL", "")
	t.Setenv("APP_HOST", "0.0.0.0")
	t.Setenv("APP_PORT", "9191")

	if got := (*Server)(nil).BuildDashboardURL("run=1"); got != "" {
		t.Fatalf("nil Server BuildDashboardURL = %q, want empty", got)
	}

	hostCases := []struct {
		host       string
		port       int
		wantOrigin string
	}{
		{"", 9095, "http://127.0.0.1:9095"},
		{"0.0.0.0", 9095, "http://127.0.0.1:9095"},
		{"::", 9095, "http://127.0.0.1:9095"},
		{"[::]", 9095, "http://127.0.0.1:9095"},
		{"::1", 9095, "http://[::1]:9095"},
		{"[::1]", 9095, "http://[::1]:9095"},
		{"127.0.0.1", 0, "http://127.0.0.1:9191"},
	}

	for _, tc := range hostCases {
		srv := &Server{host: tc.host, port: tc.port}
		got := srv.BuildDashboardURL("?run=42&ticket=caller-spoof")
		assertTicketedDashboardURL(t, srv, got, tc.wantOrigin, "run", "42")
		if strings.Contains(got, "caller-spoof") {
			t.Fatalf("BuildDashboardURL(%q) retained caller-supplied ticket: %q", tc.host, got)
		}
	}

	// Empty query produces ?ticket=<64-hex>
	srv := &Server{host: "127.0.0.1", port: 9095}
	emptyQURL := srv.BuildDashboardURL("")
	assertTicketedDashboardURL(t, srv, emptyQURL, "http://127.0.0.1:9095", "", "")

	// WEB_UI_ENABLED=false returns ""
	t.Setenv("WEB_UI_ENABLED", "false")
	if got := srv.BuildDashboardURL("run=1"); got != "" {
		t.Fatalf("BuildDashboardURL with WEB_UI_ENABLED=false = %q, want empty", got)
	}
}

func TestWebSessionHandlers_TicketAndExchangeSecurityMatrix(t *testing.T) {
	t.Setenv("WEB_UI_ENABLED", "true")
	t.Setenv("WEB_SESSION_TTL_MINUTES", "60")

	s := &Server{
		host:     "127.0.0.1",
		port:     9095,
		apiToken: "master-api-token-xyz",
	}
	router := s.RegisterRoutes()

	// 1. POST /api/web-session/ticket requires Bearer auth
	unauthW := httptest.NewRecorder()
	router.ServeHTTP(unauthW, httptest.NewRequest(http.MethodPost, "/api/web-session/ticket", nil))
	if unauthW.Result().StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth POST /api/web-session/ticket status = %d, want 401", unauthW.Result().StatusCode)
	}

	// Wrong method with auth -> 405
	wrongMethodReq := httptest.NewRequest(http.MethodGet, "/api/web-session/ticket", nil)
	wrongMethodReq.Header.Set("Authorization", "Bearer master-api-token-xyz")
	wrongMethodW := httptest.NewRecorder()
	router.ServeHTTP(wrongMethodW, wrongMethodReq)
	if wrongMethodW.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /api/web-session/ticket status = %d, want 405", wrongMethodW.Result().StatusCode)
	}

	// Malformed JSON / trailing garbage -> 400
	for _, badBody := range []string{`{`, `{} trailing`, `{"redirect_query":"%ZZ"}`} {
		badReq := httptest.NewRequest(http.MethodPost, "/api/web-session/ticket", strings.NewReader(badBody))
		badReq.Header.Set("Authorization", "Bearer master-api-token-xyz")
		badW := httptest.NewRecorder()
		router.ServeHTTP(badW, badReq)
		if badW.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("POST /api/web-session/ticket body=%q status=%d, want 400", badBody, badW.Result().StatusCode)
		}
	}

	// Valid empty-body ticket mint -> returns 1 ticket matching dashboard_url
	mintReq := httptest.NewRequest(http.MethodPost, "/api/web-session/ticket?run=99&ticket=spoof", nil)
	mintReq.Header.Set("Authorization", "Bearer master-api-token-xyz")
	mintW := httptest.NewRecorder()
	router.ServeHTTP(mintW, mintReq)
	if mintW.Result().StatusCode != http.StatusOK {
		t.Fatalf("POST /api/web-session/ticket status = %d, want 200 body=%s", mintW.Result().StatusCode, mintW.Body.String())
	}
	if gotCC := mintW.Result().Header.Get("Cache-Control"); gotCC != "no-store" {
		t.Fatalf("ticket Cache-Control = %q, want no-store", gotCC)
	}

	var mintResp struct {
		Ticket       string `json:"ticket"`
		DashboardURL string `json:"dashboard_url"`
		ExpiresAt    string `json:"expires_at"`
	}
	if err := json.NewDecoder(mintW.Body).Decode(&mintResp); err != nil {
		t.Fatalf("decode mintResp: %v", err)
	}
	if !reHex64.MatchString(mintResp.Ticket) {
		t.Fatalf("expected 64-hex ticket, got %q", mintResp.Ticket)
	}
	parsedDash, err := url.Parse(mintResp.DashboardURL)
	if err != nil {
		t.Fatalf("parse dashboard_url: %v", err)
	}
	if parsedDash.Query().Get("ticket") != mintResp.Ticket || parsedDash.Query().Get("run") != "99" {
		t.Fatalf("dashboard_url %q does not match ticket %q and run=99", mintResp.DashboardURL, mintResp.Ticket)
	}
	if _, err := time.Parse(time.RFC3339, mintResp.ExpiresAt); err != nil {
		t.Fatalf("invalid expires_at %q: %v", mintResp.ExpiresAt, err)
	}

	// 2. CRITICAL ORDERING: Rejected probes MUST NOT burn mintResp.Ticket!
	validPayload := `{"ticket":"` + mintResp.Ticket + `"}`

	// Host header attacks -> 403
	for _, badHost := range []string{
		"evil.example:9090",
		"127.0.0.1.evil.com:9090",
		"localhost.evil.com",
		"192.168.1.10:9090",
		"0.0.0.0:9090",
		"127.0.0.1:9090:80",
		"127.0.0.1:+9090",
		"127.0.0.1:-9090",
		"localhost:",
		"user@localhost:9090",
	} {
		req := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(validPayload))
		req.RemoteAddr = "127.0.0.1:54321"
		req.Host = badHost
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusForbidden {
			t.Fatalf("Host=%q status = %d, want 403 body=%s", badHost, w.Result().StatusCode, w.Body.String())
		}
	}

	// Non-loopback RemoteAddr with spoofed forwarding headers -> 403
	fwdReq := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(validPayload))
	fwdReq.RemoteAddr = "192.168.1.5:1234"
	fwdReq.Host = "127.0.0.1:9095"
	fwdReq.Header.Set("Content-Type", "application/json")
	fwdReq.Header.Set("X-Forwarded-For", "127.0.0.1")
	fwdReq.Header.Set("X-Forwarded-Host", "127.0.0.1:9095")
	fwdReq.Header.Set("X-Real-IP", "127.0.0.1")
	fwdReq.Header.Set("Forwarded", "for=127.0.0.1;host=127.0.0.1:9095")
	fwdW := httptest.NewRecorder()
	router.ServeHTTP(fwdW, fwdReq)
	if fwdW.Result().StatusCode != http.StatusForbidden {
		t.Fatalf("non-loopback RemoteAddr with spoofed headers status = %d, want 403", fwdW.Result().StatusCode)
	}

	// Wrong Content-Type -> 415
	for _, badCT := range []string{"", "text/plain", "application/x-www-form-urlencoded"} {
		ctReq := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(validPayload))
		ctReq.RemoteAddr = "127.0.0.1:54321"
		ctReq.Host = "127.0.0.1:9095"
		if badCT != "" {
			ctReq.Header.Set("Content-Type", badCT)
		}
		ctW := httptest.NewRecorder()
		router.ServeHTTP(ctW, ctReq)
		if ctW.Result().StatusCode != http.StatusUnsupportedMediaType {
			t.Fatalf("Content-Type=%q status = %d, want 415", badCT, ctW.Result().StatusCode)
		}
	}

	// Wrong JSON / empty ticket -> 400
	for _, badJSON := range []string{`{}`, `{"ticket":"   "}`, `{`, `{"ticket":"abc"} extra`} {
		jReq := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(badJSON))
		jReq.RemoteAddr = "127.0.0.1:54321"
		jReq.Host = "127.0.0.1:9095"
		jReq.Header.Set("Content-Type", "application/json")
		jW := httptest.NewRecorder()
		router.ServeHTTP(jW, jReq)
		if jW.Result().StatusCode != http.StatusBadRequest {
			t.Fatalf("bad JSON %q status = %d, want 400", badJSON, jW.Result().StatusCode)
		}
	}

	// Wrong method -> 405
	getExReq := httptest.NewRequest(http.MethodGet, "/dashboard/auth/exchange", nil)
	getExW := httptest.NewRecorder()
	router.ServeHTTP(getExW, getExReq)
	if getExW.Result().StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /dashboard/auth/exchange status = %d, want 405", getExW.Result().StatusCode)
	}

	// Valid loopback exchange SUCCEEDS because rejected probes did not burn mintResp.Ticket
	exReq := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(validPayload))
	exReq.RemoteAddr = "127.0.0.1:54321"
	exReq.Host = "127.0.0.1:9095"
	exReq.Header.Set("Content-Type", "application/json; charset=utf-8")
	exW := httptest.NewRecorder()
	router.ServeHTTP(exW, exReq)
	if exW.Result().StatusCode != http.StatusOK {
		t.Fatalf("valid POST /dashboard/auth/exchange after probes status = %d, want 200 body=%s", exW.Result().StatusCode, exW.Body.String())
	}
	if gotCC := exW.Result().Header.Get("Cache-Control"); gotCC != "no-store" {
		t.Fatalf("exchange Cache-Control = %q, want no-store", gotCC)
	}
	var exResp struct {
		SessionToken string `json:"session_token"`
		ExpiresAt    string `json:"expires_at"`
	}
	if err := json.NewDecoder(exW.Body).Decode(&exResp); err != nil {
		t.Fatalf("decode exResp: %v", err)
	}
	if !reHex64.MatchString(exResp.SessionToken) {
		t.Fatalf("expected 64-hex session_token, got %q", exResp.SessionToken)
	}

	// Replay fails with 401
	replayReq := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(validPayload))
	replayReq.RemoteAddr = "127.0.0.1:54321"
	replayReq.Host = "localhost:9095"
	replayReq.Header.Set("Content-Type", "application/json")
	replayW := httptest.NewRecorder()
	router.ServeHTTP(replayW, replayReq)
	if replayW.Result().StatusCode != http.StatusUnauthorized {
		t.Fatalf("replay POST /dashboard/auth/exchange status = %d, want 401", replayW.Result().StatusCode)
	}

	// 3. Loopback Host/RemoteAddr valid variants matrix (localhost, [::1]:port, ::1)
	loopbackCases := []struct {
		remoteAddr string
		host       string
	}{
		{"127.0.0.1:1234", "localhost:9095"},
		{"127.0.0.1:1234", "LOCALHOST"},
		{"[::1]:1234", "[::1]:9095"},
		{"[::1]:1234", "::1"},
		{"::1", "[::1]"},
	}
	for _, lc := range loopbackCases {
		tok, _, err := s.MintWebTicket()
		if err != nil {
			t.Fatalf("MintWebTicket(%v) failed: %v", lc, err)
		}
		req := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(`{"ticket":"`+tok+`"}`))
		req.RemoteAddr = lc.remoteAddr
		req.Host = lc.host
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusOK {
			t.Fatalf("loopback (%s, %s) status = %d, want 200 body=%s", lc.remoteAddr, lc.host, w.Result().StatusCode, w.Body.String())
		}
	}

	// 4. Exchanged session_token works on /api/* via authMiddleware, but NOT on /ws/extension
	apiReq := httptest.NewRequest(http.MethodGet, "/api/enrichment-config", nil)
	apiReq.Header.Set("Authorization", "Bearer "+exResp.SessionToken)
	apiW := httptest.NewRecorder()
	router.ServeHTTP(apiW, apiReq)
	if apiW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/enrichment-config with session token status = %d, want 200", apiW.Result().StatusCode)
	}

	wsReq := httptest.NewRequest(http.MethodGet, "/ws/extension", nil)
	wsReq.Header.Set("Authorization", "Bearer "+exResp.SessionToken)
	if got := s.AuthenticateWSRequest(wsReq); got != WSAuthInvalidCredentials {
		t.Fatalf("expected WS auth to reject web session token, got %v", got)
	}
	if _, ok := s.ValidateWSAuthFrame([]byte(`{"jsonrpc":"2.0","id":"1","method":"auth","params":{"token":"` + exResp.SessionToken + `"}}`)); ok {
		t.Fatal("expected ValidateWSAuthFrame to reject web session token")
	}

	// 5. WEB_UI_ENABLED=false -> 404 on /api/web-session/ticket and /dashboard/auth/exchange
	t.Setenv("WEB_UI_ENABLED", "false")
	disTicketReq := httptest.NewRequest(http.MethodPost, "/api/web-session/ticket", strings.NewReader(`{"redirect_query":"batch=3"}`))
	disTicketReq.Header.Set("Authorization", "Bearer master-api-token-xyz")
	disTicketW := httptest.NewRecorder()
	router.ServeHTTP(disTicketW, disTicketReq)
	if disTicketW.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("disabled POST /api/web-session/ticket status = %d, want 404", disTicketW.Result().StatusCode)
	}

	disExReq := httptest.NewRequest(http.MethodPost, "/dashboard/auth/exchange", strings.NewReader(`{"ticket":"abc"}`))
	disExReq.RemoteAddr = "127.0.0.1:1234"
	disExReq.Host = "127.0.0.1:9095"
	disExReq.Header.Set("Content-Type", "application/json")
	disExW := httptest.NewRecorder()
	router.ServeHTTP(disExW, disExReq)
	if disExW.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("disabled POST /dashboard/auth/exchange status = %d, want 404", disExW.Result().StatusCode)
	}
}
