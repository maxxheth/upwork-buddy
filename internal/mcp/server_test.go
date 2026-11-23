package mcp

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/server"

	"github.com/coder/websocket"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type testDBService struct {
	sqlDB *sql.DB
	gorm  *gorm.DB
}

func (t *testDBService) Health() map[string]string {
	return map[string]string{"status": "up"}
}

func (t *testDBService) Close() error {
	if t.sqlDB != nil {
		return t.sqlDB.Close()
	}
	return nil
}

func (t *testDBService) GetDB() *sql.DB {
	return t.sqlDB
}

func (t *testDBService) GetGorm() *gorm.DB {
	return t.gorm
}

func setupTestMCPServer(t *testing.T) (*server.Server, *Server) {
	t.Helper()

	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping integration test")
	}

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("invalid TEST_DATABASE_URL: %v", err)
	}
	dbName := strings.ToLower(strings.TrimPrefix(parsed.Path, "/"))
	if os.Getenv("UPWORK_BUDDY_ALLOW_TEST_DSN") != "1" &&
		!strings.Contains(dbName, "test") &&
		!strings.Contains(dbName, "verify") {
		t.Fatalf("refusing to run integration tests against non-test database %q (name must contain 'test' or 'verify')", dbName)
	}

	adminDB, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("failed to open test admin db: %v", err)
	}
	if err := adminDB.Ping(); err != nil {
		_ = adminDB.Close()
		t.Fatalf("failed to ping test database: %v", err)
	}

	schemaName := fmt.Sprintf("test_mcp_%d_%d", os.Getpid(), time.Now().UnixNano())
	if _, err := adminDB.Exec(fmt.Sprintf(`CREATE SCHEMA "%s"`, schemaName)); err != nil {
		_ = adminDB.Close()
		t.Fatalf("failed to create isolated test schema %q: %v", schemaName, err)
	}

	q := parsed.Query()
	q.Set("search_path", schemaName)
	parsed.RawQuery = q.Encode()
	scopedDSN := parsed.String()

	sqlDB, err := sql.Open("pgx", scopedDSN)
	if err != nil {
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to open scoped test db: %v", err)
	}

	gormDB, err := gorm.Open(postgres.New(postgres.Config{
		Conn: sqlDB,
	}), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to open gorm test db: %v", err)
	}

	if err := gormDB.AutoMigrate(dbservice.AllModels()...); err != nil {
		_ = sqlDB.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
		t.Fatalf("failed to migrate isolated test schema: %v", err)
	}

	dbSvc := &testDBService{sqlDB: sqlDB, gorm: gormDB}

	var backend *server.Server
	hub := bridge.NewHub(bridge.HubConfig{
		AuthTimeout:        5 * time.Second,
		DefaultCallTimeout: 10 * time.Second,
		PreAuthCheck: func(r *http.Request) bool {
			return backend.AuthenticateWSRequest(r) == server.WSAuthAuthenticated
		},
		ValidateAuthFrame: func(raw []byte) (json.RawMessage, bool) {
			return backend.ValidateWSAuthFrame(raw)
		},
		AllowOrigin: func(origin string) bool {
			return backend.IsAllowedOrigin(origin)
		},
	})

	tmpDir := t.TempDir()
	tmpSelectorsPath := filepath.Join(tmpDir, "upwork.yaml")
	if rawSel, readErr := os.ReadFile("../../configs/selectors/upwork.yaml"); readErr == nil {
		if writeErr := os.WriteFile(tmpSelectorsPath, rawSel, 0o644); writeErr != nil {
			t.Fatalf("write isolated selectors yaml: %v", writeErr)
		}
	} else {
		t.Fatalf("read selectors yaml: %v", readErr)
	}
	tmpDiagDir := filepath.Join(tmpDir, "diagnostics")

	enabled := true
	backend = server.NewServerWithDeps(server.ServerDeps{
		Host:           "127.0.0.1",
		Port:           0,
		APIToken:       "test-mcp-api-token",
		TemplatesPath:  "../../templates.yaml",
		SelectorsPath:  tmpSelectorsPath,
		DiagnosticsDir: tmpDiagDir,
		MCPEnabled:     &enabled,
		DB:             dbSvc,
		BridgeHub:      hub,
		PolicyEngine:   policy.NewEngine(gormDB),
	})

	mcpSrv := NewServer(backend)
	backend.SetMCPHandler(mcpSrv.StreamableHTTPHandler())
	backend.SetMCPShutdownHook(mcpSrv.CloseSessions)

	t.Cleanup(func() {
		_ = backend.Close()
		_, _ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName))
		_ = adminDB.Close()
	})

	return backend, mcpSrv
}

type mockRPCHandler func(method string, params json.RawMessage) (any, *mockRPCError)

type mockRPCError struct {
	Code    int
	Message string
	Data    any
}

func startMockWSServerAndClient(t *testing.T, backend *server.Server, handler mockRPCHandler) (*httptest.Server, func()) {
	t.Helper()

	httpSrv := httptest.NewServer(backend.RegisterRoutes())
	t.Cleanup(httpSrv.Close)

	wsURL := "ws" + strings.TrimPrefix(httpSrv.URL, "http") + "/ws/extension"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"chrome-extension://abcdefghijklmnop"}},
	})
	if err != nil {
		t.Fatalf("mock extension WS dial failed: %v", err)
	}

	authMsg := fmt.Sprintf(`{"jsonrpc":"2.0","id":"auth-1","method":"auth","params":{"token":%q,"extension_version":"2.0.0","browser":"chrome"}}`, backend.APIToken())
	if err := conn.Write(ctx, websocket.MessageText, []byte(authMsg)); err != nil {
		_ = conn.CloseNow()
		t.Fatalf("mock extension auth write failed: %v", err)
	}
	_, rawAck, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(rawAck), `"ok":true`) {
		_ = conn.CloseNow()
		t.Fatalf("mock extension auth ack failed: ack=%s err=%v", string(rawAck), err)
	}

	loopCtx, loopCancel := context.WithCancel(context.Background())
	var writeMu sync.Mutex
	done := make(chan struct{})

	go func() {
		defer close(done)
		for {
			_, raw, rErr := conn.Read(loopCtx)
			if rErr != nil {
				return
			}
			var req struct {
				JSONRPC string          `json:"jsonrpc"`
				ID      json.RawMessage `json:"id"`
				Method  string          `json:"method"`
				Params  json.RawMessage `json:"params"`
			}
			if json.Unmarshal(raw, &req) != nil || req.Method == "" || len(req.ID) == 0 {
				continue
			}

			var resp map[string]any
			if handler != nil {
				res, rpcErr := handler(req.Method, req.Params)
				if rpcErr != nil {
					resp = map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"error": map[string]any{
							"code":    rpcErr.Code,
							"message": rpcErr.Message,
							"data":    rpcErr.Data,
						},
					}
				} else {
					resp = map[string]any{
						"jsonrpc": "2.0",
						"id":      req.ID,
						"result":  res,
					}
				}
			} else {
				resp = map[string]any{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"result":  map[string]any{"ok": true},
				}
			}

			encoded, _ := json.Marshal(resp)
			writeMu.Lock()
			_ = conn.Write(loopCtx, websocket.MessageText, encoded)
			writeMu.Unlock()
		}
	}()

	// Poll /api/session/status until connected
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st, _ := backend.GetSessionStatus(context.Background(), false)
		if st != nil && st.ExtensionConnected {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	disconnect := func() {
		loopCancel()
		_ = conn.Close(websocket.StatusNormalClosure, "test disconnect")
		<-done
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			st, _ := backend.GetSessionStatus(context.Background(), false)
			if st != nil && !st.ExtensionConnected {
				break
			}
			time.Sleep(15 * time.Millisecond)
		}
	}
	t.Cleanup(func() {
		loopCancel()
		_ = conn.CloseNow()
		<-done
	})

	return httpSrv, disconnect
}

func connectInMemoryClient(t *testing.T, mcpSrv *Server) *mcp.ClientSession {
	t.Helper()
	t1, t2 := mcp.NewInMemoryTransports()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	srvSession, err := mcpSrv.MCPServer().Connect(ctx, t1, nil)
	if err != nil {
		t.Fatalf("MCPServer.Connect(InMemory) failed: %v", err)
	}
	t.Cleanup(func() { _ = srvSession.Close() })

	client := mcp.NewClient(&mcp.Implementation{Name: "test-inmemory-client", Version: "1.0.0"}, nil)
	cliSession, err := client.Connect(ctx, t2, nil)
	if err != nil {
		t.Fatalf("Client.Connect(InMemory) failed: %v", err)
	}
	t.Cleanup(func() { _ = cliSession.Close() })
	return cliSession
}

func parseToolJSON(t *testing.T, res *mcp.CallToolResult) map[string]any {
	t.Helper()
	if res == nil || len(res.Content) == 0 {
		t.Fatalf("empty CallToolResult: %+v", res)
	}
	tc, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("expected TextContent, got %T", res.Content[0])
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(tc.Text), &out); err != nil {
		t.Fatalf("failed to decode tool JSON %q: %v", tc.Text, err)
	}
	return out
}

func toolErrorText(res *mcp.CallToolResult) string {
	if res == nil || len(res.Content) == 0 {
		return ""
	}
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

type bearerRT struct {
	token string
}

func (b *bearerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	cloned := r.Clone(r.Context())
	if b.token != "" {
		cloned.Header.Set("Authorization", "Bearer "+b.token)
	}
	return http.DefaultTransport.RoundTrip(cloned)
}

func defaultMockHandler() mockRPCHandler {
	return func(method string, params json.RawMessage) (any, *mockRPCError) {
		switch method {
		case "session.status":
			return map[string]any{
				"ok":                true,
				"upwork_logged_in":  true,
				"automation_tab_id": 42,
				"busy":              false,
			}, nil
		case "tabs.list":
			return map[string]any{
				"tabs": []map[string]any{
					{"id": 42, "title": "Upwork Search", "url": "https://www.upwork.com/nx/search/jobs/", "active": true, "automation": true, "is_automation": true},
					{"id": 7, "title": "Best Matches", "url": "https://www.upwork.com/nx/find-work/best-matches", "active": false, "automation": false, "is_automation": false},
				},
			}, nil
		case "audit.selectors":
			return map[string]any{
				"ok":             true,
				"overall_status": "HEALTHY",
				"report": map[string]any{
					"view_type":      "search_listings",
					"overall_status": "HEALTHY",
					"rules": map[string]any{
						"title": map[string]any{"field": "title", "status": "HEALTHY"},
					},
				},
				"blueprint": map[string]any{"view_type": "search_listings"},
			}, nil
		case "jobs.search":
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":   "~030100000000000000001",
						"job_title":       "Senior Go PostgreSQL Architect",
						"job_description": "Build Go and PostgreSQL MCP services.",
						"url":             "https://www.upwork.com/jobs/~030100000000000000001/",
						"contract_type":   "fixed",
						"budget_amount":   "$1,500",
						"skills":          []string{"Go", "PostgreSQL"},
					},
					{
						"upwork_job_id":   "~030100000000000000002",
						"job_title":       "Quick CSS Fix",
						"job_description": "Small CSS tweak.",
						"url":             "https://www.upwork.com/jobs/~030100000000000000002/",
						"contract_type":   "fixed",
						"budget_amount":   "$100",
						"skills":          []string{"CSS"},
					},
				},
			}, nil
		case "jobs.detail":
			var p struct {
				URL         string   `json:"url"`
				UpworkJobID string   `json:"upwork_job_id"`
				URLs        []string `json:"urls"`
			}
			_ = json.Unmarshal(params, &p)
			targetID := p.UpworkJobID
			if targetID == "" && strings.Contains(p.URL, "~030100000000000000002") {
				targetID = "~030100000000000000002"
			}
			if targetID == "" {
				targetID = "~030100000000000000001"
			}
			budget := "$1,500"
			title := "Senior Go PostgreSQL Architect"
			skills := []string{"Go", "PostgreSQL"}
			if targetID == "~030100000000000000002" {
				budget = "$100"
				title = "Quick CSS Fix"
				skills = []string{"CSS"}
			}
			jobPayload := map[string]any{
				"upwork_job_id":    targetID,
				"job_title":        title,
				"job_description":  "Detailed job description with Go and PostgreSQL.",
				"url":              fmt.Sprintf("https://www.upwork.com/jobs/%s/", targetID),
				"contract_type":    "fixed",
				"budget_amount":    budget,
				"skills":           skills,
				"connects_required": 8,
				"payment_verified": true,
				"client_hire_rate": 85.0,
				"hours_per_week":   "30+ hrs/week",
				"screening_questions": []map[string]any{
					{"index": 0, "prompt": "Describe Go experience", "required": true},
				},
			}
			return map[string]any{
				"ok":             true,
				"job":            jobPayload,
				"jobs":           []map[string]any{jobPayload},
				"stopped_reason": "completed",
			}, nil
		case "proposal.fill":
			return map[string]any{
				"ok":                            true,
				"cover_letter_length":           55,
				"bid_type":                      "fixed",
				"bid_amount":                    1500.0,
				"connects_cost":                 8,
				"total_connects":                8,
				"available_connects":            50,
				"insufficient_connects":         false,
				"unanswered_required_questions": 0,
			}, nil
		case "proposal.submit":
			return map[string]any{
				"ok":                  true,
				"submitted":           true,
				"upwork_proposal_url": "https://www.upwork.com/nx/proposals/999001",
				"confirmation_url":    "https://www.upwork.com/nx/proposals/999001",
			}, nil
		case "proposals.sync":
			return map[string]any{
				"ok": true,
				"proposals": []map[string]any{
					{
						"upwork_job_id":       "~030100000000000000001",
						"upwork_proposal_url": "https://www.upwork.com/nx/proposals/999001",
						"job_title":           "Senior Go PostgreSQL Architect",
						"status":              "interviewing",
						"bid_amount":          1500.0,
						"connects":            8,
						"submitted_at":        time.Now().UTC().Format(time.RFC3339),
					},
				},
			}, nil
		case "messages.list":
			return map[string]any{
				"ok":           true,
				"total_unread": 2,
				"rooms": []map[string]any{
					{
						"upwork_room_id":       "room_alpha",
						"room_id":              "room_alpha",
						"client_name":          "Alice Client",
						"job_title":            "Senior Go PostgreSQL Architect",
						"upwork_job_id":        "~030100000000000000001",
						"unread_count":         2,
						"last_message_snippet": "Can we discuss the Go architecture?",
						"last_message_at":      time.Now().UTC().Format(time.RFC3339),
					},
				},
			}, nil
		case "messages.get":
			var p struct {
				RoomID string `json:"room_id"`
			}
			_ = json.Unmarshal(params, &p)
			if p.RoomID == "room_missing" {
				return nil, &mockRPCError{
					Code:    -32004,
					Message: "Room not found",
					Data:    map[string]any{"error_code": "ROOM_NOT_FOUND"},
				}
			}
			return map[string]any{
				"ok":            true,
				"room_id":       p.RoomID,
				"upwork_room_id": p.RoomID,
				"client_name":   "Alice Client",
				"job_title":     "Senior Go PostgreSQL Architect",
				"upwork_job_id": "~030100000000000000001",
				"unread_count":  2,
				"messages": []map[string]any{
					{
						"upwork_message_id": "msg-101",
						"sender":            "Alice Client",
						"sender_role":       "client",
						"body":              "Can we discuss the Go architecture?",
						"sent_at":           time.Now().UTC().Format(time.RFC3339),
					},
				},
			}, nil
		case "messages.draft":
			return map[string]any{"ok": true, "prefilled": true}, nil
		case "messages.send":
			return map[string]any{"ok": true, "sent": true}, nil
		case "diagnostics.capture":
			return map[string]any{
				"ok": true,
				"capture": map[string]any{
					"captured_at":      time.Now().UTC().Format(time.RFC3339),
					"url":              "https://www.upwork.com/jobs/~030100000000000000001/",
					"title":            "Senior Go PostgreSQL Architect - Upwork",
					"view_type":        "job_detail",
					"scope":            "drawer",
					"is_authenticated": true,
					"overall_status":   "BROKEN",
					"redact_pii":       true,
					"audit_report":     map[string]any{"view_type": "job_detail", "overall_status": "BROKEN"},
					"blueprint":        map[string]any{"view_type": "job_detail"},
					"landmarks":        []map[string]any{{"landmark": "main", "tag": "main"}},
					"repetitive_patterns": []map[string]any{
						{
							"pattern_name":       "skill_chip",
							"container_selector": "ul.new-skill-chips",
							"item_selector":      "ul.new-skill-chips > li.air3-skill-chip",
							"instance_count":     2,
							"sample_items":       []string{"Go", "PostgreSQL"},
						},
					},
					"broken_fields": []map[string]any{
						{
							"field":               "skills",
							"view":                "job_detail",
							"status":              "BROKEN",
							"registered_selector": "[data-test='Skill']",
							"matched_count":       0,
							"notes":               "Matched 0 nodes",
							"nearest_heading":     "Skills and Expertise",
							"anchor_html":         `<ul class="new-skill-chips"><li class="air3-skill-chip"><span>Go</span></li></ul>`,
							"candidates": []map[string]any{
								{
									"selector":        ".air3-skill-chip span",
									"stability_score": 88,
									"matched_count":   2,
									"sample_value":    []string{"Go", "PostgreSQL"},
									"strategy":        "repetitive_pattern_leaf",
									"is_fragile":      false,
									"reason":          "Matched 2 nodes",
								},
							},
						},
					},
					"pruned_html": `<main><ul class="new-skill-chips"><li class="air3-skill-chip"><span>Go</span></li></ul></main>`,
				},
			}, nil
		case "diagnostics.test_patch":
			return map[string]any{
				"ok":            true,
				"view":          "job_detail",
				"field":         "skills",
				"matched_count": 2,
				"sample_value":  []string{"Go", "PostgreSQL"},
				"status":        "HEALTHY",
				"regressions":   []any{},
				"before_summary": map[string]any{
					"status":        "BROKEN",
					"matched_count": 0,
				},
				"after_summary": map[string]any{
					"status":           "HEALTHY",
					"matched_count":    2,
					"sample_value":     []string{"Go", "PostgreSQL"},
					"matched_selector": ".air3-skill-chip span",
				},
			}, nil
		case "selectors.reload":
			return map[string]any{"ok": true, "reloaded": true}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	}
}

