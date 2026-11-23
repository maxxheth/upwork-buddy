package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/scoring"

	"gorm.io/gorm"
)

func (m *WatcherManager) reactToJobs(
	ctx context.Context,
	gormDB *gorm.DB,
	rule *dbservice.WatchRule,
	runRow *dbservice.WatchRun,
	newJobIDs []uint,
	preloadedJobs []dbservice.Job,
	dryRun bool,
) ([]WatchEventView, error) {
	events := make([]WatchEventView, 0)
	var jobs []dbservice.Job
	switch {
	case len(preloadedJobs) > 0:
		jobs = append([]dbservice.Job(nil), preloadedJobs...)
	case len(newJobIDs) > 0:
		if err := gormDB.Where("id IN ?", newJobIDs).Find(&jobs).Error; err != nil {
			return events, err
		}
	default:
		return events, nil
	}
	if len(jobs) == 0 {
		return events, nil
	}

	// Sort by score DESC, then ID DESC for determinism.
	sort.SliceStable(jobs, func(i, j int) bool {
		si, sj := 0, 0
		if jobs[i].Score != nil {
			si = *jobs[i].Score
		}
		if jobs[j].Score != nil {
			sj = *jobs[j].Score
		}
		if si != sj {
			return si > sj
		}
		return jobs[i].ID > jobs[j].ID
	})

	maxReactions := rule.MaxReactionsPerTick
	if maxReactions <= 0 {
		maxReactions = 2
	}

	reqKWs := decodeStringSliceJSON(rule.RequiredKeywordsJSON)
	excKWs := decodeStringSliceJSON(rule.ExcludeKeywordsJSON)
	var bidStrat *ollama.BidStrategy
	if len(rule.BidStrategyJSON) > 0 {
		var bs ollama.BidStrategy
		if json.Unmarshal(rule.BidStrategyJSON, &bs) == nil {
			bidStrat = &bs
		}
	}

	reactionsTaken := 0
	for i := range jobs {
		if ctx.Err() != nil {
			break
		}
		if reactionsTaken >= maxReactions {
			break
		}
		job := jobs[i]

		// Idempotency check
		if m.shouldSkipJobIdempotency(gormDB, rule.ID, job) {
			continue
		}

		// Stage-2 gate
		if reason := m.checkStage2Gate(rule, job, reqKWs, excKWs); reason != "" {
			ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "filtered_out", reason, nil, "", "", dryRun)
			events = append(events, ev)
			continue
		}

		scoreVal := 0
		if job.Score != nil {
			scoreVal = *job.Score
		}

		// alert_only mode
		if strings.EqualFold(rule.ActionMode, "alert_only") {
			if scoreVal < rule.MinScore {
				ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "filtered_out", fmt.Sprintf("score %d < min_score %d", scoreVal, rule.MinScore), nil, "", "", dryRun)
				events = append(events, ev)
				continue
			}
			runRow.QualifiedCount++
			runRow.AlertedCount++
			reactionsTaken++
			ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "alert_only", "qualified_hot_job", nil, "", "", dryRun)
			events = append(events, ev)
			if !dryRun && m.notifier != nil {
				upworkID := derefTrimmedString(job.UpworkJobID)
				m.notifier.NotifyAsync(WatcherAlert{
					Event:       EventHotJobAlert,
					Title:       fmt.Sprintf("Hot Job (%d/100): %s", scoreVal, job.Title),
					Message:     fmt.Sprintf("Rule %q matched %s", rule.Name, upworkID),
					RuleID:      rule.ID,
					RuleName:    rule.Name,
					JobID:       job.ID,
					UpworkJobID: upworkID,
					Score:       &scoreVal,
				})
			}
			continue
		}

		// draft_and_fill / auto_submit
		m.activeCount.Add(1)
		ev, err := m.reactSingleJobProposal(ctx, gormDB, rule, runRow, job, bidStrat, dryRun)
		m.activeCount.Add(-1)
		if ev != nil {
			events = append(events, *ev)
		}
		reactionsTaken++
		if err != nil {
			if errors.Is(err, bridge.ErrHumanActionRequired) {
				return events, err
			}
			// Non-fatal per-job error already recorded on event; continue to next job.
		}
	}

	return events, nil
}

