package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

const advisoryLockMessages int64 = 7002

type threadEntry = ThreadEntry
type messageEntry = MessageEntry

// ThreadEntry is the API/MCP DTO for an Upwork message room.
type ThreadEntry struct {
	ID                 uint    `json:"id"`
	UpworkRoomID       string  `json:"upwork_room_id"`
	RoomID             string  `json:"room_id"`
	ClientName         string  `json:"client_name"`
	ClientCompany      string  `json:"client_company,omitempty"`
	JobTitle           string  `json:"job_title,omitempty"`
	JobID              *uint   `json:"job_id,omitempty"`
	UpworkJobID        string  `json:"upwork_job_id,omitempty"`
	ProposalID         *uint   `json:"proposal_id,omitempty"`
	UnreadCount        int     `json:"unread_count"`
	LastMessageSnippet string  `json:"last_message_snippet"`
	LastMessageAt      *string `json:"last_message_at,omitempty"`
	CreatedAt          string  `json:"created_at"`
	UpdatedAt          string  `json:"updated_at"`
}

// MessageEntry is the API/MCP DTO for a single message or draft in a room.
type MessageEntry struct {
	ID              uint            `json:"id"`
	ThreadID        uint            `json:"thread_id"`
	UpworkRoomID    string          `json:"upwork_room_id,omitempty"`
	RoomID          string          `json:"room_id,omitempty"`
	ClientName      string          `json:"client_name,omitempty"`
	JobTitle        string          `json:"job_title,omitempty"`
	UpworkMessageID string          `json:"upwork_message_id,omitempty"`
	Sender          string          `json:"sender"`
	SenderRole      string          `json:"sender_role"`
	Body            string          `json:"body"`
	SentAt          *string         `json:"sent_at,omitempty"`
	Timestamp       string          `json:"timestamp"`
	Attachments     json.RawMessage `json:"attachments,omitempty"`
	AttachmentsJSON json.RawMessage `json:"attachments_json,omitempty"`
	Card            json.RawMessage `json:"card,omitempty"`
	CardJSON        json.RawMessage `json:"card_json,omitempty"`
	IsDraft         bool            `json:"is_draft"`
	Status          string          `json:"status"`
	ApprovalToken   string          `json:"approval_token,omitempty"`
	ApprovedAt      *string         `json:"approved_at,omitempty"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
}

// SyncRoomPayload represents a room summary pushed by the extension or returned by messages.list.
type SyncRoomPayload struct {
	UpworkRoomID       string `json:"upwork_room_id"`
	RoomID             string `json:"room_id"`
	ClientName         string `json:"client_name"`
	ClientCompany      string `json:"client_company"`
	JobTitle           string `json:"job_title"`
	UpworkJobID        string `json:"upwork_job_id"`
	UnreadCount        int    `json:"unread_count"`
	LastMessageSnippet string `json:"last_message_snippet"`
	LastMessageAt      string `json:"last_message_at"`
}

// ListThreadsResult wraps listed/synced message threads and aggregate unread count.
type ListThreadsResult struct {
	Threads     []ThreadEntry `json:"threads"`
	TotalUnread int           `json:"total_unread"`
}

// ThreadMessagesResult wraps a message room and its ordered messages.
type ThreadMessagesResult struct {
	Thread   ThreadEntry    `json:"thread"`
	Messages []MessageEntry `json:"messages"`
}

// DraftMessageInput configures drafting (and optionally prefilling) a client message reply.
type DraftMessageInput struct {
	RoomID          string `json:"room_id"`
	UpworkRoomID    string `json:"upwork_room_id"`
	Body            string `json:"body"`
	PrefillComposer bool   `json:"prefill_composer"`
}

// DraftMessageResult returns the persisted draft message and approval token.
type DraftMessageResult struct {
	Message       MessageEntry `json:"message"`
	ApprovalToken string       `json:"approval_token"`
	ExpiresAt     string       `json:"expires_at"`
	Status        string       `json:"status"`
}

// CommitMessageInput configures sending or approving an outbound message.
type CommitMessageInput struct {
	RoomID        string `json:"room_id"`
	UpworkRoomID  string `json:"upwork_room_id"`
	Body          string `json:"body"`
	ApprovalToken string `json:"approval_token"`
	MessageID     *uint  `json:"message_id"`
}

// CommitMessageResult summarizes a sent message.
type CommitMessageResult struct {
	Message MessageEntry `json:"message"`
	Sent    bool         `json:"sent"`
	Status  string       `json:"status"`
	RoomID  string       `json:"room_id"`
}

func threadEntryFromModel(t dbservice.MessageThread) threadEntry {
	upworkJobID := t.UpworkJobID
	if t.Job != nil && t.Job.UpworkJobID != nil && strings.TrimSpace(*t.Job.UpworkJobID) != "" {
		upworkJobID = *t.Job.UpworkJobID
	}
	return threadEntry{
		ID:                 t.ID,
		UpworkRoomID:       t.UpworkRoomID,
		RoomID:             t.UpworkRoomID,
		ClientName:         t.ClientName,
		ClientCompany:      t.ClientCompany,
		JobTitle:           t.JobTitle,
		JobID:              t.JobID,
		UpworkJobID:        upworkJobID,
		ProposalID:         t.ProposalID,
		UnreadCount:        t.UnreadCount,
		LastMessageSnippet: t.LastMessageSnippet,
		LastMessageAt:      formatOptTime(t.LastMessageAt),
		CreatedAt:          t.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:          t.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func messageEntryFromModel(m dbservice.Message) messageEntry {
	var upworkID string
	if m.UpworkMessageID != nil {
		upworkID = *m.UpworkMessageID
	}
	att := rawJSONFromJSONB(m.AttachmentsJSON)
	card := rawJSONFromJSONB(m.CardJSON)
	sentStr := formatOptTime(m.SentAt)
	ts := m.CreatedAt.UTC().Format(time.RFC3339)
	if sentStr != nil {
		ts = *sentStr
	}
	var roomID, clientName, jobTitle string
	if m.Thread != nil {
		roomID = m.Thread.UpworkRoomID
		clientName = m.Thread.ClientName
		jobTitle = m.Thread.JobTitle
	}
	var tok string
	if m.IsDraft || m.Status == "pending_approval" {
		tok = m.ApprovalToken
	}
	return messageEntry{
		ID:              m.ID,
		ThreadID:        m.ThreadID,
		UpworkRoomID:    roomID,
		RoomID:          roomID,
		ClientName:      clientName,
		JobTitle:        jobTitle,
		UpworkMessageID: upworkID,
		Sender:          m.Sender,
		SenderRole:      m.SenderRole,
		Body:            m.Body,
		SentAt:          sentStr,
		Timestamp:       ts,
		Attachments:     att,
		AttachmentsJSON: att,
		Card:            card,
		CardJSON:        card,
		IsDraft:         m.IsDraft,
		Status:          m.Status,
		ApprovalToken:   tok,
		ApprovedAt:      formatOptTime(m.ApprovedAt),
		CreatedAt:       m.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:       m.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func extractRoomIDParam(r *http.Request) string {
	roomID := strings.TrimSpace(r.PathValue("roomId"))
	if roomID != "" {
		return roomID
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/messages/threads/")
	if idx := strings.Index(path, "/"); idx != -1 {
		path = path[:idx]
	}
	return strings.TrimSpace(path)
}

func extractMessageIDParam(r *http.Request) (uint64, error) {
	idStr := strings.TrimSpace(r.PathValue("id"))
	if idStr == "" {
		path := strings.TrimPrefix(r.URL.Path, "/api/messages/")
		if idx := strings.Index(path, "/"); idx != -1 {
			path = path[:idx]
		}
		idStr = strings.TrimSpace(path)
	}
	return strconv.ParseUint(idStr, 10, 64)
}

func parseFlexibleTimestamp(raw string) *time.Time {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.Parse(layout, trimmed); err == nil {
			utc := t.UTC()
			return &utc
		}
	}
	return nil
}

func truncateSnippet(s string, maxLen int) string {
	trimmed := strings.TrimSpace(s)
	runes := []rune(trimmed)
	if len(runes) <= maxLen {
		return trimmed
	}
	return string(runes[:maxLen-1]) + "…"
}

func resolveJobAndProposalForRoom(tx *gorm.DB, upworkJobID string, jobTitle string) (*uint, *uint) {
	if tx == nil {
		return nil, nil
	}
	normJobID := scoring.NormalizeUpworkJobID(upworkJobID)
	var jobID *uint
	var proposalID *uint

	if normJobID != "" {
		var job dbservice.Job
		if err := tx.Where("upwork_job_id = ?", normJobID).First(&job).Error; err == nil {
			jobID = &job.ID
			var prop dbservice.Proposal
			if pErr := tx.Where("job_id = ? OR upwork_job_id = ?", job.ID, normJobID).
				Order("id DESC").
				First(&prop).Error; pErr == nil {
				proposalID = &prop.ID
			}
			return jobID, proposalID
		}
		var prop dbservice.Proposal
		if pErr := tx.Where("upwork_job_id = ?", normJobID).
			Order("id DESC").
			First(&prop).Error; pErr == nil {
			proposalID = &prop.ID
			jobID = prop.JobID
			return jobID, proposalID
		}
	}

	if trimmedTitle := strings.TrimSpace(jobTitle); trimmedTitle != "" {
		var job dbservice.Job
		if err := tx.Where("LOWER(title) = LOWER(?)", trimmedTitle).
			Order("id DESC").
			First(&job).Error; err == nil {
			jobID = &job.ID
			var prop dbservice.Proposal
			if pErr := tx.Where("job_id = ?", job.ID).Order("id DESC").First(&prop).Error; pErr == nil {
				proposalID = &prop.ID
			}
		}
	}

	return jobID, proposalID
}

func upsertMessageThreadTx(
	tx *gorm.DB,
	roomID, clientName, clientCompany, jobTitle, upworkJobID, snippet string,
	unreadCount *int,
	lastMsgAt *time.Time,
) (dbservice.MessageThread, error) {
	normUpworkJobID := firstNonEmpty(scoring.NormalizeUpworkJobID(upworkJobID), strings.TrimSpace(upworkJobID))
	jobID, proposalID := resolveJobAndProposalForRoom(tx, normUpworkJobID, jobTitle)

	var existing dbservice.MessageThread
	findErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("upwork_room_id = ?", roomID).
		First(&existing).Error
	if findErr == nil {
		if normUpworkJobID != "" {
			existing.UpworkJobID = normUpworkJobID
		}
		if strings.TrimSpace(clientName) != "" {
			existing.ClientName = strings.TrimSpace(clientName)
		}
		if strings.TrimSpace(clientCompany) != "" {
			existing.ClientCompany = strings.TrimSpace(clientCompany)
		}
		if strings.TrimSpace(jobTitle) != "" {
			existing.JobTitle = strings.TrimSpace(jobTitle)
		}
		if jobID != nil {
			existing.JobID = jobID
		}
		if proposalID != nil {
			existing.ProposalID = proposalID
		}
		if unreadCount != nil {
			existing.UnreadCount = *unreadCount
		}
		if strings.TrimSpace(snippet) != "" {
			existing.LastMessageSnippet = strings.TrimSpace(snippet)
		}
		if lastMsgAt != nil {
			existing.LastMessageAt = lastMsgAt
		}
		if err := tx.Save(&existing).Error; err != nil {
			return dbservice.MessageThread{}, err
		}
		return existing, nil
	}
	if !errors.Is(findErr, gorm.ErrRecordNotFound) {
		return dbservice.MessageThread{}, findErr
	}

	unread := 0
	if unreadCount != nil {
		unread = *unreadCount
	}
	candidate := dbservice.MessageThread{
		UpworkRoomID:       roomID,
		UpworkJobID:        normUpworkJobID,
		ClientName:         strings.TrimSpace(clientName),
		ClientCompany:      strings.TrimSpace(clientCompany),
		JobTitle:           strings.TrimSpace(jobTitle),
		JobID:              jobID,
		ProposalID:         proposalID,
		UnreadCount:        unread,
		LastMessageSnippet: strings.TrimSpace(snippet),
		LastMessageAt:      lastMsgAt,
	}
	res := tx.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "upwork_room_id"}},
		DoNothing: true,
	}).Create(&candidate)
	if res.Error != nil {
		return dbservice.MessageThread{}, res.Error
	}
	if res.RowsAffected > 0 {
		return candidate, nil
	}

	var locked dbservice.MessageThread
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("upwork_room_id = ?", roomID).
		First(&locked).Error; err != nil {
		return dbservice.MessageThread{}, err
	}
	if normUpworkJobID != "" {
		locked.UpworkJobID = normUpworkJobID
	}
	if strings.TrimSpace(clientName) != "" {
		locked.ClientName = strings.TrimSpace(clientName)
	}
	if strings.TrimSpace(clientCompany) != "" {
		locked.ClientCompany = strings.TrimSpace(clientCompany)
	}
	if strings.TrimSpace(jobTitle) != "" {
		locked.JobTitle = strings.TrimSpace(jobTitle)
	}
	if jobID != nil {
		locked.JobID = jobID
	}
	if proposalID != nil {
		locked.ProposalID = proposalID
	}
	if unreadCount != nil {
		locked.UnreadCount = *unreadCount
	}
	if strings.TrimSpace(snippet) != "" {
		locked.LastMessageSnippet = strings.TrimSpace(snippet)
	}
	if lastMsgAt != nil {
		locked.LastMessageAt = lastMsgAt
	}
	if err := tx.Save(&locked).Error; err != nil {
		return dbservice.MessageThread{}, err
	}
	return locked, nil
}

func syntheticMessageID(roomID, sender, sentAtRaw, body string) string {
	sum := sha256.Sum256([]byte(roomID + "|" + strings.TrimSpace(sender) + "|" + strings.TrimSpace(sentAtRaw) + "|" + strings.TrimSpace(body)))
	return "synth:" + hex.EncodeToString(sum[:])
}

// ListThreads queries persisted message rooms ordered by most recent message.
func (s *Server) ListThreads(ctx context.Context, unreadOnly bool) (*ListThreadsResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	db := s.db.GetGorm().WithContext(ctx).Model(&dbservice.MessageThread{}).Preload("Job")
	if unreadOnly {
		db = db.Where("unread_count > 0")
	}

	var rows []dbservice.MessageThread
	if err := db.Order("last_message_at DESC NULLS LAST, id DESC").Find(&rows).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to list message threads"}
	}

	entries := make([]ThreadEntry, 0, len(rows))
	totalUnread := 0
	for _, row := range rows {
		totalUnread += row.UnreadCount
		entries = append(entries, threadEntryFromModel(row))
	}
	return &ListThreadsResult{
		Threads:     entries,
		TotalUnread: totalUnread,
	}, nil
}

// SyncThreads syncs rooms from the provided slice or via extension messages.list RPC and persists to Postgres.
func (s *Server) SyncThreads(ctx context.Context, rooms []SyncRoomPayload) (*ListThreadsResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	if len(rooms) == 0 {
		if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
			return nil, bridge.ErrExtensionDisconnected
		}

		rawRes, callErr := s.bridgeHub.CallExtension(ctx, "messages.list", map[string]any{}, 2*time.Minute)
		if callErr != nil {
			s.auditBridgeChallenge("messages_list", "", callErr)
			return nil, callErr
		}

		var listOut struct {
			Rooms []SyncRoomPayload `json:"rooms"`
		}
		if err := json.Unmarshal(rawRes, &listOut); err != nil {
			return nil, &ServiceError{Code: "INVALID_RPC_RESULT", HTTPStatus: http.StatusBadGateway, Message: "Invalid messages.list RPC result"}
		}
		rooms = listOut.Rooms
	}

	type roomItem struct {
		origIdx     int
		roomID      string
		clientName  string
		company     string
		jobTitle    string
		upworkJobID string
		unread      int
		snippet     string
		lastMsgAt   *time.Time
	}

	ordered := make([]roomItem, 0, len(rooms))
	for i, rm := range rooms {
		roomID := firstNonEmpty(rm.UpworkRoomID, rm.RoomID)
		if roomID == "" {
			continue
		}
		ordered = append(ordered, roomItem{
			origIdx:     i,
			roomID:      roomID,
			clientName:  rm.ClientName,
			company:     rm.ClientCompany,
			jobTitle:    rm.JobTitle,
			upworkJobID: rm.UpworkJobID,
			unread:      rm.UnreadCount,
			snippet:     rm.LastMessageSnippet,
			lastMsgAt:   parseFlexibleTimestamp(rm.LastMessageAt),
		})
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].roomID < ordered[j].roomID
	})

	gormDB := s.db.GetGorm().WithContext(ctx)
	const maxTxAttempts = 4
	var entries []ThreadEntry
	totalUnread := 0

	for attempt := 0; attempt < maxTxAttempts; attempt++ {
		attemptEntries := make([]ThreadEntry, 0, len(ordered))
		attemptUnread := 0
		txErr := gormDB.Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
				return err
			}
			for _, item := range ordered {
				unread := item.unread
				saved, err := upsertMessageThreadTx(
					tx,
					item.roomID,
					item.clientName,
					item.company,
					item.jobTitle,
					item.upworkJobID,
					item.snippet,
					&unread,
					item.lastMsgAt,
				)
				if err != nil {
					return err
				}
				if saved.JobID != nil {
					var j dbservice.Job
					if tx.First(&j, *saved.JobID).Error == nil {
						saved.Job = &j
					}
				}
				attemptUnread += saved.UnreadCount
				attemptEntries = append(attemptEntries, threadEntryFromModel(saved))
			}
			return nil
		})
		if txErr == nil {
			entries = attemptEntries
			totalUnread = attemptUnread
			break
		}
		if !isRetryableTxError(txErr) || attempt == maxTxAttempts-1 {
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to sync message threads"}
		}
		time.Sleep(time.Duration(5+rand.IntN(21)) * time.Millisecond)
	}

	_ = s.PolicyEngine().RecordAudit(policy.AuditEntry{
		ActionType: "messages_synced",
		Actor:      "extension",
		Outcome:    "success",
		Details: map[string]any{
			"thread_count": len(entries),
			"total_unread": totalUnread,
		},
	})

	return &ListThreadsResult{
		Threads:     entries,
		TotalUnread: totalUnread,
	}, nil
}

// GetThread loads a message thread and its messages from Postgres.
func (s *Server) GetThread(ctx context.Context, roomID string) (*ThreadMessagesResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	roomID = strings.TrimSpace(roomID)
	if roomID == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "roomId is required"}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	var thread dbservice.MessageThread
	if err := gormDB.Preload("Job").Where("upwork_room_id = ?", roomID).First(&thread).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, &ServiceError{Code: "ROOM_NOT_FOUND", HTTPStatus: http.StatusNotFound, Message: "Conversation not found"}
		}
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load thread"}
	}

	var msgs []dbservice.Message
	if err := gormDB.Preload("Thread").
		Where("thread_id = ?", thread.ID).
		Order("sent_at ASC NULLS LAST, id ASC").
		Find(&msgs).Error; err != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to load messages"}
	}

	msgEntries := make([]MessageEntry, 0, len(msgs))
	for _, m := range msgs {
		msgEntries = append(msgEntries, messageEntryFromModel(m))
	}

	return &ThreadMessagesResult{
		Thread:   threadEntryFromModel(thread),
		Messages: msgEntries,
	}, nil
}

// SyncThread fetches message history for a room via extension messages.get RPC and upserts into Postgres.
func (s *Server) SyncThread(ctx context.Context, roomID string) (*ThreadMessagesResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	roomID = strings.TrimSpace(roomID)
	if roomID == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "roomId is required"}
	}
	if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
		return nil, bridge.ErrExtensionDisconnected
	}

	rawRes, callErr := s.bridgeHub.CallExtension(ctx, "messages.get", map[string]any{
		"room_id": roomID,
	}, 2*time.Minute)
	if callErr != nil {
		s.auditBridgeChallenge("messages_get", roomID, callErr)
		return nil, callErr
	}

	var getOut struct {
		UpworkRoomID  string `json:"upwork_room_id"`
		RoomID        string `json:"room_id"`
		ClientName    string `json:"client_name"`
		ClientCompany string `json:"client_company"`
		JobTitle      string `json:"job_title"`
		UpworkJobID   string `json:"upwork_job_id"`
		UnreadCount   *int   `json:"unread_count"`
		Messages      []struct {
			UpworkMessageID string          `json:"upwork_message_id"`
			Sender          string          `json:"sender"`
			SenderRole      string          `json:"sender_role"`
			Body            string          `json:"body"`
			SentAt          string          `json:"sent_at"`
			Timestamp       string          `json:"timestamp"`
			Attachments     json.RawMessage `json:"attachments"`
			AttachmentsJSON json.RawMessage `json:"attachments_json"`
			Card            json.RawMessage `json:"card"`
			CardJSON        json.RawMessage `json:"card_json"`
			InterviewCard   json.RawMessage `json:"interview_card"`
			OfferCard       json.RawMessage `json:"offer_card"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(rawRes, &getOut); err != nil {
		return nil, &ServiceError{Code: "INVALID_RPC_RESULT", HTTPStatus: http.StatusBadGateway, Message: "Invalid messages.get RPC result"}
	}

	canonicalRoomID := firstNonEmpty(getOut.UpworkRoomID, getOut.RoomID, roomID)

	type normMsg struct {
		msgID       string
		sender      string
		senderRole  string
		body        string
		sentAt      *time.Time
		attachments dbservice.JSONB
		card        dbservice.JSONB
	}

	normMsgs := make([]normMsg, 0, len(getOut.Messages))
	var latestSnippet string
	var latestAt *time.Time

	for _, m := range getOut.Messages {
		sentRaw := firstNonEmpty(m.SentAt, m.Timestamp)
		sentAt := parseFlexibleTimestamp(sentRaw)
		msgID := strings.TrimSpace(m.UpworkMessageID)
		if msgID == "" {
			msgID = syntheticMessageID(canonicalRoomID, m.Sender, sentRaw, m.Body)
		}

		attJSONB, _ := parseFlexibleJSONB(firstNonEmptyRawJSON(m.AttachmentsJSON, m.Attachments))
		rawCard := firstNonEmptyRawJSON(m.CardJSON, m.Card)
		if len(bytes.TrimSpace(rawCard)) == 0 {
			cardMap := map[string]json.RawMessage{}
			if len(bytes.TrimSpace(m.InterviewCard)) > 0 && !bytes.Equal(bytes.TrimSpace(m.InterviewCard), []byte("null")) {
				cardMap["interview_card"] = m.InterviewCard
			}
			if len(bytes.TrimSpace(m.OfferCard)) > 0 && !bytes.Equal(bytes.TrimSpace(m.OfferCard), []byte("null")) {
				cardMap["offer_card"] = m.OfferCard
			}
			if len(cardMap) > 0 {
				rawCard, _ = json.Marshal(cardMap)
			}
		}
		cardJSONB, _ := parseFlexibleJSONB(rawCard)

		role := strings.ToLower(strings.TrimSpace(m.SenderRole))
		if role == "" {
			role = "client"
		}

		normMsgs = append(normMsgs, normMsg{
			msgID:       msgID,
			sender:      strings.TrimSpace(m.Sender),
			senderRole:  role,
			body:        m.Body,
			sentAt:      sentAt,
			attachments: attJSONB,
			card:        cardJSONB,
		})
		if strings.TrimSpace(m.Body) != "" {
			latestSnippet = truncateSnippet(m.Body, 160)
		}
		if sentAt != nil {
			latestAt = sentAt
		}
	}

	sort.SliceStable(normMsgs, func(i, j int) bool {
		return normMsgs[i].msgID < normMsgs[j].msgID
	})

	gormDB := s.db.GetGorm().WithContext(ctx)
	const maxTxAttempts = 4
	var thread dbservice.MessageThread
	var msgs []dbservice.Message

	for attempt := 0; attempt < maxTxAttempts; attempt++ {
		txErr := gormDB.Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
				return err
			}

			savedThread, err := upsertMessageThreadTx(
				tx,
				canonicalRoomID,
				getOut.ClientName,
				getOut.ClientCompany,
				getOut.JobTitle,
				getOut.UpworkJobID,
				latestSnippet,
				getOut.UnreadCount,
				latestAt,
			)
			if err != nil {
				return err
			}

			for _, item := range normMsgs {
				mid := item.msgID
				candidate := dbservice.Message{
					ThreadID:        savedThread.ID,
					UpworkMessageID: &mid,
					Sender:          item.sender,
					SenderRole:      item.senderRole,
					Body:            item.body,
					SentAt:          item.sentAt,
					AttachmentsJSON: item.attachments,
					CardJSON:        item.card,
					IsDraft:         false,
					Status:          "received",
				}
				res := tx.Clauses(clause.OnConflict{
					Columns: []clause.Column{{Name: "upwork_message_id"}},
					TargetWhere: clause.Where{Exprs: []clause.Expression{
						clause.Expr{SQL: "upwork_message_id IS NOT NULL AND upwork_message_id <> ''"},
					}},
					DoNothing: true,
				}).Create(&candidate)
				if res.Error != nil {
					return res.Error
				}
				if res.RowsAffected == 0 {
					var existing dbservice.Message
					if fErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
						Where("upwork_message_id = ?", mid).
						First(&existing).Error; fErr == nil {
						changed := false
						if len(item.attachments) > 0 {
							existing.AttachmentsJSON = item.attachments
							changed = true
						}
						if len(item.card) > 0 {
							existing.CardJSON = item.card
							changed = true
						}
						if item.sentAt != nil && existing.SentAt == nil {
							existing.SentAt = item.sentAt
							changed = true
						}
						if changed {
							if sErr := tx.Save(&existing).Error; sErr != nil {
								return sErr
							}
						}
					}
				}
			}

			if err := tx.Preload("Job").First(&thread, savedThread.ID).Error; err != nil {
				return err
			}
			return tx.Preload("Thread").
				Where("thread_id = ?", savedThread.ID).
				Order("sent_at ASC NULLS LAST, id ASC").
				Find(&msgs).Error
		})
		if txErr == nil {
			break
		}
		if !isRetryableTxError(txErr) || attempt == maxTxAttempts-1 {
			return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to sync message thread"}
		}
		time.Sleep(time.Duration(5+rand.IntN(21)) * time.Millisecond)
	}

	msgEntries := make([]MessageEntry, 0, len(msgs))
	for _, m := range msgs {
		msgEntries = append(msgEntries, messageEntryFromModel(m))
	}

	return &ThreadMessagesResult{
		Thread:   threadEntryFromModel(thread),
		Messages: msgEntries,
	}, nil
}

