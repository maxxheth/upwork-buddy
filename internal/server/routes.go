package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

func (s *Server) RegisterRoutes() http.Handler {
	mux := http.NewServeMux()

	// Register routes
	mux.HandleFunc("/", s.HelloWorldHandler)

	mux.HandleFunc("/health", s.healthHandler)

	// Environment-aware health check endpoint
	mux.HandleFunc("/api/health", s.apiHealthHandler)

	// AI Analysis endpoint
	mux.HandleFunc("/api/analyze-job", s.analyzeJobHandler)

	// Profile configuration endpoint for the bookmarklet UI
	mux.HandleFunc("/api/profile", s.profileHandler)

	// Job CRUD endpoints
	mux.HandleFunc("POST /api/jobs", s.saveJobHandler)
	mux.HandleFunc("GET /api/jobs", s.listJobsHandler)
	mux.HandleFunc("DELETE /api/jobs/{id}", s.deleteJobHandler)

	// Template & Agent endpoints
	mux.HandleFunc("GET /api/templates", s.listTemplatesHandler)
	mux.HandleFunc("GET /api/templates/{name}", s.getTemplateHandler)
	mux.HandleFunc("POST /api/agents/generate", s.generateAgentsHandler)
	mux.HandleFunc("GET /api/agents", s.listAgentsHandler)
	mux.HandleFunc("POST /api/agents/download", s.downloadAgentsHandler)

	// Wrap the mux with CORS middleware
	return s.corsMiddleware(mux)
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Use configured CORS allowed origins instead of hardcoded "*"
		allowedOrigins := s.corsAllowedOrigins
		if allowedOrigins == "" {
			// No origins configured — deny cross-origin by default
			w.Header().Set("Access-Control-Allow-Origin", "")
		} else if allowedOrigins == "*" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else {
			// Multiple origins: check if the request origin matches
			origin := r.Header.Get("Origin")
			allowed := false
			for _, o := range strings.Split(allowedOrigins, ",") {
				o = strings.TrimSpace(o)
				if o == origin {
					allowed = true
					break
				}
			}
			if allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH")
		w.Header().Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, X-CSRF-Token")
		w.Header().Set("Access-Control-Allow-Credentials", "false")

		// Handle preflight OPTIONS requests
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Proceed with the next handler
		next.ServeHTTP(w, r)
	})
}

func (s *Server) HelloWorldHandler(w http.ResponseWriter, r *http.Request) {
	resp := map[string]string{"message": "Hello World"}
	jsonResp, err := json.Marshal(resp)
	if err != nil {
		http.Error(w, "Failed to marshal response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(jsonResp); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}

func (s *Server) healthHandler(w http.ResponseWriter, r *http.Request) {
	resp, err := json.Marshal(s.db.Health())
	if err != nil {
		http.Error(w, "Failed to marshal health check response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(resp); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}

// apiHealthHandler returns environment-aware health information for the frontend
func (s *Server) apiHealthHandler(w http.ResponseWriter, r *http.Request) {
	resp := map[string]string{
		"status": "ok",
		"env":    s.env,
	}
	jsonResp, err := json.Marshal(resp)
	if err != nil {
		http.Error(w, "Failed to marshal health response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if _, err := w.Write(jsonResp); err != nil {
		log.Printf("Failed to write response: %v", err)
	}
}
