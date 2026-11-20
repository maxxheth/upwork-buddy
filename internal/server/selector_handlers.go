package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"

	"go.yaml.in/yaml/v3"
	"gorm.io/gorm"
)

// SelectorConfig represents the declarative Upwork selector contract served via GET /api/selectors.
type SelectorConfig struct {
	Version                string                        `yaml:"version" json:"version"`
	Site                   string                        `yaml:"site" json:"site"`
	BaseURL                string                        `yaml:"base_url" json:"base_url"`
	PageGuards             PageGuardConfig               `yaml:"page_guards" json:"page_guards"`
	AuthAndChallengeGuards *AuthAndChallengeGuardsConfig `yaml:"auth_and_challenge_guards,omitempty" json:"auth_and_challenge_guards,omitempty"`
	Views                  map[string]ViewSelectorConfig `yaml:"views" json:"views"`
}

// PageGuardConfig holds selectors and headings for detecting error/404/invalid pages.
type PageGuardConfig struct {
	NotFoundHeadings     []string `yaml:"not_found_headings" json:"not_found_headings"`
	ErrorHeadingSelectors []string `yaml:"error_heading_selectors" json:"error_heading_selectors"`
	DetailSignalSelectors []string `yaml:"detail_signal_selectors" json:"detail_signal_selectors"`
	AuthLoggedInSelectors []string `yaml:"auth_logged_in_selectors,omitempty" json:"auth_logged_in_selectors,omitempty"`
	ChallengeSelectors    []string `yaml:"challenge_selectors,omitempty" json:"challenge_selectors,omitempty"`
}

// AuthAndChallengeGuardsConfig holds patterns and selectors for login, 2FA, and anti-bot challenge detection.
type AuthAndChallengeGuardsConfig struct {
	LoginURLPatterns      []string `yaml:"login_url_patterns,omitempty" json:"login_url_patterns,omitempty"`
	ChallengeURLPatterns  []string `yaml:"challenge_url_patterns,omitempty" json:"challenge_url_patterns,omitempty"`
	ChallengeSelectors    []string `yaml:"challenge_selectors,omitempty" json:"challenge_selectors,omitempty"`
	ChallengeTextPatterns []string `yaml:"challenge_text_patterns,omitempty" json:"challenge_text_patterns,omitempty"`
	LoggedInSelectors     []string `yaml:"logged_in_selectors,omitempty" json:"logged_in_selectors,omitempty"`
	LoggedOutSelectors    []string `yaml:"logged_out_selectors,omitempty" json:"logged_out_selectors,omitempty"`
}

// ViewSelectorConfig defines container and field extraction rules for an Upwork page view.
type ViewSelectorConfig struct {
	ContainerSelectors []string                     `yaml:"container_selectors,omitempty" json:"container_selectors,omitempty"`
	Fields             map[string]FieldSelectorRule `yaml:"fields" json:"fields"`
}

// FieldSelectorRule describes how to extract and normalize a single DOM field.
type FieldSelectorRule struct {
	Selectors       []string `yaml:"selectors" json:"selectors"`
	Extract         string   `yaml:"extract" json:"extract"`
	Attribute       string   `yaml:"attribute,omitempty" json:"attribute,omitempty"`
	Transforms      []string `yaml:"transforms,omitempty" json:"transforms,omitempty"`
	SiblingChildTag string   `yaml:"sibling_child_tag,omitempty" json:"sibling_child_tag,omitempty"`
	JoinWith        string   `yaml:"join_with,omitempty" json:"join_with,omitempty"`
	LabelContains   string   `yaml:"label_contains,omitempty" json:"label_contains,omitempty"`
	Required        bool     `yaml:"required,omitempty" json:"required,omitempty"`
	IsFragile       bool     `yaml:"is_fragile,omitempty" json:"is_fragile,omitempty"`
	FragileReason   string   `yaml:"fragile_reason,omitempty" json:"fragile_reason,omitempty"`
	AuthOnly        bool     `yaml:"auth_only,omitempty" json:"auth_only,omitempty"`
	Description     string   `yaml:"description,omitempty" json:"description,omitempty"`
}

