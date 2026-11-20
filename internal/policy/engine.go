package policy

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	DefaultConfigKey = "default"

	ModeConfirmInUI        = "confirm_in_ui"
	ModeDraftOnly          = "draft_only"
	ModeAutoWithGuardrails = "auto_with_guardrails"

	ErrCodePolicyBlocked    = "POLICY_BLOCKED"
	ErrCodeApprovalRequired = "APPROVAL_REQUIRED"
	ErrCodeDailyCapExceeded = "DAILY_CAP_EXCEEDED"

	DefaultMaxProposalsPerDay = 5
	DefaultMaxConnectsPerDay  = 50
	DefaultMaxMessagesPerDay  = 20
	DefaultApprovalTokenTTL   = 24 * time.Hour
)

// PolicyError represents a deterministic policy/guardrail/cap rejection.
type PolicyError struct {
	Code       string         `json:"error_code"`
	HTTPStatus int            `json:"-"`
	Message    string         `json:"error"`
	Details    map[string]any `json:"details,omitempty"`
}

func (e *PolicyError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return e.Message
}

// Config represents the persisted runtime policy configuration.
type Config struct {
	Mode                string   `json:"mode"`
	AutoSubmitProposals bool     `json:"auto_submit_proposals"`
	AutoSendMessages    bool     `json:"auto_send_messages"`
	MaxProposalsPerDay  int      `json:"max_proposals_per_day"`
	MaxConnectsPerDay   int      `json:"max_connects_per_day"`
	MaxMessagesPerDay   int      `json:"max_messages_per_day"`
	MinJobScore         int      `json:"min_job_score"`
	AllowedRoomIDs      []string `json:"allowed_room_ids"`
	QuietHours          *string  `json:"quiet_hours"`
	KillSwitchActive    bool     `json:"kill_switch_active"`
}

// UsageSnapshot represents current UTC-day usage and pending approvals.
type UsageSnapshot struct {
	ProposalsToday   int `json:"proposals_today"`
	ConnectsToday    int `json:"connects_today"`
	MessagesToday    int `json:"messages_today"`
	PendingApprovals int `json:"pending_approvals"`
}

// Snapshot combines persisted Config, UsageSnapshot, and UpdatedAt timestamp.
type Snapshot struct {
	Config
	UsageSnapshot
	UpdatedAt string `json:"updated_at"`
}

// UpdateInput supports partial updates while preserving explicit zero values and nullable quiet_hours.
type UpdateInput struct {
	Mode                *string        `json:"mode"`
	AutoSubmitProposals *bool          `json:"auto_submit_proposals"`
	AutoSendMessages    *bool          `json:"auto_send_messages"`
	MaxProposalsPerDay  *int           `json:"max_proposals_per_day"`
	MaxConnectsPerDay   *int           `json:"max_connects_per_day"`
	MaxMessagesPerDay   *int           `json:"max_messages_per_day"`
	MinJobScore         *int           `json:"min_job_score"`
	AllowedRoomIDs      *[]string      `json:"allowed_room_ids"`
	QuietHours          NullableString `json:"quiet_hours"`
}

// NullableString distinguishes omitted JSON field vs explicit null vs string value.
type NullableString struct {
	Set   bool
	Value *string
}

func (n *NullableString) UnmarshalJSON(data []byte) error {
	n.Set = true
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		n.Value = nil
		return nil
	}
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	n.Value = &s
	return nil
}

// AuditEntry describes a row to insert into action_audit_logs.
type AuditEntry struct {
	ActionType string
	Actor      string
	TargetID   string
	PolicyMode string
	Outcome    string
	Details    map[string]any
}

// Engine evaluates and persists Upwork automation policy, daily caps, approval tokens, and audit logs.
type Engine struct {
	db       *gorm.DB
	now      func() time.Time
	localLoc *time.Location
	tokenTTL time.Duration
}

// NewEngine constructs a Postgres-backed policy engine.
func NewEngine(db *gorm.DB) *Engine {
	ttl := DefaultApprovalTokenTTL
	if raw := strings.TrimSpace(os.Getenv("APPROVAL_TOKEN_TTL")); raw != "" {
		if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
			ttl = parsed
		}
	}
	loc := time.Local
	if tz := strings.TrimSpace(os.Getenv("QUIET_HOURS_TZ")); tz != "" {
		if loaded, err := time.LoadLocation(tz); err == nil {
			loc = loaded
		}
	}
	return &Engine{
		db:       db,
		now:      func() time.Time { return time.Now().UTC() },
		localLoc: loc,
		tokenTTL: ttl,
	}
}

// WithClock overrides the engine clock and local timezone (for deterministic tests).
func (e *Engine) WithClock(nowFn func() time.Time, loc *time.Location) *Engine {
	if nowFn != nil {
		e.now = nowFn
	}
	if loc != nil {
		e.localLoc = loc
	}
	return e
}

// WithTokenTTL overrides the approval token TTL (for deterministic tests).
func (e *Engine) WithTokenTTL(ttl time.Duration) *Engine {
	if ttl > 0 {
		e.tokenTTL = ttl
	}
	return e
}