func TestMCP_InMemory_All26ToolsAnd10Resources(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)
	_, _ = startMockWSServerAndClient(t, backend, defaultMockHandler())
	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	// 1. Verify exact 30 tools
	toolsRes, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	expectedTools := map[string]bool{
		"upwork_session_status":          true,
		"upwork_audit_selectors":         true,
		"upwork_list_tabs":               true,
		"upwork_capture_ui_diagnostic":   true,
		"upwork_get_ui_diagnostic":       true,
		"upwork_test_selector_patch":     true,
		"upwork_apply_selector_patch":    true,
		"upwork_search_jobs":             true,
		"upwork_get_job_details":         true,
		"upwork_list_saved_jobs":         true,
		"upwork_analyze_job":             true,
		"upwork_manage_search_profiles":  true,
		"upwork_draft_proposal":          true,
		"upwork_fill_proposal_form":      true,
		"upwork_submit_proposal":         true,
		"upwork_sync_proposals":          true,
		"upwork_list_conversations":      true,
		"upwork_get_conversation":        true,
		"upwork_draft_message":           true,
		"upwork_send_message":            true,
		"upwork_profile":                 true,
		"upwork_generate_project_agents": true,
		"upwork_active_projects":         true,
		"upwork_save_jobs":               true,
		"upwork_enrich_jobs":             true,
		"upwork_enrichment_batches":      true,
		"upwork_manage_watchers":         true,
		"upwork_run_watcher":             true,
		"upwork_watcher_events":          true,
		"upwork_configure_notifications": true,
	}
	if len(toolsRes.Tools) != len(expectedTools) {
		t.Fatalf("expected %d tools, got %d", len(expectedTools), len(toolsRes.Tools))
	}
	for _, tool := range toolsRes.Tools {
		if !expectedTools[tool.Name] {
			t.Fatalf("unexpected tool %q", tool.Name)
		}
		if tool.InputSchema == nil {
			t.Fatalf("tool %q missing InputSchema", tool.Name)
		}
	}

	// 2. Verify exact 10 resources
	resList, err := session.ListResources(ctx, &mcp.ListResourcesParams{})
	if err != nil {
		t.Fatalf("ListResources failed: %v", err)
	}
	expectedResources := []string{
		"upwork://profile",
		"upwork://jobs/hot",
		"upwork://proposals/pending-approval",
		"upwork://proposals/active",
		"upwork://messages/unread",
		"upwork://selectors/health",
		"upwork://diagnostics/latest",
		"upwork://projects/active",
		"upwork://jobs/search-runs",
		"upwork://jobs/enrichment-batches",
	}
	if len(resList.Resources) != len(expectedResources) {
		t.Fatalf("expected %d resources, got %d", len(expectedResources), len(resList.Resources))
	}

	// 3. upwork_profile (update + get)
	profUpd, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"action":      "update",
			"description": "Senior Go and PostgreSQL architect",
			"skills":      []string{"Go", "PostgreSQL", "TypeScript"},
			"target_rate": 115,
			"portfolio_items": []map[string]any{
				{"title": "Go MCP Engine", "link": "https://example.com/go-mcp", "description": "Embedded Go MCP server"},
			},
		},
	})
	if err != nil || profUpd.IsError {
		t.Fatalf("upwork_profile update failed: res=%+v err=%v", profUpd, err)
	}
	profGet, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_profile",
		Arguments: map[string]any{"action": "get"},
	})
	if err != nil || profGet.IsError || !strings.Contains(toolErrorText(profGet), "PostgreSQL") {
		t.Fatalf("upwork_profile get failed: %+v err=%v", profGet, err)
	}

	// 4. upwork_session_status & upwork_list_tabs
	sessRes, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "upwork_session_status", Arguments: map[string]any{}})
	if err != nil || sessRes.IsError {
		t.Fatalf("upwork_session_status failed: %+v err=%v", sessRes, err)
	}
	sessJSON := parseToolJSON(t, sessRes)
	if sessJSON["extension_connected"] != true || sessJSON["policy_mode"] != "confirm_in_ui" || sessJSON["db"] != "up" {
		t.Fatalf("unexpected session status: %+v", sessJSON)
	}

	tabsRes, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "upwork_list_tabs", Arguments: map[string]any{}})
	if err != nil || tabsRes.IsError {
		t.Fatalf("upwork_list_tabs failed: %+v err=%v", tabsRes, err)
	}
	if !strings.Contains(toolErrorText(tabsRes), "best-matches") {
		t.Fatalf("unexpected tabs output: %s", toolErrorText(tabsRes))
	}

	// 5. upwork_audit_selectors (valid + invalid view)
	auditRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_audit_selectors",
		Arguments: map[string]any{"view": "search_listings"},
	})
	if err != nil || auditRes.IsError {
		t.Fatalf("upwork_audit_selectors failed: %+v err=%v", auditRes, err)
	}
	auditJSON := parseToolJSON(t, auditRes)
	if auditJSON["overall_status"] != "HEALTHY" || auditJSON["rules"] == nil {
		t.Fatalf("expected top-level overall_status & rules in audit response, got %+v", auditJSON)
	}

	badAuditRes, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_audit_selectors",
		Arguments: map[string]any{"view": "invalid_view"},
	})
	if !badAuditRes.IsError || !strings.Contains(toolErrorText(badAuditRes), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS for invalid_view, got %+v", badAuditRes)
	}

	// 6. upwork_manage_search_profiles (save with search, save with yaml, list, run, delete)
	spSave, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_manage_search_profiles",
		Arguments: map[string]any{
			"action": "save",
			"name":   "go_backend",
			"search": map[string]any{"mode": "live_search", "queries": []string{"golang"}, "max_pages": 1},
		},
	})
	if err != nil || spSave.IsError {
		t.Fatalf("search profile save failed: %+v err=%v", spSave, err)
	}
	spYAML, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_manage_search_profiles",
		Arguments: map[string]any{
			"action": "save",
			"name":   "yaml_sniper",
			"yaml":   "name: yaml_sniper\nsearch:\n  mode: live_search\n  query: golang\n  max_pages: 1\n",
		},
	})
	if err != nil || spYAML.IsError {
		t.Fatalf("search profile yaml save failed: %+v err=%v", spYAML, err)
	}
	spRun, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_manage_search_profiles",
		Arguments: map[string]any{"action": "run", "profile": "yaml_sniper", "name": "yaml_sniper"},
	})
	if err != nil || spRun.IsError {
		t.Fatalf("search profile run failed: %+v err=%v", spRun, err)
	}
	spDel, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_manage_search_profiles",
		Arguments: map[string]any{"action": "delete", "name": "go_backend"},
	})
	if err != nil || spDel.IsError {
		t.Fatalf("search profile delete failed: %+v err=%v", spDel, err)
	}

	// 7. upwork_search_jobs (Stage-3 budget_min filter keeps $1500 job, drops $100 job)
	searchRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_search_jobs",
		Arguments: map[string]any{
			"source":       "search",
			"query":        "golang",
			"max_pages":    1,
			"enrich_top_n": 2,
			"budget_min":   500,
		},
	})
	if err != nil || searchRes.IsError {
		t.Fatalf("upwork_search_jobs failed: %+v err=%v", searchRes, err)
	}
	searchText := toolErrorText(searchRes)
	if !strings.Contains(searchText, "~030100000000000000001") || strings.Contains(searchText, "~030100000000000000002") {
		t.Fatalf("expected budget_min=500 to keep ~030100000000000000001 and filter ~030100000000000000002, got %s", searchText)
	}

	// 8. upwork_get_job_details & upwork_list_saved_jobs & upwork_analyze_job
	detailRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_job_details",
		Arguments: map[string]any{"job_id": "~030100000000000000001"},
	})
	if err != nil || detailRes.IsError {
		t.Fatalf("upwork_get_job_details failed: %+v err=%v", detailRes, err)
	}

	savedRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_saved_jobs",
		Arguments: map[string]any{"budget_min": 500, "sort": "score_desc"},
	})
	if err != nil || savedRes.IsError {
		t.Fatalf("upwork_list_saved_jobs failed: %+v err=%v", savedRes, err)
	}
	savedJSON := parseToolJSON(t, savedRes)
	jobsSlice, _ := savedJSON["jobs"].([]any)
	if len(jobsSlice) == 0 {
		t.Fatalf("expected saved jobs, got %+v", savedJSON)
	}
	firstJobMap := jobsSlice[0].(map[string]any)
	numericJobID := uint(firstJobMap["id"].(float64))

	analyzeRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_analyze_job",
		Arguments: map[string]any{"job_id": numericJobID},
	})
	if err != nil || analyzeRes.IsError {
		t.Fatalf("upwork_analyze_job failed: %+v err=%v", analyzeRes, err)
	}
	// Mark hot so upwork://jobs/hot has at least one row
	_ = backend.DB().GetGorm().Model(&dbservice.Job{}).Where("id = ?", numericJobID).Updates(map[string]any{"fit_label": "hot", "score": 92}).Error

	missingAnalyze, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_analyze_job",
		Arguments: map[string]any{"job_id": "999999"},
	})
	if !missingAnalyze.IsError || !strings.Contains(toolErrorText(missingAnalyze), "NOT_FOUND") {
		t.Fatalf("expected NOT_FOUND on missing job_id, got %+v", missingAnalyze)
	}

	// 9. upwork_generate_project_agents (inferred template + explicit format, plus unsupported format check)
	genRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_generate_project_agents",
		Arguments: map[string]any{"job_id": numericJobID, "format": "claude"},
	})
	if err != nil || genRes.IsError {
		t.Fatalf("upwork_generate_project_agents (inferred) failed: %+v err=%v", genRes, err)
	}
	genCopilot, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_generate_project_agents",
		Arguments: map[string]any{
			"job_id":        "~030100000000000000001",
			"template_name": "golang",
			"agent_names":   []string{"go-api-agent"},
			"format":        "copilot",
		},
	})
	if err != nil || genCopilot.IsError {
		t.Fatalf("upwork_generate_project_agents (copilot) failed: %+v err=%v", genCopilot, err)
	}
	badGen, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_generate_project_agents",
		Arguments: map[string]any{
			"job_id":        "~030100000000000000001",
			"template_name": "golang",
			"agent_names":   []string{"go-api-agent"},
			"format":        "unsupported_agent",
		},
	})
	if !badGen.IsError || !strings.Contains(strings.ToLower(toolErrorText(badGen)), "unsupported") {
		t.Fatalf("expected unsupported format error, got %+v", badGen)
	}

	// 10. Proposals lifecycle: draft -> fill -> pending-approval resource -> submit -> sync
	draftPropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_draft_proposal",
		Arguments: map[string]any{
			"job_id":            "~030100000000000000001",
			"cover_letter":      "Production Go + PostgreSQL MCP architecture proposal.",
			"bid_type":          "fixed",
			"bid_amount":        1500,
			"screening_answers": []string{"10 years Go + Postgres."},
		},
	})
	if err != nil || draftPropRes.IsError {
		t.Fatalf("upwork_draft_proposal failed: %+v err=%v", draftPropRes, err)
	}
	propID := uint(parseToolJSON(t, draftPropRes)["proposal_id"].(float64))

	fillPropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_fill_proposal_form",
		Arguments: map[string]any{"proposal_id": propID},
	})
	if err != nil || fillPropRes.IsError {
		t.Fatalf("upwork_fill_proposal_form failed: %+v err=%v", fillPropRes, err)
	}
	fillJSON := parseToolJSON(t, fillPropRes)
	propToken := fillJSON["approval_token"].(string)

	// Read pending-approval resource before submitting
	pendRes, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: "upwork://proposals/pending-approval"})
	if err != nil || len(pendRes.Contents) == 0 || !strings.Contains(pendRes.Contents[0].Text, "pending_approval") {
		t.Fatalf("pending-approval resource unexpected: %+v err=%v", pendRes, err)
	}

	subPropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID, "approval_token": propToken},
	})
	if err != nil || subPropRes.IsError {
		t.Fatalf("upwork_submit_proposal failed: %+v err=%v", subPropRes, err)
	}

	syncPropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_sync_proposals",
		Arguments: map[string]any{},
	})
	if err != nil || syncPropRes.IsError {
		t.Fatalf("upwork_sync_proposals failed: %+v err=%v", syncPropRes, err)
	}

	// 11. Messages lifecycle: list(sync) -> get(sync) -> draft -> unread resource -> send
	convsRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_conversations",
		Arguments: map[string]any{"sync": true},
	})
	if err != nil || convsRes.IsError {
		t.Fatalf("upwork_list_conversations failed: %+v err=%v", convsRes, err)
	}

	convRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_conversation",
		Arguments: map[string]any{"room_id": "room_alpha", "sync": true},
	})
	if err != nil || convRes.IsError {
		t.Fatalf("upwork_get_conversation failed: %+v err=%v", convRes, err)
	}

	missingRoom, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_conversation",
		Arguments: map[string]any{"room_id": "room_missing", "sync": true},
	})
	if !missingRoom.IsError || !strings.Contains(toolErrorText(missingRoom), "ROOM_NOT_FOUND") {
		t.Fatalf("expected ROOM_NOT_FOUND, got %+v", missingRoom)
	}

	// Read unread messages resource before sending (unread_count = 2)
	unreadRes, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: "upwork://messages/unread"})
	if err != nil || len(unreadRes.Contents) == 0 || !strings.Contains(unreadRes.Contents[0].Text, "room_alpha") {
		t.Fatalf("unread resource unexpected: %+v err=%v", unreadRes, err)
	}

	draftMsgRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_draft_message",
		Arguments: map[string]any{
			"room_id":          "room_alpha",
			"body":             "Happy to walk through the Go architecture.",
			"prefill_composer": true,
		},
	})
	if err != nil || draftMsgRes.IsError {
		t.Fatalf("upwork_draft_message failed: %+v err=%v", draftMsgRes, err)
	}
	msgToken := parseToolJSON(t, draftMsgRes)["approval_token"].(string)

	sendMsgRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_send_message",
		Arguments: map[string]any{
			"room_id":        "room_alpha",
			"approval_token": msgToken,
		},
	})
	if err != nil || sendMsgRes.IsError {
		t.Fatalf("upwork_send_message failed: %+v err=%v", sendMsgRes, err)
	}

	// 12. Exercise all 4 UI diagnostic & self-healing selector tools
	capRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_capture_ui_diagnostic",
		Arguments: map[string]any{
			"scope":          "drawer",
			"use_active_tab": true,
			"redact_pii":     true,
		},
	})
	if err != nil || capRes.IsError {
		t.Fatalf("upwork_capture_ui_diagnostic failed: %+v err=%v", capRes, err)
	}
	capMap := parseToolJSON(t, capRes)
	captureUID, _ := capMap["capture_uid"].(string)
	if captureUID == "" {
		t.Fatalf("expected non-empty capture_uid, got %+v", capMap)
	}

	getCapRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_get_ui_diagnostic",
		Arguments: map[string]any{
			"capture_id":   captureUID,
			"include_html": true,
		},
	})
	if err != nil || getCapRes.IsError {
		t.Fatalf("upwork_get_ui_diagnostic failed: %+v err=%v", getCapRes, err)
	}
	if !strings.Contains(toolErrorText(getCapRes), "Skills and Expertise") {
		t.Fatalf("expected markdown diagnostic content in get response, got: %s", toolErrorText(getCapRes))
	}

	testPatchRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_test_selector_patch",
		Arguments: map[string]any{
			"view":       "job_detail",
			"field":      "skills",
			"selectors":  []string{".air3-skill-chip span"},
			"extract":    "list",
			"capture_id": captureUID,
		},
	})
	if err != nil || testPatchRes.IsError {
		t.Fatalf("upwork_test_selector_patch failed: %+v err=%v", testPatchRes, err)
	}
	testPatchMap := parseToolJSON(t, testPatchRes)
	if testPatchMap["valid_yaml"] != true || testPatchMap["dom_tested"] != true {
		t.Fatalf("expected valid_yaml=true & dom_tested=true, got %+v", testPatchMap)
	}

	applyPatchRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_apply_selector_patch",
		Arguments: map[string]any{
			"view":       "job_detail",
			"field":      "skills",
			"selectors":  []string{".air3-skill-chip span"},
			"extract":    "list",
			"reason":     "MCP self-heal test",
			"capture_id": captureUID,
		},
	})
	if err != nil || applyPatchRes.IsError {
		t.Fatalf("upwork_apply_selector_patch failed: %+v err=%v", applyPatchRes, err)
	}
	applyPatchMap := parseToolJSON(t, applyPatchRes)
	if applyPatchMap["reloaded_extension"] != true ||
		applyPatchMap["new_version"] == "" ||
		applyPatchMap["new_version"] == applyPatchMap["old_version"] {
		t.Fatalf("expected reloaded_extension=true & bumped new_version, got %+v", applyPatchMap)
	}

	// 12b. upwork_active_projects (sync via backend, list + update via MCP)
	if _, syncErr := backend.SyncActiveProjects(ctx, server.SyncActiveProjectsRequest{
		Projects: []server.SyncActiveProjectItem{
			{
				ProjectKey:   "edfx-labs/mcp-proj",
				Slug:         "mcp-proj",
				Name:         "MCP Project",
				GroupName:    "edfx-labs",
				ActivityTier: "active",
				TechStack:    []string{"Go"},
			},
		},
	}); syncErr != nil {
		t.Fatalf("SyncActiveProjects failed: %v", syncErr)
	}
	apList, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_active_projects",
		Arguments: map[string]any{"action": "list", "tier": "active"},
	})
	if err != nil || apList.IsError || !strings.Contains(toolErrorText(apList), "edfx-labs/mcp-proj") {
		t.Fatalf("upwork_active_projects list failed: res=%+v err=%v", apList, err)
	}
	apUpd, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_active_projects",
		Arguments: map[string]any{
			"action":              "update",
			"id":                  "edfx-labs/mcp-proj",
			"proposal_visibility": "anonymized",
			"public_alias":        "Go Automation Service",
		},
	})
	if err != nil || apUpd.IsError || !strings.Contains(toolErrorText(apUpd), "Go Automation Service") {
		t.Fatalf("upwork_active_projects update failed: res=%+v err=%v", apUpd, err)
	}

	// 13. Verify all 10 resources return valid non-empty JSON
	for _, uri := range expectedResources {
		rr, rErr := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: uri})
		if rErr != nil || len(rr.Contents) == 0 {
			t.Fatalf("ReadResource(%q) failed: res=%+v err=%v", uri, rr, rErr)
		}
		c := rr.Contents[0]
		if c.MIMEType != "application/json" || len(c.Text) <= 2 {
			t.Fatalf("ReadResource(%q) bad content: mime=%q text=%q", uri, c.MIMEType, c.Text)
		}
		var parsed any
		if jErr := json.Unmarshal([]byte(c.Text), &parsed); jErr != nil {
			t.Fatalf("ReadResource(%q) invalid JSON: %v", uri, jErr)
		}
	}
}

