# Cloud Sync Integration Guide for FindForge Apps

How to add Clerk-authenticated, B2-backed storage sync to any FindForge app.
The reference implementation lives in **FindForge Translate** (`src/auth.ts`,
`src/cloudSync.ts`, `src/syncJournal.ts`, `src/opfs.ts`).

---

## 1. Overview

FindForge Storage Sync synchronises OPFS data across devices via a Cloudflare Worker
that fronts Backblaze B2. Authentication uses Clerk session tokens. Every FindForge
app gets its own B2 prefix (e.g. `translate/`, `research/`, `images/`) and its own
OPFS namespace (`/translate/`, `/research/`, `/images/`). Shared settings like the
global sync toggle live in `/cloud/` and are **never synced**. API keys live in
`/credentials/` (shared across all apps, synced under the `credentials/` cloud
prefix).

The app-data sync engine uses **event-sourced journaling**: every OPFS write or
delete is recorded in a rotating NDJSON journal. The sync engine replays unprocessed
journal entries to determine exactly what changed, avoiding a full filesystem walk
on every sync cycle.

**Credentials** use a **separate sync pipeline** with no journal and no debounce:
writes upload immediately, and downloads happen only on startup and manual request.

---

## 2. Architecture

```
Browser OPFS                          Cloud (B2 via Worker)
────────────────────────────────────────────────────────────────
/cloud/                               (never synced — shared local settings)
  preferences/
    cloudSyncEnabled
    cloudSyncDeleteRemote

/credentials/                         credentials/                    ← shared across all apps
  openrouter                          openrouter
  anthropic                           anthropic
  syncManifest                        (not synced — local manifest)

/{APP_PREFIX}/                        {CLOUD_PREFIX}
  preferences/                        preferences/
    apiKey                            apiKey
    selectedModel                     selectedModel
    syncManifest                      syncManifest
    ...
  sessions/                           sessions/
    {id}/session.json                 {id}/session.json
    {id}/translations/{ts}.json       {id}/translations/{ts}.json
  ...

/sync/                                (never synced — local crash-recovery)
  journal-a
  journal-b
  checkpoint
```

The manifest (`preferences/syncManifest`) records the last-synced hash, etag, and
mtime of every file. The cloud state file (`cloud-state.json`) is a signal written
by the worker after every upload so other devices know the cloud has newer data.

---

## 3. Prerequisites

- **Clerk account** — a publishable key for your app. The build/deploy pipeline
  must inject it as `public/clerk-key.js`, which sets `window.CLERK_PUBLISHABLE_KEY`.
- **FindForge Storage Worker** — URL: `https://findforge-storage.chris-f57.workers.dev`
  (set via `USE_DEV_WORKER = true` toggle during development).
- **An existing PWA** — OPFS storage, `manifest.json`, and a service worker.
  This guide adds the sync layer on top.

---

## 4. Files to Create or Adapt

### 4.1 `public/clerk-key.js`

Created by your build/deploy pipeline. Must set the publishable key before any
of your app scripts run:

```js
window.CLERK_PUBLISHABLE_KEY = 'pk_live_...';
```

Include it in `index.html` **after** Bootstrap but **before** your TypeScript entry:

```html
<script src="./clerk-key.js"></script>
```

---

### 4.2 `src/auth.ts` — Full source (no app changes needed)

