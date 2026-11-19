package service

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"os"
	"strings"
	"testing"
)

type failingPingDriver struct{}

func (d failingPingDriver) Open(string) (driver.Conn, error) {
	return failingPingConn{}, nil
}

type failingPingConn struct{}

func (c failingPingConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not implemented")
}
func (c failingPingConn) Close() error              { return nil }
func (c failingPingConn) Begin() (driver.Tx, error) { return nil, errors.New("not implemented") }
func (c failingPingConn) Ping(context.Context) error {
	return errors.New("simulated ping failure")
}

func init() {
	sql.Register("failing_ping_test", failingPingDriver{})
}

func TestHealthReturnsDownWithoutFatal(t *testing.T) {
	var nilSvc *service
	stats := nilSvc.Health()
	if stats["status"] != "down" {
		t.Fatalf("expected status 'down' for nil service, got %q", stats["status"])
	}
	if stats["error"] == "" {
		t.Fatal("expected non-empty error for nil service")
	}

	emptySvc := &service{}
	stats = emptySvc.Health()
	if stats["status"] != "down" {
		t.Fatalf("expected status 'down' for empty service, got %q", stats["status"])
	}
	if stats["error"] == "" {
		t.Fatal("expected non-empty error for empty service")
	}

	mockDB, err := sql.Open("failing_ping_test", "")
	if err != nil {
		t.Fatalf("failed to open mock sql.DB: %v", err)
	}
	svc := &service{db: mockDB, dbName: "mock_db"}
	stats = svc.Health()
	if stats["status"] != "down" {
		t.Fatalf("expected status 'down' on ping failure, got %q", stats["status"])
	}
	if !strings.Contains(stats["error"], "simulated ping failure") {
		t.Fatalf("expected simulated ping failure in error, got %q", stats["error"])
	}
	if err := svc.Close(); err != nil {
		t.Fatalf("expected Close() to succeed, got: %v", err)
	}
}

func TestNewWithDSNValidationAndErrorHandling(t *testing.T) {
	if _, err := NewWithDSN("   "); err == nil {
		t.Fatal("expected error for blank DSN")
	}

	if _, err := NewWithDSN("postgres://postgres:password@127.0.0.1:1/nonexistent?sslmode=disable"); err == nil {
		t.Fatal("expected error when dialing unreachable Postgres port")
	}
}

func TestNewWithDSNSharesSinglePoolAndClosesCleanly(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set, skipping live pool test")
	}

	svc, err := NewWithDSN(dsn)
	if err != nil {
		t.Fatalf("unexpected error from NewWithDSN: %v", err)
	}

	if svc.GetDB() == nil {
		t.Fatal("expected non-nil *sql.DB")
	}
	if svc.GetGorm() == nil {
		t.Fatal("expected non-nil *gorm.DB")
	}

	gormSQLDB, err := svc.GetGorm().DB()
	if err != nil {
		t.Fatalf("failed to get underlying *sql.DB from GORM: %v", err)
	}
	if gormSQLDB != svc.GetDB() {
		t.Fatal("expected GORM and DatabaseService to share the exact same *sql.DB pool")
	}

	stats := svc.Health()
	if stats["status"] != "up" {
		t.Fatalf("expected status 'up' for live DB, got %q (error=%q)", stats["status"], stats["error"])
	}

	if err := svc.Close(); err != nil {
		t.Fatalf("expected Close() to succeed, got: %v", err)
	}

	// After Close(), Health() should return "down" non-fatally
	afterClose := svc.Health()
	if afterClose["status"] != "down" {
		t.Fatalf("expected status 'down' after Close(), got %q", afterClose["status"])
	}
}
