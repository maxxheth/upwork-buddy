package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
	"gorm.io/gorm"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/diagnostics"
	"upwork-buddy/internal/policy"
)

// CaptureUIDiagnosticRequest configures a live DOM diagnostic capture via the connected browser extension.
type CaptureUIDiagnosticRequest struct {
	Scope             string   `json:"scope,omitempty"`
	View              string   `json:"view,omitempty"`
	URL               string   `json:"url,omitempty"`
	UseActiveTab      *bool    `json:"use_active_tab,omitempty"`
	TabID             *int     `json:"tab_id,omitempty"`
	IncludeScreenshot bool     `json:"include_screenshot,omitempty"`
	RedactPII         *bool    `json:"redact_pii,omitempty"`
	BrokenFields      []string `json:"broken_fields,omitempty"`
}

// DiagnosticArtifacts lists disk paths of exported bundle artifacts for a capture.
type DiagnosticArtifacts struct {
	BundleDir      string `json:"bundle_dir"`
	SnapshotPath   string `json:"snapshot_path"`
	PrunedHTMLPath string `json:"pruned_html_path"`
	MarkdownPath   string `json:"markdown_path"`
	ScreenshotPath string `json:"screenshot_path,omitempty"`
	HasScreenshot  bool   `json:"has_screenshot"`
}

// UIDiagnosticCaptureEntry represents a persisted UI diagnostic capture summary.
type UIDiagnosticCaptureEntry struct {
	ID            uint                              `json:"id"`
	CaptureUID    string                            `json:"capture_uid"`
	ViewType      string                            `json:"view_type"`
	PageURL       string                            `json:"page_url"`
	OverallStatus string                            `json:"overall_status"`
	BrokenCount   int                               `json:"broken_count"`
	BrokenFields  []diagnostics.BrokenFieldDiagnosis `json:"broken_fields"`
	BundleDir     string                            `json:"bundle_dir"`
	HasScreenshot bool                              `json:"has_screenshot"`
	Summary       json.RawMessage                   `json:"summary,omitempty"`
	Artifacts     *DiagnosticArtifacts              `json:"artifacts,omitempty"`
	CreatedAt     string                            `json:"created_at"`
}

// UIDiagnosticCaptureDetail returns a capture summary along with rendered markdown, optional pruned HTML, and snapshot JSON.
type UIDiagnosticCaptureDetail struct {
	OK         bool                         `json:"ok"`
	CaptureUID string                       `json:"capture_uid"`
	Entry      UIDiagnosticCaptureEntry     `json:"entry"`
	Capture    *diagnostics.CapturePayload  `json:"capture,omitempty"`
	Markdown   string                       `json:"markdown"`
	PrunedHTML string                       `json:"pruned_html,omitempty"`
	Artifacts  DiagnosticArtifacts          `json:"artifacts"`
}

// FieldRuleInput allows callers (extension/MCP/HTTP) to specify rule fields either flat or nested under rule.
type FieldRuleInput struct {
	Selectors       []string `json:"selectors"`
	Extract         string   `json:"extract,omitempty"`
	Attribute       string   `json:"attribute,omitempty"`
	Transforms      []string `json:"transforms,omitempty"`
	SiblingChildTag string   `json:"sibling_child_tag,omitempty"`
	JoinWith        string   `json:"join_with,omitempty"`
	LabelContains   string   `json:"label_contains,omitempty"`
	Required        *bool    `json:"required,omitempty"`
	IsFragile       *bool    `json:"is_fragile,omitempty"`
	FragileReason   *string  `json:"fragile_reason,omitempty"`
	AuthOnly        *bool    `json:"auth_only,omitempty"`
	Description     string   `json:"description,omitempty"`
}

// TestSelectorPatchRequest configures a non-destructive YAML + DOM dry-run test for a selector patch.
type TestSelectorPatchRequest struct {
	View            string          `json:"view"`
	Field           string          `json:"field"`
	Rule            *FieldRuleInput `json:"rule,omitempty"`
	Selectors       []string        `json:"selectors,omitempty"`
	Extract         string          `json:"extract,omitempty"`
	Attribute       string          `json:"attribute,omitempty"`
	Transforms      []string        `json:"transforms,omitempty"`
	SiblingChildTag string          `json:"sibling_child_tag,omitempty"`
	JoinWith        string          `json:"join_with,omitempty"`
	LabelContains   string          `json:"label_contains,omitempty"`
	Required        *bool           `json:"required,omitempty"`
	IsFragile       *bool           `json:"is_fragile,omitempty"`
	FragileReason   *string         `json:"fragile_reason,omitempty"`
	AuthOnly        *bool           `json:"auth_only,omitempty"`
	Description     string          `json:"description,omitempty"`
	Mode            string          `json:"mode,omitempty"`
	CaptureID       string          `json:"capture_id,omitempty"`
	UseActiveTab    *bool           `json:"use_active_tab,omitempty"`
	TabID           *int            `json:"tab_id,omitempty"`
	PrunedHTML      string          `json:"pruned_html,omitempty"`
	SkipDOMTest     bool            `json:"skip_dom_test,omitempty"`
}

// SelectorPatchFieldSummary mirrors the TS dry-run per-field extraction result.
type SelectorPatchFieldSummary struct {
	Status          string `json:"status"`
	MatchedCount    int    `json:"matched_count"`
	SampleValue     any    `json:"sample_value"`
	MatchedSelector string `json:"matched_selector,omitempty"`
}

