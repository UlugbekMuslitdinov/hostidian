# Hostidian developer / operator entry points. Run `make` (or `make help`) for the list.
# Portable to the GNU Make 3.81 that ships with macOS (no .ONESHELL / .SHELLFLAGS).

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Prefix for multi-line recipes so any failing command (or pipe stage) aborts the recipe.
STRICT      := set -euo pipefail;

COMPOSE     ?= docker compose
DEV_COMPOSE ?= docker compose -f docker-compose.dev.yml
# scripts/pnpm.sh serializes access to pnpm-lock.yaml. Long-running dev servers use plain pnpm instead,
# otherwise they would hold that lock until they exit.
PNPM        ?= scripts/pnpm.sh
PNPM_DEV    ?= pnpm
# e2e needs a running stack, so it is excluded from the generic recursive typecheck/lint/test/build.
NODE_ONLY   := -r --filter '!@hostidian/e2e' --if-present
REDOCLY     ?= @redocly/cli@2.54.2
BACKUP_DIR  ?= backups

# ---- local development defaults (loopback only; never reuse in production) -------------------------
DEV_PG_PORT        ?= 5432
DEV_PROXY_PORT     ?= 8000
DEV_DATABASE_URL   ?= postgres://hostidian:hostidian@127.0.0.1:$(DEV_PG_PORT)/hostidian?sslmode=disable
DEV_PUBLIC_URL     ?= http://localhost:$(DEV_PROXY_PORT)
DEV_ORIGINS        ?= http://localhost:3000,http://localhost:$(DEV_PROXY_PORT)
DEV_JWT_SECRET     ?= dev-only-collab-jwt-secret-0123456789abcdef0123456789abcdef
DEV_INTERNAL_TOKEN ?= dev-only-internal-token-0123456789abcdef0123456789abcdef
DEV_APP_SECRET     ?= dev-only-app-secret-0123456789abcdef0123456789abcdef
export DEV_PG_PORT DEV_PROXY_PORT BACKUP_DIR

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} \
	  /^##@ / {printf "\n\033[1m%s\033[0m\n", substr($$0, 5)} \
	  /^[a-zA-Z0-9_.-]+:.*## / {printf "  \033[36m%-13s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo

##@ Code generation

.PHONY: gen
gen: ## Regenerate API types (TypeScript) and Go code (sqlc, oapi-codegen, ...)
	$(PNPM) gen:api
	cd backend && go generate ./...

##@ Local development (services run on the host; only Postgres/Caddy use Docker)

.PHONY: dev
dev: dev-db ## Start Postgres, then print how to run the three services
	@echo
	@echo "Postgres is up. Start the services in three terminals:"
	@echo
	@echo "  make dev-api       # Go API         :8080 (public) / :8081 (internal)"
	@echo "  make dev-collab    # collab server  :1234 (WebSocket) / :1235 (internal)"
	@echo "  make dev-web       # Next.js        :3000"
	@echo
	@echo "Optional single origin like production (cookies, SSE and WebSockets on one host):"
	@echo
	@echo "  make dev-proxy     # then open http://localhost:$(DEV_PROXY_PORT)"
	@echo
	@echo "Stop everything with: make dev-down"
	@echo

.PHONY: dev-db
dev-db: ## Start Postgres for development on 127.0.0.1:5432 (DEV_PG_PORT)
	$(DEV_COMPOSE) up -d --wait postgres

.PHONY: dev-proxy
dev-proxy: ## Start the optional single-origin dev proxy on http://localhost:8000
	$(DEV_COMPOSE) --profile proxy up -d proxy

.PHONY: dev-api
dev-api: ## Run the Go API on :8080/:8081 against the dev database
	@mkdir -p data/dev
	cd backend && \
	  DATABASE_URL='$(DEV_DATABASE_URL)' PUBLIC_URL='$(DEV_PUBLIC_URL)' ALLOWED_ORIGINS='$(DEV_ORIGINS)' \
	  COLLAB_JWT_SECRET='$(DEV_JWT_SECRET)' INTERNAL_TOKEN='$(DEV_INTERNAL_TOKEN)' APP_SECRET='$(DEV_APP_SECRET)' \
	  API_ADDR=:8080 INTERNAL_ADDR=:8081 COLLAB_INTERNAL_URL=http://127.0.0.1:1235 \
	  COLLAB_PUBLIC_URL='ws://localhost:$(DEV_PROXY_PORT)/collab' DATA_DIR='$(CURDIR)/data/dev' LOG_LEVEL=debug \
	  go run ./cmd/hostidian

.PHONY: dev-collab
dev-collab: ## Run the collaboration server on :1234/:1235 (watch mode)
	DATABASE_URL='$(DEV_DATABASE_URL)' PUBLIC_URL='$(DEV_PUBLIC_URL)' ALLOWED_ORIGINS='$(DEV_ORIGINS)' \
	  COLLAB_JWT_SECRET='$(DEV_JWT_SECRET)' INTERNAL_TOKEN='$(DEV_INTERNAL_TOKEN)' \
	  COLLAB_PORT=1234 COLLAB_INTERNAL_PORT=1235 API_INTERNAL_URL=http://127.0.0.1:8081 LOG_LEVEL=debug \
	  $(PNPM_DEV) -F @hostidian/collab dev

.PHONY: dev-web
dev-web: ## Run the Next.js dev server on :3000
	$(PNPM_DEV) -F @hostidian/web dev

.PHONY: dev-down
dev-down: ## Stop the dev containers (data is kept)
	$(DEV_COMPOSE) --profile proxy down

##@ Quality

.PHONY: lint
lint: lint-go lint-node lint-spec ## Run every linter and type check

