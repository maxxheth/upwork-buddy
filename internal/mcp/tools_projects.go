package mcp

import (
	"context"
	"net/http"
	"strings"

	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type activeProjectsToolInput struct {
	Action             string    `json:"action,omitempty" jsonschema:"Action: list (default) or update"`
	ID                 string    `json:"id,omitempty" jsonschema:"Project numeric ID, project_key, or slug (required for action='update')"`
	Tier               string    `json:"tier,omitempty" jsonschema:"Filter by activity tier: active, recent, or paused"`
	Status             string    `json:"status,omitempty" jsonschema:"Filter by status (list) or set status (update)"`
	Visibility         string    `json:"visibility,omitempty" jsonschema:"Filter by proposal_visibility (list): public, anonymized, or private"`
	Query              string    `json:"query,omitempty" jsonschema:"Case-insensitive search across name, public_alias, summary, group_name, and tech_stack"`
	Limit              int       `json:"limit,omitempty" jsonschema:"Maximum number of projects to return (default 100, max 500)"`
	ProposalVisibility *string   `json:"proposal_visibility,omitempty" jsonschema:"Update proposal visibility: public, anonymized, or private"`
	PublicAlias        *string   `json:"public_alias,omitempty" jsonschema:"Update sanitized public alias used in proposals"`
	Summary            *string   `json:"summary,omitempty" jsonschema:"Update curated project summary"`
	Client             *string   `json:"client,omitempty" jsonschema:"Update client name"`
	NextActions        *[]string `json:"next_actions,omitempty" jsonschema:"Update next actions list"`
	Blockers           *[]string `json:"blockers,omitempty" jsonschema:"Update blockers list"`
	Notes              *string   `json:"notes,omitempty" jsonschema:"Update curated notes"`
	Pinned             *bool     `json:"pinned,omitempty" jsonschema:"Pin or unpin project"`
	UpdatedBy          string    `json:"updated_by,omitempty" jsonschema:"Actor recording the update"`
}

func (s *Server) registerProjectTools() {
	mcp.AddTool(s.mcpServer, &mcp.Tool{
		Name:        "upwork_active_projects",
		Description: "List tracked workspace coding/client projects or update curated project metadata (summary, proposal_visibility, public_alias, status, next_actions, blockers, notes, pinned).",
	}, func(ctx context.Context, _ *mcp.CallToolRequest, in activeProjectsToolInput) (*mcp.CallToolResult, any, error) {
		action := strings.ToLower(strings.TrimSpace(in.Action))
		if action == "" {
			if strings.TrimSpace(in.ID) != "" {
				action = "update"
			} else {
				action = "list"
			}
		}

		switch action {
		case "list":
			projects, err := s.backend.ListActiveProjects(ctx, server.ListActiveProjectsFilter{
				Tier:       in.Tier,
				Status:     in.Status,
				Visibility: in.Visibility,
				Query:      in.Query,
				Limit:      in.Limit,
			})
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(map[string]any{
				"projects": projects,
				"count":    len(projects),
			})

		case "update":
			var statusPtr *string
			if strings.TrimSpace(in.Status) != "" {
				st := strings.TrimSpace(in.Status)
				statusPtr = &st
			}
			updatedBy := strings.TrimSpace(in.UpdatedBy)
			if updatedBy == "" {
				updatedBy = "mcp"
			}
			entry, err := s.backend.UpdateActiveProject(ctx, in.ID, server.UpdateActiveProjectInput{
				Status:             statusPtr,
				Client:             in.Client,
				ProposalVisibility: in.ProposalVisibility,
				PublicAlias:        in.PublicAlias,
				Summary:            in.Summary,
				NextActions:        in.NextActions,
				Blockers:           in.Blockers,
				Notes:              in.Notes,
				Pinned:             in.Pinned,
				UpdatedBy:          updatedBy,
			})
			if err != nil {
				return toolErrorResult(err)
			}
			return toolSuccess(entry)

		default:
			return toolErrorResult(&server.ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "action must be 'list' or 'update'",
			})
		}
	})
}
