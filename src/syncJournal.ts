/**
 * Sync Journal Module
 * Records all local OPFS write/delete operations as NDJSON entries
 * in rotating journal files. Used by the sync engine to determine
 * exactly what changed since the last sync, without walking the filesystem.
 * 
 * Journal files (not synced to cloud):
 *   sync/journal-a     — active journal A (NDJSON, max 10,000 entries)
 *   sync/journal-b     — active journal B (NDJSON, max 10,000 entries)
 *   sync/checkpoint    — tracks last processed ID and active journal
 */

import { getOPFSHandle, ensureDirectory } from './opfs';
import type { SyncJournalEntry, SyncCheckpoint } from './types/cloudSync';

const JOURNAL_A_PATH = 'journal-a';
const JOURNAL_B_PATH = 'journal-b';
const CHECKPOINT_PATH = 'checkpoint';
const SYNC_DIR = 'sync';
const MAX_JOURNAL_ENTRIES = 10000;

/** @type {number} */
let nextId: number = 1;

/** @type {Map<string, SyncJournalEntry>} */
let dirtyPaths: Map<string, SyncJournalEntry> = new Map();

/** @type {SyncCheckpoint} */
let checkpoint: SyncCheckpoint = {
    lastId: 0,
    currentJournal: 'a',
    lastCloudCheckTime: null
};

/** @type {SyncJournalEntry[]} */
let pendingQueue: SyncJournalEntry[] = [];

/** @type {Promise<void> | null} */
let drainPromise: Promise<void> | null = null;

/**
 * Gets the sync directory handle, creating it if needed
 * @returns {Promise<FileSystemDirectoryHandle>} Sync directory handle
 */
async function getSyncDirHandle(): Promise<FileSystemDirectoryHandle> {
    const root = await getOPFSHandle();
    return await ensureDirectory(root, SYNC_DIR);
}

/**
 * Reads the active journal file and returns all entries
 * @returns {Promise<string>} Journal file content
 */
async function readJournal(): Promise<string> {
    const syncDir = await getSyncDirHandle();
    const fileName = checkpoint.currentJournal === 'a' ? JOURNAL_A_PATH : JOURNAL_B_PATH;
    try {
        const fileHandle = await syncDir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return await file.text();
    } catch {
        return '';
    }
}

/**
 * Reads both journal files and returns their content
 * @returns {Promise<[string, string]>} [journalA content, journalB content]
 */
async function readBothJournals(): Promise<[string, string]> {
    const syncDir = await getSyncDirHandle();
    let aContent = '';
    let bContent = '';
    try {
        const fa = await syncDir.getFileHandle(JOURNAL_A_PATH);
        aContent = await (await fa.getFile()).text();
    } catch { /* not found */ }
    try {
        const fb = await syncDir.getFileHandle(JOURNAL_B_PATH);
        bContent = await (await fb.getFile()).text();
    } catch { /* not found */ }
    return [aContent, bContent];
}

/**
 * Appends a batch of journal entries to the active journal file (NDJSON)
 * @param {SyncJournalEntry[]} entries - Entries to append
 * @returns {Promise<void>}
 */
async function appendBatchToJournal(entries: SyncJournalEntry[]): Promise<void> {
    const syncDir = await getSyncDirHandle();
    const fileName = checkpoint.currentJournal === 'a' ? JOURNAL_A_PATH : JOURNAL_B_PATH;

    const existing = await readJournal();
    const newContent = existing + entries.map(function(e: SyncJournalEntry) {
        return JSON.stringify(e) + '\n';
    }).join('');
    const fileHandle = await syncDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(newContent);
    await writable.close();
}

/**
 * Counts entries in the active journal
 * @returns {Promise<number>} Number of NDJSON lines
 */
async function countActiveJournalEntries(): Promise<number> {
    const content = await readJournal();
    if (!content) return 0;
    return content.split('\n').filter(function(l: string) { return l.trim().length > 0; }).length;
}

/**
 * Parses NDJSON content into journal entries
 * @param {string} content - NDJSON content
 * @returns {SyncJournalEntry[]} Parsed entries
 */
function parseJournalContent(content: string): SyncJournalEntry[] {
    const entries: SyncJournalEntry[] = [];
    const lines = content.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const entry = JSON.parse(trimmed) as SyncJournalEntry;
            entries.push(entry);
        } catch (e) {
            console.warn('[syncJournal] Failed to parse journal line:', trimmed);
        }
    }
    return entries;
}

/**
 * Gets the maximum entry ID from the other (non-active) journal
 * @param {'a' | 'b'} otherJournal - The other journal to scan
 * @returns {Promise<number>} Maximum ID, or 0 if empty
 */
