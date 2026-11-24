#!/usr/bin/env bash
set -euo pipefail

# Month-end builds remain available after the publisher rotates daily builds.
archive_url=https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-8.1.tar.xz
archive_sha256=41e9c565594c390622cf968d82fa4135d9e9a11d06c1515644288cbc844e3380
install_dir=$(mktemp -d "${RUNNER_TEMP:?}/ffmpeg.XXXXXXXX")
archive="$install_dir/ffmpeg.tar.xz"
trap 'rm -f -- "$archive"' EXIT

curl -fsSL --retry 3 --max-time 180 "$archive_url" -o "$archive"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$install_dir" --strip-components=1
printf '%s\n' "$install_dir/bin" >> "${GITHUB_PATH:?}"
