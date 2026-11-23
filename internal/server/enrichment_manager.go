package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
)

const (
	EnrichmentBatchStatusQueued              = "queued"
	EnrichmentBatchStatusRunning             = "running"
	EnrichmentBatchStatusCompleted           = "completed"
	EnrichmentBatchStatusCompletedWithErrors = "completed_with_errors"
	EnrichmentBatchStatusCanceled            = "canceled"
	EnrichmentBatchStatusFailed              = "failed"

	EnrichmentItemStatusQueued          = "queued"
	EnrichmentItemStatusScrapingDetails = "scraping_details"
	EnrichmentItemStatusAnalyzing       = "analyzing"
	EnrichmentItemStatusCompleted       = "completed"
	EnrichmentItemStatusSkipped         = "skipped"
	EnrichmentItemStatusFailed          = "failed"
	EnrichmentItemStatusCanceled        = "canceled"
)

// BatchEnrichRequest configures an async or wait=true batch enrichment run.
type BatchEnrichRequest struct {
	JobIDs              []any  `json:"job_ids"`
	Mode                string `json:"mode,omitempty"`
	Force               *bool  `json:"force,omitempty"`
	SkipDetailIfPresent *bool  `json:"skip_detail_if_present,omitempty"`
	RequireDetails      *bool  `json:"require_details,omitempty"`
	Model               string `json:"model,omitempty"`
	Effort              string `json:"effort,omitempty"`
	MaxConcurrency      *int   `json:"max_concurrency,omitempty"`
	Wait                *bool  `json:"wait,omitempty"`
	WaitTimeoutSeconds  *int   `json:"wait_timeout_seconds,omitempty"`
	TriggeredBy         string `json:"triggered_by,omitempty"`
}

// EnrichmentBatchSummary is the API/MCP DTO for an EnrichmentBatch row.
type EnrichmentBatchSummary struct {
	ID              uint    `json:"id"`
	Mode            string  `json:"mode"`
	TriggeredBy     string  `json:"triggered_by"`
	Model           string  `json:"model,omitempty"`
	Effort          string  `json:"effort,omitempty"`
	Force           bool    `json:"force"`
	Status          string  `json:"status"`
	TotalCount      int     `json:"total_count"`
	QueuedCount     int     `json:"queued_count"`
	RunningCount    int     `json:"running_count"`
	CompletedCount  int     `json:"completed_count"`
	SkippedCount    int     `json:"skipped_count"`
	FailedCount     int     `json:"failed_count"`
	CanceledCount   int     `json:"canceled_count"`
	TotalTokensUsed int     `json:"total_tokens_used"`
	CreatedAt       string  `json:"created_at"`
	StartedAt       *string `json:"started_at,omitempty"`
	CompletedAt     *string `json:"completed_at,omitempty"`
	UpdatedAt       string  `json:"updated_at"`
}

// EnrichmentBatchItemEntry is the API/MCP DTO for an EnrichmentBatchItem row.
type EnrichmentBatchItemEntry struct {
	ID            uint    `json:"id"`
	BatchID       uint    `json:"batch_id"`
	JobID         uint    `json:"job_id"`
	Status        string  `json:"status"`
	DetailFetched bool    `json:"detail_fetched"`
	LLMInvoked    bool    `json:"llm_invoked"`
	Model         string  `json:"model,omitempty"`
	Effort        string  `json:"effort,omitempty"`
	InputTokens   int     `json:"input_tokens"`
	OutputTokens  int     `json:"output_tokens"`
	ThoughtTokens int     `json:"thought_tokens"`
	TotalTokens   int     `json:"total_tokens"`
	ErrorCode     string  `json:"error_code,omitempty"`
	ErrorMessage  string  `json:"error_message,omitempty"`
	StartedAt     *string `json:"started_at,omitempty"`
	CompletedAt   *string `json:"completed_at,omitempty"`
	CreatedAt     string  `json:"created_at"`
	UpdatedAt     string  `json:"updated_at"`
}

// EnrichmentBatchDetailResponse returns a batch summary, its items, and optional dashboard URL.
type EnrichmentBatchDetailResponse struct {
	Batch        EnrichmentBatchSummary     `json:"batch"`
	Items        []EnrichmentBatchItemEntry `json:"items"`
	DashboardURL string                     `json:"dashboard_url,omitempty"`
	Completed    bool                       `json:"-"`
}

type parsedBatchJobRef struct {
	numericID uint64
	upworkID  string
	dedupKey  string
	rawLabel  string
}

type activeBatchItemState struct {
	item                dbservice.EnrichmentBatchItem
	job                 dbservice.Job
	hadPriorCompletedAI bool
	priorAIStatus       string
	priorAIError        string
}

type activeBatchRun struct {
	batchID              uint
	mode                 string
	skipDetailIfPresent  bool
	requireDetails       bool
	maxConcurrency       int
	globalMaxConcurrency int
	items                []*activeBatchItemState

	ctx      context.Context
	cancel   context.CancelFunc
	done     chan struct{}
	rollupMu sync.Mutex
}

type semWaiter struct {
	ch      chan struct{}
	limit   int
	granted bool
}

// dynamicSemaphore is a FIFO, context-cancellable semaphore whose concurrency
// limit is evaluated dynamically on each Acquire call.
type dynamicSemaphore struct {
	mu      sync.Mutex
	inUse   int
	waiters []*semWaiter
}

func (s *dynamicSemaphore) Acquire(ctx context.Context, limit int) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if limit < 1 {
		limit = 1
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	if len(s.waiters) == 0 && s.inUse < limit {
		s.inUse++
		s.mu.Unlock()
		return nil
	}
	w := &semWaiter{
		ch:    make(chan struct{}),
		limit: limit,
	}
	s.waiters = append(s.waiters, w)
	s.mu.Unlock()

	select {
	case <-w.ch:
		if err := ctx.Err(); err != nil {
			s.Release()
			return err
		}
		return nil
	case <-ctx.Done():
		s.mu.Lock()
		if w.granted {
			s.mu.Unlock()
			s.Release()
			return ctx.Err()
		}
		for i, item := range s.waiters {
			if item == w {
				s.waiters = append(s.waiters[:i], s.waiters[i+1:]...)
				break
			}
		}
		s.wakeLocked()
		s.mu.Unlock()
		return ctx.Err()
	}
}

func (s *dynamicSemaphore) Release() {
	s.mu.Lock()
	if s.inUse > 0 {
		s.inUse--
	}
	s.wakeLocked()
	s.mu.Unlock()
}

func (s *dynamicSemaphore) wakeLocked() {
	for len(s.waiters) > 0 {
		head := s.waiters[0]
		limit := head.limit
		if limit < 1 {
			limit = 1
		}
		if s.inUse >= limit {
			break
		}
		s.waiters = s.waiters[1:]
		s.inUse++
		head.granted = true
		close(head.ch)
	}
}

// EnrichmentManager orchestrates Postgres-backed async batch detail scraping and AI enrichment.
type EnrichmentManager struct {
	server *Server

	mu        sync.Mutex
	closed    bool
	active    map[uint]*activeBatchRun
	wg        sync.WaitGroup
	detailSem dynamicSemaphore
	llmSem    dynamicSemaphore
}

// NewEnrichmentManager creates an EnrichmentManager bound to s.
func NewEnrichmentManager(s *Server) *EnrichmentManager {
	return &EnrichmentManager{
		server: s,
		active: make(map[uint]*activeBatchRun),
	}
}

