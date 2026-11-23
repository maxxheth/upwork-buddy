package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/policy"

	"gorm.io/gorm"
)

// ListWatchRules returns all persisted watch rules ordered by id asc.
func (s *Server) ListWatchRules(ctx context.Context) ([]WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	var rows []dbservice.WatchRule
	if err := s.db.GetGorm().WithContext(ctx).Order("id asc").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]WatchRuleView, 0, len(rows))
	for _, r := range rows {
		out = append(out, watchRuleToView(r))
	}
	return out, nil
}

// GetWatchRule returns a single WatchRuleView by ID.
func (s *Server) GetWatchRule(ctx context.Context, id uint) (*WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	var row dbservice.WatchRule
	if err := s.db.GetGorm().WithContext(ctx).First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
		}
		return nil, err
	}
	v := watchRuleToView(row)
	return &v, nil
}

// ResolveWatchRule resolves a watch rule by numeric ID or exact name.
func (s *Server) ResolveWatchRule(ctx context.Context, ruleID *uint, name string) (*WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if ruleID != nil && *ruleID > 0 {
		return s.GetWatchRule(ctx, *ruleID)
	}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "rule_id or name is required"}
	}
	var row dbservice.WatchRule
	if err := s.db.GetGorm().WithContext(ctx).Where("LOWER(name) = ?", strings.ToLower(trimmed)).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
		}
		return nil, err
	}
	v := watchRuleToView(row)
	return &v, nil
}

// CreateWatchRule validates and creates a new WatchRule.
func (s *Server) CreateWatchRule(ctx context.Context, in UpsertWatchRuleInput) (*WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	name := ""
	if in.Name != nil {
		name = strings.TrimSpace(*in.Name)
	}
	if name == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "name is required"}
	}

	backend := "chrome"
	if in.DiscoveryBackend != nil && strings.TrimSpace(*in.DiscoveryBackend) != "" {
		backend = strings.ToLower(strings.TrimSpace(*in.DiscoveryBackend))
	}
	if backend != "chrome" && backend != "scraper_fs" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "discovery_backend must be chrome or scraper_fs"}
	}

	actionMode := "draft_and_fill"
	if in.ActionMode != nil && strings.TrimSpace(*in.ActionMode) != "" {
		actionMode = strings.ToLower(strings.TrimSpace(*in.ActionMode))
	}
	if actionMode != "alert_only" && actionMode != "draft_and_fill" && actionMode != "auto_submit" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "action_mode must be alert_only, draft_and_fill, or auto_submit"}
	}

	row := dbservice.WatchRule{
		Name:                         name,
		DiscoveryBackend:             backend,
		IntervalMinutes:              defaultWatcherIntervalMin,
		JitterRatio:                  defaultWatcherJitter,
		MinScore:                     75,
		RequirePaymentVerified:       true,
		ActionMode:                   actionMode,
		AutoSubmitMinConfidence:      0.85,
		FallbackOnScreeningQuestions: true,
		MaxReactionsPerTick:          2,
		SeedBaselineOnFirstRun:       true,
	}

	if err := applyWatchRuleInput(&row, in); err != nil {
		return nil, err
	}
	if row.Enabled && row.NextRunAt == nil {
		nextRun := computeNextRunAt(time.Now().UTC(), row.IntervalMinutes, row.JitterRatio)
		row.NextRunAt = &nextRun
	}

	if err := s.db.GetGorm().WithContext(ctx).Create(&row).Error; err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, &ServiceError{Code: "DUPLICATE_NAME", HTTPStatus: http.StatusConflict, Message: fmt.Sprintf("Watch rule %q already exists", name)}
		}
		return nil, err
	}
	v := watchRuleToView(row)
	return &v, nil
}

// UpdateWatchRule applies partial updates to an existing WatchRule.
func (s *Server) UpdateWatchRule(ctx context.Context, id uint, in UpsertWatchRuleInput) (*WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	var row dbservice.WatchRule
	if err := gormDB.First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
		}
		return nil, err
	}

	wasEnabled := row.Enabled
	if err := applyWatchRuleInput(&row, in); err != nil {
		return nil, err
	}
	if !wasEnabled && row.Enabled && row.NextRunAt == nil {
		nextRun := computeNextRunAt(time.Now().UTC(), row.IntervalMinutes, row.JitterRatio)
		row.NextRunAt = &nextRun
	}
	if err := gormDB.Save(&row).Error; err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, &ServiceError{Code: "DUPLICATE_NAME", HTTPStatus: http.StatusConflict, Message: fmt.Sprintf("Watch rule %q already exists", row.Name)}
		}
		return nil, err
	}
	v := watchRuleToView(row)
	return &v, nil
}

