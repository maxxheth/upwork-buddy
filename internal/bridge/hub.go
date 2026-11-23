package bridge

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	defaultAuthTimeout      = 5 * time.Second
	defaultCallTimeout      = 60 * time.Second
	defaultMaxMessageBytes  = int64(8 << 20) // 8 MiB
	defaultWriteTimeout     = 5 * time.Second
	defaultCloseWaitTimeout = 2 * time.Second
)

// PreAuthChecker inspects an incoming HTTP upgrade request and returns true if already authenticated.
type PreAuthChecker func(r *http.Request) bool

// AuthFrameValidator validates a JSON-RPC 2.0 first-frame auth message and returns its ID and ok status.
type AuthFrameValidator func(raw []byte) (id json.RawMessage, ok bool)

// OriginChecker validates a non-empty HTTP Origin header.
type OriginChecker func(origin string) bool

// ProgressHandler receives task.progress events emitted by the extension.
type ProgressHandler func(evt ProgressEvent)

// SearchObservedHandler receives search.observed events pushed by the extension.
// Implementations MUST be non-blocking so Hub.readLoop never stalls waiting on RPC responses or DB I/O.
type SearchObservedHandler func(evt SearchObservedEvent)

// HubConfig configures a loopback WebSocket bridge Hub.
type HubConfig struct {
	AuthTimeout        time.Duration
	DefaultCallTimeout time.Duration
	MaxMessageBytes    int64
	PreAuthCheck       PreAuthChecker
	ValidateAuthFrame  AuthFrameValidator
	AllowOrigin        OriginChecker
	OnProgress         ProgressHandler
	OnSearchObserved   SearchObservedHandler
}

type rpcOutcome struct {
	result json.RawMessage
	rpcErr *WireRPCError
	err    error
}

type extSession struct {
	id               string
	conn             *websocket.Conn
	cancel           context.CancelFunc
	done             chan struct{}
	browser          string
	extensionVersion string
	connectedAt      time.Time

	stateMu         sync.RWMutex
	lastHeartbeatAt time.Time
	upworkLoggedIn  *bool

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan rpcOutcome
}

// Hub manages the active authenticated Chrome extension WebSocket session and JSON-RPC 2.0 calls.
type Hub struct {
	cfg HubConfig

	rootCtx    context.Context
	rootCancel context.CancelFunc
	closed     atomic.Bool

	mu     sync.RWMutex
	active *extSession

	progressMu   sync.RWMutex
	progressSubs map[string]map[chan ProgressEvent]struct{}

	searchObservedMu      sync.RWMutex
	searchObservedHandler SearchObservedHandler

	seq atomic.Uint64
}

// NewHub creates a new WebSocket bridge Hub with sensible defaults.
func NewHub(cfg HubConfig) *Hub {
	if cfg.AuthTimeout <= 0 {
		cfg.AuthTimeout = defaultAuthTimeout
	}
	if cfg.DefaultCallTimeout <= 0 {
		cfg.DefaultCallTimeout = defaultCallTimeout
	}
	if cfg.MaxMessageBytes <= 0 {
		cfg.MaxMessageBytes = defaultMaxMessageBytes
	}
	rootCtx, rootCancel := context.WithCancel(context.Background())
	return &Hub{
		cfg:                   cfg,
		rootCtx:               rootCtx,
		rootCancel:            rootCancel,
		progressSubs:          make(map[string]map[chan ProgressEvent]struct{}),
		searchObservedHandler: cfg.OnSearchObserved,
	}
}

func randomHex(nBytes int) string {
	buf := make([]byte, nBytes)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func (s *extSession) writeJSON(ctx context.Context, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	writeCtx, cancel := context.WithTimeout(ctx, defaultWriteTimeout)
	defer cancel()
	return s.conn.Write(writeCtx, websocket.MessageText, raw)
}

func (s *extSession) failAllPending(err error) {
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	for k, ch := range s.pending {
		select {
		case ch <- rpcOutcome{err: err}:
		default:
		}
		delete(s.pending, k)
	}
}

func (s *extSession) updateHeartbeat(loggedIn *bool) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	s.lastHeartbeatAt = time.Now().UTC()
	if loggedIn != nil {
		val := *loggedIn
		s.upworkLoggedIn = &val
	}
}

