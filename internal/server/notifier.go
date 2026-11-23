package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	dbservice "upwork-buddy/internal/database/service"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	EventHotJobAlert        = "hot_job_alert"
	EventPendingApproval    = "pending_approval"
	EventProposalSubmitted  = "proposal_submitted"
	EventHumanActionReq     = "human_action_required"
	EventWatcherPaused      = "watcher_paused"
	defaultNotificationKey  = "default"
	defaultTelegramBaseURL  = "https://api.telegram.org"
	notifierQueueSize       = 64
	notifierHTTPTimeout     = 5 * time.Second
)

var DefaultNotifyEvents = []string{
	EventHotJobAlert,
	EventPendingApproval,
	EventProposalSubmitted,
	EventHumanActionReq,
	EventWatcherPaused,
}

// NotificationConfigView is the secret-safe public representation of NotificationConfig.
type NotificationConfigView struct {
	ChromeNotificationsEnabled bool     `json:"chrome_notifications_enabled"`
	WebhookEnabled             bool     `json:"webhook_enabled"`
	WebhookURL                 string   `json:"webhook_url"`
	HasWebhookSecret           bool     `json:"has_webhook_secret"`
	TelegramEnabled            bool     `json:"telegram_enabled"`
	HasTelegramBotToken        bool     `json:"has_telegram_bot_token"`
	TelegramChatID             string   `json:"telegram_chat_id"`
	NotifyEvents               []string `json:"notify_events"`
	UpdatedAt                  string   `json:"updated_at"`
}

// UpdateNotificationConfigInput configures partial or full updates to notification settings.
type UpdateNotificationConfigInput struct {
	ChromeNotificationsEnabled *bool    `json:"chrome_notifications_enabled,omitempty"`
	WebhookEnabled             *bool    `json:"webhook_enabled,omitempty"`
	WebhookURL                 *string  `json:"webhook_url,omitempty"`
	WebhookSecret              *string  `json:"webhook_secret,omitempty"`
	ClearWebhookSecret         bool     `json:"clear_webhook_secret,omitempty"`
	TelegramEnabled            *bool    `json:"telegram_enabled,omitempty"`
	TelegramBotToken           *string  `json:"telegram_bot_token,omitempty"`
	ClearTelegramBotToken      bool     `json:"clear_telegram_bot_token,omitempty"`
	TelegramChatID             *string  `json:"telegram_chat_id,omitempty"`
	NotifyEvents               []string `json:"notify_events,omitempty"`
}

// WatcherAlert describes a notification event emitted by the WatcherManager.
type WatcherAlert struct {
	Event            string   `json:"event"`
	Title            string   `json:"title"`
	Message          string   `json:"message"`
	RuleID           uint     `json:"rule_id,omitempty"`
	RuleName         string   `json:"rule_name,omitempty"`
	JobID            uint     `json:"job_id,omitempty"`
	UpworkJobID      string   `json:"upwork_job_id,omitempty"`
	ProposalID       *uint    `json:"proposal_id,omitempty"`
	Score            *int     `json:"score,omitempty"`
	ConnectsCost     *int     `json:"connects_cost,omitempty"`
	PendingApprovals int      `json:"pending_approvals"`
	DashboardURL     string   `json:"dashboard_url,omitempty"`
	Timestamp        string   `json:"timestamp,omitempty"`
	Confidence       *float64 `json:"confidence,omitempty"`
}

// ChannelDeliveryResult records the outcome of dispatching to a single channel.
type ChannelDeliveryResult struct {
	Attempted bool   `json:"attempted"`
	OK        bool   `json:"ok"`
	Sent      bool   `json:"sent"`
	Error     string `json:"error,omitempty"`
}

// TelegramChatCandidate describes a chat discovered from Telegram Bot API getUpdates.
type TelegramChatCandidate struct {
	ChatID      string `json:"chat_id"`
	Type        string `json:"type"`
	Title       string `json:"title,omitempty"`
	Username    string `json:"username,omitempty"`
	DisplayName string `json:"display_name"`
	LastText    string `json:"last_text,omitempty"`
	LastDate    string `json:"last_date,omitempty"`
}

// TelegramDetectChatResult bundles discovered Telegram chats and bot metadata.
type TelegramDetectChatResult struct {
	BotUsername string                  `json:"bot_username,omitempty"`
	Chats       []TelegramChatCandidate `json:"chats"`
	Hint        string                  `json:"hint,omitempty"`
}

