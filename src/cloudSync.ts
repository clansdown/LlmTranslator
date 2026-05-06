/**
 * Cloud Sync Module
 * Syncs OPFS data to Backblaze B2 via FindForge Storage Worker
 * Authenticated through Clerk
 */

import { getClerkToken, isSignedIn, isClerkEnabled } from './auth';
import { getOPFSHandle, ensureDirectory } from './storage';
import { STATE } from './state';
import * as ui from './ui';
import type { SyncFileInfo, SyncConflict, SyncDeletion, SyncActions, SyncManifestEntry, SyncManifest, WorkerErrorResponse } from './types/cloudSync';
import type { CloudSyncState } from './types/state';

// Toggle to target the local dev worker instead of production
const USE_DEV_WORKER = true;

const WORKER_BASE_URL = USE_DEV_WORKER
    ? 'http://localhost:8787'
    : 'https://findforge-storage.chris-f57.workers.dev';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const ALLOW_CLOUD_DELETIONS = false;
const MANIFEST_PATH = 'preferences/syncManifest';
const SYNC_SAFETY_WINDOW_MS = 10000;

/** @type {number | null} */
let syncTimerId: number | null = null;

/** @type {number | null} */
let pendingSyncTimeout: number | null = null;

/** @type {string | null} */
let cachedToken: string | null = null;

/** @type {number | null} */
let tokenExpiryTime: number | null = null;

/**
 * Gets the current Clerk session token with caching
 * Clerk session tokens expire ~60 seconds by default, so we cache for 45 seconds
 * to handle bursts of rapid requests while staying safely under expiry.
 * @param {boolean} [forceRefresh=false] - If true, bypasses cache and fetches a new token
 * @returns {Promise<string | null>} The session token, or null if not available
 */
async function getAuthToken(forceRefresh: boolean = false): Promise<string | null> {
    const now = Date.now();
    if (!forceRefresh && cachedToken && tokenExpiryTime && now < tokenExpiryTime) {
        return cachedToken;
    }

    const token = await getClerkToken(forceRefresh ? { skipCache: true } : undefined);
    if (!token) {
        console.warn('[cloudSync] No Clerk token available');
        return null;
    }

    cachedToken = token;
    tokenExpiryTime = now + 45000;
    return token;
}

/**
 * Makes an authenticated fetch to the storage worker with automatic token refresh on expiry.
 * Handles all documented worker error codes:
 *   - 401 token_expired → retry once with fresh token (via skipCache: true)
 *   - 401 token_invalid / auth_failed / token_not_active → throw, no retry
 *   - 429 rate_limit_exceeded → throw with Retry-After info
 * @param {string} url - Full worker URL
 * @param {RequestInit} [options={}] - Fetch options (method, headers, body, etc.)
 * @returns {Promise<Response>} The fetch response (always ok — throws on failure)
 * @throws {Error} On auth failure, rate limit, or any non-2xx after retry
 */
async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await getAuthToken();
    if (!token) {
        throw new Error('No Clerk token available');
    }

    /**
     * Performs an actual fetch with the given token merged into request headers
     * @param {string} token - Bearer token
     * @returns {Promise<Response>}
     */
    async function doFetch(token: string): Promise<Response> {
        const headers = new Headers(options.headers || {});
        headers.set('Authorization', 'Bearer ' + token);
        return fetch(url, { ...options, headers });
    }

    const response = await doFetch(token);
    if (response.ok) return response;

    // Attempt to parse the structured error body (non-B2 errors are always JSON)
    let errorBody: WorkerErrorResponse | null = null;
    try {
        errorBody = await response.json() as WorkerErrorResponse;
    } catch {
        // Body not JSON — likely a B2 passthrough error (404, 403) — will throw generic below
    }

    // Token expired: retry exactly once with a forced-fresh token
    if (response.status === 401 && errorBody?.error === 'token_expired') {
        const freshToken = await getAuthToken(true);
        if (!freshToken) {
            throw new Error('Clerk token refresh failed — unable to retry request');
        }

        const retryResponse = await doFetch(freshToken);
        if (retryResponse.ok) return retryResponse;

        // Retry also failed — parse its error body
        let retryError: WorkerErrorResponse | null = null;
        try {
            retryError = await retryResponse.json() as WorkerErrorResponse;
        } catch {
            // Not JSON
        }
        throw new Error(
            'Worker request failed after token refresh: ' + retryResponse.status +
            (retryError ? ' - ' + retryError.message : '')
        );
    }

    // Rate limited
    if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new Error(
            'Rate limit exceeded' +
            (retryAfter ? ', retry after ' + retryAfter + ' seconds' : '') +
            (errorBody?.message ? ': ' + errorBody.message : '')
        );
    }

    // Other 401 codes (token_invalid, auth_failed, token_not_active) — no retry
    if (response.status === 401) {
        throw new Error(
            'Authentication failed (' + (errorBody?.error ?? 'unknown') + '): ' +
            (errorBody?.message ?? 'No details')
        );
    }

    // All other errors (including B2 passthrough)
    throw new Error(
        'Worker request failed: ' + response.status +
        (errorBody ? ' - ' + errorBody.message : '')
    );
}

