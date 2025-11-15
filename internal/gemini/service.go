package gemini

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"strings"

	"google.golang.org/genai"
)

// Service handles interactions with Google's Gemini AI
type Service struct {
	client *genai.Client
	model  string
}

// JobAnalysisRequest contains the job posting and user profile
type JobAnalysisRequest struct {
	JobTitle       string `json:"job_title"`
	JobDescription string `json:"job_description"`
	Budget         string `json:"budget,omitempty"`
	Skills         string `json:"skills,omitempty"`
	UserProfile    string `json:"user_profile"`
	UserSkills     string `json:"user_skills"`
}

// JobAnalysisResponse contains the AI-generated analysis
type JobAnalysisResponse struct {
	Proposal           string   `json:"proposal"`
	SpecSheetPrompt    string   `json:"spec_sheet_prompt"`
	TimeEstimate       string   `json:"time_estimate"`
	WorkloadDivision   string   `json:"workload_division"`
	QuestionsForClient []string `json:"questions_for_client"`
	TipsAndAdvice      []string `json:"tips_and_advice"`
	ToneAnalysis       string   `json:"tone_analysis"`
}

// New creates a new Gemini service instance
func New() (*Service, error) {
	apiKey := os.Getenv("GEMINI_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("GEMINI_API_KEY environment variable not set")
	}

	ctx := context.Background()
	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  apiKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create Gemini client: %w", err)
	}

	return &Service{
		client: client,
		model:  "gemini-2.0-flash-exp", // Using the latest model
	}, nil
}

// Close closes the Gemini client connection
func (s *Service) Close() error {
	// The genai.Client doesn't have a Close method in this version
	return nil
}

// AnalyzeJob analyzes a job posting and generates a comprehensive response
func (s *Service) AnalyzeJob(ctx context.Context, req JobAnalysisRequest) (*JobAnalysisResponse, error) {
	prompt := s.buildAnalysisPrompt(req)
	log.Printf("Gemini analyze job request: title=%q budget=%q skills=%q", req.JobTitle, req.Budget, req.Skills)
	log.Printf("Prompt length: %d characters", len(prompt))

	resp, err := s.client.Models.GenerateContent(ctx, s.model, []*genai.Content{
		{
			Role: "user",
			Parts: []*genai.Part{
				{Text: prompt},
			},
		},
	}, nil)
	if err != nil {
		log.Printf("GenerateContent failed: %v", err)
		return nil, fmt.Errorf("failed to generate content: %w", err)
	}

	// Parse the response
	log.Printf("GenerateContent succeeded: %d candidates", len(resp.Candidates))
	result := s.parseResponse(resp)
	log.Printf("Parsed analysis result: proposal length=%d spec_sheet length=%d", len(result.Proposal), len(result.SpecSheetPrompt))
	return result, nil
}

// buildAnalysisPrompt constructs the comprehensive prompt for the AI
func (s *Service) buildAnalysisPrompt(req JobAnalysisRequest) string {
	return fmt.Sprintf(`You are an expert freelance consultant helping contractors on Upwork create winning proposals and project plans.

JOB POSTING:
Title: %s
Description: %s
Budget: %s
Required Skills: %s

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

2. SPEC SHEET PROMPT
Create a detailed prompt that can be used with AI coding agents (GitHub Copilot, Jules, etc.) to generate a technical specification document. This prompt should include:
- Project requirements breakdown
- Technical architecture considerations
- Implementation approach
- Key deliverables
- Testing and QA requirements

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

Format your response as JSON with these exact keys:
{
  "proposal": "...",
  "spec_sheet_prompt": "...",
  "time_estimate": "...",
  "workload_division": "...",
  "questions_for_client": ["...", "..."],
  "tips_and_advice": ["...", "..."],
  "tone_analysis": "..."
}`,
		req.JobTitle,
		req.JobDescription,
		req.Budget,
		req.Skills,
		req.UserProfile,
		req.UserSkills,
	)
}

// parseResponse parses the AI response into structured data
func (s *Service) parseResponse(resp *genai.GenerateContentResponse) *JobAnalysisResponse {
	// Extract text from response
	var fullText string
	var candidateCount int
	for _, candidate := range resp.Candidates {
		candidateCount++
		if candidate.Content != nil {
			for _, part := range candidate.Content.Parts {
				if part.Text != "" {
					fullText += part.Text
				}
			}
		}
	}
	log.Printf("parseResponse: collected text length=%d from %d candidates", len(fullText), candidateCount)

	// Strip markdown code block if present
	fullText = strings.TrimSpace(fullText)

	// Remove ```json and ``` wrappers
	jsonBlockRegex := regexp.MustCompile("(?s)^```(?:json)?\\s*\\n?(.*?)\\n?```$")
	if matches := jsonBlockRegex.FindStringSubmatch(fullText); len(matches) > 1 {
		fullText = strings.TrimSpace(matches[1])
		preview := fullText
		if len(preview) > 200 {
			preview = preview[:200]
		}
		log.Printf("parseResponse: stripped markdown, snippet=%q", preview)
	}

	// Try to parse as JSON directly
	var result JobAnalysisResponse
	if err := json.Unmarshal([]byte(fullText), &result); err == nil {
		log.Printf("parseResponse: json.Unmarshal succeeded")
		// If the proposal field contains JSON-like content, it might be double-encoded
		// Check if proposal starts with { and try to re-parse
		if strings.HasPrefix(strings.TrimSpace(result.Proposal), "{") {
			var innerResult JobAnalysisResponse
			if err2 := json.Unmarshal([]byte(result.Proposal), &innerResult); err2 == nil {
				log.Printf("parseResponse: proposal contained nested JSON, reused inner result")
				return &innerResult
			}
		}
		return &result
	}

	preview := fullText
	if len(preview) > 200 {
		preview = preview[:200]
	}
	log.Printf("parseResponse: json.Unmarshal failed, returning raw text snippet=%q", preview)
	return &JobAnalysisResponse{
		Proposal:           fullText,
		SpecSheetPrompt:    "Failed to parse response. Please check the API server logs.",
		TimeEstimate:       "",
		WorkloadDivision:   "",
		QuestionsForClient: []string{},
		TipsAndAdvice:      []string{},
		ToneAnalysis:       "",
	}
}
