//go:build e2e

package e2e_test

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// --- Package-level build-once state ---

var (
	buildOnce   sync.Once
	builtBinDir string
	builtBin    string
	buildErr    error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if builtBinDir != "" {
		_ = os.RemoveAll(builtBinDir)
	}
	os.Exit(code)
}

// --- DSN Validation & Env Parsing ---

// ValidateTestDatabaseDSN parses either a Postgres URI (postgres:// or postgresql://)
// or a libpq key=value DSN and rejects empty, malformed, non-Postgres, or :5432
// default dev databases unless allowOverride is true.
func ValidateTestDatabaseDSN(raw string, allowOverride bool) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return errors.New("TEST_DATABASE_URL is empty")
	}

	parsed, err := parsePostgresDSN(trimmed)
	if err != nil {
		return err
	}

	isDefaultDevDB := parsed.dbnameOmitted ||
		parsed.dbname == "upwork_buddy" ||
		parsed.dbname == "postgres" ||
		parsed.dbname == "template0" ||
		parsed.dbname == "template1"

	for _, hp := range parsed.hosts {
		if !allowOverride && hp.port == "5432" && isDefaultDevDB {
			return fmt.Errorf(
				"refusing unsafe TEST_DATABASE_URL targeting host=%q port=%q dbname=%q (omitted=%v); set UPWORK_BUDDY_ALLOW_TEST_DSN=1 only for isolated :5432 test containers",
				hp.host, hp.port, parsed.dbname, parsed.dbnameOmitted,
			)
		}
	}
	return nil
}

// ParseDSNToAppDBEnv extracts APP_DB_{HOST,PORT,USERNAME,PASSWORD,DATABASE}
// from a Postgres URI or libpq key=value DSN so both DATABASE_URL-aware and
// legacy APP_DB_*-aware binaries target the exact same isolated database.
func ParseDSNToAppDBEnv(raw string) (map[string]string, error) {
	parsed, err := parsePostgresDSN(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	host := "localhost"
	port := "5432"
	if len(parsed.hosts) > 0 {
		host = parsed.hosts[0].host
		port = parsed.hosts[0].port
	}
	return map[string]string{
		"APP_DB_HOST":     host,
		"APP_DB_PORT":     port,
		"APP_DB_USERNAME": parsed.user,
		"APP_DB_PASSWORD": parsed.password,
		"APP_DB_DATABASE": parsed.dbname,
	}, nil
}

type dsnHostPort struct {
	host string
	port string
}

type parsedDSN struct {
	hosts         []dsnHostPort
	user          string
	password      string
	dbname        string
	dbnameOmitted bool
}

func parsePostgresDSN(raw string) (*parsedDSN, error) {
	if strings.Contains(raw, "://") {
		u, err := url.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("malformed Postgres URI: %w", err)
		}
		scheme := strings.ToLower(u.Scheme)
		if scheme != "postgres" && scheme != "postgresql" {
			return nil, fmt.Errorf("unsupported DSN scheme %q; expected postgres or postgresql", u.Scheme)
		}

		user := ""
		password := ""
		if u.User != nil {
			user = u.User.Username()
			password, _ = u.User.Password()
		}

		rawDB := strings.TrimPrefix(u.Path, "/")
		dbnameOmitted := rawDB == ""
		dbname := rawDB
		if dbname == "" {
			if user != "" {
				dbname = user
			} else {
				dbname = "postgres"
			}
		}

		rawHost := u.Host
		if rawHost == "" {
			rawHost = u.Query().Get("host")
		}
		var hosts []dsnHostPort
		if rawHost == "" {
			port := u.Query().Get("port")
			if port == "" {
				port = "5432"
			}
			hosts = append(hosts, dsnHostPort{host: "localhost", port: port})
		} else {
			for _, part := range strings.Split(rawHost, ",") {
				part = strings.TrimSpace(part)
				if part == "" {
					continue
				}
				h, p, err := splitHostPortDefault(part, "5432")
				if err != nil {
					return nil, fmt.Errorf("malformed host:port %q in DSN: %w", part, err)
				}
				if h == "" {
					h = "localhost"
				}
				hosts = append(hosts, dsnHostPort{host: strings.ToLower(h), port: p})
			}
		}
		if len(hosts) == 0 {
			hosts = append(hosts, dsnHostPort{host: "localhost", port: "5432"})
		}

		return &parsedDSN{
			hosts:         hosts,
			user:          user,
			password:      password,
			dbname:        dbname,
			dbnameOmitted: dbnameOmitted,
		}, nil
	}

	kv, err := parseLibpqKV(raw)
	if err != nil {
		return nil, err
	}
	recognized := false
	for _, k := range []string{"host", "hostaddr", "port", "dbname", "user", "sslmode"} {
		if _, ok := kv[k]; ok {
			recognized = true
			break
		}
	}
	if !recognized {
		return nil, errors.New("malformed libpq DSN: missing recognized PostgreSQL keywords (host, port, dbname, user, sslmode)")
	}

	host := kv["host"]
	if host == "" {
		host = kv["hostaddr"]
	}
	if host == "" {
		host = "localhost"
	}
	port := kv["port"]
	if port == "" {
		port = "5432"
	}
	user := kv["user"]
	password := kv["password"]
	rawDB, hasDB := kv["dbname"]
	dbnameOmitted := !hasDB || strings.TrimSpace(rawDB) == ""
	dbname := rawDB
	if dbnameOmitted {
		if user != "" {
			dbname = user
		} else {
			dbname = "postgres"
		}
	}

	var hosts []dsnHostPort
	hostParts := strings.Split(host, ",")
	portParts := strings.Split(port, ",")
	for i, h := range hostParts {
		h = strings.TrimSpace(h)
		if h == "" {
			h = "localhost"
		}
		p := portParts[0]
		if i < len(portParts) && strings.TrimSpace(portParts[i]) != "" {
			p = strings.TrimSpace(portParts[i])
		}
		hosts = append(hosts, dsnHostPort{host: strings.ToLower(h), port: p})
	}

	return &parsedDSN{
		hosts:         hosts,
		user:          user,
		password:      password,
		dbname:        dbname,
		dbnameOmitted: dbnameOmitted,
	}, nil
}

func splitHostPortDefault(hp, defPort string) (string, string, error) {
	if strings.HasPrefix(hp, "[") {
		if strings.Contains(hp, "]:") {
			h, p, err := net.SplitHostPort(hp)
			return h, p, err
		}
		return strings.Trim(hp, "[]"), defPort, nil
	}
	if strings.Contains(hp, ":") {
		h, p, err := net.SplitHostPort(hp)
		if err != nil {
			return "", "", err
		}
		if p == "" {
			p = defPort
		}
		return h, p, nil
	}
	return hp, defPort, nil
}

func parseLibpqKV(raw string) (map[string]string, error) {
	out := make(map[string]string)
	i := 0
	n := len(raw)
	for i < n {
		for i < n && (raw[i] == ' ' || raw[i] == '\t' || raw[i] == '\n' || raw[i] == '\r') {
			i++
		}
		if i >= n {
			break
		}
		kStart := i
		for i < n && raw[i] != '=' && raw[i] != ' ' && raw[i] != '\t' {
			i++
		}
		if i >= n || raw[i] != '=' || i == kStart {
			return nil, fmt.Errorf("malformed libpq DSN near byte %d", kStart)
		}
		key := strings.ToLower(raw[kStart:i])
		i++ // skip '='

		var val strings.Builder
		if i < n && raw[i] == '\'' {
			i++ // skip opening quote
			closed := false
			for i < n {
				if raw[i] == '\\' && i+1 < n {
					i++
					val.WriteByte(raw[i])
					i++
					continue
				}
				if raw[i] == '\'' {
					if i+1 < n && raw[i+1] == '\'' {
						val.WriteByte('\'')
						i += 2
						continue
					}
					closed = true
					i++
					break
				}
				val.WriteByte(raw[i])
				i++
			}
			if !closed {
				return nil, fmt.Errorf("unterminated single-quoted value for key %q in libpq DSN", key)
			}
		} else {
			for i < n && raw[i] != ' ' && raw[i] != '\t' && raw[i] != '\n' && raw[i] != '\r' {
				if raw[i] == '\\' && i+1 < n {
					i++
				}
				val.WriteByte(raw[i])
				i++
			}
		}
		out[key] = val.String()
	}
	return out, nil
}

// --- Ephemeral Port, Repo Locator & Binary Builder ---

func allocFreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("allocFreePort listen: %v", err)
	}
	defer ln.Close()
	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		t.Fatalf("unexpected addr %v", ln.Addr())
	}
	return addr.Port
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		goModPath := filepath.Join(dir, "go.mod")
		if data, err := os.ReadFile(goModPath); err == nil {
			if strings.Contains(string(data), "module upwork-buddy") {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("could not locate upwork-buddy repo root containing go.mod")
		}
		dir = parent
	}
}

func ensureBuiltBinary(t *testing.T) string {
	t.Helper()
	buildOnce.Do(func() {
		repoRoot, err := findRepoRoot()
		if err != nil {
			buildErr = err
			return
		}
		dir, err := os.MkdirTemp("", "upwork-buddy-e2e-bin-*")
		if err != nil {
			buildErr = err
			return
		}
		builtBinDir = dir
		binPath := filepath.Join(dir, "upwork-buddy")
		cmd := exec.Command("go", "build", "-o", binPath, "./cmd/api")
		cmd.Dir = repoRoot
		if out, err := cmd.CombinedOutput(); err != nil {
			buildErr = fmt.Errorf("go build ./cmd/api failed: %w\n%s", err, string(out))
			return
		}
		builtBin = binPath
	})
	if buildErr != nil {
		t.Fatalf("ensureBuiltBinary: %v", buildErr)
	}
	return builtBin
}

func randomHexToken(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("crypto/rand failed: %v", err))
	}
	return hex.EncodeToString(b)
}

// --- Thread-Safe Log Buffer ---

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// --- Harness Configuration & Lifecycle ---

type HarnessOptions struct {
	PolicyMode         string
	MaxProposalsPerDay int
	MaxConnectsPerDay  int
	MaxMessagesPerDay  int
	MinJobScore        int
	OmitTokenEnv       bool
	CORSAllowedOrigins string
	TemplatesPath      string
	SelectorsPath      string
	QuietHours         string
	ExtraEnv           []string
	SkipHealthCheck    bool
}

