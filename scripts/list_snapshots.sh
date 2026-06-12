#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSIONS_DIR="$ROOT_DIR/versions"

if [[ ! -d "$VERSIONS_DIR" ]]; then
  echo "No snapshots directory found: $VERSIONS_DIR"
  exit 1
fi

shopt -s nullglob
snapshot_dirs=("$VERSIONS_DIR"/*)
shopt -u nullglob

if [[ ${#snapshot_dirs[@]} -eq 0 ]]; then
  echo "No snapshots found in $VERSIONS_DIR"
  exit 0
fi

printf '%-18s  %-20s  %-10s  %-10s  %s\n' "SNAPSHOT ID" "CREATED AT (UTC)" "PROJECT" "PLUGIN" "STATUS"

for snapshot_dir in "${snapshot_dirs[@]}"; do
  [[ -d "$snapshot_dir" ]] || continue

  snapshot_id="$(basename "$snapshot_dir")"
  manifest_path="$snapshot_dir/manifest.json"
  project_archive="$snapshot_dir/gpt-image-plugin-project.tar.gz"
  plugin_archive="$snapshot_dir/gpt-image-plugin-codex-plugin.tar.gz"

  status="ok"
  created_at="-"
  project_size="-"
  plugin_size="-"

  if [[ -f "$manifest_path" ]]; then
    created_at="$(sed -n 's/.*"createdAt": "\(.*\)".*/\1/p' "$manifest_path" | head -n 1)"
    [[ -n "$created_at" ]] || created_at="-"
  else
    status="missing-manifest"
  fi

  if [[ -f "$project_archive" ]]; then
    project_size="$(du -h "$project_archive" | awk '{print $1}')"
  else
    status="${status/ok/missing-project-archive}"
    [[ "$status" == "missing-manifest" ]] || true
    if [[ "$status" != "missing-project-archive" && "$status" != "missing-manifest" ]]; then
      status="$status,missing-project-archive"
    fi
  fi

  if [[ -f "$plugin_archive" ]]; then
    plugin_size="$(du -h "$plugin_archive" | awk '{print $1}')"
  else
    if [[ "$status" == "ok" ]]; then
      status="missing-plugin-archive"
    elif [[ "$status" != *"missing-plugin-archive"* ]]; then
      status="$status,missing-plugin-archive"
    fi
  fi

  printf '%-18s  %-20s  %-10s  %-10s  %s\n' \
    "$snapshot_id" \
    "$created_at" \
    "$project_size" \
    "$plugin_size" \
    "$status"
done
