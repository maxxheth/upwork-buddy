package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/scoring"

	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

var (
	errSearchProfileNotFound = errors.New("search profile not found")
	errBatchValidation       = errors.New("batch job validation failed")
)

type batchIngestJobsRequest struct {
	Jobs        []saveJobRequest      `json:"jobs"`
	Filters     *scoring.FilterConfig `json:"filters,omitempty"`
	FilterStage string                `json:"filter_stage,omitempty"`
	SortByScore *bool                 `json:"sort_by_score,omitempty"`
	Upsert      *bool                 `json:"upsert,omitempty"`
}

type batchIngestJobsResponse struct {
	Jobs              []jobEntry `json:"jobs"`
	TotalReceived     int        `json:"total_received"`
	DeduplicatedCount int        `json:"deduplicated_count"`
	FilteredCount     int        `json:"filtered_count"`
	PersistedCount    int        `json:"persisted_count"`
}

// SearchJobsRequest describes an orchestrated extension search + scoring + optional enrichment sweep.
type SearchJobsRequest struct {
	Source         string                `json:"source,omitempty"`
	Query          string                `json:"query,omitempty"`
	Queries        []string              `json:"queries,omitempty"`
	Sort           string                `json:"sort,omitempty"`
	PerPage        *int                  `json:"per_page,omitempty"`
	ContractorTier []int                 `json:"contractor_tier,omitempty"`
	ContractType   string                `json:"contract_type,omitempty"`
	ProposalTiers  []string              `json:"proposal_tiers,omitempty"`
	Amount         string                `json:"amount,omitempty"`
	BudgetMin      *int                  `json:"budget_min,omitempty"`
	BudgetMax      *int                  `json:"budget_max,omitempty"`
	Category       string                `json:"category,omitempty"`
	SearchURL      string                `json:"search_url,omitempty"`
	StartPage      int                   `json:"start_page,omitempty"`
	MaxPages       int                   `json:"max_pages,omitempty"`
	TargetJobs     *int                  `json:"target_jobs,omitempty"`
	EnrichTopN     *int                  `json:"enrich_top_n,omitempty"`
	ProfileID      *uint                 `json:"profile_id,omitempty"`
	Filters        *scoring.FilterConfig `json:"filters,omitempty"`
}

// SearchJobsResponse summarizes an orchestrated search pipeline run.
type SearchJobsResponse struct {
	Jobs          []jobEntry `json:"jobs"`
	TotalScraped  int        `json:"total_scraped"`
	FilteredCount int        `json:"filtered_count"`
	EnrichedCount int        `json:"enriched_count"`
	StoppedReason string     `json:"stopped_reason"`
}

// DetailEnrichRequest describes a single or batch job detail enrichment call.
type DetailEnrichRequest struct {
	URL         string   `json:"url,omitempty"`
	UpworkJobID string   `json:"upwork_job_id,omitempty"`
	URLs        []string `json:"urls,omitempty"`
	MaxJobs     *int     `json:"max_jobs,omitempty"`
}

// DetailEnrichResponse returns enriched persisted job(s).
type DetailEnrichResponse struct {
	Job           *jobEntry  `json:"job,omitempty"`
	Jobs          []jobEntry `json:"jobs"`
	EnrichedCount int        `json:"enriched_count"`
	NotFound      bool       `json:"not_found,omitempty"`
	NotFoundURLs  []string   `json:"not_found_urls,omitempty"`
	StoppedReason string     `json:"stopped_reason"`
}

func canonicalKeyForRequest(req saveJobRequest) string {
	rawURL := firstNonEmpty(req.CanonicalURL, req.URL, req.JobURL)
	canonicalURL := scoring.NormalizeJobURL(rawURL)
	upworkID := firstNonEmpty(
		scoring.NormalizeUpworkJobID(req.UpworkJobID),
		scoring.ExtractUpworkJobID(canonicalURL),
		scoring.ExtractUpworkJobID(rawURL),
	)
	if upworkID != "" {
		return "id:" + upworkID
	}
	if canonicalURL != "" {
		return "url:" + canonicalURL
	}
	return "title:" + strings.ToLower(strings.TrimSpace(req.JobTitle)) + "|" + strings.ToLower(strings.TrimSpace(req.SourceQuery))
}

func deduplicateSaveJobRequests(reqs []saveJobRequest) []saveJobRequest {
	seen := make(map[string]int, len(reqs))
	out := make([]saveJobRequest, 0, len(reqs))
	for _, r := range reqs {
		key := canonicalKeyForRequest(r)
		if idx, exists := seen[key]; exists {
			mergeSaveJobRequests(&out[idx], r)
			continue
		}
		seen[key] = len(out)
		out = append(out, r)
	}
	return out
}

