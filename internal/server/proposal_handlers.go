package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const advisoryLockProposals int64 = 7001

type proposalEntry = ProposalEntry

// ProposalEntry is the API/MCP DTO for a proposal row.
type ProposalEntry struct {
	ID                       uint            `json:"id"`
	JobID                    *uint           `json:"job_id,omitempty"`
	UpworkJobID              string          `json:"upwork_job_id"`
	JobTitle                 string          `json:"job_title,omitempty"`
	CoverLetter              string          `json:"cover_letter"`
	BidType                  string          `json:"bid_type"`
	BidAmount                *float64        `json:"bid_amount,omitempty"`
	RateIncrease             string          `json:"rate_increase,omitempty"`
	MilestonesJSON           json.RawMessage `json:"milestones_json,omitempty"`
	ScreeningAnswersJSON     json.RawMessage `json:"screening_answers_json,omitempty"`
	ConnectsRequired         *int            `json:"connects_required,omitempty"`
	BoostConnects            *int            `json:"boost_connects,omitempty"`
	TotalConnects            int             `json:"total_connects"`
	PortfolioRefsJSON        json.RawMessage `json:"portfolio_refs_json,omitempty"`
	Status                   string          `json:"status"`
	ApprovalToken            string          `json:"approval_token,omitempty"`
	ApprovedAt               *string         `json:"approved_at,omitempty"`
	SubmittedAt              *string         `json:"submitted_at,omitempty"`
	UpworkProposalURL        string          `json:"upwork_proposal_url,omitempty"`
	VerificationSnapshotJSON json.RawMessage `json:"verification_snapshot_json,omitempty"`
	CreatedAt                string          `json:"created_at"`
	UpdatedAt                string          `json:"updated_at"`
}

type proposalVerificationSnapshot struct {
	OK                          bool            `json:"ok"`
	CoverLetterLength           int             `json:"cover_letter_length"`
	BidType                     string          `json:"bid_type"`
	BidAmount                   *float64        `json:"bid_amount"`
	EstimatedFee                *float64        `json:"estimated_fee,omitempty"`
	EstimatedNet                *float64        `json:"estimated_net,omitempty"`
	ConnectsCost                *int            `json:"connects_cost"`
	BoostConnects               *int            `json:"boost_connects,omitempty"`
	TotalConnects               int             `json:"total_connects"`
	AvailableConnects           *int            `json:"available_connects,omitempty"`
	InsufficientConnects        bool            `json:"insufficient_connects,omitempty"`
	UnansweredRequiredQuestions int             `json:"unanswered_required_questions"`
	RateIncrease                string          `json:"rate_increase,omitempty"`
	ScreeningAnswers            json.RawMessage `json:"screening_answers,omitempty"`
}

