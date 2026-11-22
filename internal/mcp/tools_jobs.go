package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"upwork-buddy/internal/scoring"
	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type compactJobEntry struct {
	ID                 uint     `json:"id"`
	UpworkJobID        string   `json:"upwork_job_id,omitempty"`
	CanonicalURL       string   `json:"canonical_url,omitempty"`
	JobTitle           string   `json:"job_title"`
	JobDescription     string   `json:"job_description"`
	URL                string   `json:"url,omitempty"`
	Source             string   `json:"source,omitempty"`
	SourceFeed         string   `json:"source_feed,omitempty"`
	SourceQuery        string   `json:"source_query,omitempty"`
	Status             string   `json:"status,omitempty"`
	ContractType       string   `json:"contract_type"`
	Budget             string   `json:"budget"`
	RateRange          string   `json:"rate_range"`
	RateMin            string   `json:"rate_min"`
	RateMax            string   `json:"rate_max"`
	BudgetAmount       string   `json:"budget_amount"`
	ExperienceLevel    string   `json:"experience_level"`
	Duration           string   `json:"duration,omitempty"`
	HoursPerWeek       string   `json:"hours_per_week,omitempty"`
	Skills             string   `json:"skills"`
	PostedText         string   `json:"posted_text,omitempty"`
	PostedAtEst        *string  `json:"posted_at_est,omitempty"`
	ProposalsTier      string   `json:"proposals_tier,omitempty"`
	ProposalsCount     *int     `json:"proposals_count,omitempty"`
	ConnectsRequired   *int     `json:"connects_required,omitempty"`
	ClientCountry      string   `json:"client_country,omitempty"`
	ClientRating       *float64 `json:"client_rating,omitempty"`
	ClientReviews      *int     `json:"client_reviews,omitempty"`
	ClientSpent        string   `json:"client_spent,omitempty"`
	ClientSpentUSD     *float64 `json:"client_spent_usd,omitempty"`
	ClientHires        *int     `json:"client_hires,omitempty"`
	ClientHireRate     *float64 `json:"client_hire_rate,omitempty"`
	PaymentVerified    *bool    `json:"payment_verified,omitempty"`
	Score                 *int     `json:"score,omitempty"`
	FitLabel              string   `json:"fit_label,omitempty"`
	FitAssessment         string   `json:"fit_assessment,omitempty"`
	MatchedActiveProjects []string `json:"matched_active_projects,omitempty"`
	AIEnrichmentStatus    string   `json:"ai_enrichment_status"`
	AIEnrichedAt       *string  `json:"ai_enriched_at,omitempty"`
	AIEnrichmentError  string   `json:"ai_enrichment_error,omitempty"`
	AIModel            string   `json:"ai_model,omitempty"`
	AIEffort           string   `json:"ai_effort,omitempty"`
	AITokensUsed       *int     `json:"ai_tokens_used,omitempty"`
	LastSearchRunID    *uint    `json:"last_search_run_id,omitempty"`
	CreatedAt          string   `json:"created_at"`
	UpdatedAt          string   `json:"updated_at,omitempty"`
}

func truncateCompactDescription(desc string) string {
	trimmed := strings.TrimSpace(desc)
	runes := []rune(trimmed)
	if len(runes) <= 160 {
		return trimmed
	}
	return strings.TrimSpace(string(runes[:160])) + "..."
}

func extractCompactMatchedActiveProjects(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var sb struct {
		MatchedActiveProjects []string `json:"matched_active_projects"`
	}
	if err := json.Unmarshal(raw, &sb); err != nil || len(sb.MatchedActiveProjects) == 0 {
		return nil
	}
	return sb.MatchedActiveProjects
}