// IsValidMode checks whether mode is one of the 3 supported policy modes.
func IsValidMode(mode string) bool {
	switch strings.TrimSpace(mode) {
	case ModeConfirmInUI, ModeDraftOnly, ModeAutoWithGuardrails:
		return true
	default:
		return false
	}
}

// NormalizeMode returns a valid policy mode or confirm_in_ui fallback.
func NormalizeMode(mode string) string {
	trimmed := strings.TrimSpace(mode)
	if IsValidMode(trimmed) {
		return trimmed
	}
	return ModeConfirmInUI
}

// DefaultConfigFromEnv builds initial policy configuration from environment variables.
func DefaultConfigFromEnv() Config {
	mode := NormalizeMode(os.Getenv("POLICY_MODE"))

	autoSubmit := parseEnvBool("AUTO_SUBMIT_PROPOSALS", true)
	autoSend := parseEnvBool("AUTO_SEND_MESSAGES", true)
	maxProp := parseEnvNonNegInt("MAX_PROPOSALS_PER_DAY", DefaultMaxProposalsPerDay)
	maxConn := parseEnvNonNegInt("MAX_CONNECTS_PER_DAY", DefaultMaxConnectsPerDay)
	maxMsg := parseEnvNonNegInt("MAX_MESSAGES_PER_DAY", DefaultMaxMessagesPerDay)
	minScore := parseEnvNonNegInt("MIN_JOB_SCORE", 0)
	if minScore > 100 {
		minScore = 100
	}

	var allowedRooms []string
	if rawRooms := strings.TrimSpace(os.Getenv("ALLOWED_ROOM_IDS")); rawRooms != "" {
		for _, part := range strings.Split(rawRooms, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				allowedRooms = append(allowedRooms, trimmed)
			}
		}
	}
	if allowedRooms == nil {
		allowedRooms = []string{}
	}

	var quietHours *string
	if rawQH := strings.TrimSpace(os.Getenv("QUIET_HOURS")); rawQH != "" {
		if _, _, err := ParseQuietHours(rawQH); err == nil {
			quietHours = &rawQH
		}
	}

	return Config{
		Mode:                mode,
		AutoSubmitProposals: autoSubmit,
		AutoSendMessages:    autoSend,
		MaxProposalsPerDay:  maxProp,
		MaxConnectsPerDay:   maxConn,
		MaxMessagesPerDay:   maxMsg,
		MinJobScore:         minScore,
		AllowedRoomIDs:      allowedRooms,
		QuietHours:          quietHours,
		KillSwitchActive:    mode == ModeDraftOnly && parseEnvBool("KILL_SWITCH_ACTIVE", false),
	}
}

func parseEnvBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func parseEnvNonNegInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < 0 {
		return fallback
	}
	return v
}

// ParseQuietHours parses "HH:MM-HH:MM" into start and end minutes since midnight [0, 1439].
func ParseQuietHours(spec string) (int, int, error) {
	trimmed := strings.TrimSpace(spec)
	if trimmed == "" {
		return 0, 0, errors.New("empty quiet_hours")
	}
	parts := strings.Split(trimmed, "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("invalid quiet_hours %q; expected HH:MM-HH:MM", spec)
	}
	startMin, err := parseClockMinutes(strings.TrimSpace(parts[0]))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid quiet_hours start %q: %w", spec, err)
	}
	endMin, err := parseClockMinutes(strings.TrimSpace(parts[1]))
	if err != nil {
		return 0, 0, fmt.Errorf("invalid quiet_hours end %q: %w", spec, err)
	}
	return startMin, endMin, nil
}