func proposalEntryFromModel(p dbservice.Proposal) proposalEntry {
	var jobTitle string
	connectsReq := p.ConnectsRequired
	if p.Job != nil {
		jobTitle = p.Job.Title
		if connectsReq == nil && p.Job.ConnectsRequired != nil {
			connectsReq = p.Job.ConnectsRequired
		}
	}
	if connectsReq == nil && len(p.VerificationSnapshotJSON) > 0 {
		var snap proposalVerificationSnapshot
		if json.Unmarshal(p.VerificationSnapshotJSON, &snap) == nil && snap.ConnectsCost != nil {
			connectsReq = snap.ConnectsCost
		}
	}
	totalConnects := 0
	if connectsReq != nil {
		totalConnects += *connectsReq
	}
	if p.BoostConnects != nil {
		totalConnects += *p.BoostConnects
	}
	return proposalEntry{
		ID:                       p.ID,
		JobID:                    p.JobID,
		UpworkJobID:              p.UpworkJobID,
		JobTitle:                 jobTitle,
		CoverLetter:              p.CoverLetter,
		BidType:                  p.BidType,
		BidAmount:                p.BidAmount,
		RateIncrease:             p.RateIncrease,
		MilestonesJSON:           rawJSONFromJSONB(p.MilestonesJSON),
		ScreeningAnswersJSON:     rawJSONFromJSONB(p.ScreeningAnswersJSON),
		ConnectsRequired:         connectsReq,
		BoostConnects:            p.BoostConnects,
		TotalConnects:            totalConnects,
		PortfolioRefsJSON:        rawJSONFromJSONB(p.PortfolioRefsJSON),
		Status:                   p.Status,
		ApprovalToken:            p.ApprovalToken,
		ApprovedAt:               formatOptTime(p.ApprovedAt),
		SubmittedAt:              formatOptTime(p.SubmittedAt),
		UpworkProposalURL:        p.UpworkProposalURL,
		VerificationSnapshotJSON: rawJSONFromJSONB(p.VerificationSnapshotJSON),
		CreatedAt:                p.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:                p.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func extractProposalIDParam(r *http.Request) (uint64, error) {
	idStr := strings.TrimSpace(r.PathValue("id"))
	if idStr == "" {
		path := strings.TrimPrefix(r.URL.Path, "/api/proposals/")
		if idx := strings.Index(path, "/"); idx != -1 {
			path = path[:idx]
		}
		idStr = strings.TrimSpace(path)
	}
	idVal, err := strconv.ParseUint(idStr, 10, 64)
	if err != nil || idVal == 0 || idVal > math.MaxInt64 {
		return 0, errors.New("invalid proposal ID")
	}
	return idVal, nil
}

func firstNonEmptyRawJSON(candidates ...json.RawMessage) json.RawMessage {
	for _, c := range candidates {
		if len(bytes.TrimSpace(c)) > 0 {
			return c
		}
	}
	return nil
}

func resolveApplyURL(upworkJobID, override string) string {
	if trimmed := strings.TrimSpace(override); trimmed != "" {
		return trimmed
	}
	id := scoring.NormalizeUpworkJobID(upworkJobID)
	if id == "" {
		return ""
	}
	return fmt.Sprintf("https://www.upwork.com/nx/proposals/job/%s/apply/", id)
}

func proposalConnectsCost(p dbservice.Proposal, job *dbservice.Job) int {
	base := 0
	if p.ConnectsRequired != nil {
		base = *p.ConnectsRequired
	} else if job != nil && job.ConnectsRequired != nil {
		base = *job.ConnectsRequired
	} else if len(p.VerificationSnapshotJSON) > 0 {
		var snap proposalVerificationSnapshot
		if json.Unmarshal(p.VerificationSnapshotJSON, &snap) == nil && snap.ConnectsCost != nil {
			base = *snap.ConnectsCost
		}
	}
	boost := 0
	if p.BoostConnects != nil {
		boost = *p.BoostConnects
	}
	if base+boost < 0 {
		return 0
	}
	return base + boost
}

func countUnansweredRequiredQuestions(p dbservice.Proposal, job *dbservice.Job) int {
	if len(p.VerificationSnapshotJSON) > 0 {
		var snap proposalVerificationSnapshot
		if json.Unmarshal(p.VerificationSnapshotJSON, &snap) == nil && snap.UnansweredRequiredQuestions > 0 {
			return snap.UnansweredRequiredQuestions
		}
	}

	if job == nil || len(job.ScreeningQuestions) == 0 {
		return 0
	}
	var questions []struct {
		Index    int    `json:"index"`
		Prompt   string `json:"prompt"`
		Required bool   `json:"required"`
	}
	if json.Unmarshal(job.ScreeningQuestions, &questions) != nil || len(questions) == 0 {
		return 0
	}

	requiredQuestions := 0
	for _, q := range questions {
		if q.Required {
			requiredQuestions++
		}
	}
	if requiredQuestions == 0 {
		return 0
	}

	// Parse proposal screening answers (array of strings or objects {index, prompt, answer})
	answeredByIdx := make(map[int]string)
	answeredByPrompt := make(map[string]string)
	if len(p.ScreeningAnswersJSON) > 0 {
		var objAnswers []struct {
			Index  *int   `json:"index"`
			Prompt string `json:"prompt"`
			Answer string `json:"answer"`
		}
		if json.Unmarshal(p.ScreeningAnswersJSON, &objAnswers) == nil && len(objAnswers) > 0 {
			for i, a := range objAnswers {
				ans := strings.TrimSpace(a.Answer)
				if a.Index != nil {
					answeredByIdx[*a.Index] = ans
				} else {
					answeredByIdx[i] = ans
				}
				if pt := strings.ToLower(strings.TrimSpace(a.Prompt)); pt != "" {
					answeredByPrompt[pt] = ans
				}
			}
		} else {
			var strAnswers []string
			if json.Unmarshal(p.ScreeningAnswersJSON, &strAnswers) == nil {
				for i, a := range strAnswers {
					answeredByIdx[i] = strings.TrimSpace(a)
				}
			}
		}
	}

	missing := 0
	for i, q := range questions {
		if !q.Required {
			continue
		}
		ans := answeredByIdx[q.Index]
		if ans == "" {
			ans = answeredByIdx[i]
		}
		if ans == "" && q.Prompt != "" {
			ans = answeredByPrompt[strings.ToLower(strings.TrimSpace(q.Prompt))]
		}
		if strings.TrimSpace(ans) == "" {
			missing++
		}
	}
	return missing
}

func isValidProposalStatus(status string) bool {
	switch status {
	case "draft", "pending_approval", "approved", "submitting", "submitted", "viewed", "interviewing", "offer", "archived", "rejected", "failed":
		return true
	default:
		return false
	}
}

func isTerminalOrInFlightProposalStatus(status string) bool {
	switch status {
	case "submitting", "submitted", "viewed", "interviewing", "offer":
		return true
	default:
		return false
	}
}

func isAllowedSaveProposalStatus(status string, isCreate bool) bool {
	switch status {
	case "draft", "pending_approval", "rejected", "archived":
		return true
	case "submitted":
		// Allow seeding pre-existing submitted proposals on initial create (e.g. before proposals.sync).
		return isCreate
	default:
		return false
	}
}

func normalizeSyncedProposalStatus(raw string) string {
	lower := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case strings.Contains(lower, "offer"):
		return "offer"
	case strings.Contains(lower, "interview"):
		return "interviewing"
	case strings.Contains(lower, "view"):
		return "viewed"
	case strings.Contains(lower, "archiv"):
		return "archived"
	case strings.Contains(lower, "withdraw") || strings.Contains(lower, "declin") || strings.Contains(lower, "reject"):
		return "rejected"
	case strings.Contains(lower, "submit") || strings.Contains(lower, "active"):
		return "submitted"
	default:
		if isValidProposalStatus(lower) {
			return lower
		}
		return "submitted"
	}
}

// ListProposalsFilter configures filtering and pagination for ListProposals.
type ListProposalsFilter struct {
	Status      string   `json:"status,omitempty"`
	Statuses    []string `json:"statuses,omitempty"`
	JobID       *uint64  `json:"job_id,omitempty"`
	UpworkJobID string   `json:"upwork_job_id,omitempty"`
	Limit       int      `json:"limit,omitempty"`
	Offset      int      `json:"offset,omitempty"`
}

// SaveProposalInput configures creating or updating a proposal draft.
type SaveProposalInput struct {
	ID                   *uint           `json:"id"`
	JobID                json.RawMessage `json:"job_id"`
	UpworkJobID          string          `json:"upwork_job_id"`
	CoverLetter          string          `json:"cover_letter"`
	BidType              string          `json:"bid_type"`
	BidAmount            *float64        `json:"bid_amount"`
	RateIncrease         string          `json:"rate_increase"`
	ConnectsRequired     *int            `json:"connects_required"`
	MilestonesJSON       json.RawMessage `json:"milestones_json"`
	Milestones           json.RawMessage `json:"milestones"`
	ScreeningAnswersJSON json.RawMessage `json:"screening_answers_json"`
	ScreeningAnswers     json.RawMessage `json:"screening_answers"`
	BoostConnects        *int            `json:"boost_connects"`
	PortfolioRefsJSON    json.RawMessage `json:"portfolio_refs_json"`
	PortfolioRefs        json.RawMessage `json:"portfolio_refs"`
	Status               string          `json:"status"`
}

// FillProposalInput configures live proposal form filling.
type FillProposalInput struct {
	ApplyURL     string `json:"apply_url"`
	RateIncrease string `json:"rate_increase"`
}

// FillProposalResult summarizes the filled proposal and pending approval token.
type FillProposalResult struct {
	Proposal          ProposalEntry   `json:"proposal"`
	Snapshot          json.RawMessage `json:"snapshot"`
	ApprovalToken     string          `json:"approval_token"`
	ExpiresAt         string          `json:"expires_at"`
	Status            string          `json:"status"`
	CoverLetterLength int             `json:"cover_letter_length"`
	BidType           string          `json:"bid_type"`
	BidAmount         *float64        `json:"bid_amount"`
	TotalConnects     int             `json:"total_connects"`
	ConnectsCost      *int            `json:"connects_cost,omitempty"`
	AvailableConnects *int            `json:"available_connects,omitempty"`
	ScreeningAnswers  json.RawMessage `json:"screening_answers"`
}

// CommitProposalInput configures proposal submission / approval.
type CommitProposalInput struct {
	ApprovalToken string `json:"approval_token"`
	ApplyURL      string `json:"apply_url"`
}

// CommitProposalResult summarizes a committed proposal submission.
type CommitProposalResult struct {
	Proposal          ProposalEntry `json:"proposal"`
	Submitted         bool          `json:"submitted"`
	Status            string        `json:"status"`
	UpworkProposalURL string        `json:"upwork_proposal_url,omitempty"`
}

// SyncProposalsResult summarizes synced proposals from Upwork.
type SyncProposalsResult struct {
	Proposals   []ProposalEntry `json:"proposals"`
	SyncedCount int             `json:"synced_count"`
}

// ListProposals queries persisted proposals with optional status, job, and pagination filters.
func (s *Server) ListProposals(ctx context.Context, filter ListProposalsFilter) ([]ProposalEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	db := s.db.GetGorm().WithContext(ctx).Model(&dbservice.Proposal{}).Preload("Job")
	if status := strings.TrimSpace(filter.Status); status != "" {
		db = db.Where("status = ?", status)
	}
	if len(filter.Statuses) > 0 {
		db = db.Where("status IN ?", filter.Statuses)
	}
	if filter.JobID != nil {
		if *filter.JobID == 0 || *filter.JobID > math.MaxInt64 {
			return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid job_id parameter"}
		}
		db = db.Where("job_id = ?", *filter.JobID)
	}
	if upworkJobID := strings.TrimSpace(filter.UpworkJobID); upworkJobID != "" {
		db = db.Where("upwork_job_id = ?", scoring.NormalizeUpworkJobID(upworkJobID))
	}
	if filter.Limit < 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid limit parameter"}
	}
	if filter.Limit > 0 {
		limit := filter.Limit
		if limit > 500 {
			limit = 500
		}
		db = db.Limit(limit)
	}
	if filter.Offset < 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid offset parameter"}
	}
	if filter.Offset > 0 {
		db = db.Offset(filter.Offset)
	}

	var rows []dbservice.Proposal
	if err := db.Order("updated_at DESC, id DESC").Find(&rows).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list proposals"}
	}

	entries := make([]ProposalEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, proposalEntryFromModel(row))
	}
	return entries, nil
}

