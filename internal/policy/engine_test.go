package policy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

func setupPolicyTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	rawURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if rawURL == "" {
		t.Skip("skipping Postgres policy integration test: TEST_DATABASE_URL is not set")
	}

	var rnd [4]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	schemaName := "test_policy_" + hex.EncodeToString(rnd[:])

	adminDB, err := gorm.Open(postgres.Open(rawURL), &gorm.Config{})
	if err != nil {
		t.Fatalf("open admin test db: %v", err)
	}
	if err := adminDB.Exec(fmt.Sprintf(`CREATE SCHEMA "%s"`, schemaName)).Error; err != nil {
		t.Fatalf("create schema: %v", err)
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse TEST_DATABASE_URL: %v", err)
	}
	q := u.Query()
	q.Set("search_path", schemaName)
	u.RawQuery = q.Encode()

	db, err := gorm.Open(postgres.Open(u.String()), &gorm.Config{})
	if err != nil {
		t.Fatalf("open schema test db: %v", err)
	}
	if err := db.AutoMigrate(dbservice.AllModels()...); err != nil {
		t.Fatalf("AutoMigrate: %v", err)
	}

	t.Cleanup(func() {
		sqlDB, _ := db.DB()
		if sqlDB != nil {
			_ = sqlDB.Close()
		}
		_ = adminDB.Exec(fmt.Sprintf(`DROP SCHEMA IF EXISTS "%s" CASCADE`, schemaName)).Error
		adminSQLDB, _ := adminDB.DB()
		if adminSQLDB != nil {
			_ = adminSQLDB.Close()
		}
	})

	return db
}

func TestDefaultConfigFromEnv_PreservesZeroCaps(t *testing.T) {
	t.Setenv("POLICY_MODE", "auto_with_guardrails")
	t.Setenv("MAX_PROPOSALS_PER_DAY", "0")
	t.Setenv("MAX_CONNECTS_PER_DAY", "0")
	t.Setenv("MAX_MESSAGES_PER_DAY", "0")
	t.Setenv("MIN_JOB_SCORE", "75")
	t.Setenv("ALLOWED_ROOM_IDS", "room_a, room_b")
	t.Setenv("QUIET_HOURS", "22:00-06:00")

	cfg := DefaultConfigFromEnv()
	if cfg.Mode != ModeAutoWithGuardrails {
		t.Fatalf("Mode = %q, want auto_with_guardrails", cfg.Mode)
	}
	if cfg.MaxProposalsPerDay != 0 || cfg.MaxConnectsPerDay != 0 || cfg.MaxMessagesPerDay != 0 {
		t.Fatalf("expected zero caps preserved, got %+v", cfg)
	}
	if cfg.MinJobScore != 75 {
		t.Fatalf("MinJobScore = %d, want 75", cfg.MinJobScore)
	}
	if len(cfg.AllowedRoomIDs) != 2 || cfg.AllowedRoomIDs[0] != "room_a" || cfg.AllowedRoomIDs[1] != "room_b" {
		t.Fatalf("unexpected AllowedRoomIDs: %+v", cfg.AllowedRoomIDs)
	}
	if cfg.QuietHours == nil || *cfg.QuietHours != "22:00-06:00" {
		t.Fatalf("unexpected QuietHours: %v", cfg.QuietHours)
	}
	if !cfg.AutoSubmitProposals || !cfg.AutoSendMessages {
		t.Fatalf("expected auto flags true by default")
	}
}

func TestQuietHours_NormalWraparoundAndAllDay(t *testing.T) {
	loc := time.UTC
	if _, _, err := ParseQuietHours("invalid"); err == nil {
		t.Fatal("expected error for invalid quiet_hours")
	}
	if _, _, err := ParseQuietHours("25:00-06:00"); err == nil {
		t.Fatal("expected error for invalid hour")
	}

	// Normal daytime window 09:00-17:00
	if !IsInQuietHours("09:00-17:00", time.Date(2026, 11, 20, 12, 30, 0, 0, loc), loc) {
		t.Fatal("expected 12:30 inside 09:00-17:00")
	}
	if IsInQuietHours("09:00-17:00", time.Date(2026, 11, 20, 18, 0, 0, 0, loc), loc) {
		t.Fatal("expected 18:00 outside 09:00-17:00")
	}

	// Wraparound overnight window 22:00-07:00
	if !IsInQuietHours("22:00-07:00", time.Date(2026, 11, 20, 23, 15, 0, 0, loc), loc) {
		t.Fatal("expected 23:15 inside 22:00-07:00")
	}
	if !IsInQuietHours("22:00-07:00", time.Date(2026, 11, 20, 3, 45, 0, 0, loc), loc) {
		t.Fatal("expected 03:45 inside 22:00-07:00")
	}
	if IsInQuietHours("22:00-07:00", time.Date(2026, 11, 20, 14, 0, 0, 0, loc), loc) {
		t.Fatal("expected 14:00 outside 22:00-07:00")
	}

	// 00:00-23:59 blocks even at 23:59
	if !IsInQuietHours("00:00-23:59", time.Date(2026, 11, 20, 23, 59, 0, 0, loc), loc) {
		t.Fatal("expected 23:59 inside 00:00-23:59")
	}
}

