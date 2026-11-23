package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"upwork-buddy/internal/bridge"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"gorm.io/gorm"
)

// Server wraps the official Go MCP SDK server backed by *server.Server services.
type Server struct {
	backend   *server.Server
	mcpServer *mcp.Server
}

// NewServer constructs and registers all 30 Upwork Buddy MCP tools and 10 resources.
func NewServer(backend *server.Server) *Server {
	s := &Server{
		backend: backend,
		mcpServer: mcp.NewServer(
			&mcp.Implementation{
				Name:    "upwork-buddy",
				Title:   "Upwork Buddy MCP Server",
				Version: "2.0.0",
			},
			&mcp.ServerOptions{
				Instructions: "Local Upwork automation, job discovery/scoring, proposal drafting/filling/approval-gated submission, and client messaging MCP server.",
			},
		),
	}

	s.registerSessionTools()
	s.registerDiagnosticTools()
	s.registerJobTools()
	s.registerEnrichmentTools()
	s.registerProposalTools()
	s.registerMessageTools()
	s.registerProfileTools()
	s.registerProjectTools()
	s.registerWatcherTools()
	s.registerResources()

	return s
}

// MCPServer returns the underlying *mcp.Server instance.
func (s *Server) MCPServer() *mcp.Server {
	if s == nil {
		return nil
	}
	return s.mcpServer
}

// StreamableHTTPHandler returns the stateful Streamable HTTP handler for mounting on /mcp.
func (s *Server) StreamableHTTPHandler() http.Handler {
	return mcp.NewStreamableHTTPHandler(func(_ *http.Request) *mcp.Server {
		return s.mcpServer
	}, &mcp.StreamableHTTPOptions{
		SessionTimeout: 30 * time.Minute,
	})
}

// CloseSessions closes all active MCP server sessions so open SSE streams terminate cleanly on shutdown.
func (s *Server) CloseSessions() {
	if s == nil || s.mcpServer == nil {
		return
	}
	for ss := range s.mcpServer.Sessions() {
		_ = ss.Close()
	}
}

// RunStdio serves the embedded MCP server over stdio until ctx is canceled or stdin closes.
func (s *Server) RunStdio(ctx context.Context) error {
	if s == nil || s.mcpServer == nil {
		return errors.New("mcp server is nil")
	}
	return s.mcpServer.Run(ctx, &mcp.StdioTransport{})
}

func toolSuccess(out any) (*mcp.CallToolResult, any, error) {
	return nil, out, nil
}

func toolErrorResult(err error) (*mcp.CallToolResult, any, error) {
	if err == nil {
		return nil, nil, nil
	}

	code := "INTERNAL_ERROR"
	msg := err.Error()
	var details any

	var pe *policy.PolicyError
	var se *server.ServiceError
	var be *bridge.BridgeError

	switch {
	case errors.As(err, &pe) && pe != nil:
		code = pe.Code
		msg = pe.Message
		details = pe.Details
	case errors.As(err, &se) && se != nil:
		code = se.Code
		msg = se.Message
		details = se.Details
	case errors.Is(err, bridge.ErrExtensionDisconnected):
		code = bridge.ErrCodeExtensionDisconnected
	case errors.Is(err, bridge.ErrHumanActionRequired):
		code = bridge.ErrCodeHumanActionRequired
		if errors.As(err, &be) && be != nil && len(be.Data) > 0 {
			details = json.RawMessage(be.Data)
		}
	case errors.Is(err, bridge.ErrApprovalRequired):
		code = bridge.ErrCodeApprovalRequired
	case errors.Is(err, bridge.ErrDailyCapExceeded):
		code = bridge.ErrCodeDailyCapExceeded
	case errors.Is(err, bridge.ErrPolicyBlocked):
		code = bridge.ErrCodePolicyBlocked
	case errors.As(err, &be) && be != nil:
		if strings.TrimSpace(be.Code) != "" {
			code = strings.ToUpper(strings.TrimSpace(be.Code))
		}
		msg = be.Error()
		if len(be.Data) > 0 {
			details = json.RawMessage(be.Data)
		}
	case errors.Is(err, gorm.ErrRecordNotFound):
		code = "NOT_FOUND"
	default:
		lower := strings.ToLower(msg)
		switch {
		case strings.Contains(lower, "not found"):
			code = "NOT_FOUND"
		case strings.Contains(lower, "invalid"):
			code = "INVALID_PARAMS"
		}
	}

	payload := map[string]any{
		"error_code": code,
		"error":      msg,
	}
	if details != nil {
		payload["details"] = details
	}
	encoded, mErr := json.Marshal(payload)
	if mErr != nil {
		encoded = []byte(`{"error_code":"INTERNAL_ERROR","error":"failed to marshal error"}`)
	}

	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{
			&mcp.TextContent{Text: string(encoded)},
		},
	}, nil, nil
}
