package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"upwork-buddy/internal/scoring"
	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type searchJobsInput struct {
	Source         string                `json:"source,omitempty" jsonschema:"Discovery source: search, best_matches, most_recent, or saved_jobs"`
	Query          string                `json:"query,omitempty" jsonschema:"Search query string"`
	Queries        []string              `json:"queries,omitempty" jsonschema:"Optional multiple search query strings"`
	Sort           string                `json:"sort,omitempty" jsonschema:"Search sort order: recency or relevance"`
	PerPage        *int                  `json:"per_page,omitempty" jsonschema:"Results per page (10, 20, or 50)"`
	ContractorTier []int                 `json:"contractor_tier,omitempty" jsonschema:"Contractor experience tiers (1, 2, 3)"`
	ContractType   string                `json:"contract_type,omitempty" jsonschema:"Contract type: hourly or fixed"`
	ProposalTiers  []string              `json:"proposal_tiers,omitempty" jsonschema:"Upwork proposal tier filters"`
	Amount         string                `json:"amount,omitempty" jsonschema:"Upwork fixed-price amount range facet (e.g. 500-5000, 500-, -5000)"`
	BudgetMin      *int                  `json:"budget_min,omitempty" jsonschema:"Minimum fixed-price budget"`
	BudgetMax      *int                  `json:"budget_max,omitempty" jsonschema:"Maximum fixed-price budget"`
	Category       string                `json:"category,omitempty" jsonschema:"Upwork category slug"`
	SearchURL      string                `json:"search_url,omitempty" jsonschema:"Explicit Upwork search URL"`
	StartPage      int                   `json:"start_page,omitempty" jsonschema:"Starting page number (default 1)"`
	MaxPages       int                   `json:"max_pages,omitempty" jsonschema:"Maximum pages to scan (default 1)"`
	TargetJobs     *int                  `json:"target_jobs,omitempty" jsonschema:"Target candidate count to stop early"`
	EnrichTopN     *int                  `json:"enrich_top_n,omitempty" jsonschema:"Number of top-scored candidates to detail-enrich"`
	ProfileID      *uint                 `json:"profile_id,omitempty" jsonschema:"Optional persisted search profile ID"`
	Filters        *scoring.FilterConfig `json:"filters,omitempty" jsonschema:"Optional post-scrape scoring and keyword filters"`
}

type getJobDetailsInput struct {
	JobID       any      `json:"job_id,omitempty" jsonschema:"Persisted numeric DB job ID or Upwork ~jobID"`
	UpworkJobID string   `json:"upwork_job_id,omitempty" jsonschema:"Upwork job ID (e.g. ~01abc)"`
	URL         string   `json:"url,omitempty" jsonschema:"Canonical or raw Upwork job URL"`
	URLs        []string `json:"urls,omitempty" jsonschema:"Multiple Upwork job URLs for batch detail enrichment"`
	MaxJobs     *int     `json:"max_jobs,omitempty" jsonschema:"Maximum number of URLs to enrich"`
}

type listSavedJobsInput struct {
	Status               string   `json:"status,omitempty" jsonschema:"Filter by job status"`
	Fit                  string   `json:"fit,omitempty" jsonschema:"Filter by fit_label (hot, ready, review, skip)"`
	MinScore             *int     `json:"min_score,omitempty" jsonschema:"Minimum deterministic score (0-100)"`
	MaxAgeDays           *int     `json:"max_age_days,omitempty" jsonschema:"Maximum job age in days"`
	MaxProposals         *int     `json:"max_proposals,omitempty" jsonschema:"Maximum proposal count"`
	IncludeUnknown       bool     `json:"include_unknown,omitempty" jsonschema:"Include jobs with unknown proposal counts when max_proposals is set"`
	IncludeUnknownBudget bool     `json:"include_unknown_budget,omitempty" jsonschema:"Include jobs with unknown fixed-price budgets when budget_min or budget_max is set"`
	Query                string   `json:"query,omitempty" jsonschema:"Case-insensitive text search across title, description, and skills"`
	Q                    string   `json:"q,omitempty" jsonschema:"Alias for query"`
	RequiredKeywords     []string `json:"required_keywords,omitempty" jsonschema:"Require at least one matching keyword across title, description, and skills"`
	ExcludeKeywords      []string `json:"exclude_keywords,omitempty" jsonschema:"Exclude jobs matching any keyword across title, description, and skills"`
	BudgetMin            *float64 `json:"budget_min,omitempty" jsonschema:"Minimum fixed-price budget"`
	BudgetMax            *float64 `json:"budget_max,omitempty" jsonschema:"Maximum fixed-price budget"`
	Sort                 string   `json:"sort,omitempty" jsonschema:"Sort order: created_desc or score_desc"`
	Limit                *int     `json:"limit,omitempty" jsonschema:"Maximum jobs to return (default 50, max 500)"`
	Offset               int      `json:"offset,omitempty" jsonschema:"Pagination offset"`
}

