package server

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strings"

	"upwork-buddy/internal/webui"
)

func (s *Server) RegisterRoutes() http.Handler {
	mux := http.NewServeMux()

	// Unauthenticated root & minimal liveness endpoint
	mux.HandleFunc("/", s.HelloWorldHandler)
	mux.HandleFunc("/health", s.healthHandler)

	// Protected /api/* sub-mux (fail-closed by construction for all API routes)
	apiMux := http.NewServeMux()
	apiMux.HandleFunc("/api/health", s.apiHealthHandler)
	apiMux.HandleFunc("/api/analyze-job", s.analyzeJobHandler)
	apiMux.HandleFunc("/api/profile", s.profileHandler)

	// Job CRUD, batch ingest & discovery orchestration endpoints
	apiMux.HandleFunc("POST /api/jobs", s.saveJobHandler)
	apiMux.HandleFunc("POST /api/jobs/batch", s.batchIngestJobsHandler)
	apiMux.HandleFunc("POST /api/jobs/search", s.searchJobsHandler)
	apiMux.HandleFunc("POST /api/jobs/detail", s.enrichJobDetailHandler)
	apiMux.HandleFunc("GET /api/jobs", s.listJobsHandler)
	apiMux.HandleFunc("GET /api/jobs/{id}", s.getJobHandler)
	apiMux.HandleFunc("POST /api/jobs/{id}/analyze", s.analyzeSavedJobHandler)
	apiMux.HandleFunc("PATCH /api/jobs/{id}", s.updateJobHandler)
	apiMux.HandleFunc("DELETE /api/jobs/{id}", s.deleteJobHandler)

	// Template & Agent endpoints
	apiMux.HandleFunc("GET /api/templates", s.listTemplatesHandler)
	apiMux.HandleFunc("GET /api/templates/{name}", s.getTemplateHandler)
	apiMux.HandleFunc("POST /api/agents/generate", s.generateAgentsHandler)
	apiMux.HandleFunc("GET /api/agents", s.listAgentsHandler)
	apiMux.HandleFunc("POST /api/agents/download", s.downloadAgentsHandler)

	// Selectors, Search Profiles & Selector Audits
	apiMux.HandleFunc("GET /api/selectors", s.getSelectorsHandler)
	apiMux.HandleFunc("POST /api/selector-audits", s.createSelectorAuditHandler)
	apiMux.HandleFunc("GET /api/selector-audits", s.listSelectorAuditsHandler)
	apiMux.HandleFunc("POST /api/diagnostics/capture", s.captureUIDiagnosticHandler)
	apiMux.HandleFunc("POST /api/diagnostics/ingest", s.ingestUIDiagnosticHandler)
	apiMux.HandleFunc("GET /api/diagnostics/captures", s.listUIDiagnosticCapturesHandler)
	apiMux.HandleFunc("GET /api/diagnostics/captures/{id}", s.getUIDiagnosticCaptureHandler)
	apiMux.HandleFunc("POST /api/diagnostics/test-patch", s.testSelectorPatchHandler)
	apiMux.HandleFunc("POST /api/diagnostics/apply-patch", s.applySelectorPatchHandler)
	apiMux.HandleFunc("POST /api/diagnostics/rollback", s.rollbackSelectorPatchHandler)
	apiMux.HandleFunc("GET /api/search-profiles", s.listSearchProfilesHandler)
	apiMux.HandleFunc("POST /api/search-profiles", s.saveSearchProfileHandler)
	apiMux.HandleFunc("POST /api/search-profiles/import", s.importSearchProfilesHandler)
	apiMux.HandleFunc("POST /api/search-profiles/{id}/run", s.runSearchProfileHandler)
	apiMux.HandleFunc("DELETE /api/search-profiles/{id}", s.deleteSearchProfileHandler)

	// Bridge & session status (both routes alias the same handler for E2E & v2 compatibility)
	apiMux.HandleFunc("GET /api/session/status", s.sessionStatusHandler)
	apiMux.HandleFunc("GET /api/bridge/status", s.sessionStatusHandler)

	// Policy, Kill Switch & Audit Logs
	apiMux.HandleFunc("GET /api/policy", s.getPolicyHandler)
	apiMux.HandleFunc("PUT /api/policy", s.updatePolicyHandler)
	apiMux.HandleFunc("POST /api/policy", s.updatePolicyHandler)
	apiMux.HandleFunc("POST /api/policy/kill-switch", s.killSwitchHandler)
	apiMux.HandleFunc("GET /api/audit-logs", s.listAuditLogsHandler)

	// Proposals Lifecycle
	apiMux.HandleFunc("GET /api/proposals", s.listProposalsHandler)
	apiMux.HandleFunc("POST /api/proposals", s.saveProposalHandler)
	apiMux.HandleFunc("POST /api/proposals/sync", s.syncProposalsHandler)
	apiMux.HandleFunc("GET /api/proposals/{id}", s.getProposalHandler)
	apiMux.HandleFunc("POST /api/proposals/{id}/fill", s.fillProposalHandler)
	apiMux.HandleFunc("POST /api/proposals/{id}/approve", s.approveProposalHandler)
	apiMux.HandleFunc("POST /api/proposals/{id}/reject", s.rejectProposalHandler)
	apiMux.HandleFunc("POST /api/proposals/{id}/submit", s.submitProposalHandler)

	// Messages & Client Threads
	apiMux.HandleFunc("GET /api/messages/threads", s.listThreadsHandler)
	apiMux.HandleFunc("POST /api/messages/threads/sync", s.syncThreadsHandler)
	apiMux.HandleFunc("POST /api/messages/poll", s.syncThreadsHandler)
	apiMux.HandleFunc("GET /api/messages/unread", s.listUnreadThreadsHandler)
	apiMux.HandleFunc("GET /api/messages/drafts", s.listDraftMessagesHandler)
	apiMux.HandleFunc("POST /api/messages/draft", s.draftMessageHandler)
	apiMux.HandleFunc("POST /api/messages/send", s.sendMessageHandler)
	apiMux.HandleFunc("GET /api/messages/threads/{roomId}", s.getThreadHandler)
	apiMux.HandleFunc("POST /api/messages/threads/{roomId}/sync", s.syncThreadHandler)
	apiMux.HandleFunc("POST /api/messages/threads/{roomId}/draft", s.draftMessageHandler)
	apiMux.HandleFunc("POST /api/messages/threads/{roomId}/send", s.sendMessageHandler)
	apiMux.HandleFunc("POST /api/messages/{id}/approve", s.approveMessageHandler)
	apiMux.HandleFunc("POST /api/messages/{id}/reject", s.rejectMessageHandler)

	// Active Projects Inventory
	apiMux.HandleFunc("POST /api/active-projects/sync", s.syncActiveProjectsHandler)
	apiMux.HandleFunc("GET /api/active-projects", s.listActiveProjectsHandler)
	apiMux.HandleFunc("PATCH /api/active-projects/{id}", s.updateActiveProjectHandler)

	// Search Runs, Enrichment Config & Async Batch Enrichment
	apiMux.HandleFunc("GET /api/search-runs", s.listSearchRunsHandler)
	apiMux.HandleFunc("GET /api/search-runs/{id}", s.getSearchRunHandler)
	apiMux.HandleFunc("GET /api/enrichment-config", s.enrichmentConfigHandler)
	apiMux.HandleFunc("POST /api/jobs/enrich", s.enrichJobsHandler)
	apiMux.HandleFunc("GET /api/enrichment-batches", s.listEnrichmentBatchesHandler)
	apiMux.HandleFunc("GET /api/enrichment-batches/{id}", s.getEnrichmentBatchHandler)
	apiMux.HandleFunc("POST /api/enrichment-batches/{id}/cancel", s.cancelEnrichmentBatchHandler)

	// Autonomous Job Watchers & Notifications
	apiMux.HandleFunc("GET /api/watchers", s.listWatchersHandler)
	apiMux.HandleFunc("POST /api/watchers", s.createWatcherHandler)
	apiMux.HandleFunc("GET /api/watchers/status", s.watcherStatusHandler)
	apiMux.HandleFunc("GET /api/watchers/{id}", s.getWatcherHandler)
	apiMux.HandleFunc("PATCH /api/watchers/{id}", s.updateWatcherHandler)
	apiMux.HandleFunc("DELETE /api/watchers/{id}", s.deleteWatcherHandler)
	apiMux.HandleFunc("POST /api/watchers/{id}/toggle", s.toggleWatcherHandler)
	apiMux.HandleFunc("POST /api/watchers/{id}/resume", s.resumeWatcherHandler)
	apiMux.HandleFunc("POST /api/watchers/{id}/run", s.runWatcherHandler)
	apiMux.HandleFunc("GET /api/watchers/{id}/runs", s.listWatcherRunsHandler)
	apiMux.HandleFunc("GET /api/watchers/{id}/events", s.listWatcherEventsHandler)
	apiMux.HandleFunc("GET /api/notifications/config", s.getNotificationConfigHandler)
	apiMux.HandleFunc("PUT /api/notifications/config", s.updateNotificationConfigHandler)
	apiMux.HandleFunc("POST /api/notifications/test", s.testNotificationHandler)
	apiMux.HandleFunc("POST /api/notifications/telegram/detect-chat", s.detectTelegramChatHandler)

	// Web Dashboard Session Ticket
	apiMux.HandleFunc("POST /api/web-session/ticket", s.createWebSessionTicketHandler)

	mux.Handle("/api/", s.authMiddleware(apiMux))

	// Standalone Web Dashboard (method-less patterns so non-GET methods never fall through to "/")
	mux.HandleFunc("/dashboard", s.dashboardRedirectHandler)
	mux.HandleFunc("/dashboard/auth/exchange", s.exchangeWebSessionTicketHandler)
	mux.Handle("/dashboard/", s.dashboardStaticHandler())

	// Protected MCP endpoint (delegates to s.mcpHandler when wired in M6)
	mcpStub := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.MCPEnabled() {
			respondWithError(w, http.StatusNotFound, "MCP server is disabled")
			return
		}
		if s.mcpHandler != nil {
			s.mcpHandler.ServeHTTP(w, r)
			return
		}
		respondWithError(w, http.StatusNotImplemented, "MCP server not initialized")
	})
	mux.Handle("/mcp", s.authMiddleware(mcpStub))
	mux.Handle("/mcp/", s.authMiddleware(mcpStub))

	// Protected extension WebSocket endpoint
	mux.HandleFunc("/ws/extension", s.wsExtensionHandler)

	// Wrap root mux with dashboard traversal guard and strict Origin-echoing CORS middleware
	return s.corsMiddleware(s.dashboardTraversalMiddleware(mux))
}

