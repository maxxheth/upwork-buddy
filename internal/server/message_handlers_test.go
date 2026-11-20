package server

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

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
)

func TestMessageHandlers_SyncLinkIdempotencyAndPolicySend(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var draftRPCCalled atomic.Int32
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "messages.list":
			return map[string]any{
				"rooms": []map[string]any{
					{
						"upwork_room_id":       "room_alpha",
						"client_name":          "Alice Client",
						"client_company":       "Acme",
						"job_title":            "Go MCP Server",
						"upwork_job_id":        "~022115332344639171",
						"unread_count":         2,
						"last_message_snippet": "Can you start Monday?",
						"last_message_at":      "2026-11-20T01:00:00Z",
					},
				},
			}, nil
		case "messages.get":
			var p struct {
				RoomID string `json:"room_id"`
			}
			_ = json.Unmarshal(params, &p)
			if p.RoomID == "missing_room" {
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "ROOM_NOT_FOUND: Conversation not found",
					Data:    json.RawMessage(`{"error_code":"ROOM_NOT_FOUND"}`),
				}
			}
			return map[string]any{
				"room_id":       "room_alpha",
				"client_name":   "Alice Client",
				"job_title":     "Go MCP Server",
				"upwork_job_id": "~022115332344639171",
				"unread_count":  2,
				"messages": []map[string]any{
					{
						"sender":      "Alice Client",
						"sender_role": "client",
						"body":        "Hello! Are you available?",
						"sent_at":     "2026-11-20T00:50:00Z",
						"attachments": []map[string]any{{"filename": "spec.pdf", "url": "https://www.upwork.com/att/1/spec.pdf"}},
					},
					{
						"sender":         "Alice Client",
						"sender_role":    "client",
						"body":           "Interview invite sent",
						"sent_at":        "2026-11-20T01:00:00Z",
						"interview_card": map[string]any{"title": "Technical Screen"},
					},
				},
			}, nil
		case "messages.draft":
			draftRPCCalled.Add(1)
			return map[string]any{"ok": true, "prefilled": true}, nil
		case "messages.send":
			time.Sleep(15 * time.Millisecond)
			return map[string]any{"sent": true}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	// Seed job + proposal so messages.list links job_id and proposal_id
	job := seedTestJobForProposals(t, s, "~022115332344639171", 88, 12, "")
	prop := dbservice.Proposal{
		JobID:       &job.ID,
		UpworkJobID: "~022115332344639171",
		CoverLetter: "Ready to help",
		Status:      "submitted",
	}
	_ = s.db.GetGorm().Create(&prop).Error

	// 1. Sync threads and verify job_id / proposal_id linking
	listSyncReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/threads/sync", strings.NewReader(`{}`))
	listSyncReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	listSyncResp, _ := http.DefaultClient.Do(listSyncReq)
	var listSyncOut struct {
		Threads     []threadEntry `json:"threads"`
		TotalUnread int           `json:"total_unread"`
	}
	_ = json.NewDecoder(listSyncResp.Body).Decode(&listSyncOut)
	listSyncResp.Body.Close()
	if listSyncResp.StatusCode != http.StatusOK || len(listSyncOut.Threads) != 1 || listSyncOut.TotalUnread != 2 {
		t.Fatalf("unexpected threads sync (%d): %+v", listSyncResp.StatusCode, listSyncOut)
	}
	if listSyncOut.Threads[0].JobID == nil || *listSyncOut.Threads[0].JobID != job.ID ||
		listSyncOut.Threads[0].ProposalID == nil || *listSyncOut.Threads[0].ProposalID != prop.ID {
		t.Fatalf("expected job_id=%d and proposal_id=%d linked, got %+v", job.ID, prop.ID, listSyncOut.Threads[0])
	}

	// 2. ROOM_NOT_FOUND returns 404
	nfReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/threads/missing_room/sync", strings.NewReader(`{}`))
	nfReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	nfResp, _ := http.DefaultClient.Do(nfReq)
	nfResp.Body.Close()
	if nfResp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for missing_room, got %d", nfResp.StatusCode)
	}

	// 3. Sync room_alpha twice consecutively -> idempotent, preserves attachments & card, chronological order
	for range 2 {
		syncReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/threads/room_alpha/sync", strings.NewReader(`{}`))
		syncReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		syncResp, _ := http.DefaultClient.Do(syncReq)
		var syncOut struct {
			Messages []messageEntry `json:"messages"`
		}
		_ = json.NewDecoder(syncResp.Body).Decode(&syncOut)
		syncResp.Body.Close()
		if syncResp.StatusCode != http.StatusOK || len(syncOut.Messages) != 2 {
			t.Fatalf("expected 2 idempotent messages, got (%d) %+v", syncResp.StatusCode, syncOut.Messages)
		}
		if !strings.Contains(string(syncOut.Messages[0].AttachmentsJSON), "spec.pdf") ||
			!strings.Contains(string(syncOut.Messages[1].CardJSON), "Technical Screen") {
			t.Fatalf("expected attachments & card_json preserved, got %+v", syncOut.Messages)
		}
	}

	// 4. Whitespace-only draft returns 400 without touching extension
	blankReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/draft", strings.NewReader(`{"room_id":"room_alpha","body":"   ","prefill_composer":true}`))
	blankReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	blankResp, _ := http.DefaultClient.Do(blankReq)
	blankResp.Body.Close()
	if blankResp.StatusCode != http.StatusBadRequest || draftRPCCalled.Load() != 0 {
		t.Fatalf("expected 400 and 0 extension calls for blank draft, got status=%d calls=%d", blankResp.StatusCode, draftRPCCalled.Load())
	}

	// 5. Draft reply, check GET /api/messages/drafts, verify /send without token fails confirm_in_ui, then /approve succeeds
	draftReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/draft", strings.NewReader(`{"room_id":"room_alpha","body":"Yes, Monday 10am works!","prefill_composer":true}`))
	draftReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	draftResp, _ := http.DefaultClient.Do(draftReq)
	var draftOut struct {
		Message       messageEntry `json:"message"`
		ApprovalToken string       `json:"approval_token"`
	}
	_ = json.NewDecoder(draftResp.Body).Decode(&draftOut)
	draftResp.Body.Close()
	if draftResp.StatusCode != http.StatusCreated || draftOut.ApprovalToken == "" {
		t.Fatalf("unexpected draft response (%d): %+v", draftResp.StatusCode, draftOut)
	}

	draftsGetReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/messages/drafts?status=pending_approval", nil)
	draftsGetReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	draftsGetResp, _ := http.DefaultClient.Do(draftsGetReq)
	var draftsList struct {
		Drafts []messageEntry `json:"drafts"`
	}
	_ = json.NewDecoder(draftsGetResp.Body).Decode(&draftsList)
	draftsGetResp.Body.Close()
	if len(draftsList.Drafts) != 1 || draftsList.Drafts[0].RoomID != "room_alpha" {
		t.Fatalf("expected 1 pending draft for room_alpha, got %+v", draftsList.Drafts)
	}

	unauthSendReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/send", strings.NewReader(`{"room_id":"room_alpha","body":"Bypass?"}`))
	unauthSendReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	unauthSendResp, _ := http.DefaultClient.Do(unauthSendReq)
	unauthSendResp.Body.Close()
	if unauthSendResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 APPROVAL_REQUIRED without token, got %d", unauthSendResp.StatusCode)
	}

	approveReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/messages/%d/approve", srv.URL, draftOut.Message.ID), strings.NewReader(`{}`))
	approveReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	approveResp, _ := http.DefaultClient.Do(approveReq)
	approveResp.Body.Close()
	if approveResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on approve message, got %d", approveResp.StatusCode)
	}

	// 6. Concurrency: auto_with_guardrails allowed_room_ids + max_messages_per_day=2 (1 already sent -> only 1 more allowed)
	putReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/policy", strings.NewReader(`{"mode":"auto_with_guardrails","max_messages_per_day":2,"allowed_room_ids":["room_alpha"]}`))
	putReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	putResp, _ := http.DefaultClient.Do(putReq)
	putResp.Body.Close()

	// room_beta blocked by allowlist
	betaReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/send", strings.NewReader(`{"room_id":"room_beta","body":"Hi"}`))
	betaReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	betaResp, _ := http.DefaultClient.Do(betaReq)
	betaResp.Body.Close()
	if betaResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for disallowed room_beta, got %d", betaResp.StatusCode)
	}

	var sentOK atomic.Int32
	var sentCap atomic.Int32
	var wg sync.WaitGroup
	for i := range 6 {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/send", strings.NewReader(fmt.Sprintf(`{"room_id":"room_alpha","body":"Concurrent %d"}`, idx)))
			req.Header.Set("Authorization", "Bearer "+s.apiToken)
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				switch resp.StatusCode {
				case http.StatusOK:
					sentOK.Add(1)
				case http.StatusTooManyRequests:
					sentCap.Add(1)
				}
				resp.Body.Close()
			}
		}(i)
	}
	wg.Wait()
	if sentOK.Load() != 1 || sentCap.Load() != 5 {
		t.Fatalf("expected 1 allowed and 5 cap-blocked concurrent message sends, got ok=%d cap=%d", sentOK.Load(), sentCap.Load())
	}
}

