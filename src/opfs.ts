/**
 * OPFS Primitives Module
 *
 * Pure, generic File System Access API helpers with no app-specific logic.
 * Part of the FindForge suite. This app's data is namespaced under /translate/.
 *
 * Directory Structure:
 *
 * OPFS Root:
 * ├── cloud/                           ← Shared across FindForge tools
 * │   └── preferences/
 * │       ├── cloudSyncEnabled         ← Global sync toggle
 * │       └── cloudSyncDeleteRemote    ← Global delete-remote preference
 * │
 * └── translate/                       ← This app's namespace (app root)
 *     └── ...
 */

export const APP_PREFIX: string = 'translate';
export const CLOUD_PREFIX: string = 'cloud';
export const CREDENTIALS_PREFIX: string = 'credentials';

/** @type {boolean} */
let migrationComplete = false;

/**
 * Recursively copies all contents from a source directory to a destination directory.
 * Preserves files with their content and subdirectories.
 * @param {FileSystemDirectoryHandle} source - Source directory
 * @param {FileSystemDirectoryHandle} dest - Destination directory
 * @returns {Promise<void>}
 */
async function copyDirectoryContents(source: FileSystemDirectoryHandle, dest: FileSystemDirectoryHandle): Promise<void> {
    for await (const entry of (source as any).values()) {
        if (entry.kind === 'file') {
            const fileHandle = await source.getFileHandle(entry.name);
            const file = await fileHandle.getFile();
            const content = await file.arrayBuffer();
            const newFile = await dest.getFileHandle(entry.name, { create: true });
            const writable = await newFile.createWritable();
            await writable.write(content);
            await writable.close();
        } else if (entry.kind === 'directory') {
            const sourceSubDir = await source.getDirectoryHandle(entry.name);
            const destSubDir = await dest.getDirectoryHandle(entry.name, { create: true });
            await copyDirectoryContents(sourceSubDir, destSubDir);
        }
    }
}

/**
 * Runs one-time migration from old root-level paths to /translate/ prefix.
 * Copies old sessions/, preferences/, conversational/, translations/ directories
 * into translate/ and leaves the originals in place for safety.
 * Creates the /cloud/ directory for shared settings.
 * @returns {Promise<void>}
 */
async function migrateToNamespacedPaths(): Promise<void> {
    if (migrationComplete) return;

    const root = await navigator.storage.getDirectory();

    // Check if already migrated
    try {
        await root.getDirectoryHandle(APP_PREFIX);
        return;
    } catch {
        // Not migrated yet
    }

    console.log('[opfs] Running one-time migration to /' + APP_PREFIX + '/...');

    const appDir = await root.getDirectoryHandle(APP_PREFIX, { create: true });

    // Detect old data directories at root level
    const oldDirs = ['sessions', 'preferences', 'conversations', 'translations'];
    let foundAny = false;

    for (const dirName of oldDirs) {
        try {
            const oldDir = await root.getDirectoryHandle(dirName);
            const newDir = await appDir.getDirectoryHandle(dirName, { create: true });
            await copyDirectoryContents(oldDir, newDir);
            console.log('[opfs] Copied /' + dirName + '/ → /' + APP_PREFIX + '/' + dirName + '/');
            foundAny = true;
        } catch {
            // Directory doesn't exist or failed to copy — skip
        }
    }

    // Create /cloud/ and /cloud/preferences/ for shared settings
    const cloudDir = await root.getDirectoryHandle(CLOUD_PREFIX, { create: true });
    await cloudDir.getDirectoryHandle('preferences', { create: true });

    // Attempt to migrate the old cloud sync enabled flag
    if (foundAny) {
        try {
            const oldPrefs = await root.getDirectoryHandle('preferences');
            const oldCloudSyncFile = await oldPrefs.getFileHandle('cloudSync');
            const oldContent = await oldCloudSyncFile.getFile();
            const oldText = await oldContent.text();
            const oldState = JSON.parse(oldText);
            if (typeof oldState.enabled === 'boolean') {
                const cloudPrefs = await cloudDir.getDirectoryHandle('preferences');
                const enabledFile = await cloudPrefs.getFileHandle('cloudSyncEnabled', { create: true });
                const writable = await enabledFile.createWritable();
                await writable.write(String(oldState.enabled));
                await writable.close();
                console.log('[opfs] Migrated cloud sync enabled flag to /cloud/');
            }
        } catch {
            // No old cloud sync state to migrate — fine
        }
    }

    migrationComplete = true;
    console.log('[opfs] Migration complete. Old data preserved at root level.');
}

/**
 * Gets this app's OPFS root directory handle (/{APP_PREFIX}/).
 * Runs the one-time namespace migration on first call.
 * @returns {Promise<FileSystemDirectoryHandle>} App root directory handle
 */
export async function getOPFSHandle(): Promise<FileSystemDirectoryHandle> {
    await migrateToNamespacedPaths();
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(APP_PREFIX);
}

/**
 * Gets the shared /cloud/ directory handle for cross-FindForge-tool settings.
 * Creates the directory if it doesn't exist.
 * @returns {Promise<FileSystemDirectoryHandle>} Cloud directory handle
 */
export async function getCloudDirectory(): Promise<FileSystemDirectoryHandle> {
    await migrateToNamespacedPaths();
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CLOUD_PREFIX);
}

/**
 * Gets the shared /credentials/ directory handle for cross-FindForge-tool API keys.
 * Creates the directory if it doesn't exist.
 * @returns {Promise<FileSystemDirectoryHandle>} Credentials directory handle
 */
