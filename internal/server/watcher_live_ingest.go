package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/url"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
)

// EnqueueObservedSearch queues an observed search batch for async processing without blocking Hub.readLoop.
func (m *WatcherManager) EnqueueObservedSearch(evt bridge.SearchObservedEvent) bool {
	if m == nil || len(evt.Jobs) == 0 || !IsLiveIngestEnabledFromEnv() {
		return false
	}

	m.mu.Lock()
	if m.closed || !m.running || m.liveQueue == nil {
		m.mu.Unlock()
		return false
	}
	select {
	case m.liveQueue <- evt:
		m.mu.Unlock()
		return true
	default:
		qCap := cap(m.liveQueue)
		m.mu.Unlock()
		m.liveDroppedBatches.Add(1)
		log.Printf("watcher: live ingest queue full (cap=%d); dropping observed batch (feed=%q query=%q jobs=%d)",
			qCap, evt.SourceFeed, evt.Query, len(evt.Jobs))
		return false
	}
}

func (m *WatcherManager) liveIngestLoop(ctx context.Context) {
	defer m.wg.Done()

	for {
		select {
		case <-ctx.Done():
			return
		case evt := <-m.liveQueue:
			if ctx.Err() != nil {
				return
			}
			if err := m.ProcessObservedSearch(ctx, evt); err != nil && !errors.Is(err, context.Canceled) {
				log.Printf("watcher: live search ingest error: %v", err)
			}
		}
	}
}

