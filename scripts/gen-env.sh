#!/usr/bin/env bash
# Create a ready-to-use .env from .env.example with freshly generated secrets.
#
#   scripts/gen-env.sh                          # interactive: asks for the domain on a terminal
#   scripts/gen-env.sh --domain notes.example.com
#   scripts/gen-env.sh --force                  # regenerate; the old file is kept as .env.bak-<timestamp>
#
# Safe to re-run: an existing .env is never touched unless --force is given.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/.env.example"
OUTPUT="$ROOT/.env"
DOMAIN_ARG=""
FORCE=0
ASSUME_YES=0

usage() {
  cat <<'EOF'
Usage: scripts/gen-env.sh [options]

Creates .env from .env.example and fills in:
  COLLAB_JWT_SECRET, INTERNAL_TOKEN, APP_SECRET, POSTGRES_PASSWORD   random (openssl rand)
  DATABASE_URL                                                       rebuilt from the POSTGRES_* values
  DOMAIN, PUBLIC_URL                                                 from --domain / prompt

Options:
  -d, --domain NAME   Site address: localhost (default), a real domain such as notes.example.com
                      (HTTPS via Let's Encrypt), or http://host / :80 for plain HTTP.
  -f, --force         Overwrite an existing .env (the old one is saved as .env.bak-<timestamp>).
                      WARNING: new secrets do not change an existing Postgres volume's password.
  -y, --yes           Never prompt; use defaults for anything not given as an option.
  -o, --output FILE   Write to FILE instead of .env.
  -h, --help          Show this help.
EOF
}

die() { printf 'gen-env: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--domain)   [ $# -ge 2 ] || die "$1 needs a value"; DOMAIN_ARG="$2"; shift 2 ;;
    --domain=*)    DOMAIN_ARG="${1#*=}"; shift ;;
    -f|--force)    FORCE=1; shift ;;
    -y|--yes|--non-interactive) ASSUME_YES=1; shift ;;
    -o|--output)   [ $# -ge 2 ] || die "$1 needs a value"; OUTPUT="$2"; shift 2 ;;
    --output=*)    OUTPUT="${1#*=}"; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown option: $1" ;;
  esac
done

[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"

if [ -e "$OUTPUT" ] && [ "$FORCE" -ne 1 ]; then
  printf 'gen-env: %s already exists; keeping it (use --force to regenerate).\n' "$OUTPUT"
  exit 0
fi

# Random secret as lowercase hex: safe in URLs, shells and compose interpolation.
# Usage: rand_hex <bytes>
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Value of KEY in the template ("" if absent or empty).
template_value() {
  local line
  line="$(grep -E "^$1=" "$TEMPLATE" | head -n 1 || true)"
  printf '%s' "${line#*=}"
}

# ---- domain -> DOMAIN / PUBLIC_URL -----------------------------------------------------------------
DOMAIN_VALUE="$DOMAIN_ARG"
if [ -z "$DOMAIN_VALUE" ]; then
  DOMAIN_VALUE="$(template_value DOMAIN)"
  DOMAIN_VALUE="${DOMAIN_VALUE:-localhost}"
  if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ] && [ -t 1 ]; then
    printf 'Domain Hostidian will be served on.\n'
    printf '  localhost            local testing, self-signed HTTPS\n'
    printf '  notes.example.com    real domain, automatic Let'"'"'s Encrypt HTTPS\n'
    printf '  http://notes.lan     plain HTTP\n'
    printf 'Domain [%s]: ' "$DOMAIN_VALUE"
    read -r answer || answer=""
    [ -z "$answer" ] || DOMAIN_VALUE="$answer"
  fi
fi