func TestTokenGenerationAndDualExpiry(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	eng := NewEngine(nil).WithClock(func() time.Time { return now }, time.UTC).WithTokenTTL(24 * time.Hour)

	t1, exp1, err := eng.GenerateApprovalToken()
	if err != nil {
		t.Fatalf("GenerateApprovalToken: %v", err)
	}
	t2, _, err := eng.GenerateApprovalToken()
	if err != nil {
		t.Fatalf("GenerateApprovalToken 2: %v", err)
	}
	if len(t1) != 64 || t1 == t2 {
		t.Fatalf("expected unique 64-char hex tokens, got %q and %q", t1, t2)
	}
	if !TokensEqual(t1, t1) || TokensEqual(t1, t2) || TokensEqual("", "") {
		t.Fatal("TokensEqual failed")
	}
	if eng.IsTokenExpired(&exp1, nil, now) {
		t.Fatal("fresh token should not be expired")
	}

	// Explicit expiry in past
	past := now.Add(-time.Minute)
	if !eng.IsTokenExpired(&past, nil, now) {
		t.Fatal("expected expired when expiresAt < now")
	}

	// T2-F5-03 SQL aging: updated_at and approved_at moved back 2 days while expiresAt is future
	twoDaysAgo := now.Add(-48 * time.Hour)
	if !eng.IsTokenExpired(&exp1, &twoDaysAgo, twoDaysAgo) {
		t.Fatal("expected expired when approved_at/updated_at > 24h old")
	}
}