type analyzeJobInput struct {
	JobID       any    `json:"job_id,omitempty" jsonschema:"Persisted numeric DB job ID or Upwork ~jobID"`
	UpworkJobID string `json:"upwork_job_id,omitempty" jsonschema:"Upwork job ID (e.g. ~01abc)"`
	UseLLM      *bool  `json:"use_llm,omitempty" jsonschema:"Whether to also invoke AGY/Ollama LLM analysis (requires AGY_ENDPOINT_URL or OLLAMA_API_KEY)"`
	Model       string `json:"model,omitempty" jsonschema:"Optional LLM model override (e.g. gemini-pro-orchestrator-neon, gemini-4-neon, gpt-oss:120b)"`
	Effort      string `json:"effort,omitempty" jsonschema:"Optional AGY reasoning effort override (low, medium, high, xhigh)"`
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
		Description: "Run a live Upwork search or authenticated feed scrape (search, best_matches, most_recent, saved_jobs), score/filter candidates, optionally detail-enrich top N, and persist to Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in searchJobsInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.ExecuteSearchPipeline(ctx, server.SearchJobsRequest{
			Source:         in.Source,
			Query:          in.Query,
			Queries:        in.Queries,
			Sort:           in.Sort,
			PerPage:        in.PerPage,
			ContractorTier: in.ContractorTier,
			ContractType:   in.ContractType,
			ProposalTiers:  in.ProposalTiers,
			Amount:         in.Amount,
			BudgetMin:      in.BudgetMin,
			BudgetMax:      in.BudgetMax,
			Category:       in.Category,
			SearchURL:      in.SearchURL,
			StartPage:      in.StartPage,
			MaxPages:       in.MaxPages,
			TargetJobs:     in.TargetJobs,
			EnrichTopN:     in.EnrichTopN,
			ProfileID:      in.ProfileID,
			Filters:        in.Filters,
		})
		if err != nil {
			return toolErrorResult(err)
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
					if numID, err := strconv.ParseUint(trimmed, 10, 64); err == nil && numID > 0 {
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
		Description: "Query and filter persisted Upwork jobs in Postgres by status, fit label, score, age, proposal count, budget, and search query.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in listSavedJobsInput) (*mcp.CallToolResult, any, error) {
		limit := 50
		if in.Limit != nil {
			limit = *in.Limit
		}
		query := strings.TrimSpace(in.Query)
		if query == "" {
			query = strings.TrimSpace(in.Q)
		}
		jobs, total, err := s.backend.ListJobsWithTotal(ctx, server.ListJobsFilter{
			Status:               in.Status,
			Fit:                  in.Fit,
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
			Limit:                limit,
			Offset:               in.Offset,
			Sort:                 in.Sort,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(map[string]any{
			"jobs":  jobs,
			"total": total,
		})
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_analyze_job",
		Description: "Run deterministic scoring against the live freelancer profile (plus optional AGY/Ollama LLM analysis) and persist updated score/analysis back to Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in analyzeJobInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.AnalyzeJob(ctx, server.AnalyzeJobRequest{
			JobID:       in.JobID,
			UpworkJobID: in.UpworkJobID,
			UseLLM:      in.UseLLM,
			Model:       in.Model,
			Effort:      in.Effort,
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
			res, err := s.backend.RunSearchProfile(ctx, in.ID, profileName)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(res)

		case "delete":
			var idVal uint64
			if in.ID != nil {
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