.PHONY: lint-go
lint-go: ## gofmt + go vet
	@$(STRICT) cd backend; \
	unformatted="$$(gofmt -l .)"; \
	if [ -n "$$unformatted" ]; then echo "gofmt needed on:"; echo "$$unformatted"; exit 1; fi; \
	go vet ./...

.PHONY: lint-node
lint-node: ## TypeScript type check + ESLint for all packages
	$(PNPM) $(NODE_ONLY) run typecheck
	$(PNPM) $(NODE_ONLY) run lint

.PHONY: lint-spec
lint-spec: ## Lint the OpenAPI specs (Redocly)
	npx --yes $(REDOCLY) lint api/openapi.yaml api/internal.yaml

.PHONY: test
test: test-go test-node ## Run all unit and integration tests (Go integration tests need Docker)

.PHONY: test-go
test-go: ## go test ./... (testcontainers starts Postgres)
	cd backend && go test -count=1 ./...

.PHONY: test-node
test-node: ## Vitest suites of all packages
	$(PNPM) $(NODE_ONLY) run test

.PHONY: build
build: build-go build-node ## Compile the API binary and build the Node packages

.PHONY: build-go
build-go: ## Build backend/bin/hostidian
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/hostidian ./cmd/hostidian

.PHONY: build-node
build-node: ## Build collab and web
	$(PNPM) $(NODE_ONLY) run build

.PHONY: images
images: ## Build the Docker images (api, collab, web) without starting anything
	$(COMPOSE) build

##@ Running the stack with Docker Compose

.PHONY: up
up: ## Create .env if missing, then build and start the whole stack
	@if [ ! -f .env ]; then scripts/gen-env.sh; fi
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop and remove the containers (volumes and data are kept)
	$(COMPOSE) down

.PHONY: logs
logs: ## Follow logs (one service: make logs SERVICE=api)
	$(COMPOSE) logs -f --tail=100 $(SERVICE)

.PHONY: ps
ps: ## Show container status
	$(COMPOSE) ps

##@ Backup and restore

.PHONY: backup
backup: ## Dump Postgres and archive the files volume into ./backups
	@$(STRICT) mkdir -p '$(BACKUP_DIR)'; \
	ts="$$(date +%Y%m%d-%H%M%S)"; \
	db="hostidian-$$ts.sql.gz"; \
	files="hostidian-files-$$ts.tar.gz"; \
	echo "Dumping database -> $(BACKUP_DIR)/$$db"; \
	$(COMPOSE) exec -T postgres sh -c 'pg_dump -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" --no-owner --clean --if-exists' \
	  | gzip > "$(BACKUP_DIR)/$$db" || { rm -f "$(BACKUP_DIR)/$$db"; echo "database dump failed"; exit 1; }; \
	echo "Archiving files  -> $(BACKUP_DIR)/$$files"; \
	$(COMPOSE) --profile tools run --rm --no-deps -T \
	  -e OUT="$$files" -e HOST_UID="$$(id -u)" -e HOST_GID="$$(id -g)" tools \
	  sh -c 'tar czf "/backups/$$OUT" -C /data . && chown "$$HOST_UID:$$HOST_GID" "/backups/$$OUT"'; \
	echo "Done. Keep both files together; see docs/deployment.md for restoring."

.PHONY: restore
restore: ## Restore: make restore DB=backups/hostidian-<ts>.sql.gz [FILES=backups/hostidian-files-<ts>.tar.gz]
	@$(STRICT) \
	if [ -z '$(DB)' ]; then \
	  echo "usage: make restore DB=$(BACKUP_DIR)/hostidian-<ts>.sql.gz [FILES=$(BACKUP_DIR)/hostidian-files-<ts>.tar.gz]"; exit 1; \
	fi; \
	[ -f '$(DB)' ] || { echo "not found: $(DB)"; exit 1; }; \
	if [ -n '$(FILES)' ]; then [ -f '$(FILES)' ] || { echo "not found: $(FILES)"; exit 1; }; fi; \
	if [ '$(YES)' != 1 ]; then \
	  read -r -p "This REPLACES the current database$(if $(FILES), and files) with the backup. Type 'restore' to continue: " answer; \
	  [ "$$answer" = restore ] || { echo "aborted"; exit 1; }; \
	fi; \
	$(COMPOSE) stop web api collab caddy; \
	$(COMPOSE) up -d --wait postgres; \
	echo "Restoring database from $(DB)"; \
	gunzip -c '$(DB)' | $(COMPOSE) exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' >/dev/null; \
	if [ -n '$(FILES)' ]; then \
	  echo "Restoring files from $(FILES)"; \
	  $(COMPOSE) --profile tools run --rm --no-deps -T -v "$$(cd "$$(dirname '$(FILES)')" && pwd):/restore:ro" \
	    -e IN="$$(basename '$(FILES)')" tools \
	    sh -c 'find /data -mindepth 1 -delete && tar xzf "/restore/$$IN" -C /data && chown -R 65532:65532 /data'; \
	fi; \
	$(COMPOSE) up -d; \
	echo "Restore complete."

##@ Cleanup

.PHONY: clean
clean: ## Remove local build output (Go binary, .next, dist); containers and data are untouched
	rm -rf backend/bin backend/tmp collab/dist web/.next web/coverage collab/coverage packages/*/dist

.PHONY: destroy
destroy: ## DANGER: remove the stack AND its volumes (database, files, certificates)
	@$(STRICT) \
	if [ '$(YES)' != 1 ]; then \
	  read -r -p "This DELETES the database, uploaded files and TLS certificates. Type 'destroy' to continue: " answer; \
	  [ "$$answer" = destroy ] || { echo "aborted"; exit 1; }; \
	fi; \
	$(COMPOSE) --profile tools down -v --remove-orphans
