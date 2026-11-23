package ollama

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newMockLLMService(t *testing.T, handler func(req chatRequest) chatResponse) *Service {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/chat" {
			http.NotFound(w, r)
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp := handler(req)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)

	return &Service{
		client:   srv.Client(),
		provider: "agy",
		host:     srv.URL,
		model:    "gemini-test",
		effort:   "low",
	}
}

func TestDraftFastProposal_GoNoGoAndConfidenceClamp(t *testing.T) {
	// 1. "no-go" variant + confidence > 1.0 clamped to 1.0
	svc := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Model: "gemini-test",
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "no-go",
					"confidence": 1.45,
					"reject_reason": "Budget too low",
					"cover_letter": "",
					"bid_type": "fixed",
					"bid_amount": 500
				}`,
			},
		}
	})

	res, err := svc.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Cheap Site",
		JobDescription: "Build Amazon clone for $50",
		UserProfile:    "Senior Go Engineer",
		UserSkills:     "Go, Postgres",
	})
	if err != nil {
		t.Fatalf("DraftFastProposal failed: %v", err)
	}
	if res.GoNoGo != "no_go" {
		t.Fatalf("GoNoGo = %q, want 'no_go'", res.GoNoGo)
	}
	if res.Confidence != 1.0 {
		t.Fatalf("Confidence = %v, want 1.0", res.Confidence)
	}

	// 2. "go" + negative confidence clamped to 0.0
	svc2 := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Model: "gemini-test",
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "GO",
					"confidence": -0.2,
					"cover_letter": "I can build this Go API cleanly.",
					"bid_type": "hourly",
					"bid_amount": 95
				}`,
			},
		}
	})

	res2, err := svc2.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Go API",
		JobDescription: "Build a Go REST API",
		UserProfile:    "Senior Go Engineer",
		UserSkills:     "Go, Postgres",
	})
	if err != nil {
		t.Fatalf("DraftFastProposal 2 failed: %v", err)
	}
	if res2.GoNoGo != "go" {
		t.Fatalf("GoNoGo = %q, want 'go'", res2.GoNoGo)
	}
	if res2.Confidence != 0.0 {
		t.Fatalf("Confidence = %v, want 0.0", res2.Confidence)
	}
}

