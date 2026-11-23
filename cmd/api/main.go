package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	dbservice "upwork-buddy/internal/database/service"
	upworkmcp "upwork-buddy/internal/mcp"
	"upwork-buddy/internal/policy"
	"upwork-buddy/internal/server"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	gormlogger "gorm.io/gorm/logger"
)

func gracefulShutdown(apiServer *http.Server, appServer *server.Server, done chan bool) {
	// Create context that listens for the interrupt signal from the OS.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Listen for the interrupt signal.
	<-ctx.Done()

	log.Println("shutting down gracefully, press Ctrl+C again to force")
	stop() // Allow Ctrl+C to force shutdown

	// Close active MCP SSE/HTTP sessions, watchers, enrichment batches, and WebSocket bridge connections before http.Server.Shutdown.
	if appServer != nil {
		appServer.CloseMCPSessions()
		if err := appServer.CloseWatchers(); err != nil {
			log.Printf("Watcher shutdown error: %v", err)
		}
		if err := appServer.CloseEnrichment(); err != nil {
			log.Printf("Enrichment batch shutdown error: %v", err)
		}
		if appServer.BridgeHub() != nil {
			if err := appServer.BridgeHub().Close(); err != nil {
				log.Printf("WebSocket bridge shutdown error: %v", err)
			}
		}
	}

	// Give active HTTP requests up to 5 seconds to complete before closing DB resources.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := apiServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("Server forced to shutdown with error: %v", err)
	}

	if appServer != nil {
		if err := appServer.Close(); err != nil {
			log.Printf("Server resource shutdown error: %v", err)
		}
	}

	log.Println("Server exiting")

	// Notify the main goroutine that the shutdown is complete
	done <- true
}

func runServe() {
	httpServer, appServer := server.NewServerInstance()

	if appServer.MCPEnabled() {
		mcpSrv := upworkmcp.NewServer(appServer)
		appServer.SetMCPHandler(mcpSrv.StreamableHTTPHandler())
		appServer.SetMCPShutdownHook(mcpSrv.CloseSessions)
	}

	if server.IsWatcherEnabledFromEnv() {
		if err := appServer.StartWatchers(context.Background()); err != nil {
			log.Printf("Watcher startup error: %v", err)
		}
	}

	// Create a done channel to signal when the shutdown is complete
	done := make(chan bool, 1)

	// Run graceful shutdown in a separate goroutine
	go gracefulShutdown(httpServer, appServer, done)

	err := httpServer.ListenAndServe()
	if err != nil && err != http.ErrServerClosed {
		panic(fmt.Sprintf("http server error: %s", err))
	}

	// Wait for the graceful shutdown to complete
	<-done
	log.Println("Graceful shutdown complete.")
}

type bearerRoundTripper struct {
	base       http.RoundTripper
	token      string
	lastStatus atomic.Int32
}

func (b *bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	cloned := req.Clone(req.Context())
	if b.token != "" {
		cloned.Header.Set("Authorization", "Bearer "+b.token)
	}
	base := b.base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(cloned)
	if resp != nil {
		b.lastStatus.Store(int32(resp.StatusCode))
	}
	return resp, err
}

func normalizeDaemonBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return server.ResolveDaemonBaseURL()
	}
	trimmed = strings.TrimRight(trimmed, "/")
	trimmed = strings.TrimSuffix(trimmed, "/mcp")
	return strings.TrimRight(trimmed, "/")
}

func probeDaemonHealth(ctx context.Context, baseURL string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, baseURL+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := (&http.Client{Timeout: 1500 * time.Millisecond}).Do(req)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func spawnDetachedDaemon() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve executable: %w", err)
	}
	logPath := filepath.Join(os.TempDir(), "upwork-buddy-daemon.log")
	if cfgDir, cErr := os.UserConfigDir(); cErr == nil && strings.TrimSpace(cfgDir) != "" {
		dir := filepath.Join(cfgDir, "upwork-buddy")
		if mkErr := os.MkdirAll(dir, 0o700); mkErr == nil {
			logPath = filepath.Join(dir, "daemon.log")
		}
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		logFile = nil
	} else {
		defer func() { _ = logFile.Close() }()
	}

	cmd := exec.Command(exe, "serve")
	cmd.Stdin = nil
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	} else {
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start daemon: %w", err)
	}
	return cmd.Process.Release()
}

