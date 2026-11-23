package server

import (
	"bytes"
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
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/policy"

	"github.com/coder/websocket"
)

func strPtr(s string) *string     { return &s }
func intPtr(i int) *int           { return &i }
func floatPtr(f float64) *float64 { return &f }
func boolPtr(b bool) *bool        { return &b }

func TestWatcherManager_RecoverAndBaselineAndTabBusy(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "test-token"
	httpSrv, _ := attachTestBridgeHub(t, srv)

	ctx := context.Background()
	rule, err := srv.CreateWatchRule(ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Go Backend Watch"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("alert_only"),
		SeedBaselineOnFirstRun: boolPtr(true),
		DiscoveryConfig:        &DiscoveryConfig{Query: "golang"},
	})
	if err != nil {
		t.Fatalf("CreateWatchRule failed: %v", err)
	}
	if rule.NextRunAt == nil {
		t.Fatalf("expected CreateWatchRule(enabled=true) to initialize NextRunAt instead of nil")
	}

	// 1. Orphaned running WatchRun is recovered on startup
	orphan := dbservice.WatchRun{
		WatchRuleID:      rule.ID,
		DiscoveryBackend: "chrome",
		TriggeredBy:      "scheduler",
		Status:           "running",
		StartedAt:        time.Now().UTC().Add(-2 * time.Minute),
	}
	if err := srv.db.GetGorm().Create(&orphan).Error; err != nil {
		t.Fatalf("create orphan run failed: %v", err)
	}
	mgr := srv.getWatcherManager()
	if err := mgr.RecoverInterruptedRuns(ctx); err != nil {
		t.Fatalf("RecoverInterruptedRuns failed: %v", err)
	}
	var reloadedOrphan dbservice.WatchRun
	if err := srv.db.GetGorm().First(&reloadedOrphan, orphan.ID).Error; err != nil {
		t.Fatalf("reload orphan failed: %v", err)
	}
	if reloadedOrphan.Status != "failed" || reloadedOrphan.ErrorCode != "INTERRUPTED" {
		t.Fatalf("expected failed/INTERRUPTED, got %s/%s", reloadedOrphan.Status, reloadedOrphan.ErrorCode)
	}

	// 2. Connect mock extension returning TAB_BUSY first, then a job
	busyMode := true
	var lastSearchParams map[string]any
	dialAuthenticatedMockExtension(t, httpSrv, "test-token", func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			lastSearchParams = nil
			_ = json.Unmarshal(params, &lastSearchParams)
			if busyMode {
				return nil, &bridge.WireRPCError{Code: json.RawMessage(`"TAB_BUSY"`), Message: "User is typing in Upwork tab"}
			}
			return map[string]any{
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~01baselineJob1",
						"url":             "https://www.upwork.com/jobs/~01baselineJob1",
						"job_title":       "Senior Go Engineer",
						"job_description": "Build Go APIs",
						"skills":          []string{"Go", "PostgreSQL"},
					},
				},
			}, nil
		}
		return map[string]any{}, nil
	})

	// TAB_BUSY -> skipped_busy, ConsecutiveErrors stays 0, scheduler sets skip_if_busy=true and sort=recency
	busyRes, err := mgr.RunRule(ctx, rule.ID, "scheduler", false, false)
	if err != nil {
		t.Fatalf("expected TAB_BUSY to return nil error, got %v", err)
	}
	if busyRes.Run.Status != "skipped_busy" {
		t.Fatalf("expected skipped_busy, got %q", busyRes.Run.Status)
	}
	if lastSearchParams["sort"] != "recency" {
		t.Fatalf("expected default sort=recency for watcher search, got %v", lastSearchParams["sort"])
	}
	if lastSearchParams["skip_if_busy"] != true {
		t.Fatalf("expected skip_if_busy=true for scheduler run, got %v", lastSearchParams["skip_if_busy"])
	}
	afterBusy, _ := srv.GetWatchRule(ctx, rule.ID)
	if afterBusy.ConsecutiveErrors != 0 {
		t.Fatalf("expected ConsecutiveErrors=0 after TAB_BUSY, got %d", afterBusy.ConsecutiveErrors)
	}

	// 2b. Manual Chrome Dry Run: skip_if_busy omitted/false, does NOT persist jobs or search_runs
	busyMode = false
	dryRes, err := mgr.RunRule(ctx, rule.ID, "manual", true, false)
	if err != nil {
		t.Fatalf("chrome dry RunRule failed: %v", err)
	}
	if dryRes.Run.Status != "dry_run" || dryRes.Run.ScrapedCount != 1 || dryRes.Run.NewJobsCount != 1 {
		t.Fatalf("unexpected chrome dry run result: %+v", dryRes)
	}
	if lastSearchParams["skip_if_busy"] == true {
		t.Fatalf("expected skip_if_busy not true for manual run, got %v", lastSearchParams["skip_if_busy"])
	}
	var jobsAfterDry, runsAfterDry int64
	_ = srv.db.GetGorm().Model(&dbservice.Job{}).Count(&jobsAfterDry).Error
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&runsAfterDry).Error
	if jobsAfterDry != 0 || runsAfterDry != 0 {
		t.Fatalf("expected chrome dry run to persist 0 jobs and 0 search_runs, got jobs=%d search_runs=%d", jobsAfterDry, runsAfterDry)
	}

	// 3. First real run still sees ~01baselineJob1 as new and seeds baseline without reacting
	seedRes, err := mgr.RunRule(ctx, rule.ID, "scheduler", false, false)
	if err != nil {
		t.Fatalf("seed RunRule failed: %v", err)
	}
	if seedRes.Run.Status != "seeded" || seedRes.Run.NewJobsCount != 1 || len(seedRes.Events) != 0 {
		t.Fatalf("expected seeded with 1 new job and 0 events, got status=%s new=%d events=%d", seedRes.Run.Status, seedRes.Run.NewJobsCount, len(seedRes.Events))
	}
	afterSeed, _ := srv.GetWatchRule(ctx, rule.ID)
	if afterSeed.SeededAt == nil {
		t.Fatalf("expected SeededAt to be set")
	}
}