func (s *Server) resolveSelectorsPath() string {
	if s != nil && strings.TrimSpace(s.selectorsPath) != "" {
		return strings.TrimSpace(s.selectorsPath)
	}
	if envPath := strings.TrimSpace(os.Getenv("SELECTORS_PATH")); envPath != "" {
		return envPath
	}
	return "configs/selectors/upwork.yaml"
}

func ifNoneMatchMatches(headerVal, etag string) bool {
	trimmed := strings.TrimSpace(headerVal)
	if trimmed == "" {
		return false
	}
	if trimmed == "*" {
		return true
	}
	for _, candidate := range strings.Split(trimmed, ",") {
		c := strings.TrimSpace(candidate)
		c = strings.TrimPrefix(c, "W/")
		if c == etag {
			return true
		}
	}
	return false
}

func wantsYAML(accept string) bool {
	if accept == "" {
		return false
	}
	lower := strings.ToLower(accept)
	yamlIdx := -1
	for _, mt := range []string{"application/yaml", "text/yaml", "application/x-yaml"} {
		if idx := strings.Index(lower, mt); idx >= 0 && (yamlIdx < 0 || idx < yamlIdx) {
			yamlIdx = idx
		}
	}
	if yamlIdx < 0 {
		return false
	}
	jsonIdx := strings.Index(lower, "application/json")
	return jsonIdx < 0 || yamlIdx < jsonIdx
}

func (s *Server) getSelectorsHandler(w http.ResponseWriter, r *http.Request) {
	path := s.resolveSelectorsPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Printf("❌ Failed to read selectors file %q: %v", path, err)
		respondWithError(w, http.StatusInternalServerError, "Failed to load selector configuration")
		return
	}

	var cfg SelectorConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		log.Printf("❌ Invalid selector YAML in %q: %v", path, err)
		respondWithError(w, http.StatusInternalServerError, "Invalid selector configuration")
		return
	}

	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	repFormat := "json"
	switch format {
	case "yaml", "yml":
		repFormat = "yaml"
	case "":
		if wantsYAML(r.Header.Get("Accept")) {
			repFormat = "yaml"
		}
	case "json":
		repFormat = "json"
	default:
		respondWithError(w, http.StatusBadRequest, "Unsupported format; expected json or yaml")
		return
	}

	h := sha256.New()
	h.Write([]byte(repFormat))
	h.Write([]byte(":"))
	h.Write(raw)
	etag := fmt.Sprintf("\"%x\"", h.Sum(nil))

	w.Header().Set("ETag", etag)
	w.Header().Set("Vary", "Accept")
	w.Header().Set("Cache-Control", "no-cache")
	if cfg.Version != "" {
		w.Header().Set("X-Selector-Version", cfg.Version)
	}

	if ifNoneMatchMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	if repFormat == "yaml" {
		w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
		if _, err := w.Write(raw); err != nil {
			log.Printf("⚠️ Failed to write YAML selectors response: %v", err)
		}
		return
	}
	respondWithJSON(w, cfg)
}

type selectorAuditRequest struct {
	ViewType      string          `json:"view_type"`
	OverallStatus string          `json:"overall_status"`
	Report        json.RawMessage `json:"report"`
	Baseline      json.RawMessage `json:"baseline"`
}

type driftCounts struct {
	ViewType               string `json:"view_type"`
	HealthySelectorsCount  int    `json:"healthy_selectors_count"`
	DegradedSelectorsCount int    `json:"degraded_selectors_count"`
	BrokenSelectorsCount   int    `json:"broken_selectors_count"`
	FragileSelectorsCount  int    `json:"fragile_selectors_count"`
}

// SelectorAuditEntry is the API/MCP DTO for a persisted selector drift audit row.
type SelectorAuditEntry struct {
	ID            uint            `json:"id"`
	ViewType      string          `json:"view_type"`
	OverallStatus string          `json:"overall_status"`
	Report        json.RawMessage `json:"report"`
	Baseline      json.RawMessage `json:"baseline,omitempty"`
	CreatedAt     string          `json:"created_at"`
}

type selectorAuditEntry = SelectorAuditEntry