// GetProposal retrieves a single proposal by ID.
func (s *Server) GetProposal(ctx context.Context, id uint64) (*ProposalEntry, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if id == 0 || id > math.MaxInt64 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid proposal ID"}
	}

	var row dbservice.Proposal
	if err := s.db.GetGorm().WithContext(ctx).Preload("Job").First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Proposal not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to get proposal"}
	}
	entry := proposalEntryFromModel(row)
	return &entry, nil
}

// SaveProposal creates or updates a proposal draft and records an audit log entry.
func (s *Server) SaveProposal(ctx context.Context, req SaveProposalInput, actor string) (*ProposalEntry, bool, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, false, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if strings.TrimSpace(actor) == "" {
		actor = "api"
	}

	coverLetter := strings.TrimSpace(req.CoverLetter)
	if coverLetter == "" {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "cover_letter is required"}
	}

	bidType := strings.ToLower(strings.TrimSpace(req.BidType))
	if bidType != "" && bidType != "hourly" && bidType != "fixed" {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "bid_type must be 'hourly', 'fixed', or empty"}
	}
	if req.BidAmount != nil && *req.BidAmount < 0 {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "bid_amount must be >= 0"}
	}
	if req.BoostConnects != nil && *req.BoostConnects < 0 {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "boost_connects must be >= 0"}
	}
	if req.ConnectsRequired != nil && *req.ConnectsRequired < 0 {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "connects_required must be >= 0"}
	}

	milestones, err := parseFlexibleJSONB(firstNonEmptyRawJSON(req.MilestonesJSON, req.Milestones))
	if err != nil {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid milestones_json value"}
	}
	screeningAnswers, err := parseFlexibleJSONB(firstNonEmptyRawJSON(req.ScreeningAnswersJSON, req.ScreeningAnswers))
	if err != nil {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid screening_answers_json value"}
	}
	portfolioRefs, err := parseFlexibleJSONB(firstNonEmptyRawJSON(req.PortfolioRefsJSON, req.PortfolioRefs))
	if err != nil {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid portfolio_refs_json value"}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	var resolvedJob *dbservice.Job
	upworkJobID := scoring.NormalizeUpworkJobID(req.UpworkJobID)

	rawJobID := bytes.TrimSpace(req.JobID)
	if len(rawJobID) > 0 && !bytes.Equal(rawJobID, []byte("null")) {
		if rawJobID[0] == '"' {
			var strID string
			if err := json.Unmarshal(rawJobID, &strID); err != nil {
				return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid job_id"}
			}
			strID = strings.TrimSpace(strID)
			if numID, numErr := strconv.ParseUint(strID, 10, 64); numErr == nil || errors.Is(numErr, strconv.ErrRange) {
				if numErr != nil || numID == 0 || numID > math.MaxInt64 {
					return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid job_id"}
				}
				var j dbservice.Job
				if err := gormDB.First(&j, numID).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return nil, false, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Job not found"}
					}
					return nil, false, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load job"}
				}
				resolvedJob = &j
			} else if strID != "" {
				norm := scoring.NormalizeUpworkJobID(strID)
				lookupID := norm
				if lookupID == "" {
					lookupID = strID
				}
				var j dbservice.Job
				if err := gormDB.Where("upwork_job_id = ?", lookupID).First(&j).Error; err == nil {
					resolvedJob = &j
				} else if errors.Is(err, gorm.ErrRecordNotFound) {
					if strings.HasPrefix(norm, "~") {
						if upworkJobID != "" && upworkJobID != norm {
							return nil, false, &policy.PolicyError{
								Code:       "INVALID_JOB_TARGET",
								HTTPStatus: http.StatusConflict,
								Message:    fmt.Sprintf("INVALID_JOB_TARGET: job_id %q does not match upwork_job_id %q", norm, upworkJobID),
							}
						}
						if upworkJobID == "" {
							upworkJobID = norm
						}
					} else {
						return nil, false, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Job not found"}
					}
				} else {
					return nil, false, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load job"}
				}
			}
		} else {
			var numID uint64
			if err := json.Unmarshal(rawJobID, &numID); err != nil || numID == 0 || numID > math.MaxInt64 {
				return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid job_id"}
			}
			var j dbservice.Job
			if err := gormDB.First(&j, numID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return nil, false, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Job not found"}
				}
				return nil, false, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load job"}
			}
			resolvedJob = &j
		}
	} else if upworkJobID != "" {
		var j dbservice.Job
		if err := gormDB.Where("upwork_job_id = ?", upworkJobID).First(&j).Error; err == nil {
			resolvedJob = &j
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, false, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load job"}
		}
	}

	if resolvedJob != nil && resolvedJob.UpworkJobID != nil {
		resolvedUpworkID := scoring.NormalizeUpworkJobID(*resolvedJob.UpworkJobID)
		if resolvedUpworkID != "" {
			if upworkJobID != "" && upworkJobID != resolvedUpworkID {
				return nil, false, &policy.PolicyError{
					Code:       "INVALID_JOB_TARGET",
					HTTPStatus: http.StatusConflict,
					Message:    fmt.Sprintf("INVALID_JOB_TARGET: job_id %d (%s) does not match upwork_job_id %q", resolvedJob.ID, resolvedUpworkID, upworkJobID),
				}
			}
			if upworkJobID == "" {
				upworkJobID = resolvedUpworkID
			}
		}
	}

	if req.ID != nil && uint64(*req.ID) > math.MaxInt64 {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid proposal ID"}
	}
	status := strings.TrimSpace(req.Status)
	isCreateReq := req.ID == nil || *req.ID == 0
	if status == "" {
		status = "draft"
	} else if !isAllowedSaveProposalStatus(status, isCreateReq) {
		return nil, false, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid or disallowed proposal status"}
	}

	var model dbservice.Proposal
	isUpdate := false
	var serviceErr error

	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
			return err
		}

		var (
			prevStatus           string
			prevJobID            *uint
			prevUpworkJobID      string
			prevCoverLetter      string
			prevBidType          string
			prevBidAmount        *float64
			prevRateIncrease     string
			prevConnectsRequired *int
			prevBoostConnects    *int
			prevMilestones       []byte
			prevScreening        []byte
		)
		if req.ID != nil && *req.ID > 0 {
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&model, *req.ID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					serviceErr = &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Proposal not found"}
					return nil
				}
				return err
			}
			isUpdate = true
			prevStatus = model.Status
			if isTerminalOrInFlightProposalStatus(prevStatus) {
				serviceErr = &ServiceError{
					Code:       "ALREADY_SUBMITTED",
					HTTPStatus: http.StatusConflict,
					Message:    fmt.Sprintf("proposal #%d is already %s and cannot be modified", model.ID, prevStatus),
				}
				return nil
			}
			if prevStatus == "failed" && status == "pending_approval" {
				serviceErr = &policy.PolicyError{
					Code:       "PROPOSAL_REFILL_REQUIRED",
					HTTPStatus: http.StatusConflict,
					Message:    fmt.Sprintf("proposal #%d is in failed state; re-fill the proposal form before moving to pending_approval", model.ID),
				}
				return nil
			}
			if model.JobID != nil {
				v := *model.JobID
				prevJobID = &v
			}
			prevUpworkJobID = model.UpworkJobID
			prevCoverLetter = model.CoverLetter
			prevBidType = model.BidType
			if model.BidAmount != nil {
				v := *model.BidAmount
				prevBidAmount = &v
			}
			prevRateIncrease = model.RateIncrease
			if model.ConnectsRequired != nil {
				v := *model.ConnectsRequired
				prevConnectsRequired = &v
			}
			if model.BoostConnects != nil {
				v := *model.BoostConnects
				prevBoostConnects = &v
			}
			prevMilestones = append([]byte(nil), model.MilestonesJSON...)
			prevScreening = append([]byte(nil), model.ScreeningAnswersJSON...)
		}

		if resolvedJob != nil {
			jobChanged := !equalUintPtr(model.JobID, &resolvedJob.ID)
			model.JobID = &resolvedJob.ID
			if req.ConnectsRequired == nil {
				if jobChanged {
					if resolvedJob.ConnectsRequired != nil {
						v := *resolvedJob.ConnectsRequired
						model.ConnectsRequired = &v
					} else {
						model.ConnectsRequired = nil
					}
				} else if model.ConnectsRequired == nil && resolvedJob.ConnectsRequired != nil {
					v := *resolvedJob.ConnectsRequired
					model.ConnectsRequired = &v
				}
			}
			if jobChanged && upworkJobID == "" {
				if resolvedJob.UpworkJobID != nil {
					model.UpworkJobID = *resolvedJob.UpworkJobID
				} else {
					model.UpworkJobID = ""
				}
			}
		} else if isUpdate && upworkJobID != "" && upworkJobID != prevUpworkJobID {
			model.JobID = nil
			if req.ConnectsRequired == nil {
				model.ConnectsRequired = nil
			}
		}
		if upworkJobID != "" {
			model.UpworkJobID = upworkJobID
		}
		model.CoverLetter = coverLetter
		model.BidType = bidType
		model.BidAmount = req.BidAmount
		if strings.TrimSpace(req.RateIncrease) != "" {
			model.RateIncrease = strings.TrimSpace(req.RateIncrease)
		}
		if req.ConnectsRequired != nil {
			model.ConnectsRequired = req.ConnectsRequired
		}
		if milestones != nil {
			model.MilestonesJSON = milestones
		}
		if screeningAnswers != nil {
			model.ScreeningAnswersJSON = screeningAnswers
		}
		if req.BoostConnects != nil {
			model.BoostConnects = req.BoostConnects
		}
		if portfolioRefs != nil {
			model.PortfolioRefsJSON = portfolioRefs
		}
		model.Status = status

		criticalChanged := false
		if isUpdate {
			criticalChanged = !equalUintPtr(model.JobID, prevJobID) ||
				model.UpworkJobID != prevUpworkJobID ||
				model.CoverLetter != prevCoverLetter ||
				model.BidType != prevBidType ||
				!equalFloat64Ptr(model.BidAmount, prevBidAmount) ||
				model.RateIncrease != prevRateIncrease ||
				!equalIntPtr(model.ConnectsRequired, prevConnectsRequired) ||
				!equalIntPtr(model.BoostConnects, prevBoostConnects) ||
				!bytes.Equal(bytes.TrimSpace(model.MilestonesJSON), bytes.TrimSpace(prevMilestones)) ||
				!bytes.Equal(bytes.TrimSpace(model.ScreeningAnswersJSON), bytes.TrimSpace(prevScreening))

			if status == "pending_approval" {
				if criticalChanged {
					model.Status = "draft"
				} else if prevStatus != "pending_approval" || len(model.VerificationSnapshotJSON) == 0 {
					serviceErr = &policy.PolicyError{
						Code:       "PROPOSAL_REFILL_REQUIRED",
						HTTPStatus: http.StatusConflict,
						Message:    fmt.Sprintf("proposal #%d must be filled via FillProposal before moving to pending_approval", model.ID),
					}
					return nil
				}
			}

			if prevStatus == "rejected" || prevStatus == "archived" || prevStatus == "failed" || criticalChanged || status != "pending_approval" {
				model.ApprovalToken = ""
				model.ApprovalTokenExpiresAt = nil
				model.ApprovedAt = nil
				model.VerificationSnapshotJSON = nil
			}
		}

		if isUpdate {
			if err := tx.Save(&model).Error; err != nil {
				return err
			}
		} else {
			if err := tx.Create(&model).Error; err != nil {
				return err
			}
		}

		if err := tx.Preload("Job").First(&model, model.ID).Error; err != nil {
			return err
		}

		return policy.RecordAuditTx(tx, policy.AuditEntry{
			ActionType: "proposal_drafted",
			Actor:      actor,
			TargetID:   strconv.FormatUint(uint64(model.ID), 10),
			Outcome:    "allowed",
			Details: map[string]any{
				"upwork_job_id": model.UpworkJobID,
				"bid_type":      model.BidType,
				"status":        model.Status,
			},
		})
	})
	if serviceErr != nil {
		return nil, false, serviceErr
	}
	if txErr != nil {
		msg := "Failed to create proposal"
		if isUpdate {
			msg = "Failed to update proposal"
		}
		return nil, false, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: msg}
	}

	entry := proposalEntryFromModel(model)
	return &entry, !isUpdate, nil
}

