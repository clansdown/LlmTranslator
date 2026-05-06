/**
 * Cloud Sync data types
 * Backblaze B2 sync via FindForge Storage Worker, authenticated by Clerk
 * CloudSyncState is defined in state.ts alongside AppState
 */

/**
 * Structured error response from the FindForge Storage Worker
 * All non-B2 errors return JSON with this shape
 */
export interface WorkerErrorResponse {
    error: string;
    message: string;
}

/**
 * Metadata for a file stored on the remote worker
 */
export interface SyncFileInfo {
    path: string;
    etag: string;
    size: number;
    lastModified: string;
}

/**
 * A file that has changed both locally and remotely since last sync
 */
export interface SyncConflict {
    path: string;
    localContent: string;
    remoteEtag: string;
    remoteLastModified: string;
}

/**
 * A file to be deleted during sync
 */
export interface SyncDeletion {
    path: string;
    location: 'local' | 'remote';
}

/**
 * Actions to execute during a sync cycle
 */
export interface SyncActions {
    uploads: string[];
    downloads: string[];
    conflicts: SyncConflict[];
    deletions: SyncDeletion[];
}

/**
 * Persisted state of a single file at the last successful sync
 */
export interface SyncManifestEntry {
    localHash: string;
    remoteEtag: string;
    localMtime: number;
    remoteMtime: string;
}

/**
 * Persisted state of all synced files at the last successful sync
 * Keyed by file path relative to OPFS root
 */
export interface SyncManifest {
    [path: string]: SyncManifestEntry;
}
