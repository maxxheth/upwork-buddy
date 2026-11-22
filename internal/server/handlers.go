package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
)

// AnalyzeJobRequest configures deterministic scoring and optional LLM analysis for a persisted job.
type AnalyzeJobRequest struct {
	JobID         any    `json:"job_id,omitempty"`
	UpworkJobID   string `json:"upwork_job_id,omitempty"`
	EnsureDetails bool   `json:"ensure_details,omitempty"`
	UseLLM        *bool  `json:"use_llm,omitempty"`
	Model         string `json:"model,omitempty"`
	Effort        string `json:"effort,omitempty"`
}

// PortfolioReferenceEntry represents a portfolio item or sanitized active project referenced during job analysis.
type PortfolioReferenceEntry struct {
	Source       string   `json:"source"`
	DisplayName  string   `json:"display_name"`
	Visibility   string   `json:"visibility"`
	Link         string   `json:"link,omitempty"`
	Summary      string   `json:"summary,omitempty"`
	ActivityTier string   `json:"activity_tier,omitempty"`
	TechStack    []string `json:"tech_stack,omitempty"`
}

// AnalyzeJobResult contains the deterministic score breakdown, optional LLM analysis, and updated job row.
type AnalyzeJobResult struct {
	Job             JobEntry                    `json:"job"`
	Score           int                         `json:"score"`
	FitLabel        string                      `json:"fit_label"`
	ScoreBreakdown  any                         `json:"score_breakdown"`
	Reasons         []string                    `json:"reasons"`
	MatchedProjects []PortfolioReferenceEntry   `json:"matched_projects,omitempty"`
	LLMAnalysis     *ollama.JobAnalysisResponse `json:"llm_analysis,omitempty"`
	LLMError        string                      `json:"llm_error,omitempty"`
	Usage           *ollama.TokenUsage          `json:"usage,omitempty"`
	AIEnrichedAt    *string                     `json:"ai_enriched_at,omitempty"`
	AIModel         string                      `json:"ai_model,omitempty"`
	AIEffort        string                      `json:"ai_effort,omitempty"`
	AITokensUsed    *int                        `json:"ai_tokens_used,omitempty"`
}

