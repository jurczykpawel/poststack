#!/usr/bin/env bash
# Release gate: refuse a release while anything is left open in the GitHub repository.
#
# Usage: open-items-gate.sh [start|release]
#   start    run when work on a release begins, before the full test gate, so open pull requests
#            and issues land in the candidate before it is tested
#   release  (default) run on the release tag; confirms nothing new is open
#
# Checks: (a) open pull requests, (b) open issues, (c) open Dependabot alerts, (d) open secret
# scanning alerts, (e) open code scanning alerts (no analysis yet = nothing open), (f) repository
# security advisories in triage or draft. Anything open exits 1 with the list; so does any API
# error (fail closed).
#
# The only way to let an item wait: a pull request or issue that carries the deferral label and
# none of the critical labels. Security alerts (c-f) can never be deferred, and the deferral label
# on a critical item keeps the gate red.
#
# Repository-agnostic; configured only through the environment:
#   GATE_REPO             owner/name. Default: $GITHUB_REPOSITORY, else the repository of the checkout (gh).
#   GATE_DEFER_LABEL      deferral label. Default: deferred-next-release.
#   GATE_CRITICAL_LABELS  comma-separated labels that can never be deferred. Default: bug,security.
#   GH_TOKEN              token for (a), (b), (e). In GitHub Actions: GITHUB_TOKEN with
#                         pull-requests: read, issues: read, security-events: read. Locally: gh's own login.
#   RELEASE_GATE_TOKEN    token for (c), (d), (f), which GITHUB_TOKEN cannot read. Required in GitHub
#                         Actions (the error message lists the exact permissions). Locally optional:
#                         gh's own login is used when it is unset.
# Requires: gh (GitHub CLI), jq.

set -uo pipefail

mode="${1:-release}"
case "$mode" in
    start|release) ;;
    *) echo "usage: $0 [start|release]" >&2; exit 2 ;;
esac

for tool in gh jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "release gate: $tool is required." >&2
        exit 1
    fi
done

repo="${GATE_REPO:-${GITHUB_REPOSITORY:-}}"
if [ -z "$repo" ] && ! repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null); then
    echo "release gate: could not determine the repository (set GATE_REPO=owner/name)." >&2
    exit 1
fi
defer_label="${GATE_DEFER_LABEL:-deferred-next-release}"
critical_labels="${GATE_CRITICAL_LABELS:-bug,security}"

err_file=$(mktemp)
trap 'rm -f "$err_file"' EXIT
status=0
deferred=""

# shellcheck disable=SC2016 # jq variables, not shell ones
# Pull requests and issues: "B<TAB>line" blocks, "D<TAB>line" is deferred.
items_filter='
  ($critical_csv | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != ""))) as $critical
  | .[] | select(.pull_request | not)
  | [.labels[]?.name] as $labels
  | ($labels - ($labels - $critical)) as $hit
  | "#\(.number) \(.title) — \(.html_url)" as $line
  | if ($labels | index($defer)) == null then "B\t\($line)"
    elif ($hit | length) > 0 then "B\t\($line) (\($defer) is not allowed on \($hit | join("/")) items)"
    else "D\t\($line)" end'
# The pulls endpoint has no pull_request key; the issues endpoint marks pull requests with it.

# fetch <default|security> <endpoint>: prints the raw JSON pages.
fetch() {
    if [ "$1" = security ] && [ -n "${RELEASE_GATE_TOKEN:-}" ]; then
        GH_TOKEN="$RELEASE_GATE_TOKEN" gh api --paginate "$2" 2>"$err_file"
    else
        gh api --paginate "$2" 2>"$err_file"
    fi
}

# check <title> <default|security> <endpoint> <jq filter> [tolerated error pattern]
# Security filters print plain lines (always blocking); item filters print B/D-tagged lines.
check() {
    local json out line blocking=""
    if ! json=$(fetch "$2" "$3"); then
        if [ -n "${5:-}" ] && grep -Eq "$5" "$err_file"; then
            return
        fi
        echo "release gate: could not read $1: $(tr '\n' ' ' < "$err_file")" >&2
        status=1
        return
    fi
    if ! out=$(jq -r --arg defer "$defer_label" --arg critical_csv "$critical_labels" "$4" <<< "$json" 2>"$err_file"); then
        echo "release gate: unexpected response for $1: $(tr '\n' ' ' < "$err_file")" >&2
        status=1
        return
    fi
    while IFS= read -r line; do
        case "$line" in
            "") ;;
            D$'\t'*) deferred="$deferred  ${line#D$'\t'}"$'\n' ;;
            B$'\t'*) blocking="$blocking  ${line#B$'\t'}"$'\n' ;;
            *) blocking="$blocking  $line"$'\n' ;;
        esac
    done <<< "$out"
    [ -z "$blocking" ] && return
    printf '%s:\n%s' "$1" "$blocking" >&2
    status=1
}

api="repos/$repo"

check "Open pull requests" default "$api/pulls?state=open&per_page=100" "$items_filter"
check "Open issues" default "$api/issues?state=open&per_page=100" "$items_filter"
check "Open code scanning alerts" default "$api/code-scanning/alerts?state=open&per_page=100" \
    '.[] | "#\(.number) \(.rule.severity // "") \(.rule.description // .rule.id) — \(.html_url)"' \
    'no analysis found.*HTTP 404'

if [ -z "${RELEASE_GATE_TOKEN:-}" ] && [ "${GITHUB_ACTIONS:-}" = true ]; then
    cat >&2 <<EOF
release gate: the RELEASE_GATE_TOKEN secret is missing, so Dependabot alerts, secret scanning
alerts and security advisories cannot be checked (GITHUB_TOKEN cannot read them).
Create a fine-grained personal access token as a repository administrator (only administrators
see unpublished advisories and secret scanning alerts):
  Repository access: only $repo
  Repository permissions, all Read-only: Dependabot alerts, Secret scanning alerts,
  Repository security advisories (Metadata: Read is added automatically)
Then save it as an Actions secret: gh secret set RELEASE_GATE_TOKEN --repo $repo
EOF
    status=1
else
    check "Open Dependabot alerts" security "$api/dependabot/alerts?state=open&per_page=100" \
        '.[] | "#\(.number) \(.security_advisory.severity) \(.dependency.package.ecosystem)/\(.dependency.package.name): \(.security_advisory.summary) — \(.html_url)"'
    check "Open secret scanning alerts" security "$api/secret-scanning/alerts?state=open&per_page=100" \
        '.[] | "#\(.number) \(.secret_type_display_name // .secret_type) — \(.html_url)"'
    check "Security advisories in triage or draft" security "$api/security-advisories?per_page=100" \
        '.[] | select(.state == "triage" or .state == "draft") | "\(.ghsa_id) [\(.state)] \(.summary) — \(.html_url)"'
fi

if [ -n "$deferred" ]; then
    printf 'Deferred to the next release with label %s (not blocking):\n%s' "$defer_label" "$deferred"
fi

if [ "$status" -ne 0 ]; then
    if [ "$mode" = start ]; then
        msg="Release cycle cannot start: merge, fix or close everything listed above in $repo before the full test gate, so it lands in the candidate. Only a non-critical pull request or issue may wait, with label $defer_label."
    else
        msg="Release blocked: handle everything listed above in $repo (merge, fix or close; only a non-critical pull request or issue may wait, with label $defer_label), then release again."
    fi
    if [ "${GITHUB_ACTIONS:-}" = true ]; then echo "::error::$msg" >&2; else echo "$msg" >&2; fi
    exit 1
fi
echo "Release gate ($mode): nothing open in $repo."
