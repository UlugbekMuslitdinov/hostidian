// Package migrations embeds the goose SQL migrations so the API binary can migrate on start-up.
package migrations

import "embed"

// FS holds every *.sql migration (goose format) at its root.
//
//go:embed *.sql
var FS embed.FS
