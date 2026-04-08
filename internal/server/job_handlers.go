package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"

	dbservice "upwork-buddy/internal/database/service"
)

type saveJobRequest struct {
	JobTitle        string `json:"job_title"`
	JobDescription  string `json:"job_description"`
	Budget          string `json:"budget"`
	Skills          string `json:"skills"`
	Proposal        string `json:"proposal"`
	TimeEstimate    string `json:"time_estimate"`
	SpecSheetPrompt string `json:"spec_sheet_prompt"`
	ToneAnalysis    string `json:"tone_analysis"`
}

type saveJobResponse struct {
	ID        uint   `json:"id"`
	JobTitle  string `json:"job_title"`
	CreatedAt string `json:"created_at"`
}

type listJobsResponse struct {
	Jobs []jobEntry `json:"jobs"`
}

type jobEntry struct {
	ID              uint   `json:"id"`
	JobTitle        string `json:"job_title"`
	JobDescription  string `json:"job_description"`
	Budget          string `json:"budget"`
	Skills          string `json:"skills"`
	Proposal        string `json:"proposal"`
	TimeEstimate    string `json:"time_estimate"`
	SpecSheetPrompt string `json:"spec_sheet_prompt"`
	ToneAnalysis    string `json:"tone_analysis"`
	CreatedAt       string `json:"created_at"`
}

func (s *Server) saveJobHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Save job request received")
	if r.Method != http.MethodPost {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req saveJobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	job := dbservice.Job{
		Title:           req.JobTitle,
		Description:     req.JobDescription,
		Budget:          req.Budget,
		Skills:          req.Skills,
		Proposal:        req.Proposal,
		TimeEstimate:    req.TimeEstimate,
		SpecSheetPrompt: req.SpecSheetPrompt,
		ToneAnalysis:    req.ToneAnalysis,
	}

	if err := s.db.GetGorm().Create(&job).Error; err != nil {
		log.Printf("❌ Failed to save job: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to save job")
		return
	}

	log.Printf("✅ Job saved successfully: id=%d title=%q", job.ID, job.Title)
	respondWithJSON(w, saveJobResponse{
		ID:        job.ID,
		JobTitle:  job.Title,
		CreatedAt: job.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
	})
}

func (s *Server) listJobsHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 List jobs request received")
	if r.Method != http.MethodGet {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var jobs []dbservice.Job
	if err := s.db.GetGorm().Order("created_at DESC").Find(&jobs).Error; err != nil {
		log.Printf("❌ Failed to list jobs: %v", err)
		respondWithError(w, http.StatusInternalServerError, "Failed to list jobs")
		return
	}

	entries := make([]jobEntry, 0, len(jobs))
	for _, j := range jobs {
		entries = append(entries, jobEntry{
			ID:              j.ID,
			JobTitle:        j.Title,
			JobDescription:  j.Description,
			Budget:          j.Budget,
			Skills:          j.Skills,
			Proposal:        j.Proposal,
			TimeEstimate:    j.TimeEstimate,
			SpecSheetPrompt: j.SpecSheetPrompt,
			ToneAnalysis:    j.ToneAnalysis,
			CreatedAt:       j.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		})
	}

	log.Printf("✅ Listed %d jobs", len(entries))
	respondWithJSON(w, listJobsResponse{Jobs: entries})
}

func (s *Server) deleteJobHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("📥 Delete job request received")
	if r.Method != http.MethodDelete {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	// Extract ID from path: /api/jobs/{id}
	idStr := strings.TrimPrefix(r.URL.Path, "/api/jobs/")
	id, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil {
		log.Printf("❌ Invalid job ID: %q", idStr)
		respondWithError(w, http.StatusBadRequest, "Invalid job ID")
		return
	}

	result := s.db.GetGorm().Delete(&dbservice.Job{}, id)
	if result.Error != nil {
		log.Printf("❌ Failed to delete job: %v", result.Error)
		respondWithError(w, http.StatusInternalServerError, "Failed to delete job")
		return
	}

	if result.RowsAffected == 0 {
		log.Printf("❌ Job not found: id=%d", id)
		respondWithError(w, http.StatusNotFound, "Job not found")
		return
	}

	log.Printf("✅ Job deleted: id=%d", id)
	w.WriteHeader(http.StatusNoContent)
}

// respondWithError sends a JSON error response
func respondWithError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}