func TestWatcherManager_ScraperFS_DraftFill_AutoSubmit_And_CircuitBreaker(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "test-token"
	httpSrv, _ := attachTestBridgeHub(t, srv)
	ctx := context.Background()

	// Seed profile for buildAnalysisContext
	_ = srv.db.GetGorm().Create(&dbservice.Profile{
		Description: "Senior Go and distributed systems engineer",
		Skills:      "Go, PostgreSQL, Docker",
	}).Error

	// Mock extension for detail enrich, fill, and submit
	dialAuthenticatedMockExtension(t, httpSrv, "test-token", func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "jobs.detail":
			return map[string]any{
				"ok": true,
				"job": map[string]any{
					"upwork_job_id":     "~01scraperJob1",
					"url":               "https://www.upwork.com/jobs/~01scraperJob1",
					"job_title":         "Go Microservices Lead",
					"job_description":   "Need senior Go engineer for PostgreSQL APIs.",
					"payment_verified":  true,
					"connects_required": 8,
					"proposals_count":   4,
					"client_country":    "United States",
					"client_spent":      "$100K+",
					"client_rating":     4.9,
				},
			}, nil
		case "proposal.fill":
			return map[string]any{
				"snapshot": map[string]any{
					"cover_letter_length": 180,
					"bid_type":            "hourly",
					"bid_amount":          95.0,
					"total_connects":      8,
				},
			}, nil
		case "proposal.submit":
			return map[string]any{
				"submitted":           true,
				"upwork_proposal_url": "https://www.upwork.com/ab/proposals/999",
			}, nil
		default:
			return map[string]any{}, nil
		}
	})

	// Configure PolicyEngine for auto_with_guardrails
	autoMode := policy.ModeAutoWithGuardrails
	autoSubmit := true
	if _, err := srv.PolicyEngine().Update(ctx, policy.UpdateInput{
		Mode:                &autoMode,
		AutoSubmitProposals: &autoSubmit,
	}, "test"); err != nil {
		t.Fatalf("PolicyEngine.Update failed: %v", err)
	}

	// Create scraper_fs rule with auto_submit
	currentJobID := "~01scraperJob1"
	var lastScraperArgs []string
	fsDir := t.TempDir()
	mgr := srv.getWatcherManager()
	mgr.scraperFSRunner = NewScraperFSRunner(ScraperFSConfig{Dir: fsDir, PythonBin: "uv"})
	mgr.scraperFSRunner.lookPath = func(file string) (string, error) { return "/usr/bin/uv", nil }
	mgr.scraperFSRunner.execFn = func(_ context.Context, _ string, _ string, args []string) ([]byte, []byte, error) {
		lastScraperArgs = append([]string(nil), args...)
		return []byte(`{
			"ok": true,
			"query": "golang",
			"total_found": 1,
			"elapsed_seconds": 0.5,
			"errors": [],
			"jobs": [{
				"title": "Go Microservices Lead",
				"url": "https://www.upwork.com/jobs/` + currentJobID + `",
				"upwork_job_id": "` + currentJobID + `",
				"description": "Need senior Go engineer for PostgreSQL APIs.",
				"hourly_rate": "$80-$120",
				"skills": ["Go", "PostgreSQL"],
				"country": "United States",
				"proposals_count": 4,
				"client_rating": 4.9,
				"client_spent": "$100K+"
			}]
		}`), nil, nil
	}

	confToReturn := 0.92
	ambigToReturn := false
	mgr.draftFastProposalFn = func(_ context.Context, req ollama.FastProposalRequest) (*ollama.FastProposalResponse, error) {
		bid := 95.0
		return &ollama.FastProposalResponse{
			GoNoGo:                "go",
			Confidence:            confToReturn,
			CoverLetter:           "I have built high-throughput Go and PostgreSQL services for 8+ years.",
			BidType:               "hourly",
			BidAmount:             &bid,
			HasAmbiguousScreening: ambigToReturn,
		}, nil
	}

	rule, err := srv.CreateWatchRule(ctx, UpsertWatchRuleInput{
		Name:                         strPtr("ScraperFS AutoSubmit"),
		Enabled:                      boolPtr(true),
		DiscoveryBackend:             strPtr("scraper_fs"),
		ActionMode:                   strPtr("auto_submit"),
		MinScore:                     intPtr(50),
		AutoSubmitMinConfidence:      floatPtr(0.85),
		FallbackOnScreeningQuestions: boolPtr(true),
		SeedBaselineOnFirstRun:       boolPtr(false),
		RequirePaymentVerified:       boolPtr(true),
		MaxConnectsPerJob:            NewNullableInt(12),
		DiscoveryConfig:              &DiscoveryConfig{Query: "golang"},
	})
	if err != nil {
		t.Fatalf("CreateWatchRule failed: %v", err)
	}
	if rule.NextRunAt == nil {
		t.Fatalf("expected CreateWatchRule(enabled=true) to initialize NextRunAt instead of nil")
	}

	// Dry run first -> preview without persisting Jobs, SearchRuns, WatchEvent, or Proposal
	dryRes, err := mgr.RunRule(ctx, rule.ID, "manual", true, true)
	if err != nil {
		t.Fatalf("dryRun failed: %v", err)
	}
	if dryRes.Run.Status != "dry_run" || dryRes.Run.NewJobsCount != 1 || len(dryRes.Events) != 1 || dryRes.Events[0].Stage != "dry_run_preview" {
		t.Fatalf("unexpected dryRun result: %+v", dryRes)
	}
	foundSortRecency := false
	for i := 0; i+1 < len(lastScraperArgs); i++ {
		if lastScraperArgs[i] == "--sort" && lastScraperArgs[i+1] == "recency" {
			foundSortRecency = true
			break
		}
	}
	if !foundSortRecency {
		t.Fatalf("expected scraper_fs default --sort recency, got args=%v", lastScraperArgs)
	}
	var persistedJobsAfterDry, persistedRunsAfterDry int64
	_ = srv.db.GetGorm().Model(&dbservice.Job{}).Count(&persistedJobsAfterDry).Error
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&persistedRunsAfterDry).Error
	if persistedJobsAfterDry != 0 || persistedRunsAfterDry != 0 {
		t.Fatalf("expected scraper_fs dry run to persist 0 jobs and 0 search_runs, got jobs=%d runs=%d", persistedJobsAfterDry, persistedRunsAfterDry)
	}

	// Real run on the SAME job ID still sees it as new and auto-submits!
	realRes, err := mgr.RunRule(ctx, rule.ID, "manual", false, true)
	if err != nil {
		t.Fatalf("real RunRule failed: %v", err)
	}
	if realRes.Run.SubmittedCount != 1 || len(realRes.Events) != 1 || realRes.Events[0].Stage != "submitted" {
		t.Fatalf("expected submitted event, got %+v", realRes)
	}

	// Idempotency: running again on same job skips it
	idemRes, err := mgr.RunRule(ctx, rule.ID, "manual", false, true)
	if err != nil {
		t.Fatalf("idempotency RunRule failed: %v", err)
	}
	if len(idemRes.Events) != 0 {
		t.Fatalf("expected 0 events on idempotent re-run, got %d", len(idemRes.Events))
	}

	// Circuit breaker: 3 consecutive errors pause the rule
	mgr.scraperFSRunner.execFn = func(_ context.Context, _ string, _ string, _ []string) ([]byte, []byte, error) {
		return []byte(`{"ok":false,"errors":["HTTP 429 Too Many Requests"]}`), nil, errors.New("exit 1")
	}
	for i := 0; i < 3; i++ {
		_, _ = mgr.RunRule(ctx, rule.ID, "scheduler", false, true)
	}
	pausedRule, _ := srv.GetWatchRule(ctx, rule.ID)
	if pausedRule.PausedReason != "CONSECUTIVE_ERRORS" {
		t.Fatalf("expected PausedReason=CONSECUTIVE_ERRORS after 3 failures, got %q", pausedRule.PausedReason)
	}

	// Resume clears PausedReason & ConsecutiveErrors
	resumed, err := srv.ResumeWatchRule(ctx, rule.ID)
	if err != nil {
		t.Fatalf("ResumeWatchRule failed: %v", err)
	}
	if resumed.PausedReason != "" || resumed.ConsecutiveErrors != 0 {
		t.Fatalf("expected cleared pause/errors on resume, got %+v", resumed)
	}

	// Kill switch cancels/pauses enabled rules
	srv.CancelWatchers("emergency stop")
	afterKS, _ := srv.GetWatchRule(ctx, rule.ID)
	if afterKS.PausedReason != "KILL_SWITCH" {
		t.Fatalf("expected PausedReason=KILL_SWITCH, got %q", afterKS.PausedReason)
	}
}