// TabEntry describes an open Upwork browser tab returned by the extension.
type TabEntry struct {
	ID           int    `json:"id"`
	Title        string `json:"title"`
	URL          string `json:"url"`
	Active       bool   `json:"active"`
	Automation   bool   `json:"automation"`
	IsAutomation bool   `json:"is_automation"`
}

// TabsListResponse wraps the list of open Upwork tabs.
type TabsListResponse struct {
	Tabs []TabEntry `json:"tabs"`
}

// AuditSelectorsRequest configures a live selector drift audit via the extension.
type AuditSelectorsRequest struct {
	View           string `json:"view"`
	URL            string `json:"url"`
	UseActiveTab   bool   `json:"use_active_tab,omitempty"`
	UpdateBaseline bool   `json:"update_baseline"`
	SaveBaseline   bool   `json:"save_baseline,omitempty"`
}

// AuditRuleResult represents a normalized per-field selector drift audit result.
type AuditRuleResult struct {
	Field                string `json:"field"`
	Status               string `json:"status"`
	MatchedCount         int    `json:"matched_count"`
	SuggestedReplacement string `json:"suggested_replacement,omitempty"`
	Reason               string `json:"reason,omitempty"`
	RegisteredSelector   string `json:"registered_selector,omitempty"`
	View                 string `json:"view,omitempty"`
}

// AuditSelectorsResponse returns both top-level report fields (view_type, overall_status, rules,
// total_cards_detected, field_results, discovered_candidates, baseline_diff, baseline_diffs,
// breaking_changes_detected) and nested audit/report/blueprint objects.
type AuditSelectorsResponse struct {
	OK                      bool                `json:"ok"`
	ViewType                string              `json:"view_type"`
	OverallStatus           string              `json:"overall_status"`
	TotalCardsDetected      int                 `json:"total_cards_detected"`
	Rules                   json.RawMessage     `json:"rules"`
	FieldResults            []AuditRuleResult   `json:"field_results"`
	DiscoveredCandidates    json.RawMessage     `json:"discovered_candidates"`
	BaselineDiff            json.RawMessage     `json:"baseline_diff"`
	BaselineDiffs           json.RawMessage     `json:"baseline_diffs"`
	BreakingChangesDetected bool                `json:"breaking_changes_detected"`
	Audit                   *SelectorAuditEntry `json:"audit,omitempty"`
	Report                  json.RawMessage     `json:"report,omitempty"`
	Blueprint               json.RawMessage     `json:"blueprint,omitempty"`
}

func selectorAuditFromModel(m dbservice.SelectorAudit) SelectorAuditEntry {
	var rep json.RawMessage
	if len(m.ReportJSON) > 0 {
		rep = json.RawMessage(m.ReportJSON)
	}
	var base json.RawMessage
	if len(m.BaselineJSON) > 0 {
		base = json.RawMessage(m.BaselineJSON)
	}
	return SelectorAuditEntry{
		ID:            m.ID,
		ViewType:      m.ViewType,
		OverallStatus: m.OverallStatus,
		Report:        rep,
		Baseline:      base,
		CreatedAt:     m.CreatedAt.UTC().Format("2006-01-02T15:04:05Z07:00"),
	}
}

func computeOverallAuditStatus(counts driftCounts) string {
	switch {
	case counts.BrokenSelectorsCount > 0:
		return "BROKEN"
	case counts.DegradedSelectorsCount > 0:
		return "DEGRADED"
	case counts.FragileSelectorsCount > 0:
		return "FRAGILE"
	default:
		return "HEALTHY"
	}
}

func isValidAuditStatus(status string) bool {
	switch status {
	case "HEALTHY", "DEGRADED", "BROKEN", "FRAGILE":
		return true
	default:
		return false
	}
}

// ListTabs queries the connected browser extension for open upwork.com tabs.
func (s *Server) ListTabs(ctx context.Context) (*TabsListResponse, error) {
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}
	rawRes, err := s.bridgeHub.CallExtension(ctx, "tabs.list", map[string]any{}, 10*time.Second)
	if err != nil {
		return nil, err
	}
	var out TabsListResponse
	if err := json.Unmarshal(rawRes, &out); err != nil {
		return nil, fmt.Errorf("invalid tabs.list RPC result: %w", err)
	}
	if out.Tabs == nil {
		out.Tabs = []TabEntry{}
	}
	return &out, nil
}

