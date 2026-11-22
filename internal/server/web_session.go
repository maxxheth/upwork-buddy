package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"upwork-buddy/internal/webui"
)

const (
	webTicketTTL         = 5 * time.Minute
	maxPendingWebTickets = 4096
	maxWebSessions       = 4096
	maxWebAuthBodyBytes  = 16 * 1024
)

type webTicketEntry struct {
	hash      [32]byte
	expiresAt time.Time
}

type webSessionEntry struct {
	hash      [32]byte
	expiresAt time.Time
}

type webSessionManager struct {
	mu       sync.Mutex
	tickets  map[[32]byte]webTicketEntry
	sessions map[[32]byte]webSessionEntry
	nowFn    func() time.Time
}

func newWebSessionManager() *webSessionManager {
	return &webSessionManager{
		tickets:  make(map[[32]byte]webTicketEntry),
		sessions: make(map[[32]byte]webSessionEntry),
		nowFn:    func() time.Time { return time.Now().UTC() },
	}
}

func (m *webSessionManager) now() time.Time {
	if m != nil && m.nowFn != nil {
		return m.nowFn().UTC()
	}
	return time.Now().UTC()
}

func (m *webSessionManager) pruneExpiredTicketsLocked(now time.Time) {
	for k, v := range m.tickets {
		if !now.Before(v.expiresAt) {
			delete(m.tickets, k)
		}
	}
}

func (m *webSessionManager) evictOldestTicketLocked() {
	var oldestKey [32]byte
	var oldestTime time.Time
	found := false
	for k, v := range m.tickets {
		if !found || v.expiresAt.Before(oldestTime) {
			oldestKey = k
			oldestTime = v.expiresAt
			found = true
		}
	}
	if found {
		delete(m.tickets, oldestKey)
	}
}

func (m *webSessionManager) pruneExpiredSessionsLocked(now time.Time) {
	for k, v := range m.sessions {
		if !now.Before(v.expiresAt) {
			delete(m.sessions, k)
		}
	}
}

func (m *webSessionManager) evictOldestSessionLocked() {
	var oldestKey [32]byte
	var oldestTime time.Time
	found := false
	for k, v := range m.sessions {
		if !found || v.expiresAt.Before(oldestTime) {
			oldestKey = k
			oldestTime = v.expiresAt
			found = true
		}
	}
	if found {
		delete(m.sessions, oldestKey)
	}
}

func generateWebRandomToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate random token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

// MintWebTicket generates a single-use, 5-minute web dashboard ticket stored only by SHA-256 hash.
func (s *Server) MintWebTicket() (string, time.Time, error) {
	if s == nil {
		return "", time.Time{}, &ServiceError{
			Code:       "INTERNAL_ERROR",
			HTTPStatus: http.StatusInternalServerError,
			Message:    "Server unavailable",
		}
	}
	if !ResolveEnrichmentConfig().WebUIEnabled {
		return "", time.Time{}, &ServiceError{
			Code:       "NOT_FOUND",
			HTTPStatus: http.StatusNotFound,
			Message:    "Web UI is disabled",
		}
	}

	tok, err := generateWebRandomToken()
	if err != nil {
		return "", time.Time{}, &ServiceError{
			Code:       "INTERNAL_ERROR",
			HTTPStatus: http.StatusInternalServerError,
			Message:    "Failed to mint web session ticket",
		}
	}

	mgr := s.getWebSessionManager()
	sum := sha256.Sum256([]byte(tok))

	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	now := mgr.now()
	mgr.pruneExpiredTicketsLocked(now)
	for len(mgr.tickets) >= maxPendingWebTickets {
		mgr.evictOldestTicketLocked()
	}

	expiresAt := now.Add(webTicketTTL)
	mgr.tickets[sum] = webTicketEntry{
		hash:      sum,
		expiresAt: expiresAt,
	}
	return tok, expiresAt, nil
}

// ExchangeWebTicket atomically burns a single-use ticket and mints a scoped web session Bearer token.
func (s *Server) ExchangeWebTicket(ticket string) (sessionToken string, expiresAt time.Time, ok bool) {
	if s == nil || !ResolveEnrichmentConfig().WebUIEnabled {
		return "", time.Time{}, false
	}
	trimmed := strings.TrimSpace(ticket)
	if trimmed == "" {
		return "", time.Time{}, false
	}

	ticketSum := sha256.Sum256([]byte(trimmed))
	mgr := s.getWebSessionManager()

	mgr.mu.Lock()
	entry, exists := mgr.tickets[ticketSum]
	if !exists {
		mgr.mu.Unlock()
		return "", time.Time{}, false
	}
	// Burn immediately on lookup regardless of expiry or validity so tickets can never be replayed.
	delete(mgr.tickets, ticketSum)
	now := mgr.now()
	valid := subtle.ConstantTimeCompare(entry.hash[:], ticketSum[:]) == 1 && now.Before(entry.expiresAt)
	mgr.mu.Unlock()

	if !valid {
		return "", time.Time{}, false
	}

	sessTok, err := generateWebRandomToken()
	if err != nil {
		return "", time.Time{}, false
	}
	sessSum := sha256.Sum256([]byte(sessTok))
	ttl := ResolveEnrichmentConfig().WebSessionTTL()

	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	now = mgr.now()
	mgr.pruneExpiredSessionsLocked(now)
	for len(mgr.sessions) >= maxWebSessions {
		mgr.evictOldestSessionLocked()
	}

	sessExpiresAt := now.Add(ttl)
	mgr.sessions[sessSum] = webSessionEntry{
		hash:      sessSum,
		expiresAt: sessExpiresAt,
	}
	return sessTok, sessExpiresAt, true
}

