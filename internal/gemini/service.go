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
	Proposal           string          `json:"proposal"`
	SpecSheetPrompt    string          `json:"spec_sheet_prompt"`
	TimeEstimate       json.RawMessage `json:"time_estimate"`     // Can be string or object
	WorkloadDivision   json.RawMessage `json:"workload_division"` // Can be string or object
	QuestionsForClient []string        `json:"questions_for_client"`
	TipsAndAdvice      []string        `json:"tips_and_advice"`
	ToneAnalysis       string          `json:"tone_analysis"`
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

	// Log the raw response for debugging
	if len(fullText) > 0 {
		preview := fullText
		if len(preview) > 500 {
			preview = preview[:500] + "..."
		}
		log.Printf("parseResponse: RAW RESPONSE START\n%s\nparseResponse: RAW RESPONSE END", preview)
	}

	// Strip markdown code block if present
	fullText = strings.TrimSpace(fullText)
	originalLength := len(fullText)

	// Remove ```json and ``` wrappers
	jsonBlockRegex := regexp.MustCompile("(?s)^```(?:json)?\\s*\\n?(.*?)\\n?```$")
	if matches := jsonBlockRegex.FindStringSubmatch(fullText); len(matches) > 1 {
		fullText = strings.TrimSpace(matches[1])
		log.Printf("parseResponse: stripped markdown wrapper (before=%d, after=%d)", originalLength, len(fullText))
		preview := fullText
		if len(preview) > 300 {
			preview = preview[:300] + "..."
		}
		log.Printf("parseResponse: STRIPPED JSON START\n%s\nparseResponse: STRIPPED JSON END", preview)
	}

	// Try to parse as JSON directly
	var result JobAnalysisResponse
	if err := json.Unmarshal([]byte(fullText), &result); err == nil {
		log.Printf("parseResponse: ✅ json.Unmarshal succeeded")
		log.Printf("parseResponse: proposal length=%d, spec_sheet length=%d, questions=%d, tips=%d",
			len(result.Proposal), len(result.SpecSheetPrompt),
			len(result.QuestionsForClient), len(result.TipsAndAdvice))

		// If the proposal field contains JSON-like content, it might be double-encoded
		// Check if proposal starts with { and try to re-parse
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

		// Try to identify the specific JSON error location
		if syntaxErr, ok := err.(*json.SyntaxError); ok {
			log.Printf("parseResponse: JSON syntax error at byte offset %d", syntaxErr.Offset)
			// Show context around the error
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

		preview := fullText
		if len(preview) > 500 {
			preview = preview[:500] + "..."
		}
		log.Printf("parseResponse: FAILED JSON CONTENT START\n%s\nparseResponse: FAILED JSON CONTENT END", preview)

		return &JobAnalysisResponse{
			Proposal:           fullText,
			SpecSheetPrompt:    "Failed to parse response. Please check the API server logs.",
			TimeEstimate:       json.RawMessage(`""`),
			WorkloadDivision:   json.RawMessage(`""`),
			QuestionsForClient: []string{},
			TipsAndAdvice:      []string{},
			ToneAnalysis:       "",
		}
	}
}
