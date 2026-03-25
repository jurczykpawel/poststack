#!/bin/bash
# Pre-commit security hook for ReplyStack
# Runs static security checks on staged changes before every git commit.
# Exit 2 = block commit with error message
# Exit 0 = allow commit

set -euo pipefail

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)
if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Only check TypeScript/JavaScript source files
TS_FILES=$(echo "$STAGED_FILES" | grep -E '\.(ts|tsx|js)$' | grep -v 'node_modules' | grep -v 'generated' || true)
if [ -z "$TS_FILES" ]; then
  exit 0
fi

DIFF=$(git diff --cached -- $TS_FILES 2>/dev/null)
ERRORS=()

# ─────────────────────────────────────────────
# 1. Hardcoded secrets / credentials
# ─────────────────────────────────────────────
if echo "$DIFF" | grep -qE '^\+.*(password|secret|api_key|apikey|private_key)\s*=\s*["'"'"'][^${\s]{8,}["'"'"']' 2>/dev/null; then
  ERRORS+=("Possible hardcoded credential detected. Use environment variables instead.")
fi

# Meta/Stripe/JWT keys hardcoded (not in .env files)
NON_ENV_FILES=$(echo "$TS_FILES" | grep -v '\.env' || true)
if [ -n "$NON_ENV_FILES" ]; then
  if git diff --cached -- $NON_ENV_FILES 2>/dev/null | grep -qE '^\+.*(sk_live_|rk_live_|whsec_[a-zA-Z0-9]{20,}|rs_live_[a-zA-Z0-9]{20,})'; then
    ERRORS+=("Possible hardcoded API key in source file (not .env). Remove before committing.")
  fi
fi

# ─────────────────────────────────────────────
# 2. fetch() with redirect: follow (SSRF risk)
# ─────────────────────────────────────────────
if echo "$DIFF" | grep -qE "^\+.*fetch\(.*redirect:\s*['\"]follow['\"]" 2>/dev/null; then
  ERRORS+=("fetch() with redirect: 'follow' detected. Use redirect: 'error' to prevent SSRF via redirect chains.")
fi

# ─────────────────────────────────────────────
# 3. eval() usage
# ─────────────────────────────────────────────
if echo "$DIFF" | grep -qE '^\+[^/]*[^a-z]eval\(' 2>/dev/null; then
  ERRORS+=("eval() usage detected. This is a security risk -- use safer alternatives.")
fi

# ─────────────────────────────────────────────
# 4. SQL string concatenation (injection risk)
# ─────────────────────────────────────────────
if echo "$DIFF" | grep -qE '^\+.*\`(SELECT|INSERT|UPDATE|DELETE|DROP).*\$\{' 2>/dev/null; then
  ERRORS+=("SQL string interpolation detected. Use Prisma client with parameterized queries instead.")
fi

# ─────────────────────────────────────────────
# 5. Token encryption key fallback
# ─────────────────────────────────────────────
if echo "$DIFF" | grep -qE '^\+.*TOKEN_ENCRYPTION_KEY.*\|\|.*["'"'"']' 2>/dev/null; then
  ERRORS+=("TOKEN_ENCRYPTION_KEY with fallback value detected. Missing key must throw, never use a default.")
fi

# ─────────────────────────────────────────────
# 6. Prisma raw queries (injection risk)
# ─────────────────────────────────────────────
if echo "$DIFF" | grep -qE '^\+.*\$queryRaw.*\$\{|^\+.*\$executeRaw.*\$\{' 2>/dev/null; then
  ERRORS+=("Prisma raw query with string interpolation detected. Use Prisma.sql tagged template or parameterized queries.")
fi

# ─────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────
if [ ${#ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Security pre-commit check found ${#ERRORS[@]} issue(s):"
  echo ""
  for err in "${ERRORS[@]}"; do
    echo "  !  $err"
  done
  echo ""
  echo "To skip this check (not recommended): git commit --no-verify"
  echo ""
  exit 2
fi

exit 0