func enrichmentBatchSummaryFromModel(m dbservice.EnrichmentBatch) EnrichmentBatchSummary {
	return EnrichmentBatchSummary{
		ID:              m.ID,
		Mode:            m.Mode,
		TriggeredBy:     m.TriggeredBy,
		Model:           m.Model,
		Effort:          m.Effort,
		Force:           m.Force,
		Status:          m.Status,
		TotalCount:      m.TotalCount,
		QueuedCount:     m.QueuedCount,
		RunningCount:    m.RunningCount,
		CompletedCount:  m.CompletedCount,
		SkippedCount:    m.SkippedCount,
		FailedCount:     m.FailedCount,
		CanceledCount:   m.CanceledCount,
		TotalTokensUsed: m.TotalTokensUsed,
		CreatedAt:       m.CreatedAt.UTC().Format(time.RFC3339),
		StartedAt:       formatOptTime(m.StartedAt),
		CompletedAt:     formatOptTime(m.CompletedAt),
		UpdatedAt:       m.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func enrichmentBatchItemEntryFromModel(m dbservice.EnrichmentBatchItem) EnrichmentBatchItemEntry {
	return EnrichmentBatchItemEntry{
		ID:            m.ID,
		BatchID:       m.BatchID,
		JobID:         m.JobID,
		Status:        m.Status,
		DetailFetched: m.DetailFetched,
		LLMInvoked:    m.LLMInvoked,
		Model:         m.Model,
		Effort:        m.Effort,
		InputTokens:   m.InputTokens,
		OutputTokens:  m.OutputTokens,
		ThoughtTokens: m.ThoughtTokens,
		TotalTokens:   m.TotalTokens,
		ErrorCode:     m.ErrorCode,
		ErrorMessage:  m.ErrorMessage,
		StartedAt:     formatOptTime(m.StartedAt),
		CompletedAt:   formatOptTime(m.CompletedAt),
		CreatedAt:     m.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:     m.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func (s *Server) buildEnrichmentBatchDashboardURL(batchID uint) string {
	if s == nil || batchID == 0 {
		return ""
	}
	return s.BuildDashboardURL(fmt.Sprintf("batch=%d", batchID))
}

var (
	reBatchNumericJobID = regexp.MustCompile(`^[0-9]+$`)
	reBatchFullUpworkID = regexp.MustCompile(`^~[0-9a-zA-Z]+$`)
	reBatchBareUpworkID = regexp.MustCompile(`^[0-9a-zA-Z]{8,}$`)
)

func hasValidTime(t *time.Time) bool {
	return t != nil && !t.IsZero()
}

func isJobAIEnriched(job dbservice.Job) bool {
	status := strings.TrimSpace(job.AIEnrichmentStatus)
	if strings.EqualFold(status, "completed") {
		return true
	}
	if strings.EqualFold(status, "failed") {
		return false
	}
	return strings.TrimSpace(job.Proposal) != "" || hasValidTime(job.AIEnrichedAt)
}

func priorJobAIState(job dbservice.Job) (status string, errMsg string, hadCompleted bool) {
	st := strings.TrimSpace(job.AIEnrichmentStatus)
	if strings.EqualFold(st, "completed") || strings.TrimSpace(job.Proposal) != "" || hasValidTime(job.AIEnrichedAt) {
		return "completed", "", true
	}
	if strings.EqualFold(st, "failed") {
		return "failed", job.AIEnrichmentError, false
	}
	return "none", "", false
}

func isTerminalBatchStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case EnrichmentBatchStatusCompleted,
		EnrichmentBatchStatusCompletedWithErrors,
		EnrichmentBatchStatusCanceled,
		EnrichmentBatchStatusFailed:
		return true
	default:
		return false
	}
}

func isValidBatchStatusFilter(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case EnrichmentBatchStatusQueued,
		EnrichmentBatchStatusRunning,
		EnrichmentBatchStatusCompleted,
		EnrichmentBatchStatusCompletedWithErrors,
		EnrichmentBatchStatusCanceled,
		EnrichmentBatchStatusFailed:
		return true
	default:
		return false
	}
}

func parseBatchJobIDRef(raw any) (parsedBatchJobRef, error) {
	switch v := raw.(type) {
	case nil:
		return parsedBatchJobRef{}, errors.New("job_ids cannot contain null")
	case uint:
		if v == 0 || uint64(v) > math.MaxInt64 {
			return parsedBatchJobRef{}, errors.New("job_ids must contain positive integers")
		}
		return parsedBatchJobRef{
			numericID: uint64(v),
			dedupKey:  "id:" + strconv.FormatUint(uint64(v), 10),
			rawLabel:  strconv.FormatUint(uint64(v), 10),
		}, nil
	case uint64:
		if v == 0 || v > math.MaxInt64 {
			return parsedBatchJobRef{}, errors.New("job_ids must contain positive integers")
		}
		return parsedBatchJobRef{
			numericID: v,
			dedupKey:  "id:" + strconv.FormatUint(v, 10),
			rawLabel:  strconv.FormatUint(v, 10),
		}, nil
	case uint32:
		if v == 0 {
			return parsedBatchJobRef{}, errors.New("job_ids must contain positive integers")
		}
		return parsedBatchJobRef{
			numericID: uint64(v),
			dedupKey:  "id:" + strconv.FormatUint(uint64(v), 10),
			rawLabel:  strconv.FormatUint(uint64(v), 10),
		}, nil
	case int:
		if v <= 0 {
			return parsedBatchJobRef{}, errors.New("job_ids must contain positive integers")
		}
		return parsedBatchJobRef{
			numericID: uint64(v),
			dedupKey:  "id:" + strconv.Itoa(v),
			rawLabel:  strconv.Itoa(v),
		}, nil
	case int64:
		if v <= 0 {
			return parsedBatchJobRef{}, errors.New("job_ids must contain positive integers")
		}
		return parsedBatchJobRef{
			numericID: uint64(v),
			dedupKey:  "id:" + strconv.FormatInt(v, 10),
			rawLabel:  strconv.FormatInt(v, 10),
		}, nil
	case int32:
		if v <= 0 {
			return parsedBatchJobRef{}, errors.New("job_ids must contain positive integers")
		}
		return parsedBatchJobRef{
			numericID: uint64(v),
			dedupKey:  "id:" + strconv.FormatInt(int64(v), 10),
			rawLabel:  strconv.FormatInt(int64(v), 10),
		}, nil
	case float64:
		// Note: Go float64 cannot distinguish 1 from 1.0 (e.g. unmarshaling JSON without UseNumber),
		// so whole integers in [1, 2^63) are accepted, while JSON decoding via UseNumber() enforces
		// strict integer syntax on json.Number. Also float64(math.MaxInt64) rounds up to 2^63,
		// so reject v >= float64(uint64(1)<<63).
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 1 || v >= float64(uint64(1)<<63) || v != math.Trunc(v) {
			return parsedBatchJobRef{}, errors.New("job_ids numeric values must be positive whole integers")
		}
		n := uint64(v)
		return parsedBatchJobRef{
			numericID: n,
			dedupKey:  "id:" + strconv.FormatUint(n, 10),
			rawLabel:  strconv.FormatUint(n, 10),
		}, nil
	case json.Number:
		s := strings.TrimSpace(v.String())
		if !reBatchNumericJobID.MatchString(s) {
			return parsedBatchJobRef{}, errors.New("job_ids numeric values must be positive whole integers")
		}
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil || n == 0 || n > math.MaxInt64 {
			return parsedBatchJobRef{}, errors.New("job_ids numeric values must be positive whole integers")
		}
		return parsedBatchJobRef{
			numericID: n,
			dedupKey:  "id:" + strconv.FormatUint(n, 10),
			rawLabel:  s,
		}, nil
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return parsedBatchJobRef{}, errors.New("job_ids cannot contain empty strings")
		}
		if strings.HasPrefix(trimmed, "~") {
			if !reBatchFullUpworkID.MatchString(trimmed) {
				return parsedBatchJobRef{}, fmt.Errorf("invalid job_id %q", trimmed)
			}
			return parsedBatchJobRef{
				upworkID: trimmed,
				dedupKey: "upwork:" + trimmed,
				rawLabel: trimmed,
			}, nil
		}
		if strings.Contains(trimmed, "://") || strings.Contains(trimmed, "/") {
			extracted := scoring.ExtractUpworkJobID(trimmed)
			if extracted == "" {
				return parsedBatchJobRef{}, fmt.Errorf("invalid job_id %q", trimmed)
			}
			return parsedBatchJobRef{
				upworkID: extracted,
				dedupKey: "upwork:" + extracted,
				rawLabel: trimmed,
			}, nil
		}
		if reBatchNumericJobID.MatchString(trimmed) {
			n, err := strconv.ParseUint(trimmed, 10, 64)
			if err != nil || n == 0 || n > math.MaxInt64 {
				return parsedBatchJobRef{}, errors.New("job_ids numeric values must be positive integers")
			}
			return parsedBatchJobRef{
				numericID: n,
				dedupKey:  "id:" + strconv.FormatUint(n, 10),
				rawLabel:  trimmed,
			}, nil
		}
		if reBatchBareUpworkID.MatchString(trimmed) {
			norm := "~" + trimmed
			return parsedBatchJobRef{
				upworkID: norm,
				dedupKey: "upwork:" + norm,
				rawLabel: trimmed,
			}, nil
		}
		return parsedBatchJobRef{}, fmt.Errorf("invalid job_id %q", trimmed)
	default:
		return parsedBatchJobRef{}, fmt.Errorf("unsupported job_id type %T", raw)
	}
}