func isValidAuditView(view string) bool {
	switch view {
	case "", "search_listings", "search_results", "best_matches", "most_recent", "saved_jobs",
		"job_detail", "proposal_apply", "proposals_list", "messages_rooms", "messages_thread", "messages":
		return true
	default:
		return false
	}
}

// AuditSelectors runs a live selector drift audit on the connected extension tab.
func (s *Server) AuditSelectors(ctx context.Context, req AuditSelectorsRequest) (*AuditSelectorsResponse, error) {
	view := strings.TrimSpace(req.View)
	if !isValidAuditView(view) {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("invalid selector audit view %q", view),
		}
	}
	explicitURL := strings.TrimSpace(req.URL)
	if !req.UseActiveTab {
		if view == "" && explicitURL == "" {
			view = "search_listings"
		}
		if view == "messages" && explicitURL == "" {
			view = "messages_rooms"
		}
		if explicitURL == "" && (view == "job_detail" || view == "proposal_apply" || view == "messages_thread") {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    fmt.Sprintf("url is required when auditing view %q", view),
			}
		}
	}

	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	updateBaseline := req.UpdateBaseline || req.SaveBaseline
	wsParams := map[string]any{
		"update_baseline": updateBaseline,
		"use_active_tab":  req.UseActiveTab,
	}
	if view != "" {
		wsParams["view"] = view
	}
	if explicitURL != "" {
		wsParams["url"] = explicitURL
	}

	rawRes, err := s.bridgeHub.CallExtension(ctx, "audit.selectors", wsParams, 60*time.Second)
	if err != nil {
		s.auditBridgeChallenge("audit_selectors", firstNonEmpty(view, explicitURL), err)
		return nil, err
	}

	var rpcOut struct {
		OK                 bool                `json:"ok"`
		OverallStatus      string              `json:"overall_status"`
		TotalCardsDetected *int                `json:"total_cards_detected"`
		Audit              *SelectorAuditEntry `json:"audit"`
		Report             json.RawMessage     `json:"report"`
		Blueprint          json.RawMessage     `json:"blueprint"`
	}
	if err := json.Unmarshal(rawRes, &rpcOut); err != nil {
		return nil, fmt.Errorf("invalid audit.selectors RPC result: %w", err)
	}

	var reportMeta struct {
		ViewType                string               `json:"view_type"`
		OverallStatus           string               `json:"overall_status"`
		TotalCardsDetected      *int                 `json:"total_cards_detected"`
		Rules                   json.RawMessage      `json:"rules"`
		FieldResults            []AuditRuleResult    `json:"field_results"`
		Audits                  []extensionAuditItem `json:"audits"`
		DiscoveredCandidates    json.RawMessage      `json:"discovered_candidates"`
		BaselineDiff            json.RawMessage      `json:"baseline_diff"`
		BaselineDiffs           json.RawMessage      `json:"baseline_diffs"`
		BreakingChangesDetected json.RawMessage      `json:"breaking_changes_detected"`
	}
	if len(rpcOut.Report) > 0 {
		_ = json.Unmarshal(rpcOut.Report, &reportMeta)
	}

	var blueprintMeta struct {
		JobCardBlueprint *struct {
			TotalCardsDetected int `json:"total_cards_detected"`
		} `json:"job_card_blueprint"`
	}
	if len(rpcOut.Blueprint) > 0 {
		_ = json.Unmarshal(rpcOut.Blueprint, &blueprintMeta)
	}

	overallStatus := firstNonEmpty(rpcOut.OverallStatus, reportMeta.OverallStatus)
	viewType := firstNonEmpty(reportMeta.ViewType, view, "search_listings")

	// Persist fallback only if the extension did not already persist via /api/selector-audits.
	auditEntry := rpcOut.Audit
	if auditEntry == nil && s.db != nil && s.db.GetGorm() != nil && len(rpcOut.Report) > 0 {
		fallbackPayload, _ := json.Marshal(map[string]any{
			"view_type":      viewType,
			"overall_status": overallStatus,
			"report":         json.RawMessage(rpcOut.Report),
			"baseline":       json.RawMessage(rpcOut.Blueprint),
		})
		if saved, saveErr := s.SaveSelectorAudit(ctx, fallbackPayload); saveErr == nil {
			auditEntry = saved
		}
	}
	if auditEntry != nil && overallStatus == "" {
		overallStatus = auditEntry.OverallStatus
	}

	totalCards := 0
	if reportMeta.TotalCardsDetected != nil {
		totalCards = *reportMeta.TotalCardsDetected
	} else if rpcOut.TotalCardsDetected != nil {
		totalCards = *rpcOut.TotalCardsDetected
	} else if blueprintMeta.JobCardBlueprint != nil {
		totalCards = blueprintMeta.JobCardBlueprint.TotalCardsDetected
	}

	rulesRaw, fieldResults := synthesizeAuditRulesAndFields(reportMeta.Rules, reportMeta.FieldResults, reportMeta.Audits)

	discoveredCandidates := defaultJSONArray(reportMeta.DiscoveredCandidates)
	baselineDiff, hasBreakingDiffA := normalizeBaselineDiffs(reportMeta.BaselineDiff)
	baselineDiffs, hasBreakingDiffB := normalizeBaselineDiffs(reportMeta.BaselineDiffs)
	if len(baselineDiff) == 0 && len(baselineDiffs) > 0 {
		baselineDiff = baselineDiffs
	} else if len(baselineDiffs) == 0 && len(baselineDiff) > 0 {
		baselineDiffs = baselineDiff
	}
	if len(baselineDiff) == 0 {
		baselineDiff = json.RawMessage("[]")
	}
	if len(baselineDiffs) == 0 {
		baselineDiffs = json.RawMessage("[]")
	}

	breakingDetected := parseBreakingChangesFlag(reportMeta.BreakingChangesDetected) ||
		hasBreakingDiffA || hasBreakingDiffB || strings.EqualFold(overallStatus, "BROKEN")

	return &AuditSelectorsResponse{
		OK:                      rpcOut.OK || overallStatus != "",
		ViewType:                viewType,
		OverallStatus:           overallStatus,
		TotalCardsDetected:      totalCards,
		Rules:                   rulesRaw,
		FieldResults:            fieldResults,
		DiscoveredCandidates:    discoveredCandidates,
		BaselineDiff:            baselineDiff,
		BaselineDiffs:           baselineDiffs,
		BreakingChangesDetected: breakingDetected,
		Audit:                   auditEntry,
		Report:                  rpcOut.Report,
		Blueprint:               rpcOut.Blueprint,
	}, nil
}

