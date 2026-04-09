package ollama

import "testing"

func TestParseResponseMarkdownWrappedJSON(t *testing.T) {
	service := &Service{}

	result := service.parseResponse("```json\n{\n  \"proposal\": \"Hello\",\n  \"spec_sheet_prompt\": \"Build it\",\n  \"time_estimate\": \"10 hours\",\n  \"workload_division\": \"50/50\",\n  \"questions_for_client\": [\"Question 1\"],\n  \"tips_and_advice\": [\"Tip 1\"],\n  \"tone_analysis\": \"Professional\"\n}\n```")

	if result.Proposal != "Hello" {
		t.Fatalf("expected proposal to be parsed, got %q", result.Proposal)
	}
	if len(result.QuestionsForClient) != 1 {
		t.Fatalf("expected one client question, got %d", len(result.QuestionsForClient))
	}
	if result.ToneAnalysis != "Professional" {
		t.Fatalf("expected tone analysis to be parsed, got %q", result.ToneAnalysis)
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