func TestWatcherHandlers_RESTEndpoints(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "secret-token"
	handler := srv.RegisterRoutes()

	doReq := func(method, path string, body any) *httptest.ResponseRecorder {
		var rBody *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rBody = bytes.NewReader(b)
		} else {
			rBody = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, rBody)
		req.Header.Set("Authorization", "Bearer secret-token")
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		return rr
	}

	// Create watcher
	rr := doReq(http.MethodPost, "/api/watchers", map[string]any{
		"name":              "REST Watch",
		"discovery_backend": "scraper_fs",
		"action_mode":       "alert_only",
		"max_proposals":     15,
	})
	if rr.Code != http.StatusCreated {
		t.Fatalf("POST /api/watchers expected 201, got %d: %s", rr.Code, rr.Body.String())
	}
	var createOut struct {
		Rule WatchRuleView `json:"rule"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &createOut)
	if createOut.Rule.ID == 0 || createOut.Rule.Name != "REST Watch" || createOut.Rule.MaxProposals == nil || *createOut.Rule.MaxProposals != 15 {
		t.Fatalf("unexpected createOut: %+v", createOut)
	}

	// Invalid active_hours rejected with 400
	rrBadHours := doReq(http.MethodPost, "/api/watchers", map[string]any{
		"name":         "Bad Hours",
		"active_hours": "25:99-99:00",
	})
	if rrBadHours.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid active_hours, got %d: %s", rrBadHours.Code, rrBadHours.Body.String())
	}

	// PATCH clears nullable *int gates back to null
	rrPatch := doReq(http.MethodPatch, "/api/watchers/1", map[string]any{
		"max_proposals": nil,
		"active_hours":  "08:00-18:00",
	})
	if rrPatch.Code != http.StatusOK {
		t.Fatalf("PATCH /api/watchers/1 expected 200, got %d: %s", rrPatch.Code, rrPatch.Body.String())
	}
	var patchOut struct {
		Rule WatchRuleView `json:"rule"`
	}
	_ = json.Unmarshal(rrPatch.Body.Bytes(), &patchOut)
	if patchOut.Rule.MaxProposals != nil || patchOut.Rule.ActiveHours != "08:00-18:00" {
		t.Fatalf("expected max_proposals cleared and active_hours updated, got %+v", patchOut.Rule)
	}

	// Status endpoint
	rrStatus := doReq(http.MethodGet, "/api/watchers/status", nil)
	if rrStatus.Code != http.StatusOK {
		t.Fatalf("GET /api/watchers/status expected 200, got %d", rrStatus.Code)
	}

	// List watchers
	rrList := doReq(http.MethodGet, "/api/watchers", nil)
	if rrList.Code != http.StatusOK {
		t.Fatalf("GET /api/watchers expected 200, got %d", rrList.Code)
	}

	// Toggle with explicit {"enabled": true} and {"enabled": false}
	rrToggleOn := doReq(http.MethodPost, "/api/watchers/1/toggle", map[string]any{"enabled": true})
	if rrToggleOn.Code != http.StatusOK {
		t.Fatalf("POST /api/watchers/1/toggle expected 200, got %d", rrToggleOn.Code)
	}
	var toggleOut struct {
		Rule WatchRuleView `json:"rule"`
	}
	_ = json.Unmarshal(rrToggleOn.Body.Bytes(), &toggleOut)
	if !toggleOut.Rule.Enabled {
		t.Fatalf("expected Enabled=true after explicit toggle")
	}

	// Run disconnected chrome watcher -> 503 SERVICE_UNAVAILABLE via respondBridgeError
	rrChrome := doReq(http.MethodPost, "/api/watchers", map[string]any{
		"name":              "Chrome Disconnected Watch",
		"discovery_backend": "chrome",
	})
	if rrChrome.Code != http.StatusCreated {
		t.Fatalf("POST /api/watchers chrome expected 201, got %d", rrChrome.Code)
	}
	rrRunDisconn := doReq(http.MethodPost, "/api/watchers/2/run", map[string]any{})
	if rrRunDisconn.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when extension disconnected, got %d: %s", rrRunDisconn.Code, rrRunDisconn.Body.String())
	}

	// Delete
	rrDel := doReq(http.MethodDelete, "/api/watchers/1", nil)
	if rrDel.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/watchers/1 expected 204, got %d", rrDel.Code)
	}

	// Notification config GET/PUT/Test with channel="all"
	rrCfg := doReq(http.MethodGet, "/api/notifications/config", nil)
	if rrCfg.Code != http.StatusOK {
		t.Fatalf("GET /api/notifications/config expected 200, got %d", rrCfg.Code)
	}
	whServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer whServer.Close()
	_ = doReq(http.MethodPut, "/api/notifications/config", map[string]any{
		"chrome_notifications_enabled": false,
		"webhook_enabled":              true,
		"webhook_url":                  whServer.URL,
	})
	rrTestAll := doReq(http.MethodPost, "/api/notifications/test", map[string]any{"channel": "all"})
	if rrTestAll.Code != http.StatusOK {
		t.Fatalf("POST /api/notifications/test expected 200, got %d", rrTestAll.Code)
	}
	var testAllOut struct {
		OK      bool                             `json:"ok"`
		Results map[string]ChannelDeliveryResult `json:"results"`
	}
	_ = json.Unmarshal(rrTestAll.Body.Bytes(), &testAllOut)
	if !testAllOut.OK || !testAllOut.Results["webhook"].Sent {
		t.Fatalf("expected channel=all webhook sent=true, got %+v", testAllOut)
	}
}

func createSeededWatchRule(t *testing.T, srv *Server, ctx context.Context, in UpsertWatchRuleInput) *WatchRuleView {
	t.Helper()
	rule, err := srv.CreateWatchRule(ctx, in)
	if err != nil {
		t.Fatalf("CreateWatchRule(%q) failed: %v", derefTrimmedString(in.Name), err)
	}
	now := time.Now().UTC().Add(-time.Minute)
	updates := map[string]any{
		"seeded_at": now,
	}
	if in.SeedBaselineOnFirstRun != nil && !*in.SeedBaselineOnFirstRun {
		updates["seed_baseline_on_first_run"] = false
	}
	if in.MinScore != nil {
		updates["min_score"] = *in.MinScore
	}
	if err := srv.db.GetGorm().Model(&dbservice.WatchRule{}).Where("id = ?", rule.ID).Updates(updates).Error; err != nil {
		t.Fatalf("mark rule %d seeded failed: %v", rule.ID, err)
	}
	reloaded, err := srv.GetWatchRule(ctx, rule.ID)
	if err != nil {
		t.Fatalf("reload rule %d failed: %v", rule.ID, err)
	}
	return reloaded
}

func dialMockExtensionWithConn(
	t *testing.T,
	srv *httptest.Server,
	token string,
	rpcResponder func(method string, params json.RawMessage) (any, *bridge.WireRPCError),
) func(method string, params any) error {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/extension"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"chrome-extension://abcdefghijklmnop"}},
	})
	if err != nil {
		t.Fatalf("WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })

	var writeMu sync.Mutex
	writeJSON := func(v any) error {
		encoded, mErr := json.Marshal(v)
		if mErr != nil {
			return mErr
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.Write(ctx, websocket.MessageText, encoded)
	}

	authMsg := `{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"` + token + `","extension_version":"2.0.0","browser":"chrome"}}`
	writeMu.Lock()
	err = conn.Write(ctx, websocket.MessageText, []byte(authMsg))
	writeMu.Unlock()
	if err != nil {
		t.Fatalf("WS auth write failed: %v", err)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatalf("WS auth ack read failed: %v", err)
	}

	go func() {
		for {
			_, data, rErr := conn.Read(ctx)
			if rErr != nil {
				return
			}
			var env bridge.Envelope
			if uErr := json.Unmarshal(data, &env); uErr != nil || env.Method == "" {
				continue
			}
			res, rpcErr := rpcResponder(env.Method, env.Params)
			reply := map[string]any{
				"jsonrpc": "2.0",
				"id":      json.RawMessage(env.ID),
			}
			if rpcErr != nil {
				reply["error"] = rpcErr
			} else {
				reply["result"] = res
			}
			_ = writeJSON(reply)
		}
	}()

	deadline := time.Now().Add(3 * time.Second)
	connected := false
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/session/status", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, doErr := http.DefaultClient.Do(req)
		if doErr == nil {
			var st bridge.BridgeStatus
			_ = json.NewDecoder(resp.Body).Decode(&st)
			resp.Body.Close()
			if st.ExtensionConnected {
				connected = true
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	if !connected {
		t.Fatal("timed out waiting for mock extension WS connection")
	}

	return func(method string, params any) error {
		return writeJSON(map[string]any{
			"jsonrpc": "2.0",
			"method":  method,
			"params":  params,
		})
	}
}

func TestWatcherLiveIngest_EndToEndWS_DetailEnrichNoDeadlock(t *testing.T) {
	baseSrv := setupTestServer(t)
	ctx := context.Background()

	var hub *bridge.Hub
	var srv *Server
	hub = bridge.NewHub(bridge.HubConfig{
		AuthTimeout:        2 * time.Second,
		DefaultCallTimeout: 5 * time.Second,
		PreAuthCheck: func(r *http.Request) bool {
			return srv.AuthenticateWSRequest(r) == WSAuthAuthenticated
		},
		ValidateAuthFrame: func(raw []byte) (json.RawMessage, bool) {
			return srv.ValidateWSAuthFrame(raw)
		},
		AllowOrigin: func(origin string) bool {
			return srv.IsAllowedOrigin(origin)
		},
	})
	t.Cleanup(func() { _ = hub.Close() })

	srv = NewServerWithDeps(ServerDeps{
		APIToken:     "test-token",
		DB:           baseSrv.db,
		BridgeHub:    hub,
		PolicyEngine: baseSrv.PolicyEngine(),
	})

	httpSrv := httptest.NewServer(srv.RegisterRoutes())
	t.Cleanup(httpSrv.Close)

	if err := srv.StartWatchers(ctx); err != nil {
		t.Fatalf("StartWatchers failed: %v", err)
	}
	// Registered after setupTestServer so LIFO stops watchers before sqlDB.Close().
	t.Cleanup(func() { _ = srv.CloseWatchers() })

	_ = srv.db.GetGorm().Create(&dbservice.Profile{
		Description: "Senior Go distributed systems architect",
		Skills:      "Go, PostgreSQL, Kubernetes",
	}).Error

	var detailCalled atomic.Bool
	var fillCalled atomic.Bool
	sendNotif := dialMockExtensionWithConn(t, httpSrv, "test-token", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "jobs.detail":
			detailCalled.Store(true)
			return map[string]any{
				"ok": true,
				"job": map[string]any{
					"upwork_job_id":     "~01liveWsJob1",
					"url":               "https://www.upwork.com/jobs/~01liveWsJob1/",
					"job_title":         "Senior Go Backend Engineer",
					"job_description":   "Design Go microservices and PostgreSQL pipelines.",
					"payment_verified":  true,
					"connects_required": 6,
					"proposals_count":   3,
					"client_country":    "United States",
					"client_spent":      "$50K+",
					"client_rating":     4.95,
				},
			}, nil
		case "proposal.fill":
			fillCalled.Store(true)
			return map[string]any{
				"snapshot": map[string]any{
					"cover_letter_length": 160,
					"bid_type":            "hourly",
					"bid_amount":          95.0,
					"total_connects":      6,
				},
			}, nil
		default:
			return map[string]any{}, nil
		}
	})

	mgr := srv.getWatcherManager()
	mgr.draftFastProposalFn = func(_ context.Context, _ ollama.FastProposalRequest) (*ollama.FastProposalResponse, error) {
		bid := 95.0
		return &ollama.FastProposalResponse{
			GoNoGo:      "go",
			Confidence:  0.90,
			CoverLetter: "I build production Go and PostgreSQL APIs.",
			BidType:     "hourly",
			BidAmount:   &bid,
		}, nil
	}

	ruleView := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Live WS Go Rule"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("draft_and_fill"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", Query: "golang"},
	})

	initialNextRun := time.Now().UTC().Add(30 * time.Minute).Truncate(time.Second)
	if err := srv.db.GetGorm().Model(&dbservice.WatchRule{}).
		Where("id = ?", ruleView.ID).
		Update("next_run_at", initialNextRun).Error; err != nil {
		t.Fatalf("update initial next_run_at failed: %v", err)
	}

	err := sendNotif("search.observed", map[string]any{
		"tab_id":         42,
		"page_url":       "https://www.upwork.com/nx/search/jobs/?q=golang",
		"source_feed":    "search",
		"query":          "golang",
		"operation_name": "userJobSearchV1",
		"capture_kind":   "graphql",
		"captured_at":    time.Now().UTC().Format(time.RFC3339),
		"jobs": []map[string]any{
			{
				"upwork_job_id":   "~01liveWsJob1",
				"url":             "https://www.upwork.com/jobs/~01liveWsJob1/",
				"job_title":       "Senior Go Backend Engineer",
				"job_description": "Design Go microservices and PostgreSQL pipelines.",
				"skills":          []string{"Go", "PostgreSQL"},
				"rate_range":      "$80 - $110/hr",
			},
		},
	})
	if err != nil {
		t.Fatalf("sendNotif search.observed failed: %v", err)
	}

	var watchRun dbservice.WatchRun
	deadline := time.Now().Add(6 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		var runs []dbservice.WatchRun
		if err := srv.db.GetGorm().Where("watch_rule_id = ? AND triggered_by = ?", ruleView.ID, "live_stream").Find(&runs).Error; err == nil && len(runs) > 0 {
			if runs[0].Status == "completed" || runs[0].Status == "failed" {
				watchRun = runs[0]
				found = true
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	if !found {
		t.Fatalf("timed out waiting for live_stream WatchRun to complete")
	}
	if !detailCalled.Load() || !fillCalled.Load() {
		t.Fatalf("expected jobs.detail and proposal.fill RPCs to execute without deadlocking Hub.readLoop (detail=%v fill=%v)", detailCalled.Load(), fillCalled.Load())
	}
	if watchRun.Status != "completed" || watchRun.FilledCount != 1 || watchRun.SearchRunID == nil {
		t.Fatalf("unexpected WatchRun: %+v", watchRun)
	}

	var searchRun dbservice.SearchRun
	if err := srv.db.GetGorm().First(&searchRun, *watchRun.SearchRunID).Error; err != nil {
		t.Fatalf("load SearchRun failed: %v", err)
	}
	if searchRun.Source != "chrome_live_stream" || searchRun.TriggeredBy != "live_stream" {
		t.Fatalf("unexpected SearchRun source/triggered_by: %+v", searchRun)
	}

	var watchEvents []dbservice.WatchEvent
	if err := srv.db.GetGorm().Where("watch_rule_id = ?", ruleView.ID).Find(&watchEvents).Error; err != nil {
		t.Fatalf("load WatchEvents failed: %v", err)
	}
	if len(watchEvents) != 1 || watchEvents[0].Stage != "pending_approval" {
		t.Fatalf("expected 1 WatchEvent at stage pending_approval, got %+v", watchEvents)
	}

	var reloadedRule dbservice.WatchRule
	if err := srv.db.GetGorm().First(&reloadedRule, ruleView.ID).Error; err != nil {
		t.Fatalf("reload WatchRule failed: %v", err)
	}
	if reloadedRule.NextRunAt == nil || !reloadedRule.NextRunAt.UTC().Equal(initialNextRun) {
		t.Fatalf("expected NextRunAt to remain unchanged (%v), got %v", initialNextRun, reloadedRule.NextRunAt)
	}
}

func TestWatcherLiveIngest_StatusEndpointAndEnvFlags(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "secret-token"
	handler := srv.RegisterRoutes()
	ctx := context.Background()

	getStatus := func() WatcherStatusView {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/watchers/status", nil)
		req.Header.Set("Authorization", "Bearer secret-token")
		rr := httptest.NewRecorder()
		handler.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("GET /api/watchers/status expected 200, got %d: %s", rr.Code, rr.Body.String())
		}
		var out WatcherStatusView
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode status failed: %v", err)
		}
		return out
	}

	// Default flags: live_ingest_enabled=true, live_ingest_include_scraper_fs=false
	stDefault := getStatus()
	if !stDefault.LiveIngestEnabled || stDefault.LiveIngestIncludeScraperFS {
		t.Fatalf("unexpected default live ingest flags: %+v", stDefault)
	}

	for _, truthy := range []string{"true", "1", "yes", "on"} {
		t.Setenv("WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS", truthy)
		if !IsLiveIngestIncludeScraperFSFromEnv() {
			t.Fatalf("expected WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS=%q to be true", truthy)
		}
		st := getStatus()
		if !st.LiveIngestIncludeScraperFS {
			t.Fatalf("expected status.LiveIngestIncludeScraperFS=true for %q", truthy)
		}
	}

	// Disabled live ingest suppresses HandleObservedSearch, EnqueueObservedSearch, and ProcessObservedSearch
	for _, falsy := range []string{"false", "0", "no", "off"} {
		t.Setenv("WATCHER_LIVE_INGEST_ENABLED", falsy)
		if IsLiveIngestEnabledFromEnv() {
			t.Fatalf("expected WATCHER_LIVE_INGEST_ENABLED=%q to be false", falsy)
		}
		st := getStatus()
		if st.LiveIngestEnabled {
			t.Fatalf("expected status.LiveIngestEnabled=false for %q", falsy)
		}
	}

	t.Setenv("WATCHER_LIVE_INGEST_ENABLED", "false")
	if err := srv.StartWatchers(ctx); err != nil {
		t.Fatalf("StartWatchers failed: %v", err)
	}
	t.Cleanup(func() { _ = srv.CloseWatchers() })

	evt := bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01disabledJob1","job_title":"Go Engineer","url":"https://www.upwork.com/jobs/~01disabledJob1/"}`),
		},
	}
	srv.HandleObservedSearch(evt)
	if srv.getWatcherManager().EnqueueObservedSearch(evt) {
		t.Fatalf("expected EnqueueObservedSearch to return false when WATCHER_LIVE_INGEST_ENABLED=false")
	}
	if err := srv.getWatcherManager().ProcessObservedSearch(ctx, evt); err != nil {
		t.Fatalf("ProcessObservedSearch returned unexpected error when disabled: %v", err)
	}

	var jobCount, searchRunCount, watchRunCount int64
	_ = srv.db.GetGorm().Model(&dbservice.Job{}).Count(&jobCount).Error
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&searchRunCount).Error
	_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Count(&watchRunCount).Error
	if jobCount != 0 || searchRunCount != 0 || watchRunCount != 0 {
		t.Fatalf("expected 0 DB writes when disabled, got jobs=%d searchRuns=%d watchRuns=%d", jobCount, searchRunCount, watchRunCount)
	}

	// Re-enable and ingest 1 job -> telemetry counters surface on GET /api/watchers/status
	t.Setenv("WATCHER_LIVE_INGEST_ENABLED", "true")
	if err := srv.getWatcherManager().ProcessObservedSearch(ctx, evt); err != nil {
		t.Fatalf("ProcessObservedSearch failed: %v", err)
	}
	stAfter := getStatus()
	if stAfter.LiveBatchesSeen != 1 || stAfter.LiveJobsIngested != 1 {
		t.Fatalf("expected live_batches_seen=1 live_jobs_ingested=1, got %+v", stAfter)
	}
}