type HarnessOption func(*HarnessOptions)

func WithPolicyMode(mode string) HarnessOption {
	return func(o *HarnessOptions) { o.PolicyMode = mode }
}

func WithCaps(proposals, connects, messages int) HarnessOption {
	return func(o *HarnessOptions) {
		o.MaxProposalsPerDay = proposals
		o.MaxConnectsPerDay = connects
		o.MaxMessagesPerDay = messages
	}
}

func WithMinJobScore(score int) HarnessOption {
	return func(o *HarnessOptions) { o.MinJobScore = score }
}

func WithOmitTokenEnv(omit bool) HarnessOption {
	return func(o *HarnessOptions) { o.OmitTokenEnv = omit }
}

func WithCORSAllowedOrigins(origins string) HarnessOption {
	return func(o *HarnessOptions) { o.CORSAllowedOrigins = origins }
}

func WithSelectorsPath(path string) HarnessOption {
	return func(o *HarnessOptions) { o.SelectorsPath = path }
}

func WithTemplatesPath(path string) HarnessOption {
	return func(o *HarnessOptions) { o.TemplatesPath = path }
}

func WithQuietHours(qh string) HarnessOption {
	return func(o *HarnessOptions) { o.QuietHours = qh }
}

func WithExtraEnv(kv ...string) HarnessOption {
	return func(o *HarnessOptions) { o.ExtraEnv = append(o.ExtraEnv, kv...) }
}

type TestHarness struct {
	t          *testing.T
	opts       HarnessOptions
	BaseURL    string
	WSURL      string
	MCPURL     string
	Token      string
	TokenPath  string
	BinPath    string
	TempDir    string
	HomeDir    string
	WorkDir    string
	RepoRoot   string
	DSN        string
	Port       int
	IsExternal bool

	httpClient *http.Client
	cmd        *exec.Cmd
	logs       *lockedBuffer
	waitDone   chan error
	stopOnce   sync.Once
}

func NewTestHarness(t *testing.T, optFns ...HarnessOption) *TestHarness {
	t.Helper()

	opts := HarnessOptions{
		PolicyMode:         "confirm_in_ui",
		CORSAllowedOrigins: "chrome-extension://test-ext-id,moz-extension://test-ext-id",
	}
	for _, fn := range optFns {
		fn(&opts)
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		t.Fatalf("findRepoRoot: %v", err)
	}

	// Mode 1: External daemon mode
	if extURL := strings.TrimSpace(os.Getenv("UPWORK_BUDDY_E2E_URL")); extURL != "" {
		u, err := url.Parse(extURL)
		if err != nil {
			t.Fatalf("invalid UPWORK_BUDDY_E2E_URL %q: %v", extURL, err)
		}
		host := strings.ToLower(u.Hostname())
		if host != "127.0.0.1" && host != "localhost" && host != "::1" {
			t.Fatalf("UPWORK_BUDDY_E2E_URL must target loopback host, got %q", host)
		}
		token := os.Getenv("UPWORK_BUDDY_E2E_TOKEN")
		if token == "" {
			t.Fatalf("UPWORK_BUDDY_E2E_URL is set without UPWORK_BUDDY_E2E_TOKEN")
		}
		base := strings.TrimRight(extURL, "/")
		wsScheme := "ws"
		if u.Scheme == "https" {
			wsScheme = "wss"
		}
		wsURL := wsScheme + "://" + u.Host + "/ws/extension"

		h := &TestHarness{
			t:          t,
			opts:       opts,
			BaseURL:    base,
			WSURL:      wsURL,
			MCPURL:     base + "/mcp",
			Token:      token,
			RepoRoot:   repoRoot,
			IsExternal: true,
			httpClient: &http.Client{Timeout: 15 * time.Second},
			logs:       &lockedBuffer{},
		}
		if err := h.waitHealthy(5 * time.Second); err != nil {
			t.Fatalf("external daemon at %s unhealthy: %v", base, err)
		}
		return h
	}

	// Mode 2: Managed isolated daemon mode
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; skipping live daemon E2E execution")
	}

	allowOverride := os.Getenv("UPWORK_BUDDY_ALLOW_TEST_DSN") == "1"
	if err := ValidateTestDatabaseDSN(dsn, allowOverride); err != nil {
		t.Fatalf("unsafe TEST_DATABASE_URL: %v", err)
	}

	appDBEnv, err := ParseDSNToAppDBEnv(dsn)
	if err != nil {
		t.Fatalf("ParseDSNToAppDBEnv: %v", err)
	}

	binPath := ensureBuiltBinary(t)
	port := allocFreePort(t)
	rootTmp := t.TempDir()
	homeDir := filepath.Join(rootTmp, "home")
	xdgDir := filepath.Join(homeDir, ".config")
	workDir := filepath.Join(rootTmp, "workdir")
	tokenPath := filepath.Join(rootTmp, "token")
	if err := os.MkdirAll(xdgDir, 0o700); err != nil {
		t.Fatalf("mkdir xdg: %v", err)
	}
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatalf("mkdir workdir: %v", err)
	}

	templatesPath := opts.TemplatesPath
	if templatesPath == "" {
		templatesPath = filepath.Join(repoRoot, "templates.yaml")
	}
	selectorsPath := opts.SelectorsPath
	if selectorsPath == "" {
		candidate := filepath.Join(repoRoot, "configs", "selectors", "upwork.yaml")
		if _, err := os.Stat(candidate); err == nil {
			selectorsPath = candidate
		}
	}

	token := ""
	if !opts.OmitTokenEnv {
		token = randomHexToken(32)
	}

	env := cleanBaseEnv()
	env = append(env,
		"HOME="+homeDir,
		"XDG_CONFIG_HOME="+xdgDir,
		"APP_HOST=127.0.0.1",
		fmt.Sprintf("APP_PORT=%d", port),
		fmt.Sprintf("PORT=%d", port),
		"APP_ENV=test",
		"DATABASE_URL="+dsn,
		"BUDDY_TOKEN_PATH="+tokenPath,
		"TEMPLATES_PATH="+templatesPath,
		"CORS_ALLOWED_ORIGINS="+opts.CORSAllowedOrigins,
		"POLICY_MODE="+opts.PolicyMode,
		"MCP_ENABLED=true",
	)
	if selectorsPath != "" {
		env = append(env, "SELECTORS_PATH="+selectorsPath)
	}
	if token != "" {
		env = append(env, "BUDDY_API_TOKEN="+token)
	}
	if opts.MaxProposalsPerDay > 0 {
		env = append(env, fmt.Sprintf("MAX_PROPOSALS_PER_DAY=%d", opts.MaxProposalsPerDay))
	}
	if opts.MaxConnectsPerDay > 0 {
		env = append(env, fmt.Sprintf("MAX_CONNECTS_PER_DAY=%d", opts.MaxConnectsPerDay))
	}
	if opts.MaxMessagesPerDay > 0 {
		env = append(env, fmt.Sprintf("MAX_MESSAGES_PER_DAY=%d", opts.MaxMessagesPerDay))
	}
	if opts.MinJobScore > 0 {
		env = append(env, fmt.Sprintf("MIN_JOB_SCORE=%d", opts.MinJobScore))
	}
	if opts.QuietHours != "" {
		env = append(env, "QUIET_HOURS="+opts.QuietHours)
	}
	for k, v := range appDBEnv {
		env = append(env, k+"="+v)
	}
	env = append(env, opts.ExtraEnv...)

	logs := &lockedBuffer{}
	cmd := exec.Command(binPath, "serve")
	cmd.Dir = workDir // CRITICAL: blocks godotenv/autoload from reading repo .env
	cmd.Env = env
	cmd.Stdout = logs
	cmd.Stderr = logs

	if err := cmd.Start(); err != nil {
		t.Fatalf("start upwork-buddy serve: %v", err)
	}

	waitDone := make(chan error, 1)
	go func() {
		waitDone <- cmd.Wait()
	}()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	h := &TestHarness{
		t:          t,
		opts:       opts,
		BaseURL:    base,
		WSURL:      fmt.Sprintf("ws://127.0.0.1:%d/ws/extension", port),
		MCPURL:     base + "/mcp",
		Token:      token,
		TokenPath:  tokenPath,
		BinPath:    binPath,
		TempDir:    rootTmp,
		HomeDir:    homeDir,
		WorkDir:    workDir,
		RepoRoot:   repoRoot,
		DSN:        dsn,
		Port:       port,
		httpClient: &http.Client{Timeout: 15 * time.Second},
		cmd:        cmd,
		logs:       logs,
		waitDone:   waitDone,
	}

	t.Cleanup(func() {
		h.Stop()
		if t.Failed() {
			t.Logf("=== Daemon logs (%s) ===\n%s", t.Name(), h.Logs())
		}
	})

	if !opts.SkipHealthCheck {
		if err := h.waitHealthy(15 * time.Second); err != nil {
			t.Fatalf("daemon failed readiness probe: %v\nlogs:\n%s", err, h.Logs())
		}
	}

	if opts.OmitTokenEnv {
		data, err := os.ReadFile(tokenPath)
		if err != nil {
			t.Fatalf("expected daemon to auto-create BUDDY_TOKEN_PATH %s: %v\nlogs:\n%s", tokenPath, err, h.Logs())
		}
		info, err := os.Stat(tokenPath)
		if err != nil {
			t.Fatalf("stat tokenPath: %v", err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("token file %s permissions too open: %o", tokenPath, info.Mode().Perm())
		}
		h.Token = strings.TrimSpace(string(data))
		if h.Token == "" {
			t.Fatalf("auto-created token file %s is empty", tokenPath)
		}
	}

	return h
}

func cleanBaseEnv() []string {
	var env []string
	for _, key := range []string{"PATH", "TMPDIR", "TEMP", "TMP", "GOROOT", "GOPATH", "GOCACHE", "GOMODCACHE", "TZ"} {
		if val, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+val)
		}
	}
	return env
}