// ProcessObservedSearch validates, deduplicates, persists, and evaluates matching WatchRules for an observed search batch.
func (m *WatcherManager) ProcessObservedSearch(ctx context.Context, evt bridge.SearchObservedEvent) error {
	if m == nil || m.server == nil || !IsLiveIngestEnabledFromEnv() || len(evt.Jobs) == 0 {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	if pe := m.server.PolicyEngine(); pe != nil {
		snap, err := pe.GetSnapshot(ctx)
		if err != nil {
			return err
		}
		if snap.KillSwitchActive {
			return nil
		}
	}

	baseDB := m.gormDB()
	if baseDB == nil {
		return nil
	}
	gormDB := baseDB.WithContext(ctx)

	normalizedFeed := normalizeLiveFeedSource(evt.SourceFeed)
	reqs := make([]saveJobRequest, 0, len(evt.Jobs))
	for _, raw := range evt.Jobs {
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
			continue
		}
		var req saveJobRequest
		if err := json.Unmarshal(trimmed, &req); err != nil {
			continue
		}
		if strings.TrimSpace(req.JobTitle) == "" {
			continue
		}
		req.Source = firstNonEmpty(req.Source, "chrome_live_stream")
		req.SourceFeed = firstNonEmpty(req.SourceFeed, normalizedFeed)
		req.SourceQuery = firstNonEmpty(req.SourceQuery, evt.Query)
		if _, _, _, err := buildJobModelFromRequest(req); err != nil {
			continue
		}
		reqs = append(reqs, req)
	}

	deduped := deduplicateSaveJobRequests(reqs)
	if len(deduped) == 0 {
		return nil
	}

	profile := loadScoringProfile(gormDB)
	unseenModels, _, err := filterUnseenJobModels(gormDB, deduped, profile)
	if err != nil {
		return err
	}

	var runMeta *searchRunMetadata
	if len(unseenModels) > 0 {
		var queries []string
		if q := strings.TrimSpace(evt.Query); q != "" {
			queries = []string{q}
		}
		runMeta = &searchRunMetadata{
			Label:         firstNonEmpty(evt.OperationName, evt.CaptureKind, "live_stream"),
			Source:        "chrome_live_stream",
			TriggeredBy:   "live_stream",
			Queries:       queries,
			TotalScraped:  len(deduped),
			FilteredCount: len(deduped),
			StoppedReason: "completed",
			Criteria: map[string]any{
				"source_feed":    normalizedFeed,
				"page_url":       strings.TrimSpace(evt.PageURL),
				"operation_name": strings.TrimSpace(evt.OperationName),
				"capture_kind":   strings.TrimSpace(evt.CaptureKind),
				"tab_id":         evt.TabID,
			},
		}
	}

	entries, searchRunID, newJobIDs, err := upsertBatchRequestsWithRun(gormDB, deduped, profile, runMeta)
	if err != nil {
		return err
	}

	m.liveBatchesSeen.Add(1)
	m.liveJobsIngested.Add(int64(len(newJobIDs)))

	if len(newJobIDs) == 0 {
		return nil
	}

	newJobIDSet := make(map[uint]struct{}, len(newJobIDs))
	for _, id := range newJobIDs {
		if id != 0 {
			newJobIDSet[id] = struct{}{}
		}
	}
	newReqs := make([]saveJobRequest, 0, len(newJobIDs))
	reqKeyToJobID := make(map[string]uint, len(newJobIDs))
	for i, req := range deduped {
		if i >= len(entries) {
			break
		}
		jobID := entries[i].ID
		if _, isNew := newJobIDSet[jobID]; !isNew {
			continue
		}
		key := canonicalKeyForRequest(req)
		if _, seen := reqKeyToJobID[key]; seen {
			continue
		}
		reqKeyToJobID[key] = jobID
		newReqs = append(newReqs, req)
	}
	if len(newReqs) == 0 {
		return nil
	}

	backends := []string{"", "chrome"}
	if IsLiveIngestIncludeScraperFSFromEnv() {
		backends = append(backends, "scraper_fs")
	}

	var rules []dbservice.WatchRule
	if err := gormDB.
		Where("enabled = ? AND paused_reason = '' AND LOWER(TRIM(discovery_backend)) IN ?", true, backends).
		Order("id asc").
		Find(&rules).Error; err != nil {
		return err
	}

	loc := m.localLoc
	if loc == nil {
		loc = time.Local
	}

	for _, rule := range rules {
		if err := ctx.Err(); err != nil {
			return err
		}
		if rule.SeedBaselineOnFirstRun && rule.SeededAt == nil {
			continue
		}
		now := m.nowFn().UTC()
		if strings.TrimSpace(rule.ActiveHours) != "" && !policy.IsInQuietHours(rule.ActiveHours, now, loc) {
			continue
		}

		discCfg, filterCfg := resolveRuleLiveFilters(gormDB, rule)
		matchedReqs, matchedNewJobIDs := matchObservedBatchToRule(
			evt,
			normalizedFeed,
			discCfg,
			filterCfg,
			newReqs,
			reqKeyToJobID,
			profile,
		)
		if len(matchedNewJobIDs) == 0 {
			continue
		}

		if err := m.processLiveRuleMatch(ctx, gormDB, rule, searchRunID, len(matchedReqs), matchedNewJobIDs); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("watcher: live stream rule %d (%s) error: %v", rule.ID, rule.Name, err)
			if errors.Is(err, bridge.ErrHumanActionRequired) {
				break
			}
		}
	}

	return nil
}

