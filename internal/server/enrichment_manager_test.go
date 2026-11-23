package server

import (
	"context"
	"encoding/json"
	"errors"
	"math"
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

func setupTestServerWithEnrichment(t *testing.T) *Server {
	t.Helper()
	s := setupTestServer(t)
	t.Cleanup(func() {
		_ = s.getEnrichmentManager().Close()
	})
	return s
}

func TestParseBatchJobIDRef_Validation(t *testing.T) {
	validCases := []struct {
		raw        any
		wantNum    uint64
		wantUpwork string
	}{
		{raw: uint(42), wantNum: 42},
		{raw: uint64(99), wantNum: 99},
		{raw: uint64(math.MaxInt64), wantNum: math.MaxInt64},
		{raw: int(7), wantNum: 7},
		{raw: float64(15), wantNum: 15},
		{raw: json.Number("123"), wantNum: 123},
		{raw: json.Number("9223372036854775807"), wantNum: math.MaxInt64},
		{raw: " 55 ", wantNum: 55},
		{raw: "9223372036854775807", wantNum: math.MaxInt64},
		{raw: "~01abc12345", wantUpwork: "~01abc12345"},
		{raw: "01abc12345", wantUpwork: "~01abc12345"},
		{raw: "https://www.upwork.com/jobs/~02xyz98765/", wantUpwork: "~02xyz98765"},
		{raw: "/jobs/~02xyz98765", wantUpwork: "~02xyz98765"},
	}
	for _, tc := range validCases {
		got, err := parseBatchJobIDRef(tc.raw)
		if err != nil {
			t.Fatalf("parseBatchJobIDRef(%#v) unexpected err: %v", tc.raw, err)
		}
		if got.numericID != tc.wantNum || got.upworkID != tc.wantUpwork {
			t.Fatalf("parseBatchJobIDRef(%#v) = (%d, %q), want (%d, %q)", tc.raw, got.numericID, got.upworkID, tc.wantNum, tc.wantUpwork)
		}
	}

	invalidCases := []any{
		nil,
		true,
		false,
		0,
		-3,
		uint(0),
		uint(math.MaxInt64) + 1,
		uint64(math.MaxInt64) + 1,
		uint64(math.MaxUint64),
		float64(0),
		float64(-1),
		float64(1.5),
		float64(math.MaxInt64),
		float64(math.MaxUint64),
		math.NaN(),
		math.Inf(1),
		json.Number("0"),
		json.Number("-2"),
		json.Number("1.5"),
		json.Number("1.0"),
		json.Number("1e2"),
		json.Number("9223372036854775808"),
		json.Number("18446744073709551615"),
		"",
		"   ",
		"0",
		"-5",
		"1.5",
		"9223372036854775808",
		"18446744073709551615",
		"~",
		"~!",
		"~a b",
		"~01abc!",
		"https://www.upwork.com/jobs/no-id-here",
		"not-an-upwork-id",
		[]string{"1"},
		map[string]any{"id": 1},
	}
	for _, raw := range invalidCases {
		if got, err := parseBatchJobIDRef(raw); err == nil {
			t.Fatalf("parseBatchJobIDRef(%#v) expected error, got %+v", raw, got)
		}
	}
}

func TestEnrichmentManager_NilDB(t *testing.T) {
	s := &Server{}
	mgr := s.getEnrichmentManager()

	var se *ServiceError
	if _, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{JobIDs: []any{1}}); !errors.As(err, &se) || se.Code != "DB_UNAVAILABLE" {
		t.Fatalf("StartBatch nil DB expected DB_UNAVAILABLE, got %v", err)
	}
	if _, err := mgr.CancelBatch(context.Background(), 1); !errors.As(err, &se) || se.Code != "DB_UNAVAILABLE" {
		t.Fatalf("CancelBatch nil DB expected DB_UNAVAILABLE, got %v", err)
	}
	if _, _, err := mgr.ListBatches(context.Background(), "", 20, 0); !errors.As(err, &se) || se.Code != "DB_UNAVAILABLE" {
		t.Fatalf("ListBatches nil DB expected DB_UNAVAILABLE, got %v", err)
	}
	if _, err := mgr.GetBatch(context.Background(), 1); !errors.As(err, &se) || se.Code != "DB_UNAVAILABLE" {
		t.Fatalf("GetBatch nil DB expected DB_UNAVAILABLE, got %v", err)
	}
	if err := mgr.RecoverInterruptedBatches(context.Background()); err != nil {
		t.Fatalf("RecoverInterruptedBatches nil DB expected nil, got %v", err)
	}
	if err := mgr.Close(); err != nil {
		t.Fatalf("Close expected nil, got %v", err)
	}
}

func TestEnrichmentManager_ValidationCapAndMissingIDs_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	uid := "~01capjob1"
	job := dbservice.Job{UpworkJobID: &uid, Title: "Cap Test Job", Description: "Desc"}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	var se *ServiceError
	invalidReqs := []BatchEnrichRequest{
		{JobIDs: nil},
		{JobIDs: []any{}},
		{JobIDs: []any{job.ID}, Mode: "bogus"},
		{JobIDs: []any{job.ID}, Effort: "extreme"},
		{JobIDs: []any{job.ID}, MaxConcurrency: new(0)},
		{JobIDs: []any{job.ID}, MaxConcurrency: new(-1)},
		{JobIDs: []any{job.ID}, WaitTimeoutSeconds: new(-5)},
		{JobIDs: []any{0}},
		{JobIDs: []any{1.5}},
		{JobIDs: []any{"bad"}},
	}
	for i, req := range invalidReqs {
		if _, err := mgr.StartBatch(context.Background(), req); !errors.As(err, &se) || se.Code != "INVALID_PARAMS" {
			t.Fatalf("case %d: expected INVALID_PARAMS, got %v", i, err)
		}
	}

	// Cap check happens before DB lookups and rejects > ENRICHMENT_MAX_BATCH_SIZE
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "3")
	_, capErr := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{1, 2, 3, 4},
		Mode:   "ai_only",
	})
	if !errors.As(capErr, &se) || se.Code != "INVALID_PARAMS" {
		t.Fatalf("expected INVALID_PARAMS over cap, got %v", capErr)
	}

	// Partial missing -> 404 NOT_FOUND with missing_job_ids and 0 batches persisted
	_, missingErr := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{job.ID, 999999, "~01nonexistent"},
		Mode:   "ai_only",
	})
	if !errors.As(missingErr, &se) || se.Code != "NOT_FOUND" {
		t.Fatalf("expected NOT_FOUND for missing IDs, got %v", missingErr)
	}
	if missingList, ok := se.Details["missing_job_ids"].([]string); !ok || len(missingList) != 2 {
		t.Fatalf("expected 2 missing_job_ids in details, got %+v", se.Details)
	}

	var batchCount int64
	if err := gormDB.Model(&dbservice.EnrichmentBatch{}).Count(&batchCount).Error; err != nil {
		t.Fatalf("count batches: %v", err)
	}
	if batchCount != 0 {
		t.Fatalf("expected 0 batches created on validation/404 errors, got %d", batchCount)
	}
}

