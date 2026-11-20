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

func seedTestJobForProposals(t *testing.T, s *Server, upworkID string, score int, connects int, screeningJSON string) dbservice.Job {
	t.Helper()
	var sq dbservice.JSONB
	if screeningJSON != "" {
		sq = dbservice.JSONB(screeningJSON)
	}
	job := dbservice.Job{
		UpworkJobID:        &upworkID,
		Title:              "Senior Go Developer " + upworkID,
		URL:                "https://www.upwork.com/jobs/" + upworkID + "/",
		CanonicalURL:       "https://www.upwork.com/jobs/" + upworkID + "/",
		Status:             "ready",
		Score:              &score,
		ConnectsRequired:   &connects,
		ScreeningQuestions: sq,
	}
	if err := s.db.GetGorm().Create(&job).Error; err != nil {
		t.Fatalf("seed job: %v", err)
	}
	return job
}

func TestProposalLifecycle_FillApproveSubmitSyncAndGuards(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var fillMode atomic.Value
	fillMode.Store("ok")
	var submitMode atomic.Value
	submitMode.Store("ok")

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "proposal.fill":
			mode := fillMode.Load().(string)
			if mode == "verify_fail" {
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "FILL_VERIFICATION_FAILED: bid reset to 0",
					Data:    json.RawMessage(`{"error_code":"FILL_VERIFICATION_FAILED"}`),
				}
			}
			if mode == "already_applied" {
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "ALREADY_APPLIED",
					Data:    json.RawMessage(`{"error_code":"ALREADY_APPLIED"}`),
				}
			}
			if mode == "unanswered" {
				return map[string]any{
					"ok":                            true,
					"cover_letter_length":           45,
					"bid_type":                      "fixed",
					"bid_amount":                    1400,
					"connects_cost":                 12,
					"boost_connects":                4,
					"total_connects":                16,
					"available_connects":            50,
					"unanswered_required_questions": 1,
					"screening_answers":             []any{},
				}, nil
			}
			return map[string]any{
				"ok":                            true,
				"cover_letter_length":           45,
				"bid_type":                      "fixed",
				"bid_amount":                    1400,
				"estimated_fee":                 140,
				"estimated_net":                 1260,
				"connects_cost":                 12,
				"boost_connects":                4,
				"total_connects":                16,
				"available_connects":            50,
				"unanswered_required_questions": 0,
				"screening_answers":             []any{},
			}, nil
		case "proposal.submit":
			if submitMode.Load().(string) == "challenge" {
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32001`),
					Message: "2FA required",
					Data:    json.RawMessage(`{"error_code":"HUMAN_ACTION_REQUIRED"}`),
				}
			}
			return map[string]any{
				"submitted":           true,
				"upwork_proposal_url": "https://www.upwork.com/nx/proposals/990001",
			}, nil
		case "proposals.sync":
			return map[string]any{
				"proposals": []map[string]any{
					{
						"upwork_job_id":       "~022111111111111111",
						"upwork_proposal_url": "https://www.upwork.com/nx/proposals/990001",
						"job_title":           "Senior Go Developer ~022111111111111111",
						"status":              "Viewed by client",
						"bid_amount":          1400,
					},
					{
						"upwork_job_id":       "~022999999999999999",
						"upwork_proposal_url": "https://www.upwork.com/nx/proposals/990002",
						"job_title":           "External Offer Role",
						"status":              "Offer received",
						"bid_amount":          2500,
					},
				},
			}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	job := seedTestJobForProposals(t, s, "~022111111111111111", 85, 12, `[{"index":0,"prompt":"Go years?","required":true}]`)

	// 1. Validation: blank cover_letter fails 400
	badReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals", strings.NewReader(`{"cover_letter":"   "}`))
	badReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	badResp, _ := http.DefaultClient.Do(badReq)
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for blank cover_letter, got %d", badResp.StatusCode)
	}

	// 2. Create draft with missing screening answer -> fill succeeds with unanswered_required_questions=1, approve/submit blocks 422
	createReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals", strings.NewReader(fmt.Sprintf(`{
		"job_id": %d,
		"cover_letter": "I can build your Go backend cleanly.",
		"bid_type": "fixed",
		"bid_amount": 1400,
		"boost_connects": 4
	}`, job.ID)))
	createReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	createResp, err := http.DefaultClient.Do(createReq)
	if err != nil {
		t.Fatalf("POST /api/proposals: %v", err)
	}
	var createOut struct {
		Proposal proposalEntry `json:"proposal"`
	}
	_ = json.NewDecoder(createResp.Body).Decode(&createOut)
	createResp.Body.Close()
	if createResp.StatusCode != http.StatusCreated || createOut.Proposal.ID == 0 {
		t.Fatalf("unexpected create proposal (%d): %+v", createResp.StatusCode, createOut)
	}
	propID := createOut.Proposal.ID

	// 3. Failed fill leaves status as draft and issues no approval token
	fillMode.Store("verify_fail")
	failFillReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/fill", srv.URL, propID), strings.NewReader(`{}`))
	failFillReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	failFillResp, _ := http.DefaultClient.Do(failFillReq)
	failFillResp.Body.Close()
	if failFillResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on FILL_VERIFICATION_FAILED, got %d", failFillResp.StatusCode)
	}
	var afterFail dbservice.Proposal
	_ = s.db.GetGorm().First(&afterFail, propID).Error
	if afterFail.Status != "draft" || afterFail.ApprovalToken != "" {
		t.Fatalf("failed fill must keep draft status without token, got status=%q tok=%q", afterFail.Status, afterFail.ApprovalToken)
	}

	// 4. Fill with unanswered screening question -> pending_approval, but /approve blocks 422
	fillMode.Store("unanswered")
	fillUnansReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/fill", srv.URL, propID), strings.NewReader(`{}`))
	fillUnansReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	fillUnansResp, _ := http.DefaultClient.Do(fillUnansReq)
	fillUnansResp.Body.Close()
	if fillUnansResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on fill with unanswered question, got %d", fillUnansResp.StatusCode)
	}
	appBlockReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/approve", srv.URL, propID), strings.NewReader(`{}`))
	appBlockReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	appBlockResp, _ := http.DefaultClient.Do(appBlockReq)
	appBlockResp.Body.Close()
	if appBlockResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on approve with unanswered required screening question, got %d", appBlockResp.StatusCode)
	}

	// 5. Update proposal with screening answer, re-fill cleanly, test token aging expiry (T2-F5-03)
	updReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals", strings.NewReader(fmt.Sprintf(`{
		"id": %d,
		"job_id": %d,
		"cover_letter": "I can build your Go backend cleanly.",
		"bid_type": "fixed",
		"bid_amount": 1400,
		"boost_connects": 4,
		"screening_answers": [{"index":0,"prompt":"Go years?","answer":"8 years","required":true}]
	}`, propID, job.ID)))
	updReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	updResp, _ := http.DefaultClient.Do(updReq)
	updResp.Body.Close()

	fillMode.Store("ok")
	fillOKReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/fill", srv.URL, propID), strings.NewReader(`{}`))
	fillOKReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	fillOKResp, _ := http.DefaultClient.Do(fillOKReq)
	var fillOKOut struct {
		ApprovalToken string `json:"approval_token"`
	}
	_ = json.NewDecoder(fillOKResp.Body).Decode(&fillOKOut)
	fillOKResp.Body.Close()
	if fillOKOut.ApprovalToken == "" {
		t.Fatal("expected non-empty approval_token")
	}

	// Age token in SQL like T2-F5-03
	if err := s.db.GetGorm().Exec(`UPDATE proposals SET updated_at = NOW() - INTERVAL '2 days', approved_at = NOW() - INTERVAL '2 days' WHERE id = ?`, propID).Error; err != nil {
		t.Fatalf("age proposal: %v", err)
	}
	expReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, propID), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, fillOKOut.ApprovalToken)))
	expReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	expResp, _ := http.DefaultClient.Do(expReq)
	expResp.Body.Close()
	if expResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for expired token, got %d", expResp.StatusCode)
	}

	// Re-fill fresh token, test HUMAN_ACTION_REQUIRED compensation preserves pending_approval + token
	fillOKReq2, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/fill", srv.URL, propID), strings.NewReader(`{}`))
	fillOKReq2.Header.Set("Authorization", "Bearer "+s.apiToken)
	fillOKResp2, _ := http.DefaultClient.Do(fillOKReq2)
	var fillOKOut2 struct {
		ApprovalToken string `json:"approval_token"`
	}
	_ = json.NewDecoder(fillOKResp2.Body).Decode(&fillOKOut2)
	fillOKResp2.Body.Close()

	submitMode.Store("challenge")
	chalReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, propID), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, fillOKOut2.ApprovalToken)))
	chalReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	chalResp, _ := http.DefaultClient.Do(chalReq)
	chalResp.Body.Close()
	if chalResp.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 on challenge submit, got %d", chalResp.StatusCode)
	}
	var afterChal dbservice.Proposal
	_ = s.db.GetGorm().First(&afterChal, propID).Error
	if afterChal.Status != "pending_approval" || afterChal.ApprovalToken != fillOKOut2.ApprovalToken {
		t.Fatalf("expected compensation to restore pending_approval + token, got status=%q", afterChal.Status)
	}

	// 6. Submit succeeds and consumes token (replay fails)
	submitMode.Store("ok")
	subReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, propID), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, fillOKOut2.ApprovalToken)))
	subReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	subResp, _ := http.DefaultClient.Do(subReq)
	subResp.Body.Close()
	if subResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on valid submit, got %d", subResp.StatusCode)
	}

	replayReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, propID), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, fillOKOut2.ApprovalToken)))
	replayReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	replayResp, _ := http.DefaultClient.Do(replayReq)
	replayResp.Body.Close()
	if replayResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 on replay after submit, got %d", replayResp.StatusCode)
	}

	// 7. POST /api/proposals/sync updates existing (~022111...) to viewed and inserts unseen (~022999...) as offer
	syncReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals/sync", strings.NewReader(`{}`))
	syncReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	syncResp, _ := http.DefaultClient.Do(syncReq)
	var syncOut struct {
		Proposals []proposalEntry `json:"proposals"`
	}
	_ = json.NewDecoder(syncResp.Body).Decode(&syncOut)
	syncResp.Body.Close()
	if syncResp.StatusCode != http.StatusOK || len(syncOut.Proposals) != 2 {
		t.Fatalf("expected 2 synced proposals, got (%d) %+v", syncResp.StatusCode, syncOut)
	}
	if syncOut.Proposals[0].Status != "viewed" || syncOut.Proposals[1].Status != "offer" {
		t.Fatalf("unexpected normalized synced statuses: %+v", syncOut.Proposals)
	}
}

func TestProposalSubmit_ConcurrencyTokenReplayAndDailyCap(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "proposal.submit" {
			time.Sleep(15 * time.Millisecond)
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/777"}, nil
		}
		return map[string]any{"ok": true}, nil
	})

	// A. 8-goroutine replay of a single approval_token
	jobA := seedTestJobForProposals(t, s, "~022333333333333331", 90, 10, "")
	tok := "single-use-race-token-1234567890"
	propA := dbservice.Proposal{
		JobID:         &jobA.ID,
		UpworkJobID:   "~022333333333333331",
		CoverLetter:   "Hello",
		BidType:       "fixed",
		Status:        "pending_approval",
		ApprovalToken: tok,
	}
	if err := s.db.GetGorm().Create(&propA).Error; err != nil {
		t.Fatalf("create propA: %v", err)
	}

	var okCount atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, propA.ID), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tok)))
			req.Header.Set("Authorization", "Bearer "+s.apiToken)
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				if resp.StatusCode == http.StatusOK {
					okCount.Add(1)
				}
				resp.Body.Close()
			}
		}()
	}
	wg.Wait()
	if okCount.Load() != 1 {
		t.Fatalf("expected exactly 1 success for concurrent token replay, got %d", okCount.Load())
	}

	// B. 8-goroutine concurrent auto_with_guardrails submits against max_proposals_per_day=2 (1 already submitted above -> only 1 more allowed)
	putReq, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/policy", strings.NewReader(`{"mode":"auto_with_guardrails","max_proposals_per_day":2,"max_connects_per_day":100}`))
	putReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	putResp, _ := http.DefaultClient.Do(putReq)
	putResp.Body.Close()

	var propIDs []uint
	for i := range 8 {
		uid := fmt.Sprintf("~02244444444444444%d", i)
		j := seedTestJobForProposals(t, s, uid, 90, 5, "")
		p := dbservice.Proposal{
			JobID:       &j.ID,
			UpworkJobID: uid,
			CoverLetter: "Hello",
			BidType:     "fixed",
			Status:      "draft",
		}
		if err := s.db.GetGorm().Create(&p).Error; err != nil {
			t.Fatalf("create p: %v", err)
		}
		propIDs = append(propIDs, p.ID)
	}

	var capOK atomic.Int32
	var capBlocked atomic.Int32
	for _, pid := range propIDs {
		wg.Add(1)
		go func(id uint) {
			defer wg.Done()
			req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, id), strings.NewReader(`{}`))
			req.Header.Set("Authorization", "Bearer "+s.apiToken)
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				switch resp.StatusCode {
				case http.StatusOK:
					capOK.Add(1)
				case http.StatusTooManyRequests:
					capBlocked.Add(1)
				}
				resp.Body.Close()
			}
		}(pid)
	}
	wg.Wait()
	if capOK.Load() != 1 || capBlocked.Load() != 7 {
		t.Fatalf("expected 1 allowed and 7 cap-blocked under concurrent submits, got ok=%d blocked=%d", capOK.Load(), capBlocked.Load())
	}
}

func TestProposalCommit_NotFound404AndDeadlineExceededCompensation(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "proposal.submit" {
			time.Sleep(120 * time.Millisecond)
			return map[string]any{"submitted": true}, nil
		}
		return map[string]any{"ok": true}, nil
	})

	// 1. Nonexistent proposal ID on /approve and /submit returns 404 (not 500)
	for _, action := range []string{"approve", "submit"} {
		req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/999999/%s", srv.URL, action), strings.NewReader(`{}`))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s request: %v", action, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("expected 404 for nonexistent proposal on /%s, got %d", action, resp.StatusCode)
		}
	}

	// 2. context.DeadlineExceeded during proposal.submit RPC sets status="failed" and does NOT restore approval_token
	job := seedTestJobForProposals(t, s, "~022555555555555551", 90, 10, "")
	tok := "deadline-test-token-1234567890"
	prop := dbservice.Proposal{
		JobID:         &job.ID,
		UpworkJobID:   "~022555555555555551",
		CoverLetter:   "Timeout test cover letter",
		BidType:       "fixed",
		Status:        "pending_approval",
		ApprovalToken: tok,
	}
	if err := s.db.GetGorm().Create(&prop).Error; err != nil {
		t.Fatalf("create proposal: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	timeoutReq := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", prop.ID), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tok))).WithContext(ctx)
	timeoutReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	timeoutRec := httptest.NewRecorder()
	s.RegisterRoutes().ServeHTTP(timeoutRec, timeoutReq)
	if timeoutRec.Code == http.StatusOK {
		t.Fatalf("expected non-200 on context.DeadlineExceeded")
	}

	var after dbservice.Proposal
	_ = s.db.GetGorm().First(&after, prop.ID).Error
	if after.Status != "failed" || after.ApprovalToken != "" {
		t.Fatalf("expected failed status and empty approval_token on context.DeadlineExceeded, got status=%q tok=%q", after.Status, after.ApprovalToken)
	}
}

func TestProposalCommit_RealTCPTimeoutAndUnconfirmedCompensation(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var submitMode atomic.Value
	submitMode.Store("slow")
	slowDone := make(chan struct{}, 1)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "proposal.submit" {
			switch submitMode.Load().(string) {
			case "slow":
				time.Sleep(300 * time.Millisecond)
				select {
				case slowDone <- struct{}{}:
				default:
				}
				return map[string]any{"submitted": true}, nil
			case "unconfirmed":
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "PROPOSAL_SUBMIT_UNCONFIRMED: Proposal submission was not confirmed within polling window",
					Data:    json.RawMessage(`{"error_code":"PROPOSAL_SUBMIT_UNCONFIRMED"}`),
				}
			case "validation_err":
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "FORM_VALIDATION_ERROR: Cover letter too short",
					Data:    json.RawMessage(`{"error_code":"FORM_VALIDATION_ERROR"}`),
				}
			}
		}
		return map[string]any{"ok": true}, nil
	})

	// 1. Real httptest.NewServer TCP client timeout (80ms client timeout while WS takes 300ms -> server sees context.Canceled)
	job1 := seedTestJobForProposals(t, s, "~022666666666666661", 90, 10, "")
	tok1 := "tcp-timeout-prop-token-1234567890"
	prop1 := dbservice.Proposal{
		JobID:         &job1.ID,
		UpworkJobID:   "~022666666666666661",
		CoverLetter:   "Real TCP timeout proposal",
		BidType:       "fixed",
		Status:        "pending_approval",
		ApprovalToken: tok1,
	}
	if err := s.db.GetGorm().Create(&prop1).Error; err != nil {
		t.Fatalf("create prop1: %v", err)
	}

	clientCtx, clientCancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer clientCancel()
	tcpReq, _ := http.NewRequestWithContext(
		clientCtx,
		http.MethodPost,
		fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, prop1.ID),
		strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tok1)),
	)
	tcpReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	tcpResp, tcpErr := http.DefaultClient.Do(tcpReq)
	if tcpResp != nil {
		tcpResp.Body.Close()
	}
	if tcpErr == nil || !errors.Is(tcpErr, context.DeadlineExceeded) {
		t.Fatalf("expected client context.DeadlineExceeded over TCP, got err=%v", tcpErr)
	}

	var afterTCP dbservice.Proposal
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := s.db.GetGorm().First(&afterTCP, prop1.ID).Error; err == nil && afterTCP.Status != "submitting" {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if afterTCP.Status != "failed" || afterTCP.ApprovalToken != "" {
		t.Fatalf("expected failed status and empty approval_token after real TCP timeout, got status=%q tok=%q", afterTCP.Status, afterTCP.ApprovalToken)
	}

	select {
	case <-slowDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for slow mock WS responder")
	}

	// 2. PROPOSAL_SUBMIT_UNCONFIRMED -> HTTP 502, status="failed", approval_token=""
	submitMode.Store("unconfirmed")
	job2 := seedTestJobForProposals(t, s, "~022666666666666662", 90, 10, "")
	tok2 := "unconfirmed-prop-token-1234567890"
	prop2 := dbservice.Proposal{
		JobID:         &job2.ID,
		UpworkJobID:   "~022666666666666662",
		CoverLetter:   "Unconfirmed submit proposal",
		BidType:       "fixed",
		Status:        "pending_approval",
		ApprovalToken: tok2,
	}
	if err := s.db.GetGorm().Create(&prop2).Error; err != nil {
		t.Fatalf("create prop2: %v", err)
	}

	uncReq, _ := http.NewRequest(
		http.MethodPost,
		fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, prop2.ID),
		strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tok2)),
	)
	uncReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	uncResp, err := http.DefaultClient.Do(uncReq)
	if err != nil {
		t.Fatalf("unconfirmed submit request: %v", err)
	}
	var uncOut struct {
		ErrorCode string `json:"error_code"`
	}
	_ = json.NewDecoder(uncResp.Body).Decode(&uncOut)
	uncResp.Body.Close()
	if uncResp.StatusCode != http.StatusBadGateway || uncOut.ErrorCode != "PROPOSAL_SUBMIT_UNCONFIRMED" {
		t.Fatalf("expected 502 PROPOSAL_SUBMIT_UNCONFIRMED, got status=%d code=%q", uncResp.StatusCode, uncOut.ErrorCode)
	}

	var afterUnc dbservice.Proposal
	_ = s.db.GetGorm().First(&afterUnc, prop2.ID).Error
	if afterUnc.Status != "failed" || afterUnc.ApprovalToken != "" {
		t.Fatalf("expected failed status and empty approval_token on PROPOSAL_SUBMIT_UNCONFIRMED, got status=%q tok=%q", afterUnc.Status, afterUnc.ApprovalToken)
	}

	// 3. Non-ambiguous FORM_VALIDATION_ERROR still restores pending_approval + approval_token cleanly
	submitMode.Store("validation_err")
	job3 := seedTestJobForProposals(t, s, "~022666666666666663", 90, 10, "")
	tok3 := "validation-err-prop-token-12345678"
	prop3 := dbservice.Proposal{
		JobID:         &job3.ID,
		UpworkJobID:   "~022666666666666663",
		CoverLetter:   "Short",
		BidType:       "fixed",
		Status:        "pending_approval",
		ApprovalToken: tok3,
	}
	if err := s.db.GetGorm().Create(&prop3).Error; err != nil {
		t.Fatalf("create prop3: %v", err)
	}

	valReq, _ := http.NewRequest(
		http.MethodPost,
		fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, prop3.ID),
		strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tok3)),
	)
	valReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	valResp, err := http.DefaultClient.Do(valReq)
	if err != nil {
		t.Fatalf("validation error submit request: %v", err)
	}
	valResp.Body.Close()
	if valResp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 on FORM_VALIDATION_ERROR, got %d", valResp.StatusCode)
	}
	var afterVal dbservice.Proposal
	_ = s.db.GetGorm().First(&afterVal, prop3.ID).Error
	if afterVal.Status != "pending_approval" || afterVal.ApprovalToken != tok3 {
		t.Fatalf("expected FORM_VALIDATION_ERROR to restore pending_approval + token, got status=%q tok=%q", afterVal.Status, afterVal.ApprovalToken)
	}
}

func TestFillProposal_DisconnectedReturnsExtensionDisconnectedEvenIfProposalMissing(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	// Bridge hub is attached but no extension WS client is connected, and proposal ID 999999 does not exist.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals/999999/fill", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /api/proposals/999999/fill: %v", err)
	}
	defer resp.Body.Close()

	var errOut struct {
		ErrorCode string `json:"error_code"`
		Error     string `json:"error"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&errOut)
	if resp.StatusCode != http.StatusServiceUnavailable || errOut.ErrorCode != "EXTENSION_DISCONNECTED" {
		t.Fatalf("expected 503 EXTENSION_DISCONNECTED when disconnected even if proposal missing, got status=%d body=%+v", resp.StatusCode, errOut)
	}
}