func TestEvaluateProposalAndMessagePolicies(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	eng := NewEngine(nil).WithClock(func() time.Time { return now }, time.UTC)

	validProp := dbservice.Proposal{
		Status:        "pending_approval",
		ApprovalToken: "tok-valid-123",
		UpdatedAt:     now,
	}
	validMsg := &dbservice.Message{
		Status:        "pending_approval",
		ApprovalToken: "msg-tok-123",
		UpdatedAt:     now,
	}

	// 1. draft_only hard-blocks even with valid token or UI approval
	draftPolicy := modelFromConfig(Config{
		Mode:                ModeDraftOnly,
		AutoSubmitProposals: true,
		AutoSendMessages:    true,
		MaxProposalsPerDay:  10,
		MaxConnectsPerDay:   100,
		MaxMessagesPerDay:   20,
	})
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     draftPolicy,
		Proposal:      validProp,
		ProvidedToken: "tok-valid-123",
		HumanApproved: true,
	}); err == nil || !strings.Contains(err.Message, "draft_only") {
		t.Fatalf("expected draft_only block for proposal, got %v", err)
	}
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:     draftPolicy,
		RoomID:        "room_alpha",
		DraftMessage:  validMsg,
		ProvidedToken: "msg-tok-123",
		HumanApproved: true,
	}); err == nil || !strings.Contains(err.Message, "draft_only") {
		t.Fatalf("expected draft_only block for message, got %v", err)
	}

	// 2. confirm_in_ui requires token or UI click
	confirmPolicy := modelFromConfig(Config{
		Mode:                ModeConfirmInUI,
		AutoSubmitProposals: true,
		AutoSendMessages:    true,
		MaxProposalsPerDay:  5,
		MaxConnectsPerDay:   50,
		MaxMessagesPerDay:   20,
	})
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow: confirmPolicy,
		Proposal:  validProp,
	}); err == nil || err.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED without token, got %v", err)
	}
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     confirmPolicy,
		Proposal:      validProp,
		ProvidedToken: "tok-valid-123",
		ConnectsCost:  12,
	}); err != nil {
		t.Fatalf("expected valid token to pass confirm_in_ui, got %v", err)
	}

	// 3. auto_with_guardrails enforces min_job_score, quiet_hours, allowed_room_ids, and 0 caps
	score74 := 74
	score75 := 75
	qh := "00:00-23:59"
	autoPolicy := modelFromConfig(Config{
		Mode:                ModeAutoWithGuardrails,
		AutoSubmitProposals: true,
		AutoSendMessages:    true,
		MaxProposalsPerDay:  1,
		MaxConnectsPerDay:   20,
		MaxMessagesPerDay:   1,
		MinJobScore:         75,
		AllowedRoomIDs:      []string{"room_alpha"},
	})
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:    autoPolicy,
		Proposal:     dbservice.Proposal{Status: "draft"},
		JobScore:     &score74,
		ConnectsCost: 10,
	}); err == nil || err.Code != ErrCodePolicyBlocked || !strings.Contains(err.Message, "min_job_score") {
		t.Fatalf("expected min_job_score block, got %v", err)
	}
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:    autoPolicy,
		Proposal:     dbservice.Proposal{Status: "draft"},
		JobScore:     &score75,
		ConnectsCost: 10,
	}); err != nil {
		t.Fatalf("expected score 75 to pass, got %v", err)
	}
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:    autoPolicy,
		Usage:        UsageSnapshot{ProposalsToday: 1, ConnectsToday: 10},
		Proposal:     dbservice.Proposal{Status: "draft"},
		JobScore:     &score75,
		ConnectsCost: 6,
	}); err == nil || err.Code != ErrCodeDailyCapExceeded {
		t.Fatalf("expected DAILY_CAP_EXCEEDED at 1/1 proposals, got %v", err)
	}
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:    autoPolicy,
		Usage:        UsageSnapshot{ProposalsToday: 0, ConnectsToday: 15},
		Proposal:     dbservice.Proposal{Status: "draft"},
		JobScore:     &score75,
		ConnectsCost: 6,
	}); err == nil || err.Code != ErrCodeDailyCapExceeded {
		t.Fatalf("expected DAILY_CAP_EXCEEDED at 15+6 > 20 connects, got %v", err)
	}
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow: autoPolicy,
		RoomID:    "room_beta",
	}); err == nil || err.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED for unlisted room_beta, got %v", err)
	}

	autoQuiet := autoPolicy
	autoQuiet.QuietHours = qh
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow: autoQuiet,
		RoomID:    "room_alpha",
	}); err == nil || !strings.Contains(err.Message, "quiet_hours") {
		t.Fatalf("expected quiet_hours block, got %v", err)
	}
}