// StartBatch validates, resolves, deduplicates, persists, and starts (or waits for) an enrichment batch.
func (m *EnrichmentManager) StartBatch(ctx context.Context, req BatchEnrichRequest) (*EnrichmentBatchDetailResponse, error) {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	m.mu.Lock()
	closed := m.closed
	m.mu.Unlock()
	if closed {
		return nil, &ServiceError{Code: "SERVICE_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Enrichment manager is shutting down"}
	}

	cfg := ResolveEnrichmentConfig()

	mode := cfg.EffectiveMode()
	if strings.TrimSpace(req.Mode) != "" {
		parsedMode, ok := ParseEnrichmentMode(req.Mode)
		if !ok {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid mode: must be full, ai_only, or detail_only"}
		}
		mode = parsedMode
	}

	effort := cfg.DefaultEffort
	if strings.TrimSpace(req.Effort) != "" {
		parsedEffort, ok := ParseEnrichmentEffort(req.Effort)
		if !ok {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid effort: must be low, medium, high, or xhigh"}
		}
		effort = parsedEffort
	}

	globalMaxConcurrency := cfg.EffectiveMaxConcurrency()
	maxConcurrency := globalMaxConcurrency
	if req.MaxConcurrency != nil {
		if *req.MaxConcurrency <= 0 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "max_concurrency must be > 0"}
		}
		maxConcurrency = clampInt(*req.MaxConcurrency, MinEnrichmentMaxConcurrency, globalMaxConcurrency)
	}

	waitTimeout := cfg.WaitTimeout()
	if req.WaitTimeoutSeconds != nil {
		if *req.WaitTimeoutSeconds < 0 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "wait_timeout_seconds must be >= 0"}
		}
		if *req.WaitTimeoutSeconds > 0 {
			waitTimeout = time.Duration(clampInt(*req.WaitTimeoutSeconds, MinEnrichmentWaitTimeoutSeconds, MaxEnrichmentWaitTimeoutSeconds)) * time.Second
		}
	}

	if len(req.JobIDs) == 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "job_ids is required"}
	}

	uniqueRefs := make([]parsedBatchJobRef, 0, len(req.JobIDs))
	seenRef := make(map[string]struct{}, len(req.JobIDs))
	for _, rawID := range req.JobIDs {
		parsedRef, err := parseBatchJobIDRef(rawID)
		if err != nil {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: err.Error()}
		}
		if _, exists := seenRef[parsedRef.dedupKey]; exists {
			continue
		}
		seenRef[parsedRef.dedupKey] = struct{}{}
		uniqueRefs = append(uniqueRefs, parsedRef)
	}

	maxBatchSize := cfg.EffectiveMaxBatchSize()
	if len(uniqueRefs) > maxBatchSize {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("Batch exceeds maximum allowed size (%d > %d)", len(uniqueRefs), maxBatchSize),
			Details: map[string]any{
				"requested_count": len(uniqueRefs),
				"max_batch_size":  maxBatchSize,
			},
		}
	}

	gormDB := m.server.db.GetGorm().WithContext(ctx)

	var numericIDs []uint64
	var upworkIDs []string
	for _, ref := range uniqueRefs {
		if ref.numericID > 0 {
			numericIDs = append(numericIDs, ref.numericID)
		} else if ref.upworkID != "" {
			upworkIDs = append(upworkIDs, ref.upworkID)
		}
	}

	byNumericID := make(map[uint64]dbservice.Job, len(numericIDs))
	if len(numericIDs) > 0 {
		var rows []dbservice.Job
		if err := gormDB.Where("id IN ?", numericIDs).Find(&rows).Error; err != nil {
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to resolve job IDs"}
		}
		for _, row := range rows {
			byNumericID[uint64(row.ID)] = row
		}
	}

	byUpworkID := make(map[string]dbservice.Job, len(upworkIDs))
	if len(upworkIDs) > 0 {
		var rows []dbservice.Job
		if err := gormDB.Where("upwork_job_id IN ?", upworkIDs).Find(&rows).Error; err != nil {
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to resolve upwork job IDs"}
		}
		for _, row := range rows {
			if row.UpworkJobID != nil {
				byUpworkID[strings.TrimSpace(*row.UpworkJobID)] = row
			}
		}
	}

	var missing []string
	resolvedJobs := make([]dbservice.Job, 0, len(uniqueRefs))
	seenJobPK := make(map[uint]struct{}, len(uniqueRefs))
	for _, ref := range uniqueRefs {
		var job dbservice.Job
		var found bool
		if ref.numericID > 0 {
			job, found = byNumericID[ref.numericID]
		} else {
			job, found = byUpworkID[ref.upworkID]
		}
		if !found {
			missing = append(missing, ref.rawLabel)
			continue
		}
		if _, dup := seenJobPK[job.ID]; dup {
			continue
		}
		seenJobPK[job.ID] = struct{}{}
		resolvedJobs = append(resolvedJobs, job)
	}

	if len(missing) > 0 || len(resolvedJobs) == 0 {
		return nil, &ServiceError{
			Code:       "NOT_FOUND",
			HTTPStatus: http.StatusNotFound,
			Message:    "One or more requested jobs were not found",
			Details: map[string]any{
				"missing_job_ids": missing,
			},
		}
	}

	force := cfg.DefaultForce
	if req.Force != nil {
		force = *req.Force
	}
	skipDetailIfPresent := cfg.SkipDetailIfPresent
	if req.SkipDetailIfPresent != nil {
		skipDetailIfPresent = *req.SkipDetailIfPresent
	}
	requireDetails := cfg.RequireDetails
	if req.RequireDetails != nil {
		requireDetails = *req.RequireDetails
	}
	model := firstNonEmpty(req.Model, cfg.DefaultModel)
	triggeredBy := firstNonEmpty(req.TriggeredBy, "api")

	now := time.Now().UTC()
	runItems := make([]*activeBatchItemState, 0, len(resolvedJobs))
	runnableJobIDs := make([]uint, 0, len(resolvedJobs))
	skippedCount := 0
	queuedCount := 0

	for _, job := range resolvedJobs {
		hadPriorAI := isJobAIEnriched(job)
		priorStatus, priorErr, hadCompleted := priorJobAIState(job)
		skip := false
		switch mode {
		case EnrichmentModeFull, EnrichmentModeAIOnly:
			skip = !force && hadPriorAI
		case EnrichmentModeDetailOnly:
			skip = !force && skipDetailIfPresent && hasValidTime(job.LastEnrichedAt)
		}

		item := dbservice.EnrichmentBatchItem{
			JobID:  job.ID,
			Status: EnrichmentItemStatusQueued,
		}
		if skip {
			item.Status = EnrichmentItemStatusSkipped
			item.CompletedAt = &now
			skippedCount++
		} else {
			queuedCount++
			runnableJobIDs = append(runnableJobIDs, job.ID)
		}

		runItems = append(runItems, &activeBatchItemState{
			item:                item,
			job:                 job,
			hadPriorCompletedAI: hadCompleted,
			priorAIStatus:       priorStatus,
			priorAIError:        priorErr,
		})
	}

	batch := dbservice.EnrichmentBatch{
		Mode:         mode,
		TriggeredBy:  triggeredBy,
		Model:        model,
		Effort:       effort,
		Force:        force,
		Status:       EnrichmentBatchStatusQueued,
		TotalCount:   len(resolvedJobs),
		QueuedCount:  queuedCount,
		SkippedCount: skippedCount,
	}
	if queuedCount == 0 {
		batch.Status = EnrichmentBatchStatusCompleted
		batch.StartedAt = &now
		batch.CompletedAt = &now
	}

	if err := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&batch).Error; err != nil {
			return err
		}
		dbItems := make([]dbservice.EnrichmentBatchItem, 0, len(runItems))
		for _, st := range runItems {
			st.item.BatchID = batch.ID
			dbItems = append(dbItems, st.item)
		}
		if err := tx.Create(&dbItems).Error; err != nil {
			return err
		}
		for i := range dbItems {
			runItems[i].item = dbItems[i]
		}
		if len(runnableJobIDs) > 0 {
			if err := tx.Model(&dbservice.Job{}).
				Where("id IN ?", runnableJobIDs).
				Updates(map[string]any{
					"ai_enrichment_status": "queued",
					"ai_enrichment_error":  "",
				}).Error; err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to persist enrichment batch"}
	}

	if queuedCount == 0 {
		dashboardURL := m.server.buildEnrichmentBatchDashboardURL(batch.ID)
		entries := make([]EnrichmentBatchItemEntry, 0, len(runItems))
		for _, st := range runItems {
			entries = append(entries, enrichmentBatchItemEntryFromModel(st.item))
		}
		return &EnrichmentBatchDetailResponse{
			Batch:        enrichmentBatchSummaryFromModel(batch),
			Items:        entries,
			DashboardURL: dashboardURL,
			Completed:    true,
		}, nil
	}

	batchCtx, batchCancel := context.WithCancel(context.Background())
	run := &activeBatchRun{
		batchID:              batch.ID,
		mode:                 mode,
		skipDetailIfPresent:  skipDetailIfPresent,
		requireDetails:       requireDetails,
		maxConcurrency:       maxConcurrency,
		globalMaxConcurrency: globalMaxConcurrency,
		items:                runItems,
		ctx:                  batchCtx,
		cancel:               batchCancel,
		done:                 make(chan struct{}),
	}

	initialBatch := enrichmentBatchSummaryFromModel(batch)
	initialEntries := make([]EnrichmentBatchItemEntry, 0, len(runItems))
	for _, st := range runItems {
		initialEntries = append(initialEntries, enrichmentBatchItemEntryFromModel(st.item))
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		batchCancel()
		// Clean up persisted batch row as canceled since shutdown began concurrently.
		_ = m.finalizeAbandonedNewBatch(run)
		return nil, &ServiceError{Code: "SERVICE_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Enrichment manager is shutting down"}
	}
	m.active[batch.ID] = run
	m.wg.Add(1)
	m.mu.Unlock()

	go m.runBatch(run)

	if req.Wait != nil && *req.Wait {
		completed := false
		timer := time.NewTimer(waitTimeout)
		defer timer.Stop()

		select {
		case <-run.done:
			completed = true
		case <-timer.C:
			completed = false
		case <-ctx.Done():
			completed = false
		}

		snapCtx, snapCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer snapCancel()
		snap, err := m.GetBatch(snapCtx, batch.ID)
		if err != nil {
			return nil, err
		}
		snap.Completed = completed || isTerminalBatchStatus(snap.Batch.Status)
		return snap, nil
	}

	dashboardURL := m.server.buildEnrichmentBatchDashboardURL(batch.ID)

	return &EnrichmentBatchDetailResponse{
		Batch:        initialBatch,
		Items:        initialEntries,
		DashboardURL: dashboardURL,
		Completed:    false,
	}, nil
}