func TestEnrichmentManager_ForceFalseIdempotencyAndForceTrue_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	var llmCalls atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "low",
			"usage": {"inputTokens": 100, "outputTokens": 200, "thoughtTokens": 50, "totalTokens": 350},
			"message": {
				"role": "assistant",
				"content": "{\"proposal\":\"Fresh proposal\",\"execution_prompt\":\"Go\",\"time_estimate\":\"4h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"
			}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	uid1, uid2, uid3 := "~01idem1", "~01idem2", "~01idem3"
	jCompleted := dbservice.Job{UpworkJobID: &uid1, Title: "Already Completed", Description: "D1", AIEnrichmentStatus: "completed", Proposal: "Existing proposal 1"}
	jLegacy := dbservice.Job{UpworkJobID: &uid2, Title: "Legacy Proposal", Description: "D2", AIEnrichmentStatus: "none", Proposal: "Legacy proposal 2"}
	jFresh := dbservice.Job{UpworkJobID: &uid3, Title: "Fresh Unenriched", Description: "D3", AIEnrichmentStatus: "none"}
	for _, j := range []*dbservice.Job{&jCompleted, &jLegacy, &jFresh} {
		if err := gormDB.Create(j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
	}

	// Pass duplicate ref (jFresh.ID and ~01idem3) to verify canonical dedup as well
	waitTrue := true
	forceFalse := false
	res1, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:      []any{jCompleted.ID, uid2, jFresh.ID, uid3},
		Mode:        "ai_only",
		Force:       &forceFalse,
		Effort:      "low",
		Wait:        &waitTrue,
		TriggeredBy: "mcp",
	})
	if err != nil {
		t.Fatalf("StartBatch(force=false) failed: %v", err)
	}
	if !res1.Completed || res1.Batch.Status != EnrichmentBatchStatusCompleted {
		t.Fatalf("expected completed batch, got %+v", res1.Batch)
	}
	if res1.Batch.TotalCount != 3 || res1.Batch.SkippedCount != 2 || res1.Batch.CompletedCount != 1 || res1.Batch.TotalTokensUsed != 350 {
		t.Fatalf("unexpected counts/tokens: %+v", res1.Batch)
	}
	if llmCalls.Load() != 1 {
		t.Fatalf("expected exactly 1 LLM call with force=false, got %d", llmCalls.Load())
	}

	// Verify skipped items did not mutate existing jobs
	var reloadedLegacy dbservice.Job
	if err := gormDB.First(&reloadedLegacy, jLegacy.ID).Error; err != nil {
		t.Fatalf("reload legacy job: %v", err)
	}
	if reloadedLegacy.AIEnrichmentStatus != "none" || reloadedLegacy.Proposal != "Legacy proposal 2" {
		t.Fatalf("expected skipped legacy job untouched, got status=%q proposal=%q", reloadedLegacy.AIEnrichmentStatus, reloadedLegacy.Proposal)
	}

	// All-skipped batch completes immediately with 0 LLM calls
	resAllSkipped, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{jCompleted.ID, jFresh.ID},
		Mode:   "ai_only",
		Force:  &forceFalse,
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("all-skipped StartBatch failed: %v", err)
	}
	if !resAllSkipped.Completed || resAllSkipped.Batch.SkippedCount != 2 || resAllSkipped.Batch.CompletedCount != 0 || llmCalls.Load() != 1 {
		t.Fatalf("unexpected all-skipped batch result: %+v llmCalls=%d", resAllSkipped.Batch, llmCalls.Load())
	}

	// force=true re-enriches both
	forceTrue := true
	resForced, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{jCompleted.ID, jFresh.ID},
		Mode:   "ai_only",
		Force:  &forceTrue,
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("forced StartBatch failed: %v", err)
	}
	if resForced.Batch.SkippedCount != 0 || resForced.Batch.CompletedCount != 2 || resForced.Batch.TotalTokensUsed != 700 || llmCalls.Load() != 3 {
		t.Fatalf("unexpected forced batch result: %+v llmCalls=%d", resForced.Batch, llmCalls.Load())
	}
}

