# Upwork Buddy repository instructions

## Build, test, and check commands

- Backend build: `make build`
- Backend run: `make run`
- Full Go test suite: `go test ./... -v` or `make test`
- Run a single Go test: `go test ./internal/server -run TestHandler -v`
- Frontend type check: `cd js && npm run type-check`
- Frontend build: `cd js && npm run build`
- Frontend dev build with source maps: `cd js && npm run build:dev`
- Frontend watch mode: `cd js && npm run watch`
- Start Postgres for local development: `make docker-run`
- Apply DB migrations: `make apply`
- Generate DB migrations after schema changes: `make diff`

## High-level architecture

- This repo is a two-part system: a Go API in `cmd/api` + `internal/...` and a TypeScript browser extension in `js/`.
- The Go entrypoint is `cmd/api/main.go`. `internal/server/server.go` loads `.env` automatically, creates the singleton database service, and serves the routes from `internal/server/routes.go`.
- The main backend flow is `POST /api/analyze-job` in `internal/server/handlers.go`: decode request JSON -> create `internal/ollama.Service` -> build a structured prompt -> call the Ollama Cloud chat API -> normalize the model output into JSON before returning it.
- The profile flow is `GET/POST /api/profile`: the API persists one `Profile` row plus related `PortfolioItem` rows in PostgreSQL using GORM transactions.
- The extension entrypoint is `js/src/main.ts`. It injects styles, creates the modal/buttons, waits for Upwork’s `.job-details-content` drawer via `MutationObserver`, extracts job data from the live DOM, then calls the API.
- Frontend state is centered in `js/src/state.ts`: profile data and analyzed-job cache live in memory and are persisted through `js/src/storage.ts`.
- `js/src/storage.ts` is intentionally dual-mode: prefer `browser.storage` / `chrome.storage` when running as an extension, but fall back to `localStorage` for bookmarklet/testing flows.

## Key conventions

- Keep backend/frontend API shapes aligned exactly. The backend request/response structs in Go use snake_case JSON fields, and the frontend API layer in `js/src/api.ts` sends `portfolio_items` on write while tolerating both `portfolio_items` and `portfolioItems` on read.
- When changing persistence models, update both `internal/database/service/schema.go` and `internal/database/service/loader/main.go` before running `make diff`; Atlas migration generation only sees models loaded by the schema loader.
- Profile saves are replace-style updates: `saveProfile` rewrites the parent profile and deletes/recreates all portfolio items inside one transaction instead of patching individual child rows.
- The extension should read URLs/default profile text from `CONFIG` in `js/src/types.ts`; avoid hardcoding API endpoints elsewhere.
- Cached analyses are keyed by `title + first 100 chars of description` in `StateManager.generateCacheKey()`. Preserve that behavior unless you intentionally migrate stored cache data.
- The UI only appears when Upwork’s job drawer exists. DOM-related changes should keep the `MutationObserver` + selector-based extraction flow intact instead of assuming a static page.
- Logging is intentionally verbose for AI/debugging work. Backend request/parse logging lives in `internal/server/handlers.go` and `internal/ollama/service.go`; frontend request/render logging lives in `js/src/api.ts`, `js/src/main.ts`, and related UI/state modules.