func (m *WatcherManager) reactSingleJobProposal(
	ctx context.Context,
	gormDB *gorm.DB,
	rule *dbservice.WatchRule,
	runRow *dbservice.WatchRun,
	job dbservice.Job,
	bidStrat *ollama.BidStrategy,
	dryRun bool,
) (*WatchEventView, error) {
	// Detail enrich if needed (skip live browser enrichment in dry_run to keep it side-effect-free).
	needsDetail := job.LastEnrichedAt == nil || job.ConnectsRequired == nil
	upworkID := derefTrimmedString(job.UpworkJobID)
	if needsDetail && !dryRun {
		_, enrichErr := m.server.ExecuteDetailEnrich(ctx, DetailEnrichRequest{
			UpworkJobID: upworkID,
			URL:         job.URL,
		})
		if enrichErr != nil {
			if errors.Is(enrichErr, bridge.ErrHumanActionRequired) {
				m.triggerHumanActionCircuitBreaker(ctx, gormDB, rule, enrichErr.Error())
				ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "paused_human_action", enrichErr.Error(), nil, bridge.ErrCodeHumanActionRequired, enrichErr.Error(), false)
				return &ev, enrichErr
			}
			if errors.Is(enrichErr, bridge.ErrExtensionDisconnected) {
				ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "deferred_extension_offline", "Chrome extension disconnected during detail enrich", nil, bridge.ErrCodeExtensionDisconnected, enrichErr.Error(), false)
				if m.notifier != nil {
					m.notifier.NotifyAsync(WatcherAlert{
						Event:       EventHotJobAlert,
						Title:       fmt.Sprintf("Hot Job (Extension Offline): %s", job.Title),
						Message:     "Detail enrichment deferred because Chrome extension is disconnected",
						RuleID:      rule.ID,
						RuleName:    rule.Name,
						JobID:       job.ID,
						UpworkJobID: upworkID,
						Score:       job.Score,
					})
				}
				return &ev, nil
			}
			ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "failed", "detail enrich failed", nil, extractErrorCode(enrichErr, "WATCHER_ERROR"), enrichErr.Error(), false)
			return &ev, enrichErr
		}
		// Reload enriched job
		var reloaded dbservice.Job
		if err := gormDB.First(&reloaded, job.ID).Error; err == nil {
			job = reloaded
			upworkID = derefTrimmedString(job.UpworkJobID)
		}
	}

	// Stage-3 hard gates
	if reason := m.checkStage3Gate(rule, job, dryRun); reason != "" {
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "filtered_out", reason, nil, "", "", dryRun)
		return &ev, nil
	}
	runRow.QualifiedCount++

	// Build FastProposalRequest
	jobInput := jobModelToScoringInput(job)
	profile, portfolioCtx, activeProjCtx, workloadSummary, matchedRefs := m.server.buildAnalysisContext(ctx, jobInput)

	var screeningQs []ollama.FastScreeningQuestion
	if len(job.ScreeningQuestions) > 0 {
		var rawQs []struct {
			Index    int    `json:"index"`
			Prompt   string `json:"prompt"`
			Question string `json:"question"`
			Required bool   `json:"required"`
		}
		if json.Unmarshal(job.ScreeningQuestions, &rawQs) == nil {
			for idx, q := range rawQs {
				prompt := strings.TrimSpace(q.Prompt)
				if prompt == "" {
					prompt = strings.TrimSpace(q.Question)
				}
				if prompt == "" {
					continue
				}
				qIdx := q.Index
				if qIdx == 0 && idx > 0 {
					qIdx = idx
				}
				screeningQs = append(screeningQs, ollama.FastScreeningQuestion{
					Index:    qIdx,
					Prompt:   prompt,
					Required: q.Required,
				})
			}
		}
	}

	fastReq := ollama.FastProposalRequest{
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
		ScreeningQuestions: screeningQs,
		UserProfile:        profile.Description,
		UserSkills:         profile.Skills,
		PortfolioItems:     portfolioCtx,
		ActiveProjects:     activeProjCtx,
		WorkloadSummary:    workloadSummary,
		BidStrategy:        bidStrat,
		Model:              rule.LLMModel,
		Effort:             rule.LLMEffort,
	}

	fastResp, llmErr := m.invokeDraftFastProposal(ctx, fastReq)
	if llmErr != nil {
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "failed", "llm drafting failed", nil, extractErrorCode(llmErr, "WATCHER_ERROR"), llmErr.Error(), dryRun)
		return &ev, llmErr
	}

	conf := fastResp.Confidence
	if strings.EqualFold(fastResp.GoNoGo, "no_go") {
		reason := strings.TrimSpace(fastResp.RejectReason)
		if reason == "" {
			reason = "llm_no_go"
		}
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "llm_rejected", reason, &conf, "", "", dryRun)
		return &ev, nil
	}

	if dryRun {
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "dry_run_preview", fmt.Sprintf("would_%s", rule.ActionMode), &conf, "", "", true)
		return &ev, nil
	}

	runRow.DraftedCount++

	// SaveProposal
	jobIDJSON, _ := json.Marshal(job.ID)
	milestonesJSON, _ := json.Marshal(fastResp.Milestones)
	screeningJSON, _ := json.Marshal(fastResp.ScreeningAnswers)
	portfolioJSON, _ := json.Marshal(matchedRefs)

	var boostConnects *int
	rateIncrease := ""
	if bidStrat != nil {
		boostConnects = bidStrat.BoostConnects
		rateIncrease = bidStrat.RateIncrease
	}

	propEntry, _, saveErr := m.server.SaveProposal(ctx, SaveProposalInput{
		JobID:                jobIDJSON,
		UpworkJobID:          upworkID,
		CoverLetter:          fastResp.CoverLetter,
		BidType:              fastResp.BidType,
		BidAmount:            fastResp.BidAmount,
		RateIncrease:         rateIncrease,
		ConnectsRequired:     job.ConnectsRequired,
		MilestonesJSON:       milestonesJSON,
		ScreeningAnswersJSON: screeningJSON,
		BoostConnects:        boostConnects,
		PortfolioRefsJSON:    portfolioJSON,
		Status:               "draft",
	}, "watcher")
	if saveErr != nil {
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, nil, "failed", "save proposal failed", &conf, extractErrorCode(saveErr, "WATCHER_ERROR"), saveErr.Error(), false)
		return &ev, saveErr
	}
	propID := propEntry.ID

	// FillProposal
	fillRes, fillErr := m.server.FillProposal(ctx, uint64(propID), FillProposalInput{
		RateIncrease: rateIncrease,
	})
	if fillErr != nil {
		if errors.Is(fillErr, bridge.ErrHumanActionRequired) {
			m.triggerHumanActionCircuitBreaker(ctx, gormDB, rule, fillErr.Error())
			ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "paused_human_action", fillErr.Error(), &conf, bridge.ErrCodeHumanActionRequired, fillErr.Error(), false)
			return &ev, fillErr
		}
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "failed", "fill proposal failed", &conf, extractErrorCode(fillErr, "WATCHER_ERROR"), fillErr.Error(), false)
		return &ev, fillErr
	}
	runRow.FilledCount++

	connectsCost := fillRes.TotalConnects
	if rule.MaxConnectsPerJob != nil && connectsCost > *rule.MaxConnectsPerJob {
		reason := fmt.Sprintf("connects_exceeded_cap (%d > %d)", connectsCost, *rule.MaxConnectsPerJob)
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "pending_approval", reason, &conf, "", "", false)
		m.notifyPendingApproval(rule, job, propID, connectsCost, conf, reason)
		return &ev, nil
	}

	if !strings.EqualFold(rule.ActionMode, "auto_submit") {
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "pending_approval", "draft_and_fill_ready", &conf, "", "", false)
		m.notifyPendingApproval(rule, job, propID, connectsCost, conf, "Ready for human approval")
		return &ev, nil
	}

	// auto_submit safety & confidence checks
	if fallbackReason := m.checkAutoSubmitEligibility(ctx, rule, fastResp, connectsCost); fallbackReason != "" {
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "pending_approval", fallbackReason, &conf, "", "", false)
		m.notifyPendingApproval(rule, job, propID, connectsCost, conf, fallbackReason)
		return &ev, nil
	}

	// CommitProposal (auto-submit)
	_, commitErr := m.server.CommitProposal(ctx, uint64(propID), CommitProposalInput{}, false)
	if commitErr != nil {
		if errors.Is(commitErr, bridge.ErrHumanActionRequired) {
			m.triggerHumanActionCircuitBreaker(ctx, gormDB, rule, commitErr.Error())
			ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "paused_human_action", commitErr.Error(), &conf, bridge.ErrCodeHumanActionRequired, commitErr.Error(), false)
			return &ev, commitErr
		}
		ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "failed", "commit proposal failed", &conf, extractErrorCode(commitErr, "WATCHER_ERROR"), commitErr.Error(), false)
		return &ev, commitErr
	}

	runRow.SubmittedCount++
	ev := m.recordWatchEvent(gormDB, rule.ID, runRow.ID, job, &propID, "submitted", "auto_submitted", &conf, "", "", false)
	if m.notifier != nil {
		m.notifier.NotifyAsync(WatcherAlert{
			Event:        EventProposalSubmitted,
			Title:        fmt.Sprintf("Proposal Submitted: %s", job.Title),
			Message:      fmt.Sprintf("Auto-submitted by rule %q (confidence %.2f)", rule.Name, conf),
			RuleID:       rule.ID,
			RuleName:     rule.Name,
			JobID:        job.ID,
			UpworkJobID:  upworkID,
			ProposalID:   &propID,
			Score:        job.Score,
			ConnectsCost: &connectsCost,
			Confidence:   &conf,
		})
	}
	return &ev, nil
}

