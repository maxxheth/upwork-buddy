package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"upwork-buddy/internal/bridge"
	"upwork-buddy/internal/policy"
)

func TestM5Endpoints_NilDBGuards(t *testing.T) {
	s := &Server{apiToken: "tok"}
	router := s.RegisterRoutes()

	endpoints := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/policy", ""},
		{http.MethodPut, "/api/policy", `{"mode":"draft_only"}`},
		{http.MethodPost, "/api/policy/kill-switch", `{}`},
		{http.MethodGet, "/api/audit-logs", ""},
		{http.MethodGet, "/api/proposals", ""},
		{http.MethodPost, "/api/proposals", `{}`},
		{http.MethodGet, "/api/proposals/1", ""},
		{http.MethodPost, "/api/proposals/1/fill", `{}`},
		{http.MethodPost, "/api/proposals/1/approve", `{}`},
		{http.MethodPost, "/api/proposals/1/reject", `{}`},
		{http.MethodPost, "/api/proposals/1/submit", `{}`},
		{http.MethodPost, "/api/proposals/sync", `{}`},
		{http.MethodGet, "/api/messages/threads", ""},
		{http.MethodPost, "/api/messages/threads/sync", `{}`},
		{http.MethodPost, "/api/messages/poll", `{}`},
		{http.MethodGet, "/api/messages/unread", ""},
		{http.MethodGet, "/api/messages/drafts", ""},
		{http.MethodGet, "/api/messages/threads/room_1", ""},
		{http.MethodPost, "/api/messages/threads/room_1/sync", `{}`},
		{http.MethodPost, "/api/messages/threads/room_1/draft", `{}`},
		{http.MethodPost, "/api/messages/threads/room_1/send", `{}`},
		{http.MethodPost, "/api/messages/1/approve", `{}`},
		{http.MethodPost, "/api/messages/1/reject", `{}`},
	}

	for _, ep := range endpoints {
		req := httptest.NewRequest(ep.method, ep.path, strings.NewReader(ep.body))
		req.Header.Set("Authorization", "Bearer tok")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusServiceUnavailable {
			t.Errorf("%s %s status = %d, want 503", ep.method, ep.path, w.Result().StatusCode)
		}
	}
}

func TestPolicyEndpoints_KillSwitchAuditLogsAndSessionStatus(t *testing.T) {
	s := setupTestServer(t)
	var abortCount atomic.Int32
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "kill_switch.abort":
			abortCount.Add(1)
			return map[string]any{"aborted": true, "active_request_id": "req-1", "reason": "stop"}, nil
		case "jobs.detail":
			return nil, &bridge.WireRPCError{
				Code:    json.RawMessage(`-32001`),
				Message: "CAPTCHA challenge detected",
				Data:    json.RawMessage(`{"error_code":"HUMAN_ACTION_REQUIRED"}`),
			}
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	// 1. GET /api/policy defaults to confirm_in_ui
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/policy", nil)
	req.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /api/policy: %v", err)
	}
	var snap policy.Snapshot
	_ = json.NewDecoder(resp.Body).Decode(&snap)
	resp.Body.Close()
	if snap.Mode != policy.ModeConfirmInUI || snap.MaxProposalsPerDay != 5 {
		t.Fatalf("unexpected default policy: %+v", snap)
	}

	// 2. PUT /api/policy with 0 cap & quiet_hours, then clear quiet_hours with null
	putReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/policy", strings.NewReader(`{
		"mode":"auto_with_guardrails",
		"max_proposals_per_day":0,
		"min_job_score":75,
		"allowed_room_ids":["room_alpha"],
		"quiet_hours":"00:00-23:59"
	}`))
	putReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	if err != nil {
		t.Fatalf("PUT /api/policy: %v", err)
	}
	var putSnap policy.Snapshot
	_ = json.NewDecoder(putResp.Body).Decode(&putSnap)
	putResp.Body.Close()
	if putResp.StatusCode != http.StatusOK || putSnap.MaxProposalsPerDay != 0 || putSnap.QuietHours == nil || *putSnap.QuietHours != "00:00-23:59" {
		t.Fatalf("unexpected PUT /api/policy result (%d): %+v", putResp.StatusCode, putSnap)
	}

	// Invalid mode returns 400
	badReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/policy", strings.NewReader(`{"mode":"yolo"}`))
	badReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	badResp, _ := http.DefaultClient.Do(badReq)
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid policy mode, got %d", badResp.StatusCode)
	}

	// 3. Discovery HUMAN_ACTION_REQUIRED logs to action_audit_logs
	detReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/detail", strings.NewReader(`{"upwork_job_id":"~022115332344639171"}`))
	detReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	detResp, _ := http.DefaultClient.Do(detReq)
	detResp.Body.Close()
	if detResp.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 on challenge, got %d", detResp.StatusCode)
	}

	// 4. POST /api/policy/kill-switch drops mode to draft_only and calls kill_switch.abort RPC
	ksReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/policy/kill-switch", strings.NewReader(`{"reason":"test abort"}`))
	ksReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	ksResp, err := http.DefaultClient.Do(ksReq)
	if err != nil {
		t.Fatalf("POST /api/policy/kill-switch: %v", err)
	}
	var ksBody map[string]any
	_ = json.NewDecoder(ksResp.Body).Decode(&ksBody)
	ksResp.Body.Close()
	if ksResp.StatusCode != http.StatusOK || ksBody["mode"] != "draft_only" || ksBody["aborted"] != true {
		t.Fatalf("unexpected kill-switch response (%d): %+v", ksResp.StatusCode, ksBody)
	}
	if abortCount.Load() != 1 {
		t.Fatalf("expected kill_switch.abort RPC called once, got %d", abortCount.Load())
	}

	// 5. GET /api/session/status reflects live draft_only mode & db=up
	stReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/session/status", nil)
	stReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	stResp, _ := http.DefaultClient.Do(stReq)
	var sessOut sessionStatusResponse
	_ = json.NewDecoder(stResp.Body).Decode(&sessOut)
	stResp.Body.Close()
	if sessOut.PolicyMode != "draft_only" || !sessOut.KillSwitchActive || sessOut.DB != "up" {
		t.Fatalf("unexpected session status: %+v", sessOut)
	}

	// 6. GET /api/audit-logs contains kill_switch_activated and HUMAN_ACTION_REQUIRED
	alReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/audit-logs?limit=20", nil)
	alReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	alResp, _ := http.DefaultClient.Do(alReq)
	var alBody struct {
		Logs []auditLogEntry `json:"logs"`
	}
	_ = json.NewDecoder(alResp.Body).Decode(&alBody)
	alResp.Body.Close()
	var sawKS, sawChallenge bool
	for _, entry := range alBody.Logs {
		if entry.ActionType == "kill_switch_activated" {
			sawKS = true
		}
		if entry.Outcome == "HUMAN_ACTION_REQUIRED" {
			sawChallenge = true
		}
	}
	if !sawKS || !sawChallenge {
		t.Fatalf("expected kill_switch_activated and HUMAN_ACTION_REQUIRED in audit logs, got %+v", alBody.Logs)
	}
}
