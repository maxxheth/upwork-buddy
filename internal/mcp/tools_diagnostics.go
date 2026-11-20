package mcp

import (
	"context"

	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type captureUIDiagnosticInput struct {
	Scope             string   `json:"scope,omitempty" jsonschema:"Capture scope: auto (default; captures open job/drawer first or main page), drawer, or page"`
	View              string   `json:"view,omitempty" jsonschema:"Optional Upwork view hint: search_listings, best_matches, most_recent, saved_jobs, job_detail, proposal_apply, proposals_list, messages_rooms, or messages_thread"`
	URL               string   `json:"url,omitempty" jsonschema:"Optional target Upwork URL if opening or targeting a specific page"`
	UseActiveTab      *bool    `json:"use_active_tab,omitempty" jsonschema:"Capture from the active Upwork Chrome tab instead of navigating (default true when url is omitted)"`
	TabID             *int     `json:"tab_id,omitempty" jsonschema:"Optional Chrome tab ID override"`
	IncludeScreenshot bool     `json:"include_screenshot,omitempty" jsonschema:"Capture optional visible tab PNG screenshot alongside DOM bundle (default false)"`
	RedactPII         *bool    `json:"redact_pii,omitempty" jsonschema:"Mask emails, tokens, and private client/message text before persisting (default true)"`
	BrokenFields      []string `json:"broken_fields,omitempty" jsonschema:"Optional list of broken field names to focus anchor neighborhoods on"`
}

type getUIDiagnosticInput struct {
	CaptureID   string `json:"capture_id,omitempty" jsonschema:"Numeric DB ID or capture_uid (defaults to latest when omitted)"`
	IncludeHTML bool   `json:"include_html,omitempty" jsonschema:"Include pruned HTML artifact in response (default false; defaults to markdown + JSON metadata)"`
}

type testSelectorPatchInput struct {
	View            string   `json:"view" jsonschema:"Target Upwork view in configs/selectors/upwork.yaml (e.g. job_detail, search_listings)"`
	Field           string   `json:"field" jsonschema:"Target field name (e.g. skills, title, budget) or container_selectors"`
	Selectors       []string `json:"selectors" jsonschema:"Ordered CSS selectors to test (prepended ahead of existing fallbacks by default)"`
	Extract         string   `json:"extract,omitempty" jsonschema:"Extraction mode: text, full_text, rendered_text, attribute, list, sibling_text, hourly_or_fixed_label, or ca_item_value"`
	Attribute       string   `json:"attribute,omitempty" jsonschema:"Attribute name when extract is attribute"`
	Transforms      []string `json:"transforms,omitempty" jsonschema:"Optional post-extraction transforms"`
	SiblingChildTag string   `json:"sibling_child_tag,omitempty" jsonschema:"Child tag for sibling_text extraction"`
	JoinWith        string   `json:"join_with,omitempty" jsonschema:"Separator when joining multi-node matches"`
	LabelContains   string   `json:"label_contains,omitempty" jsonschema:"Substring match filter for sibling_text"`
	Required        *bool    `json:"required,omitempty" jsonschema:"Whether the field is required during audits"`
	IsFragile       *bool    `json:"is_fragile,omitempty" jsonschema:"Override fragility flag on the rule"`
	FragileReason   *string  `json:"fragile_reason,omitempty" jsonschema:"Optional explanation if rule remains fragile"`
	AuthOnly        *bool    `json:"auth_only,omitempty" jsonschema:"Whether this field requires an authenticated Upwork session"`
	Description     string   `json:"description,omitempty" jsonschema:"Optional human-readable rule description"`
	Mode            string   `json:"mode,omitempty" jsonschema:"Patch mode: prepend (default, preserves existing fallbacks) or replace"`
	CaptureID       string   `json:"capture_id,omitempty" jsonschema:"Optional stored capture_uid or numeric ID whose pruned HTML can be used during dry-run"`
	UseActiveTab    *bool    `json:"use_active_tab,omitempty" jsonschema:"Dry-run against the active Chrome Upwork tab (default true)"`
	TabID           *int     `json:"tab_id,omitempty" jsonschema:"Optional Chrome tab ID override for live dry-run"`
	PrunedHTML      string   `json:"pruned_html,omitempty" jsonschema:"Optional pruned HTML string for offline/snapshot dry-run"`
	SkipDOMTest     bool     `json:"skip_dom_test,omitempty" jsonschema:"Validate YAML syntax and unified diff only without calling extension DOM test"`
}

type applySelectorPatchInput struct {
	View            string   `json:"view" jsonschema:"Target Upwork view in configs/selectors/upwork.yaml (e.g. job_detail, search_listings)"`
	Field           string   `json:"field" jsonschema:"Target field name (e.g. skills, title, budget) or container_selectors"`
	Selectors       []string `json:"selectors" jsonschema:"Ordered CSS selectors to apply"`
	Extract         string   `json:"extract,omitempty" jsonschema:"Extraction mode: text, full_text, rendered_text, attribute, list, sibling_text, hourly_or_fixed_label, or ca_item_value"`
	Attribute       string   `json:"attribute,omitempty" jsonschema:"Attribute name when extract is attribute"`
	Transforms      []string `json:"transforms,omitempty" jsonschema:"Optional post-extraction transforms"`
	SiblingChildTag string   `json:"sibling_child_tag,omitempty" jsonschema:"Child tag for sibling_text extraction"`
	JoinWith        string   `json:"join_with,omitempty" jsonschema:"Separator when joining multi-node matches"`
	LabelContains   string   `json:"label_contains,omitempty" jsonschema:"Substring match filter for sibling_text"`
	Required        *bool    `json:"required,omitempty" jsonschema:"Whether the field is required during audits"`
	IsFragile       *bool    `json:"is_fragile,omitempty" jsonschema:"Override fragility flag on the rule"`
	FragileReason   *string  `json:"fragile_reason,omitempty" jsonschema:"Optional explanation if rule remains fragile"`
	AuthOnly        *bool    `json:"auth_only,omitempty" jsonschema:"Whether this field requires an authenticated Upwork session"`
	Description     string   `json:"description,omitempty" jsonschema:"Optional human-readable rule description"`
	Mode            string   `json:"mode,omitempty" jsonschema:"Patch mode: prepend (default, keeps existing fallbacks) or replace"`
	Reason          string   `json:"reason,omitempty" jsonschema:"Audit note describing why this selector patch is being applied"`
	CaptureID       string   `json:"capture_id,omitempty" jsonschema:"Optional capture_uid associated with this fix"`
}

func (s *Server) registerDiagnosticTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_capture_ui_diagnostic",
		Description: "Capture a pruned, PII-redacted DOM diagnostic bundle (failing field anchor HTML, repetitive sibling patterns, ranked candidate selectors, landmarks, markdown summary) from the open Upwork Chrome tab/drawer and persist artifacts.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in captureUIDiagnosticInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.CaptureUIDiagnostic(ctx, server.CaptureUIDiagnosticRequest{
			Scope:             in.Scope,
			View:              in.View,
			URL:               in.URL,
			UseActiveTab:      in.UseActiveTab,
			TabID:             in.TabID,
			IncludeScreenshot: in.IncludeScreenshot,
			RedactPII:         in.RedactPII,
			BrokenFields:      in.BrokenFields,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_get_ui_diagnostic",
		Description: "Load a persisted UI diagnostic capture (or 'latest') including failing field diagnoses, ranked candidate selectors, artifact paths, markdown summary, and optional pruned HTML.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getUIDiagnosticInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.GetUIDiagnosticCapture(ctx, in.CaptureID, in.IncludeHTML)
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_test_selector_patch",
		Description: "Dry-run a proposed selector patch in memory against configs/selectors/upwork.yaml and test live extraction + sibling field regressions on the open Upwork tab without writing any files.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in testSelectorPatchInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.TestSelectorPatch(ctx, server.TestSelectorPatchRequest{
			View:            in.View,
			Field:           in.Field,
			Selectors:       in.Selectors,
			Extract:         in.Extract,
			Attribute:       in.Attribute,
			Transforms:      in.Transforms,
			SiblingChildTag: in.SiblingChildTag,
			JoinWith:        in.JoinWith,
			LabelContains:   in.LabelContains,
			Required:        in.Required,
			IsFragile:       in.IsFragile,
			FragileReason:   in.FragileReason,
			AuthOnly:        in.AuthOnly,
			Description:     in.Description,
			Mode:            in.Mode,
			CaptureID:       in.CaptureID,
			UseActiveTab:    in.UseActiveTab,
			TabID:           in.TabID,
			PrunedHTML:      in.PrunedHTML,
			SkipDOMTest:     in.SkipDOMTest,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_apply_selector_patch",
		Description: "Back up configs/selectors/upwork.yaml atomically, apply a validated selector patch, log the change to action_audit_logs, and push selectors.reload to Chrome for immediate hot-reload without rebuilding the extension.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in applySelectorPatchInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.ApplySelectorPatch(ctx, server.ApplySelectorPatchRequest{
			View:            in.View,
			Field:           in.Field,
			Selectors:       in.Selectors,
			Extract:         in.Extract,
			Attribute:       in.Attribute,
			Transforms:      in.Transforms,
			SiblingChildTag: in.SiblingChildTag,
			JoinWith:        in.JoinWith,
			LabelContains:   in.LabelContains,
			Required:        in.Required,
			IsFragile:       in.IsFragile,
			FragileReason:   in.FragileReason,
			AuthOnly:        in.AuthOnly,
			Description:     in.Description,
			Mode:            in.Mode,
			Reason:          in.Reason,
			CaptureID:       in.CaptureID,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})
}