func (m *WatcherManager) invokeDraftFastProposal(ctx context.Context, req ollama.FastProposalRequest) (*ollama.FastProposalResponse, error) {
	if m.draftFastProposalFn != nil {
		return m.draftFastProposalFn(ctx, req)
	}
	svc, err := ollama.New()
	if err != nil {
		return nil, err
	}
	defer func() { _ = svc.Close() }()
	return svc.DraftFastProposal(ctx, req)
}

func (m *WatcherManager) checkAutoSubmitEligibility(ctx context.Context, rule *dbservice.WatchRule, resp *ollama.FastProposalResponse, connectsCost int) string {
	if resp.Confidence < rule.AutoSubmitMinConfidence {
		return fmt.Sprintf("confidence %.2f < min %.2f", resp.Confidence, rule.AutoSubmitMinConfidence)
	}
	if rule.FallbackOnScreeningQuestions && resp.HasAmbiguousScreening {
		return "ambiguous_screening_questions"
	}
	if m.server == nil || m.server.PolicyEngine() == nil {
		return "policy_engine_unavailable"
	}
	snap, err := m.server.PolicyEngine().GetSnapshot(ctx)
	if err != nil {
		return "policy_snapshot_error: " + err.Error()
	}
	if snap.KillSwitchActive {
		return "kill_switch_active"
	}
	if snap.Mode != policy.ModeAutoWithGuardrails {
		return fmt.Sprintf("policy_mode_%s", snap.Mode)
	}
	if !snap.AutoSubmitProposals {
		return "auto_submit_proposals_disabled"
	}
	loc := m.localLoc
	if loc == nil {
		loc = time.Local
	}
	if snap.QuietHours != nil && policy.IsInQuietHours(*snap.QuietHours, m.nowFn(), loc) {
		return "quiet_hours_active"
	}
	if snap.MaxProposalsPerDay > 0 && snap.ProposalsToday >= snap.MaxProposalsPerDay {
		return "daily_proposals_cap_reached"
	}
	if snap.MaxConnectsPerDay > 0 && snap.ConnectsToday+connectsCost > snap.MaxConnectsPerDay {
		return "daily_connects_cap_reached"
	}
	return ""
}