// DraftMessage persists a message reply draft (and optionally prefills Chrome's composer) with pending_approval token.
func (s *Server) DraftMessage(ctx context.Context, req DraftMessageInput, actor string) (*DraftMessageResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if strings.TrimSpace(actor) == "" {
		actor = "agent"
	}

	roomID := firstNonEmpty(req.RoomID, req.UpworkRoomID)
	if roomID == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "room_id is required"}
	}
	if strings.TrimSpace(req.Body) == "" {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "body must not be empty"}
	}

	if req.PrefillComposer {
		if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
			return nil, bridge.ErrExtensionDisconnected
		}
		_, callErr := s.bridgeHub.CallExtension(ctx, "messages.draft", map[string]any{
			"room_id":          roomID,
			"body":             req.Body,
			"prefill_composer": true,
		}, 90*time.Second)
		if callErr != nil {
			s.auditBridgeChallenge("messages_draft", roomID, callErr)
			return nil, callErr
		}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	eng := s.PolicyEngine()
	token, expiresAt, err := eng.GenerateApprovalToken()
	if err != nil {
		return nil, &ServiceError{Code: "INTERNAL_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to generate approval token"}
	}

	var saved dbservice.Message
	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
			return err
		}
		thread, err := upsertMessageThreadTx(tx, roomID, "", "", "", "", "", nil, nil)
		if err != nil {
			return err
		}
		draft := dbservice.Message{
			ThreadID:               thread.ID,
			Sender:                 "Maxx Freelancer",
			SenderRole:             "freelancer",
			Body:                   req.Body,
			IsDraft:                true,
			Status:                 "pending_approval",
			ApprovalToken:          token,
			ApprovalTokenExpiresAt: &expiresAt,
		}
		if err := tx.Create(&draft).Error; err != nil {
			return err
		}
		saved = draft
		saved.Thread = &thread

		policyRow, _ := eng.EnsurePolicyRow(tx)
		return policy.RecordAuditTx(tx, policy.AuditEntry{
			ActionType: "message_drafted",
			Actor:      actor,
			TargetID:   roomID,
			PolicyMode: policyRow.Mode,
			Outcome:    "pending_approval",
			Details: map[string]any{
				"message_id":       draft.ID,
				"prefill_composer": req.PrefillComposer,
			},
		})
	})
	if txErr != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to persist message draft"}
	}

	return &DraftMessageResult{
		Message:       messageEntryFromModel(saved),
		ApprovalToken: token,
		ExpiresAt:     expiresAt.UTC().Format(time.RFC3339),
		Status:        saved.Status,
	}, nil
}

