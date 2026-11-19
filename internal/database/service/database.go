package service

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "github.com/joho/godotenv/autoload"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

// DatabaseService represents a service that interacts with a database.
type DatabaseService interface {
	// Health returns a map of health status information.
	// The keys and values in the map are service-specific.
	Health() map[string]string

	// Close terminates the database connection.
	// It returns an error if the connection cannot be closed.
	Close() error

	// GetDB returns the raw SQL database connection
	GetDB() *sql.DB

	// GetGorm returns the GORM database instance
	GetGorm() *gorm.DB
}

type service struct {
	db     *sql.DB
	gorm   *gorm.DB
	dbName string
}

var (
	mu         sync.Mutex
	dbInstance *service
)

// New returns the singleton DatabaseService configured from environment variables.
func New() DatabaseService {
	mu.Lock()
	defer mu.Unlock()

	if dbInstance != nil {
		return dbInstance
	}

	connStr := buildConnStrFromEnv()
	svc, err := newServiceWithDSN(connStr)
	if err != nil {
		log.Fatal(err)
	}

	dbInstance = svc
	return dbInstance
}

// NewWithDSN creates a new DatabaseService using the given PostgreSQL DSN.
// It shares a single *sql.DB connection pool between database/sql and GORM.
func NewWithDSN(connStr string) (DatabaseService, error) {
	return newServiceWithDSN(connStr)
}

func newServiceWithDSN(connStr string) (*service, error) {
	if strings.TrimSpace(connStr) == "" {
		return nil, fmt.Errorf("empty database connection string")
	}

	db, err := sql.Open("pgx", connStr)
	if err != nil {
		return nil, fmt.Errorf("open sql db: %w", err)
	}

	db.SetConnMaxLifetime(0)
	db.SetMaxIdleConns(50)
	db.SetMaxOpenConns(50)

	gormDB, err := gorm.Open(postgres.New(postgres.Config{
		Conn: db,
	}), &gorm.Config{
		NamingStrategy: schema.NamingStrategy{
			TablePrefix: "public.",
		},
	})
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open gorm db: %w", err)
	}

	return &service{
		db:     db,
		gorm:   gormDB,
		dbName: extractDBName(connStr),
	}, nil
}

func buildConnStrFromEnv() string {
	if rawURL := strings.TrimSpace(os.Getenv("DATABASE_URL")); rawURL != "" {
		return rawURL
	}

	database := os.Getenv("APP_DB_DATABASE")
	password := os.Getenv("APP_DB_PASSWORD")
	username := os.Getenv("APP_DB_USERNAME")
	port := os.Getenv("APP_DB_PORT")
	host := os.Getenv("APP_DB_HOST")

	hostPort := host
	if host != "" && port != "" {
		hostPort = net.JoinHostPort(host, port)
	} else if port != "" {
		hostPort = ":" + port
	}

	u := &url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(username, password),
		Host:     hostPort,
		Path:     "/" + strings.TrimPrefix(database, "/"),
		RawQuery: "sslmode=disable&search_path=public",
	}
	return u.String()
}

func extractDBName(connStr string) string {
	u, err := url.Parse(connStr)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(u.Path, "/")
}

// GetDB returns the raw SQL database connection
func (s *service) GetDB() *sql.DB {
	return s.db
}

// GetGorm returns the GORM database instance
func (s *service) GetGorm() *gorm.DB {
	return s.gorm
}

// Health checks the health of the database connection by pinging the database.
// It returns a map with keys indicating various health statistics.
func (s *service) Health() map[string]string {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	stats := make(map[string]string)
	if s == nil || s.db == nil {
		stats["status"] = "down"
		stats["error"] = "db down: database connection is nil"
		return stats
	}

	// Ping the database
	err := s.db.PingContext(ctx)
	if err != nil {
		stats["status"] = "down"
		stats["error"] = fmt.Sprintf("db down: %v", err)
		log.Printf("db down: %v", err)
		return stats
	}

	// Database is up, add more statistics
	stats["status"] = "up"
	stats["message"] = "It's healthy"

	// Get database stats (like open connections, in use, idle, etc.)
	dbStats := s.db.Stats()
	stats["open_connections"] = strconv.Itoa(dbStats.OpenConnections)
	stats["in_use"] = strconv.Itoa(dbStats.InUse)
	stats["idle"] = strconv.Itoa(dbStats.Idle)
	stats["wait_count"] = strconv.FormatInt(dbStats.WaitCount, 10)
	stats["wait_duration"] = dbStats.WaitDuration.String()
	stats["max_idle_closed"] = strconv.FormatInt(dbStats.MaxIdleClosed, 10)
	stats["max_lifetime_closed"] = strconv.FormatInt(dbStats.MaxLifetimeClosed, 10)

	// Evaluate stats to provide a health message
	if dbStats.OpenConnections > 40 {
		stats["message"] = "The database is experiencing heavy load."
	}
	if dbStats.WaitCount > 1000 {
		stats["message"] = "The database has a high number of wait events, indicating potential bottlenecks."
	}

	if dbStats.OpenConnections > 0 && dbStats.MaxIdleClosed > int64(dbStats.OpenConnections)/2 {
		stats["message"] = "Many idle connections are being closed, consider revising the connection pool settings."
	}
	if dbStats.OpenConnections > 0 && dbStats.MaxLifetimeClosed > int64(dbStats.OpenConnections)/2 {
		stats["message"] = "Many connections are being closed due to max lifetime, consider increasing max lifetime or revising the connection usage pattern."
	}

	return stats
}

// Close closes the database connection.
// It logs a message indicating the disconnection from the specific database.
// If the connection is successfully closed, it returns nil.
// If an error occurs while closing the connection, it returns the error.
func (s *service) Close() error {
	if s == nil || s.db == nil {
		return nil
	}

	mu.Lock()
	if dbInstance == s {
		dbInstance = nil
	}
	mu.Unlock()

	log.Printf("Disconnected from database: %s", s.dbName)
	return s.db.Close()
}
