# Deploying Hostidian

Hostidian ships as a Docker Compose stack: Postgres, the Go API, the collaboration server, the Next.js web app and Caddy as the single public entry point (routing, TLS, security headers).

```
                         ┌──────────────── docker network "frontend" ───────────────┐
 browser ── 80/443 ──►  caddy ──/api/*────► api:8080     ┐
                          │  ──/collab*──► collab:1234    │   ┌─ network "data" (internal, no internet) ─┐
                          │  ──/internal*─► 404           ├───┤  postgres:5432                           │
                          └──everything else► web:3000    │   └──────────────────────────────────────────┘
                                          api:8081  ◄──► collab:1235   (service-to-service, never published)
```

Only Caddy publishes ports. Postgres, the API's internal port (8081) and the collab internal port (1235) are reachable only from other containers; Postgres sits on a network that has no route to the outside world.

## Requirements

- Docker Engine 24+ with the Compose v2 plugin (`docker compose version`).
- 1 vCPU and 1 GB of RAM is enough for a small team; add RAM for large imports.
- Ports 80 and 443 free on the host (or see [custom ports](#custom-ports)).
- For a public HTTPS site: a DNS name pointing at the host and ports 80/443 reachable from the internet.

## Quick start

```bash
git clone https://github.com/UlugbekMuslitdinov/hostidian.git
cd hostidian
./scripts/gen-env.sh        # writes .env with random secrets; asks for the domain (default: localhost)
docker compose up -d        # first run builds the images (a few minutes)
```

Open <https://localhost> (accept the self-signed certificate; see [HTTPS](#https-and-domains) for trusting it). The first visit shows the setup screen: create the administrator account, then a workspace. Further users join by invitation unless you enable open signup under **Admin → Settings**.

`make up` does the same (it runs `gen-env.sh` only when `.env` is missing). Check the stack with `docker compose ps` (every service should become `healthy`) and `docker compose logs -f`.

`gen-env.sh` options: `--domain notes.example.com`, `--yes` (no prompts), `--force` (regenerate; the old file is kept as `.env.bak-<timestamp>`), `--output FILE`.

## Configuration

All settings live in `.env` (template: [`.env.example`](../.env.example)). Compose passes each service only the variables it needs. Restart after changes: `docker compose up -d`.

| Variable | Default | Used by | Description |
|---|---|---|---|
| `DOMAIN` | `localhost` | caddy | Caddy site address. `localhost` = self-signed HTTPS; a real domain = automatic Let's Encrypt; `http://host` or `:80` = plain HTTP. |
| `PUBLIC_URL` | `https://localhost` | api, collab | Externally visible base URL, no trailing slash. Drives the `Secure` cookie flag, Origin checks, invite/share links and the OIDC redirect. Must match what users type in the browser. |
| `ALLOWED_ORIGINS` | empty | api, collab | Extra browser origins allowed besides `PUBLIC_URL`, comma separated (development: `http://localhost:3000`). |
| `HTTP_PORT` | `80` | caddy | Host and container HTTP port. |
| `HTTPS_PORT` | `443` | caddy | Host and container HTTPS (and HTTP/3) port. |
| `POSTGRES_USER` | `hostidian` | postgres | Database role. |
| `POSTGRES_PASSWORD` | generated | postgres | Database password. Only applied when the data volume is first created. |
| `POSTGRES_DB` | `hostidian` | postgres | Database name. |
| `DATABASE_URL` | built by `gen-env.sh` | api, collab | Connection string; host is `postgres` inside Compose. If you leave it empty, Compose builds it from the `POSTGRES_*` values. Set it to use an external database. |
| `COLLAB_JWT_SECRET` | generated | api, collab | Signs the short-lived collab tokens (api to browser to collab). |
| `INTERNAL_TOKEN` | generated | api, collab | Bearer token for api and collab calling each other. |
| `APP_SECRET` | generated | api | Signs OIDC state/nonce cookies. |
| `API_ADDR` | `:8080` | api | Public API listener (served under `/api`). |
| `INTERNAL_ADDR` | `:8081` | api | Internal listener. Never publish it. |
| `COLLAB_INTERNAL_URL` | `http://collab:1235` | api | Where the API reaches the collab internal port. |
| `COLLAB_PUBLIC_URL` | derived | api | WebSocket URL handed to browsers. Empty = `wss://<host of PUBLIC_URL>/collab`. |
| `DATA_DIR` | `/data` | api | Uploaded files (volume `appdata`). |
| `MAX_UPLOAD_MB` | `50` | api | Per-file upload limit. Caddy allows request bodies up to 512 MB for `/api/*` (zip imports). |
| `LOG_LEVEL` | `info` | api, collab | `debug`, `info`, `warn`, `error`. |
| `COLLAB_PORT` | `1234` | collab | WebSocket port (behind Caddy at `/collab`). |
| `COLLAB_INTERNAL_PORT` | `1235` | collab | Internal HTTP port. Never publish it. |
| `API_INTERNAL_URL` | `http://api:8081` | collab | Where collab reaches the API's internal port. |
| `OIDC_ISSUER_URL` | empty | api | OpenID Connect issuer. SSO is enabled only when issuer, client id and secret are all set. |
| `OIDC_CLIENT_ID` | empty | api | OIDC client id. |
| `OIDC_CLIENT_SECRET` | empty | api | OIDC client secret. |
| `OIDC_NAME` | `Single sign-on` | api | Label of the login button. |

Secrets are generated as hex strings (`openssl rand -hex`), which are safe in URLs and in `.env`. If you write your own, avoid `$` and `#` (Compose interpolation and comments) and URL-reserved characters in `POSTGRES_PASSWORD`, or percent-encode them inside `DATABASE_URL`.

## HTTPS and domains

Caddy picks the certificate source from `DOMAIN`:

| `DOMAIN` | Behaviour | `PUBLIC_URL` |
|---|---|---|
| `localhost` | Self-signed certificate from Caddy's internal CA. Good for trying things out. | `https://localhost` |
| `notes.example.com` | Real certificate from Let's Encrypt, renewed automatically. Needs DNS pointing at the host and ports 80 and 443 reachable from the internet. | `https://notes.example.com` |
| `http://notes.lan` or `:80` | Plain HTTP, no certificates. | `http://notes.lan` |

`./scripts/gen-env.sh --domain notes.example.com` sets both values. Certificates and the local CA live in the `caddy_data` volume; keep it (and back it up) to avoid re-issuing.

Trusting the local CA (so `https://localhost` has no warning): copy the root certificate out of the container and add it to your OS trust store.

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./hostidian-root.crt
```

HSTS (`Strict-Transport-Security`) is only sent for HTTPS requests to real hostnames, never for `localhost` or loopback addresses (browsers ignore it for IP addresses anyway).

PWA note: the service worker and "Add to Home Screen" require a secure context: HTTPS with a certificate the device trusts, or `http://localhost`. A phone cannot use `https://localhost` from your computer, and does not trust Caddy's local CA unless you install it there. See [phone install](#installing-the-pwa-on-a-phone).

### Custom ports

Set `HTTP_PORT` / `HTTPS_PORT` (for example `8080` / `8443`) when 80/443 are taken. Compose publishes the same number inside and outside the container, and Caddy listens on it. Then set `PUBLIC_URL` to include the port (`https://localhost:8443`) and open that URL directly: Caddy's automatic HTTP to HTTPS redirect cannot add a custom port. Let's Encrypt only validates on ports 80/443, so a public certificate needs the default ports (or a proxy in front, see below).

## Running behind another reverse proxy

You can let an existing proxy (Traefik, nginx, HAProxy, another Caddy, a cloud load balancer) handle TLS and forward everything to the Hostidian Caddy over plain HTTP. This is also the pattern for Tailscale and Cloudflare Tunnel.

1. Make Caddy serve plain HTTP on a free local port and publish only that port on the loopback interface. In `.env`:

   ```env
   DOMAIN=:8080
   HTTP_PORT=8080
   PUBLIC_URL=https://notes.example.com   # the URL users see, not the internal one
   ```

   and in a `docker-compose.override.yml` next to `docker-compose.yml` (Compose 2.24+), so the stack does not also try to bind 80/443 that your proxy needs:

   ```yaml
   services:
     caddy:
       ports: !override
         - "127.0.0.1:8080:8080"
   ```

2. Forward **all** paths (`/`, `/api`, `/collab`) to `http://<host>:8080`. Caddy inside the stack still does the path routing and blocks `/internal*`.

3. The outer proxy must:
   - pass the `Host` header and set `X-Forwarded-For` / `X-Forwarded-Proto`;
   - **support WebSockets** (`Upgrade` / `Connection` headers) for `/collab`;
   - **not buffer or compress `text/event-stream`** responses (the live tree updates at `/api/workspaces/<id>/events`) and allow long idle connections (the API sends a heartbeat every 25 s);
   - allow request bodies of at least 512 MB (zip imports) and long upload timeouts.

4. Make Caddy trust the outer proxy so that rate limiting and logs see the real client IP, not the proxy's. Edit the global block of `deploy/Caddyfile`:

   ```caddyfile
   {
       servers {
           trusted_proxies static private_ranges   # or the explicit IPs/CIDRs of your proxy
       }
   }
   ```

   (Merge it with the existing `servers { protocols h1 h2 h3 }` block.) For Cloudflare use their published IP ranges. Without this, login rate limiting treats every visitor as one client.

nginx example (TLS terminated by nginx):

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;
    # ssl_certificate ... ; ssl_certificate_key ... ;

    client_max_body_size 512m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade { default upgrade; '' close; }
        proxy_buffering off;                               # server-sent events
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Traefik example (a `docker-compose.override.yml` that removes the published ports and attaches Caddy to Traefik's network; `.env` has `DOMAIN=:80`, `HTTP_PORT=80`, `PUBLIC_URL=https://notes.example.com`):

```yaml
services:
  caddy:
    ports: !reset []
    networks: [frontend, traefik]
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.hostidian.rule=Host(`notes.example.com`)
      - traefik.http.routers.hostidian.entrypoints=websecure
      - traefik.http.routers.hostidian.tls.certresolver=letsencrypt
      - traefik.http.services.hostidian.loadbalancer.server.port=80
networks:
  traefik:
    external: true
```

Traefik proxies WebSockets and streams SSE without extra configuration; do not enable a compression middleware on this router.

You can also skip the bundled Caddy and route straight to the containers: `/api/*` to `api:8080`, `/collab` to `collab:1234` (strip the `/collab` prefix), everything else to `web:3000`, and return 404 for `/internal*`. That needs your proxy to join the Compose network and is not recommended unless you have a reason.

## Installing the PWA on a phone

Install prompts, the service worker and offline mode only work over a trusted HTTPS origin. Options, easiest first:

**Public domain.** Point DNS at your server and use `DOMAIN=notes.example.com`. Caddy handles the certificate.

**Tailscale (private, no public exposure).** Keep Hostidian on plain HTTP locally and let Tailscale provide a valid certificate for your tailnet name:

```env
DOMAIN=:8080
HTTP_PORT=8080
PUBLIC_URL=https://myhost.tail1234.ts.net
```

```bash
tailscale serve --bg 8080          # serves https://myhost.tail1234.ts.net -> http://127.0.0.1:8080
```

HTTPS must be enabled for the tailnet (admin console, DNS settings). Open the URL on the phone (with Tailscale connected) and use "Add to Home Screen".

**Cloudflare Tunnel.** Run `cloudflared` on the server with a public hostname whose service is `http://localhost:8080`, and use the same `.env` as above with `PUBLIC_URL=https://notes.example.com`. WebSockets and server-sent events work through tunnels. Note that Cloudflare limits request bodies (100 MB on the free and Pro plans), which also limits large imports and uploads.

In all three cases `PUBLIC_URL` must be exactly the HTTPS URL users open; otherwise logins fail the Origin check and cookies are not marked `Secure`.

## Single sign-on (OIDC)

Create an OpenID Connect client at your identity provider (authorization-code flow) with this redirect URI:

```
${PUBLIC_URL}/api/auth/oidc/callback        e.g. https://notes.example.com/api/auth/oidc/callback
```

then set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (and optionally `OIDC_NAME`) in `.env` and run `docker compose up -d`. A "Single sign-on" button appears on the login page. Behaviour: existing users are matched by issuer and subject; an existing local account is linked only if the provider reports `email_verified`; new users are created only when open signup is enabled or they arrive with an invite link.

- **Authentik:** create an *OAuth2/OpenID Provider* and an application; redirect URI as above (strict); issuer URL is `https://authentik.example.com/application/o/<application-slug>/`.
- **Keycloak:** create a client with *Client authentication* on and the standard flow enabled; issuer URL is `https://keycloak.example.com/realms/<realm>` (older versions: `https://keycloak.example.com/auth/realms/<realm>`).
- **Google:** in Google Cloud Console create an OAuth client of type *Web application* and add the redirect URI; issuer URL is `https://accounts.google.com`.

## Backups and restore

State lives in two Docker volumes: `pgdata` (everything except uploaded files) and `appdata` (uploaded files). `caddy_data` holds certificates and can be re-issued if lost.

```bash
make backup
```

writes `backups/hostidian-<timestamp>.sql.gz` (a `pg_dump`) and `backups/hostidian-files-<timestamp>.tar.gz` (the files volume). Schedule it with cron and copy the files off the machine:

```cron
15 3 * * *  cd /opt/hostidian && make backup >> backups/backup.log 2>&1
```

Restore (replaces the current data; asks for confirmation, `YES=1` skips the prompt):

```bash
make restore DB=backups/hostidian-20260101-031500.sql.gz FILES=backups/hostidian-files-20260101-031500.tar.gz
```

Take the database dump and the files archive at about the same time; omit `FILES=` to restore only the database. Without `make`:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' | gzip > hostidian.sql.gz
gunzip -c hostidian.sql.gz | docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Test a restore on a scratch machine before you need it. Keep `.env` in your backup (securely): the secrets are needed to keep sessions and collab tokens valid, although everything else can be regenerated.

## Upgrades

```bash
cd hostidian
make backup                      # always back up first
git pull
docker compose up -d --build     # rebuilds changed images; database migrations run when the API starts
docker compose ps                # wait for "healthy"
```

Migrations are applied automatically on startup and are forward-only: to go back to an older version, restore the backup you took before upgrading. Release tags (`v*`) also publish multi-arch images to `ghcr.io/<owner>/hostidian-{api,collab,web}`; to run those instead of building locally, add a `docker-compose.override.yml`:

```yaml
services:
  api:
    image: ghcr.io/<owner>/hostidian-api:0.1.0
    pull_policy: always
  collab:
    image: ghcr.io/<owner>/hostidian-collab:0.1.0
    pull_policy: always
  web:
    image: ghcr.io/<owner>/hostidian-web:0.1.0
    pull_policy: always
```

and use `docker compose pull && docker compose up -d`.

## Ports

| Port | Service | Published? |
|---|---|---|
| 80 (`HTTP_PORT`) | caddy, HTTP and ACME challenges | yes |
| 443 (`HTTPS_PORT`) tcp + udp | caddy, HTTPS and HTTP/3 | yes |
| 8080 | api, public (`/api`) | no |
| 8081 | api, internal (collab to api) | **never** |
| 1234 | collab, WebSocket | no |
| 1235 | collab, internal (api to collab) | **never** |
| 3000 | web | no |
| 5432 | postgres | **never** (in development it is bound to 127.0.0.1 only) |

## Security notes

- **Internal endpoints.** `api:8081` and `collab:1235` carry service-to-service calls authenticated with `INTERNAL_TOKEN`. They are not published, and Caddy answers 404 to any path starting with `/internal` (also `/api/internal*` and `/collab/internal*`). If you add your own proxy in front, forward only to Caddy and never expose those ports.
- **Secrets.** `.env` is created with mode 600 and is git-ignored. Rotating `COLLAB_JWT_SECRET`, `INTERNAL_TOKEN` or `APP_SECRET` is safe: edit `.env` and run `docker compose up -d`. Sessions live in the database, so nobody is signed out; open editors reconnect and in-flight SSO logins have to be retried. Changing `POSTGRES_PASSWORD` in `.env` does **not** change the password inside an existing database; run `ALTER USER` as well.
- **Containers.** The API, collab and web containers run as non-root users with all Linux capabilities dropped and `no-new-privileges`. Postgres is on an internal network without internet access.
- **Browser protections.** Caddy adds `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, a minimal `Permissions-Policy` and HSTS on real HTTPS domains. Mutating requests and WebSocket/SSE upgrades are checked against `PUBLIC_URL` / `ALLOWED_ORIGINS`.
- **Follow-up.** A strict Content-Security-Policy is deliberately not set yet: the Next.js inline bootstrap scripts would need per-request nonces, which conflicts with the static, offline-capable app shell. Only the non-script directives (frame-ancestors, base-uri, form-action, object-src) are enforced for now.
- **Updates.** Rebuild periodically (`docker compose build --pull`) to pick up base-image security fixes.

## Troubleshooting

| Symptom | Check |
|---|---|
| `required variable ... is not set` from Compose | `.env` is missing or incomplete: run `./scripts/gen-env.sh`. |
| `bind: address already in use` on 80/443 | Another service uses the port. Stop it or set `HTTP_PORT`/`HTTPS_PORT` and adjust `PUBLIC_URL`. |
| Browser warns about the certificate on `https://localhost` | Expected with the internal CA: trust the root certificate (see above) or click through. |
| Let's Encrypt fails | `docker compose logs caddy`: DNS must point at the host and ports 80/443 must be reachable from outside. Let's Encrypt rate-limits repeated failures. |
| API stays `unhealthy` / password authentication failed | `POSTGRES_PASSWORD` in `.env` differs from the one the existing `pgdata` volume was created with (for example after `gen-env.sh --force`). Restore the old value, or run `make destroy` to start from scratch (deletes data). |
| Login says forbidden / 403 on actions | The browser origin does not match `PUBLIC_URL` (scheme, host or port) and is not in `ALLOWED_ORIGINS`. |
| Editor shows "offline" / WebSocket fails | `COLLAB_PUBLIC_URL`/`PUBLIC_URL` wrong, or your outer proxy does not forward `Upgrade` headers on `/collab`. |
| Sidebar does not update live | An outer proxy is buffering or compressing `text/event-stream` (`/api/workspaces/<id>/events`). |
| Upload fails with 413 | Raise `MAX_UPLOAD_MB`; also check the outer proxy's body limit (Caddy allows 512 MB on `/api/*`). |
| A service keeps restarting | `docker compose logs --tail=100 <service>`; configuration errors are printed at startup. |

Useful commands: `docker compose ps`, `docker compose logs -f api collab`, `docker compose exec postgres psql -U hostidian`, `docker compose exec api /usr/local/bin/healthcheck` (exit code 0 = healthy) and `docker compose exec collab wget -qO- http://127.0.0.1:1235/internal/health`.

## Development

Services run on your machine against a Postgres container; see the [README](../README.md#development) for the overview.

```bash
make dev-db        # Postgres on 127.0.0.1:5432 (docker-compose.dev.yml)
make dev-api       # Go API on :8080 / :8081
make dev-collab    # collab server on :1234 / :1235
make dev-web       # Next.js on :3000
make dev-proxy     # optional: http://localhost:8000, the production routing without TLS
make dev-down      # stop the dev containers
```

`make dev` starts Postgres and prints these instructions. Defaults (ports, dev secrets, database URL) are variables at the top of the `Makefile` (`DEV_PG_PORT`, `DEV_PROXY_PORT`, ...). With `make dev-proxy` open <http://localhost:8000> so the API, collab WebSocket and web app share one origin like in production; on Linux the services must listen on all interfaces (the defaults do) so the proxy container can reach them through `host.docker.internal`.

Other targets: `make gen` (API types + Go code), `make lint`, `make test`, `make build`, `make images`, `make clean`. Run `make help` for the full list.
