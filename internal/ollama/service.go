package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHost           = "https://ollama.com"
	defaultModel          = "gpt-oss:120b"
	defaultAGYEndpoint    = "http://127.0.0.1:11435"
	defaultAGYModel       = "gemini-pro-orchestrator-neon"
	defaultAGYEffort      = "medium"
	defaultTimeoutSeconds = 180
	minTimeoutSeconds     = 10
)

var (
	// ErrUnavailable indicates the configured LLM provider is not configured or temporarily unavailable (HTTP 503).
	ErrUnavailable = errors.New("llm service unavailable")
	// ErrAuthRequired indicates the configured LLM provider rejected credentials or requires authentication.
	ErrAuthRequired = errors.New("llm authentication required")
)

// Service handles interactions with the configured LLM provider (AGY gateway or Ollama Cloud).
type Service struct {
	client   *http.Client
	provider string
	host     string
	apiKey   string
	model    string
	effort   string
}

// PortfolioContext represents a relevant portfolio entry included in LLM prompt context.
type PortfolioContext struct {
	Title       string `json:"title"`
	Link        string `json:"link,omitempty"`
	Description string `json:"description,omitempty"`
}

// ActiveProjectContext represents a sanitized active project included in LLM prompt context.
type ActiveProjectContext struct {
	DisplayName  string   `json:"display_name"`
	Visibility   string   `json:"visibility"`
	ActivityTier string   `json:"activity_tier,omitempty"`
	Summary      string   `json:"summary,omitempty"`
	RecentFocus  string   `json:"recent_focus,omitempty"`
	TechStack    []string `json:"tech_stack,omitempty"`
}

// JobAnalysisRequest contains the job posting and user profile.
type JobAnalysisRequest struct {
	JobTitle           string                 `json:"job_title"`
	JobDescription     string                 `json:"job_description"`
	ContractType       string                 `json:"contract_type,omitempty"`
	Budget             string                 `json:"budget,omitempty"`
	RateRange          string                 `json:"rate_range,omitempty"`
	RateMin            string                 `json:"rate_min,omitempty"`
	RateMax            string                 `json:"rate_max,omitempty"`
	BudgetAmount       string                 `json:"budget_amount,omitempty"`
	Skills             string                 `json:"skills,omitempty"`
	ExperienceLevel    string                 `json:"experience_level,omitempty"`
	Duration           string                 `json:"duration,omitempty"`
	HoursPerWeek       string                 `json:"hours_per_week,omitempty"`
	ProposalsTier      string                 `json:"proposals_tier,omitempty"`
	ClientCountry      string                 `json:"client_country,omitempty"`
	ClientSpent        string                 `json:"client_spent,omitempty"`
	ClientHireRate     *float64               `json:"client_hire_rate,omitempty"`
	ScreeningQuestions []string               `json:"screening_questions,omitempty"`
	UserProfile        string                 `json:"user_profile"`
	UserSkills         string                 `json:"user_skills"`
	PortfolioItems     []PortfolioContext     `json:"portfolio_items,omitempty"`
	ActiveProjects     []ActiveProjectContext `json:"active_projects,omitempty"`
	WorkloadSummary    string                 `json:"workload_summary,omitempty"`
	Model              string                 `json:"model,omitempty"`
	Effort             string                 `json:"effort,omitempty"`
}

// TokenUsage captures normalized LLM token counts returned by AGY or Ollama.
type TokenUsage struct {
	InputTokens   int `json:"input_tokens,omitempty"`
	OutputTokens  int `json:"output_tokens,omitempty"`
	ThoughtTokens int `json:"thought_tokens,omitempty"`
	TotalTokens   int `json:"total_tokens,omitempty"`
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
	Model              string          `json:"model,omitempty"`
	Effort             string          `json:"effort,omitempty"`
	Usage              *TokenUsage     `json:"usage,omitempty"`
}