```typescript
import { Clerk } from '@clerk/clerk-js';

let clerkInstance: Clerk | null = null;
let clerkEnabled: boolean = false;

/**
 * Gets the current Clerk session token for API authentication.
 * @param {{ skipCache?: boolean }} [options] - Pass skipCache: true to bypass Clerk's internal cache
 * @returns {Promise<string | null>} Session token or null if not signed in
 */
export async function getClerkToken(options?: { skipCache?: boolean }): Promise<string | null> {
    if (!clerkInstance?.isSignedIn || !clerkInstance.session) return null;
    try {
        return await clerkInstance.session.getToken(options);
    } catch (e) {
        console.error('[auth] Failed to get Clerk token:', e);
        return null;
    }
}

/**
 * Checks whether Clerk is available and a publishable key is present.
 * @returns {boolean}
 */
export function isClerkEnabled(): boolean {
    return clerkEnabled;
}

/**
 * Initializes Clerk from window.CLERK_PUBLISHABLE_KEY.
 * @returns {Promise<boolean>} True if Clerk was successfully initialized
 */
export async function initAuth(): Promise<boolean> {
    const publishableKey = (window as any).CLERK_PUBLISHABLE_KEY as string | undefined;
    if (!publishableKey) {
        clerkEnabled = false;
        return false;
    }

    try {
        const clerkDomain = atob(publishableKey.split('_')[2]).slice(0, -1);
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = `https://${clerkDomain}/npm/@clerk/ui@1/dist/ui.browser.js`;
            script.async = true;
            script.crossOrigin = 'anonymous';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load @clerk/ui bundle'));
            document.head.appendChild(script);
        });

        const clerk = new Clerk(publishableKey);
        await clerk.load({ ui: { ClerkUI: (window as any).__internal_ClerkUICtor } });
        clerkInstance = clerk;
        clerkEnabled = true;
        return true;
    } catch (e) {
        console.error('[auth] Clerk init failed:', e);
        clerkEnabled = false;
        return false;
    }
}

/**
 * Returns the Clerk instance.
 * @returns {Clerk | null}
 */
export function getClerk(): Clerk | null {
    return clerkInstance;
}

/**
 * Returns whether the user is currently signed in.
 * @returns {boolean}
 */
export function isSignedIn(): boolean {
    return clerkInstance?.isSignedIn ?? false;
}

/**
 * Mounts a Clerk sign-in or sign-up component into a container element.
 * @param {HTMLElement} element - Container element
 * @param {'signIn' | 'signUp'} mode - Which component to mount
 * @returns {void}
 */
export function mountAuthComponent(element: HTMLElement, mode: 'signIn' | 'signUp'): void {
    if (mode === 'signIn') {
        clerkInstance?.mountSignIn(element as HTMLDivElement);
    } else {
        clerkInstance?.mountSignUp(element as HTMLDivElement);
    }
}
```

If your app uses npm, add the Clerk JS dependency: `npm install @clerk/clerk-js`.

---

### 4.3 Your OPFS module — Design requirements

Your existing OPFS module must expose the following. You already have file I/O
helpers; the new requirement is **namespacing** so multiple FindForge apps coexist
on the same origin.

#### 4.3.1 `APP_PREFIX` constant

```typescript
export const APP_PREFIX: string = 'your-app-name';
```

This is the directory name under OPFS root for all your app data. Examples:
`'translate'`, `'research'`, `'images'`.

#### 4.3.2 `getOPFSHandle()` — App root directory

```typescript
export async function getOPFSHandle(): Promise<FileSystemDirectoryHandle> {
    await migrateToNamespacedPaths();
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(APP_PREFIX);
}
```

Every existing function in your OPFS module that reads or writes files should call
`getOPFSHandle()` to get the app root directory, instead of accessing
`navigator.storage.getDirectory()` directly.

#### 4.3.3 `migrateToNamespacedPaths()` — One-time migration

On first access after deployment, this function copies all old root-level data
(`sessions/`, `preferences/`, etc.) into the new `/{APP_PREFIX}/` directory.
It checks for the existence of `/{APP_PREFIX}/` — if that directory already exists,
it skips the migration. Old data is copied, not moved, so it's safe.

Reference implementation: `src/opfs.ts` lines 57–100 in FindForge Translate.

#### 4.3.4 Shared cloud settings — `/cloud/`

```typescript
export const CLOUD_PREFIX: string = 'cloud';
```

The `/cloud/` directory holds settings shared across all FindForge tools on the
same origin. Provide:

```typescript
export async function getCloudHandle(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CLOUD_PREFIX, { create: true });
}

