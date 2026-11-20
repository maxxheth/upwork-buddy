package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestNormalizeDaemonBaseURL(t *testing.T) {
	t.Setenv("APP_HOST", "127.0.0.1")
	t.Setenv("APP_PORT", "9191")

	if got := normalizeDaemonBaseURL(""); got != "http://127.0.0.1:9191" {
		t.Fatalf("empty normalizeDaemonBaseURL = %q, want http://127.0.0.1:9191", got)
	}
	if got := normalizeDaemonBaseURL("http://127.0.0.1:9090/mcp/"); got != "http://127.0.0.1:9090" {
		t.Fatalf("normalizeDaemonBaseURL(/mcp/) = %q, want http://127.0.0.1:9090", got)
	}
	if got := normalizeDaemonBaseURL("  http://127.0.0.1:9090/mcp  "); got != "http://127.0.0.1:9090" {
		t.Fatalf("normalizeDaemonBaseURL(/mcp) = %q, want http://127.0.0.1:9090", got)
	}
}

func TestSanitizeForwardMeta(t *testing.T) {
	if got := sanitizeForwardMeta(nil); got != nil {
		t.Fatalf("expected nil for empty meta, got %+v", got)
	}
	onlyProto := mcp.Meta{
		mcp.MetaKeyProtocolVersion: "2025-03-26",
	}
	if got := sanitizeForwardMeta(onlyProto); got != nil {
		t.Fatalf("expected nil when only protocolVersion present, got %+v", got)
	}

	mixed := mcp.Meta{
		mcp.MetaKeyProtocolVersion: "2025-03-26",
		"progressToken":            "tok-1",
		"custom":                   42,
	}
	got := sanitizeForwardMeta(mixed)
	if len(got) != 2 {
		t.Fatalf("expected 2 preserved keys, got %+v", got)
	}
	if _, hasProto := got[mcp.MetaKeyProtocolVersion]; hasProto {
		t.Fatal("expected MetaKeyProtocolVersion to be stripped")
	}
	if got["progressToken"] != "tok-1" || got["custom"] != 42 {
		t.Fatalf("unexpected sanitized meta: %+v", got)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestBearerRoundTripper(t *testing.T) {
	var seenAuth string
	rt := &bearerRoundTripper{
		token: "test-bearer-xyz",
		base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			seenAuth = r.Header.Get("Authorization")
			return &http.Response{
				StatusCode: http.StatusNotFound,
				Body:       http.NoBody,
			}, nil
		}),
	}

	req, _ := http.NewRequest(http.MethodPost, "http://127.0.0.1:9090/mcp", nil)
	resp, err := rt.RoundTrip(req)
	if err != nil {
		t.Fatalf("RoundTrip error: %v", err)
	}
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if seenAuth != "Bearer test-bearer-xyz" {
		t.Fatalf("expected Authorization Bearer header, got %q", seenAuth)
	}
	if rt.lastStatus.Load() != http.StatusNotFound {
		t.Fatalf("expected lastStatus=404, got %d", rt.lastStatus.Load())
	}
	// Original request must remain unmodified
	if req.Header.Get("Authorization") != "" {
		t.Fatal("RoundTrip mutated original request headers")
	}
}

func TestProbeDaemonHealth(t *testing.T) {
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer okSrv.Close()

	if !probeDaemonHealth(context.Background(), okSrv.URL) {
		t.Fatal("expected probeDaemonHealth=true on 200 OK")
	}

	downSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer downSrv.Close()

	if probeDaemonHealth(context.Background(), downSrv.URL) {
		t.Fatal("expected probeDaemonHealth=false on 503")
	}
	downSrv.Close()

	if probeDaemonHealth(context.Background(), downSrv.URL) {
		t.Fatal("expected probeDaemonHealth=false when unreachable")
	}
}
