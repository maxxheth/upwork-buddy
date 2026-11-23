package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
)

const (
	watcherSchedulerInterval  = 15 * time.Second
	watcherLiveQueueSize      = 32
	maxConsecutiveRuleErrors  = 3
	defaultWatcherIntervalMin = 5
	defaultWatcherJitter      = 0.35
)

// WatchRuleView is the API/MCP DTO for a WatchRule.
type WatchRuleView struct {
	ID                           uint                `json:"id"`
	Name                         string              `json:"name"`
	Description                  string              `json:"description"`
	Enabled                      bool                `json:"enabled"`
	DiscoveryBackend             string              `json:"discovery_backend"`
	SearchProfileID              *uint               `json:"search_profile_id,omitempty"`
	DiscoveryConfig              DiscoveryConfig     `json:"discovery_config"`
	IntervalMinutes              int                 `json:"interval_minutes"`
	JitterRatio                  float64             `json:"jitter_ratio"`
	ActiveHours                  string              `json:"active_hours"`
	MinScore                     int                 `json:"min_score"`
	MaxProposals                 *int                `json:"max_proposals,omitempty"`
	MaxPostedAgeMinutes          *int                `json:"max_posted_age_minutes,omitempty"`
	MaxConnectsPerJob            *int                `json:"max_connects_per_job,omitempty"`
	RequirePaymentVerified       bool                `json:"require_payment_verified"`
	RequiredKeywords             []string            `json:"required_keywords"`
	ExcludeKeywords              []string            `json:"exclude_keywords"`
	ActionMode                   string              `json:"action_mode"`
	LLMModel                     string              `json:"llm_model"`
	LLMEffort                    string              `json:"llm_effort"`
	BidStrategy                  *ollama.BidStrategy `json:"bid_strategy,omitempty"`
	AutoSubmitMinConfidence      float64             `json:"auto_submit_min_confidence"`
	FallbackOnScreeningQuestions bool                `json:"fallback_on_screening_questions"`
	MaxReactionsPerTick          int                 `json:"max_reactions_per_tick"`
	SeedBaselineOnFirstRun       bool                `json:"seed_baseline_on_first_run"`
	SeededAt                     *string             `json:"seeded_at,omitempty"`
	PausedReason                 string              `json:"paused_reason"`
	ConsecutiveErrors            int                 `json:"consecutive_errors"`
	NextRunAt                    *string             `json:"next_run_at,omitempty"`
	LastRunAt                    *string             `json:"last_run_at,omitempty"`
	LastSuccessAt                *string             `json:"last_success_at,omitempty"`
	LastError                    string              `json:"last_error"`
	CreatedAt                    string              `json:"created_at"`
	UpdatedAt                    string              `json:"updated_at"`
}

// WatchRunView is the API/MCP DTO for a WatchRun.
type WatchRunView struct {
	ID               uint    `json:"id"`
	WatchRuleID      uint    `json:"watch_rule_id"`
	DiscoveryBackend string  `json:"discovery_backend"`
	TriggeredBy      string  `json:"triggered_by"`
	SearchRunID      *uint   `json:"search_run_id,omitempty"`
	Status           string  `json:"status"`
	ScrapedCount     int     `json:"scraped_count"`
	NewJobsCount     int     `json:"new_jobs_count"`
	QualifiedCount   int     `json:"qualified_count"`
	DraftedCount     int     `json:"drafted_count"`
	FilledCount      int     `json:"filled_count"`
	SubmittedCount   int     `json:"submitted_count"`
	AlertedCount     int     `json:"alerted_count"`
	ErrorCode        string  `json:"error_code,omitempty"`
	ErrorMessage     string  `json:"error_message,omitempty"`
	StartedAt        string  `json:"started_at"`
	CompletedAt      *string `json:"completed_at,omitempty"`
	CreatedAt        string  `json:"created_at"`
}

