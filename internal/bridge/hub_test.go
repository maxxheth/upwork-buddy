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

func waitForHubConnected(t *testing.T, hub *Hub, want bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for hub.IsConnected() != want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if hub.IsConnected() != want {
		t.Fatalf("timed out waiting for hub.IsConnected() == %v", want)
	}
}

func TestHub_SearchObservedDecodingAndPagination(t *testing.T) {
	evtCh := make(chan SearchObservedEvent, 16)
	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
		OnSearchObserved: func(evt SearchObservedEvent) {
			evtCh <- evt
		},
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()
	waitForHubConnected(t, hub, true)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("full payload with paging and ProjectedGraphQLJob fields", func(t *testing.T) {
		payload := map[string]any{
			"jsonrpc": "2.0",
			"method":  "search.observed",
			"params": map[string]any{
				"tab_id":         42,
				"page_url":       "https://www.upwork.com/nx/search/jobs/?q=golang",
				"source_feed":    "search",
				"query":          "golang",
				"operation_name": "userJobSearchV1",
				"capture_kind":   "graphql",
				"captured_at":    "2026-11-22T23:00:00Z",
				"paging": map[string]any{
					"total_count":   120,
					"offset":        20,
					"count":         20,
					"page":          2,
					"per_page":      20,
					"has_next_page": true,
					"next_cursor":   "cur-2",
				},
				"jobs": []map[string]any{
					{
						"upwork_job_id":     "~01abc123456",
						"job_title":         "Senior Go WebSocket Engineer",
						"job_description":   "Build reliable JSON-RPC bridge.",
						"canonical_url":     "https://www.upwork.com/jobs/~01abc123456/",
						"url":               "https://www.upwork.com/jobs/~01abc123456/",
						"job_url":           "https://www.upwork.com/jobs/~01abc123456/",
						"source":            "chrome_live_stream",
						"source_feed":       "search",
						"source_query":      "golang",
						"status":            "ready",
						"contract_type":     "hourly",
						"rate_min":          "$60",
						"rate_max":          "$90",
						"rate_range":        "$60 - $90",
						"budget":            "$60 - $90/hr",
						"experience_level":  "Expert",
						"posted_at_est":     "2026-11-22T22:50:00Z",
						"connects_required": 12,
						"client_hire_rate":  0.75,
						"payment_verified":  true,
						"skills":            "Go, WebSockets, PostgreSQL",
					},
					{
						"upwork_job_id": "~01def789012",
						"job_title":     "Fix GraphQL Ingestion",
						"contract_type": "fixed",
						"budget_amount": "$1,500",
						"budget":        "$1,500 fixed",
						"source":        "chrome_live_stream",
						"status":        "ready",
					},
				},
			},
		}
		raw, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal failed: %v", err)
		}
		if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatalf("write failed: %v", err)
		}

		var evt SearchObservedEvent
		select {
		case evt = <-evtCh:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for SearchObservedEvent")
		}

		if evt.TabID != 42 ||
			evt.PageURL != "https://www.upwork.com/nx/search/jobs/?q=golang" ||
			evt.SourceFeed != "search" ||
			evt.Query != "golang" ||
			evt.OperationName != "userJobSearchV1" ||
			evt.CaptureKind != "graphql" ||
			evt.CapturedAt != "2026-11-22T23:00:00Z" {
			t.Fatalf("unexpected event metadata: %+v", evt)
		}
		if evt.Paging == nil {
			t.Fatalf("expected non-nil Paging")
		}
		if evt.Paging.TotalCount == nil || *evt.Paging.TotalCount != 120 ||
			evt.Paging.Offset == nil || *evt.Paging.Offset != 20 ||
			evt.Paging.Count == nil || *evt.Paging.Count != 20 ||
			evt.Paging.Page == nil || *evt.Paging.Page != 2 ||
			evt.Paging.PerPage == nil || *evt.Paging.PerPage != 20 ||
			evt.Paging.HasNextPage == nil || !*evt.Paging.HasNextPage ||
			evt.Paging.NextCursor != "cur-2" {
			t.Fatalf("unexpected Paging values: %+v", evt.Paging)
		}
		if len(evt.Jobs) != 2 {
			t.Fatalf("expected 2 jobs, got %d", len(evt.Jobs))
		}

		var job0 map[string]any
		if err := json.Unmarshal(evt.Jobs[0], &job0); err != nil {
			t.Fatalf("unmarshal job[0] failed: %v", err)
		}
		if job0["upwork_job_id"] != "~01abc123456" ||
			job0["source"] != "chrome_live_stream" ||
			job0["contract_type"] != "hourly" ||
			job0["posted_at_est"] != "2026-11-22T22:50:00Z" ||
			job0["payment_verified"] != true ||
			job0["connects_required"] != float64(12) {
			t.Fatalf("job[0] fields not preserved: %+v", job0)
		}
	})

	t.Run("explicit zero and false paging values", func(t *testing.T) {
		raw := []byte(`{
			"jsonrpc":"2.0",
			"method":"search.observed",
			"params":{
				"page_url":"https://www.upwork.com/nx/search/jobs/?q=none",
				"source_feed":"search",
				"paging":{"total_count":0,"offset":0,"count":0,"page":1,"per_page":20,"has_next_page":false},
				"jobs":[]
			}
		}`)
		if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatalf("write failed: %v", err)
		}

		var evt SearchObservedEvent
		select {
		case evt = <-evtCh:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for zero-paging SearchObservedEvent")
		}

		if evt.Paging == nil {
			t.Fatalf("expected non-nil Paging")
		}
		if evt.Paging.TotalCount == nil || *evt.Paging.TotalCount != 0 {
			t.Fatalf("expected TotalCount=0, got %v", evt.Paging.TotalCount)
		}
		if evt.Paging.Offset == nil || *evt.Paging.Offset != 0 {
			t.Fatalf("expected Offset=0, got %v", evt.Paging.Offset)
		}
		if evt.Paging.Count == nil || *evt.Paging.Count != 0 {
			t.Fatalf("expected Count=0, got %v", evt.Paging.Count)
		}
		if evt.Paging.Page == nil || *evt.Paging.Page != 1 {
			t.Fatalf("expected Page=1, got %v", evt.Paging.Page)
		}
		if evt.Paging.HasNextPage == nil || *evt.Paging.HasNextPage {
			t.Fatalf("expected HasNextPage=false, got %v", evt.Paging.HasNextPage)
		}
		if len(evt.Jobs) != 0 {
			t.Fatalf("expected 0 jobs, got %d", len(evt.Jobs))
		}
	})

	t.Run("large >64KB search.observed batch clears 32KB default limit", func(t *testing.T) {
		desc := strings.Repeat("Go backend engineering ", 120) // ~2.7 KB per job
		jobs := make([]map[string]any, 0, 50)
		for i := range 50 {
			jobs = append(jobs, map[string]any{
				"upwork_job_id":   fmt.Sprintf("~01bulk%06d", i),
				"job_title":       fmt.Sprintf("Bulk Go Job %d", i),
				"job_description": desc,
				"source":          "chrome_live_stream",
				"status":          "ready",
			})
		}
		raw, err := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  "search.observed",
			"params": map[string]any{
				"page_url":    "https://www.upwork.com/nx/search/jobs/?q=bulk",
				"source_feed": "search",
				"jobs":        jobs,
			},
		})
		if err != nil {
			t.Fatalf("marshal large batch failed: %v", err)
		}
		if len(raw) <= 64*1024 {
			t.Fatalf("expected payload >64KB, got %d bytes", len(raw))
		}
		if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatalf("write large batch failed: %v", err)
		}

		var evt SearchObservedEvent
		select {
		case evt = <-evtCh:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for large SearchObservedEvent")
		}
		if len(evt.Jobs) != 50 {
			t.Fatalf("expected 50 jobs, got %d", len(evt.Jobs))
		}
		var first, last map[string]any
		_ = json.Unmarshal(evt.Jobs[0], &first)
		_ = json.Unmarshal(evt.Jobs[49], &last)
		if first["upwork_job_id"] != "~01bulk000000" || last["upwork_job_id"] != "~01bulk000049" {
			t.Fatalf("unexpected boundary job IDs: first=%v last=%v", first["upwork_job_id"], last["upwork_job_id"])
		}
	})
}

