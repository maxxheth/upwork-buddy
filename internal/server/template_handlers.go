package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/templates"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GeneratedAgent is the API DTO for a generated project agent blueprint.
type GeneratedAgent struct {
	FileName      string    `json:"file_name"`
	BlueprintName string    `json:"blueprint_name,omitempty"`
	Content       string    `json:"content"`
	TemplateName  string    `json:"template_name"`
	Format        string    `json:"format"`
	JobID         *uint     `json:"job_id,omitempty"`
	GeneratedAt   time.Time `json:"generated_at"`
}

type generatedAgentStore interface {
	UpsertAgent(ctx context.Context, agent GeneratedAgent) error
	ListAgents(ctx context.Context) ([]GeneratedAgent, error)
	FindAgent(ctx context.Context, templateName, format, name string) (*GeneratedAgent, error)
}

type postgresAgentStore struct {
	db *gorm.DB
}

func (p *postgresAgentStore) UpsertAgent(ctx context.Context, agent GeneratedAgent) error {
	now := time.Now().UTC()
	genAt := agent.GeneratedAt
	if genAt.IsZero() {
		genAt = now
	}
	model := dbservice.GeneratedAgent{
		TemplateName:  agent.TemplateName,
		BlueprintName: agent.BlueprintName,
		Format:        agent.Format,
		FileName:      agent.FileName,
		JobID:         agent.JobID,
		Content:       agent.Content,
		GeneratedAt:   genAt,
		UpdatedAt:     now,
	}
	updates := map[string]any{
		"file_name":    model.FileName,
		"content":      model.Content,
		"generated_at": model.GeneratedAt,
		"updated_at":   now,
	}
	if model.JobID != nil {
		updates["job_id"] = model.JobID
	}
	return p.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "template_name"},
			{Name: "blueprint_name"},
			{Name: "format"},
		},
		DoUpdates: clause.Assignments(updates),
	}).Create(&model).Error
}

func (p *postgresAgentStore) ListAgents(ctx context.Context) ([]GeneratedAgent, error) {
	var rows []dbservice.GeneratedAgent
	if err := p.db.WithContext(ctx).Order("generated_at DESC, id DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]GeneratedAgent, 0, len(rows))
	for _, r := range rows {
		out = append(out, generatedAgentFromModel(r))
	}
	return out, nil
}

func (p *postgresAgentStore) FindAgent(ctx context.Context, templateName, format, name string) (*GeneratedAgent, error) {
	if templateName != "" && format != "" {
		var rows []dbservice.GeneratedAgent
		err := p.db.WithContext(ctx).
			Where("template_name = ? AND blueprint_name = ? AND format = ?", templateName, name, format).
			Order("generated_at DESC, id DESC").
			Limit(1).
			Find(&rows).Error
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			dto := generatedAgentFromModel(rows[0])
			return &dto, nil
		}
	}

	q := p.db.WithContext(ctx).Model(&dbservice.GeneratedAgent{})
	if templateName != "" {
		q = q.Where("template_name = ?", templateName)
	}
	if format != "" {
		q = q.Where("format = ?", format)
	}
	q = q.Where(
		"blueprint_name = ? OR file_name = ? OR file_name = ? OR file_name = ?",
		name, name, name+".md", name+".yaml",
	)

	var candidates []dbservice.GeneratedAgent
	if err := q.Order("generated_at DESC, id DESC").Find(&candidates).Error; err != nil {
		return nil, err
	}
	for _, row := range candidates {
		baseFileName := strings.TrimSuffix(strings.TrimSuffix(row.FileName, ".md"), ".yaml")
		if row.BlueprintName == name || baseFileName == name || row.FileName == name {
			dto := generatedAgentFromModel(row)
			return &dto, nil
		}
	}
	return nil, nil
}

func generatedAgentFromModel(m dbservice.GeneratedAgent) GeneratedAgent {
	return GeneratedAgent{
		FileName:      m.FileName,
		BlueprintName: m.BlueprintName,
		Content:       m.Content,
		TemplateName:  m.TemplateName,
		Format:        m.Format,
		JobID:         m.JobID,
		GeneratedAt:   m.GeneratedAt,
	}
}