export async function readCloudPreference(name: string): Promise<string | null> { /* ... */ }
export async function writeCloudPreference(name: string, value: string): Promise<void> { /* ... */ }
```

Keys currently stored under `/cloud/preferences/`:
- `cloudSyncEnabled` — global toggle (`'true'` / `'false'`)
- `cloudSyncDeleteRemote` — delete-remote preference

#### 4.3.5 Required read/write primitives (you likely already have these)

```typescript
export async function readLocalFile(path: string): Promise<string | null>;
export async function writeLocalFile(path: string, content: string | ArrayBuffer): Promise<void>;
export async function deleteLocalFile(path: string): Promise<void>;
export async function ensureDirectory(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle>;
export async function walkOpfsDirectory(dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]>;
```

`walkOpfsDirectory` is used by the sync engine to build the initial local manifest
(only during complete re-sync; normal sync uses the journal).

#### 4.3.6 Shared credentials — `/credentials/`

The `/credentials/` directory stores API keys shared across **all** FindForge apps
on the same browser origin. Each provider gets one flat file (e.g. `openrouter`,
`anthropic`). The directory is synced to the cloud so entering a key in one app
makes it available in all apps on all devices.

```typescript
export const CREDENTIALS_PREFIX: string = 'credentials';

export async function getCredentialsHandle(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CREDENTIALS_PREFIX, { create: true });
}

export async function readCredential(provider: string): Promise<string | null> { /* ... */ }
export async function writeCredential(provider: string, value: string): Promise<void> { /* ... */ }
export async function deleteCredential(provider: string): Promise<void> { /* ... */ }
```

Reference implementation: `src/opfs.ts` in FindForge Translate.

---

### 4.4 `src/syncJournal.ts` — Design description (no app changes needed)

The sync journal is an event-sourced crash-recovery system. Copy the file from
FindForge Translate (`src/syncJournal.ts`, ~430 lines). It has no app-specific
code.

**What it tracks:**
- `sync/journal-a` / `sync/journal-b` — rotating NDJSON files, 10,000 entries max each
- `sync/checkpoint` — JSON file recording `{ lastId, currentJournal, lastCloudCheckTime }`

**Public exports:**

| Function | Purpose |
|----------|---------|
| `init(): Promise<void>` | Reads checkpoint, loads journal, determines next ID |
| `recordWrite(path, hash): void` | Records a write in the dirty set |
| `recordDelete(path): void` | Records a deletion in the dirty set |
| `recordDeleteRecursive(path): void` | Records a recursive deletion |
| `drainQueue(): Promise<void>` | Persists dirty entries to the active journal file |
| `getCheckpoint(): SyncCheckpoint` | Returns current checkpoint |
| `setLastCloudCheckTime(iso: string): Promise<void>` | Updates the last-cloud-check timestamp |

**These files are NEVER synced to cloud.** They are local crash-recovery journals
only. The sync engine's `syncToCloudInternal()` calls `drainQueue()` before
building the upload batch, and `getCheckpoint()` to decide which entries to upload.

---

### 4.5 `src/cloudSync.ts` — Key sections to adapt

Copy the full file from FindForge Translate (`src/cloudSync.ts`, ~1700 lines).
Only **one constant** must change. Everything else is generic.

#### 4.5.1 Constants block — CHANGE `CLOUD_PREFIX`

```typescript
// Toggle to target the local dev worker instead of production
const USE_DEV_WORKER = false;

const WORKER_BASE_URL = USE_DEV_WORKER
    ? 'http://localhost:8787'
    : 'https://findforge-storage.chris-f57.workers.dev';

const SYNC_INTERVAL_MS = 60 * 60 * 1000;   // 1 hour read-sync timer

export const ALLOW_CLOUD_DELETIONS = false; // Safety gate — keep as false

// ═══════════════════════════════════════════════════════════════
// ★ CHANGE THIS to your app's cloud prefix
// ═══════════════════════════════════════════════════════════════
export const CLOUD_PREFIX = 'your-app-name/';
// ═══════════════════════════════════════════════════════════════