func (m *EnrichmentManager) finalizeAbandonedNewBatch(run *activeBatchRun) error {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m.finalizeBatch(cleanupCtx, run)
	return nil
}

func (m *EnrichmentManager) runBatch(run *activeBatchRun) {
	skipFinalize := false
	defer func() {
		if !skipFinalize {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			m.finalizeBatch(cleanupCtx, run)
			cancel()
		}

		m.mu.Lock()
		delete(m.active, run.batchID)
		m.mu.Unlock()

		close(run.done)
		m.wg.Done()
	}()

	gormDB := m.server.db.GetGorm()
	startNow := time.Now().UTC()
	startRes := gormDB.WithContext(run.ctx).Model(&dbservice.EnrichmentBatch{}).
		Where("id = ? AND status = ?", run.batchID, EnrichmentBatchStatusQueued).
		Updates(map[string]any{
			"status":     EnrichmentBatchStatusRunning,
			"started_at": &startNow,
		})
	if startRes.Error != nil {
		run.cancel()
		return
	}
	if startRes.RowsAffected == 0 {
		var cur dbservice.EnrichmentBatch
		if err := gormDB.WithContext(context.Background()).Select("status").First(&cur, run.batchID).Error; err == nil && isTerminalBatchStatus(cur.Status) {
			skipFinalize = true
		}
		run.cancel()
		return
	}

	if run.mode == EnrichmentModeFull || run.mode == EnrichmentModeDetailOnly {
		m.runPhaseA(run)
	}

	if run.ctx.Err() == nil && (run.mode == EnrichmentModeFull || run.mode == EnrichmentModeAIOnly) {
		m.runPhaseB(run)
	}
}

