package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testTokenValidator(expected string) AuthFrameValidator {
	return func(raw []byte) (json.RawMessage, bool) {
		var env struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      json.RawMessage `json:"id"`
			Method  string          `json:"method"`
			Params  struct {
				Token string `json:"token"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return nil, false
		}
		if env.Method != "auth" || env.Params.Token != expected {
			return nil, false
		}
		return env.ID, true
	}
}

func wsURLFromHTTP(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

func dialWS(t *testing.T, url string, opts *websocket.DialOptions) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		t.Fatalf("websocket.Dial failed: %v", err)
	}
	conn.SetReadLimit(8 << 20)
	return conn
}

func TestHub_FirstFrameAuthSuccessAndSessionStatus(t *testing.T) {
	hub := NewHub(HubConfig{
		ValidateAuthFrame: testTokenValidator("secret-token"),
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()

	authPayload := `{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"secret-token","extension_version":"2.0.0","browser":"chrome"}}`
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := conn.Write(ctx, websocket.MessageText, []byte(authPayload)); err != nil {
		t.Fatalf("write auth failed: %v", err)
	}

	_, rawAck, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read auth ack failed: %v", err)
	}

	var ack struct {
		ID     string     `json:"id"`
		Result AuthResult `json:"result"`
	}
	if err := json.Unmarshal(rawAck, &ack); err != nil {
		t.Fatalf("unmarshal ack failed: %v", err)
	}
	if ack.ID != "auth-1" || !ack.Result.OK || ack.Result.SessionID == "" {
		t.Fatalf("unexpected auth ack: %+v", ack)
	}

	status := hub.Status()
	if !status.ExtensionConnected || status.SessionID != ack.Result.SessionID {
		t.Fatalf("unexpected status: %+v", status)
	}
	if status.Browser != "chrome" || status.ExtensionVersion != "2.0.0" {
		t.Fatalf("expected browser/version populated, got %+v", status)
	}
}

func TestHub_AuthFailureAnd5sTimeout(t *testing.T) {
	defaultHub := NewHub(HubConfig{})
	if defaultHub.cfg.AuthTimeout != 5*time.Second {
		t.Fatalf("expected default AuthTimeout 5s, got %s", defaultHub.cfg.AuthTimeout)
	}
	_ = defaultHub.Close()

	hub := NewHub(HubConfig{
		AuthTimeout:       150 * time.Millisecond,
		ValidateAuthFrame: testTokenValidator("good-token"),
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	t.Run("wrong token closes with 4001", func(t *testing.T) {
		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
		defer conn.CloseNow()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"1","method":"auth","params":{"token":"wrong"}}`))

		_, _, err := conn.Read(ctx)
		if websocket.CloseStatus(err) != WSCloseUnauthorized {
			t.Fatalf("expected close 4001, got err=%v status=%d", err, websocket.CloseStatus(err))
		}
	})

	t.Run("non-auth first frame closes with 4001", func(t *testing.T) {
		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
		defer conn.CloseNow()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"1","method":"ping"}`))

		_, _, err := conn.Read(ctx)
		if websocket.CloseStatus(err) != WSCloseUnauthorized {
			t.Fatalf("expected close 4001, got err=%v status=%d", err, websocket.CloseStatus(err))
		}
	})

	t.Run("silent client times out and closes with 4001", func(t *testing.T) {
		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
		defer conn.CloseNow()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _, err := conn.Read(ctx)
		if websocket.CloseStatus(err) != WSCloseUnauthorized {
			t.Fatalf("expected close 4001 on timeout, got err=%v status=%d", err, websocket.CloseStatus(err))
		}
	})
}

func TestHub_PreAuthUpgrade(t *testing.T) {
	hub := NewHub(HubConfig{
		PreAuthCheck: func(r *http.Request) bool {
			return r.URL.Query().Get("token") == "preauth-tok"
		},
		AllowOrigin: func(origin string) bool {
			return strings.HasPrefix(origin, "chrome-extension://")
		},
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	// Disallowed origin fails before upgrade with 403
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"?token=preauth-tok", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("origin check request failed: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed origin, got %d", resp.StatusCode)
	}

	conn := dialWS(t, wsURLFromHTTP(srv.URL)+"?token=preauth-tok", nil)
	defer conn.CloseNow()

	// Wait briefly for server to register session
	deadline := time.Now().Add(2 * time.Second)
	for !hub.IsConnected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !hub.IsConnected() {
		t.Fatalf("expected pre-auth session to register")
	}

	// Simulate extension handling session.status RPC without auth frame
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go func() {
		_, rawReq, rErr := conn.Read(ctx)
		if rErr != nil {
			return
		}
		var env Envelope
		_ = json.Unmarshal(rawReq, &env)
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"result":{"ok":true,"extension_connected":true}}`))
	}()

	res, err := hub.CallExtension(ctx, "session.status", map[string]any{}, 2*time.Second)
	if err != nil {
		t.Fatalf("CallExtension failed: %v", err)
	}
	if !strings.Contains(string(res), `"extension_connected":true`) {
		t.Fatalf("unexpected RPC result: %s", string(res))
	}
}