const MANIFEST_PATH = 'preferences/syncManifest';
const CLOUD_STATE_PATH = 'cloud-state.json';
const SYNC_SAFETY_WINDOW_MS = 10000;
```

The trailing `/` on `CLOUD_PREFIX` is required. It's prepended to all remote B2
paths: `{CLOUD_PREFIX}preferences/apiKey`, `{CLOUD_PREFIX}sessions/{id}/session.json`, etc.

#### 4.5.2 Public API

These functions are the only entry points your `main.ts` needs:

| Function | What it does |
|----------|-------------|
| `initCloudSync(): Promise<void>` | Initialise sync after Clerk auth. Loads shared settings from `/cloud/`, reads per-app state, starts the 1-hour timer, and decides whether to do an initial sync |
| `enableCloudSync(): Promise<void>` | Toggle on. Triggers the initial sync decision modal |
| `disableCloudSync(): Promise<void>` | Toggle off |
| `syncToCloud(): Promise<void>` | Upload dirty journal entries |
| `syncFromCloud(): Promise<void>` | Pull remote changes (fast-path if cloud state hasn't changed) |
| `syncBothWays(): Promise<void>` | Upload then download |
| `syncResetThenPull(): Promise<void>` | Delete manifest, show priority choice, full re-sync |
| `setSyncReloadCallback(cb): void` | Register your reload handler |
| `queueSync(): void` | Signal a pending write (5-second debounce → `syncToCloud()`) |
| `triggerManualSync(): Promise<void>` | Called by the navbar sync button |
| `triggerCompleteResync(): Promise<void>` | Full re-sync with priority choice |
| `computeHash(content): string` | Big-endian MD5 hash for B2 ETag compatibility |
| `setDeleteRemoteOnLocalDelete(bool): Promise<void>` | Toggle delete-remote behaviour |

#### 4.5.3 `initCloudSync()` — What it does at startup

1. Reads `/cloud/preferences/cloudSyncEnabled` → `STATE.cloudSync.enabled`
2. Reads per-app `preferences/cloudSync` → restores `lastSyncTime`
3. If enabled and journal is empty (first-run), shows the initial sync modal (upload vs. download)
4. Otherwise does `syncToCloud()` to push any local changes
5. Starts the 1-hour `syncFromCloud()` timer
6. Calls `ui.updateCloudSyncUI()` to reflect state

**Critical:** `initCloudSync()` must be called **after** Clerk auth and **after**
your config is loaded from OPFS. See Section 5.7 for the correct init order.

#### 4.5.4 `withSyncLock()` and the changed-paths callback

Every sync operation runs inside `withSyncLock()`, which:
1. Acquires a mutex (no overlapping syncs)
2. Sets `STATE.cloudSync.isSyncing = true`
3. Runs the sync function
4. In the `finally` block: releases the lock, fires `onSyncReload(changedPaths)`, resets `changedPaths`

This is where you hook your UI reload. See Section 5.8.

#### 4.5.5 `fetchWithAuth()` — Token management

All worker requests go through `fetchWithAuth(url, options)`. It:
1. Gets a Clerk session token
2. Attaches `Authorization: Bearer {token}`
3. On HTTP 401 with `token_expired`: retries once with a forced-fresh token
4. Throws on other 401 codes, 429 rate limits, or any non-2xx response

Token caching: Clerk tokens are cached for 45 seconds (they expire ~60s).

#### 4.5.6 Sync conflict resolution

Built-in modal flows handle conflicts:
- Per-file conflict modal (pick local vs. remote version)
- Deletion confirmation modal (gated by `ALLOW_CLOUD_DELETIONS`)
- Initial sync modal (upload vs. download on first-run)
- Complete re-sync modal (local vs. cloud priority)

`.png` file conflicts are auto-resolved as uploads.

#### 4.5.7 Credential sync (separate pipeline)

Credentials have their own sync pipeline, completely independent of the app-data
journal/debounce system:

**Constants:**
```typescript
export const CREDENTIALS_CLOUD_PREFIX = 'credentials/';
```

**Credential-specific public API:**

| Function | What it does |
|----------|-------------|
| `syncCredentialToCloud(provider)` | Immediate upload after writing a credential. Acquires sync lock, reads file, uploads to `credentials/{provider}` in B2, updates credential manifest, writes credential cloud-state. No journal, no debounce. |
| `syncCredentialsFromCloud(force?)` | Pull credential files from cloud. Called once on startup (`force=true`, always full sync) and on manual request (`force=false`, fast-path via `credentials/cloud-state.json`). Always lists the remote prefix (credential dirs are tiny: ~1–10 files). Resolves conflicts with last-write-wins — no modal. |
| `syncCredentialToCloud()` / `syncCredentialsFromCloud()` | Internal helpers already wired in. |

**Architecture differences from app-data sync:**

| Aspect | App Data | Credentials |
|--------|----------|-------------|
| **OPFS root** | `/{APP_PREFIX}/` | `/credentials/` |
| **Cloud prefix** | `{CLOUD_PREFIX}` | `credentials/` |
| **Manifest** | `preferences/syncManifest` | `/credentials/syncManifest` |
| **Journal** | Yes (NDJSON, debounced) | **None** |
| **Write → cloud** | Journal → debounce (5s) → batch upload | **Immediate** (write then upload in same call) |
| **Download timer** | 1-hour interval | **Startup + manual only** |
| **Conflict resolution** | Per-file modal | **Last-write-wins** (no modal) |
| **Cloud-state fast-path** | `cloud-state.json` (per prefix) | `credentials/cloud-state.json` |

**How upload/download/delete handle credential paths:**

The existing `uploadFile()`, `downloadFile()`, and `deleteRemoteFile()` functions
in `cloudSync.ts` detect the `credentials/` path prefix and automatically switch to
the `credentials/` cloud prefix:

```typescript
// Inside uploadFile(path, content):
const cloudPrefix = path.startsWith('credentials/') ? CREDENTIALS_CLOUD_PREFIX : CLOUD_PREFIX;
const requestPath = path.startsWith('credentials/') ? path.slice('credentials/'.length) : path;
const url = WORKER_BASE_URL + '/' + cloudPrefix + encodeURIComponent(requestPath);
```

So calling `uploadFile('credentials/openrouter', key)` automatically uploads to
`credentials/openrouter` in B2. No special function needed.

**`initCloudSync()` also calls `syncCredentialsFromCloud(true)` at startup** (after
the app-data init sync block). This ensures credentials are pulled on first load.

---

### 4.6 `src/types/cloudSync.ts` — Design description (no app changes needed)

Copy from FindForge Translate. Defines the data structures used by all sync modules:

| Type | Purpose |
|------|---------|
| `SyncFileInfo` | Remote file metadata (path, etag, size, lastModified) |
| `SyncConflict` | A file changed on both sides |
| `SyncDeletion` | A file to delete (local or remote) |
| `SyncActions` | The complete sync plan (uploads, downloads, conflicts, deletions) |
| `SyncManifestEntry` | One file's last-synced state |
| `SyncManifest` | All files' last-synced state, keyed by path |
| `SyncJournalEntry` | One local change recorded in the journal |
| `SyncCheckpoint` | Journal processing state |
| `CloudState` | Remote signal file contents |
| `WorkerErrorResponse` | Structured error from the worker |

---

### 4.7 `public/sw.js` — Service worker fix for HTML ETag validation

The service worker must force `cache: 'no-cache'` for HTML/navigation requests
to ensure the PWA always checks ETags against the server:

```javascript
function networkFirst(request, cacheName, fetchEvent) {
    const fetchOptions = (fetchEvent.request.mode === 'navigate' || request.url.endsWith('.html'))
        ? { cache: 'no-cache' }
        : {};
    return fetch(request, fetchOptions).then(function(response) {
        if (response.ok) {
            const responseClone = response.clone();
            caches.open(cacheName).then(function(cache) {
                cache.put(request, responseClone);
            });
        }
        return response;
    }).catch(function() {
        return caches.match(request).then(function(cached) {
            if (cached) return cached;
            if (fetchEvent.request.mode === 'navigate') {
                return caches.match('/index.html');
            }
            return new Response('Offline', { status: 503 });
        });
    });
}
```

Without this, the browser may serve stale HTML from its HTTP cache without ever
sending an `If-None-Match` header to the server, meaning deployed `index.html`
changes are invisible to PWAs until the cache expires or the user manually
refreshes.

JS and CSS files don't need this because Vite hash-busts their filenames on every
build, so cache-first is safe for them.

---

## 5. Step-by-Step Integration

### 5.1 Add the Clerk script tag

In `index.html`, before the closing `</body>` and after Bootstrap CDN scripts:

```html
<script src="./clerk-key.js"></script>
```

The exact position matters: above your TypeScript entry point so
`window.CLERK_PUBLISHABLE_KEY` is available when `auth.ts` loads.

### 5.2 Create `auth.ts`

Copy the full source from Section 4.2 into `src/auth.ts`.

### 5.3 Adapt your OPFS module for namespacing

1. Add `APP_PREFIX` constant (your app name).
2. Create `getOPFSHandle()` that returns `/{APP_PREFIX}/`.
3. Create `migrateToNamespacedPaths()` — copies old root-level data into the new prefix on first access.
4. Add `/cloud/` support: `getCloudHandle()`, `readCloudPreference()`, `writeCloudPreference()`.
5. Update all existing file I/O functions to call `getOPFSHandle()`.

### 5.4 Create `syncJournal.ts`

Copy from FindForge Translate. No changes needed.

### 5.5 Create `cloudSync.ts`

Copy from FindForge Translate. **Change only `CLOUD_PREFIX`** to your app's prefix
(e.g. `'research/'`, `'images/'` — note the trailing `/`).

### 5.6 Instrument your storage layer

Every OPFS write or delete in your storage module must call two functions after
the file operation succeeds:

```typescript
import { recordWrite, recordDelete, recordDeleteRecursive } from './syncJournal';
import { queueSync, computeHash } from './cloudSync';