func parseClockMinutes(hhmm string) (int, error) {
	parts := strings.Split(hhmm, ":")
	if len(parts) != 2 {
		return 0, fmt.Errorf("invalid time %q", hhmm)
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < 0 || h > 23 {
		return 0, fmt.Errorf("invalid hour %q", hhmm)
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil || m < 0 || m > 59 {
		return 0, fmt.Errorf("invalid minute %q", hhmm)
	}
	return h*60 + m, nil
}

// IsInQuietHours checks whether t (converted to localLoc) falls within the HH:MM-HH:MM window.
func IsInQuietHours(spec string, t time.Time, loc *time.Location) bool {
	if strings.TrimSpace(spec) == "" {
		return false
	}
	startMin, endMin, err := ParseQuietHours(spec)
	if err != nil {
		return false
	}
	if loc == nil {
		loc = time.Local
	}
	local := t.In(loc)
	curMin := local.Hour()*60 + local.Minute()
	if startMin == 0 && endMin == 23*60+59 {
		return true
	}
	if startMin <= endMin {
		return curMin >= startMin && curMin < endMin
	}
	// Wraparound overnight window (e.g. 22:00-07:00)
	return curMin >= startMin || curMin < endMin
}

func modelFromConfig(cfg Config) dbservice.PolicyConfig {
	rooms := cfg.AllowedRoomIDs
	if rooms == nil {
		rooms = []string{}
	}
	encodedRooms, _ := json.Marshal(rooms)
	qh := ""
	if cfg.QuietHours != nil {
		qh = strings.TrimSpace(*cfg.QuietHours)
	}
	return dbservice.PolicyConfig{
		ConfigKey:           DefaultConfigKey,
		Mode:                NormalizeMode(cfg.Mode),
		AutoSubmitProposals: cfg.AutoSubmitProposals,
		AutoSendMessages:    cfg.AutoSendMessages,
		MaxProposalsPerDay:  cfg.MaxProposalsPerDay,
		MaxConnectsPerDay:   cfg.MaxConnectsPerDay,
		MaxMessagesPerDay:   cfg.MaxMessagesPerDay,
		MinJobScore:         cfg.MinJobScore,
		AllowedRoomIDsJSON:  dbservice.JSONB(encodedRooms),
		QuietHours:          qh,
		KillSwitchActive:    cfg.KillSwitchActive,
	}
}

func configFromModel(m dbservice.PolicyConfig) Config {
	rooms := []string{}
	if len(m.AllowedRoomIDsJSON) > 0 {
		_ = json.Unmarshal(m.AllowedRoomIDsJSON, &rooms)
		if rooms == nil {
			rooms = []string{}
		}
	}
	var qh *string
	if trimmed := strings.TrimSpace(m.QuietHours); trimmed != "" {
		qh = &trimmed
	}
	return Config{
		Mode:                NormalizeMode(m.Mode),
		AutoSubmitProposals: m.AutoSubmitProposals,
		AutoSendMessages:    m.AutoSendMessages,
		MaxProposalsPerDay:  m.MaxProposalsPerDay,
		MaxConnectsPerDay:   m.MaxConnectsPerDay,
		MaxMessagesPerDay:   m.MaxMessagesPerDay,
		MinJobScore:         m.MinJobScore,
		AllowedRoomIDs:      rooms,
		QuietHours:          qh,
		KillSwitchActive:    m.KillSwitchActive,
	}
}

// EnsurePolicyRowLocked loads (or creates from env defaults) and locks the singleton policy_configs row.
func (e *Engine) EnsurePolicyRowLocked(tx *gorm.DB) (dbservice.PolicyConfig, error) {
	if tx == nil {
		return dbservice.PolicyConfig{}, errors.New("database transaction required")
	}
	var row dbservice.PolicyConfig
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("config_key = ?", DefaultConfigKey).
		First(&row).Error
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return dbservice.PolicyConfig{}, err
	}

	seed := modelFromConfig(DefaultConfigFromEnv())
	if createErr := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "config_key"}},
		DoNothing: true,
	}).Create(&seed).Error; createErr != nil {
		return dbservice.PolicyConfig{}, createErr
	}

	if reErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("config_key = ?", DefaultConfigKey).
		First(&row).Error; reErr != nil {
		return dbservice.PolicyConfig{}, reErr
	}
	return row, nil
}

// EnsurePolicyRow loads or auto-initializes the singleton policy_configs row without taking a row lock.
func (e *Engine) EnsurePolicyRow(db *gorm.DB) (dbservice.PolicyConfig, error) {
	if db == nil {
		return modelFromConfig(DefaultConfigFromEnv()), nil
	}
	var row dbservice.PolicyConfig
	err := db.Where("config_key = ?", DefaultConfigKey).First(&row).Error
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return dbservice.PolicyConfig{}, err
	}
	seed := modelFromConfig(DefaultConfigFromEnv())
	if createErr := db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "config_key"}},
		DoNothing: true,
	}).Create(&seed).Error; createErr != nil {
		return dbservice.PolicyConfig{}, createErr
	}
	if reErr := db.Where("config_key = ?", DefaultConfigKey).First(&row).Error; reErr != nil {
		return dbservice.PolicyConfig{}, reErr
	}
	return row, nil
}

// ComputeUsage queries Postgres for today's UTC usage counters and pending approval counts.
func (e *Engine) ComputeUsage(db *gorm.DB) (UsageSnapshot, error) {
	if db == nil {
		return UsageSnapshot{}, nil
	}
	now := e.now().UTC()
	startOfDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)

	var usage UsageSnapshot
	var propStats struct {
		ProposalsToday int64
		ConnectsToday  int64
	}
	if err := db.Table("proposals p").
		Select("COUNT(*) AS proposals_today, COALESCE(SUM(COALESCE(p.connects_required, j.connects_required, 0) + COALESCE(p.boost_connects, 0)), 0) AS connects_today").
		Joins("LEFT JOIN jobs j ON j.id = p.job_id").
		Where("p.submitted_at >= ? OR p.status = ?", startOfDay, "submitting").
		Scan(&propStats).Error; err != nil {
		return UsageSnapshot{}, err
	}
	usage.ProposalsToday = int(propStats.ProposalsToday)
	usage.ConnectsToday = int(propStats.ConnectsToday)

	var msgsToday int64
	if err := db.Model(&dbservice.Message{}).
		Where("sender_role <> ? AND ((is_draft = ? AND status = ? AND sent_at >= ?) OR status = ?)",
			"client", false, "sent", startOfDay, "sending").
		Count(&msgsToday).Error; err != nil {
		return UsageSnapshot{}, err
	}
	usage.MessagesToday = int(msgsToday)

	var pendingProps, pendingMsgs int64
	if err := db.Model(&dbservice.Proposal{}).Where("status = ?", "pending_approval").Count(&pendingProps).Error; err != nil {
		return UsageSnapshot{}, err
	}
	if err := db.Model(&dbservice.Message{}).Where("status = ?", "pending_approval").Count(&pendingMsgs).Error; err != nil {
		return UsageSnapshot{}, err
	}
	usage.PendingApprovals = int(pendingProps + pendingMsgs)

	return usage, nil
}