func TestEnrichmentManager_DetailOnlyFullModeAndFallbacks_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	var llmCalls atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 60, "outputTokens": 140, "thoughtTokens": 0, "totalTokens": 200},
			"message": {"role": "assistant", "content": "{\"proposal\":\"AI proposal\",\"execution_prompt\":\"Run\",\"time_estimate\":\"3h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	// 1. Offline fallback vs require_details=true (no extension connected)
	uidOffline := "~01offlinemgr"
	offlineJob := dbservice.Job{
		UpworkJobID: &uidOffline,
		Title:       "Offline Batch Job",
		Description: "Stored card description",
		URL:         "https://www.upwork.com/jobs/" + uidOffline + "/",
	}
	if err := gormDB.Create(&offlineJob).Error; err != nil {
		t.Fatalf("create offline job: %v", err)
	}

	waitTrue := true
	reqDetailsFalse := false
	resFallback, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:         []any{offlineJob.ID},
		Mode:           "full",
		RequireDetails: &reqDetailsFalse,
		Wait:           &waitTrue,
	})
	if err != nil {
		t.Fatalf("offline fallback batch failed: %v", err)
	}
	if resFallback.Batch.CompletedCount != 1 || llmCalls.Load() != 1 {
		t.Fatalf("expected offline fallback completion, got %+v llmCalls=%d", resFallback.Batch, llmCalls.Load())
	}

	forceTrue := true
	skipDetailFalse := false
	reqDetailsTrue := true
	resReqFail, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:              []any{offlineJob.ID},
		Mode:                "full",
		Force:               &forceTrue,
		SkipDetailIfPresent: &skipDetailFalse,
		RequireDetails:      &reqDetailsTrue,
		Wait:                &waitTrue,
	})
	if err != nil {
		t.Fatalf("require_details=true batch failed to start: %v", err)
	}
	if resReqFail.Batch.FailedCount != 1 || resReqFail.Batch.Status != EnrichmentBatchStatusFailed || resReqFail.Items[0].ErrorCode != bridge.ErrCodeExtensionDisconnected {
		t.Fatalf("expected EXTENSION_DISCONNECTED failure, got batch=%+v items=%+v", resReqFail.Batch, resReqFail.Items)
	}

	// 2. Live extension detail_only -> leaves ai_enrichment_status='none', matches GET detail_only filter, then full skips detail
	var detailCalls atomic.Int32
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method != "jobs.detail" {
			return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "method not found"}
		}
		detailCalls.Add(1)
		var p struct {
			UpworkJobID string `json:"upwork_job_id"`
			URL         string `json:"url"`
		}
		_ = json.Unmarshal(params, &p)
		return map[string]any{
			"ok": true,
			"job": map[string]any{
				"upwork_job_id":   p.UpworkJobID,
				"job_title":       "Live Detail Batch Job",
				"job_description": "Scraped full description for " + p.UpworkJobID,
				"url":             p.URL,
			},
		}, nil
	})

	uid1, uid2 := "~01detmgr1", "~01detmgr2"
	j1 := dbservice.Job{UpworkJobID: &uid1, Title: "Detail Job 1", Description: "Short 1", URL: "https://www.upwork.com/jobs/" + uid1 + "/"}
	j2 := dbservice.Job{UpworkJobID: &uid2, Title: "Detail Job 2", Description: "Short 2", URL: "https://www.upwork.com/jobs/" + uid2 + "/"}
	for _, j := range []*dbservice.Job{&j1, &j2} {
		if err := gormDB.Create(j).Error; err != nil {
			t.Fatalf("create detail job: %v", err)
		}
	}

	resDetOnly, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{j1.ID, j2.ID},
		Mode:   "detail_only",
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("detail_only batch failed: %v", err)
	}
	if resDetOnly.Batch.CompletedCount != 2 || detailCalls.Load() != 2 || llmCalls.Load() != 1 {
		t.Fatalf("unexpected detail_only result: batch=%+v detailCalls=%d llmCalls=%d", resDetOnly.Batch, detailCalls.Load(), llmCalls.Load())
	}
	for _, item := range resDetOnly.Items {
		if !item.DetailFetched || item.LLMInvoked {
			t.Fatalf("expected DetailFetched=true LLMInvoked=false, got %+v", item)
		}
	}

	var checkJ1 dbservice.Job
	if err := gormDB.First(&checkJ1, j1.ID).Error; err != nil {
		t.Fatalf("reload j1: %v", err)
	}
	if checkJ1.AIEnrichmentStatus != "none" || checkJ1.LastEnrichedAt == nil {
		t.Fatalf("expected detail_only to keep ai_enrichment_status='none' and backfill last_enriched_at, got status=%q last_enriched_at=%v", checkJ1.AIEnrichmentStatus, checkJ1.LastEnrichedAt)
	}

	detEntries, detTotal, err := s.ListJobsWithTotal(context.Background(), ListJobsFilter{EnrichmentStatus: "detail_only"})
	if err != nil || detTotal != 2 || len(detEntries) != 2 {
		t.Fatalf("expected ListJobsWithTotal(detail_only)=2, got total=%d len=%d err=%v", detTotal, len(detEntries), err)
	}

	// Full mode with skip_detail_if_present=true skips Phase A and invokes LLM directly
	resFullSkipDet, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{j1.ID, j2.ID},
		Mode:   "full",
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("full mode after detail_only failed: %v", err)
	}
	if resFullSkipDet.Batch.CompletedCount != 2 || detailCalls.Load() != 2 || llmCalls.Load() != 3 {
		t.Fatalf("expected 0 extra detail calls and 2 LLM calls, got batch=%+v detailCalls=%d llmCalls=%d", resFullSkipDet.Batch, detailCalls.Load(), llmCalls.Load())
	}
}

func TestEnrichmentManager_ChallengeHaltMidBatch_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	var scrapedIDs []string
	var mu sync.Mutex
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		var p struct {
			UpworkJobID string `json:"upwork_job_id"`
			URL         string `json:"url"`
		}
		_ = json.Unmarshal(params, &p)
		mu.Lock()
		scrapedIDs = append(scrapedIDs, p.UpworkJobID)
		mu.Unlock()
		if p.UpworkJobID == "~01chal2" {
			return nil, &bridge.WireRPCError{
				Code:    json.RawMessage(`"HUMAN_ACTION_REQUIRED"`),
				Message: "Cloudflare challenge encountered",
			}
		}
		nowStr := time.Now().UTC().Format(time.RFC3339)
		return map[string]any{
			"ok": true,
			"job": map[string]any{
				"upwork_job_id":    p.UpworkJobID,
				"job_title":        "Challenge Job " + p.UpworkJobID,
				"job_description":  "Full scraped text",
				"url":              p.URL,
				"last_enriched_at": nowStr,
			},
		}, nil
	})

	var ids []any
	for _, uid := range []string{"~01chal1", "~01chal2", "~01chal3"} {
		u := uid
		j := dbservice.Job{UpworkJobID: &u, Title: "Job " + uid, Description: "Card", URL: "https://www.upwork.com/jobs/" + uid + "/"}
		if err := gormDB.Create(&j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
		ids = append(ids, j.ID)
	}

	waitTrue := true
	res, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: ids,
		Mode:   "detail_only",
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("StartBatch challenge test failed: %v", err)
	}
	if res.Batch.CompletedCount != 1 || res.Batch.FailedCount != 2 {
		t.Fatalf("expected 1 completed and 2 failed after challenge halt, got %+v", res.Batch)
	}
	mu.Lock()
	scrapedCount := len(scrapedIDs)
	mu.Unlock()
	if scrapedCount != 2 {
		t.Fatalf("expected scraping to halt after job 2 (2 calls total), got %d (%v)", scrapedCount, scrapedIDs)
	}
	if res.Items[0].Status != EnrichmentItemStatusCompleted ||
		res.Items[1].ErrorCode != bridge.ErrCodeHumanActionRequired ||
		res.Items[2].ErrorCode != bridge.ErrCodeHumanActionRequired {
		t.Fatalf("unexpected item states after challenge halt: %+v", res.Items)
	}
}