// SelectorPatchRegression captures any sibling field that degraded during dry-run testing.
type SelectorPatchRegression struct {
	Field        string `json:"field"`
	BeforeStatus string `json:"before_status"`
	AfterStatus  string `json:"after_status"`
	Reason       string `json:"reason"`
}

// TestSelectorPatchResponse combines YAML schema/diff validation and live DOM extraction dry-run metrics.
type TestSelectorPatchResponse struct {
	OK            bool                      `json:"ok"`
	View          string                    `json:"view"`
	Field         string                    `json:"field"`
	Status        string                    `json:"status,omitempty"`
	MatchedCount  int                       `json:"matched_count"`
	SampleValue   any                       `json:"sample_value,omitempty"`
	Regressions   []SelectorPatchRegression `json:"regressions"`
	BeforeSummary *SelectorPatchFieldSummary `json:"before_summary,omitempty"`
	AfterSummary  *SelectorPatchFieldSummary `json:"after_summary,omitempty"`
	OldVersion    string                    `json:"old_version"`
	NewVersion    string                    `json:"new_version"`
	YAMLDiff      string                    `json:"yaml_diff"`
	ValidYAML     bool                      `json:"valid_yaml"`
	DOMTested     bool                      `json:"dom_tested"`
}

// ApplySelectorPatchRequest configures an atomic YAML selector patch + backup + extension reload.
type ApplySelectorPatchRequest struct {
	View            string          `json:"view"`
	Field           string          `json:"field"`
	Rule            *FieldRuleInput `json:"rule,omitempty"`
	Selectors       []string        `json:"selectors,omitempty"`
	Extract         string          `json:"extract,omitempty"`
	Attribute       string          `json:"attribute,omitempty"`
	Transforms      []string        `json:"transforms,omitempty"`
	SiblingChildTag string          `json:"sibling_child_tag,omitempty"`
	JoinWith        string          `json:"join_with,omitempty"`
	LabelContains   string          `json:"label_contains,omitempty"`
	Required        *bool           `json:"required,omitempty"`
	IsFragile       *bool           `json:"is_fragile,omitempty"`
	FragileReason   *string         `json:"fragile_reason,omitempty"`
	AuthOnly        *bool           `json:"auth_only,omitempty"`
	Description     string          `json:"description,omitempty"`
	Mode            string          `json:"mode,omitempty"`
	Reason          string          `json:"reason,omitempty"`
	CaptureID       string          `json:"capture_id,omitempty"`
}

// ApplySelectorPatchResponse reports version bump, backup file, diff, and live reload status.
type ApplySelectorPatchResponse struct {
	OK                bool   `json:"ok"`
	OldVersion        string `json:"old_version"`
	NewVersion        string `json:"new_version"`
	View              string `json:"view"`
	Field             string `json:"field"`
	BackupPath        string `json:"backup_path"`
	BackupFile        string `json:"backup_file"`
	Diff              string `json:"diff"`
	ReloadedExtension bool   `json:"reloaded_extension"`
	ReloadWarning     string `json:"reload_warning,omitempty"`
}

// RollbackSelectorPatchRequest selects a backup YAML file (or latest when omitted) to restore.
type RollbackSelectorPatchRequest struct {
	BackupFile string `json:"backup_file,omitempty"`
}

// RollbackSelectorPatchResponse reports the restored backup metadata and live extension reload status.
type RollbackSelectorPatchResponse struct {
	OK                bool   `json:"ok"`
	RestoredFrom      string `json:"restored_from"`
	BackupFile        string `json:"backup_file"`
	Version           string `json:"version"`
	ReloadedExtension bool   `json:"reloaded_extension"`
	ReloadWarning     string `json:"reload_warning,omitempty"`
}

func normalizeDiagnosticScope(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "auto":
		return "auto", nil
	case "drawer":
		return "drawer", nil
	case "page":
		return "page", nil
	default:
		return "", &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("invalid diagnostic scope %q (expected 'auto', 'drawer', or 'page')", raw),
		}
	}
}

func normalizePatchView(raw string) (string, error) {
	view := strings.TrimSpace(raw)
	if view == "search_results" {
		view = "search_listings"
	}
	switch view {
	case "search_listings", "best_matches", "most_recent", "saved_jobs",
		"job_detail", "proposal_apply", "proposals_list", "messages_rooms", "messages_thread":
		return view, nil
	default:
		return "", &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("invalid target patch view %q", raw),
		}
	}
}

