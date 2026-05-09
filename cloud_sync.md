# FindForge Cloud Sync Protocol

## Overview

Cloud sync for FindForge tools uses Backblaze B2 storage via a Cloudflare Worker (FindForge Storage Worker), authenticated through Clerk session tokens. The protocol supports incremental hash-based sync with crash-recovery journaling.

## OPFS Shared Directory (`/cloud/`)

All FindForge tools share `/cloud/` in the browser OPFS for cross-tool settings. This directory is **never** synced to cloud storage.

| File | Purpose |
|------|---------|
| `/cloud/preferences/cloudSyncEnabled` | Global sync toggle (`"true"` / `"false"`) |
| `/cloud/preferences/cloudSyncDeleteRemote` | Delete-remote preference (`"true"` / `"false"`) |

### Integration

```typescript
import { readCloudPreference, writeCloudPreference } from './storage';
const enabled = await readCloudPreference('cloudSyncEnabled');
await writeCloudPreference('cloudSyncEnabled', 'true');
```

## App OPFS Root (`/{app_prefix}/`)

Each tool uses its own prefix (e.g., `/translate/`, `/chat/`, `/image/`). `getOPFSHandle()` returns the app root after running the one-time migration from old root-level paths.

```
OPFS Root:
├── cloud/
└── {app_prefix}/
    ├── sessions/
    ├── preferences/
    │   ├── cloudSync       ← Per-app state (lastSyncTime)
    │   ├── syncManifest
    │   ├── syncJournal
    │   └── ...
    └── translations/
```

## Remote Storage Paths

All remote paths use the app prefix as a namespace:

| Path | Purpose |
|------|---------|
| `{app_prefix}/sessions/{id}/session.json` | Session metadata |
| `{app_prefix}/sessions/{id}/translations/{ts}.json` | Translation entries |
| `{app_prefix}/preferences/{key}` | App preferences |
| `{app_prefix}/cloud-state.json` | Sync heartbeat (newest timestamp triggers re-sync on other devices) |

## Worker API

The FindForge Storage Worker at `https://findforge-storage.chris-f57.workers.dev` (or `http://localhost:8787` for dev) provides B2-compatible endpoints:

### List files

```
GET /?list-type=2&prefix={app_prefix}
```

Returns S3 ListObjectsV2 XML with `<Contents>` entries. Parse with `parseListObjectsXml()` (DOM-free tag extraction).

### Upload

```
PUT /{path}
Content-Type: application/json (or text/plain; charset=utf-8)
Authorization: Bearer {clerk_token}

{body}
```

Returns `ETag` header (MD5 hash).

### Download

```
GET /{path}
Authorization: Bearer {clerk_token}
```

Returns file content as text.

### Delete

```
DELETE /{path}
Authorization: Bearer {clerk_token}
```

Returns 204 on success.

## Authentication

All requests require a Bearer token obtained from Clerk's session token. The token is cached for 45 seconds and refreshed automatically on `401 token_expired`.

## Sync Algorithm

### State Files

| File | Type | Purpose |
|------|------|---------|
| `syncManifest` | JSON | Records per-file hash/ETag/mtime from last successful sync |
| `syncJournal` | NDJSON | Crash-recovery log of completed operations during a sync |
| `cloud-state.json` | JSON (`{ lastSyncTime }`) | Heartbeat — other devices check this to know if sync is needed |

### Flow

```
performSync()
  ├─ recoverFromJournal()           // Replay any crashed-sync journal
  ├─ checkCloudState()              // Fast-path: skip if remote unchanged
  ├─ buildLocalManifestWithHashes() // Read files, compute MD5 hashes
  ├─ listRemoteFiles()              // List remote files, extract ETags
  ├─ resolveSyncActions()           // Three-way comparison
  │   ├─ Upload (local changed)
  │   ├─ Download (remote changed)
  │   ├─ Delete (manifest entry gone from one side)
  │   ├─ Identical (MD5 == ETag, first-sync files)
  │   └─ Conflict (both changed within 10s window)
  ├─ Execute operations             // Each successful op is journaled
  ├─ Save manifest + delete journal
  └─ Upload cloud-state.json        // If remote state changed
```

### Local Manifest (`readLocalFile`, `writeLocalFile`)

Each local file's MD5 hash, B2 ETag, and mtime are stored:

```json
{
  "sessions/abc/session.json": {
    "localHash": "d41d8cd98f00b204e9800998ecf8427e",
    "remoteEtag": "d41d8cd98f00b204e9800998ecf8427e",
    "localMtime": 1712345678000,
    "remoteMtime": "Tue, 05 May 2026 12:00:00 GMT"
  }
}
```

### Journal (NDJSON)

One JSON object per line, appended after each successful operation:

```json
{"op":"upload","path":"sessions/abc/session.json","localHash":"...","remoteEtag":"...","localMtime":1712345678000,"remoteMtime":"Tue, 05 May 2026 12:00:00 GMT"}
{"op":"delete","path":"sessions/abc/session.json"}
```

On startup, `recoverFromJournal()` replays the journal, updates the manifest, and deletes the journal. If the journal contained uploads or deletions, `cloud-state.json` is also re-uploaded to signal other devices.

### MD5 / ETag Comparison

- **Local hash**: Pure JS MD5, computed by `computeHash()` in `src/cloudSync.ts`
- **Remote ETag**: MD5 hash returned by B2 for objects < 5GB
- **Comparison**: `localEntry.hash === remoteInfo.etag` → identical content

## Transitions

### First Sync / Re-Sync

If no manifest exists (first sync or `triggerCompleteResync()`):
- Files on both sides with matching MD5/ETag → added to manifest as `identical` (no transfer)
- Files on both sides with differing content → last-write-wins with 10s safety window
- Files only on one side → uploaded or downloaded normally

### Old Hash Migration

When switching from SHA-256 to MD5, old 64-char manifest hashes are detected by length and treated as absent. All files are re-hashed with MD5 on the first sync after the upgrade.

## Integrating into a New FindForge App

1. **Set `CLOUD_PREFIX`** in `cloudSync.ts` to `'{app_prefix}/'`
2. **Set `APP_PREFIX`** in `storage.ts` to `'{app_prefix}'`
3. **Call `migrateToNamespacedPaths()`** early in init (runs automatically via `getOPFSHandle()`)
4. **Read shared settings** from `/cloud/` using `readCloudPreference()`
5. **Write shared settings** to `/cloud/` using `writeCloudPreference()`
6. **Use `readLocalFile`/`writeLocalFile`** functions from `cloudSync.ts` (they use `getOPFSHandle()` which returns the app root)
7. **Set `CLOUD_STATE_PATH`** to `CLOUD_PREFIX + 'cloud-state.json'`
8. **Call `listRemoteFiles(CLOUD_PREFIX)`** to scope file listings to this app
