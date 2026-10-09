// Package backend holds the code-generation entry points for the Hostidian API.
//
// Generated code is checked in so a fresh clone builds without running the generators:
//   - internal/httpapi/gen   (oapi-codegen, from ../api/openapi.yaml)
//   - internal/db/sqlcgen    (sqlc, from migrations/ + queries/)
package backend

//go:generate sh scripts/gen-openapi.sh
//go:generate go tool sqlc generate