func buildFieldRulePatch(
	view, field string,
	rule *FieldRuleInput,
	flatSelectors []string,
	flatExtract, flatAttr string,
	flatTransforms []string,
	flatSiblingTag, flatJoinWith, flatLabel string,
	flatRequired, flatFragile *bool,
	flatFragileReason *string,
	flatAuthOnly *bool,
	flatDescription, mode, reason string,
) diagnostics.FieldRulePatch {
	patch := diagnostics.FieldRulePatch{
		View:            strings.TrimSpace(view),
		Field:           strings.TrimSpace(field),
		Selectors:       flatSelectors,
		Extract:         strings.TrimSpace(flatExtract),
		Attribute:       strings.TrimSpace(flatAttr),
		Transforms:      flatTransforms,
		SiblingChildTag: strings.TrimSpace(flatSiblingTag),
		JoinWith:        flatJoinWith,
		LabelContains:   flatLabel,
		Required:        flatRequired,
		IsFragile:       flatFragile,
		FragileReason:   flatFragileReason,
		AuthOnly:        flatAuthOnly,
		Description:     strings.TrimSpace(flatDescription),
		Mode:            strings.TrimSpace(mode),
		Reason:          strings.TrimSpace(reason),
	}
	if rule != nil {
		if len(patch.Selectors) == 0 && len(rule.Selectors) > 0 {
			patch.Selectors = rule.Selectors
		}
		if patch.Extract == "" {
			patch.Extract = strings.TrimSpace(rule.Extract)
		}
		if patch.Attribute == "" {
			patch.Attribute = strings.TrimSpace(rule.Attribute)
		}
		if len(patch.Transforms) == 0 && len(rule.Transforms) > 0 {
			patch.Transforms = rule.Transforms
		}
		if patch.SiblingChildTag == "" {
			patch.SiblingChildTag = strings.TrimSpace(rule.SiblingChildTag)
		}
		if patch.JoinWith == "" {
			patch.JoinWith = rule.JoinWith
		}
		if patch.LabelContains == "" {
			patch.LabelContains = rule.LabelContains
		}
		if patch.Required == nil {
			patch.Required = rule.Required
		}
		if patch.IsFragile == nil {
			patch.IsFragile = rule.IsFragile
		}
		if patch.FragileReason == nil {
			patch.FragileReason = rule.FragileReason
		}
		if patch.AuthOnly == nil {
			patch.AuthOnly = rule.AuthOnly
		}
		if patch.Description == "" {
			patch.Description = strings.TrimSpace(rule.Description)
		}
	}
	return patch
}

type previewYamlConfig struct {
	Views map[string]struct {
		ContainerSelectors []string `yaml:"container_selectors"`
		Fields             map[string]struct {
			Selectors       []string `yaml:"selectors"`
			Extract         string   `yaml:"extract"`
			Attribute       string   `yaml:"attribute,omitempty"`
			Transforms      []string `yaml:"transforms,omitempty"`
			SiblingChildTag string   `yaml:"sibling_child_tag,omitempty"`
			JoinWith        string   `yaml:"join_with,omitempty"`
			LabelContains   string   `yaml:"label_contains,omitempty"`
		} `yaml:"fields"`
	} `yaml:"views"`
}

func extractMergedRulePayload(patchedYAML []byte, view, field string, fallback diagnostics.FieldRulePatch) map[string]any {
	var parsed previewYamlConfig
	if err := yaml.Unmarshal(patchedYAML, &parsed); err == nil {
		if vCfg, ok := parsed.Views[view]; ok {
			if field == "container_selectors" || field == "job_cards_container" || field == "items_container" {
				if len(vCfg.ContainerSelectors) > 0 {
					return map[string]any{
						"selectors": vCfg.ContainerSelectors,
						"extract":   "text",
					}
				}
			} else if fCfg, ok := vCfg.Fields[field]; ok && len(fCfg.Selectors) > 0 {
				out := map[string]any{
					"selectors": fCfg.Selectors,
					"extract":   firstNonEmpty(fCfg.Extract, "text"),
				}
				if fCfg.Attribute != "" {
					out["attribute"] = fCfg.Attribute
				}
				if len(fCfg.Transforms) > 0 {
					out["transforms"] = fCfg.Transforms
				}
				if fCfg.SiblingChildTag != "" {
					out["sibling_child_tag"] = fCfg.SiblingChildTag
				}
				if fCfg.JoinWith != "" {
					out["join_with"] = fCfg.JoinWith
				}
				if fCfg.LabelContains != "" {
					out["label_contains"] = fCfg.LabelContains
				}
				return out
			}
		}
	}

	out := map[string]any{
		"selectors": fallback.Selectors,
		"extract":   firstNonEmpty(fallback.Extract, "text"),
	}
	if fallback.Attribute != "" {
		out["attribute"] = fallback.Attribute
	}
	if len(fallback.Transforms) > 0 {
		out["transforms"] = fallback.Transforms
	}
	if fallback.SiblingChildTag != "" {
		out["sibling_child_tag"] = fallback.SiblingChildTag
	}
	if fallback.JoinWith != "" {
		out["join_with"] = fallback.JoinWith
	}
	if fallback.LabelContains != "" {
		out["label_contains"] = fallback.LabelContains
	}
	return out
}

func mapDiagnosticError(err error) error {
	if err == nil {
		return nil
	}
	var se *ServiceError
	if errors.As(err, &se) {
		return err
	}
	msg := err.Error()
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "no backup") || strings.Contains(lower, "not found") || os.IsNotExist(err) {
		return &ServiceError{
			Code:       "NOT_FOUND",
			HTTPStatus: http.StatusNotFound,
			Message:    msg,
		}
	}
	if strings.Contains(lower, "required") ||
		strings.Contains(lower, "invalid") ||
		strings.Contains(lower, "unsupported") ||
		strings.Contains(lower, "unbalanced") ||
		strings.Contains(lower, "selector") ||
		strings.Contains(lower, "parse") {
		return &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    msg,
		}
	}
	return &ServiceError{
		Code:       "DIAGNOSTIC_ERROR",
		HTTPStatus: http.StatusInternalServerError,
		Message:    msg,
	}
}