func (m *EnrichmentManager) runPhaseA(run *activeBatchRun) {
	gormDB := m.server.db.GetGorm()
	challengeHalted := false

	for _, st := range run.items {
		if run.ctx.Err() != nil {
			return
		}
		if st.item.Status != EnrichmentItemStatusQueued {
			continue
		}

		// Reload latest job snapshot before deciding skip/scrape.
		var latestJob dbservice.Job
		if err := gormDB.WithContext(run.ctx).First(&latestJob, st.item.JobID).Error; err == nil {
			st.job = latestJob
		}

		if run.mode == EnrichmentModeFull && run.skipDetailIfPresent && hasValidTime(st.job.LastEnrichedAt) {
			continue
		}

		if challengeHalted {
			if run.mode == EnrichmentModeDetailOnly || run.requireDetails {
				m.failDetailItem(run, st, "HUMAN_ACTION_REQUIRED", "Chrome detail scraping halted after challenge")
			}
			continue
		}

		targetURL := firstNonEmpty(st.job.CanonicalURL, st.job.URL)
		upworkID := ""
		if st.job.UpworkJobID != nil {
			upworkID = strings.TrimSpace(*st.job.UpworkJobID)
		}
		if upworkID == "" && targetURL != "" {
			if extracted := scoring.ExtractUpworkJobID(targetURL); extracted != "" {
				upworkID = extracted
				_ = gormDB.WithContext(run.ctx).Model(&dbservice.Job{}).
					Where("id = ? AND (upwork_job_id IS NULL OR upwork_job_id = '')", st.job.ID).
					Update("upwork_job_id", extracted).Error
			}
		}

		if upworkID == "" && targetURL == "" {
			if run.mode == EnrichmentModeDetailOnly || run.requireDetails {
				m.failDetailItem(run, st, "INVALID_PARAMS", "Job has no URL or upwork_job_id for detail scraping")
				m.rollupBatch(run.ctx, run, false)
			} else {
				m.requeueDetailItem(run, st)
				m.rollupBatch(run.ctx, run, false)
			}
			continue
		}

		if err := m.detailSem.Acquire(run.ctx, 1); err != nil {
			return
		}

		now := time.Now().UTC()
		_ = gormDB.WithContext(run.ctx).Model(&dbservice.EnrichmentBatchItem{}).
			Where("id = ?", st.item.ID).
			Updates(map[string]any{
				"status":     EnrichmentItemStatusScrapingDetails,
				"started_at": &now,
			}).Error
		st.item.Status = EnrichmentItemStatusScrapingDetails
		st.item.StartedAt = &now

		_ = gormDB.WithContext(run.ctx).Model(&dbservice.Job{}).
			Where("id = ?", st.item.JobID).
			Updates(map[string]any{
				"ai_enrichment_status": "scraping_details",
				"ai_enrichment_error":  "",
			}).Error

		m.rollupBatch(run.ctx, run, false)

		detailRes, detailErr := m.server.ExecuteDetailEnrich(run.ctx, DetailEnrichRequest{
			URL:         targetURL,
			UpworkJobID: upworkID,
		})
		m.detailSem.Release()

		if detailErr != nil {
			if run.ctx.Err() != nil || errors.Is(detailErr, context.Canceled) {
				return
			}
			if errors.Is(detailErr, bridge.ErrHumanActionRequired) {
				challengeHalted = true
				m.failDetailItem(run, st, bridge.ErrCodeHumanActionRequired, detailErr.Error())
				m.rollupBatch(run.ctx, run, false)
				continue
			}

			errCode := extractErrorCode(detailErr, "DETAIL_SCRAPE_FAILED")
			if errors.Is(detailErr, bridge.ErrExtensionDisconnected) {
				errCode = bridge.ErrCodeExtensionDisconnected
			}
			if run.mode == EnrichmentModeDetailOnly || run.requireDetails {
				m.failDetailItem(run, st, errCode, detailErr.Error())
			} else {
				log.Printf("⚠️ Enrichment batch %d job %d detail fallback to stored text: %v", run.batchID, st.item.JobID, detailErr)
				m.requeueDetailItem(run, st)
			}
			m.rollupBatch(run.ctx, run, false)
			continue
		}

		if detailRes == nil || detailRes.NotFound || detailRes.EnrichedCount == 0 {
			errCode := "DETAIL_SCRAPE_FAILED"
			errMsg := "Detail scrape returned no job data"
			if detailRes != nil {
				switch {
				case detailRes.StoppedReason == "rate_limited":
					errCode = "RATE_LIMITED"
					errMsg = "Chrome detail scraping rate-limited"
					challengeHalted = true
				case detailRes.NotFound:
					errCode = "JOB_NOT_FOUND"
					errMsg = "Job listing not found during detail scrape"
				}
			}
			if run.mode == EnrichmentModeDetailOnly || run.requireDetails {
				m.failDetailItem(run, st, errCode, errMsg)
			} else {
				m.requeueDetailItem(run, st)
			}
			m.rollupBatch(run.ctx, run, false)
			continue
		}

		// Detail scrape succeeded: persist completion using a bounded non-canceled context
		// so a concurrent batch cancellation cannot cause split-brain state.
		persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)

		var reloaded dbservice.Job
		if err := gormDB.WithContext(persistCtx).First(&reloaded, st.item.JobID).Error; err == nil {
			if !hasValidTime(reloaded.LastEnrichedAt) {
				enrichNow := time.Now().UTC()
				reloaded.LastEnrichedAt = &enrichNow
				_ = gormDB.WithContext(persistCtx).Model(&dbservice.Job{}).
					Where("id = ?", reloaded.ID).
					Update("last_enriched_at", enrichNow).Error
			}
			st.job = reloaded
		}

		st.item.DetailFetched = true
		if run.mode == EnrichmentModeDetailOnly {
			doneAt := time.Now().UTC()
			st.item.Status = EnrichmentItemStatusCompleted
			st.item.CompletedAt = &doneAt
			_ = gormDB.WithContext(persistCtx).Model(&dbservice.EnrichmentBatchItem{}).
				Where("id = ?", st.item.ID).
				Updates(map[string]any{
					"status":         EnrichmentItemStatusCompleted,
					"detail_fetched": true,
					"completed_at":   &doneAt,
				}).Error

			restoreJobAIStatus(persistCtx, gormDB, st.item.JobID, st.priorAIStatus, st.priorAIError)
		} else {
			st.item.Status = EnrichmentItemStatusQueued
			_ = gormDB.WithContext(persistCtx).Model(&dbservice.EnrichmentBatchItem{}).
				Where("id = ?", st.item.ID).
				Updates(map[string]any{
					"status":         EnrichmentItemStatusQueued,
					"detail_fetched": true,
				}).Error
			_ = gormDB.WithContext(persistCtx).Model(&dbservice.Job{}).
				Where("id = ?", st.item.JobID).
				Updates(map[string]any{
					"ai_enrichment_status": "queued",
					"ai_enrichment_error":  "",
				}).Error
		}

		m.rollupBatch(persistCtx, run, false)
		persistCancel()
	}
}

func (m *EnrichmentManager) failDetailItem(run *activeBatchRun, st *activeBatchItemState, code, msg string) {
	gormDB := m.server.db.GetGorm()
	now := time.Now().UTC()
	st.item.Status = EnrichmentItemStatusFailed
	st.item.ErrorCode = code
	st.item.ErrorMessage = msg
	st.item.CompletedAt = &now

	_ = gormDB.WithContext(run.ctx).Model(&dbservice.EnrichmentBatchItem{}).
		Where("id = ?", st.item.ID).
		Updates(map[string]any{
			"status":        EnrichmentItemStatusFailed,
			"error_code":    code,
			"error_message": msg,
			"completed_at":  &now,
		}).Error

	if st.hadPriorCompletedAI {
		_ = gormDB.WithContext(run.ctx).Model(&dbservice.Job{}).
			Where("id = ?", st.item.JobID).
			Updates(map[string]any{
				"ai_enrichment_status": "completed",
				"ai_enrichment_error":  "",
			}).Error
	} else {
		_ = gormDB.WithContext(run.ctx).Model(&dbservice.Job{}).
			Where("id = ?", st.item.JobID).
			Updates(map[string]any{
				"ai_enrichment_status": "failed",
				"ai_enrichment_error":  msg,
			}).Error
	}
}