func TestHub_HeartbeatAndMalformedRecovery(t *testing.T) {
	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()

	deadline := time.Now().Add(2 * time.Second)
	for !hub.IsConnected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	initialHB := hub.Status().LastHeartbeatAt

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// 1. Malformed JSON should return -32700 without closing socket
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{broken-json`)); err != nil {
		t.Fatalf("write broken json failed: %v", err)
	}
	_, rawParseErr, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("expected -32700 error frame, got %v", err)
	}
	if !strings.Contains(string(rawParseErr), "-32700") {
		t.Fatalf("expected -32700 in response, got %s", string(rawParseErr))
	}

	// 2. Unknown method should return -32601 without closing socket
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"unk-1","method":"does.not.exist"}`)); err != nil {
		t.Fatalf("write unknown method failed: %v", err)
	}
	_, rawMethodErr, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("expected -32601 error frame, got %v", err)
	}
	if !strings.Contains(string(rawMethodErr), "-32601") {
		t.Fatalf("expected -32601 in response, got %s", string(rawMethodErr))
	}

	// 3. Ping with ID and without ID both respond with pong and update last_heartbeat_at
	time.Sleep(15 * time.Millisecond)
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"ping-1","method":"ping","params":{"upwork_logged_in":true}}`)); err != nil {
		t.Fatalf("write ping with id failed: %v", err)
	}
	_, rawPong1, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read pong1 failed: %v", err)
	}
	if !strings.Contains(string(rawPong1), `"pong":true`) {
		t.Fatalf("expected pong:true, got %s", string(rawPong1))
	}

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"ping"}`)); err != nil {
		t.Fatalf("write ping notification failed: %v", err)
	}
	_, rawPong2, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read pong2 failed: %v", err)
	}
	if !strings.Contains(string(rawPong2), `"method":"pong"`) {
		t.Fatalf("expected method:pong, got %s", string(rawPong2))
	}

	after := hub.Status()
	if after.LastHeartbeatAt == initialHB {
		t.Fatalf("expected LastHeartbeatAt to advance from %s", initialHB)
	}
	if after.UpworkLoggedIn == nil || !*after.UpworkLoggedIn {
		t.Fatalf("expected UpworkLoggedIn=true, got %v", after.UpworkLoggedIn)
	}
}