// GetSnapshot returns the current policy config and live UTC-day usage from Postgres.
func (e *Engine) GetSnapshot(_ context.Context) (Snapshot, error) {
	if e == nil || e.db == nil {
		cfg := DefaultConfigFromEnv()
		return Snapshot{
			Config:    cfg,
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		}, nil
	}

	row, err := e.EnsurePolicyRow(e.db)
	if err != nil {
		return Snapshot{}, err
	}
	usage, err := e.ComputeUsage(e.db)
	if err != nil {
		return Snapshot{}, err
	}
	updatedAt := row.UpdatedAt
	if updatedAt.IsZero() {
		updatedAt = e.now().UTC()
	}
	return Snapshot{
		Config:        configFromModel(row),
		UsageSnapshot: usage,
		UpdatedAt:     updatedAt.UTC().Format(time.RFC3339),
	}, nil
}

// Update validates and applies partial policy updates atomically in Postgres and records an audit log.
func (e *Engine) Update(_ context.Context, input UpdateInput, actor string) (Snapshot, error) {
	if e == nil || e.db == nil {
		return Snapshot{}, errors.New("database unavailable")
	}
	if actor == "" {
		actor = "api"
	}

	var updatedRow dbservice.PolicyConfig
	txErr := e.db.Transaction(func(tx *gorm.DB) error {
		row, err := e.EnsurePolicyRowLocked(tx)
		if err != nil {
			return err
		}

		if input.Mode != nil {
			mode := strings.TrimSpace(*input.Mode)
			if !IsValidMode(mode) {
				return &PolicyError{
					Code:       "INVALID_POLICY_MODE",
					HTTPStatus: http.StatusBadRequest,
					Message:    fmt.Sprintf("invalid policy mode %q; expected confirm_in_ui, draft_only, or auto_with_guardrails", mode),
				}
			}
			row.Mode = mode
			if mode != ModeDraftOnly {
				row.KillSwitchActive = false
			}
		}
		if input.AutoSubmitProposals != nil {
			row.AutoSubmitProposals = *input.AutoSubmitProposals
		}
		if input.AutoSendMessages != nil {
			row.AutoSendMessages = *input.AutoSendMessages
		}
		if input.MaxProposalsPerDay != nil {
			if *input.MaxProposalsPerDay < 0 {
				return &PolicyError{
					Code:       "INVALID_POLICY_CAP",
					HTTPStatus: http.StatusBadRequest,
					Message:    "max_proposals_per_day must be >= 0",
				}
			}
			row.MaxProposalsPerDay = *input.MaxProposalsPerDay
		}
		if input.MaxConnectsPerDay != nil {
			if *input.MaxConnectsPerDay < 0 {
				return &PolicyError{
					Code:       "INVALID_POLICY_CAP",
					HTTPStatus: http.StatusBadRequest,
					Message:    "max_connects_per_day must be >= 0",
				}
			}
			row.MaxConnectsPerDay = *input.MaxConnectsPerDay
		}
		if input.MaxMessagesPerDay != nil {
			if *input.MaxMessagesPerDay < 0 {
				return &PolicyError{
					Code:       "INVALID_POLICY_CAP",
					HTTPStatus: http.StatusBadRequest,
					Message:    "max_messages_per_day must be >= 0",
				}
			}
			row.MaxMessagesPerDay = *input.MaxMessagesPerDay
		}
		if input.MinJobScore != nil {
			if *input.MinJobScore < 0 || *input.MinJobScore > 100 {
				return &PolicyError{
					Code:       "INVALID_POLICY_SCORE",
					HTTPStatus: http.StatusBadRequest,
					Message:    "min_job_score must be between 0 and 100",
				}
			}
			row.MinJobScore = *input.MinJobScore
		}
		if input.AllowedRoomIDs != nil {
			cleaned := make([]string, 0, len(*input.AllowedRoomIDs))
			seen := make(map[string]struct{}, len(*input.AllowedRoomIDs))
			for _, id := range *input.AllowedRoomIDs {
				trimmed := strings.TrimSpace(id)
				if trimmed == "" {
					continue
				}
				if _, ok := seen[trimmed]; !ok {
					seen[trimmed] = struct{}{}
					cleaned = append(cleaned, trimmed)
				}
			}
			encoded, _ := json.Marshal(cleaned)
			row.AllowedRoomIDsJSON = dbservice.JSONB(encoded)
		}
		if input.QuietHours.Set {
			if input.QuietHours.Value == nil || strings.TrimSpace(*input.QuietHours.Value) == "" {
				row.QuietHours = ""
			} else {
				qh := strings.TrimSpace(*input.QuietHours.Value)
				if _, _, qErr := ParseQuietHours(qh); qErr != nil {
					return &PolicyError{
						Code:       "INVALID_QUIET_HOURS",
						HTTPStatus: http.StatusBadRequest,
						Message:    qErr.Error(),
					}
				}
				row.QuietHours = qh
			}
		}

		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		updatedRow = row

		cfg := configFromModel(row)
		return RecordAuditTx(tx, AuditEntry{
			ActionType: "policy_updated",
			Actor:      actor,
			TargetID:   DefaultConfigKey,
			PolicyMode: cfg.Mode,
			Outcome:    "allowed",
			Details: map[string]any{
				"mode":                  cfg.Mode,
				"auto_submit_proposals": cfg.AutoSubmitProposals,
				"auto_send_messages":    cfg.AutoSendMessages,
				"max_proposals_per_day": cfg.MaxProposalsPerDay,
				"max_connects_per_day":  cfg.MaxConnectsPerDay,
				"max_messages_per_day":  cfg.MaxMessagesPerDay,
				"min_job_score":         cfg.MinJobScore,
				"allowed_room_ids":      cfg.AllowedRoomIDs,
				"quiet_hours":           cfg.QuietHours,
			},
		})
	})
	if txErr != nil {
		return Snapshot{}, txErr
	}

	usage, err := e.ComputeUsage(e.db)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		Config:        configFromModel(updatedRow),
		UsageSnapshot: usage,
		UpdatedAt:     updatedRow.UpdatedAt.UTC().Format(time.RFC3339),
	}, nil
}

