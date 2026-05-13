/**
 * Cloud Sync Module
 * Syncs OPFS data to Backblaze B2 via FindForge Storage Worker
 * Authenticated through Clerk
 */

import { Modal } from 'bootstrap';
import { getClerkToken, isSignedIn, isClerkEnabled } from './auth';
import { getOPFSHandle, ensureDirectory, readCloudPreference, writeCloudPreference, readLocalFile, writeLocalFile, deleteLocalFile, walkOpfsDirectory } from './opfs';
import { STATE } from './state';
import * as ui from './ui';
import type { SyncFileInfo, SyncConflict, SyncDeletion, SyncActions, SyncManifest, WorkerErrorResponse, SyncJournalEntry } from './types/cloudSync';
import type { CloudSyncState } from './types/state';

// Toggle to target the local dev worker instead of production
const USE_DEV_WORKER = false;

const WORKER_BASE_URL = USE_DEV_WORKER
    ? 'http://localhost:8787'
    : 'https://findforge-storage.chris-f57.workers.dev';
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
export const ALLOW_CLOUD_DELETIONS = false;
export const CLOUD_PREFIX = 'translate/';
const MANIFEST_PATH = 'preferences/syncManifest';
const CLOUD_STATE_PATH = 'cloud-state.json';
const SYNC_SAFETY_WINDOW_MS = 10000;

/** @type {number | null} */
let syncTimerId: number | null = null;

/** @type {number | null} */
let pendingSyncTimeout: number | null = null;

/** @type {string | null} */
let cachedToken: string | null = null;

/** @type {number | null} */
let tokenExpiryTime: number | null = null;

/** @type {Promise<void>} */
let syncLock: Promise<void> = Promise.resolve();

/** @type {string[]} */
let changedPaths: string[] = [];

/** @type {((changedPaths: string[]) => Promise<void>) | null} */
let onSyncReload: ((changedPaths: string[]) => Promise<void>) | null = null;

/**
 * Registers a callback that fires after sync completes with paths that changed.
 * @param {(changedPaths: string[]) => Promise<void>} callback
 * @returns {void}
 */
export function setSyncReloadCallback(callback: (changedPaths: string[]) => Promise<void>): void {
    onSyncReload = callback;
}

/**
 * Acquires the sync mutex lock. Returns a release callback.
 * Ensures only one sync operation runs at a time.
 * @returns {Promise<() => void>} Release function
 */
async function acquireSyncLock(): Promise<() => void> {
    let release: () => void;
    const newLock = new Promise<void>(function(resolve) { release = resolve; });
    const previousLock = syncLock;
    syncLock = previousLock.then(function() { return newLock; });
    await previousLock;
    return function() { release!(); };
}

/**
 * Runs a sync function under the mutex lock with UI state management.
 * @param {() => Promise<void>} fn - Sync function to run
 * @returns {Promise<void>}
 */
async function withSyncLock(fn: () => Promise<void>): Promise<void> {
    const release = await acquireSyncLock();
    STATE.cloudSync.isSyncing = true;
    ui.updateCloudSyncUI();
    try {
        await fn();
        STATE.cloudSync.lastError = null;
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown sync error';
        STATE.cloudSync.lastError = msg;
        console.error('[cloudSync] Sync failed:', e);
    } finally {
        STATE.cloudSync.isSyncing = false;
        ui.hideSyncProgress();
        ui.updateCloudSyncUI();
        release();
        const changed = changedPaths;
        changedPaths = [];
        if (changed.length > 0 && onSyncReload) {
            onSyncReload(changed).catch(function(e) {
                console.error('[cloudSync] Reload callback failed:', e);
            });
        }
    }
}

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
export async function listRemoteFiles(prefix?: string): Promise<SyncFileInfo[]> {
    const allFiles: SyncFileInfo[] = [];
    let continuationToken: string | undefined;

    do {
        const url = new URL(WORKER_BASE_URL + '/');
        url.searchParams.set('list-type', '2');
        if (prefix) {
            url.searchParams.set('prefix', prefix);
        }
        if (continuationToken) {
            url.searchParams.set('continuation-token', continuationToken);
        }

        const response = await fetchWithAuth(url.toString());
        const xml = await response.text();
        const result = parseListObjectsXml(xml);

        for (const f of result.files) {
            const strippedPath = f.path.startsWith(CLOUD_PREFIX)
                ? f.path.slice(CLOUD_PREFIX.length)
                : f.path;
            if (strippedPath !== CLOUD_STATE_PATH) {
                allFiles.push({ ...f, path: strippedPath });
            }
        }

        continuationToken = result.nextContinuationToken ?? undefined;
    } while (continuationToken);

    return allFiles;
}

/**
 * Uploads a file to the remote storage worker
 * @param {string} path - Remote file path
 * @param {string | Blob} content - File content
 * @returns {Promise<string>} The ETag returned by the worker
 */
export async function uploadFile(path: string, content: string | Blob): Promise<string> {
    const url = WORKER_BASE_URL + '/' + CLOUD_PREFIX + encodeURIComponent(path);

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
    return (response.headers.get('ETag') ?? '').replace(/^"/, '').replace(/"$/, '');
}

/**
 * Downloads a file from the remote storage worker.
 * Returns ArrayBuffer for .png files, string for text files.
 * @param {string} path - Remote file path
 * @returns {Promise<string | ArrayBuffer>} File content as text or raw bytes
 */
export async function downloadFile(path: string): Promise<string | ArrayBuffer> {
    const url = WORKER_BASE_URL + '/' + CLOUD_PREFIX + encodeURIComponent(path);
    const response = await fetchWithAuth(url);

    if (path.endsWith('.png')) {
        return await response.arrayBuffer();
    }
    return await response.text();
}

/**
 * Deletes a file from the remote storage worker (safety-gated)
 * @param {string} path - Remote file path
 * @returns {Promise<void>}
 */
export async function deleteRemoteFile(path: string): Promise<void> {
    const url = WORKER_BASE_URL + '/' + CLOUD_PREFIX + encodeURIComponent(path);
    await fetchWithAuth(url, { method: 'DELETE' });
}

/**
 * Uploads a cloud-state.json file to signal that the remote state has changed.
 * @param {string} lastUpdateTime - ISO timestamp of the last write
 * @returns {Promise<void>}
 */