func sanitizeForwardMeta(in mcp.Meta) mcp.Meta {
	if len(in) == 0 {
		return nil
	}
	out := make(mcp.Meta, len(in))
	for k, v := range in {
		if k == mcp.MetaKeyProtocolVersion {
			continue
		}
		out[k] = v
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func proxyMCPToDaemon(ctx context.Context, mcpURL string) error {
	token, _, err := server.ResolveExistingAPIToken()
	if err != nil || strings.TrimSpace(token) == "" {
		token, _, err = server.ResolveOrCreateAPIToken()
		if err != nil {
			return fmt.Errorf("resolve daemon API token: %w", err)
		}
	}

	rt := &bearerRoundTripper{
		base:  http.DefaultTransport,
		token: token,
	}
	httpClient := &http.Client{
		Transport: rt,
	}

	client := mcp.NewClient(&mcp.Implementation{
		Name:    "upwork-buddy-stdio-proxy",
		Version: "2.0.0",
	}, nil)

	clientSession, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:             mcpURL,
		HTTPClient:           httpClient,
		DisableStandaloneSSE: true,
	}, nil)
	if err != nil {
		if rt.lastStatus.Load() == http.StatusNotFound {
			return fmt.Errorf("daemon /health is 200 OK but MCP endpoint %q returned 404 Not Found (MCP_ENABLED=false); enable MCP_ENABLED=true on the daemon or pass --embedded: %w", mcpURL, err)
		}
		return fmt.Errorf("connect to daemon MCP %q: %w", mcpURL, err)
	}
	defer func() {
		_ = clientSession.Close()
	}()

	proxySrv := mcp.NewServer(&mcp.Implementation{
		Name:    "upwork-buddy",
		Title:   "Upwork Buddy MCP Server",
		Version: "2.0.0",
	}, &mcp.ServerOptions{
		Instructions: "Stdio proxy to running Upwork Buddy daemon MCP server.",
	})

	// Mirror all tools from the running daemon.
	var toolCursor string
	for {
		listRes, lErr := clientSession.ListTools(ctx, &mcp.ListToolsParams{Cursor: toolCursor})
		if lErr != nil {
			return fmt.Errorf("list daemon MCP tools: %w", lErr)
		}
		for _, tool := range listRes.Tools {
			tCopy := *tool
			toolName := tCopy.Name
			proxySrv.AddTool(&tCopy, func(callCtx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				var args any = map[string]any{}
				if len(req.Params.Arguments) > 0 {
					args = req.Params.Arguments
				}
				return clientSession.CallTool(callCtx, &mcp.CallToolParams{
					Meta:      sanitizeForwardMeta(req.Params.Meta),
					Name:      toolName,
					Arguments: args,
				})
			})
		}
		if listRes.NextCursor == "" {
			break
		}
		toolCursor = listRes.NextCursor
	}

	// Mirror all resources from the running daemon.
	var resCursor string
	for {
		listRes, lErr := clientSession.ListResources(ctx, &mcp.ListResourcesParams{Cursor: resCursor})
		if lErr != nil {
			return fmt.Errorf("list daemon MCP resources: %w", lErr)
		}
		for _, res := range listRes.Resources {
			rCopy := *res
			proxySrv.AddResource(&rCopy, func(readCtx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
				return clientSession.ReadResource(readCtx, &mcp.ReadResourceParams{
					Meta: sanitizeForwardMeta(req.Params.Meta),
					URI:  req.Params.URI,
				})
			})
		}
		if listRes.NextCursor == "" {
			break
		}
		resCursor = listRes.NextCursor
	}

	return proxySrv.Run(ctx, &mcp.StdioTransport{})
}

func runEmbeddedMCP(ctx context.Context) error {
	templatesPath := strings.TrimSpace(os.Getenv("TEMPLATES_PATH"))
	if templatesPath == "" {
		templatesPath = "templates.yaml"
	}
	selectorsPath := strings.TrimSpace(os.Getenv("SELECTORS_PATH"))
	if selectorsPath == "" {
		selectorsPath = "configs/selectors/upwork.yaml"
	}
	dbSvc := dbservice.New()
	appServer := server.NewServerWithDeps(server.ServerDeps{
		TemplatesPath: templatesPath,
		SelectorsPath: selectorsPath,
		DB:            dbSvc,
		PolicyEngine:  policy.NewEngine(dbSvc.GetGorm()),
	})
	defer func() {
		_ = appServer.Close()
	}()

	mcpSrv := upworkmcp.NewServer(appServer)
	return mcpSrv.RunStdio(ctx)
}

func runMCP(args []string) int {
	log.SetOutput(os.Stderr)
	gormlogger.Default = gormlogger.New(log.New(os.Stderr, "\r\n", log.LstdFlags), gormlogger.Config{
		SlowThreshold:             200 * time.Millisecond,
		LogLevel:                  gormlogger.Warn,
		IgnoreRecordNotFoundError: true,
		Colorful:                  false,
	})

	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	daemonURLFlag := fs.String("daemon-url", "", "Base URL of running upwork-buddy daemon (e.g. http://127.0.0.1:9090)")
	autoStart := fs.Bool("auto-start", false, "Auto-start detached 'upwork-buddy serve' if daemon is not reachable")
	embedded := fs.Bool("embedded", false, "Run embedded local MCP server on stdio without proxying to daemon")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if !*embedded {
		baseURL := normalizeDaemonBaseURL(*daemonURLFlag)
		healthy := probeDaemonHealth(ctx, baseURL)
		if !healthy && *autoStart {
			if err := spawnDetachedDaemon(); err != nil {
				log.Printf("auto-start failed: %v", err)
			} else {
				deadline := time.Now().Add(10 * time.Second)
				for time.Now().Before(deadline) {
					if ctx.Err() != nil {
						return 0
					}
					if probeDaemonHealth(ctx, baseURL) {
						healthy = true
						break
					}
					time.Sleep(150 * time.Millisecond)
				}
			}
		}

		if healthy {
			if err := proxyMCPToDaemon(ctx, baseURL+"/mcp"); err != nil {
				if ctx.Err() != nil {
					return 0
				}
				log.Printf("mcp stdio proxy error: %v", err)
				return 1
			}
			return 0
		}
		log.Printf("daemon at %s unreachable; falling back to embedded stdio MCP server (browser tools return EXTENSION_DISCONNECTED)", baseURL)
	}

	if err := runEmbeddedMCP(ctx); err != nil {
		if ctx.Err() != nil {
			return 0
		}
		log.Printf("embedded mcp stdio error: %v", err)
		return 1
	}
	return 0
}

func main() {
	subcommand := "serve"
	if len(os.Args) > 1 {
		subcommand = os.Args[1]
	}

	switch subcommand {
	case "serve":
		runServe()
	case "mcp":
		os.Exit(runMCP(os.Args[2:]))
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q; expected 'serve' or 'mcp'\n", subcommand)
		os.Exit(2)
	}
}
