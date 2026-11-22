package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/scoring"
)

func attachTestBridgeHub(t *testing.T, s *Server) (*httptest.Server, *bridge.Hub) {
	t.Helper()
	hub := bridge.NewHub(bridge.HubConfig{
		AuthTimeout:        2 * time.Second,
		DefaultCallTimeout: 5 * time.Second,
		PreAuthCheck: func(r *http.Request) bool {
			return s.AuthenticateWSRequest(r) == WSAuthAuthenticated
		},
		ValidateAuthFrame: s.ValidateWSAuthFrame,
		AllowOrigin:       s.IsAllowedOrigin,
	})
	t.Cleanup(func() { _ = hub.Close() })
	s.bridgeHub = hub
	s.wsHandler = hub

	srv := httptest.NewServer(s.RegisterRoutes())
	t.Cleanup(srv.Close)
	return srv, hub
}

func dialAuthenticatedMockExtension(
	t *testing.T,
	srv *httptest.Server,
	token string,
	rpcResponder func(method string, params json.RawMessage) (any, *bridge.WireRPCError),
) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/extension"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"chrome-extension://abcdefghijklmnop"}},
	})
	if err != nil {
		t.Fatalf("WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })

	authMsg := `{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":"` + token + `","extension_version":"2.0.0","browser":"chrome"}}`
	if err := conn.Write(ctx, websocket.MessageText, []byte(authMsg)); err != nil {
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
			encoded, _ := json.Marshal(reply)
			_ = conn.Write(ctx, websocket.MessageText, encoded)
		}
	}()

	// Wait until bridgeHub reports connected
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/session/status", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			var st bridge.BridgeStatus
			_ = json.NewDecoder(resp.Body).Decode(&st)
			resp.Body.Close()
			if st.ExtensionConnected {
				return
			}
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("timed out waiting for mock extension WS connection")
}

func TestDeduplicateAndFilterSaveJobRequests(t *testing.T) {
	reqs := []saveJobRequest{
		{
			JobTitle:       "Go Microservices",
			URL:            "https://www.upwork.com/jobs/Go-Microservices_~022111887415567641941/?referrer=1",
			Skills:         FlexibleSkills{Text: "Go, PostgreSQL", Slice: []string{"Go", "PostgreSQL"}},
			Budget:         "Fixed price",
			ContractType:   "fixed",
			JobDescription: "Short",
		},
		{
			JobTitle:       "Go Microservices",
			UpworkJobID:    "~022111887415567641941",
			JobDescription: "Detailed description requiring Go and PostgreSQL expertise for MCP servers.",
		},
		{
			JobTitle:     "Zero Budget Job",
			UpworkJobID:  "~022111887415567699999",
			Budget:       "$0",
			BudgetAmount: "$0",
			ContractType: "fixed",
			Proposals:    "5 to 10",
		},
	}

	deduped := deduplicateSaveJobRequests(reqs)
	if len(deduped) != 2 {
		t.Fatalf("expected 2 deduplicated jobs, got %d", len(deduped))
	}
	if !strings.Contains(deduped[0].JobDescription, "Detailed description") {
		t.Fatalf("expected richer description to merge, got %q", deduped[0].JobDescription)
	}

	// StagePreEnrichment keeps unknown budget ("Fixed price"); StagePostEnrichment drops unknown & keeps explicit $0 <= BudgetMax(0)
	zero := 0.0
	filters := scoring.FilterConfig{
		BudgetMax: &zero,
	}
	pre := filterSaveJobRequests(deduped, filters, scoring.StagePreEnrichment, nil)
	if len(pre) != 2 {
		t.Fatalf("expected StagePreEnrichment to retain unknown-budget candidate + $0 candidate, got %d", len(pre))
	}
	post := filterSaveJobRequests(deduped, filters, scoring.StagePostEnrichment, nil)
	if len(post) != 1 || post[0].UpworkJobID != "~022111887415567699999" {
		t.Fatalf("expected StagePostEnrichment to keep only explicit $0 job, got %+v", post)
	}
}

func TestSearchAndDetailEndpoints_DisconnectedAndHumanActionRequired(t *testing.T) {
	s := &Server{apiToken: "tok-disc"}
	srv, _ := attachTestBridgeHub(t, s)

	// 1. Disconnected extension -> 503 EXTENSION_DISCONNECTED
	for _, endpoint := range []struct {
		path string
		body string
	}{
		{"/api/jobs/search", `{"source":"search","query":"golang"}`},
		{"/api/jobs/detail", `{"url":"https://www.upwork.com/jobs/~0123/"}`},
	} {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+endpoint.path, strings.NewReader(endpoint.body))
		req.Header.Set("Authorization", "Bearer tok-disc")
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("request %s failed: %v", endpoint.path, err)
		}
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if resp.StatusCode != http.StatusServiceUnavailable || out["error_code"] != bridge.ErrCodeExtensionDisconnected {
			t.Fatalf("%s disconnected: status=%d body=%+v", endpoint.path, resp.StatusCode, out)
		}
	}

	// 2. Connected extension returning HUMAN_ACTION_REQUIRED -> 428 Precondition Required
	dialAuthenticatedMockExtension(t, srv, "tok-disc", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		return nil, &bridge.WireRPCError{
			Code:    json.RawMessage(`-32001`),
			Message: "Cloudflare challenge detected",
			Data:    json.RawMessage(`{"error_code":"HUMAN_ACTION_REQUIRED"}`),
		}
	})

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/search", strings.NewReader(`{"source":"search","query":"go"}`))
	req.Header.Set("Authorization", "Bearer tok-disc")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("search challenge request failed: %v", err)
	}
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if resp.StatusCode != http.StatusPreconditionRequired || out["error_code"] != bridge.ErrCodeHumanActionRequired {
		t.Fatalf("expected 428 HUMAN_ACTION_REQUIRED, got status=%d body=%+v", resp.StatusCode, out)
	}
}

func TestSearchPipeline_TwoStageEnrichmentWithMockBridge(t *testing.T) {
	s := &Server{apiToken: "tok-pipe"}
	srv, _ := attachTestBridgeHub(t, s)

	var seenMethods []string
	dialAuthenticatedMockExtension(t, srv, "tok-pipe", func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		seenMethods = append(seenMethods, method)
		if method == "jobs.search" {
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~01low",
						"canonical_url":   "https://www.upwork.com/jobs/Low_~01low/",
						"job_title":       "Low Fit Job",
						"job_description": "Need React",
						"budget":          "Fixed price",
						"contract_type":   "fixed",
						"skills":          "React",
					},
					{
						"upwork_job_id":   "~02high",
						"canonical_url":   "https://www.upwork.com/jobs/High_~02high/",
						"job_title":       "Senior Go Postgres MCP Engineer",
						"job_description": "Build Go backend and PostgreSQL pipelines",
						"rate_range":      "$60.00 - $80.00",
						"budget":          "$60.00 - $80.00/hr",
						"contract_type":   "hourly",
						"skills":          "Go, PostgreSQL, Docker",
						"client_spent":    "$50K",
					},
				},
			}, nil
		}
		if method == "jobs.detail" {
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":     "~02high",
						"canonical_url":     "https://www.upwork.com/jobs/High_~02high/",
						"job_title":         "Senior Go Postgres MCP Engineer",
						"proposals_tier":    "5 to 10",
						"proposals_count":   10,
						"connects_required": 8,
						"payment_verified":  true,
					},
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unknown method"}
	})

	body := `{"source":"search","query":"golang","enrich_top_n":1,"filters":{"max_proposals":15}}`
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/search", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok-pipe")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("search pipeline request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}
	var out SearchJobsResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode SearchJobsResponse: %v", err)
	}

	if out.TotalScraped != 2 || out.EnrichedCount != 1 {
		t.Fatalf("expected TotalScraped=2 EnrichedCount=1, got %+v", out)
	}
	// Stage 3 post-enrichment drops ~01low (unknown proposals) and retains ~02high (proposals=10 <= 15)
	if len(out.Jobs) != 1 || out.Jobs[0].UpworkJobID != "~02high" {
		t.Fatalf("expected only ~02high to survive Stage 3 max_proposals=15, got %+v", out.Jobs)
	}
	if len(seenMethods) != 2 || seenMethods[0] != "jobs.search" || seenMethods[1] != "jobs.detail" {
		t.Fatalf("expected jobs.search -> jobs.detail RPC order, got %v", seenMethods)
	}
}