// DeleteWatchRule deletes a WatchRule by ID.
func (s *Server) DeleteWatchRule(ctx context.Context, id uint) error {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	res := s.db.GetGorm().WithContext(ctx).Delete(&dbservice.WatchRule{}, id)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
	}
	return nil
}

// ToggleWatchRule flips Enabled (or sets it if enabled != nil) on a WatchRule.
func (s *Server) ToggleWatchRule(ctx context.Context, id uint, enabled *bool) (*WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	var row dbservice.WatchRule
	if err := gormDB.First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
		}
		return nil, err
	}
	if enabled != nil {
		row.Enabled = *enabled
	} else {
		row.Enabled = !row.Enabled
	}
	if row.Enabled {
		row.PausedReason = ""
		row.ConsecutiveErrors = 0
		row.LastError = ""
		if row.NextRunAt == nil {
			now := time.Now().UTC()
			row.NextRunAt = &now
		}
	}
	if err := gormDB.Save(&row).Error; err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, &ServiceError{Code: "DUPLICATE_NAME", HTTPStatus: http.StatusConflict, Message: fmt.Sprintf("Watch rule %q already exists", row.Name)}
		}
		return nil, err
	}
	v := watchRuleToView(row)
	return &v, nil
}

// ResumeWatchRule clears PausedReason and ConsecutiveErrors on a WatchRule.
func (s *Server) ResumeWatchRule(ctx context.Context, id uint) (*WatchRuleView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	var row dbservice.WatchRule
	if err := gormDB.First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Watch rule not found"}
		}
		return nil, err
	}
	row.PausedReason = ""
	row.ConsecutiveErrors = 0
	row.LastError = ""
	row.Enabled = true
	now := time.Now().UTC()
	row.NextRunAt = &now
	if err := gormDB.Save(&row).Error; err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "duplicate") || strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, &ServiceError{Code: "DUPLICATE_NAME", HTTPStatus: http.StatusConflict, Message: fmt.Sprintf("Watch rule %q already exists", row.Name)}
		}
		return nil, err
	}
	v := watchRuleToView(row)
	return &v, nil
}

// ListWatchRuns returns paginated WatchRuns for a rule.
func (s *Server) ListWatchRuns(ctx context.Context, ruleID uint, limit, offset int) ([]WatchRunView, int, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, 0, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if limit <= 0 || limit > 200 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	var total int64
	if err := gormDB.Model(&dbservice.WatchRun{}).Where("watch_rule_id = ?", ruleID).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []dbservice.WatchRun
	if err := gormDB.Where("watch_rule_id = ?", ruleID).Order("id desc").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	out := make([]WatchRunView, 0, len(rows))
	for _, r := range rows {
		out = append(out, watchRunToView(r))
	}
	return out, int(total), nil
}

// ListWatchEvents returns paginated WatchEvents for a rule (or all rules if ruleID == 0).
func (s *Server) ListWatchEvents(ctx context.Context, ruleID uint, limit, offset int) ([]WatchEventView, int, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, 0, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	gormDB := s.db.GetGorm().WithContext(ctx)
	q := gormDB.Model(&dbservice.WatchEvent{})
	if ruleID > 0 {
		q = q.Where("watch_rule_id = ?", ruleID)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []dbservice.WatchEvent
	if err := q.Preload("Job").Order("id desc").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		return nil, 0, err
	}
	out := make([]WatchEventView, 0, len(rows))
	for _, e := range rows {
		title := ""
		if e.Job != nil {
			title = e.Job.Title
		}
		out = append(out, watchEventToView(e, title))
	}
	return out, int(total), nil
}