func TestHub_CallExtensionCorrelationAndErrors(t *testing.T) {
	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
	})
	defer hub.Close()

	// Disconnected call returns ErrExtensionDisconnected
	_, err := hub.CallExtension(context.Background(), "session.status", nil, time.Second)
	if !errors.Is(err, ErrExtensionDisconnected) {
		t.Fatalf("expected ErrExtensionDisconnected, got %v", err)
	}

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()

	deadline := time.Now().Add(2 * time.Second)
	for !hub.IsConnected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Responder goroutine handling concurrent & error scenarios
	go func() {
		for {
			_, raw, rErr := conn.Read(ctx)
			if rErr != nil {
				return
			}
			var env Envelope
			if json.Unmarshal(raw, &env) != nil || env.Method == "" {
				continue
			}
			switch env.Method {
			case "echo":
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"result":`+string(env.Params)+`}`))
			case "challenge_err":
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"error":{"code":-32001,"message":"captcha","data":{"error_code":"HUMAN_ACTION_REQUIRED"}}}`))
			case "challenge_str":
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"error":{"code":"HUMAN_ACTION_REQUIRED","message":"2FA prompt"}}`))
			case "challenge_result":
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"result":{"status":"HUMAN_ACTION_REQUIRED","reason":"login wall"}}`))
			case "approval_err":
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"error":{"code":"APPROVAL_REQUIRED","message":"pending"}}`))
			case "cap_err":
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"error":{"code":-32005,"message":"limit","data":{"code":"DAILY_CAP_EXCEEDED"}}}`))
			case "slow":
				// Intentionally do not reply to trigger timeout
			}
		}
	}()

	// Concurrent RPC correlation
	var wg sync.WaitGroup
	for i := range 5 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			res, cErr := hub.CallExtension(ctx, "echo", map[string]int{"idx": idx}, 2*time.Second)
			if cErr != nil {
				t.Errorf("concurrent echo %d failed: %v", idx, cErr)
				return
			}
			var out map[string]int
			if uErr := json.Unmarshal(res, &out); uErr != nil || out["idx"] != idx {
				t.Errorf("mismatched correlation for %d: %s", idx, string(res))
			}
		}(i)
	}
	wg.Wait()

	for _, tc := range []struct {
		method string
		target error
	}{
		{"challenge_err", ErrHumanActionRequired},
		{"challenge_str", ErrHumanActionRequired},
		{"challenge_result", ErrHumanActionRequired},
		{"approval_err", ErrApprovalRequired},
		{"cap_err", ErrDailyCapExceeded},
	} {
		_, cErr := hub.CallExtension(ctx, tc.method, nil, 2*time.Second)
		if !errors.Is(cErr, tc.target) {
			t.Fatalf("method %s: expected errors.Is(_, %v), got %v", tc.method, tc.target, cErr)
		}
	}

	// Timeout check
	_, tErr := hub.CallExtension(ctx, "slow", nil, 80*time.Millisecond)
	var bErr *BridgeError
	if !errors.As(tErr, &bErr) || bErr.Code != ErrCodeTimeout {
		t.Fatalf("expected timeout BridgeError, got %v", tErr)
	}
}