func TestBatchIngestAndRunSearchProfile_WithDB(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	// 1. POST /api/jobs/batch deduplication + StagePreEnrichment + DB persistence
	batchReqBody := map[string]any{
		"filter_stage": "pre_enrichment",
		"sort_by_score": true,
		"filters": map[string]any{
			"required_keywords": []string{"golang"},
		},
		"jobs": []map[string]any{
			{
				"upwork_job_id":   "~03batch1",
				"canonical_url":   "https://www.upwork.com/jobs/Go_~03batch1/",
				"job_title":       "Golang Backend Engineer",
				"job_description": "Build APIs in Golang",
				"skills":          "Golang, PostgreSQL",
				"rate_range":      "$65 - $85",
				"budget":          "$65 - $85/hr",
				"contract_type":   "hourly",
			},
			{
				"upwork_job_id":   "~03batch1",
				"canonical_url":   "https://www.upwork.com/jobs/Go_~03batch1/",
				"job_title":       "Golang Backend Engineer",
				"job_description": "Build APIs in Golang with Docker and PostgreSQL",
				"client_spent":    "$25K",
			},
			{
				"upwork_job_id":   "~03batch2",
				"canonical_url":   "https://www.upwork.com/jobs/WordPress_~03batch2/",
				"job_title":       "WordPress Theme",
				"job_description": "Fix Elementor",
				"skills":          "WordPress",
			},
		},
	}
	batchBytes, _ := json.Marshal(batchReqBody)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/batch", bytes.NewReader(batchBytes))
	req.Header.Set("Authorization", "Bearer "+s.apiToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /api/jobs/batch failed: %v", err)
	}
	var batchOut batchIngestJobsResponse
	_ = json.NewDecoder(resp.Body).Decode(&batchOut)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || batchOut.TotalReceived != 3 || batchOut.DeduplicatedCount != 2 || batchOut.PersistedCount != 1 {
		t.Fatalf("unexpected batch response: status=%d out=%+v", resp.StatusCode, batchOut)
	}

	// 2. Create search profile and run POST /api/search-profiles/{id}/run
	profReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/search-profiles", strings.NewReader(`{
		"name": "go_profile_run_test",
		"config": { "search": { "mode": "live_search", "query": "golang", "max_pages": 1 } }
	}`))
	profReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	profReq.Header.Set("Content-Type", "application/json")
	profResp, err := http.DefaultClient.Do(profReq)
	if err != nil {
		t.Fatalf("create profile failed: %v", err)
	}
	var profCreated struct {
		Profile searchProfileEntry `json:"profile"`
	}
	_ = json.NewDecoder(profResp.Body).Decode(&profCreated)
	profResp.Body.Close()

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		return map[string]any{
			"ok":             true,
			"stopped_reason": "completed",
			"jobs": []map[string]any{
				{
					"upwork_job_id":   "~04prof1",
					"canonical_url":   "https://www.upwork.com/jobs/Prof_~04prof1/",
					"job_title":       "Profile Go Role",
					"job_description": "Go + Postgres",
					"skills":          "Go",
				},
			},
		}, nil
	})

	runReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/search-profiles/"+strconv.FormatUint(uint64(profCreated.Profile.ID), 10)+"/run", nil)
	runReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	runResp, err := http.DefaultClient.Do(runReq)
	if err != nil {
		t.Fatalf("run search profile failed: %v", err)
	}
	var runOut SearchJobsResponse
	_ = json.NewDecoder(runResp.Body).Decode(&runOut)
	runResp.Body.Close()
	if runResp.StatusCode != http.StatusOK || len(runOut.Jobs) != 1 || runOut.Jobs[0].UpworkJobID != "~04prof1" {
		t.Fatalf("unexpected profile run result: status=%d out=%+v", runResp.StatusCode, runOut)
	}
}

func TestBatchIngest_AtomicRollbackAndHourlyBudgetFilter_WithDB(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	// 1. Atomic rollback: [valid, invalid] returns 400 and persists 0 rows
	invalidBatch := map[string]any{
		"jobs": []map[string]any{
			{
				"upwork_job_id":   "~05valid",
				"canonical_url":   "https://www.upwork.com/jobs/Valid_~05valid/",
				"job_title":       "Valid First Item",
				"job_description": "Should be rolled back / pre-validated",
			},
			{
				"upwork_job_id":       "~05bad",
				"job_title":           "Malformed Second Item",
				"screening_questions": "not-valid-json",
			},
		},
	}
	invalidBytes, _ := json.Marshal(invalidBatch)
	badReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/batch", bytes.NewReader(invalidBytes))
	badReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	badReq.Header.Set("Content-Type", "application/json")
	badResp, err := http.DefaultClient.Do(badReq)
	if err != nil {
		t.Fatalf("POST /api/jobs/batch invalid failed: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request, got %d", badResp.StatusCode)
	}

	listReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/jobs", nil)
	listReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	listResp, err := http.DefaultClient.Do(listReq)
	if err != nil {
		t.Fatalf("GET /api/jobs failed: %v", err)
	}
	var listed listJobsResponse
	_ = json.NewDecoder(listResp.Body).Decode(&listed)
	listResp.Body.Close()
	if len(listed.Jobs) != 0 {
		t.Fatalf("expected 0 persisted rows after 400 batch failure, got %d: %+v", len(listed.Jobs), listed.Jobs)
	}

	// 2. StagePostEnrichment with budget_max: 100 retains $60-$80/hr hourly job while dropping unknown-budget fixed job
	hourlyBatch := map[string]any{
		"filter_stage": "post_enrichment",
		"filters": map[string]any{
			"budget_max": 100,
		},
		"jobs": []map[string]any{
			{
				"upwork_job_id":   "~06hourly",
				"canonical_url":   "https://www.upwork.com/jobs/Hourly_~06hourly/",
				"job_title":       "Hourly Go Architect",
				"job_description": "Go + Postgres",
				"contract_type":   "hourly",
				"rate_range":      "$60.00 - $80.00",
				"budget":          "$60.00 - $80.00/hr",
			},
			{
				"upwork_job_id":   "~06unknownfixed",
				"canonical_url":   "https://www.upwork.com/jobs/Unknown_~06unknownfixed/",
				"job_title":       "Unknown Fixed Budget Job",
				"job_description": "Go + Postgres",
				"contract_type":   "fixed",
				"budget":          "Fixed price",
			},
		},
	}
	hourlyBytes, _ := json.Marshal(hourlyBatch)
	hReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/batch", bytes.NewReader(hourlyBytes))
	hReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	hReq.Header.Set("Content-Type", "application/json")
	hResp, err := http.DefaultClient.Do(hReq)
	if err != nil {
		t.Fatalf("POST /api/jobs/batch hourly failed: %v", err)
	}
	var hOut batchIngestJobsResponse
	_ = json.NewDecoder(hResp.Body).Decode(&hOut)
	hResp.Body.Close()
	if hResp.StatusCode != http.StatusOK || hOut.FilteredCount != 1 || len(hOut.Jobs) != 1 || hOut.Jobs[0].UpworkJobID != "~06hourly" {
		t.Fatalf("expected only ~06hourly to survive StagePostEnrichment budget_max=100, got status=%d out=%+v", hResp.StatusCode, hOut)
	}
}

func TestSearchPipeline_ExplicitEnrichTopNZeroAndDetailDisconnect(t *testing.T) {
	// 1. Explicit enrich_top_n: 0 must NOT invoke jobs.detail even when max_proposals is set and proposals are missing
	s1 := &Server{apiToken: "tok-zero"}
	srv1, _ := attachTestBridgeHub(t, s1)

	detailCalled := 0
	dialAuthenticatedMockExtension(t, srv1, "tok-zero", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~07noprop",
						"canonical_url":   "https://www.upwork.com/jobs/NoProp_~07noprop/",
						"job_title":       "Go Backend Job",
						"job_description": "Go + Postgres",
					},
				},
			}, nil
		}
		if method == "jobs.detail" {
			detailCalled++
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unexpected"}
	})

	reqZero, _ := http.NewRequest(http.MethodPost, srv1.URL+"/api/jobs/search", strings.NewReader(`{"source":"search","query":"go","enrich_top_n":0,"filters":{"max_proposals":15}}`))
	reqZero.Header.Set("Authorization", "Bearer tok-zero")
	reqZero.Header.Set("Content-Type", "application/json")
	respZero, err := http.DefaultClient.Do(reqZero)
	if err != nil {
		t.Fatalf("POST /api/jobs/search enrich_top_n=0 failed: %v", err)
	}
	respZero.Body.Close()
	if respZero.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", respZero.StatusCode)
	}
	if detailCalled != 0 {
		t.Fatalf("expected jobs.detail to be called 0 times when enrich_top_n=0, got %d", detailCalled)
	}

	// 2. Mid-pipeline disconnect on jobs.detail propagates 503 EXTENSION_DISCONNECTED
	s2 := &Server{apiToken: "tok-mid-disc"}
	srv2, hub2 := attachTestBridgeHub(t, s2)
	dialAuthenticatedMockExtension(t, srv2, "tok-mid-disc", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~08disc",
						"canonical_url":   "https://www.upwork.com/jobs/Disc_~08disc/",
						"job_title":       "Go Job",
						"job_description": "Go + Postgres",
					},
				},
			}, nil
		}
		if method == "jobs.detail" {
			// Close the hub so CallExtension returns ErrExtensionDisconnected mid-pipeline
			_ = hub2.Close()
			return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32000`), Message: "closing"}
		}
		return nil, nil
	})

	reqDisc, _ := http.NewRequest(http.MethodPost, srv2.URL+"/api/jobs/search", strings.NewReader(`{"source":"search","query":"go","enrich_top_n":1}`))
	reqDisc.Header.Set("Authorization", "Bearer tok-mid-disc")
	reqDisc.Header.Set("Content-Type", "application/json")
	respDisc, err := http.DefaultClient.Do(reqDisc)
	if err != nil {
		t.Fatalf("POST /api/jobs/search disconnect probe failed: %v", err)
	}
	var discOut map[string]any
	_ = json.NewDecoder(respDisc.Body).Decode(&discOut)
	respDisc.Body.Close()
	if respDisc.StatusCode != http.StatusServiceUnavailable || discOut["error_code"] != bridge.ErrCodeExtensionDisconnected {
		t.Fatalf("expected 503 EXTENSION_DISCONNECTED on mid-pipeline jobs.detail disconnect, got status=%d body=%+v", respDisc.StatusCode, discOut)
	}
}