func (s *Server) getAgentStore() (generatedAgentStore, error) {
	if s != nil && s.agentStore != nil {
		return s.agentStore, nil
	}
	if s != nil && s.db != nil && s.db.GetGorm() != nil {
		return &postgresAgentStore{db: s.db.GetGorm()}, nil
	}
	return nil, errors.New("database unavailable")
}

func normalizeAgentFormat(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "goose", "claude", "codex", "copilot":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return "claude"
	}
}

func validateAndNormalizeAgentFormat(raw string) (string, error) {
	trimmed := strings.ToLower(strings.TrimSpace(raw))
	if trimmed == "" {
		return "claude", nil
	}
	switch trimmed {
	case "goose", "claude", "codex", "copilot":
		return trimmed, nil
	default:
		return "", &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("unsupported agent format %q; expected claude, goose, codex, or copilot", raw),
		}
	}
}

// listTemplatesResponse is the response for listing template categories
type listTemplatesResponse struct {
	Templates []templateSummary `json:"templates"`
}

type templateSummary struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	AgentCount  int    `json:"agent_count"`
}

// getTemplateResponse is the full template detail response
type getTemplateResponse struct {
	Name            string                   `json:"name"`
	DisplayName     string                   `json:"display_name"`
	Description     string                   `json:"description"`
	Icon            string                   `json:"icon"`
	Docs            []docRefResponse         `json:"docs"`
	AgentBlueprints []agentBlueprintResponse `json:"agent_blueprints"`
}

type docRefResponse struct {
	URL   string `json:"url"`
	Label string `json:"label"`
}

type agentBlueprintResponse struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

// GenerateProjectAgentsRequest is the request DTO for generating agent blueprints via REST or MCP.
type GenerateProjectAgentsRequest struct {
	JobID        any      `json:"job_id,omitempty"`
	TemplateName string   `json:"template_name"`
	AgentNames   []string `json:"agent_names"`
	Format       string   `json:"format"` // "goose", "claude", "codex", "copilot" — defaults to "claude"
}

// GenerateAgentsResponse is the response DTO for agent generation.
type GenerateAgentsResponse struct {
	Agents []GeneratedAgent `json:"agents"`
}

func inferTemplateForJob(cfg *templates.Config, job *dbservice.Job) string {
	if cfg == nil || len(cfg.Templates) == 0 {
		return ""
	}
	if job == nil {
		return cfg.Templates[0].Name
	}
	haystack := strings.ToLower(job.Title + " " + job.Skills + " " + job.Description)
	hasGo := strings.Contains(haystack, "golang") || regexpMust(`\bgo\b`).MatchString(haystack)
	hasReact := strings.Contains(haystack, "react")
	hasVue := strings.Contains(haystack, "vue")
	hasSvelte := strings.Contains(haystack, "svelte")
	hasLaravel := strings.Contains(haystack, "laravel")
	hasNext := strings.Contains(haystack, "next.js") || strings.Contains(haystack, "nextjs")

	preferred := ""
	switch {
	case hasLaravel && hasReact:
		preferred = "laravel-react-inertia"
	case hasLaravel && hasSvelte:
		preferred = "laravel-svelte-inertia"
	case hasLaravel && hasVue:
		preferred = "laravel-vue-inertia"
	case hasReact && hasGo:
		preferred = "react-go"
	case hasSvelte && hasGo:
		preferred = "svelte-go"
	case hasVue && hasGo:
		preferred = "vue-go"
	case hasNext:
		preferred = "nextjs"
	case hasGo:
		preferred = "golang"
	case hasReact:
		preferred = "tanstack-ts-node"
	}
	if preferred != "" {
		for _, t := range cfg.Templates {
			if t.Name == preferred {
				return t.Name
			}
		}
	}
	for _, t := range cfg.Templates {
		if t.Name == "golang" {
			return t.Name
		}
	}
	return cfg.Templates[0].Name
}

