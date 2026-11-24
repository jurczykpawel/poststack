#!/usr/bin/env bash
# Install on the deployment host as the dedicated SSH key's forced command.
set -euo pipefail
umask 077

stack_dir=${1:?stack directory required}
cd "$stack_dir"
if [[ "${SSH_ORIGINAL_COMMAND:-}" == check ]]; then
  test -w . && test -w .env && docker compose -f docker-compose.yaml config --quiet >/dev/null 2>&1 || exit 1
  echo "Deployment command ready."
  exit 0
fi

tag_pattern='v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?'
digest_pattern='sha256:[a-f0-9]{64}'
if [[ ! "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ($tag_pattern)\ ($digest_pattern)\ ($digest_pattern)$ ]]; then
  echo "Invalid deployment command." >&2
  exit 1
fi
tag=${BASH_REMATCH[1]}
web_digest=${BASH_REMATCH[3]}
worker_digest=${BASH_REMATCH[4]}

mkdir -p -m 700 deploy-logs
log=$(mktemp --suffix=.log "deploy-logs/$tag-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
override=
env_tmp=
exec 3>&1 4>&2
finish() {
  local result=$?
  rm -f -- "$override" "$env_tmp" || true
  if (( result == 0 )); then
    printf 'Deployment succeeded. Log: %s/%s\n' "$PWD" "$log" >&3
  else
    printf 'Deployment failed. Log: %s/%s\n' "$PWD" "$log" >&4
  fi
}
trap finish EXIT
exec >>"$log" 2>&1
exec 9>deploy-logs/.lock
flock -w 120 9
override=$(mktemp "$PWD/deploy-logs/.compose.XXXXXXXX")
env_tmp=$(mktemp "$PWD/.env.deploy.XXXXXXXX")
export IMAGE_TAG="$tag"
cat > "$override" <<YAML
services:
web:
  image: ghcr.io/jurczykpawel/poststack@$web_digest
worker:
  image: ghcr.io/jurczykpawel/poststack-worker@$worker_digest
YAML
compose=(docker compose -f docker-compose.yaml -f "$override")
"${compose[@]}" pull web worker
"${compose[@]}" run --rm --no-deps --pull never --entrypoint bun web scripts/migrate.ts
"${compose[@]}" up -d --no-deps --pull never --wait --wait-timeout 180 web worker

cp -p -- .env "$env_tmp"
if grep -q '^IMAGE_TAG=' "$env_tmp"; then
  sed -i "s/^IMAGE_TAG=.*/IMAGE_TAG=$tag/" "$env_tmp"
else
  printf '\nIMAGE_TAG=%s\n' "$tag" >> "$env_tmp"
fi
mv -- "$env_tmp" .env
docker image prune -af
docker builder prune -af
