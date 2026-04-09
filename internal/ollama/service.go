package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const (
	defaultHost  = "https://ollama.com"
	defaultModel = "gpt-oss:120b"
)

// Service handles interactions with Ollama Cloud.
type Service struct {
	client *http.Client
	host   string
	apiKey string
	model  string
}

// JobAnalysisRequest contains the job posting and user profile.
type JobAnalysisRequest struct {
	JobTitle       string `json:"job_title"`
	JobDescription string `json:"job_description"`
	ContractType   string `json:"contract_type,omitempty"`
	Budget         string `json:"budget,omitempty"`
	RateRange      string `json:"rate_range,omitempty"`
	RateMin        string `json:"rate_min,omitempty"`
	RateMax        string `json:"rate_max,omitempty"`
	BudgetAmount   string `json:"budget_amount,omitempty"`
	Skills         string `json:"skills,omitempty"`
	ExperienceLevel string `json:"experience_level,omitempty"`
	UserProfile    string `json:"user_profile"`
	UserSkills     string `json:"user_skills"`
}

// JobAnalysisResponse contains the AI-generated analysis.
type JobAnalysisResponse struct {
	Proposal           string          `json:"proposal"`
	ExecutionPrompt    string          `json:"execution_prompt"`
	TimeEstimate       json.RawMessage `json:"time_estimate"`
	WorkloadDivision   json.RawMessage `json:"workload_division"`
	QuestionsForClient []string        `json:"questions_for_client"`
	TipsAndAdvice      []string        `json:"tips_and_advice"`
	ToneAnalysis       string          `json:"tone_analysis"`
}

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
	Format   string        `json:"format,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Model     string      `json:"model"`
	CreatedAt string      `json:"created_at"`
	Message   chatMessage `json:"message"`
	Error     string      `json:"error,omitempty"`
}

// New creates a new Ollama service instance.
func New() (*Service, error) {
	apiKey := strings.TrimSpace(os.Getenv("OLLAMA_API_KEY"))
	if apiKey == "" {
		return nil, fmt.Errorf("OLLAMA_API_KEY environment variable not set")
	}

	host := normalizeHost(os.Getenv("OLLAMA_HOST"))
	if host == "" {
		host = defaultHost
	}

	model := strings.TrimSpace(os.Getenv("OLLAMA_MODEL"))
	if model == "" {
		model = defaultModel
	}

	return &Service{
		client: &http.Client{Timeout: 90 * time.Second},
		host:   host,
		apiKey: apiKey,
		model:  model,
	}, nil
}

// Close closes the service connection.
func (s *Service) Close() error {
	return nil
}

// AnalyzeJob analyzes a job posting and generates a comprehensive response.
func (s *Service) AnalyzeJob(ctx context.Context, req JobAnalysisRequest) (*JobAnalysisResponse, error) {
	prompt := s.buildAnalysisPrompt(req)
	log.Printf("Ollama analyze job request: title=%q contract_type=%q budget=%q skills=%q experience_level=%q model=%q host=%q", req.JobTitle, req.ContractType, req.Budget, req.Skills, req.ExperienceLevel, s.model, s.host)
	log.Printf("Prompt length: %d characters", len(prompt))

	payload, err := json.Marshal(chatRequest{
		Model: s.model,
		Messages: []chatMessage{
			{
				Role:    "user",
				Content: prompt,
			},
		},
		Stream: false,
		Format: "json",
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
		log.Printf("Ollama chat request failed: %v", err)
		return nil, fmt.Errorf("failed to call Ollama Cloud API: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read Ollama response: %w", err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		log.Printf("Ollama chat failed: status=%d body=%s", resp.StatusCode, truncateForLog(string(respBody), 500))
		return nil, fmt.Errorf("Ollama Cloud API returned %s", resp.Status)
	}

	var chatResp chatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		log.Printf("Failed to decode Ollama response: %v", err)
		return nil, fmt.Errorf("failed to decode Ollama response: %w", err)
	}
	if chatResp.Error != "" {
		log.Printf("Ollama response error: %s", chatResp.Error)
		return nil, fmt.Errorf("Ollama Cloud API error: %s", chatResp.Error)
	}

	log.Printf("Ollama chat succeeded: model=%q created_at=%q content_length=%d", chatResp.Model, chatResp.CreatedAt, len(chatResp.Message.Content))
	result := s.parseResponse(chatResp.Message.Content)
	log.Printf("Parsed analysis result: proposal length=%d execution_prompt length=%d", len(result.Proposal), len(result.ExecutionPrompt))
	return result, nil
}

// buildAnalysisPrompt constructs the comprehensive prompt for the AI.
func (s *Service) buildAnalysisPrompt(req JobAnalysisRequest) string {
	// Build a human-readable budget description
	budgetDesc := req.Budget
	if budgetDesc == "" || budgetDesc == "Not specified" {
		switch req.ContractType {
		case "hourly":
			if req.RateRange != "" {
				budgetDesc = fmt.Sprintf("%s/hr (Hourly)", req.RateRange)
			}
		case "fixed":
			if req.BudgetAmount != "" {
				budgetDesc = fmt.Sprintf("%s (Fixed-price)", req.BudgetAmount)
			}
		default:
			budgetDesc = "Not specified"
		}
	}

	experienceDesc := req.ExperienceLevel
	if experienceDesc == "" || experienceDesc == "Not specified" {
		experienceDesc = "Not specified"
	}

	return fmt.Sprintf(`You are an expert freelance consultant helping contractors on Upwork create winning proposals and project plans.

