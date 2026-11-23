package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

func TestNotifier_ConfigSecretHygieneAndValidation(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()

	// Invalid webhook URL rejected
	badURL := "ftp://example.com/hook"
	if _, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		WebhookURL: &badURL,
	}); err == nil {
		t.Fatalf("expected invalid webhook_url error for ftp scheme")
	}

	// Set webhook & telegram secrets
	whEnabled := true
	whURL := "https://example.com/webhook"
	whSecret := "super-secret-hmac-key"
	tgEnabled := true
	tgToken := "123456:ABC-DEF"
	tgChat := "99887766"

	view, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		WebhookEnabled:   &whEnabled,
		WebhookURL:       &whURL,
		WebhookSecret:    &whSecret,
		TelegramEnabled:  &tgEnabled,
		TelegramBotToken: &tgToken,
		TelegramChatID:   &tgChat,
		NotifyEvents:     []string{EventHotJobAlert, EventPendingApproval},
	})
	if err != nil {
		t.Fatalf("UpdateNotificationConfig failed: %v", err)
	}
	if !view.HasWebhookSecret || !view.HasTelegramBotToken || view.WebhookURL != whURL || view.TelegramChatID != tgChat {
		t.Fatalf("unexpected view: %+v", view)
	}

	// Verify JSON serialization never leaks raw secrets
	rawJSON, err := json.Marshal(view)
	if err != nil {
		t.Fatalf("marshal view failed: %v", err)
	}
	sJSON := string(rawJSON)
	if containsAny(sJSON, whSecret, tgToken) {
		t.Fatalf("raw secret leaked in JSON view: %s", sJSON)
	}

	// Partial update omitting/blanking secrets preserves existing secrets
	blank := "   "
	newChat := "11223344"
	view2, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		WebhookSecret:    &blank,
		TelegramBotToken: &blank,
		TelegramChatID:   &newChat,
	})
	if err != nil {
		t.Fatalf("partial UpdateNotificationConfig failed: %v", err)
	}
	if !view2.HasWebhookSecret || !view2.HasTelegramBotToken || view2.TelegramChatID != newChat {
		t.Fatalf("expected secrets preserved on blank update, got %+v", view2)
	}

	// Explicit clear removes secrets
	view3, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		ClearWebhookSecret:    true,
		ClearTelegramBotToken: true,
	})
	if err != nil {
		t.Fatalf("clear UpdateNotificationConfig failed: %v", err)
	}
	if view3.HasWebhookSecret || view3.HasTelegramBotToken {
		t.Fatalf("expected secrets cleared, got %+v", view3)
	}
}

func TestNotifier_WebhookHMACRetryAndTelegram(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()

	var webhookAttempts atomic.Int32
	var receivedSig string
	var receivedBody []byte
	secret := "test-hmac-secret"

	whServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := webhookAttempts.Add(1)
		body, _ := io.ReadAll(r.Body)
		if attempt == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte("transient error"))
			return
		}
		receivedSig = r.Header.Get("X-Upwork-Buddy-Signature")
		receivedBody = body
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer whServer.Close()

	var tgPath string
	var tgBody map[string]any
	tgServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tgPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&tgBody)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer tgServer.Close()

	whEnabled := true
	tgEnabled := true
	tgToken := "bot-token-xyz"
	tgChat := "chat-42"
	whURL := whServer.URL
	if _, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		WebhookEnabled:   &whEnabled,
		WebhookURL:       &whURL,
		WebhookSecret:    &secret,
		TelegramEnabled:  &tgEnabled,
		TelegramBotToken: &tgToken,
		TelegramChatID:   &tgChat,
	}); err != nil {
		t.Fatalf("UpdateNotificationConfig failed: %v", err)
	}

	n := NewNotifier(srv)
	n.telegramBaseURL = tgServer.URL

	score := 92
	ok, results := n.SendSync(ctx, WatcherAlert{
		Event:    EventHotJobAlert,
		Title:    "Hot Go Job",
		Message:  "92/100 match",
		RuleID:   1,
		RuleName: "Go Watch",
		Score:    &score,
	}, "")
	if !ok {
		t.Fatalf("expected SendSync ok=true, got results=%+v", results)
	}
	if webhookAttempts.Load() != 2 {
		t.Fatalf("expected 2 webhook attempts (1 retry), got %d", webhookAttempts.Load())
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(receivedBody)
	wantSig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if receivedSig != wantSig {
		t.Fatalf("signature mismatch: got %q want %q", receivedSig, wantSig)
	}

	if tgPath != "/bot"+tgToken+"/sendMessage" {
		t.Fatalf("unexpected telegram path: %q", tgPath)
	}
	if tgBody["chat_id"] != tgChat {
		t.Fatalf("unexpected telegram chat_id: %v", tgBody["chat_id"])
	}

	// Test async queue drain on Close
	n.NotifyAsync(WatcherAlert{
		Event:   EventHotJobAlert,
		Title:   "Async Alert",
		Message: "Drained on close",
	})
	if err := n.Close(); err != nil {
		t.Fatalf("Notifier.Close failed: %v", err)
	}
	if webhookAttempts.Load() < 3 {
		t.Fatalf("expected async alert to be delivered before Close returned, attempts=%d", webhookAttempts.Load())
	}
}

