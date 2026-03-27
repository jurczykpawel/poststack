#!/usr/bin/env bash
#
# Meta Graph API Version Probe
#
# Verifies that Meta Graph API response shapes match what our code expects.
# Uses a permanent page access token to test real success responses.
#
# Required env vars:
#   META_PAGE_ACCESS_TOKEN — never-expiring page token
#   META_PAGE_ID           — Facebook Page ID
#
# Optional (enables extra probes):
#   META_APP_ID            — App ID (for app token + debug_token probes)
#   META_APP_SECRET        — App Secret
#
# Usage:
#   META_PAGE_ACCESS_TOKEN=xxx META_PAGE_ID=yyy ./scripts/meta-api-probe.sh [version]
#
# Exit codes:
#   0 = all probes passed (or skipped due to missing credentials)
#   1 = shape mismatch detected
#

set -euo pipefail

VERSION="${1:-v25.0}"
BASE="https://graph.facebook.com/${VERSION}"
PAGE_TOKEN="${META_PAGE_ACCESS_TOKEN:-}"
PAGE_ID="${META_PAGE_ID:-}"
APP_ID="${META_APP_ID:-}"
APP_SECRET="${META_APP_SECRET:-}"

if [ -z "$PAGE_TOKEN" ] || [ -z "$PAGE_ID" ]; then
  echo "SKIP: META_PAGE_ACCESS_TOKEN and META_PAGE_ID not set, skipping API probe"
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
obj = data
for key in '${field}'.split('.'):
  if isinstance(obj, list):
    obj = obj[0] if obj else {}
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
    REPORT="${REPORT}\n  FAIL ${name}: missing fields:${missing}"
    echo "FAIL: ${name} — missing fields:${missing}"
  else
    echo "OK:   ${name}"
  fi
}

echo "=== Meta Graph API Probe — ${VERSION} ==="
echo ""

# ─── 1. Page Info (basic connectivity check) ─────────────────────────────
echo "--- Probe: Page Info ---"
PAGE_INFO=$(curl -s "${BASE}/${PAGE_ID}?access_token=${PAGE_TOKEN}&fields=id,name")
probe "page_info" "id name" "$PAGE_INFO"

# ─── 2. /me/accounts — error shape verification ──────────────────────────
# Full success response requires a user token (only available during OAuth flow).
# With a page token we verify the endpoint exists and returns a standard error.
echo ""
echo "--- Probe: /me/accounts (error shape with page token) ---"
ACCOUNTS_ERR=$(curl -s "${BASE}/me/accounts?access_token=${PAGE_TOKEN}&fields=id,name&limit=1")
probe "me_accounts_error" "error error.message error.type error.code" "$ACCOUNTS_ERR"

# ─── 3. /{page-id}/feed — posts response shape ──────────────────────────
# Our rules UI fetches posts for comment_keyword rules
echo ""
echo "--- Probe: /{page-id}/feed (posts) ---"
FEED=$(curl -s "${BASE}/${PAGE_ID}/feed?access_token=${PAGE_TOKEN}&fields=id,message,created_time,full_picture,permalink_url&limit=2")
probe "page_feed" "data" "$FEED"

if echo "$FEED" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['data']" 2>/dev/null; then
  probe "page_feed_fields" "data.id data.created_time" "$FEED"
fi

# ─── 4. /debug_token — token introspection ───────────────────────────────
echo ""
echo "--- Probe: debug_token ---"
if [ -n "$APP_ID" ] && [ -n "$APP_SECRET" ]; then
  DEBUG=$(curl -s "${BASE}/debug_token?input_token=${PAGE_TOKEN}&access_token=${APP_ID}|${APP_SECRET}")
  probe "debug_token" "data data.app_id data.type data.is_valid" "$DEBUG"
else
  # Can also debug with the token itself
  DEBUG=$(curl -s "${BASE}/debug_token?input_token=${PAGE_TOKEN}&access_token=${PAGE_TOKEN}")
  probe "debug_token" "data data.type data.is_valid" "$DEBUG"
fi

# ─── 5. /{page-id}/subscribed_apps — webhook subscription ────────────────
# Our OAuth callback calls this to auto-subscribe pages
echo ""
echo "--- Probe: subscribed_apps (read current) ---"
SUBS=$(curl -s "${BASE}/${PAGE_ID}/subscribed_apps?access_token=${PAGE_TOKEN}")
probe "subscribed_apps_read" "data" "$SUBS"

# ─── 6. Send Message Error Shape ─────────────────────────────────────────
# We can't send a real message (no PSID), but verify the error shape
echo ""
echo "--- Probe: Send Message (error shape) ---"
SEND_ERROR=$(curl -s -X POST "${BASE}/me/messages" \
  -H "Content-Type: application/json" \
  -d "{\"recipient\":{\"id\":\"0\"},\"message\":{\"text\":\"probe\"},\"access_token\":\"${PAGE_TOKEN}\"}")
probe "send_message_error" "error error.message error.type error.code" "$SEND_ERROR"

# ─── 7. Comment Error Shape ──────────────────────────────────────────────
echo ""
echo "--- Probe: Comment (error shape) ---"
COMMENT_ERROR=$(curl -s -X POST "${BASE}/0/comments" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"probe\",\"access_token\":\"${PAGE_TOKEN}\"}")
probe "comment_error" "error error.message error.type error.code" "$COMMENT_ERROR"

# ─── 8. App Token Exchange (if app credentials available) ─────────────────
if [ -n "$APP_ID" ] && [ -n "$APP_SECRET" ]; then
  echo ""
  echo "--- Probe: App Token Exchange ---"
  APP_TOKEN_RESPONSE=$(curl -s "${BASE}/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&grant_type=client_credentials")
  probe "app_token_exchange" "access_token token_type" "$APP_TOKEN_RESPONSE"

  echo ""
  echo "--- Probe: Token Exchange Error Shape ---"
  TOKEN_ERROR=$(curl -s "${BASE}/oauth/access_token?client_id=${APP_ID}&client_secret=${APP_SECRET}&redirect_uri=https://localhost/test&code=invalid_code")
  probe "token_exchange_error" "error error.message error.type error.code" "$TOKEN_ERROR"
fi

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