func toCompactJobEntry(j server.JobEntry) compactJobEntry {
	return compactJobEntry{
		ID:                    j.ID,
		UpworkJobID:           j.UpworkJobID,
		CanonicalURL:          j.CanonicalURL,
		JobTitle:              j.JobTitle,
		JobDescription:        truncateCompactDescription(j.JobDescription),
		URL:                   j.URL,
		Source:                j.Source,
		SourceFeed:            j.SourceFeed,
		SourceQuery:           j.SourceQuery,
		Status:                j.Status,
		ContractType:          j.ContractType,
		Budget:                j.Budget,
		RateRange:             j.RateRange,
		RateMin:               j.RateMin,
		RateMax:               j.RateMax,
		BudgetAmount:          j.BudgetAmount,
		ExperienceLevel:       j.ExperienceLevel,
		Duration:              j.Duration,
		HoursPerWeek:          j.HoursPerWeek,
		Skills:                j.Skills,
		PostedText:            j.PostedText,
		PostedAtEst:           j.PostedAtEst,
		ProposalsTier:         j.ProposalsTier,
		ProposalsCount:        j.ProposalsCount,
		ConnectsRequired:      j.ConnectsRequired,
		ClientCountry:         j.ClientCountry,
		ClientRating:          j.ClientRating,
		ClientReviews:         j.ClientReviews,
		ClientSpent:           j.ClientSpent,
		ClientSpentUSD:        j.ClientSpentUSD,
		ClientHires:           j.ClientHires,
		ClientHireRate:        j.ClientHireRate,
		PaymentVerified:       j.PaymentVerified,
		Score:                 j.Score,
		FitLabel:              j.FitLabel,
		FitAssessment:         j.FitAssessment,
		MatchedActiveProjects: extractCompactMatchedActiveProjects(j.ScoreBreakdown),
		AIEnrichmentStatus:    j.AIEnrichmentStatus,
		AIEnrichedAt:       j.AIEnrichedAt,
		AIEnrichmentError:  j.AIEnrichmentError,
		AIModel:            j.AIModel,
		AIEffort:           j.AIEffort,
		AITokensUsed:       j.AITokensUsed,
		LastSearchRunID:    j.LastSearchRunID,
		CreatedAt:          j.CreatedAt,
		UpdatedAt:          j.UpdatedAt,
	}
}

func toCompactJobEntries(jobs []server.JobEntry) []compactJobEntry {
	out := make([]compactJobEntry, 0, len(jobs))
	for _, j := range jobs {
		out = append(out, toCompactJobEntry(j))
	}
	return out
}

type compactSearchJobsResponse struct {
	SearchRunID        uint              `json:"search_run_id,omitempty"`
	Jobs               []compactJobEntry `json:"jobs"`
	TotalScraped       int               `json:"total_scraped"`
	FilteredCount      int               `json:"filtered_count"`
	EnrichedCount      int               `json:"enriched_count"`
	StoppedReason      string            `json:"stopped_reason"`
	MatchedProjectKeys []string          `json:"matched_project_keys,omitempty"`
	DashboardURL       string            `json:"dashboard_url,omitempty"`
}

type listSavedJobsResponse struct {
	Jobs         any    `json:"jobs"`
	Total        int    `json:"total"`
	DashboardURL string `json:"dashboard_url,omitempty"`
}

