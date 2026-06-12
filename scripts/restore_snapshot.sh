#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <snapshot-id>"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="/Users/hanbala/plugins/gpt-image-plugin"
SNAPSHOT_ID="$1"
SNAPSHOT_DIR="$ROOT_DIR/versions/$SNAPSHOT_ID"
PROJECT_ARCHIVE="$SNAPSHOT_DIR/gpt-image-plugin-project.tar.gz"
CODEX_PLUGIN_ARCHIVE="$SNAPSHOT_DIR/gpt-image-plugin-codex-plugin.tar.gz"

if [[ ! -f "$PROJECT_ARCHIVE" || ! -f "$CODEX_PLUGIN_ARCHIVE" ]]; then
  echo "Snapshot not found or incomplete: $SNAPSHOT_DIR"
  exit 1
fi

tar -xzf "$PROJECT_ARCHIVE" -C "$ROOT_DIR"
tar -xzf "$CODEX_PLUGIN_ARCHIVE" -C "$(dirname "$PLUGIN_DIR")"

printf 'Restored snapshot: %s\n' "$SNAPSHOT_ID"
printf 'Project restored to: %s\n' "$ROOT_DIR"
printf 'Plugin restored to: %s\n' "$PLUGIN_DIR"
