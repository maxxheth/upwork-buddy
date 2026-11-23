package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	dbservice "upwork-buddy/internal/database/service"
	"upwork-buddy/internal/policy"
)

type sessionStatusResponse = SessionStatusResponse

// SessionStatusResponse combines daemon DB health, extension WebSocket bridge status, and policy caps/usage.
type SessionStatusResponse struct {
	OK bool `json:"ok"`
	bridge.BridgeStatus
	DB                 string  `json:"db"`
	AutomationTabID    *int    `json:"automation_tab_id,omitempty"`
	Busy               bool    `json:"busy"`
	ActiveRequestID    *string `json:"active_request_id,omitempty"`
	LastError          *string `json:"last_error,omitempty"`
	ProposalsToday     int     `json:"proposals_today"`
	MaxProposalsPerDay int     `json:"max_proposals_per_day"`
	ConnectsToday      int     `json:"connects_today"`
	MaxConnectsPerDay  int     `json:"max_connects_per_day"`
	MessagesToday      int     `json:"messages_today"`
	MaxMessagesPerDay  int     `json:"max_messages_per_day"`
	PendingApprovals   int     `json:"pending_approvals"`
	KillSwitchActive   bool    `json:"kill_switch_active"`
}

// GetSessionStatus returns daemon/DB health, WS bridge status (with optional live session.status probe), and policy snapshot.
func (s *Server) GetSessionStatus(ctx context.Context, liveProbe bool) (*SessionStatusResponse, error) {
	var base bridge.BridgeStatus
	if s.bridgeHub != nil {
		base = s.bridgeHub.Status()
	}

	dbStatus := "down"
	if s.db != nil && s.db.GetGorm() != nil {
		if health := s.db.Health(); health["status"] == "up" {
			dbStatus = "up"
		}
	}

	var snap policy.Snapshot
	if s.db != nil && s.db.GetGorm() != nil {
		if loaded, err := s.PolicyEngine().GetSnapshot(ctx); err == nil {
			snap = loaded
		} else {
			snap.Config = policy.DefaultConfigFromEnv()
		}
	} else {
		snap.Config = policy.DefaultConfigFromEnv()
	}

	base.PolicyMode = snap.Mode
	resp := &SessionStatusResponse{
		OK:                 dbStatus == "up",
		BridgeStatus:       base,
		DB:                 dbStatus,
		ProposalsToday:     snap.ProposalsToday,
		MaxProposalsPerDay: snap.MaxProposalsPerDay,
		ConnectsToday:      snap.ConnectsToday,
		MaxConnectsPerDay:  snap.MaxConnectsPerDay,
		MessagesToday:      snap.MessagesToday,
		MaxMessagesPerDay:  snap.MaxMessagesPerDay,
		PendingApprovals:   snap.PendingApprovals,
		KillSwitchActive:   snap.KillSwitchActive,
	}

	if liveProbe && s.bridgeHub != nil && s.bridgeHub.IsConnected() {
		probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		rawRes, err := s.bridgeHub.CallExtension(probeCtx, "session.status", map[string]any{}, 3*time.Second)
		cancel()
		if err == nil && len(rawRes) > 0 {
			var probe struct {
				UpworkLoggedIn  *bool   `json:"upwork_logged_in"`
				AutomationTabID *int    `json:"automation_tab_id"`
				Busy            bool    `json:"busy"`
				ActiveRequestID *string `json:"active_request_id"`
				LastError       *string `json:"last_error"`
				Browser         string  `json:"browser"`
				ExtensionVer    string  `json:"extension_version"`
			}
			if json.Unmarshal(rawRes, &probe) == nil {
				if probe.UpworkLoggedIn != nil {
					resp.UpworkLoggedIn = probe.UpworkLoggedIn
				}
				resp.AutomationTabID = probe.AutomationTabID
				resp.Busy = probe.Busy
				resp.ActiveRequestID = probe.ActiveRequestID
				resp.LastError = probe.LastError
				if probe.Browser != "" {
					resp.Browser = probe.Browser
				}
				if probe.ExtensionVer != "" {
					resp.ExtensionVersion = probe.ExtensionVer
				}
			}
		}
	}

	return resp, nil
}

func (s *Server) sessionStatusHandler(w http.ResponseWriter, r *http.Request) {
	liveProbe := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("live_probe")), "true")
	resp, _ := s.GetSessionStatus(r.Context(), liveProbe)
	respondWithJSON(w, resp)
}

func (s *Server) getPolicyHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	snap, err := s.PolicyEngine().GetSnapshot(r.Context())
	if err != nil {
		respondWithError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondWithJSON(w, snap)
}