func TestPolicyEngine_PostgresPersistenceKillSwitchAndUsage(t *testing.T) {
	db := setupPolicyTestDB(t)
	ctx := context.Background()
	now := time.Date(2026, 11, 20, 15, 0, 0, 0, time.UTC)
	eng := NewEngine(db).WithClock(func() time.Time { return now }, time.UTC)

	snap, err := eng.GetSnapshot(ctx)
	if err != nil {
		t.Fatalf("GetSnapshot initial: %v", err)
	}
	if snap.Mode != ModeConfirmInUI || snap.MaxProposalsPerDay != 5 {
		t.Fatalf("unexpected default snapshot: %+v", snap)
	}

	// Update with explicit 0 cap and quiet_hours
	modeAuto := ModeAutoWithGuardrails
	zero := 0
	qh := "00:00-23:59"
	updated, err := eng.Update(ctx, UpdateInput{
		Mode:               &modeAuto,
		MaxProposalsPerDay: &zero,
		QuietHours:         NullableString{Set: true, Value: &qh},
	}, "test")
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Mode != ModeAutoWithGuardrails || updated.MaxProposalsPerDay != 0 || updated.QuietHours == nil || *updated.QuietHours != qh {
		t.Fatalf("unexpected updated snapshot: %+v", updated)
	}

	// Clear quiet_hours with explicit null
	cleared, err := eng.Update(ctx, UpdateInput{
		QuietHours: NullableString{Set: true, Value: nil},
	}, "test")
	if err != nil {
		t.Fatalf("Update clear quiet_hours: %v", err)
	}
	if cleared.QuietHours != nil {
		t.Fatalf("expected QuietHours nil after clear, got %v", *cleared.QuietHours)
	}

	// Seed a submitted proposal + pending proposal + received client message + sent freelancer message
	connReq := 12
	boost := 4
	job := dbservice.Job{Title: "Go Job", ConnectsRequired: &connReq, Status: "applied"}
	if err := db.Create(&job).Error; err != nil {
		t.Fatalf("create job: %v", err)
	}
	if err := db.Create(&dbservice.Proposal{
		JobID:         &job.ID,
		UpworkJobID:   "~123",
		Status:        "submitted",
		BoostConnects: &boost,
		SubmittedAt:   &now,
	}).Error; err != nil {
		t.Fatalf("create submitted proposal: %v", err)
	}
	if err := db.Create(&dbservice.Proposal{
		UpworkJobID: "~456",
		Status:      "pending_approval",
	}).Error; err != nil {
		t.Fatalf("create pending proposal: %v", err)
	}
	thread := dbservice.MessageThread{UpworkRoomID: "room_1", ClientName: "Alice"}
	if err := db.Create(&thread).Error; err != nil {
		t.Fatalf("create thread: %v", err)
	}
	if err := db.Create(&dbservice.Message{
		ThreadID:   thread.ID,
		Sender:     "Alice",
		SenderRole: "client",
		Body:       "Hello",
		Status:     "received",
		SentAt:     &now,
	}).Error; err != nil {
		t.Fatalf("create client message: %v", err)
	}
	if err := db.Create(&dbservice.Message{
		ThreadID:   thread.ID,
		Sender:     "Maxx",
		SenderRole: "freelancer",
		Body:       "Hi Alice",
		Status:     "sent",
		SentAt:     &now,
	}).Error; err != nil {
		t.Fatalf("create sent message: %v", err)
	}

	usage, err := eng.ComputeUsage(db)
	if err != nil {
		t.Fatalf("ComputeUsage: %v", err)
	}
	if usage.ProposalsToday != 1 || usage.ConnectsToday != 16 || usage.MessagesToday != 1 || usage.PendingApprovals != 1 {
		t.Fatalf("unexpected usage: %+v", usage)
	}

	// Kill switch drops to draft_only and writes action_audit_logs
	ksSnap, err := eng.ActivateKillSwitch(ctx, "Emergency stop", "user")
	if err != nil {
		t.Fatalf("ActivateKillSwitch: %v", err)
	}
	if ksSnap.Mode != ModeDraftOnly || !ksSnap.KillSwitchActive {
		t.Fatalf("expected draft_only + kill_switch_active=true, got %+v", ksSnap)
	}

	var auditCount int64
	if err := db.Model(&dbservice.ActionAuditLog{}).Where("action_type = ?", "kill_switch_activated").Count(&auditCount).Error; err != nil {
		t.Fatalf("count audit: %v", err)
	}
	if auditCount != 1 {
		t.Fatalf("expected 1 kill_switch_activated audit log, got %d", auditCount)
	}
}