func renderDeterministicAgentBlueprint(
	cat *templates.TemplateCategory,
	bp templates.AgentBlueprint,
	format string,
	job *dbservice.Job,
) (string, string) {
	ext := ".md"
	if format == "goose" {
		ext = ".yaml"
	}
	fileName := bp.Name + ext

	var jobSection strings.Builder
	if job != nil {
		fmt.Fprintf(&jobSection, "Job Title: %s\n", job.Title)
		if job.UpworkJobID != nil && *job.UpworkJobID != "" {
			fmt.Fprintf(&jobSection, "Upwork Job ID: %s\n", *job.UpworkJobID)
		}
		if strings.TrimSpace(job.Skills) != "" {
			fmt.Fprintf(&jobSection, "Required Skills: %s\n", job.Skills)
		}
		if strings.TrimSpace(job.ExecutionPrompt) != "" {
			fmt.Fprintf(&jobSection, "Execution Notes: %s\n", job.ExecutionPrompt)
		} else if strings.TrimSpace(job.Description) != "" {
			desc := strings.TrimSpace(job.Description)
			if len(desc) > 500 {
				desc = desc[:500] + "..."
			}
			fmt.Fprintf(&jobSection, "Job Scope: %s\n", desc)
		}
	}

	var docLines strings.Builder
	for _, d := range cat.Docs {
		fmt.Fprintf(&docLines, "- %s: %s\n", d.Label, d.URL)
	}

	switch format {
	case "goose":
		var b strings.Builder
		fmt.Fprintf(&b, "version: \"1.0.0\"\n")
		fmt.Fprintf(&b, "title: %q\n", bp.Title)
		fmt.Fprintf(&b, "description: %q\n", bp.Description)
		b.WriteString("parameters:\n")
		b.WriteString("  - key: target_path\n")
		b.WriteString("    input_type: string\n")
		b.WriteString("    requirement: optional\n")
		b.WriteString("    description: \"Target module or directory\"\n")
		b.WriteString("    default: \".\"\n")
		b.WriteString("instructions: |\n")
		fmt.Fprintf(&b, "  Role: %s (%s)\n", bp.Title, cat.DisplayName)
		fmt.Fprintf(&b, "  Objective: %s\n", bp.Description)
		if jobSection.Len() > 0 {
			for _, line := range strings.Split(strings.TrimSpace(jobSection.String()), "\n") {
				fmt.Fprintf(&b, "  %s\n", line)
			}
		}
		b.WriteString("  Steps:\n")
		b.WriteString("  1. Inspect existing project layout, conventions, and tests.\n")
		b.WriteString("  2. Implement scoped changes adhering to framework patterns.\n")
		b.WriteString("  3. Run unit/integration tests and linters to verify correctness.\n")
		b.WriteString("activities:\n")
		fmt.Fprintf(&b, "  - \"message: Ready to execute %s\"\n", bp.Title)
		b.WriteString("extensions:\n")
		b.WriteString("  - type: builtin\n")
		b.WriteString("    name: developer\n")
		b.WriteString("    timeout: 300\n")
		b.WriteString("    bundled: true\n")
		return fileName, b.String()

	case "codex":
		var b strings.Builder
		fmt.Fprintf(&b, "# Codex Agent Instructions — %s\n\n", bp.Title)
		fmt.Fprintf(&b, "## Overview\n%s\n\nStack: %s (%s)\n\n", bp.Description, cat.DisplayName, cat.Description)
		if jobSection.Len() > 0 {
			fmt.Fprintf(&b, "## Project Context\n%s\n", jobSection.String())
		}
		b.WriteString("## Architecture & Conventions\n- Follow repository structure, typed contracts, and explicit error handling.\n- Keep changes minimal and strictly scoped to requirements.\n\n")
		b.WriteString("## Steps\n1. Inspect relevant modules and schemas.\n2. Implement the required feature or refactor.\n3. Add or update unit/integration tests.\n\n")
		fmt.Fprintf(&b, "## Testing & Verification\nRun project build, vet/lint, and test commands before reporting completion.\n\n## References\n%s", docLines.String())
		return fileName, b.String()

	case "copilot":
		var b strings.Builder
		fmt.Fprintf(&b, "# GitHub Copilot Instructions — %s\n\n", bp.Title)
		fmt.Fprintf(&b, "## Project Overview\n%s\n\nTemplate: %s — %s\n\n", bp.Description, cat.DisplayName, cat.Description)
		if jobSection.Len() > 0 {
			fmt.Fprintf(&b, "## Active Job Context\n%s\n", jobSection.String())
		}
		b.WriteString("## Architecture\nRespect package boundaries, existing database models, and API DTO contracts.\n\n")
		b.WriteString("## Conventions\n- Write idiomatic, strongly-typed code with clear error propagation.\n- Avoid unrequested refactoring or silent fallbacks.\n\n")
		b.WriteString("## Testing\nVerify every change with automated tests covering success and error paths.\n\n")
		fmt.Fprintf(&b, "## Key Patterns & References\n%s", docLines.String())
		return fileName, b.String()

	default: // claude
		var b strings.Builder
		b.WriteString("---\n")
		fmt.Fprintf(&b, "name: %s\n", bp.Name)
		fmt.Fprintf(&b, "description: %s\n", bp.Description)
		b.WriteString("tools: Read, Edit, Write, Bash, Grep, Glob\n")
		b.WriteString("model: inherit\n")
		b.WriteString("maxTurns: 20\n")
		b.WriteString("---\n\n")
		fmt.Fprintf(&b, "You are the **%s** for %s.\n\n", bp.Title, cat.DisplayName)
		if jobSection.Len() > 0 {
			fmt.Fprintf(&b, "## Project Context\n%s\n", jobSection.String())
		}
		fmt.Fprintf(&b, "## Architecture Context\n%s\n\n", cat.Description)
		b.WriteString("## Steps\n1. Inspect existing code and conventions in target packages.\n2. Implement the required capability cleanly and minimally.\n3. Run build, lint, and test suites to verify.\n\n")
		if docLines.Len() > 0 {
			fmt.Fprintf(&b, "## Documentation References\n%s", docLines.String())
		}
		return fileName, b.String()
	}
}