// ActivateKillSwitch atomically forces policy mode to draft_only, sets kill_switch_active=true, and logs the event.
func (e *Engine) ActivateKillSwitch(_ context.Context, reason, actor string) (Snapshot, error) {
	if e == nil || e.db == nil {
		return Snapshot{}, errors.New("database unavailable")
	}
	if actor == "" {
		actor = "user"
	}
	if strings.TrimSpace(reason) == "" {
		reason = "Kill switch activated"
	}

	var updatedRow dbservice.PolicyConfig
	txErr := e.db.Transaction(func(tx *gorm.DB) error {
		row, err := e.EnsurePolicyRowLocked(tx)
		if err != nil {
			return err
		}
		row.Mode = ModeDraftOnly
		row.KillSwitchActive = true
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		updatedRow = row

		return RecordAuditTx(tx, AuditEntry{
			ActionType: "kill_switch_activated",
			Actor:      actor,
			TargetID:   DefaultConfigKey,
			PolicyMode: ModeDraftOnly,
			Outcome:    "allowed",
			Details: map[string]any{
				"reason":             reason,
				"kill_switch_active": true,
			},
		})
	})
	if txErr != nil {
		return Snapshot{}, txErr
	}

	usage, err := e.ComputeUsage(e.db)
	if err != nil {
		return Snapshot{}, err
	}
	return Snapshot{
		Config:        configFromModel(updatedRow),
		UsageSnapshot: usage,
		UpdatedAt:     updatedRow.UpdatedAt.UTC().Format(time.RFC3339),
	}, nil
}

// GenerateApprovalToken generates a 32-byte cryptographically random hex approval token and expiry timestamp.
func (e *Engine) GenerateApprovalToken() (string, time.Time, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", time.Time{}, fmt.Errorf("generate approval token: %w", err)
	}
	ttl := DefaultApprovalTokenTTL
	now := time.Now().UTC()
	if e != nil {
		if e.tokenTTL > 0 {
			ttl = e.tokenTTL
		}
		if e.now != nil {
			now = e.now().UTC()
		}
	}
	return hex.EncodeToString(buf), now.Add(ttl), nil
}

// TokensEqual compares two approval tokens in constant time via SHA-256 digests.
func TokensEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ha := sha256.Sum256([]byte(a))
	hb := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

// IsTokenExpired checks both explicit approval_token_expires_at and approved_at/updated_at TTL aging.
func (e *Engine) IsTokenExpired(expiresAt *time.Time, approvedAt *time.Time, updatedAt time.Time) bool {
	now := time.Now().UTC()
	ttl := DefaultApprovalTokenTTL
	if e != nil {
		if e.now != nil {
			now = e.now().UTC()
		}
		if e.tokenTTL > 0 {
			ttl = e.tokenTTL
		}
	}
	if expiresAt != nil && !expiresAt.IsZero() && now.After(*expiresAt) {
		return true
	}
	if approvedAt != nil && !approvedAt.IsZero() && now.Sub(*approvedAt) > ttl {
		return true
	}
	if !updatedAt.IsZero() && now.Sub(updatedAt) > ttl {
		return true
	}
	return false
}

// ProposalAuthRequest carries parameters for evaluating a proposal submission against policy & token/guardrails.
type ProposalAuthRequest struct {
	PolicyRow      dbservice.PolicyConfig
	Usage          UsageSnapshot
	Proposal       dbservice.Proposal
	JobScore       *int
	ConnectsCost   int
	ProvidedToken  string
	HumanApproved  bool
	RequiresToken  bool
}

