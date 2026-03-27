#!/usr/bin/env bash
#
# Meta Graph API Version Probe
#
# Probes the Meta Graph API with real credentials to verify response shapes
# haven't changed. Uses an app access token (client_credentials grant) —
# no user interaction needed.
#
# Usage:
#   META_APP_ID=xxx META_APP_SECRET=yyy ./scripts/meta-api-probe.sh [version]
#
# Exit codes:
#   0 = all probes passed (response shapes match expectations)
#   1 = shape mismatch detected (details in output)
#   2 = missing credentials or network error
#

set -euo pipefail

VERSION="${1:-v25.0}"
BASE="https://graph.facebook.com/${VERSION}"

if [ -z "${META_APP_ID:-}" ] || [ -z "${META_APP_SECRET:-}" ]; then
  echo "SKIP: META_APP_ID and META_APP_SECRET not set, skipping API probe"
  exit 0
fi

MISMATCHES=0
PROBES=0
REPORT=""

probe() {
  local name="$1"
  local expected_fields="$2"
  local response="$3"

  PROBES=$((PROBES + 1))
  local missing=""

  for field in $expected_fields; do
    if ! echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
# Navigate dot-separated path
obj = data
for key in '${field}'.split('.'):
  if isinstance(obj, dict) and key in obj:
    obj = obj[key]
  else:
    sys.exit(1)
" 2>/dev/null; then
      missing="${missing} ${field}"
    fi
  done

  if [ -n "$missing" ]; then
    MISMATCHES=$((MISMATCHES + 1))
    REPORT="${REPORT}\n FAIL ${name}: missing fields:${missing}"
    echo "FAIL: ${name} — missing fields:${missing}"
  else
    echo "OK:   ${name}"
  fi
}

echo "=== Meta Graph API Probe — ${VERSION} ==="
echo ""

# ─── 1. App Access Token (client_credentials) ────────────────────────────
echo "--- Probe: App Token Exchange ---"
APP_TOKEN_RESPONSE=$(curl -s "${BASE}/oauth/access_token?\
client_id=${META_APP_ID}&\
client_secret=${META_APP_SECRET}&\
grant_type=client_credentials")

probe "app_token_exchange" \
  "access_token token_type" \
  "$APP_TOKEN_RESPONSE"

APP_TOKEN=$(echo "$APP_TOKEN_RESPONSE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -z "$APP_TOKEN" ]; then
  echo "ERROR: Could not obtain app token. Remaining probes skipped."
  echo "$APP_TOKEN_RESPONSE"
  exit 2
fi

# ─── 2. Debug Token (token introspection) ────────────────────────────────
echo ""
echo "--- Probe: Debug Token ---"
DEBUG_RESPONSE=$(curl -s "${BASE}/debug_token?\
input_token=${APP_TOKEN}&\
access_token=${APP_TOKEN}")

probe "debug_token" \
  "data data.app_id data.type data.is_valid" \
  "$DEBUG_RESPONSE"

# ─── 3. Token Exchange Error Shape ───────────────────────────────────────
echo ""
echo "--- Probe: Token Exchange Error Shape ---"
TOKEN_ERROR=$(curl -s "${BASE}/oauth/access_token?\
client_id=${META_APP_ID}&\
client_secret=${META_APP_SECRET}&\
redirect_uri=https://localhost/test&\
code=invalid_code_12345")

probe "token_exchange_error" \
  "error error.message error.type error.code" \
  "$TOKEN_ERROR"

# ─── 4. Send Message Error Shape (no token) ─────────────────────────────
echo ""
echo "--- Probe: Send Message Error Shape ---"
SEND_ERROR=$(curl -s -X POST "${BASE}/me/messages" \
  -H "Content-Type: application/json" \
  -d '{"recipient":{"id":"0"},"message":{"text":"probe"},"access_token":"invalid"}')

probe "send_message_error" \
  "error error.message error.type error.code" \
  "$SEND_ERROR"

# ─── 5. Page Subscription Error Shape ───────────────────────────────────
echo ""
echo "--- Probe: Page Subscription Error Shape ---"
SUB_ERROR=$(curl -s -X POST "${BASE}/0/subscribed_apps" \
  -H "Content-Type: application/json" \
  -d "{\"subscribed_fields\":\"messages\",\"access_token\":\"${APP_TOKEN}\"}")

probe "subscribe_webhooks_error" \
  "error error.message error.type error.code" \
  "$SUB_ERROR"

# ─── 6. Comment Endpoint Error Shape ────────────────────────────────────
echo ""
echo "--- Probe: Comment Endpoint Error Shape ---"
COMMENT_ERROR=$(curl -s -X POST "${BASE}/0/comments" \
  -H "Content-Type: application/json" \
  -d '{"message":"probe","access_token":"invalid"}')

probe "comment_endpoint_error" \
  "error error.message error.type error.code" \
  "$COMMENT_ERROR"

# ─── 7. App Info (verify app token works) ────────────────────────────────
echo ""
echo "--- Probe: App Info ---"
APP_INFO=$(curl -s "${BASE}/${META_APP_ID}?access_token=${APP_TOKEN}&fields=id,name")

probe "app_info" \
  "id name" \
  "$APP_INFO"

# ─── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "=== Summary: ${PROBES} probes, ${MISMATCHES} mismatches ==="
if [ "$MISMATCHES" -gt 0 ]; then
  echo -e "$REPORT"
  echo ""
  echo "Response shapes may have changed in ${VERSION}."
  echo "Review and update FIXTURES in meta-api-contract.test.ts"
  exit 1
else
  echo "All response shapes match expectations for ${VERSION}."
  exit 0
fi