func TestHub_SetSearchObservedHandlerAndRaceSafety(t *testing.T) {
	// Nil *Hub receiver must be safe.
	var nilHub *Hub
	nilHub.SetSearchObservedHandler(func(SearchObservedEvent) {})
	nilHub.dispatchSearchObserved(SearchObservedEvent{})

	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()
	waitForHubConnected(t, hub, true)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	sendObserved := func(query string) {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  "search.observed",
			"params": map[string]any{
				"page_url":    "https://www.upwork.com/nx/search/jobs/",
				"source_feed": "search",
				"query":       query,
				"jobs":        []any{},
			},
		})
		if err := conn.Write(ctx, websocket.MessageText, raw); err != nil {
			t.Fatalf("write search.observed(%q) failed: %v", query, err)
		}
	}

	assertPingBarrier := func(id string) {
		t.Helper()
		if err := conn.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"jsonrpc":"2.0","id":%q,"method":"ping"}`, id))); err != nil {
			t.Fatalf("write ping(%s) failed: %v", id, err)
		}
		_, rawResp, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read ping(%s) response failed: %v", id, err)
		}
		if !strings.Contains(string(rawResp), id) || !strings.Contains(string(rawResp), `"pong":true`) {
			t.Fatalf("expected pong for %s, got %s", id, string(rawResp))
		}
	}

	// 1. Initially nil handler is a safe no-op.
	sendObserved("ignored-initial")
	assertPingBarrier("ping-nil-init")

	// 2. Register handlerA, then swap to handlerB, then clear to nil.
	chA := make(chan SearchObservedEvent, 8)
	chB := make(chan SearchObservedEvent, 8)
	var countA, countB atomic.Int32
	handlerA := func(evt SearchObservedEvent) {
		countA.Add(1)
		chA <- evt
	}
	handlerB := func(evt SearchObservedEvent) {
		countB.Add(1)
		chB <- evt
	}

	hub.SetSearchObservedHandler(handlerA)
	sendObserved("alpha")
	select {
	case evt := <-chA:
		if evt.Query != "alpha" {
			t.Fatalf("handlerA expected query alpha, got %q", evt.Query)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for handlerA")
	}

	hub.SetSearchObservedHandler(handlerB)
	sendObserved("beta")
	select {
	case evt := <-chB:
		if evt.Query != "beta" {
			t.Fatalf("handlerB expected query beta, got %q", evt.Query)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for handlerB")
	}
	if countA.Load() != 1 {
		t.Fatalf("expected handlerA count to remain 1, got %d", countA.Load())
	}

	hub.SetSearchObservedHandler(nil)
	sendObserved("ignored-cleared")
	assertPingBarrier("ping-nil-cleared")
	if countA.Load() != 1 || countB.Load() != 1 {
		t.Fatalf("expected counts (1, 1) after clearing handler, got (%d, %d)", countA.Load(), countB.Load())
	}

	// 3. Re-entrancy check: calling SetSearchObservedHandler and Status inside the callback must not deadlock
	// because dispatchSearchObserved releases searchObservedMu.RLock() before invoking fn.
	reentrantDone := make(chan struct{}, 1)
	hub.SetSearchObservedHandler(func(_ SearchObservedEvent) {
		_ = hub.Status()
		hub.SetSearchObservedHandler(nil)
		reentrantDone <- struct{}{}
	})
	sendObserved("reentrant")
	select {
	case <-reentrantDone:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for re-entrant handler (possible lock held across callback)")
	}

	// 4. Concurrent -race stress: swap handlers 100 times while sending 100 search.observed frames.
	var stressA, stressB atomic.Int32
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := range 100 {
			switch i % 3 {
			case 0:
				hub.SetSearchObservedHandler(func(SearchObservedEvent) { stressA.Add(1) })
			case 1:
				hub.SetSearchObservedHandler(func(SearchObservedEvent) { stressB.Add(1) })
			default:
				hub.SetSearchObservedHandler(nil)
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := range 100 {
			sendObserved(fmt.Sprintf("stress-%d", i))
		}
	}()
	wg.Wait()

	// Drain all 100 stress frames through readLoop before installing finalHandler.
	assertPingBarrier("ping-post-stress")

	finalCh := make(chan SearchObservedEvent, 1)
	hub.SetSearchObservedHandler(func(evt SearchObservedEvent) {
		finalCh <- evt
	})
	sendObserved("final")
	select {
	case evt := <-finalCh:
		if evt.Query != "final" {
			t.Fatalf("expected final query, got %q", evt.Query)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for final handler after concurrent stress")
	}
}

func TestHub_SearchObservedInterleavedWithConcurrentCallExtension(t *testing.T) {
	evtCh := make(chan SearchObservedEvent, 32)
	hub := NewHub(HubConfig{
		PreAuthCheck: func(_ *http.Request) bool { return true },
		OnSearchObserved: func(evt SearchObservedEvent) {
			evtCh <- evt
		},
	})
	defer hub.Close()

	srv := httptest.NewServer(hub)
	defer srv.Close()

	conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
	defer conn.CloseNow()
	waitForHubConnected(t, hub, true)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var writeMu sync.Mutex
	writeText := func(b []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.Write(ctx, websocket.MessageText, b)
	}

	// Single client reader goroutine: answers "echo" RPCs and forwards any other server frame to ctrlCh.
	ctrlCh := make(chan []byte, 16)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			_, raw, rErr := conn.Read(ctx)
			if rErr != nil {
				return
			}
			var env Envelope
			if json.Unmarshal(raw, &env) == nil && env.Method == "echo" {
				_ = writeText([]byte(`{"jsonrpc":"2.0","id":` + string(env.ID) + `,"result":` + string(env.Params) + `}`))
				continue
			}
			ctrlCh <- raw
		}
	}()

	const rpcCount = 8
	const notifCount = 20
	var wg sync.WaitGroup
	for i := range rpcCount {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			res, cErr := hub.CallExtension(ctx, "echo", map[string]int{"idx": idx}, 2*time.Second)
			if cErr != nil {
				t.Errorf("CallExtension(%d) failed: %v", idx, cErr)
				return
			}
			var out map[string]int
			if uErr := json.Unmarshal(res, &out); uErr != nil || out["idx"] != idx {
				t.Errorf("CallExtension(%d) correlation mismatch: %s", idx, string(res))
			}
		}(i)
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := range notifCount {
			frame := map[string]any{
				"jsonrpc": "2.0",
				"method":  "search.observed",
				"params": map[string]any{
					"page_url":    "https://www.upwork.com/nx/search/jobs/",
					"source_feed": "search",
					"query":       fmt.Sprintf("interleaved-%d", i),
					"jobs":        []any{},
				},
			}
			// Alternate notifications without id and frames with id to verify -32601 is never sent.
			if i%2 == 1 {
				frame["id"] = fmt.Sprintf("obs-%d", i)
			}
			raw, _ := json.Marshal(frame)
			if err := writeText(raw); err != nil {
				t.Errorf("write interleaved search.observed %d failed: %v", i, err)
				return
			}
		}
	}()

	wg.Wait()

	for i := range notifCount {
		select {
		case <-evtCh:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for interleaved search.observed %d/%d", i+1, notifCount)
		}
	}

	// Deterministic no--32601 check: send search.observed WITH id immediately followed by ping sentinel.
	if err := writeText([]byte(`{"jsonrpc":"2.0","id":"obs-id-sentinel","method":"search.observed","params":{"page_url":"https://www.upwork.com/nx/search/jobs/","source_feed":"search","jobs":[]}}`)); err != nil {
		t.Fatalf("write obs-id-sentinel failed: %v", err)
	}
	if err := writeText([]byte(`{"jsonrpc":"2.0","id":"ping-sentinel","method":"ping"}`)); err != nil {
		t.Fatalf("write ping-sentinel failed: %v", err)
	}

	select {
	case rawCtrl := <-ctrlCh:
		if !strings.Contains(string(rawCtrl), `"ping-sentinel"`) || !strings.Contains(string(rawCtrl), `"pong":true`) {
			t.Fatalf("expected ping-sentinel pong as first non-echo frame (no -32601 allowed), got %s", string(rawCtrl))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for ping-sentinel pong")
	}

	if len(ctrlCh) != 0 {
		extra := <-ctrlCh
		t.Fatalf("unexpected extra frame on wire: %s", string(extra))
	}
	_ = conn.CloseNow()
	<-readerDone
}

func TestHub_SearchObservedPreAuthMalformedAndMaxMessageBytes(t *testing.T) {
	t.Run("pre-auth search.observed rejected with 4001 and zero handler calls", func(t *testing.T) {
		var count atomic.Int32
		hub := NewHub(HubConfig{
			AuthTimeout:       200 * time.Millisecond,
			ValidateAuthFrame: testTokenValidator("secret-token"),
			OnSearchObserved: func(SearchObservedEvent) {
				count.Add(1)
			},
		})
		defer hub.Close()

		srv := httptest.NewServer(hub)
		defer srv.Close()

		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
		defer conn.CloseNow()

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","method":"search.observed","params":{"page_url":"https://www.upwork.com/nx/search/jobs/","source_feed":"search","jobs":[{"upwork_job_id":"~01evil"}]}}`))
		_, _, err := conn.Read(ctx)
		if websocket.CloseStatus(err) != WSCloseUnauthorized {
			t.Fatalf("expected close 4001 for pre-auth search.observed, got err=%v status=%d", err, websocket.CloseStatus(err))
		}
		if count.Load() != 0 {
			t.Fatalf("pre-auth search.observed must not invoke handler, got %d", count.Load())
		}
	})

	t.Run("empty, null, and malformed params safely dropped without -32601", func(t *testing.T) {
		evtCh := make(chan SearchObservedEvent, 8)
		hub := NewHub(HubConfig{
			ValidateAuthFrame: testTokenValidator("secret-token"),
			OnSearchObserved: func(evt SearchObservedEvent) {
				evtCh <- evt
			},
		})
		defer hub.Close()

		srv := httptest.NewServer(hub)
		defer srv.Close()

		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
		defer conn.CloseNow()

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"secret-token"}}`)); err != nil {
			t.Fatalf("write auth failed: %v", err)
		}
		if _, _, err := conn.Read(ctx); err != nil {
			t.Fatalf("read auth ack failed: %v", err)
		}

		badFrames := []string{
			`{"jsonrpc":"2.0","method":"search.observed"}`,
			`{"jsonrpc":"2.0","method":"search.observed","params":null}`,
			`{"jsonrpc":"2.0","id":"obs-null-id","method":"search.observed","params":null}`,
			`{"jsonrpc":"2.0","method":"search.observed","params":"not-an-object"}`,
			`{"jsonrpc":"2.0","method":"search.observed","params":["array"]}`,
			`{"jsonrpc":"2.0","id":"obs-bad-int","method":"search.observed","params":{"tab_id":"bad","jobs":[]}}`,
			`{"jsonrpc":"2.0","id":"obs-bad-jobs","method":"search.observed","params":{"jobs":"not-array"}}`,
		}
		for _, frame := range badFrames {
			if err := conn.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
				t.Fatalf("write bad frame %s failed: %v", frame, err)
			}
		}

		// Follow with valid search.observed and trailing ping sentinel.
		validFrame := `{"jsonrpc":"2.0","method":"search.observed","params":{"page_url":"https://www.upwork.com/nx/search/jobs/?q=recovered","source_feed":"search","query":"recovered","jobs":[{"upwork_job_id":"~01ok"}]}}`
		if err := conn.Write(ctx, websocket.MessageText, []byte(validFrame)); err != nil {
			t.Fatalf("write valid frame failed: %v", err)
		}
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"jsonrpc":"2.0","id":"after-malformed","method":"ping"}`)); err != nil {
			t.Fatalf("write ping sentinel failed: %v", err)
		}

		_, rawResp, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read ping sentinel failed: %v", err)
		}
		if !strings.Contains(string(rawResp), `"after-malformed"`) || !strings.Contains(string(rawResp), `"pong":true`) {
			t.Fatalf("expected ping sentinel response immediately (no -32601 or error frames), got %s", string(rawResp))
		}

		var got []SearchObservedEvent
		for len(evtCh) > 0 {
			got = append(got, <-evtCh)
		}
		if len(got) != 1 || got[0].Query != "recovered" || len(got[0].Jobs) != 1 {
			t.Fatalf("expected exactly 1 recovered SearchObservedEvent, got %+v", got)
		}
	})

	t.Run("MaxMessageBytes boundary enforcement", func(t *testing.T) {
		var count atomic.Int32
		hub := NewHub(HubConfig{
			PreAuthCheck:    func(_ *http.Request) bool { return true },
			MaxMessageBytes: 4096,
			OnSearchObserved: func(SearchObservedEvent) {
				count.Add(1)
			},
		})
		defer hub.Close()

		srv := httptest.NewServer(hub)
		defer srv.Close()

		conn := dialWS(t, wsURLFromHTTP(srv.URL), nil)
		defer conn.CloseNow()
		waitForHubConnected(t, hub, true)

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()

		oversized, err := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  "search.observed",
			"params": map[string]any{
				"page_url":    "https://www.upwork.com/nx/search/jobs/",
				"source_feed": "search",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~01oversized",
						"job_description": strings.Repeat("A", 6*1024),
					},
				},
			},
		})
		if err != nil {
			t.Fatalf("marshal oversized payload failed: %v", err)
		}
		if len(oversized) <= 4096 {
			t.Fatalf("expected oversized payload >4096 bytes, got %d", len(oversized))
		}

		_ = conn.Write(ctx, websocket.MessageText, oversized)
		_, _, readErr := conn.Read(ctx)
		if websocket.CloseStatus(readErr) != websocket.StatusMessageTooBig {
			t.Fatalf("expected StatusMessageTooBig (1009), got err=%v status=%d", readErr, websocket.CloseStatus(readErr))
		}
		if count.Load() != 0 {
			t.Fatalf("oversized frame must not invoke OnSearchObserved, got %d", count.Load())
		}
		waitForHubConnected(t, hub, false)
	})
}