// CommitMessage executes the three-phase advisory-locked policy gate + WS RPC + compensation commit for sending a message.
func (s *Server) CommitMessage(ctx context.Context, req CommitMessageInput, humanApproved bool) (*CommitMessageResult, error) {
	if s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}

	var targetMessageID uint64
	if req.MessageID != nil && *req.MessageID > 0 {
		targetMessageID = uint64(*req.MessageID)
	}
	if humanApproved && targetMessageID == 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "Invalid message ID"}
	}

	r1 := strings.TrimSpace(req.RoomID)
	r2 := strings.TrimSpace(req.UpworkRoomID)
	if r1 != "" && r2 != "" && r1 != r2 {
		return nil, &policy.PolicyError{
			Code:       "INVALID_MESSAGE_TARGET",
			HTTPStatus: http.StatusConflict,
			Message:    fmt.Sprintf("INVALID_MESSAGE_TARGET: room_id %q does not match upwork_room_id %q", r1, r2),
		}
	}
	roomID := firstNonEmpty(r1, r2)
	if !humanApproved && roomID == "" && targetMessageID == 0 {
		return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "room_id is required"}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	eng := s.PolicyEngine()

	var claimedMsg dbservice.Message
	var claimedThread dbservice.MessageThread
	var isSyntheticStub bool
	var prevStatus string
	var prevIsDraft bool
	var prevToken string
	var prevTokenExp *time.Time
	var prevApprovedAt *time.Time
	var policyMode string
	var sendBody string
	var rejectionErr error

	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
			return err
		}

		policyRow, err := eng.EnsurePolicyRowLocked(tx)
		if err != nil {
			return err
		}
		policyMode = policyRow.Mode

		var draft *dbservice.Message
		if targetMessageID > 0 {
			var m dbservice.Message
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&m, targetMessageID).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					rejectionErr = &policy.PolicyError{
						Code:       "MESSAGE_NOT_FOUND",
						HTTPStatus: http.StatusNotFound,
						Message:    "Message draft not found",
					}
					return nil
				}
				return err
			}
			var th dbservice.MessageThread
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&th, m.ThreadID).Error; err != nil {
				return err
			}
			if roomID != "" && th.UpworkRoomID != roomID {
				rejectionErr = &policy.PolicyError{
					Code:       "INVALID_MESSAGE_TARGET",
					HTTPStatus: http.StatusConflict,
					Message:    fmt.Sprintf("INVALID_MESSAGE_TARGET: message #%d belongs to room %q, not %q", targetMessageID, th.UpworkRoomID, roomID),
				}
				return nil
			}
			claimedThread = th
			roomID = th.UpworkRoomID
			draft = &m
		} else {
			var th dbservice.MessageThread
			thErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("upwork_room_id = ?", roomID).
				First(&th).Error
			if thErr != nil && !errors.Is(thErr, gorm.ErrRecordNotFound) {
				return thErr
			}
			if thErr == nil {
				claimedThread = th
				if tok := strings.TrimSpace(req.ApprovalToken); tok != "" {
					var m dbservice.Message
					if mErr := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
						Where("thread_id = ? AND approval_token = ?", th.ID, tok).
						First(&m).Error; mErr == nil {
						draft = &m
					}
				}
			}
		}

		if draft != nil && (draft.SenderRole == "client" || draft.Status == "received") {
			rejectionErr = &policy.PolicyError{
				Code:       "INVALID_MESSAGE_TARGET",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("cannot send an inbound client message (#%d)", draft.ID),
			}
			return nil
		}
		if draft != nil && draft.Status == "rejected" {
			rejectionErr = &policy.PolicyError{
				Code:       "MESSAGE_REDRAFT_REQUIRED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("message #%d was rejected; create a new draft before sending", draft.ID),
			}
			return nil
		}
		if draft != nil && (draft.Status == "sending" || draft.Status == "sent") {
			rejectionErr = &policy.PolicyError{
				Code:       "ALREADY_SENT",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("message #%d is already %s", draft.ID, draft.Status),
			}
			return nil
		}
		if draft != nil && draft.Status == "failed" {
			rejectionErr = &policy.PolicyError{
				Code:       "MESSAGE_REDRAFT_REQUIRED",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("message #%d is in failed state; create a new draft before sending", draft.ID),
			}
			return nil
		}

		usage, err := eng.ComputeUsage(tx)
		if err != nil {
			return err
		}

		if pErr := eng.EvaluateMessageSend(policy.MessageAuthRequest{
			PolicyRow:     policyRow,
			Usage:         usage,
			RoomID:        roomID,
			DraftMessage:  draft,
			ProvidedToken: req.ApprovalToken,
			HumanApproved: humanApproved,
		}); pErr != nil {
			_ = policy.RecordAuditTx(tx, policy.AuditEntry{
				ActionType: "message_blocked",
				Actor:      "policy",
				TargetID:   roomID,
				PolicyMode: policyMode,
				Outcome:    "blocked",
				Details:    map[string]any{"error_code": pErr.Code, "error": pErr.Message},
			})
			rejectionErr = pErr
			return nil
		}

		if draft != nil && !humanApproved && strings.TrimSpace(req.ApprovalToken) != "" {
			if trimmedBody := strings.TrimSpace(req.Body); trimmedBody != "" && trimmedBody != strings.TrimSpace(draft.Body) {
				pErr := &policy.PolicyError{
					Code:       policy.ErrCodeApprovalRequired,
					HTTPStatus: http.StatusForbidden,
					Message:    "APPROVAL_REQUIRED: cannot modify approved draft body with approval_token; create a new draft",
				}
				_ = policy.RecordAuditTx(tx, policy.AuditEntry{
					ActionType: "message_blocked",
					Actor:      "policy",
					TargetID:   roomID,
					PolicyMode: policyMode,
					Outcome:    "blocked",
					Details:    map[string]any{"error_code": pErr.Code, "error": pErr.Message},
				})
				rejectionErr = pErr
				return nil
			}
		}

		sendBody = strings.TrimSpace(req.Body)
		if sendBody == "" && draft != nil {
			sendBody = strings.TrimSpace(draft.Body)
		}
		if sendBody == "" {
			rejectionErr = &policy.PolicyError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "body is required to send a message",
			}
			return nil
		}

		if s.bridgeHub == nil || !s.bridgeHub.IsConnected() {
			rejectionErr = bridge.ErrExtensionDisconnected
			return nil
		}

		if claimedThread.ID == 0 {
			createdThread, tErr := upsertMessageThreadTx(tx, roomID, "", "", "", "", "", nil, nil)
			if tErr != nil {
				return tErr
			}
			claimedThread = createdThread
		}

		now := time.Now().UTC()
		if draft != nil {
			prevStatus = draft.Status
			prevIsDraft = draft.IsDraft
			prevToken = draft.ApprovalToken
			prevTokenExp = draft.ApprovalTokenExpiresAt
			prevApprovedAt = draft.ApprovedAt

			draft.IsDraft = false
			draft.Status = "sending"
			draft.ApprovalToken = ""
			draft.ApprovalTokenExpiresAt = nil
			draft.ApprovedAt = &now
			if req.Body != "" && strings.TrimSpace(req.Body) != "" {
				draft.Body = req.Body
			}
			if err := tx.Save(draft).Error; err != nil {
				return err
			}
			claimedMsg = *draft
		} else {
			isSyntheticStub = true
			stub := dbservice.Message{
				ThreadID:   claimedThread.ID,
				Sender:     "Maxx Freelancer",
				SenderRole: "freelancer",
				Body:       sendBody,
				IsDraft:    false,
				Status:     "sending",
				ApprovedAt: &now,
			}
			if err := tx.Create(&stub).Error; err != nil {
				return err
			}
			claimedMsg = stub
		}
		return nil
	})
	if txErr != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Failed to authorize message send"}
	}
	if rejectionErr != nil {
		return nil, rejectionErr
	}

	// Phase 2: Execute messages.send RPC
	_, callErr := s.bridgeHub.CallExtension(ctx, "messages.send", map[string]any{
		"room_id": roomID,
		"body":    sendBody,
	}, 90*time.Second)
	if callErr != nil {
		var be *bridge.BridgeError
		var bridgeCode string
		if errors.As(callErr, &be) && be != nil {
			bridgeCode = strings.ToUpper(strings.TrimSpace(be.Code))
		}
		markFailed := errors.Is(callErr, context.DeadlineExceeded) ||
			errors.Is(callErr, context.Canceled) ||
			bridgeCode == bridge.ErrCodeTimeout ||
			bridgeCode == "MESSAGE_SEND_UNCONFIRMED"

		phase3Ctx, phase3Cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer phase3Cancel()

		_ = gormDB.WithContext(phase3Ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
				return err
			}
			if isSyntheticStub && !markFailed {
				_ = tx.Delete(&dbservice.Message{}, claimedMsg.ID).Error
			} else {
				var row dbservice.Message
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, claimedMsg.ID).Error; err == nil {
					if markFailed {
						row.IsDraft = false
						row.Status = "failed"
						row.ApprovalToken = ""
						row.ApprovalTokenExpiresAt = nil
					} else {
						restoreStatus := prevStatus
						if restoreStatus == "" || restoreStatus == "sending" {
							restoreStatus = "draft"
						}
						row.IsDraft = prevIsDraft
						row.Status = restoreStatus
						if restoreStatus == "pending_approval" && prevToken != "" {
							row.ApprovalToken = prevToken
							row.ApprovalTokenExpiresAt = prevTokenExp
							row.ApprovedAt = prevApprovedAt
						}
					}
					_ = tx.Save(&row).Error
				}
			}
			outcome := "failed"
			actionType := "message_send_failed"
			if errors.Is(callErr, bridge.ErrHumanActionRequired) {
				outcome = "HUMAN_ACTION_REQUIRED"
				actionType = "human_action_required"
			}
			return policy.RecordAuditTx(tx, policy.AuditEntry{
				ActionType: actionType,
				Actor:      "extension",
				TargetID:   roomID,
				PolicyMode: policyMode,
				Outcome:    outcome,
				Details:    map[string]any{"error": callErr.Error()},
			})
		})

		return nil, callErr
	}

	phase3Ctx, phase3Cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer phase3Cancel()

	var finalized dbservice.Message
	finErr := gormDB.WithContext(phase3Ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
			return err
		}
		var row dbservice.Message
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, claimedMsg.ID).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		row.Status = "sent"
		row.IsDraft = false
		row.SentAt = &now
		if err := tx.Save(&row).Error; err != nil {
			return err
		}

		var th dbservice.MessageThread
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&th, claimedThread.ID).Error; err == nil {
			th.LastMessageSnippet = truncateSnippet(sendBody, 160)
			th.LastMessageAt = &now
			th.UnreadCount = 0
			_ = tx.Save(&th).Error
			row.Thread = &th
		}
		finalized = row

		actor := "agent"
		if humanApproved {
			actor = "user"
		}
		return policy.RecordAuditTx(tx, policy.AuditEntry{
			ActionType: "message_sent",
			Actor:      actor,
			TargetID:   roomID,
			PolicyMode: policyMode,
			Outcome:    "success",
			Details: map[string]any{
				"message_id": row.ID,
				"room_id":    roomID,
			},
		})
	})
	if finErr != nil {
		return nil, &ServiceError{Code: "DB_ERROR", HTTPStatus: http.StatusInternalServerError, Message: "Message sent in Upwork but failed to finalize DB state"}
	}

	return &CommitMessageResult{
		Message: messageEntryFromModel(finalized),
		Sent:    true,
		Status:  finalized.Status,
		RoomID:  roomID,
	}, nil
}