func TestEnrichmentManager_BoundedConcurrencyCancelAndRecovery_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	var inflight atomic.Int32
	var maxInflight atomic.Int32
	var delayMS atomic.Int64
	delayMS.Store(80)
	firstStarted := make(chan struct{}, 10)

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inflight.Add(1)
		for {
			prev := maxInflight.Load()
			if cur <= prev || maxInflight.CompareAndSwap(prev, cur) {
				break
			}
		}
		select {
		case firstStarted <- struct{}{}:
		default:
		}
		defer inflight.Add(-1)

		d := time.Duration(delayMS.Load()) * time.Millisecond
		select {
		case <-time.After(d):
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 20, "outputTokens": 30, "thoughtTokens": 0, "totalTokens": 50},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Done\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "2")

	var jobIDs []any
	var rawJobs []dbservice.Job
	for _, uid := range []string{"~01conc1", "~01conc2", "~01conc3", "~01conc4"} {
		u := uid
		j := dbservice.Job{UpworkJobID: &u, Title: "Conc Job " + uid, Description: "Desc"}
		if err := gormDB.Create(&j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
		rawJobs = append(rawJobs, j)
		jobIDs = append(jobIDs, j.ID)
	}

	// 1. Bounded concurrency <= 2
	waitTrue := true
	maxConc := 2
	resConc, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:         jobIDs,
		Mode:           "ai_only",
		MaxConcurrency: &maxConc,
		Wait:           &waitTrue,
	})
	if err != nil {
		t.Fatalf("bounded concurrency batch failed: %v", err)
	}
	if resConc.Batch.CompletedCount != 4 || maxInflight.Load() > 2 || maxInflight.Load() < 1 {
		t.Fatalf("unexpected concurrency result: completed=%d maxInflight=%d", resConc.Batch.CompletedCount, maxInflight.Load())
	}

	// 2. Mid-batch cancellation (force=true, max_concurrency=1, slow LLM)
	delayMS.Store(350)
	for len(firstStarted) > 0 {
		<-firstStarted
	}
	waitFalse := false
	forceTrue := true
	conc1 := 1
	asyncRes, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:         jobIDs,
		Mode:           "ai_only",
		Force:          &forceTrue,
		MaxConcurrency: &conc1,
		Wait:           &waitFalse,
	})
	if err != nil {
		t.Fatalf("async batch failed to start: %v", err)
	}

	select {
	case <-firstStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for first LLM request")
	}

	cancelRes, err := mgr.CancelBatch(context.Background(), asyncRes.Batch.ID)
	if err != nil {
		t.Fatalf("CancelBatch failed: %v", err)
	}
	if cancelRes.Batch.Status != EnrichmentBatchStatusCanceled || cancelRes.Batch.CanceledCount < 1 {
		t.Fatalf("expected canceled batch with canceled_count >= 1, got %+v", cancelRes.Batch)
	}

	// Previously completed jobs canceled mid-flight restore to 'completed'
	var restoredJob dbservice.Job
	if err := gormDB.First(&restoredJob, rawJobs[3].ID).Error; err != nil {
		t.Fatalf("reload canceled job: %v", err)
	}
	if restoredJob.AIEnrichmentStatus != "completed" {
		t.Fatalf("expected previously enriched job restored to 'completed', got %q", restoredJob.AIEnrichmentStatus)
	}

	// Idempotent second CancelBatch on terminal batch
	cancelAgain, err := mgr.CancelBatch(context.Background(), asyncRes.Batch.ID)
	if err != nil || cancelAgain.Batch.Status != EnrichmentBatchStatusCanceled {
		t.Fatalf("expected idempotent CancelBatch, got res=%+v err=%v", cancelAgain, err)
	}

	// 3. Startup crash recovery (RecoverInterruptedBatches)
	stuckBatch := dbservice.EnrichmentBatch{
		Mode:        "ai_only",
		TriggeredBy: "ui",
		Status:      EnrichmentBatchStatusRunning,
		TotalCount:  2,
		QueuedCount: 1,
		RunningCount: 1,
	}
	if err := gormDB.Create(&stuckBatch).Error; err != nil {
		t.Fatalf("create stuck batch: %v", err)
	}
	uidUnenriched := "~01stuckfresh"
	jStuckFresh := dbservice.Job{UpworkJobID: &uidUnenriched, Title: "Stuck Fresh", AIEnrichmentStatus: "analyzing"}
	if err := gormDB.Create(&jStuckFresh).Error; err != nil {
		t.Fatalf("create stuck fresh job: %v", err)
	}
	if err := gormDB.Model(&dbservice.Job{}).Where("id = ?", rawJobs[0].ID).Update("ai_enrichment_status", "queued").Error; err != nil {
		t.Fatalf("set stuck queued job: %v", err)
	}
	stuckItems := []dbservice.EnrichmentBatchItem{
		{BatchID: stuckBatch.ID, JobID: jStuckFresh.ID, Status: "running"},
		{BatchID: stuckBatch.ID, JobID: rawJobs[0].ID, Status: "queued"},
	}
	if err := gormDB.Create(&stuckItems).Error; err != nil {
		t.Fatalf("create stuck items: %v", err)
	}

	if err := mgr.RecoverInterruptedBatches(context.Background()); err != nil {
		t.Fatalf("RecoverInterruptedBatches failed: %v", err)
	}

	recovered, err := mgr.GetBatch(context.Background(), stuckBatch.ID)
	if err != nil {
		t.Fatalf("GetBatch recovered failed: %v", err)
	}
	if recovered.Batch.Status != EnrichmentBatchStatusFailed || recovered.Batch.QueuedCount != 0 || recovered.Batch.RunningCount != 0 || recovered.Batch.FailedCount != 2 {
		t.Fatalf("unexpected recovered batch state: %+v", recovered.Batch)
	}
	for _, it := range recovered.Items {
		if it.Status != EnrichmentItemStatusFailed || it.ErrorCode != "SERVER_RESTARTED" {
			t.Fatalf("expected recovered item failed/SERVER_RESTARTED, got %+v", it)
		}
	}

	var checkFresh, checkHadProposal dbservice.Job
	_ = gormDB.First(&checkFresh, jStuckFresh.ID).Error
	_ = gormDB.First(&checkHadProposal, rawJobs[0].ID).Error
	if checkFresh.AIEnrichmentStatus != "none" {
		t.Fatalf("expected unenriched stuck job restored to 'none', got %q", checkFresh.AIEnrichmentStatus)
	}
	if checkHadProposal.AIEnrichmentStatus != "completed" {
		t.Fatalf("expected previously enriched stuck job restored to 'completed', got %q", checkHadProposal.AIEnrichmentStatus)
	}
}