func (h *TestHarness) waitHealthy(timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if h.waitDone != nil {
			select {
			case err := <-h.waitDone:
				h.waitDone = nil
				return fmt.Errorf("daemon exited early (%v)", err)
			default:
			}
		}
		resp, err := h.httpClient.Get(h.BaseURL + "/health")
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("timed out after %s waiting for GET %s/health", timeout, h.BaseURL)
}

func (h *TestHarness) Stop() {
	if h.IsExternal || h.cmd == nil || h.cmd.Process == nil {
		return
	}
	h.stopOnce.Do(func() {
		_ = h.cmd.Process.Signal(syscall.SIGTERM)
		if h.waitDone != nil {
			select {
			case <-h.waitDone:
				return
			case <-time.After(5 * time.Second):
				_ = h.cmd.Process.Kill()
				<-h.waitDone
			}
		}
	})
}

func (h *TestHarness) Logs() string {
	if h.logs == nil {
		return ""
	}
	return h.logs.String()
}

// Restart gracefully stops the current managed daemon and starts a new one on a
// fresh ephemeral port against the same TEST_DATABASE_URL.
func (h *TestHarness) Restart(t *testing.T, extraOpts ...HarnessOption) *TestHarness {
	t.Helper()
	if h.IsExternal {
		t.Skip("Restart not supported in external UPWORK_BUDDY_E2E_URL mode")
	}
	h.Stop()
	merged := []HarnessOption{
		WithPolicyMode(h.opts.PolicyMode),
		WithCORSAllowedOrigins(h.opts.CORSAllowedOrigins),
	}
	if h.opts.SelectorsPath != "" {
		merged = append(merged, WithSelectorsPath(h.opts.SelectorsPath))
	}
	if h.opts.TemplatesPath != "" {
		merged = append(merged, WithTemplatesPath(h.opts.TemplatesPath))
	}
	merged = append(merged, extraOpts...)
	return NewTestHarness(t, merged...)
}

// TempSelectorsCopy copies configs/selectors/upwork.yaml into t.TempDir() (or writes
// a spec-compliant fallback YAML if configs/selectors/upwork.yaml does not exist yet)
// so tests can mutate SELECTORS_PATH without ever touching repo files.
func TempSelectorsCopy(t *testing.T, repoRoot string) string {
	t.Helper()
	src := filepath.Join(repoRoot, "configs", "selectors", "upwork.yaml")
	data, err := os.ReadFile(src)
	if err != nil {
		data = []byte(defaultFallbackSelectorsYAML)
	}
	dst := filepath.Join(t.TempDir(), "upwork-selectors.yaml")
	if err := os.WriteFile(dst, data, 0o600); err != nil {
		t.Fatalf("write temp selectors: %v", err)
	}
	return dst
}

const defaultFallbackSelectorsYAML = `version: "1.0"
site: "upwork"
base_url: "https://www.upwork.com"
page_guards:
  not_found_headings:
    - "job not found"
    - "this job is no longer available"
  error_heading_selectors:
    - "h1"
  detail_signal_selectors:
    - "[data-cy='clock-timelog']"
  auth_logged_in_selectors:
    - "[data-test='nav-user-menu']"
  challenge_selectors:
    - "#cf-challenge-running"
views:
  search_listings:
    container_selectors:
      - "article.job-tile"
    fields:
      title:
        selectors: ["a[data-test*='job-tile-title-link']"]
        extract: "rendered_text"
        required: true
      posted:
        selectors: ["[data-test='job-pubilshed-date'] span", "[data-test='job-published-date'] span"]
        extract: "text"
        is_fragile: true
  best_matches:
    container_selectors: ["article.job-tile"]
    fields:
      title:
        selectors: ["a[data-test*='job-tile-title-link']"]
        extract: "rendered_text"
  most_recent:
    container_selectors: ["article.job-tile"]
    fields:
      title:
        selectors: ["a[data-test*='job-tile-title-link']"]
        extract: "rendered_text"
  saved_jobs:
    container_selectors: ["article.job-tile"]
    fields:
      title:
        selectors: ["a[data-test*='job-tile-title-link']"]
        extract: "rendered_text"
  job_detail:
    fields:
      title:
        selectors: ["h1"]
        extract: "text"
  proposal_apply:
    fields:
      cover_letter:
        selectors: ["textarea[aria-label*='Cover Letter']"]
        extract: "value"
  proposals_list:
    container_selectors: ["[data-test='proposal-row']"]
    fields:
      status:
        selectors: ["[data-test='proposal-status']"]
        extract: "text"
  messages_rooms:
    container_selectors: ["[data-test='room-item']"]
    fields:
      room_id:
        selectors: ["a"]
        extract: "attribute"
        attribute: "href"
  messages_thread:
    container_selectors: ["[data-test='message-item']"]
    fields:
      body:
        selectors: [".message-body"]
        extract: "text"
`

// --- HTTP Helpers ---

func (h *TestHarness) HTTPDo(ctx context.Context, method, path string, body any, extraHeaders map[string]string) (*http.Response, []byte, error) {
	headers := map[string]string{
		"Authorization": "Bearer " + h.Token,
	}
	for k, v := range extraHeaders {
		headers[k] = v
	}
	return h.HTTPDoRaw(ctx, method, path, body, headers)
}

func (h *TestHarness) HTTPDoRaw(ctx context.Context, method, path string, body any, headers map[string]string) (*http.Response, []byte, error) {
	var bodyReader io.Reader
	hasContentType := false
	for k := range headers {
		if strings.EqualFold(k, "Content-Type") {
			hasContentType = true
		}
	}
	if body != nil {
		switch v := body.(type) {
		case []byte:
			bodyReader = bytes.NewReader(v)
		case string:
			bodyReader = strings.NewReader(v)
		default:
			encoded, err := json.Marshal(v)
			if err != nil {
				return nil, nil, err
			}
			bodyReader = bytes.NewReader(encoded)
			if !hasContentType {
				if headers == nil {
					headers = map[string]string{}
				}
				headers["Content-Type"] = "application/json"
			}
		}
	}

	target := path
	if !strings.HasPrefix(path, "http://") && !strings.HasPrefix(path, "https://") {
		if !strings.HasPrefix(path, "/") {
			path = "/" + path
		}
		target = h.BaseURL + path
	}

	req, err := http.NewRequestWithContext(ctx, method, target, bodyReader)
	if err != nil {
		return nil, nil, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := h.httpClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	respBytes, err := io.ReadAll(resp.Body)
	return resp, respBytes, err
}

func (h *TestHarness) MustHTTPJSON(t *testing.T, method, path string, reqBody any, expectedStatuses []int, out any) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	resp, data, err := h.HTTPDo(ctx, method, path, reqBody, nil)
	if err != nil {
		t.Fatalf("%s %s failed: %v", method, path, err)
	}
	matched := false
	for _, s := range expectedStatuses {
		if resp.StatusCode == s {
			matched = true
			break
		}
	}
	if !matched {
		t.Fatalf("%s %s status=%d (expected %v), body=%s", method, path, resp.StatusCode, expectedStatuses, string(data))
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			t.Fatalf("%s %s decode JSON failed: %v\nbody=%s", method, path, err, string(data))
		}
	}
	return data
}

func assertStatusIn(t *testing.T, got int, want ...int) {
	t.Helper()
	for _, w := range want {
		if got == w {
			return
		}
	}
	t.Fatalf("unexpected HTTP status %d, expected one of %v", got, want)
}

// --- RFC-6455 Stdlib WebSocket Client ---

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type RPCHandler func(ctx context.Context, method string, params json.RawMessage) (any, *RPCError)