func (s *Server) listThreadsHandler(w http.ResponseWriter, r *http.Request) {
	unreadOnly := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("unread_only")), "true")
	res, err := s.ListThreads(r.Context(), unreadOnly)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) listUnreadThreadsHandler(w http.ResponseWriter, r *http.Request) {
	res, err := s.ListThreads(r.Context(), true)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) listDraftMessagesHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	q := r.URL.Query()
	db := s.db.GetGorm().Model(&dbservice.Message{}).Preload("Thread")
	if status := strings.TrimSpace(q.Get("status")); status != "" {
		db = db.Where("status = ?", status)
	} else {
		db = db.Where("is_draft = ? OR status = ?", true, "pending_approval")
	}
	if roomID := strings.TrimSpace(q.Get("room_id")); roomID != "" {
		db = db.Joins("JOIN message_threads ON message_threads.id = messages.thread_id").
			Where("message_threads.upwork_room_id = ?", roomID)
	}

	var rows []dbservice.Message
	if err := db.Order("updated_at DESC, id DESC").Find(&rows).Error; err != nil {
		respondWithError(w, http.StatusInternalServerError, "Failed to list message drafts")
		return
	}

	entries := make([]messageEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, messageEntryFromModel(row))
	}
	respondWithJSON(w, map[string]any{
		"drafts": entries,
	})
}