func TestEnrichmentManager_WaitCallerContextTimeout_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(350 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"message": {"role": "assistant", "content": "{\"proposal\":\"Ok\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	uid := "~01waittimeout"
	j := dbservice.Job{UpworkJobID: &uid, Title: "Wait Timeout Job", Description: "Desc"}
	if err := gormDB.Create(&j).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()

	waitTrue := true
	res, err := mgr.StartBatch(ctx, BatchEnrichRequest{
		JobIDs: []any{j.ID},
		Mode:   "ai_only",
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("StartBatch expected snapshot on wait timeout, got err=%v", err)
	}
	if res.Completed || (res.Batch.Status != EnrichmentBatchStatusQueued && res.Batch.Status != EnrichmentBatchStatusRunning) {
		t.Fatalf("expected incomplete queued/running snapshot on wait timeout, got completed=%v status=%q", res.Completed, res.Batch.Status)
	}
	if !strings.Contains(res.DashboardURL, "/dashboard/?batch=") {
		t.Fatalf("expected dashboard_url, got %q", res.DashboardURL)
	}
}

func TestEnrichmentManager_RecoveryStatusAndDetailOnlyAIPreservation_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	// 1. RecoverInterruptedBatches terminal status rollup matrix
	uid1, uid2, uid3, uid4 := "~01rec1", "~01rec2", "~01rec3", "~01rec4"
	j1 := dbservice.Job{UpworkJobID: &uid1, Title: "Rec 1", AIEnrichmentStatus: "completed"}
	j2 := dbservice.Job{UpworkJobID: &uid2, Title: "Rec 2", AIEnrichmentStatus: "completed"}
	j3 := dbservice.Job{UpworkJobID: &uid3, Title: "Rec 3", AIEnrichmentStatus: "queued"}
	j4 := dbservice.Job{UpworkJobID: &uid4, Title: "Rec 4", AIEnrichmentStatus: "none"}
	for _, j := range []*dbservice.Job{&j1, &j2, &j3, &j4} {
		if err := gormDB.Create(j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
	}

	bCompleted := dbservice.EnrichmentBatch{Mode: "ai_only", TriggeredBy: "api", Status: EnrichmentBatchStatusRunning, TotalCount: 2}
	bPartial := dbservice.EnrichmentBatch{Mode: "ai_only", TriggeredBy: "api", Status: EnrichmentBatchStatusRunning, TotalCount: 2}
	bCanceled := dbservice.EnrichmentBatch{Mode: "ai_only", TriggeredBy: "api", Status: EnrichmentBatchStatusQueued, TotalCount: 2}
	bEmpty := dbservice.EnrichmentBatch{Mode: "ai_only", TriggeredBy: "api", Status: EnrichmentBatchStatusRunning, TotalCount: 0}
	for _, b := range []*dbservice.EnrichmentBatch{&bCompleted, &bPartial, &bCanceled, &bEmpty} {
		if err := gormDB.Create(b).Error; err != nil {
			t.Fatalf("create batch: %v", err)
		}
	}

	seedItems := []dbservice.EnrichmentBatchItem{
		{BatchID: bCompleted.ID, JobID: j1.ID, Status: EnrichmentItemStatusCompleted, TotalTokens: 120},
		{BatchID: bCompleted.ID, JobID: j2.ID, Status: EnrichmentItemStatusSkipped, TotalTokens: 0},
		{BatchID: bPartial.ID, JobID: j1.ID, Status: EnrichmentItemStatusSkipped, TotalTokens: 0},
		{BatchID: bPartial.ID, JobID: j3.ID, Status: EnrichmentItemStatusQueued, TotalTokens: 0},
		{BatchID: bCanceled.ID, JobID: j1.ID, Status: EnrichmentItemStatusCanceled, TotalTokens: 0},
		{BatchID: bCanceled.ID, JobID: j2.ID, Status: EnrichmentItemStatusCompleted, TotalTokens: 50},
	}
	if err := gormDB.Create(&seedItems).Error; err != nil {
		t.Fatalf("create seed items: %v", err)
	}

	if err := mgr.RecoverInterruptedBatches(context.Background()); err != nil {
		t.Fatalf("RecoverInterruptedBatches failed: %v", err)
	}

	gotCompleted, err := mgr.GetBatch(context.Background(), bCompleted.ID)
	if err != nil {
		t.Fatalf("GetBatch bCompleted: %v", err)
	}
	if gotCompleted.Batch.Status != EnrichmentBatchStatusCompleted || gotCompleted.Batch.CompletedCount != 1 || gotCompleted.Batch.SkippedCount != 1 || gotCompleted.Batch.FailedCount != 0 || gotCompleted.Batch.TotalTokensUsed != 120 {
		t.Fatalf("expected bCompleted status='completed', got %+v", gotCompleted.Batch)
	}

	gotPartial, err := mgr.GetBatch(context.Background(), bPartial.ID)
	if err != nil {
		t.Fatalf("GetBatch bPartial: %v", err)
	}
	if gotPartial.Batch.Status != EnrichmentBatchStatusCompletedWithErrors || gotPartial.Batch.SkippedCount != 1 || gotPartial.Batch.FailedCount != 1 {
		t.Fatalf("expected bPartial status='completed_with_errors', got %+v", gotPartial.Batch)
	}

	gotCanceled, err := mgr.GetBatch(context.Background(), bCanceled.ID)
	if err != nil {
		t.Fatalf("GetBatch bCanceled: %v", err)
	}
	if gotCanceled.Batch.Status != EnrichmentBatchStatusCanceled || gotCanceled.Batch.CanceledCount != 1 || gotCanceled.Batch.CompletedCount != 1 {
		t.Fatalf("expected bCanceled status='canceled', got %+v", gotCanceled.Batch)
	}

	gotEmpty, err := mgr.GetBatch(context.Background(), bEmpty.ID)
	if err != nil {
		t.Fatalf("GetBatch bEmpty: %v", err)
	}
	if gotEmpty.Batch.Status != EnrichmentBatchStatusFailed {
		t.Fatalf("expected 0-item interrupted batch status='failed', got %+v", gotEmpty.Batch)
	}

	// 2. detail_only preserves ai_enriched_at != nil and prior failed status; force=false respects ai_enriched_at != nil while still retrying failed
	var detailCalls atomic.Int32
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		detailCalls.Add(1)
		var p struct {
			UpworkJobID string `json:"upwork_job_id"`
			URL         string `json:"url"`
		}
		_ = json.Unmarshal(params, &p)
		return map[string]any{
			"ok": true,
			"job": map[string]any{
				"upwork_job_id":   p.UpworkJobID,
				"job_title":       "Preserved Job",
				"job_description": "Scraped body",
				"url":             p.URL,
			},
		}, nil
	})

	var llmCalls atomic.Int32
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		llmCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "low",
			"usage": {"inputTokens": 10, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 30},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Retried proposal\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()
	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	enrichedAt := time.Now().UTC().Add(-time.Hour)
	zeroTime := time.Time{}
	uidAtOnly, uidFailed := "~01atonly", "~01prevfail"
	jAtOnly := dbservice.Job{
		UpworkJobID:        &uidAtOnly,
		Title:              "AI Enriched Timestamp Only",
		Description:        "Desc",
		URL:                "https://www.upwork.com/jobs/" + uidAtOnly + "/",
		AIEnrichmentStatus: "none",
		Proposal:           "",
		AIEnrichedAt:       &enrichedAt,
		LastEnrichedAt:     &zeroTime, // zero time should be treated as unset
	}
	jFailed := dbservice.Job{
		UpworkJobID:        &uidFailed,
		Title:              "Previously Failed AI",
		Description:        "Desc",
		URL:                "https://www.upwork.com/jobs/" + uidFailed + "/",
		AIEnrichmentStatus: "failed",
		AIEnrichmentError:  "previous timeout",
	}
	for _, j := range []*dbservice.Job{&jAtOnly, &jFailed} {
		if err := gormDB.Create(j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
	}

	waitTrue := true
	skipDetailTrue := true
	detRes, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:              []any{jAtOnly.ID, jFailed.ID},
		Mode:                "detail_only",
		SkipDetailIfPresent: &skipDetailTrue,
		Wait:                &waitTrue,
	})
	if err != nil {
		t.Fatalf("detail_only batch failed: %v", err)
	}
	if detRes.Batch.CompletedCount != 2 || detailCalls.Load() != 2 {
		t.Fatalf("expected both jobs scraped (zero LastEnrichedAt not skipped), got batch=%+v detailCalls=%d", detRes.Batch, detailCalls.Load())
	}

	var reloadAtOnly, reloadFailed dbservice.Job
	_ = gormDB.First(&reloadAtOnly, jAtOnly.ID).Error
	_ = gormDB.First(&reloadFailed, jFailed.ID).Error
	if reloadAtOnly.AIEnrichmentStatus != "completed" {
		t.Fatalf("expected ai_enriched_at!=nil job to preserve 'completed' after detail_only, got %q", reloadAtOnly.AIEnrichmentStatus)
	}
	if reloadFailed.AIEnrichmentStatus != "failed" || reloadFailed.AIEnrichmentError != "previous timeout" {
		t.Fatalf("expected prior failed job to preserve 'failed' and error after detail_only, got status=%q err=%q", reloadFailed.AIEnrichmentStatus, reloadFailed.AIEnrichmentError)
	}

	// force=false in ai_only skips jAtOnly (ai_enriched_at!=nil) and retries jFailed (status=='failed')
	forceFalse := false
	aiRes, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{jAtOnly.ID, jFailed.ID},
		Mode:   "ai_only",
		Force:  &forceFalse,
		Wait:   &waitTrue,
	})
	if err != nil {
		t.Fatalf("ai_only batch failed: %v", err)
	}
	if aiRes.Batch.SkippedCount != 1 || aiRes.Batch.CompletedCount != 1 || llmCalls.Load() != 1 {
		t.Fatalf("expected 1 skipped (ai_enriched_at!=nil) and 1 completed (retried failed), got batch=%+v llmCalls=%d", aiRes.Batch, llmCalls.Load())
	}
}

