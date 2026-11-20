package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"upwork-buddy/internal/bridge"
)

func TestGetSelectorsHandler_JSONYAMLAndETag(t *testing.T) {
	s := &Server{
		apiToken:      "test-token",
		selectorsPath: "../../configs/selectors/upwork.yaml",
	}
	router := s.RegisterRoutes()

	// 1. Default JSON response
	req := httptest.NewRequest(http.MethodGet, "/api/selectors", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/selectors status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("expected JSON Content-Type, got %q", ct)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatal("expected non-empty ETag header")
	}
	if ver := resp.Header.Get("X-Selector-Version"); ver != "2.0" {
		t.Fatalf("expected X-Selector-Version=2.0, got %q", ver)
	}

	var cfg SelectorConfig
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		t.Fatalf("decode selectors JSON: %v", err)
	}
	for _, view := range []string{
		"search_listings", "best_matches", "most_recent", "saved_jobs",
		"job_detail", "proposal_apply", "proposals_list", "messages_rooms", "messages_thread",
	} {
		if _, ok := cfg.Views[view]; !ok {
			t.Errorf("missing expected view %q in selectors config", view)
		}
	}
	if cfg.AuthAndChallengeGuards == nil || len(cfg.AuthAndChallengeGuards.ChallengeSelectors) == 0 {
		t.Error("expected auth_and_challenge_guards to be populated")
	}

	// 2. Conditional GET with ETag -> 304 Not Modified
	req304 := httptest.NewRequest(http.MethodGet, "/api/selectors", nil)
	req304.Header.Set("Authorization", "Bearer test-token")
	req304.Header.Set("If-None-Match", etag)
	w304 := httptest.NewRecorder()
	router.ServeHTTP(w304, req304)
	if w304.Result().StatusCode != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified, got %d", w304.Result().StatusCode)
	}

	// 3. ?format=yaml and Accept: application/yaml
	reqYAML := httptest.NewRequest(http.MethodGet, "/api/selectors?format=yaml", nil)
	reqYAML.Header.Set("Authorization", "Bearer test-token")
	wYAML := httptest.NewRecorder()
	router.ServeHTTP(wYAML, reqYAML)
	if wYAML.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/selectors?format=yaml status = %d", wYAML.Result().StatusCode)
	}
	if ct := wYAML.Header().Get("Content-Type"); !strings.Contains(ct, "application/yaml") {
		t.Fatalf("expected application/yaml Content-Type, got %q", ct)
	}
	if !strings.Contains(wYAML.Body.String(), "search_listings:") {
		t.Fatal("expected YAML body to contain search_listings:")
	}

	reqAcceptYAML := httptest.NewRequest(http.MethodGet, "/api/selectors", nil)
	reqAcceptYAML.Header.Set("Authorization", "Bearer test-token")
	reqAcceptYAML.Header.Set("Accept", "application/yaml")
	wAcceptYAML := httptest.NewRecorder()
	router.ServeHTTP(wAcceptYAML, reqAcceptYAML)
	if ct := wAcceptYAML.Header().Get("Content-Type"); !strings.Contains(ct, "application/yaml") {
		t.Fatalf("expected Accept negotiation to return application/yaml, got %q", ct)
	}

	// 4. Distinct ETag between JSON and YAML + Vary: Accept prevents stale 304 across representations
	if vary := resp.Header.Get("Vary"); !strings.Contains(vary, "Accept") {
		t.Fatalf("expected Vary: Accept on JSON response, got %q", vary)
	}
	yamlETag := wYAML.Header().Get("ETag")
	if yamlETag == "" || yamlETag == etag {
		t.Fatalf("expected distinct ETag for YAML (%q) vs JSON (%q)", yamlETag, etag)
	}
	reqCross304 := httptest.NewRequest(http.MethodGet, "/api/selectors?format=yaml", nil)
	reqCross304.Header.Set("Authorization", "Bearer test-token")
	reqCross304.Header.Set("If-None-Match", etag)
	wCross304 := httptest.NewRecorder()
	router.ServeHTTP(wCross304, reqCross304)
	if wCross304.Result().StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK when passing JSON ETag to ?format=yaml, got %d", wCross304.Result().StatusCode)
	}
}