type effectiveNotificationConfig struct {
	ChromeNotificationsEnabled bool
	WebhookEnabled             bool
	WebhookURL                 string
	WebhookSecret              string
	TelegramEnabled            bool
	TelegramBotToken           string
	TelegramChatID             string
	NotifyEvents               []string
	UpdatedAt                  time.Time
}

// Notifier dispatches watcher alerts across Chrome WS, Webhooks, and Telegram.
type Notifier struct {
	server          *Server
	httpClient      *http.Client
	telegramBaseURL string

	mu      sync.Mutex
	started bool
	closed  bool
	queue   chan WatcherAlert
	wg      sync.WaitGroup
}

// NewNotifier constructs a Notifier bound to *Server.
func NewNotifier(s *Server) *Notifier {
	return &Notifier{
		server: s,
		httpClient: &http.Client{
			Timeout: notifierHTTPTimeout,
		},
		telegramBaseURL: defaultTelegramBaseURL,
	}
}

// Close drains any queued async alerts and waits for the worker to exit.
func (n *Notifier) Close() error {
	if n == nil {
		return nil
	}
	n.mu.Lock()
	if n.closed {
		n.mu.Unlock()
		return nil
	}
	n.closed = true
	started := n.started
	if started && n.queue != nil {
		close(n.queue)
	}
	n.mu.Unlock()

	if started {
		n.wg.Wait()
	}
	return nil
}

// NotifyAsync enqueues an alert for non-blocking background delivery.
func (n *Notifier) NotifyAsync(alert WatcherAlert) {
	if n == nil {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return
	}
	if !n.started {
		n.queue = make(chan WatcherAlert, notifierQueueSize)
		n.started = true
		n.wg.Add(1)
		go n.worker()
	}
	select {
	case n.queue <- alert:
	default:
		log.Printf("notifier: async queue full, dropping event=%s rule_id=%d", alert.Event, alert.RuleID)
	}
}

func (n *Notifier) worker() {
	defer n.wg.Done()
	for alert := range n.queue {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		_, _ = n.SendSync(ctx, alert, "")
		cancel()
	}
}

// GetNotificationConfig loads the singleton config row with env fallbacks and returns the secret-safe view.
func (s *Server) GetNotificationConfig(ctx context.Context) (*NotificationConfigView, error) {
	eff, err := s.loadEffectiveNotificationConfig(ctx)
	if err != nil {
		return nil, err
	}
	view := eff.toView()
	return &view, nil
}

// UpdateNotificationConfig validates and persists updates to the singleton notification_configs row.
func (s *Server) UpdateNotificationConfig(ctx context.Context, in UpdateNotificationConfigInput) (*NotificationConfigView, error) {
	if s == nil || s.db == nil || s.db.GetGorm() == nil {
		return nil, &ServiceError{Code: "DB_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Database unavailable"}
	}
	if in.WebhookURL != nil {
		trimmedURL := strings.TrimSpace(*in.WebhookURL)
		if trimmedURL != "" {
			if err := validateWebhookURL(trimmedURL); err != nil {
				return nil, &ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: err.Error()}
			}
		}
	}

	gormDB := s.db.GetGorm().WithContext(ctx)
	var row dbservice.NotificationConfig
	err := gormDB.Where("config_key = ?", defaultNotificationKey).First(&row).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		defaultEventsJSON, _ := json.Marshal(DefaultNotifyEvents)
		row = dbservice.NotificationConfig{
			ConfigKey:                  defaultNotificationKey,
			ChromeNotificationsEnabled: true,
			NotifyEventsJSON:           dbservice.JSONB(defaultEventsJSON),
		}
	} else if err != nil {
		return nil, err
	}

	if in.ChromeNotificationsEnabled != nil {
		row.ChromeNotificationsEnabled = *in.ChromeNotificationsEnabled
	}
	if in.WebhookEnabled != nil {
		row.WebhookEnabled = *in.WebhookEnabled
	}
	if in.WebhookURL != nil {
		row.WebhookURL = strings.TrimSpace(*in.WebhookURL)
	}
	if in.ClearWebhookSecret {
		row.WebhookSecret = ""
	} else if in.WebhookSecret != nil {
		if trimmed := strings.TrimSpace(*in.WebhookSecret); trimmed != "" {
			row.WebhookSecret = trimmed
		}
	}
	if in.TelegramEnabled != nil {
		row.TelegramEnabled = *in.TelegramEnabled
	}
	if in.ClearTelegramBotToken {
		row.TelegramBotToken = ""
	} else if in.TelegramBotToken != nil {
		if trimmed := normalizeTelegramBotToken(*in.TelegramBotToken); trimmed != "" {
			row.TelegramBotToken = trimmed
		}
	}
	if in.TelegramChatID != nil {
		row.TelegramChatID = strings.TrimSpace(*in.TelegramChatID)
	}
	if in.NotifyEvents != nil {
		normalized := normalizeNotifyEvents(in.NotifyEvents)
		encoded, _ := json.Marshal(normalized)
		row.NotifyEventsJSON = dbservice.JSONB(encoded)
	} else if len(row.NotifyEventsJSON) == 0 {
		encoded, _ := json.Marshal(DefaultNotifyEvents)
		row.NotifyEventsJSON = dbservice.JSONB(encoded)
	}

	if err := gormDB.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "config_key"}},
		DoUpdates: clause.AssignmentColumns([]string{
			"chrome_notifications_enabled",
			"webhook_enabled",
			"webhook_url",
			"webhook_secret",
			"telegram_enabled",
			"telegram_bot_token",
			"telegram_chat_id",
			"notify_events_json",
			"updated_at",
		}),
	}).Create(&row).Error; err != nil {
		return nil, err
	}

	return s.GetNotificationConfig(ctx)
}

