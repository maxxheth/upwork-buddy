package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type memoryAgentStore struct {
	mu     sync.RWMutex
	agents map[string]GeneratedAgent
}

func newMemoryAgentStore() *memoryAgentStore {
	return &memoryAgentStore{agents: make(map[string]GeneratedAgent)}
}

func memoryAgentKey(templateName, blueprintName, format string) string {
	return templateName + "::" + blueprintName + "::" + format
}

func (m *memoryAgentStore) UpsertAgent(_ context.Context, agent GeneratedAgent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.agents[memoryAgentKey(agent.TemplateName, agent.BlueprintName, agent.Format)] = agent
	return nil
}

func (m *memoryAgentStore) ListAgents(_ context.Context) ([]GeneratedAgent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]GeneratedAgent, 0, len(m.agents))
	for _, a := range m.agents {
		out = append(out, a)
	}
	return out, nil
}

func (m *memoryAgentStore) FindAgent(_ context.Context, templateName, format, name string) (*GeneratedAgent, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if templateName != "" && format != "" {
		if a, ok := m.agents[memoryAgentKey(templateName, name, format)]; ok {
			copyA := a
			return &copyA, nil
		}
	}
	var matched *GeneratedAgent
	for _, a := range m.agents {
		if templateName != "" && a.TemplateName != templateName {
			continue
		}
		if format != "" && a.Format != format {
			continue
		}
		baseFileName := strings.TrimSuffix(strings.TrimSuffix(a.FileName, ".md"), ".yaml")
		if a.BlueprintName == name || baseFileName == name || a.FileName == name {
			if matched == nil || a.GeneratedAt.After(matched.GeneratedAt) {
				copyA := a
				matched = &copyA
			}
		}
	}
	return matched, nil
}

func TestGeneratedAgentsCompositeKeyIsolation(t *testing.T) {
	store := newMemoryAgentStore()
	s := &Server{agentStore: store}
	now := time.Now().UTC()

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

	_ = store.UpsertAgent(context.Background(), laravelClaude)
	_ = store.UpsertAgent(context.Background(), laravelCopilot)
	_ = store.UpsertAgent(context.Background(), apiClaude)

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
	store := newMemoryAgentStore()
	s := &Server{agentStore: store}
	now := time.Now().UTC()

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
		_ = store.UpsertAgent(context.Background(), a)
	}

	// Backward-compatible request without template_name/format
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

func TestGeneratedAgentsFailClosedWithoutDB(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	w := httptest.NewRecorder()
	s.listAgentsHandler(w, req)
	if w.Result().StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when DB is unavailable, got %d", w.Result().StatusCode)
	}
}

func TestGeneratedAgentsPostgresPersistence(t *testing.T) {
	s1 := setupTestServer(t)
	store, err := s1.getAgentStore()
	if err != nil {
		t.Fatalf("getAgentStore: %v", err)
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := store.UpsertAgent(context.Background(), GeneratedAgent{
		FileName:      "go-backend-agent.md",
		BlueprintName: "go-backend-agent",
		Content:       "v1 content",
		TemplateName:  "golang",
		Format:        "claude",
		GeneratedAt:   now,
	}); err != nil {
		t.Fatalf("UpsertAgent v1: %v", err)
	}

	// Upsert same composite key updates content instead of duplicating
	if err := store.UpsertAgent(context.Background(), GeneratedAgent{
		FileName:      "go-backend-agent.md",
		BlueprintName: "go-backend-agent",
		Content:       "v2 updated content",
		TemplateName:  "golang",
		Format:        "claude",
		GeneratedAt:   now.Add(2 * time.Second),
	}); err != nil {
		t.Fatalf("UpsertAgent v2: %v", err)
	}

	// Different format preserves composite-key isolation
	if err := store.UpsertAgent(context.Background(), GeneratedAgent{
		FileName:      "go-backend-agent.md",
		BlueprintName: "go-backend-agent",
		Content:       "copilot content",
		TemplateName:  "golang",
		Format:        "copilot",
		GeneratedAt:   now.Add(3 * time.Second),
	}); err != nil {
		t.Fatalf("UpsertAgent copilot: %v", err)
	}

	// Simulate fresh Server instance sharing the same DB (across restarts)
	s2 := &Server{db: s1.db, apiToken: s1.apiToken}
	router := s2.RegisterRoutes()

	listReq := httptest.NewRequest(http.MethodGet, "/api/agents", nil)
	listReq.Header.Set("Authorization", "Bearer "+s2.apiToken)
	listW := httptest.NewRecorder()
	router.ServeHTTP(listW, listReq)
	if listW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /api/agents status = %d", listW.Result().StatusCode)
	}

	var listed struct {
		Agents []GeneratedAgent `json:"agents"`
	}
	if err := json.NewDecoder(listW.Body).Decode(&listed); err != nil {
		t.Fatalf("decode /api/agents: %v", err)
	}
	if len(listed.Agents) != 2 {
		t.Fatalf("expected 2 persisted agents, got %d", len(listed.Agents))
	}

	dlPayload, _ := json.Marshal(downloadAgentsRequest{
		TemplateName: "golang",
		Format:       "claude",
		AgentNames:   []string{"go-backend-agent"},
	})
	dlReq := httptest.NewRequest(http.MethodPost, "/api/agents/download", bytes.NewReader(dlPayload))
	dlReq.Header.Set("Authorization", "Bearer "+s2.apiToken)
	dlReq.Header.Set("Content-Type", "application/json")
	dlW := httptest.NewRecorder()
	router.ServeHTTP(dlW, dlReq)
	if dlW.Result().StatusCode != http.StatusOK {
		t.Fatalf("POST /api/agents/download status = %d", dlW.Result().StatusCode)
	}
	zr, err := zip.NewReader(bytes.NewReader(dlW.Body.Bytes()), int64(dlW.Body.Len()))
	if err != nil || len(zr.File) != 1 {
		t.Fatalf("unexpected zip result: len=%d err=%v", len(zr.File), err)
	}
	rc, err := zr.File[0].Open()
	if err != nil {
		t.Fatalf("open zip entry: %v", err)
	}
	var gotContent bytes.Buffer
	_, _ = gotContent.ReadFrom(rc)
	_ = rc.Close()
	if gotContent.String() != "v2 updated content" {
		t.Fatalf("expected updated content, got %q", gotContent.String())
	}
}
