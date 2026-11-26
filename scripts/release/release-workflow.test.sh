#!/usr/bin/env bash
# The release gate is skipped on the manual PROD dispatch. A job with a skipped ancestor is skipped too
# unless its condition has a status function, so every job on that path (called workflows included) needs
# !cancelled() plus an explicit success check of each job it depends on, except the gate itself.
set -euo pipefail
cd "$(dirname "$0")/../.."
workflows=.github/workflows

# jobs <file>: one "name|needs|called workflow|condition" line per job.
jobs() {
    awk '
        function flush() { if (name != "") print name "|" needs "|" uses "|" cond; name = needs = uses = cond = ""; folded = 0 }
        /^[^ #]/ { flush(); in_jobs = /^jobs:/; next }
        !in_jobs { next }
        /^  [A-Za-z0-9_-]+:/ { flush(); name = $1; sub(/:$/, "", name); next }
        folded && /^      / { sub(/^ +/, ""); cond = cond " " $0; next }
        { folded = 0 }
        /^    if: [>|]/ { folded = 1; next }
        /^    if: / { sub(/^    if: /, ""); cond = $0 }
        /^    needs: / { sub(/^    needs: /, ""); gsub(/[][,]/, " "); needs = $0 }
        /^    uses: \.\// { uses = $2; sub(/.*\//, "", uses) }
        END { flush() }
    ' "$workflows/$1"
}

failures=0
checked=""
require() { # require <label> <needs> <condition>
    local need
    checked="$checked $1"
    [[ "$3" == *'!cancelled()'* ]] || { echo "FAIL: $1 lacks !cancelled()"; failures=$((failures + 1)); }
    for need in $2; do
        [ "$need" = release-gate ] && continue
        [[ "$3" == *"needs.$need.result == 'success'"* ]] ||
            { echo "FAIL: $1 does not require needs.$need.result == 'success'"; failures=$((failures + 1)); }
    done
}

# Jobs are declared after the jobs they need, so one pass finds everything behind the gate.
behind=" release-gate "
while IFS='|' read -r name needs uses cond; do
    for need in $needs; do
        [[ "$behind" == *" $need "* ]] || continue
        behind="$behind$name "
        # Push-only jobs never run on the dispatch.
        if [[ "$cond" == *"event_name == 'push'"* && "$cond" != *workflow_dispatch* ]]; then break; fi
        require "$name" "$needs" "$cond"
        if [ -n "$uses" ]; then
            while IFS='|' read -r inner inner_needs _ inner_cond; do
                require "$uses:$inner" "$inner_needs" "$inner_cond"
            done < <(jobs "$uses")
        fi
        break
    done
done < <(jobs release.yml)

# Guards against a parser that silently matches nothing.
expected=" live-telegram live-telegram.yml:resolve live-telegram.yml:smoke resolve-images deploy-prod deploy-release.yml:deploy"
[ "$checked" = "$expected" ] || { echo "FAIL: checked jobs:$checked; expected:$expected"; failures=$((failures + 1)); }

if [ "$failures" -ne 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo "ok release-workflow"