// EvaluateProposalSubmit checks draft_only, approval_token / confirm_in_ui, guardrails, and daily caps.
func (e *Engine) EvaluateProposalSubmit(req ProposalAuthRequest) *PolicyError {
	cfg := configFromModel(req.PolicyRow)

	// 1. draft_only ALWAYS blocks submission, even with valid approval token or UI click.
	if cfg.Mode == ModeDraftOnly {
		return &PolicyError{
			Code:       ErrCodePolicyBlocked,
			HTTPStatus: http.StatusForbidden,
			Message:    "POLICY_DRAFT_ONLY: proposal submission is blocked while policy mode is draft_only",
			Details:    map[string]any{"mode": cfg.Mode},
		}
	}

	// 2. Authorization check (UI approval click, confirm_in_ui token, or auto_with_guardrails)
	hasExplicitToken := strings.TrimSpace(req.ProvidedToken) != ""
	if req.HumanApproved {
		if req.Proposal.Status != "pending_approval" {
			return &PolicyError{
				Code:       ErrCodeApprovalRequired,
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("APPROVAL_REQUIRED: proposal status is %q, expected pending_approval", req.Proposal.Status),
			}
		}
		trimmedSnap := bytes.TrimSpace(req.Proposal.VerificationSnapshotJSON)
		if strings.TrimSpace(req.Proposal.ApprovalToken) == "" || len(trimmedSnap) == 0 || bytes.Equal(trimmedSnap, []byte("null")) {
			return &PolicyError{
				Code:       "PROPOSAL_REFILL_REQUIRED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("PROPOSAL_REFILL_REQUIRED: proposal #%d must be filled via FillProposal before approving", req.Proposal.ID),
			}
		}
		if e.IsTokenExpired(req.Proposal.ApprovalTokenExpiresAt, req.Proposal.ApprovedAt, req.Proposal.UpdatedAt) {
			return &PolicyError{
				Code:       ErrCodeApprovalRequired,
				HTTPStatus: http.StatusForbidden,
				Message:    "APPROVAL_REQUIRED: approval token expired; re-fill proposal",
			}
		}
	} else {
		switch cfg.Mode {
		case ModeConfirmInUI:
			if !hasExplicitToken {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: confirm_in_ui policy requires approval_token or Side Panel approval",
					Details:    map[string]any{"mode": cfg.Mode},
				}
			}
			if req.Proposal.Status != "pending_approval" || !TokensEqual(req.Proposal.ApprovalToken, strings.TrimSpace(req.ProvidedToken)) {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: approval token is invalid or already consumed",
				}
			}
			if e.IsTokenExpired(req.Proposal.ApprovalTokenExpiresAt, req.Proposal.ApprovedAt, req.Proposal.UpdatedAt) {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: approval token expired",
				}
			}
		case ModeAutoWithGuardrails:
			// An approval_token returned by FillProposal must NEVER bypass autonomous guardrails
			// when HumanApproved == false; validate any supplied token AND enforce all guardrails.
			if hasExplicitToken {
				if req.Proposal.Status != "pending_approval" || !TokensEqual(req.Proposal.ApprovalToken, strings.TrimSpace(req.ProvidedToken)) {
					return &PolicyError{
						Code:       ErrCodeApprovalRequired,
						HTTPStatus: http.StatusForbidden,
						Message:    "APPROVAL_REQUIRED: approval token is invalid or already consumed",
					}
				}
				if e.IsTokenExpired(req.Proposal.ApprovalTokenExpiresAt, req.Proposal.ApprovedAt, req.Proposal.UpdatedAt) {
					return &PolicyError{
						Code:       ErrCodeApprovalRequired,
						HTTPStatus: http.StatusForbidden,
						Message:    "APPROVAL_REQUIRED: approval token expired",
					}
				}
			}
			if req.Proposal.Status == "pending_approval" && strings.TrimSpace(req.Proposal.ApprovalToken) == "" {
				return &PolicyError{
					Code:       "PROPOSAL_REFILL_REQUIRED",
					HTTPStatus: http.StatusConflict,
					Message:    fmt.Sprintf("PROPOSAL_REFILL_REQUIRED: proposal #%d must be filled via FillProposal before submitting", req.Proposal.ID),
				}
			}
			if req.Proposal.Status != "draft" && req.Proposal.Status != "pending_approval" && req.Proposal.Status != "approved" {
				return &PolicyError{
					Code:       "PROPOSAL_NOT_SUBMITTABLE",
					HTTPStatus: http.StatusConflict,
					Message:    fmt.Sprintf("PROPOSAL_NOT_SUBMITTABLE: proposal status %q cannot be submitted under auto_with_guardrails", req.Proposal.Status),
					Details:    map[string]any{"status": req.Proposal.Status},
				}
			}
			if !cfg.AutoSubmitProposals {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: auto_submit_proposals is disabled under auto_with_guardrails",
				}
			}
			if cfg.QuietHours != nil && IsInQuietHours(*cfg.QuietHours, e.now(), e.localLoc) {
				return &PolicyError{
					Code:       ErrCodePolicyBlocked,
					HTTPStatus: http.StatusForbidden,
					Message:    fmt.Sprintf("POLICY_BLOCKED: blocked by quiet_hours (%s)", *cfg.QuietHours),
					Details:    map[string]any{"quiet_hours": *cfg.QuietHours},
				}
			}
			if cfg.MinJobScore > 0 {
				scoreVal := 0
				if req.JobScore != nil {
					scoreVal = *req.JobScore
				}
				if scoreVal < cfg.MinJobScore {
					return &PolicyError{
						Code:       ErrCodePolicyBlocked,
						HTTPStatus: http.StatusForbidden,
						Message:    fmt.Sprintf("POLICY_BLOCKED: job score %d is below min_job_score %d", scoreVal, cfg.MinJobScore),
						Details:    map[string]any{"job_score": scoreVal, "min_job_score": cfg.MinJobScore},
					}
				}
			}
		default:
			return &PolicyError{
				Code:       ErrCodeApprovalRequired,
				HTTPStatus: http.StatusForbidden,
				Message:    fmt.Sprintf("APPROVAL_REQUIRED: unsupported policy mode %q", cfg.Mode),
				Details:    map[string]any{"mode": cfg.Mode},
			}
		}
	}

	// 3. Hard daily budget caps (enforced in both confirm_in_ui and auto_with_guardrails)
	if req.Usage.ProposalsToday+1 > cfg.MaxProposalsPerDay {
		return &PolicyError{
			Code:       ErrCodeDailyCapExceeded,
			HTTPStatus: http.StatusTooManyRequests,
			Message:    fmt.Sprintf("DAILY_CAP_EXCEEDED: max_proposals_per_day cap reached (%d/%d)", req.Usage.ProposalsToday, cfg.MaxProposalsPerDay),
			Details: map[string]any{
				"proposals_today":       req.Usage.ProposalsToday,
				"max_proposals_per_day": cfg.MaxProposalsPerDay,
			},
		}
	}
	if req.Usage.ConnectsToday+req.ConnectsCost > cfg.MaxConnectsPerDay {
		return &PolicyError{
			Code:       ErrCodeDailyCapExceeded,
			HTTPStatus: http.StatusTooManyRequests,
			Message:    fmt.Sprintf("DAILY_CAP_EXCEEDED: max_connects_per_day cap exceeded (%d + %d > %d)", req.Usage.ConnectsToday, req.ConnectsCost, cfg.MaxConnectsPerDay),
			Details: map[string]any{
				"connects_today":       req.Usage.ConnectsToday,
				"connects_cost":        req.ConnectsCost,
				"max_connects_per_day": cfg.MaxConnectsPerDay,
			},
		}
	}

	return nil
}