func TestWatcherLiveIngest_IncludeScraperFSFlag_And_RunHistoryHygiene(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()
	mgr := srv.getWatcherManager()

	ruleView := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("ScraperFS Live Watch"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("scraper_fs"),
		ActionMode:             strPtr("alert_only"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", Query: "golang"},
	})

	// 1. Default WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS=false: job & SearchRun persist, scraper_fs rule is skipped.
	t.Setenv("WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS", "false")
	batch1 := bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scraperLive1","job_title":"Go API Developer","job_description":"Initial desc","url":"https://www.upwork.com/jobs/~01scraperLive1/"}`),
		},
	}
	if err := mgr.ProcessObservedSearch(ctx, batch1); err != nil {
		t.Fatalf("ProcessObservedSearch batch1 failed: %v", err)
	}

	var searchRuns1, watchRuns1 int64
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&searchRuns1).Error
	_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Count(&watchRuns1).Error
	if searchRuns1 != 1 || watchRuns1 != 0 {
		t.Fatalf("expected 1 SearchRun and 0 WatchRuns when include_scraper_fs=false, got searchRuns=%d watchRuns=%d", searchRuns1, watchRuns1)
	}

	// 2. Duplicate batch with richer description updates existing job in place with 0 new SearchRuns and 0 WatchRuns.
	batch1Dup := bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scraperLive1","job_title":"Go API Developer","job_description":"Much richer updated Go and PostgreSQL description from GraphQL","url":"https://www.upwork.com/jobs/~01scraperLive1/"}`),
		},
	}
	if err := mgr.ProcessObservedSearch(ctx, batch1Dup); err != nil {
		t.Fatalf("ProcessObservedSearch batch1Dup failed: %v", err)
	}

	var searchRunsAfterDup, watchRunsAfterDup int64
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&searchRunsAfterDup).Error
	_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Count(&watchRunsAfterDup).Error
	if searchRunsAfterDup != 1 || watchRunsAfterDup != 0 {
		t.Fatalf("expected 0 new SearchRuns/WatchRuns on duplicate batch, got searchRuns=%d watchRuns=%d", searchRunsAfterDup, watchRunsAfterDup)
	}
	var updatedJob dbservice.Job
	if err := srv.db.GetGorm().Where("upwork_job_id = ?", "~01scraperLive1").First(&updatedJob).Error; err != nil {
		t.Fatalf("load updated job failed: %v", err)
	}
	if !strings.Contains(updatedJob.Description, "Much richer updated") {
		t.Fatalf("expected duplicate upsert to refresh description in place, got %q", updatedJob.Description)
	}

	// 3. With WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS=true, new unseen job triggers scraper_fs WatchRule.
	t.Setenv("WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS", "true")
	batch2 := bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scraperLive2","job_title":"Go Microservices Engineer","job_description":"Build Go gRPC services","url":"https://www.upwork.com/jobs/~01scraperLive2/"}`),
		},
	}
	if err := mgr.ProcessObservedSearch(ctx, batch2); err != nil {
		t.Fatalf("ProcessObservedSearch batch2 failed: %v", err)
	}

	var runs []dbservice.WatchRun
	if err := srv.db.GetGorm().Where("watch_rule_id = ?", ruleView.ID).Find(&runs).Error; err != nil {
		t.Fatalf("query watch_runs failed: %v", err)
	}
	if len(runs) != 1 || runs[0].TriggeredBy != "live_stream" || runs[0].DiscoveryBackend != "scraper_fs" || runs[0].AlertedCount != 1 {
		t.Fatalf("expected 1 live_stream scraper_fs WatchRun with alerted_count=1, got %+v", runs)
	}

	// Re-sending batch2 creates 0 new SearchRuns and 0 new WatchRuns.
	if err := mgr.ProcessObservedSearch(ctx, batch2); err != nil {
		t.Fatalf("ProcessObservedSearch batch2 dup failed: %v", err)
	}
	var finalSearchRuns, finalWatchRuns int64
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&finalSearchRuns).Error
	_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Count(&finalWatchRuns).Error
	if finalSearchRuns != 2 || finalWatchRuns != 1 {
		t.Fatalf("expected final searchRuns=2 watchRuns=1, got searchRuns=%d watchRuns=%d", finalSearchRuns, finalWatchRuns)
	}
}