/**
 * Lists files from the remote storage worker
 * @param {string} [prefix] - Optional prefix filter
 * @returns {Promise<SyncFileInfo[]>} Array of file info objects
 */
async function listRemoteFiles(prefix?: string): Promise<SyncFileInfo[]> {
    const url = new URL(WORKER_BASE_URL + '/');
    url.searchParams.set('list-type', '2');
    if (prefix) {
        url.searchParams.set('prefix', prefix);
    }

    const response = await fetchWithAuth(url.toString());

    const xml = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const contents = doc.querySelectorAll('Contents');
    const files: SyncFileInfo[] = [];

    contents.forEach(function(el) {
        const key = el.querySelector('Key')?.textContent ?? '';
        const etag = (el.querySelector('ETag')?.textContent ?? '').replace(/^"/, '').replace(/"$/, '');
        const sizeStr = el.querySelector('Size')?.textContent ?? '0';
        const lastMod = el.querySelector('LastModified')?.textContent ?? '';

        files.push({
            path: key,
            etag: etag,
            size: parseInt(sizeStr, 10) || 0,
            lastModified: lastMod
        });
    });

    return files;
}

/**
 * Uploads a file to the remote storage worker
 * @param {string} path - Remote file path
 * @param {string | Blob} content - File content
 * @returns {Promise<string>} The ETag returned by the worker
 */
async function uploadFile(path: string, content: string | Blob): Promise<string> {
    const url = WORKER_BASE_URL + '/' + encodeURIComponent(path);

    let body: BodyInit;
    let contentType: string;

    if (typeof content === 'string') {
        body = content;
        contentType = path.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8';
    } else {
        body = content;
        contentType = content.type || 'application/octet-stream';
    }

    const response = await fetchWithAuth(url, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: body
    });
    return response.headers.get('ETag') ?? '';
}

/**
 * Downloads a file from the remote storage worker
 * @param {string} path - Remote file path
 * @returns {Promise<string>} File content as text
 */
async function downloadFile(path: string): Promise<string> {
    const url = WORKER_BASE_URL + '/' + encodeURIComponent(path);
    const response = await fetchWithAuth(url);

    return await response.text();
}

/**
 * Deletes a file from the remote storage worker (safety-gated)
 * @param {string} path - Remote file path
 * @returns {Promise<void>}
 */
async function deleteRemoteFile(path: string): Promise<void> {
    const url = WORKER_BASE_URL + '/' + encodeURIComponent(path);
    await fetchWithAuth(url, { method: 'DELETE' });
}

/**
 * Computes SHA-256 hash of a string
 * @param {string} content - Content to hash
 * @returns {Promise<string>} Hex-encoded hash
 */