func TestHub_ProgressEventsAndLargePayload(t *testing.T) {
	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()

	deadline := time.Now().Add(2 * time.Second)
	for !hub.IsConnected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	ch, unsub := hub.SubscribeProgress("req-42")
	defer unsub()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	progFrame := `{"jsonrpc":"2.0","method":"task.progress","params":{"request_id":"req-42","stage":"enriching","current":3,"total":10,"message":"Fetching details"}}`
	if err := conn.Write(ctx, websocket.MessageText, []byte(progFrame)); err != nil {
		t.Fatalf("write progress failed: %v", err)
	}

	select {
	case evt := <-ch:
		if evt.RequestID != "req-42" || evt.Stage != "enriching" || evt.Current != 3 || evt.Total != 10 {
			t.Fatalf("unexpected progress event: %+v", evt)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for progress event")
	}

	// Verify >64 KB payload (exceeding coder/websocket default 32 KB limit) succeeds
	largeBlob := strings.Repeat("x", 96*1024)
	go func() {
		_, raw, rErr := conn.Read(ctx)
		if rErr != nil {
			return
		}
		var env Envelope
		_ = json.Unmarshal(raw, &env)
		resBytes, _ := json.Marshal(map[string]string{"payload": largeBlob})
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"result":`+string(resBytes)+`}`))
	}()

	res, err := hub.CallExtension(ctx, "jobs.detail", nil, 3*time.Second)
	if err != nil {
		t.Fatalf("large payload CallExtension failed: %v", err)
	}
	if len(res) < 96*1024 {
		t.Fatalf("expected >96KB payload, got %d bytes", len(res))
	}
}

func TestHub_SessionReplacementAndGracefulClose(t *testing.T) {
	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn1 := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn1.CloseNow()

	deadline := time.Now().Add(2 * time.Second)
	for !hub.IsConnected() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	sess1ID := hub.Status().SessionID

	conn2 := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn2.CloseNow()

	deadline = time.Now().Add(2 * time.Second)
	for hub.Status().SessionID == sess1ID && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !hub.IsConnected() || hub.Status().SessionID == sess1ID {
		t.Fatalf("expected session2 to replace session1")
	}

	// Old connection should receive StatusGoingAway
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _, err1 := conn1.Read(ctx)
	if websocket.CloseStatus(err1) != websocket.StatusGoingAway {
		t.Fatalf("expected old session close StatusGoingAway, got %v (status %d)", err1, websocket.CloseStatus(err1))
	}

	// Pending RPC on active session unblocks on Hub.Close()
	errCh := make(chan error, 1)
	go func() {
		_, cErr := hub.CallExtension(context.Background(), "jobs.search", nil, 10*time.Second)
		errCh <- cErr
	}()
	time.Sleep(30 * time.Millisecond)

	if err := hub.Close(); err != nil {
		t.Fatalf("Hub.Close failed: %v", err)
	}
	if hub.IsConnected() {
		t.Fatalf("expected hub disconnected after Close")
	}

	select {
	case cErr := <-errCh:
		if !errors.Is(cErr, ErrExtensionDisconnected) {
			t.Fatalf("expected pending RPC to unblock with ErrExtensionDisconnected, got %v", cErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("pending RPC did not unblock on Close")
	}
}

func TestHub_AuthAckOrderingAndConcurrentSessionReplacement(t *testing.T) {
	hub := NewHub(HubConfig{
		ValidateAuthFrame: testTokenValidator("secret-token"),
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	const iterations = 25
	for i := range iterations {
		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		authPayload := `{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"secret-token","extension_version":"2.0.0","browser":"chrome"}}`
		if err := conn.Write(ctx, websocket.MessageText, []byte(authPayload)); err != nil {
			cancel()
			_ = conn.CloseNow()
			t.Fatalf("iter %d: write auth failed: %v", i, err)
		}

		_, rawAck, err := conn.Read(ctx)
		if err != nil {
			cancel()
			_ = conn.CloseNow()
			t.Fatalf("iter %d: read auth ack failed: %v", i, err)
		}

		var ack struct {
			ID     string     `json:"id"`
			Result AuthResult `json:"result"`
		}
		if err := json.Unmarshal(rawAck, &ack); err != nil {
			cancel()
			_ = conn.CloseNow()
			t.Fatalf("iter %d: unmarshal ack failed: %v", i, err)
		}
		if !ack.Result.OK || ack.Result.SessionID == "" {
			cancel()
			_ = conn.CloseNow()
			t.Fatalf("iter %d: unexpected auth ack: %+v", i, ack)
		}

		// Immediately after receiving the auth ACK (with zero sleep/polling),
		// Hub.Status() must already reflect the newly registered session.
		status := hub.Status()
		if !status.ExtensionConnected || status.SessionID != ack.Result.SessionID {
			cancel()
			_ = conn.CloseNow()
			t.Fatalf("iter %d: auth ACK arrived before registerSession (ack=%s, status=%+v)", i, ack.Result.SessionID, status)
		}

		// Verify concurrent Status() reads and immediate CallExtension serialization
		// (ackBytes must precede any server-initiated RPC frame on the wire).
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			for range 10 {
				_ = hub.Status()
			}
		}()
		go func() {
			defer wg.Done()
			_, rawReq, rErr := conn.Read(ctx)
			if rErr != nil {
				return
			}
			var env Envelope
			if json.Unmarshal(rawReq, &env) == nil && env.Method == "ping.check" {
				_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":`+string(env.ID)+`,"result":{"ok":true}}`))
			}
		}()

		res, callErr := hub.CallExtension(ctx, "ping.check", map[string]int{"iter": i}, 2*time.Second)
		if callErr != nil {
			cancel()
			_ = conn.CloseNow()
			wg.Wait()
			t.Fatalf("iter %d: immediate CallExtension after auth ACK failed: %v", i, callErr)
		}
		if !strings.Contains(string(res), `"ok":true`) {
			cancel()
			_ = conn.CloseNow()
			wg.Wait()
			t.Fatalf("iter %d: unexpected CallExtension result: %s", i, string(res))
		}

		_ = conn.CloseNow()
		wg.Wait()
		cancel()
	}
}