func applyWatchRuleInput(row *dbservice.WatchRule, in UpsertWatchRuleInput) error {
	if in.Name != nil {
		trimmed := strings.TrimSpace(*in.Name)
		if trimmed == "" {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "name cannot be empty"}
		}
		row.Name = trimmed
	}
	if in.Description != nil {
		row.Description = strings.TrimSpace(*in.Description)
	}
	if in.Enabled != nil {
		row.Enabled = *in.Enabled
	}
	if in.DiscoveryBackend != nil {
		backend := strings.ToLower(strings.TrimSpace(*in.DiscoveryBackend))
		if backend != "chrome" && backend != "scraper_fs" {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "discovery_backend must be chrome or scraper_fs"}
		}
		row.DiscoveryBackend = backend
	}
	if in.ClearSearchProfileID {
		row.SearchProfileID = nil
	} else if in.SearchProfileID != nil {
		row.SearchProfileID = in.SearchProfileID
	}
	if in.DiscoveryConfig != nil {
		if in.DiscoveryConfig.MaxPages < 0 || in.DiscoveryConfig.MaxPages > 20 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "discovery_config.max_pages must be between 1 and 20"}
		}
		if in.DiscoveryConfig.PerPage != nil && *in.DiscoveryConfig.PerPage != 10 && *in.DiscoveryConfig.PerPage != 20 && *in.DiscoveryConfig.PerPage != 50 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "discovery_config.per_page must be 10, 20, or 50"}
		}
		raw, err := json.Marshal(in.DiscoveryConfig)
		if err != nil {
			return err
		}
		row.DiscoveryConfigJSON = dbservice.JSONB(raw)
	}
	if in.IntervalMinutes != nil {
		if *in.IntervalMinutes < 1 || *in.IntervalMinutes > 1440 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "interval_minutes must be between 1 and 1440"}
		}
		row.IntervalMinutes = *in.IntervalMinutes
	}
	if in.JitterRatio != nil {
		if *in.JitterRatio < 0 || *in.JitterRatio > 0.9 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "jitter_ratio must be between 0 and 0.9"}
		}
		row.JitterRatio = *in.JitterRatio
	}
	if in.ActiveHours != nil {
		trimmed := strings.TrimSpace(*in.ActiveHours)
		if trimmed != "" {
			if _, _, err := policy.ParseQuietHours(trimmed); err != nil {
				return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: fmt.Sprintf("invalid active_hours: %v", err)}
			}
		}
		row.ActiveHours = trimmed
	}
	if in.MinScore != nil {
		if *in.MinScore < 0 || *in.MinScore > 100 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "min_score must be between 0 and 100"}
		}
		row.MinScore = *in.MinScore
	}
	if in.MaxProposals.Set {
		row.MaxProposals = in.MaxProposals.Value
	}
	if in.MaxPostedAgeMinutes.Set {
		row.MaxPostedAgeMinutes = in.MaxPostedAgeMinutes.Value
	}
	if in.MaxConnectsPerJob.Set {
		row.MaxConnectsPerJob = in.MaxConnectsPerJob.Value
	}
	if in.RequirePaymentVerified != nil {
		row.RequirePaymentVerified = *in.RequirePaymentVerified
	}
	if in.RequiredKeywords != nil {
		raw, _ := json.Marshal(in.RequiredKeywords)
		row.RequiredKeywordsJSON = dbservice.JSONB(raw)
	}
	if in.ExcludeKeywords != nil {
		raw, _ := json.Marshal(in.ExcludeKeywords)
		row.ExcludeKeywordsJSON = dbservice.JSONB(raw)
	}
	if in.ActionMode != nil {
		mode := strings.ToLower(strings.TrimSpace(*in.ActionMode))
		if mode != "alert_only" && mode != "draft_and_fill" && mode != "auto_submit" {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "action_mode must be alert_only, draft_and_fill, or auto_submit"}
		}
		row.ActionMode = mode
	}
	if in.LLMModel != nil {
		row.LLMModel = strings.TrimSpace(*in.LLMModel)
	}
	if in.LLMEffort != nil {
		row.LLMEffort = strings.TrimSpace(*in.LLMEffort)
	}
	if in.BidStrategy != nil {
		raw, _ := json.Marshal(in.BidStrategy)
		row.BidStrategyJSON = dbservice.JSONB(raw)
	}
	if in.AutoSubmitMinConfidence != nil {
		if *in.AutoSubmitMinConfidence < 0 || *in.AutoSubmitMinConfidence > 1 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "auto_submit_min_confidence must be between 0 and 1"}
		}
		row.AutoSubmitMinConfidence = *in.AutoSubmitMinConfidence
	}
	if in.FallbackOnScreeningQuestions != nil {
		row.FallbackOnScreeningQuestions = *in.FallbackOnScreeningQuestions
	}
	if in.MaxReactionsPerTick != nil {
		if *in.MaxReactionsPerTick < 1 || *in.MaxReactionsPerTick > 20 {
			return &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "max_reactions_per_tick must be between 1 and 20"}
		}
		row.MaxReactionsPerTick = *in.MaxReactionsPerTick
	}
	if in.SeedBaselineOnFirstRun != nil {
		row.SeedBaselineOnFirstRun = *in.SeedBaselineOnFirstRun
	}
	return nil
}

// --- HTTP Handlers ---

func parsePathUintID(r *http.Request, name string) (uint, error) {
	raw := strings.TrimSpace(r.PathValue(name))
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || v == 0 {
		return 0, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: fmt.Sprintf("invalid %s", name)}
	}
	return uint(v), nil
}

