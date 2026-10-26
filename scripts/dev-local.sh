#!/usr/bin/env bash
# Runs GoForge on this machine with nothing in the cloud: a local PostgreSQL holds the accounts and is where "GoForge cloud" databases
# are created, and a local Oracle Free holds the Oracle databases. Your server/.env (Neon and the rest) is not read for these values
# and not changed. Usage: scripts/dev-local.sh [api|ui|all]   (default all). Needs Docker. Stop with: docker rm -f goforge-pg-dev goforge-oracle-dev
set -euo pipefail
cd "$(dirname "$0")/.."

PG=goforge-pg-dev
ORA=goforge-oracle-dev
PG_PORT=54330
API_PORT=${API_PORT:-4100}
UI_PORT=${UI_PORT:-5174}
STATE=.local-dev
mkdir -p "$STATE"

secret() { # a password per machine, kept in a git-ignored file
  local file="$STATE/$1.local"
  [ -f "$file" ] || { umask 077; node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))" > "$file"; }
  cat "$file"
}
env_of() { docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$2=//p"; }

busy() { lsof -iTCP:"$1" -sTCP:LISTEN -P >/dev/null 2>&1; }
need_free() { # a second copy of this script, or anything else on the port, would fail halfway with a stack trace
  for port in "$@"; do
    busy "$port" && { echo "Port $port is already in use, most likely by a copy of this script that is still running. Stop it (Ctrl-C in its terminal, or: lsof -ti tcp:$port | xargs kill) and run this again; or set API_PORT / UI_PORT to other ports." >&2; exit 1; }
  done
  return 0
}

ensure_containers() {
  docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop and run this again." >&2; exit 1; }
  if ! docker inspect "$PG" >/dev/null 2>&1; then
    docker run -d --name "$PG" -e POSTGRES_PASSWORD="$(secret postgres)" -p 127.0.0.1:$PG_PORT:5432 postgres:16 >/dev/null
  else docker start "$PG" >/dev/null; fi
  if ! docker inspect "$ORA" >/dev/null 2>&1; then
    docker run -d --name "$ORA" -e ORACLE_PASSWORD="$(secret oracle)" -p 127.0.0.1:1521:1521 gvenzl/oracle-free:23-slim-faststart >/dev/null
  else docker start "$ORA" >/dev/null; fi
  echo "waiting for PostgreSQL..."; until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  docker exec "$PG" psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='goforge_app'" | grep -q 1 \
    || docker exec "$PG" psql -U postgres -c "CREATE DATABASE goforge_app" >/dev/null
  echo "waiting for Oracle (the first start takes a minute or two)..."
  until [ "$(docker inspect -f '{{.State.Health.Status}}' "$ORA" 2>/dev/null)" = healthy ] || docker exec "$ORA" healthcheck.sh >/dev/null 2>&1; do sleep 3; done
}

start_api() {
  local pgpw orapw
  pgpw=$(env_of "$PG" POSTGRES_PASSWORD); orapw=$(env_of "$ORA" ORACLE_PASSWORD)
  # variables set here win over server/.env, which only fills in what is not set (the model key, for one); a local run allows 20 Oracle
  # databases per account (a deployed server keeps the default of 5)
  (cd server && PORT=$API_PORT CORS_ORIGIN="http://localhost:$UI_PORT" ALLOW_SIGNUP=true \
    DATABASE_URL="postgres://postgres:$pgpw@127.0.0.1:$PG_PORT/goforge_app" DATABASE_URL_POOLED="" \
    ORACLE_ADMIN_URL="oracle://system:$orapw@127.0.0.1:1521/FREEPDB1" MAX_ORACLE_DATABASES_PER_USER="${MAX_ORACLE_DATABASES_PER_USER:-20}" exec npx tsx src/index.ts)
}
start_ui() { GOFORGE_API_URL="http://127.0.0.1:$API_PORT" exec npx vite --port "$UI_PORT" --strictPort; }

case "${1:-all}" in
  api) need_free "$API_PORT"; ensure_containers; start_api ;;
  ui) need_free "$UI_PORT"; start_ui ;;
  all) need_free "$API_PORT" "$UI_PORT"; ensure_containers
       (start_api) & API_PID=$!; trap 'kill $API_PID 2>/dev/null' EXIT INT TERM
       echo "GoForge: http://localhost:$UI_PORT  (API on $API_PORT; create an account, it is stored in the local PostgreSQL)"
       start_ui ;;
  *) echo "usage: $0 [api|ui|all]" >&2; exit 2 ;;
esac
