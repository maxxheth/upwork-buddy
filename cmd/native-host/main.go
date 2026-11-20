package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	hostVersion    = "2.0.0"
	maxMessageSize = uint32(1 << 20) // 1 MiB Chrome Native Messaging ceiling
	defaultBaseURL = "http://127.0.0.1:9090"
)

// Request represents a Chrome Native Messaging JSON request.
type Request struct {
	ID      json.RawMessage `json:"id,omitempty"`
	Action  string          `json:"action,omitempty"`
	Type    string          `json:"type,omitempty"`
	Command string          `json:"command,omitempty"`
}

func (r Request) normalizedAction() string {
	for _, v := range []string{r.Action, r.Type, r.Command} {
		if trimmed := strings.ToLower(strings.TrimSpace(v)); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// Response represents a Chrome Native Messaging JSON response.
type Response struct {
	ID             json.RawMessage `json:"id,omitempty"`
	OK             bool            `json:"ok"`
	Action         string          `json:"action,omitempty"`
	Pong           bool            `json:"pong,omitempty"`
	Version        string          `json:"version,omitempty"`
	DaemonRunning  bool            `json:"daemon_running,omitempty"`
	AlreadyRunning bool            `json:"already_running,omitempty"`
	Started        bool            `json:"started,omitempty"`
	PID            int             `json:"pid,omitempty"`
	DaemonURL      string          `json:"daemon_url,omitempty"`
	APIURL         string          `json:"api_url,omitempty"`
	Token          string          `json:"token,omitempty"`
	TokenSource    string          `json:"token_source,omitempty"`
	Error          string          `json:"error,omitempty"`
}

// DaemonStarter launches the local upwork-buddy daemon detached and returns its PID.
type DaemonStarter func(ctx context.Context, binPath string) (int, error)

// Host processes Chrome Native Messaging frames without ever writing logs to stdout.
type Host struct {
	BaseURL           string
	TokenPathOverride string
	DaemonBin         string
	HTTPClient        *http.Client
	Log               *log.Logger
	StartDaemon       DaemonStarter
	StartTimeout      time.Duration
	PollInterval      time.Duration
}

func newDefaultHost() *Host {
	baseURL := strings.TrimSpace(os.Getenv("BUDDY_API_URL"))
	if baseURL == "" {
		host := strings.TrimSpace(os.Getenv("APP_HOST"))
		if host == "" {
			host = "127.0.0.1"
		}
		port := strings.TrimSpace(os.Getenv("APP_PORT"))
		if port == "" {
			port = "9090"
		}
		baseURL = fmt.Sprintf("http://%s:%s", host, port)
	}
	return &Host{
		BaseURL:      strings.TrimRight(baseURL, "/"),
		DaemonBin:    strings.TrimSpace(os.Getenv("BUDDY_BIN")),
		HTTPClient:   &http.Client{Timeout: 2 * time.Second},
		Log:          log.New(os.Stderr, "[upwork-buddy-native-host] ", log.LstdFlags),
		StartTimeout: 10 * time.Second,
		PollInterval: 150 * time.Millisecond,
	}
}

// ReadMessage reads one 4-byte little-endian length-prefixed JSON payload from r.
func ReadMessage(r io.Reader, maxBytes uint32) ([]byte, error) {
	if maxBytes == 0 {
		maxBytes = maxMessageSize
	}
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	length := binary.LittleEndian.Uint32(lenBuf[:])
	if length == 0 {
		return nil, errors.New("native message length must be > 0")
	}
	if length > maxBytes {
		return nil, fmt.Errorf("native message length %d exceeds limit %d", length, maxBytes)
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// WriteMessage writes one 4-byte little-endian length-prefixed payload to w.
func WriteMessage(w io.Writer, payload []byte) error {
	if uint32(len(payload)) > maxMessageSize {
		return fmt.Errorf("native response length %d exceeds limit %d", len(payload), maxMessageSize)
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(payload)))
	if _, err := w.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func (h *Host) baseURL() string {
	if h == nil || strings.TrimSpace(h.BaseURL) == "" {
		return defaultBaseURL
	}
	return strings.TrimRight(strings.TrimSpace(h.BaseURL), "/")
}

func (h *Host) httpClient() *http.Client {
	if h != nil && h.HTTPClient != nil {
		return h.HTTPClient
	}
	return &http.Client{Timeout: 2 * time.Second}
}

func (h *Host) logger() *log.Logger {
	if h != nil && h.Log != nil {
		return h.Log
	}
	return log.New(io.Discard, "", 0)
}

func (h *Host) checkHealth(ctx context.Context) bool {
	reqCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, h.baseURL()+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := h.httpClient().Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode == http.StatusOK
}

func (h *Host) resolveTokenPath() (string, error) {
	if h != nil && strings.TrimSpace(h.TokenPathOverride) != "" {
		return strings.TrimSpace(h.TokenPathOverride), nil
	}
	if p := strings.TrimSpace(os.Getenv("BUDDY_TOKEN_PATH")); p != "" {
		return p, nil
	}
	if p := strings.TrimSpace(os.Getenv("TOKEN_PATH")); p != "" {
		return p, nil
	}
	cfgDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(cfgDir) == "" {
		homeDir, hErr := os.UserHomeDir()
		if hErr != nil || strings.TrimSpace(homeDir) == "" {
			return "", fmt.Errorf("cannot resolve config or home directory for token path: %w", err)
		}
		cfgDir = filepath.Join(homeDir, ".config")
	}
	return filepath.Join(cfgDir, "upwork-buddy", "token"), nil
}

func (h *Host) resolveToken() (token string, source string, ok bool) {
	if envTok := strings.TrimSpace(os.Getenv("BUDDY_API_TOKEN")); envTok != "" {
		return envTok, "env:BUDDY_API_TOKEN", true
	}
	tokenPath, err := h.resolveTokenPath()
	if err != nil {
		return "", "", false
	}
	data, readErr := os.ReadFile(tokenPath)
	if readErr != nil {
		return "", "", false
	}
	tok := strings.TrimSpace(string(data))
	if tok == "" {
		return "", "", false
	}
	return tok, tokenPath, true
}

func (h *Host) resolveDaemonBin() (string, error) {
	if h != nil && strings.TrimSpace(h.DaemonBin) != "" {
		return strings.TrimSpace(h.DaemonBin), nil
	}
	if envBin := strings.TrimSpace(os.Getenv("BUDDY_BIN")); envBin != "" {
		return envBin, nil
	}
	if exePath, err := os.Executable(); err == nil {
		sibling := filepath.Join(filepath.Dir(exePath), "upwork-buddy")
		if info, statErr := os.Stat(sibling); statErr == nil && !info.IsDir() {
			return sibling, nil
		}
	}
	if found, err := exec.LookPath("upwork-buddy"); err == nil {
		return found, nil
	}
	return "", errors.New("upwork-buddy binary not found; set BUDDY_BIN or install in PATH")
}

func defaultStartDaemon(_ context.Context, binPath string) (int, error) {
	cmd := exec.Command(binPath, "serve")
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	logFile := (*os.File)(nil)
	if cfgDir, err := os.UserConfigDir(); err == nil && strings.TrimSpace(cfgDir) != "" {
		dir := filepath.Join(cfgDir, "upwork-buddy")
		if mkErr := os.MkdirAll(dir, 0o700); mkErr == nil {
			if f, openErr := os.OpenFile(filepath.Join(dir, "daemon.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); openErr == nil {
				logFile = f
			}
		}
	}
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		defer func() { _ = logFile.Close() }()
	} else if devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0); err == nil {
		cmd.Stdout = devNull
		cmd.Stderr = devNull
		defer func() { _ = devNull.Close() }()
	}

	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	return pid, nil
}

func (h *Host) handleRequest(ctx context.Context, raw []byte) Response {
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return Response{
			OK:    false,
			Error: "invalid_json",
		}
	}

	action := req.normalizedAction()
	switch action {
	case "ping":
		return Response{
			ID:      req.ID,
			OK:      true,
			Action:  "ping",
			Pong:    true,
			Version: hostVersion,
		}

	case "status":
		healthy := h.checkHealth(ctx)
		return Response{
			ID:            req.ID,
			OK:            true,
			Action:        "status",
			DaemonRunning: healthy,
			DaemonURL:     h.baseURL(),
			APIURL:        h.baseURL(),
		}

	case "get_token":
		tok, src, ok := h.resolveToken()
		if !ok {
			return Response{
				ID:     req.ID,
				OK:     false,
				Action: "get_token",
				Error:  "token_not_found",
			}
		}
		return Response{
			ID:          req.ID,
			OK:          true,
			Action:      "get_token",
			Token:       tok,
			TokenSource: src,
			DaemonURL:   h.baseURL(),
			APIURL:      h.baseURL(),
		}

	case "start_daemon":
		if h.checkHealth(ctx) {
			return Response{
				ID:             req.ID,
				OK:             true,
				Action:         "start_daemon",
				DaemonRunning:  true,
				AlreadyRunning: true,
				DaemonURL:      h.baseURL(),
				APIURL:         h.baseURL(),
			}
		}

		binPath, err := h.resolveDaemonBin()
		if err != nil {
			return Response{
				ID:        req.ID,
				OK:        false,
				Action:    "start_daemon",
				DaemonURL: h.baseURL(),
				APIURL:    h.baseURL(),
				Error:     err.Error(),
			}
		}

		starter := h.StartDaemon
		if starter == nil {
			starter = defaultStartDaemon
		}
		pid, err := starter(ctx, binPath)
		if err != nil {
			return Response{
				ID:        req.ID,
				OK:        false,
				Action:    "start_daemon",
				DaemonURL: h.baseURL(),
				APIURL:    h.baseURL(),
				Error:     fmt.Sprintf("failed to start daemon: %v", err),
			}
		}

		startTimeout := h.StartTimeout
		if startTimeout <= 0 {
			startTimeout = 10 * time.Second
		}
		pollInterval := h.PollInterval
		if pollInterval <= 0 {
			pollInterval = 150 * time.Millisecond
		}
		deadline := time.Now().Add(startTimeout)
		for time.Now().Before(deadline) {
			if h.checkHealth(ctx) {
				return Response{
					ID:            req.ID,
					OK:            true,
					Action:        "start_daemon",
					DaemonRunning: true,
					Started:       true,
					PID:           pid,
					DaemonURL:     h.baseURL(),
					APIURL:        h.baseURL(),
				}
			}
			select {
			case <-ctx.Done():
				return Response{
					ID:     req.ID,
					OK:     false,
					Action: "start_daemon",
					PID:    pid,
					Error:  ctx.Err().Error(),
				}
			case <-time.After(pollInterval):
			}
		}

		return Response{
			ID:            req.ID,
			OK:            false,
			Action:        "start_daemon",
			DaemonRunning: false,
			Started:       true,
			PID:           pid,
			DaemonURL:     h.baseURL(),
			APIURL:        h.baseURL(),
			Error:         "daemon started but did not pass /health before timeout",
		}

	default:
		return Response{
			ID:     req.ID,
			OK:     false,
			Action: action,
			Error:  "unsupported_action",
		}
	}
}

// ServeOnce reads a single frame from r, processes it, and writes one frame to w.
func (h *Host) ServeOnce(ctx context.Context, r io.Reader, w io.Writer) error {
	raw, err := ReadMessage(r, maxMessageSize)
	if err != nil {
		return err
	}
	resp := h.handleRequest(ctx, raw)
	out, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	return WriteMessage(w, out)
}

// ServeLoop processes native messaging frames until EOF or fatal stream error.
func (h *Host) ServeLoop(ctx context.Context, r io.Reader, w io.Writer) error {
	for {
		if err := h.ServeOnce(ctx, r, w); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			h.logger().Printf("native messaging loop stopped: %v", err)
			return err
		}
	}
}

func main() {
	host := newDefaultHost()
	if err := host.ServeLoop(context.Background(), os.Stdin, os.Stdout); err != nil {
		host.logger().Printf("fatal error: %v", err)
		os.Exit(1)
	}
}