func TestMessageHandlers_SyncUpworkJobIDWithoutJobsRowDirectRoomsAndTimeoutCompensation(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var listRPCCalls atomic.Int32
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "messages.list":
			listRPCCalls.Add(1)
			return map[string]any{
				"rooms": []map[string]any{
					{
						"upwork_room_id":       "room_no_job_row",
						"client_name":          "Alice Vance",
						"job_title":            "SEO Audit",
						"upwork_job_id":        "~022115332344639171",
						"unread_count":         2,
						"last_message_snippet": "Hello!",
					},
				},
			}, nil
		case "messages.send":
			time.Sleep(120 * time.Millisecond)
			return map[string]any{"sent": true}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	// 1. Sync threads when jobs table is completely empty -> upwork_job_id must still persist & be returned by GET
	syncReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/threads/sync", strings.NewReader(`{}`))
	syncReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	syncResp, err := http.DefaultClient.Do(syncReq)
	if err != nil {
		t.Fatalf("sync threads: %v", err)
	}
	syncResp.Body.Close()
	if syncResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on sync threads, got %d", syncResp.StatusCode)
	}

	getReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/messages/threads", nil)
	getReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	getResp, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatalf("get threads: %v", err)
	}
	var threadsOut struct {
		Threads     []threadEntry `json:"threads"`
		TotalUnread int           `json:"total_unread"`
	}
	_ = json.NewDecoder(getResp.Body).Decode(&threadsOut)
	getResp.Body.Close()
	if len(threadsOut.Threads) != 1 || threadsOut.Threads[0].UpworkJobID != "~022115332344639171" {
		t.Fatalf("expected upwork_job_id ~022115332344639171 without jobs row, got %+v", threadsOut.Threads)
	}

	// 2. Direct {"rooms": [...]} body upserts without calling messages.list RPC again
	beforeRPC := listRPCCalls.Load()
	directBody := `{"rooms":[{"upwork_room_id":"room_no_job_row","client_name":"Alice Vance","unread_count":4,"last_message_snippet":"Updated unread"},{"upwork_room_id":"room_polled_2","client_name":"Bob Mercer","upwork_job_id":"022999888777666555","unread_count":1,"last_message_snippet":"New ping"}]}`
	directReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/threads/sync", strings.NewReader(directBody))
	directReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	directResp, err := http.DefaultClient.Do(directReq)
	if err != nil {
		t.Fatalf("direct sync: %v", err)
	}
	var directOut struct {
		Threads     []threadEntry `json:"threads"`
		TotalUnread int           `json:"total_unread"`
	}
	_ = json.NewDecoder(directResp.Body).Decode(&directOut)
	directResp.Body.Close()
	if directResp.StatusCode != http.StatusOK || listRPCCalls.Load() != beforeRPC {
		t.Fatalf("expected 200 without RPC call (before=%d after=%d), got status=%d", beforeRPC, listRPCCalls.Load(), directResp.StatusCode)
	}
	if directOut.TotalUnread != 5 || len(directOut.Threads) != 2 {
		t.Fatalf("expected 2 threads and total_unread=5, got %+v", directOut)
	}

	unreadReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/messages/unread", nil)
	unreadReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	unreadResp, _ := http.DefaultClient.Do(unreadReq)
	var unreadOut struct {
		Threads     []threadEntry `json:"threads"`
		TotalUnread int           `json:"total_unread"`
	}
	_ = json.NewDecoder(unreadResp.Body).Decode(&unreadOut)
	unreadResp.Body.Close()
	if unreadOut.TotalUnread != 5 {
		t.Fatalf("expected GET /api/messages/unread total_unread=5, got %d", unreadOut.TotalUnread)
	}

	// Verify existing upwork_job_id on room_no_job_row was preserved when omitted in direct update, and bare ID on room_polled_2 was normalized
	foundByRoom := map[string]threadEntry{}
	for _, th := range unreadOut.Threads {
		foundByRoom[th.UpworkRoomID] = th
	}
	if foundByRoom["room_no_job_row"].UpworkJobID != "~022115332344639171" {
		t.Fatalf("expected preserved upwork_job_id on room_no_job_row, got %q", foundByRoom["room_no_job_row"].UpworkJobID)
	}
	if foundByRoom["room_polled_2"].UpworkJobID != "~022999888777666555" {
		t.Fatalf("expected normalized upwork_job_id on room_polled_2, got %q", foundByRoom["room_polled_2"].UpworkJobID)
	}

	// 3. context.DeadlineExceeded during messages.send RPC marks draft failed and does NOT restore approval_token
	draftReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/draft", strings.NewReader(`{"room_id":"room_no_job_row","body":"Timeout test reply","prefill_composer":false}`))
	draftReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	draftResp, _ := http.DefaultClient.Do(draftReq)
	var draftOut struct {
		Message       messageEntry `json:"message"`
		ApprovalToken string       `json:"approval_token"`
	}
	_ = json.NewDecoder(draftResp.Body).Decode(&draftOut)
	draftResp.Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	timeoutReq := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/messages/%d/approve", draftOut.Message.ID), strings.NewReader(`{}`)).WithContext(ctx)
	timeoutReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	timeoutRec := httptest.NewRecorder()
	s.RegisterRoutes().ServeHTTP(timeoutRec, timeoutReq)
	if timeoutRec.Code == http.StatusOK {
		t.Fatalf("expected non-200 on context.DeadlineExceeded")
	}

	var afterTimeout dbservice.Message
	_ = s.db.GetGorm().First(&afterTimeout, draftOut.Message.ID).Error
	if afterTimeout.Status != "failed" || afterTimeout.ApprovalToken != "" {
		t.Fatalf("expected failed status and empty approval_token on context.DeadlineExceeded, got status=%q tok=%q", afterTimeout.Status, afterTimeout.ApprovalToken)
	}
}

