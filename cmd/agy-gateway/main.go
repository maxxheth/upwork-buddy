package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/joho/godotenv/autoload"

	"upwork-buddy/internal/agyacp"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	host := envOrDefault("AGY_GATEWAY_HOST", "127.0.0.1")
	port := envIntOrDefault("AGY_GATEWAY_PORT", 11435)
	model := envOrDefault("AGY_MODEL", "gemini-pro-orchestrator-neon")
	effort := envOrDefault("AGY_EFFORT", "medium")
	maxConcurrent := envIntOrDefault("AGY_MAX_CONCURRENT", 2)
	warmOnStart := envBoolOrDefault("AGY_WARM_ON_START", true)
	agyBin := strings.TrimSpace(os.Getenv("AGY_BIN"))

	token, tokenSource, err := agyacp.ResolveOrCreateGatewayToken()
	if err != nil {
		logger.Error("failed to resolve gateway token", "error", err)
		os.Exit(1)
	}

	client := agyacp.NewClient(agyacp.Config{
		AgyBin:        agyBin,
		DefaultModel:  model,
		DefaultEffort: effort,
		MaxConcurrent: maxConcurrent,
	})

	srv := agyacp.NewServer(client, agyacp.ServerConfig{
		Host:          host,
		Port:          port,
		Token:         token,
		DefaultModel:  model,
		DefaultEffort: effort,
		Logger:        logger,
	})

	httpServer := &http.Server{
		Addr:         srv.ListenAddr(),
		Handler:      srv.Handler(),
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}

	rootCtx, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()

	if warmOnStart {
		go func() {
			warmCtx, cancel := context.WithTimeout(rootCtx, 45*time.Second)
			defer cancel()
			logger.Info("warming up agy acp subprocess", "default_model", model, "default_effort", effort)
			if err := client.Warm(warmCtx); err != nil {
				logger.Warn("agy acp warm-up failed; will retry lazily on request", "error", err)
				return
			}
			logger.Info("agy acp warm-up complete")
		}()
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("starting agy-gateway",
			"addr", httpServer.Addr,
			"token_source", tokenSource,
			"default_model", model,
			"default_effort", effort,
			"max_concurrent", maxConcurrent,
		)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	select {
	case <-rootCtx.Done():
		logger.Info("shutdown signal received")
	case err := <-errCh:
		if err != nil {
			logger.Error("http server error", "error", err)
			_ = client.Close()
			os.Exit(1)
		}
		return
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http server shutdown error", "error", err)
	}
	if err := client.Close(); err != nil {
		logger.Warn("acp client close error", "error", err)
	}
	logger.Info("agy-gateway stopped")
}

func envOrDefault(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envIntOrDefault(key string, def int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func envBoolOrDefault(key string, def bool) bool {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def
	}
	b, err := strconv.ParseBool(raw)
	if err != nil {
		return def
	}
	return b
}