type extensionAuditItem struct {
	TargetField          string  `json:"target_field"`
	View                 string  `json:"view"`
	RegisteredSelector   string  `json:"registered_selector"`
	Status               string  `json:"status"`
	MatchedCount         int     `json:"matched_count"`
	Notes                string  `json:"notes"`
	SuggestedReplacement *string `json:"suggested_replacement"`
}

func isNonEmptyJSONValue(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte("{}")) || bytes.Equal(trimmed, []byte("[]")) {
		return false
	}
	return true
}

func defaultJSONArray(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return json.RawMessage("[]")
	}
	return trimmed
}

func synthesizeAuditRulesAndFields(rawRules json.RawMessage, existingFields []AuditRuleResult, audits []extensionAuditItem) (json.RawMessage, []AuditRuleResult) {
	fieldResults := make([]AuditRuleResult, 0, len(audits)+2)
	if len(existingFields) > 0 {
		fieldResults = append(fieldResults, existingFields...)
	}

	synthesizedRules := make(map[string]AuditRuleResult, len(audits)+2)
	for _, a := range audits {
		var repl string
		if a.SuggestedReplacement != nil {
			repl = *a.SuggestedReplacement
		}
		makeRule := func(fieldName string) AuditRuleResult {
			return AuditRuleResult{
				Field:                fieldName,
				Status:               a.Status,
				MatchedCount:         a.MatchedCount,
				SuggestedReplacement: repl,
				Reason:               a.Notes,
				RegisteredSelector:   a.RegisteredSelector,
				View:                 a.View,
			}
		}

		tf := strings.TrimSpace(a.TargetField)
		if tf == "" {
			continue
		}
		if tf == "title_and_url" {
			titleRule := makeRule("title")
			urlRule := makeRule("url")
			synthesizedRules["title"] = titleRule
			synthesizedRules["url"] = urlRule
			synthesizedRules["title_and_url"] = makeRule("title_and_url")
			if len(existingFields) == 0 {
				fieldResults = append(fieldResults, titleRule, urlRule)
			}
			continue
		}
		rule := makeRule(tf)
		synthesizedRules[tf] = rule
		if len(existingFields) == 0 {
			fieldResults = append(fieldResults, rule)
		}
	}

	var outRules json.RawMessage
	if isNonEmptyJSONValue(rawRules) {
		outRules = bytes.TrimSpace(rawRules)
		if len(fieldResults) == 0 {
			var rulesMap map[string]AuditRuleResult
			if json.Unmarshal(outRules, &rulesMap) == nil && len(rulesMap) > 0 {
				for k, v := range rulesMap {
					if v.Field == "" {
						v.Field = k
					}
					fieldResults = append(fieldResults, v)
				}
			}
		}
	} else if len(synthesizedRules) > 0 {
		if encoded, err := json.Marshal(synthesizedRules); err == nil {
			outRules = json.RawMessage(encoded)
		}
	}
	if !isNonEmptyJSONValue(outRules) && len(bytes.TrimSpace(outRules)) == 0 {
		outRules = json.RawMessage("{}")
	}
	if fieldResults == nil {
		fieldResults = []AuditRuleResult{}
	}
	return outRules, fieldResults
}