func (m *EnrichmentManager) requeueDetailItem(run *activeBatchRun, st *activeBatchItemState) {
	gormDB := m.server.db.GetGorm()
	st.item.Status = EnrichmentItemStatusQueued
	st.item.DetailFetched = false

	_ = gormDB.WithContext(run.ctx).Model(&dbservice.EnrichmentBatchItem{}).
		Where("id = ?", st.item.ID).
		Updates(map[string]any{
			"status":         EnrichmentItemStatusQueued,
			"detail_fetched": false,
		}).Error

	_ = gormDB.WithContext(run.ctx).Model(&dbservice.Job{}).
		Where("id = ?", st.item.JobID).
		Updates(map[string]any{
			"ai_enrichment_status": "queued",
			"ai_enrichment_error":  "",
		}).Error
}

func (m *EnrichmentManager) runPhaseB(run *activeBatchRun) {
	var queue []*activeBatchItemState
	for _, st := range run.items {
		if st.item.Status == EnrichmentItemStatusQueued {
			queue = append(queue, st)
		}
	}
	if len(queue) == 0 || run.ctx.Err() != nil {
		return
	}

	workers := run.maxConcurrency
	if workers < 1 {
		workers = 1
	}
	if workers > len(queue) {
		workers = len(queue)
	}

	ch := make(chan *activeBatchItemState, len(queue))
	for _, st := range queue {
		ch <- st
	}
	close(ch)

	var poolWG sync.WaitGroup
	for i := 0; i < workers; i++ {
		poolWG.Add(1)
		go func() {
			defer poolWG.Done()
			for st := range ch {
				if run.ctx.Err() != nil {
					return
				}
				m.processPhaseBItem(run, st)
			}
		}()
	}
	poolWG.Wait()
}

func (m *EnrichmentManager) processPhaseBItem(run *activeBatchRun, st *activeBatchItemState) {
	if run.ctx.Err() != nil {
		return
	}

	if err := m.llmSem.Acquire(run.ctx, run.globalMaxConcurrency); err != nil {
		return
	}
	defer m.llmSem.Release()

	gormDB := m.server.db.GetGorm()
	now := time.Now().UTC()

	itemUpdates := map[string]any{
		"status": EnrichmentItemStatusAnalyzing,
	}
	if st.item.StartedAt == nil {
		itemUpdates["started_at"] = &now
		st.item.StartedAt = &now
	}
	st.item.Status = EnrichmentItemStatusAnalyzing

	_ = gormDB.WithContext(run.ctx).Model(&dbservice.EnrichmentBatchItem{}).
		Where("id = ?", st.item.ID).
		Updates(itemUpdates).Error

	_ = gormDB.WithContext(run.ctx).Model(&dbservice.Job{}).
		Where("id = ?", st.item.JobID).
		Updates(map[string]any{
			"ai_enrichment_status": "analyzing",
			"ai_enrichment_error":  "",
		}).Error

	m.rollupBatch(run.ctx, run, false)

	var batchModel, batchEffort string
	var bRow dbservice.EnrichmentBatch
	if err := gormDB.WithContext(run.ctx).Select("model, effort").First(&bRow, run.batchID).Error; err == nil {
		batchModel = bRow.Model
		batchEffort = bRow.Effort
	}

	useLLM := true
	res, err := m.server.AnalyzeJob(run.ctx, AnalyzeJobRequest{
		JobID:         st.item.JobID,
		EnsureDetails: false,
		UseLLM:        &useLLM,
		Model:         batchModel,
		Effort:        batchEffort,
	})

	if err != nil {
		if run.ctx.Err() != nil || errors.Is(err, context.Canceled) {
			cancelCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			doneAt := time.Now().UTC()
			st.item.Status = EnrichmentItemStatusCanceled
			st.item.CompletedAt = &doneAt
			_ = gormDB.WithContext(cancelCtx).Model(&dbservice.EnrichmentBatchItem{}).
				Where("id = ?", st.item.ID).
				Updates(map[string]any{
					"status":       EnrichmentItemStatusCanceled,
					"completed_at": &doneAt,
				}).Error

			restoreJobAIStatus(cancelCtx, gormDB, st.item.JobID, st.priorAIStatus, st.priorAIError)
			m.rollupBatch(cancelCtx, run, false)
			return
		}

		errCode := extractErrorCode(err, "LLM_ERROR")
		llmInvoked := errCode != "OLLAMA_UNAVAILABLE"
		doneAt := time.Now().UTC()
		st.item.Status = EnrichmentItemStatusFailed
		st.item.LLMInvoked = llmInvoked
		st.item.ErrorCode = errCode
		st.item.ErrorMessage = err.Error()
		st.item.CompletedAt = &doneAt

		persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer persistCancel()

		_ = gormDB.WithContext(persistCtx).Model(&dbservice.EnrichmentBatchItem{}).
			Where("id = ?", st.item.ID).
			Updates(map[string]any{
				"status":        EnrichmentItemStatusFailed,
				"llm_invoked":   llmInvoked,
				"error_code":    errCode,
				"error_message": err.Error(),
				"completed_at":  &doneAt,
			}).Error

		_ = gormDB.WithContext(persistCtx).Model(&dbservice.Job{}).
			Where("id = ?", st.item.JobID).
			Updates(map[string]any{
				"ai_enrichment_status": "failed",
				"ai_enrichment_error":  err.Error(),
			}).Error

		m.rollupBatch(persistCtx, run, false)
		return
	}

	var usage *ollama.TokenUsage
	if res != nil {
		if res.Usage != nil {
			usage = res.Usage
		} else if res.LLMAnalysis != nil && res.LLMAnalysis.Usage != nil {
			usage = res.LLMAnalysis.Usage
		}
	}

	var inTok, outTok, thoughtTok, totalTok int
	if usage != nil {
		inTok = usage.InputTokens
		outTok = usage.OutputTokens
		thoughtTok = usage.ThoughtTokens
		totalTok = usage.TotalTokens
	}
	effModel := batchModel
	effEffort := batchEffort
	if res != nil {
		effModel = firstNonEmpty(res.AIModel, batchModel)
		effEffort = firstNonEmpty(res.AIEffort, batchEffort)
	}

	doneAt := time.Now().UTC()
	st.item.Status = EnrichmentItemStatusCompleted
	st.item.LLMInvoked = true
	st.item.Model = effModel
	st.item.Effort = effEffort
	st.item.InputTokens = inTok
	st.item.OutputTokens = outTok
	st.item.ThoughtTokens = thoughtTok
	st.item.TotalTokens = totalTok
	st.item.CompletedAt = &doneAt

	persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer persistCancel()

	_ = gormDB.WithContext(persistCtx).Model(&dbservice.EnrichmentBatchItem{}).
		Where("id = ?", st.item.ID).
		Updates(map[string]any{
			"status":         EnrichmentItemStatusCompleted,
			"llm_invoked":    true,
			"model":          effModel,
			"effort":         effEffort,
			"input_tokens":   inTok,
			"output_tokens":  outTok,
			"thought_tokens": thoughtTok,
			"total_tokens":   totalTok,
			"error_code":     "",
			"error_message":  "",
			"completed_at":   &doneAt,
		}).Error

	m.rollupBatch(persistCtx, run, false)
}