func mergeSaveJobRequests(dst *saveJobRequest, src saveJobRequest) {
	if strings.TrimSpace(src.JobTitle) != "" && strings.TrimSpace(dst.JobTitle) == "" {
		dst.JobTitle = src.JobTitle
	}
	if len(strings.TrimSpace(src.JobDescription)) > len(strings.TrimSpace(dst.JobDescription)) {
		dst.JobDescription = src.JobDescription
	}
	if src.URL != "" && dst.URL == "" {
		dst.URL = src.URL
	}
	if src.JobURL != "" && dst.JobURL == "" {
		dst.JobURL = src.JobURL
	}
	if src.CanonicalURL != "" {
		dst.CanonicalURL = src.CanonicalURL
	}
	if src.UpworkJobID != "" {
		dst.UpworkJobID = src.UpworkJobID
	}
	if src.ContractType != "" {
		dst.ContractType = src.ContractType
	}
	if src.Budget != "" && (dst.Budget == "" || dst.Budget == "Not specified" || dst.Budget == "Fixed price") {
		dst.Budget = src.Budget
	}
	if src.RateRange != "" {
		dst.RateRange = src.RateRange
	}
	if src.RateMin != "" {
		dst.RateMin = src.RateMin
	}
	if src.RateMax != "" {
		dst.RateMax = src.RateMax
	}
	if src.BudgetAmount != "" {
		dst.BudgetAmount = src.BudgetAmount
	}
	if src.ExperienceLevel != "" {
		dst.ExperienceLevel = src.ExperienceLevel
	}
	if src.Duration != "" {
		dst.Duration = src.Duration
	}
	if src.HoursPerWeek != "" {
		dst.HoursPerWeek = src.HoursPerWeek
	}
	if len(src.Skills.Slice) > len(dst.Skills.Slice) || (dst.Skills.Text == "" && src.Skills.Text != "") {
		dst.Skills = src.Skills
	}
	if src.PostedText != "" {
		dst.PostedText = src.PostedText
	}
	if src.Posted != "" {
		dst.Posted = src.Posted
	}
	if src.ProposalsTier != "" {
		dst.ProposalsTier = src.ProposalsTier
	}
	if src.Proposals != "" {
		dst.Proposals = src.Proposals
	}
	if src.ProposalsCount != nil {
		dst.ProposalsCount = src.ProposalsCount
	}
	if src.ConnectsRequired != nil {
		dst.ConnectsRequired = src.ConnectsRequired
	}
	if len(src.ScreeningQuestions) > 0 {
		dst.ScreeningQuestions = src.ScreeningQuestions
	}
	if len(src.Attachments) > 0 {
		dst.Attachments = src.Attachments
	}
	if len(src.Qualifications) > 0 {
		dst.Qualifications = src.Qualifications
	}
	if src.ClientCountry != "" {
		dst.ClientCountry = src.ClientCountry
	}
	if src.Country != "" {
		dst.Country = src.Country
	}
	if src.ClientRating != nil {
		dst.ClientRating = src.ClientRating
	}
	if src.ClientReviews != nil {
		dst.ClientReviews = src.ClientReviews
	}
	if src.ClientSpent != "" {
		dst.ClientSpent = src.ClientSpent
	}
	if src.ClientSpentUSD != nil {
		dst.ClientSpentUSD = src.ClientSpentUSD
	}
	if src.ClientHires != nil {
		dst.ClientHires = src.ClientHires
	}
	if src.ClientHireRate != nil {
		dst.ClientHireRate = src.ClientHireRate
	}
	if src.PaymentVerified != nil {
		dst.PaymentVerified = src.PaymentVerified
	}
	if len(src.ClientActivity) > 0 {
		dst.ClientActivity = src.ClientActivity
	}
	if src.LastEnrichedAt != nil {
		dst.LastEnrichedAt = src.LastEnrichedAt
	}
}

