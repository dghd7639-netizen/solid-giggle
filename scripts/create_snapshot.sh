#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="/Users/hanbala/plugins/gpt-image-plugin"
TIMESTAMP="${1:-$(date '+%Y%m%d-%H%M%S')}"
SNAPSHOT_DIR="$ROOT_DIR/versions/$TIMESTAMP"
PROJECT_ARCHIVE="$SNAPSHOT_DIR/gpt-image-plugin-project.tar.gz"
CODEX_PLUGIN_ARCHIVE="$SNAPSHOT_DIR/gpt-image-plugin-codex-plugin.tar.gz"
MANIFEST_PATH="$SNAPSHOT_DIR/manifest.json"

mkdir -p "$SNAPSHOT_DIR"

tar \
  --exclude='./versions' \
  -czf "$PROJECT_ARCHIVE" \
  -C "$ROOT_DIR" .

tar \
  -czf "$CODEX_PLUGIN_ARCHIVE" \
  -C "$(dirname "$PLUGIN_DIR")" \
  "$(basename "$PLUGIN_DIR")"

cat > "$MANIFEST_PATH" <<EOF
{
  "snapshotId": "$TIMESTAMP",
  "createdAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "projectRoot": "$ROOT_DIR",
  "pluginRoot": "$PLUGIN_DIR",
  "projectArchive": "$PROJECT_ARCHIVE",
  "pluginArchive": "$CODEX_PLUGIN_ARCHIVE"
}
EOF

printf 'Created snapshot: %s\n' "$SNAPSHOT_DIR"
printf 'Project archive: %s\n' "$PROJECT_ARCHIVE"
printf 'Plugin archive: %s\n' "$CODEX_PLUGIN_ARCHIVE"
printf 'Manifest: %s\n' "$MANIFEST_PATH"