func TestDraftFastProposal_TrapPromptAndConfidentialityRules(t *testing.T) {
	var capturedPrompt string
	svc := newMockLLMService(t, func(req chatRequest) chatResponse {
		if len(req.Messages) > 0 {
			capturedPrompt = req.Messages[0].Content
		}
		if req.Stream || req.Format != "json" {
			t.Fatalf("expected Stream=false Format='json', got Stream=%v Format=%q", req.Stream, req.Format)
		}
		return chatResponse{
			Model: "gemini-test",
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.92,
					"cover_letter": "BLUEPRINT — I noticed your Go backend needs zero-downtime Postgres migrations...",
					"bid_type": "hourly",
					"bid_amount": 110,
					"detected_trap_instruction": "start your proposal with BLUEPRINT"
				}`,
			},
			Usage: &chatUsage{InputTokens: 100, OutputTokens: 80, TotalTokens: 180},
		}
	})

	res, err := svc.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Go + Postgres Migration",
		JobDescription: "Please start your proposal with BLUEPRINT so we know you read this.",
		UserProfile:    "Staff Backend Engineer",
		UserSkills:     "Go, PostgreSQL",
		ActiveProjects: []ActiveProjectContext{
			{
				DisplayName: "Stealth Fintech Ledger",
				Visibility:  "anonymized",
				Summary:     "High-throughput ledger",
				TechStack:   []string{"Go", "Postgres"},
			},
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal failed: %v", err)
	}
	for _, want := range []string{"120-220 words", "Do NOT generate an execution prompt", "TRAP / SECRET WORD CHECK", "[ANONYMIZED/NDA]"} {
		if !strings.Contains(capturedPrompt, want) {
			t.Fatalf("prompt missing required instruction %q", want)
		}
	}
	if res.DetectedTrapInstruction != "start your proposal with BLUEPRINT" {
		t.Fatalf("DetectedTrapInstruction = %q, want 'start your proposal with BLUEPRINT'", res.DetectedTrapInstruction)
	}
	if res.Usage == nil || res.Usage.TotalTokens != 180 {
		t.Fatalf("expected Usage.TotalTokens=180, got %+v", res.Usage)
	}
}

func TestDraftFastProposal_BidClampingAndDefaults(t *testing.T) {
	minBid := 500.0
	maxBid := 2500.0
	mult := 0.8
	hourly := 95.0

	// 1. Clamp above MaxFixedBid
	svcHigh := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.9,
					"cover_letter": "Solid fit.",
					"bid_type": "fixed",
					"bid_amount": 5000
				}`,
			},
		}
	})
	resHigh, err := svcHigh.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Fixed Project",
		JobDescription: "Build service",
		ContractType:   "fixed",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		BidStrategy: &BidStrategy{
			MinFixedBid: &minBid,
			MaxFixedBid: &maxBid,
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal high failed: %v", err)
	}
	if resHigh.BidAmount == nil || *resHigh.BidAmount != maxBid {
		t.Fatalf("BidAmount = %v, want clamped %v", resHigh.BidAmount, maxBid)
	}

	// 2. Clamp below MinFixedBid
	svcLow := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.9,
					"cover_letter": "Solid fit.",
					"bid_type": "fixed",
					"bid_amount": 100
				}`,
			},
		}
	})
	resLow, err := svcLow.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Fixed Project",
		JobDescription: "Build service",
		ContractType:   "fixed",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		BidStrategy: &BidStrategy{
			MinFixedBid: &minBid,
			MaxFixedBid: &maxBid,
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal low failed: %v", err)
	}
	if resLow.BidAmount == nil || *resLow.BidAmount != minBid {
		t.Fatalf("BidAmount = %v, want clamped %v", resLow.BidAmount, minBid)
	}

	// 3. Omitted bid_type and bid_amount computed from BidStrategy + job budget
	svcDefaultFixed := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.88,
					"cover_letter": "Solid fit."
				}`,
			},
		}
	})
	resDefFixed, err := svcDefaultFixed.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Fixed Project",
		JobDescription: "Build service",
		ContractType:   "fixed",
		Budget:         "$2,000",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		BidStrategy: &BidStrategy{
			FixedMultiplier: &mult,
			MinFixedBid:     &minBid,
			MaxFixedBid:     &maxBid,
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal default fixed failed: %v", err)
	}
	if resDefFixed.BidType != "fixed" || resDefFixed.BidAmount == nil || *resDefFixed.BidAmount != 1600 {
		t.Fatalf("expected fixed 1600, got type=%q amount=%v", resDefFixed.BidType, resDefFixed.BidAmount)
	}

	// 4. Omitted hourly bid_amount uses BidStrategy.HourlyRate
	resDefHourly, err := svcDefaultFixed.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Hourly Project",
		JobDescription: "Ongoing Go work",
		ContractType:   "hourly",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		BidStrategy: &BidStrategy{
			HourlyRate: &hourly,
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal default hourly failed: %v", err)
	}
	if resDefHourly.BidType != "hourly" || resDefHourly.BidAmount == nil || *resDefHourly.BidAmount != hourly {
		t.Fatalf("expected hourly %v, got type=%q amount=%v", hourly, resDefHourly.BidType, resDefHourly.BidAmount)
	}
}

