#!/usr/bin/env bash
set -euo pipefail

archive_url=https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-24-12-41/ffmpeg-n8.1.3-41-ga8029b6528-linux64-gpl-8.1.tar.xz
archive_sha256=b4234c329574dd1d821ab79999f9e5e727045bf24d11847e1e14deba27cea5a8
install_dir=$(mktemp -d "${RUNNER_TEMP:?}/ffmpeg.XXXXXXXX")
archive="$install_dir/ffmpeg.tar.xz"
trap 'rm -f -- "$archive"' EXIT

curl -fsSL --retry 3 --max-time 180 "$archive_url" -o "$archive"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$install_dir" --strip-components=1
printf '%s\n' "$install_dir/bin" >> "${GITHUB_PATH:?}"
