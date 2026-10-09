// Package testutil starts one shared throw-away Postgres per test-package run (testcontainers) and
// hands every test its own freshly migrated database cloned from a template.
//
// Usage in a package that needs a database:
//
//	func TestMain(m *testing.M) { os.Exit(testutil.Run(m)) }
//	func TestX(t *testing.T) { pool := testutil.NewDB(t) ... }
package testutil

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"

	"hostidian/backend/internal/db"
)

const templateDB = "hostidian_template"

var (
	startOnce sync.Once
	startErr  error
	container *tcpostgres.PostgresContainer
	adminDSN  string // postgres://…/postgres
	dsnPrefix string // postgres://user:pass@host:port/
	dsnSuffix string // ?sslmode=disable
	dbCounter atomic.Int64
)

// Run executes the tests of the calling package and then terminates the shared container.
func Run(m *testing.M) int {
	code := m.Run()
	if container != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = container.Terminate(ctx)
	}
	return code
}

func start(ctx context.Context) error {
	startOnce.Do(func() {
		c, err := tcpostgres.Run(ctx, "postgres:17-alpine",
			tcpostgres.WithDatabase("postgres"),
			tcpostgres.WithUsername("postgres"),
			tcpostgres.WithPassword("postgres"),
			testcontainers.WithCmd("postgres", "-c", "fsync=off", "-c", "synchronous_commit=off",
				"-c", "full_page_writes=off", "-c", "max_connections=400"),
			tcpostgres.BasicWaitStrategies(),
		)
		if err != nil {
			startErr = fmt.Errorf("start postgres container: %w", err)
			return
		}
		container = c
		dsn, err := c.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			startErr = err
			return
		}
		adminDSN = dsn
		i := strings.LastIndex(dsn, "/postgres?")
		dsnPrefix, dsnSuffix = dsn[:i+1], dsn[i+len("/postgres"):]

		if err := admin(ctx, "CREATE DATABASE "+templateDB); err != nil {
			startErr = err
			return
		}
		if err := db.Migrate(ctx, dsnFor(templateDB)); err != nil {
			startErr = fmt.Errorf("migrate template database: %w", err)
		}
	})
	return startErr
}

func dsnFor(name string) string { return dsnPrefix + name + dsnSuffix }

func admin(ctx context.Context, stmt string) error {
	conn, err := pgx.Connect(ctx, adminDSN)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, stmt)
	return err
}

// NewDB returns a pool connected to a brand-new, fully migrated database that is dropped when the
// test ends.
func NewDB(t testing.TB) *pgxpool.Pool {
	t.Helper()
	pool, _ := NewDBWithDSN(t)
	return pool
}

// NewDBWithDSN is NewDB that also returns the connection string.
func NewDBWithDSN(t testing.TB) (*pgxpool.Pool, string) {
	t.Helper()
	if os.Getenv("HOSTIDIAN_SKIP_DOCKER_TESTS") != "" {
		t.Skip("HOSTIDIAN_SKIP_DOCKER_TESTS is set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if err := start(ctx); err != nil {
		t.Fatalf("postgres test container unavailable: %v", err)
	}
	name := fmt.Sprintf("t%d_%d", os.Getpid(), dbCounter.Add(1))
	if err := admin(ctx, fmt.Sprintf("CREATE DATABASE %s TEMPLATE %s", name, templateDB)); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	dsn := dsnFor(name)
	pool, err := db.Connect(ctx, dsn+"&pool_max_conns=10")
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		dctx, dcancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer dcancel()
		_ = admin(dctx, fmt.Sprintf("DROP DATABASE IF EXISTS %s WITH (FORCE)", name))
	})
	return pool, dsn
}
