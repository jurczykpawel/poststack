#!/usr/bin/env bash
# Image tags for a release ref, as GITHUB_OUTPUT multiline blocks `web` and `worker`.
#   image-tags.sh <ref> <web-image> <worker-image>
# A stable tag (v1.2.3) is also published as :latest. A pre-release tag (anything after a '-',
# e.g. v1.2.3-rc.1) only gets its own tag: it is meant for the TEST deploy, and :latest is what
# self-hosters pull.
set -euo pipefail

ref="${1:?ref required}" web="${2:?web image required}" worker="${3:?worker image required}"
[[ "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "not a release tag: $ref" >&2; exit 1; }

emit() {
  local name="$1" image="$2"
  echo "${name}<<TAGS"
  echo "${image}:${ref}"
  [[ "$ref" == *-* ]] || echo "${image}:latest"
  echo "TAGS"
}

emit web "$web"
emit worker "$worker"