func TestMCP_ErrorContracts_And_PolicyAndCompensation(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)

	var challengeMode atomic.Value
	challengeMode.Store("")
	var submitMode atomic.Value
	submitMode.Store("ok")

	handler := func(method string, params json.RawMessage) (any, *mockRPCError) {
		if ch, _ := challengeMode.Load().(string); ch != "" && (method == "jobs.search" || method == "jobs.detail" || method == "audit.selectors" || method == "proposal.fill") {
			return nil, &mockRPCError{
				Code:    -32001,
				Message: "Human verification challenge encountered: " + ch,
				Data:    map[string]any{"error_code": "HUMAN_ACTION_REQUIRED", "challenge_type": ch},
			}
		}
		if method == "proposal.submit" {
			if sm, _ := submitMode.Load().(string); sm == "unconfirmed" {
				return nil, &mockRPCError{
					Code:    -32010,
					Message: "Confirmation banner not detected",
					Data:    map[string]any{"error_code": "PROPOSAL_SUBMIT_UNCONFIRMED"},
				}
			}
		}
		return defaultMockHandler()(method, params)
	}

	_, disconnect := startMockWSServerAndClient(t, backend, handler)
	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	// Seed job & draft proposal while connected
	_, _ = session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_job_details",
		Arguments: map[string]any{"job_id": "~030100000000000000001"},
	})
	draftProp := parseToolJSON(t, func() *mcp.CallToolResult {
		r, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name: "upwork_draft_proposal",
			Arguments: map[string]any{
				"job_id":            "~030100000000000000001",
				"cover_letter":      "Error contract test proposal.",
				"bid_type":          "fixed",
				"bid_amount":        1500,
				"screening_answers": []string{"Answered."},
			},
		})
		if err != nil || r.IsError {
			t.Fatalf("draft failed: %+v err=%v", r, err)
		}
		return r
	}())
	propID := uint(draftProp["proposal_id"].(float64))

	fillRes, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_fill_proposal_form",
		Arguments: map[string]any{"proposal_id": propID},
	})
	propToken := parseToolJSON(t, fillRes)["approval_token"].(string)

	// 1. APPROVAL_REQUIRED under confirm_in_ui without token
	noTokSub, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID},
	})
	if !noTokSub.IsError || !strings.Contains(toolErrorText(noTokSub), "APPROVAL_REQUIRED") {
		t.Fatalf("expected APPROVAL_REQUIRED on submit without token, got %+v", noTokSub)
	}
	noTokMsg, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "body": "Blocked without token"},
	})
	if !noTokMsg.IsError || !strings.Contains(toolErrorText(noTokMsg), "APPROVAL_REQUIRED") {
		t.Fatalf("expected APPROVAL_REQUIRED on send_message without token, got %+v", noTokMsg)
	}

	// 2. draft_only hard-blocks even WITH valid approval_token
	draftOnlyMode := "draft_only"
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{Mode: &draftOnlyMode}, "test"); err != nil {
		t.Fatalf("policy update draft_only failed: %v", err)
	}
	draftOnlySub, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID, "approval_token": propToken},
	})
	if !draftOnlySub.IsError || !strings.Contains(toolErrorText(draftOnlySub), "POLICY_BLOCKED") || !strings.Contains(toolErrorText(draftOnlySub), "draft_only") {
		t.Fatalf("expected POLICY_BLOCKED + draft_only, got %+v", draftOnlySub)
	}

	// 3. DAILY_CAP_EXCEEDED under auto_with_guardrails with 0 cap
	zero := 0
	autoTrue := true
	autoMode := "auto_with_guardrails"
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{
		Mode:                &autoMode,
		MaxProposalsPerDay:  &zero,
		MaxMessagesPerDay:   &zero,
		AutoSubmitProposals: &autoTrue,
		AutoSendMessages:    &autoTrue,
	}, "test"); err != nil {
		t.Fatalf("policy update auto_with_guardrails failed: %v", err)
	}
	capSub, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID},
	})
	if !capSub.IsError || !strings.Contains(toolErrorText(capSub), "DAILY_CAP_EXCEEDED") {
		t.Fatalf("expected DAILY_CAP_EXCEEDED on proposal, got %+v", capSub)
	}
	capMsg, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "body": "Blocked by daily cap"},
	})
	if !capMsg.IsError || !strings.Contains(toolErrorText(capMsg), "DAILY_CAP_EXCEEDED") {
		t.Fatalf("expected DAILY_CAP_EXCEEDED on message, got %+v", capMsg)
	}

	// 4. Phase-3 PROPOSAL_SUBMIT_UNCONFIRMED compensation -> failed + token cleared + blocked until re-fill
	five := 5
	fifty := 50
	confirmMode := "confirm_in_ui"
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{
		Mode:               &confirmMode,
		MaxProposalsPerDay: &five,
		MaxConnectsPerDay:  &fifty,
	}, "test"); err != nil {
		t.Fatalf("policy reset confirm_in_ui failed: %v", err)
	}
	submitMode.Store("unconfirmed")
	uncSub, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID, "approval_token": propToken},
	})
	if !uncSub.IsError || !strings.Contains(toolErrorText(uncSub), "PROPOSAL_SUBMIT_UNCONFIRMED") {
		t.Fatalf("expected PROPOSAL_SUBMIT_UNCONFIRMED, got %+v", uncSub)
	}
	// Token was consumed and proposal is now failed; replay must fail even after mode restored
	submitMode.Store("ok")
	replaySub, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID, "approval_token": propToken},
	})
	if !replaySub.IsError || !strings.Contains(toolErrorText(replaySub), "PROPOSAL_REFILL_REQUIRED") {
		t.Fatalf("expected PROPOSAL_REFILL_REQUIRED on replay after unconfirmed failure, got %+v", replaySub)
	}

	// 5. HUMAN_ACTION_REQUIRED
	challengeMode.Store("captcha")
	haltedSearch, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_search_jobs",
		Arguments: map[string]any{"source": "search", "query": "golang"},
	})
	if !haltedSearch.IsError || !strings.Contains(toolErrorText(haltedSearch), "HUMAN_ACTION_REQUIRED") {
		t.Fatalf("expected HUMAN_ACTION_REQUIRED on search, got %+v", haltedSearch)
	}
	challengeMode.Store("")

	// 6. EXTENSION_DISCONNECTED when WS drops (DB tools keep working)
	disconnect()
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"upwork_list_tabs", map[string]any{}},
		{"upwork_search_jobs", map[string]any{"source": "search", "query": "golang"}},
		{"upwork_get_job_details", map[string]any{"job_id": "~030100000000000000001"}},
		{"upwork_audit_selectors", map[string]any{"view": "search_listings"}},
		{"upwork_fill_proposal_form", map[string]any{"proposal_id": propID}},
		{"upwork_fill_proposal_form", map[string]any{"proposal_id": 999999}},
		{"upwork_list_conversations", map[string]any{"sync": true}},
		{"upwork_sync_proposals", map[string]any{}},
	} {
		res, _ := session.CallTool(ctx, &mcp.CallToolParams{Name: tc.name, Arguments: tc.args})
		if !res.IsError || !strings.Contains(toolErrorText(res), "EXTENSION_DISCONNECTED") {
			t.Fatalf("expected EXTENSION_DISCONNECTED on %s, got %+v", tc.name, res)
		}
	}

	// DB-only tools still succeed while disconnected
	savedRes, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "upwork_list_saved_jobs", Arguments: map[string]any{}})
	if err != nil || savedRes.IsError {
		t.Fatalf("DB-only upwork_list_saved_jobs failed while disconnected: %+v err=%v", savedRes, err)
	}
}

func TestMCP_StreamableHTTP_AuthSessionConcurrencyAndShutdown(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)
	httpSrv, _ := startMockWSServerAndClient(t, backend, defaultMockHandler())
	mcpURL := httpSrv.URL + "/mcp"

	// 1. Unauthenticated /mcp -> 401 without leaking token
	unauthResp, err := http.Post(mcpURL, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
	if err != nil {
		t.Fatalf("unauth POST /mcp failed: %v", err)
	}
	unauthBody, _ := io.ReadAll(unauthResp.Body)
	_ = unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusUnauthorized || strings.Contains(string(unauthBody), backend.APIToken()) {
		t.Fatalf("unexpected unauth response: status=%d body=%s", unauthResp.StatusCode, string(unauthBody))
	}

	// 2. Concurrent multi-client Streamable HTTP sessions
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	connectHTTP := func(name string) *mcp.ClientSession {
		c := mcp.NewClient(&mcp.Implementation{Name: name, Version: "1.0.0"}, nil)
		s, cErr := c.Connect(ctx, &mcp.StreamableClientTransport{
			Endpoint:   mcpURL,
			HTTPClient: &http.Client{Transport: &bearerRT{token: backend.APIToken()}},
		}, nil)
		if cErr != nil {
			t.Fatalf("StreamableClientTransport(%s) connect failed: %v", name, cErr)
		}
		return s
	}

	cliA := connectHTTP("client-a")
	cliB := connectHTTP("client-b")
	if cliA.ID() == "" || cliB.ID() == "" || cliA.ID() == cliB.ID() {
		t.Fatalf("expected distinct non-empty Mcp-Session-Ids, got A=%q B=%q", cliA.ID(), cliB.ID())
	}

	var wg sync.WaitGroup
	var errA, errB error
	var resA, resB *mcp.CallToolResult
	wg.Add(2)
	go func() {
		defer wg.Done()
		resA, errA = cliA.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_get_job_details",
			Arguments: map[string]any{"job_id": "~030100000000000000001"},
		})
	}()
	go func() {
		defer wg.Done()
		resB, errB = cliB.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_list_tabs",
			Arguments: map[string]any{},
		})
	}()
	wg.Wait()

	if errA != nil || resA == nil || resA.IsError {
		t.Fatalf("concurrent HTTP client A failed: res=%+v err=%v", resA, errA)
	}
	if errB != nil || resB == nil || resB.IsError {
		t.Fatalf("concurrent HTTP client B failed: res=%+v err=%v", resB, errB)
	}

	// 3. Clean shutdown closes open MCP sessions without stalling
	_ = cliA.Close()
	_ = cliB.Close()
	mcpSrv.CloseSessions()
}