func respondServiceError(w http.ResponseWriter, err error) {
	var se *ServiceError
	if errors.As(err, &se) && se != nil && se.HTTPStatus > 0 {
		respondWithError(w, se.HTTPStatus, se.Message)
		return
	}
	respondWithError(w, http.StatusInternalServerError, err.Error())
}

func (s *Server) listWatchersHandler(w http.ResponseWriter, r *http.Request) {
	rules, err := s.ListWatchRules(r.Context())
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"rules": rules})
}

func (s *Server) createWatcherHandler(w http.ResponseWriter, r *http.Request) {
	var in UpsertWatchRuleInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	rule, err := s.CreateWatchRule(r.Context(), in)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"rule": rule})
}

func (s *Server) watcherStatusHandler(w http.ResponseWriter, r *http.Request) {
	status := s.getWatcherManager().Status(r.Context())
	respondWithJSON(w, status)
}

func (s *Server) getWatcherHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	rule, err := s.GetWatchRule(r.Context(), id)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"rule": rule})
}

func (s *Server) updateWatcherHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	var in UpsertWatchRuleInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	rule, err := s.UpdateWatchRule(r.Context(), id, in)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"rule": rule})
}

func (s *Server) deleteWatcherHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	if err := s.DeleteWatchRule(r.Context(), id); err != nil {
		respondServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) toggleWatcherHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	rule, err := s.ToggleWatchRule(r.Context(), id, body.Enabled)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"rule": rule})
}

func (s *Server) resumeWatcherHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	rule, err := s.ResumeWatchRule(r.Context(), id)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"rule": rule})
}

func (s *Server) runWatcherHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)

	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	var body struct {
		DryRun         bool `json:"dry_run"`
		IgnoreBaseline bool `json:"ignore_baseline"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	res, runErr := s.getWatcherManager().RunRule(r.Context(), id, "manual", body.DryRun, body.IgnoreBaseline)
	if runErr != nil {
		respondBridgeError(w, runErr)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) listWatcherRunsHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	runs, total, err := s.ListWatchRuns(r.Context(), id, limit, offset)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"runs": runs, "total": total})
}

func (s *Server) listWatcherEventsHandler(w http.ResponseWriter, r *http.Request) {
	id, err := parsePathUintID(r, "id")
	if err != nil {
		respondServiceError(w, err)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	events, total, err := s.ListWatchEvents(r.Context(), id, limit, offset)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"events": events, "total": total})
}

func (s *Server) getNotificationConfigHandler(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.GetNotificationConfig(r.Context())
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"config": cfg})
}

func (s *Server) updateNotificationConfigHandler(w http.ResponseWriter, r *http.Request) {
	var in UpdateNotificationConfigInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	cfg, err := s.UpdateNotificationConfig(r.Context(), in)
	if err != nil {
		respondServiceError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"config": cfg})
}

func (s *Server) testNotificationHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Channel string `json:"channel"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	ok, results := s.getWatcherManager().notifier.SendSync(r.Context(), WatcherAlert{
		Event:   "test",
		Title:   "Upwork Buddy Test Notification",
		Message: "Your watcher notification channel is configured and reachable.",
	}, strings.TrimSpace(body.Channel))
	respondWithJSON(w, map[string]any{
		"ok":      ok,
		"results": results,
	})
}

func (s *Server) detectTelegramChatHandler(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TelegramBotToken string `json:"telegram_bot_token"`
		AutoSave         bool   `json:"auto_save"`
	}
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	detected, err := s.getWatcherManager().notifier.DetectTelegramChats(r.Context(), body.TelegramBotToken)
	if err != nil {
		respondServiceError(w, err)
		return
	}

	resp := map[string]any{
		"bot_username": detected.BotUsername,
		"chats":        detected.Chats,
		"hint":         detected.Hint,
		"saved":        false,
	}

	if body.AutoSave && len(detected.Chats) == 1 {
		chatID := detected.Chats[0].ChatID
		updateIn := UpdateNotificationConfigInput{
			TelegramChatID: &chatID,
		}
		if trimmedToken := strings.TrimSpace(body.TelegramBotToken); trimmedToken != "" {
			updateIn.TelegramBotToken = &trimmedToken
		}
		cfg, saveErr := s.UpdateNotificationConfig(r.Context(), updateIn)
		if saveErr != nil {
			respondServiceError(w, saveErr)
			return
		}
		resp["saved"] = true
		resp["selected_chat_id"] = chatID
		resp["config"] = cfg
	}

	respondWithJSON(w, resp)
}