// ValidateWebSessionToken verifies a scoped web dashboard Bearer token when Web UI is enabled.
func (s *Server) ValidateWebSessionToken(tok string) bool {
	if s == nil || !ResolveEnrichmentConfig().WebUIEnabled {
		return false
	}
	trimmed := strings.TrimSpace(tok)
	if trimmed == "" {
		return false
	}

	sum := sha256.Sum256([]byte(trimmed))
	mgr := s.getWebSessionManager()

	mgr.mu.Lock()
	defer mgr.mu.Unlock()

	entry, exists := mgr.sessions[sum]
	if !exists {
		return false
	}
	now := mgr.now()
	if !now.Before(entry.expiresAt) {
		delete(mgr.sessions, sum)
		return false
	}
	return subtle.ConstantTimeCompare(entry.hash[:], sum[:]) == 1
}

func normalizeDashboardHost(raw string) string {
	h := strings.TrimSpace(raw)
	if strings.HasPrefix(h, "[") && strings.HasSuffix(h, "]") && len(h) >= 2 {
		h = h[1 : len(h)-1]
	}
	switch strings.ToLower(h) {
	case "", "0.0.0.0", "::":
		return "127.0.0.1"
	default:
		return h
	}
}

func (s *Server) resolveDashboardBaseURL() string {
	if s != nil && s.port > 0 {
		host := normalizeDashboardHost(s.host)
		return fmt.Sprintf("http://%s", net.JoinHostPort(host, strconv.Itoa(s.port)))
	}
	raw := ResolveDaemonBaseURL()
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(raw, "/")
	}
	host := normalizeDashboardHost(u.Hostname())
	port := u.Port()
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/")
}

func sanitizeDashboardQuery(raw string) string {
	trimmed := strings.TrimPrefix(strings.TrimSpace(raw), "?")
	if trimmed == "" {
		return ""
	}
	vals, err := url.ParseQuery(trimmed)
	if err != nil && len(vals) == 0 {
		return ""
	}
	vals.Del("ticket")
	return vals.Encode()
}

func (s *Server) buildDashboardURLWithTicket(query string, ticket string) string {
	if s == nil || !ResolveEnrichmentConfig().WebUIEnabled {
		return ""
	}
	baseURL := s.resolveDashboardBaseURL()
	if baseURL == "" || strings.TrimSpace(ticket) == "" {
		return ""
	}
	params := sanitizeDashboardQuery(query)
	if params != "" {
		return fmt.Sprintf("%s/dashboard/?%s&ticket=%s", baseURL, params, url.QueryEscape(ticket))
	}
	return fmt.Sprintf("%s/dashboard/?ticket=%s", baseURL, url.QueryEscape(ticket))
}

// BuildDashboardURL mints a single-use web ticket and builds a normalized local dashboard URL.
func (s *Server) BuildDashboardURL(query string) string {
	if s == nil || !ResolveEnrichmentConfig().WebUIEnabled {
		return ""
	}
	ticket, _, err := s.MintWebTicket()
	if err != nil || ticket == "" {
		return ""
	}
	return s.buildDashboardURLWithTicket(query, ticket)
}