func (m *WatcherManager) notifyPendingApproval(rule *dbservice.WatchRule, job dbservice.Job, propID uint, connectsCost int, conf float64, reason string) {
	if m.notifier == nil {
		return
	}
	m.notifier.NotifyAsync(WatcherAlert{
		Event:        EventPendingApproval,
		Title:        fmt.Sprintf("Approval Needed: %s", job.Title),
		Message:      fmt.Sprintf("Rule %q filled proposal #%d (%s)", rule.Name, propID, reason),
		RuleID:       rule.ID,
		RuleName:     rule.Name,
		JobID:        job.ID,
		UpworkJobID:  derefTrimmedString(job.UpworkJobID),
		ProposalID:   &propID,
		Score:        job.Score,
		ConnectsCost: &connectsCost,
		Confidence:   &conf,
	})
}

func (m *WatcherManager) shouldSkipJobIdempotency(gormDB *gorm.DB, ruleID uint, job dbservice.Job) bool {
	if strings.EqualFold(strings.TrimSpace(job.Status), "applied") {
		return true
	}
	if gormDB == nil {
		return false
	}
	if job.ID > 0 {
		var eventCount int64
		if err := gormDB.Model(&dbservice.WatchEvent{}).
			Where("watch_rule_id = ? AND job_id = ?", ruleID, job.ID).
			Count(&eventCount).Error; err == nil && eventCount > 0 {
			return true
		}
		var propCount int64
		if err := gormDB.Model(&dbservice.Proposal{}).
			Where("job_id = ? AND LOWER(status) NOT IN ?", job.ID, []string{"rejected", "archived", "failed"}).
			Count(&propCount).Error; err == nil && propCount > 0 {
			return true
		}
		return false
	}
	if upworkID := derefTrimmedString(job.UpworkJobID); upworkID != "" {
		var eventCount int64
		if err := gormDB.Model(&dbservice.WatchEvent{}).
			Where("watch_rule_id = ? AND upwork_job_id = ?", ruleID, upworkID).
			Count(&eventCount).Error; err == nil && eventCount > 0 {
			return true
		}
		var propCount int64
		if err := gormDB.Model(&dbservice.Proposal{}).
			Where("upwork_job_id = ? AND LOWER(status) NOT IN ?", upworkID, []string{"rejected", "archived", "failed"}).
			Count(&propCount).Error; err == nil && propCount > 0 {
			return true
		}
	}
	return false
}