async function computeHash(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/**
 * Parses an HTTP-date string to milliseconds since epoch
 * @param {string} mtime - HTTP-date string (e.g. "Tue, 05 May 2026 12:00:00 GMT")
 * @returns {number} Milliseconds since epoch
 */
function parseRemoteMtime(mtime: string): number {
    return new Date(mtime).getTime();
}

/**
 * Reads a local OPFS file with its last-modified timestamp
 * @param {string} path - OPFS path relative to root
 * @returns {Promise<{ content: string; mtime: number } | null>} File content and mtime
 */
async function readLocalFileWithMtime(path: string): Promise<{ content: string; mtime: number } | null> {
    try {
        const root = await getOPFSHandle();
        const parts = path.split('/');
        let dir = root;

        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await dir.getFileHandle(fileName);
        const fileObj = await fileHandle.getFile();
        const content = await fileObj.text();
        return { content, mtime: fileObj.lastModified };
    } catch (e) {
        console.warn('[cloudSync] Failed to read local file:', path, e);
        return null;
    }
}

/**
 * Loads the persisted sync manifest from OPFS
 * @returns {Promise<SyncManifest | null>} The manifest, or null
 */
async function loadSyncManifest(): Promise<SyncManifest | null> {
    const saved = await readLocalFile(MANIFEST_PATH);
    if (!saved) return null;
    try {
        return JSON.parse(saved) as SyncManifest;
    } catch (e) {
        console.warn('[cloudSync] Failed to parse sync manifest:', e);
        return null;
    }
}

/**
 * Persists the sync manifest to OPFS
 * @param {SyncManifest} manifest - Manifest to save
 * @returns {Promise<void>}
 */
async function saveSyncManifest(manifest: SyncManifest): Promise<void> {
    await writeLocalFile(MANIFEST_PATH, JSON.stringify(manifest));
}

/**
 * Reads a local OPFS file as text
 * @param {string} path - OPFS path relative to root (e.g. "preferences/apiKey")
 * @returns {Promise<string | null>} File content or null
 */
async function readLocalFile(path: string): Promise<string | null> {
    try {
        const root = await getOPFSHandle();
        const parts = path.split('/');
        let dir = root;

        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await dir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return await file.text();
    } catch (e) {
        console.warn('[cloudSync] Failed to read local file:', path, e);
        return null;
    }
}

/**
 * Writes text content to a local OPFS file
 * @param {string} path - OPFS path relative to root
 * @param {string} content - Content to write
 * @returns {Promise<void>}
 */
async function writeLocalFile(path: string, content: string): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const parts = path.split('/');
        let dir = root;

        for (let i = 0; i < parts.length - 1; i++) {
            dir = await ensureDirectory(dir, parts[i]);
        }

        const fileName = parts[parts.length - 1];
        const fileHandle = await dir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
    } catch (e) {
        console.error('[cloudSync] Failed to write local file:', path, e);
    }
}

/**
 * Deletes a local OPFS file (safety-gated)
 * @param {string} path - OPFS path relative to root
 * @returns {Promise<void>}
 */
async function deleteLocalFile(path: string): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const parts = path.split('/');
        let dir = root;

        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i]);
        }

        const fileName = parts[parts.length - 1];
        await dir.removeEntry(fileName);
    } catch (e) {
        console.error('[cloudSync] Failed to delete local file:', path, e);
    }
}

/**
 * Recursively walks an OPFS directory to build a file listing
 * @param {FileSystemDirectoryHandle} dir - Directory handle to walk
 * @param {string} prefix - Current path prefix for recursion
 * @returns {Promise<string[]>} Array of file paths relative to the root
 */
async function walkOpfsDirectory(dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> {
    const files: string[] = [];
    const entries = (dir as any).values();

    for await (const entry of entries) {
        const path = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.kind === 'file') {
            files.push(path);
        } else if (entry.kind === 'directory') {
            const subDir = await dir.getDirectoryHandle(entry.name);
            const subFiles = await walkOpfsDirectory(subDir, path);
            files.push.apply(files, subFiles);
        }
    }

    return files;
}

/**
 * Builds a local manifest with hashes and mtimes, using the last sync manifest
 * as a fast-path cache to avoid re-reading unchanged files.
 * @param {SyncManifest | null} lastManifest - The manifest from the last successful sync
 * @returns {Promise<Map<string, { content: string | null; hash: string; mtime: number }>>} Map of path -> { content, hash, mtime }
 */
async function buildLocalManifestWithHashes(lastManifest: SyncManifest | null): Promise<Map<string, { content: string | null; hash: string; mtime: number }>> {
    const manifest = new Map<string, { content: string | null; hash: string; mtime: number }>();
    const root = await getOPFSHandle();
    const files = await walkOpfsDirectory(root, '');

    for (const filePath of files) {
        if (filePath === MANIFEST_PATH) continue;

        const fileEntry = await readLocalFileWithMtime(filePath);
        if (fileEntry === null) continue;

        const lastEntry = lastManifest?.[filePath];

        if (lastEntry && fileEntry.mtime === lastEntry.localMtime) {
            manifest.set(filePath, {
                content: null,
                hash: lastEntry.localHash,
                mtime: fileEntry.mtime
            });
        } else {
            manifest.set(filePath, {
                content: fileEntry.content,
                hash: await computeHash(fileEntry.content),
                mtime: fileEntry.mtime
            });
        }
    }

    return manifest;
}

