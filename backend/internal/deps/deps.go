// Package deps is the dependency bundle shared by the HTTP layer and every domain package. It lives
// in its own package so domain packages (files, search, comments, …) can take it without importing
// internal/httpapi.
package deps

import (
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"

	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/config"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/events"
)

// Deps are the process-wide singletons.
type Deps struct {
	Config *config.Config
	Log    *slog.Logger
	Pool   *pgxpool.Pool
	// Q runs queries on the pool; use db.InTx for transactions.
	Q *sqlcgen.Queries
	// Broker publishes SSE events: Broker.Publish(events.Event{…}).
	Broker *events.Broker
	// Collab closes live collaboration sockets after permission changes.
	Collab collabclient.Disconnecter
}