func TestEnrichmentManager_OverlappingAnalyzeCancelDoesNotClobberCompleted_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	firstBatchStarted := make(chan struct{})
	releaseSlowLLM := make(chan struct{})
	var callNum atomic.Int32

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callNum.Add(1)
		if n == 1 {
			close(firstBatchStarted)
			select {
			case <-releaseSlowLLM:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-4-neon-high",
			"applied_effort": "low",
			"usage": {"inputTokens": 40, "outputTokens": 60, "thoughtTokens": 0, "totalTokens": 100},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Completed concurrent proposal\",\"execution_prompt\":\"Go\",\"time_estimate\":\"2h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()
	defer close(releaseSlowLLM)

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	uid := "~01overlap1"
	job := dbservice.Job{
		UpworkJobID:        &uid,
		Title:              "Overlap Cancel Job",
		Description:        "Go backend service",
		AIEnrichmentStatus: "none",
	}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	waitFalse := false
	batchRes, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs: []any{job.ID},
		Mode:   "ai_only",
		Wait:   &waitFalse,
	})
	if err != nil {
		t.Fatalf("StartBatch failed: %v", err)
	}

	select {
	case <-firstBatchStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for slow batch LLM request to start")
	}

	// Concurrent direct AnalyzeJob completes on the same job before the batch is canceled.
	useLLM := true
	analyzeRes, err := s.AnalyzeJob(context.Background(), AnalyzeJobRequest{
		JobID:  job.ID,
		UseLLM: &useLLM,
	})
	if err != nil {
		t.Fatalf("concurrent AnalyzeJob failed: %v", err)
	}
	if analyzeRes.Job.AIEnrichmentStatus != "completed" || strings.TrimSpace(analyzeRes.Job.Proposal) == "" {
		t.Fatalf("expected completed AnalyzeJob result, got %+v", analyzeRes.Job)
	}

	// Canceling the slow overlapping batch must NOT clobber ai_enrichment_status back to 'none'.
	cancelRes, err := mgr.CancelBatch(context.Background(), batchRes.Batch.ID)
	if err != nil {
		t.Fatalf("CancelBatch failed: %v", err)
	}
	if cancelRes.Batch.Status != EnrichmentBatchStatusCanceled {
		t.Fatalf("expected canceled batch status, got %q", cancelRes.Batch.Status)
	}

	var reloaded dbservice.Job
	if err := gormDB.First(&reloaded, job.ID).Error; err != nil {
		t.Fatalf("reload job: %v", err)
	}
	if reloaded.AIEnrichmentStatus != "completed" {
		t.Fatalf("expected ai_enrichment_status='completed' preserved after overlapping cancel, got %q", reloaded.AIEnrichmentStatus)
	}
	if strings.TrimSpace(reloaded.Proposal) != "Completed concurrent proposal" {
		t.Fatalf("expected proposal preserved, got %q", reloaded.Proposal)
	}
	if reloaded.AIEnrichmentError != "" {
		t.Fatalf("expected empty ai_enrichment_error, got %q", reloaded.AIEnrichmentError)
	}

	// Verify runBatch respects an already-canceled batch row without resurrecting it or deadlocking.
	canceledBatch := dbservice.EnrichmentBatch{
		Mode:        "ai_only",
		TriggeredBy: "api",
		Status:      EnrichmentBatchStatusCanceled,
		TotalCount:  1,
	}
	if err := gormDB.Create(&canceledBatch).Error; err != nil {
		t.Fatalf("create pre-canceled batch: %v", err)
	}
	runCtx, runCancel := context.WithCancel(context.Background())
	run := &activeBatchRun{
		batchID: canceledBatch.ID,
		mode:    "ai_only",
		ctx:     runCtx,
		cancel:  runCancel,
		done:    make(chan struct{}),
	}
	mgr.mu.Lock()
	mgr.active[canceledBatch.ID] = run
	mgr.wg.Add(1)
	mgr.mu.Unlock()
	go mgr.runBatch(run)

	select {
	case <-run.done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for runBatch on already-canceled batch")
	}
	var checkBatch dbservice.EnrichmentBatch
	if err := gormDB.First(&checkBatch, canceledBatch.ID).Error; err != nil {
		t.Fatalf("reload pre-canceled batch: %v", err)
	}
	if checkBatch.Status != EnrichmentBatchStatusCanceled {
		t.Fatalf("expected pre-canceled batch to remain canceled, got %q", checkBatch.Status)
	}
}

func TestEnrichmentManager_BatchIDBoundsValidation_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	mgr := s.getEnrichmentManager()
	ctx := context.Background()

	overflowIDs := []uint{0, uint(uint64(1) << 63), ^uint(0)}
	for _, badID := range overflowIDs {
		_, getErr := mgr.GetBatch(ctx, badID)
		var se *ServiceError
		if !errors.As(getErr, &se) || se.HTTPStatus != http.StatusBadRequest || se.Code != "INVALID_PARAMS" {
			t.Fatalf("GetBatch(%d) expected 400 INVALID_PARAMS, got %v", badID, getErr)
		}

		_, cancelErr := mgr.CancelBatch(ctx, badID)
		var seCancel *ServiceError
		if !errors.As(cancelErr, &seCancel) || seCancel.HTTPStatus != http.StatusBadRequest || seCancel.Code != "INVALID_PARAMS" {
			t.Fatalf("CancelBatch(%d) expected 400 INVALID_PARAMS, got %v", badID, cancelErr)
		}
	}
}