// IsAllowedOrigin strictly validates an HTTP Origin header using URL parsing and exact host/scheme rules.
func (s *Server) IsAllowedOrigin(origin string) bool {
	origin = strings.TrimSpace(origin)
	if origin == "" || origin == "null" {
		return false
	}

	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if u.Path != "" && u.Path != "/" {
		return false
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme == "chrome-extension" || scheme == "moz-extension" {
		if u.Port() != "" {
			return false
		}
		return strings.TrimSpace(u.Hostname()) != ""
	}

	cfg := ""
	if s != nil {
		cfg = strings.TrimSpace(s.corsAllowedOrigins)
	}

	if cfg == "" || cfg == "*" {
		if scheme != "http" {
			return false
		}
		host := strings.ToLower(u.Hostname())
		return host == "127.0.0.1" || host == "localhost" || host == "::1"
	}

	for _, entry := range strings.Split(cfg, ",") {
		p := strings.TrimSpace(entry)
		if p == "" || p == "*" {
			continue
		}
		if strings.EqualFold(p, origin) {
			return true
		}
		if strings.HasSuffix(p, ":*") {
			base := strings.TrimSuffix(p, ":*")
			pu, pErr := url.Parse(base)
			if pErr == nil && pu.Port() == "" &&
				strings.EqualFold(u.Scheme, pu.Scheme) &&
				strings.EqualFold(u.Hostname(), pu.Hostname()) {
				return true
			}
		}
	}

	return false
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")

		origin := strings.TrimSpace(r.Header.Get("Origin"))
		allowed := origin != "" && s.IsAllowedOrigin(origin)
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-CSRF-Token")
			w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id")
			w.Header().Set("Access-Control-Allow-Credentials", "false")
		}

		if r.Method == http.MethodOptions {
			if origin != "" && !allowed {
				w.WriteHeader(http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func headerContainsToken(headerVal, target string) bool {
	for _, part := range strings.Split(headerVal, ",") {
		if strings.EqualFold(strings.TrimSpace(part), target) {
			return true
		}
	}
	return false
}

func (s *Server) wsExtensionHandler(w http.ResponseWriter, r *http.Request) {
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" && !s.IsAllowedOrigin(origin) {
		respondWithError(w, http.StatusForbidden, "Origin not allowed")
		return
	}

	status := s.AuthenticateWSRequest(r)
	switch status {
	case WSAuthInvalidCredentials:
		w.Header().Set("WWW-Authenticate", "Bearer")
		respondWithError(w, http.StatusUnauthorized, "Unauthorized")
		return
	case WSAuthMissingCredentials:
		isWSUpgrade := strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket") &&
			headerContainsToken(r.Header.Get("Connection"), "upgrade")
		if !isWSUpgrade {
			w.Header().Set("WWW-Authenticate", "Bearer")
			respondWithError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		// Allow WebSocket upgrade to proceed to s.wsHandler for first-frame JSON-RPC auth handshake.
	case WSAuthAuthenticated:
		// Authenticated via Bearer header or ?token= query parameter.
	}

	if s.wsHandler != nil {
		s.wsHandler.ServeHTTP(w, r)
		return
	}
	respondWithError(w, http.StatusNotImplemented, "WebSocket bridge not initialized")
}

func targetsDashboard(u *url.URL) bool {
	if u == nil {
		return false
	}
	for _, candidate := range []string{u.Path, u.EscapedPath(), u.RawPath} {
		if candidate == "" {
			continue
		}
		lower := strings.ToLower(candidate)
		if lower == "/dashboard" ||
			strings.HasPrefix(lower, "/dashboard/") ||
			strings.HasPrefix(lower, "/dashboard\\") ||
			strings.HasPrefix(lower, "/dashboard%2f") ||
			strings.HasPrefix(lower, "/dashboard%5c") {
			return true
		}
	}
	return false
}

func (s *Server) dashboardTraversalMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if targetsDashboard(r.URL) && webui.HasPathTraversal(r.URL) {
			webui.SetSecurityHeaders(w)
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) dashboardRedirectHandler(w http.ResponseWriter, r *http.Request) {
	webui.SetSecurityHeaders(w)
	if !ResolveEnrichmentConfig().WebUIEnabled {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	target := "/dashboard/"
	if r.URL != nil && r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func (s *Server) dashboardStaticHandler() http.Handler {
	static := http.StripPrefix("/dashboard/", webui.Handler())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		webui.SetSecurityHeaders(w)
		if !ResolveEnrichmentConfig().WebUIEnabled {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		static.ServeHTTP(w, r)
	})
}

func (s *Server) HelloWorldHandler(w http.ResponseWriter, r *http.Request) {
	resp := map[string]string{"message": "Hello World"}
	jsonResp, err := json.Marshal(resp)
	if err != nil {
		http.Error(w, "Failed to marshal response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(jsonResp); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	dbStatus := "down"
	overallStatus := "degraded"
	if s.db != nil {
		stats := s.db.Health()
		if stats["status"] == "up" {
			dbStatus = "up"
			overallStatus = "ok"
		}
	}

	resp, err := json.Marshal(map[string]string{
		"status": overallStatus,
		"db":     dbStatus,
	})
	if err != nil {
		http.Error(w, "Failed to marshal health check response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(resp); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}

// apiHealthHandler returns authenticated detailed health and environment info.
func (s *Server) apiHealthHandler(w http.ResponseWriter, r *http.Request) {
	dbStatus := "down"
	var dbHealth map[string]string
	if s.db != nil {
		dbHealth = s.db.Health()
		if dbHealth["status"] == "up" {
			dbStatus = "up"
		}
	}
	status := "ok"
	if dbStatus != "up" {
		status = "degraded"
	}

	resp := map[string]any{
		"status": status,
		"env":    s.env,
		"db":     dbHealth,
	}
	jsonResp, err := json.Marshal(resp)
	if err != nil {
		http.Error(w, "Failed to marshal health response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(jsonResp); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}