async function getMaxOtherJournalId(otherJournal: 'a' | 'b'): Promise<number> {
    const syncDir = await getSyncDirHandle();
    const fileName = otherJournal === 'a' ? JOURNAL_A_PATH : JOURNAL_B_PATH;
    try {
        const fileHandle = await syncDir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        const content = await file.text();
        const entries = parseJournalContent(content);
        let maxId = 0;
        for (const entry of entries) {
            if (entry.id > maxId) maxId = entry.id;
        }
        return maxId;
    } catch {
        return 0;
    }
}

/**
 * Clears a journal file
 * @param {'a' | 'b'} which - Which journal to clear
 * @returns {Promise<void>}
 */
async function clearJournal(which: 'a' | 'b'): Promise<void> {
    const syncDir = await getSyncDirHandle();
    const fileName = which === 'a' ? JOURNAL_A_PATH : JOURNAL_B_PATH;
    const fileHandle = await syncDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('');
    await writable.close();
}

/**
 * Initializes the sync journal module.
 * Loads checkpoint, scans journals to set nextId, rebuilds dirtyPaths.
 * Called once at app startup.
 * @returns {Promise<SyncCheckpoint>} Loaded checkpoint
 */
export async function init(): Promise<SyncCheckpoint> {
    const syncDir = await getSyncDirHandle();

    // Load checkpoint
    try {
        const fileHandle = await syncDir.getFileHandle(CHECKPOINT_PATH);
        const file = await fileHandle.getFile();
        const content = await file.text();
        if (content) {
            const parsed = JSON.parse(content) as Partial<SyncCheckpoint>;
            if (typeof parsed.lastId === 'number') checkpoint.lastId = parsed.lastId;
            if (parsed.currentJournal === 'a' || parsed.currentJournal === 'b') {
                checkpoint.currentJournal = parsed.currentJournal;
            }
            if (typeof parsed.lastCloudCheckTime === 'string') {
                checkpoint.lastCloudCheckTime = parsed.lastCloudCheckTime;
            }
        }
    } catch { /* file doesn't exist — use defaults */ }

    // Scan both journals to find the highest ID
    const [aContent, bContent] = await readBothJournals();
    const allEntries = [...parseJournalContent(aContent), ...parseJournalContent(bContent)];
    let maxId = 0;
    for (const entry of allEntries) {
        if (entry.id > maxId) maxId = entry.id;
    }
    nextId = maxId + 1;

    // Rebuild dirtyPaths from pending entries (id > checkpoint.lastId)
    dirtyPaths.clear();
    for (const entry of allEntries) {
        if (entry.id > checkpoint.lastId) {
            dirtyPaths.set(entry.path, entry);
        }
    }

    console.log('[syncJournal] Initialized: lastId=' + checkpoint.lastId + ', nextId=' + nextId + ', dirtyPaths=' + dirtyPaths.size);
    return checkpoint;
}

/**
 * Records a file write operation.
 * Appends a 'write' entry to the active journal.
 * The caller should provide the MD5 hash if available.
 * @param {string} path - OPFS path relative to app root
 * @param {string} hash - MD5 hash of file content (or empty string)
 * @returns {Promise<void>}
 */
export async function recordWrite(path: string, hash: string): Promise<void> {
    const mtime = Date.now();
    const entry: SyncJournalEntry = {
        id: nextId++,
        op: 'write',
        path: path,
        hash: hash,
        mtime: mtime,
        timestamp: new Date().toISOString()
    };

    pendingQueue.push(entry);
    dirtyPaths.set(path, entry);
    await drainQueue();
    await maybeRotate();
}

/**
 * Records a file delete operation.
 * @param {string} path - OPFS path relative to app root
 * @returns {Promise<void>}
 */
export async function recordDelete(path: string): Promise<void> {
    const entry: SyncJournalEntry = {
        id: nextId++,
        op: 'delete',
        path: path,
        hash: '',
        mtime: 0,
        timestamp: new Date().toISOString()
    };

    pendingQueue.push(entry);
    dirtyPaths.set(path, entry);
    await drainQueue();
    await maybeRotate();
}

/**
 * Records a recursive directory delete operation.
 * @param {string} path - OPFS path relative to app root
 * @returns {Promise<void>}
 */
export async function recordDeleteRecursive(path: string): Promise<void> {
    const entry: SyncJournalEntry = {
        id: nextId++,
        op: 'deleteRecursive',
        path: path,
        hash: '',
        mtime: 0,
        timestamp: new Date().toISOString()
    };

    pendingQueue.push(entry);
    dirtyPaths.set(path, entry);
    await drainQueue();
    await maybeRotate();
}

/**
 * Drains the pending queue of journal entries to disk.
 * Only one drain runs at a time; concurrent callers wait on the same promise.
 * @returns {Promise<void>}
 */
