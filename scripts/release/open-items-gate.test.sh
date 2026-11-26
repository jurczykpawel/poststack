#!/usr/bin/env bash
# Tests for open-items-gate.sh against a fake gh that serves canned JSON per endpoint.
# shellcheck disable=SC2034 # FAKE_* variables are exported (set -a) and read by the fake gh
set -euo pipefail
GATE="$(cd "$(dirname "$0")" && pwd)/open-items-gate.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<'GH'
#!/usr/bin/env bash
# Fake gh: `gh api --paginate <endpoint>`. FAKE_<KEY> = response body, FAKE_FAIL_<KEY> = stderr of a failure.
[ "$1 $2" = "api --paginate" ] || { echo "fake gh: unexpected call: $*" >&2; exit 9; }
case "$3" in
    */pulls\?*) key=PULLS ;;
    */issues\?*) key=ISSUES ;;
    */code-scanning/*) key=CODE ;;
    */dependabot/*) key=DEPENDABOT ;;
    */secret-scanning/*) key=SECRETS ;;
    */security-advisories\?*) key=ADVISORIES ;;
    *) echo "fake gh: unexpected endpoint: $3" >&2; exit 9 ;;
esac
echo "$key token=${GH_TOKEN:-}" >> "$FAKE_LOG"
fail="FAKE_FAIL_$key"
if [ -n "${!fail:-}" ]; then echo "${!fail}" >&2; exit 1; fi
body="FAKE_$key"
printf '%s\n' "${!body-[]}"
GH
chmod +x "$WORK/bin/gh"
export PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK/gh.log" GATE_REPO=acme/app GH_TOKEN=default-token
unset GITHUB_ACTIONS RELEASE_GATE_TOKEN GATE_DEFER_LABEL GATE_CRITICAL_LABELS GATE_DEFER_MAX_DAYS
set -a # every FAKE_* assignment below must reach the fake gh

failures=0
fail() { echo "FAIL: $1"; sed 's/^/    /' "$WORK/out"; failures=$((failures + 1)); }
reset() {
    unset FAKE_PULLS FAKE_ISSUES FAKE_CODE FAKE_DEPENDABOT FAKE_SECRETS FAKE_ADVISORIES \
        FAKE_FAIL_PULLS FAKE_FAIL_ISSUES FAKE_FAIL_CODE FAKE_FAIL_DEPENDABOT FAKE_FAIL_SECRETS \
        FAKE_FAIL_ADVISORIES GITHUB_ACTIONS RELEASE_GATE_TOKEN GATE_DEFER_LABEL GATE_CRITICAL_LABELS \
        GATE_DEFER_MAX_DAYS
    : > "$FAKE_LOG"
}
run() { bash "$GATE" "$@" > "$WORK/out" 2>&1; }
# expect <name> <exit code> [text that must appear] -- runs the gate in release mode
expect() {
    local code=0
    run || code=$?
    [ "$code" = "$2" ] || { fail "$1: exit $code, expected $2"; return; }
    if [ -n "${3:-}" ] && ! grep -qF -- "$3" "$WORK/out"; then fail "$1: output lacks '$3'"; fi
}
days_ago() { jq -nr --argjson days "$1" 'now - $days * 86400 | floor | todate'; }
item() { # item <number> <title> <labels JSON array> [extra JSON fields] [created_at]
    printf '{"number":%s,"title":"%s","html_url":"https://github.com/acme/app/%s","created_at":"%s","labels":%s%s}' \
        "$1" "$2" "$1" "${5:-$(days_ago 1)}" "$(jq -c 'map({name: .})' <<< "$3")" "${4:-}"
}

reset; expect "nothing open" 0 "nothing open in acme/app"

reset; FAKE_PULLS="[$(item 7 'chore(deps): bump x' '["dependencies"]')]"
expect "open pull request" 1 "#7 chore(deps): bump x — https://github.com/acme/app/7"

reset; FAKE_ISSUES="[$(item 8 'Crash on save' '["enhancement"]')]"
expect "open issue" 1 "#8 Crash on save"

reset; FAKE_ISSUES="[$(item 9 'PR seen as issue' '[]' ',"pull_request":{}')]"
expect "pull requests are not counted again as issues" 0

