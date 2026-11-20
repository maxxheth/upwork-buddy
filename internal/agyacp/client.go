package agyacp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultModelName      = "gemini-pro-orchestrator-neon"
	defaultEffortLevel    = "medium"
	defaultMaxConcurrent  = 2
	defaultRequestTimeout = 180 * time.Second
	sessionCloseTimeout   = 5 * time.Second
	maxStderrBytes        = 16 * 1024
)

var (
	// ErrAuthRequired indicates the ACP subprocess requires Antigravity authentication.
	ErrAuthRequired = errors.New("agyacp: authentication required")
	// ErrProcessUnavailable indicates the ACP subprocess is not running or exited unexpectedly.
	ErrProcessUnavailable = errors.New("agyacp: acp process unavailable")
)

// Config configures the supervised Antigravity ACP client.
type Config struct {
	AgyBin         string
	DefaultModel   string
	DefaultEffort  string
	MaxConcurrent  int
	ScratchDir     string
	RequestTimeout time.Duration
	ExtraArgs      []string
	CommandFactory func(ctx context.Context, bin string, args ...string) *exec.Cmd
}

// ChatMessage represents a single role/content turn in a chat request.
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatRequest describes a non-streaming chat completion request to ACP.
type ChatRequest struct {
	Model    string        `json:"model"`
	Effort   string        `json:"effort,omitempty"`
	Format   string        `json:"format,omitempty"`
	Messages []ChatMessage `json:"messages"`
}

// UsageStats captures token accounting returned by ACP session/prompt.
type UsageStats struct {
	InputTokens   int `json:"inputTokens,omitempty"`
	OutputTokens  int `json:"outputTokens,omitempty"`
	ThoughtTokens int `json:"thoughtTokens,omitempty"`
	TotalTokens   int `json:"totalTokens,omitempty"`
}

// ChatResult holds the aggregated response from an ACP prompt turn.
type ChatResult struct {
	Model         string     `json:"model"`
	AppliedModel  string     `json:"applied_model"`
	AppliedEffort string     `json:"applied_effort,omitempty"`
	EffortApplied bool       `json:"effort_applied"`
	Content       string     `json:"content"`
	StopReason    string     `json:"stop_reason,omitempty"`
	Usage         UsageStats `json:"usage"`
}

// ModelInfo describes a model advertised by ACP session/new.
type ModelInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ClientStatus reports the health and activity of the supervised ACP client.
type ClientStatus struct {
	Ready          bool   `json:"ready"`
	Running        bool   `json:"running"`
	Initialized    bool   `json:"initialized"`
	DefaultModel   string `json:"default_model"`
	DefaultEffort  string `json:"default_effort"`
	ActiveSessions int    `json:"active_sessions"`
	LastError      string `json:"last_error,omitempty"`
}

// ACPClient defines the client operations used by the HTTP gateway.
type ACPClient interface {
	Start(ctx context.Context) error
	Warm(ctx context.Context) error
	Healthy() bool
	Status() ClientStatus
	ListModels(ctx context.Context) ([]ModelInfo, error)
	Chat(ctx context.Context, req ChatRequest) (ChatResult, error)
	Close() error
}

type rpcEnvelope struct {
	JSONRPC string           `json:"jsonrpc,omitempty"`
	ID      json.RawMessage  `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
	Result  json.RawMessage  `json:"result,omitempty"`
	Error   *rpcErrorPayload `json:"error,omitempty"`
}

type rpcErrorPayload struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcErrorPayload) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

type rpcResponse struct {
	result json.RawMessage
	err    error
}

type configOptionValue struct {
	Value string `json:"value"`
	Name  string `json:"name"`
}

type configOption struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Category     string              `json:"category"`
	Type         string              `json:"type"`
	CurrentValue string              `json:"currentValue"`
	Options      []configOptionValue `json:"options"`
}

type sessionNewResult struct {
	SessionID string `json:"sessionId"`
	Models    struct {
		AvailableModels []struct {
			ModelID string `json:"modelId"`
			Name    string `json:"name"`
		} `json:"availableModels"`
	} `json:"models"`
	ConfigOptions []configOption `json:"configOptions"`
}

type setConfigResult struct {
	ConfigOptions []configOption `json:"configOptions"`
}

type sessionPromptResult struct {
	StopReason string     `json:"stopReason"`
	Usage      UsageStats `json:"usage"`
}

type sessionUpdateParams struct {
	SessionID string `json:"sessionId"`
	Update    struct {
		SessionUpdate string `json:"sessionUpdate"`
		Content       struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	} `json:"update"`
}

type permissionOption struct {
	OptionID string `json:"optionId"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
}

