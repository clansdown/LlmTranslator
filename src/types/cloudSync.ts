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
    identical: string[];
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

/**
 * A single completed sync operation recorded in the crash-recovery journal.
 * Written to preferences/syncJournal as NDJSON lines after each successful
 * upload, download, or delete. Replayed on the next startup if the sync
 * crashed before the manifest was saved.
 */
export interface JournalEntry {
    op: 'upload' | 'download' | 'delete';
    path: string;
    localHash?: string;
    remoteEtag?: string;
    localMtime?: number;
    remoteMtime?: string;
}

/**
 * A single local change recorded in the sync journal (NDJSON, not synced).
 * Written by storage.ts after every OPFS write or delete.
 */
export interface SyncJournalEntry {
    /** Monotonically increasing entry ID */
    id: number;
    /** Operation type */
    op: 'write' | 'delete' | 'deleteRecursive';
    /** OPFS path relative to app root */
    path: string;
    /** MD5 hash of file content (for write ops) */
    hash: string;
    /** File lastModified timestamp */
    mtime: number;
    /** Entry creation time (ISO 8601) */
    timestamp: string;
}

/**
 * Sync checkpoint persisted to OPFS at sync/checkpoint.
 * Tracks which journal entries have been processed.
 */
export interface SyncCheckpoint {
    /** Highest journal ID that has been successfully synced */
    lastId: number;
    /** Which journal file is currently active: 'a' or 'b' */
    currentJournal: 'a' | 'b';
    /** ISO timestamp of last confirmed cloud-state check */
    lastCloudCheckTime: string | null;
}

/**
 * Cloud state signal stored at translate/cloud-state.json in B2.
 * Written after every completed write sync.
 */
export interface CloudState {
    /** ISO timestamp of when the cloud was last modified by a sync */
    lastUpdateTime: string;
}