reset; FAKE_DEPENDABOT='[{"number":3,"html_url":"https://github.com/acme/app/security/dependabot/3","security_advisory":{"severity":"high","summary":"ReDoS"},"dependency":{"package":{"ecosystem":"npm","name":"lodash"}}}]'
expect "open Dependabot alert" 1 "#3 high npm/lodash: ReDoS"

reset; FAKE_SECRETS='[{"number":4,"secret":"sk_live_do_not_print","secret_type_display_name":"Stripe API Key","html_url":"https://github.com/acme/app/security/secret-scanning/4"}]'
expect "open secret scanning alert" 1 "#4 Stripe API Key"
grep -q sk_live_do_not_print "$WORK/out" && fail "secret value printed"

reset; FAKE_CODE='[{"number":5,"rule":{"id":"js/xss","severity":"error","description":"XSS"},"html_url":"https://github.com/acme/app/security/code-scanning/5"}]'
expect "open code scanning alert" 1 "#5 error XSS"

reset; FAKE_ADVISORIES='[{"ghsa_id":"GHSA-aaaa","state":"draft","summary":"Token leak","html_url":"u1"},{"ghsa_id":"GHSA-bbbb","state":"published","summary":"Old","html_url":"u2"}]'
expect "draft security advisory" 1 "GHSA-aaaa [draft] Token leak"
grep -q GHSA-bbbb "$WORK/out" && fail "published advisory listed"

reset; FAKE_ADVISORIES='[{"ghsa_id":"GHSA-cccc","state":"triage","summary":"Report","html_url":"u"}]'
expect "advisory in triage" 1 "GHSA-cccc [triage] Report"

reset; FAKE_FAIL_CODE='gh: no analysis found (HTTP 404)'
expect "code scanning without analysis counts as nothing open" 0

reset; FAKE_FAIL_CODE='gh: Advanced Security must be enabled for this repository to use code scanning. (HTTP 403)'
expect "other code scanning error fails closed" 1 "could not read Open code scanning alerts"

reset; FAKE_FAIL_PULLS='gh: Bad credentials (HTTP 401)'
expect "API error fails closed" 1 "could not read Open pull requests"

reset; FAKE_PULLS='not json'
expect "unexpected response fails closed" 1 "unexpected response for Open pull requests"

for source in PULLS ISSUES CODE DEPENDABOT SECRETS ADVISORIES; do
    reset; declare "FAKE_$source="
    expect "empty $source response fails closed" 1 "unexpected response for"
    reset; declare "FAKE_$source={}"
    expect "non-array $source response fails closed" 1 "unexpected response for"
done

reset; FAKE_PULLS='[]
{}'
expect "non-array later page fails closed" 1 "unexpected response for Open pull requests"

reset; FAKE_PULLS="[$(item 1 'first page' '[]')]
[$(item 2 'second page' '[]')]"
expect "every page is checked" 1 "#2 second page"

reset; export GITHUB_ACTIONS=true
expect "missing RELEASE_GATE_TOKEN in Actions fails with instructions" 1 "gh secret set RELEASE_GATE_TOKEN --repo acme/app"
grep -qF "Repository security advisories" "$WORK/out" || fail "token instructions lack the permissions"
grep -qE 'DEPENDABOT|SECRETS|ADVISORIES' "$FAKE_LOG" && fail "security sources read with GITHUB_TOKEN"

reset; export GITHUB_ACTIONS=true RELEASE_GATE_TOKEN=gate-token
expect "Actions with RELEASE_GATE_TOKEN" 0
[ "$(grep -c 'token=gate-token' "$FAKE_LOG")" = 3 ] || fail "security sources not read with RELEASE_GATE_TOKEN"
[ "$(grep -c 'token=default-token' "$FAKE_LOG")" = 3 ] || fail "pull requests/issues/code scanning not read with GH_TOKEN"

reset; expect "locally gh's own login reads security sources" 0
[ "$(grep -cE '^(DEPENDABOT|SECRETS|ADVISORIES)' "$FAKE_LOG")" = 3 ] || fail "security sources skipped locally"

# Deferral label
reset; FAKE_PULLS="[$(item 10 'Bump tool image' '["dependencies","deferred-next-release"]')]"
expect "deferred non-critical pull request does not block" 0 "#10 Bump tool image"
grep -qF "Deferred to the next release" "$WORK/out" || fail "deferred item not reported"

reset; FAKE_ISSUES="[$(item 11 'Login broken' '["bug","deferred-next-release"]')]"
expect "deferral label on a bug blocks" 1 "deferred-next-release is not allowed on bug items"