func normalizeBaselineDiffs(raw json.RawMessage) (json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, false
	}
	var items []map[string]any
	if err := json.Unmarshal(trimmed, &items); err != nil {
		return trimmed, false
	}
	hasBreaking := false
	for _, item := range items {
		if item == nil {
			continue
		}
		if _, hasHook := item["hook"]; !hasHook {
			if hn, ok := item["hook_name"].(string); ok && hn != "" {
				item["hook"] = hn
			}
		}
		if _, hasPrev := item["previous_frequency"]; !hasPrev {
			if bf, ok := item["baseline_frequency"]; ok {
				item["previous_frequency"] = bf
			}
		}
		for _, k := range []string{"diff_type", "change_type", "change", "type"} {
			if ct, ok := item[k].(string); ok {
				upper := strings.ToUpper(strings.TrimSpace(ct))
				if upper == "REMOVED" || upper == "FREQUENCY_DROPPED" {
					hasBreaking = true
				}
			}
		}
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return trimmed, hasBreaking
	}
	return json.RawMessage(encoded), hasBreaking
}

func parseBreakingChangesFlag(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return false
	}
	var b bool
	if json.Unmarshal(trimmed, &b) == nil {
		return b
	}
	var list []string
	if json.Unmarshal(trimmed, &list) == nil {
		return len(list) > 0
	}
	return false
}

