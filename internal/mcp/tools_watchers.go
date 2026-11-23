package mcp

import (
	"context"
	"net/http"
	"strings"

	"upwork-buddy/internal/ollama"
	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type manageWatchersInput struct {
	Action                       string                  `json:"action" jsonschema:"Action to perform: list, get, create, update, delete, toggle, resume, or status"`
	RuleID                       *uint                   `json:"rule_id,omitempty" jsonschema:"Watch rule numeric ID (for get, update, delete, toggle, resume)"`
	Name                         *string                 `json:"name,omitempty" jsonschema:"Watch rule name (required for create; can also resolve rule for get)"`
	Description                  *string                 `json:"description,omitempty" jsonschema:"Optional rule description"`
	Enabled                      *bool                   `json:"enabled,omitempty" jsonschema:"Whether the rule is enabled for scheduled runs"`
	DiscoveryBackend             *string                 `json:"discovery_backend,omitempty" jsonschema:"Discovery backend: chrome or scraper_fs"`
	SearchProfileID              *uint                   `json:"search_profile_id,omitempty" jsonschema:"Optional SearchProfile ID to merge into discovery"`
	ClearSearchProfileID         bool                    `json:"clear_search_profile_id,omitempty" jsonschema:"Clear linked search_profile_id on update"`
	DiscoveryConfig              *server.DiscoveryConfig `json:"discovery_config,omitempty" jsonschema:"Discovery parameters (query, queries, source, scraper_fs_proxy_mode, scraper_fs_adapter, filters)"`
	IntervalMinutes              *int                    `json:"interval_minutes,omitempty" jsonschema:"Polling interval in minutes (1-1440)"`
	JitterRatio                  *float64                `json:"jitter_ratio,omitempty" jsonschema:"Interval jitter ratio (0.0-0.9)"`
	ActiveHours                  *string                 `json:"active_hours,omitempty" jsonschema:"Optional HH:MM-HH:MM local active window"`
	MinScore                     *int                    `json:"min_score,omitempty" jsonschema:"Minimum deterministic job score (0-100)"`
	MaxProposals                 *int                    `json:"max_proposals,omitempty" jsonschema:"Optional maximum proposals count gate"`
	MaxPostedAgeMinutes          *int                    `json:"max_posted_age_minutes,omitempty" jsonschema:"Optional maximum job posted age in minutes"`
	MaxConnectsPerJob            *int                    `json:"max_connects_per_job,omitempty" jsonschema:"Optional maximum connects per job"`
	RequirePaymentVerified       *bool                   `json:"require_payment_verified,omitempty" jsonschema:"Require verified client payment method"`
	RequiredKeywords             []string                `json:"required_keywords,omitempty" jsonschema:"Keywords that must match job title/description/skills"`
	ExcludeKeywords              []string                `json:"exclude_keywords,omitempty" jsonschema:"Keywords that disqualify a job"`
	ActionMode                   *string                 `json:"action_mode,omitempty" jsonschema:"Reaction mode: alert_only, draft_and_fill, or auto_submit"`
	LLMModel                     *string                 `json:"llm_model,omitempty" jsonschema:"Optional LLM model override for fast proposal drafting"`
	LLMEffort                    *string                 `json:"llm_effort,omitempty" jsonschema:"Optional AGY effort override"`
	BidStrategy                  *ollama.BidStrategy     `json:"bid_strategy,omitempty" jsonschema:"Pricing and boost guardrails for proposal drafting"`
	AutoSubmitMinConfidence      *float64                `json:"auto_submit_min_confidence,omitempty" jsonschema:"Minimum LLM confidence (0.0-1.0) required for auto_submit"`
	FallbackOnScreeningQuestions *bool                   `json:"fallback_on_screening_questions,omitempty" jsonschema:"Fallback to pending_approval when screening questions are ambiguous"`
	MaxReactionsPerTick          *int                    `json:"max_reactions_per_tick,omitempty" jsonschema:"Maximum jobs to react to per tick (1-20)"`
	SeedBaselineOnFirstRun       *bool                   `json:"seed_baseline_on_first_run,omitempty" jsonschema:"Seed existing page-1 jobs on first run without reacting"`
}

type runWatcherInput struct {
	RuleID         *uint  `json:"rule_id,omitempty" jsonschema:"Watch rule ID to run"`
	Name           string `json:"name,omitempty" jsonschema:"Watch rule name to run if rule_id is omitted"`
	DryRun         bool   `json:"dry_run,omitempty" jsonschema:"Evaluate and preview without filling, submitting, or persisting WatchEvents"`
	IgnoreBaseline bool   `json:"ignore_baseline,omitempty" jsonschema:"Bypass first-run baseline seeding and react immediately"`
}

type watcherEventsInput struct {
	RuleID      *uint `json:"rule_id,omitempty" jsonschema:"Optional WatchRule ID filter"`
	Limit       *int  `json:"limit,omitempty" jsonschema:"Max events/runs to return (default 50, max 200)"`
	Offset      int   `json:"offset,omitempty" jsonschema:"Pagination offset"`
	IncludeRuns bool  `json:"include_runs,omitempty" jsonschema:"Include recent WatchRun records when rule_id is provided"`
}

type configureNotificationsInput struct {
	Action                     string   `json:"action" jsonschema:"Action: get, update, or test"`
	ChromeNotificationsEnabled *bool    `json:"chrome_notifications_enabled,omitempty" jsonschema:"Enable Chrome extension desktop notifications"`
	WebhookEnabled             *bool    `json:"webhook_enabled,omitempty" jsonschema:"Enable generic JSON webhook notifications"`
	WebhookURL                 *string  `json:"webhook_url,omitempty" jsonschema:"Webhook target URL (http or https)"`
	WebhookSecret              *string  `json:"webhook_secret,omitempty" jsonschema:"HMAC-SHA256 webhook signing secret (leave blank to keep existing)"`
	ClearWebhookSecret         bool     `json:"clear_webhook_secret,omitempty" jsonschema:"Explicitly clear the stored webhook secret"`
	TelegramEnabled            *bool    `json:"telegram_enabled,omitempty" jsonschema:"Enable Telegram Bot API notifications"`
	TelegramBotToken           *string  `json:"telegram_bot_token,omitempty" jsonschema:"Telegram bot token (leave blank to keep existing)"`
	ClearTelegramBotToken      bool     `json:"clear_telegram_bot_token,omitempty" jsonschema:"Explicitly clear the stored Telegram bot token"`
	TelegramChatID             *string  `json:"telegram_chat_id,omitempty" jsonschema:"Telegram chat ID"`
	NotifyEvents               []string `json:"notify_events,omitempty" jsonschema:"Enabled event types (hot_job_alert, pending_approval, proposal_submitted, human_action_required, watcher_paused)"`
	Channel                    string   `json:"channel,omitempty" jsonschema:"Optional channel filter for test action: chrome, webhook, or telegram"`
}

func (s *Server) registerWatcherTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_manage_watchers",
		Description: "List, inspect, create, update, delete, toggle, resume, or check daemon status of autonomous job watcher rules (Chrome or upwork-scraper-fs).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in manageWatchersInput) (*mcp.CallToolResult, any, error) {
		action := strings.ToLower(strings.TrimSpace(in.Action))
		switch action {
		case "list":
			rules, err := s.backend.ListWatchRules(ctx)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"rules": rules})

		case "status":
			status := s.backend.WatcherManager().Status(ctx)
			return toolSuccess(status)

		case "get":
			name := ""
			if in.Name != nil {
				name = *in.Name
			}
			rule, err := s.backend.ResolveWatchRule(ctx, in.RuleID, name)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"rule": rule})

		case "create":
			rule, err := s.backend.CreateWatchRule(ctx, toUpsertWatchRuleInput(in))
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"rule": rule})

		case "update":
			if in.RuleID == nil || *in.RuleID == 0 {
				return toolErrorResult(&server.ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "rule_id is required for update"})
			}
			rule, err := s.backend.UpdateWatchRule(ctx, *in.RuleID, toUpsertWatchRuleInput(in))
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"rule": rule})

		case "delete":
			if in.RuleID == nil || *in.RuleID == 0 {
				return toolErrorResult(&server.ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "rule_id is required for delete"})
			}
			if err := s.backend.DeleteWatchRule(ctx, *in.RuleID); err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"ok": true, "deleted_id": *in.RuleID})

		case "toggle":
			if in.RuleID == nil || *in.RuleID == 0 {
				return toolErrorResult(&server.ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "rule_id is required for toggle"})
			}
			rule, err := s.backend.ToggleWatchRule(ctx, *in.RuleID, in.Enabled)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"rule": rule})

		case "resume":
			if in.RuleID == nil || *in.RuleID == 0 {
				return toolErrorResult(&server.ServiceError{Code: "INVALID_PARAMS", HTTPStatus: http.StatusBadRequest, Message: "rule_id is required for resume"})
			}
			rule, err := s.backend.ResumeWatchRule(ctx, *in.RuleID)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"rule": rule})

		default:
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "action must be list, get, create, update, delete, toggle, resume, or status",
			})
		}
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_run_watcher",
		Description: "Trigger an immediate execution or dry-run preview of a WatchRule by rule_id or name.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in runWatcherInput) (*mcp.CallToolResult, any, error) {
		rule, err := s.backend.ResolveWatchRule(ctx, in.RuleID, in.Name)
		if err != nil {
			return toolErrorResult(err)
		}
		res, runErr := s.backend.WatcherManager().RunRule(ctx, rule.ID, "mcp", in.DryRun, in.IgnoreBaseline)
		if runErr != nil {
			return toolErrorResult(runErr)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_watcher_events",
		Description: "List persisted WatchEvents (and optionally recent WatchRuns) for a watch rule or across all rules.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in watcherEventsInput) (*mcp.CallToolResult, any, error) {
		var ruleID uint
		if in.RuleID != nil {
			ruleID = *in.RuleID
		}
		limit := 50
		if in.Limit != nil && *in.Limit > 0 {
			limit = *in.Limit
		}
		events, total, err := s.backend.ListWatchEvents(ctx, ruleID, limit, in.Offset)
		if err != nil {
			return toolErrorResult(err)
		}
		out := map[string]any{
			"events": events,
			"total":  total,
		}
		if in.IncludeRuns && ruleID > 0 {
			runs, runsTotal, rErr := s.backend.ListWatchRuns(ctx, ruleID, limit, in.Offset)
			if rErr != nil {
				return toolErrorResult(rErr)
			}
			out["runs"] = runs
			out["runs_total"] = runsTotal
		}
		return toolSuccess(out)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_configure_notifications",
		Description: "Get, update, or test dual-channel watcher notifications (Chrome desktop, signed Webhook, Telegram Bot API) with secret hygiene.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in configureNotificationsInput) (*mcp.CallToolResult, any, error) {
		action := strings.ToLower(strings.TrimSpace(in.Action))
		switch action {
		case "get":
			cfg, err := s.backend.GetNotificationConfig(ctx)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"config": cfg})

		case "update":
			cfg, err := s.backend.UpdateNotificationConfig(ctx, server.UpdateNotificationConfigInput{
				ChromeNotificationsEnabled: in.ChromeNotificationsEnabled,
				WebhookEnabled:             in.WebhookEnabled,
				WebhookURL:                 in.WebhookURL,
				WebhookSecret:              in.WebhookSecret,
				ClearWebhookSecret:         in.ClearWebhookSecret,
				TelegramEnabled:            in.TelegramEnabled,
				TelegramBotToken:           in.TelegramBotToken,
				ClearTelegramBotToken:      in.ClearTelegramBotToken,
				TelegramChatID:             in.TelegramChatID,
				NotifyEvents:               in.NotifyEvents,
			})
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"config": cfg})

		case "test":
			ok, results := server.NewNotifier(s.backend).SendSync(ctx, server.WatcherAlert{
				Event:   "test",
				Title:   "Upwork Buddy Test Notification",
				Message: "Your watcher notification channel is configured and reachable.",
			}, strings.TrimSpace(in.Channel))
			return toolSuccess(map[string]any{
				"ok":      ok,
				"results": results,
			})

		default:
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "action must be get, update, or test",
			})
		}
	})
}

