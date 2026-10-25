#!/usr/bin/env bash
# Runs scripts/schema-change-pg.ts against PostgreSQL 12, 13, 14, 15, 16, 17 and 18, one container each, and removes the containers afterwards.
# Needs Docker and the server dependencies (npm --prefix server install). Usage: scripts/schema-change-versions.sh [version ...]
set -uo pipefail
cd "$(dirname "$0")/.."
versions=("$@")
[ ${#versions[@]} -eq 0 ] && versions=(12 13 14 15 16 17 18)
failed=()
for v in "${versions[@]}"; do
  name="goforge-schema-pg$v"; port=$((54400 + v))
  docker rm -f "$name" >/dev/null 2>&1
  docker run -d --name "$name" -e POSTGRES_PASSWORD=schema -p "127.0.0.1:$port:5432" "postgres:$v" -c max_locks_per_transaction=1024 >/dev/null || { echo "could not start PostgreSQL $v"; failed+=("$v"); continue; }
  until docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  echo "== PostgreSQL $v"
  out=$(mktemp)
  SCHEMA_CHANGE_DATABASE_URL="postgres://postgres:schema@127.0.0.1:$port/postgres" server/node_modules/.bin/tsx scripts/schema-change-pg.ts >"$out" 2>&1
  code=$?
  grep -E "passed|FAIL|threw" "$out"
  if [ $code -eq 0 ]; then echo "   PostgreSQL $v: all sections passed"; else echo "   PostgreSQL $v: FAILED (full output: $out)"; failed+=("$v"); fi
  docker rm -f "$name" >/dev/null 2>&1
done
[ ${#failed[@]} -eq 0 ] && echo "All versions passed." || { echo "Failed: ${failed[*]}"; exit 1; }