// FillProposal drives the extension proposal.fill RPC, checks connects sufficiency, and transitions to pending_approval.
func (s *Server) FillProposal(ctx context.Context, id uint64, body FillProposalInput) (*FillProposalResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if id == 0 || id > math.MaxInt64 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid proposal ID"}
	}
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	var prop dbservice.Proposal
	if err := gormDB.Preload("Job").First(&prop, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Proposal not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load proposal"}
	}
	if isTerminalOrInFlightProposalStatus(prop.Status) {
		return nil, &ServiceError{
			Code:       "ALREADY_SUBMITTED",
			HTTPStatus: http.StatusConflict,
			Message:    fmt.Sprintf("proposal #%d is already %s and cannot be re-filled", prop.ID, prop.Status),
		}
	}
	if prop.Status == "rejected" || prop.Status == "archived" {
		return nil, &policy.PolicyError{
			Code:       "PROPOSAL_NOT_FILLABLE",
			HTTPStatus: http.StatusConflict,
			Message:    fmt.Sprintf("proposal #%d is %s and cannot be filled", prop.ID, prop.Status),
		}
	}

	var origJobID *uint
	if prop.JobID != nil {
		v := *prop.JobID
		origJobID = &v
	}
	origUpworkJobID := prop.UpworkJobID
	origCoverLetter := prop.CoverLetter
	origBidType := prop.BidType
	var origBidAmount *float64
	if prop.BidAmount != nil {
		v := *prop.BidAmount
		origBidAmount = &v
	}
	origRateIncrease := prop.RateIncrease
	var origBoostConnects *int
	if prop.BoostConnects != nil {
		v := *prop.BoostConnects
		origBoostConnects = &v
	}
	origMilestones := append([]byte(nil), prop.MilestonesJSON...)
	origScreening := append([]byte(nil), prop.ScreeningAnswersJSON...)

	upworkJobID := prop.UpworkJobID
	if upworkJobID == "" && prop.Job != nil && prop.Job.UpworkJobID != nil {
		upworkJobID = *prop.Job.UpworkJobID
	}
	applyURL := resolveApplyURL(upworkJobID, body.ApplyURL)
	rateIncrease := firstNonEmpty(body.RateIncrease, prop.RateIncrease)

	wsParams := map[string]any{
		"proposal_id":   prop.ID,
		"upwork_job_id": upworkJobID,
		"cover_letter":  prop.CoverLetter,
		"bid_type":      prop.BidType,
	}
	if applyURL != "" {
		wsParams["apply_url"] = applyURL
	}
	if prop.BidAmount != nil {
		wsParams["bid_amount"] = *prop.BidAmount
	}
	if rateIncrease != "" {
		wsParams["rate_increase"] = rateIncrease
	}
	if len(prop.MilestonesJSON) > 0 {
		wsParams["milestones"] = json.RawMessage(prop.MilestonesJSON)
	}
	if len(prop.ScreeningAnswersJSON) > 0 {
		wsParams["screening_answers"] = json.RawMessage(prop.ScreeningAnswersJSON)
	}
	if prop.BoostConnects != nil {
		wsParams["boost_connects"] = *prop.BoostConnects
	}

	eng := s.PolicyEngine()
	rawRes, callErr := s.bridgeHub.CallExtension(ctx, "proposal.fill", wsParams, 2*time.Minute)
	if callErr != nil {
		if errors.Is(callErr, bridge.ErrHumanActionRequired) {
			s.auditBridgeChallenge("proposal_fill", strconv.FormatUint(id, 10), callErr)
		} else {
			_ = eng.RecordAudit(policy.AuditEntry{
				ActionType: "proposal_fill_failed",
				Actor:      "extension",
				TargetID:   strconv.FormatUint(id, 10),
				Outcome:    "blocked",
				Details:    map[string]any{"error": callErr.Error()},
			})
		}
		return nil, callErr
	}

	var snap proposalVerificationSnapshot
	if err := json.Unmarshal(rawRes, &snap); err != nil {
		return nil, &ServiceError{Code: "INVALID_RPC_RESULT", HTTPStatus: http.StatusBadGateway, Message: "Invalid proposal verification snapshot from extension"}
	}
	if snap.InsufficientConnects || (snap.AvailableConnects != nil && snap.TotalConnects > *snap.AvailableConnects) {
		_ = eng.RecordAudit(policy.AuditEntry{
			ActionType: "proposal_fill_failed",
			Actor:      "extension",
			TargetID:   strconv.FormatUint(id, 10),
			Outcome:    "blocked",
			Details: map[string]any{
				"error_code":         "INSUFFICIENT_CONNECTS",
				"total_connects":     snap.TotalConnects,
				"available_connects": snap.AvailableConnects,
			},
		})
		return nil, &ServiceError{
			Code:       "INSUFFICIENT_CONNECTS",
			HTTPStatus: http.StatusUnprocessableEntity,
			Message:    fmt.Sprintf("INSUFFICIENT_CONNECTS: proposal requires %d connects", snap.TotalConnects),
			Details: map[string]any{
				"snapshot": json.RawMessage(rawRes),
			},
		}
	}

	snapJSONB, err := parseFlexibleJSONB(rawRes)
	if err != nil {
		return nil, &ServiceError{Code: "INVALID_RPC_RESULT", HTTPStatus: http.StatusBadGateway, Message: "Malformed verification snapshot JSON"}
	}

	token, expiresAt, err := eng.GenerateApprovalToken()
	if err != nil {
		return nil, &ServiceError{Code: "INTERNAL_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to generate approval token"}
	}

	var updated dbservice.Proposal
	var fillConflictErr error
	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
			return err
		}
		var locked dbservice.Proposal
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&locked, id).Error; err != nil {
			return err
		}
		if isTerminalOrInFlightProposalStatus(locked.Status) {
			fillConflictErr = &ServiceError{
				Code:       "ALREADY_SUBMITTED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("proposal #%d is already %s and cannot be re-filled", locked.ID, locked.Status),
			}
			return nil
		}
		if locked.Status == "rejected" || locked.Status == "archived" ||
			!equalUintPtr(locked.JobID, origJobID) ||
			locked.UpworkJobID != origUpworkJobID ||
			locked.CoverLetter != origCoverLetter ||
			locked.BidType != origBidType ||
			!equalFloat64Ptr(locked.BidAmount, origBidAmount) ||
			locked.RateIncrease != origRateIncrease ||
			!equalIntPtr(locked.BoostConnects, origBoostConnects) ||
			!bytes.Equal(bytes.TrimSpace(locked.MilestonesJSON), bytes.TrimSpace(origMilestones)) ||
			!bytes.Equal(bytes.TrimSpace(locked.ScreeningAnswersJSON), bytes.TrimSpace(origScreening)) {
			fillConflictErr = &ServiceError{
				Code:       "PROPOSAL_MODIFIED_DURING_FILL",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("proposal #%d was modified or %s during fill; re-fill before approving", locked.ID, locked.Status),
			}
			return nil
		}
		locked.VerificationSnapshotJSON = snapJSONB
		if snap.ConnectsCost != nil {
			locked.ConnectsRequired = snap.ConnectsCost
		}
		if rateIncrease != "" {
			locked.RateIncrease = rateIncrease
		}
		locked.Status = "pending_approval"
		locked.ApprovalToken = token
		locked.ApprovalTokenExpiresAt = &expiresAt
		locked.ApprovedAt = nil
		if err := tx.Save(&locked).Error; err != nil {
			return err
		}
		updated = locked

		return policy.RecordAuditTx(tx, policy.AuditEntry{
			ActionType: "proposal_filled",
			Actor:      "extension",
			TargetID:   strconv.FormatUint(id, 10),
			Outcome:    "pending_approval",
			Details: map[string]any{
				"upwork_job_id":                 upworkJobID,
				"total_connects":                snap.TotalConnects,
				"unanswered_required_questions": snap.UnansweredRequiredQuestions,
			},
		})
	})
	if fillConflictErr != nil {
		return nil, fillConflictErr
	}
	if txErr != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to persist filled proposal"}
	}

	_ = gormDB.Preload("Job").First(&updated, updated.ID).Error
	entry := proposalEntryFromModel(updated)
	coverLen := snap.CoverLetterLength
	if coverLen == 0 {
		coverLen = len(strings.TrimSpace(updated.CoverLetter))
	}
	bidType := firstNonEmpty(snap.BidType, updated.BidType)
	bidAmount := snap.BidAmount
	if bidAmount == nil {
		bidAmount = updated.BidAmount
	}
	totalConnects := snap.TotalConnects
	if totalConnects == 0 {
		totalConnects = entry.TotalConnects
	}
	connectsCost := snap.ConnectsCost
	if connectsCost == nil {
		connectsCost = updated.ConnectsRequired
	}
	screeningAnswers := bytes.TrimSpace(snap.ScreeningAnswers)
	if len(screeningAnswers) == 0 || bytes.Equal(screeningAnswers, []byte("null")) {
		screeningAnswers = json.RawMessage("[]")
	}

	return &FillProposalResult{
		Proposal:          entry,
		Snapshot:          json.RawMessage(rawRes),
		ApprovalToken:     token,
		ExpiresAt:         expiresAt.UTC().Format(time.RFC3339),
		Status:            updated.Status,
		CoverLetterLength: coverLen,
		BidType:           bidType,
		BidAmount:         bidAmount,
		TotalConnects:     totalConnects,
		ConnectsCost:      connectsCost,
		AvailableConnects: snap.AvailableConnects,
		ScreeningAnswers:  screeningAnswers,
	}, nil
}