// ServeHTTP upgrades an incoming /ws/extension request, authenticates the session, and runs the read loop.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.closed.Load() {
		http.Error(w, "bridge shutting down", http.StatusServiceUnavailable)
		return
	}

	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" && h.cfg.AllowOrigin != nil {
		if !h.cfg.AllowOrigin(origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Explicit Origin validation performed above to avoid path.Match [::1] issues
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(h.cfg.MaxMessageBytes)

	connCtx, connCancel := context.WithCancel(h.rootCtx)
	defer connCancel()

	sessionID := "ext-" + randomHex(8)
	browser := "chrome"
	extVersion := ""

	var ackBytes []byte
	preAuthed := h.cfg.PreAuthCheck != nil && h.cfg.PreAuthCheck(r)
	if !preAuthed {
		authTimer := time.AfterFunc(h.cfg.AuthTimeout, func() {
			_ = conn.Close(WSCloseUnauthorized, "Unauthorized")
		})
		typ, raw, readErr := conn.Read(connCtx)
		authTimer.Stop()
		if readErr != nil || typ != websocket.MessageText || h.cfg.ValidateAuthFrame == nil {
			_ = conn.Close(WSCloseUnauthorized, "Unauthorized")
			return
		}

		frameID, ok := h.cfg.ValidateAuthFrame(raw)
		if !ok {
			_ = conn.Close(WSCloseUnauthorized, "Unauthorized")
			return
		}

		var env Envelope
		if uErr := json.Unmarshal(raw, &env); uErr == nil && len(bytes.TrimSpace(env.Params)) > 0 {
			var ap AuthParams
			if pErr := json.Unmarshal(env.Params, &ap); pErr == nil {
				if b := strings.TrimSpace(ap.Browser); b != "" {
					browser = b
				}
				extVersion = strings.TrimSpace(ap.ExtensionVersion)
			}
		}

		resBytes, _ := json.Marshal(AuthResult{
			OK:        true,
			SessionID: sessionID,
		})
		ackBytes, _ = json.Marshal(Envelope{
			JSONRPC: JSONRPCVersion,
			ID:      frameID,
			Result:  resBytes,
		})
	}

	now := time.Now().UTC()
	sess := &extSession{
		id:               sessionID,
		conn:             conn,
		cancel:           connCancel,
		done:             make(chan struct{}),
		browser:          browser,
		extensionVersion: extVersion,
		connectedAt:      now,
		lastHeartbeatAt:  now,
		pending:          make(map[string]chan rpcOutcome),
	}

	// Lock writeMu and register the session before writing the auth ACK so that:
	// 1. h.active is already populated before the client observes the ACK.
	// 2. Any concurrent CallExtension/NotifyExtension serializes behind the ACK frame.
	if len(ackBytes) > 0 {
		sess.writeMu.Lock()
	}
	if !h.registerSession(sess) {
		if len(ackBytes) > 0 {
			sess.writeMu.Unlock()
		}
		_ = conn.CloseNow()
		return
	}
	defer h.detachSession(sess)

	if len(ackBytes) > 0 {
		writeCtx, writeCancel := context.WithTimeout(connCtx, defaultWriteTimeout)
		writeErr := conn.Write(writeCtx, websocket.MessageText, ackBytes)
		writeCancel()
		sess.writeMu.Unlock()
		if writeErr != nil {
			_ = conn.CloseNow()
			return
		}
	}

	h.readLoop(connCtx, sess)
}

func (h *Hub) registerSession(sess *extSession) bool {
	h.mu.Lock()
	if h.closed.Load() {
		h.mu.Unlock()
		return false
	}
	prev := h.active
	h.active = sess
	h.mu.Unlock()

	if prev != nil && prev != sess {
		prev.failAllPending(ErrExtensionDisconnected)
		go func(old *extSession) {
			_ = old.conn.Close(websocket.StatusGoingAway, "replaced by new session")
			old.cancel()
		}(prev)
	}
	return true
}

func (h *Hub) detachSession(sess *extSession) {
	h.mu.Lock()
	if h.active == sess {
		h.active = nil
	}
	h.mu.Unlock()

	sess.failAllPending(ErrExtensionDisconnected)
	close(sess.done)
}

