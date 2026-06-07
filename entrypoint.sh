#!/bin/sh
set -e

echo "[entrypoint] Applying database migrations..."
# Fail hard if migrations fail — never start the server on an unmigrated or
# inconsistent schema (that would be a silent failure). `set -e` aborts here.
bun scripts/migrate.ts

echo "[entrypoint] Starting server..."
exec bun src/server/index.ts
