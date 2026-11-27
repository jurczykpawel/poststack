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
# error or a response that is not a JSON array (fail closed).
#
# In GitHub Actions only GITHUB_TOKEN is used, and it cannot read (d) and (f): those two are skipped
# there with an explicit note and are checked only locally, with gh's own login, by the mandatory
# "start" run at the beginning of every release cycle (and the manual run before the tag).
#
# The only way to let an item wait: a pull request or issue that carries the deferral label and
# none of the critical labels, until it has been open for GATE_DEFER_MAX_DAYS. An issue type counts
# as a critical label of the same name; names are compared ignoring case. Security alerts (c-f) can
# never be deferred, and the deferral label on a critical item keeps the gate red.
#
# Repository-agnostic; configured only through the environment:
#   GATE_REPO             owner/name. Default: $GITHUB_REPOSITORY, else the repository of the checkout (gh).
#   GATE_DEFER_LABEL      deferral label. Default: deferred-next-release.
#   GATE_CRITICAL_LABELS  comma-separated labels that can never be deferred. Default: bug,security.
#   GATE_DEFER_MAX_DAYS   days since creation after which a deferred item blocks again. Default: 30.
#   GH_TOKEN              In GitHub Actions: GITHUB_TOKEN with pull-requests: read, issues: read,
#                         security-events: read, vulnerability-alerts: read. Locally: gh's own login.
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
defer_max_days="${GATE_DEFER_MAX_DAYS:-30}"
if ! [[ "$defer_max_days" =~ ^[0-9]+$ ]]; then
    echo "release gate: GATE_DEFER_MAX_DAYS must be a whole number of days." >&2
    exit 1
fi

err_file=$(mktemp)
trap 'rm -f "$err_file"' EXIT
status=0
deferred=""

# shellcheck disable=SC2016 # jq variables, not shell ones
# Pull requests and issues: "B<TAB>line" blocks, "D<TAB>line" is deferred.
items_filter='
  ($critical_csv | ascii_downcase | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(. != ""))) as $critical
  | .[] | select(.pull_request | not)
  | [.labels[]?.name | ascii_downcase] as $labels
  | ($labels + [.type.name? // empty | ascii_downcase] | unique) as $kinds
  | ($kinds - ($kinds - $critical)) as $hit
  | "#\(.number) \(.title) — \(.html_url)" as $line
  | if ($labels | index($defer | ascii_downcase)) == null then "B\t\($line)"
    elif ($hit | length) > 0 then "B\t\($line) (\($defer) is not allowed on \($hit | join("/")) items)"
    elif now - (.created_at | fromdateiso8601) > $max_days * 86400 then
      "B\t\($line) (deferral expired: open for more than \($max_days) days)"
    else "D\t\($line)" end'
# The pulls endpoint has no pull_request key; the issues endpoint marks pull requests with it.

in_actions=false
[ "${GITHUB_ACTIONS:-}" = true ] && in_actions=true

# check <title> <endpoint> <jq filter> [tolerated error pattern] [hint shown on HTTP 403]
# Security filters print plain lines (always blocking); item filters print B/D-tagged lines.
check() {
    local json out line blocking=""
    if ! json=$(gh api --paginate "$2" 2>"$err_file"); then
        if [ -n "${4:-}" ] && grep -Eq "$4" "$err_file"; then
            return
        fi
        echo "release gate: could not read $1: $(tr '\n' ' ' < "$err_file")" >&2
        if [ -n "${5:-}" ] && grep -q 'HTTP 403' "$err_file"; then
            echo "release gate: $5" >&2
        fi
        status=1
        return
    fi
    # An empty body or another JSON type would pass the filters as "nothing open".
    if ! jq -es 'length > 0 and all(.[]; type == "array")' <<< "$json" >/dev/null 2>"$err_file"; then
        echo "release gate: unexpected response for $1: expected a JSON array. $(tr '\n' ' ' < "$err_file")" >&2
        status=1
        return
    fi
    if ! out=$(jq -r --arg defer "$defer_label" --arg critical_csv "$critical_labels" \
        --argjson max_days "$defer_max_days" "$3" <<< "$json" 2>"$err_file"); then
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

check "Open pull requests" "$api/pulls?state=open&per_page=100" "$items_filter"
check "Open issues" "$api/issues?state=open&per_page=100" "$items_filter"
check "Open code scanning alerts" "$api/code-scanning/alerts?state=open&per_page=100" \
    '.[] | "#\(.number) \(.rule.severity // "") \(.rule.description // .rule.id) — \(.html_url)"' \
    'no analysis found.*HTTP 404'
dependabot_hint=""
$in_actions && dependabot_hint="GITHUB_TOKEN cannot read Dependabot alerts here — tell the coordinator."
check "Open Dependabot alerts" "$api/dependabot/alerts?state=open&per_page=100" \
    '.[] | "#\(.number) \(.security_advisory.severity) \(.dependency.package.ecosystem)/\(.dependency.package.name): \(.security_advisory.summary) — \(.html_url)"' \
    '' "$dependabot_hint"

if $in_actions; then
    # GITHUB_TOKEN has no permission for these two; never pass them silently.
    echo "Secret scanning alerts and security advisories: not checked in GitHub Actions (GITHUB_TOKEN cannot read them); checked locally at cycle start (open-items-gate.sh start with gh login)."
else
    check "Open secret scanning alerts" "$api/secret-scanning/alerts?state=open&per_page=100" \
        '.[] | "#\(.number) \(.secret_type_display_name // .secret_type) — \(.html_url)"'
    check "Security advisories in triage or draft" "$api/security-advisories?per_page=100" \
        '.[] | select(.state == "triage" or .state == "draft") | "\(.ghsa_id) [\(.state)] \(.summary) — \(.html_url)"'
fi

if [ -n "$deferred" ]; then
    printf 'Deferred to the next release with label %s (not blocking):\n%s' "$defer_label" "$deferred"
fi

if [ "$status" -ne 0 ]; then
    if [ "$mode" = start ]; then
        msg="Release cycle cannot start: merge, fix or close everything listed above in $repo before the full test gate, so it lands in the candidate. Only a non-critical pull request or issue may wait, with label $defer_label, for at most $defer_max_days days since it was opened."
    else
        msg="Release blocked: handle everything listed above in $repo (merge, fix or close; only a non-critical pull request or issue may wait, with label $defer_label, for at most $defer_max_days days since it was opened), then release again."
    fi
    if $in_actions; then echo "::error::$msg" >&2; else echo "$msg" >&2; fi
    exit 1
fi
echo "Release gate ($mode): nothing open in $repo."
