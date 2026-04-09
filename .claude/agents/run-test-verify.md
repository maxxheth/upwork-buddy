---
name: run-test-verify
description: Run the full test suite for the Upwork Buddy project and fix any failures. Use when the user wants to verify the codebase compiles, tests pass, and the build works.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
maxTurns: 15
---

You are running tests and verification for the Upwork Buddy project. Follow the appropriate steps based on what the user asks to verify.

## Project Test Infrastructure
- **Go tests**: `go test ./... -v` for all packages, or target specific packages:
  - `go test ./internal/server/ -v` — handler and route tests
  - `go test ./internal/ollama/ -v` — Ollama service and parsing tests
  - `go test ./internal/database/ -v` — integration database tests
- **TypeScript tests**: `cd js && npx vitest run --reporter=verbose` — runs Vitest tests
- **TypeScript type check**: `cd js && npm run type-check` — runs `tsc --noEmit`
- **Frontend build**: `cd js && npm run build` — esbuild bundle verification
- **Backend build**: `go build ./...` — verifies Go compilation
- **Database migrations**: `atlas migrate diff --env app` then `atlas migrate apply --env app`
- **Docker**: `docker compose up --build` starts Postgres + Atlas
- **Go vet**: `go vet ./...` for static analysis

## Verification Steps

### Backend
1. Run `go test ./... -v` to execute all Go tests.
2. Run `go vet ./...` for static analysis.
3. Run `go build ./...` to verify compilation.
4. If any tests fail, read the failing test file and the source code it tests, then fix the issue and re-run.

### Frontend
1. Run `cd js && npx vitest run --reporter=verbose` for unit tests.
2. Run `cd js && npm run type-check` to verify TypeScript types.
3. Run `cd js && npm run build` to verify the build succeeds.
4. If any step fails, read the error output and fix the source.

### Full Stack
1. Run all backend steps (tests, vet, build).
2. Run all frontend steps (unit tests, type-check, build).
3. Run `docker compose up --build` to verify the full stack starts.
4. Run `curl http://localhost:9090/health` to verify the server responds.

### Migrations
1. Ensure Docker Postgres is running: `docker compose up -d app_db`.
2. Run `atlas migrate diff --env app` to check for schema drift.
3. If there's drift, review the generated migration file.
4. Run `atlas migrate apply --env app` to apply pending migrations.
5. Verify with `go test ./internal/database/ -v`.

Always report the results clearly: which tests passed, which failed, and what was fixed.