type searchJobsInput struct {
	Source               string                `json:"source,omitempty" jsonschema:"Discovery source: search, best_matches, most_recent, or saved_jobs"`
	Query                string                `json:"query,omitempty" jsonschema:"Search query string"`
	Queries              []string              `json:"queries,omitempty" jsonschema:"Optional multiple search query strings"`
	Sort                 string                `json:"sort,omitempty" jsonschema:"Search sort order: recency or relevance"`
	PerPage              *int                  `json:"per_page,omitempty" jsonschema:"Results per page (10, 20, or 50)"`
	ContractorTier       []int                 `json:"contractor_tier,omitempty" jsonschema:"Contractor experience tiers (1, 2, 3)"`
	ContractType         string                `json:"contract_type,omitempty" jsonschema:"Contract type: hourly or fixed"`
	ProposalTiers        []string              `json:"proposal_tiers,omitempty" jsonschema:"Upwork proposal tier filters"`
	Amount               string                `json:"amount,omitempty" jsonschema:"Upwork fixed-price amount range facet (e.g. 500-5000, 500-, -5000)"`
	BudgetMin            *int                  `json:"budget_min,omitempty" jsonschema:"Minimum fixed-price budget"`
	BudgetMax            *int                  `json:"budget_max,omitempty" jsonschema:"Maximum fixed-price budget"`
	HourlyRateMin        *float64              `json:"hourly_rate_min,omitempty" jsonschema:"Minimum hourly rate filter in USD"`
	HourlyRateMax        *float64              `json:"hourly_rate_max,omitempty" jsonschema:"Maximum hourly rate filter in USD"`
	PaymentVerifiedOnly  *bool                 `json:"payment_verified_only,omitempty" jsonschema:"Only keep jobs from payment-verified clients"`
	Category             string                `json:"category,omitempty" jsonschema:"Upwork category slug"`
	SearchURL            string                `json:"search_url,omitempty" jsonschema:"Explicit Upwork search URL"`
	StartPage            int                   `json:"start_page,omitempty" jsonschema:"Starting page number (default 1)"`
	MaxPages             int                   `json:"max_pages,omitempty" jsonschema:"Maximum pages to scan (default 1)"`
	TargetJobs           *int                  `json:"target_jobs,omitempty" jsonschema:"Target candidate count to stop early"`
	EnrichTopN           *int                  `json:"enrich_top_n,omitempty" jsonschema:"Number of top-scored candidates to detail-enrich"`
	SkipAutoDetailEnrich bool                  `json:"skip_auto_detail_enrich,omitempty" jsonschema:"Skip automatic top-N Chrome detail scraping during search"`
	ProfileID            *uint                 `json:"profile_id,omitempty" jsonschema:"Optional persisted search profile ID"`
	Filters              *scoring.FilterConfig `json:"filters,omitempty" jsonschema:"Optional post-scrape scoring and keyword filters"`
	RunLabel             string                `json:"run_label,omitempty" jsonschema:"Optional label for the persisted SearchRun"`
	FromActiveProjects   bool                  `json:"from_active_projects,omitempty" jsonschema:"Derive NDA-safe search queries from synced active_projects tech stacks"`
	ActiveProjectKeys    []string              `json:"active_project_keys,omitempty" jsonschema:"Optional specific active project keys to seed queries from"`
	ActiveProjectTiers   []string              `json:"active_project_tiers,omitempty" jsonschema:"Optional activity tiers when deriving queries (default: active)"`
	Compact              bool                  `json:"compact,omitempty" jsonschema:"Return compact job summaries (job_description < 200 chars, omitting heavy JSONB/AI prose) to save context tokens"`
}

type getJobDetailsInput struct {
	JobID       any      `json:"job_id,omitempty" jsonschema:"Persisted numeric DB job ID or Upwork ~jobID"`
	UpworkJobID string   `json:"upwork_job_id,omitempty" jsonschema:"Upwork job ID (e.g. ~01abc)"`
	URL         string   `json:"url,omitempty" jsonschema:"Canonical or raw Upwork job URL"`
	URLs        []string `json:"urls,omitempty" jsonschema:"Multiple Upwork job URLs for batch detail enrichment"`
	MaxJobs     *int     `json:"max_jobs,omitempty" jsonschema:"Maximum number of URLs to enrich"`
}

