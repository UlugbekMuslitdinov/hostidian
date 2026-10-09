#!/usr/bin/env bash
# Serialize pnpm invocations across parallel agents/processes so pnpm-lock.yaml is never written concurrently.
# Usage: scripts/pnpm.sh <any pnpm args>   e.g. scripts/pnpm.sh -F @hostidian/web add zod
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/.pnpm-lock.d"
STALE_AFTER=600  # seconds
while ! mkdir "$LOCK" 2>/dev/null; do
  if [ -d "$LOCK" ]; then
    age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK") ))
    if [ "$age" -gt "$STALE_AFTER" ]; then rm -rf "$LOCK"; continue; fi
  fi
  sleep 1
done
trap 'rm -rf "$LOCK"' EXIT
cd "$ROOT"
pnpm "$@"
