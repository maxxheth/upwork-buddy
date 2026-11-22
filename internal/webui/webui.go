package webui

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

// DashboardCSP defines the strict Content-Security-Policy applied to all /dashboard* responses.
const DashboardCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"

//go:embed all:dist
var distFS embed.FS

// SetSecurityHeaders applies strict CSP and browser hardening headers for the standalone web dashboard.
func SetSecurityHeaders(w http.ResponseWriter) {
	if w == nil {
		return
	}
	h := w.Header()
	h.Set("Content-Security-Policy", DashboardCSP)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
}

func splitPathSegments(p string) []string {
	return strings.FieldsFunc(p, func(r rune) bool {
		return r == '/' || r == '\\'
	})
}

// HasPathTraversal reports whether u contains any ".." path segment in raw,
// escaped, or unescaped path components (including %2e, %2f, and %5c variants)
// without rejecting filenames that merely contain ".." inside a segment.
func HasPathTraversal(u *url.URL) bool {
	if u == nil {
		return false
	}
	candidates := []string{u.Path, u.EscapedPath()}
	if u.RawPath != "" && u.RawPath != candidates[1] {
		candidates = append(candidates, u.RawPath)
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		for _, seg := range splitPathSegments(candidate) {
			if seg == ".." {
				return true
			}
			if unescaped, err := url.PathUnescape(seg); err == nil {
				for _, sub := range splitPathSegments(unescaped) {
					if sub == ".." {
						return true
					}
				}
			}
		}
	}
	return false
}

// Handler returns the HTTP handler serving the embedded standalone web dashboard assets.
// Callers mounting it under /dashboard/ should wrap it with http.StripPrefix("/dashboard/", ...).
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			SetSecurityHeaders(w)
			http.Error(w, "Web UI bundle unavailable", http.StatusInternalServerError)
		})
	}
	return newHandler(sub)
}

func newHandler(sub fs.FS) http.Handler {
	indexBytes, indexErr := fs.ReadFile(sub, "index.html")

	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		if indexErr != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(indexBytes))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SetSecurityHeaders(w)

		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if HasPathTraversal(r.URL) {
			http.NotFound(w, r)
			return
		}

		clean := path.Clean("/" + r.URL.Path)
		rel := strings.TrimPrefix(clean, "/")

		if rel == "" || rel == "." || rel == "index.html" {
			serveIndex(w, r)
			return
		}

		if info, statErr := fs.Stat(sub, rel); statErr == nil {
			if !info.IsDir() {
				if strings.HasPrefix(rel, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else if strings.EqualFold(path.Ext(rel), ".html") {
					w.Header().Set("Cache-Control", "no-store")
				}
				http.ServeFileFS(w, r, sub, rel)
				return
			}
			// Directory path under assets/ must not fall back to SPA index.
			if rel == "assets" || strings.HasPrefix(rel, "assets/") {
				http.NotFound(w, r)
				return
			}
			// Extensionless directory subpath serves index.html (SPA fallback).
			serveIndex(w, r)
			return
		}

		if rel == "assets" || strings.HasPrefix(rel, "assets/") || path.Ext(rel) != "" {
			http.NotFound(w, r)
			return
		}

		serveIndex(w, r)
	})
}
