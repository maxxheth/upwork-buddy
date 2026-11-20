package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func encodeFrame(t *testing.T, v any) []byte {
	t.Helper()
	payload, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal frame failed: %v", err)
	}
	var buf bytes.Buffer
	if err := WriteMessage(&buf, payload); err != nil {
		t.Fatalf("WriteMessage failed: %v", err)
	}
	return buf.Bytes()
}

func decodeFrame(t *testing.T, r io.Reader) Response {
	t.Helper()
	raw, err := ReadMessage(r, maxMessageSize)
	if err != nil {
		t.Fatalf("ReadMessage failed: %v", err)
	}
	var resp Response
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	return resp
}

func TestFramingRoundTripAndLimits(t *testing.T) {
	var buf bytes.Buffer
	payload := []byte(`{"ok":true,"hello":"world"}`)
	if err := WriteMessage(&buf, payload); err != nil {
		t.Fatalf("WriteMessage failed: %v", err)
	}
	if buf.Len() != 4+len(payload) {
		t.Fatalf("expected %d bytes, got %d", 4+len(payload), buf.Len())
	}
	gotLen := binary.LittleEndian.Uint32(buf.Bytes()[:4])
	if gotLen != uint32(len(payload)) {
		t.Fatalf("expected length prefix %d, got %d", len(payload), gotLen)
	}

	got, err := ReadMessage(&buf, maxMessageSize)
	if err != nil {
		t.Fatalf("ReadMessage failed: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload mismatch: got %q, want %q", got, payload)
	}

	// Clean EOF on empty stream
	if _, eofErr := ReadMessage(bytes.NewReader(nil), maxMessageSize); !errors.Is(eofErr, io.EOF) {
		t.Fatalf("expected io.EOF on empty reader, got %v", eofErr)
	}

	// Reject zero length
	var zeroBuf [4]byte
	if _, zErr := ReadMessage(bytes.NewReader(zeroBuf[:]), maxMessageSize); zErr == nil {
		t.Fatalf("expected error on zero-length frame")
	}

	// Reject oversized read
	var bigBuf [4]byte
	binary.LittleEndian.PutUint32(bigBuf[:], maxMessageSize+1)
	if _, bErr := ReadMessage(bytes.NewReader(bigBuf[:]), maxMessageSize); bErr == nil {
		t.Fatalf("expected error on oversized frame")
	}

	// Reject oversized write
	if wErr := WriteMessage(&bytes.Buffer{}, make([]byte, maxMessageSize+1)); wErr == nil {
		t.Fatalf("expected error on oversized write")
	}
}

