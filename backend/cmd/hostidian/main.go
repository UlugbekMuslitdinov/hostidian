// Command hostidian runs the Hostidian API: the public listener (mounted at /api) and the internal
// service-to-service listener.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/config"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/deps"
	"hostidian/backend/internal/events"
	"hostidian/backend/internal/httpapi"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "hostidian:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		return healthcheck(os.Args[2:])
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)
	if weak := cfg.WeakSecrets(); len(weak) > 0 {
		log.Warn("secrets look like placeholders or are shorter than 16 characters; generate real ones (scripts/gen-env.sh)", "vars", weak)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := connectWithRetry(ctx, cfg.DatabaseURL, log)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := db.Migrate(ctx, cfg.DatabaseURL); err != nil {
		return err
	}
	log.Info("database ready", "oidc", cfg.OIDC.Enabled(), "collab", cfg.CollabInternalURL != "")

	q := sqlcgen.New(pool)
	broker := events.NewBroker(q, log)
	collab := collabclient.New(cfg.CollabInternalURL, cfg.InternalToken, log)
	server, err := httpapi.NewServer(&deps.Deps{Config: cfg, Log: log, Pool: pool, Q: q, Broker: broker, Collab: collab}, httpapi.Options{})
	if err != nil {
		return err
	}

	public := &http.Server{
		Addr:              cfg.APIAddr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		// Streaming handlers (SSE, downloads) extend their own deadline with http.ResponseController.
		WriteTimeout: time.Minute,
		IdleTimeout:  2 * time.Minute,
	}
	internal := &http.Server{
		Addr:              cfg.InternalAddr,
		Handler:           server.InternalHandler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       time.Minute,
		WriteTimeout:      time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	go janitor(ctx, server, log)

	errc := make(chan error, 2)
	serve := func(name string, srv *http.Server) {
		log.Info("listening", "listener", name, "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- fmt.Errorf("%s listener: %w", name, err)
		}
	}
	go serve("public", public)
	go serve("internal", internal)

	select {
	case err := <-errc:
		stop()
		shutdown(log, broker, collab, public, internal)
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		shutdown(log, broker, collab, public, internal)
		return nil
	}
}

func shutdown(log *slog.Logger, broker *events.Broker, collab *collabclient.Client, servers ...*http.Server) {
	// SSE streams never finish on their own: end them first so Shutdown does not wait on them.
	broker.Shutdown()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, srv := range servers {
		if err := srv.Shutdown(ctx); err != nil {
			log.Warn("graceful shutdown failed, closing", "addr", srv.Addr, "err", err)
			_ = srv.Close()
		}
	}
	collab.Wait()
}

// connectWithRetry waits for the database during container start-up.
func connectWithRetry(ctx context.Context, dsn string, log *slog.Logger) (*pgxpool.Pool, error) {
	var lastErr error
	for attempt := 1; attempt <= 30; attempt++ {
		pool, err := db.Connect(ctx, dsn)
		if err == nil {
			return pool, nil
		}
		lastErr = err
		log.Warn("database not ready", "attempt", attempt, "err", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil, lastErr
}

// janitor performs periodic housekeeping until ctx ends.
func janitor(ctx context.Context, s *httpapi.Server, log *slog.Logger) {
	sweep := time.NewTicker(5 * time.Minute)
	defer sweep.Stop()
	hourly := time.NewTicker(time.Hour)
	defer hourly.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-sweep.C:
			s.Auth.Limiter().Sweep()
		case <-hourly.C:
			if n, err := s.Auth.Cleanup(ctx); err != nil {
				log.Warn("housekeeping", "err", err)
			} else if n > 0 {
				log.Info("deleted expired sessions", "count", n)
			}
			if n, err := s.SweepFiles(ctx, 24*time.Hour); err != nil {
				log.Warn("file sweep", "err", err)
			} else if n > 0 {
				log.Info("removed unreferenced files", "count", n)
			}
		}
	}
}

// healthcheck implements `hostidian healthcheck [url]` for container HEALTHCHECKs (the final image is
// distroless: no shell, curl or wget). It reads only API_ADDR (default :8080) and succeeds when GET /healthz
// answers 200; it deliberately does not load or validate the rest of the configuration.
func healthcheck(args []string) error {
	addr := os.Getenv("API_ADDR")
	if addr == "" {
		addr = ":8080"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid API_ADDR %q: %w", addr, err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	url := "http://" + net.JoinHostPort(host, port) + "/healthz"
	if len(args) > 0 {
		url = args[0]
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %d", url, resp.StatusCode)
	}
	return nil
}