func (h *Hub) readLoop(ctx context.Context, sess *extSession) {
	for {
		typ, raw, err := sess.conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			_ = sess.writeJSON(ctx, map[string]any{
				"jsonrpc": JSONRPCVersion,
				"id":      nil,
				"error": map[string]any{
					"code":    JSONRPCParseError,
					"message": "Parse error",
				},
			})
			continue
		}

		// Case 1: Response frame (Method == "" and valid ID)
		if env.Method == "" {
			if key, ok := NormalizeIDKey(env.ID); ok {
				sess.pendingMu.Lock()
				ch, exists := sess.pending[key]
				if exists {
					delete(sess.pending, key)
				}
				sess.pendingMu.Unlock()
				if exists {
					ch <- rpcOutcome{
						result: env.Result,
						rpcErr: env.Error,
					}
				}
			}
			continue
		}

		switch env.Method {
		case "auth":
			if h.cfg.ValidateAuthFrame == nil {
				_ = sess.conn.Close(WSCloseUnauthorized, "Unauthorized")
				return
			}
			frameID, ok := h.cfg.ValidateAuthFrame(raw)
			if !ok {
				_ = sess.conn.Close(WSCloseUnauthorized, "Unauthorized")
				return
			}
			resBytes, _ := json.Marshal(AuthResult{
				OK:        true,
				SessionID: sess.id,
			})
			_ = sess.writeJSON(ctx, Envelope{
				JSONRPC: JSONRPCVersion,
				ID:      frameID,
				Result:  resBytes,
			})

		case "ping":
			var loggedIn *bool
			if len(bytes.TrimSpace(env.Params)) > 0 {
				var pp PingParams
				if pErr := json.Unmarshal(env.Params, &pp); pErr == nil && pp.UpworkLoggedIn != nil {
					loggedIn = pp.UpworkLoggedIn
				}
			}
			sess.updateHeartbeat(loggedIn)
			ts := time.Now().UTC().Format(time.RFC3339Nano)
			if _, hasID := NormalizeIDKey(env.ID); hasID {
				resBytes, _ := json.Marshal(map[string]any{
					"pong": true,
					"ts":   ts,
				})
				_ = sess.writeJSON(ctx, Envelope{
					JSONRPC: JSONRPCVersion,
					ID:      env.ID,
					Result:  resBytes,
				})
			} else {
				paramsBytes, _ := json.Marshal(map[string]any{
					"ts": ts,
				})
				_ = sess.writeJSON(ctx, Envelope{
					JSONRPC: JSONRPCVersion,
					Method:  "pong",
					Params:  paramsBytes,
				})
			}

		case "task.progress":
			if len(bytes.TrimSpace(env.Params)) > 0 {
				var evt ProgressEvent
				if pErr := json.Unmarshal(env.Params, &evt); pErr == nil {
					h.dispatchProgress(evt)
				}
			}

		case "search.observed":
			if trimmed := bytes.TrimSpace(env.Params); len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
				var evt SearchObservedEvent
				if pErr := json.Unmarshal(trimmed, &evt); pErr == nil {
					h.dispatchSearchObserved(evt)
				}
			}

		default:
			if _, hasID := NormalizeIDKey(env.ID); hasID {
				_ = sess.writeJSON(ctx, map[string]any{
					"jsonrpc": JSONRPCVersion,
					"id":      env.ID,
					"error": map[string]any{
						"code":    JSONRPCMethodNotFound,
						"message": "Method not found: " + env.Method,
					},
				})
			}
		}
	}
}

func (h *Hub) dispatchProgress(evt ProgressEvent) {
	if h.cfg.OnProgress != nil {
		h.cfg.OnProgress(evt)
	}
	if evt.RequestID == "" {
		return
	}
	h.progressMu.RLock()
	subs := h.progressSubs[evt.RequestID]
	targets := make([]chan ProgressEvent, 0, len(subs))
	for ch := range subs {
		targets = append(targets, ch)
	}
	h.progressMu.RUnlock()

	for _, ch := range targets {
		select {
		case ch <- evt:
		default:
		}
	}
}

// SetSearchObservedHandler sets or replaces the handler invoked when the extension emits search.observed.
// Implementations MUST be non-blocking so Hub.readLoop never stalls waiting on RPC responses or DB I/O.
func (h *Hub) SetSearchObservedHandler(fn SearchObservedHandler) {
	if h == nil {
		return
	}
	h.searchObservedMu.Lock()
	h.searchObservedHandler = fn
	h.searchObservedMu.Unlock()
}

func (h *Hub) dispatchSearchObserved(evt SearchObservedEvent) {
	if h == nil {
		return
	}
	h.searchObservedMu.RLock()
	fn := h.searchObservedHandler
	h.searchObservedMu.RUnlock()
	if fn != nil {
		fn(evt)
	}
}

// SubscribeProgress registers a buffered channel to receive task.progress events for requestID.
func (h *Hub) SubscribeProgress(requestID string) (<-chan ProgressEvent, func()) {
	ch := make(chan ProgressEvent, 16)
	h.progressMu.Lock()
	if h.progressSubs[requestID] == nil {
		h.progressSubs[requestID] = make(map[chan ProgressEvent]struct{})
	}
	h.progressSubs[requestID][ch] = struct{}{}
	h.progressMu.Unlock()

	cancel := func() {
		h.progressMu.Lock()
		if subs := h.progressSubs[requestID]; subs != nil {
			delete(subs, ch)
			if len(subs) == 0 {
				delete(h.progressSubs, requestID)
			}
		}
		h.progressMu.Unlock()
	}
	return ch, cancel
}

func (h *Hub) getActiveSession() *extSession {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.active
}

// IsConnected reports whether an authenticated extension session is currently active.
func (h *Hub) IsConnected() bool {
	return h != nil && !h.closed.Load() && h.getActiveSession() != nil
}

