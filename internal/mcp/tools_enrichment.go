package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"

	"upwork-buddy/internal/scoring"
	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type saveJobsInput struct {
	Jobs        []map[string]any      `json:"jobs" jsonschema:"List of scraped or curated Upwork job objects to deduplicate, filter, score, and persist"`
	Filters     *scoring.FilterConfig `json:"filters,omitempty" jsonschema:"Optional post-ingest scoring and keyword filters"`
	FilterStage string                `json:"filter_stage,omitempty" jsonschema:"Filter stage: pre_enrichment or post_enrichment"`
	SortByScore *bool                 `json:"sort_by_score,omitempty" jsonschema:"Sort surviving jobs by deterministic score descending"`
	Upsert      *bool                 `json:"upsert,omitempty" jsonschema:"Whether to persist surviving jobs and SearchRun to Postgres (default true)"`
	RunLabel    string                `json:"run_label,omitempty" jsonschema:"Optional label for the persisted SearchRun"`
	Source      string                `json:"source,omitempty" jsonschema:"Ingestion source label (default mcp)"`
	ProjectKeys []string              `json:"project_keys,omitempty" jsonschema:"Optional matched active project keys for SearchRun provenance"`
	Queries     []string              `json:"queries,omitempty" jsonschema:"Optional search queries associated with this batch"`
	Compact     bool                  `json:"compact,omitempty" jsonschema:"Return compact job summaries (job_description < 200 chars, omitting heavy JSONB/AI prose) to save context tokens"`
}

type compactBatchIngestResponse struct {
	Jobs              []compactJobEntry `json:"jobs"`
	TotalReceived     int               `json:"total_received"`
	DeduplicatedCount int               `json:"deduplicated_count"`
	FilteredCount     int               `json:"filtered_count"`
	PersistedCount    int               `json:"persisted_count"`
	SearchRunID       uint              `json:"search_run_id,omitempty"`
	DashboardURL      string            `json:"dashboard_url,omitempty"`
}

type enrichJobsInput struct {
	JobIDs              []any  `json:"job_ids" jsonschema:"List of persisted numeric DB job IDs or Upwork ~jobIDs to enrich"`
	Mode                string `json:"mode,omitempty" jsonschema:"Enrichment mode: full, ai_only, or detail_only (defaults to ENRICHMENT_DEFAULT_MODE)"`
	Force               *bool  `json:"force,omitempty" jsonschema:"Re-run AI enrichment even if already completed (defaults to ENRICHMENT_DEFAULT_FORCE)"`
	SkipDetailIfPresent *bool  `json:"skip_detail_if_present,omitempty" jsonschema:"Skip Chrome detail scrape in full mode when last_enriched_at is already set"`
	RequireDetails      *bool  `json:"require_details,omitempty" jsonschema:"Fail instead of falling back to stored text when Chrome is disconnected"`
	Model               string `json:"model,omitempty" jsonschema:"Optional AGY/Ollama model override"`
	Effort              string `json:"effort,omitempty" jsonschema:"Optional AGY reasoning effort override (low, medium, high, xhigh)"`
	MaxConcurrency      *int   `json:"max_concurrency,omitempty" jsonschema:"Maximum concurrent LLM workers (clamped to ENRICHMENT_MAX_CONCURRENCY)"`
	Wait                *bool  `json:"wait,omitempty" jsonschema:"Wait for batch completion up to wait_timeout_seconds before returning"`
	WaitTimeoutSeconds  *int   `json:"wait_timeout_seconds,omitempty" jsonschema:"Maximum seconds to wait when wait=true"`
}

type enrichmentBatchesInput struct {
	Action  string `json:"action" jsonschema:"Action to perform: list, get, or cancel"`
	BatchID *uint  `json:"batch_id,omitempty" jsonschema:"Enrichment batch ID (required for get and cancel)"`
	Status  string `json:"status,omitempty" jsonschema:"Optional batch status filter when action is list"`
	Limit   *int   `json:"limit,omitempty" jsonschema:"Maximum batches to return when action is list (default 20, max 200)"`
	Offset  int    `json:"offset,omitempty" jsonschema:"Pagination offset when action is list"`
}

type enrichmentBatchListResponse struct {
	Batches      []server.EnrichmentBatchSummary `json:"batches"`
	Total        int                             `json:"total"`
	DashboardURL string                          `json:"dashboard_url,omitempty"`
}