type listSavedJobsInput struct {
	SearchRunID          *uint    `json:"search_run_id,omitempty" jsonschema:"Filter to jobs persisted/linked under a specific SearchRun ID"`
	Status               string   `json:"status,omitempty" jsonschema:"Filter by job status"`
	Fit                  string   `json:"fit,omitempty" jsonschema:"Filter by fit_label (hot, ready, review, skip)"`
	ContractType         string   `json:"contract_type,omitempty" jsonschema:"Filter by contract type: hourly or fixed"`
	SourceQuery          string   `json:"source_query,omitempty" jsonschema:"Filter by source query string"`
	MinScore             *int     `json:"min_score,omitempty" jsonschema:"Minimum deterministic score (0-100)"`
	MaxAgeDays           *int     `json:"max_age_days,omitempty" jsonschema:"Maximum job age in days"`
	MaxProposals         *int     `json:"max_proposals,omitempty" jsonschema:"Maximum proposal count"`
	IncludeUnknown       bool     `json:"include_unknown,omitempty" jsonschema:"Include jobs with unknown proposal counts when max_proposals is set"`
	IncludeUnknownBudget bool     `json:"include_unknown_budget,omitempty" jsonschema:"Include jobs with unknown fixed-price/hourly compensation when budget or rate filters are set"`
	Query                string   `json:"query,omitempty" jsonschema:"Case-insensitive text search across title, description, and skills"`
	Q                    string   `json:"q,omitempty" jsonschema:"Alias for query"`
	RequiredKeywords     []string `json:"required_keywords,omitempty" jsonschema:"Require at least one matching keyword across title, description, and skills"`
	ExcludeKeywords      []string `json:"exclude_keywords,omitempty" jsonschema:"Exclude jobs matching any keyword across title, description, and skills"`
	BudgetMin            *float64 `json:"budget_min,omitempty" jsonschema:"Minimum fixed-price budget"`
	BudgetMax            *float64 `json:"budget_max,omitempty" jsonschema:"Maximum fixed-price budget"`
	HourlyRateMin        *float64 `json:"hourly_rate_min,omitempty" jsonschema:"Minimum hourly rate in USD"`
	HourlyRateMax        *float64 `json:"hourly_rate_max,omitempty" jsonschema:"Maximum hourly rate in USD"`
	EnrichmentStatus     string   `json:"enrichment_status,omitempty" jsonschema:"Filter by enrichment state: none, detail_only, queued, scraping_details, analyzing, completed, failed"`
	HasAIAnalysis        *bool    `json:"has_ai_analysis,omitempty" jsonschema:"Filter by whether AI analysis has been completed"`
	MatchedProject       string   `json:"matched_project,omitempty" jsonschema:"Filter by matched active project key or NDA-safe label"`
	Sort                 string   `json:"sort,omitempty" jsonschema:"Sort order: created_desc, score_desc, posted_desc, budget_desc, or enriched_desc"`
	Limit                *int     `json:"limit,omitempty" jsonschema:"Maximum jobs to return (default 50, max 500)"`
	Offset               int      `json:"offset,omitempty" jsonschema:"Pagination offset"`
	Compact              bool     `json:"compact,omitempty" jsonschema:"Return compact job summaries (job_description < 200 chars, omitting heavy JSONB/AI prose) to save context tokens"`
}

type analyzeJobInput struct {
	JobID         any    `json:"job_id,omitempty" jsonschema:"Persisted numeric DB job ID or Upwork ~jobID"`
	UpworkJobID   string `json:"upwork_job_id,omitempty" jsonschema:"Upwork job ID (e.g. ~01abc)"`
	EnsureDetails bool   `json:"ensure_details,omitempty" jsonschema:"Fetch missing full job details via Chrome before running analysis (default false)"`
	UseLLM        *bool  `json:"use_llm,omitempty" jsonschema:"Whether to also invoke AGY/Ollama LLM analysis (requires AGY_ENDPOINT_URL or OLLAMA_API_KEY)"`
	Model         string `json:"model,omitempty" jsonschema:"Optional LLM model override (e.g. gemini-pro-orchestrator-neon, gemini-4-neon, gpt-oss:120b)"`
	Effort        string `json:"effort,omitempty" jsonschema:"Optional AGY reasoning effort override (low, medium, high, xhigh)"`
}

type manageSearchProfilesInput struct {
	Action       string `json:"action" jsonschema:"Action to perform: list, save, import_yaml, run, or delete"`
	Active       *bool  `json:"active,omitempty" jsonschema:"Filter by active status when action is list"`
	ID           *uint  `json:"id,omitempty" jsonschema:"Search profile numeric ID for run or delete"`
	Name         string `json:"name,omitempty" jsonschema:"Search profile name"`
	Profile      string `json:"profile,omitempty" jsonschema:"Alias for search profile name"`
	Description  string `json:"description,omitempty" jsonschema:"Search profile description"`
	IsActive     *bool  `json:"is_active,omitempty" jsonschema:"Whether the saved/imported profile is active"`
	NameOverride string `json:"name_override,omitempty" jsonschema:"Optional override name for first imported YAML profile"`
	Config       any    `json:"config,omitempty" jsonschema:"Nested SearchProfileConfig object"`
	Search       any    `json:"search,omitempty" jsonschema:"Top-level search workflow configuration"`
	Filters      any    `json:"filters,omitempty" jsonschema:"Top-level filter configuration"`
	Enrichment   any    `json:"enrichment,omitempty" jsonschema:"Top-level enrichment configuration"`
	Transport    any    `json:"transport,omitempty" jsonschema:"Top-level transport configuration"`
	Output       any    `json:"output,omitempty" jsonschema:"Top-level output configuration"`
	YAML         string `json:"yaml,omitempty" jsonschema:"YAML search profile payload for import_yaml or save"`
}

