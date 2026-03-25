#!/bin/sh
set -e

# Sync database schema (creates tables if missing, applies changes)
if [ -f prisma/schema.prisma ] && [ -d node_modules/prisma ]; then
  echo "[entrypoint] Syncing database schema..."
  node node_modules/prisma/build/index.js db push --schema=prisma/schema.prisma --accept-data-loss 2>&1 || echo "[entrypoint] Schema sync failed"
fi

echo "[entrypoint] Starting server..."
exec node server.js
