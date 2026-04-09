package server

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	_ "github.com/joho/godotenv/autoload"

	"upwork-buddy/internal/database/service"
)

type Server struct {
	port               int
	env                string
	corsAllowedOrigins string
	templatesPath      string
	generatedAgents   sync.Map

	db service.DatabaseService
}

func NewServer() *http.Server {
	port, _ := strconv.Atoi(os.Getenv("APP_PORT"))
	if port == 0 {
		port, _ = strconv.Atoi(os.Getenv("PORT"))
	}
	if port == 0 {
		port = 9090
	}

	env := os.Getenv("APP_ENV")
	if env == "" {
		env = "development"
	}

	corsAllowedOrigins := os.Getenv("CORS_ALLOWED_ORIGINS")
	if corsAllowedOrigins == "" {
		if env == "production" {
			corsAllowedOrigins = "" // Restrictive in production — must be explicitly set
		} else {
			corsAllowedOrigins = "*" // Permissive in development
		}
	}

	templatesPath := os.Getenv("TEMPLATES_PATH")
	if templatesPath == "" {
		templatesPath = "templates.yaml"
	}

	NewServer := &Server{
		port:               port,
		env:                env,
		corsAllowedOrigins: corsAllowedOrigins,
		templatesPath:      templatesPath,

		db: service.New(),
	}

	log.Printf("🚀 Server configured: port=%d, env=%s, cors_allowed_origins=%q", port, env, corsAllowedOrigins)

	// WriteTimeout must accommodate Ollama analysis calls (up to 90s).
	// ReadTimeout is generous for large job descriptions but still bounded.
	server := &http.Server{
		Addr:         fmt.Sprintf(":%d", NewServer.port),
		Handler:      NewServer.RegisterRoutes(),
		IdleTimeout:  2 * time.Minute,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 2 * time.Minute,
	}

	return server
}
