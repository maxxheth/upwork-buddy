---
name: add-gorm-model
description: Add a new GORM database model and migration to the Upwork Buddy backend. Use when the user wants to create a new database table/model with fields and generate the Atlas migration.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
maxTurns: 20
---

You are adding a new GORM model to the Upwork Buddy database layer. Follow the project's established conventions precisely.

## Architecture Context
- Database service: `internal/database/service/database.go` — singleton `DatabaseService` interface with `Health()`, `Close()`, `GetDB()`, `GetGorm()` methods. Uses both `database/sql` and `gorm.DB`.
- Models: `internal/database/service/schema.go` — all GORM models live here. Existing models: `User`, `Job`, `Profile`, `PortfolioItem`. Each has `ID uint`, `CreatedAt time.Time`, `UpdatedAt time.Time` fields, and uses `gorm` struct tags for column types.
- Atlas loader: `tools/atlas-loader/main.go` — must include every model struct in the `gormschema.New("postgres").Load(...)` call for migrations to be generated.
- Atlas config: `atlas.hcl` at project root — defines the migration directory, dev database, and format. Migrations live in `internal/database/migrations/app/`.
- Current connection: PostgreSQL via pgx driver, GORM with `schema.NamingStrategy{TablePrefix: "public."}`.
- Migrations: `make diff` runs `atlas migrate diff --env app`, `make apply` runs `atlas migrate apply --env app`.
- Docker: `docker-compose.yml` runs Postgres 15-alpine on port 5443 with Atlas for migrations.

## Model Conventions
- Use `gorm:"primaryKey;autoIncrement"` for `ID uint`.
- Use `gorm:"type:text"` for string fields (not varchar).
- Use `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"` for `CreatedAt`.
- Use `gorm:"type:timestamp(3);not null"` for `UpdatedAt`.
- Use `gorm:"index"` for foreign keys.
- Pointer types (`*uint`, `*time.Time`) for nullable fields.
- Foreign keys use `gorm:"foreignKey:FieldName"` tags.
- Import `"time"` and `"ariga.io/atlas-provider-gorm/gormschema"` (blank import in loader).

## Steps
1. Read `internal/database/service/schema.go` to see existing model patterns.
2. Add the new model struct to `schema.go` with proper GORM tags.
3. Update `tools/atlas-loader/main.go` to include the new model in the `Load()` call.
4. Run `atlas migrate diff --env app` to generate the migration.
5. Run `atlas migrate apply --env app` (or `make apply`) to apply it.
6. Verify by running `go test ./internal/database/... -v`.
7. If the model has relationships, also add the inverse relationship tags on the related models.

When the user provides model details, ask for the model name (PascalCase), field definitions (comma-separated), and a description of what it represents. If relationships are needed, clarify those as well.