func TestMessageCommit_RealTCPTimeoutAndUnconfirmedCompensation(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var sendMode atomic.Value
	sendMode.Store("slow")
	slowDone := make(chan struct{}, 2)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "messages.send" {
			switch sendMode.Load().(string) {
			case "slow":
				time.Sleep(300 * time.Millisecond)
				select {
				case slowDone <- struct{}{}:
				default:
				}
				return map[string]any{"sent": true}, nil
			case "unconfirmed":
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "MESSAGE_SEND_UNCONFIRMED: Message send was not confirmed within polling window",
					Data:    json.RawMessage(`{"error_code":"MESSAGE_SEND_UNCONFIRMED"}`),
				}
			}
		}
		return map[string]any{"ok": true}, nil
	})

	createDraft := func(roomID, body string) (uint, string) {
		req, _ := http.NewRequest(
			http.MethodPost,
			srv.URL+"/api/messages/draft",
			strings.NewReader(fmt.Sprintf(`{"room_id":%q,"body":%q,"prefill_composer":false}`, roomID, body)),
		)
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("create draft: %v", err)
		}
		var out struct {
			Message       messageEntry `json:"message"`
			ApprovalToken string       `json:"approval_token"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated || out.Message.ID == 0 || out.ApprovalToken == "" {
			t.Fatalf("unexpected draft response (%d): %+v", resp.StatusCode, out)
		}
		return out.Message.ID, out.ApprovalToken
	}

	// 1. Real TCP client timeout (80ms) on /api/messages/{id}/approve (token draft)
	draftID1, _ := createDraft("room_tcp_draft", "Draft TCP timeout reply")
	ctx1, cancel1 := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel1()
	req1, _ := http.NewRequestWithContext(ctx1, http.MethodPost, fmt.Sprintf("%s/api/messages/%d/approve", srv.URL, draftID1), strings.NewReader(`{}`))
	req1.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp1, err1 := http.DefaultClient.Do(req1)
	if resp1 != nil {
		resp1.Body.Close()
	}
	if err1 == nil || !errors.Is(err1, context.DeadlineExceeded) {
		t.Fatalf("expected client context.DeadlineExceeded on approve, got err=%v", err1)
	}

	var afterDraftTCP dbservice.Message
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := s.db.GetGorm().First(&afterDraftTCP, draftID1).Error; err == nil && afterDraftTCP.Status != "sending" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if afterDraftTCP.Status != "failed" || afterDraftTCP.ApprovalToken != "" {
		t.Fatalf("expected failed status and empty approval_token after TCP timeout on draft, got status=%q tok=%q", afterDraftTCP.Status, afterDraftTCP.ApprovalToken)
	}

	select {
	case <-slowDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first slow mock WS responder")
	}

	// 2. MESSAGE_SEND_UNCONFIRMED on /api/messages/{id}/approve (token draft)
	sendMode.Store("unconfirmed")
	draftID2, _ := createDraft("room_unc_draft", "Draft unconfirmed reply")
	req2, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/messages/%d/approve", srv.URL, draftID2), strings.NewReader(`{}`))
	req2.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("unconfirmed approve request: %v", err)
	}
	var out2 struct {
		ErrorCode string `json:"error_code"`
	}
	_ = json.NewDecoder(resp2.Body).Decode(&out2)
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadGateway || out2.ErrorCode != "MESSAGE_SEND_UNCONFIRMED" {
		t.Fatalf("expected 502 MESSAGE_SEND_UNCONFIRMED on draft approve, got status=%d code=%q", resp2.StatusCode, out2.ErrorCode)
	}
	var afterDraftUnc dbservice.Message
	_ = s.db.GetGorm().First(&afterDraftUnc, draftID2).Error
	if afterDraftUnc.Status != "failed" || afterDraftUnc.ApprovalToken != "" {
		t.Fatalf("expected failed status and empty approval_token on MESSAGE_SEND_UNCONFIRMED draft, got status=%q tok=%q", afterDraftUnc.Status, afterDraftUnc.ApprovalToken)
	}

	// Switch to auto_with_guardrails for synthetic stub tests
	putReq, _ := http.NewRequest(
		http.MethodPut,
		srv.URL+"/api/policy",
		strings.NewReader(`{"mode":"auto_with_guardrails","max_messages_per_day":10,"allowed_room_ids":["room_tcp_stub","room_unc_stub"]}`),
	)
	putReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatalf("update policy: %v", err)
	}
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 updating policy, got %d", putResp.StatusCode)
	}

	// 3. Real TCP client timeout (80ms) on /api/messages/send (auto_with_guardrails synthetic stub retained as failed)
	sendMode.Store("slow")
	ctx3, cancel3 := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel3()
	req3, _ := http.NewRequestWithContext(
		ctx3,
		http.MethodPost,
		srv.URL+"/api/messages/send",
		strings.NewReader(`{"room_id":"room_tcp_stub","body":"Auto stub TCP timeout body"}`),
	)
	req3.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp3, err3 := http.DefaultClient.Do(req3)
	if resp3 != nil {
		resp3.Body.Close()
	}
	if err3 == nil || !errors.Is(err3, context.DeadlineExceeded) {
		t.Fatalf("expected client context.DeadlineExceeded on auto send, got err=%v", err3)
	}

	var stubTCP dbservice.Message
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		var th dbservice.MessageThread
		if err := s.db.GetGorm().Where("upwork_room_id = ?", "room_tcp_stub").First(&th).Error; err == nil {
			if mErr := s.db.GetGorm().Where("thread_id = ?", th.ID).First(&stubTCP).Error; mErr == nil && stubTCP.Status != "sending" {
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	if stubTCP.ID == 0 || stubTCP.Status != "failed" || stubTCP.ApprovalToken != "" {
		t.Fatalf("expected synthetic stub retained with status=failed and empty token after TCP timeout, got %+v", stubTCP)
	}

	select {
	case <-slowDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for second slow mock WS responder")
	}

	// 4. MESSAGE_SEND_UNCONFIRMED on /api/messages/send (auto_with_guardrails synthetic stub retained as failed)
	sendMode.Store("unconfirmed")
	req4, _ := http.NewRequest(
		http.MethodPost,
		srv.URL+"/api/messages/send",
		strings.NewReader(`{"room_id":"room_unc_stub","body":"Auto stub unconfirmed body"}`),
	)
	req4.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp4, err := http.DefaultClient.Do(req4)
	if err != nil {
		t.Fatalf("unconfirmed auto send request: %v", err)
	}
	var out4 struct {
		ErrorCode string `json:"error_code"`
	}
	_ = json.NewDecoder(resp4.Body).Decode(&out4)
	resp4.Body.Close()
	if resp4.StatusCode != http.StatusBadGateway || out4.ErrorCode != "MESSAGE_SEND_UNCONFIRMED" {
		t.Fatalf("expected 502 MESSAGE_SEND_UNCONFIRMED on auto send, got status=%d code=%q", resp4.StatusCode, out4.ErrorCode)
	}

	var uncThread dbservice.MessageThread
	if err := s.db.GetGorm().Where("upwork_room_id = ?", "room_unc_stub").First(&uncThread).Error; err != nil {
		t.Fatalf("load room_unc_stub thread: %v", err)
	}
	var stubUnc dbservice.Message
	if err := s.db.GetGorm().Where("thread_id = ?", uncThread.ID).First(&stubUnc).Error; err != nil {
		t.Fatalf("expected synthetic stub to be retained in DB on MESSAGE_SEND_UNCONFIRMED, got err=%v", err)
	}
	if stubUnc.Status != "failed" || stubUnc.ApprovalToken != "" {
		t.Fatalf("expected retained synthetic stub status=failed and empty token, got status=%q tok=%q", stubUnc.Status, stubUnc.ApprovalToken)
	}
}

func TestMessageHandlers_SyncThreadPreservesUnreadCountWhenOmitted(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "messages.list":
			return map[string]any{
				"rooms": []map[string]any{
					{
						"upwork_room_id":       "room_777",
						"client_name":          "Bob Client",
						"job_title":            "Linked Job",
						"unread_count":         2,
						"last_message_snippet": "Check in",
					},
				},
			}, nil
		case "messages.get":
			return map[string]any{
				"room_id":        "room_777",
				"upwork_room_id": "room_777",
				"client_name":    "Bob Client",
				"job_title":      "Linked Job",
				"messages": []map[string]any{
					{
						"sender":      "Bob Client",
						"sender_role": "client",
						"body":        "Following up",
						"sent_at":     "2026-11-20T02:00:00Z",
					},
				},
			}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	if _, err := s.SyncThreads(context.Background(), nil); err != nil {
		t.Fatalf("SyncThreads: %v", err)
	}
	res, err := s.SyncThread(context.Background(), "room_777")
	if err != nil {
		t.Fatalf("SyncThread: %v", err)
	}
	if res.Thread.UnreadCount != 2 {
		t.Fatalf("expected unread_count=2 preserved when messages.get omits unread_count, got %d", res.Thread.UnreadCount)
	}
}

func TestCommitMessage_ConcurrentDraftApprovalEnforcesDailyCap(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "messages.send" {
			time.Sleep(150 * time.Millisecond)
			return map[string]any{"ok": true, "sent": true}, nil
		}
		return map[string]any{"ok": true}, nil
	})

	putReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/policy", strings.NewReader(`{"mode":"confirm_in_ui","max_messages_per_day":1}`))
	putReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatalf("PUT /api/policy: %v", err)
	}
	putResp.Body.Close()

	var draftIDs []uint
	for i := range 2 {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/draft", strings.NewReader(fmt.Sprintf(`{"room_id":"room_cap_draft","body":"Draft %d","prefill_composer":false}`, i)))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		resp, dErr := http.DefaultClient.Do(req)
		if dErr != nil {
			t.Fatalf("draft %d: %v", i, dErr)
		}
		var out struct {
			Message messageEntry `json:"message"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		draftIDs = append(draftIDs, out.Message.ID)
	}

	var ok200, blocked429 atomic.Int32
	var wg sync.WaitGroup
	start := make(chan struct{})
	for _, id := range draftIDs {
		wg.Add(1)
		go func(msgID uint) {
			defer wg.Done()
			<-start
			req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/messages/%d/approve", srv.URL, msgID), strings.NewReader(`{}`))
			req.Header.Set("Authorization", "Bearer "+s.apiToken)
			resp, aErr := http.DefaultClient.Do(req)
			if aErr == nil {
				switch resp.StatusCode {
				case http.StatusOK:
					ok200.Add(1)
				case http.StatusTooManyRequests:
					blocked429.Add(1)
				}
				resp.Body.Close()
			}
		}(id)
	}
	close(start)
	wg.Wait()

	if ok200.Load() != 1 || blocked429.Load() != 1 {
		t.Fatalf("expected 1 allowed and 1 DAILY_CAP_EXCEEDED across concurrent draft approvals, got ok=%d blocked=%d", ok200.Load(), blocked429.Load())
	}
}