func TestSaveProposal_UnseededUpworkJobIDAllowedWhileMissingNumericJobReturns404(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	// 1. Unseeded Upwork ~jobID string in job_id creates draft without requiring a seeded jobs row
	unseededReq, _ := http.NewRequest(
		http.MethodPost,
		srv.URL+"/api/proposals",
		strings.NewReader(`{
			"job_id": "~040400000000000000001",
			"cover_letter": "Blocked post-kill-switch.",
			"bid_type": "fixed",
			"bid_amount": 1100
		}`),
	)
	unseededReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	unseededResp, err := http.DefaultClient.Do(unseededReq)
	if err != nil {
		t.Fatalf("POST /api/proposals with unseeded ~jobID: %v", err)
	}
	var unseededOut struct {
		Proposal proposalEntry `json:"proposal"`
	}
	_ = json.NewDecoder(unseededResp.Body).Decode(&unseededOut)
	unseededResp.Body.Close()
	if unseededResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 for unseeded ~jobID, got %d", unseededResp.StatusCode)
	}
	if unseededOut.Proposal.ID == 0 || unseededOut.Proposal.UpworkJobID != "~040400000000000000001" || unseededOut.Proposal.JobID != nil {
		t.Fatalf("unexpected proposal payload for unseeded ~jobID: %+v", unseededOut.Proposal)
	}

	// 2. Missing numeric DB job_id (both numeric JSON and numeric string) still returns 404 NOT_FOUND
	for _, payload := range []string{
		`{"job_id": 999999, "cover_letter": "Missing numeric job.", "bid_type": "fixed", "bid_amount": 500}`,
		`{"job_id": "999999", "cover_letter": "Missing numeric string job.", "bid_type": "fixed", "bid_amount": 500}`,
	} {
		missingReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals", strings.NewReader(payload))
		missingReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		missingResp, reqErr := http.DefaultClient.Do(missingReq)
		if reqErr != nil {
			t.Fatalf("POST /api/proposals with missing numeric job_id: %v", reqErr)
		}
		var errBody struct {
			ErrorCode string `json:"error_code"`
		}
		_ = json.NewDecoder(missingResp.Body).Decode(&errBody)
		missingResp.Body.Close()
		if missingResp.StatusCode != http.StatusNotFound || errBody.ErrorCode != "NOT_FOUND" {
			t.Fatalf("expected 404 NOT_FOUND for payload %s, got status=%d code=%q", payload, missingResp.StatusCode, errBody.ErrorCode)
		}
	}
}