JOB POSTING:
Title: %s
Description: %s
Contract Type: %s
Budget: %s
Required Skills: %s
Experience Level: %s

CONTRACTOR PROFILE:
Profile: %s
Skills: %s

Please provide a comprehensive analysis with the following sections:

1. PROPOSAL (2-3 paragraphs)
Write a compelling, professional yet relatable proposal that:
- Demonstrates understanding of the project requirements
- Highlights relevant experience and skills
- Shows enthusiasm and reliability
- Uses a tone that matches the job posting's formality level

2. EXECUTION PROMPT
Write a self-contained, copy-paste-ready prompt for an AI coding agent (Claude Code, Codex, Goose, etc.) that will execute this project end-to-end. The prompt must include:
- All project requirements and constraints from the job posting
- Technical stack and architecture decisions
- Step-by-step implementation instructions (numbered, specific)
- File paths, naming conventions, and code patterns to follow
- Testing and verification steps
- Edge cases and error handling requirements
Do NOT write a spec document — write an executable prompt that an agent can run with directly.

3. TIME ESTIMATE
Provide a realistic time estimate broken down by:
- Total hours required
- Breakdown by major project phases
- Buffer time for revisions and feedback

4. WORKLOAD DIVISION
Suggest how to divide work between:
- AI agents (GitHub Copilot, Jules): tasks suitable for automation, code generation, repetitive work
- Human contractor: tasks requiring judgment, creative decisions, client communication, QA, strategic planning
Include specific percentages and reasoning.

5. QUESTIONS FOR CLIENT (5-7 questions)
List strategic questions to ask the client to:
- Clarify requirements
- Understand their goals and priorities
- Set proper expectations
- Establish a smooth workflow

6. TIPS AND ADVICE (4-6 points)
Provide actionable advice on:
- Setting clear deliverables and milestones
- Managing client expectations
- QA and testing approach
- Handoff procedures
- Communication best practices

7. TONE ANALYSIS
Analyze the job posting's tone (formal, casual, technical, etc.) and suggest the best communication approach.