func jobInputFromSaveRequest(req saveJobRequest) scoring.JobInput {
	rawURL := firstNonEmpty(req.CanonicalURL, req.URL, req.JobURL)
	canonicalURL := scoring.NormalizeJobURL(rawURL)
	hourlyRate := req.RateRange
	if hourlyRate == "" && strings.EqualFold(req.ContractType, "hourly") {
		hourlyRate = req.Budget
	}
	budgetStr := req.BudgetAmount
	if budgetStr == "" && !strings.EqualFold(req.ContractType, "hourly") {
		budgetStr = req.Budget
	}
	proposalsTier := firstNonEmpty(req.ProposalsTier, req.Proposals)
	proposalsCount := req.ProposalsCount
	if proposalsCount == nil && proposalsTier != "" {
		proposalsCount = scoring.ParseProposalCount(proposalsTier)
	}
	return scoring.JobInput{
		Title:            req.JobTitle,
		URL:              canonicalURL,
		Description:      req.JobDescription,
		Budget:           budgetStr,
		HourlyRate:       hourlyRate,
		ExperienceLevel:  req.ExperienceLevel,
		Duration:         req.Duration,
		HoursPerWeek:     req.HoursPerWeek,
		Skills:           req.Skills.Slice,
		Posted:           firstNonEmpty(req.PostedText, req.Posted),
		Country:          firstNonEmpty(req.ClientCountry, req.Country),
		Proposals:        proposalsTier,
		ProposalsCount:   proposalsCount,
		ClientRating:     req.ClientRating,
		ClientReviews:    req.ClientReviews,
		ClientHires:      req.ClientHires,
		ClientSpent:      req.ClientSpent,
		ClientHireRate:   req.ClientHireRate,
		PaymentVerified:  req.PaymentVerified,
		ConnectsRequired: req.ConnectsRequired,
	}
}

func filterSaveJobRequests(
	reqs []saveJobRequest,
	filters scoring.FilterConfig,
	stage scoring.FilterStage,
	profile *scoring.ScoringProfile,
) []saveJobRequest {
	// Tag each JobInput URL uniquely if empty so FilterCandidates preserves exact 1:1 mapping
	inputs := make([]scoring.JobInput, len(reqs))
	keyToReq := make(map[string]saveJobRequest, len(reqs))
	for i, r := range reqs {
		inp := jobInputFromSaveRequest(r)
		tagKey := fmt.Sprintf("__idx_%d__:%s", i, inp.URL)
		inp.URL = tagKey
		inputs[i] = inp
		keyToReq[tagKey] = r
	}

	survivors := scoring.FilterCandidates(inputs, filters, stage, profile)
	out := make([]saveJobRequest, 0, len(survivors))
	for _, s := range survivors {
		if r, ok := keyToReq[s.URL]; ok {
			out = append(out, r)
		}
	}
	return out
}

type preparedBatchJob struct {
	origIdx       int
	sortKey       string
	model         dbservice.Job
	explicitScore bool
}

func batchSortKey(m dbservice.Job) string {
	if m.UpworkJobID != nil && *m.UpworkJobID != "" {
		return "0:" + *m.UpworkJobID
	}
	if m.CanonicalURL != "" {
		return "1:" + m.CanonicalURL
	}
	return "2:" + strings.ToLower(strings.TrimSpace(m.Title))
}

func isRetryableTxError(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && (pgErr.Code == "40P01" || pgErr.Code == "40001")
}

func upsertBatchRequests(
	gormDB *gorm.DB,
	reqs []saveJobRequest,
	profile *scoring.ScoringProfile,
) ([]jobEntry, error) {
	prepared := make([]preparedBatchJob, 0, len(reqs))
	for i, req := range reqs {
		jobModel, _, explicitScore, err := buildJobModelFromRequest(req)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", errBatchValidation, err)
		}
		prepared = append(prepared, preparedBatchJob{
			origIdx:       i,
			sortKey:       batchSortKey(jobModel),
			model:         jobModel,
			explicitScore: explicitScore,
		})
	}

	if len(prepared) == 0 {
		return []jobEntry{}, nil
	}

	if gormDB == nil {
		entries := make([]jobEntry, 0, len(prepared))
		for _, item := range prepared {
			m := item.model
			applyDeterministicScore(&m, profile, item.explicitScore)
			entries = append(entries, jobEntryFromModel(m))
		}
		return entries, nil
	}

	ordered := make([]preparedBatchJob, len(prepared))
	copy(ordered, prepared)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].sortKey != ordered[j].sortKey {
			return ordered[i].sortKey < ordered[j].sortKey
		}
		return ordered[i].origIdx < ordered[j].origIdx
	})

	const maxTxAttempts = 4
	var entries []jobEntry
	for attempt := 0; attempt < maxTxAttempts; attempt++ {
		attemptEntries := make([]jobEntry, len(prepared))
		txErr := gormDB.Transaction(func(tx *gorm.DB) error {
			for _, item := range ordered {
				saved, _, err := upsertJobRecord(tx, item.model, profile, item.explicitScore)
				if err != nil {
					return err
				}
				attemptEntries[item.origIdx] = jobEntryFromModel(saved)
			}
			return nil
		})
		if txErr == nil {
			entries = attemptEntries
			break
		}
		if !isRetryableTxError(txErr) || attempt == maxTxAttempts-1 {
			return nil, txErr
		}
		jitter := time.Duration(5+rand.IntN(21)) * time.Millisecond
		time.Sleep(jitter)
	}
	return entries, nil
}

