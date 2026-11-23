package service

import (
	"bytes"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// JSONB stores raw JSON in PostgreSQL jsonb columns.
// Empty/nil values serialize as SQL NULL so nullable jsonb columns never fail with SQLSTATE 22P02.
type JSONB json.RawMessage

func (j JSONB) Value() (driver.Value, error) {
	trimmed := bytes.TrimSpace(j)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	if !json.Valid(trimmed) {
		return nil, fmt.Errorf("invalid jsonb value")
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, trimmed); err != nil {
		return nil, err
	}
	return buf.String(), nil
}

func (j *JSONB) Scan(value any) error {
	if value == nil {
		*j = nil
		return nil
	}
	switch v := value.(type) {
	case []byte:
		*j = append((*j)[0:0], v...)
		return nil
	case string:
		*j = JSONB(v)
		return nil
	default:
		return fmt.Errorf("unsupported jsonb scan type %T", value)
	}
}

func (j JSONB) MarshalJSON() ([]byte, error) {
	trimmed := bytes.TrimSpace(j)
	if len(trimmed) == 0 {
		return []byte("null"), nil
	}
	return trimmed, nil
}

func (j *JSONB) UnmarshalJSON(data []byte) error {
	if j == nil {
		return errors.New("JSONB: UnmarshalJSON on nil pointer")
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*j = nil
		return nil
	}
	*j = append((*j)[0:0], trimmed...)
	return nil
}

func (JSONB) GormDataType() string { return "jsonb" }

func (JSONB) GormDBDataType(db *gorm.DB, _ *schema.Field) string {
	if db.Name() == "postgres" {
		return "jsonb"
	}
	return "text"
}

// AllModels returns every GORM model in migration dependency order for Atlas & tests.
func AllModels() []any {
	return []any{
		&User{},
		&SearchProfile{},
		&SearchRun{},
		&Job{},
		&SearchRunJob{},
		&Profile{},
		&PortfolioItem{},
		&Proposal{},
		&MessageThread{},
		&Message{},
		&GeneratedAgent{},
		&SelectorAudit{},
		&UIDiagnosticCapture{},
		&ActionAuditLog{},
		&PolicyConfig{},
		&ActiveProject{},
		&EnrichmentBatch{},
		&EnrichmentBatchItem{},
		&WatchRule{},
		&WatchRun{},
		&WatchEvent{},
		&NotificationConfig{},
	}
}

// User represents a user in the system.
type User struct {
	ID        uint      `gorm:"primaryKey;autoIncrement"`
	Email     string    `gorm:"type:text;not null;uniqueIndex"`
	Name      string    `gorm:"type:text;not null"`
	CreatedAt time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt time.Time `gorm:"type:timestamp(3);not null"`
}

// Job represents a job posting or opportunity.
type Job struct {
	ID uint `gorm:"primaryKey;autoIncrement"`

	// Identity & Discovery
	UpworkJobID  *string `gorm:"type:text;uniqueIndex:idx_jobs_upwork_job_id,where:upwork_job_id IS NOT NULL AND upwork_job_id <> ''"`
	Title        string  `gorm:"type:text;not null"`
	Description  string  `gorm:"type:text"`
	URL          string  `gorm:"type:text"`
	CanonicalURL string  `gorm:"type:text;index:idx_jobs_canonical_url"`
	Source       string  `gorm:"type:text"` // e.g., "upwork", "upwork-scraper-fs", "extension"
	SourceFeed   string  `gorm:"type:text"` // "search" | "best_matches" | "most_recent" | "saved_jobs"
	SourceQuery  string  `gorm:"type:text"`

	// Compensation, Scope & Timing
	ContractType    string     `gorm:"type:text"` // "hourly" | "fixed" | ""
	Budget          string     `gorm:"type:text"`
	RateRange       string     `gorm:"type:text"`
	RateMin         string     `gorm:"type:text"`
	RateMax         string     `gorm:"type:text"`
	BudgetAmount    string     `gorm:"type:text"`
	ExperienceLevel string     `gorm:"type:text"`
	Duration        string     `gorm:"type:text"`
	HoursPerWeek    string     `gorm:"type:text"`
	Skills          string     `gorm:"type:text"`
	PostedText      string     `gorm:"type:text"`
	PostedAtEst     *time.Time `gorm:"type:timestamp(3);index:idx_jobs_posted_at_est"`

	// Competition & Authenticated Detail Metadata
	ProposalsTier      string     `gorm:"type:text"`
	ProposalsCount     *int       `gorm:"type:integer"`
	ConnectsRequired   *int       `gorm:"type:integer"`
	ScreeningQuestions JSONB      `gorm:"type:jsonb"` // []{index, prompt, required}
	Attachments        JSONB      `gorm:"type:jsonb"` // []{filename, url}
	Qualifications     JSONB      `gorm:"type:jsonb"` // []{name, value, met}
	LastEnrichedAt     *time.Time `gorm:"type:timestamp(3)"`

	// Client Signals
	ClientCountry   string   `gorm:"type:text"`
	ClientRating    *float64 `gorm:"type:double precision"`
	ClientReviews   *int     `gorm:"type:integer"`
	ClientSpent     string   `gorm:"type:text"`
	ClientSpentUSD  *float64 `gorm:"type:double precision"`
	ClientHires     *int     `gorm:"type:integer"`
	ClientHireRate  *float64 `gorm:"type:double precision"`
	PaymentVerified *bool    `gorm:"type:boolean"`
	ClientActivity  JSONB    `gorm:"type:jsonb"` // {interviewing, invites_sent, unanswered_invites, last_viewed}

	// Deterministic Scoring + Analysis + v1.0 Compatibility
	Score               *int   `gorm:"type:integer;index:idx_jobs_score"`
	ScoreBreakdown      JSONB  `gorm:"type:jsonb"`
	ScoreReasoning      string `gorm:"type:text"`
	FitLabel            string `gorm:"type:text;index:idx_jobs_fit_label"` // "hot" | "ready" | "review" | "skip"
	FitAssessment       string `gorm:"type:text"`                           // v1.0 alias
	Proposal            string `gorm:"type:text"`
	ProposalSubject     string `gorm:"type:text"`
	ProposalTone        string `gorm:"type:text"`
	ProposalJSON        JSONB  `gorm:"type:jsonb"`
	PortfolioReferences JSONB  `gorm:"type:jsonb"`
	TimeEstimate        string `gorm:"type:text"`
	WorkloadDivision    string `gorm:"type:text"`
	QuestionsForClient  string `gorm:"type:text"`
	TipsAndAdvice       string `gorm:"type:text"`
	ExecutionPrompt     string `gorm:"type:text"`
	ToneAnalysis        string `gorm:"type:text"`

	// AI Enrichment & Search Provenance
	AIEnrichmentStatus string     `gorm:"type:text;not null;default:'none';index:idx_jobs_ai_enrichment_status"` // "none" | "queued" | "scraping_details" | "analyzing" | "completed" | "failed"
	AIEnrichedAt       *time.Time `gorm:"type:timestamp(3);index:idx_jobs_ai_enriched_at"`
	AIEnrichmentError  string     `gorm:"type:text;not null;default:''"`
	AIModel            string     `gorm:"type:text;not null;default:''"`
	AIEffort           string     `gorm:"type:text;not null;default:''"`
	AITokensUsed       *int       `gorm:"type:integer"`
	LastSearchRunID    *uint      `gorm:"index:idx_jobs_last_search_run_id"`
	LastSearchRun      *SearchRun `gorm:"foreignKey:LastSearchRunID;constraint:OnDelete:SET NULL"`

	// Workflow & Ownership
	Status    string     `gorm:"type:text;index:idx_jobs_status"` // "new" | "ready" | "applied" | "rejected" | "archived"
	UserID    *uint      `gorm:"index:idx_jobs_user_id"`
	User      *User      `gorm:"foreignKey:UserID"`
	CreatedAt time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt time.Time  `gorm:"type:timestamp(3);not null"`
	AppliedAt *time.Time `gorm:"type:timestamp(3)"`
}

// Profile stores customizable freelancer metadata used during analysis and scoring.
type Profile struct {
	ID             uint            `gorm:"primaryKey;autoIncrement"`
	Description    string          `gorm:"type:text"`
	Skills         string          `gorm:"type:text"`
	PortfolioItems []PortfolioItem `gorm:"foreignKey:ProfileID"`
	CreatedAt      time.Time       `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt      time.Time       `gorm:"type:timestamp(3);not null"`
}

// PortfolioItem represents a single portfolio entry.
type PortfolioItem struct {
	ID          uint      `gorm:"primaryKey;autoIncrement"`
	ProfileID   uint      `gorm:"index"`
	Title       string    `gorm:"type:text"`
	Link        string    `gorm:"type:text"`
	Description string    `gorm:"type:text"`
	CreatedAt   time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt   time.Time `gorm:"type:timestamp(3);not null"`
}

// SearchProfile stores declarative scraping/search workflow profiles.
type SearchProfile struct {
	ID          uint       `gorm:"primaryKey;autoIncrement"`
	Name        string     `gorm:"type:text;not null;uniqueIndex:idx_search_profiles_name"`
	Description string     `gorm:"type:text;not null;default:''"`
	ConfigJSON  JSONB      `gorm:"type:jsonb;not null"`
	IsActive    bool       `gorm:"type:boolean;not null;default:true;index:idx_search_profiles_is_active"`
	LastRunAt   *time.Time `gorm:"type:timestamp(3)"`
	CreatedAt   time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt   time.Time  `gorm:"type:timestamp(3);not null"`
}

// Proposal tracks proposal drafts, confirm_in_ui approvals, and submission state.
type Proposal struct {
	ID                       uint       `gorm:"primaryKey;autoIncrement"`
	JobID                    *uint      `gorm:"index:idx_proposals_job_id"`
	Job                      *Job       `gorm:"foreignKey:JobID;constraint:OnDelete:SET NULL"`
	UpworkJobID              string     `gorm:"type:text;index:idx_proposals_upwork_job_id"`
	CoverLetter              string     `gorm:"type:text;not null;default:''"`
	BidType                  string     `gorm:"type:text;not null;default:''"` // "hourly" | "fixed" | ""
	BidAmount                *float64   `gorm:"type:double precision"`
	RateIncrease             string     `gorm:"type:text;not null;default:''"`
	ConnectsRequired         *int       `gorm:"type:integer"`
	MilestonesJSON           JSONB      `gorm:"type:jsonb"`
	ScreeningAnswersJSON     JSONB      `gorm:"type:jsonb"`
	BoostConnects            *int       `gorm:"type:integer"`
	PortfolioRefsJSON        JSONB      `gorm:"type:jsonb"`
	Status                   string     `gorm:"type:text;not null;default:'draft';index:idx_proposals_status"`
	ApprovalToken            string     `gorm:"type:text;uniqueIndex:idx_proposals_approval_token,where:approval_token IS NOT NULL AND approval_token <> ''"`
	ApprovalTokenExpiresAt   *time.Time `gorm:"type:timestamp(3)"`
	ApprovedAt               *time.Time `gorm:"type:timestamp(3)"`
	SubmittedAt              *time.Time `gorm:"type:timestamp(3);index:idx_proposals_submitted_at"`
	UpworkProposalURL        string     `gorm:"type:text;not null;default:''"`
	VerificationSnapshotJSON JSONB      `gorm:"type:jsonb"`
	CreatedAt                time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt                time.Time  `gorm:"type:timestamp(3);not null"`
}

// MessageThread tracks an Upwork client conversation room.
type MessageThread struct {
	ID                 uint       `gorm:"primaryKey;autoIncrement"`
	UpworkRoomID       string     `gorm:"type:text;not null;uniqueIndex:idx_message_threads_upwork_room_id"`
	UpworkJobID        string     `gorm:"type:text;not null;default:'';index:idx_message_threads_upwork_job_id"`
	ClientName         string     `gorm:"type:text;not null;default:''"`
	ClientCompany      string     `gorm:"type:text;not null;default:''"`
	JobTitle           string     `gorm:"type:text;not null;default:''"`
	JobID              *uint      `gorm:"index:idx_message_threads_job_id"`
	Job                *Job       `gorm:"foreignKey:JobID;constraint:OnDelete:SET NULL"`
	ProposalID         *uint      `gorm:"index:idx_message_threads_proposal_id"`
	Proposal           *Proposal  `gorm:"foreignKey:ProposalID;constraint:OnDelete:SET NULL"`
	UnreadCount        int        `gorm:"type:integer;not null;default:0"`
	LastMessageSnippet string     `gorm:"type:text;not null;default:''"`
	LastMessageAt      *time.Time `gorm:"type:timestamp(3);index:idx_message_threads_last_message_at"`
	CreatedAt          time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt          time.Time  `gorm:"type:timestamp(3);not null"`
}

// Message tracks synced messages and outbound reply drafts in a thread.
type Message struct {
	ID              uint           `gorm:"primaryKey;autoIncrement"`
	ThreadID        uint           `gorm:"not null;index:idx_messages_thread_id"`
	Thread          *MessageThread `gorm:"foreignKey:ThreadID;constraint:OnDelete:CASCADE"`
	UpworkMessageID *string        `gorm:"type:text;uniqueIndex:idx_messages_upwork_message_id,where:upwork_message_id IS NOT NULL AND upwork_message_id <> ''"`
	Sender          string         `gorm:"type:text;not null;default:''"`
	SenderRole      string         `gorm:"type:text;not null;default:''"` // "client" | "freelancer" | "system"
	Body            string         `gorm:"type:text;not null;default:''"`
	SentAt          *time.Time     `gorm:"type:timestamp(3);index:idx_messages_sent_at"`
	AttachmentsJSON JSONB          `gorm:"type:jsonb"`
	CardJSON        JSONB          `gorm:"type:jsonb"`
	IsDraft                bool           `gorm:"type:boolean;not null;default:false"`
	Status                 string         `gorm:"type:text;not null;default:'received';index:idx_messages_status"`
	ApprovalToken          string         `gorm:"type:text;uniqueIndex:idx_messages_approval_token,where:approval_token IS NOT NULL AND approval_token <> ''"`
	ApprovalTokenExpiresAt *time.Time     `gorm:"type:timestamp(3)"`
	ApprovedAt             *time.Time     `gorm:"type:timestamp(3)"`
	CreatedAt              time.Time      `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt              time.Time      `gorm:"type:timestamp(3);not null"`
}

// GeneratedAgent persists generated AI project agent blueprints across daemon restarts.
type GeneratedAgent struct {
	ID            uint      `gorm:"primaryKey;autoIncrement"`
	TemplateName  string    `gorm:"type:text;not null;uniqueIndex:idx_generated_agents_composite,priority:1"`
	BlueprintName string    `gorm:"type:text;not null;uniqueIndex:idx_generated_agents_composite,priority:2"`
	Format        string    `gorm:"type:text;not null;uniqueIndex:idx_generated_agents_composite,priority:3"`
	FileName      string    `gorm:"type:text;not null"`
	JobID         *uint     `gorm:"index:idx_generated_agents_job_id"`
	Job           *Job      `gorm:"foreignKey:JobID;constraint:OnDelete:SET NULL"`
	Content       string    `gorm:"type:text;not null;default:''"`
	FilesJSON     JSONB     `gorm:"type:jsonb"`
	GeneratedAt   time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	CreatedAt     time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt     time.Time `gorm:"type:timestamp(3);not null"`
}

// SelectorAudit persists DOM selector drift audit reports for Upwork views.
type SelectorAudit struct {
	ID            uint      `gorm:"primaryKey;autoIncrement"`
	ViewType      string    `gorm:"type:text;not null;index:idx_selector_audits_view_type"`
	OverallStatus string    `gorm:"type:text;not null;index:idx_selector_audits_overall_status"` // HEALTHY | DEGRADED | BROKEN | FRAGILE
	ReportJSON    JSONB     `gorm:"type:jsonb;not null"`
	BaselineJSON  JSONB     `gorm:"type:jsonb"`
	CreatedAt     time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_selector_audits_created_at"`
}

// UIDiagnosticCapture indexes captured live DOM diagnostic bundles stored on disk.
type UIDiagnosticCapture struct {
	ID               uint      `gorm:"primaryKey;autoIncrement"`
	CaptureUID       string    `gorm:"type:text;not null;uniqueIndex:idx_ui_diagnostic_captures_uid"`
	ViewType         string    `gorm:"type:text;not null;index:idx_ui_diagnostic_captures_view_type"`
	PageURL          string    `gorm:"type:text;not null;default:''"`
	OverallStatus    string    `gorm:"type:text;not null;index:idx_ui_diagnostic_captures_overall_status"`
	BrokenCount      int       `gorm:"type:integer;not null;default:0"`
	BrokenFieldsJSON JSONB     `gorm:"type:jsonb"`
	BundleDir        string    `gorm:"type:text;not null;default:''"`
	HasScreenshot    bool      `gorm:"type:boolean;not null;default:false"`
	SummaryJSON      JSONB     `gorm:"type:jsonb"`
	CreatedAt        time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_ui_diagnostic_captures_created_at"`
}

// ActionAuditLog records policy-governed actions, approvals, and kill-switch events.
type ActionAuditLog struct {
	ID          uint      `gorm:"primaryKey;autoIncrement"`
	ActionType  string    `gorm:"type:text;not null;index:idx_action_audit_logs_action_type"`
	Actor       string    `gorm:"type:text;not null;default:'system'"`
	TargetID    string    `gorm:"type:text;not null;default:'';index:idx_action_audit_logs_target_id"`
	PolicyMode  string    `gorm:"type:text;not null;default:''"`
	Outcome     string    `gorm:"type:text;not null;index:idx_action_audit_logs_outcome"`
	DetailsJSON JSONB     `gorm:"type:jsonb"`
	CreatedAt   time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_action_audit_logs_created_at"`
}

// PolicyConfig persists runtime automation policy mode, daily caps, guardrails, and kill-switch state.
type PolicyConfig struct {
	ID                  uint      `gorm:"primaryKey;autoIncrement"`
	ConfigKey           string    `gorm:"type:text;not null;default:'default';uniqueIndex:idx_policy_configs_config_key"`
	Mode                string    `gorm:"type:text;not null;default:'confirm_in_ui'"`
	AutoSubmitProposals bool      `gorm:"type:boolean;not null;default:true"`
	AutoSendMessages    bool      `gorm:"type:boolean;not null;default:true"`
	MaxProposalsPerDay  int       `gorm:"type:integer;not null;default:5"`
	MaxConnectsPerDay   int       `gorm:"type:integer;not null;default:50"`
	MaxMessagesPerDay   int       `gorm:"type:integer;not null;default:20"`
	MinJobScore         int       `gorm:"type:integer;not null;default:0"`
	AllowedRoomIDsJSON  JSONB     `gorm:"type:jsonb"`
	QuietHours          string    `gorm:"type:text;not null;default:''"`
	KillSwitchActive    bool      `gorm:"type:boolean;not null;default:false"`
	CreatedAt           time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt           time.Time `gorm:"type:timestamp(3);not null"`
}

// ActiveProject stores synced workspace coding/client project telemetry and curated metadata.
type ActiveProject struct {
	ID                  uint       `gorm:"primaryKey;autoIncrement"`
	ProjectKey          string     `gorm:"type:text;not null;uniqueIndex:idx_active_projects_key"`
	Slug                string     `gorm:"type:text;not null;default:'';index:idx_active_projects_slug"`
	Name                string     `gorm:"type:text;not null"`
	Path                string     `gorm:"type:text;not null;default:''"`
	GroupName           string     `gorm:"type:text;not null;default:'standalone';index:idx_active_projects_group_name"`
	ActivityTier        string     `gorm:"type:text;not null;default:'paused';index:idx_active_projects_tier"` // "active" | "recent" | "paused"
	Status              string     `gorm:"type:text;not null;default:'active';index:idx_active_projects_status"`
	Client              string     `gorm:"type:text;not null;default:''"`
	ProposalVisibility  string     `gorm:"type:text;not null;default:'anonymized';index:idx_active_projects_visibility"` // "public" | "anonymized" | "private"
	PublicAlias         string     `gorm:"type:text;not null;default:''"`
	TechStackJSON       JSONB      `gorm:"type:jsonb"`
	Summary             string     `gorm:"type:text;not null;default:''"`
	ReadmeHint          string     `gorm:"type:text;not null;default:''"`
	NextActionsJSON     JSONB      `gorm:"type:jsonb"`
	BlockersJSON        JSONB      `gorm:"type:jsonb"`
	Notes               string     `gorm:"type:text;not null;default:''"`
	Pinned              bool       `gorm:"type:boolean;not null;default:false"`
	IsGitRepo           bool       `gorm:"type:boolean;not null;default:false"`
	GitBranch           string     `gorm:"type:text;not null;default:''"`
	GitHead             string     `gorm:"type:text;not null;default:''"`
	GitDirtyCount       int        `gorm:"type:integer;not null;default:0"`
	LastCommitAt        *time.Time `gorm:"type:timestamp(3)"`
	LastCommitSubject   string     `gorm:"type:text;not null;default:''"`
	Commits7d           int        `gorm:"type:integer;not null;default:0"`
	LastClaudeSessionAt *time.Time `gorm:"type:timestamp(3)"`
	LastAntigravityAt   *time.Time `gorm:"type:timestamp(3)"`
	LastActivityAt      *time.Time `gorm:"type:timestamp(3);index:idx_active_projects_last_activity"`
	CuratedUpdatedAt    *time.Time `gorm:"type:timestamp(3)"`
	CuratedUpdatedBy    string     `gorm:"type:text;not null;default:''"`
	CreatedAt           time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt           time.Time  `gorm:"type:timestamp(3);not null"`
}

// SearchRun records metadata and counts for a discovery/ingestion run (0 LLM tokens).
type SearchRun struct {
	ID                  uint      `gorm:"primaryKey;autoIncrement"`
	Label               string    `gorm:"type:text;not null;default:''"`
	Source              string    `gorm:"type:text;not null;default:''"`
	TriggeredBy         string    `gorm:"type:text;not null;default:''"` // "api" | "mcp" | "ui" | "web" | "profile"
	ProfileID           *uint     `gorm:"index:idx_search_runs_profile_id"`
	ProjectKeysJSON     JSONB     `gorm:"type:jsonb"`
	QueriesJSON         JSONB     `gorm:"type:jsonb"`
	CriteriaJSON        JSONB     `gorm:"type:jsonb"`
	TotalScraped        int       `gorm:"type:integer;not null;default:0"`
	FilteredCount       int       `gorm:"type:integer;not null;default:0"`
	PersistedCount      int       `gorm:"type:integer;not null;default:0"`
	DetailEnrichedCount int       `gorm:"type:integer;not null;default:0"`
	StoppedReason       string    `gorm:"type:text;not null;default:''"`
	CreatedAt           time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_search_runs_created_at"`
}

// SearchRunJob links persisted jobs to the search runs that discovered or touched them.
type SearchRunJob struct {
	SearchRunID uint       `gorm:"primaryKey;autoIncrement:false"`
	JobID       uint       `gorm:"primaryKey;autoIncrement:false;index:idx_search_run_jobs_job_id"`
	SearchRun   *SearchRun `gorm:"foreignKey:SearchRunID;constraint:OnDelete:CASCADE"`
	Job         *Job       `gorm:"foreignKey:JobID;constraint:OnDelete:CASCADE"`
	CreatedAt   time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
}

// EnrichmentBatch tracks a cancelable async batch AI/detail enrichment job queue.
type EnrichmentBatch struct {
	ID              uint       `gorm:"primaryKey;autoIncrement"`
	Mode            string     `gorm:"type:text;not null;default:'full'"` // "full" | "ai_only" | "detail_only"
	TriggeredBy     string     `gorm:"type:text;not null;default:''"`     // "ui" | "web" | "mcp" | "api"
	Model           string     `gorm:"type:text;not null;default:''"`
	Effort          string     `gorm:"type:text;not null;default:''"`
	Force           bool       `gorm:"type:boolean;not null;default:false"`
	Status          string     `gorm:"type:text;not null;default:'queued';index:idx_enrichment_batches_status"` // "queued" | "running" | "completed" | "completed_with_errors" | "canceled" | "failed"
	TotalCount      int        `gorm:"type:integer;not null;default:0"`
	QueuedCount     int        `gorm:"type:integer;not null;default:0"`
	RunningCount    int        `gorm:"type:integer;not null;default:0"`
	CompletedCount  int        `gorm:"type:integer;not null;default:0"`
	SkippedCount    int        `gorm:"type:integer;not null;default:0"`
	FailedCount     int        `gorm:"type:integer;not null;default:0"`
	CanceledCount   int        `gorm:"type:integer;not null;default:0"`
	TotalTokensUsed int        `gorm:"type:integer;not null;default:0"`
	CreatedAt       time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_enrichment_batches_created_at"`
	StartedAt       *time.Time `gorm:"type:timestamp(3)"`
	CompletedAt     *time.Time `gorm:"type:timestamp(3)"`
	UpdatedAt       time.Time  `gorm:"type:timestamp(3);not null"`
}

// EnrichmentBatchItem tracks per-job execution status, token usage, and errors within a batch.
type EnrichmentBatchItem struct {
	ID            uint             `gorm:"primaryKey;autoIncrement"`
	BatchID       uint             `gorm:"not null;index:idx_enrichment_batch_items_batch_id"`
	Batch         *EnrichmentBatch `gorm:"foreignKey:BatchID;constraint:OnDelete:CASCADE"`
	JobID         uint             `gorm:"not null;index:idx_enrichment_batch_items_job_id"`
	Job           *Job             `gorm:"foreignKey:JobID;constraint:OnDelete:CASCADE"`
	Status        string           `gorm:"type:text;not null;default:'queued';index:idx_enrichment_batch_items_status"` // "queued" | "scraping_details" | "analyzing" | "completed" | "skipped" | "failed" | "canceled"
	DetailFetched bool             `gorm:"type:boolean;not null;default:false"`
	LLMInvoked    bool             `gorm:"type:boolean;not null;default:false"`
	Model         string           `gorm:"type:text;not null;default:''"`
	Effort        string           `gorm:"type:text;not null;default:''"`
	InputTokens   int              `gorm:"type:integer;not null;default:0"`
	OutputTokens  int              `gorm:"type:integer;not null;default:0"`
	ThoughtTokens int              `gorm:"type:integer;not null;default:0"`
	TotalTokens   int              `gorm:"type:integer;not null;default:0"`
	ErrorCode     string           `gorm:"type:text;not null;default:''"`
	ErrorMessage  string           `gorm:"type:text;not null;default:''"`
	StartedAt     *time.Time       `gorm:"type:timestamp(3)"`
	CompletedAt   *time.Time       `gorm:"type:timestamp(3)"`
	CreatedAt     time.Time        `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt     time.Time        `gorm:"type:timestamp(3);not null"`
}

// WatchRule configures an autonomous job-watcher rule and its reaction policy.
type WatchRule struct {
	ID                           uint           `gorm:"primaryKey;autoIncrement"`
	Name                         string         `gorm:"type:text;not null;uniqueIndex:idx_watch_rules_name"`
	Description                  string         `gorm:"type:text;not null;default:''"`
	Enabled                      bool           `gorm:"type:boolean;not null;default:false;index:idx_watch_rules_enabled"`
	DiscoveryBackend             string         `gorm:"type:text;not null;default:'chrome'"` // "chrome" | "scraper_fs"
	SearchProfileID              *uint          `gorm:"index:idx_watch_rules_search_profile_id"`
	SearchProfile                *SearchProfile `gorm:"foreignKey:SearchProfileID;constraint:OnDelete:SET NULL"`
	DiscoveryConfigJSON          JSONB          `gorm:"type:jsonb"`
	IntervalMinutes              int            `gorm:"type:integer;not null;default:5"`
	JitterRatio                  float64        `gorm:"type:double precision;not null;default:0.35"`
	ActiveHours                  string         `gorm:"type:text;not null;default:''"`
	MinScore                     int            `gorm:"type:integer;not null;default:75"`
	MaxProposals                 *int           `gorm:"type:integer"`
	MaxPostedAgeMinutes          *int           `gorm:"type:integer"`
	MaxConnectsPerJob            *int           `gorm:"type:integer"`
	RequirePaymentVerified       bool           `gorm:"type:boolean;not null;default:true"`
	RequiredKeywordsJSON         JSONB          `gorm:"type:jsonb"`
	ExcludeKeywordsJSON          JSONB          `gorm:"type:jsonb"`
	ActionMode                   string         `gorm:"type:text;not null;default:'draft_and_fill'"` // "alert_only" | "draft_and_fill" | "auto_submit"
	LLMModel                     string         `gorm:"type:text;not null;default:''"`
	LLMEffort                    string         `gorm:"type:text;not null;default:''"`
	BidStrategyJSON              JSONB          `gorm:"type:jsonb"`
	AutoSubmitMinConfidence      float64        `gorm:"type:double precision;not null;default:0.85"`
	FallbackOnScreeningQuestions bool           `gorm:"type:boolean;not null;default:true"`
	MaxReactionsPerTick          int            `gorm:"type:integer;not null;default:2"`
	SeedBaselineOnFirstRun       bool           `gorm:"type:boolean;not null;default:true"`
	SeededAt                     *time.Time     `gorm:"type:timestamp(3)"`
	PausedReason                 string         `gorm:"type:text;not null;default:''"`
	ConsecutiveErrors            int            `gorm:"type:integer;not null;default:0"`
	NextRunAt                    *time.Time     `gorm:"type:timestamp(3);index:idx_watch_rules_next_run_at"`
	LastRunAt                    *time.Time     `gorm:"type:timestamp(3)"`
	LastSuccessAt                *time.Time     `gorm:"type:timestamp(3)"`
	LastError                    string         `gorm:"type:text;not null;default:''"`
	CreatedAt                    time.Time      `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt                    time.Time      `gorm:"type:timestamp(3);not null"`
}

// WatchRun records a single execution tick of a WatchRule.
type WatchRun struct {
	ID               uint       `gorm:"primaryKey;autoIncrement"`
	WatchRuleID      uint       `gorm:"not null;index:idx_watch_runs_rule_id"`
	WatchRule        *WatchRule `gorm:"foreignKey:WatchRuleID;constraint:OnDelete:CASCADE"`
	DiscoveryBackend string     `gorm:"type:text;not null;default:''"`
	TriggeredBy      string     `gorm:"type:text;not null;default:''"`
	SearchRunID      *uint      `gorm:"index:idx_watch_runs_search_run_id"`
	SearchRun        *SearchRun `gorm:"foreignKey:SearchRunID;constraint:OnDelete:SET NULL"`
	Status           string     `gorm:"type:text;not null;default:'running';index:idx_watch_runs_status"`
	ScrapedCount     int        `gorm:"type:integer;not null;default:0"`
	NewJobsCount     int        `gorm:"type:integer;not null;default:0"`
	QualifiedCount   int        `gorm:"type:integer;not null;default:0"`
	DraftedCount     int        `gorm:"type:integer;not null;default:0"`
	FilledCount      int        `gorm:"type:integer;not null;default:0"`
	SubmittedCount   int        `gorm:"type:integer;not null;default:0"`
	AlertedCount     int        `gorm:"type:integer;not null;default:0"`
	ErrorCode        string     `gorm:"type:text;not null;default:''"`
	ErrorMessage     string     `gorm:"type:text;not null;default:''"`
	StartedAt        time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	CompletedAt      *time.Time `gorm:"type:timestamp(3)"`
	CreatedAt        time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_watch_runs_created_at"`
}

// WatchEvent records per-job progression through a WatchRule's reaction pipeline.
type WatchEvent struct {
	ID             uint       `gorm:"primaryKey;autoIncrement"`
	WatchRuleID    uint       `gorm:"not null;uniqueIndex:idx_watch_events_rule_job,priority:1;index:idx_watch_events_rule_id"`
	WatchRule      *WatchRule `gorm:"foreignKey:WatchRuleID;constraint:OnDelete:CASCADE"`
	WatchRunID     *uint      `gorm:"index:idx_watch_events_run_id"`
	WatchRun       *WatchRun  `gorm:"foreignKey:WatchRunID;constraint:OnDelete:SET NULL"`
	JobID          uint       `gorm:"not null;uniqueIndex:idx_watch_events_rule_job,priority:2;index:idx_watch_events_job_id"`
	Job            *Job       `gorm:"foreignKey:JobID;constraint:OnDelete:CASCADE"`
	UpworkJobID    string     `gorm:"type:text;not null;default:''"`
	ProposalID     *uint      `gorm:"index:idx_watch_events_proposal_id"`
	Proposal       *Proposal  `gorm:"foreignKey:ProposalID;constraint:OnDelete:SET NULL"`
	Stage          string     `gorm:"type:text;not null;default:'discovered';index:idx_watch_events_stage"`
	DecisionReason string     `gorm:"type:text;not null;default:''"`
	Confidence     *float64   `gorm:"type:double precision"`
	ErrorCode      string     `gorm:"type:text;not null;default:''"`
	ErrorMessage   string     `gorm:"type:text;not null;default:''"`
	CreatedAt      time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null;index:idx_watch_events_created_at"`
	UpdatedAt      time.Time  `gorm:"type:timestamp(3);not null"`
}

// NotificationConfig persists notification channel settings for watcher alerts.
type NotificationConfig struct {
	ID                         uint      `gorm:"primaryKey;autoIncrement"`
	ConfigKey                  string    `gorm:"type:text;not null;default:'default';uniqueIndex:idx_notification_configs_key"`
	ChromeNotificationsEnabled bool      `gorm:"type:boolean;not null;default:true"`
	WebhookEnabled             bool      `gorm:"type:boolean;not null;default:false"`
	WebhookURL                 string    `gorm:"type:text;not null;default:''"`
	WebhookSecret              string    `gorm:"type:text;not null;default:''"`
	TelegramEnabled            bool      `gorm:"type:boolean;not null;default:false"`
	TelegramBotToken           string    `gorm:"type:text;not null;default:''"`
	TelegramChatID             string    `gorm:"type:text;not null;default:''"`
	NotifyEventsJSON           JSONB     `gorm:"type:jsonb"`
	CreatedAt                  time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
	UpdatedAt                  time.Time `gorm:"type:timestamp(3);not null"`
}