// When writing a file:
async function saveMyData(path: string, data: string): Promise<void> {
    await writeLocalFile(path, data);
    const hash = computeHash(data);
    recordWrite(path, hash);
    queueSync();
}

// When deleting a file:
async function deleteMyData(path: string): Promise<void> {
    await deleteLocalFile(path);
    recordDelete(path);
    queueSync();
}
```

In FindForge Translate, this pattern is applied across 16 functions in
`src/storage.ts`. Every `saveSession()`, `saveSessionTranslation()`,
`deleteSession()`, `savePreference()`, `deletePreference()`, etc. follows it.

**Why `recordWrite` + `queueSync`?** `recordWrite` logs the change in the journal.
`queueSync` schedules a debounced upload. The journal is the single source of
truth for "what changed" — the sync engine reads the journal, not the filesystem.

### 5.7 Wire the init order in `main.ts`

**The order matters.** Config must be in memory before cloud sync starts,
otherwise you get the bug described in Section 7.

```typescript
export async function init(): Promise<void> {
    // 1. Clerk first
    const authActive = await initAuth();

    // 2. Load app config from OPFS
    await loadSettings();        // Reads preferences/ into your config object
    await loadApiKey();          // Reads apiKey from OPFS

    // 3. Load your app data (sessions, conversations, etc.)
    await loadAppData();

    // 4. Cloud sync — AFTER config is loaded
    await initCloudSync();

    // 5. Register the reload callback
    setSyncReloadCallback(async function(changedPaths: string[]): Promise<void> {
        // See Section 5.8
    });
}
```

### 5.8 Write the reload callback

The callback fires after every sync that downloaded files. It receives the list of
paths that changed. You must handle two categories:

**a) Preferences changes** — reload config into memory:

```typescript
let needsConfigReload = false;
for (const path of changedPaths) {
    if (path.startsWith('preferences/')) {
        needsConfigReload = true;
    }
}
if (needsConfigReload) {
    await loadSettings();
    await loadApiKey();  // Triggers saveApiKey() → refreshBalance() + loadModels()
}
```

**b) App-data changes** — update your UI without a full reload:

```typescript
for (const path of changedPaths) {
    if (path.startsWith('sessions/')) {
        // Parse the path, load the specific data, append to UI
        // Avoid calling setCurrentSession() — it wipes the DOM
    }
}
```

Reference: `src/main.ts` lines 256–284 in FindForge Translate.

### 5.9 Add sync UI

Minimal set of UI elements:

**Navbar sync button:**
```html
<button id="cloud-sync-btn" title="Last synced: never">
    <!-- Icon + status text -->
