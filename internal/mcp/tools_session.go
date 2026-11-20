package mcp

import (
	"context"

	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type sessionStatusInput struct {
	LiveProbe *bool `json:"live_probe,omitempty" jsonschema:"When true (default), probes the connected Chrome extension for live tab and login status"`
}

type auditSelectorsInput struct {
	View           string `json:"view,omitempty" jsonschema:"Upwork view to audit: search_listings, best_matches, most_recent, saved_jobs, job_detail, proposal_apply, proposals_list, messages_rooms, messages_thread, or messages"`
	ViewType       string `json:"view_type,omitempty" jsonschema:"Alias for view"`
	URL            string `json:"url,omitempty" jsonschema:"Target Upwork URL (required for job_detail, proposal_apply, and messages_thread)"`
	UseActiveTab   bool   `json:"use_active_tab,omitempty" jsonschema:"Audit the currently active Upwork tab instead of navigating"`
	UpdateBaseline bool   `json:"update_baseline,omitempty" jsonschema:"Whether to update stored DOM blueprint baseline"`
	SaveBaseline   bool   `json:"save_baseline,omitempty" jsonschema:"Alias for update_baseline; whether to save/update stored DOM blueprint baseline"`
}

type listTabsInput struct{}

func (s *Server) registerSessionTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_session_status",
		Description: "Return daemon/DB health, Chrome WebSocket extension connection status, Upwork login state, policy mode, daily usage caps, and pending approvals.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in sessionStatusInput) (*mcp.CallToolResult, any, error) {
		liveProbe := true
		if in.LiveProbe != nil {
			liveProbe = *in.LiveProbe
		}
		res, err := s.backend.GetSessionStatus(ctx, liveProbe)
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_audit_selectors",
		Description: "Run a live DOM selector drift audit on an Upwork page view via the connected Chrome extension.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in auditSelectorsInput) (*mcp.CallToolResult, any, error) {
		view := in.View
		if view == "" {
			view = in.ViewType
		}
		res, err := s.backend.AuditSelectors(ctx, server.AuditSelectorsRequest{
			View:           view,
			URL:            in.URL,
			UseActiveTab:   in.UseActiveTab,
			UpdateBaseline: in.UpdateBaseline || in.SaveBaseline,
			SaveBaseline:   in.SaveBaseline,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_list_tabs",
		Description: "List open upwork.com browser tabs in Chrome, including active and dedicated automation tab flags.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, _ listTabsInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.ListTabs(ctx)
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})
}