func (m *WatcherManager) processLiveRuleMatch(
	ctx context.Context,
	gormDB *gorm.DB,
	rule dbservice.WatchRule,
	searchRunID uint,
	scrapedCount int,
	matchedNewJobIDs []uint,
) error {
	ruleCtx, cancel := context.WithCancel(ctx)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		cancel()
		return context.Canceled
	}
	if _, exists := m.activeRules[rule.ID]; exists {
		m.mu.Unlock()
		cancel()
		return nil
	}
	m.activeRules[rule.ID] = cancel
	m.wg.Add(1)
	m.mu.Unlock()

	defer func() {
		cancel()
		m.mu.Lock()
		delete(m.activeRules, rule.ID)
		m.mu.Unlock()
		m.wg.Done()
	}()

	now := m.nowFn().UTC()
	var searchRunIDPtr *uint
	if searchRunID != 0 {
		sid := searchRunID
		searchRunIDPtr = &sid
	}

	runRow := dbservice.WatchRun{
		WatchRuleID:      rule.ID,
		DiscoveryBackend: firstNonEmpty(rule.DiscoveryBackend, "chrome"),
		TriggeredBy:      "live_stream",
		SearchRunID:      searchRunIDPtr,
		Status:           "running",
		ScrapedCount:     scrapedCount,
		NewJobsCount:     len(matchedNewJobIDs),
		StartedAt:        now,
	}
	if err := gormDB.Create(&runRow).Error; err != nil {
		return err
	}

	finishRun := func(status, errCode, errMsg string) {
		completed := m.nowFn().UTC()
		runRow.Status = status
		runRow.ErrorCode = errCode
		runRow.ErrorMessage = errMsg
		runRow.CompletedAt = &completed
		_ = gormDB.Model(&runRow).Updates(map[string]any{
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

	_, reactErr := m.reactToJobs(ruleCtx, gormDB, &rule, &runRow, matchedNewJobIDs, nil, false)
	if reactErr != nil {
		if errors.Is(reactErr, bridge.ErrHumanActionRequired) {
			finishRun("failed", bridge.ErrCodeHumanActionRequired, reactErr.Error())
			return reactErr
		}
		finishRun("failed", extractErrorCode(reactErr, "WATCHER_ERROR"), reactErr.Error())
		_ = gormDB.Model(&rule).Updates(map[string]any{
			"last_run_at": now,
			"last_error":  reactErr.Error(),
		}).Error
		return reactErr
	}

	completedAt := m.nowFn().UTC()
	_ = gormDB.Model(&rule).Updates(map[string]any{
		"last_run_at":     now,
		"last_success_at": completedAt,
	}).Error
	finishRun("completed", "", "")
	return nil
}

func resolveRuleLiveFilters(gormDB *gorm.DB, rule dbservice.WatchRule) (DiscoveryConfig, scoring.FilterConfig) {
	var discCfg DiscoveryConfig
	if len(rule.DiscoveryConfigJSON) > 0 {
		_ = json.Unmarshal(rule.DiscoveryConfigJSON, &discCfg)
	}

	filterCfg := scoring.FilterConfig{SortByScore: true}

	if rule.SearchProfileID != nil && *rule.SearchProfileID > 0 && gormDB != nil {
		var profileRow dbservice.SearchProfile
		if err := gormDB.First(&profileRow, *rule.SearchProfileID).Error; err == nil {
			cfg := defaultSearchProfileConfig()
			if len(profileRow.ConfigJSON) > 0 {
				_ = json.Unmarshal(profileRow.ConfigJSON, &cfg)
			}
			if strings.TrimSpace(discCfg.Source) == "" {
				discCfg.Source = searchModeToFeedSource(cfg.Search.Mode)
			}
			if strings.TrimSpace(discCfg.Query) == "" {
				discCfg.Query = strings.TrimSpace(cfg.Search.Query)
			}
			if len(discCfg.Queries) == 0 && len(cfg.Search.Queries) > 0 {
				discCfg.Queries = append([]string(nil), cfg.Search.Queries...)
			}
			if strings.TrimSpace(discCfg.ContractType) == "" && cfg.Search.ContractType != nil {
				discCfg.ContractType = strings.TrimSpace(*cfg.Search.ContractType)
			}

			filterCfg.RequiredKeywords = append([]string(nil), cfg.Filters.RequiredKeywords...)
			filterCfg.ExcludeKeywords = append([]string(nil), cfg.Filters.ExcludeKeywords...)
			filterCfg.MinScore = cfg.Filters.MinScore
			filterCfg.MaxPostedAgeDays = cfg.Filters.MaxPostedAgeDays
			filterCfg.MaxProposals = cfg.Filters.MaxProposals
			if cfg.Filters.BudgetMin != nil {
				v := float64(*cfg.Filters.BudgetMin)
				filterCfg.BudgetMin = &v
			}
			if cfg.Filters.BudgetMax != nil {
				v := float64(*cfg.Filters.BudgetMax)
				filterCfg.BudgetMax = &v
			}
		}
	}

	if amountFacet := strings.TrimSpace(discCfg.Amount); amountFacet != "" {
		if minAmt, maxAmt, err := parseAmountFacet(amountFacet); err == nil {
			if discCfg.BudgetMin == nil && minAmt != nil {
				discCfg.BudgetMin = minAmt
			}
			if discCfg.BudgetMax == nil && maxAmt != nil {
				discCfg.BudgetMax = maxAmt
			}
		}
	}

	if discCfg.BudgetMin != nil {
		v := float64(*discCfg.BudgetMin)
		filterCfg.BudgetMin = &v
	}
	if discCfg.BudgetMax != nil {
		v := float64(*discCfg.BudgetMax)
		filterCfg.BudgetMax = &v
	}
	if discCfg.HourlyRateMin != nil {
		v := *discCfg.HourlyRateMin
		filterCfg.HourlyRateMin = &v
	}
	if discCfg.HourlyRateMax != nil {
		v := *discCfg.HourlyRateMax
		filterCfg.HourlyRateMax = &v
	}
	if discCfg.PaymentVerifiedOnly != nil {
		filterCfg.PaymentVerifiedOnly = *discCfg.PaymentVerifiedOnly
	}

	if discCfg.FromActiveProjects && gormDB != nil {
		if derivedQueries, _, err := deriveQueriesFromActiveProjects(gormDB, discCfg.ActiveProjectKeys, discCfg.ActiveProjectTiers); err == nil && len(derivedQueries) > 0 {
			discCfg.Queries = mergeUniqueQueries([]string{discCfg.Query}, discCfg.Queries, derivedQueries)
			discCfg.Query = ""
		}
	}

	return discCfg, filterCfg
}

func matchObservedBatchToRule(
	evt bridge.SearchObservedEvent,
	normalizedEvtFeed string,
	discCfg DiscoveryConfig,
	filterCfg scoring.FilterConfig,
	newReqs []saveJobRequest,
	reqKeyToJobID map[string]uint,
	profile *scoring.ScoringProfile,
) ([]saveJobRequest, []uint) {
	if len(newReqs) == 0 {
		return nil, nil
	}

	ruleSource := normalizeLiveFeedSource(discCfg.Source)
	if strings.TrimSpace(discCfg.Source) == "" && strings.TrimSpace(discCfg.SearchURL) != "" {
		ruleSource = inferFeedSourceFromURL(discCfg.SearchURL)
	}
	if !strings.EqualFold(ruleSource, normalizedEvtFeed) {
		return nil, nil
	}

	var pageURLQ string
	if rawPageURL := strings.TrimSpace(evt.PageURL); rawPageURL != "" {
		if parsedPageURL, err := url.Parse(rawPageURL); err == nil {
			pageURLQ = parsedPageURL.Query().Get("q")
		}
	}

	if rawSearchURL := strings.TrimSpace(discCfg.SearchURL); rawSearchURL != "" {
		ruleURL, err := url.Parse(rawSearchURL)
		if err != nil {
			return nil, nil
		}
		pageURL, pErr := url.Parse(strings.TrimSpace(evt.PageURL))
		if pErr != nil || strings.TrimSpace(evt.PageURL) == "" {
			return nil, nil
		}
		rulePath := strings.TrimRight(strings.ToLower(ruleURL.Path), "/")
		pagePath := strings.TrimRight(strings.ToLower(pageURL.Path), "/")
		if rulePath != pagePath {
			return nil, nil
		}
		if ruleQ := normalizeQueryText(ruleURL.Query().Get("q")); ruleQ != "" {
			if normalizeQueryText(pageURL.Query().Get("q")) != ruleQ && normalizeQueryText(evt.Query) != ruleQ {
				return nil, nil
			}
		}
	}

	candidates := newReqs
	ruleQueries := mergeUniqueQueries([]string{discCfg.Query}, discCfg.Queries)
	if ruleSource == "search" && len(ruleQueries) > 0 {
		evtQ := normalizeQueryText(firstNonEmpty(evt.Query, pageURLQ))
		batchQueryMatched := false
		if evtQ != "" {
			for _, rq := range ruleQueries {
				if normalizeQueryText(rq) == evtQ {
					batchQueryMatched = true
					break
				}
			}
		}
		if !batchQueryMatched {
			matchedByToken := make([]saveJobRequest, 0, len(candidates))
			for _, req := range candidates {
				if jobMatchesAnyQueryTokens(req, ruleQueries) {
					matchedByToken = append(matchedByToken, req)
				}
			}
			candidates = matchedByToken
		}
	}
	if len(candidates) == 0 {
		return nil, nil
	}

	surviving := filterSaveJobRequests(candidates, filterCfg, scoring.StagePreEnrichment, profile)
	if len(surviving) == 0 {
		return nil, nil
	}

	matchedReqs := make([]saveJobRequest, 0, len(surviving))
	matchedIDs := make([]uint, 0, len(surviving))
	seenIDs := make(map[uint]struct{}, len(surviving))
	for _, req := range surviving {
		if !matchesContractTypeFilter(req, discCfg.ContractType) {
			continue
		}
		matchedReqs = append(matchedReqs, req)
		jobID := reqKeyToJobID[canonicalKeyForRequest(req)]
		if jobID == 0 {
			continue
		}
		if _, dup := seenIDs[jobID]; dup {
			continue
		}
		seenIDs[jobID] = struct{}{}
		matchedIDs = append(matchedIDs, jobID)
	}

	if len(matchedIDs) == 0 {
		return nil, nil
	}
	return matchedReqs, matchedIDs
}

func normalizeLiveFeedSource(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "best_matches", "best-matches":
		return "best_matches"
	case "most_recent", "most-recent":
		return "most_recent"
	case "saved_jobs", "saved-jobs":
		return "saved_jobs"
	default:
		return "search"
	}
}

func inferFeedSourceFromURL(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "search"
	}
	path := strings.ToLower(parsed.Path)
	switch {
	case strings.Contains(path, "best-matches"):
		return "best_matches"
	case strings.Contains(path, "most-recent"):
		return "most_recent"
	case strings.Contains(path, "saved-jobs"):
		return "saved_jobs"
	default:
		return "search"
	}
}