func (s *Server) registerJobTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_search_jobs",
		Description: "Search Upwork or authenticated feeds directly via Upwork Buddy's Chrome session, persist a SearchRun, and deterministically score candidates in Postgres (0 LLM tokens). Follow up selectively with upwork_enrich_jobs.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchJobsInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.ExecuteSearchPipeline(ctx, server.SearchJobsRequest{
			Source:               in.Source,
			Query:                in.Query,
			Queries:              in.Queries,
			Sort:                 in.Sort,
			PerPage:              in.PerPage,
			ContractorTier:       in.ContractorTier,
			ContractType:         in.ContractType,
			ProposalTiers:        in.ProposalTiers,
			Amount:               in.Amount,
			BudgetMin:            in.BudgetMin,
			BudgetMax:            in.BudgetMax,
			HourlyRateMin:        in.HourlyRateMin,
			HourlyRateMax:        in.HourlyRateMax,
			PaymentVerifiedOnly:  in.PaymentVerifiedOnly,
			Category:             in.Category,
			SearchURL:            in.SearchURL,
			StartPage:            in.StartPage,
			MaxPages:             in.MaxPages,
			TargetJobs:           in.TargetJobs,
			EnrichTopN:           in.EnrichTopN,
			SkipAutoDetailEnrich: in.SkipAutoDetailEnrich,
			ProfileID:            in.ProfileID,
			Filters:              in.Filters,
			RunLabel:             in.RunLabel,
			FromActiveProjects:   in.FromActiveProjects,
			ActiveProjectKeys:    in.ActiveProjectKeys,
			ActiveProjectTiers:   in.ActiveProjectTiers,
			TriggeredBy:          "mcp",
		})
		if err != nil {
			return toolErrorResult(err)
		}
		if in.Compact {
			return toolSuccess(compactSearchJobsResponse{
				SearchRunID:        res.SearchRunID,
				Jobs:               toCompactJobEntries(res.Jobs),
				TotalScraped:       res.TotalScraped,
				FilteredCount:      res.FilteredCount,
				EnrichedCount:      res.EnrichedCount,
				StoppedReason:      res.StoppedReason,
				MatchedProjectKeys: res.MatchedProjectKeys,
				DashboardURL:       res.DashboardURL,
			})
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_get_job_details",
		Description: "Fetch and enrich full job details, authenticated client metrics, screening questions, and connects cost via Chrome and upsert into Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in getJobDetailsInput) (*mcp.CallToolResult, any, error) {
		req := server.DetailEnrichRequest{
			URL:         strings.TrimSpace(in.URL),
			UpworkJobID: strings.TrimSpace(in.UpworkJobID),
			URLs:        in.URLs,
			MaxJobs:     in.MaxJobs,
		}

		if in.JobID != nil {
			switch v := in.JobID.(type) {
			case string:
				trimmed := strings.TrimSpace(v)
				if trimmed != "" {
					if numID, err := strconv.ParseUint(trimmed, 10, 64); err == nil || errors.Is(err, strconv.ErrRange) {
						if err != nil || numID == 0 || numID > math.MaxInt64 {
							return toolErrorResult(&server.ServiceError{
								Code:       "INVALID_PARAMS",
								HTTPStatus: http.StatusBadRequest,
								Message:    "Invalid numeric job_id",
							})
						}
						job, rErr := s.backend.ResolveJobRef(ctx, numID, "")
						if rErr != nil {
							return toolErrorResult(rErr)
						}
						if job.UpworkJobID != nil && *job.UpworkJobID != "" {
							req.UpworkJobID = *job.UpworkJobID
						}
						if req.URL == "" {
							req.URL = job.CanonicalURL
							if req.URL == "" {
								req.URL = job.URL
							}
						}
					} else {
						req.UpworkJobID = scoring.NormalizeUpworkJobID(trimmed)
						if req.UpworkJobID == "" {
							req.UpworkJobID = trimmed
						}
					}
				}
			case float64, int, int64, uint, uint64:
				job, rErr := s.backend.ResolveJobRef(ctx, v, "")
				if rErr != nil {
					return toolErrorResult(rErr)
				}
				if job.UpworkJobID != nil && *job.UpworkJobID != "" {
					req.UpworkJobID = *job.UpworkJobID
				}
				if req.URL == "" {
					req.URL = job.CanonicalURL
					if req.URL == "" {
						req.URL = job.URL
					}
				}
			default:
				job, rErr := s.backend.ResolveJobRef(ctx, v, "")
				if rErr != nil {
					return toolErrorResult(rErr)
				}
				if job.UpworkJobID != nil && *job.UpworkJobID != "" {
					req.UpworkJobID = *job.UpworkJobID
				}
				if req.URL == "" {
					req.URL = job.CanonicalURL
					if req.URL == "" {
						req.URL = job.URL
					}
				}
			}
		}

		if req.URL == "" && req.UpworkJobID == "" && len(req.URLs) == 0 {
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "job_id, upwork_job_id, url, or urls is required",
			})
		}

		res, err := s.backend.ExecuteDetailEnrich(ctx, req)
		if err != nil {
			return toolErrorResult(err)
		}
		if res.NotFound && len(res.Jobs) == 0 {
			return toolErrorResult(&server.ServiceError{
				Code:       "NOT_FOUND",
				HTTPStatus: http.StatusNotFound,
				Message:    "Job not found on Upwork",
				Details:    map[string]any{"not_found_urls": res.NotFoundURLs},
			})
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_list_saved_jobs",
		Description: "Query and filter persisted Upwork jobs in Postgres by search run, status, fit label, contract type, enrichment status, matched active project, score, age, proposal count, budget, hourly rate, and search query.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listSavedJobsInput) (*mcp.CallToolResult, any, error) {
		limit := 50
		if in.Limit != nil {
			if *in.Limit <= 0 {
				return toolErrorResult(&server.ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "limit must be a positive integer",
				})
			}
			limit = *in.Limit
		}
		query := strings.TrimSpace(in.Query)
		if query == "" {
			query = strings.TrimSpace(in.Q)
		}
		jobs, total, err := s.backend.ListJobsWithTotal(ctx, server.ListJobsFilter{
			SearchRunID:          in.SearchRunID,
			Status:               in.Status,
			Fit:                  in.Fit,
			ContractType:         in.ContractType,
			SourceQuery:          in.SourceQuery,
			MinScore:             in.MinScore,
			MaxAgeDays:           in.MaxAgeDays,
			MaxProposals:         in.MaxProposals,
			IncludeUnknown:       in.IncludeUnknown,
			IncludeUnknownBudget: in.IncludeUnknownBudget,
			Query:                query,
			RequiredKeywords:     in.RequiredKeywords,
			ExcludeKeywords:      in.ExcludeKeywords,
			BudgetMin:            in.BudgetMin,
			BudgetMax:            in.BudgetMax,
			HourlyRateMin:        in.HourlyRateMin,
			HourlyRateMax:        in.HourlyRateMax,
			EnrichmentStatus:     in.EnrichmentStatus,
			HasAIAnalysis:        in.HasAIAnalysis,
			MatchedProject:       in.MatchedProject,
			Limit:                limit,
			Offset:               in.Offset,
			Sort:                 in.Sort,
		})
		if err != nil {
			return toolErrorResult(err)
		}

		vals := url.Values{}
		if in.SearchRunID != nil && *in.SearchRunID > 0 {
			vals.Set("run", strconv.FormatUint(uint64(*in.SearchRunID), 10))
		}
		if fit := strings.TrimSpace(in.Fit); fit != "" {
			vals.Set("fit", fit)
		}
		if query != "" {
			vals.Set("q", query)
		}
		if es := strings.TrimSpace(in.EnrichmentStatus); es != "" {
			vals.Set("enrichment_status", es)
		}
		if ct := strings.TrimSpace(in.ContractType); ct != "" {
			vals.Set("contract_type", ct)
		}
		if mp := strings.TrimSpace(in.MatchedProject); mp != "" {
			vals.Set("matched_project", mp)
		}
		dashboardURL := s.backend.BuildDashboardURL(vals.Encode())

		var outJobs any
		if in.Compact {
			outJobs = toCompactJobEntries(jobs)
		} else {
			if jobs == nil {
				jobs = []server.JobEntry{}
			}
			outJobs = jobs
		}

		return toolSuccess(listSavedJobsResponse{
			Jobs:         outJobs,
			Total:        total,
			DashboardURL: dashboardURL,
		})
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_analyze_job",
		Description: "Run deterministic scoring against the live freelancer profile (plus optional AGY/Ollama LLM analysis and optional Chrome detail pre-fetch) and persist updated score/analysis back to Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in analyzeJobInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.AnalyzeJob(ctx, server.AnalyzeJobRequest{
			JobID:         in.JobID,
			UpworkJobID:   in.UpworkJobID,
			EnsureDetails: in.EnsureDetails,
			UseLLM:        in.UseLLM,
			Model:         in.Model,
			Effort:        in.Effort,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_manage_search_profiles",
		Description: "List, save, import from YAML, run, or delete reusable Upwork search profiles persisted in Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in manageSearchProfilesInput) (*mcp.CallToolResult, any, error) {
		action := strings.ToLower(strings.TrimSpace(in.Action))
		profileName := strings.TrimSpace(in.Name)
		if profileName == "" {
			profileName = strings.TrimSpace(in.Profile)
		}
		isActive := true
		if in.IsActive != nil {
			isActive = *in.IsActive
		}

		switch action {
		case "list":
			profiles, err := s.backend.ListSearchProfiles(ctx, in.Active)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"profiles": profiles})

		case "import_yaml":
			profiles, err := s.backend.ImportSearchProfilesYAML(ctx, in.YAML, isActive, in.NameOverride)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{
				"profiles": profiles,
				"imported": len(profiles),
			})

		case "save":
			if strings.TrimSpace(in.YAML) != "" {
				profiles, err := s.backend.ImportSearchProfilesYAML(ctx, in.YAML, isActive, profileName)
				if err != nil {
					return toolErrorResult(err)
				}
				var first *server.SearchProfileEntry
				if len(profiles) > 0 {
					first = &profiles[0]
				}
				return toolSuccess(map[string]any{
					"profile":  first,
					"profiles": profiles,
					"imported": len(profiles),
				})
			}

			payload := map[string]any{}
			if profileName != "" {
				payload["name"] = profileName
			}
			if in.Description != "" {
				payload["description"] = in.Description
			}
			if in.IsActive != nil {
				payload["is_active"] = *in.IsActive
			}
			if in.Config != nil {
				payload["config"] = in.Config
			}
			if in.Search != nil {
				payload["search"] = in.Search
			}
			if in.Filters != nil {
				payload["filters"] = in.Filters
			}
			if in.Enrichment != nil {
				payload["enrichment"] = in.Enrichment
			}
			if in.Transport != nil {
				payload["transport"] = in.Transport
			}
			if in.Output != nil {
				payload["output"] = in.Output
			}
			rawBytes, mErr := json.Marshal(payload)
			if mErr != nil {
				return toolErrorResult(mErr)
			}
			saved, created, err := s.backend.SaveSearchProfile(ctx, rawBytes)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{
				"profile": saved,
				"created": created,
			})

		case "run":
			if in.ID != nil && (*in.ID == 0 || uint64(*in.ID) > math.MaxInt64) {
				return toolErrorResult(&server.ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "Invalid search profile ID",
				})
			}
			res, err := s.backend.RunSearchProfile(ctx, in.ID, profileName)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(res)

		case "delete":
			var idVal uint64
			if in.ID != nil {
				if *in.ID == 0 || uint64(*in.ID) > math.MaxInt64 {
					return toolErrorResult(&server.ServiceError{
						Code:       "INVALID_PARAMS",
						HTTPStatus: http.StatusBadRequest,
						Message:    "Invalid search profile ID",
					})
				}
				idVal = uint64(*in.ID)
			}
			if err := s.backend.DeleteSearchProfile(ctx, idVal, profileName); err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{"deleted": true})

		default:
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "action must be one of: list, save, import_yaml, run, delete",
			})
		}
	})
}
