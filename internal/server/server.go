package server

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/joho/godotenv/autoload"

	"upwork-buddy/internal/bridge"
	"upwork-buddy/internal/database/service"
	"upwork-buddy/internal/policy"
)

// ServiceError represents a domain/validation error returned by Server service methods.
type ServiceError struct {
	Code       string
	HTTPStatus int
	Message    string
	Details    map[string]any
}

func (e *ServiceError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// ServerDeps holds explicit dependencies for constructing a *Server (useful in tests and embedded setups).
type ServerDeps struct {
	Host               string
	Port               int
	Env                string
	CORSAllowedOrigins string
	TemplatesPath      string
	SelectorsPath      string
	APIToken           string
	MCPEnabled         *bool
	DB                 service.DatabaseService
	BridgeHub          *bridge.Hub
	PolicyEngine       *policy.Engine
}

type Server struct {
	host               string
	port               int
	env                string
	corsAllowedOrigins string
	templatesPath      string
	selectorsPath      string
	apiToken           string
	mcpDisabled        bool

	agentStore      generatedAgentStore
	mcpHandler      http.Handler
	wsHandler       http.Handler
	bridgeHub       *bridge.Hub
	policyEngine    *policy.Engine
	mcpHookMu       sync.Mutex
	mcpShutdownHook func()

	db service.DatabaseService
}

func parseMCPEnabledEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MCP_ENABLED"))) {
	case "false", "0", "no", "off":
		return false
	default:
		return true
	}
}

// ResolveDaemonBaseURL returns the configured local daemon HTTP base URL (without trailing slash).
func ResolveDaemonBaseURL() string {
	for _, key := range []string{"UPWORK_BUDDY_URL", "BUDDY_API_URL"} {
		if raw := strings.TrimSpace(os.Getenv(key)); raw != "" {
			trimmed := strings.TrimRight(raw, "/")
			trimmed = strings.TrimSuffix(trimmed, "/mcp")
			return strings.TrimRight(trimmed, "/")
		}
	}
	host := strings.TrimSpace(os.Getenv("APP_HOST"))
	if host == "" {
		host = "127.0.0.1"
	}
	port, _ := strconv.Atoi(strings.TrimSpace(os.Getenv("APP_PORT")))
	if port == 0 {
		port, _ = strconv.Atoi(strings.TrimSpace(os.Getenv("PORT")))
	}
	if port == 0 {
		port = 9090
	}
	return fmt.Sprintf("http://%s", net.JoinHostPort(host, strconv.Itoa(port)))
}

// NewServerWithDeps constructs a *Server with caller-provided dependencies.
func NewServerWithDeps(deps ServerDeps) *Server {
	host := strings.TrimSpace(deps.Host)
	if host == "" {
		host = "127.0.0.1"
	}
	env := strings.TrimSpace(deps.Env)
	if env == "" {
		env = "development"
	}
	templatesPath := strings.TrimSpace(deps.TemplatesPath)
	if templatesPath == "" {
		templatesPath = "templates.yaml"
	}
	selectorsPath := strings.TrimSpace(deps.SelectorsPath)
	if selectorsPath == "" {
		selectorsPath = "configs/selectors/upwork.yaml"
	}
	mcpDisabled := deps.MCPEnabled != nil && !*deps.MCPEnabled
	pe := deps.PolicyEngine
	if pe == nil && deps.DB != nil && deps.DB.GetGorm() != nil {
		pe = policy.NewEngine(deps.DB.GetGorm())
	}
	var wsHandler http.Handler
	if deps.BridgeHub != nil {
		wsHandler = deps.BridgeHub
	}
	return &Server{
		host:               host,
		port:               deps.Port,
		env:                env,
		corsAllowedOrigins: strings.TrimSpace(deps.CORSAllowedOrigins),
		templatesPath:      templatesPath,
		selectorsPath:      selectorsPath,
		apiToken:           deps.APIToken,
		mcpDisabled:        mcpDisabled,
		bridgeHub:          deps.BridgeHub,
		wsHandler:          wsHandler,
		policyEngine:       pe,
		db:                 deps.DB,
	}
}