func TestNotifier_TelegramErrorRedactionAndConcurrentClose(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()

	// Closed server triggers *url.Error containing the full request URL
	closedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	closedURL := closedSrv.URL
	closedSrv.Close()

	tgEnabled := true
	tgToken := "987654:SECRET-BOT-TOKEN"
	tgChat := "555666"
	if _, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		TelegramEnabled:  &tgEnabled,
		TelegramBotToken: &tgToken,
		TelegramChatID:   &tgChat,
	}); err != nil {
		t.Fatalf("UpdateNotificationConfig failed: %v", err)
	}

	n := NewNotifier(srv)
	n.telegramBaseURL = closedURL

	ok, results := n.SendSync(ctx, WatcherAlert{
		Event:   "test",
		Title:   "Test Redaction",
		Message: "Should redact token",
	}, "telegram")
	if ok {
		t.Fatalf("expected SendSync to fail against closed server")
	}
	errMsg := results["telegram"].Error
	if errMsg == "" || containsString(errMsg, tgToken) {
		t.Fatalf("expected non-empty error without raw bot token, got %q", errMsg)
	}

	// Concurrent NotifyAsync + Close under -race
	n2 := NewNotifier(srv)
	n2.telegramBaseURL = closedURL
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				n2.NotifyAsync(WatcherAlert{Event: EventHotJobAlert, Title: "race"})
			}
		}()
	}
	_ = n2.Close()
	wg.Wait()
}