type requestPermissionParams struct {
	SessionID string             `json:"sessionId"`
	Options   []permissionOption `json:"options"`
}

type sessionUpdate struct {
	kind string
	text string
}

type procState struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	cancel context.CancelFunc
	done   chan struct{}
	stderr *cappedBuffer
}

type cappedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func newCappedBuffer(max int) *cappedBuffer {
	return &cappedBuffer{max: max}
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.buf.Len()+len(p) > b.max {
		keep := b.max - len(p)
		if keep <= 0 {
			b.buf.Reset()
			if len(p) > b.max {
				p = p[len(p)-b.max:]
			}
		} else {
			cur := b.buf.Bytes()
			b.buf.Reset()
			b.buf.Write(cur[len(cur)-keep:])
		}
	}
	return b.buf.Write(p)
}

func (b *cappedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return strings.TrimSpace(b.buf.String())
}

// Client supervises a single long-lived `agy acp --stdio` subprocess.
type Client struct {
	cfg Config
	sem chan struct{}

	startMu sync.Mutex

	mu               sync.Mutex
	proc             *procState
	initialized      bool
	closed           bool
	nextID           int64
	pending          map[int64]chan rpcResponse
	sessionListeners map[string]chan sessionUpdate
	cachedModels     []ModelInfo
	lastError        string
	activeSessions   atomic.Int64

	writeMu sync.Mutex
}

// NewClient creates a supervised ACP client with normalized defaults.
func NewClient(cfg Config) *Client {
	if strings.TrimSpace(cfg.DefaultModel) == "" {
		cfg.DefaultModel = defaultModelName
	}
	if strings.TrimSpace(cfg.DefaultEffort) == "" {
		cfg.DefaultEffort = defaultEffortLevel
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = defaultMaxConcurrent
	}
	if cfg.RequestTimeout <= 0 {
		cfg.RequestTimeout = defaultRequestTimeout
	}
	if strings.TrimSpace(cfg.ScratchDir) == "" {
		base, err := os.UserCacheDir()
		if err != nil || strings.TrimSpace(base) == "" {
			base = os.TempDir()
		}
		cfg.ScratchDir = filepath.Join(base, "upwork-buddy-agyacp-scratch")
	}
	return &Client{
		cfg:              cfg,
		sem:              make(chan struct{}, cfg.MaxConcurrent),
		pending:          make(map[int64]chan rpcResponse),
		sessionListeners: make(map[string]chan sessionUpdate),
	}
}

// Start ensures the ACP subprocess is running and initialized.
func (c *Client) Start(ctx context.Context) error {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	return c.startLocked(ctx)
}

func (c *Client) startLocked(ctx context.Context) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrProcessUnavailable
	}
	if c.proc != nil && c.initialized {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	if err := os.MkdirAll(c.cfg.ScratchDir, 0o700); err != nil {
		return fmt.Errorf("create scratch dir %q: %w", c.cfg.ScratchDir, err)
	}

	bin, err := resolveAgyBin(c.cfg.AgyBin)
	if err != nil {
		c.setLastError(err.Error())
		return err
	}

	args := []string{
		"acp",
		"--stdio",
		"--include-default-customizations=false",
		"--disable-telemetry",
	}
	for _, extra := range c.cfg.ExtraArgs {
		if strings.TrimSpace(extra) == "--dangerously-skip-permissions" {
			continue
		}
		args = append(args, extra)
	}

	procCtx, procCancel := context.WithCancel(context.Background())
	factory := c.cfg.CommandFactory
	if factory == nil {
		factory = exec.CommandContext
	}
	cmd := factory(procCtx, bin, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		procCancel()
		c.setLastError(err.Error())
		return fmt.Errorf("%w: stdin pipe: %v", ErrProcessUnavailable, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		procCancel()
		c.setLastError(err.Error())
		return fmt.Errorf("%w: stdout pipe: %v", ErrProcessUnavailable, err)
	}
	stderrBuf := newCappedBuffer(maxStderrBytes)
	cmd.Stderr = stderrBuf

	if err := cmd.Start(); err != nil {
		procCancel()
		c.setLastError(err.Error())
		return mapAuthOrProcessErr(err, stderrBuf.String())
	}

	ps := &procState{
		cmd:    cmd,
		stdin:  stdin,
		cancel: procCancel,
		done:   make(chan struct{}),
		stderr: stderrBuf,
	}

	c.mu.Lock()
	c.proc = ps
	c.initialized = false
	c.lastError = ""
	c.mu.Unlock()

	go c.readLoop(ps, stdout)
	go c.waitLoop(ps)

	initParams := map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{},
	}
	if _, err := c.call(ctx, "initialize", initParams); err != nil {
		c.stopProc(ps)
		mapped := mapAuthOrProcessErr(err, stderrBuf.String())
		c.setLastError(mapped.Error())
		return mapped
	}

	c.mu.Lock()
	if c.proc == ps {
		c.initialized = true
	}
	c.mu.Unlock()

	return nil
}

