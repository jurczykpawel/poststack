#!/bin/sh
# Worker container liveness probe. The worker writes an epoch-seconds heartbeat after successful
# idle polls and while active work keeps its event loop responsive. A stale file means the worker
# can no longer make progress, so Docker reports it unhealthy.
file="${WORKER_HEARTBEAT_FILE:-/tmp/replystack-worker.heartbeat}"
max_age="${WORKER_HEARTBEAT_MAX_AGE:-60}"
hb=$(cat "$file" 2>/dev/null || echo 0)
now=$(date +%s)
[ $((now - hb)) -lt "$max_age" ]