func TestHub_NotifyExtensionMidRPCDisconnectProgressOverflowAndPreAuth(t *testing.T) {
	var progressCount atomic.Int32
	hub := NewHub(HubConfig{
		AuthTimeout:       200 * time.Millisecond,
		ValidateAuthFrame: testTokenValidator("secret-token"),
		OnProgress: func(_ ProgressEvent) {
			progressCount.Add(1)
		},
	})
	defer hub.Close()

	// 1. NotifyExtension when disconnected returns ErrExtensionDisconnected
	if err := hub.NotifyExtension(context.Background(), "kill_switch.abort", map[string]any{"reason": "test"}); !errors.Is(err, ErrExtensionDisconnected) {
		t.Fatalf("expected ErrExtensionDisconnected on NotifyExtension, got %v", err)
	}

	srv := httptest.NewServer(hub)
	defer srv.Close()

	// 2. Pre-auth task.progress frame injection closes with 4001 and must NOT invoke OnProgress
	badConn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = badConn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"task.progress","params":{"request_id":"evil","stage":"x","current":1,"total":1}}`))
	_, _, badErr := badConn.Read(ctx)
	_ = badConn.CloseNow()
	if websocket.CloseStatus(badErr) != WSCloseUnauthorized {
		t.Fatalf("expected 4001 for pre-auth task.progress, got %v (status %d)", badErr, websocket.CloseStatus(badErr))
	}
	if progressCount.Load() != 0 {
		t.Fatalf("pre-auth task.progress must not trigger OnProgress, got %d", progressCount.Load())
	}

	// 3. Authenticated session: NotifyExtension + Progress overflow (>16) + Concurrent CallExtension mid-RPC disconnect
	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"secret-token"}}`))
	_, _, _ = conn.Read(ctx)

	if err := hub.NotifyExtension(ctx, "kill_switch.abort", map[string]any{"reason": "test"}); err != nil {
		t.Fatalf("NotifyExtension connected failed: %v", err)
	}
	_, rawNotif, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(rawNotif), `"kill_switch.abort"`) {
		t.Fatalf("expected kill_switch.abort notification, got %q err=%v", string(rawNotif), err)
	}

	ch, unsub := hub.SubscribeProgress("req-overflow")
	for i := range 25 {
		_ = conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"jsonrpc":"2.0","method":"task.progress","params":{"request_id":"req-overflow","stage":"s","current":%d,"total":25}}`, i)))
	}
	time.Sleep(50 * time.Millisecond)
	if len(ch) != 16 {
		t.Fatalf("expected buffered progress channel capped at 16 without blocking, got %d", len(ch))
	}
	unsub()

	// Concurrent CallExtension calls unblock with ErrExtensionDisconnected when client drops mid-RPC
	var wg sync.WaitGroup
	errs := make([]error, 4)
	for i := range 4 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, errs[idx] = hub.CallExtension(context.Background(), "slow.op", nil, 5*time.Second)
		}(i)
	}
	time.Sleep(40 * time.Millisecond)
	_ = conn.CloseNow()
	wg.Wait()
	for i, cErr := range errs {
		if !errors.Is(cErr, ErrExtensionDisconnected) {
			t.Errorf("rpc %d after client drop: got %v, want ErrExtensionDisconnected", i, cErr)
		}
	}
}