// Warm starts the ACP subprocess and opens/closes a single warmup session to cache models.
func (c *Client) Warm(ctx context.Context) error {
	if err := c.Start(ctx); err != nil {
		return err
	}
	sess, err := c.newSession(ctx)
	if err != nil {
		return err
	}
	c.closeSession(sess.SessionID)
	return nil
}

// Healthy reports whether the ACP subprocess is running and initialized.
func (c *Client) Healthy() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed && c.proc != nil && c.initialized
}

// Status returns a snapshot of the client's operational state.
func (c *Client) Status() ClientStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	running := !c.closed && c.proc != nil
	return ClientStatus{
		Ready:          running && c.initialized,
		Running:        running,
		Initialized:    c.initialized,
		DefaultModel:   c.cfg.DefaultModel,
		DefaultEffort:  c.cfg.DefaultEffort,
		ActiveSessions: int(c.activeSessions.Load()),
		LastError:      c.lastError,
	}
}

// ListModels returns available models, opening a transient session if not yet cached.
func (c *Client) ListModels(ctx context.Context) ([]ModelInfo, error) {
	c.mu.Lock()
	if len(c.cachedModels) > 0 {
		out := make([]ModelInfo, len(c.cachedModels))
		copy(out, c.cachedModels)
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()

	if err := c.Start(ctx); err != nil {
		return nil, err
	}
	sess, err := c.newSession(ctx)
	if err != nil {
		return nil, err
	}
	c.closeSession(sess.SessionID)

	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]ModelInfo, len(c.cachedModels))
	copy(out, c.cachedModels)
	return out, nil
}

// Chat executes a non-streaming prompt turn against ACP with bounded concurrency.
func (c *Client) Chat(ctx context.Context, req ChatRequest) (ChatResult, error) {
	if len(req.Messages) == 0 {
		return ChatResult{}, errors.New("agyacp: messages must not be empty")
	}

	if c.cfg.RequestTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.cfg.RequestTimeout)
		defer cancel()
	}

	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return ChatResult{}, ctx.Err()
	}

	c.activeSessions.Add(1)
	defer c.activeSessions.Add(-1)

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if err := c.Start(ctx); err != nil {
			lastErr = err
			if attempt == 0 && errors.Is(err, ErrProcessUnavailable) && ctx.Err() == nil {
				continue
			}
			return ChatResult{}, err
		}

		res, prePromptErr, err := c.chatOnce(ctx, req)
		if err == nil {
			return res, nil
		}
		lastErr = err
		if attempt == 0 && prePromptErr && errors.Is(err, ErrProcessUnavailable) && ctx.Err() == nil {
			continue
		}
		return ChatResult{}, err
	}
	return ChatResult{}, lastErr
}