# Accept "https://example.com/" and normalise it to "example.com".
DOMAIN_VALUE="$(printf '%s' "$DOMAIN_VALUE" | tr '[:upper:]' '[:lower:]')"
DOMAIN_VALUE="${DOMAIN_VALUE#https://}"
DOMAIN_VALUE="${DOMAIN_VALUE%/}"
case "$DOMAIN_VALUE" in
  http://*)
    host_part="${DOMAIN_VALUE#http://}"
    [[ "$host_part" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "invalid domain: $DOMAIN_VALUE"
    PUBLIC_URL_VALUE="$DOMAIN_VALUE"
    ;;
  :[0-9]*)
    [[ "$DOMAIN_VALUE" =~ ^:[0-9]+$ ]] || die "invalid domain: $DOMAIN_VALUE"
    PUBLIC_URL_VALUE="http://localhost"
    [ "$DOMAIN_VALUE" = ":80" ] || PUBLIC_URL_VALUE="http://localhost$DOMAIN_VALUE"
    ;;
  *)
    [[ "$DOMAIN_VALUE" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "invalid domain: $DOMAIN_VALUE"
    PUBLIC_URL_VALUE="https://$DOMAIN_VALUE"
    ;;
esac

# ---- secrets -----------------------------------------------------------------------------------------
PG_USER="$(template_value POSTGRES_USER)"; PG_USER="${PG_USER:-hostidian}"
PG_DB="$(template_value POSTGRES_DB)";     PG_DB="${PG_DB:-hostidian}"
PG_PASSWORD="$(rand_hex 24)"
COLLAB_JWT_SECRET_VALUE="$(rand_hex 48)"
INTERNAL_TOKEN_VALUE="$(rand_hex 48)"
APP_SECRET_VALUE="$(rand_hex 48)"
DATABASE_URL_VALUE="postgres://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}?sslmode=disable"

for key in DOMAIN PUBLIC_URL POSTGRES_PASSWORD DATABASE_URL COLLAB_JWT_SECRET INTERNAL_TOKEN APP_SECRET; do
  grep -qE "^${key}=" "$TEMPLATE" || die "$TEMPLATE has no ${key}= line; update scripts/gen-env.sh"
done

# ---- write -------------------------------------------------------------------------------------------
umask 077
tmp="$(mktemp "${OUTPUT}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    DOMAIN=*)            printf 'DOMAIN=%s\n' "$DOMAIN_VALUE" ;;
    PUBLIC_URL=*)        printf 'PUBLIC_URL=%s\n' "$PUBLIC_URL_VALUE" ;;
    POSTGRES_PASSWORD=*) printf 'POSTGRES_PASSWORD=%s\n' "$PG_PASSWORD" ;;
    DATABASE_URL=*)      printf 'DATABASE_URL=%s\n' "$DATABASE_URL_VALUE" ;;
    COLLAB_JWT_SECRET=*) printf 'COLLAB_JWT_SECRET=%s\n' "$COLLAB_JWT_SECRET_VALUE" ;;
    INTERNAL_TOKEN=*)    printf 'INTERNAL_TOKEN=%s\n' "$INTERNAL_TOKEN_VALUE" ;;
    APP_SECRET=*)        printf 'APP_SECRET=%s\n' "$APP_SECRET_VALUE" ;;
    *)                   printf '%s\n' "$line" ;;
  esac
done < "$TEMPLATE" > "$tmp"

if [ -e "$OUTPUT" ]; then
  backup="${OUTPUT}.bak-$(date +%Y%m%d%H%M%S)"
  mv "$OUTPUT" "$backup"
  chmod 600 "$backup"
  printf 'gen-env: previous file saved as %s\n' "$backup"
  printf 'gen-env: note: an existing Postgres volume keeps its old password; reset it (make destroy) or keep the old POSTGRES_PASSWORD.\n'
fi
mv "$tmp" "$OUTPUT"
trap - EXIT
chmod 600 "$OUTPUT"

printf 'gen-env: wrote %s (mode 600)\n' "$OUTPUT"
printf '  DOMAIN     = %s\n' "$DOMAIN_VALUE"
printf '  PUBLIC_URL = %s\n' "$PUBLIC_URL_VALUE"
printf 'Next: docker compose up -d   (then open %s)\n' "$PUBLIC_URL_VALUE"
