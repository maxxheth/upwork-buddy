package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/templates"
)

// GeneratedAgent stores a generated agent in memory
type GeneratedAgent struct {
	FileName      string    `json:"file_name"`
	BlueprintName string    `json:"blueprint_name,omitempty"`
	Content       string    `json:"content"`
	TemplateName  string    `json:"template_name"`
	Format        string    `json:"format"`
	GeneratedAt   time.Time `json:"generated_at"`
}

func agentStoreKey(templateName, blueprintName, format string) string {
	return fmt.Sprintf("%s::%s::%s", templateName, blueprintName, format)
}

func normalizeAgentFormat(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "goose", "claude", "codex", "copilot":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return "claude"
	}
}

// listTemplatesResponse is the response for listing template categories
type listTemplatesResponse struct {
	Templates []templateSummary `json:"templates"`
}

type templateSummary struct {
	Name         string `json:"name"`
	DisplayName  string `json:"display_name"`
	Description  string `json:"description"`
	Icon         string `json:"icon"`
	AgentCount   int    `json:"agent_count"`
}

// getTemplateResponse is the full template detail response
type getTemplateResponse struct {
	Name             string                       `json:"name"`
	DisplayName      string                       `json:"display_name"`
	Description      string                       `json:"description"`
	Icon             string                       `json:"icon"`
	Docs             []docRefResponse             `json:"docs"`
	AgentBlueprints  []agentBlueprintResponse     `json:"agent_blueprints"`
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

// generateAgentsRequest is the request body for POST /api/agents/generate
type generateAgentsRequest struct {
	TemplateName string   `json:"template_name"`
	AgentNames   []string `json:"agent_names"`
	Format       string   `json:"format"` // "goose", "claude", "codex", "copilot" — defaults to "claude"
}

// generateAgentsResponse is the response for agent generation
type generateAgentsResponse struct {
	Agents []GeneratedAgent `json:"agents"`
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
				Name:             t.Name,
				DisplayName:      t.DisplayName,
				Description:      t.Description,
				Icon:             t.Icon,
				Docs:             docs,
				AgentBlueprints: blueprints,
			})
			return
		}
	}

	log.Printf("❌ Template not found: %q", name)
	respondWithError(w, http.StatusNotFound, "Template not found")
}

// generateAgentsHandler scrapes docs, calls Ollama, and stores generated agents
func (s *Server) generateAgentsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Generate agents request")

	var req generateAgentsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.TemplateName == "" {
		respondWithError(w, http.StatusBadRequest, "template_name is required")
		return
	}
	if len(req.AgentNames) == 0 {
		respondWithError(w, http.StatusBadRequest, "agent_names is required")
		return
	}

	// Normalize format, default to "claude"
	format := normalizeAgentFormat(req.Format)

	// Load templates to find the matching category
	cfg, err := templates.Load(s.templatesPath)
	if err != nil {
		log.Printf("❌ Failed to load templates: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to load templates")
		return
	}

	var templateCat *templates.TemplateCategory
	for i := range cfg.Templates {
		if cfg.Templates[i].Name == req.TemplateName {
			templateCat = &cfg.Templates[i]
			break
		}
	}
	if templateCat == nil {
		log.Printf("❌ Template not found: %q", req.TemplateName)
		respondWithError(w, http.StatusNotFound, "Template not found")
		return
	}

	// Build a map of agent names to blueprints
	blueprintMap := make(map[string]templates.AgentBlueprint)
	for _, bp := range templateCat.AgentBlueprints {
		blueprintMap[bp.Name] = bp
	}

	// Scrape documentation content
	log.Printf("📥 Scraping documentation for template %q (%d docs)", req.TemplateName, len(templateCat.Docs))
	docsContent := scrapeDocs(templateCat.Docs)

	// Create Ollama service
	ollamaService, err := ollama.New()
	if err != nil {
		log.Printf("❌ Failed to create Ollama service: %v", err)
		respondWithError(w, http.StatusServiceUnavailable, "AI service unavailable")
		return
	}
	defer func() {
		if err := ollamaService.Close(); err != nil {
			log.Printf("⚠️ Failed to close Ollama service: %v", err)
		}
	}()

	// Generate agents
	generatedAgents := make([]GeneratedAgent, 0, len(req.AgentNames))
	for _, agentName := range req.AgentNames {
		bp, ok := blueprintMap[agentName]
		if !ok {
			log.Printf("⚠️ Agent blueprint not found: %q, skipping", agentName)
			continue
		}

		genReq := ollama.GenerateAgentRequest{
			TemplateName: req.TemplateName,
			AgentName:    bp.Name,
			AgentTitle:   bp.Title,
			AgentDesc:    bp.Description,
			DocsContent:  docsContent,
			Format:       format,
		}

		resp, err := ollamaService.GenerateAgent(r.Context(), genReq)
		if err != nil {
			log.Printf("❌ Failed to generate agent %q: %v", agentName, err)
			continue
		}

		agent := GeneratedAgent{
			FileName:      resp.FileName,
			BlueprintName: bp.Name,
			Content:       resp.Content,
			TemplateName:  req.TemplateName,
			Format:        format,
			GeneratedAt:   time.Now(),
		}

		// Store in the in-memory map keyed by composite (TemplateName, BlueprintName, Format)
		s.generatedAgents.Store(agentStoreKey(req.TemplateName, bp.Name, format), agent)
		generatedAgents = append(generatedAgents, agent)

		log.Printf("✅ Agent generated: %s", agentName)
	}

	log.Printf("✅ Generated %d agents for template %q", len(generatedAgents), req.TemplateName)
	respondWithJSON(w, generateAgentsResponse{Agents: generatedAgents})
}

// listAgentsHandler returns all generated agents from the in-memory store
func (s *Server) listAgentsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 List agents request")

	agents := make([]GeneratedAgent, 0)
	s.generatedAgents.Range(func(key, value interface{}) bool {
		agent, ok := value.(GeneratedAgent)
		if ok {
			agents = append(agents, agent)
		}
		return true
	})

	log.Printf("✅ Listed %d generated agents", len(agents))
	respondWithJSON(w, map[string]interface{}{
		"agents": agents,
	})
}

// downloadAgentsHandler creates a zip of selected agent files
func (s *Server) downloadAgentsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Download agents request")

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

	for _, name := range req.AgentNames {
		var matched *GeneratedAgent
		if strings.TrimSpace(req.TemplateName) != "" && requestedFormat != "" {
			if val, ok := s.generatedAgents.Load(agentStoreKey(req.TemplateName, name, requestedFormat)); ok {
				if agent, ok := val.(GeneratedAgent); ok {
					matched = &agent
				}
			}
		}

		if matched == nil {
			// Backward-compatible lookup by agent name (selecting newest GeneratedAt if multiple exist)
			s.generatedAgents.Range(func(_, value interface{}) bool {
				agent, ok := value.(GeneratedAgent)
				if !ok {
					return true
				}
				if strings.TrimSpace(req.TemplateName) != "" && agent.TemplateName != req.TemplateName {
					return true
				}
				if requestedFormat != "" && agent.Format != requestedFormat {
					return true
				}
				baseFileName := strings.TrimSuffix(strings.TrimSuffix(agent.FileName, ".md"), ".yaml")
				if agent.BlueprintName == name || baseFileName == name || agent.FileName == name {
					if matched == nil || agent.GeneratedAt.After(matched.GeneratedAt) {
						agentCopy := agent
						matched = &agentCopy
					}
				}
				return true
			})
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