func TestConcurrentBatchAndSearchIngest_WithDB(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	makeJobA := func(wave2 bool) map[string]any {
		m := map[string]any{
			"upwork_job_id":   "~0199990701",
			"canonical_url":   "https://www.upwork.com/jobs/Legacy_~0199990701/",
			"job_title":       "Legacy WordPress Fix",
			"job_description": "Small CSS tweak",
			"skills":          "WordPress",
		}
		if wave2 {
			m["job_description"] = "Small CSS tweak and minor header spacing fix in WordPress"
			m["proposals_tier"] = "5 to 10"
			m["proposals_count"] = 7
		}
		return m
	}
	makeJobB := func(wave2 bool) map[string]any {
		m := map[string]any{
			"upwork_job_id":   "~0199990702",
			"canonical_url":   "https://www.upwork.com/jobs/GoMCP_~0199990702/",
			"job_title":       "Senior Go PostgreSQL Docker Architect",
			"job_description": "Build Go backend services and PostgreSQL pipelines with Docker",
			"skills":          "Go, PostgreSQL, Docker",
			"rate_range":      "$65.00 - $85.00",
			"budget":          "$65.00 - $85.00/hr",
			"contract_type":   "hourly",
			"client_spent":    "$50K",
		}
		if wave2 {
			m["job_description"] = "Build Go backend services, MCP servers, and PostgreSQL pipelines with Docker and Kubernetes"
			m["proposals_tier"] = "5 to 10"
			m["proposals_count"] = 7
		}
		return m
	}

	var wave2Flag atomic.Bool
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			isW2 := wave2Flag.Load()
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					makeJobA(isW2),
					makeJobB(isW2),
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unexpected method"}
	})

	runWave := func(phase string, isW2 bool) {
		t.Helper()
		const totalWorkers = 16
		start := make(chan struct{})
		var wg sync.WaitGroup
		statuses := make([]int, totalWorkers)
		bodies := make([]string, totalWorkers)
		gotIDs := make([][]string, totalWorkers)
		reqErrs := make([]error, totalWorkers)

		for i := 0; i < totalWorkers; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				<-start

				var endpoint string
				var payload []byte
				if idx < 10 {
					endpoint = "/api/jobs/batch"
					var jobs []map[string]any
					if idx%2 == 0 {
						jobs = []map[string]any{makeJobA(isW2), makeJobB(isW2)}
					} else {
						jobs = []map[string]any{makeJobB(isW2), makeJobA(isW2)}
					}
					payload, _ = json.Marshal(map[string]any{"jobs": jobs})
				} else {
					endpoint = "/api/jobs/search"
					payload = []byte(`{"source":"search","query":"golang","enrich_top_n":0}`)
				}

				req, _ := http.NewRequest(http.MethodPost, srv.URL+endpoint, bytes.NewReader(payload))
				req.Header.Set("Authorization", "Bearer "+s.apiToken)
				req.Header.Set("Content-Type", "application/json")
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					reqErrs[idx] = err
					return
				}
				rawBody, rErr := io.ReadAll(resp.Body)
				resp.Body.Close()
				statuses[idx] = resp.StatusCode
				bodies[idx] = string(rawBody)
				if rErr != nil {
					reqErrs[idx] = rErr
					return
				}
				if resp.StatusCode != http.StatusOK {
					return
				}

				var parsed struct {
					Jobs []jobEntry `json:"jobs"`
				}
				if uErr := json.Unmarshal(rawBody, &parsed); uErr != nil {
					reqErrs[idx] = fmt.Errorf("unmarshal %s: %w", endpoint, uErr)
					return
				}
				ids := make([]string, 0, len(parsed.Jobs))
				for _, j := range parsed.Jobs {
					ids = append(ids, j.UpworkJobID)
				}
				gotIDs[idx] = ids
			}(i)
		}

		close(start)
		wg.Wait()

		for i := 0; i < totalWorkers; i++ {
			if reqErrs[i] != nil {
				t.Fatalf("[%s] worker %d error: %v", phase, i, reqErrs[i])
			}
			if statuses[i] != http.StatusOK {
				t.Fatalf("[%s] worker %d status=%d body=%s", phase, i, statuses[i], bodies[i])
			}
			var expected []string
			if i < 10 && i%2 == 0 {
				expected = []string{"~0199990701", "~0199990702"}
			} else {
				expected = []string{"~0199990702", "~0199990701"}
			}
			if len(gotIDs[i]) != 2 || gotIDs[i][0] != expected[0] || gotIDs[i][1] != expected[1] {
				t.Fatalf("[%s] worker %d order mismatch: got=%v want=%v", phase, i, gotIDs[i], expected)
			}
		}
	}

	// Wave 1: concurrent brand-new inserts
	runWave("wave1-insert", false)

	listJobs := func() []jobEntry {
		t.Helper()
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/jobs", nil)
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("GET /api/jobs failed: %v", err)
		}
		defer resp.Body.Close()
		var out listJobsResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			t.Fatalf("decode listJobsResponse: %v", err)
		}
		return out.Jobs
	}

	w1Jobs := listJobs()
	if len(w1Jobs) != 2 {
		t.Fatalf("Wave 1 expected 2 deduplicated rows, got %d: %+v", len(w1Jobs), w1Jobs)
	}
	scoresByID := make(map[string]int, 2)
	for _, j := range w1Jobs {
		if j.Score != nil {
			scoresByID[j.UpworkJobID] = *j.Score
		}
	}
	if scoresByID["~0199990702"] <= scoresByID["~0199990701"] {
		t.Fatalf("expected jobB (~0199990702) score > jobA (~0199990701) score, got %+v", scoresByID)
	}

	// Wave 2: concurrent overlapping updates on existing rows
	wave2Flag.Store(true)
	runWave("wave2-update", true)

	w2Jobs := listJobs()
	if len(w2Jobs) != 2 {
		t.Fatalf("Wave 2 expected 2 deduplicated rows, got %d: %+v", len(w2Jobs), w2Jobs)
	}
	for _, j := range w2Jobs {
		if j.ProposalsTier != "5 to 10" {
			t.Fatalf("expected Wave 2 proposals_tier='5 to 10' on %s, got %q", j.UpworkJobID, j.ProposalsTier)
		}
	}
}