/**
 * Compares local and remote states against the last-known sync manifest to determine
 * what actions are needed. Uses hash comparison for accuracy and mtime comparison
 * with a 10-second safety window for last-write-wins conflict resolution.
 * @param {Map<string, { content: string | null; hash: string; mtime: number }>} localManifest - Local files with hashes
 * @param {Map<string, SyncFileInfo>} remoteMap - Remote files path->info
 * @param {SyncManifest | null} lastManifest - The manifest from the last successful sync
 * @returns {SyncActions} Actions to perform
 */
function resolveSyncActions(
    localManifest: Map<string, { content: string | null; hash: string; mtime: number }>,
    remoteMap: Map<string, SyncFileInfo>,
    lastManifest: SyncManifest | null
): SyncActions {
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflicts: SyncConflict[] = [];
    const deletions: SyncDeletion[] = [];

    const localPaths = new Set(localManifest.keys());
    const remotePaths = new Set(remoteMap.keys());
    const manifestPaths = new Set(lastManifest ? Object.keys(lastManifest) : []);

    // Files known from the last sync manifest — compare each against both local and remote
    for (const path of manifestPaths) {
        const lastEntry = lastManifest![path];
        const localEntry = localManifest.get(path) ?? null;
        const remoteInfo = remoteMap.get(path) ?? null;
        const localExists = localPaths.has(path);
        const remoteExists = remotePaths.has(path);

        if (localExists && remoteExists) {
            const localHashChanged = localEntry!.hash !== lastEntry.localHash;
            const remoteEtagChanged = remoteInfo!.etag !== lastEntry.remoteEtag;

            if (!localHashChanged && !remoteEtagChanged) {
                continue;
            }

            if (localHashChanged && !remoteEtagChanged) {
                uploads.push(path);
            } else if (!localHashChanged && remoteEtagChanged) {
                downloads.push(path);
            } else {
                // Both changed — last-write-wins with 10-second safety window
                const localMtime = localEntry!.mtime;
                const remoteMtime = parseRemoteMtime(remoteInfo!.lastModified);
                const diff = localMtime - remoteMtime;

                if (diff > SYNC_SAFETY_WINDOW_MS) {
                    uploads.push(path);
                } else if (diff < -SYNC_SAFETY_WINDOW_MS) {
                    downloads.push(path);
                } else {
                    conflicts.push({
                        path: path,
                        localContent: localEntry!.content ?? '',
                        remoteEtag: remoteInfo!.etag,
                        remoteLastModified: remoteInfo!.lastModified
                    });
                }
            }
        } else if (!localExists && remoteExists) {
            deletions.push({ path: path, location: 'remote' as const });
        } else if (localExists && !remoteExists) {
            deletions.push({ path: path, location: 'local' as const });
        }
    }

    // New files (not in last manifest)
    for (const path of localPaths) {
        if (!manifestPaths.has(path)) {
            uploads.push(path);
        }
    }
    for (const path of remotePaths) {
        if (!manifestPaths.has(path)) {
            downloads.push(path);
        }
    }

    return { uploads, downloads, conflicts, deletions };
}

/**
 * Executes deletions with safety gate
 * @param {SyncDeletion[]} deletions - Deletions to execute
 * @returns {Promise<void>}
 */
async function executeDeletions(deletions: SyncDeletion[]): Promise<void> {
    if (!ALLOW_CLOUD_DELETIONS) {
        for (const del of deletions) {
            alert('[CLOUD SYNC SAFETY] Would delete: ' + del.path + ' (location: ' + del.location + ')');
        }
        console.warn('[cloudSync] Deletions blocked by ALLOW_CLOUD_DELETIONS=false. Deletions:', deletions);
        return;
    }

    for (const del of deletions) {
        try {
            if (del.location === 'remote') {
                await deleteRemoteFile(del.path);
                console.log('[cloudSync] Deleted remote:', del.path);
            } else {
                await deleteLocalFile(del.path);
                console.log('[cloudSync] Deleted local:', del.path);
            }
        } catch (e) {
            console.error('[cloudSync] Failed to delete:', del.path, e);
        }
    }
}

/**
 * Shows a sync conflict resolution modal
 * @param {SyncConflict[]} conflicts - Conflicts to resolve
 * @returns {Promise<'local' | 'remote' | 'both'>} Resolution choice
 */