func uiDiagnosticEntryFromModel(row dbservice.UIDiagnosticCapture) UIDiagnosticCaptureEntry {
	var brokenFields []diagnostics.BrokenFieldDiagnosis
	if len(row.BrokenFieldsJSON) > 0 {
		_ = json.Unmarshal(row.BrokenFieldsJSON, &brokenFields)
	}
	if brokenFields == nil {
		brokenFields = []diagnostics.BrokenFieldDiagnosis{}
	}

	var summary json.RawMessage
	if len(row.SummaryJSON) > 0 {
		summary = json.RawMessage(row.SummaryJSON)
	}

	var artifacts *DiagnosticArtifacts
	if strings.TrimSpace(row.BundleDir) != "" {
		artifacts = &DiagnosticArtifacts{
			BundleDir:      row.BundleDir,
			SnapshotPath:   filepath.Join(row.BundleDir, "snapshot.json"),
			PrunedHTMLPath: filepath.Join(row.BundleDir, "pruned.html"),
			MarkdownPath:   filepath.Join(row.BundleDir, "diagnostic.md"),
			HasScreenshot:  row.HasScreenshot,
		}
		if row.HasScreenshot {
			artifacts.ScreenshotPath = filepath.Join(row.BundleDir, "screenshot.png")
		}
	}

	return UIDiagnosticCaptureEntry{
		ID:            row.ID,
		CaptureUID:    row.CaptureUID,
		ViewType:      row.ViewType,
		PageURL:       row.PageURL,
		OverallStatus: row.OverallStatus,
		BrokenCount:   row.BrokenCount,
		BrokenFields:  brokenFields,
		BundleDir:     row.BundleDir,
		HasScreenshot: row.HasScreenshot,
		Summary:       summary,
		Artifacts:     artifacts,
		CreatedAt:     row.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func resolveContainmentSafeFile(baseDir, bundleDir, filename string) (string, error) {
	if strings.Contains(filename, "/") || strings.Contains(filename, `\`) || strings.Contains(filename, "..") {
		return "", &ServiceError{
			Code:       "INVALID_PATH",
			HTTPStatus: http.StatusBadRequest,
			Message:    "invalid artifact filename",
		}
	}
	baseAbs, err := filepath.Abs(baseDir)
	if err != nil {
		return "", err
	}
	bundleAbs, err := filepath.Abs(bundleDir)
	if err != nil {
		return "", err
	}
	relBundle, err := filepath.Rel(baseAbs, bundleAbs)
	if err != nil || relBundle == ".." || strings.HasPrefix(relBundle, ".."+string(filepath.Separator)) || filepath.IsAbs(relBundle) {
		return "", &ServiceError{
			Code:       "INVALID_PATH",
			HTTPStatus: http.StatusForbidden,
			Message:    "capture bundle directory escapes configured diagnostics directory",
		}
	}

	targetAbs := filepath.Join(bundleAbs, filename)
	if resolvedBase, evalBaseErr := filepath.EvalSymlinks(baseAbs); evalBaseErr == nil {
		if resolvedTarget, evalTargetErr := filepath.EvalSymlinks(targetAbs); evalTargetErr == nil {
			relResolved, relErr := filepath.Rel(resolvedBase, resolvedTarget)
			if relErr != nil || relResolved == ".." || strings.HasPrefix(relResolved, ".."+string(filepath.Separator)) {
				return "", &ServiceError{
					Code:       "INVALID_PATH",
					HTTPStatus: http.StatusForbidden,
					Message:    "artifact path resolves outside diagnostics directory",
				}
			}
			return resolvedTarget, nil
		}
	}
	return targetAbs, nil
}

func (s *Server) notifySelectorsReloaded(ctx context.Context, source string, details map[string]any) (bool, string) {
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return false, "browser extension disconnected; updated YAML will load on reconnect"
	}
	reloadCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	params := map[string]any{
		"source": source,
	}
	for k, v := range details {
		params[k] = v
	}
	if _, err := s.bridgeHub.CallExtension(reloadCtx, "selectors.reload", params, 10*time.Second); err != nil {
		return false, err.Error()
	}
	return true, ""
}

// CaptureUIDiagnostic asks the connected browser extension to capture a pruned DOM diagnostic bundle,
// writes markdown/json/html artifacts to disk, and records a searchable row in Postgres.
func (s *Server) CaptureUIDiagnostic(ctx context.Context, req CaptureUIDiagnosticRequest) (*UIDiagnosticCaptureDetail, error) {
	view := strings.TrimSpace(req.View)
	if !isValidAuditView(view) {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("invalid view %q", view),
		}
	}
	scope, err := normalizeDiagnosticScope(req.Scope)
	if err != nil {
		return nil, err
	}
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	explicitURL := strings.TrimSpace(req.URL)
	useActiveTab := explicitURL == ""
	if req.UseActiveTab != nil {
		useActiveTab = *req.UseActiveTab
	}
	redactPII := true
	if req.RedactPII != nil {
		redactPII = *req.RedactPII
	}

	wsParams := map[string]any{
		"scope":              scope,
		"use_active_tab":     useActiveTab,
		"include_screenshot": req.IncludeScreenshot,
		"redact_pii":         redactPII,
	}
	if view != "" {
		wsParams["view"] = view
	}
	if explicitURL != "" {
		wsParams["url"] = explicitURL
	}
	if req.TabID != nil {
		wsParams["tab_id"] = *req.TabID
	}
	if len(req.BrokenFields) > 0 {
		wsParams["broken_fields"] = req.BrokenFields
	}

	rawRes, err := s.bridgeHub.CallExtension(ctx, "diagnostics.capture", wsParams, 45*time.Second)
	if err != nil {
		return nil, err
	}

	var rpcOut struct {
		OK      bool                        `json:"ok"`
		Capture *diagnostics.CapturePayload `json:"capture"`
	}
	if err := json.Unmarshal(rawRes, &rpcOut); err != nil {
		return nil, &ServiceError{
			Code:       "INVALID_RPC_RESULT",
			HTTPStatus: http.StatusBadGateway,
			Message:    fmt.Sprintf("invalid diagnostics.capture RPC result: %v", err),
		}
	}
	if rpcOut.Capture == nil {
		return nil, &ServiceError{
			Code:       "INVALID_RPC_RESULT",
			HTTPStatus: http.StatusBadGateway,
			Message:    "diagnostics.capture RPC returned empty capture payload",
		}
	}

	detail, err := s.IngestUIDiagnostic(ctx, *rpcOut.Capture)
	if err != nil {
		return nil, err
	}

	_ = s.PolicyEngine().RecordAudit(policy.AuditEntry{
		ActionType: "ui_diagnostic_capture",
		Actor:      "daemon",
		TargetID:   detail.CaptureUID,
		Outcome:    "SUCCEEDED",
		Details: map[string]any{
			"view_type":      detail.Entry.ViewType,
			"overall_status": detail.Entry.OverallStatus,
			"broken_count":   detail.Entry.BrokenCount,
			"scope":          scope,
			"redact_pii":     redactPII,
		},
	})

	return detail, nil
}

// IngestUIDiagnostic exports a captured DOM payload to disk artifacts and persists metadata in Postgres.
func (s *Server) IngestUIDiagnostic(ctx context.Context, capture diagnostics.CapturePayload) (*UIDiagnosticCaptureDetail, error) {
	if strings.TrimSpace(capture.ViewType) == "" {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "view_type is required",
		}
	}
	if strings.TrimSpace(capture.URL) == "" {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "url is required",
		}
	}
	if strings.TrimSpace(capture.CapturedAt) == "" {
		capture.CapturedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if strings.TrimSpace(capture.Scope) == "" {
		capture.Scope = "auto"
	}
	if strings.TrimSpace(capture.OverallStatus) == "" {
		if len(capture.BrokenFields) > 0 {
			capture.OverallStatus = "BROKEN"
		} else {
			capture.OverallStatus = "HEALTHY"
		}
	} else {
		capture.OverallStatus = strings.ToUpper(strings.TrimSpace(capture.OverallStatus))
		if !isValidAuditStatus(capture.OverallStatus) {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    fmt.Sprintf("invalid overall_status %q", capture.OverallStatus),
			}
		}
	}
	if capture.RepetitivePatterns == nil {
		capture.RepetitivePatterns = []diagnostics.RepetitivePatternCandidate{}
	}
	if capture.BrokenFields == nil {
		capture.BrokenFields = []diagnostics.BrokenFieldDiagnosis{}
	}

	paths, err := diagnostics.ExportBundle(s.resolveDiagnosticsDir(), capture, diagnostics.DefaultMaxRetainedCaptures)
	if err != nil {
		return nil, &ServiceError{
			Code:       "DIAGNOSTIC_EXPORT_ERROR",
			HTTPStatus: http.StatusInternalServerError,
			Message:    fmt.Sprintf("failed to export UI diagnostic bundle: %v", err),
		}
	}
	capture.CaptureUID = paths.CaptureUID

	mdBytes, readErr := os.ReadFile(paths.MarkdownPath)
	markdown := string(mdBytes)
	if readErr != nil {
		markdown = diagnostics.RenderDiagnosticMarkdown(capture)
	}

	brokenJSON, err := json.Marshal(capture.BrokenFields)
	if err != nil {
		brokenJSON = []byte("[]")
	}

	summaryMap := map[string]any{
		"capture_uid":                 capture.CaptureUID,
		"captured_at":                 capture.CapturedAt,
		"title":                       capture.Title,
		"scope":                       capture.Scope,
		"is_authenticated":            capture.IsAuthenticated,
		"redact_pii":                  capture.RedactPII,
		"overall_status":              capture.OverallStatus,
		"broken_fields_count":         len(capture.BrokenFields),
		"repetitive_patterns_count":   len(capture.RepetitivePatterns),
		"passive_graphql_ops_count":   len(capture.PassiveGraphqlOps),
		"repetitive_patterns":         capture.RepetitivePatterns,
		"passive_graphql_ops":         capture.PassiveGraphqlOps,
		"artifacts": map[string]any{
			"bundle_dir":       paths.BundleDir,
			"snapshot_path":    paths.SnapshotPath,
			"pruned_html_path": paths.PrunedHTMLPath,
			"markdown_path":    paths.MarkdownPath,
			"screenshot_path":  paths.ScreenshotPath,
			"has_screenshot":   paths.HasScreenshot,
		},
	}
	if len(capture.Landmarks) > 0 {
		summaryMap["landmarks"] = json.RawMessage(capture.Landmarks)
	}
	summaryBytes, err := json.Marshal(summaryMap)
	if err != nil {
		summaryBytes = []byte("{}")
	}

	row := dbservice.UIDiagnosticCapture{
		CaptureUID:       paths.CaptureUID,
		ViewType:         strings.TrimSpace(capture.ViewType),
		PageURL:          strings.TrimSpace(capture.URL),
		OverallStatus:    capture.OverallStatus,
		BrokenCount:      len(capture.BrokenFields),
		BrokenFieldsJSON: dbservice.JSONB(brokenJSON),
		BundleDir:        paths.BundleDir,
		HasScreenshot:    paths.HasScreenshot,
		SummaryJSON:      dbservice.JSONB(summaryBytes),
	}

	if s.db != nil && s.db.GetGorm() != nil {
		if err := s.db.GetGorm().WithContext(ctx).Create(&row).Error; err != nil {
			log.Printf("❌ Failed to persist UI diagnostic capture: %v", err)
			return nil, &ServiceError{
				Code:       "DB_ERROR",
				HTTPStatus: http.StatusInternalServerError,
				Message:    "Failed to save UI diagnostic capture",
			}
		}
	} else {
		row.CreatedAt = time.Now().UTC()
	}

	entry := uiDiagnosticEntryFromModel(row)
	artifacts := DiagnosticArtifacts{
		BundleDir:      paths.BundleDir,
		SnapshotPath:   paths.SnapshotPath,
		PrunedHTMLPath: paths.PrunedHTMLPath,
		MarkdownPath:   paths.MarkdownPath,
		ScreenshotPath: paths.ScreenshotPath,
		HasScreenshot:  paths.HasScreenshot,
	}

	// Keep the returned payload focused; full pruned HTML stays on disk unless explicitly loaded.
	captureCopy := capture
	captureCopy.ScreenshotDataURL = ""

	return &UIDiagnosticCaptureDetail{
		OK:         true,
		CaptureUID: paths.CaptureUID,
		Entry:      entry,
		Capture:    &captureCopy,
		Markdown:   markdown,
		Artifacts:  artifacts,
	}, nil
}

// ListUIDiagnosticCaptures returns stored UI diagnostic capture summaries filtered optionally by view_type/status.
func (s *Server) ListUIDiagnosticCaptures(ctx context.Context, viewType, overallStatus string, limit int) ([]UIDiagnosticCaptureEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{
			Code:       "DB_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "Database unavailable",
		}
	}

	viewType = strings.TrimSpace(viewType)
	overallStatus = strings.ToUpper(strings.TrimSpace(overallStatus))
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	db := s.db.GetGorm().WithContext(ctx).Model(&dbservice.UIDiagnosticCapture{})
	if viewType != "" {
		db = db.Where("view_type = ?", viewType)
	}
	if overallStatus != "" {
		if !isValidAuditStatus(overallStatus) {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "overall_status must be HEALTHY, DEGRADED, BROKEN, or FRAGILE",
			}
		}
		db = db.Where("overall_status = ?", overallStatus)
	}

	var rows []dbservice.UIDiagnosticCapture
	if err := db.Order("created_at DESC, id DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, &ServiceError{
			Code:       "DB_ERROR",
			HTTPStatus: http.StatusInternalServerError,
			Message:    "Failed to list UI diagnostic captures",
		}
	}

	entries := make([]UIDiagnosticCaptureEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, uiDiagnosticEntryFromModel(row))
	}
	return entries, nil
}

// GetUIDiagnosticCapture loads a stored capture (by numeric ID, capture_uid, or "latest") and reads its bundle safely.
func (s *Server) GetUIDiagnosticCapture(ctx context.Context, idOrUID string, includeHTML bool) (*UIDiagnosticCaptureDetail, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{
			Code:       "DB_UNAVAILABLE",
			HTTPStatus: http.StatusServiceUnavailable,
			Message:    "Database unavailable",
		}
	}

	key := strings.TrimSpace(idOrUID)
	if key == "" {
		key = "latest"
	}

	var row dbservice.UIDiagnosticCapture
	db := s.db.GetGorm().WithContext(ctx)
	var err error
	if strings.EqualFold(key, "latest") {
		err = db.Order("created_at DESC, id DESC").First(&row).Error
	} else if numID, parseErr := strconv.ParseUint(key, 10, 64); parseErr == nil && numID > 0 {
		err = db.Where("id = ?", numID).First(&row).Error
	} else {
		err = db.Where("capture_uid = ?", key).First(&row).Error
	}

	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, &ServiceError{
			Code:       "NOT_FOUND",
			HTTPStatus: http.StatusNotFound,
			Message:    "UI diagnostic capture not found",
		}
	}
	if err != nil {
		return nil, &ServiceError{
			Code:       "DB_ERROR",
			HTTPStatus: http.StatusInternalServerError,
			Message:    "Failed to load UI diagnostic capture",
		}
	}

	entry := uiDiagnosticEntryFromModel(row)
	baseDir := s.resolveDiagnosticsDir()
	bundleDir := row.BundleDir

	snapshotPath, err := resolveContainmentSafeFile(baseDir, bundleDir, "snapshot.json")
	if err != nil {
		return nil, err
	}
	mdPath, err := resolveContainmentSafeFile(baseDir, bundleDir, "diagnostic.md")
	if err != nil {
		return nil, err
	}
	htmlPath, err := resolveContainmentSafeFile(baseDir, bundleDir, "pruned.html")
	if err != nil {
		return nil, err
	}
	var screenshotPath string
	if row.HasScreenshot {
		screenshotPath, err = resolveContainmentSafeFile(baseDir, bundleDir, "screenshot.png")
		if err != nil {
			return nil, err
		}
	}

	var capturePtr *diagnostics.CapturePayload
	if rawSnap, readErr := os.ReadFile(snapshotPath); readErr == nil {
		var parsed diagnostics.CapturePayload
		if json.Unmarshal(rawSnap, &parsed) == nil {
			if !includeHTML {
				parsed.PrunedHTML = ""
			}
			parsed.ScreenshotDataURL = ""
			capturePtr = &parsed
		}
	}

	var markdown string
	if rawMD, readErr := os.ReadFile(mdPath); readErr == nil {
		markdown = string(rawMD)
	} else if capturePtr != nil {
		markdown = diagnostics.RenderDiagnosticMarkdown(*capturePtr)
	}

	var prunedHTML string
	if includeHTML {
		if rawHTML, readErr := os.ReadFile(htmlPath); readErr == nil {
			prunedHTML = string(rawHTML)
		} else if capturePtr != nil {
			prunedHTML = capturePtr.PrunedHTML
		}
	}

	artifacts := DiagnosticArtifacts{
		BundleDir:      bundleDir,
		SnapshotPath:   snapshotPath,
		PrunedHTMLPath: htmlPath,
		MarkdownPath:   mdPath,
		ScreenshotPath: screenshotPath,
		HasScreenshot:  row.HasScreenshot,
	}

	return &UIDiagnosticCaptureDetail{
		OK:         true,
		CaptureUID: row.CaptureUID,
		Entry:      entry,
		Capture:    capturePtr,
		Markdown:   markdown,
		PrunedHTML: prunedHTML,
		Artifacts:  artifacts,
	}, nil
}

// TestSelectorPatch validates a proposed rule against upwork.yaml (in memory) and dry-runs it against
// the live extension tab or a captured pruned HTML snapshot without modifying disk state.
func (s *Server) TestSelectorPatch(ctx context.Context, req TestSelectorPatchRequest) (*TestSelectorPatchResponse, error) {
	patch := buildFieldRulePatch(
		req.View, req.Field, req.Rule,
		req.Selectors, req.Extract, req.Attribute, req.Transforms,
		req.SiblingChildTag, req.JoinWith, req.LabelContains,
		req.Required, req.IsFragile, req.FragileReason, req.AuthOnly,
		req.Description, req.Mode, "",
	)
	normView, err := normalizePatchView(patch.View)
	if err != nil {
		return nil, err
	}
	patch.View = normView

	yamlPath := s.resolveSelectorsPath()
	preview, err := diagnostics.PreviewPatch(yamlPath, patch)
	if err != nil {
		return nil, mapDiagnosticError(err)
	}

	prunedHTML := req.PrunedHTML
	if strings.TrimSpace(prunedHTML) == "" && strings.TrimSpace(req.CaptureID) != "" && s.db != nil && s.db.GetGorm() != nil {
		if detail, loadErr := s.GetUIDiagnosticCapture(ctx, req.CaptureID, true); loadErr == nil {
			prunedHTML = detail.PrunedHTML
		}
	}

	mergedRule := extractMergedRulePayload(preview.NewYAML, preview.View, preview.Field, patch)

	if req.SkipDOMTest {
		return &TestSelectorPatchResponse{
			OK:          true,
			View:        preview.View,
			Field:       preview.Field,
			Regressions: []SelectorPatchRegression{},
			OldVersion:  preview.OldVersion,
			NewVersion:  preview.NewVersion,
			YAMLDiff:    preview.Diff,
			ValidYAML:   true,
			DOMTested:   false,
		}, nil
	}

	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	useActiveTab := true
	if req.UseActiveTab != nil {
		useActiveTab = *req.UseActiveTab
	}

	wsParams := map[string]any{
		"view":           preview.View,
		"field":          preview.Field,
		"rule":           mergedRule,
		"use_active_tab": useActiveTab,
	}
	if req.TabID != nil {
		wsParams["tab_id"] = *req.TabID
	}
	if strings.TrimSpace(prunedHTML) != "" {
		wsParams["pruned_html"] = prunedHTML
	}

	rawRes, err := s.bridgeHub.CallExtension(ctx, "diagnostics.test_patch", wsParams, 30*time.Second)
	if err != nil {
		return nil, err
	}

	var testOut struct {
		OK            bool                       `json:"ok"`
		View          string                     `json:"view"`
		Field         string                     `json:"field"`
		MatchedCount  int                        `json:"matched_count"`
		SampleValue   any                        `json:"sample_value"`
		Status        string                     `json:"status"`
		Regressions   []SelectorPatchRegression  `json:"regressions"`
		BeforeSummary *SelectorPatchFieldSummary `json:"before_summary"`
		AfterSummary  *SelectorPatchFieldSummary `json:"after_summary"`
	}
	if err := json.Unmarshal(rawRes, &testOut); err != nil {
		return nil, &ServiceError{
			Code:       "INVALID_RPC_RESULT",
			HTTPStatus: http.StatusBadGateway,
			Message:    fmt.Sprintf("invalid diagnostics.test_patch RPC result: %v", err),
		}
	}
	if testOut.Regressions == nil {
		testOut.Regressions = []SelectorPatchRegression{}
	}

	return &TestSelectorPatchResponse{
		OK:            testOut.OK,
		View:          firstNonEmpty(testOut.View, preview.View),
		Field:         firstNonEmpty(testOut.Field, preview.Field),
		Status:        testOut.Status,
		MatchedCount:  testOut.MatchedCount,
		SampleValue:   testOut.SampleValue,
		Regressions:   testOut.Regressions,
		BeforeSummary: testOut.BeforeSummary,
		AfterSummary:  testOut.AfterSummary,
		OldVersion:    preview.OldVersion,
		NewVersion:    preview.NewVersion,
		YAMLDiff:      preview.Diff,
		ValidYAML:     true,
		DOMTested:     true,
	}, nil
}

// ApplySelectorPatch backs up upwork.yaml, validates and atomically writes the patch, logs to
// action_audit_logs, and broadcasts selectors.reload to the connected Chrome extension.
func (s *Server) ApplySelectorPatch(ctx context.Context, req ApplySelectorPatchRequest) (*ApplySelectorPatchResponse, error) {
	patch := buildFieldRulePatch(
		req.View, req.Field, req.Rule,
		req.Selectors, req.Extract, req.Attribute, req.Transforms,
		req.SiblingChildTag, req.JoinWith, req.LabelContains,
		req.Required, req.IsFragile, req.FragileReason, req.AuthOnly,
		req.Description, req.Mode, req.Reason,
	)
	normView, err := normalizePatchView(patch.View)
	if err != nil {
		return nil, err
	}
	patch.View = normView

	yamlPath := s.resolveSelectorsPath()
	backupDir := diagnostics.DefaultBackupDir(yamlPath)
	applied, err := diagnostics.ApplyPatch(yamlPath, backupDir, patch)
	if err != nil {
		return nil, mapDiagnosticError(err)
	}

	_ = s.PolicyEngine().RecordAudit(policy.AuditEntry{
		ActionType: "selector_patch_applied",
		Actor:      "operator",
		TargetID:   fmt.Sprintf("%s.%s", applied.View, applied.Field),
		Outcome:    "SUCCEEDED",
		Details: map[string]any{
			"old_version": applied.OldVersion,
			"new_version": applied.NewVersion,
			"backup_file": applied.BackupFile,
			"selectors":   patch.Selectors,
			"mode":        firstNonEmpty(patch.Mode, "prepend"),
			"reason":      patch.Reason,
			"capture_id":  strings.TrimSpace(req.CaptureID),
		},
	})

	reloaded, reloadWarn := s.notifySelectorsReloaded(ctx, "apply_patch", map[string]any{
		"version": applied.NewVersion,
		"view":    applied.View,
		"field":   applied.Field,
	})

	return &ApplySelectorPatchResponse{
		OK:                true,
		OldVersion:        applied.OldVersion,
		NewVersion:        applied.NewVersion,
		View:              applied.View,
		Field:             applied.Field,
		BackupPath:        applied.BackupPath,
		BackupFile:        applied.BackupFile,
		Diff:              applied.Diff,
		ReloadedExtension: reloaded,
		ReloadWarning:     reloadWarn,
	}, nil
}

// RollbackSelectorPatch restores a previous selector YAML backup atomically and triggers live extension reload.
func (s *Server) RollbackSelectorPatch(ctx context.Context, req RollbackSelectorPatchRequest) (*RollbackSelectorPatchResponse, error) {
	yamlPath := s.resolveSelectorsPath()
	backupDir := diagnostics.DefaultBackupDir(yamlPath)
	res, err := diagnostics.RollbackLatest(yamlPath, backupDir, req.BackupFile)
	if err != nil {
		return nil, mapDiagnosticError(err)
	}

	_ = s.PolicyEngine().RecordAudit(policy.AuditEntry{
		ActionType: "selector_patch_rolled_back",
		Actor:      "operator",
		TargetID:   res.BackupFile,
		Outcome:    "SUCCEEDED",
		Details: map[string]any{
			"restored_from": res.RestoredFrom,
			"backup_file":   res.BackupFile,
			"version":       res.Version,
		},
	})

	reloaded, reloadWarn := s.notifySelectorsReloaded(ctx, "rollback", map[string]any{
		"version":     res.Version,
		"backup_file": res.BackupFile,
	})

	return &RollbackSelectorPatchResponse{
		OK:                true,
		RestoredFrom:      res.RestoredFrom,
		BackupFile:        res.BackupFile,
		Version:           res.Version,
		ReloadedExtension: reloaded,
		ReloadWarning:     reloadWarn,
	}, nil
}

func (s *Server) captureUIDiagnosticHandler(w http.ResponseWriter, r *http.Request) {
	var req CaptureUIDiagnosticRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	res, err := s.CaptureUIDiagnostic(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSONStatus(w, http.StatusCreated, res)
}

func (s *Server) ingestUIDiagnosticHandler(w http.ResponseWriter, r *http.Request) {
	var capture diagnostics.CapturePayload
	if err := json.NewDecoder(r.Body).Decode(&capture); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	res, err := s.IngestUIDiagnostic(r.Context(), capture)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSONStatus(w, http.StatusCreated, res)
}

func (s *Server) listUIDiagnosticCapturesHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	q := r.URL.Query()
	viewType := strings.TrimSpace(q.Get("view_type"))
	overallStatus := strings.TrimSpace(q.Get("overall_status"))
	if overallStatus == "" {
		overallStatus = strings.TrimSpace(q.Get("status"))
	}
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
	captures, err := s.ListUIDiagnosticCaptures(r.Context(), viewType, overallStatus, limit)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{
		"captures": captures,
	})
}

func (s *Server) getUIDiagnosticCaptureHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	includeHTML := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("include_html")), "true")
	res, err := s.GetUIDiagnosticCapture(r.Context(), id, includeHTML)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) testSelectorPatchHandler(w http.ResponseWriter, r *http.Request) {
	var req TestSelectorPatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	res, err := s.TestSelectorPatch(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) applySelectorPatchHandler(w http.ResponseWriter, r *http.Request) {
	var req ApplySelectorPatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	res, err := s.ApplySelectorPatch(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) rollbackSelectorPatchHandler(w http.ResponseWriter, r *http.Request) {
	var req RollbackSelectorPatchRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err.Error() != "EOF" {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	res, err := s.RollbackSelectorPatch(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}