func (m *EnrichmentManager) finalizeBatch(ctx context.Context, run *activeBatchRun) {
	run.rollupMu.Lock()
	defer run.rollupMu.Unlock()

	gormDB := m.server.db.GetGorm().WithContext(ctx)
	now := time.Now().UTC()

	var remaining []dbservice.EnrichmentBatchItem
	if err := gormDB.Where("batch_id = ? AND status IN ?", run.batchID, []string{
		EnrichmentItemStatusQueued,
		EnrichmentItemStatusScrapingDetails,
		EnrichmentItemStatusAnalyzing,
		"running",
	}).Find(&remaining).Error; err == nil && len(remaining) > 0 {
		type priorState struct {
			status string
			errMsg string
		}
		priorAIMap := make(map[uint]priorState, len(run.items))
		for _, st := range run.items {
			priorAIMap[st.item.JobID] = priorState{
				status: st.priorAIStatus,
				errMsg: st.priorAIError,
			}
		}

		isCanceled := run.ctx.Err() != nil
		targetItemStatus := EnrichmentItemStatusFailed
		errCode := "BATCH_INTERRUPTED"
		errMsg := "Enrichment batch interrupted"
		if isCanceled {
			targetItemStatus = EnrichmentItemStatusCanceled
			errCode = ""
			errMsg = ""
		}

		for _, item := range remaining {
			_ = gormDB.Model(&dbservice.EnrichmentBatchItem{}).
				Where("id = ?", item.ID).
				Updates(map[string]any{
					"status":        targetItemStatus,
					"error_code":    errCode,
					"error_message": errMsg,
					"completed_at":  &now,
				}).Error

			ps := priorAIMap[item.JobID]
			restoreJobAIStatus(ctx, gormDB, item.JobID, ps.status, ps.errMsg)
		}
	}

	m.rollupBatchLocked(ctx, run.batchID, true)
}

func restoreJobAIStatus(ctx context.Context, gormDB *gorm.DB, jobID uint, priorStatus, priorErr string) {
	if gormDB == nil || jobID == 0 {
		return
	}
	var job dbservice.Job
	if jErr := gormDB.WithContext(ctx).Select("id, proposal, ai_enriched_at").First(&job, jobID).Error; jErr != nil {
		return
	}
	restoredStatus := "none"
	restoredErr := ""
	switch {
	case priorStatus == "completed" || strings.TrimSpace(job.Proposal) != "" || hasValidTime(job.AIEnrichedAt):
		restoredStatus = "completed"
	case priorStatus == "failed":
		restoredStatus = "failed"
		restoredErr = priorErr
	}
	_ = gormDB.WithContext(ctx).Model(&dbservice.Job{}).
		Where("id = ? AND ai_enrichment_status IN ?", jobID, []string{"queued", "scraping_details", "analyzing"}).
		Updates(map[string]any{
			"ai_enrichment_status": restoredStatus,
			"ai_enrichment_error":  restoredErr,
		}).Error
}

func (m *EnrichmentManager) rollupBatch(ctx context.Context, run *activeBatchRun, terminal bool) {
	if ctx.Err() != nil {
		return
	}
	run.rollupMu.Lock()
	defer run.rollupMu.Unlock()
	m.rollupBatchLocked(ctx, run.batchID, terminal)
}

func (m *EnrichmentManager) rollupBatchLocked(ctx context.Context, batchID uint, terminal bool) {
	gormDB := m.server.db.GetGorm().WithContext(ctx)

	var items []dbservice.EnrichmentBatchItem
	if err := gormDB.Where("batch_id = ?", batchID).Find(&items).Error; err != nil {
		return
	}

	var queued, running, completed, skipped, failed, canceled, totalTokens int
	for _, it := range items {
		totalTokens += it.TotalTokens
		switch it.Status {
		case EnrichmentItemStatusQueued:
			queued++
		case EnrichmentItemStatusScrapingDetails, EnrichmentItemStatusAnalyzing, "running":
			running++
		case EnrichmentItemStatusCompleted:
			completed++
		case EnrichmentItemStatusSkipped:
			skipped++
		case EnrichmentItemStatusFailed:
			failed++
		case EnrichmentItemStatusCanceled:
			canceled++
		}
	}

	updates := map[string]any{
		"queued_count":      queued,
		"running_count":     running,
		"completed_count":   completed,
		"skipped_count":     skipped,
		"failed_count":      failed,
		"canceled_count":    canceled,
		"total_tokens_used": totalTokens,
	}

	if terminal {
		now := time.Now().UTC()
		updates["queued_count"] = 0
		updates["running_count"] = 0
		updates["completed_at"] = &now

		var batchStatus string
		switch {
		case canceled > 0:
			batchStatus = EnrichmentBatchStatusCanceled
		case failed > 0 && completed == 0 && skipped == 0:
			batchStatus = EnrichmentBatchStatusFailed
		case failed > 0:
			batchStatus = EnrichmentBatchStatusCompletedWithErrors
		default:
			batchStatus = EnrichmentBatchStatusCompleted
		}
		updates["status"] = batchStatus
	}

	_ = gormDB.Model(&dbservice.EnrichmentBatch{}).Where("id = ?", batchID).Updates(updates).Error
}

// CancelBatch cancels an active batch (or marks remaining queued items canceled) and returns the latest state.
func (m *EnrichmentManager) CancelBatch(ctx context.Context, batchID uint) (*EnrichmentBatchDetailResponse, error) {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if batchID == 0 || uint64(batchID) > math.MaxInt64 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid enrichment batch ID"}
	}

	gormDB := m.server.db.GetGorm().WithContext(ctx)
	var batch dbservice.EnrichmentBatch
	if err := gormDB.First(&batch, batchID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Enrichment batch not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load enrichment batch"}
	}

	if isTerminalBatchStatus(batch.Status) {
		return m.GetBatch(ctx, batchID)
	}

	m.mu.Lock()
	run := m.active[batchID]
	m.mu.Unlock()

	if run != nil {
		run.cancel()
		select {
		case <-run.done:
		case <-ctx.Done():
		}
		return m.GetBatch(ctx, batchID)
	}

	// Fallback if batch is non-terminal in DB but not tracked in m.active.
	now := time.Now().UTC()
	if err := gormDB.Transaction(func(tx *gorm.DB) error {
		var items []dbservice.EnrichmentBatchItem
		if err := tx.Where("batch_id = ? AND status IN ?", batchID, []string{
			EnrichmentItemStatusQueued,
			EnrichmentItemStatusScrapingDetails,
			EnrichmentItemStatusAnalyzing,
			"running",
		}).Find(&items).Error; err != nil {
			return err
		}
		for _, item := range items {
			if err := tx.Model(&dbservice.EnrichmentBatchItem{}).
				Where("id = ?", item.ID).
				Updates(map[string]any{
					"status":       EnrichmentItemStatusCanceled,
					"completed_at": &now,
				}).Error; err != nil {
				return err
			}
			var job dbservice.Job
			if err := tx.Select("id, proposal, ai_enriched_at").First(&job, item.JobID).Error; err == nil {
				restoredStatus := "none"
				if strings.TrimSpace(job.Proposal) != "" || hasValidTime(job.AIEnrichedAt) {
					restoredStatus = "completed"
				}
				_ = tx.Model(&dbservice.Job{}).
					Where("id = ? AND ai_enrichment_status IN ?", item.JobID, []string{"queued", "scraping_details", "analyzing"}).
					Updates(map[string]any{
						"ai_enrichment_status": restoredStatus,
						"ai_enrichment_error":  "",
					}).Error
			}
		}
		return nil
	}); err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to cancel enrichment batch"}
	}

	m.rollupBatchLocked(ctx, batchID, true)
	return m.GetBatch(ctx, batchID)
}