func extendWriteDeadline(w http.ResponseWriter, d time.Duration) {
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(d))
}

func (s *Server) auditBridgeChallenge(actionType, targetID string, err error) {
	if s == nil || !errors.Is(err, bridge.ErrHumanActionRequired) {
		return
	}
	eng := s.PolicyEngine()
	if eng == nil {
		return
	}
	_ = eng.RecordAudit(policy.AuditEntry{
		ActionType: actionType,
		Actor:      "extension",
		TargetID:   targetID,
		Outcome:    "HUMAN_ACTION_REQUIRED",
		Details: map[string]any{
			"error":      err.Error(),
			"error_code": bridge.ErrCodeHumanActionRequired,
		},
	})
}

func respondBridgeError(w http.ResponseWriter, err error) {
	if errors.Is(err, errSearchProfileNotFound) {
		respondWithError(w, http.StatusNotFound, err.Error())
		return
	}
	var se *ServiceError
	if errors.As(err, &se) && se != nil {
		status := se.HTTPStatus
		if status == 0 {
			status = http.StatusBadRequest
		}
		payload := map[string]any{
			"error":      se.Message,
			"error_code": se.Code,
		}
		if len(se.Details) > 0 {
			payload["details"] = se.Details
		}
		respondWithJSONStatus(w, status, payload)
		return
	}
	var pe *policy.PolicyError
	if errors.As(err, &pe) && pe != nil {
		status := pe.HTTPStatus
		if status == 0 {
			status = http.StatusForbidden
		}
		respondWithJSONStatus(w, status, map[string]any{
			"error":      pe.Message,
			"error_code": pe.Code,
			"details":    pe.Details,
		})
		return
	}
	if errors.Is(err, bridge.ErrExtensionDisconnected) {
		respondWithJSONStatus(w, http.StatusServiceUnavailable, map[string]any{
			"error":      err.Error(),
			"error_code": bridge.ErrCodeExtensionDisconnected,
		})
		return
	}
	if errors.Is(err, bridge.ErrHumanActionRequired) {
		respondWithJSONStatus(w, http.StatusPreconditionRequired, map[string]any{
			"error":      err.Error(),
			"error_code": bridge.ErrCodeHumanActionRequired,
		})
		return
	}
	if errors.Is(err, bridge.ErrApprovalRequired) {
		respondWithJSONStatus(w, http.StatusForbidden, map[string]any{
			"error":      err.Error(),
			"error_code": bridge.ErrCodeApprovalRequired,
		})
		return
	}
	if errors.Is(err, bridge.ErrDailyCapExceeded) {
		respondWithJSONStatus(w, http.StatusTooManyRequests, map[string]any{
			"error":      err.Error(),
			"error_code": bridge.ErrCodeDailyCapExceeded,
		})
		return
	}
	if errors.Is(err, bridge.ErrPolicyBlocked) {
		respondWithJSONStatus(w, http.StatusForbidden, map[string]any{
			"error":      err.Error(),
			"error_code": bridge.ErrCodePolicyBlocked,
		})
		return
	}
	var be *bridge.BridgeError
	if errors.As(err, &be) && be != nil {
		status := http.StatusBadGateway
		switch strings.ToUpper(strings.TrimSpace(be.Code)) {
		case "ROOM_NOT_FOUND", "JOB_UNAVAILABLE":
			status = http.StatusNotFound
		case "ALREADY_APPLIED":
			status = http.StatusConflict
		case "FILL_VERIFICATION_FAILED", "INSUFFICIENT_CONNECTS", "SCREENING_QUESTIONS_REQUIRED", "SCREENING_QUESTIONS_UNANSWERED", "FORM_VALIDATION_ERROR":
			status = http.StatusUnprocessableEntity
		case "INVALID_PARAMS":
			status = http.StatusBadRequest
		}
		respondWithJSONStatus(w, status, map[string]any{
			"error":      be.Error(),
			"error_code": be.Code,
		})
		return
	}
	respondWithError(w, http.StatusInternalServerError, err.Error())
}

func respondWithJSONStatus(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("⚠️ Failed to write JSON response: %v", err)
	}
}

