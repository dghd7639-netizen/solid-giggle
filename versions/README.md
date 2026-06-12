# Snapshots

This directory stores rollback snapshots for the local project and the Codex plugin wrapper.

Create a snapshot:

```bash
/Users/hanbala/Desktop/gpt生图插件/scripts/create_snapshot.sh
```

List snapshots:

```bash
/Users/hanbala/Desktop/gpt生图插件/scripts/list_snapshots.sh
```

Restore a snapshot:

```bash
/Users/hanbala/Desktop/gpt生图插件/scripts/restore_snapshot.sh <snapshot-id>
```

Each snapshot folder contains:

- `gpt-image-plugin-project.tar.gz`
- `gpt-image-plugin-codex-plugin.tar.gz`
- `manifest.json`