async function showConflictModal(conflicts: SyncConflict[]): Promise<'local' | 'remote' | 'both'> {
    // For each conflict, ask the user via a simple prompt
    // In v1 we use a simple approach: prompt for each file
    for (const conflict of conflicts) {
        const choice = confirm(
            'Sync conflict: "' + conflict.path + '"\n\n' +
            'Local file size: ' + conflict.localContent.length + ' chars\n' +
            'Remote last modified: ' + conflict.remoteLastModified + '\n\n' +
            'Click OK to keep local version, Cancel to download remote version.'
        );

        if (choice) {
            return 'local';
        } else {
            return 'remote';
        }
    }

    return 'local';
}

/**
 * Shows a deletion confirmation modal
 * @returns {Promise<boolean>} Whether deletions are confirmed
 */
async function showDeletionConfirmModal(): Promise<boolean> {
    return confirm('Sync would delete files. Allow deletions?');
}

/**
 * Performs a full sync cycle
 * @returns {Promise<void>}
 */
async function performSync(): Promise<void> {
    if (STATE.cloudSync.isSyncing) {
        console.log('[cloudSync] Already syncing, skipping');
        return;
    }

    STATE.cloudSync.isSyncing = true;
    ui.updateCloudSyncUI();

    try {
        console.log('[cloudSync] Starting sync...');

        const lastManifest = await loadSyncManifest();
        const localManifest = await buildLocalManifestWithHashes(lastManifest);
        console.log('[cloudSync] Local files:', localManifest.size);

        const remoteFiles = await listRemoteFiles();
        console.log('[cloudSync] Remote files:', remoteFiles.length);

        const remoteMap = new Map<string, SyncFileInfo>();
        remoteFiles.forEach(function(f) { remoteMap.set(f.path, f); });

        const actions = resolveSyncActions(localManifest, remoteMap, lastManifest);
        console.log('[cloudSync] Actions:', {
            uploads: actions.uploads.length,
            downloads: actions.downloads.length,
            conflicts: actions.conflicts.length,
            deletions: actions.deletions.length
        });

        // Handle conflicts
        if (actions.conflicts.length > 0) {
            const resolution = await showConflictModal(actions.conflicts);
            if (resolution === 'local') {
                for (const conflict of actions.conflicts) {
                    const entry = localManifest.get(conflict.path);
                    if (entry && entry.content) {
                        actions.uploads.push(conflict.path);
                    }
                }
            } else {
                for (const conflict of actions.conflicts) {
                    actions.downloads.push(conflict.path);
                }
            }
        }

        // Handle deletions
        if (actions.deletions.length > 0) {
            console.log('[cloudSync] Deletions pending:', actions.deletions);
            const confirmed = await showDeletionConfirmModal();
            if (confirmed) {
                await executeDeletions(actions.deletions);
            }
        }

        // Track ETags from uploads for the manifest
        /** @type {Map<string, string>} */
        const uploadedEtags = new Map<string, string>();

        // Execute uploads
        for (const path of actions.uploads) {
            const entry = localManifest.get(path);
            if (!entry || !entry.content) continue;
            console.log('[cloudSync] Uploading:', path);
            try {
                const etag = await uploadFile(path, entry.content);
                uploadedEtags.set(path, etag);
            } catch (e) {
                console.error('[cloudSync] Upload failed:', path, e);
            }
        }

        // Execute downloads
        for (const path of actions.downloads) {
            console.log('[cloudSync] Downloading:', path);
            try {
                const content = await downloadFile(path);
                if (content) {
                    await writeLocalFile(path, content);
                }
            } catch (e) {
                console.error('[cloudSync] Download failed:', path, e);
            }
        }

        // Build and persist the new sync manifest
        const newManifest: SyncManifest = {};

        for (const [path, localEntry] of localManifest) {
            const remoteInfo = remoteMap.get(path) ?? null;
            if (remoteInfo) {
                newManifest[path] = {
                    localHash: localEntry.hash,
                    remoteEtag: uploadedEtags.get(path) ?? remoteInfo.etag,
                    localMtime: localEntry.mtime,
                    remoteMtime: remoteInfo.lastModified
                };
            } else if (uploadedEtags.has(path)) {
                newManifest[path] = {
                    localHash: localEntry.hash,
                    remoteEtag: uploadedEtags.get(path)!,
                    localMtime: localEntry.mtime,
                    remoteMtime: new Date().toUTCString()
                };
            }
        }

        // Capture state of newly downloaded files so they aren't re-uploaded next sync
        for (const path of actions.downloads) {
            const remoteInfo = remoteMap.get(path);
            if (!remoteInfo) continue;
            const fileEntry = await readLocalFileWithMtime(path);
            if (fileEntry) {
                newManifest[path] = {
                    localHash: await computeHash(fileEntry.content),
                    remoteEtag: remoteInfo.etag,
                    localMtime: fileEntry.mtime,
                    remoteMtime: remoteInfo.lastModified
                };
            }
        }

        // Remove deleted files from manifest
        for (const del of actions.deletions) {
            delete newManifest[del.path];
        }

        await saveSyncManifest(newManifest);

        STATE.cloudSync.lastSyncTime = new Date().toISOString();
        STATE.cloudSync.lastError = null;
        console.log('[cloudSync] Sync complete');
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown sync error';
        STATE.cloudSync.lastError = msg;
        console.error('[cloudSync] Sync failed:', e);
    } finally {
        STATE.cloudSync.isSyncing = false;
        ui.updateCloudSyncUI();
    }
}

