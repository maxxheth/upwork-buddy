package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

// GenerateAgentRequest is the input for agent generation
type GenerateAgentRequest struct {
	TemplateName    string
	AgentName      string
	AgentTitle     string
	AgentDesc      string
	DocsContent     string // scraped documentation content
	Format          string // "goose", "claude", "codex", "copilot"
	GooseAgentSpec string // optional override for goose schema
}

// GenerateAgentResponse is the output
type GenerateAgentResponse struct {
	FileName string
	Content  string
}

// ── Format-specific specs ──────────────────────────────────────────────────

const gooseAgentSpec = `version: "1.0.0"
title: "<recipe title>"
description: "<what the recipe does>"
parameters:
  - key: <name>
    input_type: string|number|boolean|select|file
    requirement: required|optional
    description: "<what this param is>"
    default: "<optional default>"
    options: []  # for select type
instructions: |
  <detailed instructions for the AI agent>
activities:
  - "message: <welcome message>"
  - "<clickable activity>"
extensions:
  - type: builtin
    name: developer
    timeout: 300
    bundled: true`

const claudeAgentSpec = `---
name: <agent-name>
description: <when to invoke this agent — one-line description>
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
maxTurns: 20
---

<system prompt goes here — detailed instructions for the agent>

## Architecture Context
<describe the project structure, conventions, and patterns>

## Steps
<numbered steps the agent should follow>

## Conventions
<coding conventions, naming rules, logging patterns, etc.>`

const codexSpec = `# Codex Agent Instructions
# Project: <project name>

## Overview
<what this agent does and when to use it>

## Architecture
<project structure, key directories, patterns>

## Conventions
<coding style, naming conventions, error handling patterns>

## Steps
<numbered steps for the agent to follow>

## Testing
<how to run tests, what to verify>`

const copilotSpec = `# GitHub Copilot Instructions

## Project Overview
<what this project is and what it does>

## Architecture
<project structure, key directories, tech stack>

## Conventions
<coding style, naming, formatting rules>

## Testing
<how to run tests, what to verify>

## Key Patterns
<important patterns that Copilot should follow>`

// formatSystemPrompts maps each format to its system prompt for the LLM.
var formatSystemPrompts = map[string]string{
	"goose": "You are an expert at creating Goose recipe YAML files. You must output ONLY valid YAML conforming to the Goose recipe schema. Do not include any markdown code fences or extra text — just the raw YAML content.",
	"claude": "You are an expert at creating Claude Code agent configuration files. You must output ONLY valid Markdown with YAML frontmatter, following the .claude/agents/ format exactly. Do not include any extra commentary — just the agent file content.",
	"codex": "You are an expert at creating OpenAI Codex agent instruction files. You must output ONLY the instruction content in Markdown format. Do not include any markdown code fences wrapping the entire output — just the raw content.",
	"copilot": "You are an expert at creating GitHub Copilot instruction files (.github/copilot-instructions.md). You must output ONLY the instruction content in Markdown format. Do not include any markdown code fences wrapping the entire output — just the raw content.",
}

// formatFileExtensions maps each format to its file extension.
var formatFileExtensions = map[string]string{
	"goose":   ".yaml",
	"claude":  ".md",
	"codex":   ".md",
	"copilot": ".md",
}

