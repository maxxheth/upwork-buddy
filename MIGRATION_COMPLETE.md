# Upwork Buddy - Migration Complete

This project has been successfully migrated from MySQL to PostgreSQL with a workflow similar to ciwg-zoho-migration.

## Quick Start

### 1. Start the Database
```bash
make docker-run
# or
docker compose up -d
```

### 2. Generate and Apply Migrations
```bash
# Generate a new migration after schema changes
make diff

# Apply migrations
make apply
```

### 3. Run the Application
```bash
# Run directly
make run

# Run with hot reload (requires air)
make watch
```

### 4. Test the API
```bash
# Hello World endpoint
curl http://localhost:9090/

# Health check (includes database stats)
curl http://localhost:9090/health
```

## Project Structure

```
upwork-buddy/
├── cmd/
│   └── api/
│       └── main.go              # Application entry point
├── internal/
│   ├── database/
│   │   ├── migrations/
│   │   │   └── app/             # Atlas migration files
│   │   └── service/
│   │       ├── database.go      # Database service with PostgreSQL + GORM
│   │       ├── schema.go        # GORM models (User, Job)
│   │       └── loader/
│   │           └── main.go      # Atlas schema loader
│   └── server/
│       ├── server.go            # HTTP server setup
│       └── routes.go            # Route handlers
├── .air.toml                    # Hot reload configuration
├── .env                         # Environment variables
├── .env.example                 # Environment template
├── atlas.hcl                    # Atlas migration configuration
├── docker-compose.yml           # PostgreSQL setup
├── go.mod                       # Go dependencies
├── Makefile                     # Build and utility commands
└── README.md                    # This file
```

## Database Configuration

The application uses PostgreSQL on port **5443** (to avoid conflicts).

### Environment Variables
```bash
PORT=8082                        # API server port
APP_ENV=local
APP_DB_HOST=localhost
APP_DB_PORT=5443                 # PostgreSQL external port
APP_DB_USERNAME=postgres
APP_DB_PASSWORD=password
APP_DB_DATABASE=upwork_buddy
```

## Available Make Commands

- `make build` - Build the application
- `make run` - Run the application
- `make watch` - Run with hot reload (Air)
- `make docker-run` - Start PostgreSQL container
- `make docker-down` - Stop PostgreSQL container
- `make apply` - Apply database migrations
- `make diff` - Generate new migration from schema changes
- `make test` - Run tests
- `make itest` - Run integration tests
- `make clean` - Clean build artifacts

## Example Models

### User Model
```go
type User struct {
    ID        uint      `gorm:"primaryKey;autoIncrement"`
    Email     string    `gorm:"type:text;not null;uniqueIndex"`
    Name      string    `gorm:"type:text;not null"`
    CreatedAt time.Time `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
    UpdatedAt time.Time `gorm:"type:timestamp(3);not null"`
}
```

### Job Model
```go
type Job struct {
    ID          uint       `gorm:"primaryKey;autoIncrement"`
    Title       string     `gorm:"type:text;not null"`
    Description string     `gorm:"type:text"`
    URL         string     `gorm:"type:text"`
    Source      string     `gorm:"type:text"`
    Status      string     `gorm:"type:text"`
    UserID      *uint      `gorm:"index"`
    User        *User      `gorm:"foreignKey:UserID"`
    CreatedAt   time.Time  `gorm:"type:timestamp(3);default:CURRENT_TIMESTAMP;not null"`
    UpdatedAt   time.Time  `gorm:"type:timestamp(3);not null"`
    AppliedAt   *time.Time `gorm:"type:timestamp(3)"`
}
```

## Workflow Overview

1. **Schema Definition**: Define models in `internal/database/service/schema.go`
2. **Schema Loading**: Atlas loads schema via `internal/database/service/loader/main.go`
3. **Migration Generation**: Run `make diff` to generate SQL migration files
4. **Migration Application**: Run `make apply` to apply migrations to database
5. **Development**: Use `make watch` for hot reload during development

## Technology Stack

- **Go**: 1.24.5
- **PostgreSQL**: 15-alpine
- **GORM**: ORM for database operations
- **Atlas**: Database schema management and migrations
- **Air**: Hot reload for development
- **Docker Compose**: Container orchestration

## Next Steps

This is a generic, templated setup. Add your business logic:
- Add more models to `schema.go`
- Create API routes in `internal/server/routes.go`
- Implement business logic in dedicated service packages
- Add tests in appropriate `_test.go` files

## Migration from ciwg-zoho-migration

The following workflow elements were successfully migrated:
- ✅ PostgreSQL database setup with Docker Compose
- ✅ Atlas migration tooling and configuration
- ✅ GORM integration for ORM
- ✅ Database service layer pattern
- ✅ Hot reload with Air
- ✅ Makefile commands for common tasks
- ✅ Health check endpoint with database stats
- ✅ Environment variable configuration

The business logic was intentionally **not** migrated as the scope differs between projects.