export async function uploadCloudState(lastUpdateTime: string): Promise<void> {
    const content = JSON.stringify({ lastUpdateTime: lastUpdateTime });
    await uploadFile(CLOUD_STATE_PATH, content);
}

/**
 * Downloads and parses the cloud-state.json file from the remote worker.
 * @returns {Promise<{ lastUpdateTime: string } | null>} Cloud state or null
 */
export async function downloadCloudState(): Promise<{ lastUpdateTime: string } | null> {
    try {
        const content = await downloadFile(CLOUD_STATE_PATH);
        return JSON.parse(content as string) as { lastUpdateTime: string };
    } catch {
        return null;
    }
}

/**
 * Computes MD5 hash of a string or raw bytes.
 * MD5 matches B2's ETag format, enabling direct local-vs-remote comparison.
 * @param {string | ArrayBuffer} content - Content to hash (string for text, ArrayBuffer for binary)
 * @returns {string} Hex-encoded MD5 hash
 */
export function computeHash(content: string | ArrayBuffer): string {
    let bytes: Uint8Array;
    if (typeof content === 'string') {
        bytes = new TextEncoder().encode(content);
    } else {
        bytes = new Uint8Array(content);
    }

    const s = [
        7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,  7, 12, 17, 22,
        5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,  5,  9, 14, 20,
        4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,  4, 11, 16, 23,
        6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21,  6, 10, 15, 21
    ];

    const K = new Uint32Array([
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
        0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
        0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
        0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
        0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
    ]);

    function leftRotate(x: number, c: number): number {
        return ((x << c) | (x >>> (32 - c))) >>> 0;
    }

    /**
     * Converts a 32-bit MD5 state word to 8 hex characters.
     * MD5 operates on little-endian words, but standard hex representation
     * lists bytes from most- to least-significant within each word.
     * @param {number} n - 32-bit state word
     * @returns {string} 8-character hex string
     */
    function md5ToHexChars(n: number): string {
        const b3 = (n >>> 24) & 0xFF;  // most significant byte
        const b2 = (n >>> 16) & 0xFF;
        const b1 = (n >>> 8) & 0xFF;
        const b0 = (n >>> 0) & 0xFF;   // least significant byte
        return [b3, b2, b1, b0].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;

    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const numBits = bytes.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, numBits >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(numBits / 0x100000000) >>> 0, true);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        const w = new Uint32Array(16);
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(offset + i * 4, true);
        }

        let a = h0, b = h1, c = h2, d = h3;

        for (let i = 0; i < 64; i++) {
            let f: number, g: number;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }

            f = f >>> 0;
            const temp = d;
            d = c;
            c = b;
            b = (b + leftRotate((a + f + K[i] + w[g]) >>> 0, s[i])) >>> 0;
            a = temp;
        }

        h0 = (h0 + a) >>> 0;
        h1 = (h1 + b) >>> 0;
        h2 = (h2 + c) >>> 0;
        h3 = (h3 + d) >>> 0;
    }

    return md5ToHexChars(h0) + md5ToHexChars(h1) + md5ToHexChars(h2) + md5ToHexChars(h3);
}

/**
 * Decodes the five standard XML entities in a string.
 * Must decode &amp; last to avoid double-decoding.
 * @param {string} text - Text with XML entities
 * @returns {string} Decoded text
 */
function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Extracts the text content of the first occurrence of a tag in an XML fragment.
 * Handles simple tag bodies; does not support nested tags of the same name.
 * Tag metacharacters are escaped for safe regex construction.
 * XML entities are decoded in the result.
 * @param {string} xml - XML fragment to search
 * @param {string} tag - Tag name (case-sensitive)
 * @returns {string} Tag body text, or empty string if not found
 */