// GenerateProjectAgents generates and persists project agent blueprints for a template (and optional linked job).
func (s *Server) GenerateProjectAgents(ctx context.Context, req GenerateProjectAgentsRequest) (*GenerateAgentsResponse, error) {
	store, err := s.getAgentStore()
	if err != nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	format, fmtErr := validateAndNormalizeAgentFormat(req.Format)
	if fmtErr != nil {
		return nil, fmtErr
	}

	var linkedJob *dbservice.Job
	var jobIDPtr *uint
	if req.JobID != nil {
		if strID, isStr := req.JobID.(string); isStr && strings.TrimSpace(strID) == "" {
			// Treat blank string job_id: "" as omitted when template_name is supplied (or let template_name check handle missing).
		} else {
			resolved, jErr := s.ResolveJobRef(ctx, req.JobID, "")
			if jErr != nil {
				return nil, jErr
			}
			linkedJob = resolved
			idCopy := resolved.ID
			jobIDPtr = &idCopy
		}
	}

	cfg, err := templates.Load(s.TemplatesPath())
	if err != nil {
		log.Printf("❌ Failed to load templates: %v", err)
		return nil, &ServiceError{Code: "TEMPLATES_LOAD_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load templates"}
	}

	templateName := strings.TrimSpace(req.TemplateName)
	if templateName == "" {
		if linkedJob != nil {
			templateName = inferTemplateForJob(cfg, linkedJob)
		}
	}
	if templateName == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "template_name is required"}
	}

	var templateCat *templates.TemplateCategory
	for i := range cfg.Templates {
		if cfg.Templates[i].Name == templateName {
			templateCat = &cfg.Templates[i]
			break
		}
	}
	if templateCat == nil {
		return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: fmt.Sprintf("Template %q not found", templateName)}
	}

	blueprintMap := make(map[string]templates.AgentBlueprint, len(templateCat.AgentBlueprints))
	for _, bp := range templateCat.AgentBlueprints {
		blueprintMap[bp.Name] = bp
	}

	agentNames := req.AgentNames
	if len(agentNames) == 0 {
		agentNames = make([]string, 0, len(templateCat.AgentBlueprints))
		for _, bp := range templateCat.AgentBlueprints {
			agentNames = append(agentNames, bp.Name)
		}
	}
	if len(agentNames) == 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "agent_names is required"}
	}

	var ollamaService *ollama.Service
	var docsContent string
	if ollama.IsConfigured() {
		if svc, oErr := ollama.New(); oErr == nil {
			ollamaService = svc
			defer func() {
				if cErr := ollamaService.Close(); cErr != nil {
					log.Printf("⚠️ Failed to close Ollama service: %v", cErr)
				}
			}()
			docsContent = scrapeDocs(templateCat.Docs)
		}
	}

	generatedAgents := make([]GeneratedAgent, 0, len(agentNames))
	for _, agentName := range agentNames {
		bp, ok := blueprintMap[agentName]
		if !ok {
			log.Printf("⚠️ Agent blueprint not found: %q, skipping", agentName)
			continue
		}

		var fileName, content string
		if ollamaService != nil {
			genReq := ollama.GenerateAgentRequest{
				TemplateName: templateName,
				AgentName:    bp.Name,
				AgentTitle:   bp.Title,
				AgentDesc:    bp.Description,
				DocsContent:  docsContent,
				Format:       format,
			}
			resp, gErr := ollamaService.GenerateAgent(ctx, genReq)
			if gErr == nil && resp != nil {
				fileName = resp.FileName
				content = resp.Content
			} else {
				log.Printf("⚠️ Ollama GenerateAgent failed for %q (%v); falling back to template blueprint", agentName, gErr)
			}
		}
		if content == "" {
			fileName, content = renderDeterministicAgentBlueprint(templateCat, bp, format, linkedJob)
		}

		agent := GeneratedAgent{
			FileName:      fileName,
			BlueprintName: bp.Name,
			Content:       content,
			TemplateName:  templateName,
			Format:        format,
			JobID:         jobIDPtr,
			GeneratedAt:   time.Now().UTC(),
		}

		if err := store.UpsertAgent(ctx, agent); err != nil {
			log.Printf("❌ Failed to persist generated agent %q: %v", agentName, err)
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to persist generated agent"}
		}
		generatedAgents = append(generatedAgents, agent)
	}

	if len(generatedAgents) == 0 {
		return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "No matching agent blueprints found for template"}
	}

	return &GenerateAgentsResponse{Agents: generatedAgents}, nil
}