// MessageAuthRequest carries parameters for evaluating an outbound message send against policy & token/guardrails.
type MessageAuthRequest struct {
	PolicyRow     dbservice.PolicyConfig
	Usage         UsageSnapshot
	RoomID        string
	DraftMessage  *dbservice.Message
	ProvidedToken string
	HumanApproved bool
}

// EvaluateMessageSend checks draft_only, approval_token / confirm_in_ui, room allowlist, quiet hours, and daily cap.
func (e *Engine) EvaluateMessageSend(req MessageAuthRequest) *PolicyError {
	cfg := configFromModel(req.PolicyRow)

	// 1. draft_only ALWAYS blocks sending.
	if cfg.Mode == ModeDraftOnly {
		return &PolicyError{
			Code:       ErrCodePolicyBlocked,
			HTTPStatus: http.StatusForbidden,
			Message:    "POLICY_DRAFT_ONLY: message sending is blocked while policy mode is draft_only",
			Details:    map[string]any{"mode": cfg.Mode},
		}
	}

	hasExplicitToken := strings.TrimSpace(req.ProvidedToken) != ""
	if req.HumanApproved {
		if req.DraftMessage == nil || req.DraftMessage.Status != "pending_approval" {
			status := ""
			if req.DraftMessage != nil {
				status = req.DraftMessage.Status
			}
			return &PolicyError{
				Code:       ErrCodeApprovalRequired,
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("APPROVAL_REQUIRED: message status is %q, expected pending_approval", status),
			}
		}
		if req.DraftMessage.ApprovalToken != "" && e.IsTokenExpired(req.DraftMessage.ApprovalTokenExpiresAt, req.DraftMessage.ApprovedAt, req.DraftMessage.UpdatedAt) {
			return &PolicyError{
				Code:       ErrCodeApprovalRequired,
				HTTPStatus: http.StatusForbidden,
				Message:    "APPROVAL_REQUIRED: approval token expired",
			}
		}
	} else {
		switch cfg.Mode {
		case ModeConfirmInUI:
			if !hasExplicitToken {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: confirm_in_ui policy requires approval_token or Side Panel approval",
					Details:    map[string]any{"mode": cfg.Mode},
				}
			}
			if req.DraftMessage == nil || req.DraftMessage.Status != "pending_approval" || !TokensEqual(req.DraftMessage.ApprovalToken, strings.TrimSpace(req.ProvidedToken)) {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: approval token is invalid or already consumed",
				}
			}
			if e.IsTokenExpired(req.DraftMessage.ApprovalTokenExpiresAt, req.DraftMessage.ApprovedAt, req.DraftMessage.UpdatedAt) {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: approval token expired",
				}
			}
		case ModeAutoWithGuardrails:
			// An approval_token returned by DraftMessage must NEVER bypass autonomous guardrails
			// when HumanApproved == false; validate any supplied token AND enforce all guardrails.
			if hasExplicitToken {
				if req.DraftMessage == nil || req.DraftMessage.Status != "pending_approval" || !TokensEqual(req.DraftMessage.ApprovalToken, strings.TrimSpace(req.ProvidedToken)) {
					return &PolicyError{
						Code:       ErrCodeApprovalRequired,
						HTTPStatus: http.StatusForbidden,
						Message:    "APPROVAL_REQUIRED: approval token is invalid or already consumed",
					}
				}
				if e.IsTokenExpired(req.DraftMessage.ApprovalTokenExpiresAt, req.DraftMessage.ApprovedAt, req.DraftMessage.UpdatedAt) {
					return &PolicyError{
						Code:       ErrCodeApprovalRequired,
						HTTPStatus: http.StatusForbidden,
						Message:    "APPROVAL_REQUIRED: approval token expired",
					}
				}
			}
			if req.DraftMessage != nil {
				if req.DraftMessage.SenderRole == "client" || req.DraftMessage.Status == "received" {
					return &PolicyError{
						Code:       "INVALID_MESSAGE_TARGET",
						HTTPStatus: http.StatusConflict,
						Message:    fmt.Sprintf("INVALID_MESSAGE_TARGET: cannot send inbound client message #%d", req.DraftMessage.ID),
					}
				}
				if req.DraftMessage.Status == "rejected" {
					return &PolicyError{
						Code:       "MESSAGE_REDRAFT_REQUIRED",
						HTTPStatus: http.StatusConflict,
						Message:    fmt.Sprintf("MESSAGE_REDRAFT_REQUIRED: message #%d was rejected; create a new draft before sending", req.DraftMessage.ID),
					}
				}
			}
			if !cfg.AutoSendMessages {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: auto_send_messages is disabled under auto_with_guardrails",
				}
			}
			if cfg.QuietHours != nil && IsInQuietHours(*cfg.QuietHours, e.now(), e.localLoc) {
				return &PolicyError{
					Code:       ErrCodePolicyBlocked,
					HTTPStatus: http.StatusForbidden,
					Message:    fmt.Sprintf("POLICY_BLOCKED: blocked by quiet_hours (%s)", *cfg.QuietHours),
					Details:    map[string]any{"quiet_hours": *cfg.QuietHours},
				}
			}
			if len(cfg.AllowedRoomIDs) > 0 && !containsString(cfg.AllowedRoomIDs, req.RoomID) {
				return &PolicyError{
					Code:       ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    fmt.Sprintf("APPROVAL_REQUIRED: room %q is not in allowed_room_ids", req.RoomID),
					Details:    map[string]any{"room_id": req.RoomID, "allowed_room_ids": cfg.AllowedRoomIDs},
				}
			}
		default:
			return &PolicyError{
				Code:       ErrCodeApprovalRequired,
				HTTPStatus: http.StatusForbidden,
				Message:    fmt.Sprintf("APPROVAL_REQUIRED: unsupported policy mode %q", cfg.Mode),
				Details:    map[string]any{"mode": cfg.Mode},
			}
		}
	}

	// 3. Hard daily message cap
	if req.Usage.MessagesToday+1 > cfg.MaxMessagesPerDay {
		return &PolicyError{
			Code:       ErrCodeDailyCapExceeded,
			HTTPStatus: http.StatusTooManyRequests,
			Message:    fmt.Sprintf("DAILY_CAP_EXCEEDED: max_messages_per_day cap reached (%d/%d)", req.Usage.MessagesToday, cfg.MaxMessagesPerDay),
			Details: map[string]any{
				"messages_today":       req.Usage.MessagesToday,
				"max_messages_per_day": cfg.MaxMessagesPerDay,
			},
		}
	}

	return nil
}

