package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
)

func setupDiagnosticTestServer(t *testing.T) (*Server, string, string) {
	t.Helper()
	s := setupTestServer(t)

	repoYAML, err := os.ReadFile("../../configs/selectors/upwork.yaml")
	if err != nil {
		t.Fatalf("read repo selectors yaml: %v", err)
	}
	tmpDir := t.TempDir()
	tmpYAML := filepath.Join(tmpDir, "upwork.yaml")
	if err := os.WriteFile(tmpYAML, repoYAML, 0o644); err != nil {
		t.Fatalf("write isolated selectors yaml: %v", err)
	}
	diagDir := filepath.Join(tmpDir, "diagnostics")
	s.selectorsPath = tmpYAML
	s.diagnosticsDir = diagDir
	return s, tmpYAML, diagDir
}

func TestDiagnosticHandlers_FullCaptureDryRunApplyReloadAndRollbackLifecycle(t *testing.T) {
	s, tmpYAML, diagDir := setupDiagnosticTestServer(t)
	srv, _ := attachTestBridgeHub(t, s)

	var reloadCalls atomic.Int32
	var testPatchCalls atomic.Int32
	dialAuthenticatedMockExtension(t, srv, s.apiToken, func(method string, params json.RawMessage) (any, *bridge.WireRPCError) {
		switch method {
		case "diagnostics.capture":
			return map[string]any{
				"ok": true,
				"capture": map[string]any{
					"captured_at":      "2026-11-20T09:00:00Z",
					"url":              "https://www.upwork.com/jobs/~0212345/",
					"title":            "Go Architect - Upwork",
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
							"sample_items":       []string{"Go", "Playwright"},
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
									"sample_value":    []string{"Go", "Playwright"},
									"strategy":        "repetitive_pattern_leaf",
									"is_fragile":       false,
									"reason":          "Matched 2 nodes",
								},
							},
						},
					},
					"pruned_html": `<main><ul class="new-skill-chips"><li class="air3-skill-chip"><span>Go</span></li><li class="air3-skill-chip"><span>Playwright</span></li></ul></main>`,
				},
			}, nil
		case "diagnostics.test_patch":
			testPatchCalls.Add(1)
			return map[string]any{
				"ok":            true,
				"view":          "job_detail",
				"field":         "skills",
				"matched_count": 2,
				"sample_value":  []string{"Go", "Playwright"},
				"status":        "HEALTHY",
				"regressions":   []any{},
				"before_summary": map[string]any{
					"status":        "BROKEN",
					"matched_count": 0,
				},
				"after_summary": map[string]any{
					"status":           "HEALTHY",
					"matched_count":    2,
					"sample_value":     []string{"Go", "Playwright"},
					"matched_selector": ".air3-skill-chip span",
				},
			}, nil
		case "selectors.reload":
			reloadCalls.Add(1)
			return map[string]any{"ok": true, "reloaded": true}, nil
		default:
			return map[string]any{"ok": true}, nil
		}
	})

	router := s.RegisterRoutes()
	doReq := func(method, path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, path, &buf)
		req.Header.Set("Authorization", "Bearer "+s.apiToken)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}

	// 1. Capture diagnostic via live extension RPC
	capW := doReq(http.MethodPost, "/api/diagnostics/capture", map[string]any{
		"use_active_tab": true,
		"scope":          "drawer",
		"redact_pii":     true,
	})
	if capW.Code != http.StatusCreated {
		t.Fatalf("POST /api/diagnostics/capture = %d body=%s", capW.Code, capW.Body.String())
	}
	var capResp struct {
		OK         bool   `json:"ok"`
		CaptureUID string `json:"capture_uid"`
		Markdown   string `json:"markdown"`
		Artifacts  struct {
			MarkdownPath   string `json:"markdown_path"`
			PrunedHTMLPath string `json:"pruned_html_path"`
		} `json:"artifacts"`
	}
	if err := json.Unmarshal(capW.Body.Bytes(), &capResp); err != nil {
		t.Fatalf("decode capture response: %v", err)
	}
	if !capResp.OK || capResp.CaptureUID == "" || !strings.Contains(capResp.Markdown, "Skills and Expertise") {
		t.Fatalf("unexpected capture response: %+v", capResp)
	}
	if _, err := os.Stat(capResp.Artifacts.MarkdownPath); err != nil {
		t.Fatalf("expected markdown artifact on disk: %v", err)
	}

	// 2. List & Get by latest and capture_uid
	listW := doReq(http.MethodGet, "/api/diagnostics/captures?view_type=job_detail", nil)
	if listW.Code != http.StatusOK || !strings.Contains(listW.Body.String(), capResp.CaptureUID) {
		t.Fatalf("GET /api/diagnostics/captures = %d body=%s", listW.Code, listW.Body.String())
	}
	getW := doReq(http.MethodGet, "/api/diagnostics/captures/latest?include_html=true", nil)
	if getW.Code != http.StatusOK || !strings.Contains(getW.Body.String(), "new-skill-chips") {
		t.Fatalf("GET /api/diagnostics/captures/latest = %d body=%s", getW.Code, getW.Body.String())
	}

	// 3. Reject invalid/ambiguous patch view (e.g. "messages") and accept "search_results" normalization on test
	badPatchW := doReq(http.MethodPost, "/api/diagnostics/test-patch", map[string]any{
		"view":      "messages",
		"field":     "skills",
		"selectors": []string{".air3-skill-chip span"},
	})
	if badPatchW.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for ambiguous 'messages' patch view, got %d", badPatchW.Code)
	}

	// 4. Dry-run valid patch
	testW := doReq(http.MethodPost, "/api/diagnostics/test-patch", map[string]any{
		"view":       "job_detail",
		"field":      "skills",
		"selectors":  []string{".air3-skill-chip span"},
		"extract":    "list",
		"capture_id": capResp.CaptureUID,
	})
	if testW.Code != http.StatusOK {
		t.Fatalf("POST /api/diagnostics/test-patch = %d body=%s", testW.Code, testW.Body.String())
	}
	if !strings.Contains(testW.Body.String(), `"valid_yaml":true`) || !strings.Contains(testW.Body.String(), `"dom_tested":true`) {
		t.Fatalf("expected valid_yaml and dom_tested in test-patch response: %s", testW.Body.String())
	}
	if testPatchCalls.Load() != 1 {
		t.Fatalf("expected 1 WS diagnostics.test_patch call, got %d", testPatchCalls.Load())
	}

	// 5. Apply patch -> writes backup + bumps version + broadcasts selectors.reload + records ActionAuditLog
	applyW := doReq(http.MethodPost, "/api/diagnostics/apply-patch", map[string]any{
		"view":       "job_detail",
		"field":      "skills",
		"selectors":  []string{".air3-skill-chip span"},
		"extract":    "list",
		"reason":     "Heal broken skills",
		"capture_id": capResp.CaptureUID,
	})
	if applyW.Code != http.StatusOK {
		t.Fatalf("POST /api/diagnostics/apply-patch = %d body=%s", applyW.Code, applyW.Body.String())
	}
	var applyResp ApplySelectorPatchResponse
	if err := json.Unmarshal(applyW.Body.Bytes(), &applyResp); err != nil {
		t.Fatalf("decode apply-patch response: %v", err)
	}
	if !applyResp.ReloadedExtension || applyResp.NewVersion == "" || applyResp.NewVersion == applyResp.OldVersion {
		t.Fatalf("unexpected apply-patch response: %+v", applyResp)
	}
	if reloadCalls.Load() != 1 {
		t.Fatalf("expected 1 selectors.reload WS broadcast, got %d", reloadCalls.Load())
	}
	var auditCount int64
	_ = s.DB().GetGorm().Model(&dbservice.ActionAuditLog{}).Where("action_type = ?", "selector_patch_applied").Count(&auditCount).Error
	if auditCount != 1 {
		t.Fatalf("expected 1 selector_patch_applied audit log, got %d", auditCount)
	}

	// 6. Rollback -> restores v2.0 + broadcasts selectors.reload again
	rbW := doReq(http.MethodPost, "/api/diagnostics/rollback", map[string]any{})
	if rbW.Code != http.StatusOK {
		t.Fatalf("POST /api/diagnostics/rollback = %d body=%s", rbW.Code, rbW.Body.String())
	}
	var rbResp RollbackSelectorPatchResponse
	if err := json.Unmarshal(rbW.Body.Bytes(), &rbResp); err != nil || !rbResp.OK || rbResp.Version != applyResp.OldVersion {
		t.Fatalf("expected rollback to restore version %q, got %s (err=%v)", applyResp.OldVersion, rbW.Body.String(), err)
	}
	if reloadCalls.Load() != 2 {
		t.Fatalf("expected 2nd selectors.reload WS broadcast after rollback, got %d", reloadCalls.Load())
	}
	restoredYAML, err := os.ReadFile(tmpYAML)
	if err != nil {
		t.Fatalf("read tmpYAML: %v", err)
	}
	if strings.Contains(string(restoredYAML), ".air3-skill-chip span") {
		t.Fatalf("expected rollback to remove patched selector from tmpYAML")
	}

	// 7. Path containment guard against escaping BundleDir
	escapedDir := filepath.Join(t.TempDir(), "outside")
	_ = os.MkdirAll(escapedDir, 0o755)
	_ = os.WriteFile(filepath.Join(escapedDir, "snapshot.json"), []byte(`{}`), 0o644)
	badRow := dbservice.UIDiagnosticCapture{
		CaptureUID:    "cap_evil_traversal",
		ViewType:      "job_detail",
		PageURL:       "https://www.upwork.com/",
		OverallStatus: "BROKEN",
		BundleDir:     escapedDir,
	}
	if err := s.DB().GetGorm().Create(&badRow).Error; err != nil {
		t.Fatalf("insert traversal row: %v", err)
	}
	travW := doReq(http.MethodGet, "/api/diagnostics/captures/cap_evil_traversal", nil)
	if travW.Code != http.StatusForbidden {
		t.Fatalf("expected 403 Forbidden for BundleDir outside %s, got %d body=%s", diagDir, travW.Code, travW.Body.String())
	}
}
