#!/bin/sh
set -eu

cd /app/apps/server

if [ ! -f drizzle/meta/_journal.json ]; then
  echo "[bootstrap] Missing committed Drizzle migrations (apps/server/drizzle/meta/_journal.json)." >&2
  echo "[bootstrap] Run pnpm db:generate locally and commit the entire drizzle directory." >&2
  exit 1
fi

echo "[bootstrap] Applying committed database migrations..."
pnpm exec drizzle-kit migrate

echo "[bootstrap] Initializing administrator if absent..."
node dist/admin-init.js

echo "[bootstrap] Starting application..."
exec node dist/main.js