func TestSaveProposal_MutationInvalidatesApprovalTokenAndCrossProposalRejected(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "proposal.fill":
			return map[string]any{
				"ok": true, "cover_letter_length": 20, "bid_type": "fixed", "bid_amount": 500,
				"connects_cost": 4, "total_connects": 4, "available_connects": 50,
			}, nil
		case "proposal.submit":
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/1"}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	createAndFill := func(uid string) (uint, string) {
		cReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals", strings.NewReader(fmt.Sprintf(`{"job_id":%q,"cover_letter":"Safe letter","bid_type":"fixed","bid_amount":500}`, uid)))
		cReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		cResp, _ := http.DefaultClient.Do(cReq)
		var cOut struct {
			Proposal proposalEntry `json:"proposal"`
		}
		_ = json.NewDecoder(cResp.Body).Decode(&cOut)
		cResp.Body.Close()

		fReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/fill", srv.URL, cOut.Proposal.ID), strings.NewReader(`{}`))
		fReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		fResp, _ := http.DefaultClient.Do(fReq)
		var fOut struct {
			ApprovalToken string `json:"approval_token"`
		}
		_ = json.NewDecoder(fResp.Body).Decode(&fOut)
		fResp.Body.Close()
		return cOut.Proposal.ID, fOut.ApprovalToken
	}

	idA, tokA := createAndFill("~01propA")
	idB, _ := createAndFill("~01propB")

	// 1. Cross-proposal token substitution must fail 403
	crossReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, idB), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tokA)))
	crossReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	crossResp, _ := http.DefaultClient.Do(crossReq)
	crossResp.Body.Close()
	if crossResp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 on cross-proposal token substitution, got %d", crossResp.StatusCode)
	}

	// 2. Mutating cover_letter/bid_amount on pending_approval proposal A must invalidate tokA & demote status
	mutReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/proposals", strings.NewReader(fmt.Sprintf(`{"id":%d,"job_id":"~01propA","cover_letter":"TAMPERED","bid_type":"fixed","bid_amount":99999,"status":"pending_approval"}`, idA)))
	mutReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	mutResp, _ := http.DefaultClient.Do(mutReq)
	var mutOut struct {
		Proposal proposalEntry `json:"proposal"`
	}
	_ = json.NewDecoder(mutResp.Body).Decode(&mutOut)
	mutResp.Body.Close()
	if mutOut.Proposal.Status == "pending_approval" || mutOut.Proposal.ApprovalToken != "" {
		t.Fatalf("expected mutated proposal to demote status and clear approval_token, got status=%q tok=%q", mutOut.Proposal.Status, mutOut.Proposal.ApprovalToken)
	}

	staleReq, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/proposals/%d/submit", srv.URL, idA), strings.NewReader(fmt.Sprintf(`{"approval_token":%q}`, tokA)))
	staleReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	staleResp, _ := http.DefaultClient.Do(staleReq)
	staleResp.Body.Close()
	if staleResp.StatusCode == http.StatusOK {
		t.Fatalf("expected mutated proposal to reject pre-mutation approval_token, got 200 OK")
	}
}

