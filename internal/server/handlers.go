package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
)

// AnalyzeJobRequest configures deterministic scoring and optional LLM analysis for a persisted job.
type AnalyzeJobRequest struct {
	JobID       any    `json:"job_id,omitempty"`
	UpworkJobID string `json:"upwork_job_id,omitempty"`
	UseLLM      *bool  `json:"use_llm,omitempty"`
	Model       string `json:"model,omitempty"`
	Effort      string `json:"effort,omitempty"`
}

// AnalyzeJobResult contains the deterministic score breakdown, optional LLM analysis, and updated job row.
type AnalyzeJobResult struct {
	Job            JobEntry                    `json:"job"`
	Score          int                         `json:"score"`
	FitLabel       string                      `json:"fit_label"`
	ScoreBreakdown any                         `json:"score_breakdown"`
	Reasons        []string                    `json:"reasons"`
	LLMAnalysis    *ollama.JobAnalysisResponse `json:"llm_analysis,omitempty"`
	LLMError       string                      `json:"llm_error,omitempty"`
}

// AnalyzeJob loads a job from Postgres, runs deterministic scoring against the live profile,
// optionally runs Ollama analysis, and persists the updated score and analysis fields back to Postgres.
func (s *Server) AnalyzeJob(ctx context.Context, req AnalyzeJobRequest) (*AnalyzeJobResult, error) {
	job, err := s.ResolveJobRef(ctx, req.JobID, req.UpworkJobID)
	if err != nil {
		return nil, err
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	profile := loadScoringProfile(gormDB)

	hourlyRate := job.RateRange
	if hourlyRate == "" && strings.EqualFold(job.ContractType, "hourly") {
		hourlyRate = job.Budget
	}
	budgetStr := job.BudgetAmount
	if budgetStr == "" && !strings.EqualFold(job.ContractType, "hourly") {
		budgetStr = job.Budget
	}
	var skillSlice []string
	for _, part := range strings.Split(job.Skills, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			skillSlice = append(skillSlice, trimmed)
		}
	}

	scoreRes := scoring.ScoreJob(scoring.JobInput{
		Title:            job.Title,
		URL:              job.CanonicalURL,
		Description:      job.Description,
		Budget:           budgetStr,
		HourlyRate:       hourlyRate,
		ExperienceLevel:  job.ExperienceLevel,
		Duration:         job.Duration,
		HoursPerWeek:     job.HoursPerWeek,
		Skills:           skillSlice,
		Posted:           job.PostedText,
		Country:          job.ClientCountry,
		Proposals:        job.ProposalsTier,
		ProposalsCount:   job.ProposalsCount,
		ClientRating:     job.ClientRating,
		ClientReviews:    job.ClientReviews,
		ClientHires:      job.ClientHires,
		ClientSpent:      job.ClientSpent,
		ClientHireRate:   job.ClientHireRate,
		PaymentVerified:  job.PaymentVerified,
		ConnectsRequired: job.ConnectsRequired,
	}, profile)

	sc := scoreRes.Score
	job.Score = &sc
	job.FitLabel = scoreRes.FitLabel
	job.FitAssessment = scoreRes.FitLabel
	job.ScoreReasoning = strings.Join(scoreRes.Reasons, "\n")
	if encoded, encErr := json.Marshal(scoreRes.Breakdown); encErr == nil {
		job.ScoreBreakdown = dbservice.JSONB(encoded)
	}

	runLLM := false
	strictLLM := false
	if req.UseLLM != nil {
		runLLM = *req.UseLLM
		strictLLM = *req.UseLLM
	} else if ollama.IsConfigured() {
		runLLM = true
	}

	var llmOut *ollama.JobAnalysisResponse
	var llmErrMsg string
	if runLLM {
		ollamaSvc, oErr := ollama.New()
		if oErr != nil {
			if strictLLM {
				return nil, &ServiceError{
					Code:       "OLLAMA_UNAVAILABLE",
					HTTPStatus: http.StatusServiceUnavailable,
					Message:    oErr.Error(),
				}
			}
			llmErrMsg = oErr.Error()
		} else {
			defer func() { _ = ollamaSvc.Close() }()

			var prof dbservice.Profile
			_ = gormDB.Order("id asc").First(&prof).Error

			res, aErr := ollamaSvc.AnalyzeJob(ctx, ollama.JobAnalysisRequest{
				JobTitle:        job.Title,
				JobDescription:  job.Description,
				ContractType:    job.ContractType,
				Budget:          job.Budget,
				RateRange:       job.RateRange,
				RateMin:         job.RateMin,
				RateMax:         job.RateMax,
				BudgetAmount:    job.BudgetAmount,
				Skills:          job.Skills,
				ExperienceLevel: job.ExperienceLevel,
				UserProfile:     prof.Description,
				UserSkills:      prof.Skills,
				Model:           req.Model,
				Effort:          req.Effort,
			})
			if aErr != nil {
				if strictLLM {
					return nil, &ServiceError{
						Code:       "OLLAMA_ERROR",
						HTTPStatus: http.StatusBadGateway,
						Message:    aErr.Error(),
					}
				}
				llmErrMsg = aErr.Error()
			} else if res != nil {
				llmOut = res
				if strings.TrimSpace(res.Proposal) != "" {
					job.Proposal = res.Proposal
				}
				if strings.TrimSpace(res.ExecutionPrompt) != "" {
					job.ExecutionPrompt = res.ExecutionPrompt
				}
				if len(res.TimeEstimate) > 0 && string(res.TimeEstimate) != `""` {
					job.TimeEstimate = string(res.TimeEstimate)
				}
				if len(res.WorkloadDivision) > 0 && string(res.WorkloadDivision) != `""` {
					job.WorkloadDivision = string(res.WorkloadDivision)
				}
				if len(res.QuestionsForClient) > 0 {
					if b, mErr := json.Marshal(res.QuestionsForClient); mErr == nil {
						job.QuestionsForClient = string(b)
					}
				}
				if len(res.TipsAndAdvice) > 0 {
					if b, mErr := json.Marshal(res.TipsAndAdvice); mErr == nil {
						job.TipsAndAdvice = string(b)
					}
				}
				if strings.TrimSpace(res.ToneAnalysis) != "" {
					job.ToneAnalysis = res.ToneAnalysis
				}
			}
		}
	}

	if err := gormDB.Save(job).Error; err != nil {
		return nil, &ServiceError{
			Code:       "DB_ERROR",
			HTTPStatus: http.StatusInternalServerError,
			Message:    "Failed to persist analyzed job",
		}
	}

	return &AnalyzeJobResult{
		Job:            jobEntryFromModel(*job),
		Score:          scoreRes.Score,
		FitLabel:       scoreRes.FitLabel,
		ScoreBreakdown: scoreRes.Breakdown,
		Reasons:        scoreRes.Reasons,
		LLMAnalysis:    llmOut,
		LLMError:       llmErrMsg,
	}, nil
}