func TestPolicyEngine_GuardrailBoundariesAndTimezoneQuietHours(t *testing.T) {
	nyLoc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}
	// 2026-11-20 04:30 UTC == 2026-11-19 23:30 EST (inside 22:00-07:00)
	utcNight := time.Date(2026, 11, 20, 4, 30, 0, 0, time.UTC)
	eng := NewEngine(nil).WithClock(func() time.Time { return utcNight }, nyLoc)

	if IsInQuietHours("09:00-09:00", utcNight, time.UTC) {
		t.Fatal("expected equal start/end quiet_hours 09:00-09:00 to be empty window (false)")
	}
	if !IsInQuietHours("22:00-07:00", utcNight, nyLoc) {
		t.Fatal("expected 23:30 EST (04:30 UTC) inside 22:00-07:00 America/New_York")
	}

	autoPolicy := modelFromConfig(Config{
		Mode:                ModeAutoWithGuardrails,
		AutoSubmitProposals: true,
		AutoSendMessages:    true,
		MaxProposalsPerDay:  5,
		MaxConnectsPerDay:   50,
		MaxMessagesPerDay:   10,
		MinJobScore:         75,
		AllowedRoomIDs:      []string{},
	})

	if pErr := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow: autoPolicy,
		Proposal:  dbservice.Proposal{Status: "draft"},
		JobScore:  nil,
	}); pErr == nil || pErr.Code != ErrCodePolicyBlocked {
		t.Fatalf("expected POLICY_BLOCKED for nil JobScore when MinJobScore=75, got %v", pErr)
	}

	disabledAutoProp := autoPolicy
	disabledAutoProp.AutoSubmitProposals = false
	score80 := 80
	if pErr := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow: disabledAutoProp,
		Proposal:  dbservice.Proposal{Status: "draft"},
		JobScore:  &score80,
	}); pErr == nil || pErr.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED when AutoSubmitProposals=false, got %v", pErr)
	}

	if mErr := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow: autoPolicy,
		RoomID:    "any_unlisted_room",
	}); mErr != nil {
		t.Fatalf("expected empty AllowedRoomIDs to allow any room, got %v", mErr)
	}

	disabledAutoMsg := autoPolicy
	disabledAutoMsg.AutoSendMessages = false
	if mErr := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow: disabledAutoMsg,
		RoomID:    "any_room",
	}); mErr == nil || mErr.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED when AutoSendMessages=false, got %v", mErr)
	}

	// R4: rejected/archived proposals and inbound client/rejected messages blocked in auto_with_guardrails
	for _, st := range []string{"rejected", "archived", "failed"} {
		if pErr := eng.EvaluateProposalSubmit(ProposalAuthRequest{
			PolicyRow: autoPolicy,
			Proposal:  dbservice.Proposal{Status: st},
			JobScore:  &score80,
		}); pErr == nil || pErr.Code != "PROPOSAL_NOT_SUBMITTABLE" {
			t.Fatalf("expected PROPOSAL_NOT_SUBMITTABLE for status %q, got %v", st, pErr)
		}
	}
	if mErr := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:    autoPolicy,
		RoomID:       "room_alpha",
		DraftMessage: &dbservice.Message{ID: 1, SenderRole: "client", Status: "received"},
	}); mErr == nil || mErr.Code != "INVALID_MESSAGE_TARGET" {
		t.Fatalf("expected INVALID_MESSAGE_TARGET for inbound client message, got %v", mErr)
	}
	if mErr := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:    autoPolicy,
		RoomID:       "room_alpha",
		DraftMessage: &dbservice.Message{ID: 2, SenderRole: "freelancer", Status: "rejected"},
	}); mErr == nil || mErr.Code != "MESSAGE_REDRAFT_REQUIRED" {
		t.Fatalf("expected MESSAGE_REDRAFT_REQUIRED for rejected draft message, got %v", mErr)
	}
}