func (s *Server) loadEffectiveNotificationConfig(ctx context.Context) (effectiveNotificationConfig, error) {
	eff := effectiveNotificationConfig{
		ChromeNotificationsEnabled: true,
		NotifyEvents:               append([]string(nil), DefaultNotifyEvents...),
	}

	var row dbservice.NotificationConfig
	hasRow := false
	if s != nil && s.db != nil && s.db.GetGorm() != nil {
		err := s.db.GetGorm().WithContext(ctx).Where("config_key = ?", defaultNotificationKey).First(&row).Error
		if err == nil {
			hasRow = true
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return eff, err
		}
	}

	if hasRow {
		eff.ChromeNotificationsEnabled = row.ChromeNotificationsEnabled
		eff.WebhookEnabled = row.WebhookEnabled
		eff.WebhookURL = strings.TrimSpace(row.WebhookURL)
		eff.WebhookSecret = strings.TrimSpace(row.WebhookSecret)
		eff.TelegramEnabled = row.TelegramEnabled
		eff.TelegramBotToken = strings.TrimSpace(row.TelegramBotToken)
		eff.TelegramChatID = strings.TrimSpace(row.TelegramChatID)
		eff.UpdatedAt = row.UpdatedAt
		if len(row.NotifyEventsJSON) > 0 {
			var evts []string
			if json.Unmarshal(row.NotifyEventsJSON, &evts) == nil {
				eff.NotifyEvents = normalizeNotifyEvents(evts)
			}
		}
	}

	// Env fallbacks when DB fields are empty.
	if eff.WebhookURL == "" {
		if v := strings.TrimSpace(os.Getenv("WATCHER_WEBHOOK_URL")); v != "" {
			eff.WebhookURL = v
		}
	}
	if eff.WebhookSecret == "" {
		if v := strings.TrimSpace(os.Getenv("WATCHER_WEBHOOK_SECRET")); v != "" {
			eff.WebhookSecret = v
		}
	}
	if eff.TelegramBotToken == "" {
		if v := strings.TrimSpace(os.Getenv("WATCHER_TELEGRAM_BOT_TOKEN")); v != "" {
			eff.TelegramBotToken = v
		}
	}
	if eff.TelegramChatID == "" {
		if v := strings.TrimSpace(os.Getenv("WATCHER_TELEGRAM_CHAT_ID")); v != "" {
			eff.TelegramChatID = v
		}
	}

	return eff, nil
}

