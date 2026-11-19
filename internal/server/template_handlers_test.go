package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGeneratedAgentsCompositeKeyIsolation(t *testing.T) {
	s := &Server{}
	now := time.Now()

	// Two different templates sharing the same blueprint name, plus two formats
	laravelClaude := GeneratedAgent{
		FileName:      "eloquent-model-agent.md",
		BlueprintName: "eloquent-model-agent",
		Content:       "laravel claude content",
		TemplateName:  "laravel",
		Format:        "claude",
		GeneratedAt:   now,
	}
	laravelCopilot := GeneratedAgent{
		FileName:      "eloquent-model-agent.md",
		BlueprintName: "eloquent-model-agent",
		Content:       "laravel copilot content",
		TemplateName:  "laravel",
		Format:        "copilot",
		GeneratedAt:   now.Add(1 * time.Second),
	}
	apiClaude := GeneratedAgent{
		FileName:      "eloquent-model-agent.md",
		BlueprintName: "eloquent-model-agent",
		Content:       "api claude content",
		TemplateName:  "php-api",
		Format:        "claude",
		GeneratedAt:   now.Add(2 * time.Second),
	}

	s.generatedAgents.Store(agentStoreKey(laravelClaude.TemplateName, laravelClaude.BlueprintName, laravelClaude.Format), laravelClaude)
	s.generatedAgents.Store(agentStoreKey(laravelCopilot.TemplateName, laravelCopilot.BlueprintName, laravelCopilot.Format), laravelCopilot)
	s.generatedAgents.Store(agentStoreKey(apiClaude.TemplateName, apiClaude.BlueprintName, apiClaude.Format), apiClaude)

	// Verify listAgentsHandler returns all 3 without overwriting
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	w := httptest.NewRecorder()
	s.listAgentsHandler(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}

	var listBody struct {
		Agents []GeneratedAgent `json:"agents"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listBody); err != nil {
		t.Fatalf("failed to decode list response: %v", err)
	}
	if len(listBody.Agents) != 3 {
		t.Fatalf("expected 3 distinct agents in store, got %d", len(listBody.Agents))
	}

	// Verify exact lookup by template_name + format retrieves laravel/claude specifically
	dlPayload, _ := json.Marshal(downloadAgentsRequest{
		TemplateName: "laravel",
		Format:       "claude",
		AgentNames:   []string{"eloquent-model-agent"},
	})
	dlReq := httptest.NewRequest(http.MethodPost, "/api/agents/download", bytes.NewReader(dlPayload))
	dlReq.Header.Set("Content-Type", "application/json")
	dlW := httptest.NewRecorder()
	s.downloadAgentsHandler(dlW, dlReq)

	dlResp := dlW.Result()
	defer dlResp.Body.Close()
	if dlResp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", dlResp.StatusCode)
	}

	zr, err := zip.NewReader(bytes.NewReader(dlW.Body.Bytes()), int64(dlW.Body.Len()))
	if err != nil {
		t.Fatalf("failed to open zip: %v", err)
	}
	if len(zr.File) != 1 {
		t.Fatalf("expected 1 zip entry, got %d", len(zr.File))
	}
	if zr.File[0].Name != ".claude/agents/eloquent-model-agent.md" {
		t.Fatalf("unexpected zip entry name: %q", zr.File[0].Name)
	}
	rc, err := zr.File[0].Open()
	if err != nil {
		t.Fatalf("failed to open zip entry: %v", err)
	}
	var content bytes.Buffer
	_, _ = content.ReadFrom(rc)
	_ = rc.Close()
	if content.String() != "laravel claude content" {
		t.Fatalf("expected laravel claude content, got %q", content.String())
	}
}

func TestDownloadAgentsHandler_MultipleCopilotAgentsHaveUniquePaths(t *testing.T) {
	s := &Server{}
	now := time.Now()

	agents := []GeneratedAgent{
		{
			FileName:      "eloquent-model-agent.md",
			BlueprintName: "eloquent-model-agent",
			Content:       "copilot 1",
			TemplateName:  "laravel",
			Format:        "copilot",
			GeneratedAt:   now,
		},
		{
			FileName:      "laravel-api-agent.md",
			BlueprintName: "laravel-api-agent",
			Content:       "copilot 2",
			TemplateName:  "laravel",
			Format:        "copilot",
			GeneratedAt:   now.Add(1 * time.Second),
		},
	}
	for _, a := range agents {
		s.generatedAgents.Store(agentStoreKey(a.TemplateName, a.BlueprintName, a.Format), a)
	}

	// Backward-compatible request without template_name/format (matches JS TemplateBrowser)
	payload, _ := json.Marshal(downloadAgentsRequest{
		AgentNames: []string{"eloquent-model-agent", "laravel-api-agent"},
	})
	req := httptest.NewRequest(http.MethodPost, "/api/agents/download", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.downloadAgentsHandler(w, req)

	resp := w.Result()
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected status 200, got %d", resp.StatusCode)
	}

	zr, err := zip.NewReader(bytes.NewReader(w.Body.Bytes()), int64(w.Body.Len()))
	if err != nil {
		t.Fatalf("failed to read zip: %v", err)
	}
	if len(zr.File) != 2 {
		t.Fatalf("expected 2 zip entries for 2 copilot agents, got %d", len(zr.File))
	}

	seen := make(map[string]bool)
	for _, f := range zr.File {
		if seen[f.Name] {
			t.Fatalf("duplicate zip entry path: %q", f.Name)
		}
		seen[f.Name] = true
	}
	if !seen[".github/instructions/eloquent-model-agent.md"] || !seen[".github/instructions/laravel-api-agent.md"] {
		t.Fatalf("unexpected copilot zip entry paths: %v", seen)
	}
}
