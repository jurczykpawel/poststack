#!/bin/sh
# Worker container liveness probe. The worker writes an epoch-seconds heartbeat on every
# graphile poll; if it stops advancing (event loop blocked / pool dead) the worker is hung even
# though the process is still "running", so this exits non-zero and Docker reports it unhealthy.
file="${WORKER_HEARTBEAT_FILE:-/tmp/replystack-worker.heartbeat}"
max_age="${WORKER_HEARTBEAT_MAX_AGE:-60}"
hb=$(cat "$file" 2>/dev/null || echo 0)
now=$(date +%s)
[ $((now - hb)) -lt "$max_age" ]
