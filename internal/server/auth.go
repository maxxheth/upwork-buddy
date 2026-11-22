package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// WSAuthStatus represents the authentication state of an incoming WebSocket HTTP upgrade request.
type WSAuthStatus int

const (
	WSAuthMissingCredentials WSAuthStatus = iota
	WSAuthAuthenticated
	WSAuthInvalidCredentials
)

func resolveTokenPath() (string, error) {
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

// ResolveOrCreateAPIToken resolves the daemon Bearer token from BUDDY_API_TOKEN or a
// local 0600 file at BUDDY_TOKEN_PATH / TOKEN_PATH / ~/.config/upwork-buddy/token.
// It never logs the raw token value.
func ResolveOrCreateAPIToken() (token string, source string, err error) {
	return resolveOrCreateAPIToken()
}

// ResolveExistingAPIToken resolves an existing daemon Bearer token from BUDDY_API_TOKEN or
// the configured token file without creating a new token file if missing.
func ResolveExistingAPIToken() (token string, source string, err error) {
	if envTok := strings.TrimSpace(os.Getenv("BUDDY_API_TOKEN")); envTok != "" {
		return envTok, "env:BUDDY_API_TOKEN", nil
	}

	tokenPath, err := resolveTokenPath()
	if err != nil {
		return "", "", err
	}

	data, readErr := os.ReadFile(tokenPath)
	if readErr != nil {
		return "", "", fmt.Errorf("read token file %q: %w", tokenPath, readErr)
	}
	existing := strings.TrimSpace(string(data))
	if existing == "" {
		return "", "", fmt.Errorf("token file %q is empty", tokenPath)
	}
	return existing, tokenPath, nil
}

// resolveOrCreateAPIToken resolves the daemon Bearer token from BUDDY_API_TOKEN or a
// local 0600 file at BUDDY_TOKEN_PATH / TOKEN_PATH / ~/.config/upwork-buddy/token.
// It never logs the raw token value.
func resolveOrCreateAPIToken() (token string, source string, err error) {
	if envTok := strings.TrimSpace(os.Getenv("BUDDY_API_TOKEN")); envTok != "" {
		return envTok, "env:BUDDY_API_TOKEN", nil
	}

	tokenPath, err := resolveTokenPath()
	if err != nil {
		return "", "", err
	}

	info, statErr := os.Stat(tokenPath)
	if statErr == nil {
		data, readErr := os.ReadFile(tokenPath)
		if readErr != nil {
			return "", "", fmt.Errorf("read token file %q: %w", tokenPath, readErr)
		}
		existing := strings.TrimSpace(string(data))
		if existing != "" {
			if info.Mode().Perm()&0o077 != 0 {
				if chmodErr := os.Chmod(tokenPath, 0o600); chmodErr != nil {
					return "", "", fmt.Errorf("tighten token file permissions on %q: %w", tokenPath, chmodErr)
				}
			}
			return existing, tokenPath, nil
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", "", fmt.Errorf("stat token file %q: %w", tokenPath, statErr)
	}

	dir := filepath.Dir(tokenPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", fmt.Errorf("create token directory %q: %w", dir, err)
	}

	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", fmt.Errorf("generate random api token: %w", err)
	}
	generated := hex.EncodeToString(raw[:])

	tmp, err := os.CreateTemp(dir, ".token-*")
	if err != nil {
		return "", "", fmt.Errorf("create temp token file in %q: %w", dir, err)
	}
	tmpName := tmp.Name()
	cleanupTmp := true
	defer func() {
		if cleanupTmp {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return "", "", fmt.Errorf("chmod temp token file: %w", err)
	}
	if _, err := tmp.WriteString(generated + "\n"); err != nil {
		_ = tmp.Close()
		return "", "", fmt.Errorf("write temp token file: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return "", "", fmt.Errorf("sync temp token file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", "", fmt.Errorf("close temp token file: %w", err)
	}
	if err := os.Rename(tmpName, tokenPath); err != nil {
		return "", "", fmt.Errorf("rename token file to %q: %w", tokenPath, err)
	}
	cleanupTmp = false
	if err := os.Chmod(tokenPath, 0o600); err != nil {
		return "", "", fmt.Errorf("chmod token file %q: %w", tokenPath, err)
	}

	return generated, tokenPath, nil
}

// ValidateToken verifies provided against the configured daemon API token in constant time.
func (s *Server) ValidateToken(provided string) bool {
	if s == nil {
		return false
	}
	expected := strings.TrimSpace(s.apiToken)
	candidate := strings.TrimSpace(provided)
	if expected == "" || candidate == "" {
		return false
	}
	expectedSum := sha256.Sum256([]byte(expected))
	candidateSum := sha256.Sum256([]byte(candidate))
	return subtle.ConstantTimeCompare(expectedSum[:], candidateSum[:]) == 1
}

// ExtractBearerToken extracts a Bearer token from the Authorization request header.
func ExtractBearerToken(r *http.Request) (string, bool) {
	if r == nil {
		return "", false
	}
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader == "" {
		return "", false
	}
	scheme, rest, ok := strings.Cut(authHeader, " ")
	if !ok || !strings.EqualFold(strings.TrimSpace(scheme), "Bearer") {
		return "", false
	}
	token := strings.TrimSpace(rest)
	if token == "" {
		return "", false
	}
	return token, true
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok, ok := ExtractBearerToken(r)
		if !ok || (!s.ValidateToken(tok) && !s.ValidateWebSessionToken(tok)) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			respondWithError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// AuthenticateWSRequest validates Bearer header or ?token= query parameter on a WebSocket request.
func (s *Server) AuthenticateWSRequest(r *http.Request) WSAuthStatus {
	if tok, ok := ExtractBearerToken(r); ok {
		if s.ValidateToken(tok) {
			return WSAuthAuthenticated
		}
		return WSAuthInvalidCredentials
	}
	if r != nil && r.URL != nil && r.URL.Query().Has("token") {
		qTok := strings.TrimSpace(r.URL.Query().Get("token"))
		if s.ValidateToken(qTok) {
			return WSAuthAuthenticated
		}
		return WSAuthInvalidCredentials
	}
	return WSAuthMissingCredentials
}

type wsAuthFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  struct {
		Token string `json:"token"`
	} `json:"params"`
}

// ValidateWSAuthFrame validates a JSON-RPC 2.0 first-frame auth message from Chrome MV3 clients.
func (s *Server) ValidateWSAuthFrame(raw []byte) (json.RawMessage, bool) {
	var frame wsAuthFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return nil, false
	}
	if frame.JSONRPC != "" && frame.JSONRPC != "2.0" {
		return nil, false
	}
	if frame.Method != "auth" {
		return nil, false
	}
	if !s.ValidateToken(frame.Params.Token) {
		return nil, false
	}
	return frame.ID, true
}