// CommitProposal executes the three-phase advisory-locked policy gate + WS RPC + compensation commit for a proposal.
func (s *Server) CommitProposal(ctx context.Context, id uint64, req CommitProposalInput, humanApproved bool) (*CommitProposalResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if id == 0 || id > math.MaxInt64 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid proposal ID"}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	eng := s.PolicyEngine()

	var claimed dbservice.Proposal
	var prevStatus string
	var prevToken string
	var prevTokenExp *time.Time
	var prevApprovedAt *time.Time
	var policyMode string
	var applyURL string
	var connectsCost int
	var rejectionErr error

	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
			return err
		}

		policyRow, err := eng.EnsurePolicyRowLocked(tx)
		if err != nil {
			return err
		}
		policyMode = policyRow.Mode

		var prop dbservice.Proposal
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&prop, id).Error; err != nil {
			return err
		}
		if prop.JobID != nil {
			var job dbservice.Job
			if jErr := tx.First(&job, *prop.JobID).Error; jErr == nil {
				prop.Job = &job
			}
		}

		if isTerminalOrInFlightProposalStatus(prop.Status) {
			rejectionErr = &policy.PolicyError{
				Code:       "ALREADY_SUBMITTED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("proposal #%d is already %s", prop.ID, prop.Status),
			}
			return nil
		}
		if prop.Status == "failed" {
			rejectionErr = &policy.PolicyError{
				Code:       "PROPOSAL_REFILL_REQUIRED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("proposal #%d is in failed state; re-fill the proposal form before submitting", prop.ID),
			}
			return nil
		}
		if prop.Status == "rejected" || prop.Status == "archived" {
			rejectionErr = &policy.PolicyError{
				Code:       "PROPOSAL_NOT_SUBMITTABLE",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("proposal #%d is %s and cannot be submitted", prop.ID, prop.Status),
			}
			return nil
		}

		// Screening questions required check (blocks BOTH /approve and /submit!)
		if unanswered := countUnansweredRequiredQuestions(prop, prop.Job); unanswered > 0 {
			_ = policy.RecordAuditTx(tx, policy.AuditEntry{
				ActionType: "proposal_blocked",
				Actor:      "policy",
				TargetID:   strconv.FormatUint(id, 10),
				PolicyMode: policyMode,
				Outcome:    "blocked",
				Details:    map[string]any{"reason": "SCREENING_QUESTIONS_REQUIRED", "unanswered": unanswered},
			})
			rejectionErr = &bridge.BridgeError{
				Code:    "SCREENING_QUESTIONS_REQUIRED",
				Message: fmt.Sprintf("%d required screening question(s) are unanswered", unanswered),
			}
			return nil
		}

		// Insufficient connects check against snapshot
		connectsCost = proposalConnectsCost(prop, prop.Job)
		if len(prop.VerificationSnapshotJSON) > 0 {
			var snap proposalVerificationSnapshot
			if json.Unmarshal(prop.VerificationSnapshotJSON, &snap) == nil {
				if snap.InsufficientConnects || (snap.AvailableConnects != nil && snap.TotalConnects > *snap.AvailableConnects) {
					_ = policy.RecordAuditTx(tx, policy.AuditEntry{
						ActionType: "proposal_blocked",
						Actor:      "policy",
						TargetID:   strconv.FormatUint(id, 10),
						PolicyMode: policyMode,
						Outcome:    "blocked",
						Details:    map[string]any{"reason": "INSUFFICIENT_CONNECTS", "total_connects": snap.TotalConnects},
					})
					rejectionErr = &bridge.BridgeError{
						Code:    "INSUFFICIENT_CONNECTS",
						Message: fmt.Sprintf("proposal requires %d connects, available %v", snap.TotalConnects, snap.AvailableConnects),
					}
					return nil
				}
			}
		}

		usage, err := eng.ComputeUsage(tx)
		if err != nil {
			return err
		}
		var jobScore *int
		if prop.Job != nil {
			jobScore = prop.Job.Score
		}

		if pErr := eng.EvaluateProposalSubmit(policy.ProposalAuthRequest{
			PolicyRow:     policyRow,
			Usage:         usage,
			Proposal:      prop,
			JobScore:      jobScore,
			ConnectsCost:  connectsCost,
			ProvidedToken: req.ApprovalToken,
			HumanApproved: humanApproved,
		}); pErr != nil {
			_ = policy.RecordAuditTx(tx, policy.AuditEntry{
				ActionType: "proposal_blocked",
				Actor:      "policy",
				TargetID:   strconv.FormatUint(id, 10),
				PolicyMode: policyMode,
				Outcome:    "blocked",
				Details:    map[string]any{"error_code": pErr.Code, "error": pErr.Message},
			})
			rejectionErr = pErr
			return nil
		}

		if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
			rejectionErr = bridge.ErrExtensionDisconnected
			return nil
		}

		prevStatus = prop.Status
		prevToken = prop.ApprovalToken
		prevTokenExp = prop.ApprovalTokenExpiresAt
		prevApprovedAt = prop.ApprovedAt

		now := time.Now().UTC()
		prop.Status = "submitting"
		prop.ApprovalToken = ""
		prop.ApprovalTokenExpiresAt = nil
		prop.ApprovedAt = &now
		if err := tx.Save(&prop).Error; err != nil {
			return err
		}
		claimed = prop
		upworkJobID := prop.UpworkJobID
		if upworkJobID == "" && prop.Job != nil && prop.Job.UpworkJobID != nil {
			upworkJobID = *prop.Job.UpworkJobID
		}
		applyURL = resolveApplyURL(upworkJobID, req.ApplyURL)
		return nil
	})
	if txErr != nil {
		if errors.Is(txErr, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Proposal not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to authorize proposal submission"}
	}
	if rejectionErr != nil {
		return nil, rejectionErr
	}

	// Phase 2: Execute proposal.submit RPC outside DB lock
	upworkJobID := claimed.UpworkJobID
	if upworkJobID == "" && claimed.Job != nil && claimed.Job.UpworkJobID != nil {
		upworkJobID = *claimed.Job.UpworkJobID
	}
	wsParams := map[string]any{
		"proposal_id":   claimed.ID,
		"upwork_job_id": upworkJobID,
		"cover_letter":  claimed.CoverLetter,
		"bid_type":      claimed.BidType,
	}
	if applyURL != "" {
		wsParams["apply_url"] = applyURL
	}
	if claimed.BidAmount != nil {
		wsParams["bid_amount"] = *claimed.BidAmount
	}
	if claimed.RateIncrease != "" {
		wsParams["rate_increase"] = claimed.RateIncrease
	}
	if len(claimed.MilestonesJSON) > 0 {
		wsParams["milestones"] = json.RawMessage(claimed.MilestonesJSON)
	}
	if len(claimed.ScreeningAnswersJSON) > 0 {
		wsParams["screening_answers"] = json.RawMessage(claimed.ScreeningAnswersJSON)
	}
	if claimed.BoostConnects != nil {
		wsParams["boost_connects"] = *claimed.BoostConnects
	}

	rawRes, callErr := s.bridgeHub.CallExtension(ctx, "proposal.submit", wsParams, 2*time.Minute)
	if callErr != nil {
		var be *bridge.BridgeError
		var bridgeCode string
		if errors.As(callErr, &be) && be != nil {
			bridgeCode = strings.ToUpper(strings.TrimSpace(be.Code))
		}
		markFailed := errors.Is(callErr, context.DeadlineExceeded) ||
			errors.Is(callErr, context.Canceled) ||
			bridgeCode == bridge.ErrCodeTimeout ||
			bridgeCode == "PROPOSAL_SUBMIT_UNCONFIRMED"

		phase3Ctx, phase3Cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer phase3Cancel()

		_ = s.db.GetGorm().WithContext(phase3Ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
				return err
			}
			var row dbservice.Proposal
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, id).Error; err != nil {
				return err
			}
			if markFailed {
				row.Status = "failed"
				row.ApprovalToken = ""
				row.ApprovalTokenExpiresAt = nil
			} else {
				restoreStatus := prevStatus
				if restoreStatus == "" || restoreStatus == "submitting" {
					restoreStatus = "draft"
				}
				row.Status = restoreStatus
				if restoreStatus == "pending_approval" && prevToken != "" {
					row.ApprovalToken = prevToken
					row.ApprovalTokenExpiresAt = prevTokenExp
					row.ApprovedAt = prevApprovedAt
				}
			}
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
			outcome := "failed"
			actionType := "proposal_submit_failed"
			if errors.Is(callErr, bridge.ErrHumanActionRequired) {
				outcome = "HUMAN_ACTION_REQUIRED"
				actionType = "human_action_required"
			}
			return policy.RecordAuditTx(tx, policy.AuditEntry{
				ActionType: actionType,
				Actor:      "extension",
				TargetID:   strconv.FormatUint(id, 10),
				PolicyMode: policyMode,
				Outcome:    outcome,
				Details:    map[string]any{"error": callErr.Error()},
			})
		})

		return nil, callErr
	}

	var submitOut struct {
		Submitted         bool   `json:"submitted"`
		UpworkProposalURL string `json:"upwork_proposal_url"`
		ConfirmationURL   string `json:"confirmation_url"`
	}
	_ = json.Unmarshal(rawRes, &submitOut)
	proposalURL := firstNonEmpty(submitOut.UpworkProposalURL, submitOut.ConfirmationURL)

	phase3Ctx, phase3Cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer phase3Cancel()

	var finalized dbservice.Proposal
	finErr := s.db.GetGorm().WithContext(phase3Ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
			return err
		}
		var row dbservice.Proposal
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, id).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		row.Status = "submitted"
		row.SubmittedAt = &now
		if proposalURL != "" {
			row.UpworkProposalURL = proposalURL
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		finalized = row

		if row.JobID != nil {
			_ = tx.Model(&dbservice.Job{}).
				Where("id = ?", *row.JobID).
				Updates(map[string]any{
					"status":     "applied",
					"applied_at": &now,
				}).Error
		}

		actor := "agent"
		if humanApproved {
			actor = "user"
		}
		return policy.RecordAuditTx(tx, policy.AuditEntry{
			ActionType: "proposal_submitted",
			Actor:      actor,
			TargetID:   strconv.FormatUint(id, 10),
			PolicyMode: policyMode,
			Outcome:    "success",
			Details: map[string]any{
				"upwork_job_id":       upworkJobID,
				"upwork_proposal_url": proposalURL,
				"connects_cost":       connectsCost,
			},
		})
	})
	if finErr != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Proposal submitted in Upwork but failed to finalize DB state"}
	}

	_ = s.db.GetGorm().WithContext(phase3Ctx).Preload("Job").First(&finalized, finalized.ID).Error
	return &CommitProposalResult{
		Proposal:          proposalEntryFromModel(finalized),
		Submitted:         true,
		Status:            finalized.Status,
		UpworkProposalURL: finalized.UpworkProposalURL,
	}, nil
}

