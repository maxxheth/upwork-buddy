package mcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCP_WatcherTools_EndToEnd(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)
	_, _ = startMockWSServerAndClient(t, backend, defaultMockHandler())
	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	// 1. Create a watch rule via upwork_manage_watchers
	createRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_manage_watchers",
		Arguments: map[string]any{
			"action":            "create",
			"name":              "MCP ScraperFS Watch",
			"discovery_backend": "scraper_fs",
			"action_mode":       "alert_only",
			"enabled":           true,
			"discovery_config": map[string]any{
				"query": "golang",
			},
		},
	})
	if err != nil || createRes.IsError {
		t.Fatalf("create watcher failed: err=%v res=%+v", err, createRes)
	}
	var createOut struct {
		Rule struct {
			ID   uint   `json:"id"`
			Name string `json:"name"`
		} `json:"rule"`
	}
	if err := json.Unmarshal([]byte(toolErrorText(createRes)), &createOut); err != nil {
		t.Fatalf("unmarshal createOut failed: %v", err)
	}
	if createOut.Rule.ID == 0 || createOut.Rule.Name != "MCP ScraperFS Watch" {
		t.Fatalf("unexpected createOut: %+v", createOut)
	}

	// 2. Check status
	statusRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_manage_watchers",
		Arguments: map[string]any{"action": "status"},
	})
	if err != nil || statusRes.IsError {
		t.Fatalf("status failed: err=%v res=%+v", err, statusRes)
	}

	// 3. Toggle & Resume
	toggleRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_manage_watchers",
		Arguments: map[string]any{"action": "toggle", "rule_id": createOut.Rule.ID},
	})
	if err != nil || toggleRes.IsError {
		t.Fatalf("toggle failed: err=%v res=%+v", err, toggleRes)
	}

	// 4. List events & runs
	eventsRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_watcher_events",
		Arguments: map[string]any{
			"rule_id":      createOut.Rule.ID,
			"include_runs": true,
		},
	})
	if err != nil || eventsRes.IsError {
		t.Fatalf("watcher_events failed: err=%v res=%+v", err, eventsRes)
	}

	// 5. Configure notifications (secret hygiene) & test
	cfgUpdateRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_configure_notifications",
		Arguments: map[string]any{
			"action":          "update",
			"webhook_enabled": true,
			"webhook_url":     "https://example.com/hook",
			"webhook_secret":  "mcp-secret",
		},
	})
	if err != nil || cfgUpdateRes.IsError {
		t.Fatalf("configure_notifications update failed: err=%v res=%+v", err, cfgUpdateRes)
	}
	var cfgOut struct {
		Config struct {
			HasWebhookSecret bool `json:"has_webhook_secret"`
		} `json:"config"`
	}
	if err := json.Unmarshal([]byte(toolErrorText(cfgUpdateRes)), &cfgOut); err != nil {
		t.Fatalf("unmarshal cfgOut failed: %v", err)
	}
	if !cfgOut.Config.HasWebhookSecret {
		t.Fatalf("expected has_webhook_secret=true")
	}

	// 6. Delete watch rule
	delRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_manage_watchers",
		Arguments: map[string]any{"action": "delete", "rule_id": createOut.Rule.ID},
	})
	if err != nil || delRes.IsError {
		t.Fatalf("delete watcher failed: err=%v res=%+v", err, delRes)
	}
}