func isLoopbackRemoteAddr(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	host := trimmed
	if h, _, err := net.SplitHostPort(trimmed); err == nil {
		host = h
	} else if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") && len(trimmed) >= 2 {
		host = trimmed[1 : len(trimmed)-1]
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isASCIIDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func isLoopbackHostHeader(raw string) bool {
	if raw == "" || strings.ContainsAny(raw, " \t\r\n@/\\") {
		return false
	}

	host := raw
	if h, port, err := net.SplitHostPort(raw); err == nil {
		if !isASCIIDigits(port) {
			return false
		}
		p, pErr := strconv.Atoi(port)
		if pErr != nil || p < 1 || p > 65535 {
			return false
		}
		host = h
	} else if strings.HasPrefix(raw, "[") {
		if !strings.HasSuffix(raw, "]") || len(raw) < 3 {
			return false
		}
		inner := raw[1 : len(raw)-1]
		if strings.ContainsAny(inner, "[]") {
			return false
		}
		ip := net.ParseIP(inner)
		return ip != nil && ip.To4() == nil && ip.IsLoopback()
	} else if strings.Contains(raw, ":") {
		// Unbracketed IPv6 literal without port (e.g. "::1") vs malformed multi-colon host.
		ip := net.ParseIP(raw)
		return ip != nil && ip.IsLoopback()
	}

	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type createWebTicketRequest struct {
	RedirectQuery string `json:"redirect_query"`
}

func (s *Server) createWebSessionTicketHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		respondWithError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}
	if !ResolveEnrichmentConfig().WebUIEnabled {
		respondBridgeError(w, &ServiceError{
			Code:       "NOT_FOUND",
			HTTPStatus: http.StatusNotFound,
			Message:    "Web UI is disabled",
		})
		return
	}

	var req createWebTicketRequest
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, maxWebAuthBodyBytes)
		dec := json.NewDecoder(r.Body)
		err := dec.Decode(&req)
		if err != nil && !errors.Is(err, io.EOF) {
			respondBridgeError(w, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Invalid request body",
			})
			return
		}
		if err == nil {
			var extra any
			if err2 := dec.Decode(&extra); !errors.Is(err2, io.EOF) {
				respondBridgeError(w, &ServiceError{
					Code:       "INVALID_PARAMS",
					HTTPStatus: http.StatusBadRequest,
					Message:    "Invalid request body",
				})
				return
			}
		}
	}

	merged := url.Values{}
	if r.URL != nil {
		for k, vs := range r.URL.Query() {
			if k == "ticket" {
				continue
			}
			merged[k] = append([]string(nil), vs...)
		}
	}
	if rq := strings.TrimPrefix(strings.TrimSpace(req.RedirectQuery), "?"); rq != "" {
		parsed, pErr := url.ParseQuery(rq)
		if pErr != nil {
			respondBridgeError(w, &ServiceError{
				Code:       "INVALID_PARAMS",
				HTTPStatus: http.StatusBadRequest,
				Message:    "Invalid redirect_query parameter",
			})
			return
		}
		for k, vs := range parsed {
			if k == "ticket" {
				continue
			}
			merged[k] = append([]string(nil), vs...)
		}
	}
	merged.Del("ticket")

	ticket, expiresAt, err := s.MintWebTicket()
	if err != nil {
		respondBridgeError(w, err)
		return
	}

	dashURL := s.buildDashboardURLWithTicket(merged.Encode(), ticket)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	respondWithJSON(w, map[string]any{
		"ticket":        ticket,
		"dashboard_url": dashURL,
		"expires_at":    expiresAt.UTC().Format(time.RFC3339),
	})
}

type exchangeWebTicketRequest struct {
	Ticket string `json:"ticket"`
}

func (s *Server) exchangeWebSessionTicketHandler(w http.ResponseWriter, r *http.Request) {
	webui.SetSecurityHeaders(w)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")

	// 1. WEB_UI_ENABLED check
	if !ResolveEnrichmentConfig().WebUIEnabled {
		respondBridgeError(w, &ServiceError{
			Code:       "NOT_FOUND",
			HTTPStatus: http.StatusNotFound,
			Message:    "Web UI is disabled",
		})
		return
	}

	// 2. HTTP method check
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		respondBridgeError(w, &ServiceError{
			Code:       "METHOD_NOT_ALLOWED",
			HTTPStatus: http.StatusMethodNotAllowed,
			Message:    "Method not allowed",
		})
		return
	}

	// 3. Strict loopback RemoteAddr & Host check (ignores X-Forwarded-*, Forwarded, X-Real-IP)
	if !isLoopbackRemoteAddr(r.RemoteAddr) || !isLoopbackHostHeader(r.Host) {
		respondBridgeError(w, &ServiceError{
			Code:       "FORBIDDEN",
			HTTPStatus: http.StatusForbidden,
			Message:    "Loopback RemoteAddr and Host are required",
		})
		return
	}

	// 4. Content-Type check before reading/burning ticket
	mediaType, _, mimeErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mimeErr != nil || !strings.EqualFold(mediaType, "application/json") {
		respondBridgeError(w, &ServiceError{
			Code:       "UNSUPPORTED_MEDIA_TYPE",
			HTTPStatus: http.StatusUnsupportedMediaType,
			Message:    "Content-Type must be application/json",
		})
		return
	}

	// 5. Strict single-object JSON decode
	if r.Body == nil {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid request body",
		})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxWebAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	var req exchangeWebTicketRequest
	if err := dec.Decode(&req); err != nil {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid request body",
		})
		return
	}
	var extra any
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "Invalid request body",
		})
		return
	}
	if strings.TrimSpace(req.Ticket) == "" {
		respondBridgeError(w, &ServiceError{
			Code:       "INVALID_PARAMS",
			HTTPStatus: http.StatusBadRequest,
			Message:    "ticket is required",
		})
		return
	}

	// 6. Atomic single-use ticket burn & session mint
	sessionToken, expiresAt, ok := s.ExchangeWebTicket(req.Ticket)
	if !ok {
		respondBridgeError(w, &ServiceError{
			Code:       "UNAUTHORIZED",
			HTTPStatus: http.StatusUnauthorized,
			Message:    "Invalid or expired ticket",
		})
		return
	}

	// 7. Success response
	respondWithJSON(w, map[string]any{
		"session_token": sessionToken,
		"expires_at":    expiresAt.UTC().Format(time.RFC3339),
	})
}