func (s *Server) syncThreadsHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var reqBody struct {
		Rooms []SyncRoomPayload `json:"rooms"`
	}
	if r.Body != nil {
		decErr := json.NewDecoder(r.Body).Decode(&reqBody)
		if decErr != nil && !errors.Is(decErr, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	res, err := s.SyncThreads(r.Context(), reqBody.Rooms)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) getThreadHandler(w http.ResponseWriter, r *http.Request) {
	res, err := s.GetThread(r.Context(), extractRoomIDParam(r))
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) syncThreadHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)
	res, err := s.SyncThread(r.Context(), extractRoomIDParam(r))
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) draftMessageHandler(w http.ResponseWriter, r *http.Request) {
	extendWriteDeadline(w, 5*time.Minute)
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req DraftMessageInput
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if paramRoom := extractRoomIDParam(r); paramRoom != "" {
		req.RoomID = paramRoom
	}

	res, err := s.DraftMessage(r.Context(), req, "agent")
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSONStatus(w, http.StatusCreated, res)
}

func (s *Server) sendMessageHandler(w http.ResponseWriter, r *http.Request) {
	s.executeMessageCommit(w, r, false)
}

func (s *Server) approveMessageHandler(w http.ResponseWriter, r *http.Request) {
	s.executeMessageCommit(w, r, true)
}