// generateAgentsHandler scrapes docs, calls Ollama (or deterministic template fallback), and persists generated agents in PostgreSQL.
func (s *Server) generateAgentsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Generate agents request")

	var req GenerateProjectAgentsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if strings.TrimSpace(req.TemplateName) == "" && req.JobID == nil {
		respondWithError(w, http.StatusBadRequest, "template_name is required")
		return
	}
	if len(req.AgentNames) == 0 && req.JobID == nil {
		respondWithError(w, http.StatusBadRequest, "agent_names is required")
		return
	}

	resp, err := s.GenerateProjectAgents(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	log.Printf("✅ Generated %d agents", len(resp.Agents))
	respondWithJSON(w, resp)
}

// downloadAgentsRequest is the request body for POST /api/agents/download
type downloadAgentsRequest struct {
	TemplateName string   `json:"template_name,omitempty"`
	Format       string   `json:"format,omitempty"`
	AgentNames   []string `json:"agent_names"`
}

// listTemplatesHandler returns all template categories with summary info
func (s *Server) listTemplatesHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 List templates request")

	cfg, err := templates.Load(s.templatesPath)
	if err != nil {
		log.Printf("❌ Failed to load templates: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to load templates")
		return
	}

	summaries := make([]templateSummary, 0, len(cfg.Templates))
	for _, t := range cfg.Templates {
		summaries = append(summaries, templateSummary{
			Name:        t.Name,
			DisplayName: t.DisplayName,
			Description: t.Description,
			Icon:        t.Icon,
			AgentCount:  len(t.AgentBlueprints),
		})
	}

	log.Printf("✅ Listed %d template categories", len(summaries))
	respondWithJSON(w, listTemplatesResponse{Templates: summaries})
}