func (s *Server) batchIngestJobsHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req batchIngestJobsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	totalReceived := len(req.Jobs)
	deduped := deduplicateSaveJobRequests(req.Jobs)

	stage := scoring.StagePreEnrichment
	if strings.EqualFold(strings.TrimSpace(req.FilterStage), string(scoring.StagePostEnrichment)) {
		stage = scoring.StagePostEnrichment
	}

	gormDB := s.db.GetGorm()
	profile := loadScoringProfile(gormDB)

	surviving := deduped
	if req.Filters != nil {
		filters := *req.Filters
		if req.SortByScore != nil {
			filters.SortByScore = *req.SortByScore
		}
		surviving = filterSaveJobRequests(deduped, filters, stage, profile)
	} else if req.SortByScore != nil && *req.SortByScore {
		surviving = filterSaveJobRequests(deduped, scoring.FilterConfig{SortByScore: true}, stage, profile)
	}

	doUpsert := req.Upsert == nil || *req.Upsert
	var entries []jobEntry
	var err error
	if doUpsert {
		entries, err = upsertBatchRequests(gormDB, surviving, profile)
	} else {
		entries, err = upsertBatchRequests(nil, surviving, profile)
	}
	if err != nil {
		if errors.Is(err, errBatchValidation) {
			respondWithError(w, http.StatusBadRequest, err.Error())
			return
		}
		log.Printf("❌ Failed to ingest batch jobs: %v", err)
		respondWithError(w, http.StatusInternalServerError, err.Error())
		return
	}

	persistedCount := 0
	if doUpsert {
		persistedCount = len(entries)
	}

	respondWithJSON(w, batchIngestJobsResponse{
		Jobs:              entries,
		TotalReceived:     totalReceived,
		DeduplicatedCount: len(deduped),
		FilteredCount:     len(surviving),
		PersistedCount:    persistedCount,
	})
}

func searchModeToFeedSource(mode string) string {
	switch strings.TrimSpace(mode) {
	case "best_matches":
		return "best_matches"
	case "most_recent":
		return "most_recent"
	case "saved_jobs":
		return "saved_jobs"
	default:
		return "search"
	}
}

func mergeProfileIntoSearchRequest(req *SearchJobsRequest, cfg SearchProfileConfig) {
	if req.Source == "" {
		req.Source = searchModeToFeedSource(cfg.Search.Mode)
	}
	if req.Query == "" {
		req.Query = cfg.Search.Query
	}
	if len(req.Queries) == 0 && len(cfg.Search.Queries) > 0 {
		req.Queries = cfg.Search.Queries
	}
	if req.Sort == "" && cfg.Search.Sort != nil {
		req.Sort = *cfg.Search.Sort
	}
	if req.PerPage == nil && cfg.Search.PerPage != nil {
		req.PerPage = cfg.Search.PerPage
	}
	if len(req.ContractorTier) == 0 && len(cfg.Search.ContractorTier) > 0 {
		req.ContractorTier = cfg.Search.ContractorTier
	}
	if req.ContractType == "" && cfg.Search.ContractType != nil {
		req.ContractType = *cfg.Search.ContractType
	}
	if len(req.ProposalTiers) == 0 && len(cfg.Search.ProposalTiers) > 0 {
		req.ProposalTiers = cfg.Search.ProposalTiers
	}
	if req.StartPage <= 0 {
		req.StartPage = cfg.Search.StartPage
	}
	if req.MaxPages <= 0 {
		req.MaxPages = cfg.Search.MaxPages
	}
	if req.TargetJobs == nil && cfg.Search.TargetJobs != nil {
		req.TargetJobs = cfg.Search.TargetJobs
	}
	if req.EnrichTopN == nil && cfg.Enrichment.Enabled {
		if cfg.Enrichment.MaxJobsToEnrich != nil {
			req.EnrichTopN = cfg.Enrichment.MaxJobsToEnrich
		} else {
			defaultTop := 10
			req.EnrichTopN = &defaultTop
		}
	}
	if req.Filters == nil {
		var budgetMin, budgetMax *float64
		if cfg.Filters.BudgetMin != nil {
			v := float64(*cfg.Filters.BudgetMin)
			budgetMin = &v
		}
		if cfg.Filters.BudgetMax != nil {
			v := float64(*cfg.Filters.BudgetMax)
			budgetMax = &v
		}
		req.Filters = &scoring.FilterConfig{
			RequiredKeywords: cfg.Filters.RequiredKeywords,
			ExcludeKeywords:  cfg.Filters.ExcludeKeywords,
			MinScore:         cfg.Filters.MinScore,
			MaxPostedAgeDays: cfg.Filters.MaxPostedAgeDays,
			MaxProposals:     cfg.Filters.MaxProposals,
			BudgetMin:        budgetMin,
			BudgetMax:        budgetMax,
			SortByScore:      true,
		}
	}
}

