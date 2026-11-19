# Simple Makefile for a Go project

# Build the application
all: build vet test

build:
	@echo "Building Go backend..."
	@go build -o ./dist/upwork-buddy ./cmd/api/main.go
	@chmod +x ./dist/upwork-buddy
	@echo "Build completed: ./dist/upwork-buddy"

# Run the application
run:
	@go run cmd/api/main.go

# Create DB container
docker-run:
	@if docker compose up --build 2>/dev/null; then \
		: ; \
	else \
		echo "Falling back to Docker Compose V1"; \
		docker-compose up --build; \
	fi

# Shutdown DB container
docker-down:
	@if docker compose down 2>/dev/null; then \
		: ; \
	else \
		echo "Falling back to Docker Compose V1"; \
		docker-compose down; \
	fi

# Test the application
test:
	@echo "Testing..."
	@go test -race ./...

# Vet the application
vet:
	@echo "Vetting..."
	@go vet ./...

# Lint the application
lint:
	@echo "Linting..."
	@golangci-lint run ./...

# Vulnerability scan
vuln:
	@echo "Scanning for vulnerabilities..."
	@govulncheck ./...

# Clean the binary
clean:
	@echo "Cleaning..."
	@rm -rf ./dist

# Start the server in the background
start: build
	@mkdir -p ./logs
	@nohup ./dist/upwork-buddy > ./logs/server.log 2>&1 &
	@echo "Server started (PID: $$!). Logs: ./logs/server.log"

# Stop the background server
stop:
	@pkill -f "./dist/upwork-buddy" 2>/dev/null && echo "Server stopped" || echo "Server not running"

# Live Reload
watch:
	@if command -v air > /dev/null; then \
            air; \
            echo "Watching...";\
        else \
            read -p "Go's 'air' is not installed on your machine. Do you want to install it? [Y/n] " choice; \
            if [ "$$choice" != "n" ] && [ "$$choice" != "N" ]; then \
                go install github.com/air-verse/air@latest; \
                air; \
                echo "Watching...";\
            else \
                echo "You chose not to install air. Exiting..."; \
                exit 1; \
            fi; \
        fi

# Atlas migrations
apply:
	@echo "Applying migrations..."
	@atlas migrate apply --env app

diff:
	@echo "Diffing schema..."
	@atlas migrate diff --env app

atlas-apply: apply

atlas-diff: diff

atlas-status:
	@atlas migrate status --env app

atlas-hash:
	@atlas migrate hash --dir "file://internal/database/migrations/app"

atlas-validate:
	@atlas migrate validate --dir "file://internal/database/migrations/app"

# Isolated Postgres 17 + Atlas clean-DB migration & test verification
verify-db:
	@bash -euo pipefail -c '\
		export DOCKER_DB_PORT=5444 APP_DB_USERNAME=verify_user APP_DB_PASSWORD=verify_pass APP_DB_DATABASE=upwork_buddy_verify; \
		cleanup() { docker compose --env-file /dev/null -p upwork_buddy_verify down -v --remove-orphans; }; \
		trap cleanup EXIT; \
		cleanup; \
		docker compose --env-file /dev/null -p upwork_buddy_verify up -d --wait app_db; \
		docker compose --env-file /dev/null -p upwork_buddy_verify run --rm migrate_app_db; \
		TEST_DATABASE_URL="postgres://verify_user:verify_pass@127.0.0.1:5444/upwork_buddy_verify?sslmode=disable" go test -race -v ./internal/database/service/... ./internal/server/...; \
	'

.PHONY: all build run test vet lint vuln clean watch docker-run docker-down apply diff atlas-apply atlas-diff atlas-status atlas-hash atlas-validate verify-db start stop