func (s *Server) registerEnrichmentTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_save_jobs",
		Description: "Deduplicate, filter, deterministically score, and persist curated or scraped Upwork job objects alongside a SearchRun provenance record in Postgres (0 LLM tokens).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in saveJobsInput) (*mcp.CallToolResult, any, error) {
		if len(in.Jobs) == 0 {
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "jobs is required and must not be empty",
			})
		}
		// go-sdk/mcp validates /properties/jobs/items against type "object" (from []map[string]any) before invoking this handler.

		source := strings.TrimSpace(in.Source)
		if source == "" {
			source = "mcp"
		}

		bridgePayload := struct {
			Jobs        []map[string]any      `json:"jobs"`
			Filters     *scoring.FilterConfig `json:"filters,omitempty"`
			FilterStage string                `json:"filter_stage,omitempty"`
			SortByScore *bool                 `json:"sort_by_score,omitempty"`
			Upsert      *bool                 `json:"upsert,omitempty"`
			RunLabel    string                `json:"run_label,omitempty"`
			Source      string                `json:"source,omitempty"`
			TriggeredBy string                `json:"triggered_by,omitempty"`
			ProjectKeys []string              `json:"project_keys,omitempty"`
			Queries     []string              `json:"queries,omitempty"`
		}{
			Jobs:        in.Jobs,
			Filters:     in.Filters,
			FilterStage: in.FilterStage,
			SortByScore: in.SortByScore,
			Upsert:      in.Upsert,
			RunLabel:    in.RunLabel,
			Source:      source,
			TriggeredBy: "mcp",
			ProjectKeys: in.ProjectKeys,
			Queries:     in.Queries,
		}

		raw, mErr := json.Marshal(bridgePayload)
		if mErr != nil {
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    fmt.Sprintf("invalid jobs payload: %v", mErr),
			})
		}

		var req server.BatchIngestJobsRequest
		if uErr := json.Unmarshal(raw, &req); uErr != nil {
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    fmt.Sprintf("invalid jobs payload: %v", uErr),
			})
		}
		req.TriggeredBy = "mcp"
		req.Source = source

		res, err := s.backend.BatchIngestJobs(ctx, req)
		if err != nil {
			return toolErrorResult(err)
		}
		if in.Compact {
			return toolSuccess(compactBatchIngestResponse{
				Jobs:              toCompactJobEntries(res.Jobs),
				TotalReceived:     res.TotalReceived,
				DeduplicatedCount: res.DeduplicatedCount,
				FilteredCount:     res.FilteredCount,
				PersistedCount:    res.PersistedCount,
				SearchRunID:       res.SearchRunID,
				DashboardURL:      res.DashboardURL,
			})
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_enrich_jobs",
		Description: "Start a selective, Postgres-backed async batch enrichment run (mode: full, ai_only, or detail_only) across persisted job IDs with env-configured guardrails, skip-cached idempotency, and token accounting.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in enrichJobsInput) (*mcp.CallToolResult, any, error) {
		mgr := s.backend.EnrichmentManager()
		if mgr == nil {
			return toolErrorResult(&server.ServiceError{
				Code:       "SERVICE_UNAVAILABLE",
				HTTPStatus: http.StatusServiceUnavailable,
				Message:    "Enrichment manager unavailable",
			})
		}

		res, err := mgr.StartBatch(ctx, server.BatchEnrichRequest{
			JobIDs:              in.JobIDs,
			Mode:                in.Mode,
			Force:               in.Force,
			SkipDetailIfPresent: in.SkipDetailIfPresent,
			RequireDetails:      in.RequireDetails,
			Model:               in.Model,
			Effort:              in.Effort,
			MaxConcurrency:      in.MaxConcurrency,
			Wait:                in.Wait,
			WaitTimeoutSeconds:  in.WaitTimeoutSeconds,
			TriggeredBy:         "mcp",
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_enrichment_batches",
		Description: "List, inspect, or cancel remaining queued items in async batch enrichment runs.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in enrichmentBatchesInput) (*mcp.CallToolResult, any, error) {
		mgr := s.backend.EnrichmentManager()
		if mgr == nil {
			return toolErrorResult(&server.ServiceError{
				Code:       "SERVICE_UNAVAILABLE",
				HTTPStatus: http.StatusServiceUnavailable,
				Message:    "Enrichment manager unavailable",
			})
		}

		action := strings.ToLower(strings.TrimSpace(in.Action))
		switch action {
		case "list":
			limit := 20
			if in.Limit != nil {
				limit = *in.Limit
			}
			batches, total, err := mgr.ListBatches(ctx, in.Status, limit, in.Offset)
			if err != nil {
				return toolErrorResult(err)
			}
			if batches == nil {
				batches = []server.EnrichmentBatchSummary{}
			}
			return toolSuccess(enrichmentBatchListResponse{
				Batches:      batches,
				Total:        total,
				DashboardURL: s.backend.BuildDashboardURL(""),
			})

		case "get":
			if in.BatchID == nil || *in.BatchID == 0 || uint64(*in.BatchID) > math.MaxInt64 {
				return toolErrorResult(&server.ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "Invalid enrichment batch ID",
				})
			}
			detail, err := mgr.GetBatch(ctx, *in.BatchID)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(detail)

		case "cancel":
			if in.BatchID == nil || *in.BatchID == 0 || uint64(*in.BatchID) > math.MaxInt64 {
				return toolErrorResult(&server.ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "Invalid enrichment batch ID",
				})
			}
			detail, err := mgr.CancelBatch(ctx, *in.BatchID)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(detail)

		default:
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "action must be one of: list, get, cancel",
			})
		}
	})
}