// ExecuteSearchPipeline runs extension search -> Stage 2 filtering/scoring -> optional top-N detail enrichment -> Stage 3 filtering/scoring -> DB upsert.
func (s *Server) ExecuteSearchPipeline(ctx context.Context, req SearchJobsRequest) (*SearchJobsResponse, error) {
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	var gormDB *gorm.DB
	if s.db != nil {
		gormDB = s.db.GetGorm()
	}

	if req.ProfileID != nil {
		if gormDB == nil {
			return nil, errors.New("database unavailable")
		}
		var profileRow dbservice.SearchProfile
		if err := gormDB.First(&profileRow, *req.ProfileID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, errSearchProfileNotFound
			}
			return nil, err
		}
		cfg := defaultSearchProfileConfig()
		if len(profileRow.ConfigJSON) > 0 {
			_ = json.Unmarshal(profileRow.ConfigJSON, &cfg)
		}
		mergeProfileIntoSearchRequest(&req, cfg)
	}

	if req.Source == "" {
		req.Source = "search"
	}
	if req.StartPage <= 0 {
		req.StartPage = 1
	}
	if req.MaxPages <= 0 {
		req.MaxPages = 1
	}
	amountFacet := strings.TrimSpace(req.Amount)
	if amountFacet != "" {
		minAmt, maxAmt, parseErr := parseAmountFacet(amountFacet)
		if parseErr != nil {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    parseErr.Error(),
			}
		}
		if req.BudgetMin == nil && minAmt != nil {
			req.BudgetMin = minAmt
		}
		if req.BudgetMax == nil && maxAmt != nil {
			req.BudgetMax = maxAmt
		}
	}

	effectiveFilters := scoring.FilterConfig{SortByScore: true}
	if req.Filters != nil {
		effectiveFilters = *req.Filters
		effectiveFilters.SortByScore = true
	}
	if req.BudgetMin != nil && effectiveFilters.BudgetMin == nil {
		v := float64(*req.BudgetMin)
		effectiveFilters.BudgetMin = &v
	}
	if req.BudgetMax != nil && effectiveFilters.BudgetMax == nil {
		v := float64(*req.BudgetMax)
		effectiveFilters.BudgetMax = &v
	}
	req.Filters = &effectiveFilters

	wsParams := map[string]any{
		"source":      req.Source,
		"start_page":  req.StartPage,
		"max_pages":   req.MaxPages,
		"auto_ingest": false,
		"filters":     &effectiveFilters,
	}
	if amountFacet != "" {
		wsParams["amount"] = amountFacet
	}
	if req.Query != "" {
		wsParams["query"] = req.Query
	}
	if len(req.Queries) > 0 {
		wsParams["queries"] = req.Queries
	}
	if req.Sort != "" {
		wsParams["sort"] = req.Sort
	}
	if req.PerPage != nil {
		wsParams["per_page"] = *req.PerPage
	}
	if len(req.ContractorTier) > 0 {
		wsParams["contractor_tier"] = req.ContractorTier
	}
	if req.ContractType != "" {
		wsParams["contract_type"] = req.ContractType
	}
	if len(req.ProposalTiers) > 0 {
		wsParams["proposal_tiers"] = req.ProposalTiers
	}
	if req.BudgetMin != nil {
		wsParams["budget_min"] = *req.BudgetMin
	}
	if req.BudgetMax != nil {
		wsParams["budget_max"] = *req.BudgetMax
	}
	if req.Category != "" {
		wsParams["category"] = req.Category
	}
	if req.SearchURL != "" {
		wsParams["search_url"] = req.SearchURL
	}
	if req.TargetJobs != nil {
		wsParams["target_jobs"] = *req.TargetJobs
	}

	rawSearchResult, err := s.bridgeHub.CallExtension(ctx, "jobs.search", wsParams, 2*time.Minute)
	if err != nil {
		s.auditBridgeChallenge("jobs_search", req.Query, err)
		return nil, err
	}

	var wsSearchOut struct {
		Jobs          []saveJobRequest `json:"jobs"`
		StoppedReason string           `json:"stopped_reason"`
	}
	if err := json.Unmarshal(rawSearchResult, &wsSearchOut); err != nil {
		return nil, fmt.Errorf("invalid jobs.search RPC result: %w", err)
	}

	totalScraped := len(wsSearchOut.Jobs)
	deduped := deduplicateSaveJobRequests(wsSearchOut.Jobs)
	profile := loadScoringProfile(gormDB)

	// Stage 2: pre-enrichment filter + sort by score
	stage2 := filterSaveJobRequests(deduped, effectiveFilters, scoring.StagePreEnrichment, profile)

	// Stage 3: optional top-N enrichment
	enrichTopN := 0
	if req.EnrichTopN != nil {
		if *req.EnrichTopN > 0 {
			enrichTopN = *req.EnrichTopN
		}
	} else if req.Filters != nil && req.Filters.MaxProposals != nil {
		anyMissing := false
		for _, c := range stage2 {
			if firstNonEmpty(c.ProposalsTier, c.Proposals) == "" && c.ProposalsCount == nil {
				anyMissing = true
				break
			}
		}
		if anyMissing {
			enrichTopN = 25
			if req.TargetJobs != nil && *req.TargetJobs > 0 && *req.TargetJobs < enrichTopN {
				enrichTopN = *req.TargetJobs
			}
		}
	}

	enrichedCount := 0
	stoppedReason := wsSearchOut.StoppedReason
	if stoppedReason == "" {
		stoppedReason = "completed"
	}

	finalCandidates := stage2
	if enrichTopN > 0 && len(stage2) > 0 {
		type ranked struct {
			idx   int
			score int
			url   string
		}
		rankedList := make([]ranked, 0, len(stage2))
		for i, c := range stage2 {
			u := firstNonEmpty(c.CanonicalURL, c.URL, c.JobURL)
			if u == "" {
				continue
			}
			sc := scoring.ScoreJob(jobInputFromSaveRequest(c), profile).Score
			rankedList = append(rankedList, ranked{idx: i, score: sc, url: u})
		}
		sort.SliceStable(rankedList, func(i, j int) bool {
			return rankedList[i].score > rankedList[j].score
		})
		if len(rankedList) > enrichTopN {
			rankedList = rankedList[:enrichTopN]
		}

		topURLs := make([]string, 0, len(rankedList))
		for _, item := range rankedList {
			topURLs = append(topURLs, item.url)
		}

		if len(topURLs) > 0 {
			rawDetailResult, detailErr := s.bridgeHub.CallExtension(ctx, "jobs.detail", map[string]any{
				"urls":    topURLs,
				"persist": false,
			}, 3*time.Minute)
			if detailErr != nil {
				if errors.Is(detailErr, bridge.ErrHumanActionRequired) {
					_, _ = upsertBatchRequests(gormDB, stage2, profile)
					s.auditBridgeChallenge("jobs_detail", strings.Join(topURLs, ","), detailErr)
					return nil, detailErr
				}
				if errors.Is(detailErr, bridge.ErrExtensionDisconnected) {
					return nil, detailErr
				}
				var be *bridge.BridgeError
				if errors.Is(detailErr, context.Canceled) ||
					errors.Is(detailErr, context.DeadlineExceeded) ||
					(errors.As(detailErr, &be) && (strings.EqualFold(be.Code, "ABORTED") || strings.EqualFold(be.Code, bridge.ErrCodeTimeout))) {
					return nil, detailErr
				}
				stoppedReason = "enrich_error"
			} else {
				var wsDetailOut struct {
					Jobs          []saveJobRequest `json:"jobs"`
					StoppedReason string           `json:"stopped_reason"`
				}
				if uErr := json.Unmarshal(rawDetailResult, &wsDetailOut); uErr == nil {
					enrichedByKey := make(map[string]saveJobRequest, len(wsDetailOut.Jobs))
					for _, ej := range wsDetailOut.Jobs {
						enrichedByKey[canonicalKeyForRequest(ej)] = ej
					}
					for i := range finalCandidates {
						key := canonicalKeyForRequest(finalCandidates[i])
						if ej, ok := enrichedByKey[key]; ok {
							mergeSaveJobRequests(&finalCandidates[i], ej)
							enrichedCount++
						}
					}
					if wsDetailOut.StoppedReason == "rate_limited" {
						stoppedReason = "rate_limited"
					}
				}
			}
		}
	}

	if req.Filters != nil {
		f := *req.Filters
		f.SortByScore = true
		finalCandidates = filterSaveJobRequests(finalCandidates, f, scoring.StagePostEnrichment, profile)
	}

	entries, err := upsertBatchRequests(gormDB, finalCandidates, profile)
	if err != nil {
		return nil, err
	}

	if req.ProfileID != nil && gormDB != nil {
		now := time.Now().UTC()
		_ = gormDB.Model(&dbservice.SearchProfile{}).
			Where("id = ?", *req.ProfileID).
			Update("last_run_at", now).Error
	}

	return &SearchJobsResponse{
		Jobs:          entries,
		TotalScraped:  totalScraped,
		FilteredCount: len(finalCandidates),
		EnrichedCount: enrichedCount,
		StoppedReason: stoppedReason,
	}, nil
}