// SyncProposals scrapes /nx/proposals/ via the extension and upserts synced proposal statuses into Postgres.
func (s *Server) SyncProposals(ctx context.Context) (*SyncProposalsResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	rawRes, callErr := s.bridgeHub.CallExtension(ctx, "proposals.sync", map[string]any{}, 2*time.Minute)
	if callErr != nil {
		s.auditBridgeChallenge("proposals_sync", "", callErr)
		return nil, callErr
	}

	var syncOut struct {
		Proposals []struct {
			UpworkJobID       string   `json:"upwork_job_id"`
			UpworkProposalID  string   `json:"upwork_proposal_id"`
			UpworkProposalURL string   `json:"upwork_proposal_url"`
			ProposalURL       string   `json:"proposal_url"`
			JobURL            string   `json:"job_url"`
			JobTitle          string   `json:"job_title"`
			Status            string   `json:"status"`
			BidAmount         *float64 `json:"bid_amount"`
			Connects          *int     `json:"connects"`
			SubmittedAt       string   `json:"submitted_at"`
		} `json:"proposals"`
	}
	if err := json.Unmarshal(rawRes, &syncOut); err != nil {
		return nil, &ServiceError{Code: "INVALID_RPC_RESULT", HTTPStatus: http.StatusBadGateway, Message: "Invalid proposals.sync RPC result"}
	}

	type normItem struct {
		origIdx     int
		sortKey     string
		upworkJobID string
		proposalURL string
		jobTitle    string
		status      string
		bidAmount   *float64
		connects    *int
		submittedAt *time.Time
	}

	items := make([]normItem, 0, len(syncOut.Proposals))
	for i, p := range syncOut.Proposals {
		upworkJobID := firstNonEmpty(
			scoring.NormalizeUpworkJobID(p.UpworkJobID),
			scoring.ExtractUpworkJobID(p.JobURL),
		)
		propURL := firstNonEmpty(p.UpworkProposalURL, p.ProposalURL)
		var parsedSub *time.Time
		if ts := strings.TrimSpace(p.SubmittedAt); ts != "" {
			if t, err := time.Parse(time.RFC3339, ts); err == nil {
				parsedSub = &t
			}
		}
		items = append(items, normItem{
			origIdx:     i,
			sortKey:     upworkJobID + "|" + propURL + "|" + strings.ToLower(strings.TrimSpace(p.JobTitle)),
			upworkJobID: upworkJobID,
			proposalURL: propURL,
			jobTitle:    strings.TrimSpace(p.JobTitle),
			status:      normalizeSyncedProposalStatus(p.Status),
			bidAmount:   p.BidAmount,
			connects:    p.Connects,
			submittedAt: parsedSub,
		})
	}
	ordered := make([]normItem, len(items))
	copy(ordered, items)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].sortKey != ordered[j].sortKey {
			return ordered[i].sortKey < ordered[j].sortKey
		}
		return ordered[i].origIdx < ordered[j].origIdx
	})

	gormDB := s.db.GetGorm().WithContext(ctx)
	const maxTxAttempts = 4
	var entries []ProposalEntry

	for attempt := 0; attempt < maxTxAttempts; attempt++ {
		attemptEntries := make([]ProposalEntry, len(ordered))
		txErr := gormDB.Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
				return err
			}
			for _, item := range ordered {
				var existing dbservice.Proposal
				var findErr error
				switch {
				case item.proposalURL != "" && item.upworkJobID != "":
					findErr = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
						Where("upwork_proposal_url = ? OR upwork_job_id = ?", item.proposalURL, item.upworkJobID).
						Order("id DESC").
						First(&existing).Error
				case item.proposalURL != "":
					findErr = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
						Where("upwork_proposal_url = ?", item.proposalURL).
						First(&existing).Error
				case item.upworkJobID != "":
					findErr = tx.Clauses(clause.Locking{Strength: "UPDATE"}).
						Where("upwork_job_id = ?", item.upworkJobID).
						Order("id DESC").
						First(&existing).Error
				default:
					findErr = gorm.ErrRecordNotFound
				}

				if findErr == nil {
					existing.Status = item.status
					if isTerminalOrInFlightProposalStatus(item.status) || item.status == "archived" || item.status == "rejected" || item.status == "failed" {
						existing.ApprovalToken = ""
						existing.ApprovalTokenExpiresAt = nil
					}
					if item.proposalURL != "" {
						existing.UpworkProposalURL = item.proposalURL
					}
					if item.upworkJobID != "" && existing.UpworkJobID == "" {
						existing.UpworkJobID = item.upworkJobID
					}
					if item.bidAmount != nil {
						existing.BidAmount = item.bidAmount
					}
					if item.connects != nil {
						existing.ConnectsRequired = item.connects
					}
					if item.submittedAt != nil && existing.SubmittedAt == nil {
						existing.SubmittedAt = item.submittedAt
					}
					if err := tx.Save(&existing).Error; err != nil {
						return err
					}
					if existing.JobID != nil {
						var j dbservice.Job
						if tx.First(&j, *existing.JobID).Error == nil {
							existing.Job = &j
						}
					}
					entry := proposalEntryFromModel(existing)
					if entry.JobTitle == "" {
						entry.JobTitle = item.jobTitle
					}
					attemptEntries[item.origIdx] = entry
					continue
				}
				if !errors.Is(findErr, gorm.ErrRecordNotFound) {
					return findErr
				}

				var linkedJob *dbservice.Job
				if item.upworkJobID != "" {
					var j dbservice.Job
					if err := tx.Where("upwork_job_id = ?", item.upworkJobID).First(&j).Error; err == nil {
						linkedJob = &j
					}
				}
				created := dbservice.Proposal{
					UpworkJobID:       item.upworkJobID,
					Status:            item.status,
					UpworkProposalURL: item.proposalURL,
					BidAmount:         item.bidAmount,
					ConnectsRequired:  item.connects,
					SubmittedAt:       item.submittedAt,
				}
				if linkedJob != nil {
					created.JobID = &linkedJob.ID
				}
				if err := tx.Create(&created).Error; err != nil {
					return err
				}
				created.Job = linkedJob
				entry := proposalEntryFromModel(created)
				if entry.JobTitle == "" {
					entry.JobTitle = item.jobTitle
				}
				attemptEntries[item.origIdx] = entry
			}
			return nil
		})
		if txErr == nil {
			entries = attemptEntries
			break
		}
		if !isRetryableTxError(txErr) || attempt == maxTxAttempts-1 {
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to sync proposals"}
		}
		time.Sleep(time.Duration(5+rand.IntN(21)) * time.Millisecond)
	}

	_ = s.PolicyEngine().RecordAudit(policy.AuditEntry{
		ActionType: "proposals_synced",
		Actor:      "extension",
		Outcome:    "success",
		Details:    map[string]any{"synced_count": len(entries)},
	})

	return &SyncProposalsResult{
		Proposals:   entries,
		SyncedCount: len(entries),
	}, nil
}