func TestBatchIngest_Validation400VsDBError500_WithDB(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	if _, err := s.db.GetDB().Exec(`ALTER TABLE jobs ADD CONSTRAINT chk_test_no_force_err CHECK (title <> '__FORCE_DB_ERROR__')`); err != nil {
		t.Fatalf("add test check constraint: %v", err)
	}

	assertZeroJobs := func(label string) {
		t.Helper()
		listReq := httptest.NewRequest(http.MethodGet, "/api/jobs", nil)
		listReq.Header.Set("Authorization", "Bearer "+s.apiToken)
		listW := httptest.NewRecorder()
		router.ServeHTTP(listW, listReq)
		if listW.Result().StatusCode != http.StatusOK {
			t.Fatalf("[%s] GET /api/jobs status=%d", label, listW.Result().StatusCode)
		}
		var listed listJobsResponse
		if err := json.NewDecoder(listW.Body).Decode(&listed); err != nil {
			t.Fatalf("[%s] decode listJobsResponse: %v", label, err)
		}
		if len(listed.Jobs) != 0 {
			t.Fatalf("[%s] expected 0 persisted rows after atomic rollback, got %d: %+v", label, len(listed.Jobs), listed.Jobs)
		}
	}

	// 1. Pre-validation failure -> 400 Bad Request + 0 persisted rows
	valBody := `{
		"jobs": [
			{
				"upwork_job_id": "~09val1",
				"canonical_url": "https://www.upwork.com/jobs/Val1_~09val1/",
				"job_title": "Valid Item Before Validation Failure",
				"job_description": "Go backend"
			},
			{
				"upwork_job_id": "~09val2",
				"job_title": "Malformed JSONB Item",
				"screening_questions": "not-valid-json"
			}
		]
	}`
	valReq := httptest.NewRequest(http.MethodPost, "/api/jobs/batch", strings.NewReader(valBody))
	valReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	valReq.Header.Set("Content-Type", "application/json")
	valW := httptest.NewRecorder()
	router.ServeHTTP(valW, valReq)
	if valW.Result().StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 Bad Request for validation failure, got %d body=%s", valW.Result().StatusCode, valW.Body.String())
	}
	assertZeroJobs("validation-400")

	// 2. DB CHECK constraint failure inside transaction -> 500 Internal Server Error + 0 persisted rows
	dbBody := `{
		"jobs": [
			{
				"upwork_job_id": "~09db1",
				"canonical_url": "https://www.upwork.com/jobs/DB1_~09db1/",
				"job_title": "Valid Before DB Fail",
				"job_description": "Should roll back atomically"
			},
			{
				"upwork_job_id": "~09db2",
				"canonical_url": "https://www.upwork.com/jobs/DB2_~09db2/",
				"job_title": "__FORCE_DB_ERROR__",
				"job_description": "Triggers SQLSTATE 23514"
			}
		]
	}`
	dbReq := httptest.NewRequest(http.MethodPost, "/api/jobs/batch", strings.NewReader(dbBody))
	dbReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	dbReq.Header.Set("Content-Type", "application/json")
	dbW := httptest.NewRecorder()
	router.ServeHTTP(dbW, dbReq)
	if dbW.Result().StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 Internal Server Error for DB constraint failure, got %d body=%s", dbW.Result().StatusCode, dbW.Body.String())
	}
	assertZeroJobs("db-check-500")

	// 3. Postgres SQLSTATE 22021 (NUL byte) inside transaction -> 500 Internal Server Error + 0 persisted rows
	nulBody := `{
		"jobs": [
			{
				"upwork_job_id": "~09nul1",
				"canonical_url": "https://www.upwork.com/jobs/Nul1_~09nul1/",
				"job_title": "Valid Before NUL Fail",
				"job_description": "Should roll back atomically"
			},
			{
				"upwork_job_id": "~09nul2",
				"canonical_url": "https://www.upwork.com/jobs/Nul2_~09nul2/",
				"job_title": "Bad\u0000Title",
				"job_description": "Triggers SQLSTATE 22021"
			}
		]
	}`
	nulReq := httptest.NewRequest(http.MethodPost, "/api/jobs/batch", strings.NewReader(nulBody))
	nulReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	nulReq.Header.Set("Content-Type", "application/json")
	nulW := httptest.NewRecorder()
	router.ServeHTTP(nulW, nulReq)
	if nulW.Result().StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500 Internal Server Error for SQLSTATE 22021 NUL byte, got %d body=%s", nulW.Result().StatusCode, nulW.Body.String())
	}
	assertZeroJobs("db-nul-500")
}