reset; FAKE_PULLS="[$(item 12 'Fix auth bypass' '["security","deferred-next-release"]')]"
expect "deferral label on a security item blocks" 1 "is not allowed on security items"

reset; FAKE_ISSUES="[$(item 13 'No labels' '[]')]"
expect "item without labels blocks" 1 "#13 No labels"

reset; export GATE_DEFER_LABEL=later
FAKE_ISSUES="[$(item 14 'Docs typo' '["later"]')]"
expect "deferral label name comes from the environment" 0
FAKE_ISSUES="[$(item 14 'Docs typo' '["deferred-next-release"]')]"
expect "default deferral label not honoured when renamed" 1 "#14 Docs typo"

reset; export GATE_CRITICAL_LABELS="type: bug, regression"
FAKE_ISSUES="[$(item 15 'Regressed' '["regression","deferred-next-release"]')]"
expect "critical labels come from the environment" 1 "not allowed on regression items"

# Label spelling and issue types
reset; FAKE_ISSUES="[$(item 17 'Capitalised' '["Bug","deferred-next-release"]')]"
expect "critical label matches regardless of case" 1 "is not allowed on bug items"
reset; FAKE_PULLS="[$(item 18 'Capitalised' '["Security","Deferred-Next-Release"]')]"
expect "critical and deferral labels match regardless of case" 1 "is not allowed on security items"
reset; FAKE_ISSUES="[$(item 19 'Typo' '["Deferred-Next-Release"]')]"
expect "deferral label matches regardless of case" 0 "#19 Typo"
reset; export GATE_CRITICAL_LABELS="Regression"
FAKE_ISSUES="[$(item 20 'Regressed' '["regression","deferred-next-release"]')]"
expect "configured critical labels match regardless of case" 1 "not allowed on regression items"

reset; FAKE_ISSUES="[$(item 21 'Typed' '["deferred-next-release"]' ',"type":{"name":"Bug"}')]"
expect "issue type Bug cannot be deferred" 1 "is not allowed on bug items"
reset; FAKE_ISSUES="[$(item 22 'Chore' '["deferred-next-release"]' ',"type":{"name":"Task"}')]"
expect "non-critical issue type can be deferred" 0 "#22 Chore"
reset; FAKE_ISSUES="[$(item 23 'Untyped' '["deferred-next-release"]' ',"type":null')]"
expect "issue without a type can be deferred" 0 "#23 Untyped"

# Deferral expiry
reset; FAKE_PULLS="[$(item 24 'Old bump' '["deferred-next-release"]' '' 2025-03-01T00:00:00Z)]"
expect "old deferred item blocks" 1 "#24 Old bump — https://github.com/acme/app/24 (deferral expired: open for more than 30 days)"
reset; FAKE_ISSUES="[$(item 25 'Recent' '["deferred-next-release"]' '' "$(days_ago 29)")]"
expect "deferred item within the limit passes" 0 "#25 Recent"
reset; FAKE_ISSUES="[$(item 26 'Just over' '["deferred-next-release"]' '' "$(days_ago 31)")]"
expect "deferred item past the limit blocks" 1 "deferral expired"
reset; export GATE_DEFER_MAX_DAYS=60
FAKE_ISSUES="[$(item 27 'Longer limit' '["deferred-next-release"]' '' "$(days_ago 31)")]"
expect "deferral limit comes from the environment" 0
reset; export GATE_DEFER_MAX_DAYS=soon
expect "invalid deferral limit fails closed" 1 "GATE_DEFER_MAX_DAYS must be a whole number"
reset; FAKE_ISSUES='[{"number":28,"title":"Undated","html_url":"u","labels":[{"name":"deferred-next-release"}]}]'
expect "deferred item without a creation date fails closed" 1 "unexpected response for Open issues"

# Modes
reset; FAKE_PULLS="[$(item 16 'Open work' '[]')]"
code=0; run start || code=$?
if [ "$code" != 1 ] || ! grep -qF "Release cycle cannot start" "$WORK/out"; then fail "start mode does not block with its own message"; fi
reset; run start || fail "start mode with nothing open"
reset; code=0; run deploy || code=$?
[ "$code" = 2 ] || fail "unknown mode accepted"

if [ "$failures" -ne 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo "ok open-items-gate"