func TestSearchProfilesCRUDAndYAMLImport(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	// Import real YAML profiles from /var/www/upwork-scraper-fs/configs/profiles/ if present, else embedded fixture
	profileFiles := []string{
		"/var/www/upwork-scraper-fs/configs/profiles/default_search.yaml",
		"/var/www/upwork-scraper-fs/configs/profiles/all_stacks_wide_harvester.yaml",
		"/var/www/upwork-scraper-fs/configs/profiles/golang_top20_enriched.yaml",
	}
	for _, p := range profileFiles {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		req := httptest.NewRequest(http.MethodPost, "/api/search-profiles/import", bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/yaml")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusOK {
			t.Fatalf("import %s failed: %d %s", filepath.Base(p), w.Result().StatusCode, w.Body.String())
		}
	}

	// Also test JSON-wrapped multi-document YAML import
	multiYAML := `name: "custom_go_profile"
description: "Go backend jobs"
search:
  mode: "best_matches"
  queries: ["golang", "postgresql"]
  per_page: 20
filters:
  required_keywords: ["go"]
  min_score: 60
---
name: "custom_wp_profile"
description: "WordPress jobs"
search:
  mode: "most_recent"
  query: "wordpress sage"
`
	importJSONBody, _ := json.Marshal(map[string]any{
		"yaml":      multiYAML,
		"is_active": false,
	})
	impReq := httptest.NewRequest(http.MethodPost, "/api/search-profiles/import", bytes.NewReader(importJSONBody))
	impReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	impReq.Header.Set("Content-Type", "application/json")
	impW := httptest.NewRecorder()
	router.ServeHTTP(impW, impReq)
	if impW.Result().StatusCode != http.StatusOK {
		t.Fatalf("JSON YAML import failed: %d %s", impW.Result().StatusCode, impW.Body.String())
	}

	// POST /api/search-profiles create & upsert
	createReq := httptest.NewRequest(http.MethodPost, "/api/search-profiles", strings.NewReader(`{
		"name": "api_created_profile",
		"description": "Created via JSON",
		"is_active": true,
		"config": {
			"search": {"mode": "live_search", "query": "rust wasm", "per_page": 50, "start_page": 1, "max_pages": 2},
			"transport": {"jitter_ratio": 0.5}
		}
	}`))
	createReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	router.ServeHTTP(createW, createReq)
	if createW.Result().StatusCode != http.StatusCreated {
		t.Fatalf("POST /api/search-profiles status = %d %s, want 201", createW.Result().StatusCode, createW.Body.String())
	}

	var createdResp struct {
		Profile searchProfileEntry `json:"profile"`
	}
	if err := json.NewDecoder(createW.Body).Decode(&createdResp); err != nil {
		t.Fatalf("decode created profile: %v", err)
	}

	// Regression test (Finding 1): partial nested config preserves all defaultSearchProfileConfig() fields
	partialReq := httptest.NewRequest(http.MethodPost, "/api/search-profiles", strings.NewReader(`{"name":"partial_profile","config":{"search":{"query":"golang"}}}`))
	partialReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	partialReq.Header.Set("Content-Type", "application/json")
	partialW := httptest.NewRecorder()
	router.ServeHTTP(partialW, partialReq)
	if partialW.Result().StatusCode != http.StatusCreated {
		t.Fatalf("partial POST /api/search-profiles status = %d %s, want 201", partialW.Result().StatusCode, partialW.Body.String())
	}
	var partialResp struct {
		Profile searchProfileEntry `json:"profile"`
	}
	if err := json.NewDecoder(partialW.Body).Decode(&partialResp); err != nil {
		t.Fatalf("decode partial profile: %v", err)
	}
	if partialResp.Profile.Config.Search.Query != "golang" {
		t.Errorf("expected query='golang', got %q", partialResp.Profile.Config.Search.Query)
	}
	if partialResp.Profile.Config.Search.StartPage != 1 || partialResp.Profile.Config.Search.MaxPages != 1 {
		t.Errorf("expected StartPage=1, MaxPages=1, got %d, %d", partialResp.Profile.Config.Search.StartPage, partialResp.Profile.Config.Search.MaxPages)
	}
	if partialResp.Profile.Config.Transport.JitterRatio != 0.5 || partialResp.Profile.Config.Transport.Adapter != "flaresolverr" {
		t.Errorf("expected Transport defaults preserved, got %+v", partialResp.Profile.Config.Transport)
	}
	if partialResp.Profile.Config.Enrichment.DelayBetweenDetailsSeconds != 4.5 {
		t.Errorf("expected DelayBetweenDetailsSeconds=4.5, got %v", partialResp.Profile.Config.Enrichment.DelayBetweenDetailsSeconds)
	}
	if partialResp.Profile.Config.SelectorsFile != "configs/selectors/upwork.yaml" {
		t.Errorf("expected SelectorsFile preserved, got %q", partialResp.Profile.Config.SelectorsFile)
	}

	// List active-only profiles
	listReq := httptest.NewRequest(http.MethodGet, "/api/search-profiles?active=true", nil)
	listReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	listW := httptest.NewRecorder()
	router.ServeHTTP(listW, listReq)
	if listW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/search-profiles?active=true status = %d", listW.Result().StatusCode)
	}

	// Delete created profile
	delReq := httptest.NewRequest(http.MethodDelete, "/api/search-profiles/"+uintToStr(createdResp.Profile.ID), nil)
	delReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	delW := httptest.NewRecorder()
	router.ServeHTTP(delW, delReq)
	if delW.Result().StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /api/search-profiles/{id} status = %d, want 204", delW.Result().StatusCode)
	}
}