type RPCError struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type wsRPCEnvelope struct {
	JSONRPC   string          `json:"jsonrpc"`
	ID        json.RawMessage `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     json.RawMessage `json:"error,omitempty"`
	TimeoutMS int             `json:"timeout_ms,omitempty"`
}

type WSNotification struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type wsRPCResponse struct {
	result json.RawMessage
	errRaw json.RawMessage
	err    error
}

type WSClient struct {
	conn    net.Conn
	br      *bufio.Reader
	writeMu sync.Mutex

	mu            sync.Mutex
	closed        bool
	closeCode     uint16
	closeReason   string
	closeCh       chan struct{}
	pending       map[string]chan wsRPCResponse
	handlers      map[string]RPCHandler
	fallbackH     RPCHandler
	notifications []WSNotification
	notifyCh      chan struct{}
	pongCh        chan []byte
	nextID        atomic.Int64
}

func DialWS(ctx context.Context, rawURL string, headers http.Header) (*WSClient, *http.Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, nil, err
	}
	httpScheme := "http"
	if u.Scheme == "wss" {
		httpScheme = "https"
	}
	reqURL := *u
	reqURL.Scheme = httpScheme

	host := u.Host
	if !strings.Contains(host, ":") {
		if httpScheme == "https" {
			host += ":443"
		} else {
			host += ":80"
		}
	}

	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, nil, err
	}

	keyBytes := make([]byte, 16)
	if _, err := rand.Read(keyBytes); err != nil {
		conn.Close()
		return nil, nil, err
	}
	secKey := base64.StdEncoding.EncodeToString(keyBytes)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL.String(), nil)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", secKey)
	for k, vals := range headers {
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, nil, err
	}

	br := bufio.NewReaderSize(conn, 64*1024)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		conn.Close()
		return nil, resp, fmt.Errorf("websocket handshake rejected with status %d", resp.StatusCode)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		conn.Close()
		return nil, resp, fmt.Errorf("missing Upgrade: websocket header")
	}
	expectedAccept := computeWSAccept(secKey)
	if resp.Header.Get("Sec-WebSocket-Accept") != expectedAccept {
		conn.Close()
		return nil, resp, fmt.Errorf("invalid Sec-WebSocket-Accept: got %q want %q", resp.Header.Get("Sec-WebSocket-Accept"), expectedAccept)
	}
	_ = conn.SetDeadline(time.Time{})

	c := &WSClient{
		conn:     conn,
		br:       br,
		closeCh:  make(chan struct{}),
		pending:  make(map[string]chan wsRPCResponse),
		handlers: make(map[string]RPCHandler),
		notifyCh: make(chan struct{}, 64),
		pongCh:   make(chan []byte, 16),
	}
	go c.readLoop()
	return c, resp, nil
}

func computeWSAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func (h *TestHarness) DialExtensionWS(t *testing.T, useQueryToken bool, origin string) *WSClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	hdr := make(http.Header)
	if origin != "" {
		hdr.Set("Origin", origin)
	} else {
		hdr.Set("Origin", "chrome-extension://test-ext-id")
	}
	wsURL := h.WSURL
	if useQueryToken {
		wsURL += "?token=" + url.QueryEscape(h.Token)
	} else {
		hdr.Set("Authorization", "Bearer "+h.Token)
	}
	c, _, err := DialWS(ctx, wsURL, hdr)
	if err != nil {
		t.Fatalf("DialExtensionWS(%s) failed: %v", wsURL, err)
	}
	t.Cleanup(func() {
		_ = c.Close(1000, "test cleanup")
	})
	return c
}

func (c *WSClient) OnMethod(method string, fn RPCHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[method] = fn
}

func (c *WSClient) OnFallback(fn RPCHandler) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fallbackH = fn
}

func (c *WSClient) SendText(data []byte) error {
	return c.writeFrame(true, 0x1, data)
}

func (c *WSClient) SendFragmentedText(chunks ...[]byte) error {
	if len(chunks) == 0 {
		return nil
	}
	if len(chunks) == 1 {
		return c.writeFrame(true, 0x1, chunks[0])
	}
	if err := c.writeFrame(false, 0x1, chunks[0]); err != nil {
		return err
	}
	for i := 1; i < len(chunks)-1; i++ {
		if err := c.writeFrame(false, 0x0, chunks[i]); err != nil {
			return err
		}
	}
	return c.writeFrame(true, 0x0, chunks[len(chunks)-1])
}

func (c *WSClient) SendPing(payload []byte) error {
	return c.writeFrame(true, 0x9, payload)
}

func (c *WSClient) WaitPong(ctx context.Context) ([]byte, error) {
	select {
	case p := <-c.pongCh:
		return p, nil
	case <-c.closeCh:
		return nil, io.EOF
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *WSClient) Close(code uint16, reason string) error {
	c.mu.Lock()
	alreadyClosed := c.closed
	c.closed = true
	c.mu.Unlock()
	if alreadyClosed {
		return nil
	}
	payload := make([]byte, 2+len(reason))
	binary.BigEndian.PutUint16(payload[:2], code)
	copy(payload[2:], reason)
	_ = c.writeFrame(true, 0x8, payload)
	err := c.conn.Close()
	c.failAllPending(io.EOF)
	return err
}

func (c *WSClient) Closed() <-chan struct{} {
	return c.closeCh
}

func (c *WSClient) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	idStr := fmt.Sprintf("ws-%d", c.nextID.Add(1))
	idRaw, _ := json.Marshal(idStr)
	ch := make(chan wsRPCResponse, 1)

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, errors.New("websocket closed")
	}
	c.pending[idStr] = ch
	c.mu.Unlock()

	defer func() {
		c.mu.Lock()
		delete(c.pending, idStr)
		c.mu.Unlock()
	}()

	req := map[string]any{
		"jsonrpc": "2.0",
		"id":      json.RawMessage(idRaw),
		"method":  method,
		"params":  params,
	}
	raw, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	if err := c.SendText(raw); err != nil {
		return nil, err
	}

	select {
	case resp := <-ch:
		if resp.err != nil {
			return nil, resp.err
		}
		if len(resp.errRaw) > 0 && string(resp.errRaw) != "null" {
			return nil, fmt.Errorf("rpc error: %s", string(resp.errRaw))
		}
		return resp.result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *WSClient) Notify(method string, params any) error {
	raw, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	return c.SendText(raw)
}

func (c *WSClient) Notifications() []WSNotification {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]WSNotification, len(c.notifications))
	copy(out, c.notifications)
	return out
}

func (c *WSClient) writeFrame(fin bool, opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	n := len(payload)
	headerLen := 2
	switch {
	case n >= 126 && n <= 65535:
		headerLen += 2
	case n > 65535:
		headerLen += 8
	}
	frame := make([]byte, headerLen+4+n)
	b0 := opcode & 0x0f
	if fin {
		b0 |= 0x80
	}
	frame[0] = b0

	idx := 2
	switch {
	case n < 126:
		frame[1] = 0x80 | byte(n)
	case n <= 65535:
		frame[1] = 0x80 | 126
		binary.BigEndian.PutUint16(frame[2:4], uint16(n))
		idx = 4
	default:
		frame[1] = 0x80 | 127
		binary.BigEndian.PutUint64(frame[2:10], uint64(n))
		idx = 10
	}

	mask := frame[idx : idx+4]
	if _, err := rand.Read(mask); err != nil {
		return err
	}
	idx += 4
	for i := 0; i < n; i++ {
		frame[idx+i] = payload[i] ^ mask[i%4]
	}

	_, err := c.conn.Write(frame)
	return err
}

func (c *WSClient) readLoop() {
	defer func() {
		c.mu.Lock()
		c.closed = true
		c.mu.Unlock()
		close(c.closeCh)
		c.failAllPending(io.EOF)
		_ = c.conn.Close()
	}()

	var fragBuf bytes.Buffer
	var fragOpcode byte
	const maxFrameSize = 16 * 1024 * 1024

	for {
		var hdr [2]byte
		if _, err := io.ReadFull(c.br, hdr[:]); err != nil {
			return
		}
		fin := hdr[0]&0x80 != 0
		opcode := hdr[0] & 0x0f
		masked := hdr[1]&0x80 != 0
		length := uint64(hdr[1] & 0x7f)

		switch length {
		case 126:
			var ext [2]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return
			}
			length = uint64(binary.BigEndian.Uint16(ext[:]))
		case 127:
			var ext [8]byte
			if _, err := io.ReadFull(c.br, ext[:]); err != nil {
				return
			}
			length = binary.BigEndian.Uint64(ext[:])
		}
		if length > maxFrameSize {
			return
		}

		var maskKey [4]byte
		if masked {
			if _, err := io.ReadFull(c.br, maskKey[:]); err != nil {
				return
			}
		}
		payload := make([]byte, int(length))
		if length > 0 {
			if _, err := io.ReadFull(c.br, payload); err != nil {
				return
			}
			if masked {
				for i := range payload {
					payload[i] ^= maskKey[i%4]
				}
			}
		}

		// Control frames (can appear interleaved between fragmented data frames)
		switch opcode {
		case 0x8: // Close
			code := uint16(1000)
			reason := ""
			if len(payload) >= 2 {
				code = binary.BigEndian.Uint16(payload[:2])
				reason = string(payload[2:])
			}
			c.mu.Lock()
			wasClosed := c.closed
			c.closeCode = code
			c.closeReason = reason
			c.closed = true
			c.mu.Unlock()
			if !wasClosed {
				ack := make([]byte, 2)
				binary.BigEndian.PutUint16(ack, code)
				_ = c.writeFrame(true, 0x8, ack)
			}
			return
		case 0x9: // Ping -> reply Pong
			_ = c.writeFrame(true, 0xA, payload)
			continue
		case 0xA: // Pong
			select {
			case c.pongCh <- payload:
			default:
			}
			continue
		}

		// Data frames (0x0 continuation, 0x1 text, 0x2 binary)
		if opcode == 0x1 || opcode == 0x2 {
			fragBuf.Reset()
			fragOpcode = opcode
			fragBuf.Write(payload)
			if !fin {
				continue
			}
		} else if opcode == 0x0 {
			if fragOpcode == 0 {
				return
			}
			fragBuf.Write(payload)
			if !fin {
				continue
			}
		} else {
			continue
		}

		msg := append([]byte(nil), fragBuf.Bytes()...)
		fragBuf.Reset()
		fragOpcode = 0
		c.handleDataMessage(msg)
	}
}

func (c *WSClient) handleDataMessage(msg []byte) {
	trimmed := strings.TrimSpace(string(msg))
	if trimmed == "ping" {
		_ = c.SendText([]byte("pong"))
		return
	}
	if trimmed == "pong" {
		select {
		case c.pongCh <- msg:
		default:
		}
		return
	}

	var env wsRPCEnvelope
	if err := json.Unmarshal(msg, &env); err != nil {
		return
	}
	hasID := len(env.ID) > 0 && string(bytes.TrimSpace(env.ID)) != "null"

	// Server-initiated RPC request
	if env.Method != "" && hasID {
		go c.dispatchServerRequest(env)
		return
	}

	// Notification (no id)
	if env.Method != "" && !hasID {
		c.mu.Lock()
		c.notifications = append(c.notifications, WSNotification{
			Method: env.Method,
			Params: env.Params,
		})
		c.mu.Unlock()
		select {
		case c.notifyCh <- struct{}{}:
		default:
		}
		return
	}

	// Response to our client-initiated RPC
	if hasID {
		key := normalizeJSONID(env.ID)
		c.mu.Lock()
		ch := c.pending[key]
		c.mu.Unlock()
		if ch != nil {
			ch <- wsRPCResponse{result: env.Result, errRaw: env.Error}
		}
	}
}

func (c *WSClient) dispatchServerRequest(env wsRPCEnvelope) {
	c.mu.Lock()
	fn := c.handlers[env.Method]
	if fn == nil {
		fn = c.fallbackH
	}
	c.mu.Unlock()

	if fn == nil {
		resp, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      env.ID,
			"error": map[string]any{
				"code":    "NOT_FOUND",
				"message": "unhandled RPC method " + env.Method,
			},
		})
		_ = c.SendText(resp)
		return
	}

	timeout := 25 * time.Second
	if env.TimeoutMS > 0 {
		timeout = time.Duration(env.TimeoutMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	res, rpcErr := fn(ctx, env.Method, env.Params)
	out := map[string]any{
		"jsonrpc": "2.0",
		"id":      env.ID,
	}
	if rpcErr != nil {
		out["error"] = rpcErr
	} else {
		if res == nil {
			res = map[string]any{}
		}
		out["result"] = res
	}
	raw, _ := json.Marshal(out)
	_ = c.SendText(raw)
}

func (c *WSClient) failAllPending(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, ch := range c.pending {
		select {
		case ch <- wsRPCResponse{err: err}:
		default:
		}
		delete(c.pending, k)
	}
}

func normalizeJSONID(raw json.RawMessage) string {
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return strings.TrimSpace(string(raw))
}

// --- Simulated MV3 Chrome Extension Peer ---

type RecordedRPCCall struct {
	Method string
	Params json.RawMessage
	At     time.Time
}

type SimulatedExtension struct {
	WS      *WSClient
	mu      sync.Mutex
	calls   []RecordedRPCCall
	abortCh chan json.RawMessage
	inFlght atomic.Int32
	overlap atomic.Int32
}

func NewSimulatedExtension(t *testing.T, h *TestHarness, useQueryToken bool) *SimulatedExtension {
	t.Helper()
	ws := h.DialExtensionWS(t, useQueryToken, "chrome-extension://test-ext-id")
	ext := &SimulatedExtension{
		WS:      ws,
		abortCh: make(chan json.RawMessage, 16),
	}
	ext.registerDefaults()
	return ext
}

func (e *SimulatedExtension) registerDefaults() {
	wrap := func(method string, handler RPCHandler) RPCHandler {
		return func(ctx context.Context, m string, params json.RawMessage) (any, *RPCError) {
			e.recordCall(method, params)
			return handler(ctx, m, params)
		}
	}

	e.WS.OnMethod("session.status", wrap("session.status", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"connected":         true,
			"upwork_logged_in":  true,
			"active_tabs":       2,
			"automation_tab_id": 101,
			"extension_version": "0.2.0-e2e",
		}, nil
	}))
	e.WS.OnMethod("tabs.list", wrap("tabs.list", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"tabs": []map[string]any{
				{"id": 101, "title": "Search Freelance Jobs - Upwork", "url": "https://www.upwork.com/nx/search/jobs/?q=golang", "active": true, "automation": true},
				{"id": 102, "title": "Messages - Upwork", "url": "https://www.upwork.com/ab/messages/rooms", "active": false, "automation": false},
			},
		}, nil
	}))
	e.WS.OnMethod("selectors.audit", wrap("selectors.audit", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		var req struct {
			View     string `json:"view"`
			ViewType string `json:"view_type"`
			URL      string `json:"url"`
		}
		_ = json.Unmarshal(p, &req)
		vt := req.ViewType
		if vt == "" {
			vt = req.View
		}
		if vt == "" {
			vt = "search_listings"
		}
		return map[string]any{
			"view_type": vt,
			"url":       "https://www.upwork.com/nx/search/jobs/",
			"health_summary": map[string]any{
				"status":      "HEALTHY",
				"total_cards": 10,
				"broken":      0,
				"degraded":    0,
				"fragile":     1,
			},
			"rules": []map[string]any{
				{"field": "title", "status": "HEALTHY", "matched": 10},
				{"field": "posted", "status": "FRAGILE", "matched": 10, "suggestion": "[data-test='job-published-date'] span"},
			},
			"discovered_unmapped": []string{},
			"baseline_diff":       map[string]any{"added": []string{}, "removed": []string{}},
		}, nil
	}))
	e.WS.OnMethod("jobs.search", wrap("jobs.search", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"jobs": []map[string]any{
				{
					"job_title":        "Senior Go & React Engineer",
					"url":              "https://www.upwork.com/jobs/~0219000000001",
					"job_description":  strings.Repeat("Build Go microservices and PostgreSQL APIs with React frontend. ", 10),
					"contract_type":    "Hourly",
					"rate_range":       "$60.00 - $85.00",
					"rate_min":         "60",
					"rate_max":         "85",
					"skills":           "Go, PostgreSQL, React, Docker, Kubernetes",
					"posted_text":      "just now",
					"proposals":        "Less than 5",
					"client_spent":     "$120K+ total",
					"client_hires":     "55 hires",
					"payment_verified": true,
				},
			},
			"pages_scanned":  1,
			"stopped_reason": "completed",
		}, nil
	}))
	e.WS.OnMethod("jobs.enrich", wrap("jobs.enrich", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"job": map[string]any{
				"job_title":         "Senior Go & React Engineer",
				"url":               "https://www.upwork.com/jobs/~0219000000001",
				"job_description":   strings.Repeat("Detailed architecture specs for Go + PostgreSQL + React system. ", 10),
				"contract_type":     "Fixed",
				"budget":            "$2,500",
				"budget_amount":     "2500",
				"skills":            "Go, PostgreSQL, React",
				"posted_text":       "1 hour ago",
				"proposals":         "5 to 10",
				"connects_required": 12,
				"client_spent":      "$120K+ total",
				"client_hires":      "55 hires",
				"client_hire_rate":  82.0,
				"payment_verified":  true,
				"screening_questions": []string{
					"How many years of Go backend experience do you have?",
				},
			},
		}, nil
	}))
	e.WS.OnMethod("proposals.inspect_form", wrap("proposals.inspect_form", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"contract_type":       "fixed",
			"connects_required":   12,
			"screening_questions": []map[string]any{{"id": "q1", "question": "Years of Go?", "required": true}},
		}, nil
	}))
	e.WS.OnMethod("proposals.fill_form", wrap("proposals.fill_form", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"filled":            true,
			"submitted":         false,
			"cover_letter_len":  240,
			"connects_required": 12,
			"snapshot":          map[string]any{"status": "ready_for_review"},
		}, nil
	}))
	e.WS.OnMethod("proposals.submit_form", wrap("proposals.submit_form", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"submitted":        true,
			"confirmation_url": "https://www.upwork.com/nx/proposals/99001122",
			"status":           "submitted",
		}, nil
	}))
	e.WS.OnMethod("proposals.sync_list", wrap("proposals.sync_list", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"proposals": []map[string]any{
				{
					"upwork_job_id": "~0219000000001",
					"status":        "viewed",
					"url":           "https://www.upwork.com/nx/proposals/99001122",
				},
			},
		}, nil
	}))
	e.WS.OnMethod("messages.list_rooms", wrap("messages.list_rooms", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"rooms": []map[string]any{
				{
					"upwork_room_id":       "room_alpha_1",
					"room_id":              "room_alpha_1",
					"client_name":          "Alice Client",
					"company":              "Acme Corp",
					"job_title":            "Senior Go & React Engineer",
					"unread_count":         1,
					"last_message_snippet": "Can you share your availability this week?",
					"last_message_at":      time.Now().UTC().Format(time.RFC3339),
				},
			},
		}, nil
	}))
	e.WS.OnMethod("messages.read_thread", wrap("messages.read_thread", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"room_id":     "room_alpha_1",
			"client_name": "Alice Client",
			"messages": []map[string]any{
				{
					"sender":  "Alice Client",
					"body":    "Can you share your availability this week?",
					"sent_at": time.Now().UTC().Add(-5 * time.Minute).Format(time.RFC3339),
					"status":  "received",
				},
			},
		}, nil
	}))
	e.WS.OnMethod("messages.draft_reply", wrap("messages.draft_reply", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"room_id":   "room_alpha_1",
			"prefilled": true,
			"sent":      false,
		}, nil
	}))
	e.WS.OnMethod("messages.send_reply", wrap("messages.send_reply", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		return map[string]any{
			"room_id":    "room_alpha_1",
			"sent":       true,
			"message_id": "msg-sent-001",
		}, nil
	}))
	e.WS.OnMethod("automation.abort", wrap("automation.abort", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		select {
		case e.abortCh <- p:
		default:
		}
		return map[string]any{"aborted": true}, nil
	}))
}

func (e *SimulatedExtension) OnMethod(method string, fn RPCHandler) {
	e.WS.OnMethod(method, func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		e.recordCall(method, p)
		return fn(ctx, m, p)
	})
}

func (e *SimulatedExtension) TrackConcurrency(method string, delay time.Duration, fn RPCHandler) {
	e.WS.OnMethod(method, func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		cur := e.inFlght.Add(1)
		if cur > 1 {
			e.overlap.Add(1)
		}
		defer e.inFlght.Add(-1)
		e.recordCall(method, p)
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return nil, &RPCError{Code: "TIMEOUT", Message: ctx.Err().Error()}
			}
		}
		return fn(ctx, m, p)
	})
}

func (e *SimulatedExtension) OverlapCount() int32 {
	return e.overlap.Load()
}

func (e *SimulatedExtension) recordCall(method string, params json.RawMessage) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = append(e.calls, RecordedRPCCall{
		Method: method,
		Params: append(json.RawMessage(nil), params...),
		At:     time.Now().UTC(),
	})
}

func (e *SimulatedExtension) Calls() []RecordedRPCCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]RecordedRPCCall, len(e.calls))
	copy(out, e.calls)
	return out
}

func (e *SimulatedExtension) CallsFor(method string) []RecordedRPCCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []RecordedRPCCall
	for _, c := range e.calls {
		if c.Method == method {
			out = append(out, c)
		}
	}
	return out
}

func (e *SimulatedExtension) ResetCalls() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls = nil
}

func (e *SimulatedExtension) EmitProgress(taskID, stage string, completed, total int, msg string) error {
	return e.WS.Notify("task.progress", map[string]any{
		"task_id":   taskID,
		"stage":     stage,
		"completed": completed,
		"total":     total,
		"message":   msg,
	})
}

func (e *SimulatedExtension) AbortChan() <-chan json.RawMessage {
	return e.abortCh
}

// --- Dual-Transport Stdlib MCP Client ---

type MCPTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"inputSchema,omitempty"`
}

type MCPContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type MCPToolResult struct {
	Content           []MCPContent    `json:"content,omitempty"`
	StructuredContent json.RawMessage `json:"structuredContent,omitempty"`
	IsError           bool            `json:"isError,omitempty"`
}

type MCPResource struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

type MCPResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"`
}

type mcpRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    any             `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data,omitempty"`
	} `json:"error,omitempty"`
}

type mcpTransport interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
	Notify(ctx context.Context, method string, params any) error
	SessionID() string
	Close() error
}

type MCPClient struct {
	transport mcpTransport
}

func (h *TestHarness) NewHTTPMCPClient(t *testing.T) *MCPClient {
	t.Helper()
	tr := &httpMCPTransport{
		mcpURL: h.MCPURL,
		token:  h.Token,
		client: &http.Client{Timeout: 30 * time.Second},
	}
	c := &MCPClient{transport: tr}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := c.Initialize(ctx); err != nil {
		t.Fatalf("HTTP MCP Initialize failed: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func (h *TestHarness) NewStdioMCPClient(t *testing.T, extraEnv ...string) *MCPClient {
	t.Helper()
	if h.BinPath == "" {
		h.BinPath = ensureBuiltBinary(t)
	}
	workDir := filepath.Join(t.TempDir(), "mcp-stdio-wd")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatalf("mkdir stdio workdir: %v", err)
	}
	env := cleanBaseEnv()
	env = append(env,
		"HOME="+h.HomeDir,
		"XDG_CONFIG_HOME="+filepath.Join(h.HomeDir, ".config"),
		"APP_HOST=127.0.0.1",
		fmt.Sprintf("APP_PORT=%d", h.Port),
		fmt.Sprintf("PORT=%d", h.Port),
		"UPWORK_BUDDY_URL="+h.BaseURL,
		"BUDDY_API_TOKEN="+h.Token,
		"BUDDY_TOKEN_PATH="+h.TokenPath,
		"TEMPLATES_PATH="+filepath.Join(h.RepoRoot, "templates.yaml"),
		"POLICY_MODE="+h.opts.PolicyMode,
	)
	if h.DSN != "" {
		env = append(env, "DATABASE_URL="+h.DSN)
		if appDBEnv, err := ParseDSNToAppDBEnv(h.DSN); err == nil {
			for k, v := range appDBEnv {
				env = append(env, k+"="+v)
			}
		}
	}
	env = append(env, extraEnv...)

	cmd := exec.Command(h.BinPath, "mcp")
	cmd.Dir = workDir
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("mcp stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("mcp stdout pipe: %v", err)
	}
	stderrLogs := &lockedBuffer{}
	cmd.Stderr = stderrLogs

	if err := cmd.Start(); err != nil {
		t.Fatalf("start upwork-buddy mcp: %v", err)
	}

	tr := &stdioMCPTransport{
		cmd:     cmd,
		stdin:   stdin,
		stderr:  stderrLogs,
		pending: make(map[string]chan mcpRPCResponse),
		done:    make(chan error, 1),
	}
	go tr.readLoop(stdout)
	go func() {
		tr.done <- cmd.Wait()
	}()

	c := &MCPClient{transport: tr}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := c.Initialize(ctx); err != nil {
		_ = c.Close()
		t.Fatalf("Stdio MCP Initialize failed: %v\nstderr:\n%s", err, stderrLogs.String())
	}
	t.Cleanup(func() {
		_ = c.Close()
		if t.Failed() {
			t.Logf("=== Stdio MCP stderr (%s) ===\n%s", t.Name(), stderrLogs.String())
		}
	})
	return c
}

func (c *MCPClient) Initialize(ctx context.Context) error {
	params := map[string]any{
		"protocolVersion": "2025-03-26",
		"capabilities":    map[string]any{},
		"clientInfo": map[string]any{
			"name":    "upwork-buddy-e2e-client",
			"version": "1.0.0",
		},
	}
	if _, err := c.transport.Call(ctx, "initialize", params); err != nil {
		return err
	}
	return c.transport.Notify(ctx, "notifications/initialized", map[string]any{})
}

func (c *MCPClient) SessionID() string {
	return c.transport.SessionID()
}

func (c *MCPClient) Close() error {
	return c.transport.Close()
}

func (c *MCPClient) ListTools(ctx context.Context) ([]MCPTool, error) {
	raw, err := c.transport.Call(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var res struct {
		Tools []MCPTool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.Tools, nil
}

func (c *MCPClient) CallTool(ctx context.Context, name string, args any) (*MCPToolResult, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.transport.Call(ctx, "tools/call", map[string]any{
		"name":      name,
		"arguments": args,
	})
	if err != nil {
		return nil, err
	}
	var res MCPToolResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("decode tools/call result: %w (%s)", err, string(raw))
	}
	return &res, nil
}

func (c *MCPClient) CallToolJSON(ctx context.Context, name string, args any, out any) (*MCPToolResult, error) {
	res, err := c.CallTool(ctx, name, args)
	if err != nil {
		return nil, err
	}
	if res.IsError {
		return res, fmt.Errorf("mcp tool %s returned isError=true: %s", name, res.Text())
	}
	if out != nil {
		payload := res.PayloadBytes()
		if len(payload) == 0 {
			return res, fmt.Errorf("mcp tool %s returned empty payload", name)
		}
		if err := json.Unmarshal(payload, out); err != nil {
			return res, fmt.Errorf("decode mcp tool %s payload: %w\npayload=%s", name, err, string(payload))
		}
	}
	return res, nil
}

func (c *MCPClient) ListResources(ctx context.Context) ([]MCPResource, error) {
	raw, err := c.transport.Call(ctx, "resources/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var res struct {
		Resources []MCPResource `json:"resources"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.Resources, nil
}

func (c *MCPClient) ReadResource(ctx context.Context, uri string) ([]MCPResourceContent, error) {
	raw, err := c.transport.Call(ctx, "resources/read", map[string]any{
		"uri": uri,
	})
	if err != nil {
		return nil, err
	}
	var res struct {
		Contents []MCPResourceContent `json:"contents"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, err
	}
	return res.Contents, nil
}

func (r *MCPToolResult) Text() string {
	if r == nil {
		return ""
	}
	var sb strings.Builder
	for _, c := range r.Content {
		if c.Text != "" {
			if sb.Len() > 0 {
				sb.WriteByte('\n')
			}
			sb.WriteString(c.Text)
		}
	}
	if sb.Len() == 0 && len(r.StructuredContent) > 0 {
		return string(r.StructuredContent)
	}
	return sb.String()
}

func (r *MCPToolResult) PayloadBytes() []byte {
	if r == nil {
		return nil
	}
	if sc := bytes.TrimSpace(r.StructuredContent); len(sc) > 0 && string(sc) != "null" {
		return sc
	}
	for _, c := range r.Content {
		if t := strings.TrimSpace(c.Text); t != "" {
			return []byte(t)
		}
	}
	return nil
}

// --- Streamable HTTP MCP Transport ---

type httpMCPTransport struct {
	mcpURL    string
	token     string
	client    *http.Client
	mu        sync.Mutex
	sessionID string
	nextID    atomic.Int64
}

func (t *httpMCPTransport) SessionID() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.sessionID
}

func (t *httpMCPTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	idNum := t.nextID.Add(1)
	idStr := strconv.FormatInt(idNum, 10)
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      idNum,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.mcpURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+t.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if sid := t.SessionID(); sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}

	resp, err := t.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.mu.Lock()
		t.sessionID = sid
		t.mu.Unlock()
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("MCP HTTP status %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "text/event-stream") {
		rpcResp, err := parseSSEResponse(body, idStr)
		if err != nil {
			return nil, err
		}
		if rpcResp.Error != nil {
			return nil, fmt.Errorf("mcp rpc error (%v): %s", rpcResp.Error.Code, rpcResp.Error.Message)
		}
		return rpcResp.Result, nil
	}

	var rpcResp mcpRPCResponse
	if err := json.Unmarshal(body, &rpcResp); err != nil {
		return nil, fmt.Errorf("decode MCP JSON response: %w (%s)", err, string(body))
	}
	if rpcResp.Error != nil {
		return nil, fmt.Errorf("mcp rpc error (%v): %s", rpcResp.Error.Code, rpcResp.Error.Message)
	}
	return rpcResp.Result, nil
}

