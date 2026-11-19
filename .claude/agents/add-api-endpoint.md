---
name: add-api-endpoint
description: Scaffold a new REST API endpoint in the Upwork Buddy Go backend. Use when the user wants to add a new route/handler for GET, POST, PUT, or DELETE operations.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
maxTurns: 20
---

You are adding a new API endpoint to the Upwork Buddy Go backend. Follow the project's established conventions precisely.

## Architecture Context
- Go backend lives in `internal/server/` with `server.go` (Server struct + NewServer), `routes.go` (RegisterRoutes + CORS middleware), and `handlers.go` (handler methods on *Server). Job-specific handlers are in `job_handlers.go` and template handlers in `template_handlers.go`.
- Router: `http.NewServeMux()` — use `mux.HandleFunc("GET /api/endpoint", s.handlerName)` or `mux.HandleFunc("POST /api/endpoint", s.handlerName)` for method-specific routing.
- Database: GORM via `s.db.GetGorm()` on the `service.DatabaseService` interface. Models live in `internal/database/service/schema.go`. If a new model is needed, add it there and regenerate Atlas migrations with `atlas migrate diff --env app` then `atlas migrate apply --env app`.
- Ollama AI service: `internal/ollama/service.go` — create with `ollama.New()`, defer `Close()`.
- Request/response JSON types: define them as private structs right above the handler in the appropriate file (e.g. `type fooRequest struct { ... }` and `type fooResponse struct { ... }`).
- JSON responses: use the `respondWithJSON(w, payload)` helper in `handlers.go`.
- Error responses: use `respondWithError(w, statusCode, "message")` helper in `job_handlers.go` (also exported).
- Logging: use `log.Printf()` with emoji prefixes — 📥 for requests, ✅ for success, ❌ for errors.
- GORM transactions: wrap multi-write operations in `db.Begin()` / `tx.Commit()` / `tx.Rollback()` with a `defer recover()` rollback guard for panics.

## Steps
1. Read the existing handler files in `internal/server/` to absorb the current patterns.
2. If a new GORM model is needed, add it to `internal/database/service/schema.go`, then update the Atlas loader in `tools/atlas-loader/main.go` to include the new model, then run `atlas migrate diff --env app` to generate a migration and `atlas migrate apply --env app` to apply it.
3. Add the handler method on `*Server` in the appropriate file following the existing pattern:
   - Validate HTTP method at the top (unless it handles multiple methods)
   - Decode JSON body for POST/PUT
   - Perform business logic, call `s.db.GetGorm()` for DB access or `ollama.New()` for AI
   - Encode JSON response with `respondWithJSON` or return error with `respondWithError`
   - Add structured logging with emoji prefixes
4. Register the route in `routes.go` inside `RegisterRoutes()`.
5. Add a test in a new or existing `_test.go` file following the `httptest.NewServer` pattern already in `internal/server/routes_test.go`.
6. Run `go test ./internal/server/ -v` and `go vet ./...` to verify everything compiles and passes.

When the user describes the endpoint they want, confirm the path, HTTP method, and what data it should accept/return.