func (c *Client) chatOnce(ctx context.Context, req ChatRequest) (ChatResult, bool, error) {
	sess, err := c.newSession(ctx)
	if err != nil {
		return ChatResult{}, true, err
	}
	sid := sess.SessionID
	defer c.closeSession(sid)

	requestedModel := strings.TrimSpace(req.Model)
	if requestedModel == "" {
		requestedModel = c.cfg.DefaultModel
	}
	requestedEffort := strings.TrimSpace(req.Effort)
	explicitEffort := requestedEffort != ""
	if !explicitEffort {
		requestedEffort = c.cfg.DefaultEffort
	}

	targetModel, derivedEffort := resolveModelAndEffort(requestedModel, sess)
	if !explicitEffort && derivedEffort != "" {
		requestedEffort = derivedEffort
	}

	currentOptions := sess.ConfigOptions
	if targetModel != "" {
		rawRes, err := c.call(ctx, "session/set_config_option", map[string]any{
			"sessionId": sid,
			"configId":  "model",
			"value":     targetModel,
		})
		if err != nil {
			return ChatResult{}, true, err
		}
		var setRes setConfigResult
		if err := json.Unmarshal(rawRes, &setRes); err == nil && len(setRes.ConfigOptions) > 0 {
			currentOptions = setRes.ConfigOptions
		}
	}

	appliedEffort := ""
	effortApplied := false
	if requestedEffort != "" && supportsThoughtLevel(currentOptions, requestedEffort) {
		if _, err := c.call(ctx, "session/set_config_option", map[string]any{
			"sessionId": sid,
			"configId":  "thought_level",
			"value":     requestedEffort,
		}); err != nil {
			return ChatResult{}, true, err
		}
		appliedEffort = requestedEffort
		effortApplied = true
	}

	updateCh := make(chan sessionUpdate, 256)
	c.registerSessionListener(sid, updateCh)
	defer c.unregisterSessionListener(sid)

	promptText := formatPrompt(req.Messages, req.Format)
	id, respCh, err := c.sendRequest("session/prompt", map[string]any{
		"sessionId": sid,
		"prompt": []map[string]string{
			{"type": "text", "text": promptText},
		},
	})
	if err != nil {
		return ChatResult{}, true, err
	}
	defer c.deletePending(id)

	var sb strings.Builder
	for {
		select {
		case u := <-updateCh:
			if u.kind == "agent_message_chunk" {
				sb.WriteString(u.text)
			}
		case resp := <-respCh:
			// Drain any buffered chunks emitted before the final JSON-RPC result.
			for {
				select {
				case u := <-updateCh:
					if u.kind == "agent_message_chunk" {
						sb.WriteString(u.text)
					}
				default:
					goto drained
				}
			}
		drained:
			if resp.err != nil {
				return ChatResult{}, false, resp.err
			}
			var pr sessionPromptResult
			if len(resp.result) > 0 {
				if err := json.Unmarshal(resp.result, &pr); err != nil {
					return ChatResult{}, false, fmt.Errorf("decode session/prompt result: %w", err)
				}
			}
			return ChatResult{
				Model:         requestedModel,
				AppliedModel:  targetModel,
				AppliedEffort: appliedEffort,
				EffortApplied: effortApplied,
				Content:       sb.String(),
				StopReason:    pr.StopReason,
				Usage:         pr.Usage,
			}, false, nil
		case <-ctx.Done():
			_ = c.sendNotification("session/cancel", map[string]any{
				"sessionId": sid,
			})
			return ChatResult{}, false, ctx.Err()
		}
	}
}

// Close shuts down the supervised ACP subprocess and fails any pending requests.
func (c *Client) Close() error {
	c.mu.Lock()
	c.closed = true
	ps := c.proc
	c.mu.Unlock()

	if ps != nil {
		c.stopProc(ps)
		<-ps.done
	}
	return nil
}

func (c *Client) newSession(ctx context.Context) (sessionNewResult, error) {
	raw, err := c.call(ctx, "session/new", map[string]any{
		"cwd":        c.cfg.ScratchDir,
		"mcpServers": []any{},
	})
	if err != nil {
		return sessionNewResult{}, err
	}
	var res sessionNewResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return sessionNewResult{}, fmt.Errorf("decode session/new result: %w", err)
	}
	if strings.TrimSpace(res.SessionID) == "" {
		return sessionNewResult{}, errors.New("agyacp: session/new returned empty sessionId")
	}
	c.cacheModels(res)
	return res, nil
}

func (c *Client) closeSession(sid string) {
	if strings.TrimSpace(sid) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), sessionCloseTimeout)
	defer cancel()
	_, _ = c.call(ctx, "session/close", map[string]any{
		"sessionId": sid,
	})
}

func (c *Client) cacheModels(res sessionNewResult) {
	if len(res.Models.AvailableModels) == 0 {
		return
	}
	models := make([]ModelInfo, 0, len(res.Models.AvailableModels))
	for _, m := range res.Models.AvailableModels {
		if strings.TrimSpace(m.ModelID) == "" {
			continue
		}
		models = append(models, ModelInfo{
			ID:   m.ModelID,
			Name: m.Name,
		})
	}
	c.mu.Lock()
	c.cachedModels = models
	c.mu.Unlock()
}