Return valid JSON only, with these exact keys:
{
  "proposal": "...",
  "execution_prompt": "...",
  "time_estimate": "...",
  "workload_division": "...",
  "questions_for_client": ["...", "..."],
  "tips_and_advice": ["...", "..."],
  "tone_analysis": "..."
}`,
		req.JobTitle,
		req.JobDescription,
		req.ContractType,
		budgetDesc,
		req.Skills,
		experienceDesc,
		req.UserProfile,
		req.UserSkills,
	)
}

// parseResponse parses the AI response into structured data.
func (s *Service) parseResponse(fullText string) *JobAnalysisResponse {
	log.Printf("parseResponse: collected text length=%d from assistant response", len(fullText))

	if len(fullText) > 0 {
		log.Printf("parseResponse: RAW RESPONSE START\n%s\nparseResponse: RAW RESPONSE END", truncateForLog(fullText, 500))
	}

	fullText = strings.TrimSpace(fullText)
	originalLength := len(fullText)

	jsonBlockRegex := regexp.MustCompile("(?s)^```(?:json)?\\s*\\n?(.*?)\\n?```$")
	if matches := jsonBlockRegex.FindStringSubmatch(fullText); len(matches) > 1 {
		fullText = strings.TrimSpace(matches[1])
		log.Printf("parseResponse: stripped markdown wrapper (before=%d, after=%d)", originalLength, len(fullText))
		log.Printf("parseResponse: STRIPPED JSON START\n%s\nparseResponse: STRIPPED JSON END", truncateForLog(fullText, 300))
	}

	var result JobAnalysisResponse
	if err := json.Unmarshal([]byte(fullText), &result); err == nil {
		log.Printf("parseResponse: ✅ json.Unmarshal succeeded")
		log.Printf("parseResponse: proposal length=%d, execution_prompt length=%d, questions=%d, tips=%d",
			len(result.Proposal), len(result.ExecutionPrompt),
			len(result.QuestionsForClient), len(result.TipsAndAdvice))

		if strings.HasPrefix(strings.TrimSpace(result.Proposal), "{") {
			log.Printf("parseResponse: proposal looks like nested JSON, attempting to re-parse...")
			var innerResult JobAnalysisResponse
			if err2 := json.Unmarshal([]byte(result.Proposal), &innerResult); err2 == nil {
				log.Printf("parseResponse: ✅ successfully parsed nested JSON from proposal field")
				return &innerResult
			}
			log.Printf("parseResponse: ⚠️ nested JSON parse failed, using outer result")
		}
		return &result
	} else {
		log.Printf("parseResponse: ❌ json.Unmarshal FAILED: %v", err)
		log.Printf("parseResponse: JSON error details - Type: %T, Message: %s", err, err.Error())

		if syntaxErr, ok := err.(*json.SyntaxError); ok {
			log.Printf("parseResponse: JSON syntax error at byte offset %d", syntaxErr.Offset)
			start := int(syntaxErr.Offset) - 100
			if start < 0 {
				start = 0
			}
			end := int(syntaxErr.Offset) + 100
			if end > len(fullText) {
				end = len(fullText)
			}
			log.Printf("parseResponse: ERROR CONTEXT: ...%s...", fullText[start:end])
		}

		log.Printf("parseResponse: FAILED JSON CONTENT START\n%s\nparseResponse: FAILED JSON CONTENT END", truncateForLog(fullText, 500))

		return &JobAnalysisResponse{
			Proposal:           fullText,
			ExecutionPrompt:    "Failed to parse response. Please check the API server logs.",
			TimeEstimate:       json.RawMessage(`""`),
			WorkloadDivision:   json.RawMessage(`""`),
			QuestionsForClient: []string{},
			TipsAndAdvice:      []string{},
			ToneAnalysis:       "",
		}
	}
}

func truncateForLog(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

func normalizeHost(raw string) string {
	host := strings.TrimSpace(raw)
	if host == "" {
		return ""
	}
	if !strings.Contains(host, "://") {
		host = "http://" + host
	}
	return strings.TrimRight(host, "/")
}