func (m *WatcherManager) checkStage2Gate(rule *dbservice.WatchRule, job dbservice.Job, reqKWs, excKWs []string) string {
	haystack := strings.TrimSpace(job.Title + " " + job.Description + " " + job.Skills)

	for _, kw := range excKWs {
		if kw != "" && scoring.KeywordMatches(kw, haystack) {
			return fmt.Sprintf("excluded_keyword: %s", kw)
		}
	}
	if len(reqKWs) > 0 {
		matched := false
		for _, kw := range reqKWs {
			if kw != "" && scoring.KeywordMatches(kw, haystack) {
				matched = true
				break
			}
		}
		if !matched {
			return "missing_required_keyword"
		}
	}
	if rule.MaxProposals != nil && job.ProposalsCount != nil && *job.ProposalsCount > *rule.MaxProposals {
		return fmt.Sprintf("proposals %d > max_proposals %d", *job.ProposalsCount, *rule.MaxProposals)
	}
	if rule.MaxPostedAgeMinutes != nil && *rule.MaxPostedAgeMinutes > 0 {
		if ageMin, ok := estimateJobAgeMinutes(job, m.nowFn().UTC()); ok && ageMin > *rule.MaxPostedAgeMinutes {
			return fmt.Sprintf("posted_age %dm > max %dm", ageMin, *rule.MaxPostedAgeMinutes)
		}
	}

	score := 0
	if job.Score != nil {
		score = *job.Score
	}
	minPreScore := rule.MinScore
	if strings.EqualFold(rule.DiscoveryBackend, "scraper_fs") {
		minPreScore = max(0, rule.MinScore-15)
	}
	if score < minPreScore {
		return fmt.Sprintf("pre_score %d < threshold %d", score, minPreScore)
	}
	return ""
}

