package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type profileToolInput struct {
	Action              string                         `json:"action,omitempty" jsonschema:"Action: get (default) or update"`
	Description         string                         `json:"description,omitempty" jsonschema:"Freelancer profile summary / bio"`
	Bio                 string                         `json:"bio,omitempty" jsonschema:"Alias for description"`
	Skills              any                            `json:"skills,omitempty" jsonschema:"Comma-separated skills string or array of skill names"`
	TargetRate          *float64                       `json:"target_rate,omitempty" jsonschema:"Optional target hourly rate"`
	PortfolioItems      *[]server.PortfolioItemRequest `json:"portfolio_items,omitempty" jsonschema:"Portfolio items replacing existing entries on update (omit to preserve existing entries)"`
	PortfolioReferences *[]server.PortfolioItemRequest `json:"portfolio_references,omitempty" jsonschema:"Alias for portfolio_items"`
}

type generateProjectAgentsInput struct {
	JobID        any      `json:"job_id,omitempty" jsonschema:"Optional persisted numeric DB job ID or Upwork ~jobID"`
	TemplateName string   `json:"template_name,omitempty" jsonschema:"Template category name from templates.yaml (auto-inferred from job when omitted)"`
	AgentNames   []string `json:"agent_names,omitempty" jsonschema:"Blueprint names to generate (defaults to all blueprints in template)"`
	Format       string   `json:"format,omitempty" jsonschema:"Target agent format: claude, goose, codex, or copilot (default claude)"`
}

func parseFlexibleSkillsInput(raw any) (server.FlexibleSkills, error) {
	if raw == nil {
		return server.FlexibleSkills{}, nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return server.FlexibleSkills{}, err
	}
	var fs server.FlexibleSkills
	if err := json.Unmarshal(b, &fs); err != nil {
		return server.FlexibleSkills{}, err
	}
	return fs, nil
}

func (s *Server) registerProfileTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_profile",
		Description: "Get or update the freelancer profile description, skills, and portfolio items persisted in Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in profileToolInput) (*mcp.CallToolResult, any, error) {
		action := strings.ToLower(strings.TrimSpace(in.Action))
		if action == "" {
			if strings.TrimSpace(in.Description) != "" || strings.TrimSpace(in.Bio) != "" ||
				in.Skills != nil || in.TargetRate != nil ||
				in.PortfolioItems != nil || in.PortfolioReferences != nil {
				action = "update"
			} else {
				action = "get"
			}
		}

		switch action {
		case "get":
			res, err := s.backend.GetProfile(ctx)
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(res)

		case "update", "save", "set":
			skills, err := parseFlexibleSkillsInput(in.Skills)
			if err != nil {
				return toolErrorResult(&server.ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "skills must be a comma-separated string or array of strings",
				})
			}
			res, err := s.backend.SaveProfile(ctx, server.SaveProfileInput{
				Description:         in.Description,
				Bio:                 in.Bio,
				Skills:              skills,
				TargetRate:          in.TargetRate,
				PortfolioItems:      in.PortfolioItems,
				PortfolioReferences: in.PortfolioReferences,
			})
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(res)

		default:
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "action must be 'get' or 'update'",
			})
		}
	})

	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_generate_project_agents",
		Description: "Generate and persist coding agent blueprints (claude, goose, codex, copilot) for a template or job into Postgres.",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in generateProjectAgentsInput) (*mcp.CallToolResult, any, error) {
		res, err := s.backend.GenerateProjectAgents(ctx, server.GenerateProjectAgentsRequest{
			JobID:        in.JobID,
			TemplateName: in.TemplateName,
			AgentNames:   in.AgentNames,
			Format:       in.Format,
		})
		if err != nil {
			return toolErrorResult(err)
		}
		return toolSuccess(res)
	})
}
