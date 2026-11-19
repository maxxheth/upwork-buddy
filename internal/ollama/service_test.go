package ollama

import (
	"strings"
	"testing"
)

func TestParseResponseMarkdownWrappedJSON(t *testing.T) {
	service := &Service{}

	result := service.parseResponse("```json\n{\n  \"proposal\": \"Hello\",\n  \"execution_prompt\": \"Build it\",\n  \"time_estimate\": \"10 hours\",\n  \"workload_division\": \"50/50\",\n  \"questions_for_client\": [\"Question 1\"],\n  \"tips_and_advice\": [\"Tip 1\"],\n  \"tone_analysis\": \"Professional\"\n}\n```")

	if result.Proposal != "Hello" {
		t.Fatalf("expected proposal to be parsed, got %q", result.Proposal)
	}
	if result.ExecutionPrompt != "Build it" {
		t.Fatalf("expected execution prompt to be parsed, got %q", result.ExecutionPrompt)
	}
	if len(result.QuestionsForClient) != 1 {
		t.Fatalf("expected one client question, got %d", len(result.QuestionsForClient))
	}
	if len(result.TipsAndAdvice) != 1 {
		t.Fatalf("expected one tip, got %d", len(result.TipsAndAdvice))
	}
	if result.ToneAnalysis != "Professional" {
		t.Fatalf("expected tone analysis to be parsed, got %q", result.ToneAnalysis)
	}
}

func TestParseResponseStructuredTimeEstimateAndWorkloadDivision(t *testing.T) {
	service := &Service{}

	result := service.parseResponse(`{
  "proposal": "Structured proposal",
  "execution_prompt": "Execute step by step",
  "time_estimate": {"total_hours": 24, "phases": ["Setup", "Build"]},
  "workload_division": {"ai_percent": 70, "human_percent": 30},
  "questions_for_client": ["What is the target launch date?"],
  "tips_and_advice": ["Set weekly milestones"],
  "tone_analysis": "Technical"
}`)

	if result.ExecutionPrompt != "Execute step by step" {
		t.Fatalf("expected execution prompt, got %q", result.ExecutionPrompt)
	}
	if !strings.Contains(string(result.TimeEstimate), `"total_hours"`) {
		t.Fatalf("expected structured time_estimate JSON, got %s", string(result.TimeEstimate))
	}
	if !strings.Contains(string(result.WorkloadDivision), `"ai_percent"`) {
		t.Fatalf("expected structured workload_division JSON, got %s", string(result.WorkloadDivision))
	}
}

func TestParseResponseInvalidJSONFallsBackToRawText(t *testing.T) {
	service := &Service{}

	result := service.parseResponse("this is not valid json")

	if result.Proposal != "this is not valid json" {
		t.Fatalf("expected raw text fallback, got %q", result.Proposal)
	}
	if result.ExecutionPrompt == "" {
		t.Fatal("expected fallback execution prompt message")
	}
}

func TestNormalizeHost(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "local host without scheme", in: "0.0.0.0:11434", want: "http://0.0.0.0:11434"},
		{name: "localhost without scheme", in: "localhost:11434/", want: "http://localhost:11434"},
		{name: "https host preserved", in: "https://ollama.com/", want: "https://ollama.com"},
		{name: "http host preserved", in: "http://127.0.0.1:11434", want: "http://127.0.0.1:11434"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeHost(tt.in); got != tt.want {
				t.Fatalf("normalizeHost(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}