func TestSaveProposal_ZeroStringJobIDReturnsBadRequest(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	for _, payload := range []string{
		`{"job_id": 0, "cover_letter": "Zero numeric job id", "bid_type": "fixed", "bid_amount": 500}`,
		`{"job_id": "0", "cover_letter": "Zero string job id", "bid_type": "fixed", "bid_amount": 500}`,
	} {
		req := httptest.NewRequest(http.MethodPost, "/api/proposals", strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var errBody struct {
			ErrorCode string `json:"error_code"`
		}
		_ = json.NewDecoder(w.Body).Decode(&errBody)
		if w.Result().StatusCode != http.StatusBadRequest || errBody.ErrorCode != "INVALID_PARAMS" {
			t.Fatalf("expected 400 INVALID_PARAMS for payload %s, got status=%d code=%q", payload, w.Result().StatusCode, errBody.ErrorCode)
		}
	}
}

func TestProposalLifecycle_R2_AdversarialStateMachineAndJobSwap(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var submitCount atomic.Int32
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "proposal.fill":
			return map[string]any{
				"ok": true, "cover_letter_length": 20, "bid_type": "fixed", "bid_amount": 500,
				"connects_cost": 2, "total_connects": 2, "available_connects": 50,
			}, nil
		case "proposal.submit":
			submitCount.Add(1)
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/880001"}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	jobA := seedTestJobForProposals(t, s, "~0229000000000000001", 90, 2, "")
	jobB := seedTestJobForProposals(t, s, "~0229000000000000002", 40, 20, "")

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

	// 1. Status smuggling on create (status=submitting) must be rejected 400 and not inflate proposals_today
	stSmuggle, _ := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(`{"job_id":%d,"cover_letter":"Smuggle","status":"submitting"}`, jobA.ID))
	if stSmuggle != http.StatusBadRequest {
		t.Fatalf("expected 400 for status=submitting in SaveProposal, got %d", stSmuggle)
	}
	_, pol := doJSON(http.MethodGet, "/api/policy", "")
	if pol["proposals_today"] != float64(0) {
		t.Fatalf("expected proposals_today=0 after rejected status=submitting, got %v", pol["proposals_today"])
	}

	// 2. JobID / UpworkJobID swap on pending_approval proposal must invalidate approval_token & demote status
	_, created := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(`{"job_id":%d,"cover_letter":"Hello","bid_type":"fixed","bid_amount":500}`, jobA.ID))
	propID := int(created["proposal"].(map[string]any)["id"].(float64))
	_, filled := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	tokA := filled["approval_token"].(string)

	stSwap, swapped := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"upwork_job_id":"~0229000000000000002","cover_letter":"Hello","bid_type":"fixed","bid_amount":500,"status":"pending_approval"}`,
		propID, jobB.ID,
	))
	if stSwap != http.StatusOK {
		t.Fatalf("expected 200 on JobID swap update, got %d", stSwap)
	}
	swappedProp := swapped["proposal"].(map[string]any)
	if swappedProp["status"] == "pending_approval" || swappedProp["approval_token"] != nil && swappedProp["approval_token"] != "" {
		t.Fatalf("expected JobID swap to demote status and clear approval_token, got status=%v tok=%v", swappedProp["status"], swappedProp["approval_token"])
	}
	stOldTok, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", propID), fmt.Sprintf(`{"approval_token":%q}`, tokA))
	if stOldTok == http.StatusOK {
		t.Fatalf("expected pre-swap approval_token to be rejected after JobID swap")
	}

	// 3. Re-fill and submit cleanly, then verify SaveProposal, FillProposal, and Reject all return 409 on submitted proposal
	_, filled2 := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	tokB := filled2["approval_token"].(string)
	stSub, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", propID), fmt.Sprintf(`{"approval_token":%q}`, tokB))
	if stSub != http.StatusOK {
		t.Fatalf("expected 200 on valid submit, got %d", stSub)
	}

	stReopen, _ := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"upwork_job_id":"~0229000000000000002","cover_letter":"Hello","bid_type":"fixed","bid_amount":500,"status":"pending_approval"}`,
		propID, jobB.ID,
	))
	if stReopen != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when mutating submitted proposal via SaveProposal, got %d", stReopen)
	}

	stRefill, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	if stRefill != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when calling FillProposal on submitted proposal, got %d", stRefill)
	}

	stReject, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/reject", propID), `{}`)
	if stReject != http.StatusConflict {
		t.Fatalf("expected 409 Conflict when rejecting submitted proposal, got %d", stReject)
	}
	if submitCount.Load() != 1 {
		t.Fatalf("expected exactly 1 submission, got %d", submitCount.Load())
	}
}