func TestNotifier_DetectTelegramChatsAndHandler(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "secret-token"
	ctx := context.Background()

	tgToken := "777888:DETECT-SECRET-TOKEN"
	webhookConflict := false
	tgServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bot" + tgToken + "/getUpdates":
			if webhookConflict {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"ok":false,"description":"Conflict: can't use getUpdates method while webhook is active"}`))
				return
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{
				"ok": true,
				"result": [
					{
						"update_id": 100,
						"message": {
							"date": 1700000100,
							"text": "/start",
							"chat": {"id": 555001, "type": "private", "first_name": "Maxx", "username": "maxxdev"}
						}
					},
					{
						"update_id": 101,
						"message": {
							"date": 1700000200,
							"text": "hello bot",
							"chat": {"id": 555001, "type": "private", "first_name": "Maxx", "username": "maxxdev"}
						}
					},
					{
						"update_id": 102,
						"my_chat_member": {
							"date": 1700000300,
							"chat": {"id": -100999888, "type": "supergroup", "title": "Upwork Alerts"}
						}
					}
				]
			}`))
		case "/bot" + tgToken + "/getMe":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"result":{"id":777888,"is_bot":true,"username":"UpworkBuddyWatchBot"}}`))
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"ok":false,"description":"Unauthorized"}`))
		}
	}))
	defer tgServer.Close()

	mgr := srv.getWatcherManager()
	mgr.notifier.telegramBaseURL = tgServer.URL

	// Save token without chat_id
	tgEnabled := true
	if _, err := srv.UpdateNotificationConfig(ctx, UpdateNotificationConfigInput{
		TelegramEnabled:  &tgEnabled,
		TelegramBotToken: &tgToken,
	}); err != nil {
		t.Fatalf("UpdateNotificationConfig failed: %v", err)
	}

	// Detect deduplicated chats sorted newest-first (also accepts accidental leading "bot" prefix)
	res, err := mgr.notifier.DetectTelegramChats(ctx, "bot"+tgToken)
	if err != nil {
		t.Fatalf("DetectTelegramChats failed: %v", err)
	}
	if res.BotUsername != "UpworkBuddyWatchBot" {
		t.Fatalf("expected bot username UpworkBuddyWatchBot, got %q", res.BotUsername)
	}
	if len(res.Chats) != 2 {
		t.Fatalf("expected 2 unique chats, got %+v", res.Chats)
	}
	if res.Chats[0].ChatID != "-100999888" || res.Chats[1].ChatID != "555001" || res.Chats[1].LastText != "hello bot" {
		t.Fatalf("unexpected chat order/fields: %+v", res.Chats)
	}

	// Malformed token (no <digits>:<secret>) rejected early without leaking token
	badToken := "not-a-bot-token!"
	_, err = mgr.notifier.DetectTelegramChats(ctx, badToken)
	if err == nil || containsString(err.Error(), badToken) || !containsString(err.Error(), "BotFather") {
		t.Fatalf("expected clear BotFather format error, got %v", err)
	}

	// Webhook conflict error is surfaced cleanly without leaking token
	webhookConflict = true
	_, err = mgr.notifier.DetectTelegramChats(ctx, "")
	if err == nil || containsString(err.Error(), tgToken) || !containsString(err.Error(), "webhook") {
		t.Fatalf("expected sanitized webhook conflict error, got %v", err)
	}
	webhookConflict = false

	// Single-chat auto_save via REST endpoint persists telegram_chat_id
	singleSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bot" + tgToken + "/getUpdates":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"result":[{"update_id":1,"message":{"date":1700000500,"text":"/start","chat":{"id":424242,"type":"private","first_name":"Maxx"}}}]}`))
		case "/bot" + tgToken + "/getMe":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true,"result":{"username":"SoloBot"}}`))
		}
	}))
	defer singleSrv.Close()
	mgr.notifier.telegramBaseURL = singleSrv.URL

	handler := srv.RegisterRoutes()
	req := httptest.NewRequest(http.MethodPost, "/api/notifications/telegram/detect-chat", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	// Send JSON body with auto_save=true
	req = httptest.NewRequest(http.MethodPost, "/api/notifications/telegram/detect-chat", io.NopCloser(stringsReader(`{"auto_save":true}`)))
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 from detect-chat, got %d: %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Saved          bool                    `json:"saved"`
		SelectedChatID string                  `json:"selected_chat_id"`
		Chats          []TelegramChatCandidate `json:"chats"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal detect-chat failed: %v", err)
	}
	if !body.Saved || body.SelectedChatID != "424242" || len(body.Chats) != 1 {
		t.Fatalf("expected saved chat 424242, got %+v", body)
	}
	cfgAfter, err := srv.GetNotificationConfig(ctx)
	if err != nil || cfgAfter.TelegramChatID != "424242" {
		t.Fatalf("expected persisted telegram_chat_id=424242, got %+v err=%v", cfgAfter, err)
	}
}

func stringsReader(s string) io.Reader {
	return &stringReader{s: s}
}

type stringReader struct {
	s string
	i int
}

func (r *stringReader) Read(p []byte) (int, error) {
	if r.i >= len(r.s) {
		return 0, io.EOF
	}
	n := copy(p, r.s[r.i:])
	r.i += n
	return n, nil
}

func containsAny(s string, needles ...string) bool {
	for _, needle := range needles {
		if needle != "" && len(needle) > 0 && containsString(s, needle) {
			return true
		}
	}
	return false
}

func containsString(s, sub string) bool {
	return len(sub) > 0 && len(s) >= len(sub) && (func() bool {
		for i := 0; i <= len(s)-len(sub); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