func (c *Client) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id, ch, err := c.sendRequest(method, params)
	if err != nil {
		return nil, err
	}
	defer c.deletePending(id)

	select {
	case resp := <-ch:
		return resp.result, resp.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *Client) sendRequest(method string, params any) (int64, chan rpcResponse, error) {
	c.mu.Lock()
	if c.closed || c.proc == nil {
		c.mu.Unlock()
		return 0, nil, ErrProcessUnavailable
	}
	c.nextID++
	id := c.nextID
	ch := make(chan rpcResponse, 1)
	c.pending[id] = ch
	stdin := c.proc.stdin
	c.mu.Unlock()

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
		"params":  params,
	}
	if err := c.writeJSONLine(stdin, payload); err != nil {
		c.deletePending(id)
		return 0, nil, fmt.Errorf("%w: write %s: %v", ErrProcessUnavailable, method, err)
	}
	return id, ch, nil
}

func (c *Client) sendNotification(method string, params any) error {
	c.mu.Lock()
	if c.closed || c.proc == nil {
		c.mu.Unlock()
		return ErrProcessUnavailable
	}
	stdin := c.proc.stdin
	c.mu.Unlock()

	payload := map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	}
	return c.writeJSONLine(stdin, payload)
}

func (c *Client) writeJSONLine(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = w.Write(data)
	return err
}

func (c *Client) deletePending(id int64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) registerSessionListener(sid string, ch chan sessionUpdate) {
	c.mu.Lock()
	c.sessionListeners[sid] = ch
	c.mu.Unlock()
}

func (c *Client) unregisterSessionListener(sid string) {
	c.mu.Lock()
	delete(c.sessionListeners, sid)
	c.mu.Unlock()
}

func (c *Client) readLoop(ps *procState, stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 1024*1024)
	for {
		line, err := reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			c.handleLine(ps, trimmed)
		}
		if err != nil {
			return
		}
	}
}

func (c *Client) waitLoop(ps *procState) {
	waitErr := ps.cmd.Wait()
	stderrText := ps.stderr.String()

	failErr := ErrProcessUnavailable
	if waitErr != nil {
		failErr = mapAuthOrProcessErr(waitErr, stderrText)
	} else if stderrText != "" && looksLikeAuthError(stderrText) {
		failErr = fmt.Errorf("%w: %s", ErrAuthRequired, stderrText)
	}

	c.mu.Lock()
	if c.proc == ps {
		c.proc = nil
		c.initialized = false
		c.lastError = failErr.Error()
		for id, ch := range c.pending {
			ch <- rpcResponse{err: failErr}
			delete(c.pending, id)
		}
	}
	c.mu.Unlock()

	close(ps.done)
}

func (c *Client) stopProc(ps *procState) {
	if ps == nil {
		return
	}
	if ps.stdin != nil {
		_ = ps.stdin.Close()
	}
	ps.cancel()
}

func (c *Client) handleLine(ps *procState, line []byte) {
	var env rpcEnvelope
	if err := json.Unmarshal(line, &env); err != nil {
		return
	}

	// Server-initiated JSON-RPC request (e.g. session/request_permission).
	if env.Method != "" && len(env.ID) > 0 && string(env.ID) != "null" {
		if env.Method == "session/request_permission" {
			go c.rejectPermission(ps, env.ID, env.Params)
		}
		return
	}

	// Server notification.
	if env.Method == "session/update" && len(env.Params) > 0 {
		var p sessionUpdateParams
		if err := json.Unmarshal(env.Params, &p); err != nil {
			return
		}
		if p.Update.SessionUpdate != "agent_message_chunk" || p.Update.Content.Type != "text" {
			return
		}
		c.mu.Lock()
		ch := c.sessionListeners[p.SessionID]
		c.mu.Unlock()
		if ch != nil {
			select {
			case ch <- sessionUpdate{kind: p.Update.SessionUpdate, text: p.Update.Content.Text}:
			default:
			}
		}
		return
	}

	// JSON-RPC response to a pending request.
	if len(env.ID) > 0 && string(env.ID) != "null" {
		var id int64
		if err := json.Unmarshal(env.ID, &id); err != nil {
			return
		}
		c.mu.Lock()
		ch := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if ch != nil {
			if env.Error != nil {
				ch <- rpcResponse{err: mapAuthOrRPCError(env.Error, ps.stderr.String())}
			} else {
				ch <- rpcResponse{result: env.Result}
			}
		}
	}
}