func (s *Server) executeMessageCommit(w http.ResponseWriter, r *http.Request, humanApproved bool) {
	extendWriteDeadline(w, 5*time.Minute)
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req CommitMessageInput
	if r.Body != nil {
		decErr := json.NewDecoder(r.Body).Decode(&req)
		if decErr != nil && !errors.Is(decErr, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	if humanApproved {
		targetID, idErr := extractMessageIDParam(r)
		if idErr != nil || targetID == 0 {
			respondWithError(w, http.StatusBadRequest, "Invalid message ID")
			return
		}
		uid := uint(targetID)
		req.MessageID = &uid
	} else if paramRoom := extractRoomIDParam(r); paramRoom != "" {
		if reqRoom := firstNonEmpty(req.RoomID, req.UpworkRoomID); reqRoom != "" && reqRoom != paramRoom {
			respondBridgeError(w, &policy.PolicyError{
				Code:       "INVALID_MESSAGE_TARGET",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("INVALID_MESSAGE_TARGET: URL room_id %q does not match body room_id %q", paramRoom, reqRoom),
			})
			return
		}
		req.RoomID = paramRoom
	}

	res, err := s.CommitMessage(r.Context(), req, humanApproved)
	if err != nil {
		respondBridgeError(w, err)
		return
	}
	respondWithJSON(w, res)
}

func (s *Server) rejectMessageHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	id, err := extractMessageIDParam(r)
	if err != nil || id == 0 {
		respondWithError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	gormDB := s.db.GetGorm()
	eng := s.PolicyEngine()

	var updated dbservice.Message
	var rejectionErr error
	txErr := gormDB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", advisoryLockMessages).Error; err != nil {
			return err
		}
		var row dbservice.Message
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, id).Error; err != nil {
			return err
		}
		if row.Status == "sending" || row.Status == "sent" {
			rejectionErr = &policy.PolicyError{
				Code:       "ALREADY_SENT",
				HTTPStatus: http.StatusConflict,
				Message:    fmt.Sprintf("message #%d is already %s and cannot be rejected", row.ID, row.Status),
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
			ActionType: "message_rejected",
			Actor:      "user",
			TargetID:   strconv.FormatUint(id, 10),
			PolicyMode: policyRow.Mode,
			Outcome:    "rejected",
		})
	})
	if txErr != nil {
		if errors.Is(txErr, gorm.ErrRecordNotFound) {
			respondWithError(w, http.StatusNotFound, "Message not found")
			return
		}
		respondWithError(w, http.StatusInternalServerError, "Failed to reject message")
		return
	}
	if rejectionErr != nil {
		respondBridgeError(w, rejectionErr)
		return
	}

	_ = gormDB.Preload("Thread").First(&updated, updated.ID).Error
	respondWithJSON(w, map[string]any{
		"message": messageEntryFromModel(updated),
		"status":  updated.Status,
	})
}