func toNullableInt(p *int) server.NullableInt {
	if p == nil {
		return server.NullableInt{}
	}
	return server.NewNullableInt(*p)
}

func toUpsertWatchRuleInput(in manageWatchersInput) server.UpsertWatchRuleInput {
	return server.UpsertWatchRuleInput{
		Name:                         in.Name,
		Description:                  in.Description,
		Enabled:                      in.Enabled,
		DiscoveryBackend:             in.DiscoveryBackend,
		SearchProfileID:              in.SearchProfileID,
		ClearSearchProfileID:         in.ClearSearchProfileID,
		DiscoveryConfig:              in.DiscoveryConfig,
		IntervalMinutes:              in.IntervalMinutes,
		JitterRatio:                  in.JitterRatio,
		ActiveHours:                  in.ActiveHours,
		MinScore:                     in.MinScore,
		MaxProposals:                 toNullableInt(in.MaxProposals),
		MaxPostedAgeMinutes:          toNullableInt(in.MaxPostedAgeMinutes),
		MaxConnectsPerJob:            toNullableInt(in.MaxConnectsPerJob),
		RequirePaymentVerified:       in.RequirePaymentVerified,
		RequiredKeywords:             in.RequiredKeywords,
		ExcludeKeywords:              in.ExcludeKeywords,
		ActionMode:                   in.ActionMode,
		LLMModel:                     in.LLMModel,
		LLMEffort:                    in.LLMEffort,
		BidStrategy:                  in.BidStrategy,
		AutoSubmitMinConfidence:      in.AutoSubmitMinConfidence,
		FallbackOnScreeningQuestions: in.FallbackOnScreeningQuestions,
		MaxReactionsPerTick:          in.MaxReactionsPerTick,
		SeedBaselineOnFirstRun:       in.SeedBaselineOnFirstRun,
	}
}