func TestEnrichmentManager_GlobalLLMSemaphoreAcrossConcurrentBatches_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	var inflight atomic.Int32
	var maxInflight atomic.Int32
	startedCh := make(chan struct{}, 5)
	releaseGate := make(chan struct{})

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cur := inflight.Add(1)
		for {
			prev := maxInflight.Load()
			if cur <= prev || maxInflight.CompareAndSwap(prev, cur) {
				break
			}
		}
		defer inflight.Add(-1)

		select {
		case startedCh <- struct{}{}:
		default:
		}

		select {
		case <-releaseGate:
		case <-r.Context().Done():
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 10, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 30},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Done\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "2")

	var batchIDs []uint
	waitFalse := false
	for i := 0; i < 5; i++ {
		uid := "~01global" + string(rune('a'+i))
		j := dbservice.Job{UpworkJobID: &uid, Title: "Global Sem Job " + uid, Description: "Desc"}
		if err := gormDB.Create(&j).Error; err != nil {
			t.Fatalf("create job %d: %v", i, err)
		}
		res, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
			JobIDs: []any{j.ID},
			Mode:   "ai_only",
			Wait:   &waitFalse,
		})
		if err != nil {
			t.Fatalf("StartBatch %d failed: %v", i, err)
		}
		batchIDs = append(batchIDs, res.Batch.ID)
	}

	// Wait for 2 LLM requests to be inflight simultaneously.
	for i := 0; i < 2; i++ {
		select {
		case <-startedCh:
		case <-time.After(5 * time.Second):
			close(releaseGate)
			t.Fatalf("timed out waiting for LLM slot %d to start", i+1)
		}
	}

	// While 2 slots are busy, all 3 waiting batches must report queued_count == 1 && running_count == 0.
	deadline := time.Now().Add(2 * time.Second)
	for {
		runningBatches := 0
		waitingBatches := 0
		for _, id := range batchIDs {
			snap, err := mgr.GetBatch(context.Background(), id)
			if err != nil {
				close(releaseGate)
				t.Fatalf("GetBatch(%d) failed: %v", id, err)
			}
			if snap.Batch.RunningCount == 1 && snap.Batch.QueuedCount == 0 {
				runningBatches++
			} else if snap.Batch.QueuedCount == 1 && snap.Batch.RunningCount == 0 {
				waitingBatches++
			}
		}
		if runningBatches == 2 && waitingBatches == 3 {
			break
		}
		if time.Now().After(deadline) {
			close(releaseGate)
			t.Fatalf("expected 2 running and 3 queued batches while slots busy, got running=%d waiting=%d", runningBatches, waitingBatches)
		}
		time.Sleep(10 * time.Millisecond)
	}

	if got := inflight.Load(); got != 2 {
		close(releaseGate)
		t.Fatalf("expected inflight == 2 while gated, got %d", got)
	}

	close(releaseGate)

	// Wait for all 5 batches to complete cleanly.
	completeDeadline := time.Now().Add(5 * time.Second)
	for _, id := range batchIDs {
		for {
			snap, err := mgr.GetBatch(context.Background(), id)
			if err != nil {
				t.Fatalf("GetBatch(%d) failed: %v", id, err)
			}
			if snap.Batch.Status == EnrichmentBatchStatusCompleted {
				if snap.Batch.CompletedCount != 1 {
					t.Fatalf("expected completed_count=1 for batch %d, got %+v", id, snap.Batch)
				}
				break
			}
			if isTerminalBatchStatus(snap.Batch.Status) {
				t.Fatalf("unexpected terminal status for batch %d: %+v", id, snap.Batch)
			}
			if time.Now().After(completeDeadline) {
				t.Fatalf("timed out waiting for batch %d to complete (status=%s)", id, snap.Batch.Status)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	if got := maxInflight.Load(); got > 2 || got < 1 {
		t.Fatalf("expected 1 <= maxInflight <= 2, got %d", got)
	}
}

func TestEnrichmentManager_CancelWhileBlockedOnLLMSemaphore_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var callNum atomic.Int32

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if callNum.Add(1) == 1 {
			close(firstStarted)
			select {
			case <-releaseFirst:
			case <-r.Context().Done():
				return
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 10, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 30},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Done\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "1")

	var jobs []dbservice.Job
	for _, uid := range []string{"~01cansem1", "~01cansem2", "~01cansem3"} {
		u := uid
		j := dbservice.Job{UpworkJobID: &u, Title: "Cancel Sem " + uid, Description: "Desc", AIEnrichmentStatus: "none"}
		if err := gormDB.Create(&j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
		jobs = append(jobs, j)
	}

	waitFalse := false
	b1, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{JobIDs: []any{jobs[0].ID}, Mode: "ai_only", Wait: &waitFalse})
	if err != nil {
		t.Fatalf("StartBatch 1 failed: %v", err)
	}
	select {
	case <-firstStarted:
	case <-time.After(5 * time.Second):
		close(releaseFirst)
		t.Fatal("timed out waiting for batch 1 LLM call")
	}

	b2, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{JobIDs: []any{jobs[1].ID}, Mode: "ai_only", Wait: &waitFalse})
	if err != nil {
		close(releaseFirst)
		t.Fatalf("StartBatch 2 failed: %v", err)
	}
	b3, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{JobIDs: []any{jobs[2].ID}, Mode: "ai_only", Wait: &waitFalse})
	if err != nil {
		close(releaseFirst)
		t.Fatalf("StartBatch 3 failed: %v", err)
	}

	// Ensure b2 and b3 have started runBatch and are blocked on llmSem (still queued, not analyzing).
	deadline := time.Now().Add(2 * time.Second)
	for {
		s2, _ := mgr.GetBatch(context.Background(), b2.Batch.ID)
		s3, _ := mgr.GetBatch(context.Background(), b3.Batch.ID)
		if s2 != nil && s3 != nil && s2.Batch.Status == EnrichmentBatchStatusRunning && s3.Batch.Status == EnrichmentBatchStatusRunning {
			if s2.Batch.QueuedCount != 1 || s2.Batch.RunningCount != 0 {
				close(releaseFirst)
				t.Fatalf("expected blocked batch 2 to report queued_count=1 running_count=0, got %+v", s2.Batch)
			}
			break
		}
		if time.Now().After(deadline) {
			close(releaseFirst)
			t.Fatal("timed out waiting for batches 2 and 3 to enter running state")
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Cancel batch 2 while it is blocked waiting on llmSem.
	cancelRes, err := mgr.CancelBatch(context.Background(), b2.Batch.ID)
	if err != nil {
		close(releaseFirst)
		t.Fatalf("CancelBatch 2 failed: %v", err)
	}
	if cancelRes.Batch.Status != EnrichmentBatchStatusCanceled || cancelRes.Batch.CanceledCount != 1 {
		close(releaseFirst)
		t.Fatalf("expected batch 2 canceled with canceled_count=1, got %+v", cancelRes.Batch)
	}

	var j2Reloaded dbservice.Job
	if err := gormDB.First(&j2Reloaded, jobs[1].ID).Error; err != nil {
		close(releaseFirst)
		t.Fatalf("reload job 2: %v", err)
	}
	if j2Reloaded.AIEnrichmentStatus != "none" {
		close(releaseFirst)
		t.Fatalf("expected job 2 ai_enrichment_status restored to 'none', got %q", j2Reloaded.AIEnrichmentStatus)
	}

	// Unblock batch 1; batch 3 must acquire the released slot and complete without starvation.
	close(releaseFirst)

	completeDeadline := time.Now().Add(5 * time.Second)
	for _, id := range []uint{b1.Batch.ID, b3.Batch.ID} {
		for {
			snap, err := mgr.GetBatch(context.Background(), id)
			if err != nil {
				t.Fatalf("GetBatch(%d) failed: %v", id, err)
			}
			if snap.Batch.Status == EnrichmentBatchStatusCompleted {
				if snap.Batch.CompletedCount != 1 {
					t.Fatalf("expected completed_count=1 for batch %d, got %+v", id, snap.Batch)
				}
				break
			}
			if isTerminalBatchStatus(snap.Batch.Status) {
				t.Fatalf("unexpected terminal status for batch %d: %+v", id, snap.Batch)
			}
			if time.Now().After(completeDeadline) {
				t.Fatalf("timed out waiting for batch %d to complete (status=%s)", id, snap.Batch.Status)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
}

func TestEnrichmentManager_GlobalDetailSemaphoreAndSkipFastPath_WithDB(t *testing.T) {
	s := setupTestServerWithEnrichment(t)
	clearServerLLMEnv(t)
	clearEnrichmentEnv(t)
	gormDB := s.db.GetGorm()
	mgr := s.getEnrichmentManager()

	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"model": "gemini-pro-orchestrator-neon",
			"applied_effort": "medium",
			"usage": {"inputTokens": 10, "outputTokens": 20, "thoughtTokens": 0, "totalTokens": 30},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Done\",\"execution_prompt\":\"Go\",\"time_estimate\":\"1h\",\"workload_division\":\"50/50\",\"questions_for_client\":[],\"tips_and_advice\":[],\"tone_analysis\":\"Direct\"}"}
		}`))
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "4")

	var detailInflight atomic.Int32
	var maxDetailInflight atomic.Int32
	var detailCalls atomic.Int32
	firstDetailStarted := make(chan struct{})
	releaseFirstDetail := make(chan struct{})

	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method != "jobs.detail" {
			return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "method not found"}
		}
		cur := detailInflight.Add(1)
		for {
			prev := maxDetailInflight.Load()
			if cur <= prev || maxDetailInflight.CompareAndSwap(prev, cur) {
				break
			}
		}
		defer detailInflight.Add(-1)

		callIdx := detailCalls.Add(1)
		if callIdx == 1 {
			close(firstDetailStarted)
			<-releaseFirstDetail
		} else {
			time.Sleep(30 * time.Millisecond)
		}

		var p struct {
			UpworkJobID string `json:"upwork_job_id"`
			URL         string `json:"url"`
		}
		_ = json.Unmarshal(params, &p)
		return map[string]any{
			"ok": true,
			"job": map[string]any{
				"upwork_job_id":   p.UpworkJobID,
				"job_title":       "Serialized Detail Job",
				"job_description": "Scraped full description for " + p.UpworkJobID,
				"url":             p.URL,
			},
		}, nil
	})

	uid1, uid2, uid3 := "~01detsem1", "~01detsem2", "~01detsem3"
	now := time.Now().UTC()
	j1 := dbservice.Job{UpworkJobID: &uid1, Title: "Detail 1", Description: "Short 1", URL: "https://www.upwork.com/jobs/" + uid1 + "/"}
	j2 := dbservice.Job{UpworkJobID: &uid2, Title: "Detail 2", Description: "Short 2", URL: "https://www.upwork.com/jobs/" + uid2 + "/"}
	j3 := dbservice.Job{UpworkJobID: &uid3, Title: "Detail Skip 3", Description: "Full 3", URL: "https://www.upwork.com/jobs/" + uid3 + "/", LastEnrichedAt: &now}
	for _, j := range []*dbservice.Job{&j1, &j2, &j3} {
		if err := gormDB.Create(j).Error; err != nil {
			t.Fatalf("create job: %v", err)
		}
	}

	waitFalse := false
	b1, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{JobIDs: []any{j1.ID}, Mode: "detail_only", Wait: &waitFalse})
	if err != nil {
		close(releaseFirstDetail)
		t.Fatalf("StartBatch 1 failed: %v", err)
	}
	select {
	case <-firstDetailStarted:
	case <-time.After(5 * time.Second):
		close(releaseFirstDetail)
		t.Fatal("timed out waiting for first detail RPC")
	}

	// Start a second detail_only batch while b1 holds detailSem: it must serialize behind b1.
	b2, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{JobIDs: []any{j2.ID}, Mode: "detail_only", Wait: &waitFalse})
	if err != nil {
		close(releaseFirstDetail)
		t.Fatalf("StartBatch 2 failed: %v", err)
	}

	// Start a full batch with skip_detail_if_present=true on j3 (LastEnrichedAt set):
	// it must NOT contend on detailSem and must complete while b1 still holds detailSem.
	waitTrue := true
	skipTrue := true
	b3, err := mgr.StartBatch(context.Background(), BatchEnrichRequest{
		JobIDs:              []any{j3.ID},
		Mode:                "full",
		SkipDetailIfPresent: &skipTrue,
		Wait:                &waitTrue,
	})
	if err != nil {
		close(releaseFirstDetail)
		t.Fatalf("StartBatch 3 (skip_detail_if_present) failed: %v", err)
	}
	if !b3.Completed || b3.Batch.Status != EnrichmentBatchStatusCompleted || b3.Batch.CompletedCount != 1 {
		close(releaseFirstDetail)
		t.Fatalf("expected skipped-detail full batch to complete immediately while detailSem held, got %+v", b3.Batch)
	}
	if detailCalls.Load() != 1 {
		close(releaseFirstDetail)
		t.Fatalf("expected detailCalls == 1 while b1 holds detailSem, got %d", detailCalls.Load())
	}

	close(releaseFirstDetail)

	completeDeadline := time.Now().Add(5 * time.Second)
	for _, id := range []uint{b1.Batch.ID, b2.Batch.ID} {
		for {
			snap, err := mgr.GetBatch(context.Background(), id)
			if err != nil {
				t.Fatalf("GetBatch(%d) failed: %v", id, err)
			}
			if snap.Batch.Status == EnrichmentBatchStatusCompleted {
				break
			}
			if isTerminalBatchStatus(snap.Batch.Status) {
				t.Fatalf("unexpected terminal status for batch %d: %+v", id, snap.Batch)
			}
			if time.Now().After(completeDeadline) {
				t.Fatalf("timed out waiting for batch %d to complete (status=%s)", id, snap.Batch.Status)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	if got := maxDetailInflight.Load(); got != 1 {
		t.Fatalf("expected maxDetailInflight == 1, got %d", got)
	}
	if got := detailCalls.Load(); got != 2 {
		t.Fatalf("expected 2 detail calls total (j1 and j2 only), got %d", got)
	}
}
