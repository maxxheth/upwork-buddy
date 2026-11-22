package webui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

func assertSecurityHeaders(t *testing.T, h http.Header) {
	t.Helper()
	if got := h.Get("Content-Security-Policy"); got != DashboardCSP {
		t.Fatalf("Content-Security-Policy = %q, want %q", got, DashboardCSP)
	}
	if got := h.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := h.Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
}

func TestEmbeddedWebUIHandler(t *testing.T) {
	h := Handler()

	// GET / and GET /index.html serve embedded HTML with no-store & security headers
	for _, target := range []string{"/", "/index.html"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)

		res := w.Result()
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()

		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", target, res.StatusCode)
		}
		assertSecurityHeaders(t, res.Header)
		if got := res.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("GET %s Cache-Control = %q, want no-store", target, got)
		}
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("GET %s Content-Type = %q, want text/html", target, ct)
		}
		html := string(body)
		lowerHTML := strings.ToLower(html)
		if !strings.Contains(html, "Upwork Buddy") || strings.Contains(lowerHTML, "onclick=") {
			t.Fatalf("GET %s unexpected HTML body: %s", target, html)
		}
		for _, segment := range strings.Split(lowerHTML, "<script")[1:] {
			tagEnd := strings.Index(segment, ">")
			if tagEnd < 0 {
				t.Fatalf("GET %s malformed script tag in HTML: %s", target, html)
			}
			tagAttrs := segment[:tagEnd]
			if !strings.Contains(tagAttrs, `src="/dashboard/assets/`) || strings.Contains(tagAttrs, "http://") || strings.Contains(tagAttrs, "https://") || strings.Contains(tagAttrs, `src="//`) {
				t.Fatalf("GET %s disallowed script tag (must be /dashboard/assets/ module): <script%s>", target, tagAttrs)
			}
		}
	}

	// HEAD / returns 200 with empty body and security headers
	headW := httptest.NewRecorder()
	h.ServeHTTP(headW, httptest.NewRequest(http.MethodHead, "/", nil))
	if headW.Result().StatusCode != http.StatusOK {
		t.Fatalf("HEAD / status = %d, want 200", headW.Result().StatusCode)
	}
	assertSecurityHeaders(t, headW.Result().Header)
	if headW.Body.Len() != 0 {
		t.Fatalf("HEAD / expected empty body, got %d bytes", headW.Body.Len())
	}

	// Non-GET/HEAD -> 405 with Allow header and security headers
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, "/", nil))
		if w.Result().StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s / status = %d, want 405", method, w.Result().StatusCode)
		}
		if allow := w.Result().Header.Get("Allow"); allow != "GET, HEAD" {
			t.Fatalf("%s / Allow = %q, want GET, HEAD", method, allow)
		}
		assertSecurityHeaders(t, w.Result().Header)
	}

	// Missing files under assets/ or paths with extensions -> 404
	for _, missing := range []string{"/assets", "/assets/missing.js", "/assets/missing.css", "/favicon.ico", "/app.js"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, missing, nil))
		if w.Result().StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", missing, w.Result().StatusCode)
		}
		assertSecurityHeaders(t, w.Result().Header)
	}

	// Extensionless SPA subpath -> 200 index.html
	spaW := httptest.NewRecorder()
	h.ServeHTTP(spaW, httptest.NewRequest(http.MethodGet, "/runs/42", nil))
	if spaW.Result().StatusCode != http.StatusOK {
		t.Fatalf("GET /runs/42 status = %d, want 200", spaW.Result().StatusCode)
	}
	assertSecurityHeaders(t, spaW.Result().Header)
	if got := spaW.Result().Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("GET /runs/42 Cache-Control = %q, want no-store", got)
	}
}