function extractXmlTag(xml: string, tag: string): string {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`);
    const m = xml.match(regex);
    return m ? decodeXmlEntities(m[1]) : '';
}

/**
 * Parses a single page of B2 ListObjectsV2 XML response.
 * Extracts file entries and any continuation token for pagination.
 * Uses a lightweight tag extractor instead of DOM parsing.
 * @param {string} xml - Raw XML response body
 * @returns {{ files: SyncFileInfo[]; nextContinuationToken: string | null }}
 */
function parseListObjectsXml(xml: string): { files: SyncFileInfo[]; nextContinuationToken: string | null } {
    if (!xml.includes('<ListBucketResult')) {
        console.warn('[cloudSync] Unexpected ListObjects response (missing <ListBucketResult>)');
        return { files: [], nextContinuationToken: null };
    }

    const files: SyncFileInfo[] = [];
    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match: RegExpExecArray | null;

    while ((match = contentsRegex.exec(xml)) !== null) {
        const block = match[1];

        const key = extractXmlTag(block, 'Key');
        const etagRaw = extractXmlTag(block, 'ETag');
        const sizeStr = extractXmlTag(block, 'Size');
        const lastMod = extractXmlTag(block, 'LastModified');

        if (!key) continue;
        if (!etagRaw) continue;
        if (!sizeStr) continue;
        if (!lastMod) continue;

        const etag = etagRaw.replace(/^"/, '').replace(/"$/, '');
        const size = parseInt(sizeStr, 10);
        if (isNaN(size)) continue;

        files.push({ path: key, etag, size, lastModified: lastMod });
    }

    const nextContinuationToken = extractXmlTag(xml, 'NextContinuationToken');
    return { files, nextContinuationToken: nextContinuationToken || null };
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
 * Reads a local OPFS file with its last-modified timestamp.
 * For text files (.json), reads as string. For binary files (.png),
 * reads as ArrayBuffer. The unused field is null.
 * @param {string} path - OPFS path relative to root
 * @returns {Promise<{ content: string | null; bytes: ArrayBuffer | null; mtime: number } | null>} File content, raw bytes, and mtime
 */
export async function readLocalFileWithMtime(path: string): Promise<{ content: string | null; bytes: ArrayBuffer | null; mtime: number } | null> {
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

        if (path.endsWith('.png')) {
            const bytes = await fileObj.arrayBuffer();
            return { content: null, bytes, mtime: fileObj.lastModified };
        }
        const content = await fileObj.text();
        return { content, bytes: null, mtime: fileObj.lastModified };
    } catch (e) {
        console.warn('[cloudSync] Failed to read local file:', path, e);
        return null;
    }
}

/**
 * Loads the persisted sync manifest from OPFS
 * @returns {Promise<SyncManifest | null>} The manifest, or null
 */
export async function loadSyncManifest(): Promise<SyncManifest | null> {
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
export async function saveSyncManifest(manifest: SyncManifest): Promise<void> {
    await writeLocalFile(MANIFEST_PATH, JSON.stringify(manifest));
}

/**
 * Builds a local manifest with hashes and mtimes, using the last sync manifest
 * as a fast-path cache to avoid re-reading unchanged files.
 * For .png files, content is null and hash is computed from raw bytes.
 * @param {SyncManifest | null} lastManifest - The manifest from the last successful sync
 * @returns {Promise<Map<string, { content: string | null; hash: string; mtime: number }>>} Map of path -> { content, hash, mtime }
 */
export async function buildLocalManifestWithHashes(lastManifest: SyncManifest | null): Promise<Map<string, { content: string | null; hash: string; mtime: number }>> {
    const manifest = new Map<string, { content: string | null; hash: string; mtime: number }>();
    const root = await getOPFSHandle();
    const files = await walkOpfsDirectory(root, '');

    for (const filePath of files) {
        if (filePath === MANIFEST_PATH) continue;

        const fileEntry = await readLocalFileWithMtime(filePath);
        if (fileEntry === null) continue;

        const lastEntry = lastManifest?.[filePath];
        const isValidMd5 = lastEntry?.localHash?.length === 32;

        const raw = fileEntry.content ?? fileEntry.bytes!;
        const hash = isValidMd5 && fileEntry.mtime === lastEntry.localMtime
            ? lastEntry.localHash
            : computeHash(raw);
        manifest.set(filePath, { content: fileEntry.content, hash, mtime: fileEntry.mtime });
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
export function resolveSyncActions(
    localManifest: Map<string, { content: string | null; hash: string; mtime: number }>,
    remoteMap: Map<string, SyncFileInfo>,
    lastManifest: SyncManifest | null
): SyncActions {
    const uploads: string[] = [];
    const downloads: string[] = [];
    const conflicts: SyncConflict[] = [];
    const deletions: SyncDeletion[] = [];
    const identical: string[] = [];

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
            const localHashChanged = localEntry!.hash.toLowerCase() !== lastEntry.localHash.toLowerCase();
            const remoteEtagChanged = remoteInfo!.etag.toLowerCase() !== lastEntry.remoteEtag.toLowerCase();

            if (!localHashChanged && !remoteEtagChanged) {
                continue;
            }

            if (localHashChanged && !remoteEtagChanged) {
                uploads.push(path);
            } else if (!localHashChanged && remoteEtagChanged) {
                downloads.push(path);
            } else {
                const localMtime = localEntry!.mtime;
                const remoteMtime = parseRemoteMtime(remoteInfo!.lastModified);
                const diff = localMtime - remoteMtime;

                if (diff > SYNC_SAFETY_WINDOW_MS) {
                    uploads.push(path);
                } else if (diff < -SYNC_SAFETY_WINDOW_MS) {
                    downloads.push(path);
                } else {
                    if (path.endsWith('.png')) {
                        uploads.push(path);
                    } else {
                        conflicts.push({
                            path: path,
                            localContent: localEntry!.content ?? '',
                            remoteEtag: remoteInfo!.etag,
                            remoteLastModified: remoteInfo!.lastModified
                        });
                    }
                }
            }
        } else if (!localExists && remoteExists) {
            console.warn('[cloudSync] File in manifest but not readable locally, skipping remote deletion:', path);
        } else if (localExists && !remoteExists) {
            deletions.push({ path: path, location: 'local' as const });
        }
    }

    // Files on both sides but NOT in last manifest (first sync / re-sync)
    for (const path of localPaths) {
        if (!manifestPaths.has(path) && remotePaths.has(path)) {
            const localEntry = localManifest.get(path)!;
            const remoteInfo = remoteMap.get(path)!;

            if (localEntry.hash === remoteInfo.etag) {
                identical.push(path);
            } else {
                const localMtime = localEntry.mtime;
                const remoteMtime = parseRemoteMtime(remoteInfo.lastModified);
                const diff = localMtime - remoteMtime;

                if (diff > SYNC_SAFETY_WINDOW_MS) {
                    uploads.push(path);
                } else if (diff < -SYNC_SAFETY_WINDOW_MS) {
                    downloads.push(path);
                } else {
                    if (path.endsWith('.png')) {
                        uploads.push(path);
                    } else {
                        conflicts.push({
                            path: path,
                            localContent: localEntry.content ?? '',
                            remoteEtag: remoteInfo.etag,
                            remoteLastModified: remoteInfo.lastModified
                        });
                    }
                }
            }
        }
    }

    // New files only on local
    for (const path of localPaths) {
        if (!manifestPaths.has(path) && !remotePaths.has(path)) {
            uploads.push(path);
        }
    }

    // New files only on remote
    for (const path of remotePaths) {
        if (!manifestPaths.has(path) && !localPaths.has(path)) {
            downloads.push(path);
        }
    }

    return { uploads, downloads, conflicts, deletions, identical };
}

/**
 * Executes deletions with safety gate.
 * Calls onSuccess(del) after each successful deletion for the caller to
 * update manifests, journal, or other bookkeeping.
 * @param {SyncDeletion[]} deletions - Deletions to execute
 * @param {(deleted: SyncDeletion) => void | Promise<void>} [onSuccess] - Called after each successful deletion
 * @returns {Promise<void>}
 */
async function executeDeletions(deletions: SyncDeletion[], onSuccess?: (deleted: SyncDeletion) => void | Promise<void>): Promise<void> {
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
            if (onSuccess) {
                await onSuccess(del);
            }
        } catch (e) {
            console.error('[cloudSync] Failed to delete:', del.path, e);
        }
    }
}

/**
 * Shows a per-file sync conflict resolution modal with local/remote timestamps.
 * @param {SyncConflict[]} conflicts - Files with changes on both sides
 * @param {Map<string, { content: string | null; hash: string; mtime: number }>} localManifest - Local files with metadata
 * @param {Map<string, SyncFileInfo>} remoteMap - Remote files with metadata
 * @returns {Promise<Map<string, 'local' | 'remote'>>} Resolution choices per file path
 */
export async function showConflictModal(
    conflicts: SyncConflict[],
    localManifest: Map<string, { content: string | null; hash: string; mtime: number }>,
    remoteMap: Map<string, SyncFileInfo>
): Promise<Map<string, 'local' | 'remote'>> {
    const template = document.getElementById('sync-conflict-modal-template') as HTMLTemplateElement | null;
    if (!template) {
        const resolutions = new Map<string, 'local' | 'remote'>();
        for (const conflict of conflicts) {
            const choice = confirm(
                'Sync conflict: "' + conflict.path + '"\n\n' +
                'Local file size: ' + conflict.localContent.length + ' chars\n' +
                'Remote last modified: ' + conflict.remoteLastModified + '\n\n' +
                'Click OK to keep local version, Cancel to download remote version.'
            );
            resolutions.set(conflict.path, choice ? 'local' : 'remote');
        }
        return resolutions;
    }

    return new Promise(function(resolve) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const modalEl = clone.querySelector('.modal') as HTMLElement;
        const listEl = clone.querySelector('.sync-conflict-list') as HTMLElement;
        const confirmBtn = clone.querySelector('.sync-conflict-confirm-btn') as HTMLButtonElement;

        for (const conflict of conflicts) {
            const localMtime = localManifest.get(conflict.path)?.mtime;
            const remoteMtime = remoteMap.get(conflict.path)?.lastModified;

            const li = document.createElement('div');
            li.className = 'list-group-item';

            const pathStrong = document.createElement('strong');
            pathStrong.textContent = conflict.path;
            li.appendChild(pathStrong);

            const timeDiv = document.createElement('div');
            timeDiv.className = 'text-muted small mb-2';
            timeDiv.textContent = 'Local: ' + (localMtime ? new Date(localMtime).toLocaleString() : 'unknown') +
                ' — Remote: ' + (remoteMtime ? new Date(remoteMtime).toLocaleString() : 'unknown');
            li.appendChild(timeDiv);

            const btnGroup = document.createElement('div');
            btnGroup.className = 'btn-group btn-group-sm conflict-btn-group';
            btnGroup.setAttribute('role', 'group');
            btnGroup.setAttribute('aria-label', 'Conflict resolution for ' + conflict.path);

            const localRadio = document.createElement('input');
            localRadio.type = 'radio';
            localRadio.className = 'btn-check';
            localRadio.name = 'conflict-' + conflict.path;
            localRadio.id = 'conflict-local-' + conflict.path;
            localRadio.value = 'local';
            localRadio.checked = true;

            const localLabel = document.createElement('label');
            localLabel.className = 'btn btn-outline-primary';
            localLabel.htmlFor = localRadio.id;
            localLabel.textContent = 'Keep Local';

            const remoteRadio = document.createElement('input');
            remoteRadio.type = 'radio';
            remoteRadio.className = 'btn-check';
            remoteRadio.name = 'conflict-' + conflict.path;
            remoteRadio.id = 'conflict-remote-' + conflict.path;
            remoteRadio.value = 'remote';

            const remoteLabel = document.createElement('label');
            remoteLabel.className = 'btn btn-outline-secondary';
            remoteLabel.htmlFor = remoteRadio.id;
            remoteLabel.textContent = 'Download Remote';

            btnGroup.appendChild(localRadio);
            btnGroup.appendChild(localLabel);
            btnGroup.appendChild(remoteRadio);
            btnGroup.appendChild(remoteLabel);
            li.appendChild(btnGroup);

            listEl.appendChild(li);
        }

        document.body.appendChild(clone);

        const modal = new Modal(modalEl);

        confirmBtn.addEventListener('click', function() {
            modal.hide();

            const resolutions = new Map<string, 'local' | 'remote'>();
            for (const conflict of conflicts) {
                const localRadioEl = document.getElementById('conflict-local-' + conflict.path) as HTMLInputElement | null;
                resolutions.set(conflict.path, localRadioEl?.checked ? 'local' : 'remote');
            }
            resolve(resolutions);
        });

        modalEl.addEventListener('hidden.bs.modal', function() {
            modalEl.remove();
            const resolutions = new Map<string, 'local' | 'remote'>();
            for (const conflict of conflicts) {
                resolutions.set(conflict.path, 'local');
            }
            resolve(resolutions);
        });

        modal.show();
    });
}

/**
 * Shows a deletion confirmation modal with rich file details.
 * @param {SyncDeletion[]} deletions - Files to be deleted
 * @param {Map<string, { content: string | null; hash: string; mtime: number }>} localManifest - Local files with metadata
 * @param {Map<string, SyncFileInfo>} remoteMap - Remote files with metadata
 * @returns {Promise<boolean>} Whether deletions are confirmed
 */
export async function showDeletionConfirmModal(
    deletions: SyncDeletion[],
    localManifest: Map<string, { content: string | null; hash: string; mtime: number }>,
    remoteMap: Map<string, SyncFileInfo>
): Promise<boolean> {
    const template = document.getElementById('sync-deletion-modal-template') as HTMLTemplateElement | null;
    if (!template) {
        return confirm('Sync would delete files. Allow deletions?');
    }

    return new Promise(function(resolve) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const modalEl = clone.querySelector('.modal') as HTMLElement;
        const listEl = clone.querySelector('.sync-deletion-list') as HTMLElement;
        const confirmBtn = clone.querySelector('.sync-deletion-confirm-btn') as HTMLButtonElement;
        const skipBtn = clone.querySelector('.sync-deletion-skip-btn') as HTMLButtonElement;

        for (const del of deletions) {
            const li = document.createElement('li');
            li.className = 'list-group-item';

            const headerDiv = document.createElement('div');
            headerDiv.className = 'd-flex justify-content-between align-items-start';

            const pathStrong = document.createElement('strong');
            pathStrong.textContent = del.path;

            const badge = document.createElement('span');
            badge.className = 'badge bg-secondary';
            badge.textContent = del.location;

            headerDiv.appendChild(pathStrong);
            headerDiv.appendChild(badge);
            li.appendChild(headerDiv);

            const timeDiv = document.createElement('div');
            timeDiv.className = 'text-muted small';
            let timestamp = '';

            if (del.location === 'local') {
                const localEntry = localManifest.get(del.path);
                if (localEntry) {
                    timestamp = new Date(localEntry.mtime).toLocaleString();
                }
            } else {
                const remoteInfo = remoteMap.get(del.path);
                if (remoteInfo && remoteInfo.lastModified) {
                    timestamp = new Date(remoteInfo.lastModified).toLocaleString();
                }
            }

            if (timestamp) {
                timeDiv.textContent = timestamp;
                li.appendChild(timeDiv);
            }

            const snippetDiv = document.createElement('div');
            snippetDiv.className = 'small text-truncate';

            if (del.location === 'local') {
                const localEntry = localManifest.get(del.path);
                if (localEntry && localEntry.content) {
                    snippetDiv.textContent = formatDeletionSnippet(del.path, localEntry.content);
                } else if (localEntry && localEntry.content === null) {
                    snippetDiv.textContent = '(unchanged file, content not loaded)';
                } else {
                    snippetDiv.textContent = '(file not found)';
                }
            } else {
                snippetDiv.textContent = 'Will be deleted from cloud storage';
            }

            li.appendChild(snippetDiv);
            listEl.appendChild(li);
        }

        document.body.appendChild(clone);

        const modal = new Modal(modalEl);

        confirmBtn.addEventListener('click', function() {
            modal.hide();
            resolve(true);
        });

        skipBtn.addEventListener('click', function() {
            modal.hide();
            resolve(false);
        });

        modalEl.addEventListener('hidden.bs.modal', function() {
            modalEl.remove();
            resolve(false);
        });

        modal.show();
    });
}

/**
 * Generates a human-readable content snippet for a file being deleted.
 * For JSON files, tries to extract meaningful fields (name, source, title).
 * Falls back to raw text prefix.
 * @param {string} path - File path
 * @param {string} content - File content
 * @returns {string} Snippet text
 */
function formatDeletionSnippet(path: string, content: string): string {
    if (!path.endsWith('.json')) {
        const trimmed = content.substring(0, 100).replace(/\s+/g, ' ');
        return trimmed + (content.length > 100 ? '...' : '');
    }

    try {
        const data = JSON.parse(content);
        const snippet = data?.name ?? data?.title ?? data?.source ?? '';
        if (snippet && typeof snippet === 'string') {
            const trimmed = snippet.substring(0, 100).replace(/\s+/g, ' ');
            return trimmed + (snippet.length > 100 ? '...' : '');
        }
    } catch {
    }

    const trimmed = content.substring(0, 100).replace(/\s+/g, ' ');
    return trimmed + (content.length > 100 ? '...' : '');
}

/**
 * Shows the initial sync modal on first-time cloud sync.
 * Offers the user the choice to download remote data or upload local data.
 * @returns {Promise<'download' | 'upload'>} User's choice
 */
async function showInitialSyncModal(): Promise<'download' | 'upload'> {
    const template = document.getElementById('initial-sync-modal-template') as HTMLTemplateElement | null;
    if (!template) {
        const choice = confirm(
            'First-time cloud sync.\n\n' +
            'Click OK to download data from the cloud.\n' +
            'Click Cancel to upload your local data instead.'
        );
        return choice ? 'download' : 'upload';
    }

    return new Promise(function(resolve) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const modalEl = clone.querySelector('.modal') as HTMLElement;
        const downloadBtn = clone.querySelector('.initial-sync-download-btn') as HTMLButtonElement;
        const uploadBtn = clone.querySelector('.initial-sync-upload-btn') as HTMLButtonElement;

        document.body.appendChild(clone);

        const modal = new Modal(modalEl);

        downloadBtn.addEventListener('click', function() {
            modal.hide();
            resolve('download');
        });

        uploadBtn.addEventListener('click', function() {
            modal.hide();
            resolve('upload');
        });

        modalEl.addEventListener('hidden.bs.modal', function() {
            modalEl.remove();
            resolve('download');
        });

        modal.show();
    });
}

/**
 * Shows a modal asking the user which side should take priority during a complete re-sync.
 * @returns {Promise<'local' | 'cloud'>} User's choice
 */
async function showResyncChoiceModal(): Promise<'local' | 'cloud'> {
    const template = document.getElementById('resync-choice-modal-template') as HTMLTemplateElement | null;
    if (!template) {
        const choice = confirm(
            'Complete re-sync.\n\n' +
            'Click OK for Local takes priority.\n' +
            'Click Cancel for Cloud takes priority.'
        );
        return choice ? 'local' : 'cloud';
    }

    return new Promise(function(resolve) {
        const clone = template.content.cloneNode(true) as DocumentFragment;
        const modalEl = clone.querySelector('.modal') as HTMLElement;
        const localBtn = clone.querySelector('.resync-local-btn') as HTMLButtonElement;
        const cloudBtn = clone.querySelector('.resync-cloud-btn') as HTMLButtonElement;

        document.body.appendChild(clone);

        const modal = new Modal(modalEl);

        localBtn.addEventListener('click', function() {
            modal.hide();
            resolve('local');
        });

        cloudBtn.addEventListener('click', function() {
            modal.hide();
            resolve('cloud');
        });

        modalEl.addEventListener('hidden.bs.modal', function() {
            modalEl.remove();
            resolve('local');
        });

        modal.show();
    });
}

/**
 * Pushes local dirty files to the cloud.
 * Checks cloud-state before writing to detect interleaved writes.
 * If the cloud was modified since last check, pulls first.
 * Internal function — callers should use syncToCloud, syncBothWays, or syncReset.
 * @returns {Promise<void>}
 */
async function syncToCloudInternal(): Promise<void> {
    const syncJournal = await import('./syncJournal');
    const dirtyPaths = syncJournal.getDirtyPaths();
    if (dirtyPaths.size === 0) return;

    console.log('[cloudSync] Write sync with ' + dirtyPaths.size + ' dirty paths');

    const checkpoint = syncJournal.getCheckpoint();
    const manifest: SyncManifest = await loadSyncManifest() ?? {};
    let lastSuccessfulId = checkpoint.lastId;

    // Check if cloud was modified by another device since our last check
    const cloudState = await downloadCloudState();
    if (cloudState?.lastUpdateTime && checkpoint.lastCloudCheckTime &&
        cloudState.lastUpdateTime > checkpoint.lastCloudCheckTime) {
        console.log('[cloudSync] Cloud modified since last check, pulling first');
        await syncFromCloudInternal();
        // Re-check dirty paths (read sync may have resolved them)
        const stillDirty = syncJournal.getDirtyPaths();
        if (stillDirty.size === 0) return;
        // Re-evaluate remaining dirty paths: files overwritten by read sync
        // may have different hashes than what their journal entries recorded
        for (const [path, entry] of stillDirty) {
            if (entry.op === 'write') {
                const fileEntry = await readLocalFileWithMtime(path);
                if (!fileEntry) continue;
                const raw = fileEntry.content ?? fileEntry.bytes!;
                const currentHash = computeHash(raw);
                if (currentHash !== entry.hash) {
                    // File was overwritten by read sync — update in-memory hash
                    entry.hash = currentHash;
                    entry.mtime = fileEntry.mtime;
                }
            }
        }
    }

    // Process each dirty path
    const totalDirty = dirtyPaths.size;
    let processedDirty = 0;
    ui.showSyncProgress(0, totalDirty);
    for (const [path, entry] of dirtyPaths) {
        processedDirty++;
        ui.showSyncProgress(processedDirty, totalDirty);
        if (entry.op === 'delete') {
            if (ALLOW_CLOUD_DELETIONS) {
                try {
                    await deleteRemoteFile(path);
                    console.log('[cloudSync] Deleted remote:', path);
                    delete manifest[path];
                    lastSuccessfulId = Math.max(lastSuccessfulId, entry.id);
                } catch (e) {
                    console.error('[cloudSync] Failed to delete remote:', path, e);
                    // Keep manifest entry so read sync doesn't re-download
                }
            }
            // If deletions disabled, keep manifest entry
        } else if (entry.op === 'deleteRecursive') {
            const remoteFiles = await listRemoteFiles(CLOUD_PREFIX + path);
            let allDeleted = true;
            const deletedPaths: string[] = [];
            if (ALLOW_CLOUD_DELETIONS) {
                for (const file of remoteFiles) {
                    try {
                        await deleteRemoteFile(file.path);
                        console.log('[cloudSync] Deleted remote:', file.path);
                        deletedPaths.push(file.path);
                    } catch (e) {
                        console.error('[cloudSync] Failed to delete remote:', file.path, e);
                        allDeleted = false;
                    }
                }
            } else {
                allDeleted = false;
            }
            if (allDeleted) {
                for (const deletedPath of deletedPaths) {
                    delete manifest[deletedPath];
                }
                for (const key of Object.keys(manifest)) {
                    if (key.startsWith(path + '/')) {
                        delete manifest[key];
                    }
                }
                lastSuccessfulId = Math.max(lastSuccessfulId, entry.id);
            }
        } else {
            // write
            const fileEntry = await readLocalFileWithMtime(path);
            if (!fileEntry) continue;
            const raw = fileEntry.content ?? fileEntry.bytes!;
            const hash = computeHash(raw);
            const uploadContent = fileEntry.content ?? new Blob([fileEntry.bytes!]);
            try {
                const etag = await uploadFile(path, uploadContent);
                manifest[path] = {
                    localHash: hash,
                    remoteEtag: etag,
                    localMtime: fileEntry.mtime,
                    remoteMtime: new Date().toUTCString()
                };
                console.log('[cloudSync] Uploaded:', path);
                lastSuccessfulId = Math.max(lastSuccessfulId, entry.id);
            } catch (e) {
                console.error('[cloudSync] Upload failed:', path, e);
            }
        }
    }

    // Advance checkpoint only for successfully processed entries
    if (lastSuccessfulId > checkpoint.lastId) {
        await syncJournal.advanceCheckpoint(lastSuccessfulId);
    }

    // Save manifest
    await saveSyncManifest(manifest);

    // Update lastCloudCheckTime so future write syncs can detect interleaved changes
    const syncTime = new Date().toISOString();
    await syncJournal.setLastCloudCheckTime(syncTime);

    // Signal cloud state changed
    await uploadCloudState(syncTime);

    STATE.cloudSync.lastSyncTime = syncTime;
    await saveCloudSyncState();

    // Reset 1-hour timer since we just synced
    if (syncTimerId !== null) {
        clearInterval(syncTimerId);
    }
    syncTimerId = window.setInterval(async function() {
        if (STATE.cloudSync.enabled) {
            await syncFromCloud();
        }
    }, SYNC_INTERVAL_MS);

    STATE.cloudSync.lastError = null;
}

/**
 * Pulls remote changes down to local storage.
 * Lists all remote files, resolves actions, handles conflicts/downloads/deletions/identicals.
 * Internal function — callers should use syncFromCloud or syncBothWays.
 * @returns {Promise<void>}
 */
async function syncFromCloudInternal(options?: { forceRemoteWins?: boolean }): Promise<void> {
    console.log('[cloudSync] Read sync...');

    const syncJournal = await import('./syncJournal');
    const checkpoint = syncJournal.getCheckpoint();

    // Fast-path: check cloud-state before expensive listing
    const cloudState = await downloadCloudState();
    if (cloudState?.lastUpdateTime && checkpoint.lastCloudCheckTime &&
        cloudState.lastUpdateTime <= checkpoint.lastCloudCheckTime) {
        console.log('[cloudSync] No remote changes since last check, skipping read sync');
        STATE.cloudSync.lastSyncTime = new Date().toISOString();
        await saveCloudSyncState();
        return;
    }

    const manifest: SyncManifest = await loadSyncManifest() ?? {};
    const localManifest = await buildLocalManifestWithHashes(manifest);
    const remoteFiles = await listRemoteFiles(CLOUD_PREFIX);
    const remoteMap = new Map<string, SyncFileInfo>();
    remoteFiles.forEach(function(f) {
        remoteMap.set(f.path, f);
    });

    const actions = resolveSyncActions(localManifest, remoteMap, manifest);
    console.log('[cloudSync] Read actions:', {
        uploads: actions.uploads.length,
        downloads: actions.downloads.length,
        conflicts: actions.conflicts.length,
        deletions: actions.deletions.length
    });

    // Handle conflicts
    if (actions.conflicts.length > 0) {
        if (options?.forceRemoteWins) {
            for (const conflict of actions.conflicts) {
                actions.downloads.push(conflict.path);
            }
        } else {
            const resolutions = await showConflictModal(actions.conflicts, localManifest, remoteMap);
            for (const conflict of actions.conflicts) {
                const choice = resolutions.get(conflict.path) ?? 'local';
                if (choice === 'local') {
                    const entry = localManifest.get(conflict.path);
                    if (entry && entry.content !== null) {
                        actions.uploads.push(conflict.path);
                    }
                } else {
                    actions.downloads.push(conflict.path);
                }
            }
        }
    }

    // Handle deletions
    if (actions.deletions.length > 0) {
        const confirmed = await showDeletionConfirmModal(actions.deletions, localManifest, remoteMap);
        if (confirmed) {
            await executeDeletions(actions.deletions, async function(del) {
                delete manifest[del.path];
            });
        }
    }

    // Execute downloads
    let allDownloadsSucceeded = true;
    const downloadCount = actions.downloads.length;
    if (downloadCount > 0) {
        ui.showSyncProgress(0, downloadCount);
    }
    for (let i = 0; i < downloadCount; i++) {
        const path = actions.downloads[i];
        ui.showSyncProgress(i + 1, downloadCount);
        try {
            const content = await downloadFile(path);
            await writeLocalFile(path, content);
            // Track changed paths
            changedPaths.push(path);
            // Remove from dirty paths so write sync won't re-upload
            syncJournal.removeFromDirtyPaths(path);
            const remoteInfo = remoteMap.get(path);
            if (remoteInfo) {
                const fileEntry = await readLocalFileWithMtime(path);
                if (fileEntry) {
                    const raw = fileEntry.content ?? fileEntry.bytes!;
                    const hash = computeHash(raw);
                    manifest[path] = {
                        localHash: hash,
                        remoteEtag: remoteInfo.etag,
                        localMtime: fileEntry.mtime,
                        remoteMtime: remoteInfo.lastModified
                    };
                }
            }
        } catch (e) {
            console.error('[cloudSync] Download failed:', path, e);
            allDownloadsSucceeded = false;
        }
    }
    ui.hideSyncProgress();

    // Add identical files
    for (const path of actions.identical) {
        const localEntry = localManifest.get(path);
        const remoteInfo = remoteMap.get(path);
        if (localEntry && remoteInfo) {
            manifest[path] = {
                localHash: localEntry.hash,
                remoteEtag: remoteInfo.etag,
                localMtime: localEntry.mtime,
                remoteMtime: remoteInfo.lastModified
            };
        }
    }

    await saveSyncManifest(manifest);
    if (allDownloadsSucceeded && cloudState?.lastUpdateTime) {
        await syncJournal.setLastCloudCheckTime(cloudState.lastUpdateTime);
    }
    STATE.cloudSync.lastSyncTime = new Date().toISOString();
    await saveCloudSyncState();
    STATE.cloudSync.lastError = null;
}

/**
 * Pushes local dirty files to the cloud.
 * If the cloud was modified by another device since last check, pulls first.
 * Acquires the sync lock and manages UI state.
 * @returns {Promise<void>}
 */
export async function syncToCloud(): Promise<void> {
    await withSyncLock(syncToCloudInternal);
}

/**
 * Pulls remote changes down to local storage.
 * Lists all remote files, downloads changes, resolves conflicts.
 * Acquires the sync lock and manages UI state.
 * @returns {Promise<void>}
 */
export async function syncFromCloud(): Promise<void> {
    await withSyncLock(syncFromCloudInternal);
}

/**
 * Performs a bidirectional sync: pushes local changes, then pulls remote changes.
 * Acquires the sync lock and manages UI state.
 * @returns {Promise<void>}
 */
export async function syncBothWays(): Promise<void> {
    await withSyncLock(async function() {
        await syncToCloudInternal();
        await syncFromCloudInternal();
    });
}

/**
 * Performs a complete re-sync: deletes manifest, resets checkpoint, uploads all local files.
 * Acquires the sync lock and manages UI state.
 * Called by triggerCompleteResync after user confirmation.
 * @returns {Promise<void>}
 */
async function syncReset(): Promise<void> {
    await withSyncLock(async function() {
        await deleteLocalFile(MANIFEST_PATH);

        STATE.cloudSync.lastSyncTime = null;
        STATE.cloudSync.lastError = null;
        await saveCloudSyncState();

        // Reset journal checkpoint so all files are re-synced
        const { resetCheckpoint } = await import('./syncJournal');
        await resetCheckpoint();

        console.log('[cloudSync] Complete re-sync (local priority) triggered');
        await syncToCloudInternal();
    });
}

/**
 * Performs a complete reset and pulls all remote files down, overwriting local.
 * Used when the user chooses "Cloud takes priority" during re-sync.
 * Acquires the sync lock and manages UI state.
 * @returns {Promise<void>}
 */
async function syncResetThenPull(): Promise<void> {
    await withSyncLock(async function() {
        await deleteLocalFile(MANIFEST_PATH);

        STATE.cloudSync.lastSyncTime = null;
        STATE.cloudSync.lastError = null;
        await saveCloudSyncState();

        // Reset journal checkpoint so all files are re-synced
        const { resetCheckpoint } = await import('./syncJournal');
        await resetCheckpoint();

        console.log('[cloudSync] Complete re-sync (cloud priority) triggered');
        await syncFromCloudInternal({ forceRemoteWins: true });
    });
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

    // Load shared settings from /cloud/preferences/
    const sharedEnabled = await readCloudPreference('cloudSyncEnabled');
    if (sharedEnabled !== null) {
        STATE.cloudSync.enabled = sharedEnabled === 'true';
    }
    const sharedDeleteRemote = await readCloudPreference('cloudSyncDeleteRemote');
    if (sharedDeleteRemote !== null) {
        STATE.cloudSync.deleteRemoteOnLocalDelete = sharedDeleteRemote === 'true';
    }

    // Load per-app state from app-root preferences
    const savedState = await readLocalFile('preferences/cloudSync');
    if (savedState) {
        try {
            const parsed = JSON.parse(savedState) as Partial<CloudSyncState>;
            if (parsed.lastSyncTime) STATE.cloudSync.lastSyncTime = parsed.lastSyncTime;
        } catch (e) {
            console.warn('[cloudSync] Failed to parse saved state:', e);
        }
    }

    // Startup verification: sync if enabled with initial sync modal
    if (STATE.cloudSync.enabled) {
        const syncJournal = await import('./syncJournal');
        const checkpoint = syncJournal.getCheckpoint();
        const hasSeen = await readLocalFile('preferences/hasSeenInitialSync');

        if (checkpoint.lastId === 0 && hasSeen !== 'true') {
            const choice = await showInitialSyncModal();
            if (choice === 'download') {
                await syncBothWays();
            } else {
                await syncToCloud();
            }
            await writeLocalFile('preferences/hasSeenInitialSync', 'true');
        } else {
            await syncToCloud();
        }

        await syncJournal.setLastCloudCheckTime(new Date().toISOString());
    }

    // Start periodic timer for checking remote changes
    if (syncTimerId !== null) {
        clearInterval(syncTimerId);
    }
    syncTimerId = window.setInterval(async function() {
        if (STATE.cloudSync.enabled) {
            await syncFromCloud();
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

    const { getCheckpoint } = await import('./syncJournal');
    const checkpoint = getCheckpoint();
    const hasSeen = await readLocalFile('preferences/hasSeenInitialSync');

    if (checkpoint.lastId === 0 && hasSeen !== 'true') {
        const choice = await showInitialSyncModal();
        if (choice === 'download') {
            await syncBothWays();
        } else {
            await syncToCloud();
        }
        await writeLocalFile('preferences/hasSeenInitialSync', 'true');
    } else {
        await syncToCloud();
    }
}

/**
 * Disables cloud sync
 * @returns {Promise<void>}
 */
export async function disableCloudSync(): Promise<void> {
    STATE.cloudSync.enabled = false;
    STATE.cloudSync.lastError = null;
    await saveCloudSyncState();
    ui.updateCloudSyncUI();
}

/**
 * Saves the cloud sync state to OPFS.
 * Shared settings go to /cloud/preferences/; per-app state stays in app root.
 * @returns {Promise<void>}
 */
async function saveCloudSyncState(): Promise<void> {
    // Save shared settings to /cloud/
    await writeCloudPreference('cloudSyncEnabled', String(STATE.cloudSync.enabled));
    await writeCloudPreference('cloudSyncDeleteRemote', String(STATE.cloudSync.deleteRemoteOnLocalDelete));

    // Save per-app state to app root
    const appState = { lastSyncTime: STATE.cloudSync.lastSyncTime };
    await writeLocalFile('preferences/cloudSync', JSON.stringify(appState));
}

/**
 * Sets whether deleting locally also deletes from cloud
 * @param {boolean} enabled - New setting value
 * @returns {Promise<void>}
 */
export async function setDeleteRemoteOnLocalDelete(enabled: boolean): Promise<void> {
    STATE.cloudSync.deleteRemoteOnLocalDelete = enabled;
    await saveCloudSyncState();
}

/**
 * Triggers a manual sync immediately
 * @returns {Promise<void>}
 */
export async function triggerManualSync(): Promise<void> {
    await syncFromCloud();
}

/**
 * Queues a sync with debouncing (5-second delay for batching writes).
 * Called by syncJournal.ts after every recorded write/delete.
 * @returns {void}
 */
export function queueSync(): void {
    if (pendingSyncTimeout !== null) {
        clearTimeout(pendingSyncTimeout);
    }
    pendingSyncTimeout = window.setTimeout(async function() {
        pendingSyncTimeout = null;
        if (STATE.cloudSync.enabled) {
            await syncToCloud();
        }
    }, 5000);
}

/**
 * Triggers a complete re-sync from scratch. Deletes the manifest and journal,
 * resets the last-sync timestamp, and runs a full initial sync. Forces all
 * local files to be uploaded again and all remote files to be downloaded.
 * Local files take priority for files that exist on both sides.
 * Intended for recovery from corrupted sync state during development.
 * @returns {Promise<void>}
 */
export async function triggerCompleteResync(): Promise<void> {
    if (STATE.cloudSync.isSyncing) {
        ui.displayError('Cannot re-sync while sync is in progress');
        return;
    }

    const choice = await showResyncChoiceModal();

    if (choice === 'local') {
        await syncReset();
    } else {
        await syncResetThenPull();
    }
}

/**
 * Exports the entire OPFS app data to a user-selected local directory.
 * Uses showDirectoryPicker() for folder selection.
 * Skips the internal sync/ directory.
 * Skips individual files that fail to copy and reports the count.
 * @returns {Promise<{ fileCount: number; byteCount: number; skippedCount: number }>} Files exported, total bytes, files skipped
 * @throws {Error} If directory picker fails, API unsupported, or user cancels
 */
export async function exportToDirectory(): Promise<{ fileCount: number; byteCount: number; skippedCount: number }> {
    if (typeof (window as any).showDirectoryPicker !== 'function') {
        throw new Error('Export requires a Chromium-based browser (Chrome, Edge, Brave, etc.)');
    }

    let targetDir: FileSystemDirectoryHandle;
    try {
        targetDir = await (window as any).showDirectoryPicker();
    } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
            throw new Error('Export cancelled');
        }
        throw new Error('Could not open directory picker: ' + (e instanceof Error ? e.message : String(e)));
    }

    const root = await getOPFSHandle();
    let fileCount = 0;
    let byteCount = 0;
    let skippedCount = 0;

    /**
     * Recursively copies files from source to dest, skipping the sync/ directory.
     * Failed files are skipped and counted, not aborted.
     * @param {FileSystemDirectoryHandle} source - Source directory handle
     * @param {FileSystemDirectoryHandle} dest - Destination directory handle
     * @returns {Promise<void>}
     */
    async function copyRecursively(source: FileSystemDirectoryHandle, dest: FileSystemDirectoryHandle): Promise<void> {
        for await (const entry of (source as any).values()) {
            if (entry.name === 'sync') continue;
            if (entry.kind === 'file') {
                try {
                    const fileHandle = await source.getFileHandle(entry.name);
                    const file = await fileHandle.getFile();
                    const content = await file.arrayBuffer();
                    const newFile = await dest.getFileHandle(entry.name, { create: true });
                    const writable = await newFile.createWritable();
                    await writable.write(content);
                    await writable.close();
                    fileCount++;
                    byteCount += content.byteLength;
                } catch (e) {
                    skippedCount++;
                    console.warn('[cloudSync] Export skipped file:', entry.name, e);
                }
            } else if (entry.kind === 'directory') {
                try {
                    const sourceSubDir = await source.getDirectoryHandle(entry.name);
                    const destSubDir = await dest.getDirectoryHandle(entry.name, { create: true });
                    await copyRecursively(sourceSubDir, destSubDir);
                } catch (e) {
                    skippedCount++;
                    console.warn('[cloudSync] Export skipped directory:', entry.name, e);
                }
            }
        }
    }

    await copyRecursively(root, targetDir);
    console.log('[cloudSync] Exported ' + fileCount + ' files (' + byteCount + ' bytes)' +
        (skippedCount > 0 ? ', ' + skippedCount + ' skipped' : ''));
    return { fileCount, byteCount, skippedCount };
}