func (e effectiveNotificationConfig) toView() NotificationConfigView {
	updatedAt := ""
	if !e.UpdatedAt.IsZero() {
		updatedAt = e.UpdatedAt.UTC().Format(time.RFC3339)
	}
	events := e.NotifyEvents
	if events == nil {
		events = []string{}
	}
	return NotificationConfigView{
		ChromeNotificationsEnabled: e.ChromeNotificationsEnabled,
		WebhookEnabled:             e.WebhookEnabled,
		WebhookURL:                 e.WebhookURL,
		HasWebhookSecret:           e.WebhookSecret != "",
		TelegramEnabled:            e.TelegramEnabled,
		HasTelegramBotToken:        e.TelegramBotToken != "",
		TelegramChatID:             e.TelegramChatID,
		NotifyEvents:               events,
		UpdatedAt:                  updatedAt,
	}
}

func (e effectiveNotificationConfig) allowsEvent(event string) bool {
	if event == "" || event == "test" {
		return true
	}
	for _, ev := range e.NotifyEvents {
		if ev == event {
			return true
		}
	}
	return false
}

// SendSync dispatches an alert synchronously across configured channels (or a specific channel when channelFilter is non-empty).
func (n *Notifier) SendSync(ctx context.Context, alert WatcherAlert, channelFilter string) (bool, map[string]ChannelDeliveryResult) {
	results := map[string]ChannelDeliveryResult{}
	if n == nil || n.server == nil {
		return false, results
	}

	eff, err := n.server.loadEffectiveNotificationConfig(ctx)
	if err != nil {
		results["config"] = ChannelDeliveryResult{Attempted: true, OK: false, Error: err.Error()}
		return false, results
	}

	channelFilter = strings.TrimSpace(channelFilter)
	isAllChannels := channelFilter == "" || strings.EqualFold(channelFilter, "all")
	if isAllChannels && !eff.allowsEvent(alert.Event) {
		return true, results
	}

	if alert.Timestamp == "" {
		alert.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	if alert.DashboardURL == "" {
		alert.DashboardURL = ResolveDaemonBaseURL() + "/dashboard/"
	}
	if n.server.db != nil && n.server.db.GetGorm() != nil {
		if usage, uErr := n.server.PolicyEngine().ComputeUsage(n.server.db.GetGorm()); uErr == nil {
			alert.PendingApprovals = usage.PendingApprovals
		}
	}

	wantChannel := func(ch string) bool {
		return isAllChannels || strings.EqualFold(channelFilter, ch)
	}

	allOK := true

	// 1. Chrome WS notification
	if wantChannel("chrome") && (eff.ChromeNotificationsEnabled || strings.EqualFold(channelFilter, "chrome")) {
		res := ChannelDeliveryResult{Attempted: true}
		if n.server.bridgeHub != nil && n.server.bridgeHub.IsConnected() {
			chromeNotif := eff.ChromeNotificationsEnabled
			if strings.EqualFold(channelFilter, "chrome") {
				chromeNotif = true
			}
			payload := map[string]any{
				"event":                alert.Event,
				"title":                alert.Title,
				"message":              alert.Message,
				"rule_id":              alert.RuleID,
				"rule_name":            alert.RuleName,
				"job_id":               alert.JobID,
				"upwork_job_id":        alert.UpworkJobID,
				"proposal_id":          alert.ProposalID,
				"score":                alert.Score,
				"connects_cost":        alert.ConnectsCost,
				"pending_approvals":    alert.PendingApprovals,
				"dashboard_url":        alert.DashboardURL,
				"chrome_notifications": chromeNotif,
			}
			if notifyErr := n.server.bridgeHub.NotifyExtension(ctx, "watch.alert", payload); notifyErr != nil {
				res.Error = notifyErr.Error()
				allOK = false
			} else {
				res.OK = true
				res.Sent = true
			}
		} else {
			res.Error = "extension disconnected"
			if strings.EqualFold(channelFilter, "chrome") {
				allOK = false
			}
		}
		results["chrome"] = res
	}

	// 2. Generic Webhook
	if wantChannel("webhook") && (eff.WebhookEnabled || strings.EqualFold(channelFilter, "webhook")) {
		res := ChannelDeliveryResult{Attempted: true}
		if eff.WebhookURL == "" {
			res.Error = "webhook_url is not configured"
			allOK = false
		} else if err := n.sendWebhook(ctx, eff.WebhookURL, eff.WebhookSecret, alert); err != nil {
			res.Error = err.Error()
			allOK = false
		} else {
			res.OK = true
			res.Sent = true
		}
		results["webhook"] = res
	}

	// 3. Telegram Bot API
	if wantChannel("telegram") && (eff.TelegramEnabled || strings.EqualFold(channelFilter, "telegram")) {
		res := ChannelDeliveryResult{Attempted: true}
		if eff.TelegramBotToken == "" && eff.TelegramChatID == "" {
			res.Error = "telegram_bot_token and telegram_chat_id are required"
			allOK = false
		} else if eff.TelegramBotToken == "" {
			res.Error = "telegram_bot_token is required"
			allOK = false
		} else if eff.TelegramChatID == "" {
			res.Error = "telegram_chat_id is required (send /start to your bot in Telegram, then click Detect Chat ID)"
			allOK = false
		} else if err := n.sendTelegram(ctx, eff.TelegramBotToken, eff.TelegramChatID, alert); err != nil {
			res.Error = err.Error()
			allOK = false
		} else {
			res.OK = true
			res.Sent = true
		}
		results["telegram"] = res
	}

	return allOK, results
}

func (n *Notifier) sendWebhook(ctx context.Context, webhookURL, secret string, alert WatcherAlert) error {
	if err := validateWebhookURL(webhookURL); err != nil {
		return err
	}
	body, err := json.Marshal(alert)
	if err != nil {
		return err
	}
	headers := map[string]string{
		"Content-Type": "application/json",
	}
	if secret != "" {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		headers["X-Upwork-Buddy-Signature"] = "sha256=" + hex.EncodeToString(mac.Sum(nil))
	}
	return n.postJSONWithRetry(ctx, webhookURL, body, headers)
}

func (n *Notifier) sendTelegram(ctx context.Context, botToken, chatID string, alert WatcherAlert) error {
	botToken = normalizeTelegramBotToken(botToken)
	base := strings.TrimRight(n.telegramBaseURL, "/")
	if base == "" {
		base = defaultTelegramBaseURL
	}
	escapedToken := url.PathEscape(botToken)
	endpoint := fmt.Sprintf("%s/bot%s/sendMessage", base, escapedToken)
	text := formatTelegramMessage(alert)
	payload := map[string]any{
		"chat_id":                  chatID,
		"text":                     text,
		"disable_web_page_preview": true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if err := n.postJSONWithRetry(ctx, endpoint, body, map[string]string{
		"Content-Type": "application/json",
	}); err != nil {
		return sanitizeTelegramError(err, botToken, escapedToken)
	}
	return nil
}

type telegramChatPayload struct {
	ID        int64  `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

type telegramMessagePayload struct {
	Date int64                `json:"date"`
	Text string               `json:"text"`
	Chat *telegramChatPayload `json:"chat"`
}

type telegramChatMemberPayload struct {
	Date int64                `json:"date"`
	Chat *telegramChatPayload `json:"chat"`
}

type telegramCallbackQueryPayload struct {
	Message *telegramMessagePayload `json:"message"`
}

type telegramUpdatePayload struct {
	UpdateID          int64                         `json:"update_id"`
	Message           *telegramMessagePayload       `json:"message"`
	EditedMessage     *telegramMessagePayload       `json:"edited_message"`
	ChannelPost       *telegramMessagePayload       `json:"channel_post"`
	EditedChannelPost *telegramMessagePayload       `json:"edited_channel_post"`
	MyChatMember      *telegramChatMemberPayload    `json:"my_chat_member"`
	CallbackQuery     *telegramCallbackQueryPayload `json:"callback_query"`
}

// DetectTelegramChats queries Telegram's getUpdates (and getMe) to discover recent chat IDs
// for either tokenOverride or the persisted Telegram bot token, without consuming updates or leaking secrets.
func (n *Notifier) DetectTelegramChats(ctx context.Context, tokenOverride string) (*TelegramDetectChatResult, error) {
	if n == nil || n.server == nil {
		return nil, &ServiceError{Code: "NOTIFIER_UNAVAILABLE", HTTPStatus: http.StatusServiceUnavailable, Message: "Notifier unavailable"}
	}

	botToken := normalizeTelegramBotToken(tokenOverride)
	if botToken == "" {
		eff, err := n.server.loadEffectiveNotificationConfig(ctx)
		if err != nil {
			return nil, err
		}
		botToken = normalizeTelegramBotToken(eff.TelegramBotToken)
	}
	if botToken == "" {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Enter or save a Telegram Bot Token first",
		}
	}
	if !looksLikeTelegramBotToken(botToken) {
		return nil, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Saved or entered Telegram Bot Token is not in @BotFather HTTP API token format (expected <digits>:<token>, e.g. 123456789:AAH...). Paste the full token from @BotFather and try again.",
		}
	}

	base := strings.TrimRight(n.telegramBaseURL, "/")
	if base == "" {
		base = defaultTelegramBaseURL
	}
	escapedToken := url.PathEscape(botToken)

	var updatesResp struct {
		OK          bool                    `json:"ok"`
		Description string                  `json:"description"`
		Result      []telegramUpdatePayload `json:"result"`
	}
	updatesURL := fmt.Sprintf("%s/bot%s/getUpdates?limit=100", base, escapedToken)
	if err := n.getTelegramAPI(ctx, updatesURL, botToken, escapedToken, &updatesResp); err != nil {
		return nil, err
	}

	// Best-effort getMe lookup for helpful @bot_username display.
	botUsername := ""
	var meResp struct {
		OK     bool `json:"ok"`
		Result struct {
			Username string `json:"username"`
		} `json:"result"`
	}
	meURL := fmt.Sprintf("%s/bot%s/getMe", base, escapedToken)
	if err := n.getTelegramAPI(ctx, meURL, botToken, escapedToken, &meResp); err == nil && meResp.OK {
		botUsername = strings.TrimSpace(meResp.Result.Username)
	}

	type trackedChat struct {
		candidate TelegramChatCandidate
		unixDate  int64
		updateID  int64
	}
	byChatID := make(map[string]trackedChat)

	recordChat := func(updateID int64, chat *telegramChatPayload, unixDate int64, text string) {
		if chat == nil || chat.ID == 0 {
			return
		}
		chatIDStr := strconv.FormatInt(chat.ID, 10)
		if existing, ok := byChatID[chatIDStr]; ok {
			if unixDate < existing.unixDate || (unixDate == existing.unixDate && updateID <= existing.updateID) {
				return
			}
		}
		trimmedText := strings.TrimSpace(text)
		if len(trimmedText) > 80 {
			trimmedText = trimmedText[:80] + "..."
		}
		lastDate := ""
		if unixDate > 0 {
			lastDate = time.Unix(unixDate, 0).UTC().Format(time.RFC3339)
		}
		byChatID[chatIDStr] = trackedChat{
			candidate: TelegramChatCandidate{
				ChatID:      chatIDStr,
				Type:        strings.TrimSpace(chat.Type),
				Title:       strings.TrimSpace(chat.Title),
				Username:    strings.TrimSpace(chat.Username),
				DisplayName: formatTelegramChatDisplayName(*chat),
				LastText:    trimmedText,
				LastDate:    lastDate,
			},
			unixDate: unixDate,
			updateID: updateID,
		}
	}

	for _, upd := range updatesResp.Result {
		switch {
		case upd.Message != nil && upd.Message.Chat != nil:
			recordChat(upd.UpdateID, upd.Message.Chat, upd.Message.Date, upd.Message.Text)
		case upd.EditedMessage != nil && upd.EditedMessage.Chat != nil:
			recordChat(upd.UpdateID, upd.EditedMessage.Chat, upd.EditedMessage.Date, upd.EditedMessage.Text)
		case upd.ChannelPost != nil && upd.ChannelPost.Chat != nil:
			recordChat(upd.UpdateID, upd.ChannelPost.Chat, upd.ChannelPost.Date, upd.ChannelPost.Text)
		case upd.EditedChannelPost != nil && upd.EditedChannelPost.Chat != nil:
			recordChat(upd.UpdateID, upd.EditedChannelPost.Chat, upd.EditedChannelPost.Date, upd.EditedChannelPost.Text)
		case upd.MyChatMember != nil && upd.MyChatMember.Chat != nil:
			recordChat(upd.UpdateID, upd.MyChatMember.Chat, upd.MyChatMember.Date, "")
		case upd.CallbackQuery != nil && upd.CallbackQuery.Message != nil && upd.CallbackQuery.Message.Chat != nil:
			recordChat(upd.UpdateID, upd.CallbackQuery.Message.Chat, upd.CallbackQuery.Message.Date, upd.CallbackQuery.Message.Text)
		}
	}

	tracked := make([]trackedChat, 0, len(byChatID))
	for _, tc := range byChatID {
		tracked = append(tracked, tc)
	}
	sort.Slice(tracked, func(i, j int) bool {
		if tracked[i].unixDate != tracked[j].unixDate {
			return tracked[i].unixDate > tracked[j].unixDate
		}
		if tracked[i].updateID != tracked[j].updateID {
			return tracked[i].updateID > tracked[j].updateID
		}
		return tracked[i].candidate.ChatID < tracked[j].candidate.ChatID
	})

	chats := make([]TelegramChatCandidate, 0, len(tracked))
	for _, tc := range tracked {
		chats = append(chats, tc.candidate)
	}

	hint := ""
	if len(chats) == 0 {
		if botUsername != "" {
			hint = fmt.Sprintf("No recent messages found for @%s. Open Telegram, send /start (or any message) to @%s, then click Detect Chat ID again.", botUsername, botUsername)
		} else {
			hint = "No recent messages found. Open Telegram, send /start (or any message) to your bot, then click Detect Chat ID again."
		}
	}

	return &TelegramDetectChatResult{
		BotUsername: botUsername,
		Chats:       chats,
		Hint:        hint,
	}, nil
}

func formatTelegramChatDisplayName(chat telegramChatPayload) string {
	label := strings.TrimSpace(chat.Title)
	if label == "" {
		nameParts := make([]string, 0, 2)
		if fn := strings.TrimSpace(chat.FirstName); fn != "" {
			nameParts = append(nameParts, fn)
		}
		if ln := strings.TrimSpace(chat.LastName); ln != "" {
			nameParts = append(nameParts, ln)
		}
		label = strings.Join(nameParts, " ")
	}
	username := strings.TrimPrefix(strings.TrimSpace(chat.Username), "@")
	if label == "" && username != "" {
		label = "@" + username
	} else if label != "" && username != "" {
		label = fmt.Sprintf("%s (@%s)", label, username)
	}
	if label == "" {
		label = fmt.Sprintf("Chat %d", chat.ID)
	}
	if ct := strings.TrimSpace(chat.Type); ct != "" {
		label = fmt.Sprintf("%s [%s]", label, ct)
	}
	return label
}

func (n *Notifier) getTelegramAPI(ctx context.Context, targetURL, botToken, escapedToken string, dest any) error {
	client := n.httpClient
	if client == nil {
		client = &http.Client{Timeout: notifierHTTPTimeout}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return sanitizeTelegramError(err, botToken, escapedToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return &ServiceError{
			Code:       "TELEGRAM_UNREACHABLE",
			HTTPStatus: http.StatusBadGateway,
			Message:    sanitizeTelegramError(err, botToken, escapedToken).Error(),
		}
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if readErr != nil {
		return &ServiceError{
			Code:       "TELEGRAM_API_ERROR",
			HTTPStatus: http.StatusBadGateway,
			Message:    sanitizeTelegramError(readErr, botToken, escapedToken).Error(),
		}
	}

	var envelope struct {
		OK          bool   `json:"ok"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(bodyBytes, &envelope)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !envelope.OK {
		desc := redactSecrets(strings.TrimSpace(envelope.Description), botToken, escapedToken)
		if desc == "" {
			desc = redactSecrets(strings.TrimSpace(string(bodyBytes)), botToken, escapedToken)
		}
		lowerDesc := strings.ToLower(desc)
		switch {
		case resp.StatusCode == http.StatusUnauthorized || strings.Contains(lowerDesc, "unauthorized"):
			return &ServiceError{
				Code:       "TELEGRAM_AUTH_FAILED",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Telegram rejected the bot token (401 Unauthorized). Check the token from @BotFather.",
			}
		case resp.StatusCode == http.StatusNotFound:
			return &ServiceError{
				Code:       "TELEGRAM_AUTH_FAILED",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Telegram rejected the bot token (404 Not Found). Verify you pasted the full HTTP API token from @BotFather (format: 123456789:AAH...).",
			}
		case resp.StatusCode == http.StatusConflict || strings.Contains(lowerDesc, "webhook"):
			return &ServiceError{
				Code:       "TELEGRAM_WEBHOOK_ACTIVE",
				HTTPStatus: http.StatusConflict,
				Message:    "This Telegram bot has an active webhook, so getUpdates cannot detect chat IDs automatically. Remove the webhook or enter the Chat ID manually.",
			}
		default:
			if desc == "" {
				desc = fmt.Sprintf("HTTP %d", resp.StatusCode)
			}
			return &ServiceError{
				Code:       "TELEGRAM_API_ERROR",
				HTTPStatus: http.StatusBadGateway,
				Message:    fmt.Sprintf("Telegram API error: %s", desc),
			}
		}
	}

	if err := json.Unmarshal(bodyBytes, dest); err != nil {
		return &ServiceError{
			Code:       "TELEGRAM_API_ERROR",
			HTTPStatus: http.StatusBadGateway,
			Message:    "Failed to parse Telegram API response",
		}
	}
	return nil
}

func normalizeTelegramBotToken(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) > 3 && strings.EqualFold(trimmed[:3], "bot") {
		rest := trimmed[3:]
		if looksLikeTelegramBotToken(rest) {
			return rest
		}
	}
	return trimmed
}

func looksLikeTelegramBotToken(token string) bool {
	parts := strings.SplitN(token, ":", 2)
	if len(parts) != 2 || len(parts[0]) == 0 || len(parts[1]) < 10 {
		return false
	}
	for _, r := range parts[0] {
		if r < '0' || r > '9' {
			return false
		}
	}
	for _, r := range parts[1] {
		if r <= ' ' {
			return false
		}
	}
	return true
}

func sanitizeTelegramError(err error, botToken, escapedToken string) error {
	if err == nil {
		return nil
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue != nil {
		ue.URL = redactSecrets(ue.URL, botToken, escapedToken)
	}
	msg := redactSecrets(err.Error(), botToken, escapedToken)
	return errors.New(msg)
}

func redactSecrets(s string, secrets ...string) string {
	for _, sec := range secrets {
		if sec != "" {
			s = strings.ReplaceAll(s, sec, "[REDACTED]")
		}
	}
	return s
}

func formatTelegramMessage(alert WatcherAlert) string {
	var lines []string
	if alert.Title != "" {
		lines = append(lines, alert.Title)
	} else {
		lines = append(lines, "Upwork Buddy Watcher: "+alert.Event)
	}
	if alert.Message != "" {
		lines = append(lines, alert.Message)
	}
	var meta []string
	if alert.RuleName != "" {
		meta = append(meta, "Rule: "+alert.RuleName)
	}
	if alert.Score != nil {
		meta = append(meta, fmt.Sprintf("Score: %d", *alert.Score))
	}
	if alert.ConnectsCost != nil {
		meta = append(meta, fmt.Sprintf("Connects: %d", *alert.ConnectsCost))
	}
	if alert.PendingApprovals > 0 {
		meta = append(meta, fmt.Sprintf("Pending approvals: %d", alert.PendingApprovals))
	}
	if len(meta) > 0 {
		lines = append(lines, strings.Join(meta, " | "))
	}
	if alert.DashboardURL != "" {
		lines = append(lines, alert.DashboardURL)
	}
	return strings.Join(lines, "\n")
}

func (n *Notifier) postJSONWithRetry(ctx context.Context, targetURL string, body []byte, headers map[string]string) error {
	client := n.httpClient
	if client == nil {
		client = &http.Client{Timeout: notifierHTTPTimeout}
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(150 * time.Millisecond):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, bytes.NewReader(body))
		if err != nil {
			return err
		}
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		_ = resp.Body.Close()

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		lastErr = fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
		if resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests {
			return lastErr
		}
	}
	return lastErr
}

func validateWebhookURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid webhook_url: %w", err)
	}
	scheme := strings.ToLower(strings.TrimSpace(u.Scheme))
	if scheme != "http" && scheme != "https" {
		return errors.New("webhook_url must use http or https scheme")
	}
	if strings.TrimSpace(u.Host) == "" {
		return errors.New("webhook_url must include a host")
	}
	return nil
}

func normalizeNotifyEvents(events []string) []string {
	seen := make(map[string]bool, len(events))
	out := make([]string, 0, len(events))
	for _, ev := range events {
		ev = strings.TrimSpace(ev)
		if ev == "" || seen[ev] {
			continue
		}
		seen[ev] = true
		out = append(out, ev)
	}
	return out
}