// ExecuteDetailEnrich invokes the extension jobs.detail RPC and persists enriched jobs to Postgres.
func (s *Server) ExecuteDetailEnrich(ctx context.Context, req DetailEnrichRequest) (*DetailEnrichResponse, error) {
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	wsParams := map[string]any{
		"persist": false,
	}
	if strings.TrimSpace(req.URL) != "" {
		wsParams["url"] = strings.TrimSpace(req.URL)
	}
	if strings.TrimSpace(req.UpworkJobID) != "" {
		wsParams["upwork_job_id"] = strings.TrimSpace(req.UpworkJobID)
	}
	if len(req.URLs) > 0 {
		wsParams["urls"] = req.URLs
	}
	if req.MaxJobs != nil {
		if *req.MaxJobs < 0 {
			return nil, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "max_jobs must be >= 0",
			}
		}
		if *req.MaxJobs > 0 {
			wsParams["max_jobs"] = *req.MaxJobs
		}
	}

	rawResult, err := s.bridgeHub.CallExtension(ctx, "jobs.detail", wsParams, 2*time.Minute)
	if err != nil {
		s.auditBridgeChallenge("jobs_detail", firstNonEmpty(req.UpworkJobID, req.URL), err)
		return nil, err
	}

	var wsOut struct {
		OK            bool             `json:"ok"`
		NotFound      bool             `json:"not_found"`
		Job           *saveJobRequest  `json:"job"`
		Jobs          []saveJobRequest `json:"jobs"`
		NotFoundURLs  []string         `json:"not_found_urls"`
		StoppedReason string           `json:"stopped_reason"`
	}
	if err := json.Unmarshal(rawResult, &wsOut); err != nil {
		return nil, fmt.Errorf("invalid jobs.detail RPC result: %w", err)
	}

	candidates := wsOut.Jobs
	if len(candidates) == 0 && wsOut.Job != nil {
		candidates = []saveJobRequest{*wsOut.Job}
	}

	var gormDB *gorm.DB
	if s.db != nil {
		gormDB = s.db.GetGorm()
	}
	profile := loadScoringProfile(gormDB)
	entries, err := upsertBatchRequests(gormDB, candidates, profile)
	if err != nil {
		return nil, err
	}

	var firstJob *jobEntry
	if len(entries) > 0 {
		firstJob = &entries[0]
	}

	stoppedReason := wsOut.StoppedReason
	if stoppedReason == "" {
		stoppedReason = "completed"
	}

	return &DetailEnrichResponse{
		Job:           firstJob,
		Jobs:          entries,
		EnrichedCount: len(entries),
		NotFound:      wsOut.NotFound,
		NotFoundURLs:  wsOut.NotFoundURLs,
		StoppedReason: stoppedReason,
	}, nil
}