func TestProposalLifecycle_R3_FailedRefillBypass_FillTOCTOU_AndJobSwapUpworkID(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var fillStartedMu sync.Mutex
	var fillStarted chan struct{}
	var allowFillReturn chan struct{}
	var gateFill atomic.Bool
	var submitCount atomic.Int32

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "proposal.fill":
			if gateFill.Load() {
				fillStartedMu.Lock()
				started := fillStarted
				allow := allowFillReturn
				fillStartedMu.Unlock()
				if started != nil {
					close(started)
				}
				if allow != nil {
					<-allow
				}
			}
			return map[string]any{
				"ok": true, "cover_letter_length": 20, "bid_type": "fixed", "bid_amount": 500,
				"connects_cost": 2, "total_connects": 2, "available_connects": 50,
			}, nil
		case "proposal.submit":
			n := submitCount.Add(1)
			if n == 1 {
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`"PROPOSAL_SUBMIT_UNCONFIRMED"`),
					Message: "unconfirmed submit",
				}
			}
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/990011"}, nil
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

	jobA := seedTestJobForProposals(t, s, "~0229000000000000101", 90, 2, "")
	jobB := dbservice.Job{Title: "Job B Without UpworkJobID", URL: "https://www.upwork.com/jobs/manual-b"}
	if err := s.db.GetGorm().Create(&jobB).Error; err != nil {
		t.Fatalf("create jobB: %v", err)
	}

	// 1. Trigger failed state via PROPOSAL_SUBMIT_UNCONFIRMED, then verify SaveProposal cannot bypass PROPOSAL_REFILL_REQUIRED
	_, created := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(`{"job_id":%d,"cover_letter":"Initial pitch","bid_type":"fixed","bid_amount":500}`, jobA.ID))
	propID := int(created["proposal"].(map[string]any)["id"].(float64))
	_, filled := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	tok1 := filled["approval_token"].(string)

	stFail, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", propID), fmt.Sprintf(`{"approval_token":%q}`, tok1))
	if stFail == http.StatusOK {
		t.Fatalf("expected unconfirmed submit to fail")
	}

	stBypass, bypassOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"upwork_job_id":"~0229000000000000101","cover_letter":"Initial pitch","bid_type":"fixed","bid_amount":500,"status":"pending_approval"}`,
		propID, jobA.ID,
	))
	if stBypass != http.StatusConflict || bypassOut["error_code"] != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on failed->pending_approval SaveProposal, got %d (%v)", stBypass, bypassOut)
	}

	// Also verify criticalChanged on failed -> pending_approval returns 409 PROPOSAL_REFILL_REQUIRED
	stFailCrit, failCritOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"Edited after failure","bid_type":"fixed","bid_amount":600,"status":"pending_approval"}`,
		propID, jobA.ID,
	))
	if stFailCrit != http.StatusConflict || failCritOut["error_code"] != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on failed->pending_approval even with edited fields, got %d (%v)", stFailCrit, failCritOut)
	}

	// Transition failed -> draft clears snapshot/token, and draft -> pending_approval with criticalChanged demotes to draft
	stReset, resetOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"Clean draft","bid_type":"fixed","bid_amount":500,"status":"draft"}`,
		propID, jobA.ID,
	))
	if stReset != http.StatusOK {
		t.Fatalf("reset to draft failed: %d", stReset)
	}
	resetProp := resetOut["proposal"].(map[string]any)
	if resetProp["verification_snapshot_json"] != nil || (resetProp["approval_token"] != nil && resetProp["approval_token"] != "") {
		t.Fatalf("expected failed->draft to clear snapshot and token, got %+v", resetProp)
	}

	stDraftCrit, draftCritOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"Edited from draft","bid_type":"fixed","bid_amount":550,"status":"pending_approval"}`,
		propID, jobA.ID,
	))
	if stDraftCrit != http.StatusOK || draftCritOut["proposal"].(map[string]any)["status"] != "draft" {
		t.Fatalf("expected draft->pending_approval with criticalChanged to demote to draft, got %d (%v)", stDraftCrit, draftCritOut)
	}

	// 2A. Concurrent SaveProposal mutation during FillProposal must abort 409 PROPOSAL_MODIFIED_DURING_FILL
	fillStartedMu.Lock()
	fillStarted = make(chan struct{})
	allowFillReturn = make(chan struct{})
	fillStartedMu.Unlock()
	gateFill.Store(true)

	var wg sync.WaitGroup
	var raceFillStatus int
	var raceFillOut map[string]any
	wg.Add(1)
	go func() {
		defer wg.Done()
		raceFillStatus, raceFillOut = doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	}()
	<-fillStarted
	stMut, _ := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"Mutated mid-fill","bid_type":"fixed","bid_amount":9999,"status":"draft"}`,
		propID, jobA.ID,
	))
	if stMut != http.StatusOK {
		t.Fatalf("concurrent SaveProposal failed: %d", stMut)
	}
	close(allowFillReturn)
	wg.Wait()
	gateFill.Store(false)

	if raceFillStatus != http.StatusConflict || raceFillOut["error_code"] != "PROPOSAL_MODIFIED_DURING_FILL" {
		t.Fatalf("expected 409 PROPOSAL_MODIFIED_DURING_FILL on concurrent FillProposal mutation, got %d (%v)", raceFillStatus, raceFillOut)
	}

	// 2B. Concurrent rejectProposalHandler during FillProposal must also abort 409 PROPOSAL_MODIFIED_DURING_FILL
	fillStartedMu.Lock()
	fillStarted = make(chan struct{})
	allowFillReturn = make(chan struct{})
	fillStartedMu.Unlock()
	gateFill.Store(true)

	var rejectFillStatus int
	var rejectFillOut map[string]any
	wg.Add(1)
	go func() {
		defer wg.Done()
		rejectFillStatus, rejectFillOut = doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	}()
	<-fillStarted
	stRejMid, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/reject", propID), `{}`)
	if stRejMid != http.StatusOK {
		t.Fatalf("concurrent rejectProposalHandler failed: %d", stRejMid)
	}
	close(allowFillReturn)
	wg.Wait()
	gateFill.Store(false)

	if rejectFillStatus != http.StatusConflict || rejectFillOut["error_code"] != "PROPOSAL_MODIFIED_DURING_FILL" {
		t.Fatalf("expected 409 PROPOSAL_MODIFIED_DURING_FILL on concurrent reject during FillProposal, got %d (%v)", rejectFillStatus, rejectFillOut)
	}

	// 3. Swapping JobID to Job B (nil upwork_job_id) must clear stale UpworkJobID from Job A
	stSwapB, swapBOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"For Job B","bid_type":"fixed","bid_amount":500,"status":"draft"}`,
		propID, jobB.ID,
	))
	if stSwapB != http.StatusOK {
		t.Fatalf("swap to Job B failed: %d", stSwapB)
	}
	if uid, _ := swapBOut["proposal"].(map[string]any)["upwork_job_id"].(string); uid != "" {
		t.Fatalf("expected upwork_job_id cleared when swapping to job without upwork_job_id, got %q", uid)
	}
}