func TestWatcherLiveIngest_RuleGuards_Scope_And_ActiveProjects(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()
	mgr := srv.getWatcherManager()

	fixedNow := time.Date(2026, 11, 22, 3, 0, 0, 0, time.UTC)
	mgr.nowFn = func() time.Time { return fixedNow }
	mgr.localLoc = time.UTC

	// Seed an active non-private project for FromActiveProjects testing.
	if err := srv.db.GetGorm().Create(&dbservice.ActiveProject{
		ProjectKey:         "wasm-engine",
		Name:               "WASM Engine",
		ProposalVisibility: "public",
		ActivityTier:       "active",
		Status:             "active",
		TechStackJSON:      dbservice.JSONB(`["Rust","WebAssembly"]`),
	}).Error; err != nil {
		t.Fatalf("create ActiveProject failed: %v", err)
	}

	seededTime := fixedNow.Add(-time.Hour)
	createRule := func(name string, enabled bool, pausedReason, activeHours string, seedBaseline bool, seeded *time.Time, disc DiscoveryConfig) uint {
		t.Helper()
		rawDisc, _ := json.Marshal(disc)
		r := dbservice.WatchRule{
			Name:                   name,
			Enabled:                enabled,
			DiscoveryBackend:       "chrome",
			DiscoveryConfigJSON:    dbservice.JSONB(rawDisc),
			IntervalMinutes:        5,
			ActiveHours:            activeHours,
			MinScore:               0,
			ActionMode:             "alert_only",
			MaxReactionsPerTick:    10,
			SeedBaselineOnFirstRun: seedBaseline,
			SeededAt:               seeded,
			PausedReason:           pausedReason,
		}
		if err := srv.db.GetGorm().Create(&r).Error; err != nil {
			t.Fatalf("create rule %s failed: %v", name, err)
		}
		return r.ID
	}

	idUnseeded := createRule("Unseeded", true, "", "", true, nil, DiscoveryConfig{Source: "search", Query: "go backend"})
	idDisabled := createRule("Disabled", false, "", "", false, &seededTime, DiscoveryConfig{Source: "search", Query: "go backend"})
	idPaused := createRule("Paused", true, "CONSECUTIVE_ERRORS", "", false, &seededTime, DiscoveryConfig{Source: "search", Query: "go backend"})
	idHours := createRule("ActiveHours", true, "", "09:00-17:00", false, &seededTime, DiscoveryConfig{Source: "search", Query: "go backend"})
	idBestMatches := createRule("BestMatches", true, "", "", false, &seededTime, DiscoveryConfig{Source: "best_matches"})
	idSearchURL := createRule("SearchURLRust", true, "", "", false, &seededTime, DiscoveryConfig{SearchURL: "https://www.upwork.com/nx/search/jobs/?q=rust"})
	idExactQuery := createRule("ExactQueryGoBackend", true, "", "", false, &seededTime, DiscoveryConfig{Source: "search", Query: "go backend"})
	idTokenFallback := createRule("TokenFallbackGoPg", true, "", "", false, &seededTime, DiscoveryConfig{Source: "search", Query: "go postgres"})
	idActiveProj := createRule("FromActiveProjects", true, "", "", false, &seededTime, DiscoveryConfig{Source: "search", FromActiveProjects: true, ActiveProjectKeys: []string{"wasm-engine"}})

	countWatchRuns := func(ruleID uint) int64 {
		var c int64
		_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Where("watch_rule_id = ?", ruleID).Count(&c).Error
		return c
	}

	// Batch 1: whitespace-padded query "  Go   Backend ", at 03:00 UTC (outside 09:00-17:00).
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=Go+Backend",
		SourceFeed: "search",
		Query:      "  Go   Backend ",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scopeGo1","job_title":"API Systems Engineer","job_description":"Distributed services","url":"https://www.upwork.com/jobs/~01scopeGo1/"}`),
		},
	}); err != nil {
		t.Fatalf("Batch 1 failed: %v", err)
	}
	if countWatchRuns(idUnseeded) != 0 || countWatchRuns(idDisabled) != 0 || countWatchRuns(idPaused) != 0 || countWatchRuns(idHours) != 0 || countWatchRuns(idBestMatches) != 0 || countWatchRuns(idSearchURL) != 0 {
		t.Fatalf("expected skipped rules to have 0 runs: unseeded=%d disabled=%d paused=%d hours=%d best=%d url=%d",
			countWatchRuns(idUnseeded), countWatchRuns(idDisabled), countWatchRuns(idPaused), countWatchRuns(idHours), countWatchRuns(idBestMatches), countWatchRuns(idSearchURL))
	}
	if countWatchRuns(idExactQuery) != 1 {
		t.Fatalf("expected ExactQueryGoBackend to match normalized query, got %d", countWatchRuns(idExactQuery))
	}

	// Batch 2: move clock to 12:00 UTC (inside 09:00-17:00) + different evt.Query -> exercises ActiveHours, TokenFallback, and FromActiveProjects.
	fixedNow = time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=systems",
		SourceFeed: "search",
		Query:      "systems",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scopeTok1","job_title":"Go and Postgres Systems","skills":["Go","Postgres"],"url":"https://www.upwork.com/jobs/~01scopeTok1/"}`),
			json.RawMessage(`{"upwork_job_id":"~01scopeHours1","job_title":"Go Backend API Engineer","url":"https://www.upwork.com/jobs/~01scopeHours1/"}`),
			json.RawMessage(`{"upwork_job_id":"~01scopeWasm1","job_title":"Rust WebAssembly Module","job_description":"Compile Rust to WebAssembly","url":"https://www.upwork.com/jobs/~01scopeWasm1/"}`),
			json.RawMessage(`{"upwork_job_id":"~01scopeSkip1","job_title":"WordPress Theme Tweak","url":"https://www.upwork.com/jobs/~01scopeSkip1/"}`),
		},
	}); err != nil {
		t.Fatalf("Batch 2 failed: %v", err)
	}
	if countWatchRuns(idHours) != 1 {
		t.Fatalf("expected ActiveHours rule to trigger at 12:00 UTC, got %d", countWatchRuns(idHours))
	}
	if countWatchRuns(idTokenFallback) != 1 {
		t.Fatalf("expected TokenFallbackGoPg to match via token fallback, got %d", countWatchRuns(idTokenFallback))
	}
	if countWatchRuns(idActiveProj) != 1 {
		t.Fatalf("expected FromActiveProjects rule to match Rust WebAssembly job, got %d", countWatchRuns(idActiveProj))
	}
	var tokenRun dbservice.WatchRun
	_ = srv.db.GetGorm().Where("watch_rule_id = ?", idTokenFallback).First(&tokenRun).Error
	if tokenRun.NewJobsCount != 1 {
		t.Fatalf("expected TokenFallbackGoPg to match only 1 job, got %d", tokenRun.NewJobsCount)
	}

	// Batch 3: best_matches feed + SearchURL rust batch.
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/find-work/best-matches",
		SourceFeed: "best_matches",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scopeBest1","job_title":"Best Match Go Job","url":"https://www.upwork.com/jobs/~01scopeBest1/"}`),
		},
	}); err != nil {
		t.Fatalf("Batch 3 best_matches failed: %v", err)
	}
	if countWatchRuns(idBestMatches) != 1 {
		t.Fatalf("expected BestMatches rule to trigger on best_matches feed, got %d", countWatchRuns(idBestMatches))
	}

	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs?q=Rust&sort=recency",
		SourceFeed: "search",
		Query:      "rust",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01scopeRust1","job_title":"Rust Systems Dev","url":"https://www.upwork.com/jobs/~01scopeRust1/"}`),
		},
	}); err != nil {
		t.Fatalf("Batch 3 SearchURL failed: %v", err)
	}
	if countWatchRuns(idSearchURL) != 1 {
		t.Fatalf("expected SearchURLRust rule to match pathname + q=rust, got %d", countWatchRuns(idSearchURL))
	}
}