func TestDraftFastProposal_ScreeningAmbiguityDetection(t *testing.T) {
	// Case 1: Required question has confident=false -> HasAmbiguousScreening = true
	svcAmbig := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.87,
					"cover_letter": "Great fit.",
					"bid_type": "hourly",
					"bid_amount": 90,
					"screening_answers": [
						{"index": 0, "prompt": "Do you have HIPAA clearance?", "answer": "Unclear", "confident": false}
					]
				}`,
			},
		}
	})
	resAmbig, err := svcAmbig.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Healthcare API",
		JobDescription: "Need HIPAA API",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		ScreeningQuestions: []FastScreeningQuestion{
			{Index: 0, Prompt: "Do you have HIPAA clearance?", Required: true},
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal ambig failed: %v", err)
	}
	if !resAmbig.HasAmbiguousScreening {
		t.Fatal("expected HasAmbiguousScreening=true when required question has confident=false")
	}

	// Case 2: Required question missing answer -> HasAmbiguousScreening = true
	svcMissing := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.9,
					"cover_letter": "Great fit.",
					"bid_type": "hourly",
					"bid_amount": 90,
					"screening_answers": []
				}`,
			},
		}
	})
	resMissing, err := svcMissing.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Healthcare API",
		JobDescription: "Need HIPAA API",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		ScreeningQuestions: []FastScreeningQuestion{
			{Index: 0, Prompt: "Do you have HIPAA clearance?", Required: true},
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal missing failed: %v", err)
	}
	if !resMissing.HasAmbiguousScreening {
		t.Fatal("expected HasAmbiguousScreening=true when required question answer is missing")
	}

	// Case 3: Required question confident=true, optional question confident=false -> HasAmbiguousScreening = false
	svcOptionalOnly := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Message: chatMessage{
				Role: "assistant",
				Content: `{
					"go_no_go": "go",
					"confidence": 0.91,
					"cover_letter": "Great fit.",
					"bid_type": "hourly",
					"bid_amount": 90,
					"screening_answers": [
						{"index": 0, "prompt": "Years of Go?", "answer": "8 years", "confident": true},
						{"index": 1, "prompt": "Optional timezone note?", "answer": "Maybe", "confident": false}
					]
				}`,
			},
		}
	})
	resOpt, err := svcOptionalOnly.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Go API",
		JobDescription: "Build Go API",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
		ScreeningQuestions: []FastScreeningQuestion{
			{Index: 0, Prompt: "Years of Go?", Required: true},
			{Index: 1, Prompt: "Optional timezone note?", Required: false},
		},
	})
	if err != nil {
		t.Fatalf("DraftFastProposal optional failed: %v", err)
	}
	if resOpt.HasAmbiguousScreening {
		t.Fatal("expected HasAmbiguousScreening=false when only optional question is low confidence")
	}
}

func TestDraftFastProposal_MalformedJSONRepair(t *testing.T) {
	// Markdown fence + unescaped interior double quotes inside cover_letter
	raw := "```json\n" +
		`{"go_no_go": "go", "confidence": 0.89, "cover_letter": "We built a "zero-downtime" pipeline in Go.", "bid_type": "fixed", "bid_amount": 1200}` +
		"\n```"

	svc := newMockLLMService(t, func(req chatRequest) chatResponse {
		return chatResponse{
			Model: "gemini-test",
			Message: chatMessage{
				Role:    "assistant",
				Content: raw,
			},
		}
	})

	res, err := svc.DraftFastProposal(context.Background(), FastProposalRequest{
		JobTitle:       "Pipeline",
		JobDescription: "Build pipeline",
		UserProfile:    "Go dev",
		UserSkills:     "Go",
	})
	if err != nil {
		t.Fatalf("DraftFastProposal malformed JSON repair failed: %v", err)
	}
	if res.GoNoGo != "go" || !strings.Contains(res.CoverLetter, "zero-downtime") {
		t.Fatalf("unexpected repaired response: %+v", res)
	}
	if res.BidAmount == nil || *res.BidAmount != 1200 {
		t.Fatalf("expected BidAmount=1200, got %v", res.BidAmount)
	}
}