func TestSelectorAuditsEndpoints(t *testing.T) {
	s := setupTestServer(t)
	router := s.RegisterRoutes()

	// Create 2 audits for search_listings (1st with baseline, 2nd omitting baseline, 3rd with "baseline":"" -> baseline must be preserved across all!) and 1 for job_detail (BROKEN, no baseline)
	payloads := []string{
		`{"view_type":"search_listings","report":{"view_type":"search_listings","healthy_selectors_count":10,"degraded_selectors_count":2,"broken_selectors_count":0,"fragile_selectors_count":1},"baseline":{"url":"https://www.upwork.com/nx/search/jobs/","view_type":"search_listings","field_counts":{"title":10}}}`,
		`{"view_type":"search_listings","report":{"view_type":"search_listings","healthy_selectors_count":12,"degraded_selectors_count":0,"broken_selectors_count":0,"fragile_selectors_count":0}}`,
		`{"view_type":"search_listings","report":{"view_type":"search_listings","healthy_selectors_count":12,"degraded_selectors_count":0,"broken_selectors_count":0,"fragile_selectors_count":0},"baseline":""}`,
		`{"view_type":"job_detail","report":{"view_type":"job_detail","healthy_selectors_count":8,"degraded_selectors_count":1,"broken_selectors_count":1,"fragile_selectors_count":0}}`,
	}

	for _, p := range payloads {
		req := httptest.NewRequest(http.MethodPost, "/api/selector-audits", strings.NewReader(p))
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusCreated {
			t.Fatalf("POST /api/selector-audits status = %d %s, want 201", w.Result().StatusCode, w.Body.String())
		}
	}

	// Malformed baseline JSON must still return 400 Bad Request
	badBaselineReq := httptest.NewRequest(http.MethodPost, "/api/selector-audits", strings.NewReader(`{"view_type":"search_listings","report":{"view_type":"search_listings"},"baseline":"not-json"}`))
	badBaselineReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	badBaselineReq.Header.Set("Content-Type", "application/json")
	badBaselineW := httptest.NewRecorder()
	router.ServeHTTP(badBaselineW, badBaselineReq)
	if badBaselineW.Result().StatusCode != http.StatusBadRequest {
		t.Fatalf("POST /api/selector-audits malformed baseline status = %d, want 400", badBaselineW.Result().StatusCode)
	}

	// Query latest=true -> 1 per view_type (search_listings=HEALTHY with carried-forward baseline, job_detail=BROKEN without baseline)
	latestReq := httptest.NewRequest(http.MethodGet, "/api/selector-audits?latest=true", nil)
	latestReq.Header.Set("Authorization", "Bearer "+s.apiToken)
	latestW := httptest.NewRecorder()
	router.ServeHTTP(latestW, latestReq)
	if latestW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/selector-audits?latest=true status = %d", latestW.Result().StatusCode)
	}

	var latestResp struct {
		Audits []selectorAuditEntry `json:"audits"`
	}
	if err := json.NewDecoder(latestW.Body).Decode(&latestResp); err != nil {
		t.Fatalf("decode latest audits: %v", err)
	}
	if len(latestResp.Audits) != 2 {
		t.Fatalf("expected 2 latest audits (one per view), got %d", len(latestResp.Audits))
	}
	statuses := map[string]string{}
	baselines := map[string]string{}
	for _, a := range latestResp.Audits {
		statuses[a.ViewType] = a.OverallStatus
		baselines[a.ViewType] = string(a.Baseline)
	}
	if statuses["search_listings"] != "HEALTHY" || statuses["job_detail"] != "BROKEN" {
		t.Fatalf("unexpected latest statuses: %+v", statuses)
	}
	if !strings.Contains(baselines["search_listings"], "search_listings") {
		t.Fatalf("expected search_listings latest audit to preserve baseline_json, got %q", baselines["search_listings"])
	}
	if baselines["job_detail"] != "" {
		t.Fatalf("expected job_detail with no prior baseline to have empty baseline, got %q", baselines["job_detail"])
	}
}