export async function getCredentialsHandle(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CREDENTIALS_PREFIX, { create: true });
}

/**
 * Reads a shared preference from /cloud/preferences/.
 * @param {string} key - Preference key (filename)
 * @returns {Promise<string | null>} Preference value or null
 */
export async function readCloudPreference(key: string): Promise<string | null> {
    try {
        const cloudDir = await getCloudDirectory();
        const prefsDir = await ensureDirectory(cloudDir, 'preferences');
        const fileHandle = await prefsDir.getFileHandle(key);
        const file = await fileHandle.getFile();
        return await file.text();
    } catch {
        return null;
    }
}

/**
 * Writes a shared preference to /cloud/preferences/.
 * @param {string} key - Preference key (filename)
 * @param {string} value - Value to store
 * @returns {Promise<void>}
 */
export async function writeCloudPreference(key: string, value: string): Promise<void> {
    const cloudDir = await getCloudDirectory();
    const prefsDir = await ensureDirectory(cloudDir, 'preferences');
    const fileHandle = await prefsDir.getFileHandle(key, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(value);
    await writable.close();
}

/**
 * Reads a shared credential from /credentials/.
 * @param {string} provider - Credential provider name (filename)
 * @returns {Promise<string | null>} Credential value or null
 */
export async function readCredential(provider: string): Promise<string | null> {
    try {
        const credDir = await getCredentialsHandle();
        const fileHandle = await credDir.getFileHandle(provider);
        const file = await fileHandle.getFile();
        return await file.text();
    } catch {
        return null;
    }
}

/**
 * Writes a shared credential to /credentials/.
 * @param {string} provider - Credential provider name (filename)
 * @param {string} value - Credential value to store
 * @returns {Promise<void>}
 */
export async function writeCredential(provider: string, value: string): Promise<void> {
    const credDir = await getCredentialsHandle();
    const fileHandle = await credDir.getFileHandle(provider, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(value);
    await writable.close();
}

/**
 * Deletes a shared credential from /credentials/.
 * @param {string} provider - Credential provider name (filename)
 * @returns {Promise<void>}
 */
export async function deleteCredential(provider: string): Promise<void> {
    const credDir = await getCredentialsHandle();
    try {
        await credDir.removeEntry(provider);
    } catch (e) {
        if (e instanceof Error && e.name === 'NotFoundError') return;
        throw e;
    }
}

/**
 * Ensures a subdirectory exists within a parent directory
 * @param {FileSystemDirectoryHandle} parentDir - Parent directory handle
 * @param {string} dirName - Directory name to ensure exists
 * @returns {Promise<FileSystemDirectoryHandle>} Directory handle
 */
export async function ensureDirectory(parentDir: FileSystemDirectoryHandle, dirName: string): Promise<FileSystemDirectoryHandle> {
    try {
        return await parentDir.getDirectoryHandle(dirName, { create: true });
    } catch (e) {
        return await parentDir.getDirectoryHandle(dirName);
    }
}

/**
 * Reads a local OPFS file as text
 * @param {string} path - OPFS path relative to root (e.g. "preferences/apiKey")
 * @returns {Promise<string | null>} File content or null
 */
export async function readLocalFile(path: string): Promise<string | null> {
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
        console.warn('[opfs] Failed to read local file:', path, e);
        return null;
    }
}

/**
 * Writes content to a local OPFS file.
 * Accepts string for text files and ArrayBuffer for binary files.
 * @param {string} path - OPFS path relative to root
 * @param {string | ArrayBuffer} content - Content to write
 * @returns {Promise<void>}
 */
export async function writeLocalFile(path: string, content: string | ArrayBuffer): Promise<void> {
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
}

/**
 * Deletes a local OPFS file (safety-gated)
 * @param {string} path - OPFS path relative to root
 * @returns {Promise<void>}
 */
export async function deleteLocalFile(path: string): Promise<void> {
    const root = await getOPFSHandle();
    const parts = path.split('/');
    let dir = root;

    for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]);
    }

    const fileName = parts[parts.length - 1];
    try {
        await dir.removeEntry(fileName);
    } catch (e) {
        if (e instanceof Error && e.name === 'NotFoundError') {
            return;
        }
        throw e;
    }
}

/**
 * Recursively walks an OPFS directory to build a file listing
 * @param {FileSystemDirectoryHandle} dir - Directory handle to walk
 * @param {string} prefix - Current path prefix for recursion
 * @returns {Promise<string[]>} Array of file paths relative to the root
 */
export async function walkOpfsDirectory(dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> {
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
 * Gets or creates a persistent device identifier for this browser/computer.
 * Stored in /cloud/preferences/ so it's shared across all FindForge apps.
 * Never synced to the cloud.
 * @returns {Promise<string>} Unique device ID
 */
export async function getDeviceId(): Promise<string> {
    const existing = await readCloudPreference('deviceId');
    if (existing) return existing;
    const id = crypto.randomUUID();
    await writeCloudPreference('deviceId', id);
    return id;
}

/**
 * Gets the human-readable device name for this browser/computer.
 * Stored in /cloud/preferences/ so it's shared across all FindForge apps.
 * Never synced to the cloud. Returns empty string if not set.
 * @returns {Promise<string>} Device name or empty string
 */
export async function getDeviceName(): Promise<string> {
    const existing = await readCloudPreference('deviceName');
    return existing ?? '';
}
