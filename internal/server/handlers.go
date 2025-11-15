package server

import (
	"encoding/json"
	"log"
	"net/http"

	"upwork-buddy/internal/gemini"
)

// analyzeJobHandler handles POST /api/analyze-job requests
func (s *Server) analyzeJobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req gemini.JobAnalysisRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	// Create Gemini service
	geminiService, err := gemini.New()
	if err != nil {
		log.Printf("Failed to create Gemini service: %v", err)
		http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
		return
	}
	defer geminiService.Close()

	// Analyze the job
	result, err := geminiService.AnalyzeJob(r.Context(), req)
	if err != nil {
		log.Printf("Failed to analyze job: %v", err)
		http.Error(w, "Failed to analyze job", http.StatusInternalServerError)
		return
	}

	// Return the response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("Failed to encode response: %v", err)
	}
}