// SaveSelectorAudit validates and persists a selector drift audit payload.
func (s *Server) SaveSelectorAudit(ctx context.Context, rawBody []byte) (*SelectorAuditEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	var req selectorAuditRequest
	if err := json.Unmarshal(rawBody, &req); err != nil {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid selector audit payload"}
	}

	reportBytes := req.Report
	if len(reportBytes) == 0 || string(reportBytes) == "null" {
		// Flat DriftAuditReport JSON passed at top level
		reportBytes = rawBody
	}

	var counts driftCounts
	if err := json.Unmarshal(reportBytes, &counts); err != nil {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid report JSON"}
	}

	viewType := strings.TrimSpace(req.ViewType)
	if viewType == "" {
		viewType = strings.TrimSpace(counts.ViewType)
	}
	if viewType == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "view_type is required"}
	}

	overallStatus := strings.ToUpper(strings.TrimSpace(req.OverallStatus))
	if overallStatus == "" {
		overallStatus = computeOverallAuditStatus(counts)
	}
	if !isValidAuditStatus(overallStatus) {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "overall_status must be HEALTHY, DEGRADED, BROKEN, or FRAGILE"}
	}

	reportJSONB, err := parseFlexibleJSONB(reportBytes)
	if err != nil || len(reportJSONB) == 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "report must be valid JSON"}
	}
	var baselineJSONB dbservice.JSONB
	if len(req.Baseline) > 0 {
		baselineJSONB, err = parseFlexibleJSONB(req.Baseline)
		if err != nil {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "baseline must be valid JSON"}
		}
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	if len(baselineJSONB) == 0 {
		var prev dbservice.SelectorAudit
		prevErr := gormDB.
			Select("baseline_json").
			Where("view_type = ? AND baseline_json IS NOT NULL", viewType).
			Order("created_at DESC, id DESC").
			Limit(1).
			First(&prev).Error
		if prevErr == nil && len(prev.BaselineJSON) > 0 {
			baselineJSONB = prev.BaselineJSON
		} else if prevErr != nil && !errors.Is(prevErr, gorm.ErrRecordNotFound) {
			log.Printf("⚠️ Failed to query prior selector baseline for %q: %v", viewType, prevErr)
		}
	}

	audit := dbservice.SelectorAudit{
		ViewType:      viewType,
		OverallStatus: overallStatus,
		ReportJSON:    reportJSONB,
		BaselineJSON:  baselineJSONB,
	}

	if err := gormDB.Create(&audit).Error; err != nil {
		log.Printf("❌ Failed to save selector audit: %v", err)
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to save selector audit"}
	}

	entry := selectorAuditFromModel(audit)
	return &entry, nil
}

// ListSelectorAudits returns stored selector drift audits with optional view_type, status, and latest-per-view filtering.
func (s *Server) ListSelectorAudits(ctx context.Context, viewType, overallStatus string, latest bool, limit int) ([]SelectorAuditEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	viewType = strings.TrimSpace(viewType)
	overallStatus = strings.ToUpper(strings.TrimSpace(overallStatus))
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	db := s.db.GetGorm().WithContext(ctx).Model(&dbservice.SelectorAudit{})
	if viewType != "" {
		db = db.Where("view_type = ?", viewType)
	}
	if overallStatus != "" {
		if !isValidAuditStatus(overallStatus) {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "overall_status must be HEALTHY, DEGRADED, BROKEN, or FRAGILE"}
		}
		db = db.Where("overall_status = ?", overallStatus)
	}

	var rows []dbservice.SelectorAudit
	if latest {
		if err := db.Select("DISTINCT ON (view_type) *").
			Order("view_type ASC, created_at DESC, id DESC").
			Limit(limit).
			Find(&rows).Error; err != nil {
			log.Printf("❌ Failed to list latest selector audits: %v", err)
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list selector audits"}
		}
	} else {
		if err := db.Order("created_at DESC, id DESC").
			Limit(limit).
			Find(&rows).Error; err != nil {
			log.Printf("❌ Failed to list selector audits: %v", err)
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list selector audits"}
		}
	}

	audits := make([]SelectorAuditEntry, 0, len(rows))
	for _, row := range rows {
		audits = append(audits, selectorAuditFromModel(row))
	}
	return audits, nil
}

func (s *Server) createSelectorAuditHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var rawBody json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&rawBody); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	entry, err := s.SaveSelectorAudit(r.Context(), rawBody)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if err := json.NewEncoder(w).Encode(map[string]any{
		"audit": entry,
	}); err != nil {
		log.Printf("⚠️ Failed to encode selector audit response: %v", err)
	}
}

func (s *Server) listSelectorAuditsHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	q := r.URL.Query()
	viewType := strings.TrimSpace(q.Get("view_type"))
	overallStatus := strings.ToUpper(strings.TrimSpace(q.Get("overall_status")))
	if overallStatus == "" {
		overallStatus = strings.ToUpper(strings.TrimSpace(q.Get("status")))
	}
	latest := strings.EqualFold(strings.TrimSpace(q.Get("latest")), "true")

	limit := 20
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			respondWithError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if parsed > 100 {
			parsed = 100
		}
		limit = parsed
	}

	audits, err := s.ListSelectorAudits(r.Context(), viewType, overallStatus, latest, limit)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	respondWithJSON(w, map[string]any{
		"audits": audits,
	})
}