func TestParseSaveSearchProfileRequest_PreservesDefaultsOnPartialNestedConfig(t *testing.T) {
	cfg, isActive, err := parseSaveSearchProfileRequest([]byte(`{"name":"partial_profile","config":{"search":{"query":"golang"}}}`))
	if err != nil {
		t.Fatalf("unexpected error parsing partial nested config: %v", err)
	}
	if !isActive {
		t.Errorf("expected default isActive=true")
	}
	if cfg.Name != "partial_profile" || cfg.Search.Query != "golang" {
		t.Errorf("unexpected name/query: %q / %q", cfg.Name, cfg.Search.Query)
	}
	if cfg.Search.StartPage != 1 || cfg.Search.MaxPages != 1 {
		t.Errorf("expected StartPage=1, MaxPages=1, got %d, %d", cfg.Search.StartPage, cfg.Search.MaxPages)
	}
	if cfg.Transport.JitterRatio != 0.5 || cfg.Transport.Adapter != "flaresolverr" || cfg.Transport.ProxyMode != "rotation" || cfg.Transport.MaxTimeoutMs != 60000 {
		t.Errorf("expected Transport defaults preserved, got %+v", cfg.Transport)
	}
	if cfg.Enrichment.DelayBetweenDetailsSeconds != 4.5 || cfg.Enrichment.DetailRetries != 2 {
		t.Errorf("expected Enrichment defaults preserved, got %+v", cfg.Enrichment)
	}
	if cfg.SelectorsFile != "configs/selectors/upwork.yaml" {
		t.Errorf("expected SelectorsFile default preserved, got %q", cfg.SelectorsFile)
	}

	// Explicit config: null falls back to flat payload while keeping defaults
	flatCfg, flatActive, err := parseSaveSearchProfileRequest([]byte(`{"name":"flat_null","is_active":false,"config":null,"search":{"query":"rust"}}`))
	if err != nil {
		t.Fatalf("unexpected error parsing config:null payload: %v", err)
	}
	if flatActive {
		t.Errorf("expected isActive=false")
	}
	if flatCfg.Search.Query != "rust" || flatCfg.Search.StartPage != 1 || flatCfg.Transport.JitterRatio != 0.5 {
		t.Errorf("expected defaults preserved on config:null, got %+v", flatCfg)
	}

	// Invalid explicit value must still fail validation
	if _, _, err := parseSaveSearchProfileRequest([]byte(`{"name":"bad_pages","config":{"search":{"start_page":0}}}`)); err == nil {
		t.Fatal("expected error for explicit start_page=0")
	}
	// Invalid config JSON type must fail
	if _, _, err := parseSaveSearchProfileRequest([]byte(`{"name":"bad_type","config":"invalid"}`)); err == nil {
		t.Fatal("expected error for non-object config")
	}
}

func TestAuditSelectors_URLWithoutViewOmitsDefaultView(t *testing.T) {
	s := &Server{apiToken: "tok-sel-infer"}
	srv, _ := attachTestBridgeHub(t, s)

	var seenParams atomic.Value
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		if method == "audit.selectors" {
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			seenParams.Store(p)
			return map[string]any{
				"ok":             true,
				"overall_status": "HEALTHY",
				"report": map[string]any{
					"view_type":      "messages_rooms",
					"overall_status": "HEALTHY",
				},
			}, nil
		}
		return map[string]any{"ok": true}, nil
	})

	res, err := s.AuditSelectors(context.Background(), AuditSelectorsRequest{
		URL: "https://www.upwork.com/ab/messages/rooms/",
	})
	if err != nil {
		t.Fatalf("AuditSelectors failed: %v", err)
	}
	if res.ViewType != "messages_rooms" {
		t.Fatalf("expected ViewType=messages_rooms, got %q", res.ViewType)
	}
	p, _ := seenParams.Load().(map[string]any)
	if _, hasView := p["view"]; hasView {
		t.Fatalf("expected wsParams to omit 'view' when explicit URL is given without view, got %+v", p)
	}
	if p["url"] != "https://www.upwork.com/ab/messages/rooms/" {
		t.Fatalf("expected url forwarded, got %+v", p)
	}
}