func TestExecuteSearchPipeline_MinScoreBudgetAndTopLevelFiltersForwarded(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var seenSearchParams atomic.Value
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			seenSearchParams.Store(p)
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~01lowscore",
						"canonical_url":   "https://www.upwork.com/jobs/Low_~01lowscore/",
						"job_title":       "Tiny CSS Task",
						"job_description": "Tiny tweak",
						"budget":          "Fixed price",
						"contract_type":   "fixed",
						"proposals":       "50+",
					},
					{
						"upwork_job_id":    "~02highscore",
						"canonical_url":    "https://www.upwork.com/jobs/High_~02highscore/",
						"job_title":        "Senior Go PostgreSQL Docker Architect",
						"job_description":  strings.Repeat("Go PostgreSQL Docker AWS microservices architecture. ", 15),
						"budget":           "$2,000",
						"budget_amount":    "$2,000",
						"contract_type":    "fixed",
						"skills":           []string{"Go", "PostgreSQL", "Docker", "AWS"},
						"proposals":        "Less than 5",
						"client_spent":     "$150K",
						"client_hires":     25,
						"payment_verified": true,
					},
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unexpected"}
	})

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/search", strings.NewReader(`{
		"source": "search",
		"query": "golang",
		"amount": "500-5000",
		"filters": {"min_score": 70}
	}`))
	req.Header.Set("Authorization", "Bearer "+s.apiToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /api/jobs/search: %v", err)
	}
	var out SearchJobsResponse
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", resp.StatusCode)
	}

	sp, _ := seenSearchParams.Load().(map[string]any)
	wsFilters, _ := sp["filters"].(map[string]any)
	if wsFilters == nil || wsFilters["budget_min"] != float64(500) || wsFilters["budget_max"] != float64(5000) {
		t.Fatalf("expected wsParams.filters to include folded budget_min=500 & budget_max=5000, got %+v", sp)
	}

	if len(out.Jobs) != 1 || out.Jobs[0].UpworkJobID != "~02highscore" {
		t.Fatalf("expected only ~02highscore to survive min_score=70 & budget_min=500, got %+v", out.Jobs)
	}
}

func TestExecuteSearchPipeline_Stage3ChallengePreservesStage2Jobs(t *testing.T) {
	s := setupTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~03stage2",
						"canonical_url":   "https://www.upwork.com/jobs/Stage2_~03stage2/",
						"job_title":       "Go Backend Role",
						"job_description": "Go + PostgreSQL",
					},
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{
			Code:    json.RawMessage(`-32001`),
			Message: "Challenge on detail",
			Data:    json.RawMessage(`{"error_code":"HUMAN_ACTION_REQUIRED"}`),
		}
	})

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/search", strings.NewReader(`{"source":"search","query":"go","enrich_top_n":1}`))
	req.Header.Set("Authorization", "Bearer "+s.apiToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /api/jobs/search: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("expected 428 HUMAN_ACTION_REQUIRED, got %d", resp.StatusCode)
	}

	jobs, listErr := s.ListJobs(context.Background(), ListJobsFilter{})
	if listErr != nil || len(jobs) != 1 || jobs[0].UpworkJobID != "~03stage2" {
		t.Fatalf("expected Stage 2 job ~03stage2 to be persisted before Stage 3 challenge halt, got %+v (err=%v)", jobs, listErr)
	}
}

func TestExecuteDetailEnrich_NegativeMaxJobsRejected(t *testing.T) {
	s := &Server{apiToken: "tok-neg"}
	srv, _ := attachTestBridgeHub(t, s)
	dialAuthenticatedMockExtension(t, srv, "tok-neg", func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		return map[string]any{"ok": true}, nil
	})

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/jobs/detail", strings.NewReader(`{"urls":["https://www.upwork.com/jobs/~0123/"],"max_jobs":-5}`))
	req.Header.Set("Authorization", "Bearer tok-neg")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /api/jobs/detail: %v", err)
	}
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest || out["error_code"] != "INVALID_PARAMS" {
		t.Fatalf("expected 400 INVALID_PARAMS for negative max_jobs, got status=%d body=%+v", resp.StatusCode, out)
	}
}

func TestComputeSearchRPCTimeout(t *testing.T) {
	if got := computeSearchRPCTimeout(1, 1); got != 2*time.Minute {
		t.Fatalf("1x1 timeout = %v, want 2m", got)
	}
	if got := computeSearchRPCTimeout(3, 2); got != 3*time.Minute {
		t.Fatalf("3x2 timeout = %v, want 3m", got)
	}
	if got := computeSearchRPCTimeout(10, 5); got != 4*time.Minute+30*time.Second {
		t.Fatalf("10x5 timeout = %v, want 4m30s", got)
	}
}

func TestDeriveQueriesFromActiveProjects_NDASafety_WithDB(t *testing.T) {
	s := setupTestServer(t)
	gormDB := s.db.GetGorm()

	now := time.Now().UTC()
	projects := []dbservice.ActiveProject{
		{
			ProjectKey:         "pub-active-1",
			Name:               "FORBIDDEN_PUB_NAME",
			Path:               "/var/www/forbidden-pub-path",
			GroupName:          "forbidden-pub-group",
			ActivityTier:       "active",
			Status:             "active",
			Client:             "FORBIDDEN_PUB_CLIENT",
			ProposalVisibility: "public",
			PublicAlias:        "FORBIDDEN_PUB_ALIAS",
			TechStackJSON:      dbservice.JSONB(`["Go","PostgreSQL","Docker"]`),
			Summary:            "FORBIDDEN_PUB_SUMMARY",
			ReadmeHint:         "FORBIDDEN_PUB_README",
			Pinned:             true,
			LastActivityAt:     &now,
		},
		{
			ProjectKey:         "anon-active-2",
			Name:               "FORBIDDEN_ANON_NAME",
			Path:               "/var/www/forbidden-anon-path",
			GroupName:          "forbidden-anon-group",
			ActivityTier:       "active",
			Status:             "active",
			Client:             "FORBIDDEN_ANON_CLIENT",
			ProposalVisibility: "anonymized",
			PublicAlias:        "FORBIDDEN_ANON_ALIAS",
			TechStackJSON:      dbservice.JSONB(`["TypeScript","Playwright"]`),
			Summary:            "FORBIDDEN_ANON_SUMMARY",
			ReadmeHint:         "FORBIDDEN_ANON_README",
		},
		{
			ProjectKey:         "private-stealth",
			Name:               "FORBIDDEN_PRIVATE_NAME",
			Path:               "/var/www/forbidden-private-path",
			GroupName:          "forbidden-private-group",
			ActivityTier:       "active",
			Status:             "active",
			Client:             "FORBIDDEN_PRIVATE_CLIENT",
			ProposalVisibility: "private",
			PublicAlias:        "FORBIDDEN_PRIVATE_ALIAS",
			TechStackJSON:      dbservice.JSONB(`["StealthSecretStack","Rust"]`),
			Summary:            "FORBIDDEN_PRIVATE_SUMMARY",
			ReadmeHint:         "FORBIDDEN_PRIVATE_README",
			Pinned:             true,
		},
		{
			ProjectKey:         "tier-archived",
			Name:               "FORBIDDEN_TIER_ARCHIVED",
			ActivityTier:       "archived",
			Status:             "active",
			ProposalVisibility: "public",
			TechStackJSON:      dbservice.JSONB(`["ArchivedTierStack"]`),
		},
		{
			ProjectKey:         "status-archived",
			Name:               "FORBIDDEN_STATUS_ARCHIVED",
			ActivityTier:       "active",
			Status:             "archived",
			ProposalVisibility: "public",
			TechStackJSON:      dbservice.JSONB(`["ArchivedStatusStack"]`),
		},
		{
			ProjectKey:         "recent-proj",
			Name:               "FORBIDDEN_RECENT_NAME",
			ActivityTier:       "recent",
			Status:             "active",
			ProposalVisibility: "anonymized",
			TechStackJSON:      dbservice.JSONB(`["Next.js","Prisma"]`),
		},
		{
			ProjectKey:         "empty-stack-active",
			Name:               "FORBIDDEN_EMPTY_STACK",
			ActivityTier:       "active",
			Status:             "active",
			ProposalVisibility: "public",
			TechStackJSON:      dbservice.JSONB(`[]`),
		},
	}
	for i := range projects {
		if err := gormDB.Create(&projects[i]).Error; err != nil {
			t.Fatalf("seed project %s: %v", projects[i].ProjectKey, err)
		}
	}

	// 1. Default tiers (nil, nil) -> only active non-private non-archived with non-empty tech stack
	queries, matchedKeys, err := deriveQueriesFromActiveProjects(gormDB, nil, nil)
	if err != nil {
		t.Fatalf("deriveQueriesFromActiveProjects default failed: %v", err)
	}
	if len(queries) != 2 || queries[0] != "Go PostgreSQL" || queries[1] != "TypeScript Playwright" {
		t.Fatalf("unexpected default derived queries: %+v", queries)
	}
	if len(matchedKeys) != 2 || matchedKeys[0] != "pub-active-1" || matchedKeys[1] != "anon-active-2" {
		t.Fatalf("unexpected default matchedKeys: %+v", matchedKeys)
	}

	// Explicit negative NDA assertions
	joined := strings.Join(queries, " | ")
	for _, forbidden := range []string{
		"FORBIDDEN_",
		"forbidden-",
		"StealthSecretStack",
		"ArchivedTierStack",
		"ArchivedStatusStack",
		"pub-active-1",
		"anon-active-2",
		"private-stealth",
		"Next.js",
	} {
		if strings.Contains(joined, forbidden) {
			t.Fatalf("NDA leak detected: forbidden token %q appeared in queries %q", forbidden, joined)
		}
	}

	// 2. Explicit tiers=["active","recent"] includes recent-proj
	tierQueries, tierKeys, err := deriveQueriesFromActiveProjects(gormDB, nil, []string{"active", "recent"})
	if err != nil {
		t.Fatalf("deriveQueriesFromActiveProjects with tiers failed: %v", err)
	}
	if len(tierQueries) != 3 || tierQueries[2] != "Next.js Prisma" {
		t.Fatalf("expected recent project query included, got %+v", tierQueries)
	}
	if len(tierKeys) != 3 {
		t.Fatalf("expected 3 matched keys, got %+v", tierKeys)
	}

	// 3. Explicit keys filter (private-stealth still excluded even when explicitly requested!)
	keyQueries, keyMatched, err := deriveQueriesFromActiveProjects(gormDB, []string{"anon-active-2", "private-stealth"}, nil)
	if err != nil {
		t.Fatalf("deriveQueriesFromActiveProjects with keys failed: %v", err)
	}
	if len(keyQueries) != 1 || keyQueries[0] != "TypeScript Playwright" {
		t.Fatalf("expected only anon-active-2 query, got %+v", keyQueries)
	}
	if len(keyMatched) != 1 || keyMatched[0] != "anon-active-2" {
		t.Fatalf("expected only anon-active-2 key, got %+v", keyMatched)
	}
}

func TestExecuteSearchPipeline_CriteriaForwardingAndSkipAutoDetailEnrich(t *testing.T) {
	s := &Server{apiToken: "tok-crit"}
	srv, _ := attachTestBridgeHub(t, s)

	var detailCalls atomic.Int32
	var seenSearchParams atomic.Value
	dialAuthenticatedMockExtension(t, srv, "tok-crit", func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.detail" {
			detailCalls.Add(1)
			return map[string]any{"ok": true, "jobs": []any{}}, nil
		}
		if method == "jobs.search" {
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			seenSearchParams.Store(p)
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":    "~01hourlyok",
						"canonical_url":    "https://www.upwork.com/jobs/Hourly-OK_~01hourlyok/",
						"job_title":        "Go Hourly Engineer",
						"job_description":  "Build Go services",
						"contract_type":    "hourly",
						"rate_range":       "$75 - $110/hr",
						"proposals":        "Less than 5",
						"payment_verified": true,
					},
					{
						"upwork_job_id":    "~02unverified",
						"canonical_url":    "https://www.upwork.com/jobs/Unverified_~02unverified/",
						"job_title":        "Unverified Hourly",
						"job_description":  "Build Go services",
						"contract_type":    "hourly",
						"rate_range":       "$80 - $100/hr",
						"payment_verified": false,
					},
					{
						"upwork_job_id":    "~03lowrate",
						"canonical_url":    "https://www.upwork.com/jobs/Low-Rate_~03lowrate/",
						"job_title":        "Low Rate Hourly",
						"job_description":  "Build Go services",
						"contract_type":    "hourly",
						"rate_range":       "$25 - $40/hr",
						"payment_verified": true,
					},
					{
						"upwork_job_id":    "~04missingprops",
						"canonical_url":    "https://www.upwork.com/jobs/Missing-Props_~04missingprops/",
						"job_title":        "Hourly Missing Proposals",
						"job_description":  "Build Go services",
						"contract_type":    "hourly",
						"rate_range":       "$80 - $110/hr",
						"payment_verified": true,
					},
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unexpected"}
	})

	// 1. Inverted hourly_rate_min > hourly_rate_max fails fast with 400 INVALID_PARAMS before calling Chrome
	minHigh := 120.0
	maxLow := 60.0
	_, badErr := s.ExecuteSearchPipeline(context.Background(), SearchJobsRequest{
		Source:        "search",
		Query:         "go",
		HourlyRateMin: &minHigh,
		HourlyRateMax: &maxLow,
	})
	var se *ServiceError
	if !errors.As(badErr, &se) || se.HTTPStatus != http.StatusBadRequest || se.Code != "INVALID_PARAMS" {
		t.Fatalf("expected 400 INVALID_PARAMS for inverted hourly rates, got %v", badErr)
	}

	// 2. Valid hourly_rate_min, hourly_rate_max, payment_verified_only, skip_auto_detail_enrich=true (even with max_proposals=15 & missing proposals)
	rateMin := 70.0
	rateMax := 130.0
	payVerified := true
	maxProps := 15
	res, err := s.ExecuteSearchPipeline(context.Background(), SearchJobsRequest{
		Source:               "search",
		Query:                "go",
		HourlyRateMin:        &rateMin,
		HourlyRateMax:        &rateMax,
		PaymentVerifiedOnly:  &payVerified,
		SkipAutoDetailEnrich: true,
		Filters: &scoring.FilterConfig{
			MaxProposals: &maxProps,
		},
	})
	if err != nil {
		t.Fatalf("ExecuteSearchPipeline failed: %v", err)
	}
	if detailCalls.Load() != 0 {
		t.Fatalf("expected 0 jobs.detail calls when skip_auto_detail_enrich=true, got %d", detailCalls.Load())
	}
	sp, _ := seenSearchParams.Load().(map[string]any)
	if sp["hourly_rate_min"] != float64(70) || sp["hourly_rate_max"] != float64(130) || sp["payment_verified_only"] != true {
		t.Fatalf("expected hourly_rate_min/max & payment_verified_only forwarded in wsParams, got %+v", sp)
	}
	if len(res.Jobs) != 1 || res.Jobs[0].UpworkJobID != "~01hourlyok" {
		t.Fatalf("expected only ~01hourlyok to survive hourly rate & payment_verified filters, got %+v", res.Jobs)
	}
}

func TestExecuteSearchPipeline_PaymentVerifiedOnlyKeepsNilBadgeCardsWithoutDetailEnrich(t *testing.T) {
	s := NewServerWithDeps(ServerDeps{APIToken: "test-tok"})
	srv, _ := attachTestBridgeHub(t, s)

	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, _ json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~01nilbadge",
						"canonical_url":   "https://www.upwork.com/jobs/Nil-Badge_~01nilbadge/",
						"job_title":       "Go Backend Engineer",
						"job_description": "Go and PostgreSQL",
						"contract_type":   "hourly",
						"rate_range":      "$80 - $100/hr",
					},
					{
						"upwork_job_id":    "~02explicitfalse",
						"canonical_url":    "https://www.upwork.com/jobs/Unverified_~02explicitfalse/",
						"job_title":        "Unverified Client Job",
						"job_description":  "Go and PostgreSQL",
						"contract_type":    "hourly",
						"rate_range":       "$80 - $100/hr",
						"payment_verified": false,
					},
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unexpected"}
	})

	payVerified := true
	res, err := s.ExecuteSearchPipeline(context.Background(), SearchJobsRequest{
		Source:               "search",
		Query:                "golang",
		PaymentVerifiedOnly:  &payVerified,
		SkipAutoDetailEnrich: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSearchPipeline failed: %v", err)
	}
	if len(res.Jobs) != 1 || res.Jobs[0].UpworkJobID != "~01nilbadge" {
		t.Fatalf("expected nil-badge card from native payment_verified=1 search to survive and explicit false to be dropped, got %+v", res.Jobs)
	}
}

func TestSearchAndBatchIngest_SearchRunProvenance_WithDB(t *testing.T) {
	s := setupTestServer(t)
	s.port = 9095
	t.Setenv("WEB_UI_ENABLED", "true")
	srv, _ := attachTestBridgeHub(t, s)
	gormDB := s.db.GetGorm()

	// Seed 1 public active project and 1 private project
	if err := gormDB.Create(&dbservice.ActiveProject{
		ProjectKey:         "upwork-buddy",
		Name:               "Secret Project Name",
		Client:             "Secret Client",
		ActivityTier:       "active",
		Status:             "active",
		ProposalVisibility: "public",
		TechStackJSON:      dbservice.JSONB(`["Go","PostgreSQL"]`),
	}).Error; err != nil {
		t.Fatalf("seed active project: %v", err)
	}
	if err := gormDB.Create(&dbservice.ActiveProject{
		ProjectKey:         "stealth-proj",
		Name:               "Stealth Name",
		ActivityTier:       "active",
		Status:             "active",
		ProposalVisibility: "private",
		TechStackJSON:      dbservice.JSONB(`["StealthLang"]`),
	}).Error; err != nil {
		t.Fatalf("seed private project: %v", err)
	}

	var seenSearchParams atomic.Value
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "jobs.search" {
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			seenSearchParams.Store(p)
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":    "~01provA",
						"canonical_url":    "https://www.upwork.com/jobs/Prov-A_~01provA/",
						"job_title":        "Go PostgreSQL API",
						"job_description":  "Go + Postgres microservices",
						"contract_type":    "hourly",
						"rate_range":       "$75 - $110/hr",
						"payment_verified": true,
					},
				},
			}, nil
		}
		return nil, &bridge.WireRPCError{Code: json.RawMessage(`-32601`), Message: "unexpected"}
	})

	rateMin := 70.0
	payVerified := true
	searchRes, err := s.ExecuteSearchPipeline(context.Background(), SearchJobsRequest{
		Source:               "search",
		RunLabel:             "M2 sweep",
		TriggeredBy:          "mcp",
		FromActiveProjects:   true,
		HourlyRateMin:        &rateMin,
		PaymentVerifiedOnly:  &payVerified,
		SkipAutoDetailEnrich: true,
	})
	if err != nil {
		t.Fatalf("ExecuteSearchPipeline failed: %v", err)
	}
	if searchRes.SearchRunID == 0 {
		t.Fatal("expected non-zero SearchRunID")
	}
	if len(searchRes.MatchedProjectKeys) != 1 || searchRes.MatchedProjectKeys[0] != "upwork-buddy" {
		t.Fatalf("expected matched_project_keys=[upwork-buddy], got %+v", searchRes.MatchedProjectKeys)
	}
	assertTicketedDashboardURL(t, s, searchRes.DashboardURL, "http://127.0.0.1:9095", "run", strconv.FormatUint(uint64(searchRes.SearchRunID), 10))
	if len(searchRes.Jobs) != 1 || searchRes.Jobs[0].LastSearchRunID == nil || *searchRes.Jobs[0].LastSearchRunID != searchRes.SearchRunID {
		t.Fatalf("expected job last_search_run_id=%d, got %+v", searchRes.SearchRunID, searchRes.Jobs)
	}

	sp, _ := seenSearchParams.Load().(map[string]any)
	rawQueries, _ := sp["queries"].([]any)
	if len(rawQueries) != 1 || rawQueries[0] != "Go PostgreSQL" {
		t.Fatalf("expected derived query ['Go PostgreSQL'] in wsParams, got %+v", sp["queries"])
	}

	// Verify GetSearchRun returns run1 + job ~01provA
	detail1, err := s.GetSearchRun(context.Background(), searchRes.SearchRunID)
	if err != nil || len(detail1.Jobs) != 1 || detail1.Jobs[0].UpworkJobID != "~01provA" {
		t.Fatalf("GetSearchRun(run1) failed: detail=%+v err=%v", detail1, err)
	}
	if detail1.SearchRun.Label != "M2 sweep" || detail1.SearchRun.TriggeredBy != "mcp" {
		t.Fatalf("unexpected SearchRun metadata: %+v", detail1.SearchRun)
	}

	// Second wave via BatchIngestJobs re-ingests ~01provA + adds ~01provB
	batchRes, err := s.BatchIngestJobs(context.Background(), BatchIngestJobsRequest{
		RunLabel:    "Batch wave 2",
		Source:      "batch",
		TriggeredBy: "api",
		Jobs: []saveJobRequest{
			{
				UpworkJobID:    "~01provA",
				JobTitle:       "Go PostgreSQL API",
				JobDescription: "Go + Postgres microservices updated",
			},
			{
				UpworkJobID:    "~01provB",
				JobTitle:       "Second Job",
				JobDescription: "Docker + Kubernetes",
			},
		},
	})
	if err != nil {
		t.Fatalf("BatchIngestJobs failed: %v", err)
	}
	if batchRes.SearchRunID == 0 || batchRes.SearchRunID == searchRes.SearchRunID {
		t.Fatalf("expected distinct batch SearchRunID, got %d", batchRes.SearchRunID)
	}

	// Verify ~01provA has last_search_run_id updated to batchRes.SearchRunID while STILL linked to BOTH runs in search_run_jobs!
	gotA, err := s.GetJob(context.Background(), 0, "~01provA")
	if err != nil || gotA.LastSearchRunID == nil || *gotA.LastSearchRunID != batchRes.SearchRunID {
		t.Fatalf("expected ~01provA last_search_run_id=%d, got %+v (err=%v)", batchRes.SearchRunID, gotA, err)
	}
	detail1After, err := s.GetSearchRun(context.Background(), searchRes.SearchRunID)
	if err != nil || len(detail1After.Jobs) != 1 {
		t.Fatalf("expected run1 to retain ~01provA provenance in search_run_jobs, got %+v (err=%v)", detail1After, err)
	}
	detail2, err := s.GetSearchRun(context.Background(), batchRes.SearchRunID)
	if err != nil || len(detail2.Jobs) != 2 {
		t.Fatalf("expected run2 to have 2 jobs, got %+v (err=%v)", detail2, err)
	}

	// Upsert=false creates 0 SearchRun rows
	noUpsert := false
	dryRes, err := s.BatchIngestJobs(context.Background(), BatchIngestJobsRequest{
		Upsert: &noUpsert,
		Jobs: []saveJobRequest{
			{UpworkJobID: "~01dry", JobTitle: "Dry Run Job", JobDescription: "Test"},
		},
	})
	if err != nil {
		t.Fatalf("BatchIngestJobs upsert=false failed: %v", err)
	}
	if dryRes.SearchRunID != 0 || dryRes.PersistedCount != 0 || dryRes.DashboardURL != "" {
		t.Fatalf("expected SearchRunID=0, PersistedCount=0, DashboardURL='' on upsert=false, got %+v", dryRes)
	}
}

func TestBatchIngestJobs_RateMinMaxScoringFilterAndEmptyValidation_WithDB(t *testing.T) {
	s := setupTestServer(t)

	// 1. rate_min / rate_max without rate_range should synthesize hourly rate for scoring & post_enrichment filtering.
	noUpsert := false
	rateMinFilter := 70.0
	res, err := s.BatchIngestJobs(context.Background(), BatchIngestJobsRequest{
		Upsert:      &noUpsert,
		FilterStage: "post_enrichment",
		Filters: &scoring.FilterConfig{
			HourlyRateMin: &rateMinFilter,
		},
		Jobs: []saveJobRequest{
			{
				UpworkJobID:    "~09rateminmax1",
				JobTitle:       "Hourly Go Engineer",
				JobDescription: "Build Go microservices",
				ContractType:   "hourly",
				RateMin:        "80",
				RateMax:        "120",
			},
			{
				UpworkJobID:    "~09rateminmax2",
				JobTitle:       "Low Hourly Go Engineer",
				JobDescription: "Build Go microservices",
				ContractType:   "hourly",
				RateMin:        "25",
				RateMax:        "40",
			},
		},
	})
	if err != nil {
		t.Fatalf("BatchIngestJobs(rate_min/max) failed: %v", err)
	}
	if res.FilteredCount != 1 || len(res.Jobs) != 1 || res.Jobs[0].UpworkJobID != "~09rateminmax1" {
		t.Fatalf("expected only ~09rateminmax1 to pass hourly_rate_min=70, got filtered=%d jobs=%+v", res.FilteredCount, res.Jobs)
	}
	if res.Jobs[0].Score == nil || *res.Jobs[0].Score <= 0 {
		t.Fatalf("expected non-zero deterministic score from rate_min/rate_max, got %+v", res.Jobs[0].Score)
	}
	var sb scoring.ScoreBreakdown
	if err := json.Unmarshal(res.Jobs[0].ScoreBreakdown, &sb); err != nil {
		t.Fatalf("unmarshal score_breakdown: %v", err)
	}
	if sb.RateBudget != 20 {
		t.Fatalf("expected RateBudget=20 for $80-$120/hr, got %d", sb.RateBudget)
	}

	// 2. Empty job object {} must fail with 400 INVALID_PARAMS (even when filters are present).
	for _, tc := range []struct {
		name string
		req  BatchIngestJobsRequest
	}{
		{
			name: "plain_empty_object",
			req:  BatchIngestJobsRequest{Jobs: []saveJobRequest{{}}},
		},
		{
			name: "empty_object_with_filters",
			req: BatchIngestJobsRequest{
				Jobs:    []saveJobRequest{{}},
				Filters: &scoring.FilterConfig{HourlyRateMin: &rateMinFilter},
			},
		},
	} {
		_, emptyErr := s.BatchIngestJobs(context.Background(), tc.req)
		var se *ServiceError
		if !errors.As(emptyErr, &se) || se.HTTPStatus != http.StatusBadRequest || se.Code != "INVALID_PARAMS" {
			t.Fatalf("%s: expected 400 INVALID_PARAMS, got %v", tc.name, emptyErr)
		}
	}
}

func TestSearchProfileAndPipelineIDBoundsValidation_WithDB(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()
	ctx := context.Background()

	// ExecuteSearchPipeline rejects ProfileID == 0 or > math.MaxInt64 with 400 INVALID_PARAMS
	for _, badID := range []uint{0, uint(uint64(1) << 63), ^uint(0)} {
		idCopy := badID
		_, err := s.ExecuteSearchPipeline(ctx, SearchJobsRequest{ProfileID: &idCopy})
		var se *ServiceError
		if !errors.As(err, &se) || se.HTTPStatus != http.StatusBadRequest || se.Code != "INVALID_PARAMS" {
			t.Fatalf("ExecuteSearchPipeline(ProfileID=%d) expected 400 INVALID_PARAMS, got %v", badID, err)
		}

		_, runErr := s.RunSearchProfile(ctx, &idCopy, "")
		var seRun *ServiceError
		if !errors.As(runErr, &seRun) || seRun.HTTPStatus != http.StatusBadRequest || seRun.Code != "INVALID_PARAMS" {
			t.Fatalf("RunSearchProfile(id=%d) expected 400 INVALID_PARAMS, got %v", badID, runErr)
		}
	}

	// DeleteSearchProfile rejects > math.MaxInt64 with 400 INVALID_PARAMS
	for _, badU64 := range []uint64{uint64(1) << 63, math.MaxUint64} {
		delErr := s.DeleteSearchProfile(ctx, badU64, "")
		var seDel *ServiceError
		if !errors.As(delErr, &seDel) || seDel.HTTPStatus != http.StatusBadRequest || seDel.Code != "INVALID_PARAMS" {
			t.Fatalf("DeleteSearchProfile(id=%d) expected 400 INVALID_PARAMS, got %v", badU64, delErr)
		}
	}

	// HTTP endpoints: POST /api/search-profiles/{id}/run and DELETE /api/search-profiles/{id}
	for _, badIDStr := range []string{"0", "9223372036854775808", "18446744073709551615"} {
		for _, tc := range []struct {
			method string
			path   string
		}{
			{http.MethodPost, "/api/search-profiles/" + badIDStr + "/run"},
			{http.MethodDelete, "/api/search-profiles/" + badIDStr},
		} {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			req.Header.Set("Authorization", "Bearer "+s.apiToken)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Result().StatusCode != http.StatusBadRequest {
				t.Fatalf("%s %s status = %d, want 400; body=%s", tc.method, tc.path, w.Result().StatusCode, w.Body.String())
			}
			var errBody map[string]any
			_ = json.NewDecoder(w.Body).Decode(&errBody)
			if errBody["error_code"] != "INVALID_PARAMS" {
				t.Fatalf("%s %s expected INVALID_PARAMS, got %+v", tc.method, tc.path, errBody)
			}
		}
	}
}