// ListBatches returns enrichment batches ordered newest-first with optional status filtering.
func (m *EnrichmentManager) ListBatches(ctx context.Context, status string, limit, offset int) ([]EnrichmentBatchSummary, int, error) {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil, 0, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	trimmedStatus := strings.ToLower(strings.TrimSpace(status))
	if trimmedStatus != "" && !isValidBatchStatusFilter(trimmedStatus) {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid status filter"}
	}
	if limit < 0 {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid limit parameter"}
	}
	if offset < 0 {
		return nil, 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid offset parameter"}
	}
	if limit == 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}

	gormDB := m.server.db.GetGorm().WithContext(ctx)
	query := gormDB.Model(&dbservice.EnrichmentBatch{})
	if trimmedStatus != "" {
		query = query.Where("status = ?", trimmedStatus)
	}

	var total64 int64
	if err := query.Session(&gorm.Session{}).Count(&total64).Error; err != nil {
		return nil, 0, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to count enrichment batches"}
	}

	var rows []dbservice.EnrichmentBatch
	if err := query.Order("created_at DESC, id DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		return nil, 0, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list enrichment batches"}
	}

	out := make([]EnrichmentBatchSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, enrichmentBatchSummaryFromModel(r))
	}
	return out, int(total64), nil
}

// GetBatch retrieves a single EnrichmentBatch and its EnrichmentBatchItems.
func (m *EnrichmentManager) GetBatch(ctx context.Context, batchID uint) (*EnrichmentBatchDetailResponse, error) {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if batchID == 0 || uint64(batchID) > math.MaxInt64 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid enrichment batch ID"}
	}

	gormDB := m.server.db.GetGorm().WithContext(ctx)
	var batch dbservice.EnrichmentBatch
	if err := gormDB.First(&batch, batchID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Enrichment batch not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load enrichment batch"}
	}

	var items []dbservice.EnrichmentBatchItem
	if err := gormDB.Where("batch_id = ?", batchID).Order("id ASC").Find(&items).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load enrichment batch items"}
	}

	entries := make([]EnrichmentBatchItemEntry, 0, len(items))
	for _, item := range items {
		entries = append(entries, enrichmentBatchItemEntryFromModel(item))
	}

	return &EnrichmentBatchDetailResponse{
		Batch:        enrichmentBatchSummaryFromModel(batch),
		Items:        entries,
		DashboardURL: m.server.buildEnrichmentBatchDashboardURL(batch.ID),
		Completed:    isTerminalBatchStatus(batch.Status),
	}, nil
}

// RecoverInterruptedBatches marks interrupted queued/running batches and items as failed on daemon startup
// and restores any stuck jobs.ai_enrichment_status rows back to completed or none.
func (m *EnrichmentManager) RecoverInterruptedBatches(ctx context.Context) error {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil
	}

	gormDB := m.server.db.GetGorm().WithContext(ctx)
	now := time.Now().UTC()

	return gormDB.Transaction(func(tx *gorm.DB) error {
		var interruptedBatches []dbservice.EnrichmentBatch
		if err := tx.Where("status IN ?", []string{EnrichmentBatchStatusQueued, EnrichmentBatchStatusRunning}).
			Find(&interruptedBatches).Error; err != nil {
			return err
		}

		if err := tx.Model(&dbservice.EnrichmentBatchItem{}).
			Where("status IN ?", []string{
				EnrichmentItemStatusQueued,
				EnrichmentItemStatusScrapingDetails,
				EnrichmentItemStatusAnalyzing,
				"running",
			}).
			Updates(map[string]any{
				"status":        EnrichmentItemStatusFailed,
				"error_code":    "SERVER_RESTARTED",
				"error_message": "Batch interrupted by server restart",
				"completed_at":  gorm.Expr("COALESCE(completed_at, ?)", now),
			}).Error; err != nil {
			return err
		}

		if err := tx.Exec(`
			UPDATE jobs
			SET ai_enrichment_status = CASE
				WHEN COALESCE(proposal, '') ~ '\S' OR ai_enriched_at IS NOT NULL THEN 'completed'
				ELSE 'none'
			END,
			ai_enrichment_error = CASE
				WHEN COALESCE(proposal, '') ~ '\S' OR ai_enriched_at IS NOT NULL THEN ''
				ELSE ai_enrichment_error
			END
			WHERE ai_enrichment_status IN ('queued', 'scraping_details', 'analyzing')
		`).Error; err != nil {
			return err
		}

		for _, b := range interruptedBatches {
			var items []dbservice.EnrichmentBatchItem
			if err := tx.Where("batch_id = ?", b.ID).Find(&items).Error; err != nil {
				return err
			}
			var completed, skipped, failed, canceled, totalTokens int
			for _, it := range items {
				totalTokens += it.TotalTokens
				switch it.Status {
				case EnrichmentItemStatusCompleted:
					completed++
				case EnrichmentItemStatusSkipped:
					skipped++
				case EnrichmentItemStatusFailed:
					failed++
				case EnrichmentItemStatusCanceled:
					canceled++
				}
			}
			var batchStatus string
			switch {
			case canceled > 0:
				batchStatus = EnrichmentBatchStatusCanceled
			case failed == 0 && (completed > 0 || skipped > 0):
				batchStatus = EnrichmentBatchStatusCompleted
			case failed > 0 && completed == 0 && skipped == 0:
				batchStatus = EnrichmentBatchStatusFailed
			case failed > 0:
				batchStatus = EnrichmentBatchStatusCompletedWithErrors
			default:
				batchStatus = EnrichmentBatchStatusFailed
			}
			if err := tx.Model(&dbservice.EnrichmentBatch{}).
				Where("id = ?", b.ID).
				Updates(map[string]any{
					"status":            batchStatus,
					"queued_count":      0,
					"running_count":     0,
					"completed_count":   completed,
					"skipped_count":     skipped,
					"failed_count":      failed,
					"canceled_count":    canceled,
					"total_tokens_used": totalTokens,
					"completed_at":      gorm.Expr("COALESCE(completed_at, ?)", now),
				}).Error; err != nil {
				return err
			}
		}

		return nil
	})
}

// Shutdown cancels all running batches and waits for worker goroutines to exit (or ctx to expire).
func (m *EnrichmentManager) Shutdown(ctx context.Context) error {
	if m == nil {
		return nil
	}

	m.mu.Lock()
	m.closed = true
	cancels := make([]context.CancelFunc, 0, len(m.active))
	for _, run := range m.active {
		cancels = append(cancels, run.cancel)
	}
	m.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}

	doneCh := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(doneCh)
	}()

	select {
	case <-doneCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close cancels all active batches and waits for background enrichment workers to finish.
func (m *EnrichmentManager) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return m.Shutdown(ctx)
}

func extractErrorCode(err error, fallback string) string {
	var se *ServiceError
	if errors.As(err, &se) && se != nil && strings.TrimSpace(se.Code) != "" {
		return strings.TrimSpace(se.Code)
	}
	var be *bridge.BridgeError
	if errors.As(err, &be) && be != nil && strings.TrimSpace(be.Code) != "" {
		return strings.TrimSpace(be.Code)
	}
	return fallback
}