func (s *Server) searchJobsHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)

	var req SearchJobsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	res, err := s.ExecuteSearchPipeline(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) enrichJobDetailHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)

	var req DetailEnrichRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if strings.TrimSpace(req.URL) == "" && strings.TrimSpace(req.UpworkJobID) == "" && len(req.URLs) == 0 {
		respondWithError(w, http.StatusBadRequest, "url, upwork_job_id, or urls is required")
		return
	}

	res, err := s.ExecuteDetailEnrich(r.Context(), req)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	if res.NotFound && len(res.Jobs) == 0 {
		respondWithJSONStatus(w, http.StatusNotFound, res)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) runSearchProfileHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)

	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	idStr := strings.TrimSpace(r.PathValue("id"))
	idVal, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil || idVal == 0 {
		respondWithError(w, http.StatusBadRequest, "Invalid search profile ID")
		return
	}

	profileID := uint(idVal)
	res, err := s.ExecuteSearchPipeline(r.Context(), SearchJobsRequest{
		ProfileID: &profileID,
	})
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func parseAmountFacet(raw string) (*int, *int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil, nil
	}
	parts := strings.Split(trimmed, "-")
	if len(parts) > 2 {
		return nil, nil, fmt.Errorf("invalid amount range %q: expected min-max", raw)
	}
	var minPtr, maxPtr *int
	minStr := strings.TrimSpace(parts[0])
	if minStr != "" {
		v, err := strconv.Atoi(minStr)
		if err != nil || v < 0 {
			return nil, nil, fmt.Errorf("invalid amount range %q: min must be a non-negative integer", raw)
		}
		minPtr = &v
	}
	if len(parts) == 2 {
		maxStr := strings.TrimSpace(parts[1])
		if maxStr != "" {
			v, err := strconv.Atoi(maxStr)
			if err != nil || v < 0 {
				return nil, nil, fmt.Errorf("invalid amount range %q: max must be a non-negative integer", raw)
			}
			maxPtr = &v
		}
	}
	if minPtr == nil && maxPtr == nil {
		return nil, nil, fmt.Errorf("invalid amount range %q: min or max required", raw)
	}
	if minPtr != nil && maxPtr != nil && *minPtr > *maxPtr {
		return nil, nil, fmt.Errorf("invalid amount range %q: min cannot exceed max", raw)
	}
	return minPtr, maxPtr, nil
}