func parseSSEResponse(raw []byte, targetID string) (*mcpRPCResponse, error) {
	normalized := strings.ReplaceAll(string(raw), "\r\n", "\n")
	blocks := strings.Split(normalized, "\n\n")
	var lastResp *mcpRPCResponse
	for _, block := range blocks {
		block = strings.TrimSpace(block)
		if block == "" {
			continue
		}
		var dataLines []string
		for _, line := range strings.Split(block, "\n") {
			if strings.HasPrefix(line, "data:") {
				dataLines = append(dataLines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		if len(dataLines) == 0 {
			continue
		}
		dataPayload := strings.Join(dataLines, "\n")
		var resp mcpRPCResponse
		if err := json.Unmarshal([]byte(dataPayload), &resp); err != nil {
			continue
		}
		if len(resp.ID) > 0 && string(bytes.TrimSpace(resp.ID)) != "null" {
			lastResp = &resp
			if normalizeJSONID(resp.ID) == targetID {
				return &resp, nil
			}
		}
	}
	if lastResp != nil {
		return lastResp, nil
	}
	return nil, fmt.Errorf("no matching JSON-RPC response in SSE stream for id=%s (raw=%q)", targetID, string(raw))
}

func (t *httpMCPTransport) Notify(ctx context.Context, method string, params any) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.mcpURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if sid := t.SessionID(); sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("MCP notify %s returned status %d", method, resp.StatusCode)
	}
	return nil
}

func (t *httpMCPTransport) Close() error {
	sid := t.SessionID()
	if sid == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, t.mcpURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+t.token)
	req.Header.Set("Mcp-Session-Id", sid)
	resp, err := t.client.Do(req)
	if err != nil {
		return nil
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return nil
}

// --- Stdio MCP Transport ---

type stdioMCPTransport struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stderr   *lockedBuffer
	writeMu  sync.Mutex
	mu       sync.Mutex
	pending  map[string]chan mcpRPCResponse
	closed   bool
	nextID   atomic.Int64
	done     chan error
	stopOnce sync.Once
}

func (t *stdioMCPTransport) SessionID() string { return "stdio" }