func (s *Server) listProposalsHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	q := r.URL.Query()
	filter := ListProposalsFilter{
		Status:      strings.TrimSpace(q.Get("status")),
		UpworkJobID: strings.TrimSpace(q.Get("upwork_job_id")),
	}
	if jobIDRaw := strings.TrimSpace(q.Get("job_id")); jobIDRaw != "" {
		jobID, err := strconv.ParseUint(jobIDRaw, 10, 64)
		if err != nil || jobID == 0 || jobID > math.MaxInt64 {
			respondInvalidParams(w, "Invalid job_id parameter")
			return
		}
		filter.JobID = &jobID
	}
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil || limit <= 0 {
			respondWithError(w, http.StatusBadRequest, "Invalid limit parameter")
			return
		}
		filter.Limit = limit
	}
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		offset, err := strconv.Atoi(rawOffset)
		if err != nil || offset < 0 {
			respondWithError(w, http.StatusBadRequest, "Invalid offset parameter")
			return
		}
		filter.Offset = offset
	}

	entries, err := s.ListProposals(r.Context(), filter)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, map[string]any{"proposals": entries})
}

func (s *Server) getProposalHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractProposalIDParam(r)
	if err != nil || id == 0 {
		respondInvalidParams(w, "Invalid proposal ID")
		return
	}
	entry, getErr := s.GetProposal(r.Context(), id)
	if getErr != nil {
		respondBridgeError(w, getErr)
		return
	}
	respondWithJSON(w, map[string]any{"proposal": entry})
}

