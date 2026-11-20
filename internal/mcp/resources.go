package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func jsonResourceResult(uri string, payload any) (*mcp.ReadResourceResult, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal resource %s: %w", uri, err)
	}
	return &mcp.ReadResourceResult{
		Contents: []*mcp.ResourceContents{
			{
				URI:      uri,
				MIMEType: "application/json",
				Text:     string(encoded),
			},
		},
	}, nil
}

func (s *Server) registerResources() {
	s.mcpServer.AddResource(&mcp.Resource{
		URI:         "upwork://profile",
		Name:        "Freelancer Profile",
		Description: "Current freelancer profile bio, skills, and portfolio items persisted in Postgres.",
		MIMEType:    "application/json",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		prof, err := s.backend.GetProfile(ctx)
		if err != nil {
			return nil, err
		}
		return jsonResourceResult(req.Params.URI, prof)
	})

	s.mcpServer.AddResource(&mcp.Resource{
		URI:         "upwork://jobs/hot",
		Name:        "Hot Upwork Jobs",
		Description: "Top-scoring Upwork jobs (fit_label = 'hot' or score >= 80).",
		MIMEType:    "application/json",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		jobs, err := s.backend.ListHotJobs(ctx, 50)
		if err != nil {
			return nil, err
		}
		return jsonResourceResult(req.Params.URI, map[string]any{
			"jobs":  jobs,
			"count": len(jobs),
		})
	})

	s.mcpServer.AddResource(&mcp.Resource{
		URI:         "upwork://proposals/pending-approval",
		Name:        "Pending-Approval Proposals",
		Description: "Proposals awaiting human approval in confirm_in_ui mode.",
		MIMEType:    "application/json",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		props, err := s.backend.ListProposals(ctx, server.ListProposalsFilter{
			Status: "pending_approval",
			Limit:  100,
		})
		if err != nil {
			return nil, err
		}
		return jsonResourceResult(req.Params.URI, map[string]any{
			"proposals": props,
			"count":     len(props),
		})
	})

	s.mcpServer.AddResource(&mcp.Resource{
		URI:         "upwork://proposals/active",
		Name:        "Active Proposals",
		Description: "Submitted, viewed, interviewing, offer, approved, and in-flight proposals.",
		MIMEType:    "application/json",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		props, err := s.backend.ListProposals(ctx, server.ListProposalsFilter{
			Statuses: []string{"submitted", "viewed", "interviewing", "offer", "approved", "submitting"},
			Limit:    100,
		})
		if err != nil {
			return nil, err
		}
		return jsonResourceResult(req.Params.URI, map[string]any{
			"proposals": props,
			"count":     len(props),
		})
	})

	s.mcpServer.AddResource(&mcp.Resource{
		URI:         "upwork://messages/unread",
		Name:        "Unread Message Threads",
		Description: "Upwork client message rooms with unread messages.",
		MIMEType:    "application/json",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		res, err := s.backend.ListThreads(ctx, true)
		if err != nil {
			return nil, err
		}
		return jsonResourceResult(req.Params.URI, res)
	})

	s.mcpServer.AddResource(&mcp.Resource{
		URI:         "upwork://selectors/health",
		Name:        "Selector Health Audits",
		Description: "Latest DOM selector drift audit per Upwork view.",
		MIMEType:    "application/json",
	}, func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		audits, err := s.backend.ListSelectorAudits(ctx, "", "", true, 20)
		if err != nil {
			return nil, err
		}
		return jsonResourceResult(req.Params.URI, map[string]any{
			"audits": audits,
			"count":  len(audits),
		})
	})
}