/**
 * Initializes the cloud sync module
 * Should be called after Clerk auth is initialized
 * @returns {Promise<void>}
 */
export async function initCloudSync(): Promise<void> {
    if (!isClerkEnabled() || !isSignedIn()) {
        console.log('[cloudSync] Clerk not available or not signed in');
        return;
    }

    console.log('[cloudSync] Initializing...');

    // Load persisted state
    const savedState = await readLocalFile('preferences/cloudSync');
    if (savedState) {
        try {
            const parsed = JSON.parse(savedState) as Partial<CloudSyncState>;
            if (typeof parsed.enabled === 'boolean') STATE.cloudSync.enabled = parsed.enabled;
            if (typeof parsed.deleteRemoteOnLocalDelete === 'boolean') STATE.cloudSync.deleteRemoteOnLocalDelete = parsed.deleteRemoteOnLocalDelete;
            if (parsed.lastSyncTime) STATE.cloudSync.lastSyncTime = parsed.lastSyncTime;
        } catch (e) {
            console.warn('[cloudSync] Failed to parse saved state:', e);
        }
    }

    // Startup verification: sync if enabled
    if (STATE.cloudSync.enabled) {
        await performSync();
    }

    // Start periodic timer
    if (syncTimerId !== null) {
        clearInterval(syncTimerId);
    }
    syncTimerId = window.setInterval(function() {
        if (STATE.cloudSync.enabled) {
            performSync();
        }
    }, SYNC_INTERVAL_MS);

    ui.updateCloudSyncUI();
}

/**
 * Enables cloud sync and triggers initial sync
 * @returns {Promise<void>}
 */
export async function enableCloudSync(): Promise<void> {
    STATE.cloudSync.enabled = true;
    await saveCloudSyncState();
    ui.updateCloudSyncUI();
    await performSync();
}

/**
 * Disables cloud sync
 * @returns {void}
 */
export function disableCloudSync(): void {
    STATE.cloudSync.enabled = false;
    STATE.cloudSync.lastError = null;
    saveCloudSyncState();
    ui.updateCloudSyncUI();
}

/**
 * Saves the cloud sync state to OPFS
 * @returns {Promise<void>}
 */
async function saveCloudSyncState(): Promise<void> {
    const state: CloudSyncState = {
        enabled: STATE.cloudSync.enabled,
        deleteRemoteOnLocalDelete: STATE.cloudSync.deleteRemoteOnLocalDelete,
        lastSyncTime: STATE.cloudSync.lastSyncTime,
        isSyncing: false,
        lastError: null
    };
    await writeLocalFile('preferences/cloudSync', JSON.stringify(state));
}

/**
 * Sets whether deleting locally also deletes from cloud
 * @param {boolean} enabled - New setting value
 * @returns {void}
 */
export function setDeleteRemoteOnLocalDelete(enabled: boolean): void {
    STATE.cloudSync.deleteRemoteOnLocalDelete = enabled;
    saveCloudSyncState();
}

/**
 * Triggers a manual sync immediately
 * @returns {Promise<void>}
 */
export async function triggerManualSync(): Promise<void> {
    if (STATE.cloudSync.isSyncing) return;
    await performSync();
}

/**
 * Queues a sync with debouncing (2-second delay)
 * @returns {void}
 */
export function queueSync(): void {
    if (pendingSyncTimeout !== null) {
        clearTimeout(pendingSyncTimeout);
    }
    pendingSyncTimeout = window.setTimeout(async function() {
        pendingSyncTimeout = null;
        if (STATE.cloudSync.enabled) {
            await performSync();
        }
    }, 2000);
}