</button>
```

Wire it to `triggerManualSync()`.

**Settings → Cloud Sync tab:**
- Enable/disable toggle (calls `enableCloudSync()` / `disableCloudSync()`)
- Manual sync button
- Progress bar + text (`showSyncProgress` / `hideSyncProgress` from `ui.ts`)
- Sync status text (from `STATE.cloudSync`)

**Modal templates** (in `index.html` as `<template>` elements):
- `sync-conflict-modal-template` — per-file conflict resolution
- `initial-sync-modal-template` — first-run upload vs. download choice
- `resync-choice-modal-template` — complete re-sync priority choice

Reference: FindForge Translate's `index.html` for all four modal templates.

### 5.10 Integrate shared credentials

Each FindForge app should read API keys from the shared `/credentials/` directory
and write them there when the user saves a key.

**a) Writing an API key** — write to `/credentials/{provider}`, sync to cloud, then
write the legacy per-app fallback:

```typescript
export async function saveApiKey(key: string): Promise<void> {
    config.openRouterApiKey = key;
    // Write to shared credentials directory
    const { writeCredential } = await import('./opfs');
    await writeCredential('openrouter', key);
    // Sync immediately to cloud (no debounce)
    const { syncCredentialToCloud } = await import('./cloudSync');
    await syncCredentialToCloud('openrouter');
    // Permanent fallback for apps that haven't migrated yet
    await savePreference('apiKey', key);
    await refreshBalance();
    await loadModels();
}
```

**b) Reading an API key** — check `/credentials/{provider}` first, fall back to
legacy per-app preference:

```typescript
async function loadApiKey(): Promise<void> {
    const { readCredential } = await import('./opfs');
    const credKey = await readCredential('openrouter');
    if (credKey && !config.openRouterApiKey) {
        config.openRouterApiKey = credKey;
        await refreshBalance();
        await loadModels();
        return;
    }
    // Fallback to legacy
    const key = await getPreference('apiKey');
    if (key && !config.openRouterApiKey) {
        await saveApiKey(key); // This promotes the key to /credentials/
    }
}
```

**c) Reload callback** — when credentials are downloaded from the cloud, the reload
callback receives `credentials/openrouter` in `changedPaths`. Handle it:

```typescript
for (const path of changedPaths) {
    if (path === 'credentials/openrouter') {
        await loadApiKey();
    }
}
```

**d) Manual sync button (optional):** Add a "Sync credentials now" button that calls
`syncCredentialsFromCloud(false)` (exported from `cloudSync.ts`).

---

## 6. Storage Worker API

Base URL: `https://findforge-storage.chris-f57.workers.dev`  
Authentication: `Authorization: Bearer {clerkSessionToken}`