func containsString(slice []string, target string) bool {
	trimmed := strings.TrimSpace(target)
	for _, s := range slice {
		if strings.TrimSpace(s) == trimmed {
			return true
		}
	}
	return false
}

// RecordAudit inserts an immutable row into action_audit_logs (best-effort if db is nil).
func (e *Engine) RecordAudit(entry AuditEntry) error {
	if e == nil || e.db == nil {
		return nil
	}
	if entry.PolicyMode == "" {
		if row, err := e.EnsurePolicyRow(e.db); err == nil {
			entry.PolicyMode = row.Mode
		} else {
			entry.PolicyMode = ModeConfirmInUI
		}
	}
	return RecordAuditTx(e.db, entry)
}

// RecordAuditTx inserts an immutable row into action_audit_logs inside the given DB/transaction.
func RecordAuditTx(db *gorm.DB, entry AuditEntry) error {
	if db == nil {
		return nil
	}
	actor := strings.TrimSpace(entry.Actor)
	if actor == "" {
		actor = "system"
	}
	var detailsJSON dbservice.JSONB
	if len(entry.Details) > 0 {
		if encoded, err := json.Marshal(entry.Details); err == nil {
			detailsJSON = dbservice.JSONB(encoded)
		}
	}
	row := dbservice.ActionAuditLog{
		ActionType:  strings.TrimSpace(entry.ActionType),
		Actor:       actor,
		TargetID:    strings.TrimSpace(entry.TargetID),
		PolicyMode:  strings.TrimSpace(entry.PolicyMode),
		Outcome:     strings.TrimSpace(entry.Outcome),
		DetailsJSON: detailsJSON,
	}
	return db.Create(&row).Error
}