func TestWatcherLiveIngest_Filters_ContractType_Amount_And_SearchProfile(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()
	mgr := srv.getWatcherManager()

	// Create SearchProfile with Mode=best_matches, ContractType=fixed, Filters (RequiredKeywords, ExcludeKeywords, MaxProposals, BudgetMin/Max).
	profCfg := defaultSearchProfileConfig()
	profCfg.Search.Mode = "best_matches"
	ctFixed := "fixed"
	profCfg.Search.ContractType = &ctFixed
	profCfg.Filters.RequiredKeywords = []string{"terraform"}
	profCfg.Filters.ExcludeKeywords = []string{"wordpress"}
	profCfg.Filters.MaxProposals = intPtr(10)
	profCfg.Filters.BudgetMin = intPtr(1000)
	profCfg.Filters.BudgetMax = intPtr(5000)
	profRaw, _ := json.Marshal(profCfg)
	prof := dbservice.SearchProfile{
		Name:       "Terraform Best Matches",
		ConfigJSON: dbservice.JSONB(profRaw),
	}
	if err := srv.db.GetGorm().Create(&prof).Error; err != nil {
		t.Fatalf("create SearchProfile failed: %v", err)
	}

	// Rule 1: ContractType=hourly on search feed
	rHourly := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Hourly Only Rule"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("alert_only"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", ContractType: "hourly"},
	})

	// Rule 2: Amount="500-2000" (BudgetMin/BudgetMax nil) on search feed
	rAmount := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Amount Range Rule"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("alert_only"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", ContractType: "fixed", Amount: "500-2000"},
	})

	// Rule 3: SearchProfileID-backed rule (inherits best_matches, fixed, terraform, !wordpress, <=10 proposals, 1000..5000)
	rProfile := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Profile Merged Rule"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		SearchProfileID:        &prof.ID,
		ActionMode:             strPtr("alert_only"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{},
	})

	// Search batch: hourly job, fixed $1200 job, fixed $200 job, unspecified job
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/",
		SourceFeed: "search",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01ctHourly1","job_title":"Hourly SRE","rate_range":"$75 - $95/hr","url":"https://www.upwork.com/jobs/~01ctHourly1/"}`),
			json.RawMessage(`{"upwork_job_id":"~01ctFixed1200","job_title":"Fixed Mid Budget","contract_type":"fixed","budget_amount":"$1,200","url":"https://www.upwork.com/jobs/~01ctFixed1200/"}`),
			json.RawMessage(`{"upwork_job_id":"~01ctFixed200","job_title":"Fixed Small Budget","budget":"$200","url":"https://www.upwork.com/jobs/~01ctFixed200/"}`),
			json.RawMessage(`{"upwork_job_id":"~01ctUnspec1","job_title":"Unspecified Comp Card","url":"https://www.upwork.com/jobs/~01ctUnspec1/"}`),
		},
	}); err != nil {
		t.Fatalf("search batch failed: %v", err)
	}

	var hourlyEvents, amountEvents []dbservice.WatchEvent
	_ = srv.db.GetGorm().Where("watch_rule_id = ?", rHourly.ID).Find(&hourlyEvents).Error
	_ = srv.db.GetGorm().Where("watch_rule_id = ?", rAmount.ID).Find(&amountEvents).Error

	// Hourly rule keeps ~01ctHourly1 and ~01ctUnspec1 (StagePreEnrichment preserves unknown), drops fixed jobs.
	if len(hourlyEvents) != 2 {
		t.Fatalf("expected 2 WatchEvents for Hourly Only Rule (hourly + unspecified), got %d: %+v", len(hourlyEvents), hourlyEvents)
	}
	for _, ev := range hourlyEvents {
		if ev.Stage != "alert_only" {
			t.Fatalf("expected hourlyEvent stage=alert_only, got %+v", ev)
		}
	}
	// Amount rule ("500-2000" + fixed) keeps ~01ctFixed1200 and ~01ctUnspec1 (unknown budget/type preserved), drops $200 and hourly.
	if len(amountEvents) != 2 {
		t.Fatalf("expected 2 WatchEvents for Amount Range Rule ($1200 + unspecified), got %d: %+v", len(amountEvents), amountEvents)
	}
	for _, ev := range amountEvents {
		if ev.Stage != "alert_only" {
			t.Fatalf("expected amountEvent stage=alert_only, got %+v", ev)
		}
	}

	// Best matches batch testing SearchProfile merging
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/find-work/best-matches",
		SourceFeed: "best_matches",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01profMatch","job_title":"Terraform AWS Infra","contract_type":"fixed","budget_amount":"$2,500","proposals_count":5,"url":"https://www.upwork.com/jobs/~01profMatch/"}`),
			json.RawMessage(`{"upwork_job_id":"~01profExcl","job_title":"Terraform WordPress Setup","contract_type":"fixed","budget_amount":"$2,500","proposals_count":5,"url":"https://www.upwork.com/jobs/~01profExcl/"}`),
			json.RawMessage(`{"upwork_job_id":"~01profTooMany","job_title":"Terraform GCP","contract_type":"fixed","budget_amount":"$2,500","proposals_count":25,"url":"https://www.upwork.com/jobs/~01profTooMany/"}`),
			json.RawMessage(`{"upwork_job_id":"~01profHourly","job_title":"Terraform Hourly","contract_type":"hourly","rate_range":"$90/hr","proposals_count":3,"url":"https://www.upwork.com/jobs/~01profHourly/"}`),
			json.RawMessage(`{"upwork_job_id":"~01profLowBudget","job_title":"Terraform Small","contract_type":"fixed","budget_amount":"$300","proposals_count":3,"url":"https://www.upwork.com/jobs/~01profLowBudget/"}`),
		},
	}); err != nil {
		t.Fatalf("best_matches batch failed: %v", err)
	}

	var profileEvents []dbservice.WatchEvent
	_ = srv.db.GetGorm().Where("watch_rule_id = ?", rProfile.ID).Find(&profileEvents).Error
	if len(profileEvents) != 1 || profileEvents[0].UpworkJobID != "~01profMatch" || profileEvents[0].Stage != "alert_only" {
		t.Fatalf("expected only ~01profMatch at stage alert_only to survive SearchProfile filters, got %+v", profileEvents)
	}
}