// analyzeSavedJobHandler handles POST /api/jobs/{id}/analyze requests.
func (s *Server) analyzeSavedJobHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		respondWithError(w, http.StatusBadRequest, "Job ID is required")
		return
	}

	var body struct {
		UseLLM *bool  `json:"use_llm,omitempty"`
		Model  string `json:"model,omitempty"`
		Effort string `json:"effort,omitempty"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	res, err := s.AnalyzeJob(r.Context(), AnalyzeJobRequest{
		JobID:  id,
		UseLLM: body.UseLLM,
		Model:  body.Model,
		Effort: body.Effort,
	})
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

// analyzeJobHandler handles POST /api/analyze-job requests
func (s *Server) analyzeJobHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("=== ANALYZE JOB REQUEST START ===")
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ollama.JobAnalysisRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("❌ Invalid request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	log.Printf("📥 Received request: title=%q, contract_type=%q, budget=%q, rate_range=%q, budget_amount=%q, skills=%q, experience_level=%q, profile_length=%d, user_skills_length=%d",
		req.JobTitle, req.ContractType, req.Budget, req.RateRange, req.BudgetAmount, req.Skills, req.ExperienceLevel, len(req.UserProfile), len(req.UserSkills))

	// Create Ollama service
	ollamaService, err := ollama.New()
	if err != nil {
		log.Printf("❌ Failed to create Ollama service: %v", err)
		http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
		return
	}
	defer func() {
		if err := ollamaService.Close(); err != nil {
			log.Printf("⚠️ Failed to close Ollama service: %v", err)
		}
	}()

	// Analyze the job
	result, err := ollamaService.AnalyzeJob(r.Context(), req)
	if err != nil {
		log.Printf("❌ Failed to analyze job: %v", err)
		if errors.Is(err, ollama.ErrUnavailable) || errors.Is(err, ollama.ErrAuthRequired) {
			http.Error(w, "Service unavailable", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "Failed to analyze job", http.StatusBadGateway)
		return
	}

	log.Printf("✅ Analysis complete: proposal_length=%d, execution_prompt_length=%d, questions=%d, tips=%d",
		len(result.Proposal), len(result.ExecutionPrompt),
		len(result.QuestionsForClient), len(result.TipsAndAdvice))

	// Return the response
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(result); err != nil {
		log.Printf("❌ Failed to encode response: %v", err)
	} else {
		log.Printf("📤 Response sent successfully")
	}
	log.Printf("=== ANALYZE JOB REQUEST END ===")
}

type profileResponse = ProfileResponse
type portfolioItemResponse = PortfolioItemResponse

// PortfolioItemRequest represents a portfolio item submitted in profile updates.
type PortfolioItemRequest struct {
	Title       string `json:"title"`
	Link        string `json:"link"`
	Description string `json:"description"`
}

// SaveProfileInput configures Get/Save profile updates across REST and MCP.
type SaveProfileInput struct {
	Description         string                  `json:"description"`
	Bio                 string                  `json:"bio"`
	Skills              FlexibleSkills          `json:"skills"`
	TargetRate          *float64                `json:"target_rate,omitempty"`
	PortfolioItems      *[]PortfolioItemRequest `json:"portfolio_items"`
	PortfolioReferences *[]PortfolioItemRequest `json:"portfolio_references"`
}

// ProfileResponse is the DTO returned for freelancer profile queries and updates.
type ProfileResponse struct {
	Description       string                  `json:"description"`
	Skills            string                  `json:"skills"`
	PortfolioItems    []PortfolioItemResponse `json:"portfolio_items"`
	UpdatedAt         string                  `json:"updated_at,omitempty"`
	LastSyncedAt      string                  `json:"last_synced_at,omitempty"`
	LastSyncedAtCamel string                  `json:"lastSyncedAt,omitempty"`
}

// PortfolioItemResponse is the DTO for a persisted portfolio item.
type PortfolioItemResponse struct {
	ID          uint   `json:"id"`
	Title       string `json:"title"`
	Link        string `json:"link"`
	Description string `json:"description"`
}

// GetProfile loads the freelancer profile and portfolio items from Postgres.
func (s *Server) GetProfile(ctx context.Context) (*ProfileResponse, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	db := s.db.GetGorm().WithContext(ctx)
	var profile dbservice.Profile
	if err := db.Preload("PortfolioItems", func(tx *gorm.DB) *gorm.DB {
		return tx.Order("id asc")
	}).Order("id asc").First(&profile).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &ProfileResponse{PortfolioItems: []PortfolioItemResponse{}}, nil
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load profile"}
	}
	resp := profileResponseFromModel(&profile)
	return &resp, nil
}

// SaveProfile updates the freelancer profile and replaces portfolio items (when provided) inside a Postgres transaction.
func (s *Server) SaveProfile(ctx context.Context, payload SaveProfileInput) (*ProfileResponse, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	description := payload.Description
	if strings.TrimSpace(description) == "" && strings.TrimSpace(payload.Bio) != "" {
		description = payload.Bio
	}
	skillsText := payload.Skills.Text

	portfolioSpecified := payload.PortfolioItems != nil || payload.PortfolioReferences != nil
	var itemsInput []PortfolioItemRequest
	if payload.PortfolioItems != nil {
		itemsInput = *payload.PortfolioItems
	}
	if len(itemsInput) == 0 && payload.PortfolioReferences != nil && len(*payload.PortfolioReferences) > 0 {
		itemsInput = *payload.PortfolioReferences
	}

	db := s.db.GetGorm().WithContext(ctx)
	tx := db.Begin()
	if tx.Error != nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusInternalServerError, Message: "Database unavailable"}
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
			panic(r)
		}
	}()

	var profile dbservice.Profile
	err := tx.Preload("PortfolioItems", func(q *gorm.DB) *gorm.DB {
		return q.Order("id asc")
	}).Order("id asc").First(&profile).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		profile = dbservice.Profile{
			Description: description,
			Skills:      skillsText,
		}
		if err := tx.Create(&profile).Error; err != nil {
			tx.Rollback()
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to create profile"}
		}
	} else if err != nil {
		tx.Rollback()
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load profile"}
	} else {
		if strings.TrimSpace(description) != "" {
			profile.Description = description
		}
		if payload.Skills.Set || payload.Skills.Text != "" || len(payload.Skills.Slice) > 0 {
			profile.Skills = skillsText
		}
		if err := tx.Omit("PortfolioItems").Save(&profile).Error; err != nil {
			tx.Rollback()
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to update profile"}
		}
		if portfolioSpecified {
			if err := tx.Where("profile_id = ?", profile.ID).Delete(&dbservice.PortfolioItem{}).Error; err != nil {
				tx.Rollback()
				return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to clear existing portfolio"}
			}
		}
	}

	var responseItems []PortfolioItemResponse
	if portfolioSpecified {
		responseItems = make([]PortfolioItemResponse, 0, len(itemsInput))
		for _, itemReq := range itemsInput {
			if strings.TrimSpace(itemReq.Title) == "" && strings.TrimSpace(itemReq.Link) == "" && strings.TrimSpace(itemReq.Description) == "" {
				continue
			}
			portfolioItem := dbservice.PortfolioItem{
				ProfileID:   profile.ID,
				Title:       itemReq.Title,
				Link:        itemReq.Link,
				Description: itemReq.Description,
			}
			if err := tx.Create(&portfolioItem).Error; err != nil {
				tx.Rollback()
				return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to save portfolio items"}
			}
			responseItems = append(responseItems, PortfolioItemResponse{
				ID:          portfolioItem.ID,
				Title:       portfolioItem.Title,
				Link:        portfolioItem.Link,
				Description: portfolioItem.Description,
			})
		}
	} else {
		responseItems = make([]PortfolioItemResponse, 0, len(profile.PortfolioItems))
		for _, item := range profile.PortfolioItems {
			responseItems = append(responseItems, PortfolioItemResponse{
				ID:          item.ID,
				Title:       item.Title,
				Link:        item.Link,
				Description: item.Description,
			})
		}
	}

	if err := tx.Commit().Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to persist profile"}
	}

	updatedAt := formatProfileTimestamp(profile.UpdatedAt)
	return &ProfileResponse{
		Description:       profile.Description,
		Skills:            profile.Skills,
		PortfolioItems:    responseItems,
		UpdatedAt:         updatedAt,
		LastSyncedAt:      updatedAt,
		LastSyncedAtCamel: updatedAt,
	}, nil
}

func (s *Server) profileHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getProfile(w, r)
	case http.MethodPost, http.MethodPut:
		s.saveProfile(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	resp, err := s.GetProfile(r.Context())
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, resp)
}

func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request) {
	var payload SaveProfileInput
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	resp, err := s.SaveProfile(r.Context(), payload)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, resp)
}

func formatProfileTimestamp(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func profileResponseFromModel(profile *dbservice.Profile) profileResponse {
	items := make([]portfolioItemResponse, 0, len(profile.PortfolioItems))
	for _, item := range profile.PortfolioItems {
		items = append(items, portfolioItemResponse{
			ID:          item.ID,
			Title:       item.Title,
			Link:        item.Link,
			Description: item.Description,
		})
	}
	updatedAt := formatProfileTimestamp(profile.UpdatedAt)
	return profileResponse{
		Description:       profile.Description,
		Skills:            profile.Skills,
		PortfolioItems:    items,
		UpdatedAt:         updatedAt,
		LastSyncedAt:      updatedAt,
		LastSyncedAtCamel: updatedAt,
	}
}

func respondWithJSON(w http.ResponseWriter, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("Failed to encode response: %v", err)
	}
}