async function drainQueue(): Promise<void> {
    if (drainPromise) return drainPromise;
    drainPromise = (async function() {
        while (pendingQueue.length > 0) {
            const batch = pendingQueue.splice(0);
            await appendBatchToJournal(batch);
        }
    })();
    await drainPromise;
    drainPromise = null;
}

/**
 * Returns all pending journal entries (id > checkpoint.lastId), sorted by id.
 * @returns {Promise<SyncJournalEntry[]>} Sorted pending entries
 */
export async function getPendingEntries(): Promise<SyncJournalEntry[]> {
    const [aContent, bContent] = await readBothJournals();
    const allEntries = [...parseJournalContent(aContent), ...parseJournalContent(bContent)];
    return allEntries
        .filter(function(e: SyncJournalEntry) { return e.id > checkpoint.lastId; })
        .sort(function(a: SyncJournalEntry, b: SyncJournalEntry) { return a.id - b.id; });
}

/**
 * Returns the map of dirty paths (latest entry per path).
 * Contains only pending entries (id > checkpoint.lastId).
 * deleteRecursive entries mark all nested paths as dirty.
 * @returns {Map<string, SyncJournalEntry>} Dirty path -> latest entry
 */
export function getDirtyPaths(): Map<string, SyncJournalEntry> {
    return dirtyPaths;
}

/**
 * Removes a path from the dirty paths map.
 * Called after read sync downloads a file, so it won't be re-uploaded.
 * @param {string} path - Path to remove
 * @returns {void}
 */
export function removeFromDirtyPaths(path: string): void {
    dirtyPaths.delete(path);
}

/**
 * Advances the checkpoint past the given ID.
 * Removes processed entries from dirtyPaths.
 * @param {number} lastId - Highest processed journal ID
 * @returns {Promise<void>}
 */
export async function advanceCheckpoint(lastId: number): Promise<void> {
    checkpoint.lastId = lastId;

    // Remove processed entries from dirtyPaths
    for (const [path, entry] of dirtyPaths) {
        if (entry.id <= lastId) {
            dirtyPaths.delete(path);
        }
    }

    await saveCheckpointImpl();
}

/**
 * Saves the checkpoint to disk
 * @returns {Promise<void>}
 */
async function saveCheckpointImpl(): Promise<void> {
    const syncDir = await getSyncDirHandle();
    const fileHandle = await syncDir.getFileHandle(CHECKPOINT_PATH, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify({
        lastId: checkpoint.lastId,
        currentJournal: checkpoint.currentJournal,
        lastCloudCheckTime: checkpoint.lastCloudCheckTime
    }));
    await writable.close();
}

/**
 * Saves the checkpoint with current state.
 * Public wrapper for use by sync engine.
 * @returns {Promise<void>}
 */
export async function saveCheckpoint(): Promise<void> {
    await saveCheckpointImpl();
}

/**
 * Returns the loaded checkpoint
 * @returns {SyncCheckpoint} Current checkpoint
 */
export function getCheckpoint(): SyncCheckpoint {
    return checkpoint;
}

/**
 * Updates the lastCloudCheckTime in the checkpoint
 * @param {string} time - ISO timestamp
 * @returns {Promise<void>}
 */
export async function setLastCloudCheckTime(time: string): Promise<void> {
    checkpoint.lastCloudCheckTime = time;
    await saveCheckpointImpl();
}

/**
 * Resets the checkpoint to defaults (for complete re-sync)
 * @returns {Promise<void>}
 */
export async function resetCheckpoint(): Promise<void> {
    checkpoint = {
        lastId: 0,
        currentJournal: 'a',
        lastCloudCheckTime: null
    };
    dirtyPaths.clear();
    await saveCheckpointImpl();
}

/**
 * Checks if the active journal has exceeded the max entry count
 * and rotates if the other journal is fully processed.
 * @returns {Promise<void>}
 */
async function maybeRotate(): Promise<void> {
    const count = await countActiveJournalEntries();
    if (count < MAX_JOURNAL_ENTRIES) return;

    const otherJournal = checkpoint.currentJournal === 'a' ? 'b' : 'a';
    const maxOtherId = await getMaxOtherJournalId(otherJournal);

    // Only rotate if the other journal has been fully processed
    if (maxOtherId <= checkpoint.lastId) {
        await clearJournal(otherJournal);
        checkpoint.currentJournal = otherJournal;
        await saveCheckpointImpl();
        console.log('[syncJournal] Rotated to journal-' + otherJournal);
    } else {
        console.warn('[syncJournal] Journal full but other journal not processed (' +
            maxOtherId + ' > ' + checkpoint.lastId + '), continuing');
    }
}