// GenerateAgent generates an agent file using the LLM.
func (s *Service) GenerateAgent(ctx context.Context, req GenerateAgentRequest) (*GenerateAgentResponse, error) {
	format := req.Format
	if format == "" {
		format = "claude"
	}

	prompt := buildAgentPrompt(req, format)
	systemPrompt, ok := formatSystemPrompts[format]
	if !ok {
		systemPrompt = formatSystemPrompts["claude"]
	}

	log.Printf("🤖 Generating %s agent: template=%q agent=%q", format, req.TemplateName, req.AgentName)
	log.Printf("🤖 Prompt length: %d characters", len(prompt))

	payload, err := json.Marshal(chatRequest{
		Model: s.model,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: prompt},
		},
		Stream: false,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to encode Ollama request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, s.host+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to create Ollama request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+s.apiKey)

	resp, err := s.client.Do(httpReq)
	if err != nil {
		log.Printf("🤖 Ollama agent generation request failed: %v", err)
		return nil, fmt.Errorf("failed to call Ollama API for agent generation: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read Ollama response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		log.Printf("🤖 Ollama agent generation failed: status=%d body=%s", resp.StatusCode, truncateForLog(string(respBody), 500))
		return nil, fmt.Errorf("ollama API returned %s", resp.Status)
	}

	var chatResp chatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		return nil, fmt.Errorf("failed to decode Ollama response: %w", err)
	}
	if chatResp.Error != "" {
		return nil, fmt.Errorf("ollama API error: %s", chatResp.Error)
	}

	content := chatResp.Message.Content
	content = extractContentFromResponse(content, format)

	if err := validateContent(content, format); err != nil {
		log.Printf("🤖 Generated %s agent validation warning: %v", format, err)
		// Still return the content — best effort
	}

	ext, ok := formatFileExtensions[format]
	if !ok {
		ext = ".md"
	}
	fileName := req.AgentName + ext
	log.Printf("🤖 Agent generated successfully: format=%q file=%q content_length=%d", format, fileName, len(content))

	return &GenerateAgentResponse{
		FileName: fileName,
		Content:  content,
	}, nil
}

// buildAgentPrompt constructs the prompt for agent generation based on format
func buildAgentPrompt(req GenerateAgentRequest, format string) string {
	docsSection := ""
	if req.DocsContent != "" {
		docsSection = fmt.Sprintf(`

FRAMEWORK DOCUMENTATION:
%s
`, req.DocsContent)
	}

	switch format {
	case "goose":
		spec := req.GooseAgentSpec
		if spec == "" {
			spec = gooseAgentSpec
		}
		return fmt.Sprintf(`Generate a Goose recipe YAML file for the following agent blueprint:

TEMPLATE: %s
AGENT NAME: %s
AGENT TITLE: %s
AGENT DESCRIPTION: %s
%s

The recipe MUST conform to this Goose recipe YAML schema:

%s

IMPORTANT RULES:
1. Output ONLY valid YAML — no markdown code fences, no extra commentary.
2. The "version" field MUST be "1.0.0".
3. Include a meaningful "title" and "description".
4. Add relevant "parameters" that a user would need to customize the recipe.
5. Write detailed "instructions" that an AI agent can follow step-by-step.
6. Include helpful "activities" (at least a welcome message).
7. Add appropriate "extensions" (typically the developer builtin extension).
8. The instructions should reference the framework documentation and best practices above.
9. Make the recipe practical and ready to use — not a toy example.
`, req.TemplateName, req.AgentName, req.AgentTitle, req.AgentDesc, docsSection, spec)

	case "claude":
		return fmt.Sprintf(`Generate a Claude Code agent configuration file (a Markdown file with YAML frontmatter) for the following blueprint:

TEMPLATE: %s
AGENT NAME: %s
AGENT TITLE: %s
AGENT DESCRIPTION: %s
%s

The agent file MUST conform to this format:

%s

IMPORTANT RULES:
1. Start with YAML frontmatter (---) containing name, description, tools, model, and maxTurns.
2. The "name" field should be a short kebab-case identifier (e.g., "add-gorm-model").
3. The "description" field should explain WHEN to use this agent — not just what it does.
4. The "tools" field should list the Claude Code tools the agent needs (Read, Edit, Write, Bash, Grep, Glob).
5. The "model" field should be "inherit" (uses the parent model).
6. The body after the frontmatter is the system prompt — write detailed, step-by-step instructions.
7. Include "Architecture Context" and "Steps" sections.
8. Reference the framework documentation above in the instructions.
9. Make the agent practical and production-ready — not a toy example.
10. Do NOT include markdown code fences around the entire output — output the raw file content.
`, req.TemplateName, req.AgentName, req.AgentTitle, req.AgentDesc, docsSection, claudeAgentSpec)

	case "codex":
		return fmt.Sprintf(`Generate an OpenAI Codex agent instruction file for the following blueprint:

TEMPLATE: %s
AGENT NAME: %s
AGENT TITLE: %s
AGENT DESCRIPTION: %s
%s

The instructions MUST follow this structure:

%s

IMPORTANT RULES:
1. Output ONLY the instruction content — no markdown code fences, no extra commentary.
2. Use clear Markdown headers and sections.
3. Include an Overview section explaining what the agent does.
4. Include an Architecture section describing the project structure.
5. Include a Conventions section with coding patterns and naming rules.
6. Include numbered Steps the agent should follow.
7. Include a Testing section explaining how to verify the work.
8. Reference the framework documentation above.
9. Make the instructions practical and production-ready.
`, req.TemplateName, req.AgentName, req.AgentTitle, req.AgentDesc, docsSection, codexSpec)

	case "copilot":
		return fmt.Sprintf(`Generate a GitHub Copilot instructions file for the following blueprint:

TEMPLATE: %s
AGENT NAME: %s
AGENT TITLE: %s
AGENT DESCRIPTION: %s
%s

The instructions MUST follow this structure:

%s

IMPORTANT RULES:
1. Output ONLY the instruction content — no markdown code fences, no extra commentary.
2. Use clear Markdown headers and sections.
3. Include a Project Overview section.
4. Include an Architecture section describing the project structure and key directories.
5. Include a Conventions section with coding style, naming, and formatting rules.
6. Include a Testing section explaining how to run tests and verify.
7. Include a Key Patterns section with important patterns to follow.
8. Reference the framework documentation above.
9. Make the instructions practical and production-ready.
`, req.TemplateName, req.AgentName, req.AgentTitle, req.AgentDesc, docsSection, copilotSpec)

	default:
		// Fallback to claude
		return buildAgentPrompt(req, "claude")
	}
}