func normalizeQueryText(raw string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(raw)), " "))
}

func jobMatchesAnyQueryTokens(req saveJobRequest, queries []string) bool {
	haystack := strings.TrimSpace(req.JobTitle + " " + req.JobDescription + " " + req.Skills.Text)
	if haystack == "" {
		return false
	}
	for _, rq := range queries {
		tokens := strings.Fields(strings.TrimSpace(rq))
		if len(tokens) == 0 {
			continue
		}
		allMatched := true
		for _, tok := range tokens {
			if !scoring.KeywordMatches(tok, haystack) {
				allMatched = false
				break
			}
		}
		if allMatched {
			return true
		}
	}
	return false
}

func matchesContractTypeFilter(req saveJobRequest, wantCT string) bool {
	want := strings.ToLower(strings.TrimSpace(wantCT))
	if want != "hourly" && want != "fixed" {
		return true
	}

	inferred := ""
	ct := strings.ToLower(strings.TrimSpace(req.ContractType))
	if ct == "hourly" || ct == "fixed" {
		inferred = ct
	} else {
		hourlyRate := effectiveHourlyRate(req.RateRange, req.ContractType, req.Budget, req.RateMin, req.RateMax)
		budgetLower := strings.ToLower(strings.TrimSpace(req.Budget))
		rateRangeLower := strings.ToLower(strings.TrimSpace(req.RateRange))

		hasHourlySignal := (hourlyRate != "" && !strings.Contains(strings.ToLower(hourlyRate), "fixed")) ||
			strings.TrimSpace(req.RateMin) != "" ||
			strings.TrimSpace(req.RateMax) != "" ||
			strings.Contains(budgetLower, "/hr") ||
			strings.Contains(budgetLower, "hourly")

		hasFixedSignal := strings.TrimSpace(req.BudgetAmount) != "" ||
			strings.Contains(budgetLower, "fixed") ||
			strings.Contains(rateRangeLower, "fixed") ||
			(scoring.ParseBudgetAmount(req.Budget) != nil && !hasHourlySignal)

		switch {
		case hasHourlySignal && !hasFixedSignal:
			inferred = "hourly"
		case hasFixedSignal && !hasHourlySignal:
			inferred = "fixed"
		}
	}

	return inferred == "" || inferred == want
}