func TestProposalLifecycle_R4_NoSaveTokenBypassAndRejectedSubmitBlocked(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var fillCalls atomic.Int32
	var submitCalls atomic.Int32
	var submitMode atomic.Value
	submitMode.Store("unconfirmed")

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "proposal.fill":
			fillCalls.Add(1)
			return map[string]any{
				"ok": true, "cover_letter_length": 25, "bid_type": "fixed", "bid_amount": 750,
				"connects_cost": 4, "total_connects": 4, "available_connects": 50,
			}, nil
		case "proposal.submit":
			submitCalls.Add(1)
			if submitMode.Load().(string) == "unconfirmed" {
				return nil, &bridge.WireRPCError{
					Code:    json.RawMessage(`-32000`),
					Message: "PROPOSAL_SUBMIT_UNCONFIRMED: timed out waiting for confirmation",
					Data:    json.RawMessage(`{"error_code":"PROPOSAL_SUBMIT_UNCONFIRMED"}`),
				}
			}
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/999001"}, nil
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

	job := seedTestJobForProposals(t, s, "~0229000000000000401", 92, 4, "")

	// 1. Create with status="pending_approval" (UI seeding compat) returns 201 with empty approval_token and fails confirm_in_ui submit
	stSeed, seedOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"job_id":%d,"cover_letter":"Seeded pending UI item","bid_type":"fixed","bid_amount":750,"status":"pending_approval"}`,
		job.ID,
	))
	if stSeed != http.StatusCreated {
		t.Fatalf("expected 201 on create pending_approval seed, got %d (%v)", stSeed, seedOut)
	}
	seedProp := seedOut["proposal"].(map[string]any)
	seedID := int(seedProp["id"].(float64))
	if tok, _ := seedProp["approval_token"].(string); tok != "" {
		t.Fatalf("expected SaveProposal create never to mint approval_token, got %q", tok)
	}
	stSeedSub, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", seedID), `{"approval_token":""}`)
	if stSeedSub != http.StatusForbidden {
		t.Fatalf("expected 403 APPROVAL_REQUIRED submitting un-filled seeded pending_approval with empty token, got %d", stSeedSub)
	}
	// Updating seeded pending_approval without FillProposal (no VerificationSnapshotJSON) must return 409 PROPOSAL_REFILL_REQUIRED
	stSeedUpd, seedUpdOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"Seeded pending UI item","bid_type":"fixed","bid_amount":750,"status":"pending_approval"}`,
		seedID, job.ID,
	))
	if stSeedUpd != http.StatusConflict || seedUpdOut["error_code"] != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on un-filled pending_approval update, got %d (%v)", stSeedUpd, seedUpdOut)
	}

	// 2. 2-step failed -> draft -> pending_approval bypass must return 409 PROPOSAL_REFILL_REQUIRED with 0 extra fills
	_, cOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"job_id":%d,"cover_letter":"R4 failure bypass check","bid_type":"fixed","bid_amount":750}`,
		job.ID,
	))
	propID := int(cOut["proposal"].(map[string]any)["id"].(float64))
	_, fOut := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	tok1 := fOut["approval_token"].(string)

	stFail, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", propID), fmt.Sprintf(`{"approval_token":%q}`, tok1))
	if stFail != http.StatusBadGateway {
		t.Fatalf("expected 502 on unconfirmed submit, got %d", stFail)
	}

	stStep1, _ := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"R4 failure bypass check","bid_type":"fixed","bid_amount":750,"status":"draft"}`,
		propID, job.ID,
	))
	if stStep1 != http.StatusOK {
		t.Fatalf("expected 200 on failed->draft, got %d", stStep1)
	}
	fillsBefore := fillCalls.Load()
	stStep2, step2Out := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"R4 failure bypass check","bid_type":"fixed","bid_amount":750,"status":"pending_approval"}`,
		propID, job.ID,
	))
	if stStep2 != http.StatusConflict || step2Out["error_code"] != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on draft->pending_approval without FillProposal, got %d (%v)", stStep2, step2Out)
	}
	if fillCalls.Load() != fillsBefore {
		t.Fatalf("expected 0 extra FillProposal calls, got delta %d", fillCalls.Load()-fillsBefore)
	}
	var afterStep2 dbservice.Proposal
	_ = s.db.GetGorm().First(&afterStep2, propID).Error
	if afterStep2.Status != "draft" || afterStep2.ApprovalToken != "" {
		t.Fatalf("expected proposal to remain draft with empty token after 409, got status=%q tok=%q", afterStep2.Status, afterStep2.ApprovalToken)
	}

	// 3. Re-fill and reject: SaveProposal(pending_approval)->409, FillProposal->409 with 0 RPCs, auto_with_guardrails submit on rejected & archived -> 409 with 0 RPCs
	_, _ = doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	stRej, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/reject", propID), `{}`)
	if stRej != http.StatusOK {
		t.Fatalf("expected 200 on reject, got %d", stRej)
	}

	stRejSave, rejSaveOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"job_id":%d,"cover_letter":"R4 failure bypass check","bid_type":"fixed","bid_amount":750,"status":"pending_approval"}`,
		propID, job.ID,
	))
	if stRejSave != http.StatusConflict || rejSaveOut["error_code"] != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on rejected->pending_approval, got %d (%v)", stRejSave, rejSaveOut)
	}
	var afterRejSave dbservice.Proposal
	_ = s.db.GetGorm().First(&afterRejSave, propID).Error
	if afterRejSave.Status != "rejected" || afterRejSave.ApprovalToken != "" {
		t.Fatalf("expected rejected proposal not mutated, got status=%q tok=%q", afterRejSave.Status, afterRejSave.ApprovalToken)
	}

	fillsBeforeRejFill := fillCalls.Load()
	stRejFill, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	if stRejFill != http.StatusConflict || fillCalls.Load() != fillsBeforeRejFill {
		t.Fatalf("expected 409 and 0 proposal.fill RPCs on rejected proposal, got status=%d rpcDelta=%d", stRejFill, fillCalls.Load()-fillsBeforeRejFill)
	}

	// Create archived proposal
	_, archOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"job_id":%d,"cover_letter":"Archived proposal","bid_type":"fixed","bid_amount":750,"status":"archived"}`,
		job.ID,
	))
	archID := int(archOut["proposal"].(map[string]any)["id"].(float64))

	submitMode.Store("ok")
	stPol, _ := doJSON(http.MethodPut, "/api/policy", `{"mode":"auto_with_guardrails","auto_submit_proposals":true,"max_proposals_per_day":10,"max_connects_per_day":100,"min_job_score":0}`)
	if stPol != http.StatusOK {
		t.Fatalf("expected 200 updating policy, got %d", stPol)
	}

	submitsBefore := submitCalls.Load()
	stSubRej, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", propID), `{}`)
	stSubArch, _ := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", archID), `{}`)
	if stSubRej != http.StatusConflict || stSubArch != http.StatusConflict || submitCalls.Load() != submitsBefore {
		t.Fatalf("expected 409 and 0 proposal.submit RPCs for rejected (%d) and archived (%d), rpcDelta=%d", stSubRej, stSubArch, submitCalls.Load()-submitsBefore)
	}
}

func TestProposalLifecycle_R5_UnseededSwapClearsJobID_MismatchRejected_AndUnfilledApproveBlocked(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var submitCalls atomic.Int32
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "proposal.fill":
			return map[string]any{
				"ok": true, "cover_letter_length": 25, "bid_type": "fixed", "bid_amount": 800,
				"connects_cost": 12, "total_connects": 12, "available_connects": 50,
			}, nil
		case "proposal.submit":
			submitCalls.Add(1)
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/999002"}, nil
		case "proposals.sync":
			return map[string]any{
				"proposals": []map[string]any{
					{
						"upwork_job_id":       "~0229000000000000501",
						"upwork_proposal_url": "https://www.upwork.com/nx/proposals/999002",
						"status":              "Submitted",
					},
				},
			}, nil
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

	jobA := seedTestJobForProposals(t, s, "~0229000000000000501", 95, 12, "")

	// 1. GO-R5-BUG-02: Mismatched job_id + upwork_job_id must return 409 INVALID_JOB_TARGET
	stMismatch1, misOut1 := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"job_id":%d,"upwork_job_id":"~01unseededB","cover_letter":"Mismatch test","bid_type":"fixed","bid_amount":500}`,
		jobA.ID,
	))
	if stMismatch1 != http.StatusConflict || misOut1["error_code"] != "INVALID_JOB_TARGET" {
		t.Fatalf("expected 409 INVALID_JOB_TARGET for seeded job_id + mismatched upwork_job_id, got %d (%v)", stMismatch1, misOut1)
	}
	stMismatch2, misOut2 := doJSON(http.MethodPost, "/api/proposals",
		`{"job_id":"~01unseededA","upwork_job_id":"~01unseededB","cover_letter":"Mismatch unseeded test","bid_type":"fixed","bid_amount":500}`,
	)
	if stMismatch2 != http.StatusConflict || misOut2["error_code"] != "INVALID_JOB_TARGET" {
		t.Fatalf("expected 409 INVALID_JOB_TARGET for unseeded job_id + mismatched upwork_job_id, got %d (%v)", stMismatch2, misOut2)
	}

	// 2. GO-R5-BUG-02: Updating proposal to an unseeded upwork_job_id clears stale JobID and ConnectsRequired
	_, created := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"job_id":%d,"cover_letter":"Pitch for Job A","bid_type":"fixed","bid_amount":800}`,
		jobA.ID,
	))
	propID := int(created["proposal"].(map[string]any)["id"].(float64))
	_, filled := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", propID), `{}`)
	if filled["approval_token"] == "" {
		t.Fatal("expected approval_token from fill")
	}

	stSwap, swapOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"id":%d,"upwork_job_id":"~01unseededB","cover_letter":"Swapped target to unseeded B","status":"pending_approval"}`,
		propID,
	))
	if stSwap != http.StatusOK {
		t.Fatalf("expected 200 on unseeded swap update, got %d (%v)", stSwap, swapOut)
	}
	swappedProp := swapOut["proposal"].(map[string]any)
	if swappedProp["upwork_job_id"] != "~01unseededB" || swappedProp["job_id"] != nil || swappedProp["status"] != "draft" {
		t.Fatalf("expected job_id=nil, upwork_job_id=~01unseededB, status=draft; got %+v", swappedProp)
	}

	// Verify DB row actually has JobID == nil and ConnectsRequired == nil, and min_job_score=80 blocks auto submit
	var dbProp dbservice.Proposal
	if err := s.db.GetGorm().First(&dbProp, propID).Error; err != nil {
		t.Fatalf("load prop: %v", err)
	}
	if dbProp.JobID != nil || dbProp.ConnectsRequired != nil {
		t.Fatalf("expected nil JobID and nil ConnectsRequired in DB after unseeded swap, got jobID=%v connects=%v", dbProp.JobID, dbProp.ConnectsRequired)
	}
	doJSON(http.MethodPut, "/api/policy", `{"mode":"auto_with_guardrails","auto_submit_proposals":true,"min_job_score":80,"max_proposals_per_day":10,"max_connects_per_day":100}`)
	stLow, lowOut := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", propID), `{}`)
	if stLow != http.StatusForbidden || lowOut["error_code"] != "POLICY_BLOCKED" || submitCalls.Load() != 0 {
		t.Fatalf("expected 403 POLICY_BLOCKED (0 RPCs) for unseeded job under min_job_score=80, got %d (%v) rpcs=%d", stLow, lowOut, submitCalls.Load())
	}

	// 3. GO-R5-BUG-03: Create pending_approval (UI badge compat) -> /approve and auto /submit MUST return 409 PROPOSAL_REFILL_REQUIRED
	stSeed, seedOut := doJSON(http.MethodPost, "/api/proposals", fmt.Sprintf(
		`{"job_id":%d,"cover_letter":"Unfilled pending attempt","bid_type":"fixed","bid_amount":800,"status":"pending_approval"}`,
		jobA.ID,
	))
	if stSeed != http.StatusCreated {
		t.Fatalf("expected 201 on create pending_approval seed, got %d (%v)", stSeed, seedOut)
	}
	seedID := int(seedOut["proposal"].(map[string]any)["id"].(float64))

	// Under auto_with_guardrails -> /submit blocked with 409 PROPOSAL_REFILL_REQUIRED
	stAutoSub, autoSubOut := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/submit", seedID), `{}`)
	if stAutoSub != http.StatusConflict || autoSubOut["error_code"] != "PROPOSAL_REFILL_REQUIRED" || submitCalls.Load() != 0 {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on auto /submit of unfilled pending_approval, got %d (%v) rpcs=%d", stAutoSub, autoSubOut, submitCalls.Load())
	}

	// Under confirm_in_ui -> /approve blocked with 409 PROPOSAL_REFILL_REQUIRED
	doJSON(http.MethodPut, "/api/policy", `{"mode":"confirm_in_ui"}`)
	stApp, appOut := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/approve", seedID), `{}`)
	if stApp != http.StatusConflict || appOut["error_code"] != "PROPOSAL_REFILL_REQUIRED" || submitCalls.Load() != 0 {
		t.Fatalf("expected 409 PROPOSAL_REFILL_REQUIRED on /approve of unfilled pending_approval, got %d (%v) rpcs=%d", stApp, appOut, submitCalls.Load())
	}

	// 4. FillProposal then SyncProposals clears stale ApprovalToken on remote terminal status
	_, filledSeed := doJSON(http.MethodPost, fmt.Sprintf("/api/proposals/%d/fill", seedID), `{}`)
	if filledSeed["approval_token"] == "" {
		t.Fatal("expected token on fill")
	}
	stSync, _ := doJSON(http.MethodPost, "/api/proposals/sync", `{}`)
	if stSync != http.StatusOK {
		t.Fatalf("expected 200 on sync, got %d", stSync)
	}
	var syncedRow dbservice.Proposal
	if err := s.db.GetGorm().First(&syncedRow, seedID).Error; err != nil {
		t.Fatalf("load synced proposal: %v", err)
	}
	if syncedRow.Status != "submitted" || syncedRow.ApprovalToken != "" || syncedRow.ApprovalTokenExpiresAt != nil {
		t.Fatalf("expected SyncProposals to clear ApprovalToken on submitted status, got status=%q tok=%q exp=%v", syncedRow.Status, syncedRow.ApprovalToken, syncedRow.ApprovalTokenExpiresAt)
	}
}