func (t *stdioMCPTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	idNum := t.nextID.Add(1)
	idStr := strconv.FormatInt(idNum, 10)
	ch := make(chan mcpRPCResponse, 1)

	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, errors.New("stdio mcp transport closed")
	}
	t.pending[idStr] = ch
	t.mu.Unlock()

	defer func() {
		t.mu.Lock()
		delete(t.pending, idStr)
		t.mu.Unlock()
	}()

	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      idNum,
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return nil, err
	}
	t.writeMu.Lock()
	_, err = t.stdin.Write(append(payload, '\n'))
	t.writeMu.Unlock()
	if err != nil {
		return nil, err
	}

	select {
	case resp, ok := <-ch:
		if !ok {
			return nil, fmt.Errorf("stdio mcp closed before response for %s\nstderr:\n%s", method, t.stderr.String())
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("mcp rpc error (%v): %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (t *stdioMCPTransport) Notify(ctx context.Context, method string, params any) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	t.writeMu.Lock()
	defer t.writeMu.Unlock()
	_, err = t.stdin.Write(append(payload, '\n'))
	return err
}

func (t *stdioMCPTransport) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 10*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var resp mcpRPCResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			continue
		}
		if len(resp.ID) == 0 || string(bytes.TrimSpace(resp.ID)) == "null" {
			continue
		}
		key := normalizeJSONID(resp.ID)
		t.mu.Lock()
		ch := t.pending[key]
		t.mu.Unlock()
		if ch != nil {
			ch <- resp
		}
	}
	t.mu.Lock()
	t.closed = true
	for k, ch := range t.pending {
		close(ch)
		delete(t.pending, k)
	}
	t.mu.Unlock()
}

func (t *stdioMCPTransport) Close() error {
	t.stopOnce.Do(func() {
		t.writeMu.Lock()
		_ = t.stdin.Close()
		t.writeMu.Unlock()
		select {
		case <-t.done:
		case <-time.After(5 * time.Second):
			if t.cmd.Process != nil {
				_ = t.cmd.Process.Kill()
			}
			<-t.done
		}
	})
	return nil
}

// --- Shared Opaque-Box Assertion & Probe Helpers ---

func assertContainsErrorCode(t *testing.T, err error, res *MCPToolResult, wantCodes ...string) {
	t.Helper()
	var parts []string
	if err != nil {
		parts = append(parts, err.Error())
	}
	if res != nil {
		parts = append(parts, res.Text(), string(res.StructuredContent))
	}
	combined := strings.ToUpper(strings.Join(parts, "\n"))
	if combined == "" {
		t.Fatalf("expected error containing one of %v, got nil/empty", wantCodes)
	}
	for _, code := range wantCodes {
		if strings.Contains(combined, strings.ToUpper(code)) {
			return
		}
	}
	t.Fatalf("expected error/result to contain one of %v, got: %s", wantCodes, combined)
}

func decodeJobsList(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err == nil {
		for _, key := range []string{"jobs", "items", "data"} {
			if arrRaw, ok := obj[key]; ok {
				var items []map[string]any
				if err := json.Unmarshal(arrRaw, &items); err == nil {
					return items
				}
			}
		}
	}
	var arr []map[string]any
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr
	}
	t.Fatalf("could not decode jobs list from %s", string(raw))
	return nil
}

func probeGetFirstOK(t *testing.T, h *TestHarness, paths ...string) (string, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, p := range paths {
		resp, body, err := h.HTTPDo(ctx, http.MethodGet, p, nil, nil)
		if err != nil {
			continue
		}
		if resp.StatusCode == http.StatusOK {
			return p, body
		}
	}
	t.Fatalf("none of GET paths %v returned 200 OK", paths)
	return "", nil
}

func probePostFirstOK(t *testing.T, h *TestHarness, payload any, paths ...string) (string, int, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, p := range paths {
		resp, body, err := h.HTTPDo(ctx, http.MethodPost, p, payload, nil)
		if err != nil {
			continue
		}
		if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
			return p, resp.StatusCode, body
		}
	}
	t.Fatalf("none of POST paths %v existed (all 404/405)", paths)
	return "", 0, nil
}

func extractMapFloat(m map[string]any, keys ...string) (float64, bool) {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			switch n := v.(type) {
			case float64:
				return n, true
			case int:
				return float64(n), true
			case json.Number:
				if f, err := n.Float64(); err == nil {
					return f, true
				}
			}
		}
	}
	return 0, false
}

func extractMapString(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
			if f, ok := v.(float64); ok {
				return strconv.FormatInt(int64(f), 10)
			}
		}
	}
	return ""
}

func seedHotJobViaREST(t *testing.T, h *TestHarness, upworkID string, title string) (int64, map[string]any) {
	t.Helper()
	payload := map[string]any{
		"job_title":        title,
		"job_description":  strings.Repeat("Seeking senior Go, PostgreSQL, Docker, React engineer to build production backend APIs and automated pipelines with clear milestones. ", 5),
		"url":              "https://www.upwork.com/jobs/" + upworkID,
		"contract_type":    "Hourly",
		"rate_range":       "$65.00 - $90.00",
		"rate_min":         "65",
		"rate_max":         "90",
		"experience_level": "Expert",
		"skills":           "Go, PostgreSQL, React, Docker, REST API",
		"posted_text":      "just now",
		"proposals":        "Less than 5",
		"client_spent":     "$150K+ total",
		"client_hires":     "60 hires",
		"client_hire_rate": 85.0,
		"payment_verified": true,
	}
	var out map[string]any
	h.MustHTTPJSON(t, http.MethodPost, "/api/jobs", payload, []int{http.StatusOK, http.StatusCreated}, &out)
	idF, ok := extractMapFloat(out, "id")
	if !ok || idF <= 0 {
		t.Fatalf("expected positive job id from POST /api/jobs, got %v", out)
	}
	return int64(idF), out
}

// =========================================================================
// Unconditional Self-Tests (run even when TEST_DATABASE_URL is unset)
// =========================================================================

func TestHarness_DSNSafetyGuard(t *testing.T) {
	unsafeCases := []struct {
		name string
		dsn  string
	}{
		{"empty", ""},
		{"whitespace", "   "},
		{"mysql_scheme", "mysql://user:pass@localhost:3306/db"},
		{"sqlite_scheme", "sqlite:///tmp/test.db"},
		{"uri_5432_upwork_buddy", "postgres://postgres:password@localhost:5432/upwork_buddy?sslmode=disable"},
		{"uri_default_port_upwork_buddy", "postgresql://postgres:password@127.0.0.1/upwork_buddy"},
		{"uri_5432_postgres", "postgres://postgres:password@127.0.0.1:5432/postgres"},
		{"uri_5432_omitted_db", "postgres://postgres:password@localhost:5432"},
		{"uri_5432_template1", "postgres://postgres@localhost:5432/template1"},
		{"kv_5432_default_db", "host=localhost port=5432 user=postgres"},
		{"kv_5432_upwork_buddy", "host=127.0.0.1 port=5432 user=upwork_buddy dbname=upwork_buddy"},
		{"kv_malformed", "not-a-valid-dsn-string"},
		{"kv_unterminated_quote", "host=localhost dbname='unterminated"},
	}

	for _, tc := range unsafeCases {
		t.Run("reject_"+tc.name, func(t *testing.T) {
			if err := ValidateTestDatabaseDSN(tc.dsn, false); err == nil {
				t.Fatalf("expected DSN %q to be rejected, but got nil error", tc.dsn)
			}
		})
	}

	safeCases := []struct {
		name          string
		dsn           string
		allowOverride bool
		wantHost      string
		wantPort      string
		wantDB        string
	}{
		{
			name:     "isolated_port_5433",
			dsn:      "postgres://postgres:pw@127.0.0.1:5433/upwork_buddy_e2e?sslmode=disable",
			wantHost: "127.0.0.1", wantPort: "5433", wantDB: "upwork_buddy_e2e",
		},
		{
			name:     "5432_custom_test_db",
			dsn:      "postgresql://tester:secret@127.0.0.1:5432/upwork_buddy_e2e_isolated",
			wantHost: "127.0.0.1", wantPort: "5432", wantDB: "upwork_buddy_e2e_isolated",
		},
		{
			name:          "5432_dev_db_with_override",
			dsn:           "postgres://postgres:password@127.0.0.1:5432/upwork_buddy",
			allowOverride: true,
			wantHost:      "127.0.0.1", wantPort: "5432", wantDB: "upwork_buddy",
		},
		{
			name:     "libpq_kv_isolated",
			dsn:      "host=127.0.0.1 port=5544 user=e2e password='p w' dbname=e2e_db sslmode=disable",
			wantHost: "127.0.0.1", wantPort: "5544", wantDB: "e2e_db",
		},
	}

	for _, tc := range safeCases {
		t.Run("accept_"+tc.name, func(t *testing.T) {
			if err := ValidateTestDatabaseDSN(tc.dsn, tc.allowOverride); err != nil {
				t.Fatalf("expected DSN %q (override=%v) to be accepted, got %v", tc.dsn, tc.allowOverride, err)
			}
			envMap, err := ParseDSNToAppDBEnv(tc.dsn)
			if err != nil {
				t.Fatalf("ParseDSNToAppDBEnv(%q): %v", tc.dsn, err)
			}
			if envMap["APP_DB_HOST"] != tc.wantHost || envMap["APP_DB_PORT"] != tc.wantPort || envMap["APP_DB_DATABASE"] != tc.wantDB {
				t.Fatalf("unexpected envMap %v", envMap)
			}
		})
	}
}

func TestHarness_EphemeralPortAllocator(t *testing.T) {
	const count = 5
	ports := make([]int, count)
	var wg sync.WaitGroup
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ports[idx] = allocFreePort(t)
		}(i)
	}
	wg.Wait()

	for i, p := range ports {
		if p <= 0 || p > 65535 {
			t.Fatalf("port[%d]=%d out of valid TCP range", i, p)
		}
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err != nil {
			t.Fatalf("allocated port %d not immediately re-bindable: %v", p, err)
		}
		_ = ln.Close()
	}
}

func TestHarness_TokenFileIsolation(t *testing.T) {
	realHome, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("os.UserHomeDir: %v", err)
	}
	tmpRoot := t.TempDir()
	tokenPath := filepath.Join(tmpRoot, "token")
	if strings.HasPrefix(tokenPath, filepath.Join(realHome, ".config")) {
		t.Fatalf("temp tokenPath %s unexpectedly inside ~/.config", tokenPath)
	}
	tok := randomHexToken(32)
	if err := os.WriteFile(tokenPath, []byte(tok+"\n"), 0o600); err != nil {
		t.Fatalf("write temp token: %v", err)
	}
	info, err := os.Stat(tokenPath)
	if err != nil {
		t.Fatalf("stat temp token: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected 0600 mode, got %o", info.Mode().Perm())
	}
	readBack, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("read temp token: %v", err)
	}
	if strings.TrimSpace(string(readBack)) != tok {
		t.Fatalf("token mismatch")
	}
}