func TestHostActions(t *testing.T) {
	t.Run("ping via action or command", func(t *testing.T) {
		h := &Host{Log: log.New(io.Discard, "", 0)}
		in := bytes.NewBuffer(encodeFrame(t, map[string]any{"id": "p1", "action": "ping"}))
		in.Write(encodeFrame(t, map[string]any{"id": "p2", "command": "ping"}))
		var out bytes.Buffer

		if err := h.ServeLoop(context.Background(), in, &out); err != nil {
			t.Fatalf("ServeLoop failed: %v", err)
		}

		r1 := decodeFrame(t, &out)
		if !r1.OK || !r1.Pong || r1.Version != hostVersion {
			t.Fatalf("unexpected ping response 1: %+v", r1)
		}
		r2 := decodeFrame(t, &out)
		if !r2.OK || !r2.Pong || r2.Action != "ping" {
			t.Fatalf("unexpected ping response 2: %+v", r2)
		}
	})

	t.Run("status healthy and down", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/health" {
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte(`{"status":"ok"}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()

		h := &Host{BaseURL: srv.URL, HTTPClient: srv.Client(), Log: log.New(io.Discard, "", 0)}
		in := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "status"}))
		var out bytes.Buffer
		if err := h.ServeOnce(context.Background(), in, &out); err != nil {
			t.Fatalf("ServeOnce failed: %v", err)
		}
		resp := decodeFrame(t, &out)
		if !resp.OK || !resp.DaemonRunning {
			t.Fatalf("expected DaemonRunning=true, got %+v", resp)
		}

		srv.Close()
		in2 := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "status"}))
		var out2 bytes.Buffer
		if err := h.ServeOnce(context.Background(), in2, &out2); err != nil {
			t.Fatalf("ServeOnce down failed: %v", err)
		}
		resp2 := decodeFrame(t, &out2)
		if !resp2.OK || resp2.DaemonRunning {
			t.Fatalf("expected DaemonRunning=false when down, got %+v", resp2)
		}
	})

	t.Run("get_token resolution order", func(t *testing.T) {
		tmpDir := t.TempDir()
		tokFile := filepath.Join(tmpDir, "token")
		if err := os.WriteFile(tokFile, []byte("file-token-123\n"), 0o600); err != nil {
			t.Fatalf("write temp token failed: %v", err)
		}

		t.Setenv("BUDDY_API_TOKEN", "")
		t.Setenv("BUDDY_TOKEN_PATH", tokFile)
		h := &Host{Log: log.New(io.Discard, "", 0)}

		in := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "get_token"}))
		var out bytes.Buffer
		if err := h.ServeOnce(context.Background(), in, &out); err != nil {
			t.Fatalf("ServeOnce failed: %v", err)
		}
		resp := decodeFrame(t, &out)
		if !resp.OK || resp.Token != "file-token-123" || resp.TokenSource != tokFile {
			t.Fatalf("unexpected token response: %+v", resp)
		}

		t.Setenv("BUDDY_API_TOKEN", "env-token-override")
		in2 := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "get_token"}))
		var out2 bytes.Buffer
		if err := h.ServeOnce(context.Background(), in2, &out2); err != nil {
			t.Fatalf("ServeOnce env failed: %v", err)
		}
		resp2 := decodeFrame(t, &out2)
		if !resp2.OK || resp2.Token != "env-token-override" || resp2.TokenSource != "env:BUDDY_API_TOKEN" {
			t.Fatalf("unexpected env token response: %+v", resp2)
		}

		t.Setenv("BUDDY_API_TOKEN", "")
		t.Setenv("BUDDY_TOKEN_PATH", filepath.Join(tmpDir, "missing-token"))
		in3 := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "get_token"}))
		var out3 bytes.Buffer
		if err := h.ServeOnce(context.Background(), in3, &out3); err != nil {
			t.Fatalf("ServeOnce missing failed: %v", err)
		}
		resp3 := decodeFrame(t, &out3)
		if resp3.OK || resp3.Error != "token_not_found" {
			t.Fatalf("expected token_not_found, got %+v", resp3)
		}
	})

	t.Run("start_daemon already running and injected starter", func(t *testing.T) {
		var healthy atomic.Bool
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if healthy.Load() {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusServiceUnavailable)
		}))
		defer srv.Close()

		// Already running
		healthy.Store(true)
		h := &Host{BaseURL: srv.URL, HTTPClient: srv.Client(), Log: log.New(io.Discard, "", 0)}
		in := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "start_daemon"}))
		var out bytes.Buffer
		if err := h.ServeOnce(context.Background(), in, &out); err != nil {
			t.Fatalf("ServeOnce already running failed: %v", err)
		}
		resp := decodeFrame(t, &out)
		if !resp.OK || !resp.AlreadyRunning || !resp.DaemonRunning {
			t.Fatalf("expected AlreadyRunning=true, got %+v", resp)
		}

		// Cold start via injected starter
		healthy.Store(false)
		h2 := &Host{
			BaseURL:      srv.URL,
			DaemonBin:    "/fake/upwork-buddy",
			HTTPClient:   srv.Client(),
			Log:          log.New(io.Discard, "", 0),
			StartTimeout: 2 * time.Second,
			PollInterval: 20 * time.Millisecond,
			StartDaemon: func(_ context.Context, binPath string) (int, error) {
				if binPath != "/fake/upwork-buddy" {
					return 0, errors.New("unexpected binPath")
				}
				healthy.Store(true)
				return 4242, nil
			},
		}
		in2 := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "start_daemon"}))
		var out2 bytes.Buffer
		if err := h2.ServeOnce(context.Background(), in2, &out2); err != nil {
			t.Fatalf("ServeOnce cold start failed: %v", err)
		}
		resp2 := decodeFrame(t, &out2)
		if !resp2.OK || !resp2.Started || !resp2.DaemonRunning || resp2.PID != 4242 {
			t.Fatalf("expected Started=true PID=4242, got %+v", resp2)
		}
	})
}

func TestHost_InvalidJSONUnsupportedActionAndStartTimeout(t *testing.T) {
	h := &Host{Log: log.New(io.Discard, "", 0)}

	// 1. invalid_json
	inBad := bytes.NewBuffer(nil)
	_ = WriteMessage(inBad, []byte(`{not-valid-json`))
	var outBad bytes.Buffer
	if err := h.ServeOnce(context.Background(), inBad, &outBad); err != nil {
		t.Fatalf("ServeOnce invalid_json: %v", err)
	}
	respBad := decodeFrame(t, &outBad)
	if respBad.OK || respBad.Error != "invalid_json" {
		t.Fatalf("expected invalid_json error, got %+v", respBad)
	}

	// 2. unsupported_action
	inUnsup := bytes.NewBuffer(encodeFrame(t, map[string]any{"id": "u1", "action": "drop_db"}))
	var outUnsup bytes.Buffer
	if err := h.ServeOnce(context.Background(), inUnsup, &outUnsup); err != nil {
		t.Fatalf("ServeOnce unsupported_action: %v", err)
	}
	respUnsup := decodeFrame(t, &outUnsup)
	if respUnsup.OK || respUnsup.Error != "unsupported_action" {
		t.Fatalf("expected unsupported_action error, got %+v", respUnsup)
	}

	// 3. start_daemon starter error
	srvDown := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srvDown.Close()

	hErr := &Host{
		BaseURL:    srvDown.URL,
		DaemonBin:  "/fake/upwork-buddy",
		HTTPClient: srvDown.Client(),
		Log:        log.New(io.Discard, "", 0),
		StartDaemon: func(_ context.Context, _ string) (int, error) {
			return 0, errors.New("boom")
		},
	}
	inErr := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "start_daemon"}))
	var outErr bytes.Buffer
	if err := hErr.ServeOnce(context.Background(), inErr, &outErr); err != nil {
		t.Fatalf("ServeOnce starter error: %v", err)
	}
	respErr := decodeFrame(t, &outErr)
	if respErr.OK || respErr.Error == "" {
		t.Fatalf("expected starter error response, got %+v", respErr)
	}

	// 4. start_daemon /health polling timeout
	hTimeout := &Host{
		BaseURL:      srvDown.URL,
		DaemonBin:    "/fake/upwork-buddy",
		HTTPClient:   srvDown.Client(),
		Log:          log.New(io.Discard, "", 0),
		StartTimeout: 60 * time.Millisecond,
		PollInterval: 15 * time.Millisecond,
		StartDaemon: func(_ context.Context, _ string) (int, error) {
			return 9876, nil
		},
	}
	inTimeout := bytes.NewBuffer(encodeFrame(t, map[string]any{"action": "start_daemon"}))
	var outTimeout bytes.Buffer
	if err := hTimeout.ServeOnce(context.Background(), inTimeout, &outTimeout); err != nil {
		t.Fatalf("ServeOnce timeout: %v", err)
	}
	respTimeout := decodeFrame(t, &outTimeout)
	if respTimeout.OK || !respTimeout.Started || respTimeout.DaemonRunning || respTimeout.PID != 9876 || respTimeout.Error == "" {
		t.Fatalf("expected timeout response with Started=true DaemonRunning=false PID=9876, got %+v", respTimeout)
	}
}