func TestPolicyEngine_R5_TokenCannotBypassAutoWithGuardrails(t *testing.T) {
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	eng := NewEngine(nil).WithClock(func() time.Time { return now }, time.UTC)

	filledProp := dbservice.Proposal{
		ID:                       42,
		Status:                   "pending_approval",
		ApprovalToken:            "tok-filled-123",
		VerificationSnapshotJSON: dbservice.JSONB(`{"ok":true}`),
		UpdatedAt:                now,
	}
	unfilledPendingProp := dbservice.Proposal{
		ID:            43,
		Status:        "pending_approval",
		ApprovalToken: "",
		UpdatedAt:     now,
	}
	draftMsg := &dbservice.Message{
		ID:            99,
		Status:        "pending_approval",
		ApprovalToken: "tok-msg-123",
		UpdatedAt:     now,
	}

	qh := "00:00-23:59"
	lowScore := 10
	highScore := 95

	// 1. Proposals under auto_with_guardrails: valid approval_token with HumanApproved=false MUST NOT bypass guardrails
	disabledAutoPropPolicy := modelFromConfig(Config{
		Mode:                ModeAutoWithGuardrails,
		AutoSubmitProposals: false,
		MaxProposalsPerDay:  5,
		MaxConnectsPerDay:   50,
		MinJobScore:         80,
	})
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     disabledAutoPropPolicy,
		Proposal:      filledProp,
		JobScore:      &highScore,
		ProvidedToken: "tok-filled-123",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED when auto_submit_proposals=false even with valid token, got %v", err)
	}

	// Score below min_job_score blocked even with valid token
	scorePolicy := modelFromConfig(Config{
		Mode:                ModeAutoWithGuardrails,
		AutoSubmitProposals: true,
		MaxProposalsPerDay:  5,
		MaxConnectsPerDay:   50,
		MinJobScore:         80,
	})
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     scorePolicy,
		Proposal:      filledProp,
		JobScore:      &lowScore,
		ProvidedToken: "tok-filled-123",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodePolicyBlocked || !strings.Contains(err.Message, "min_job_score") {
		t.Fatalf("expected POLICY_BLOCKED (min_job_score) even with valid token, got %v", err)
	}

	// quiet_hours blocked even with valid token
	quietPropPolicy := scorePolicy
	quietPropPolicy.QuietHours = qh
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     quietPropPolicy,
		Proposal:      filledProp,
		JobScore:      &highScore,
		ProvidedToken: "tok-filled-123",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodePolicyBlocked || !strings.Contains(err.Message, "quiet_hours") {
		t.Fatalf("expected POLICY_BLOCKED (quiet_hours) even with valid token, got %v", err)
	}

	// Wrong token rejected even when all auto guardrails pass
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     scorePolicy,
		Proposal:      filledProp,
		JobScore:      &highScore,
		ProvidedToken: "wrong-token",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED for wrong token under auto_with_guardrails, got %v", err)
	}

	// UI HumanApproved=true STILL succeeds when filled, even if auto_submit_proposals=false / low score / quiet_hours
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     disabledAutoPropPolicy,
		Proposal:      filledProp,
		JobScore:      &lowScore,
		HumanApproved: true,
	}); err != nil {
		t.Fatalf("expected HumanApproved=true to succeed for filled proposal, got %v", err)
	}

	// UI HumanApproved=true on unfilled pending_approval MUST fail PROPOSAL_REFILL_REQUIRED
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     scorePolicy,
		Proposal:      unfilledPendingProp,
		JobScore:      &highScore,
		HumanApproved: true,
	}); err == nil || err.Code != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected PROPOSAL_REFILL_REQUIRED for HumanApproved on unfilled pending_approval, got %v", err)
	}
	if err := eng.EvaluateProposalSubmit(ProposalAuthRequest{
		PolicyRow:     scorePolicy,
		Proposal:      unfilledPendingProp,
		JobScore:      &highScore,
		HumanApproved: false,
	}); err == nil || err.Code != "PROPOSAL_REFILL_REQUIRED" {
		t.Fatalf("expected PROPOSAL_REFILL_REQUIRED for autonomous submit on unfilled pending_approval, got %v", err)
	}

	// 2. Messages under auto_with_guardrails: valid approval_token with HumanApproved=false MUST NOT bypass guardrails
	disabledAutoMsgPolicy := modelFromConfig(Config{
		Mode:              ModeAutoWithGuardrails,
		AutoSendMessages:  false,
		MaxMessagesPerDay: 10,
		AllowedRoomIDs:    []string{"room_allowed"},
	})
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:     disabledAutoMsgPolicy,
		RoomID:        "room_allowed",
		DraftMessage:  draftMsg,
		ProvidedToken: "tok-msg-123",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodeApprovalRequired {
		t.Fatalf("expected APPROVAL_REQUIRED when auto_send_messages=false even with valid token, got %v", err)
	}

	allowlistMsgPolicy := modelFromConfig(Config{
		Mode:              ModeAutoWithGuardrails,
		AutoSendMessages:  true,
		MaxMessagesPerDay: 10,
		AllowedRoomIDs:    []string{"room_allowed"},
	})
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:     allowlistMsgPolicy,
		RoomID:        "room_forbidden",
		DraftMessage:  draftMsg,
		ProvidedToken: "tok-msg-123",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodeApprovalRequired || !strings.Contains(err.Message, "allowed_room_ids") {
		t.Fatalf("expected APPROVAL_REQUIRED (allowed_room_ids) even with valid token, got %v", err)
	}

	quietMsgPolicy := allowlistMsgPolicy
	quietMsgPolicy.QuietHours = qh
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:     quietMsgPolicy,
		RoomID:        "room_allowed",
		DraftMessage:  draftMsg,
		ProvidedToken: "tok-msg-123",
		HumanApproved: false,
	}); err == nil || err.Code != ErrCodePolicyBlocked || !strings.Contains(err.Message, "quiet_hours") {
		t.Fatalf("expected POLICY_BLOCKED (quiet_hours) even with valid token, got %v", err)
	}

	// UI HumanApproved=true STILL succeeds for message even when auto_send_messages=false / room unlisted
	if err := eng.EvaluateMessageSend(MessageAuthRequest{
		PolicyRow:     disabledAutoMsgPolicy,
		RoomID:        "room_forbidden",
		DraftMessage:  draftMsg,
		HumanApproved: true,
	}); err != nil {
		t.Fatalf("expected HumanApproved=true to succeed for message, got %v", err)
	}
}