// WatchEventView is the API/MCP DTO for a WatchEvent.
type WatchEventView struct {
	ID             uint     `json:"id"`
	WatchRuleID    uint     `json:"watch_rule_id"`
	WatchRunID     *uint    `json:"watch_run_id,omitempty"`
	JobID          uint     `json:"job_id"`
	JobTitle       string   `json:"job_title,omitempty"`
	UpworkJobID    string   `json:"upwork_job_id"`
	ProposalID     *uint    `json:"proposal_id,omitempty"`
	Stage          string   `json:"stage"`
	DecisionReason string   `json:"decision_reason"`
	Confidence     *float64 `json:"confidence,omitempty"`
	ErrorCode      string   `json:"error_code,omitempty"`
	ErrorMessage   string   `json:"error_message,omitempty"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

// WatcherStatusView summarizes the watcher daemon and rule counts.
type WatcherStatusView struct {
	Running                    bool   `json:"running"`
	ActiveRules                int    `json:"active_rules"`
	PausedRules                int    `json:"paused_rules"`
	ActiveReactions            int    `json:"active_reactions"`
	ScraperFSAvailable         bool   `json:"scraper_fs_available"`
	ScraperFSDir               string `json:"scraper_fs_dir"`
	ScraperFSReason            string `json:"scraper_fs_reason"`
	LiveIngestEnabled          bool   `json:"live_ingest_enabled"`
	LiveIngestIncludeScraperFS bool   `json:"live_ingest_include_scraper_fs"`
	LiveBatchesSeen            int64  `json:"live_batches_seen,omitempty"`
	LiveJobsIngested           int64  `json:"live_jobs_ingested,omitempty"`
	LiveDroppedBatches         int64  `json:"live_dropped_batches,omitempty"`
}

// NullableInt distinguishes omitted JSON fields from explicit null or integer values.
type NullableInt struct {
	Set   bool
	Value *int
}

// NewNullableInt constructs a set NullableInt wrapping v.
func NewNullableInt(v int) NullableInt {
	return NullableInt{Set: true, Value: &v}
}

// UnmarshalJSON records Set=true and decodes either null or an integer.
func (n *NullableInt) UnmarshalJSON(data []byte) error {
	n.Set = true
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		n.Value = nil
		return nil
	}
	var v int
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	n.Value = &v
	return nil
}

// MarshalJSON encodes either null or the underlying integer.
func (n NullableInt) MarshalJSON() ([]byte, error) {
	if n.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*n.Value)
}

// UpsertWatchRuleInput configures creating or updating a WatchRule.
type UpsertWatchRuleInput struct {
	Name                         *string             `json:"name,omitempty"`
	Description                  *string             `json:"description,omitempty"`
	Enabled                      *bool               `json:"enabled,omitempty"`
	DiscoveryBackend             *string             `json:"discovery_backend,omitempty"`
	SearchProfileID              *uint               `json:"search_profile_id,omitempty"`
	ClearSearchProfileID         bool                `json:"clear_search_profile_id,omitempty"`
	DiscoveryConfig              *DiscoveryConfig    `json:"discovery_config,omitempty"`
	IntervalMinutes              *int                `json:"interval_minutes,omitempty"`
	JitterRatio                  *float64            `json:"jitter_ratio,omitempty"`
	ActiveHours                  *string             `json:"active_hours,omitempty"`
	MinScore                     *int                `json:"min_score,omitempty"`
	MaxProposals                 NullableInt         `json:"max_proposals,omitempty"`
	MaxPostedAgeMinutes          NullableInt         `json:"max_posted_age_minutes,omitempty"`
	MaxConnectsPerJob            NullableInt         `json:"max_connects_per_job,omitempty"`
	RequirePaymentVerified       *bool               `json:"require_payment_verified,omitempty"`
	RequiredKeywords             []string            `json:"required_keywords,omitempty"`
	ExcludeKeywords              []string            `json:"exclude_keywords,omitempty"`
	ActionMode                   *string             `json:"action_mode,omitempty"`
	LLMModel                     *string             `json:"llm_model,omitempty"`
	LLMEffort                    *string             `json:"llm_effort,omitempty"`
	BidStrategy                  *ollama.BidStrategy `json:"bid_strategy,omitempty"`
	AutoSubmitMinConfidence      *float64            `json:"auto_submit_min_confidence,omitempty"`
	FallbackOnScreeningQuestions *bool               `json:"fallback_on_screening_questions,omitempty"`
	MaxReactionsPerTick          *int                `json:"max_reactions_per_tick,omitempty"`
	SeedBaselineOnFirstRun       *bool               `json:"seed_baseline_on_first_run,omitempty"`
}

// WatchRunResult bundles a WatchRunView and its WatchEventViews.
type WatchRunResult struct {
	Run    WatchRunView     `json:"run"`
	Events []WatchEventView `json:"events"`
}

// WatcherManager coordinates scheduled and on-demand watch rule execution.
type WatcherManager struct {
	server          *Server
	scraperFSRunner *ScraperFSRunner
	notifier        *Notifier

	draftFastProposalFn func(ctx context.Context, req ollama.FastProposalRequest) (*ollama.FastProposalResponse, error)

	mu                 sync.Mutex
	running            bool
	closed             bool
	cancel             context.CancelFunc
	wg                 sync.WaitGroup
	activeRules        map[uint]context.CancelFunc
	activeCount        atomic.Int32
	liveQueue          chan bridge.SearchObservedEvent
	liveBatchesSeen    atomic.Int64
	liveJobsIngested   atomic.Int64
	liveDroppedBatches atomic.Int64
	nowFn              func() time.Time
	localLoc           *time.Location
}

// NewWatcherManager constructs a WatcherManager bound to *Server.
func NewWatcherManager(s *Server) *WatcherManager {
	return &WatcherManager{
		server:          s,
		scraperFSRunner: NewScraperFSRunner(LoadScraperFSConfigFromEnv()),
		notifier:        NewNotifier(s),
		activeRules:     make(map[uint]context.CancelFunc),
		liveQueue:       make(chan bridge.SearchObservedEvent, watcherLiveQueueSize),
		nowFn:           time.Now,
		localLoc:        time.Local,
	}
}

func (m *WatcherManager) gormDB() *gorm.DB {
	if m == nil || m.server == nil || m.server.db == nil {
		return nil
	}
	return m.server.db.GetGorm()
}

// IsWatcherEnabledFromEnv returns true unless WATCHER_ENABLED is explicitly false/0/no/off.
func IsWatcherEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("WATCHER_ENABLED"))) {
	case "false", "0", "no", "off":
		return false
	default:
		return true
	}
}

// IsLiveIngestEnabledFromEnv returns true unless WATCHER_LIVE_INGEST_ENABLED is explicitly false/0/no/off.
func IsLiveIngestEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("WATCHER_LIVE_INGEST_ENABLED"))) {
	case "false", "0", "no", "off":
		return false
	default:
		return true
	}
}

// IsLiveIngestIncludeScraperFSFromEnv returns true only when WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS is explicitly true/1/yes/on.
func IsLiveIngestIncludeScraperFSFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("WATCHER_LIVE_INGEST_INCLUDE_SCRAPER_FS"))) {
	case "true", "1", "yes", "on":
		return true
	default:
		return false
	}
}

// Start recovers interrupted runs and starts the background 15s scheduler loop and live-ingest worker.
func (m *WatcherManager) Start(ctx context.Context) error {
	if m == nil {
		return nil
	}
	if err := m.RecoverInterruptedRuns(ctx); err != nil {
		log.Printf("watcher: recover interrupted runs error: %v", err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return &ServiceError{Code: "WATCHER_CLOSED", HTTPStatus: http.StatusServiceUnavailable, Message: "Watcher manager is closed"}
	}
	if m.running {
		return nil
	}
	if m.liveQueue == nil {
		m.liveQueue = make(chan bridge.SearchObservedEvent, watcherLiveQueueSize)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.running = true
	m.wg.Add(2)
	go m.schedulerLoop(runCtx)
	go m.liveIngestLoop(runCtx)
	return nil
}

// Close stops the scheduler loop, cancels active runs, drains workers, and closes the notifier.
func (m *WatcherManager) Close() error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	cancel := m.cancel
	m.running = false
	m.cancel = nil
	activeCancels := make([]context.CancelFunc, 0, len(m.activeRules))
	for _, c := range m.activeRules {
		if c != nil {
			activeCancels = append(activeCancels, c)
		}
	}
	m.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	for _, c := range activeCancels {
		c()
	}
	m.wg.Wait()

	if m.notifier != nil {
		return m.notifier.Close()
	}
	return nil
}

// CancelAll cancels all in-flight rule executions and pauses enabled rules with PausedReason="KILL_SWITCH".
func (m *WatcherManager) CancelAll(reason string) {
	if m == nil {
		return
	}
	m.mu.Lock()
	activeCancels := make([]context.CancelFunc, 0, len(m.activeRules))
	for _, c := range m.activeRules {
		if c != nil {
			activeCancels = append(activeCancels, c)
		}
	}
	m.mu.Unlock()

	for _, c := range activeCancels {
		c()
	}

	if m.server != nil && m.server.db != nil && m.server.db.GetGorm() != nil {
		reason = strings.TrimSpace(reason)
		if reason == "" {
			reason = "Kill switch activated"
		}
		_ = m.server.db.GetGorm().Model(&dbservice.WatchRule{}).
			Where("enabled = ? AND paused_reason = ''", true).
			Updates(map[string]any{
				"paused_reason": "KILL_SWITCH",
				"last_error":    reason,
			}).Error
	}
}

// RecoverInterruptedRuns marks any orphaned watch_runs with status='running' as failed (INTERRUPTED).
func (m *WatcherManager) RecoverInterruptedRuns(ctx context.Context) error {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil
	}
	now := m.nowFn().UTC()
	return m.server.db.GetGorm().WithContext(ctx).Model(&dbservice.WatchRun{}).
		Where("status = ?", "running").
		Updates(map[string]any{
			"status":        "failed",
			"error_code":    "INTERRUPTED",
			"error_message": "Watcher run interrupted by server shutdown or restart",
			"completed_at":  now,
		}).Error
}

func (m *WatcherManager) schedulerLoop(ctx context.Context) {
	defer m.wg.Done()
	ticker := time.NewTicker(watcherSchedulerInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.tickDueRules(ctx)
		}
	}
}

func (m *WatcherManager) tickDueRules(ctx context.Context) {
	if m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return
	}
	now := m.nowFn().UTC()
	var dueRules []dbservice.WatchRule
	if err := m.server.db.GetGorm().WithContext(ctx).
		Where("enabled = ? AND paused_reason = '' AND (next_run_at IS NULL OR next_run_at <= ?)", true, now).
		Order("id asc").
		Find(&dueRules).Error; err != nil {
		log.Printf("watcher: query due rules failed: %v", err)
		return
	}

	loc := m.localLoc
	if loc == nil {
		loc = time.Local
	}

	for _, rule := range dueRules {
		if ctx.Err() != nil {
			return
		}
		if strings.TrimSpace(rule.ActiveHours) != "" && !policy.IsInQuietHours(rule.ActiveHours, now, loc) {
			continue
		}
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return
		}
		_, alreadyRunning := m.activeRules[rule.ID]
		if alreadyRunning {
			m.mu.Unlock()
			continue
		}
		m.wg.Add(1)
		m.mu.Unlock()

		ruleID := rule.ID
		go func() {
			defer m.wg.Done()
			if _, err := m.RunRule(ctx, ruleID, "scheduler", false, false); err != nil {
				log.Printf("watcher: scheduled run for rule %d failed: %v", ruleID, err)
			}
		}()
	}
}

// Status returns the current WatcherStatusView.
func (m *WatcherManager) Status(ctx context.Context) WatcherStatusView {
	view := WatcherStatusView{
		LiveIngestEnabled:          IsLiveIngestEnabledFromEnv(),
		LiveIngestIncludeScraperFS: IsLiveIngestIncludeScraperFSFromEnv(),
	}
	if m == nil {
		return view
	}
	m.mu.Lock()
	view.Running = m.running
	m.mu.Unlock()
	view.ActiveReactions = int(m.activeCount.Load())
	view.LiveBatchesSeen = m.liveBatchesSeen.Load()
	view.LiveJobsIngested = m.liveJobsIngested.Load()
	view.LiveDroppedBatches = m.liveDroppedBatches.Load()

	if m.scraperFSRunner != nil {
		avail, dir, reason := m.scraperFSRunner.CheckScraperFSAvailability()
		view.ScraperFSAvailable = avail
		view.ScraperFSDir = dir
		view.ScraperFSReason = reason
	}

	if m.server != nil && m.server.db != nil && m.server.db.GetGorm() != nil {
		gormDB := m.server.db.GetGorm().WithContext(ctx)
		var activeCount, pausedCount int64
		_ = gormDB.Model(&dbservice.WatchRule{}).Where("enabled = ? AND paused_reason = ''", true).Count(&activeCount).Error
		_ = gormDB.Model(&dbservice.WatchRule{}).Where("paused_reason <> ''").Count(&pausedCount).Error
		view.ActiveRules = int(activeCount)
		view.PausedRules = int(pausedCount)
	}
	return view
}

// RunRule executes a WatchRule once (discovery -> baseline check -> qualification -> reaction).
func (m *WatcherManager) RunRule(ctx context.Context, ruleID uint, triggeredBy string, dryRun bool, ignoreBaseline bool) (*WatchRunResult, error) {
	if m == nil || m.server == nil || m.server.db == nil || m.server.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	gormDB := m.server.db.GetGorm().WithContext(ctx)

	var rule dbservice.WatchRule
	if err := gormDB.First(&rule, ruleID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
		}
		return nil, err
	}

	runCtx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		cancel()
		return nil, &ServiceError{Code: "WATCHER_CLOSED", HTTPStatus: http.StatusServiceUnavailable, Message: "Watcher manager is closed"}
	}
	if _, exists := m.activeRules[ruleID]; exists {
		m.mu.Unlock()
		cancel()
		return nil, &ServiceError{Code: "RULE_ALREADY_RUNNING", HTTPStatus: http.StatusConflict, Message: "Watch rule is already running"}
	}
	m.activeRules[ruleID] = cancel
	m.wg.Add(1)
	m.mu.Unlock()

	defer func() {
		cancel()
		m.mu.Lock()
		delete(m.activeRules, ruleID)
		m.mu.Unlock()
		m.wg.Done()
	}()

	if strings.TrimSpace(triggeredBy) == "" {
		triggeredBy = "manual"
	}

	now := m.nowFn().UTC()
	runRow := dbservice.WatchRun{
		WatchRuleID:      rule.ID,
		DiscoveryBackend: rule.DiscoveryBackend,
		TriggeredBy:      triggeredBy,
		Status:           "running",
		StartedAt:        now,
	}
	if !dryRun {
		if err := gormDB.Create(&runRow).Error; err != nil {
			return nil, err
		}
	}

	finishRun := func(status, errCode, errMsg string) {
		completed := m.nowFn().UTC()
		runRow.Status = status
		runRow.ErrorCode = errCode
		runRow.ErrorMessage = errMsg
		runRow.CompletedAt = &completed
		if !dryRun && runRow.ID != 0 {
			_ = gormDB.Model(&runRow).Updates(map[string]any{
				"search_run_id":   runRow.SearchRunID,
				"status":          runRow.Status,
				"scraped_count":   runRow.ScrapedCount,
				"new_jobs_count":  runRow.NewJobsCount,
				"qualified_count": runRow.QualifiedCount,
				"drafted_count":   runRow.DraftedCount,
				"filled_count":    runRow.FilledCount,
				"submitted_count": runRow.SubmittedCount,
				"alerted_count":   runRow.AlertedCount,
				"error_code":      runRow.ErrorCode,
				"error_message":   runRow.ErrorMessage,
				"completed_at":    runRow.CompletedAt,
			}).Error
		}
	}

	var discCfg DiscoveryConfig
	if len(rule.DiscoveryConfigJSON) > 0 {
		_ = json.Unmarshal(rule.DiscoveryConfigJSON, &discCfg)
	}

	var searchRunID uint
	var scrapedCount int
	var newJobIDs []uint
	var dryRunCandidates []dbservice.Job
	var discErr error

	switch strings.ToLower(strings.TrimSpace(rule.DiscoveryBackend)) {
	case "", "chrome":
		searchReq := buildSearchRequestFromDiscoveryConfig(discCfg, rule.SearchProfileID, triggeredBy, dryRun)
		searchResp, err := m.server.ExecuteSearchPipeline(runCtx, searchReq)
		if err != nil {
			discErr = err
		} else if searchResp != nil {
			searchRunID = searchResp.SearchRunID
			scrapedCount = searchResp.TotalScraped
			newJobIDs = searchResp.NewJobIDs
			dryRunCandidates = searchResp.UnseenModels
		}
	case "scraper_fs":
		searchRunID, scrapedCount, newJobIDs, dryRunCandidates, discErr = m.runScraperFSDiscovery(runCtx, gormDB, discCfg, dryRun)
	default:
		discErr = &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    fmt.Sprintf("unsupported discovery_backend %q", rule.DiscoveryBackend),
		}
	}

	if searchRunID != 0 {
		runRow.SearchRunID = &searchRunID
	}
	runRow.ScrapedCount = scrapedCount
	if dryRun {
		runRow.NewJobsCount = len(dryRunCandidates)
	} else {
		runRow.NewJobsCount = len(newJobIDs)
	}

	if discErr != nil {
		if isTabBusyError(discErr) {
			finishRun("skipped_busy", "TAB_BUSY", discErr.Error())
			if !dryRun {
				nextRun := computeNextRunAt(m.nowFn().UTC(), rule.IntervalMinutes, rule.JitterRatio)
				_ = gormDB.Model(&rule).Updates(map[string]any{
					"last_run_at": now,
					"next_run_at": nextRun,
				}).Error
			}
			return &WatchRunResult{Run: watchRunToView(runRow), Events: []WatchEventView{}}, nil
		}

		if errors.Is(discErr, bridge.ErrHumanActionRequired) {
			m.triggerHumanActionCircuitBreaker(runCtx, gormDB, &rule, discErr.Error())
			finishRun("failed", bridge.ErrCodeHumanActionRequired, discErr.Error())
			return &WatchRunResult{Run: watchRunToView(runRow), Events: []WatchEventView{}}, discErr
		}

		errCode := extractErrorCode(discErr, "WATCHER_ERROR")
		finishRun("failed", errCode, discErr.Error())
		if !dryRun {
			m.recordRuleFailure(gormDB, &rule, discErr.Error())
		}
		return &WatchRunResult{Run: watchRunToView(runRow), Events: []WatchEventView{}}, discErr
	}

	// Baseline seeding on first run
	if rule.SeedBaselineOnFirstRun && rule.SeededAt == nil && !ignoreBaseline && !dryRun {
		seededAt := m.nowFn().UTC()
		nextRun := computeNextRunAt(seededAt, rule.IntervalMinutes, rule.JitterRatio)
		_ = gormDB.Model(&rule).Updates(map[string]any{
			"seeded_at":          seededAt,
			"last_run_at":        now,
			"last_success_at":    seededAt,
			"consecutive_errors": 0,
			"last_error":         "",
			"next_run_at":        nextRun,
		}).Error
		finishRun("seeded", "", "")
		return &WatchRunResult{Run: watchRunToView(runRow), Events: []WatchEventView{}}, nil
	}

	// Run reaction pipeline over newly discovered jobs (or in-memory unseen candidates on dry_run)
	events, reactErr := m.reactToJobs(runCtx, gormDB, &rule, &runRow, newJobIDs, dryRunCandidates, dryRun)
	if reactErr != nil {
		if errors.Is(reactErr, bridge.ErrHumanActionRequired) {
			finishRun("failed", bridge.ErrCodeHumanActionRequired, reactErr.Error())
			return &WatchRunResult{Run: watchRunToView(runRow), Events: events}, reactErr
		}
		finishRun("failed", extractErrorCode(reactErr, "WATCHER_ERROR"), reactErr.Error())
		if !dryRun {
			m.recordRuleFailure(gormDB, &rule, reactErr.Error())
		}
		return &WatchRunResult{Run: watchRunToView(runRow), Events: events}, reactErr
	}

	if dryRun {
		finishRun("dry_run", "", "")
	} else {
		completedAt := m.nowFn().UTC()
		nextRun := computeNextRunAt(completedAt, rule.IntervalMinutes, rule.JitterRatio)
		_ = gormDB.Model(&rule).Updates(map[string]any{
			"last_run_at":        now,
			"last_success_at":    completedAt,
			"consecutive_errors": 0,
			"last_error":         "",
			"next_run_at":        nextRun,
		}).Error
		finishRun("completed", "", "")
	}

	return &WatchRunResult{
		Run:    watchRunToView(runRow),
		Events: events,
	}, nil
}

func (m *WatcherManager) runScraperFSDiscovery(ctx context.Context, gormDB *gorm.DB, discCfg DiscoveryConfig, dryRun bool) (uint, int, []uint, []dbservice.Job, error) {
	if strings.TrimSpace(discCfg.Sort) == "" {
		discCfg.Sort = "recency"
	}
	if discCfg.FromActiveProjects && gormDB != nil {
		derivedQueries, _, err := deriveQueriesFromActiveProjects(gormDB, discCfg.ActiveProjectKeys, discCfg.ActiveProjectTiers)
		if err == nil && len(derivedQueries) > 0 {
			discCfg.Queries = mergeUniqueQueries([]string{discCfg.Query}, discCfg.Queries, derivedQueries)
			discCfg.Query = ""
		}
	}

	runner := m.scraperFSRunner
	if runner == nil {
		runner = NewScraperFSRunner(LoadScraperFSConfigFromEnv())
	}
	reqs, _, err := runner.Run(ctx, discCfg)
	if err != nil {
		return 0, 0, nil, nil, err
	}

	filters := &scoring.FilterConfig{SortByScore: true}
	if discCfg.BudgetMin != nil {
		v := float64(*discCfg.BudgetMin)
		filters.BudgetMin = &v
	}
	if discCfg.BudgetMax != nil {
		v := float64(*discCfg.BudgetMax)
		filters.BudgetMax = &v
	}
	if discCfg.HourlyRateMin != nil {
		v := *discCfg.HourlyRateMin
		filters.HourlyRateMin = &v
	}
	if discCfg.HourlyRateMax != nil {
		v := *discCfg.HourlyRateMax
		filters.HourlyRateMax = &v
	}
	if discCfg.PaymentVerifiedOnly != nil {
		filters.PaymentVerifiedOnly = *discCfg.PaymentVerifiedOnly
	}

	if dryRun {
		deduped := deduplicateSaveJobRequests(reqs)
		profile := loadScoringProfile(gormDB)
		surviving := filterSaveJobRequests(deduped, *filters, scoring.StagePreEnrichment, profile)
		unseenModels, _, unseenErr := filterUnseenJobModels(gormDB, surviving, profile)
		if unseenErr != nil {
			return 0, len(reqs), nil, nil, unseenErr
		}
		return 0, len(reqs), nil, unseenModels, nil
	}

	sortByScore := true
	upsert := true
	queries := discCfg.Queries
	if len(queries) == 0 && strings.TrimSpace(discCfg.Query) != "" {
		queries = []string{strings.TrimSpace(discCfg.Query)}
	}
	batchResp, err := m.server.BatchIngestJobs(ctx, BatchIngestJobsRequest{
		Jobs:        reqs,
		Filters:     filters,
		FilterStage: string(scoring.StagePreEnrichment),
		SortByScore: &sortByScore,
		Upsert:      &upsert,
		Source:      "upwork-scraper-fs",
		TriggeredBy: "watcher",
		Queries:     queries,
	})
	if err != nil {
		return 0, len(reqs), nil, nil, err
	}
	return batchResp.SearchRunID, len(reqs), batchResp.NewJobIDs, nil, nil
}

func buildSearchRequestFromDiscoveryConfig(cfg DiscoveryConfig, profileID *uint, triggeredBy string, dryRun bool) SearchJobsRequest {
	sortByScore := true
	sortOrder := strings.TrimSpace(cfg.Sort)
	source := strings.TrimSpace(cfg.Source)
	if sortOrder == "" && (source == "" || strings.EqualFold(source, "search")) {
		sortOrder = "recency"
	}
	skipIfBusy := !strings.EqualFold(strings.TrimSpace(triggeredBy), "manual")
	return SearchJobsRequest{
		Source:               cfg.Source,
		Query:                cfg.Query,
		Queries:              cfg.Queries,
		Sort:                 sortOrder,
		PerPage:              cfg.PerPage,
		ContractorTier:       cfg.ContractorTier,
		ContractType:         cfg.ContractType,
		ProposalTiers:        cfg.ProposalTiers,
		Amount:               cfg.Amount,
		BudgetMin:            cfg.BudgetMin,
		BudgetMax:            cfg.BudgetMax,
		HourlyRateMin:        cfg.HourlyRateMin,
		HourlyRateMax:        cfg.HourlyRateMax,
		PaymentVerifiedOnly:  cfg.PaymentVerifiedOnly,
		Category:             cfg.Category,
		SearchURL:            cfg.SearchURL,
		MaxPages:             cfg.MaxPages,
		SkipAutoDetailEnrich: true,
		SkipIfBusy:           skipIfBusy,
		SkipPersist:          dryRun,
		ProfileID:            profileID,
		FromActiveProjects:   cfg.FromActiveProjects,
		ActiveProjectKeys:    cfg.ActiveProjectKeys,
		ActiveProjectTiers:   cfg.ActiveProjectTiers,
		TriggeredBy:          "watcher",
		Filters:              &scoring.FilterConfig{SortByScore: sortByScore},
	}
}

func (m *WatcherManager) triggerHumanActionCircuitBreaker(ctx context.Context, gormDB *gorm.DB, rule *dbservice.WatchRule, reason string) {
	if rule == nil {
		return
	}
	now := m.nowFn().UTC()
	rule.PausedReason = "HUMAN_ACTION_REQUIRED"
	rule.LastError = reason
	rule.LastRunAt = &now
	if gormDB != nil {
		_ = gormDB.Model(rule).Updates(map[string]any{
			"paused_reason": "HUMAN_ACTION_REQUIRED",
			"last_error":    reason,
			"last_run_at":   now,
		}).Error
	}
	if m.server != nil && m.server.PolicyEngine() != nil {
		_ = m.server.PolicyEngine().RecordAudit(policy.AuditEntry{
			ActionType: "watcher.circuit_breaker",
			Actor:      "watcher",
			TargetID:   fmt.Sprintf("watch_rule:%d", rule.ID),
			Outcome:    "paused",
			Details: map[string]any{
				"rule_id":   rule.ID,
				"rule_name": rule.Name,
				"reason":    "HUMAN_ACTION_REQUIRED",
				"message":   reason,
			},
		})
	}
	if m.notifier != nil {
		m.notifier.NotifyAsync(WatcherAlert{
			Event:    EventHumanActionReq,
			Title:    fmt.Sprintf("Human Action Required: %s", rule.Name),
			Message:  reason,
			RuleID:   rule.ID,
			RuleName: rule.Name,
		})
	}
	_ = ctx
}

func (m *WatcherManager) recordRuleFailure(gormDB *gorm.DB, rule *dbservice.WatchRule, errMsg string) {
	if rule == nil || gormDB == nil {
		return
	}
	now := m.nowFn().UTC()
	rule.ConsecutiveErrors++
	rule.LastError = errMsg
	rule.LastRunAt = &now
	nextRun := computeNextRunAt(now, rule.IntervalMinutes, rule.JitterRatio)
	updates := map[string]any{
		"consecutive_errors": rule.ConsecutiveErrors,
		"last_error":         errMsg,
		"last_run_at":        now,
		"next_run_at":        nextRun,
	}
	if rule.ConsecutiveErrors >= maxConsecutiveRuleErrors {
		rule.PausedReason = "CONSECUTIVE_ERRORS"
		updates["paused_reason"] = "CONSECUTIVE_ERRORS"
		if m.notifier != nil {
			m.notifier.NotifyAsync(WatcherAlert{
				Event:    EventWatcherPaused,
				Title:    fmt.Sprintf("Watcher Paused: %s", rule.Name),
				Message:  fmt.Sprintf("Paused after %d consecutive errors: %s", rule.ConsecutiveErrors, errMsg),
				RuleID:   rule.ID,
				RuleName: rule.Name,
			})
		}
	}
	_ = gormDB.Model(rule).Updates(updates).Error
}

func computeNextRunAt(from time.Time, intervalMinutes int, jitterRatio float64) time.Time {
	if intervalMinutes <= 0 {
		intervalMinutes = defaultWatcherIntervalMin
	}
	if jitterRatio < 0 {
		jitterRatio = 0
	}
	if jitterRatio > 0.9 {
		jitterRatio = 0.9
	}
	baseSeconds := float64(intervalMinutes) * 60.0
	factor := 1.0
	if jitterRatio > 0 {
		factor = (1.0 - jitterRatio) + rand.Float64()*(2.0*jitterRatio)
	}
	delta := time.Duration(baseSeconds*factor) * time.Second
	if delta < 10*time.Second {
		delta = 10 * time.Second
	}
	return from.Add(delta)
}

func isTabBusyError(err error) bool {
	if err == nil {
		return false
	}
	var be *bridge.BridgeError
	if errors.As(err, &be) && be != nil && strings.EqualFold(be.Code, "TAB_BUSY") {
		return true
	}
	var se *ServiceError
	if errors.As(err, &se) && se != nil && strings.EqualFold(se.Code, "TAB_BUSY") {
		return true
	}
	return strings.Contains(strings.ToUpper(err.Error()), "TAB_BUSY")
}

func watchRuleToView(r dbservice.WatchRule) WatchRuleView {
	var discCfg DiscoveryConfig
	if len(r.DiscoveryConfigJSON) > 0 {
		_ = json.Unmarshal(r.DiscoveryConfigJSON, &discCfg)
	}
	reqKWs := []string{}
	if len(r.RequiredKeywordsJSON) > 0 {
		_ = json.Unmarshal(r.RequiredKeywordsJSON, &reqKWs)
	}
	excKWs := []string{}
	if len(r.ExcludeKeywordsJSON) > 0 {
		_ = json.Unmarshal(r.ExcludeKeywordsJSON, &excKWs)
	}
	var bidStrat *ollama.BidStrategy
	if len(r.BidStrategyJSON) > 0 {
		var bs ollama.BidStrategy
		if json.Unmarshal(r.BidStrategyJSON, &bs) == nil {
			bidStrat = &bs
		}
	}
	return WatchRuleView{
		ID:                           r.ID,
		Name:                         r.Name,
		Description:                  r.Description,
		Enabled:                      r.Enabled,
		DiscoveryBackend:             r.DiscoveryBackend,
		SearchProfileID:              r.SearchProfileID,
		DiscoveryConfig:              discCfg,
		IntervalMinutes:              r.IntervalMinutes,
		JitterRatio:                  r.JitterRatio,
		ActiveHours:                  r.ActiveHours,
		MinScore:                     r.MinScore,
		MaxProposals:                 r.MaxProposals,
		MaxPostedAgeMinutes:          r.MaxPostedAgeMinutes,
		MaxConnectsPerJob:            r.MaxConnectsPerJob,
		RequirePaymentVerified:       r.RequirePaymentVerified,
		RequiredKeywords:             reqKWs,
		ExcludeKeywords:              excKWs,
		ActionMode:                   r.ActionMode,
		LLMModel:                     r.LLMModel,
		LLMEffort:                    r.LLMEffort,
		BidStrategy:                  bidStrat,
		AutoSubmitMinConfidence:      r.AutoSubmitMinConfidence,
		FallbackOnScreeningQuestions: r.FallbackOnScreeningQuestions,
		MaxReactionsPerTick:          r.MaxReactionsPerTick,
		SeedBaselineOnFirstRun:       r.SeedBaselineOnFirstRun,
		SeededAt:                     formatOptionalTime(r.SeededAt),
		PausedReason:                 r.PausedReason,
		ConsecutiveErrors:            r.ConsecutiveErrors,
		NextRunAt:                    formatOptionalTime(r.NextRunAt),
		LastRunAt:                    formatOptionalTime(r.LastRunAt),
		LastSuccessAt:                formatOptionalTime(r.LastSuccessAt),
		LastError:                    r.LastError,
		CreatedAt:                    r.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:                    r.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func watchRunToView(r dbservice.WatchRun) WatchRunView {
	return WatchRunView{
		ID:               r.ID,
		WatchRuleID:      r.WatchRuleID,
		DiscoveryBackend: r.DiscoveryBackend,
		TriggeredBy:      r.TriggeredBy,
		SearchRunID:      r.SearchRunID,
		Status:           r.Status,
		ScrapedCount:     r.ScrapedCount,
		NewJobsCount:     r.NewJobsCount,
		QualifiedCount:   r.QualifiedCount,
		DraftedCount:     r.DraftedCount,
		FilledCount:      r.FilledCount,
		SubmittedCount:   r.SubmittedCount,
		AlertedCount:     r.AlertedCount,
		ErrorCode:        r.ErrorCode,
		ErrorMessage:     r.ErrorMessage,
		StartedAt:        r.StartedAt.UTC().Format(time.RFC3339),
		CompletedAt:      formatOptionalTime(r.CompletedAt),
		CreatedAt:        r.CreatedAt.UTC().Format(time.RFC3339),
	}
}

func watchEventToView(e dbservice.WatchEvent, jobTitle string) WatchEventView {
	return WatchEventView{
		ID:             e.ID,
		WatchRuleID:    e.WatchRuleID,
		WatchRunID:     e.WatchRunID,
		JobID:          e.JobID,
		JobTitle:       jobTitle,
		UpworkJobID:    e.UpworkJobID,
		ProposalID:     e.ProposalID,
		Stage:          e.Stage,
		DecisionReason: e.DecisionReason,
		Confidence:     e.Confidence,
		ErrorCode:      e.ErrorCode,
		ErrorMessage:   e.ErrorMessage,
		CreatedAt:      e.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:      e.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func formatOptionalTime(t *time.Time) *string {
	if t == nil || t.IsZero() {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}
