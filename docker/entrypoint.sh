#!/usr/bin/env sh
set -e

echo "[entrypoint] waiting for database..."
# Wait until Postgres accepts connections (max ~60s).
i=0
until pg_isready -h "${POSTGRES_HOST:-timescaledb}" -p "${POSTGRES_PORT:-5432}" -U "${POSTGRES_USER:-market}" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] database not reachable after 60s, aborting" >&2
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] database is up."

echo "[entrypoint] applying Prisma migrations..."
npx prisma migrate deploy

# Best-effort: create TimescaleDB continuous aggregates (outside a transaction).
# Non-fatal if it fails (the prices module falls back to on-the-fly time_bucket).
if [ -f prisma/timescale/continuous_aggregates.sql ]; then
  echo "[entrypoint] applying TimescaleDB continuous aggregates (best-effort)..."
  PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    -h "${POSTGRES_HOST:-timescaledb}" -p "${POSTGRES_PORT:-5432}" \
    -U "${POSTGRES_USER:-market}" -d "${POSTGRES_DB:-prediction_market}" \
    -v ON_ERROR_STOP=0 -f prisma/timescale/continuous_aggregates.sql || \
    echo "[entrypoint] continuous aggregates step skipped/failed (non-fatal)."
fi

echo "[entrypoint] starting: $*"
exec "$@"