func TestHarness_WebSocketClientSelfTest(t *testing.T) {
	const testToken = "ws-selftest-token"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("token")
		}
		if tok != testToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		key := r.Header.Get("Sec-WebSocket-Key")
		if key == "" {
			http.Error(w, "missing key", http.StatusBadRequest)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			http.Error(w, "no hijack", http.StatusInternalServerError)
			return
		}
		conn, rw, err := hj.Hijack()
		if err != nil {
			return
		}
		defer conn.Close()

		accept := computeWSAccept(key)
		_, _ = fmt.Fprintf(rw, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", accept)
		_ = rw.Flush()

		var wMu sync.Mutex
		sendServerFrame := func(fin bool, opcode byte, payload []byte) error {
			wMu.Lock()
			defer wMu.Unlock()
			n := len(payload)
			var hdr []byte
			b0 := opcode & 0x0f
			if fin {
				b0 |= 0x80
			}
			switch {
			case n < 126:
				hdr = []byte{b0, byte(n)}
			case n <= 65535:
				hdr = make([]byte, 4)
				hdr[0], hdr[1] = b0, 126
				binary.BigEndian.PutUint16(hdr[2:4], uint16(n))
			default:
				hdr = make([]byte, 10)
				hdr[0], hdr[1] = b0, 127
				binary.BigEndian.PutUint64(hdr[2:10], uint64(n))
			}
			if _, err := conn.Write(hdr); err != nil {
				return err
			}
			if n > 0 {
				if _, err := conn.Write(payload); err != nil {
					return err
				}
			}
			return nil
		}

		// Server-initiated RPC request: session.status
		reqBytes, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"id":      "srv-1",
			"method":  "session.status",
			"params":  map[string]any{},
		})
		_ = sendServerFrame(true, 0x1, reqBytes)

		// Fragmented server text notification (tests FIN=0 + continuation 0x0)
		notif, _ := json.Marshal(map[string]any{
			"jsonrpc": "2.0",
			"method":  "task.progress",
			"params":  map[string]any{"task_id": "t1", "stage": "search", "completed": 1, "total": 2},
		})
		mid := len(notif) / 2
		_ = sendServerFrame(false, 0x1, notif[:mid])
		_ = sendServerFrame(true, 0x0, notif[mid:])

		// Read client frames (Pong, RPC response, Echo payloads up to 70KB)
		for {
			var h [2]byte
			if _, err := io.ReadFull(rw, h[:]); err != nil {
				return
			}
			op := h[0] & 0x0f
			masked := h[1]&0x80 != 0
			ln := uint64(h[1] & 0x7f)
			if ln == 126 {
				var ext [2]byte
				if _, err := io.ReadFull(rw, ext[:]); err != nil {
					return
				}
				ln = uint64(binary.BigEndian.Uint16(ext[:]))
			} else if ln == 127 {
				var ext [8]byte
				if _, err := io.ReadFull(rw, ext[:]); err != nil {
					return
				}
				ln = binary.BigEndian.Uint64(ext[:])
			}
			var mask [4]byte
			if masked {
				if _, err := io.ReadFull(rw, mask[:]); err != nil {
					return
				}
			}
			data := make([]byte, int(ln))
			if ln > 0 {
				if _, err := io.ReadFull(rw, data); err != nil {
					return
				}
				if masked {
					for i := range data {
						data[i] ^= mask[i%4]
					}
				}
			}
			switch op {
			case 0x8: // Close
				ack := make([]byte, 2)
				binary.BigEndian.PutUint16(ack, 1000)
				_ = sendServerFrame(true, 0x8, ack)
				return
			case 0x9: // Ping
				_ = sendServerFrame(true, 0xA, data)
			case 0x1:
				var msg map[string]any
				if json.Unmarshal(data, &msg) == nil {
					if m, _ := msg["method"].(string); m == "echo" {
						resp, _ := json.Marshal(map[string]any{
							"jsonrpc": "2.0",
							"id":      msg["id"],
							"result":  msg["params"],
						})
						_ = sendServerFrame(true, 0x1, resp)
					}
				}
			}
		}
	}))
	defer srv.Close()

	wsBase := "ws" + strings.TrimPrefix(srv.URL, "http")

	// 1. Unauthorized rejected
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := DialWS(ctx, wsBase+"?token=bad", nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 on bad token, got resp=%v err=%v", resp, err)
	}

	// 2. Authorized via ?token= with RPC + fragmented notification + 300B & 70KB frames + Ping/Pong
	client, _, err := DialWS(ctx, wsBase+"?token="+testToken, nil)
	if err != nil {
		t.Fatalf("DialWS(?token=) failed: %v", err)
	}
	defer client.Close(1000, "done")

	statusCalled := make(chan struct{}, 1)
	client.OnMethod("session.status", func(ctx context.Context, m string, p json.RawMessage) (any, *RPCError) {
		select {
		case statusCalled <- struct{}{}:
		default:
		}
		return map[string]any{"connected": true}, nil
	})

	select {
	case <-statusCalled:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for server-initiated session.status RPC")
	}

	// Verify fragmented task.progress notification arrived
	deadline := time.Now().Add(3 * time.Second)
	for len(client.Notifications()) == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	notifs := client.Notifications()
	if len(notifs) != 1 || notifs[0].Method != "task.progress" {
		t.Fatalf("expected 1 task.progress notification, got %+v", notifs)
	}

	// Ping/Pong
	if err := client.SendPing([]byte("hb-1")); err != nil {
		t.Fatalf("SendPing: %v", err)
	}
	pong, err := client.WaitPong(ctx)
	if err != nil || string(pong) != "hb-1" {
		t.Fatalf("WaitPong got %q err=%v", string(pong), err)
	}

	// Concurrent 300B (126-len) and 70KB (127-len) RPC calls under -race
	var wg sync.WaitGroup
	for _, size := range []int{300, 70 * 1024} {
		wg.Add(1)
		go func(sz int) {
			defer wg.Done()
			payload := strings.Repeat("A", sz)
			res, err := client.Call(ctx, "echo", map[string]any{"blob": payload})
			if err != nil {
				t.Errorf("echo(%d): %v", sz, err)
				return
			}
			var out struct {
				Blob string `json:"blob"`
			}
			if err := json.Unmarshal(res, &out); err != nil || len(out.Blob) != sz {
				t.Errorf("echo(%d) mismatch len=%d err=%v", sz, len(out.Blob), err)
			}
		}(size)
	}
	wg.Wait()
}

func TestHarness_MCPStreamableHTTPClientSelfTest(t *testing.T) {
	const testToken = "mcp-selftest-token"
	const testSID = "sess-e2e-123"
	var deleted atomic.Bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodDelete {
			if r.Header.Get("Mcp-Session-Id") == testSID {
				deleted.Store(true)
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		w.Header().Set("Mcp-Session-Id", testSID)

		switch req.Method {
		case "initialize":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion": "2025-03-26",
					"capabilities":    map[string]any{"tools": map[string]any{}, "resources": map[string]any{}},
					"serverInfo":      map[string]any{"name": "mock-mcp", "version": "1.0"},
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/list":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"tools": []map[string]any{{"name": "upwork_session_status", "description": "status"}},
				},
			})
		case "tools/call":
			// Return SSE text/event-stream to exercise SSE decoder!
			w.Header().Set("Content-Type", "text/event-stream")
			respJSON, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"content": []map[string]any{{"type": "text", "text": `{"connected":true,"policy_mode":"confirm_in_ui"}`}},
				},
			})
			_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", string(respJSON))
		case "resources/list":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"resources": []map[string]any{{"uri": "upwork://profile", "name": "profile"}},
				},
			})
		case "resources/read":
			w.Header().Set("Content-Type", "text/event-stream")
			respJSON, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"contents": []map[string]any{{"uri": "upwork://profile", "mimeType": "application/json", "text": `{"skills":"Go"}`}},
				},
			})
			_, _ = fmt.Fprintf(w, "event: message\ndata: %s\n\n", string(respJSON))
		}
	}))
	defer srv.Close()

	client := &MCPClient{
		transport: &httpMCPTransport{
			mcpURL: srv.URL,
			token:  testToken,
			client: srv.Client(),
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Initialize(ctx); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	if client.SessionID() != testSID {
		t.Fatalf("expected Mcp-Session-Id %q, got %q", testSID, client.SessionID())
	}
	tools, err := client.ListTools(ctx)
	if err != nil || len(tools) != 1 || tools[0].Name != "upwork_session_status" {
		t.Fatalf("ListTools unexpected: %+v err=%v", tools, err)
	}
	var status struct {
		Connected  bool   `json:"connected"`
		PolicyMode string `json:"policy_mode"`
	}
	if _, err := client.CallToolJSON(ctx, "upwork_session_status", nil, &status); err != nil {
		t.Fatalf("CallToolJSON(SSE): %v", err)
	}
	if !status.Connected || status.PolicyMode != "confirm_in_ui" {
		t.Fatalf("unexpected tool status: %+v", status)
	}
	resources, err := client.ListResources(ctx)
	if err != nil || len(resources) != 1 || resources[0].URI != "upwork://profile" {
		t.Fatalf("ListResources unexpected: %+v err=%v", resources, err)
	}
	contents, err := client.ReadResource(ctx, "upwork://profile")
	if err != nil || len(contents) != 1 || !strings.Contains(contents[0].Text, "Go") {
		t.Fatalf("ReadResource(SSE) unexpected: %+v err=%v", contents, err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !deleted.Load() {
		t.Fatal("expected DELETE /mcp with Mcp-Session-Id on Close")
	}
}

// Keep archive/zip referenced via shared helper for agent zip verification tests.
func readZipEntries(t *testing.T, zipBytes []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		t.Fatalf("invalid zip payload: %v", err)
	}
	out := make(map[string]string, len(zr.File))
	for _, f := range zr.File {
		if _, dup := out[f.Name]; dup {
			t.Fatalf("duplicate zip entry %q", f.Name)
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open zip entry %q: %v", f.Name, err)
		}
		b, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read zip entry %q: %v", f.Name, err)
		}
		out[f.Name] = string(b)
	}
	return out
}