// extractContentFromResponse strips markdown code fences and extracts the relevant content
func extractContentFromResponse(content string, format string) string {
	content = strings.TrimSpace(content)

	switch format {
	case "goose":
		return extractYAMLFromResponse(content)
	case "claude":
		// Claude agent files are markdown with YAML frontmatter
		// Strip ```markdown or ``` fences if present
		mdBlockRegex := regexp.MustCompile("(?s)```(?:markdown|md)?\\s*\\n(.*?)\\n```")
		if matches := mdBlockRegex.FindStringSubmatch(content); len(matches) > 1 {
			return strings.TrimSpace(matches[1])
		}
		// If starts with --- it's already the right format
		if strings.HasPrefix(content, "---") {
			return content
		}
		return content
	case "codex", "copilot":
		// These are plain markdown instructions
		mdBlockRegex := regexp.MustCompile("(?s)```(?:markdown|md)?\\s*\\n(.*?)\\n```")
		if matches := mdBlockRegex.FindStringSubmatch(content); len(matches) > 1 {
			return strings.TrimSpace(matches[1])
		}
		return content
	default:
		return content
	}
}

// extractYAMLFromResponse strips markdown code fences if present
func extractYAMLFromResponse(content string) string {
	content = strings.TrimSpace(content)

	// Try to extract from ```yaml ... ``` block
	yamlBlockRegex := regexp.MustCompile("(?s)```(?:ya?ml)?\\s*\\n(.*?)\\n```")
	if matches := yamlBlockRegex.FindStringSubmatch(content); len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}

	// If the whole content looks like it starts with a YAML key, return as-is
	if strings.HasPrefix(content, "version:") || strings.HasPrefix(content, "---") {
		content = strings.TrimPrefix(content, "---")
		return strings.TrimSpace(content)
	}

	return content
}

// validateContent checks that generated content has required fields for the format
func validateContent(content string, format string) error {
	if content == "" {
		return fmt.Errorf("empty content")
	}

	switch format {
	case "goose":
		if !strings.Contains(content, "version:") {
			return fmt.Errorf("missing 'version' field")
		}
		if !strings.Contains(content, "title:") {
			return fmt.Errorf("missing 'title' field")
		}
		if !strings.Contains(content, "description:") {
			return fmt.Errorf("missing 'description' field")
		}
		if !strings.Contains(content, "instructions:") {
			return fmt.Errorf("missing 'instructions' field")
		}
	case "claude":
		if !strings.Contains(content, "name:") {
			return fmt.Errorf("missing 'name' field in frontmatter")
		}
		if !strings.Contains(content, "description:") {
			return fmt.Errorf("missing 'description' field in frontmatter")
		}
		if !strings.Contains(content, "tools:") {
			return fmt.Errorf("missing 'tools' field in frontmatter")
		}
	case "codex", "copilot":
		// These are free-form markdown, minimal validation
		if len(content) < 100 {
			return fmt.Errorf("content too short — expected detailed instructions")
		}
	}
	return nil
}