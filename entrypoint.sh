#!/bin/sh
set -e

echo "[entrypoint] Applying database migrations..."
npx prisma migrate deploy 2>&1 || echo "[entrypoint] Migration failed or already up to date"

echo "[entrypoint] Starting server..."
exec node server.js