func TestWatcherLiveIngest_MalformedItems_Idempotency_KillSwitch_And_CircuitBreaker(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "test-token"
	httpSrv, _ := attachTestBridgeHub(t, srv)
	ctx := context.Background()
	mgr := srv.getWatcherManager()

	// 1. Malformed items alongside 1 valid item -> valid item ingests & triggers rule
	ruleAlert := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Malformed Resilient Rule"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("alert_only"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", Query: "golang"},
	})

	err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{invalid json`),
			json.RawMessage(`{"upwork_job_id":"~01badDate","posted_at_est":"not-a-timestamp"}`),
			json.RawMessage(`{}`),
			json.RawMessage(`null`),
			json.RawMessage(`{"upwork_job_id":"~01validItem1","job_title":"Valid Go Job","url":"https://www.upwork.com/jobs/~01validItem1/"}`),
		},
	})
	if err != nil {
		t.Fatalf("ProcessObservedSearch with malformed items failed: %v", err)
	}

	var validJobCount int64
	_ = srv.db.GetGorm().Model(&dbservice.Job{}).Where("upwork_job_id = ?", "~01validItem1").Count(&validJobCount).Error
	if validJobCount != 1 {
		t.Fatalf("expected 1 valid job ingested, got %d", validJobCount)
	}
	var alertEvents []dbservice.WatchEvent
	_ = srv.db.GetGorm().Where("watch_rule_id = ?", ruleAlert.ID).Find(&alertEvents).Error
	if len(alertEvents) != 1 || alertEvents[0].UpworkJobID != "~01validItem1" {
		t.Fatalf("expected 1 WatchEvent for ~01validItem1, got %+v", alertEvents)
	}

	// 2. KillSwitchActive=true suppresses ProcessObservedSearch completely
	if _, err := srv.PolicyEngine().ActivateKillSwitch(ctx, "test kill switch", "test"); err != nil {
		t.Fatalf("PolicyEngine.ActivateKillSwitch failed: %v", err)
	}
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01ksBlocked","job_title":"Blocked By KillSwitch","url":"https://www.upwork.com/jobs/~01ksBlocked/"}`),
		},
	}); err != nil {
		t.Fatalf("ProcessObservedSearch under kill switch failed: %v", err)
	}
	var ksJobCount int64
	_ = srv.db.GetGorm().Model(&dbservice.Job{}).Where("upwork_job_id = ?", "~01ksBlocked").Count(&ksJobCount).Error
	if ksJobCount != 0 {
		t.Fatalf("expected 0 jobs ingested while kill switch active, got %d", ksJobCount)
	}
	confirmMode := policy.ModeConfirmInUI
	_, _ = srv.PolicyEngine().Update(ctx, policy.UpdateInput{Mode: &confirmMode}, "test")

	// 3. ErrHumanActionRequired during jobs.detail triggers HUMAN_ACTION_REQUIRED circuit breaker and preserves NextRunAt
	ruleFill := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Human Action Circuit Breaker Rule"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("draft_and_fill"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", Query: "rust"},
	})
	fixedNextRun := time.Now().UTC().Add(45 * time.Minute).Truncate(time.Second)
	_ = srv.db.GetGorm().Model(&dbservice.WatchRule{}).Where("id = ?", ruleFill.ID).Update("next_run_at", fixedNextRun).Error

	dialAuthenticatedMockExtension(t, httpSrv, "test-token", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.detail" {
			return nil, &bridge.WireRPCError{
				Code:    json.RawMessage(`"HUMAN_ACTION_REQUIRED"`),
				Message: "Cloudflare challenge detected",
			}
		}
		return map[string]any{}, nil
	})

	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=rust",
		SourceFeed: "search",
		Query:      "rust",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01challengeJob1","job_title":"Rust Compiler Job","url":"https://www.upwork.com/jobs/~01challengeJob1/"}`),
		},
	}); err != nil {
		t.Fatalf("ProcessObservedSearch returned unexpected error: %v", err)
	}

	var cbRule dbservice.WatchRule
	if err := srv.db.GetGorm().First(&cbRule, ruleFill.ID).Error; err != nil {
		t.Fatalf("reload cbRule failed: %v", err)
	}
	if cbRule.PausedReason != "HUMAN_ACTION_REQUIRED" {
		t.Fatalf("expected PausedReason=HUMAN_ACTION_REQUIRED, got %q", cbRule.PausedReason)
	}
	if cbRule.NextRunAt == nil || !cbRule.NextRunAt.UTC().Equal(fixedNextRun) {
		t.Fatalf("expected NextRunAt untouched (%v), got %v", fixedNextRun, cbRule.NextRunAt)
	}
	var cbRuns []dbservice.WatchRun
	_ = srv.db.GetGorm().Where("watch_rule_id = ?", ruleFill.ID).Find(&cbRuns).Error
	if len(cbRuns) != 1 || cbRuns[0].Status != "failed" || cbRuns[0].ErrorCode != bridge.ErrCodeHumanActionRequired {
		t.Fatalf("expected 1 failed WatchRun with HUMAN_ACTION_REQUIRED, got %+v", cbRuns)
	}

	// 4. Idempotency with subsequent RunRule on the same job (~01validItem1)
	if err := srv.db.GetGorm().Model(&dbservice.WatchRule{}).Where("id = ?", ruleAlert.ID).Update("enabled", true).Error; err != nil {
		t.Fatalf("ensure ruleAlert enabled failed: %v", err)
	}
	var loadedJob dbservice.Job
	if err := srv.db.GetGorm().Where("upwork_job_id = ?", "~01validItem1").First(&loadedJob).Error; err != nil {
		t.Fatalf("load ~01validItem1 failed: %v", err)
	}
	if !mgr.shouldSkipJobIdempotency(srv.db.GetGorm(), ruleAlert.ID, loadedJob) {
		t.Fatalf("expected shouldSkipJobIdempotency=true for job already handled by live stream")
	}
}

func TestWatcherLiveIngest_QueueOverflow_And_CloseDrainRace(t *testing.T) {
	srv := NewServerWithDeps(ServerDeps{APIToken: "test-token"})
	mgr := srv.getWatcherManager()

	sampleEvt := bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs:       []json.RawMessage{json.RawMessage(`{"upwork_job_id":"~01q1","job_title":"Go Dev"}`)},
	}

	// Not running yet -> EnqueueObservedSearch returns false
	if mgr.EnqueueObservedSearch(sampleEvt) {
		t.Fatalf("expected EnqueueObservedSearch=false before Start")
	}

	// Empty jobs -> returns false even when running
	if err := mgr.Start(context.Background()); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	if mgr.EnqueueObservedSearch(bridge.SearchObservedEvent{PageURL: "https://www.upwork.com/nx/search/jobs/"}) {
		t.Fatalf("expected EnqueueObservedSearch=false for empty Jobs")
	}

	// Disabled env -> returns false
	t.Setenv("WATCHER_LIVE_INGEST_ENABLED", "false")
	if mgr.EnqueueObservedSearch(sampleEvt) {
		t.Fatalf("expected EnqueueObservedSearch=false when env disabled")
	}
	t.Setenv("WATCHER_LIVE_INGEST_ENABLED", "true")

	// Concurrent burst + Close() drain under -race
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 30; i++ {
				evt := sampleEvt
				evt.Query = fmt.Sprintf("golang-%d-%d", worker, i)
				mgr.EnqueueObservedSearch(evt)
			}
		}(g)
	}
	time.Sleep(5 * time.Millisecond)
	if err := mgr.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	wg.Wait()

	// After Close -> returns false without panicking
	if mgr.EnqueueObservedSearch(sampleEvt) {
		t.Fatalf("expected EnqueueObservedSearch=false after Close")
	}

	// Verify deterministic queue saturation & live_dropped_batches counter on a standalone WatcherManager without consumer
	satMgr := NewWatcherManager(srv)
	satMgr.mu.Lock()
	satMgr.running = true
	satMgr.mu.Unlock()

	for i := 0; i < watcherLiveQueueSize; i++ {
		if !satMgr.EnqueueObservedSearch(sampleEvt) {
			t.Fatalf("expected enqueue #%d to succeed before queue full", i)
		}
	}
	if satMgr.EnqueueObservedSearch(sampleEvt) {
		t.Fatalf("expected enqueue #%d to drop when queue full", watcherLiveQueueSize)
	}
	if satMgr.EnqueueObservedSearch(sampleEvt) {
		t.Fatalf("expected enqueue #%d to drop when queue full", watcherLiveQueueSize+1)
	}
	st := satMgr.Status(context.Background())
	if st.LiveDroppedBatches != 2 {
		t.Fatalf("expected LiveDroppedBatches=2, got %d", st.LiveDroppedBatches)
	}
}