// getTemplateHandler returns full details for a single template category
func (s *Server) getTemplateHandler(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if name == "" {
		// Fallback: extract from path manually for older Go patterns
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/templates/"), "/")
		if len(parts) > 0 {
			name = parts[0]
		}
	}
	log.Printf("📥 Get template request: name=%q", name)

	cfg, err := templates.Load(s.templatesPath)
	if err != nil {
		log.Printf("❌ Failed to load templates: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to load templates")
		return
	}

	for _, t := range cfg.Templates {
		if t.Name == name {
			docs := make([]docRefResponse, 0, len(t.Docs))
			for _, d := range t.Docs {
				docs = append(docs, docRefResponse{URL: d.URL, Label: d.Label})
			}
			blueprints := make([]agentBlueprintResponse, 0, len(t.AgentBlueprints))
			for _, bp := range t.AgentBlueprints {
				blueprints = append(blueprints, agentBlueprintResponse{
					Name:        bp.Name,
					Title:       bp.Title,
					Description: bp.Description,
				})
			}
			log.Printf("✅ Template found: %q", name)
			respondWithJSON(w, getTemplateResponse{
				Name:            t.Name,
				DisplayName:     t.DisplayName,
				Description:     t.Description,
				Icon:            t.Icon,
				Docs:            docs,
				AgentBlueprints: blueprints,
			})
			return
		}
	}

	log.Printf("❌ Template not found: %q", name)
	respondWithError(w, http.StatusNotFound, "Template not found")
}



// listAgentsHandler returns all persisted generated agents
func (s *Server) listAgentsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 List agents request")

	store, err := s.getAgentStore()
	if err != nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	agents, err := store.ListAgents(r.Context())
	if err != nil {
		log.Printf("❌ Failed to list generated agents: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to list generated agents")
		return
	}

	log.Printf("✅ Listed %d generated agents", len(agents))
	respondWithJSON(w, map[string]interface{}{
		"agents": agents,
	})
}