type chatRequest struct {
	Model    string        `json:"model"`
	Effort   string        `json:"effort,omitempty"`
	Messages []chatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
	Format   string        `json:"format,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatUsage struct {
	InputTokens        int `json:"inputTokens"`
	OutputTokens       int `json:"outputTokens"`
	ThoughtTokens      int `json:"thoughtTokens"`
	TotalTokens        int `json:"totalTokens"`
	InputTokensSnake   int `json:"input_tokens"`
	OutputTokensSnake  int `json:"output_tokens"`
	ThoughtTokensSnake int `json:"thought_tokens"`
	TotalTokensSnake   int `json:"total_tokens"`
}

type chatResponse struct {
	Model           string      `json:"model"`
	CreatedAt       string      `json:"created_at"`
	Message         chatMessage `json:"message"`
	Error           string      `json:"error,omitempty"`
	AppliedEffort   string      `json:"applied_effort,omitempty"`
	EffortApplied   *bool       `json:"effort_applied,omitempty"`
	Usage           *chatUsage  `json:"usage,omitempty"`
	PromptEvalCount int         `json:"prompt_eval_count,omitempty"`
	EvalCount       int         `json:"eval_count,omitempty"`
}

// ActiveProvider returns the active LLM provider ("agy", "ollama", or "") based on environment configuration.
func ActiveProvider() string {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv("LLM_PROVIDER")))
	switch raw {
	case "agy":
		return "agy"
	case "ollama":
		if strings.TrimSpace(os.Getenv("OLLAMA_API_KEY")) != "" {
			return "ollama"
		}
		return ""
	case "", "auto":
		if strings.TrimSpace(os.Getenv("AGY_ENDPOINT_URL")) != "" {
			return "agy"
		}
		if strings.TrimSpace(os.Getenv("OLLAMA_API_KEY")) != "" {
			return "ollama"
		}
		return ""
	default:
		return ""
	}
}

// IsConfigured reports whether an LLM provider (AGY gateway or Ollama Cloud) is configured.
func IsConfigured() bool {
	return ActiveProvider() != ""
}

// New creates a new LLM service instance for the active provider.
func New() (*Service, error) {
	provider := ActiveProvider()
	if provider == "" {
		rawProvider := strings.ToLower(strings.TrimSpace(os.Getenv("LLM_PROVIDER")))
		if rawProvider != "" && rawProvider != "auto" && rawProvider != "agy" && rawProvider != "ollama" {
			return nil, fmt.Errorf("%w: unsupported LLM_PROVIDER %q", ErrUnavailable, rawProvider)
		}
		if rawProvider == "ollama" {
			return nil, fmt.Errorf("%w: OLLAMA_API_KEY environment variable not set", ErrUnavailable)
		}
		return nil, fmt.Errorf("%w: no LLM provider configured (set AGY_ENDPOINT_URL or OLLAMA_API_KEY)", ErrUnavailable)
	}

	timeout := resolveTimeout()

	if provider == "agy" {
		host := normalizeHost(os.Getenv("AGY_ENDPOINT_URL"))
		if host == "" {
			host = defaultAGYEndpoint
		}
		model := strings.TrimSpace(os.Getenv("AGY_MODEL"))
		if model == "" {
			model = defaultAGYModel
		}
		effort := strings.TrimSpace(os.Getenv("AGY_EFFORT"))
		if effort == "" {
			effort = defaultAGYEffort
		}
		return &Service{
			client:   &http.Client{Timeout: timeout},
			provider: "agy",
			host:     host,
			apiKey:   resolveAGYToken(),
			model:    model,
			effort:   effort,
		}, nil
	}

	apiKey := strings.TrimSpace(os.Getenv("OLLAMA_API_KEY"))
	if apiKey == "" {
		return nil, fmt.Errorf("%w: OLLAMA_API_KEY environment variable not set", ErrUnavailable)
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
		client:   &http.Client{Timeout: timeout},
		provider: "ollama",
		host:     host,
		apiKey:   apiKey,
		model:    model,
	}, nil
}

func resolveTimeout() time.Duration {
	raw := strings.TrimSpace(os.Getenv("LLM_TIMEOUT_SECONDS"))
	if raw == "" {
		return defaultTimeoutSeconds * time.Second
	}
	secs, err := strconv.Atoi(raw)
	if err != nil || secs <= 0 {
		return defaultTimeoutSeconds * time.Second
	}
	if secs < minTimeoutSeconds {
		secs = minTimeoutSeconds
	}
	return time.Duration(secs) * time.Second
}

func resolveAGYToken() string {
	if apiKey := strings.TrimSpace(os.Getenv("AGY_API_KEY")); apiKey != "" {
		return apiKey
	}
	tokenPath := strings.TrimSpace(os.Getenv("AGY_TOKEN_PATH"))
	if tokenPath == "" {
		home, err := os.UserHomeDir()
		if err != nil || strings.TrimSpace(home) == "" {
			return ""
		}
		tokenPath = filepath.Join(home, ".config", "upwork-buddy", "agy-gateway-token")
	}
	data, err := os.ReadFile(tokenPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (s *Service) providerLabel() string {
	if s != nil && s.provider == "agy" {
		return "AGY"
	}
	return "Ollama Cloud"
}

// Close closes the service connection.
func (s *Service) Close() error {
	return nil
}

func (s *Service) doChat(ctx context.Context, req chatRequest) (*chatResponse, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to encode %s request: %w", s.providerLabel(), err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, s.host+"/api/chat", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("failed to create %s request: %w", s.providerLabel(), err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "application/json")
	if s.apiKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+s.apiKey)
	}

	resp, err := s.client.Do(httpReq)
	if err != nil {
		log.Printf("%s chat request failed: %v", s.providerLabel(), err)
		return nil, fmt.Errorf("failed to call %s API: %w", s.providerLabel(), err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s response: %w", s.providerLabel(), err)
	}

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		bodyStr := string(respBody)
		log.Printf("%s chat failed: status=%d body=%s", s.providerLabel(), resp.StatusCode, truncateForLog(bodyStr, 500))
		if strings.Contains(bodyStr, "AGY_AUTH_REQUIRED") || resp.StatusCode == http.StatusUnauthorized {
			return nil, fmt.Errorf("%w: %s API returned %s", ErrAuthRequired, s.providerLabel(), resp.Status)
		}
		if resp.StatusCode == http.StatusServiceUnavailable {
			return nil, fmt.Errorf("%w: %s API returned %s", ErrUnavailable, s.providerLabel(), resp.Status)
		}
		return nil, fmt.Errorf("%s API returned %s", s.providerLabel(), resp.Status)
	}

	var chatResp chatResponse
	if err := json.Unmarshal(respBody, &chatResp); err != nil {
		log.Printf("Failed to decode %s response: %v", s.providerLabel(), err)
		return nil, fmt.Errorf("failed to decode %s response: %w", s.providerLabel(), err)
	}
	if chatResp.Error != "" {
		log.Printf("%s response error: %s", s.providerLabel(), chatResp.Error)
		if strings.Contains(chatResp.Error, "AGY_AUTH_REQUIRED") {
			return nil, fmt.Errorf("%w: %s API error: %s", ErrAuthRequired, s.providerLabel(), chatResp.Error)
		}
		return nil, fmt.Errorf("%s API error: %s", s.providerLabel(), chatResp.Error)
	}

	return &chatResp, nil
}

// AnalyzeJob analyzes a job posting and generates a comprehensive response.
func (s *Service) AnalyzeJob(ctx context.Context, req JobAnalysisRequest) (*JobAnalysisResponse, error) {
	prompt := s.buildAnalysisPrompt(req)

	model := s.model
	if m := strings.TrimSpace(req.Model); m != "" {
		model = m
	}

	effort := ""
	if s.provider == "agy" {
		effort = s.effort
		if e := strings.TrimSpace(req.Effort); e != "" {
			effort = e
		}
	}

	log.Printf("%s analyze job request: title=%q contract_type=%q budget=%q skills=%q experience_level=%q model=%q effort=%q host=%q", s.providerLabel(), req.JobTitle, req.ContractType, req.Budget, req.Skills, req.ExperienceLevel, model, effort, s.host)
	log.Printf("Prompt length: %d characters", len(prompt))

	chatResp, err := s.doChat(ctx, chatRequest{
		Model:  model,
		Effort: effort,
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
		return nil, err
	}

	log.Printf("%s chat succeeded: model=%q created_at=%q content_length=%d", s.providerLabel(), chatResp.Model, chatResp.CreatedAt, len(chatResp.Message.Content))
	result := s.parseResponse(chatResp.Message.Content)
	respModel := strings.TrimSpace(chatResp.Model)
	if respModel == "" {
		respModel = model
	}
	result.Model = respModel
	result.Effort = resolveAppliedEffort(chatResp, s.provider, effort)
	result.Usage = extractTokenUsage(chatResp)
	log.Printf("Parsed analysis result: proposal length=%d execution_prompt length=%d", len(result.Proposal), len(result.ExecutionPrompt))
	return result, nil
}

func firstPositive(values ...int) int {
	for _, v := range values {
		if v > 0 {
			return v
		}
	}
	return 0
}

func extractTokenUsage(chatResp *chatResponse) *TokenUsage {
	if chatResp == nil {
		return nil
	}
	var in, out, thought, total int
	if chatResp.Usage != nil {
		in = firstPositive(chatResp.Usage.InputTokens, chatResp.Usage.InputTokensSnake)
		out = firstPositive(chatResp.Usage.OutputTokens, chatResp.Usage.OutputTokensSnake)
		thought = firstPositive(chatResp.Usage.ThoughtTokens, chatResp.Usage.ThoughtTokensSnake)
		total = firstPositive(chatResp.Usage.TotalTokens, chatResp.Usage.TotalTokensSnake)
	}
	if in == 0 && chatResp.PromptEvalCount > 0 {
		in = chatResp.PromptEvalCount
	}
	if out == 0 && chatResp.EvalCount > 0 {
		out = chatResp.EvalCount
	}
	if total == 0 {
		total = in + out + thought
	}
	if in == 0 && out == 0 && thought == 0 && total == 0 {
		return nil
	}
	return &TokenUsage{
		InputTokens:   in,
		OutputTokens:  out,
		ThoughtTokens: thought,
		TotalTokens:   total,
	}
}

func resolveAppliedEffort(chatResp *chatResponse, provider, requestedEffort string) string {
	if chatResp != nil {
		if e := strings.TrimSpace(chatResp.AppliedEffort); e != "" {
			return e
		}
		if chatResp.EffortApplied != nil && !*chatResp.EffortApplied {
			return ""
		}
	}
	if provider == "agy" {
		return requestedEffort
	}
	return ""
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

	var extraContext strings.Builder
	hasVisibleActiveProjects := false
	for _, proj := range req.ActiveProjects {
		if !strings.EqualFold(strings.TrimSpace(proj.Visibility), "private") {
			hasVisibleActiveProjects = true
			break
		}
	}
	if len(req.PortfolioItems) > 0 || hasVisibleActiveProjects {
		extraContext.WriteString("\nRELEVANT PORTFOLIO & ACTIVE WORK:\n")
		extraContext.WriteString("Use these relevant examples to strengthen the proposal where helpful. For any entry tagged [ANONYMIZED/NDA], NEVER disclose client names, company names, or internal repo paths — describe capabilities and architecture patterns generically.\n")
		for _, item := range req.PortfolioItems {
			title := strings.TrimSpace(item.Title)
			if title == "" {
				continue
			}
			extraContext.WriteString("- [PORTFOLIO] ")
			extraContext.WriteString(title)
			if link := strings.TrimSpace(item.Link); link != "" {
				extraContext.WriteString(" (")
				extraContext.WriteString(link)
				extraContext.WriteString(")")
			}
			if desc := strings.TrimSpace(item.Description); desc != "" {
				extraContext.WriteString(": ")
				extraContext.WriteString(desc)
			}
			extraContext.WriteByte('\n')
		}
		for _, proj := range req.ActiveProjects {
			vis := strings.TrimSpace(proj.Visibility)
			if strings.EqualFold(vis, "private") {
				continue
			}
			display := strings.TrimSpace(proj.DisplayName)
			if display == "" {
				display = "Active client project"
			}
			tag := "[ANONYMIZED/NDA]"
			if strings.EqualFold(vis, "public") {
				tag = "[PUBLIC]"
			}
			extraContext.WriteString("- ")
			extraContext.WriteString(tag)
			extraContext.WriteByte(' ')
			extraContext.WriteString(display)
			if tier := strings.TrimSpace(proj.ActivityTier); tier != "" {
				extraContext.WriteString(" (")
				extraContext.WriteString(tier)
				extraContext.WriteString(")")
			}
			if len(proj.TechStack) > 0 {
				extraContext.WriteString(" [")
				extraContext.WriteString(strings.Join(proj.TechStack, ", "))
				extraContext.WriteString("]")
			}
			if summary := strings.TrimSpace(proj.Summary); summary != "" {
				extraContext.WriteString(": ")
				extraContext.WriteString(summary)
			}
			if tag == "[PUBLIC]" {
				if focus := strings.TrimSpace(proj.RecentFocus); focus != "" {
					extraContext.WriteString(" | Recent focus: ")
					extraContext.WriteString(focus)
				}
			}
			extraContext.WriteByte('\n')
		}
	}

	if workload := strings.TrimSpace(req.WorkloadSummary); workload != "" {
		extraContext.WriteString("\nCURRENT WORKLOAD CONTEXT:\n")
		extraContext.WriteString(workload)
		extraContext.WriteString("\nFactor this concurrent project load into a realistic time_estimate and practical tips_and_advice (e.g., buffer, milestone pacing, capacity).\n")
	}

	var detailLines strings.Builder
	if v := strings.TrimSpace(req.Duration); v != "" {
		detailLines.WriteString("\nDuration: ")
		detailLines.WriteString(v)
	}
	if v := strings.TrimSpace(req.HoursPerWeek); v != "" {
		detailLines.WriteString("\nHours Per Week: ")
		detailLines.WriteString(v)
	}
	if v := strings.TrimSpace(req.ProposalsTier); v != "" {
		detailLines.WriteString("\nProposals: ")
		detailLines.WriteString(v)
	}
	if v := strings.TrimSpace(req.ClientCountry); v != "" {
		detailLines.WriteString("\nClient Country: ")
		detailLines.WriteString(v)
	}
	if v := strings.TrimSpace(req.ClientSpent); v != "" {
		detailLines.WriteString("\nClient Spent: ")
		detailLines.WriteString(v)
	}
	if req.ClientHireRate != nil {
		detailLines.WriteString("\nClient Hire Rate: ")
		detailLines.WriteString(strconv.FormatFloat(*req.ClientHireRate, 'f', -1, 64))
		detailLines.WriteByte('%')
	}
	cleanQuestions := make([]string, 0, len(req.ScreeningQuestions))
	for _, q := range req.ScreeningQuestions {
		if trimmed := strings.TrimSpace(q); trimmed != "" {
			cleanQuestions = append(cleanQuestions, trimmed)
		}
	}
	if len(cleanQuestions) > 0 {
		detailLines.WriteString("\nScreening Questions:")
		for _, q := range cleanQuestions {
			detailLines.WriteString("\n- ")
			detailLines.WriteString(q)
		}
	}

	return fmt.Sprintf(`You are an expert freelance consultant helping contractors on Upwork create winning proposals and project plans.

JOB POSTING:
Title: %s
Description: %s
Contract Type: %s
Budget: %s
Required Skills: %s
Experience Level: %s%s

CONTRACTOR PROFILE:
Profile: %s
Skills: %s
%s
Please provide a comprehensive analysis with the following sections:

1. PROPOSAL (2-3 paragraphs)
Write a compelling, professional yet relatable proposal that:
- Demonstrates understanding of the project requirements
- Highlights relevant experience and skills
- Shows enthusiasm and reliability
- Uses a tone that matches the job posting's formality level

2. EXECUTION PROMPT
Write a self-contained, copy-paste-ready prompt for an AI coding agent (Claude Code, Codex, Goose, etc.) that will execute this project end-to-end. Keep execution_prompt concise (under ~6,000 characters). The prompt must include:
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

Do not call any tools. Return valid JSON only, with these exact keys (strictly JSON-escape all double quotes as \", backslashes as \\, and newlines as \n inside JSON string values; prefer single quotes or backticks inside markdown prose):
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
		detailLines.String(),
		req.UserProfile,
		req.UserSkills,
		extraContext.String(),
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

		if repaired := repairMalformedJSON(fullText); repaired != "" && repaired != fullText {
			var repairedResult JobAnalysisResponse
			if errRepair := json.Unmarshal([]byte(repaired), &repairedResult); errRepair == nil {
				log.Printf("parseResponse: ✅ json.Unmarshal succeeded after repairMalformedJSON")
				return &repairedResult
			}
			log.Printf("parseResponse: ⚠️ repairMalformedJSON did not yield valid JSON")
		}

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

type jsonContainer struct {
	kind      byte // '{' or '['
	expectKey bool
}

// repairMalformedJSON extracts the outermost JSON object and escapes unescaped
// interior double quotes and raw control characters inside JSON string values.
func repairMalformedJSON(raw string) string {
	start := strings.IndexByte(raw, '{')
	end := strings.LastIndexByte(raw, '}')
	if start == -1 || end <= start {
		return ""
	}
	s := raw[start : end+1]

	var out strings.Builder
	out.Grow(len(s) + 64)

	var stack []jsonContainer
	inString := false
	escaped := false
	stringIsKey := false

	for i := 0; i < len(s); i++ {
		b := s[i]
		if inString {
			if escaped {
				out.WriteByte(b)
				escaped = false
				continue
			}
			switch b {
			case '\\':
				out.WriteByte(b)
				escaped = true
			case '\n':
				out.WriteString(`\n`)
			case '\r':
				out.WriteString(`\r`)
			case '\t':
				out.WriteString(`\t`)
			case '"':
				if isValidClosingQuote(s, i, stringIsKey, stack) {
					out.WriteByte('"')
					inString = false
					stringIsKey = false
				} else {
					out.WriteString(`\"`)
				}
			default:
				if b < 0x20 {
					fmt.Fprintf(&out, `\u%04x`, b)
				} else {
					out.WriteByte(b)
				}
			}
			continue
		}

		out.WriteByte(b)
		switch b {
		case '{':
			stack = append(stack, jsonContainer{kind: '{', expectKey: true})
		case '[':
			stack = append(stack, jsonContainer{kind: '['})
		case '}', ']':
			if len(stack) > 0 {
				stack = stack[:len(stack)-1]
			}
		case ':':
			if len(stack) > 0 && stack[len(stack)-1].kind == '{' {
				stack[len(stack)-1].expectKey = false
			}
		case ',':
			if len(stack) > 0 && stack[len(stack)-1].kind == '{' {
				stack[len(stack)-1].expectKey = true
			}
		case '"':
			inString = true
			escaped = false
			stringIsKey = len(stack) > 0 && stack[len(stack)-1].kind == '{' && stack[len(stack)-1].expectKey
		}
	}

	return out.String()
}

func skipJSONWhitespace(s string, idx int) int {
	for idx < len(s) {
		switch s[idx] {
		case ' ', '\t', '\n', '\r':
			idx++
		default:
			return idx
		}
	}
	return idx
}

func isValidClosingQuote(s string, quoteIdx int, stringIsKey bool, stack []jsonContainer) bool {
	nextIdx := skipJSONWhitespace(s, quoteIdx+1)
	if nextIdx >= len(s) {
		return false
	}
	nextByte := s[nextIdx]

	if stringIsKey {
		return nextByte == ':'
	}

	var topKind byte
	if len(stack) > 0 {
		topKind = stack[len(stack)-1].kind
	}

	switch nextByte {
	case '}':
		if topKind != '{' {
			return false
		}
		afterClose := skipJSONWhitespace(s, nextIdx+1)
		if len(stack) == 1 {
			return afterClose == len(s)
		}
		return afterClose < len(s) && (s[afterClose] == ',' || s[afterClose] == '}' || s[afterClose] == ']')
	case ']':
		if topKind != '[' {
			return false
		}
		afterClose := skipJSONWhitespace(s, nextIdx+1)
		if len(stack) == 1 {
			return afterClose == len(s)
		}
		return afterClose < len(s) && (s[afterClose] == ',' || s[afterClose] == '}' || s[afterClose] == ']')
	case ',':
		afterComma := skipJSONWhitespace(s, nextIdx+1)
		if afterComma >= len(s) {
			return false
		}
		afterByte := s[afterComma]
		if topKind == '{' {
			// Next token in a JSON object must be a quoted key followed by ':'.
			return looksLikeJSONKeyAt(s, afterComma)
		}
		if topKind == '[' {
			// Next token in a JSON array must start a valid JSON value (or closing ']').
			if afterByte == '"' || afterByte == '{' || afterByte == '[' ||
				afterByte == ']' || afterByte == '-' || (afterByte >= '0' && afterByte <= '9') {
				return true
			}
			for _, kw := range []string{"true", "false", "null"} {
				if strings.HasPrefix(s[afterComma:], kw) {
					endKw := afterComma + len(kw)
					if endKw == len(s) || s[endKw] == ',' || s[endKw] == ']' ||
						s[endKw] == ' ' || s[endKw] == '\t' || s[endKw] == '\n' || s[endKw] == '\r' {
						return true
					}
				}
			}
			return false
		}
		return false
	default:
		return false
	}
}

func looksLikeJSONKeyAt(s string, idx int) bool {
	if idx >= len(s) || s[idx] != '"' {
		return false
	}
	esc := false
	for i := idx + 1; i < len(s); i++ {
		b := s[i]
		if esc {
			esc = false
			continue
		}
		if b == '\\' {
			esc = true
			continue
		}
		if b == '\n' || b == '\r' {
			return false
		}
		if b == '"' {
			afterKey := skipJSONWhitespace(s, i+1)
			return afterKey < len(s) && s[afterKey] == ':'
		}
	}
	return false
}