func TestMCP_StdioSubprocess_ProxyAndEmbeddedFallback(t *testing.T) {
	backend, _ := setupTestMCPServer(t)
	httpSrv, _ := startMockWSServerAndClient(t, backend, defaultMockHandler())

	// Build ./cmd/api binary in temp dir
	binPath := filepath.Join(t.TempDir(), "upwork-buddy-test")
	repoRoot, err := filepath.Abs("../..")
	if err != nil {
		t.Fatalf("resolve repo root: %v", err)
	}
	buildCmd := exec.Command("go", "build", "-o", binPath, "./cmd/api")
	buildCmd.Dir = repoRoot
	if out, bErr := buildCmd.CombinedOutput(); bErr != nil {
		t.Fatalf("build ./cmd/api failed: %v\n%s", bErr, string(out))
	}

	runStdioChecks := func(t *testing.T, args []string, extraEnv []string, expectConnected bool) {
		t.Helper()
		cmd := exec.Command(binPath, args...)
		cmd.Dir = repoRoot
		env := append(os.Environ(), extraEnv...)
		cmd.Env = env

		stdin, err := cmd.StdinPipe()
		if err != nil {
			t.Fatalf("stdin pipe: %v", err)
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatalf("stdout pipe: %v", err)
		}
		var stderrBuf bytes.Buffer
		cmd.Stderr = &stderrBuf

		if err := cmd.Start(); err != nil {
			t.Fatalf("start %v failed: %v", args, err)
		}

		// Tap stdout line-by-line to assert ZERO non-JSON lines while feeding a pipe to mcp.IOTransport
		pr, pw := io.Pipe()
		var nonJSONLines []string
		var linesMu sync.Mutex
		scanDone := make(chan struct{})
		go func() {
			defer close(scanDone)
			defer func() { _ = pw.Close() }()
			scanner := bufio.NewScanner(stdout)
			scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
			for scanner.Scan() {
				line := scanner.Text()
				trimmed := strings.TrimSpace(line)
				if trimmed != "" {
					var js any
					if json.Unmarshal([]byte(trimmed), &js) != nil {
						linesMu.Lock()
						nonJSONLines = append(nonJSONLines, line)
						linesMu.Unlock()
					}
				}
				_, _ = io.WriteString(pw, line+"\n")
			}
		}()

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()

		client := mcp.NewClient(&mcp.Implementation{Name: "stdio-test-client", Version: "1.0.0"}, nil)
		cliSession, err := client.Connect(ctx, &mcp.IOTransport{
			Reader: pr,
			Writer: stdin,
		}, nil)
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatalf("stdio Connect failed: %v\nstderr:\n%s", err, stderrBuf.String())
		}

		toolsRes, err := cliSession.ListTools(ctx, &mcp.ListToolsParams{})
		if err != nil || len(toolsRes.Tools) != 30 {
			t.Fatalf("stdio ListTools failed: len=%d err=%v", len(toolsRes.Tools), err)
		}
		resList, err := cliSession.ListResources(ctx, &mcp.ListResourcesParams{})
		if err != nil || len(resList.Resources) != 10 {
			t.Fatalf("stdio ListResources failed: len=%d err=%v", len(resList.Resources), err)
		}

		tabsRes, err := cliSession.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_list_tabs",
			Arguments: map[string]any{},
		})
		if err != nil {
			t.Fatalf("stdio upwork_list_tabs RPC error: %v", err)
		}
		if expectConnected {
			if tabsRes.IsError || !strings.Contains(toolErrorText(tabsRes), "best-matches") {
				t.Fatalf("expected live WS tabs through stdio proxy, got %+v", tabsRes)
			}
			detRes, dErr := cliSession.CallTool(ctx, &mcp.CallToolParams{
				Name:      "upwork_get_job_details",
				Arguments: map[string]any{"job_id": "~030100000000000000001"},
			})
			if dErr != nil || detRes.IsError {
				t.Fatalf("stdio upwork_get_job_details failed: %+v err=%v", detRes, dErr)
			}
		} else {
			if !tabsRes.IsError || !strings.Contains(toolErrorText(tabsRes), "EXTENSION_DISCONNECTED") {
				t.Fatalf("expected EXTENSION_DISCONNECTED in embedded fallback, got %+v", tabsRes)
			}
			// Regression: GORM DB queries (including gorm.ErrRecordNotFound and malformed batch JSONB)
			// must log to stderr and never emit non-JSON lines onto stdout.
			missingBatchRes, mbErr := cliSession.CallTool(ctx, &mcp.CallToolParams{
				Name:      "upwork_enrichment_batches",
				Arguments: map[string]any{"action": "get", "batch_id": 999999},
			})
			if mbErr != nil {
				t.Fatalf("stdio upwork_enrichment_batches(get missing) RPC error: %v", mbErr)
			}
			if !missingBatchRes.IsError || !strings.Contains(toolErrorText(missingBatchRes), "NOT_FOUND") {
				t.Fatalf("expected NOT_FOUND for missing batch_id 999999, got %+v", missingBatchRes)
			}

			badSaveRes, bsErr := cliSession.CallTool(ctx, &mcp.CallToolParams{
				Name: "upwork_save_jobs",
				Arguments: map[string]any{
					"jobs": []map[string]any{
						{
							"upwork_job_id": "x",
							"proposal_json": "{bad-json",
						},
					},
				},
			})
			if bsErr != nil {
				t.Fatalf("stdio upwork_save_jobs(bad proposal_json) RPC error: %v", bsErr)
			}
			if !badSaveRes.IsError || !strings.Contains(toolErrorText(badSaveRes), "INVALID_PARAMS") {
				t.Fatalf("expected INVALID_PARAMS for malformed proposal_json, got %+v", badSaveRes)
			}
		}

		_ = cliSession.Close()
		_ = stdin.Close()
		_ = cmd.Wait()
		<-scanDone

		linesMu.Lock()
		badLines := append([]string(nil), nonJSONLines...)
		linesMu.Unlock()
		if len(badLines) > 0 {
			t.Fatalf("expected 0 non-JSON lines on stdout, got: %v", badLines)
		}
	}

	t.Run("ProxyToLiveDaemon", func(t *testing.T) {
		runStdioChecks(t, []string{"mcp"}, []string{
			"UPWORK_BUDDY_URL=" + httpSrv.URL,
			"BUDDY_API_TOKEN=" + backend.APIToken(),
		}, true)
	})

	t.Run("EmbeddedFallback", func(t *testing.T) {
		dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
		runStdioChecks(t, []string{"mcp", "--embedded"}, []string{
			"DATABASE_URL=" + dsn,
		}, false)
	})

	t.Run("Proxy404DiagnosticWhenMCPDisabled", func(t *testing.T) {
		disabledSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"status":"ok","db":"up"}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"MCP server disabled"}`))
		}))
		defer disabledSrv.Close()

		cmd := exec.Command(binPath, "mcp", "--daemon-url", disabledSrv.URL)
		cmd.Dir = repoRoot
		cmd.Env = append(os.Environ(), "BUDDY_API_TOKEN=dummy-token")
		var outBuf, errBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &errBuf

		err := cmd.Run()
		if err == nil {
			t.Fatalf("expected non-zero exit when /mcp returns 404")
		}
		if outBuf.Len() != 0 {
			t.Fatalf("expected zero stdout bytes on 404 failure, got %q", outBuf.String())
		}
		stderrStr := errBuf.String()
		if !strings.Contains(stderrStr, "MCP_ENABLED=false") || !strings.Contains(stderrStr, "404") {
			t.Fatalf("expected clear MCP_ENABLED=false 404 diagnostic on stderr, got %q", stderrStr)
		}
	})
}

func TestMCP_Iteration2_RemediationRegressions(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)

	var lastAuditParams atomic.Value
	var lastSearchParams atomic.Value
	var sendMode atomic.Value
	sendMode.Store("ok")
	var msgSendCalls atomic.Int32
	var auditMode atomic.Value
	auditMode.Store("real_extension")
	var fillMode atomic.Value
	fillMode.Store("with_answers")

	handler := func(method string, params json.RawMessage) (any, *mockRPCError) {
		switch method {
		case "audit.selectors":
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			lastAuditParams.Store(p)

			if mode, _ := auditMode.Load().(string); mode == "empty" {
				return map[string]any{
					"ok":             true,
					"overall_status": "HEALTHY",
					"report": map[string]any{
						"view_type":                 "search_listings",
						"overall_status":            "HEALTHY",
						"audits":                    []any{},
						"discovered_candidates":     nil,
						"baseline_diffs":            nil,
						"breaking_changes_detected": []string{},
					},
					"blueprint": map[string]any{
						"view_type": "search_listings",
					},
				}, nil
			}

			return map[string]any{
				"ok":             true,
				"overall_status": "BROKEN",
				"report": map[string]any{
					"timestamp":                time.Now().UTC().Format(time.RFC3339),
					"url":                      "https://www.upwork.com/nx/search/jobs/?q=mutated_drift",
					"view_type":                "search_listings",
					"is_authenticated":         true,
					"healthy_selectors_count":  5,
					"degraded_selectors_count": 0,
					"broken_selectors_count":   1,
					"fragile_selectors_count":  1,
					"audits": []map[string]any{
						{
							"target_field":          "title_and_url",
							"view":                  "search_listings",
							"registered_selector":   "a[data-test*='job-tile-title-link']",
							"status":                "BROKEN",
							"matched_count":         0,
							"notes":                 "Primary and all fallback selectors matched 0 elements",
							"suggested_replacement": "a[data-test='new-title']",
						},
						{
							"target_field":          "posted",
							"view":                  "search_listings",
							"registered_selector":   "span[data-test='job-pubilshed-date']",
							"status":                "FRAGILE",
							"matched_count":         4,
							"notes":                 "Typo pubilshed",
							"suggested_replacement": "[data-test='job-published-date'] span",
						},
					},
					"discovered_candidates": []map[string]any{
						{
							"hook_name":          "payment-verified-badge",
							"suggested_selector": "[data-test='payment-verified-badge']",
							"sample_text":        "Payment verified",
							"element_tag":        "span",
							"confidence":         "HIGH",
							"notes":              "Unmapped data-test hook",
						},
					},
					"breaking_changes_detected": []string{
						"BROKEN: search_listings.title_and_url",
						"BASELINE DRIFT: Hook 'token' frequency dropped",
					},
					"baseline_diffs": []map[string]any{
						{
							"hook_name":          "token",
							"hook_type":          "data-test",
							"change_type":        "FREQUENCY_DROPPED",
							"baseline_frequency": 8,
							"current_frequency":  2,
							"notes":              "frequency dropped from 8 to 2",
						},
						{
							"hook_name":          "ai-match-badge",
							"hook_type":          "data-test",
							"change_type":        "ADDED",
							"baseline_frequency": 0,
							"current_frequency":  3,
							"notes":              "new hook appeared",
						},
					},
				},
				"blueprint": map[string]any{
					"view_type": "search_listings",
					"job_card_blueprint": map[string]any{
						"total_cards_detected": 5,
					},
				},
			}, nil

		case "jobs.search":
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			lastSearchParams.Store(p)
			return defaultMockHandler()(method, params)

		case "proposal.fill":
			if fm, _ := fillMode.Load().(string); fm == "null_answers" {
				return map[string]any{
					"ok":                  true,
					"cover_letter_length": 44,
					"bid_type":            "hourly",
					"bid_amount":          85.0,
					"connects_cost":       8,
					"total_connects":      8,
					"available_connects":  50,
					"screening_answers":   nil,
				}, nil
			}
			return map[string]any{
				"ok":                  true,
				"cover_letter_length": 62,
				"bid_type":            "fixed",
				"bid_amount":          1400.0,
				"connects_cost":       12,
				"total_connects":      16,
				"available_connects":  50,
				"screening_answers": []map[string]any{
					{"index": 0, "prompt": "Experience?", "answer": "10 years Go", "required": true},
					{"index": 1, "prompt": "Availability?", "answer": "35 hrs/wk", "required": false},
				},
			}, nil

		case "messages.send":
			msgSendCalls.Add(1)
			if sm, _ := sendMode.Load().(string); sm == "unconfirmed" {
				return nil, &mockRPCError{
					Code:    -32000,
					Message: "MESSAGE_SEND_UNCONFIRMED: confirmation not detected",
					Data:    map[string]any{"error_code": "MESSAGE_SEND_UNCONFIRMED"},
				}
			}
			return map[string]any{"ok": true, "sent": true}, nil

		default:
			return defaultMockHandler()(method, params)
		}
	}

	_, _ = startMockWSServerAndClient(t, backend, handler)
	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	// Finding 1: upwork_audit_selectors with save_baseline + DriftAuditReport.audits -> rules synthesis + top-level fields
	auditRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_audit_selectors",
		Arguments: map[string]any{
			"view":          "search_listings",
			"url":           "https://www.upwork.com/nx/search/jobs/?q=mutated_drift",
			"save_baseline": true,
		},
	})
	if err != nil || auditRes.IsError {
		t.Fatalf("upwork_audit_selectors failed: res=%+v err=%v", auditRes, err)
	}
	if p, ok := lastAuditParams.Load().(map[string]any); !ok || p["update_baseline"] != true {
		t.Fatalf("expected save_baseline=true to forward update_baseline=true to extension, got %+v", p)
	}
	auditJSON := parseToolJSON(t, auditRes)
	if auditJSON["total_cards_detected"] != float64(5) {
		t.Fatalf("expected top-level total_cards_detected=5, got %v", auditJSON["total_cards_detected"])
	}
	if auditJSON["breaking_changes_detected"] != true {
		t.Fatalf("expected top-level breaking_changes_detected=true, got %v", auditJSON["breaking_changes_detected"])
	}
	rulesMap, _ := auditJSON["rules"].(map[string]any)
	titleRule, _ := rulesMap["title"].(map[string]any)
	urlRule, _ := rulesMap["url"].(map[string]any)
	postedRule, _ := rulesMap["posted"].(map[string]any)
	if titleRule["status"] != "BROKEN" || urlRule["status"] != "BROKEN" || postedRule["status"] != "FRAGILE" {
		t.Fatalf("expected synthesized rules for title, url, and posted, got %+v", rulesMap)
	}
	fieldResults, _ := auditJSON["field_results"].([]any)
	if len(fieldResults) < 3 {
		t.Fatalf("expected non-empty field_results array, got %+v", auditJSON["field_results"])
	}
	candidates, _ := auditJSON["discovered_candidates"].([]any)
	if len(candidates) != 1 {
		t.Fatalf("expected 1 discovered_candidate, got %+v", auditJSON["discovered_candidates"])
	}
	bDiff, _ := auditJSON["baseline_diff"].([]any)
	bDiffs, _ := auditJSON["baseline_diffs"].([]any)
	if len(bDiff) != 2 || len(bDiffs) != 2 {
		t.Fatalf("expected 2 items in both baseline_diff and baseline_diffs, got diff=%+v diffs=%+v", auditJSON["baseline_diff"], auditJSON["baseline_diffs"])
	}
	firstDiff, _ := bDiff[0].(map[string]any)
	if firstDiff["hook"] != "token" {
		t.Fatalf("expected normalized hook='token' in baseline_diff, got %+v", firstDiff)
	}

	// Empty report should emit [] (never null) and breaking_changes_detected=false
	auditMode.Store("empty")
	emptyAuditRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_audit_selectors",
		Arguments: map[string]any{"view": "search_listings"},
	})
	if err != nil || emptyAuditRes.IsError {
		t.Fatalf("empty upwork_audit_selectors failed: res=%+v err=%v", emptyAuditRes, err)
	}
	emptyRaw := toolErrorText(emptyAuditRes)
	for _, field := range []string{`"field_results":[]`, `"discovered_candidates":[]`, `"baseline_diff":[]`, `"baseline_diffs":[]`, `"breaking_changes_detected":false`} {
		if !strings.Contains(emptyRaw, field) {
			t.Fatalf("expected %s in empty audit response, got %s", field, emptyRaw)
		}
	}
	auditMode.Store("real_extension")

	// Finding 2: upwork_fill_proposal_form exposes top-level verification snapshot fields (and [] default)
	jobResp, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_job_details",
		Arguments: map[string]any{"job_id": "~030100000000000000001"},
	})
	if err != nil || jobResp.IsError {
		t.Fatalf("seed job detail failed: %+v err=%v", jobResp, err)
	}
	draftPropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_draft_proposal",
		Arguments: map[string]any{
			"job_id":            "~030100000000000000001",
			"cover_letter":      "Detailed WordPress and Go architecture plan for regression test.",
			"bid_type":          "fixed",
			"bid_amount":        1400,
			"screening_answers": []string{"10 years Go", "35 hrs/wk"},
			"boost_connects":    4,
		},
	})
	if err != nil || draftPropRes.IsError {
		t.Fatalf("upwork_draft_proposal failed: %+v err=%v", draftPropRes, err)
	}
	propID := uint(parseToolJSON(t, draftPropRes)["proposal_id"].(float64))

	fillRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_fill_proposal_form",
		Arguments: map[string]any{"proposal_id": propID},
	})
	if err != nil || fillRes.IsError {
		t.Fatalf("upwork_fill_proposal_form failed: %+v err=%v", fillRes, err)
	}
	fillJSON := parseToolJSON(t, fillRes)
	if fillJSON["cover_letter_length"] != float64(62) ||
		fillJSON["bid_type"] != "fixed" ||
		fillJSON["bid_amount"] != float64(1400) ||
		fillJSON["total_connects"] != float64(16) ||
		fillJSON["connects_cost"] != float64(12) ||
		fillJSON["available_connects"] != float64(50) ||
		fillJSON["status"] != "pending_approval" {
		t.Fatalf("expected top-level snapshot fields on fill result, got %+v", fillJSON)
	}
	if sa, ok := fillJSON["screening_answers"].([]any); !ok || len(sa) != 2 {
		t.Fatalf("expected top-level screening_answers length 2, got %+v", fillJSON["screening_answers"])
	}

	fillMode.Store("null_answers")
	fillNullRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_fill_proposal_form",
		Arguments: map[string]any{"proposal_id": propID},
	})
	if err != nil || fillNullRes.IsError {
		t.Fatalf("upwork_fill_proposal_form (null_answers) failed: %+v err=%v", fillNullRes, err)
	}
	if !strings.Contains(toolErrorText(fillNullRes), `"screening_answers":[]`) {
		t.Fatalf("expected screening_answers to default to [], got %s", toolErrorText(fillNullRes))
	}
	fillMode.Store("with_answers")

	// Finding 3: upwork_list_saved_jobs include_unknown_budget, required_keywords, exclude_keywords
	gormDB := backend.DB().GetGorm()
	seedJobs := []dbservice.Job{
		{
			UpworkJobID:  strPtr("~040000000000000000001"),
			Title:        "Go Backend Microservices",
			Description:  "Build scalable Go APIs with PostgreSQL.",
			Skills:       "Go, PostgreSQL",
			ContractType: "fixed",
			BudgetAmount: "$1,500",
			URL:          "https://www.upwork.com/jobs/~040000000000000000001/",
			CanonicalURL: "https://www.upwork.com/jobs/~040000000000000000001/",
		},
		{
			UpworkJobID:  strPtr("~040000000000000000002"),
			Title:        "Go + WordPress Integration",
			Description:  "Connect Go webhook to WordPress site.",
			Skills:       "Go, WordPress",
			ContractType: "fixed",
			BudgetAmount: "$0",
			URL:          "https://www.upwork.com/jobs/~040000000000000000002/",
			CanonicalURL: "https://www.upwork.com/jobs/~040000000000000000002/",
		},
		{
			UpworkJobID:  strPtr("~040000000000000000003"),
			Title:        "Django REST API",
			Description:  "Python Django web backend without fixed budget.",
			Skills:       "Python, Django",
			ContractType: "fixed",
			BudgetAmount: "",
			URL:          "https://www.upwork.com/jobs/~040000000000000000003/",
			CanonicalURL: "https://www.upwork.com/jobs/~040000000000000000003/",
		},
		{
			UpworkJobID:  strPtr("~040000000000000000004"),
			Title:        "Enterprise .NET Core API",
			Description:  "C# and .NET 8 services.",
			Skills:       ".NET, C#",
			ContractType: "fixed",
			BudgetAmount: "$2,000",
			URL:          "https://www.upwork.com/jobs/~040000000000000000004/",
			CanonicalURL: "https://www.upwork.com/jobs/~040000000000000000004/",
		},
		{
			UpworkJobID:  strPtr("~040000000000000000005"),
			Title:        "Cloud Networking Engineer",
			Description:  "VPC peering and networking automation.",
			Skills:       "Networking, AWS",
			ContractType: "fixed",
			BudgetAmount: "$2,000",
			URL:          "https://www.upwork.com/jobs/~040000000000000000005/",
			CanonicalURL: "https://www.upwork.com/jobs/~040000000000000000005/",
		},
	}
	for i := range seedJobs {
		if err := gormDB.Create(&seedJobs[i]).Error; err != nil {
			t.Fatalf("seed job %d failed: %v", i, err)
		}
	}

	exclUnknownRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_saved_jobs",
		Arguments: map[string]any{"budget_min": 100, "include_unknown_budget": false},
	})
	if err != nil || exclUnknownRes.IsError {
		t.Fatalf("list_saved_jobs exclude unknown failed: %+v err=%v", exclUnknownRes, err)
	}
	exclText := toolErrorText(exclUnknownRes)
	if strings.Contains(exclText, "~040000000000000000002") || strings.Contains(exclText, "~040000000000000000003") {
		t.Fatalf("expected $0 and unknown budget excluded, got %s", exclText)
	}

	inclUnknownRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_saved_jobs",
		Arguments: map[string]any{"budget_min": 100, "include_unknown_budget": true},
	})
	if err != nil || inclUnknownRes.IsError {
		t.Fatalf("list_saved_jobs include unknown failed: %+v err=%v", inclUnknownRes, err)
	}
	inclText := toolErrorText(inclUnknownRes)
	if strings.Contains(inclText, "~040000000000000000002") || !strings.Contains(inclText, "~040000000000000000003") {
		t.Fatalf("expected $0 excluded and unknown budget ~040000000000000000003 included, got %s", inclText)
	}

	goKWRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_list_saved_jobs",
		Arguments: map[string]any{
			"required_keywords": []string{"go"},
			"exclude_keywords":  []string{"wordpress"},
		},
	})
	if err != nil || goKWRes.IsError {
		t.Fatalf("list_saved_jobs go keyword failed: %+v err=%v", goKWRes, err)
	}
	goText := toolErrorText(goKWRes)
	if !strings.Contains(goText, "~040000000000000000001") ||
		strings.Contains(goText, "~040000000000000000002") ||
		strings.Contains(goText, "~040000000000000000003") {
		t.Fatalf("expected go/wordpress boundary match to keep ~040000000000000000001 and exclude 2 (wordpress) & 3 (django), got %s", goText)
	}

	netKWRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_saved_jobs",
		Arguments: map[string]any{"required_keywords": []string{".net"}},
	})
	if err != nil || netKWRes.IsError {
		t.Fatalf("list_saved_jobs .net keyword failed: %+v err=%v", netKWRes, err)
	}
	netText := toolErrorText(netKWRes)
	if !strings.Contains(netText, "~040000000000000000004") || strings.Contains(netText, "~040000000000000000005") {
		t.Fatalf("expected .net boundary match to keep ~040000000000000000004 and exclude networking ~040000000000000000005, got %s", netText)
	}

	// Finding 4: upwork_search_jobs amount facet & partial filters schema validation ({"min_score": 70})
	searchPartialRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_search_jobs",
		Arguments: map[string]any{
			"source":    "search",
			"query":     "golang",
			"amount":    "500-5000",
			"max_pages": 1,
			"filters":   map[string]any{"min_score": 70},
		},
	})
	if err != nil || searchPartialRes.IsError {
		t.Fatalf("upwork_search_jobs with amount + partial filters failed: res=%+v err=%v", searchPartialRes, err)
	}
	if sp, ok := lastSearchParams.Load().(map[string]any); !ok ||
		sp["amount"] != "500-5000" ||
		sp["budget_min"] != float64(500) ||
		sp["budget_max"] != float64(5000) {
		t.Fatalf("expected amount=500-5000, budget_min=500, budget_max=5000 forwarded to WS, got %+v", sp)
	}
	badAmountRes, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_search_jobs",
		Arguments: map[string]any{
			"source": "search",
			"query":  "golang",
			"amount": "bad-range",
		},
	})
	if !badAmountRes.IsError || !strings.Contains(toolErrorText(badAmountRes), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS for invalid amount facet, got %+v", badAmountRes)
	}

	// Finding 5: CommitMessage terminal/in-flight guard in auto_with_guardrails
	autoMode := "auto_with_guardrails"
	autoTrue := true
	ten := 10
	allowedRooms := []string{"room_alpha"}
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{
		Mode:              &autoMode,
		AutoSendMessages:  &autoTrue,
		MaxMessagesPerDay: &ten,
		AllowedRoomIDs:    &allowedRooms,
	}, "test"); err != nil {
		t.Fatalf("policy update auto_with_guardrails failed: %v", err)
	}

	draftFailRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_draft_message",
		Arguments: map[string]any{"room_id": "room_alpha", "body": "Unconfirmed attempt"},
	})
	if err != nil || draftFailRes.IsError {
		t.Fatalf("upwork_draft_message failed: %+v err=%v", draftFailRes, err)
	}
	failMsgJSON := parseToolJSON(t, draftFailRes)
	failMsgMap := failMsgJSON["message"].(map[string]any)
	failMsgID := uint(failMsgMap["id"].(float64))
	failMsgTok := failMsgJSON["approval_token"].(string)

	sendMode.Store("unconfirmed")
	uncSendRes, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "message_id": failMsgID, "approval_token": failMsgTok},
	})
	if !uncSendRes.IsError || !strings.Contains(toolErrorText(uncSendRes), "MESSAGE_SEND_UNCONFIRMED") {
		t.Fatalf("expected MESSAGE_SEND_UNCONFIRMED, got %+v", uncSendRes)
	}
	sendMode.Store("ok")
	beforeCalls := msgSendCalls.Load()
	reSendFailed, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "message_id": failMsgID},
	})
	if !reSendFailed.IsError || !strings.Contains(toolErrorText(reSendFailed), "MESSAGE_REDRAFT_REQUIRED") {
		t.Fatalf("expected MESSAGE_REDRAFT_REQUIRED for failed message_id, got %+v", reSendFailed)
	}
	if msgSendCalls.Load() != beforeCalls {
		t.Fatalf("expected 0 messages.send RPC calls for failed message_id")
	}

	sentRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "body": "Once-only reply"},
	})
	if err != nil || sentRes.IsError {
		t.Fatalf("initial send_message failed: %+v err=%v", sentRes, err)
	}
	sentMsgID := uint(parseToolJSON(t, sentRes)["message"].(map[string]any)["id"].(float64))
	beforeSentCalls := msgSendCalls.Load()
	reSendSent, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "message_id": sentMsgID},
	})
	if !reSendSent.IsError || !strings.Contains(toolErrorText(reSendSent), "ALREADY_SENT") {
		t.Fatalf("expected ALREADY_SENT for sent message_id, got %+v", reSendSent)
	}
	if msgSendCalls.Load() != beforeSentCalls {
		t.Fatalf("expected 0 messages.send RPC calls for already-sent message_id")
	}

	// Verify in-flight "sending" status is also blocked with ALREADY_SENT
	_ = gormDB.Model(&dbservice.Message{}).Where("id = ?", sentMsgID).Update("status", "sending").Error
	reSendSending, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_alpha", "message_id": sentMsgID},
	})
	if !reSendSending.IsError || !strings.Contains(toolErrorText(reSendSending), "ALREADY_SENT") {
		t.Fatalf("expected ALREADY_SENT for sending message_id, got %+v", reSendSending)
	}
	if msgSendCalls.Load() != beforeSentCalls {
		t.Fatalf("expected 0 messages.send RPC calls for sending message_id")
	}

	// Finding 6a: upwork_profile partial update preserves skills when omitted, clears on explicit ""
	profSeed, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"action":      "update",
			"description": "Initial bio",
			"skills":      []string{"Go", "PostgreSQL"},
		},
	})
	if err != nil || profSeed.IsError {
		t.Fatalf("profile seed failed: %+v err=%v", profSeed, err)
	}
	profPartial, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"action":      "update",
			"description": "Updated bio without skills",
		},
	})
	if err != nil || profPartial.IsError {
		t.Fatalf("profile partial update failed: %+v err=%v", profPartial, err)
	}
	if parseToolJSON(t, profPartial)["skills"] != "Go, PostgreSQL" {
		t.Fatalf("expected skills preserved on partial update, got %s", toolErrorText(profPartial))
	}
	profRateOnly, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_profile",
		Arguments: map[string]any{"target_rate": 130},
	})
	if err != nil || profRateOnly.IsError {
		t.Fatalf("profile auto-action with target_rate failed: %+v err=%v", profRateOnly, err)
	}
	if parseToolJSON(t, profRateOnly)["skills"] != "Go, PostgreSQL" {
		t.Fatalf("expected skills preserved on target_rate-only update, got %s", toolErrorText(profRateOnly))
	}
	profClearSkills, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"action":      "update",
			"description": "Explicitly cleared skills",
			"skills":      "",
		},
	})
	if err != nil || profClearSkills.IsError {
		t.Fatalf("profile explicit empty skills failed: %+v err=%v", profClearSkills, err)
	}
	if parseToolJSON(t, profClearSkills)["skills"] != "" {
		t.Fatalf("expected explicit empty skills to clear skills, got %s", toolErrorText(profClearSkills))
	}

	// Finding 6b: upwork_generate_project_agents with job_id: "" + template_name
	genBlankJob, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_generate_project_agents",
		Arguments: map[string]any{
			"job_id":        "",
			"template_name": "golang",
			"agent_names":   []string{"go-api-agent"},
			"format":        "claude",
		},
	})
	if err != nil || genBlankJob.IsError {
		t.Fatalf("upwork_generate_project_agents with blank job_id failed: %+v err=%v", genBlankJob, err)
	}
}

func TestMCP_Iteration3_RemediationRegressions(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)

	var auditDiffType atomic.Value
	auditDiffType.Store("REMOVED")

	handler := func(method string, params json.RawMessage) (any, *mockRPCError) {
		switch method {
		case "audit.selectors":
			dt, _ := auditDiffType.Load().(string)
			return map[string]any{
				"ok":             true,
				"overall_status": "DEGRADED",
				"report": map[string]any{
					"view_type":                 "search_listings",
					"overall_status":            "DEGRADED",
					"audits":                    []any{},
					"breaking_changes_detected": []string{},
					"baseline_diffs": []map[string]any{
						{
							"hook_name":          "synthetic-hook",
							"hook_type":          "data-test",
							"diff_type":          dt,
							"baseline_frequency": 8,
							"current_frequency":  0,
						},
					},
				},
			}, nil
		default:
			return defaultMockHandler()(method, params)
		}
	}

	_, _ = startMockWSServerAndClient(t, backend, handler)
	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	// 1. upwork_list_saved_jobs pagination total on SQL path AND in-memory filter path
	gormDB := backend.DB().GetGorm()
	seedJobs := []dbservice.Job{
		{
			UpworkJobID:  strPtr("~050000000000000000001"),
			Title:        "Go API Engineer 1",
			Description:  "Build Go REST services.",
			Skills:       "Go, PostgreSQL",
			ContractType: "fixed",
			BudgetAmount: "$1,000",
			URL:          "https://www.upwork.com/jobs/~050000000000000000001/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000001/",
		},
		{
			UpworkJobID:  strPtr("~050000000000000000002"),
			Title:        "Go gRPC Service 2",
			Description:  "Build Go microservices.",
			Skills:       "Go, gRPC",
			ContractType: "fixed",
			BudgetAmount: "$1,500",
			URL:          "https://www.upwork.com/jobs/~050000000000000000002/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000002/",
		},
		{
			UpworkJobID:  strPtr("~050000000000000000003"),
			Title:        "Go CLI Tooling 3",
			Description:  "Develop Go CLI utilities.",
			Skills:       "Go, Docker",
			ContractType: "fixed",
			BudgetAmount: "$2,000",
			URL:          "https://www.upwork.com/jobs/~050000000000000000003/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000003/",
		},
		{
			UpworkJobID:  strPtr("~050000000000000000004"),
			Title:        "Go Worker Queue 4",
			Description:  "Implement Go background workers.",
			Skills:       "Go, Redis",
			ContractType: "fixed",
			BudgetAmount: "$2,500",
			URL:          "https://www.upwork.com/jobs/~050000000000000000004/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000004/",
		},
		{
			UpworkJobID:  strPtr("~050000000000000000005"),
			Title:        "Go Scheduler 5",
			Description:  "Distributed Go cron scheduler.",
			Skills:       "Go, Kubernetes",
			ContractType: "fixed",
			BudgetAmount: "$3,000",
			URL:          "https://www.upwork.com/jobs/~050000000000000000005/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000005/",
		},
		{
			UpworkJobID:  strPtr("~050000000000000000006"),
			Title:        "Go + WordPress Webhook",
			Description:  "Sync Go backend with WordPress.",
			Skills:       "Go, WordPress",
			ContractType: "fixed",
			BudgetAmount: "$1,200",
			URL:          "https://www.upwork.com/jobs/~050000000000000000006/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000006/",
		},
		{
			UpworkJobID:  strPtr("~050000000000000000007"),
			Title:        "Python Django Backend",
			Description:  "Build Django REST API.",
			Skills:       "Python, Django",
			ContractType: "fixed",
			BudgetAmount: "$1,800",
			URL:          "https://www.upwork.com/jobs/~050000000000000000007/",
			CanonicalURL: "https://www.upwork.com/jobs/~050000000000000000007/",
		},
	}
	for i := range seedJobs {
		if err := gormDB.Create(&seedJobs[i]).Error; err != nil {
			t.Fatalf("seed job %d failed: %v", i, err)
		}
	}

	assertPage := func(label string, args map[string]any, wantLen int, wantTotal int) []any {
		t.Helper()
		res, callErr := session.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_list_saved_jobs",
			Arguments: args,
		})
		if callErr != nil || res.IsError {
			t.Fatalf("[%s] upwork_list_saved_jobs failed: res=%+v err=%v", label, res, callErr)
		}
		parsed := parseToolJSON(t, res)
		jobsSlice, _ := parsed["jobs"].([]any)
		if len(jobsSlice) != wantLen {
			t.Fatalf("[%s] expected len(jobs)=%d, got %d (%s)", label, wantLen, len(jobsSlice), toolErrorText(res))
		}
		if parsed["total"] != float64(wantTotal) {
			t.Fatalf("[%s] expected total=%d, got %v (%s)", label, wantTotal, parsed["total"], toolErrorText(res))
		}
		return jobsSlice
	}

	// SQL pagination path (7 total rows)
	sqlPage1 := assertPage("sql page1", map[string]any{"limit": 2, "offset": 0}, 2, 7)
	sqlPage2 := assertPage("sql page2", map[string]any{"limit": 2, "offset": 2}, 2, 7)
	assertPage("sql beyond end", map[string]any{"limit": 2, "offset": 10}, 0, 7)
	if sqlPage1[0].(map[string]any)["id"] == sqlPage2[0].(map[string]any)["id"] {
		t.Fatalf("expected distinct SQL pages, got same first job id: %v", sqlPage1[0])
	}

	// In-memory filter path (5 matching Go non-WordPress rows)
	memPage1 := assertPage("in-memory page1", map[string]any{
		"required_keywords": []string{"go"},
		"exclude_keywords":  []string{"wordpress"},
		"limit":             2,
		"offset":            0,
	}, 2, 5)
	memPage2 := assertPage("in-memory page2", map[string]any{
		"required_keywords": []string{"go"},
		"exclude_keywords":  []string{"wordpress"},
		"limit":             2,
		"offset":            2,
	}, 2, 5)
	assertPage("in-memory page3", map[string]any{
		"required_keywords": []string{"go"},
		"exclude_keywords":  []string{"wordpress"},
		"limit":             2,
		"offset":            4,
	}, 1, 5)
	assertPage("in-memory beyond end", map[string]any{
		"required_keywords": []string{"go"},
		"exclude_keywords":  []string{"wordpress"},
		"limit":             2,
		"offset":            10,
	}, 0, 5)
	if memPage1[0].(map[string]any)["id"] == memPage2[0].(map[string]any)["id"] {
		t.Fatalf("expected distinct in-memory pages, got same first job id: %v", memPage1[0])
	}

	// 2. upwork_profile partial update preserves portfolio_items when omitted, clears on explicit []
	profWithItems, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"action":      "update",
			"description": "Principal Go Engineer",
			"skills":      []string{"Go", "PostgreSQL"},
			"portfolio_items": []map[string]any{
				{"title": "Portfolio Alpha", "link": "https://example.com/alpha", "description": "Alpha project"},
				{"title": "Portfolio Beta", "link": "https://example.com/beta", "description": "Beta project"},
			},
		},
	})
	if err != nil || profWithItems.IsError {
		t.Fatalf("seed profile with portfolio failed: %+v err=%v", profWithItems, err)
	}
	if items, _ := parseToolJSON(t, profWithItems)["portfolio_items"].([]any); len(items) != 2 {
		t.Fatalf("expected 2 seeded portfolio_items, got %s", toolErrorText(profWithItems))
	}

	profPartialDesc, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"description": "Updated Go Architect",
		},
	})
	if err != nil || profPartialDesc.IsError {
		t.Fatalf("partial profile description update failed: %+v err=%v", profPartialDesc, err)
	}
	partialDescJSON := parseToolJSON(t, profPartialDesc)
	if partialDescJSON["description"] != "Updated Go Architect" || partialDescJSON["skills"] != "Go, PostgreSQL" {
		t.Fatalf("expected description updated and skills preserved, got %s", toolErrorText(profPartialDesc))
	}
	if items, _ := partialDescJSON["portfolio_items"].([]any); len(items) != 2 {
		t.Fatalf("expected portfolio_items preserved on description-only partial update, got %s", toolErrorText(profPartialDesc))
	}

	profGetPreserved, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_profile",
		Arguments: map[string]any{"action": "get"},
	})
	if err != nil || profGetPreserved.IsError {
		t.Fatalf("get profile after partial update failed: %+v err=%v", profGetPreserved, err)
	}
	if items, _ := parseToolJSON(t, profGetPreserved)["portfolio_items"].([]any); len(items) != 2 {
		t.Fatalf("expected 2 portfolio_items persisted in DB after partial update, got %s", toolErrorText(profGetPreserved))
	}

	// Explicit empty portfolio_items: [] (even without explicit action) clears portfolio items
	profClearPortfolio, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_profile",
		Arguments: map[string]any{
			"portfolio_items": []any{},
		},
	})
	if err != nil || profClearPortfolio.IsError {
		t.Fatalf("clear portfolio_items failed: %+v err=%v", profClearPortfolio, err)
	}
	clearJSON := parseToolJSON(t, profClearPortfolio)
	if items, _ := clearJSON["portfolio_items"].([]any); len(items) != 0 {
		t.Fatalf("expected portfolio_items cleared to [], got %s", toolErrorText(profClearPortfolio))
	}
	if clearJSON["description"] != "Updated Go Architect" || clearJSON["skills"] != "Go, PostgreSQL" {
		t.Fatalf("expected description and skills preserved when clearing portfolio_items, got %s", toolErrorText(profClearPortfolio))
	}

	profGetCleared, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_profile",
		Arguments: map[string]any{"action": "get"},
	})
	if err != nil || profGetCleared.IsError {
		t.Fatalf("get profile after clear failed: %+v err=%v", profGetCleared, err)
	}
	if items, _ := parseToolJSON(t, profGetCleared)["portfolio_items"].([]any); len(items) != 0 {
		t.Fatalf("expected 0 portfolio_items in DB after explicit clear, got %s", toolErrorText(profGetCleared))
	}

	// 3. upwork_audit_selectors with diff_type: "REMOVED" sets breaking_changes_detected: true
	auditRemovedRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_audit_selectors",
		Arguments: map[string]any{"view": "search_listings"},
	})
	if err != nil || auditRemovedRes.IsError {
		t.Fatalf("upwork_audit_selectors (diff_type=REMOVED) failed: %+v err=%v", auditRemovedRes, err)
	}
	if parseToolJSON(t, auditRemovedRes)["breaking_changes_detected"] != true {
		t.Fatalf("expected breaking_changes_detected=true for diff_type=REMOVED, got %s", toolErrorText(auditRemovedRes))
	}

	auditDiffType.Store("FREQUENCY_DROPPED")
	auditDropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_audit_selectors",
		Arguments: map[string]any{"view": "search_listings"},
	})
	if err != nil || auditDropRes.IsError {
		t.Fatalf("upwork_audit_selectors (diff_type=FREQUENCY_DROPPED) failed: %+v err=%v", auditDropRes, err)
	}
	if parseToolJSON(t, auditDropRes)["breaking_changes_detected"] != true {
		t.Fatalf("expected breaking_changes_detected=true for diff_type=FREQUENCY_DROPPED, got %s", toolErrorText(auditDropRes))
	}

	auditDiffType.Store("ADDED")
	auditAddedRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_audit_selectors",
		Arguments: map[string]any{"view": "search_listings"},
	})
	if err != nil || auditAddedRes.IsError {
		t.Fatalf("upwork_audit_selectors (diff_type=ADDED) failed: %+v err=%v", auditAddedRes, err)
	}
	if parseToolJSON(t, auditAddedRes)["breaking_changes_detected"] != false {
		t.Fatalf("expected breaking_changes_detected=false for diff_type=ADDED, got %s", toolErrorText(auditAddedRes))
	}
}

func TestMCP_NegativeParamsAndJobURLFallback(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)
	ctx := context.Background()

	var seenDetailURL string
	_, _ = startMockWSServerAndClient(t, backend, func(method string, params json.RawMessage) (any, *mockRPCError) {
		if method == "jobs.detail" {
			var p map[string]any
			_ = json.Unmarshal(params, &p)
			if u, ok := p["url"].(string); ok {
				seenDetailURL = u
			}
			return map[string]any{
				"ok":   true,
				"jobs": []map[string]any{},
			}, nil
		}
		return defaultMockHandler()(method, params)
	})

	session := connectInMemoryClient(t, mcpSrv)

	// Seed a job with empty CanonicalURL and non-empty URL
	job := dbservice.Job{
		Title:        "Fallback URL Job",
		URL:          "https://www.upwork.com/jobs/Fallback_~0555/",
		CanonicalURL: "",
	}
	if err := backend.DB().GetGorm().Create(&job).Error; err != nil {
		t.Fatalf("seed job: %v", err)
	}

	detRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_job_details",
		Arguments: map[string]any{"job_id": job.ID},
	})
	if err != nil {
		t.Fatalf("upwork_get_job_details err: %v", err)
	}
	_ = detRes
	if seenDetailURL != "https://www.upwork.com/jobs/Fallback_~0555/" {
		t.Fatalf("expected fallback to job.URL, got %q", seenDetailURL)
	}

	// Negative max_jobs must return INVALID_PARAMS tool error
	negRes, negErr := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_get_job_details",
		Arguments: map[string]any{"url": "https://www.upwork.com/jobs/~0123/", "max_jobs": -1},
	})
	if negErr != nil || !negRes.IsError || !strings.Contains(toolErrorText(negRes), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS tool error for negative max_jobs, got res=%+v err=%v", negRes, negErr)
	}
}

func TestMCP_R5_ApprovalTokenDoesNotBypassAutoWithGuardrailsAndDraftNotHijacked(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)
	ctx := context.Background()

	var propSubmitCalls atomic.Int32
	var msgSendCalls atomic.Int32
	_, _ = startMockWSServerAndClient(t, backend, func(method string, params json.RawMessage) (any, *mockRPCError) {
		switch method {
		case "proposal.submit":
			propSubmitCalls.Add(1)
			return map[string]any{"submitted": true, "upwork_proposal_url": "https://www.upwork.com/nx/proposals/r5-1"}, nil
		case "messages.send":
			msgSendCalls.Add(1)
			return map[string]any{"sent": true}, nil
		default:
			return defaultMockHandler()(method, params)
		}
	})

	session := connectInMemoryClient(t, mcpSrv)
	gormDB := backend.DB().GetGorm()

	lowScore := 10
	connects := 8
	job := dbservice.Job{
		UpworkJobID:      strPtr("~0r5low10"),
		Title:            "Low Score Job",
		URL:              "https://www.upwork.com/jobs/~0r5low10/",
		CanonicalURL:     "https://www.upwork.com/jobs/~0r5low10/",
		Status:           "ready",
		Score:            &lowScore,
		ConnectsRequired: &connects,
	}
	if err := gormDB.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}

	draftPropRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_draft_proposal",
		Arguments: map[string]any{
			"job_id":       job.ID,
			"cover_letter": "MCP R5 guardrail bypass check",
			"bid_type":     "fixed",
			"bid_amount":   900,
		},
	})
	if err != nil || draftPropRes.IsError {
		t.Fatalf("draft proposal failed: %+v err=%v", draftPropRes, err)
	}
	propID := uint(parseToolJSON(t, draftPropRes)["proposal_id"].(float64))

	fillRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_fill_proposal_form",
		Arguments: map[string]any{"proposal_id": propID},
	})
	if err != nil || fillRes.IsError {
		t.Fatalf("fill proposal failed: %+v err=%v", fillRes, err)
	}
	propToken := parseToolJSON(t, fillRes)["approval_token"].(string)

	// Switch to auto_with_guardrails with auto_submit_proposals=false, auto_send_messages=false, min_job_score=90, quiet_hours=00:00-23:59, allowed_room_ids=["room_allowed"]
	autoMode := "auto_with_guardrails"
	autoFalse := false
	min90 := 90
	cap10 := 10
	cap100 := 100
	qh := "00:00-23:59"
	allowed := []string{"room_allowed"}
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{
		Mode:                &autoMode,
		AutoSubmitProposals: &autoFalse,
		AutoSendMessages:    &autoFalse,
		MinJobScore:         &min90,
		MaxProposalsPerDay:  &cap10,
		MaxConnectsPerDay:   &cap100,
		MaxMessagesPerDay:   &cap10,
		AllowedRoomIDs:      &allowed,
		QuietHours:          policy.NullableString{Set: true, Value: &qh},
	}, "test"); err != nil {
		t.Fatalf("policy update failed: %v", err)
	}

	// Passing fill's approval_token via MCP MUST NOT bypass auto_submit_proposals=false / quiet_hours / min_job_score
	subAttempt, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID, "approval_token": propToken},
	})
	if !subAttempt.IsError || propSubmitCalls.Load() != 0 {
		t.Fatalf("expected MCP submit with approval_token to be blocked under auto_with_guardrails, got %+v rpcs=%d", subAttempt, propSubmitCalls.Load())
	}

	// Now enable auto_submit_proposals=true (quiet_hours & min_job_score still violated) -> still blocked
	autoTrue := true
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{AutoSubmitProposals: &autoTrue}, "test"); err != nil {
		t.Fatalf("policy update failed: %v", err)
	}
	subAttempt2, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_submit_proposal",
		Arguments: map[string]any{"proposal_id": propID, "approval_token": propToken},
	})
	if !subAttempt2.IsError || !strings.Contains(toolErrorText(subAttempt2), "POLICY_BLOCKED") || propSubmitCalls.Load() != 0 {
		t.Fatalf("expected POLICY_BLOCKED (quiet_hours) even with approval_token, got %+v rpcs=%d", subAttempt2, propSubmitCalls.Load())
	}

	// Same for messages: draft in room_forbidden -> send with approval_token MUST NOT bypass auto_send_messages=false / quiet_hours / allowed_room_ids
	draftMsgRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_draft_message",
		Arguments: map[string]any{"room_id": "room_forbidden", "body": "Forbidden room draft"},
	})
	if err != nil || draftMsgRes.IsError {
		t.Fatalf("draft message failed: %+v err=%v", draftMsgRes, err)
	}
	msgToken := parseToolJSON(t, draftMsgRes)["approval_token"].(string)

	sendAttempt, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_send_message",
		Arguments: map[string]any{
			"room_id":        "room_forbidden",
			"approval_token": msgToken,
		},
	})
	if !sendAttempt.IsError || msgSendCalls.Load() != 0 {
		t.Fatalf("expected MCP send with approval_token to be blocked under auto_with_guardrails, got %+v rpcs=%d", sendAttempt, msgSendCalls.Load())
	}

	// Clear quiet_hours & enable auto_send_messages=true, room_forbidden still blocked even with approval_token
	if _, err := backend.PolicyEngine().Update(ctx, policy.UpdateInput{
		AutoSendMessages: &autoTrue,
		QuietHours:       policy.NullableString{Set: true, Value: nil},
	}, "test"); err != nil {
		t.Fatalf("policy update failed: %v", err)
	}
	sendAttempt2, _ := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_send_message",
		Arguments: map[string]any{
			"room_id":        "room_forbidden",
			"approval_token": msgToken,
		},
	})
	if !sendAttempt2.IsError || !strings.Contains(toolErrorText(sendAttempt2), "APPROVAL_REQUIRED") || msgSendCalls.Load() != 0 {
		t.Fatalf("expected APPROVAL_REQUIRED (allowed_room_ids) even with approval_token, got %+v rpcs=%d", sendAttempt2, msgSendCalls.Load())
	}

	// UI human approval (humanApproved=true) STILL succeeds for both proposal and message
	if _, err := backend.CommitProposal(ctx, uint64(propID), server.CommitProposalInput{}, true); err != nil {
		t.Fatalf("expected UI humanApproved CommitProposal to succeed, got %v", err)
	}
	if propSubmitCalls.Load() != 1 {
		t.Fatalf("expected 1 proposal.submit RPC after human approve, got %d", propSubmitCalls.Load())
	}

	// Draft in room_allowed, then tokenless upwork_send_message must NOT overwrite the pending_approval draft
	allowedDraftRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_draft_message",
		Arguments: map[string]any{"room_id": "room_allowed", "body": "Queued human draft in allowed room"},
	})
	if err != nil || allowedDraftRes.IsError {
		t.Fatalf("draft allowed message failed: %+v err=%v", allowedDraftRes, err)
	}
	allowedDraftID := uint(parseToolJSON(t, allowedDraftRes)["message"].(map[string]any)["id"].(float64))

	autoSendRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_send_message",
		Arguments: map[string]any{"room_id": "room_allowed", "body": "Separate autonomous message"},
	})
	if err != nil || autoSendRes.IsError {
		t.Fatalf("autonomous send failed: %+v err=%v", autoSendRes, err)
	}
	sentID := uint(parseToolJSON(t, autoSendRes)["message"].(map[string]any)["id"].(float64))
	if sentID == allowedDraftID {
		t.Fatalf("expected autonomous send not to hijack pending_approval draft #%d", allowedDraftID)
	}
	var checkDraft dbservice.Message
	if err := gormDB.First(&checkDraft, allowedDraftID).Error; err != nil {
		t.Fatalf("load draft: %v", err)
	}
	if checkDraft.Status != "pending_approval" || checkDraft.Body != "Queued human draft in allowed room" {
		t.Fatalf("expected pending_approval draft preserved, got status=%q body=%q", checkDraft.Status, checkDraft.Body)
	}
}

func strPtr(s string) *string { return &s }

func TestMCP_Unit_CompactProjectionAndToolRegistration(t *testing.T) {
	backend := server.NewServerWithDeps(server.ServerDeps{
		Host: "127.0.0.1",
		Port: 0,
	})
	t.Cleanup(func() { _ = backend.Close() })

	mcpSrv := NewServer(backend)
	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	toolsRes, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("ListTools failed: %v", err)
	}
	expectedTools := map[string]bool{
		"upwork_session_status":          true,
		"upwork_audit_selectors":         true,
		"upwork_list_tabs":               true,
		"upwork_capture_ui_diagnostic":   true,
		"upwork_get_ui_diagnostic":       true,
		"upwork_test_selector_patch":     true,
		"upwork_apply_selector_patch":    true,
		"upwork_search_jobs":             true,
		"upwork_get_job_details":         true,
		"upwork_list_saved_jobs":         true,
		"upwork_analyze_job":             true,
		"upwork_manage_search_profiles":  true,
		"upwork_draft_proposal":          true,
		"upwork_fill_proposal_form":      true,
		"upwork_submit_proposal":         true,
		"upwork_sync_proposals":          true,
		"upwork_list_conversations":      true,
		"upwork_get_conversation":        true,
		"upwork_draft_message":           true,
		"upwork_send_message":            true,
		"upwork_profile":                 true,
		"upwork_generate_project_agents": true,
		"upwork_active_projects":         true,
		"upwork_save_jobs":               true,
		"upwork_enrich_jobs":             true,
		"upwork_enrichment_batches":      true,
		"upwork_manage_watchers":         true,
		"upwork_run_watcher":             true,
		"upwork_watcher_events":          true,
		"upwork_configure_notifications": true,
	}
	if len(toolsRes.Tools) != len(expectedTools) {
		t.Fatalf("expected %d tools, got %d", len(expectedTools), len(toolsRes.Tools))
	}
	for _, tool := range toolsRes.Tools {
		if !expectedTools[tool.Name] {
			t.Fatalf("unexpected tool %q", tool.Name)
		}
		if tool.InputSchema == nil {
			t.Fatalf("tool %q missing InputSchema", tool.Name)
		}
	}

	resList, err := session.ListResources(ctx, &mcp.ListResourcesParams{})
	if err != nil {
		t.Fatalf("ListResources failed: %v", err)
	}
	expectedURIs := map[string]bool{
		"upwork://profile":                    true,
		"upwork://jobs/hot":                   true,
		"upwork://proposals/pending-approval": true,
		"upwork://proposals/active":           true,
		"upwork://messages/unread":            true,
		"upwork://selectors/health":           true,
		"upwork://diagnostics/latest":         true,
		"upwork://projects/active":            true,
		"upwork://jobs/search-runs":           true,
		"upwork://jobs/enrichment-batches":    true,
	}
	if len(resList.Resources) != len(expectedURIs) {
		t.Fatalf("expected %d resources, got %d", len(expectedURIs), len(resList.Resources))
	}
	for _, r := range resList.Resources {
		if !expectedURIs[r.URI] {
			t.Fatalf("unexpected resource URI %q", r.URI)
		}
	}

	// Verify compact projection truncates description < 200 chars and omits heavy JSONB/AI prose.
	scoreVal := 88
	tokensVal := 850
	runID := uint(14)
	enrichedAt := "2026-11-21T03:00:00Z"
	longDesc := strings.Repeat("Go PostgreSQL Playwright backend architecture ", 12)
	compacted := toCompactJobEntries([]server.JobEntry{
		{
			ID:                  42,
			UpworkJobID:         "~0991234567890",
			JobTitle:            "Compact Projection Check",
			JobDescription:      longDesc,
			ContractType:        "hourly",
			RateRange:           "$90-$120/hr",
			Skills:              "Go, PostgreSQL",
			Score:               &scoreVal,
			FitLabel:            "hot",
			AIEnrichmentStatus:  "completed",
			AIEnrichedAt:        &enrichedAt,
			AIModel:             "gemini-pro-orchestrator-neon",
			AIEffort:            "medium",
			AITokensUsed:        &tokensVal,
			LastSearchRunID:     &runID,
			ScoreBreakdown:      json.RawMessage(`{"skills":40}`),
			ScoreReasoning:      "Long reasoning text",
			Qualifications:      json.RawMessage(`{"location":"US"}`),
			ScreeningQuestions:  json.RawMessage(`[{"prompt":"Q1"}]`),
			Attachments:         json.RawMessage(`[{"name":"spec.pdf"}]`),
			ClientActivity:      json.RawMessage(`{"hires":12}`),
			Proposal:            "Full cover letter",
			ProposalSubject:     "Subject",
			ProposalTone:        "Direct",
			ProposalJSON:        json.RawMessage(`{"draft":"text"}`),
			PortfolioReferences: json.RawMessage(`[{"title":"Ref"}]`),
			TimeEstimate:        "2 weeks",
			WorkloadDivision:    "Backend",
			QuestionsForClient:  "Q?",
			TipsAndAdvice:       "Tip",
			ExecutionPrompt:     "Prompt",
			ToneAnalysis:        "Tone",
			CreatedAt:           "2026-11-21T02:00:00Z",
		},
	})
	if len(compacted) != 1 {
		t.Fatalf("expected 1 compact entry, got %d", len(compacted))
	}
	rawBytes, err := json.Marshal(compacted[0])
	if err != nil {
		t.Fatalf("marshal compact entry: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(rawBytes, &decoded); err != nil {
		t.Fatalf("unmarshal compact entry: %v", err)
	}
	desc, _ := decoded["job_description"].(string)
	if len([]rune(desc)) >= 200 || !strings.HasSuffix(desc, "...") {
		t.Fatalf("expected truncated description < 200 chars with ..., got len=%d (%q)", len([]rune(desc)), desc)
	}
	for _, omitted := range []string{
		"score_breakdown", "score_reasoning", "qualifications", "screening_questions",
		"attachments", "client_activity", "proposal", "proposal_subject", "proposal_tone",
		"proposal_json", "portfolio_references", "time_estimate", "workload_division",
		"questions_for_client", "tips_and_advice", "execution_prompt", "tone_analysis",
	} {
		if _, exists := decoded[omitted]; exists {
			t.Fatalf("expected heavy field %q to be omitted in compact entry", omitted)
		}
	}
	for _, retained := range []string{
		"id", "upwork_job_id", "job_title", "job_description", "contract_type",
		"rate_range", "skills", "score", "fit_label", "ai_enrichment_status",
		"ai_enriched_at", "ai_model", "ai_effort", "ai_tokens_used", "last_search_run_id",
	} {
		if _, exists := decoded[retained]; !exists {
			t.Fatalf("expected retained field %q in compact entry", retained)
		}
	}

	// Verify INVALID_PARAMS guards without DB
	emptySaveRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_save_jobs",
		Arguments: map[string]any{"jobs": []any{}},
	})
	if err != nil || !emptySaveRes.IsError || !strings.Contains(toolErrorText(emptySaveRes), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS on empty upwork_save_jobs, got res=%+v err=%v", emptySaveRes, err)
	}

	badBatchAction, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_enrichment_batches",
		Arguments: map[string]any{"action": "bogus"},
	})
	if err != nil || !badBatchAction.IsError || !strings.Contains(toolErrorText(badBatchAction), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS on invalid batch action, got res=%+v err=%v", badBatchAction, err)
	}

	missingBatchID, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_enrichment_batches",
		Arguments: map[string]any{"action": "get"},
	})
	if err != nil || !missingBatchID.IsError || !strings.Contains(toolErrorText(missingBatchID), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS on missing batch_id, got res=%+v err=%v", missingBatchID, err)
	}
}

func TestMCP_M5_SearchSaveEnrichAndBatches(t *testing.T) {
	backend, mcpSrv := setupTestMCPServer(t)

	// Clear ambient LLM / enrichment env so test is completely hermetic.
	t.Setenv("OLLAMA_HOST", "")
	t.Setenv("OLLAMA_API_KEY", "")
	t.Setenv("AGY_API_KEY", "")
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "")
	t.Setenv("ENRICHMENT_DEFAULT_MODE", "")
	t.Setenv("ENRICHMENT_DEFAULT_FORCE", "")
	t.Setenv("ENRICHMENT_SKIP_DETAIL_IF_PRESENT", "")
	t.Setenv("ENRICHMENT_REQUIRE_DETAILS", "")
	t.Setenv("ENRICHMENT_MAX_CONCURRENCY", "")
	t.Setenv("ENRICHMENT_DEFAULT_MODEL", "")
	t.Setenv("ENRICHMENT_DEFAULT_EFFORT", "")
	t.Setenv("WEB_UI_ENABLED", "true")

	var llmCalls atomic.Int32
	var llmDelayMs atomic.Int64
	var lastLLMPrompt atomic.Value
	mockLLM := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model    string `json:"model"`
			Effort   string `json:"effort"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var promptParts []string
		for _, m := range body.Messages {
			promptParts = append(promptParts, m.Content)
		}
		lastLLMPrompt.Store(strings.Join(promptParts, "\n"))
		llmCalls.Add(1)

		if d := llmDelayMs.Load(); d > 0 {
			time.Sleep(time.Duration(d) * time.Millisecond)
		}

		model := body.Model
		if model == "" {
			model = "gemini-pro-orchestrator-neon"
		}
		effort := body.Effort
		if effort == "" {
			effort = "medium"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{
			"model": %q,
			"applied_effort": %q,
			"usage": {"inputTokens": 400, "outputTokens": 250, "thoughtTokens": 50, "totalTokens": 700},
			"message": {"role": "assistant", "content": "{\"proposal\":\"Tailored Go & PostgreSQL proposal\",\"execution_prompt\":\"Build and verify\",\"time_estimate\":\"1-2 weeks\",\"workload_division\":\"Backend 70%% / QA 30%%\",\"questions_for_client\":[\"Any staging DB?\"],\"tips_and_advice\":[\"Highlight Postgres migrations\"],\"tone_analysis\":\"Direct\"}"}
		}`, model, effort)
	}))
	defer mockLLM.Close()

	t.Setenv("LLM_PROVIDER", "agy")
	t.Setenv("AGY_ENDPOINT_URL", mockLLM.URL)

	var searchRPCQueries []string
	var searchRPCMu sync.Mutex
	var detailCalls atomic.Int32
	longCardDesc := strings.Repeat("Build scalable Go microservices and PostgreSQL pipelines with strict Playwright E2E coverage. ", 5)

	_, _ = startMockWSServerAndClient(t, backend, func(method string, params json.RawMessage) (any, *mockRPCError) {
		switch method {
		case "jobs.search":
			searchRPCMu.Lock()
			searchRPCQueries = append(searchRPCQueries, string(params))
			searchRPCMu.Unlock()
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"jobs": []map[string]any{
					{
						"upwork_job_id":    "~0550000000000000001",
						"job_title":        "Hourly Go & PostgreSQL Architect",
						"job_description":  longCardDesc,
						"url":              "https://www.upwork.com/jobs/~0550000000000000001/",
						"contract_type":    "hourly",
						"rate_range":       "$90.00 - $125.00/hr",
						"skills":           []string{"Go", "PostgreSQL"},
						"payment_verified": true,
						"proposals_count":  4,
						"source_query":     "Go",
						"score_breakdown":  map[string]any{"skills": 45},
						"qualifications":   map[string]any{"location": "United States"},
					},
					{
						"upwork_job_id":    "~0550000000000000002",
						"job_title":        "Low-Rate Unverified Gig",
						"job_description":  "Cheap quick fix.",
						"url":              "https://www.upwork.com/jobs/~0550000000000000002/",
						"contract_type":    "hourly",
						"rate_range":       "$15.00 - $20.00/hr",
						"skills":           []string{"PHP"},
						"payment_verified": false,
						"proposals_count":  25,
					},
				},
			}, nil
		case "jobs.detail":
			detailCalls.Add(1)
			var p struct {
				URL         string `json:"url"`
				UpworkJobID string `json:"upwork_job_id"`
			}
			_ = json.Unmarshal(params, &p)
			uid := p.UpworkJobID
			if uid == "" {
				uid = "~0550000000000000001"
			}
			return map[string]any{
				"ok":             true,
				"stopped_reason": "completed",
				"job": map[string]any{
					"upwork_job_id":     uid,
					"job_title":         "Hourly Go & PostgreSQL Architect",
					"job_description":   "Full detailed description mentioning Core Web Vitals and 30+ hrs/week.",
					"url":               fmt.Sprintf("https://www.upwork.com/jobs/%s/", uid),
					"contract_type":     "hourly",
					"rate_range":        "$90.00 - $125.00/hr",
					"skills":            []string{"Go", "PostgreSQL"},
					"payment_verified":  true,
					"hours_per_week":    "30+ hrs/week",
					"duration":          "3 to 6 months",
					"connects_required": 10,
					"screening_questions": []map[string]any{
						{"index": 0, "prompt": "Describe your Go concurrency experience", "required": true},
					},
				},
			}, nil
		default:
			return defaultMockHandler()(method, params)
		}
	})

	session := connectInMemoryClient(t, mcpSrv)
	ctx := context.Background()

	// Seed profile & NDA active projects
	targetRate := 95.0
	if _, err := backend.SaveProfile(ctx, server.SaveProfileInput{
		Description: "Senior Go & PostgreSQL architect.",
		Skills: server.FlexibleSkills{
			Text:  "Go, PostgreSQL, TypeScript",
			Slice: []string{"Go", "PostgreSQL", "TypeScript"},
			Set:   true,
		},
		TargetRate: &targetRate,
	}); err != nil {
		t.Fatalf("SaveProfile failed: %v", err)
	}
	if _, err := backend.SyncActiveProjects(ctx, server.SyncActiveProjectsRequest{
		Projects: []server.SyncActiveProjectItem{
			{
				ProjectKey:         "edfx/nda-go-core",
				Slug:               "nda-go-core",
				Name:               "TopSecretClientPortal",
				Client:             "SecretClientCorp",
				GroupName:          "confidential-group",
				Path:               "/srv/nda/secret-client-path",
				ActivityTier:       "active",
				Status:             "active",
				ProposalVisibility: "anonymized",
				PublicAlias:        "Enterprise Go Platform",
				TechStack:          []string{"Go", "PostgreSQL"},
				Summary:            "Confidential proprietary summary.",
			},
			{
				ProjectKey:         "edfx/private-vault",
				Slug:               "private-vault",
				Name:               "PrivateVaultApp",
				Client:             "PrivateVaultCorp",
				ActivityTier:       "active",
				Status:             "active",
				ProposalVisibility: "private",
				TechStack:          []string{"PrivateOnlyStack"},
				Summary:            "Strictly private.",
			},
		},
	}); err != nil {
		t.Fatalf("SyncActiveProjects failed: %v", err)
	}

	// 1. upwork_search_jobs with 0 LLM tokens, skip_auto_detail_enrich, hourly_rate_min, payment_verified_only, compact=true
	searchRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_search_jobs",
		Arguments: map[string]any{
			"source":                  "search",
			"query":                   "Go",
			"max_pages":               1,
			"hourly_rate_min":         70,
			"payment_verified_only":   true,
			"skip_auto_detail_enrich": true,
			"run_label":               "m5-zero-token-go",
			"compact":                 true,
		},
	})
	if err != nil || searchRes.IsError {
		t.Fatalf("upwork_search_jobs failed: res=%+v err=%v", searchRes, err)
	}
	if llmCalls.Load() != 0 {
		t.Fatalf("expected 0 LLM calls during upwork_search_jobs, got %d", llmCalls.Load())
	}
	if detailCalls.Load() != 0 {
		t.Fatalf("expected 0 detail RPC calls with skip_auto_detail_enrich=true, got %d", detailCalls.Load())
	}
	searchJSON := parseToolJSON(t, searchRes)
	runIDFloat, ok := searchJSON["search_run_id"].(float64)
	if !ok || runIDFloat <= 0 {
		t.Fatalf("expected search_run_id > 0, got %+v", searchJSON["search_run_id"])
	}
	searchRunID := uint(runIDFloat)
	dashURL, _ := searchJSON["dashboard_url"].(string)
	if !strings.Contains(dashURL, "/dashboard/") || !strings.Contains(dashURL, "ticket=") {
		t.Fatalf("expected dashboard_url with /dashboard/ and ticket=, got %q", dashURL)
	}
	searchJobsSlice, _ := searchJSON["jobs"].([]any)
	if len(searchJobsSlice) != 1 {
		t.Fatalf("expected 1 surviving job after hourly/payment filter, got %d (%+v)", len(searchJobsSlice), searchJobsSlice)
	}
	firstSearchJob := searchJobsSlice[0].(map[string]any)
	if desc, _ := firstSearchJob["job_description"].(string); len([]rune(desc)) >= 200 {
		t.Fatalf("expected compact job_description < 200 chars, got %d", len([]rune(desc)))
	}
	for _, omitted := range []string{"score_breakdown", "qualifications", "screening_questions", "attachments"} {
		if _, exists := firstSearchJob[omitted]; exists {
			t.Fatalf("expected %q omitted in compact upwork_search_jobs output", omitted)
		}
	}

	// 2. upwork_search_jobs with from_active_projects=true (NDA-safe verification)
	searchRPCMu.Lock()
	searchRPCQueries = nil
	searchRPCMu.Unlock()

	ndaSearchRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_search_jobs",
		Arguments: map[string]any{
			"from_active_projects":    true,
			"skip_auto_detail_enrich": true,
			"run_label":               "m5-nda-seeded",
			"compact":                 true,
		},
	})
	if err != nil || ndaSearchRes.IsError {
		t.Fatalf("upwork_search_jobs(from_active_projects) failed: res=%+v err=%v", ndaSearchRes, err)
	}
	searchRPCMu.Lock()
	joinedRPC := strings.ToLower(strings.Join(searchRPCQueries, "\n"))
	searchRPCMu.Unlock()
	if !strings.Contains(joinedRPC, "go") && !strings.Contains(joinedRPC, "postgresql") {
		t.Fatalf("expected active project tech_stack queries in jobs.search RPC, got %q", joinedRPC)
	}
	for _, forbidden := range []string{
		"edfx/nda-go-core", "edfx/private-vault", "topsecretclientportal",
		"secretclientcorp", "confidential-group", "/srv/nda/secret-client-path",
		"enterprise go platform", "confidential proprietary summary",
		"privateonlystack", "privatevaultapp", "privatevaultcorp",
	} {
		if strings.Contains(joinedRPC, forbidden) {
			t.Fatalf("NDA leakage detected (%q) in jobs.search RPC: %s", forbidden, joinedRPC)
		}
	}

	// 3. upwork_list_saved_jobs with new filters + dashboard_url + WEB_UI_ENABLED=false omission
	listRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_list_saved_jobs",
		Arguments: map[string]any{
			"search_run_id":     searchRunID,
			"contract_type":     "hourly",
			"hourly_rate_min":   70,
			"enrichment_status": "none",
			"matched_project":   "Enterprise Go Platform",
			"sort":              "enriched_desc",
			"compact":           true,
		},
	})
	if err != nil || listRes.IsError {
		t.Fatalf("upwork_list_saved_jobs failed: res=%+v err=%v", listRes, err)
	}
	listJSON := parseToolJSON(t, listRes)
	if total, _ := listJSON["total"].(float64); total != 1 {
		t.Fatalf("expected total=1, got %+v", listJSON["total"])
	}
	listDashURL, _ := listJSON["dashboard_url"].(string)
	if !strings.Contains(listDashURL, "/dashboard/") || !strings.Contains(listDashURL, "run=") || !strings.Contains(listDashURL, "ticket=") {
		t.Fatalf("expected dashboard_url with run= and ticket=, got %q", listDashURL)
	}

	t.Setenv("WEB_UI_ENABLED", "false")
	listNoWebRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_saved_jobs",
		Arguments: map[string]any{"search_run_id": searchRunID, "compact": true},
	})
	if err != nil || listNoWebRes.IsError {
		t.Fatalf("upwork_list_saved_jobs(WEB_UI_ENABLED=false) failed: res=%+v err=%v", listNoWebRes, err)
	}
	listNoWebJSON := parseToolJSON(t, listNoWebRes)
	if _, hasDash := listNoWebJSON["dashboard_url"]; hasDash {
		t.Fatalf("expected dashboard_url omitted when WEB_UI_ENABLED=false, got %+v", listNoWebJSON["dashboard_url"])
	}
	t.Setenv("WEB_UI_ENABLED", "true")

	// 4. upwork_analyze_job with ensure_details=true + use_llm=true
	analyzeRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_analyze_job",
		Arguments: map[string]any{
			"job_id":         "~0550000000000000001",
			"ensure_details": true,
			"use_llm":        true,
		},
	})
	if err != nil || analyzeRes.IsError {
		t.Fatalf("upwork_analyze_job failed: res=%+v err=%v", analyzeRes, err)
	}
	if detailCalls.Load() != 1 || llmCalls.Load() != 1 {
		t.Fatalf("expected 1 detail call and 1 LLM call, got detail=%d llm=%d", detailCalls.Load(), llmCalls.Load())
	}
	promptStr, _ := lastLLMPrompt.Load().(string)
	if !strings.Contains(promptStr, "30+ hrs/week") {
		t.Fatalf("expected detail signals injected into LLM prompt, got %q", promptStr)
	}
	analyzeJSON := parseToolJSON(t, analyzeRes)
	analyzedJob := analyzeJSON["job"].(map[string]any)
	if analyzedJob["ai_enrichment_status"] != "completed" {
		t.Fatalf("expected ai_enrichment_status=completed, got %+v", analyzedJob["ai_enrichment_status"])
	}
	if analyzeJSON["ai_model"] == "" || analyzeJSON["ai_effort"] == "" || analyzeJSON["ai_enriched_at"] == "" {
		t.Fatalf("expected ai_model, ai_effort, ai_enriched_at on analyze response: %+v", analyzeJSON)
	}
	usageMap, _ := analyzeJSON["usage"].(map[string]any)
	if totalTok, _ := usageMap["total_tokens"].(float64); totalTok <= 0 {
		t.Fatalf("expected usage.total_tokens > 0, got %+v", usageMap)
	}

	// Verify has_ai_analysis=true filter on upwork_list_saved_jobs
	hasAI := true
	aiListRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_list_saved_jobs",
		Arguments: map[string]any{
			"has_ai_analysis":   hasAI,
			"enrichment_status": "completed",
			"compact":           true,
		},
	})
	if err != nil || aiListRes.IsError {
		t.Fatalf("upwork_list_saved_jobs(has_ai_analysis) failed: res=%+v err=%v", aiListRes, err)
	}
	if total, _ := parseToolJSON(t, aiListRes)["total"].(float64); total != 1 {
		t.Fatalf("expected 1 AI-analyzed job, got %+v", parseToolJSON(t, aiListRes))
	}

	// 5. upwork_save_jobs (dedup + sort_by_score + compact + 0 LLM tokens + INVALID_PARAMS on malformed JSONB)
	saveRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_save_jobs",
		Arguments: map[string]any{
			"run_label":     "m5-curated-save",
			"source":        "curated",
			"sort_by_score": true,
			"compact":       true,
			"jobs": []map[string]any{
				{
					"upwork_job_id":    "~0660000000000000001",
					"job_title":        "Curated Go & PostgreSQL Backend",
					"job_description":  longCardDesc,
					"url":              "https://www.upwork.com/jobs/~0660000000000000001/",
					"contract_type":    "fixed",
					"budget_amount":    "$2,000.00",
					"skills":           []string{"Go", "PostgreSQL"},
					"payment_verified": true,
				},
				{
					"upwork_job_id":    "~0660000000000000002",
					"job_title":        "Curated TypeScript QA",
					"job_description":  "TypeScript and Playwright test suite.",
					"url":              "https://www.upwork.com/jobs/~0660000000000000002/",
					"contract_type":    "hourly",
					"rate_range":       "$90.00/hr",
					"skills":           []string{"TypeScript", "Playwright"},
					"payment_verified": true,
				},
				{
					"upwork_job_id":   "~0660000000000000001",
					"job_title":       "Curated Go & PostgreSQL Backend (dup)",
					"job_description": "Duplicate job in same batch.",
					"url":             "https://www.upwork.com/jobs/~0660000000000000001/",
				},
			},
		},
	})
	if err != nil || saveRes.IsError {
		t.Fatalf("upwork_save_jobs failed: res=%+v err=%v", saveRes, err)
	}
	if llmCalls.Load() != 1 {
		t.Fatalf("expected upwork_save_jobs to spend 0 extra LLM calls, got %d", llmCalls.Load())
	}
	saveJSON := parseToolJSON(t, saveRes)
	if saveJSON["total_received"] != float64(3) || saveJSON["deduplicated_count"] != float64(2) || saveJSON["persisted_count"] != float64(2) {
		t.Fatalf("unexpected upwork_save_jobs counts: %+v", saveJSON)
	}
	if srID, _ := saveJSON["search_run_id"].(float64); srID <= 0 {
		t.Fatalf("expected search_run_id > 0 from upwork_save_jobs, got %+v", saveJSON["search_run_id"])
	}
	if savedSlice, _ := saveJSON["jobs"].([]any); len(savedSlice) != 2 {
		t.Fatalf("expected 2 saved jobs, got %d", len(savedSlice))
	} else {
		firstSaved := savedSlice[0].(map[string]any)
		if d, _ := firstSaved["job_description"].(string); len([]rune(d)) >= 200 {
			t.Fatalf("expected compact saved description < 200 chars, got %d", len([]rune(d)))
		}
	}

	badJSONSaveRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_save_jobs",
		Arguments: map[string]any{
			"jobs": []map[string]any{
				{
					"upwork_job_id": "~0660000000000000099",
					"job_title":     "Invalid JSONB Job",
					"url":           "https://www.upwork.com/jobs/~0660000000000000099/",
					"proposal_json": "{bad-json",
				},
			},
		},
	})
	if err != nil || !badJSONSaveRes.IsError || !strings.Contains(toolErrorText(badJSONSaveRes), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS on malformed proposal_json, got res=%+v err=%v", badJSONSaveRes, err)
	}

	// 6. upwork_enrich_jobs: force=false skip-cached vs force=true + ENRICHMENT_MAX_BATCH_SIZE cap
	enrichSkipRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrich_jobs",
		Arguments: map[string]any{
			"job_ids": []any{"~0550000000000000001", "~0660000000000000001"},
			"mode":    "full",
			"force":   false,
			"wait":    true,
		},
	})
	if err != nil || enrichSkipRes.IsError {
		t.Fatalf("upwork_enrich_jobs(force=false) failed: res=%+v err=%v", enrichSkipRes, err)
	}
	skipBatch := parseToolJSON(t, enrichSkipRes)["batch"].(map[string]any)
	if skipBatch["status"] != "completed" || skipBatch["skipped_count"] != float64(1) || skipBatch["completed_count"] != float64(1) {
		t.Fatalf("unexpected force=false batch summary: %+v", skipBatch)
	}
	if llmCalls.Load() != 2 {
		t.Fatalf("expected 1 additional LLM call (total 2) with force=false, got %d", llmCalls.Load())
	}

	enrichForceRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrich_jobs",
		Arguments: map[string]any{
			"job_ids": []any{"~0550000000000000001"},
			"mode":    "ai_only",
			"force":   true,
			"wait":    true,
		},
	})
	if err != nil || enrichForceRes.IsError {
		t.Fatalf("upwork_enrich_jobs(force=true) failed: res=%+v err=%v", enrichForceRes, err)
	}
	forceBatch := parseToolJSON(t, enrichForceRes)["batch"].(map[string]any)
	if forceBatch["skipped_count"] != float64(0) || forceBatch["completed_count"] != float64(1) || llmCalls.Load() != 3 {
		t.Fatalf("unexpected force=true batch summary: %+v llmCalls=%d", forceBatch, llmCalls.Load())
	}

	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "2")
	capErrRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrich_jobs",
		Arguments: map[string]any{
			"job_ids": []any{"~0550000000000000001", "~0660000000000000001", "~0660000000000000002"},
			"mode":    "ai_only",
		},
	})
	if err != nil || !capErrRes.IsError || !strings.Contains(toolErrorText(capErrRes), "INVALID_PARAMS") {
		t.Fatalf("expected INVALID_PARAMS when exceeding ENRICHMENT_MAX_BATCH_SIZE, got res=%+v err=%v", capErrRes, err)
	}
	t.Setenv("ENRICHMENT_MAX_BATCH_SIZE", "25")

	// 7. Async upwork_enrich_jobs + upwork_enrichment_batches (cancel, get, list)
	llmDelayMs.Store(350)
	asyncRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrich_jobs",
		Arguments: map[string]any{
			"job_ids":         []any{"~0550000000000000001", "~0660000000000000001", "~0660000000000000002"},
			"mode":            "ai_only",
			"force":           true,
			"max_concurrency": 1,
			"wait":            false,
		},
	})
	if err != nil || asyncRes.IsError {
		t.Fatalf("async upwork_enrich_jobs failed: res=%+v err=%v", asyncRes, err)
	}
	asyncBatch := parseToolJSON(t, asyncRes)["batch"].(map[string]any)
	asyncBatchID := uint(asyncBatch["id"].(float64))
	if asyncBatchID == 0 {
		t.Fatalf("expected async batch id > 0, got %+v", asyncBatch)
	}

	cancelRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrichment_batches",
		Arguments: map[string]any{
			"action":   "cancel",
			"batch_id": asyncBatchID,
		},
	})
	if err != nil || cancelRes.IsError {
		t.Fatalf("upwork_enrichment_batches(cancel) failed: res=%+v err=%v", cancelRes, err)
	}
	cancelBatch := parseToolJSON(t, cancelRes)["batch"].(map[string]any)
	if cancelBatch["status"] != "canceled" && cancelBatch["canceled_count"].(float64) < 1 {
		t.Fatalf("expected canceled status or canceled items, got %+v", cancelBatch)
	}

	getRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrichment_batches",
		Arguments: map[string]any{
			"action":   "get",
			"batch_id": asyncBatchID,
		},
	})
	if err != nil || getRes.IsError {
		t.Fatalf("upwork_enrichment_batches(get) failed: res=%+v err=%v", getRes, err)
	}
	getBatch := parseToolJSON(t, getRes)["batch"].(map[string]any)
	if uint(getBatch["id"].(float64)) != asyncBatchID {
		t.Fatalf("expected batch %d, got %+v", asyncBatchID, getBatch)
	}

	listBatchRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name: "upwork_enrichment_batches",
		Arguments: map[string]any{
			"action": "list",
		},
	})
	if err != nil || listBatchRes.IsError {
		t.Fatalf("upwork_enrichment_batches(list) failed: res=%+v err=%v", listBatchRes, err)
	}
	listBatchJSON := parseToolJSON(t, listBatchRes)
	if total, _ := listBatchJSON["total"].(float64); total < 3 {
		t.Fatalf("expected >= 3 enrichment batches, got %+v", listBatchJSON)
	}

	// 8. Verify new resources: upwork://jobs/search-runs and upwork://jobs/enrichment-batches
	runsRR, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: "upwork://jobs/search-runs"})
	if err != nil || len(runsRR.Contents) == 0 {
		t.Fatalf("ReadResource(upwork://jobs/search-runs) failed: %v", err)
	}
	runsText := runsRR.Contents[0].Text
	if !strings.Contains(runsText, "m5-zero-token-go") || !strings.Contains(runsText, "m5-nda-seeded") || !strings.Contains(runsText, "m5-curated-save") {
		t.Fatalf("expected search run labels in upwork://jobs/search-runs, got %s", runsText)
	}

	batchesRR, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: "upwork://jobs/enrichment-batches"})
	if err != nil || len(batchesRR.Contents) == 0 {
		t.Fatalf("ReadResource(upwork://jobs/enrichment-batches) failed: %v", err)
	}
	if !strings.Contains(batchesRR.Contents[0].Text, fmt.Sprintf(`"id":%d`, asyncBatchID)) {
		t.Fatalf("expected batch %d in upwork://jobs/enrichment-batches, got %s", asyncBatchID, batchesRR.Contents[0].Text)
	}

	// 9. Adversarial boundary regressions: ID overflow, float truncation, empty save job {}, and limit <= 0
	for _, badID := range []any{"0", "9223372036854775808", "18446744073709551615", float64(18446744073709551615), float64(1.5), float64(0)} {
		detErrRes, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_get_job_details",
			Arguments: map[string]any{"job_id": badID},
		})
		if err != nil || !detErrRes.IsError || !strings.Contains(toolErrorText(detErrRes), "INVALID_PARAMS") {
			t.Fatalf("upwork_get_job_details(%#v) expected INVALID_PARAMS, got res=%+v err=%v", badID, detErrRes, err)
		}

		analyzeErrRes, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_analyze_job",
			Arguments: map[string]any{"job_id": badID, "use_llm": false},
		})
		if err != nil || !analyzeErrRes.IsError || !strings.Contains(toolErrorText(analyzeErrRes), "INVALID_PARAMS") {
			t.Fatalf("upwork_analyze_job(%#v) expected INVALID_PARAMS, got res=%+v err=%v", badID, analyzeErrRes, err)
		}
	}

	for _, action := range []string{"get", "cancel"} {
		for _, badBatchID := range []uint64{0, 9223372036854775808} {
			batchErrRes, err := session.CallTool(ctx, &mcp.CallToolParams{
				Name:      "upwork_enrichment_batches",
				Arguments: map[string]any{"action": action, "batch_id": badBatchID},
			})
			if err != nil || !batchErrRes.IsError || !strings.Contains(toolErrorText(batchErrRes), "INVALID_PARAMS") {
				t.Fatalf("upwork_enrichment_batches(%s, %d) expected INVALID_PARAMS, got res=%+v err=%v", action, badBatchID, batchErrRes, err)
			}
		}
	}

	for _, action := range []string{"delete", "run"} {
		for _, badProfID := range []uint64{0, 9223372036854775808} {
			profErrRes, err := session.CallTool(ctx, &mcp.CallToolParams{
				Name:      "upwork_manage_search_profiles",
				Arguments: map[string]any{"action": action, "id": badProfID},
			})
			if err != nil || !profErrRes.IsError || !strings.Contains(toolErrorText(profErrRes), "INVALID_PARAMS") {
				t.Fatalf("upwork_manage_search_profiles(%s, %d) expected INVALID_PARAMS, got res=%+v err=%v", action, badProfID, profErrRes, err)
			}
		}
	}

	emptyObjSaveRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_save_jobs",
		Arguments: map[string]any{"jobs": []map[string]any{{}}},
	})
	if err != nil || !emptyObjSaveRes.IsError || !strings.Contains(toolErrorText(emptyObjSaveRes), "INVALID_PARAMS") {
		t.Fatalf("upwork_save_jobs([{}]) expected INVALID_PARAMS, got res=%+v err=%v", emptyObjSaveRes, err)
	}

	for _, badLimit := range []int{0, -1, -50} {
		badLimitRes, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name:      "upwork_list_saved_jobs",
			Arguments: map[string]any{"limit": badLimit},
		})
		if err != nil || !badLimitRes.IsError || !strings.Contains(toolErrorText(badLimitRes), "INVALID_PARAMS") {
			t.Fatalf("upwork_list_saved_jobs(limit=%d) expected INVALID_PARAMS, got res=%+v err=%v", badLimit, badLimitRes, err)
		}
	}

	// Omitted limit continues to default cleanly
	omittedLimitRes, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "upwork_list_saved_jobs",
		Arguments: map[string]any{"compact": true},
	})
	if err != nil || omittedLimitRes.IsError {
		t.Fatalf("upwork_list_saved_jobs(omitted limit) failed: res=%+v err=%v", omittedLimitRes, err)
	}
}