### LIST files
```
GET /?list-type=2&prefix={CLOUD_PREFIX}
```
Returns XML (B2 list-objects format). Paginated via `continuation-token`.

### UPLOAD file
```
PUT /{CLOUD_PREFIX}{path}
Content-Type: application/json (for .json) or text/plain (otherwise)
Body: raw file content
```
Returns: `200 OK` with `ETag` header. Use big-endian MD5 for local hash to match B2's ETag format.

### DOWNLOAD file
```
GET /{CLOUD_PREFIX}{path}
```
Returns: file content. `.png` files return `ArrayBuffer`; text files return `string`.

### DELETE file
```
DELETE /{CLOUD_PREFIX}{path}
```
Gated by `ALLOW_CLOUD_DELETIONS`. In production, deletions are disabled globally.

---

## 7. Critical Rules & Gotchas

- **`/cloud/` is never synced.** Shared settings stay local. Cloud sync only covers
  `/{APP_PREFIX}/` data.

- **`/sync/` is never synced.** The journal files (`journal-a`, `journal-b`,
  `checkpoint`) are local crash-recovery data. Adding them to the cloud would cause
  conflicts on every write.

- **Config must be loaded before `initCloudSync()`.** If cloud sync runs before
  `loadSettings()`, the reload callback catches the `preferences/` download but the
  in-memory config is still the hardcoded default. See Section 5.7 for the correct
  init order.

- **Reload callback must handle `preferences/`.** When another device syncs config
  changes, your reload callback must call `loadSettings()` + `loadApiKey()` to
  refresh the in-memory config. Without this, the app continues with stale config
  until the user refreshes the page.