func TestWebUIHandler_ImmutableAssetsAndDirectoryHandling(t *testing.T) {
	mockFS := fstest.MapFS{
		"index.html": {
			Data: []byte("<!doctype html><html><body>SPA</body></html>"),
		},
		"assets/app-abc123.js": {
			Data: []byte("console.log('ok');"),
		},
		"assets/styles-abc123.css": {
			Data: []byte("body { color: #111; }"),
		},
	}

	h := newHandler(mockFS)

	for _, assetPath := range []string{"/assets/app-abc123.js", "/assets/styles-abc123.css"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, assetPath, nil))
		res := w.Result()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", assetPath, res.StatusCode)
		}
		assertSecurityHeaders(t, res.Header)
		if got := res.Header.Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Fatalf("GET %s Cache-Control = %q, want immutable", assetPath, got)
		}
	}

	// Existing /assets directory returns 404 instead of directory listing or index.html
	wDir := httptest.NewRecorder()
	h.ServeHTTP(wDir, httptest.NewRequest(http.MethodGet, "/assets", nil))
	if wDir.Result().StatusCode != http.StatusNotFound {
		t.Fatalf("GET /assets status = %d, want 404", wDir.Result().StatusCode)
	}
}

func TestWebUIHandler_PathTraversalRejectionAndDoubleDotFilenames(t *testing.T) {
	h := Handler()

	traversalTargets := []string{
		"/../etc/passwd",
		"/sub/../etc/passwd",
		"/%2e%2e/etc/passwd",
		"/%2E%2E/etc/passwd",
		"/..%2fetc%2fpasswd",
		"/sub/..%2fetc/passwd",
		"/..%5cetc%5cpasswd",
		"/..\\etc\\passwd",
		"/..",
		"/sub/..",
	}
	for _, target := range traversalTargets {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, target, nil))
		res := w.Result()
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", target, res.StatusCode)
		}
		assertSecurityHeaders(t, res.Header)
	}

	// Also verify raw unparsed percent-encoded segments in url.URL.Path / RawPath.
	for _, rawURL := range []*url.URL{
		{Path: "/%2e%2e/etc/passwd"},
		{Path: "/..%2fetc%2fpasswd"},
		{Path: "/dashboard/..%2fetc%2fpasswd", RawPath: "/dashboard/..%2fetc%2fpasswd"},
	} {
		req := &http.Request{Method: http.MethodGet, URL: rawURL}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Result().StatusCode != http.StatusNotFound {
			t.Fatalf("GET raw URL %+v status = %d, want 404", rawURL, w.Result().StatusCode)
		}
		assertSecurityHeaders(t, w.Result().Header)
	}

	// Extensionless SPA route containing ".." inside a segment succeeds (200 SPA fallback).
	for _, spaTarget := range []string{"/foo..bar/view", "/runs/1..2/details"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, spaTarget, nil))
		res := w.Result()
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200 SPA fallback", spaTarget, res.StatusCode)
		}
		assertSecurityHeaders(t, res.Header)
		if got := res.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("GET %s Cache-Control = %q, want no-store", spaTarget, got)
		}
		if !strings.Contains(string(body), "Upwork Buddy") {
			t.Fatalf("GET %s expected index.html body, got %s", spaTarget, string(body))
		}
	}

	// Legitimate files containing ".." inside a filename segment are served when present.
	mockFS := fstest.MapFS{
		"index.html":        {Data: []byte("<!doctype html><html><body>SPA</body></html>")},
		"foo..bar":          {Data: []byte("plain file")},
		"assets/app..1.js":  {Data: []byte("console.log('double-dot');")},
	}
	mh := newHandler(mockFS)

	for _, tc := range []struct {
		path string
		want string
	}{
		{"/foo..bar", "plain file"},
		{"/assets/app..1.js", "console.log('double-dot');"},
	} {
		w := httptest.NewRecorder()
		mh.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		res := w.Result()
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200", tc.path, res.StatusCode)
		}
		if string(body) != tc.want {
			t.Fatalf("GET %s body = %q, want %q", tc.path, string(body), tc.want)
		}
		assertSecurityHeaders(t, res.Header)
	}
}