// NewServerInstance builds both the *http.Server and underlying *Server so cmd/api/main.go
// can close database resources cleanly on graceful shutdown.
func NewServerInstance() (*http.Server, *Server) {
	host := strings.TrimSpace(os.Getenv("APP_HOST"))
	if host == "" {
		host = "127.0.0.1"
	}

	port, _ := strconv.Atoi(os.Getenv("APP_PORT"))
	if port == 0 {
		port, _ = strconv.Atoi(os.Getenv("PORT"))
	}
	if port == 0 {
		port = 9090
	}

	env := strings.TrimSpace(os.Getenv("APP_ENV"))
	if env == "" {
		env = "development"
	}

	corsAllowedOrigins := strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGINS"))

	templatesPath := strings.TrimSpace(os.Getenv("TEMPLATES_PATH"))
	if templatesPath == "" {
		templatesPath = "templates.yaml"
	}

	selectorsPath := strings.TrimSpace(os.Getenv("SELECTORS_PATH"))
	if selectorsPath == "" {
		selectorsPath = "configs/selectors/upwork.yaml"
	}

	apiToken, tokenSource, err := resolveOrCreateAPIToken()
	if err != nil {
		log.Fatalf("Failed to initialize API token: %v", err)
	}

	mcpEnabled := parseMCPEnabledEnv()
	dbSvc := service.New()
	appServer := &Server{
		host:               host,
		port:               port,
		env:                env,
		corsAllowedOrigins: corsAllowedOrigins,
		templatesPath:      templatesPath,
		selectorsPath:      selectorsPath,
		apiToken:           apiToken,
		mcpDisabled:        !mcpEnabled,
		db:                 dbSvc,
		policyEngine:       policy.NewEngine(dbSvc.GetGorm()),
	}

	bridgeHub := bridge.NewHub(bridge.HubConfig{
		AuthTimeout:        5 * time.Second,
		DefaultCallTimeout: 60 * time.Second,
		PreAuthCheck: func(r *http.Request) bool {
			return appServer.AuthenticateWSRequest(r) == WSAuthAuthenticated
		},
		ValidateAuthFrame: appServer.ValidateWSAuthFrame,
		AllowOrigin:       appServer.IsAllowedOrigin,
	})
	appServer.bridgeHub = bridgeHub
	appServer.wsHandler = bridgeHub

	addr := net.JoinHostPort(appServer.host, strconv.Itoa(appServer.port))
	log.Printf("🚀 Server configured: addr=%s, env=%s, mcp_enabled=%t, token_source=%q, cors_allowed_origins=%q",
		addr, env, mcpEnabled, tokenSource, corsAllowedOrigins)

	// WriteTimeout must accommodate multi-page search + top-N enrichment sweeps and Ollama calls.
	// ReadTimeout is generous for large job descriptions but still bounded.
	httpServer := &http.Server{
		Addr:         addr,
		Handler:      appServer.RegisterRoutes(),
		IdleTimeout:  2 * time.Minute,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 5 * time.Minute,
	}

	return httpServer, appServer
}

// NewServer constructs the configured *http.Server for callers that only need the listener.
func NewServer() *http.Server {
	httpServer, _ := NewServerInstance()
	return httpServer
}

// DB returns the underlying database service.
func (s *Server) DB() service.DatabaseService {
	if s == nil {
		return nil
	}
	return s.db
}

// APIToken returns the configured Bearer API token.
func (s *Server) APIToken() string {
	if s == nil {
		return ""
	}
	return s.apiToken
}

// SelectorsPath returns the resolved selectors YAML path.
func (s *Server) SelectorsPath() string {
	return s.resolveSelectorsPath()
}

// TemplatesPath returns the configured templates YAML path.
func (s *Server) TemplatesPath() string {
	if s == nil || strings.TrimSpace(s.templatesPath) == "" {
		return "templates.yaml"
	}
	return s.templatesPath
}

// MCPEnabled reports whether the embedded MCP server is enabled.
func (s *Server) MCPEnabled() bool {
	if s == nil {
		return false
	}
	return !s.mcpDisabled
}

// SetMCPShutdownHook registers a hook invoked during Server.Close() / graceful shutdown to close active MCP sessions.
func (s *Server) SetMCPShutdownHook(fn func()) {
	if s == nil {
		return
	}
	s.mcpHookMu.Lock()
	s.mcpShutdownHook = fn
	s.mcpHookMu.Unlock()
}

// CloseMCPSessions invokes any registered MCP shutdown hook so open SSE streams close cleanly before HTTP shutdown.
func (s *Server) CloseMCPSessions() {
	if s == nil {
		return
	}
	s.mcpHookMu.Lock()
	hook := s.mcpShutdownHook
	s.mcpHookMu.Unlock()
	if hook != nil {
		hook()
	}
}

// BridgeHub returns the active WebSocket extension bridge hub (nil in unit tests without WS).
func (s *Server) BridgeHub() *bridge.Hub {
	if s == nil {
		return nil
	}
	return s.bridgeHub
}

// PolicyEngine returns the server's policy engine (initializing lazily if needed).
func (s *Server) PolicyEngine() *policy.Engine {
	if s == nil {
		return nil
	}
	if s.policyEngine != nil {
		return s.policyEngine
	}
	if s.db != nil && s.db.GetGorm() != nil {
		s.policyEngine = policy.NewEngine(s.db.GetGorm())
		return s.policyEngine
	}
	return policy.NewEngine(nil)
}

// Close releases underlying server resources (including MCP sessions, WebSocket bridge, and database pool).
func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	s.CloseMCPSessions()
	var errs []error
	if s.bridgeHub != nil {
		if err := s.bridgeHub.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	if s.db != nil {
		if err := s.db.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// SetMCPHandler attaches the MCP HTTP handler behind Bearer authentication.
func (s *Server) SetMCPHandler(h http.Handler) {
	if s != nil {
		s.mcpHandler = h
	}
}

// SetWSHandler attaches the extension WebSocket handler behind WebSocket auth guards.
func (s *Server) SetWSHandler(h http.Handler) {
	if s != nil {
		s.wsHandler = h
	}
}