func TestWatcherLiveIngest_TitlelessSkipped_And_HaltsOnHumanAction(t *testing.T) {
	srv := setupTestServer(t)
	srv.apiToken = "test-token"
	httpSrv, _ := attachTestBridgeHub(t, srv)
	ctx := context.Background()
	mgr := srv.getWatcherManager()

	// Create two matching enabled seeded draft_and_fill rules
	rule1 := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Challenge Halt Rule 1"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("draft_and_fill"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", Query: "golang"},
	})
	rule2 := createSeededWatchRule(t, srv, ctx, UpsertWatchRuleInput{
		Name:                   strPtr("Challenge Halt Rule 2"),
		Enabled:                boolPtr(true),
		DiscoveryBackend:       strPtr("chrome"),
		ActionMode:             strPtr("draft_and_fill"),
		MinScore:               intPtr(0),
		SeedBaselineOnFirstRun: boolPtr(false),
		DiscoveryConfig:        &DiscoveryConfig{Source: "search", Query: "golang"},
	})

	// 1. Titleless job (~01noTitle) must be skipped without creating jobs, SearchRuns, or WatchRuns
	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01noTitle","url":"https://www.upwork.com/jobs/~01noTitle/","connects_required":8}`),
		},
	}); err != nil {
		t.Fatalf("ProcessObservedSearch titleless batch failed: %v", err)
	}

	var jobCount, searchRunCount, watchRunCount int64
	_ = srv.db.GetGorm().Model(&dbservice.Job{}).Count(&jobCount).Error
	_ = srv.db.GetGorm().Model(&dbservice.SearchRun{}).Count(&searchRunCount).Error
	_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Count(&watchRunCount).Error
	if jobCount != 0 || searchRunCount != 0 || watchRunCount != 0 {
		t.Fatalf("expected 0 jobs/SearchRuns/WatchRuns for titleless batch, got jobs=%d searchRuns=%d watchRuns=%d", jobCount, searchRunCount, watchRunCount)
	}

	// 2. When Rule 1 hits HUMAN_ACTION_REQUIRED on jobs.detail, loop halts so Rule 2 does not hammer Chrome
	var detailCalls atomic.Int32
	dialAuthenticatedMockExtension(t, httpSrv, "test-token", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.detail" {
			detailCalls.Add(1)
			return nil, &bridge.WireRPCError{
				Code:    json.RawMessage(`"HUMAN_ACTION_REQUIRED"`),
				Message: "Cloudflare challenge detected",
			}
		}
		return map[string]any{}, nil
	})

	if err := mgr.ProcessObservedSearch(ctx, bridge.SearchObservedEvent{
		PageURL:    "https://www.upwork.com/nx/search/jobs/?q=golang",
		SourceFeed: "search",
		Query:      "golang",
		Jobs: []json.RawMessage{
			json.RawMessage(`{"upwork_job_id":"~01chalHalt1","job_title":"Go Systems Architect","url":"https://www.upwork.com/jobs/~01chalHalt1/"}`),
		},
	}); err != nil {
		t.Fatalf("ProcessObservedSearch challenge batch failed: %v", err)
	}

	if detailCalls.Load() != 1 {
		t.Fatalf("expected exactly 1 jobs.detail RPC call before halting rule loop, got %d", detailCalls.Load())
	}

	var reloaded1, reloaded2 dbservice.WatchRule
	if err := srv.db.GetGorm().First(&reloaded1, rule1.ID).Error; err != nil {
		t.Fatalf("reload rule1 failed: %v", err)
	}
	if err := srv.db.GetGorm().First(&reloaded2, rule2.ID).Error; err != nil {
		t.Fatalf("reload rule2 failed: %v", err)
	}
	if reloaded1.PausedReason != "HUMAN_ACTION_REQUIRED" {
		t.Fatalf("expected rule1 PausedReason=HUMAN_ACTION_REQUIRED, got %q", reloaded1.PausedReason)
	}
	if reloaded2.PausedReason != "" {
		t.Fatalf("expected rule2 PausedReason to remain empty, got %q", reloaded2.PausedReason)
	}

	var rule2Runs int64
	_ = srv.db.GetGorm().Model(&dbservice.WatchRun{}).Where("watch_rule_id = ?", rule2.ID).Count(&rule2Runs).Error
	if rule2Runs != 0 {
		t.Fatalf("expected 0 WatchRuns for rule2 after rule1 halted on HUMAN_ACTION_REQUIRED, got %d", rule2Runs)
	}
}

func TestWatchRule_DiscoveryConfigPaginationValidation(t *testing.T) {
	srv := setupTestServer(t)
	ctx := context.Background()

	perPage20 := 20
	created, err := srv.CreateWatchRule(ctx, UpsertWatchRuleInput{
		Name: strPtr("Valid Pagination Rule"),
		DiscoveryConfig: &DiscoveryConfig{
			Source:   "search",
			Queries:  []string{"golang"},
			MaxPages: 3,
			PerPage:  &perPage20,
		},
	})
	if err != nil {
		t.Fatalf("CreateWatchRule valid pagination failed: %v", err)
	}
	if created.DiscoveryConfig.MaxPages != 3 || created.DiscoveryConfig.PerPage == nil || *created.DiscoveryConfig.PerPage != 20 {
		t.Fatalf("unexpected created DiscoveryConfig pagination: %+v", created.DiscoveryConfig)
	}

	perPage50 := 50
	updated, err := srv.UpdateWatchRule(ctx, created.ID, UpsertWatchRuleInput{
		DiscoveryConfig: &DiscoveryConfig{
			Source:   "search",
			Queries:  []string{"golang"},
			MaxPages: 5,
			PerPage:  &perPage50,
		},
	})
	if err != nil {
		t.Fatalf("UpdateWatchRule valid pagination failed: %v", err)
	}
	if updated.DiscoveryConfig.MaxPages != 5 || updated.DiscoveryConfig.PerPage == nil || *updated.DiscoveryConfig.PerPage != 50 {
		t.Fatalf("unexpected updated DiscoveryConfig pagination: %+v", updated.DiscoveryConfig)
	}

	if _, err := srv.CreateWatchRule(ctx, UpsertWatchRuleInput{
		Name: strPtr("Invalid MaxPages Rule"),
		DiscoveryConfig: &DiscoveryConfig{
			Source:   "search",
			MaxPages: 25,
		},
	}); err == nil {
		t.Fatalf("expected INVALID_PARAMS error for max_pages=25")
	} else {
		var se *ServiceError
		if !errors.As(err, &se) || se.Code != "INVALID_PARAMS" {
			t.Fatalf("expected ServiceError INVALID_PARAMS for max_pages=25, got %v", err)
		}
	}

	badPerPage := 33
	if _, err := srv.UpdateWatchRule(ctx, created.ID, UpsertWatchRuleInput{
		DiscoveryConfig: &DiscoveryConfig{
			Source:   "search",
			MaxPages: 3,
			PerPage:  &badPerPage,
		},
	}); err == nil {
		t.Fatalf("expected INVALID_PARAMS error for per_page=33")
	} else {
		var se *ServiceError
		if !errors.As(err, &se) || se.Code != "INVALID_PARAMS" {
			t.Fatalf("expected ServiceError INVALID_PARAMS for per_page=33, got %v", err)
		}
	}
}