func (s *Server) updatePolicyHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}
	var input policy.UpdateInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		respondWithError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	snap, err := s.PolicyEngine().Update(r.Context(), input, "api")
	if err != nil {
		var pe *policy.PolicyError
		if errors.As(err, &pe) && pe != nil {
			respondWithJSONStatus(w, pe.HTTPStatus, map[string]any{
				"error":      pe.Message,
				"error_code": pe.Code,
			})
			return
		}
		respondWithError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondWithJSON(w, snap)
}

func (s *Server) killSwitchHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	var req struct {
		Reason string `json:"reason"`
	}
	if r.Body != nil {
		err := json.NewDecoder(r.Body).Decode(&req)
		if err != nil && !errors.Is(err, io.EOF) {
			respondWithError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		reason = "Kill switch activated"
	}

	snap, err := s.PolicyEngine().ActivateKillSwitch(r.Context(), reason, "user")
	if err != nil {
		respondWithError(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.CancelWatchers(reason)

	aborted := false
	var abortError string
	if s.bridgeHub != nil && s.bridgeHub.IsConnected() {
		callCtx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		rawRes, callErr := s.bridgeHub.CallExtension(callCtx, "kill_switch.abort", map[string]any{
			"reason": reason,
		}, 3*time.Second)
		if callErr != nil {
			abortError = callErr.Error()
		} else {
			var res struct {
				Aborted bool `json:"aborted"`
			}
			if json.Unmarshal(rawRes, &res) == nil {
				aborted = res.Aborted
			}
		}
	}

	resp := map[string]any{
		"ok":                 true,
		"mode":               snap.Mode,
		"kill_switch_active": snap.KillSwitchActive,
		"aborted":            aborted,
		"reason":             reason,
		"policy":             snap,
	}
	if abortError != "" {
		resp["abort_warning"] = abortError
	}
	respondWithJSON(w, resp)
}

type auditLogEntry struct {
	ID         uint            `json:"id"`
	ActionType string          `json:"action_type"`
	Actor      string          `json:"actor"`
	TargetID   string          `json:"target_id"`
	PolicyMode string          `json:"policy_mode"`
	Outcome    string          `json:"outcome"`
	Details    json.RawMessage `json:"details,omitempty"`
	CreatedAt  string          `json:"created_at"`
}

func (s *Server) listAuditLogsHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil || s.db.GetGorm() == nil {
		respondWithError(w, http.StatusServiceUnavailable, "Database unavailable")
		return
	}

	q := r.URL.Query()
	limit := 50
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			respondWithError(w, http.StatusBadRequest, "Invalid limit parameter")
			return
		}
		if parsed > 200 {
			parsed = 200
		}
		limit = parsed
	}
	offset := 0
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		parsed, err := strconv.Atoi(rawOffset)
		if err != nil || parsed < 0 {
			respondWithError(w, http.StatusBadRequest, "Invalid offset parameter")
			return
		}
		offset = parsed
	}

	db := s.db.GetGorm().Model(&dbservice.ActionAuditLog{})
	if actionType := strings.TrimSpace(q.Get("action_type")); actionType != "" {
		db = db.Where("action_type = ?", actionType)
	}
	if outcome := strings.TrimSpace(q.Get("outcome")); outcome != "" {
		db = db.Where("outcome = ?", outcome)
	}
	if targetID := strings.TrimSpace(q.Get("target_id")); targetID != "" {
		db = db.Where("target_id = ?", targetID)
	}
	if actor := strings.TrimSpace(q.Get("actor")); actor != "" {
		db = db.Where("actor = ?", actor)
	}

	var total int64
	if err := db.Count(&total).Error; err != nil {
		respondWithError(w, http.StatusInternalServerError, "Failed to count audit logs")
		return
	}

	var rows []dbservice.ActionAuditLog
	if err := db.Order("created_at DESC, id DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		respondWithError(w, http.StatusInternalServerError, "Failed to list audit logs")
		return
	}

	entries := make([]auditLogEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, auditLogEntry{
			ID:         row.ID,
			ActionType: row.ActionType,
			Actor:      row.Actor,
			TargetID:   row.TargetID,
			PolicyMode: row.PolicyMode,
			Outcome:    row.Outcome,
			Details:    rawJSONFromJSONB(row.DetailsJSON),
			CreatedAt:  row.CreatedAt.UTC().Format(time.RFC3339),
		})
	}

	respondWithJSON(w, map[string]any{
		"logs":   entries,
		"total":  total,
		"limit":  limit,
		"offset": offset,
	})
}