// Status returns the current extension connection and heartbeat snapshot.
func (h *Hub) Status() BridgeStatus {
	if h == nil || h.closed.Load() {
		return BridgeStatus{ExtensionConnected: false}
	}
	sess := h.getActiveSession()
	if sess == nil {
		return BridgeStatus{ExtensionConnected: false}
	}

	sess.stateMu.RLock()
	lastHB := sess.lastHeartbeatAt
	var loggedInCopy *bool
	if sess.upworkLoggedIn != nil {
		v := *sess.upworkLoggedIn
		loggedInCopy = &v
	}
	sess.stateMu.RUnlock()

	return BridgeStatus{
		ExtensionConnected: true,
		SessionID:          sess.id,
		Browser:            sess.browser,
		ExtensionVersion:   sess.extensionVersion,
		UpworkLoggedIn:     loggedInCopy,
		ConnectedAt:        sess.connectedAt.Format(time.RFC3339Nano),
		LastHeartbeatAt:    lastHB.Format(time.RFC3339Nano),
	}
}

// CallExtension sends a JSON-RPC 2.0 request to the active extension session and awaits its correlated response.
func (h *Hub) CallExtension(
	ctx context.Context,
	method string,
	params any,
	timeout time.Duration,
) (json.RawMessage, error) {
	if h == nil || h.closed.Load() {
		return nil, ErrExtensionDisconnected
	}
	sess := h.getActiveSession()
	if sess == nil {
		return nil, ErrExtensionDisconnected
	}

	if timeout <= 0 {
		timeout = h.cfg.DefaultCallTimeout
	}

	reqID := fmt.Sprintf("rpc-%d-%s", h.seq.Add(1), randomHex(4))
	rawID, _ := json.Marshal(reqID)
	key, _ := NormalizeIDKey(rawID)

	var rawParams json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("marshal params for %s: %w", method, err)
		}
		rawParams = b
	}

	ch := make(chan rpcOutcome, 1)
	sess.pendingMu.Lock()
	sess.pending[key] = ch
	sess.pendingMu.Unlock()

	cleanupPending := func() {
		sess.pendingMu.Lock()
		delete(sess.pending, key)
		sess.pendingMu.Unlock()
	}

	env := Envelope{
		JSONRPC:   JSONRPCVersion,
		ID:        rawID,
		Method:    method,
		Params:    rawParams,
		TimeoutMS: int(timeout.Milliseconds()),
	}

	if err := sess.writeJSON(ctx, env); err != nil {
		cleanupPending()
		return nil, &BridgeError{
			Code:    ErrCodeExtensionDisconnected,
			Message: fmt.Sprintf("failed writing RPC %s: %v", method, err),
		}
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case outcome := <-ch:
		if outcome.err != nil {
			return nil, outcome.err
		}
		if outcome.rpcErr != nil {
			return nil, ClassifyWireError(outcome.rpcErr)
		}
		if resErr := CheckResultForError(outcome.result); resErr != nil {
			return outcome.result, resErr
		}
		return outcome.result, nil
	case <-sess.done:
		cleanupPending()
		return nil, ErrExtensionDisconnected
	case <-ctx.Done():
		cleanupPending()
		return nil, ctx.Err()
	case <-timer.C:
		cleanupPending()
		return nil, &BridgeError{
			Code:    ErrCodeTimeout,
			Message: fmt.Sprintf("extension RPC %s timed out after %s", method, timeout),
		}
	}
}

// NotifyExtension sends a JSON-RPC 2.0 notification (no response expected) to the active extension session.
func (h *Hub) NotifyExtension(ctx context.Context, method string, params any) error {
	if h == nil || h.closed.Load() {
		return ErrExtensionDisconnected
	}
	sess := h.getActiveSession()
	if sess == nil {
		return ErrExtensionDisconnected
	}

	var rawParams json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			return fmt.Errorf("marshal notification params for %s: %w", method, err)
		}
		rawParams = b
	}

	env := Envelope{
		JSONRPC: JSONRPCVersion,
		Method:  method,
		Params:  rawParams,
	}
	if err := sess.writeJSON(ctx, env); err != nil {
		return &BridgeError{
			Code:    ErrCodeExtensionDisconnected,
			Message: fmt.Sprintf("failed writing notification %s: %v", method, err),
		}
	}
	return nil
}

// Close shuts down the hub and closes any active WebSocket session cleanly.
func (h *Hub) Close() error {
	if h == nil {
		return nil
	}
	if h.closed.Swap(true) {
		return nil
	}

	sess := h.getActiveSession()
	if sess != nil {
		sess.failAllPending(ErrExtensionDisconnected)
		_ = sess.conn.Close(websocket.StatusGoingAway, "server shutting down")
		h.rootCancel()
		select {
		case <-sess.done:
		case <-time.After(defaultCloseWaitTimeout):
			_ = sess.conn.CloseNow()
		}
	} else {
		h.rootCancel()
	}
	return nil
}