func (m *WatcherManager) checkStage3Gate(rule *dbservice.WatchRule, job dbservice.Job, dryRun bool) string {
	score := 0
	if job.Score != nil {
		score = *job.Score
	}
	if score < rule.MinScore {
		return fmt.Sprintf("score %d < min_score %d", score, rule.MinScore)
	}
	if rule.RequirePaymentVerified {
		if job.PaymentVerified != nil {
			if !*job.PaymentVerified {
				return "payment_not_verified"
			}
		} else if !(dryRun && job.LastEnrichedAt == nil) {
			return "payment_not_verified"
		}
	}
	if rule.MaxProposals != nil && job.ProposalsCount != nil && *job.ProposalsCount > *rule.MaxProposals {
		return fmt.Sprintf("proposals %d > max_proposals %d", *job.ProposalsCount, *rule.MaxProposals)
	}
	if rule.MaxConnectsPerJob != nil && job.ConnectsRequired != nil && *job.ConnectsRequired > *rule.MaxConnectsPerJob {
		return fmt.Sprintf("connects %d > max_connects_per_job %d", *job.ConnectsRequired, *rule.MaxConnectsPerJob)
	}
	return ""
}

func (m *WatcherManager) recordWatchEvent(
	gormDB *gorm.DB,
	ruleID uint,
	runID uint,
	job dbservice.Job,
	proposalID *uint,
	stage string,
	reason string,
	confidence *float64,
	errCode string,
	errMsg string,
	dryRun bool,
) WatchEventView {
	var runIDPtr *uint
	if runID != 0 {
		rID := runID
		runIDPtr = &rID
	}
	row := dbservice.WatchEvent{
		WatchRuleID:    ruleID,
		WatchRunID:     runIDPtr,
		JobID:          job.ID,
		UpworkJobID:    derefTrimmedString(job.UpworkJobID),
		ProposalID:     proposalID,
		Stage:          stage,
		DecisionReason: reason,
		Confidence:     confidence,
		ErrorCode:      errCode,
		ErrorMessage:   errMsg,
		CreatedAt:      m.nowFn().UTC(),
		UpdatedAt:      m.nowFn().UTC(),
	}
	if !dryRun && gormDB != nil {
		_ = gormDB.Create(&row).Error
	}
	return watchEventToView(row, job.Title)
}

func decodeStringSliceJSON(raw dbservice.JSONB) []string {
	if len(raw) == 0 {
		return nil
	}
	var out []string
	_ = json.Unmarshal(raw, &out)
	return out
}

func estimateJobAgeMinutes(job dbservice.Job, now time.Time) (int, bool) {
	if job.PostedAtEst != nil && !job.PostedAtEst.IsZero() {
		mins := int(now.Sub(job.PostedAtEst.UTC()).Minutes())
		if mins < 0 {
			mins = 0
		}
		return mins, true
	}
	txt := strings.ToLower(strings.TrimSpace(job.PostedText))
	if txt == "" {
		return 0, false
	}
	if strings.Contains(txt, "just now") || strings.Contains(txt, "seconds ago") {
		return 0, true
	}
	fields := strings.Fields(txt)
	if len(fields) >= 2 {
		if n, err := strconv.Atoi(fields[0]); err == nil && n >= 0 {
			unit := fields[1]
			switch {
			case strings.HasPrefix(unit, "min"):
				return n, true
			case strings.HasPrefix(unit, "hour") || strings.HasPrefix(unit, "hr"):
				return n * 60, true
			case strings.HasPrefix(unit, "day"):
				return n * 1440, true
			}
		}
	}
	return 0, false
}

func jobModelToScoringInput(job dbservice.Job) scoring.JobInput {
	var skills []string
	for _, s := range strings.Split(job.Skills, ",") {
		if trimmed := strings.TrimSpace(s); trimmed != "" {
			skills = append(skills, trimmed)
		}
	}
	return scoring.JobInput{
		Title:            job.Title,
		URL:              job.URL,
		Description:      job.Description,
		Budget:           job.Budget,
		HourlyRate:       job.RateRange,
		ExperienceLevel:  job.ExperienceLevel,
		Duration:         job.Duration,
		HoursPerWeek:     job.HoursPerWeek,
		Skills:           skills,
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
}