// AnalyzeJob loads a job from Postgres, runs deterministic scoring against the live profile,
// optionally fetches missing DOM details and runs Ollama/AGY analysis, and persists the updated
// score, analysis fields, and AI enrichment metadata back to Postgres.
func (s *Server) AnalyzeJob(ctx context.Context, req AnalyzeJobRequest) (*AnalyzeJobResult, error) {
	job, err := s.ResolveJobRef(ctx, req.JobID, req.UpworkJobID)
	if err != nil {
		return nil, err
	}

	gormDB := s.db.GetGorm().WithContext(ctx)

	if req.EnsureDetails && (job.LastEnrichedAt == nil || job.LastEnrichedAt.IsZero() || strings.TrimSpace(job.Description) == "") {
		upworkID := ""
		if job.UpworkJobID != nil {
			upworkID = strings.TrimSpace(*job.UpworkJobID)
		}
		targetURL := firstNonEmpty(job.CanonicalURL, job.URL)
		if upworkID == "" && targetURL != "" {
			if extracted := scoring.ExtractUpworkJobID(targetURL); extracted != "" {
				upworkID = extracted
				_ = gormDB.Model(&dbservice.Job{}).Where("id = ? AND (upwork_job_id IS NULL OR upwork_job_id = '')", job.ID).Update("upwork_job_id", extracted).Error
			}
		}
		if upworkID != "" || targetURL != "" {
			detailRes, detailErr := s.ExecuteDetailEnrich(ctx, DetailEnrichRequest{
				URL:         targetURL,
				UpworkJobID: upworkID,
			})
			if detailErr != nil {
				if errors.Is(detailErr, bridge.ErrHumanActionRequired) ||
					errors.Is(detailErr, context.Canceled) ||
					errors.Is(detailErr, context.DeadlineExceeded) ||
					ctx.Err() != nil {
					return nil, detailErr
				}
				if ResolveEnrichmentConfig().RequireDetails {
					return nil, detailErr
				}
				log.Printf("⚠️ AnalyzeJob ensure_details fallback to stored job text for job %d: %v", job.ID, detailErr)
			} else if detailRes == nil || detailRes.NotFound || detailRes.EnrichedCount == 0 {
				if ResolveEnrichmentConfig().RequireDetails {
					return nil, &ServiceError{
						Code:       "DETAIL_SCRAPE_FAILED",
						HTTPStatus: http.StatusBadGateway,
						Message:    "Detail scrape returned no job data",
					}
				}
				log.Printf("⚠️ AnalyzeJob ensure_details returned empty result for job %d; continuing with stored text", job.ID)
			} else {
				if reloaded, reloadErr := s.ResolveJobRef(ctx, job.ID, ""); reloadErr == nil && reloaded != nil {
					if reloaded.LastEnrichedAt == nil || reloaded.LastEnrichedAt.IsZero() {
						enrichNow := time.Now().UTC()
						reloaded.LastEnrichedAt = &enrichNow
						_ = gormDB.Model(&dbservice.Job{}).
							Where("id = ?", reloaded.ID).
							Update("last_enriched_at", enrichNow).Error
					}
					job = reloaded
				}
			}
		}
	}

	profile := loadScoringProfile(gormDB)

	hourlyRate := effectiveHourlyRate(job.RateRange, job.ContractType, job.Budget, job.RateMin, job.RateMax)
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

	jobInput := scoring.JobInput{
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
	}

	scoreRes := scoring.ScoreJob(jobInput, profile)

	sc := scoreRes.Score
	job.Score = &sc
	job.FitLabel = scoreRes.FitLabel
	job.FitAssessment = scoreRes.FitLabel
	job.ScoreReasoning = strings.Join(scoreRes.Reasons, "\n")
	if encoded, encErr := json.Marshal(scoreRes.Breakdown); encErr == nil {
		job.ScoreBreakdown = dbservice.JSONB(encoded)
	}

	prof, portfolioCtx, activeProjCtx, workloadSummary, matchedRefs := s.buildAnalysisContext(ctx, jobInput)
	if len(matchedRefs) > 0 {
		if encoded, encErr := json.Marshal(matchedRefs); encErr == nil {
			job.PortfolioReferences = dbservice.JSONB(encoded)
		}
	} else {
		job.PortfolioReferences = dbservice.JSONB("[]")
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
			llmErrMsg = oErr.Error()
			if ctx.Err() == nil && !errors.Is(oErr, context.Canceled) {
				job.AIEnrichmentStatus = "failed"
				job.AIEnrichmentError = llmErrMsg
			}
			if strictLLM {
				if ctx.Err() == nil && !errors.Is(oErr, context.Canceled) {
					_ = gormDB.Save(job).Error
				}
				return nil, &ServiceError{
					Code:       "OLLAMA_UNAVAILABLE",
					HTTPStatus: http.StatusServiceUnavailable,
					Message:    oErr.Error(),
				}
			}
		} else {
			defer func() { _ = ollamaSvc.Close() }()

			res, aErr := ollamaSvc.AnalyzeJob(ctx, ollama.JobAnalysisRequest{
				JobTitle:           job.Title,
				JobDescription:     job.Description,
				ContractType:       job.ContractType,
				Budget:             job.Budget,
				RateRange:          job.RateRange,
				RateMin:            job.RateMin,
				RateMax:            job.RateMax,
				BudgetAmount:       job.BudgetAmount,
				Skills:             job.Skills,
				ExperienceLevel:    job.ExperienceLevel,
				Duration:           job.Duration,
				HoursPerWeek:       job.HoursPerWeek,
				ProposalsTier:      job.ProposalsTier,
				ClientCountry:      job.ClientCountry,
				ClientSpent:        job.ClientSpent,
				ClientHireRate:     job.ClientHireRate,
				ScreeningQuestions: decodeScreeningQuestions(job.ScreeningQuestions),
				UserProfile:        prof.Description,
				UserSkills:         prof.Skills,
				PortfolioItems:     portfolioCtx,
				ActiveProjects:     activeProjCtx,
				WorkloadSummary:    workloadSummary,
				Model:              req.Model,
				Effort:             req.Effort,
			})
			if aErr != nil {
				if errors.Is(aErr, context.Canceled) || ctx.Err() != nil {
					return nil, aErr
				}
				llmErrMsg = aErr.Error()
				job.AIEnrichmentStatus = "failed"
				job.AIEnrichmentError = llmErrMsg
				if strictLLM {
					_ = gormDB.Save(job).Error
					return nil, &ServiceError{
						Code:       "OLLAMA_ERROR",
						HTTPStatus: http.StatusBadGateway,
						Message:    aErr.Error(),
					}
				}
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
				now := time.Now().UTC()
				job.AIEnrichmentStatus = "completed"
				job.AIEnrichedAt = &now
				job.AIEnrichmentError = ""
				job.AIModel = strings.TrimSpace(res.Model)
				job.AIEffort = strings.TrimSpace(res.Effort)
				if res.Usage != nil {
					toks := res.Usage.TotalTokens
					job.AITokensUsed = &toks
				} else {
					job.AITokensUsed = nil
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

	jobEntry := jobEntryFromModel(*job)
	var usage *ollama.TokenUsage
	if llmOut != nil {
		usage = llmOut.Usage
	}

	return &AnalyzeJobResult{
		Job:             jobEntry,
		Score:           scoreRes.Score,
		FitLabel:        scoreRes.FitLabel,
		ScoreBreakdown:  scoreRes.Breakdown,
		Reasons:         scoreRes.Reasons,
		MatchedProjects: matchedRefs,
		LLMAnalysis:     llmOut,
		LLMError:        llmErrMsg,
		Usage:           usage,
		AIEnrichedAt:    jobEntry.AIEnrichedAt,
		AIModel:         jobEntry.AIModel,
		AIEffort:        jobEntry.AIEffort,
		AITokensUsed:    jobEntry.AITokensUsed,
	}, nil
}

func decodeScreeningQuestions(raw dbservice.JSONB) []string {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var asStrings []string
	if err := json.Unmarshal([]byte(trimmed), &asStrings); err == nil {
		out := make([]string, 0, len(asStrings))
		for _, item := range asStrings {
			if t := strings.TrimSpace(item); t != "" {
				out = append(out, t)
			}
		}
		return out
	}
	var asObjects []struct {
		Prompt   string `json:"prompt"`
		Question string `json:"question"`
		Text     string `json:"text"`
		Required bool   `json:"required"`
	}
	if err := json.Unmarshal([]byte(trimmed), &asObjects); err == nil {
		out := make([]string, 0, len(asObjects))
		for _, item := range asObjects {
			q := firstNonEmpty(item.Prompt, item.Question, item.Text)
			if q == "" {
				continue
			}
			if item.Required {
				q += " (required)"
			}
			out = append(out, q)
		}
		return out
	}
	return nil
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
		EnsureDetails bool   `json:"ensure_details,omitempty"`
		UseLLM        *bool  `json:"use_llm,omitempty"`
		Model         string `json:"model,omitempty"`
		Effort        string `json:"effort,omitempty"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	res, err := s.AnalyzeJob(r.Context(), AnalyzeJobRequest{
		JobID:         id,
		EnsureDetails: body.EnsureDetails,
		UseLLM:        body.UseLLM,
		Model:         body.Model,
		Effort:        body.Effort,
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

	// Auto-enrich empty portfolio/active-project/workload context from Postgres when available.
	if s.db != nil && s.db.GetGorm() != nil &&
		(len(req.PortfolioItems) == 0 || len(req.ActiveProjects) == 0 || strings.TrimSpace(req.WorkloadSummary) == "") {
		var skills []string
		for _, part := range strings.Split(req.Skills, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				skills = append(skills, trimmed)
			}
		}
		_, portfolioCtx, activeProjCtx, workloadSummary, _ := s.buildAnalysisContext(r.Context(), scoring.JobInput{
			Title:       req.JobTitle,
			Description: req.JobDescription,
			Skills:      skills,
		})
		if len(req.PortfolioItems) == 0 {
			req.PortfolioItems = portfolioCtx
		}
		if len(req.ActiveProjects) == 0 {
			req.ActiveProjects = activeProjCtx
		}
		if strings.TrimSpace(req.WorkloadSummary) == "" {
			req.WorkloadSummary = workloadSummary
		}
	}

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

type rankedActiveProject struct {
	project     dbservice.ActiveProject
	displayName string
	summary     string
	recentFocus string
	visibility  string
	techStack   []string
	matchScore  int
	tierScore   int
}

func (s *Server) buildAnalysisContext(ctx context.Context, jobInput scoring.JobInput) (
	profile dbservice.Profile,
	portfolioCtx []ollama.PortfolioContext,
	activeProjCtx []ollama.ActiveProjectContext,
	workloadSummary string,
	matchedRefs []PortfolioReferenceEntry,
) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return profile, nil, nil, "", nil
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	_ = gormDB.Preload("PortfolioItems").Order("id asc").First(&profile).Error

	jobHaystack := strings.TrimSpace(jobInput.Title + " " + jobInput.Description + " " + strings.Join(jobInput.Skills, " "))

	for _, item := range profile.PortfolioItems {
		title := strings.TrimSpace(item.Title)
		if title == "" {
			continue
		}
		itemText := strings.TrimSpace(title + " " + item.Description)
		matched := false
		for _, skill := range jobInput.Skills {
			if t := strings.TrimSpace(skill); t != "" && scoring.KeywordMatches(t, itemText) {
				matched = true
				break
			}
		}
		if matched || len(profile.PortfolioItems) <= 5 {
			portfolioCtx = append(portfolioCtx, ollama.PortfolioContext{
				Title:       title,
				Link:        strings.TrimSpace(item.Link),
				Description: strings.TrimSpace(item.Description),
			})
		}
		if matched {
			matchedRefs = append(matchedRefs, PortfolioReferenceEntry{
				Source:      "portfolio",
				DisplayName: title,
				Visibility:  "public",
				Link:        strings.TrimSpace(item.Link),
				Summary:     strings.TrimSpace(item.Description),
			})
		}
	}

	var allProjects []dbservice.ActiveProject
	if err := gormDB.Where("LOWER(activity_tier) <> ? AND LOWER(status) <> ?", "archived", "archived").
		Order("pinned desc, last_activity_at desc, id asc").
		Find(&allProjects).Error; err != nil {
		log.Printf("buildAnalysisContext: skipping active projects query: %v", err)
		return profile, portfolioCtx, nil, "", matchedRefs
	}

	activeCount := 0
	recentCount := 0
	ranked := make([]rankedActiveProject, 0, len(allProjects))
	for _, p := range allProjects {
		tier := strings.ToLower(strings.TrimSpace(p.ActivityTier))
		switch tier {
		case "active":
			activeCount++
		case "recent":
			recentCount++
		}

		displayName, safeSummary, safeRecentFocus, ok := SanitizedActiveProjectDisplay(p)
		if !ok {
			continue
		}

		vis := strings.ToLower(strings.TrimSpace(p.ProposalVisibility))
		if vis != "public" {
			vis = "anonymized"
		}
		techStack := decodeStringSliceJSONB(p.TechStackJSON)

		matchScore := 0
		if jobHaystack != "" {
			for _, tech := range techStack {
				if t := strings.TrimSpace(tech); t != "" && scoring.KeywordMatches(t, jobHaystack) {
					matchScore += 3
				}
			}
		}
		projText := strings.TrimSpace(displayName + " " + safeSummary + " " + strings.Join(techStack, " "))
		if projText != "" {
			for _, skill := range jobInput.Skills {
				if sk := strings.TrimSpace(skill); sk != "" && scoring.KeywordMatches(sk, projText) {
					matchScore += 2
				}
			}
		}

		tierScore := 0
		if p.Pinned {
			tierScore += 2
		}
		switch tier {
		case "active":
			tierScore += 2
		case "recent":
			tierScore++
		}

		ranked = append(ranked, rankedActiveProject{
			project:     p,
			displayName: displayName,
			summary:     safeSummary,
			recentFocus: safeRecentFocus,
			visibility:  vis,
			techStack:   techStack,
			matchScore:  matchScore,
			tierScore:   tierScore,
		})
	}

	if activeCount > 0 || recentCount > 0 {
		workloadSummary = fmt.Sprintf("%d active projects (<=72h), %d recent (<=14d)", activeCount, recentCount)
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		iMatched := ranked[i].matchScore > 0
		jMatched := ranked[j].matchScore > 0
		if iMatched != jMatched {
			return iMatched
		}
		if ranked[i].matchScore != ranked[j].matchScore {
			return ranked[i].matchScore > ranked[j].matchScore
		}
		if ranked[i].tierScore != ranked[j].tierScore {
			return ranked[i].tierScore > ranked[j].tierScore
		}
		return ranked[i].project.ID < ranked[j].project.ID
	})

	const maxSelectedProjects = 8
	if len(ranked) > maxSelectedProjects {
		ranked = ranked[:maxSelectedProjects]
	}

	for _, r := range ranked {
		activeProjCtx = append(activeProjCtx, ollama.ActiveProjectContext{
			DisplayName:  r.displayName,
			Visibility:   r.visibility,
			ActivityTier: r.project.ActivityTier,
			Summary:      r.summary,
			RecentFocus:  r.recentFocus,
			TechStack:    r.techStack,
		})
		matchedRefs = append(matchedRefs, PortfolioReferenceEntry{
			Source:       "active_project",
			DisplayName:  r.displayName,
			Visibility:   r.visibility,
			Summary:      r.summary,
			ActivityTier: r.project.ActivityTier,
			TechStack:    r.techStack,
		})
	}

	return profile, portfolioCtx, activeProjCtx, workloadSummary, matchedRefs
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