func (c *Client) rejectPermission(ps *procState, reqID json.RawMessage, rawParams json.RawMessage) {
	var p requestPermissionParams
	_ = json.Unmarshal(rawParams, &p)

	selectedID := ""
	for _, opt := range p.Options {
		if opt.Kind == "reject_once" {
			selectedID = opt.OptionID
			break
		}
	}
	if selectedID == "" {
		for _, opt := range p.Options {
			if opt.Kind == "reject_always" {
				selectedID = opt.OptionID
				break
			}
		}
	}

	var outcome map[string]any
	if selectedID != "" {
		outcome = map[string]any{
			"outcome":  "selected",
			"optionId": selectedID,
		}
	} else {
		outcome = map[string]any{
			"outcome": "cancelled",
		}
	}

	reply := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(reqID),
		"result": map[string]any{
			"outcome": outcome,
		},
	}
	_ = c.writeJSONLine(ps.stdin, reply)
}

func (c *Client) setLastError(msg string) {
	c.mu.Lock()
	c.lastError = msg
	c.mu.Unlock()
}

func resolveAgyBin(explicit string) (string, error) {
	if p := strings.TrimSpace(explicit); p != "" {
		return p, nil
	}
	if p := strings.TrimSpace(os.Getenv("AGY_BIN")); p != "" {
		return p, nil
	}
	if p, err := exec.LookPath("agy"); err == nil && p != "" {
		return p, nil
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidate := filepath.Join(home, ".local", "bin", "agy")
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%w: agy binary not found", ErrProcessUnavailable)
}

func resolveModelAndEffort(requestedModel string, sess sessionNewResult) (targetModel string, derivedEffort string) {
	if requestedModel == "" {
		return "", ""
	}
	if hasModel(sess, requestedModel) {
		return requestedModel, ""
	}
	for _, suffix := range []string{"-xhigh", "-high", "-medium", "-low"} {
		if strings.HasSuffix(requestedModel, suffix) {
			base := strings.TrimSuffix(requestedModel, suffix)
			if base != "" && hasModel(sess, base) {
				return base, strings.TrimPrefix(suffix, "-")
			}
		}
	}
	return requestedModel, ""
}

func hasModel(sess sessionNewResult, modelID string) bool {
	for _, opt := range sess.ConfigOptions {
		if opt.ID == "model" {
			for _, v := range opt.Options {
				if v.Value == modelID {
					return true
				}
			}
		}
	}
	for _, m := range sess.Models.AvailableModels {
		if m.ModelID == modelID {
			return true
		}
	}
	return false
}

func supportsThoughtLevel(options []configOption, effort string) bool {
	for _, opt := range options {
		if opt.ID == "thought_level" {
			for _, v := range opt.Options {
				if v.Value == effort {
					return true
				}
			}
		}
	}
	return false
}

func formatPrompt(messages []ChatMessage, format string) string {
	var sb strings.Builder
	for i, msg := range messages {
		if i > 0 {
			sb.WriteString("\n\n")
		}
		role := strings.ToLower(strings.TrimSpace(msg.Role))
		switch role {
		case "system":
			sb.WriteString("[System]\n")
		case "assistant":
			sb.WriteString("[Assistant]\n")
		default:
			sb.WriteString("[User]\n")
		}
		sb.WriteString(msg.Content)
	}
	if strings.EqualFold(strings.TrimSpace(format), "json") {
		sb.WriteString("\n\nIMPORTANT: Output valid JSON only. Do not include markdown fences or extra text, and do not call any tools.")
	}
	return sb.String()
}

func looksLikeAuthError(s string) bool {
	lower := strings.ToLower(s)
	return strings.Contains(lower, "auth") ||
		strings.Contains(lower, "login") ||
		strings.Contains(lower, "not logged in") ||
		strings.Contains(lower, "unauthorized") ||
		strings.Contains(lower, "unauthenticated") ||
		strings.Contains(lower, "credentials")
}

func mapAuthOrProcessErr(err error, stderrText string) error {
	if err == nil {
		return nil
	}
	if looksLikeAuthError(err.Error()) || looksLikeAuthError(stderrText) {
		msg := err.Error()
		if stderrText != "" {
			msg = stderrText
		}
		return fmt.Errorf("%w: %s", ErrAuthRequired, msg)
	}
	if errors.Is(err, ErrProcessUnavailable) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if stderrText != "" {
		return fmt.Errorf("%w: %v (%s)", ErrProcessUnavailable, err, stderrText)
	}
	return fmt.Errorf("%w: %v", ErrProcessUnavailable, err)
}

func mapAuthOrRPCError(rpcErr *rpcErrorPayload, stderrText string) error {
	if rpcErr == nil {
		return nil
	}
	if looksLikeAuthError(rpcErr.Message) || looksLikeAuthError(stderrText) {
		return fmt.Errorf("%w: %s", ErrAuthRequired, rpcErr.Message)
	}
	return rpcErr
}