// downloadAgentsHandler creates a zip of selected agent files
func (s *Server) downloadAgentsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Download agents request")

	store, err := s.getAgentStore()
	if err != nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req downloadAgentsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if len(req.AgentNames) == 0 {
		respondWithError(w, http.StatusBadRequest, "agent_names is required")
		return
	}

	// Collect agents to include in the zip
	var agents []GeneratedAgent
	requestedFormat := ""
	if strings.TrimSpace(req.Format) != "" {
		requestedFormat = normalizeAgentFormat(req.Format)
	}
	templateName := strings.TrimSpace(req.TemplateName)

	for _, name := range req.AgentNames {
		matched, err := store.FindAgent(r.Context(), templateName, requestedFormat, name)
		if err != nil {
			log.Printf("❌ Failed to look up agent %q: %v", name, err)
			respondWithError(w, http.StatusInternalServerError, "Failed to query generated agents")
			return
		}
		if matched == nil {
			log.Printf("⚠️ Agent not found in store: %q, skipping", name)
			continue
		}
		agents = append(agents, *matched)
	}

	if len(agents) == 0 {
		respondWithError(w, http.StatusNotFound, "No agents found for the given names")
		return
	}

	copilotCount := 0
	for _, agent := range agents {
		if agent.Format == "copilot" {
			copilotCount++
		}
	}

	// Create zip in memory
	buf := new(bytes.Buffer)
	zipWriter := zip.NewWriter(buf)
	seenPaths := make(map[string]bool)

	for _, agent := range agents {
		// Use format-specific directory structure in the zip
		var path string
		switch agent.Format {
		case "claude":
			path = fmt.Sprintf(".claude/agents/%s", agent.FileName)
		case "codex":
			path = fmt.Sprintf(".codex/agents/%s", agent.FileName)
		case "copilot":
			if copilotCount > 1 {
				path = fmt.Sprintf(".github/instructions/%s", agent.FileName)
			} else {
				path = ".github/copilot-instructions.md"
			}
		default: // goose
			path = fmt.Sprintf(".goose/recipes/%s", agent.FileName)
		}

		if seenPaths[path] {
			switch agent.Format {
			case "claude":
				path = fmt.Sprintf(".claude/agents/%s-%s", agent.TemplateName, agent.FileName)
			case "codex":
				path = fmt.Sprintf(".codex/agents/%s-%s", agent.TemplateName, agent.FileName)
			case "copilot":
				path = fmt.Sprintf(".github/instructions/%s-%s", agent.TemplateName, agent.FileName)
			default:
				path = fmt.Sprintf(".goose/recipes/%s-%s", agent.TemplateName, agent.FileName)
			}
		}
		for idx := 2; seenPaths[path]; idx++ {
			path = fmt.Sprintf("%s.%d", path, idx)
		}
		seenPaths[path] = true

		f, err := zipWriter.Create(path)
		if err != nil {
			log.Printf("❌ Failed to create zip entry %q: %v", path, err)
			continue
		}
		if _, err := f.Write([]byte(agent.Content)); err != nil {
			log.Printf("❌ Failed to write zip entry %q: %v", path, err)
			continue
		}
	}

	if err := zipWriter.Close(); err != nil {
		log.Printf("❌ Failed to close zip writer: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to create zip archive")
		return
	}

	log.Printf("📦 Sending zip with %d agents (%d bytes)", len(agents), buf.Len())

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", "attachment; filename=agents.zip")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", buf.Len()))
	if _, err := io.Copy(w, buf); err != nil {
		log.Printf("❌ Failed to write zip response: %v", err)
	}
}

// scrapeDocs fetches documentation URLs and returns concatenated content
func scrapeDocs(docs []templates.DocRef) string {
	client := &http.Client{Timeout: 10 * time.Second}
	var content strings.Builder

	for _, doc := range docs {
		log.Printf("📥 Scraping doc: %s (%s)", doc.Label, doc.URL)
		resp, err := client.Get(doc.URL)
		if err != nil {
			log.Printf("⚠️ Failed to fetch %s: %v", doc.URL, err)
			continue
		}
		body, err := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		if err != nil {
			log.Printf("⚠️ Failed to read %s: %v", doc.URL, err)
			continue
		}

		// Strip HTML tags for a rough text extraction
		text := stripHTMLTags(string(body))
		// Limit content size per doc to avoid overwhelming the LLM
		if len(text) > 5000 {
			text = text[:5000] + "\n... (truncated)"
		}

		fmt.Fprintf(&content, "\n=== %s (%s) ===\n%s\n", doc.Label, doc.URL, text)
	}

	return content.String()
}

// stripHTMLTags does a basic removal of HTML tags from content
func stripHTMLTags(s string) string {
	// Remove HTML tags
	re := regexpMust(`(?s)<script.*?</script>`)
	s = re.ReplaceAllString(s, "")
	re = regexpMust(`(?s)<style.*?</style>`)
	s = re.ReplaceAllString(s, "")
	re = regexpMust(`<[^>]+>`)
	s = re.ReplaceAllString(s, " ")
	// Collapse whitespace
	re = regexpMust(`\s+`)
	s = re.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// regexpMust is a helper that panics on invalid regex — used for hardcoded patterns
func regexpMust(pattern string) *regexp.Regexp {
	return regexp.MustCompile(pattern)
}