func (s *Server) saveProposalHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req SaveProposalInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	entry, created, err := s.SaveProposal(r.Context(), req, "api")
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	httpStatus := http.StatusOK
	if created {
		httpStatus = http.StatusCreated
	}
	respondWithJSONStatus(w, httpStatus, map[string]any{
		"proposal": entry,
	})
}

func (s *Server) fillProposalHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractProposalIDParam(r)
	if err != nil || id == 0 {
		respondInvalidParams(w, "Invalid proposal ID")
		return
	}

	var body FillProposalInput
	if r.Body != nil {
		decErr := json.NewDecoder(r.Body).Decode(&body)
		if decErr != nil && !errors.Is(decErr, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	res, fillErr := s.FillProposal(r.Context(), id, body)
	if fillErr != nil {
		var se *ServiceError
		if errors.As(fillErr, &se) && se != nil && se.Code == "INSUFFICIENT_CONNECTS" {
			respondWithJSONStatus(w, se.HTTPStatus, map[string]any{
				"error":      se.Message,
				"error_code": se.Code,
				"snapshot":   se.Details["snapshot"],
			})
			return
		}
		respondBridgeError(w, fillErr)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) approveProposalHandler(w http.ResponseWriter, r *http.Request) {
	s.executeProposalCommit(w, r, true)
}

func (s *Server) submitProposalHandler(w http.ResponseWriter, r *http.Request) {
	s.executeProposalCommit(w, r, false)
}

func (s *Server) executeProposalCommit(w http.ResponseWriter, r *http.Request, humanApproved bool) {
	extendWriteDeadline(w, 5*time.Minute)
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractProposalIDParam(r)
	if err != nil || id == 0 {
		respondInvalidParams(w, "Invalid proposal ID")
		return
	}

	var req CommitProposalInput
	if r.Body != nil {
		decErr := json.NewDecoder(r.Body).Decode(&req)
		if decErr != nil && !errors.Is(decErr, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	res, commitErr := s.CommitProposal(r.Context(), id, req, humanApproved)
	if commitErr != nil {
		respondBridgeError(w, commitErr)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) rejectProposalHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractProposalIDParam(r)
	if err != nil || id == 0 {
		respondInvalidParams(w, "Invalid proposal ID")
		return
	}

	gormDB := s.db.GetGorm()
	eng := s.PolicyEngine()

	var updated dbservice.Proposal
	var rejectionErr error
	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockProposals).Error; err != nil {
			return err
		}
		var row dbservice.Proposal
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, id).Error; err != nil {
			return err
		}
		if isTerminalOrInFlightProposalStatus(row.Status) {
			rejectionErr = &policy.PolicyError{
				Code:       "ALREADY_SUBMITTED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("proposal #%d is already %s and cannot be rejected", row.ID, row.Status),
			}
			return nil
		}
		row.Status = "rejected"
		row.ApprovalToken = ""
		row.ApprovalTokenExpiresAt = nil
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		updated = row
		policyRow, _ := eng.EnsurePolicyRow(tx)
		return policy.RecordAuditTx(tx, policy.AuditEntry{
			ActionType: "proposal_rejected",
			Actor:      "user",
			TargetID:   strconv.FormatUint(id, 10),
			PolicyMode: policyRow.Mode,
			Outcome:    "rejected",
		})
	})
	if txErr != nil {
		if errors.Is(txErr, gorm.ErrRecordNotFound) {
			respondWithError(w, http.StatusNotFound, "Proposal not found")
			return
		}
		respondWithError(w, http.StatusInternalServerError, "Failed to reject proposal")
		return
	}
	if rejectionErr != nil {
		respondBridgeError(w, rejectionErr)
		return
	}

	_ = gormDB.Preload("Job").First(&updated, updated.ID).Error
	respondWithJSON(w, map[string]any{
		"proposal": proposalEntryFromModel(updated),
		"status":   updated.Status,
	})
}

func (s *Server) syncProposalsHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)
	res, err := s.SyncProposals(r.Context())
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func equalFloat64Ptr(a, b *float64) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func equalIntPtr(a, b *int) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func equalUintPtr(a, b *uint) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