- **Service worker must use `cache: 'no-cache'` for HTML.** See Section 4.7. This
  forces ETag validation on every page load. Without it, deployed `index.html`
  changes are invisible to PWA users.

- **`queueSync()` debounces writes by 5 seconds.** Multiple rapid writes get batched
  into a single `syncToCloud()` call. The journal ensures no data is lost.

- **`syncFromCloud()` has a fast-path.** It checks `cloud-state.json` first. If the
  cloud's `lastUpdateTime` matches the local checkpoint's `lastCloudCheckTime`, it
  skips the full listing. This makes pull-only syncs (the navbar button) very cheap
  when nothing changed.

- **`ALLOW_CLOUD_DELETIONS = false` is a safety gate.** Even if your code calls
  `deleteRemoteFile()`, the worker will reject it. Keep this `false` in production.

- **`.png` conflicts are auto-resolved as uploads.** Binary files are treated as
  local-wins to preserve image quality. All other file types show the conflict modal.

- **Journal files are rotate when they reach 10,000 entries.** A fresh journal-A
  or journal-B file is created, and the checkpoint switches to the new journal.

- **Cloud paths always use the full prefix.** Remote paths are stored as
  `{CLOUD_PREFIX}preferences/apiKey`, not `preferences/apiKey` directly. The worker
  strips the prefix in list results, but upload/download require it.

- **One-time migration runs automatically** on first access after deploying
  namespaced paths. Old root-level data is copied into `/{APP_PREFIX}/`. It's
  idempotent — if the namespace directory already exists, it skips.

- **Credentials have no journal or debounce.** When a credential is written,
  `syncCredentialToCloud()` uploads immediately. Read-syncs happen only at
  startup and on manual request. Credentials are never polled by the 1-hour timer.

- **Credential manifest is separate.** Stored at `/credentials/syncManifest` (local
  file, never synced). Reuses the same `SyncManifest` type as app data.

- **Credential directories are always listed.** `syncCredentialsFromCloud()` does
  not use a "skip listing" fast-path because credential dirs are tiny (~1–10 files).
  The cloud-state check (`credentials/cloud-state.json`) gates the sync, but once
  the sync runs, it always does a full `listRemoteFiles('credentials/')`.

- **Credential conflict resolution is last-write-wins.** No conflict modal is shown
  for credential files. If both local and remote changed, the later mtime wins.

---

## 8. Per-App Checklist

| What | File | Example (`images`) |
|------|------|-------------------|
| **Clerk script** | `index.html` | `<script src="./clerk-key.js"></script>` |
| **Auth module** | `src/auth.ts` | Copy inlined source, no changes |
| **OPFS prefix** | Your OPFS module | `export const APP_PREFIX = 'images'` |
| **Cloud handle** | Your OPFS module | `getCloudHandle()`, `readCloudPreference()`, `writeCloudPreference()` |
| **Migration** | Your OPFS module | `migrateToNamespacedPaths()` |
| **Cloud sync prefix** | `src/cloudSync.ts` | `export const CLOUD_PREFIX = 'images/'` |
| **Sync journal** | `src/syncJournal.ts` | Copy from Translate, no changes |
| **Cloud types** | `src/types/cloudSync.ts` | Copy from Translate, no changes |
| **Storage instrumentation** | Your storage module | `recordWrite()` + `queueSync()` on every write/delete |
| **Init order** | `src/main.ts` | Clerk → config → app data → `initCloudSync()` |
| **Reload callback** | `src/main.ts` | Handle `preferences/` (reload config) + app-data paths |
| **Sync UI** | `index.html` | Navbar button, settings tab, modal templates |
| **Service worker** | `public/sw.js` | `cache: 'no-cache'` for HTML/nav requests |
| **PWA manifest** | `public/manifest.json` | Update `name`, `short_name`, icons |
| **Credential read/write** | Your OPFS module | `readCredential()` / `writeCredential()` |
| **Credential sync (write)** | Your `main.ts` | `saveApiKey()` writes to `credentials/{provider}` + syncs |
| **Credential sync (read)** | Your `main.ts` | `loadApiKey()` reads from `credentials/{provider}` first |
| **Credential reload** | Your `main.ts` | Handle `credentials/{provider}` in reload callback |