func TestCommitMessage_CrossMessageAndCrossRoomTokenRejected(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		return map[string]any{"ok": true, "sent": true}, nil
	})

	createDraft := func(roomID, body string) (uint, string) {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/draft", strings.NewReader(fmt.Sprintf(`{"room_id":%q,"body":%q,"prefill_composer":false}`, roomID, body)))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("create draft: %v", err)
		}
		defer resp.Body.Close()
		var out struct {
			Message       messageEntry `json:"message"`
			ApprovalToken string       `json:"approval_token"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return out.Message.ID, out.ApprovalToken
	}

	idA, tokA := createDraft("room_a", "Reply A")
	idB, _ := createDraft("room_b", "Reply B")

	// 1. Token from room_a/idA cannot authorize room_b
	crossRoomReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/send", strings.NewReader(fmt.Sprintf(`{"room_id":"room_b","approval_token":%q}`, tokA)))
	crossRoomReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	crossRoomResp, _ := http.DefaultClient.Do(crossRoomReq)
	crossRoomResp.Body.Close()
	if crossRoomResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-room token substitution, got %d", crossRoomResp.StatusCode)
	}

	// 2. Token from idA cannot authorize message_id=idB
	crossMsgReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/messages/send", strings.NewReader(fmt.Sprintf(`{"message_id":%d,"approval_token":%q}`, idB, tokA)))
	crossMsgReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	crossMsgResp, _ := http.DefaultClient.Do(crossMsgReq)
	crossMsgResp.Body.Close()
	if crossMsgResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-message token substitution, got %d", crossMsgResp.StatusCode)
	}
	_ = idA
}

func TestMessageLifecycle_R2_TokenBodyTamperingAndRejectSentCapBypassBlocked(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var sentBodies []string
	var mu sync.Mutex
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "messages.send" {
			var p struct {
				Body string `json:"body"`
			}
			_ = json.Unmarshal(params, &p)
			mu.Lock()
			sentBodies = append(sentBodies, p.Body)
			mu.Unlock()
			return map[string]any{"sent": true}, nil
		}
		return map[string]any{"ok": true}, nil
	})

	doJSON := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	// 1. In confirm_in_ui mode, sending a different body with an existing draft's approval_token must fail 403
	_, dm := doJSON(http.MethodPost, "/api/messages/draft", `{"room_id":"room_alpha","body":"Safe reply","prefill_composer":false}`)
	msgID := int(dm["message"].(map[string]any)["id"].(float64))
	tok := dm["approval_token"].(string)

	stTamper, _ := doJSON(http.MethodPost, "/api/messages/send", fmt.Sprintf(`{"message_id":%d,"approval_token":%q,"body":"TAMPERED EVIL PAYLOAD"}`, msgID, tok))
	if stTamper != http.StatusForbidden {
		t.Fatalf("expected 403 when altering body with approval_token, got %d", stTamper)
	}
	if len(sentBodies) != 0 {
		t.Fatalf("expected 0 sent messages on tampered body, got %v", sentBodies)
	}

	// Token remains valid when sending with omitted or matching body
	stOK, _ := doJSON(http.MethodPost, "/api/messages/send", fmt.Sprintf(`{"message_id":%d,"approval_token":%q}`, msgID, tok))
	if stOK != http.StatusOK {
		t.Fatalf("expected 200 on matching/omitted body with valid approval_token, got %d", stOK)
	}

	// 2. Rejecting an already-sent message must return 409 Conflict and MUST NOT reset messages_today cap
	doJSON(http.MethodPut, "/api/policy", `{"mode":"auto_with_guardrails","max_messages_per_day":1,"allowed_room_ids":["room_alpha"]}`)
	stRejectSent, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/messages/%d/reject", msgID), `{}`)
	if stRejectSent != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when rejecting sent message, got %d", stRejectSent)
	}
	stBlocked, _ := doJSON(http.MethodPost, "/api/messages/send", `{"room_id":"room_alpha","body":"Should still hit cap"}`)
	if stBlocked != http.StatusTooManyRequests {
		t.Fatalf("expected 429 DAILY_CAP_EXCEEDED to hold after reject attempt on sent message, got %d", stBlocked)
	}
}

func TestMessageCommit_R4_RejectsInboundClientAndRejectedDraftMessageID(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var sendRPCCalls atomic.Int32
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "messages.get":
			return map[string]any{
				"room_id":     "room_r4",
				"client_name": "Alice Client",
				"job_title":   "Go Role",
				"messages": []map[string]any{
					{"sender": "Alice Client", "sender_role": "client", "body": "Hi there 1", "sent_at": "2026-11-20T01:00:00Z"},
					{"sender": "Alice Client", "sender_role": "client", "body": "Hi there 2", "sent_at": "2026-11-20T01:05:00Z"},
				},
			}, nil
		case "messages.send":
			sendRPCCalls.Add(1)
			return map[string]any{"sent": true}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	doJSON := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	stSync, syncOut := doJSON(http.MethodPost, "/api/messages/threads/room_r4/sync", `{}`)
	if stSync != http.StatusOK {
		t.Fatalf("expected 200 syncing thread, got %d (%v)", stSync, syncOut)
	}
	msgs := syncOut["messages"].([]any)
	clientMsgID := uint(msgs[0].(map[string]any)["id"].(float64))

	stPol, _ := doJSON(http.MethodPut, "/api/policy", `{"mode":"auto_with_guardrails","auto_send_messages":true,"max_messages_per_day":1,"allowed_room_ids":["room_r4"]}`)
	if stPol != http.StatusOK {
		t.Fatalf("expected 200 setting policy, got %d", stPol)
	}

	// 1. CommitMessage targeting inbound client message must return 409 with 0 RPCs and unchanged row / usage
	stClientSend, clientSendOut := doJSON(http.MethodPost, "/api/messages/send", fmt.Sprintf(`{"message_id":%d}`, clientMsgID))
	if stClientSend != http.StatusConflict || clientSendOut["error_code"] != "INVALID_MESSAGE_TARGET" {
		t.Fatalf("expected 409 INVALID_MESSAGE_TARGET for client message_id, got %d (%v)", stClientSend, clientSendOut)
	}
	if sendRPCCalls.Load() != 0 {
		t.Fatalf("expected 0 messages.send RPCs, got %d", sendRPCCalls.Load())
	}
	var clientMsg dbservice.Message
	_ = s.db.GetGorm().First(&clientMsg, clientMsgID).Error
	if clientMsg.Status != "received" || clientMsg.SenderRole != "client" {
		t.Fatalf("expected client message unchanged, got status=%q role=%q", clientMsg.Status, clientMsg.SenderRole)
	}
	_, polOut := doJSON(http.MethodGet, "/api/policy", "")
	if polOut["messages_today"] != float64(0) {
		t.Fatalf("expected messages_today=0, got %v", polOut["messages_today"])
	}

	// 2. Draft and reject a message, then verify /send under auto_with_guardrails returns 409 with 0 RPCs
	_, draftOut := doJSON(http.MethodPost, "/api/messages/draft", `{"room_id":"room_r4","body":"Rejected reply","prefill_composer":false}`)
	rejectedID := uint(draftOut["message"].(map[string]any)["id"].(float64))
	stRej, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/messages/%d/reject", rejectedID), `{}`)
	if stRej != http.StatusOK {
		t.Fatalf("expected 200 rejecting draft, got %d", stRej)
	}

	stRejSend, rejSendOut := doJSON(http.MethodPost, "/api/messages/send", fmt.Sprintf(`{"message_id":%d}`, rejectedID))
	if stRejSend != http.StatusConflict || rejSendOut["error_code"] != "MESSAGE_REDRAFT_REQUIRED" {
		t.Fatalf("expected 409 MESSAGE_REDRAFT_REQUIRED for rejected message_id, got %d (%v)", stRejSend, rejSendOut)
	}
	if sendRPCCalls.Load() != 0 {
		t.Fatalf("expected 0 messages.send RPCs after rejected draft attempt, got %d", sendRPCCalls.Load())
	}
}

func TestMessageCommit_R5_CrossRoomMessageIDRejected_AndTokenlessDoesNotHijackPendingDraft(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var sentMu sync.Mutex
	var sentPayloads []map[string]string
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "messages.send" {
			var p struct {
				RoomID string `json:"room_id"`
				Body   string `json:"body"`
			}
			_ = json.Unmarshal(params, &p)
			sentMu.Lock()
			sentPayloads = append(sentPayloads, map[string]string{"room_id": p.RoomID, "body": p.Body})
			sentMu.Unlock()
			return map[string]any{"sent": true}, nil
		}
		return map[string]any{"ok": true}, nil
	})

	doJSON := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		return resp.StatusCode, out
	}

	_, draftOut := doJSON(http.MethodPost, "/api/messages/draft", `{"room_id":"room_A","body":"Careful human-queued draft in Room A","prefill_composer":false}`)
	msgID := uint(draftOut["message"].(map[string]any)["id"].(float64))
	tokA := draftOut["approval_token"].(string)

	// 1. Cross-room message_id on /threads/room_B/send and /messages/send must return 409 INVALID_MESSAGE_TARGET with 0 RPCs
	stCrossRoute, crossRouteOut := doJSON(http.MethodPost, "/api/messages/threads/room_B/send", fmt.Sprintf(`{"message_id":%d,"approval_token":%q}`, msgID, tokA))
	if stCrossRoute != http.StatusConflict || crossRouteOut["error_code"] != "INVALID_MESSAGE_TARGET" {
		t.Fatalf("expected 409 INVALID_MESSAGE_TARGET on cross-room /threads/room_B/send, got %d (%v)", stCrossRoute, crossRouteOut)
	}
	stCrossBody, crossBodyOut := doJSON(http.MethodPost, "/api/messages/send", fmt.Sprintf(`{"room_id":"room_B","message_id":%d,"approval_token":%q}`, msgID, tokA))
	if stCrossBody != http.StatusConflict || crossBodyOut["error_code"] != "INVALID_MESSAGE_TARGET" {
		t.Fatalf("expected 409 INVALID_MESSAGE_TARGET on cross-room /messages/send, got %d (%v)", stCrossBody, crossBodyOut)
	}
	stCrossRoomFields, crossFieldsOut := doJSON(http.MethodPost, "/api/messages/threads/room_B/send", `{"room_id":"room_A","body":"Mismatch"}`)
	if stCrossRoomFields != http.StatusConflict || crossFieldsOut["error_code"] != "INVALID_MESSAGE_TARGET" {
		t.Fatalf("expected 409 INVALID_MESSAGE_TARGET on mismatched URL vs body room_id, got %d (%v)", stCrossRoomFields, crossFieldsOut)
	}
	sentMu.Lock()
	if len(sentPayloads) != 0 {
		t.Fatalf("expected 0 messages.send RPCs on cross-room mismatch, got %v", sentPayloads)
	}
	sentMu.Unlock()

	// 2. Tokenless send without message_id under auto_with_guardrails must NOT overwrite existing pending_approval draft in room_A
	stPol, _ := doJSON(http.MethodPut, "/api/policy", `{"mode":"auto_with_guardrails","auto_send_messages":true,"max_messages_per_day":5,"allowed_room_ids":["room_A"]}`)
	if stPol != http.StatusOK {
		t.Fatalf("expected 200 setting policy, got %d", stPol)
	}

	stAutoSend, autoSendOut := doJSON(http.MethodPost, "/api/messages/send", `{"room_id":"room_A","body":"Autonomous new outbound message"}`)
	if stAutoSend != http.StatusOK {
		t.Fatalf("expected 200 on autonomous send, got %d (%v)", stAutoSend, autoSendOut)
	}
	sentID := uint(autoSendOut["message"].(map[string]any)["id"].(float64))
	if sentID == msgID {
		t.Fatalf("expected tokenless autonomous send to create a new message record, not reuse pending_approval draft #%d", msgID)
	}

	var preservedDraft dbservice.Message
	if err := s.db.GetGorm().First(&preservedDraft, msgID).Error; err != nil {
		t.Fatalf("load preserved draft: %v", err)
	}
	if preservedDraft.Status != "pending_approval" || preservedDraft.Body != "Careful human-queued draft in Room A" || preservedDraft.ApprovalToken != tokA {
		t.Fatalf("expected pending_approval draft untouched, got status=%q body=%q tok=%q", preservedDraft.Status, preservedDraft.Body, preservedDraft.ApprovalToken)
	}
}
