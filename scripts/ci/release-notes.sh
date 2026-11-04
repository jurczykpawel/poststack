#!/usr/bin/env bash
# Print the CHANGELOG.md section for one version (e.g. 0.17.1), without its heading.
# Exits non-zero when the section is missing, so a release never goes out with empty notes.
set -euo pipefail
v="${1#v}"
awk -v v="$v" '
  /^## \[/ { if (on) exit; on = index($0, "## [" v "]") == 1; next }
  on { print }
' "${2:-CHANGELOG.md}" | sed -e '/./,$!d' > /tmp/release-notes.$$
[ -s /tmp/release-notes.$$ ] || { echo "No CHANGELOG section for $v" >&2; rm -f /tmp/release-notes.$$; exit 1; }
cat /tmp/release-notes.$$; rm -f /tmp/release-notes.$$
