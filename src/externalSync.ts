/**
 * External Directory Sync Module
 * Handles syncing data between OPFS and a user-selected external directory
 */

import { STATE } from './state';
import { listConversations, getOPFSHandle, loadConversation, loadSummary, listImages, listReferenceImages, saveDirectoryHandle, loadDirectoryHandle, clearDirectoryHandle } from './storage';
import * as ui from './ui';

declare global {
    interface Window {
        showDirectoryPicker: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }

    interface FileSystemDirectoryHandle {
        queryPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
        requestPermission?(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    }
}

const EXTERNAL_CONVERSATIONS_DIR: string = "conversations";
const EXTERNAL_IMAGES_DIR: string = "images";
const EXTERNAL_REFERENCE_DIR: string = "reference";

/**
 * Checks if the File System Access API is supported
 * @returns {boolean} True if supported
 */
export function isFileSystemAccessSupported(): boolean {
    return 'showDirectoryPicker' in window;
}

/**
 * Opens a directory picker and stores the directory handle
 * @returns {Promise<boolean>} True if directory was selected
 */
export async function selectDirectory(): Promise<boolean> {
    if (!isFileSystemAccessSupported()) {
        console.warn("File System Access API not supported");
        return false;
    }

    try {
        const dirHandle = await window.showDirectoryPicker();
        STATE.externalSync.directoryHandle = dirHandle;
        STATE.externalSync.syncEnabled = true;
        await saveDirectoryHandle(dirHandle);
        ui.updateSyncButton(true, false);
        return true;
    } catch (e) {
        if ((e as Error).name !== 'AbortError') {
            console.error("Error selecting directory:", e);
        }
        return false;
    }
}

/**
 * Restores the directory handle from IndexedDB and checks permissions
 * @returns {Promise<boolean>} True if sync is now active
 */
export async function restoreDirectoryHandle(): Promise<boolean> {
    if (!isFileSystemAccessSupported()) {
        return false;
    }

    const storedHandle = await loadDirectoryHandle();
    if (!storedHandle) {
        return false;
    }

    try {
        const permission = await storedHandle.queryPermission?.({ mode: 'readwrite' }) ?? 'prompt';
        
        if (permission === 'granted') {
            STATE.externalSync.directoryHandle = storedHandle;
            STATE.externalSync.syncEnabled = true;
            ui.updateSyncButton(true, false);
            await syncFromOpfs();
            return true;
        } else if (permission === 'prompt') {
            STATE.externalSync.directoryHandle = storedHandle;
            ui.updateSyncButton(false, false, true);
            return false;
        } else {
            await clearDirectoryHandle();
            return false;
        }
    } catch (e) {
        console.error("Error restoring directory handle:", e);
        await clearDirectoryHandle();
        return false;
    }
}

/**
 * Re-authorizes access to the previously stored directory
 * @returns {Promise<boolean>} True if re-authorization succeeded
 */
export async function reauthorizeDirectory(): Promise<boolean> {
    if (!STATE.externalSync.directoryHandle) {
        return await toggleSync();
    }

    try {
        const permission = await STATE.externalSync.directoryHandle.requestPermission?.({ mode: 'readwrite' }) ?? 'prompt';
        
        if (permission === 'granted') {
            STATE.externalSync.syncEnabled = true;
            ui.updateSyncButton(true, false);
            await syncFromOpfs();
            return true;
        } else if (permission === 'denied') {
            await clearDirectoryHandle();
            disableSync();
            return false;
        }
        return false;
    } catch (e) {
        console.error("Error re-authorizing directory:", e);
        return false;
    }
}

/**
 * Disables sync and clears the directory handle
 */
export async function disableSync(): Promise<void> {
    STATE.externalSync.directoryHandle = null;
    STATE.externalSync.syncEnabled = false;
    STATE.externalSync.isSyncing = false;
    STATE.externalSync.syncProgress = null;
    await clearDirectoryHandle();
    ui.updateSyncButton(false, false);
    ui.hideSyncProgress();
}

/**
 * Toggles sync on/off
 * @returns {Promise<boolean>} Current sync state
 */
export async function toggleSync(): Promise<boolean> {
    if (STATE.externalSync.syncEnabled) {
        await disableSync();
        return false;
    }

    const selected = await selectDirectory();
    if (selected) {
        await syncFromOpfs();
    }
    return STATE.externalSync.syncEnabled;
}

/**
 * Ensures a subdirectory exists within a parent directory
 * @param {FileSystemDirectoryHandle} parentDir - Parent directory handle
 * @param {string} dirName - Directory name to ensure exists
 * @returns {Promise<FileSystemDirectoryHandle>} Directory handle
 */
async function ensureExternalDirectory(parentDir: FileSystemDirectoryHandle, dirName: string): Promise<FileSystemDirectoryHandle> {
    try {
        return await parentDir.getDirectoryHandle(dirName, { create: true });
    } catch (e) {
        return await parentDir.getDirectoryHandle(dirName);
    }
}

/**
 * Compares the modification time of OPFS file vs external file
 * @param {FileSystemFileHandle} opfsFile - OPFS file handle
 * @param {FileSystemFileHandle} externalFile - External file handle
 * @returns {Promise<boolean>} True if OPFS file is newer or external doesn't exist
 */
async function isOpfsNewer(opfsFile: FileSystemFileHandle, externalFile: FileSystemFileHandle | null): Promise<boolean> {
    if (!externalFile) return true;

    try {
        const opfsModTime = (await opfsFile.getFile()).lastModified;
        const extModTime = (await externalFile.getFile()).lastModified;
        return opfsModTime > extModTime;
    } catch (e) {
        return true;
    }
}

/**
 * Copies a file from source to destination
 * @param {FileSystemFileHandle} sourceHandle - Source file handle
 * @param {FileSystemFileHandle} destHandle - Destination file handle
 * @returns {Promise<void>}
 */
async function copyFile(sourceHandle: FileSystemFileHandle, destHandle: FileSystemFileHandle): Promise<void> {
    const sourceFile = await sourceHandle.getFile();
    const writable = await destHandle.createWritable();
    await writable.write(sourceFile);
    await writable.close();
}

/**
 * Copies a single conversation directory from OPFS to external directory
 * @param {number} timestamp - Conversation timestamp
 * @param {FileSystemDirectoryHandle} externalConvsDir - External conversations directory
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<boolean>} True if successful
 */
async function copyConversationDirectory(
    timestamp: number,
    externalConvsDir: FileSystemDirectoryHandle,
    onProgress?: () => void
): Promise<boolean> {
    try {
        const opfsRoot = await getOPFSHandle();
        const opfsConvsDir = await opfsRoot.getDirectoryHandle("conversations");
        const opfsConvDir = await opfsConvsDir.getDirectoryHandle(String(timestamp));

        const externalConvDir = await ensureExternalDirectory(externalConvsDir, String(timestamp));

        const conversation = await loadConversation(timestamp);
        if (!conversation) return false;

        const convJsonHandle = await opfsConvDir.getFileHandle("conversation.json");
        const convJsonExists = await externalConvDir.getFileHandle("conversation.json").then(() => true).catch(() => false);

        if (convJsonExists) {
            const isNewer = await isOpfsNewer(convJsonHandle, await externalConvDir.getFileHandle("conversation.json"));
            if (isNewer) {
                const destHandle = await externalConvDir.getFileHandle("conversation.json", { create: true });
                await copyFile(convJsonHandle, destHandle);
            }
        } else {
            const destHandle = await externalConvDir.getFileHandle("conversation.json", { create: true });
            await copyFile(convJsonHandle, destHandle);
        }
        if (onProgress) onProgress();

        const summary = await loadSummary(timestamp);
        if (summary) {
            const summaryJsonHandle = await opfsConvDir.getFileHandle("summary.json");
            const summaryExists = await externalConvDir.getFileHandle("summary.json").then(() => true).catch(() => false);

        if (summaryExists) {
            const isNewer = await isOpfsNewer(summaryJsonHandle, await externalConvDir.getFileHandle("summary.json"));
            if (isNewer) {
                const destHandle = await externalConvDir.getFileHandle("summary.json", { create: true });
                await copyFile(summaryJsonHandle, destHandle);
            }
        } else {
            const destHandle = await externalConvDir.getFileHandle("summary.json", { create: true });
            await copyFile(summaryJsonHandle, destHandle);
        }
            if (onProgress) onProgress();
        }

        const opfsImagesDir = await opfsConvDir.getDirectoryHandle("images");
        const externalImagesDir = await ensureExternalDirectory(externalConvDir, EXTERNAL_IMAGES_DIR);

        const imageIndices = await listImages(timestamp);
        for (const imgIndex of imageIndices) {
            const imgFileName = String(imgIndex) + ".png";
            try {
                const opfsImgHandle = await opfsImagesDir.getFileHandle(imgFileName);
                const extImgExists = await externalImagesDir.getFileHandle(imgFileName).then(() => true).catch(() => false);

                if (extImgExists) {
                    const isNewer = await isOpfsNewer(opfsImgHandle, await externalImagesDir.getFileHandle(imgFileName));
                    if (isNewer) {
                        const destHandle = await externalImagesDir.getFileHandle(imgFileName, { create: true });
                        await copyFile(opfsImgHandle, destHandle);
                    }
                } else {
                    const destHandle = await externalImagesDir.getFileHandle(imgFileName, { create: true });
                    await copyFile(opfsImgHandle, destHandle);
                }
            } catch (e) {
                console.error("Error copying image", imgFileName, e);
            }
            if (onProgress) onProgress();
        }

        const opfsRefDir = await opfsConvDir.getDirectoryHandle(EXTERNAL_REFERENCE_DIR);
        const externalRefDir = await ensureExternalDirectory(externalConvDir, EXTERNAL_REFERENCE_DIR);

        const refIndices = await listReferenceImages(timestamp);
        for (const refIndex of refIndices) {
            const refFileName = String(refIndex) + ".png";
            try {
                const opfsRefHandle = await opfsRefDir.getFileHandle(refFileName);
                const extRefExists = await externalRefDir.getFileHandle(refFileName).then(() => true).catch(() => false);

                if (extRefExists) {
                    const isNewer = await isOpfsNewer(opfsRefHandle, await externalRefDir.getFileHandle(refFileName));
                    if (isNewer) {
                        const destHandle = await externalRefDir.getFileHandle(refFileName, { create: true });
                        await copyFile(opfsRefHandle, destHandle);
                    }
                } else {
                    const destHandle = await externalRefDir.getFileHandle(refFileName, { create: true });
                    await copyFile(opfsRefHandle, destHandle);
                }
            } catch (e) {
                console.error("Error copying reference image", refFileName, e);
            }
            if (onProgress) onProgress();
        }

        return true;
    } catch (e) {
        console.error("Error copying conversation", timestamp, e);
        return false;
    }
}

/**
 * Syncs all data from OPFS to the external directory
 * @returns {Promise<void>}
 */
export async function syncFromOpfs(): Promise<void> {
    if (!STATE.externalSync.directoryHandle) return;

    STATE.externalSync.isSyncing = true;
    ui.updateSyncButton(true, true);

    const timestamps = await listConversations();
    let processed = 0;

    STATE.externalSync.syncProgress = { current: 0, total: timestamps.length };
    ui.showSyncProgress(0, timestamps.length);

    const externalRoot = STATE.externalSync.directoryHandle;
    const externalConvsDir = await ensureExternalDirectory(externalRoot, EXTERNAL_CONVERSATIONS_DIR);

    for (const timestamp of timestamps) {
        await copyConversationDirectory(timestamp, externalConvsDir, () => {
            processed++;
        });

        processed++;
        STATE.externalSync.syncProgress!.current = timestamps.indexOf(timestamp) + 1;
        ui.showSyncProgress(STATE.externalSync.syncProgress!.current, timestamps.length);
    }

    STATE.externalSync.isSyncing = false;
    STATE.externalSync.syncProgress = null;
    ui.hideSyncProgress(true);
    ui.updateSyncButton(true, false);
}

/**
 * Saves image data to the external directory
 * @param {number} timestamp - Conversation timestamp
 * @param {string} imageData - Base64 image data
 * @param {number} imageIndex - Image index
 * @returns {Promise<boolean>} True if successful
 */
export async function saveImageToExternal(timestamp: number, imageData: string, imageIndex: number): Promise<boolean> {
    if (!STATE.externalSync.syncEnabled || !STATE.externalSync.directoryHandle) {
        return false;
    }

    try {
        const externalRoot = STATE.externalSync.directoryHandle;
        const externalConvsDir = await ensureExternalDirectory(externalRoot, EXTERNAL_CONVERSATIONS_DIR);
        const externalConvDir = await ensureExternalDirectory(externalConvsDir, String(timestamp));
        const externalImagesDir = await ensureExternalDirectory(externalConvDir, EXTERNAL_IMAGES_DIR);

        const fileName = String(imageIndex) + ".png";

        let base64Data = imageData;
        if (imageData.startsWith("data:")) {
            const parts = imageData.split(",");
            if (parts.length > 1) {
                base64Data = parts[1];
            }
        }

        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const fileHandle = await externalImagesDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();

        return true;
    } catch (e) {
        console.error("Error saving image to external directory:", e);
        return false;
    }
}

/**
 * Saves conversation data to the external directory
 * @param {number} timestamp - Conversation timestamp
 * @param {Object} conversationData - Conversation object
 * @returns {Promise<boolean>} True if successful
 */
export async function saveConversationToExternal(timestamp: number, conversationData: unknown): Promise<boolean> {
    if (!STATE.externalSync.syncEnabled || !STATE.externalSync.directoryHandle) {
        return false;
    }

    try {
        const externalRoot = STATE.externalSync.directoryHandle;
        const externalConvsDir = await ensureExternalDirectory(externalRoot, EXTERNAL_CONVERSATIONS_DIR);
        const externalConvDir = await ensureExternalDirectory(externalConvsDir, String(timestamp));

        const fileHandle = await externalConvDir.getFileHandle("conversation.json", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(conversationData, null, 2));
        await writable.close();

        return true;
    } catch (e) {
        console.error("Error saving conversation to external directory:", e);
        return false;
    }
}

/**
 * Saves summary data to the external directory
 * @param {number} timestamp - Conversation timestamp
 * @param {Object} summaryData - Summary object
 * @returns {Promise<boolean>} True if successful
 */
export async function saveSummaryToExternal(timestamp: number, summaryData: unknown): Promise<boolean> {
    if (!STATE.externalSync.syncEnabled || !STATE.externalSync.directoryHandle) {
        return false;
    }

    try {
        const externalRoot = STATE.externalSync.directoryHandle;
        const externalConvsDir = await ensureExternalDirectory(externalRoot, EXTERNAL_CONVERSATIONS_DIR);
        const externalConvDir = await ensureExternalDirectory(externalConvsDir, String(timestamp));

        const fileHandle = await externalConvDir.getFileHandle("summary.json", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(summaryData, null, 2));
        await writable.close();

        return true;
    } catch (e) {
        console.error("Error saving summary to external directory:", e);
        return false;
    }
}

/**
 * Saves reference image to the external directory
 * @param {number} timestamp - Conversation timestamp
 * @param {File} file - Image file
 * @param {number} imageIndex - Image index
 * @returns {Promise<boolean>} True if successful
 */
export async function saveReferenceImageToExternal(timestamp: number, file: File, imageIndex: number): Promise<boolean> {
    if (!STATE.externalSync.syncEnabled || !STATE.externalSync.directoryHandle) {
        return false;
    }

    try {
        const externalRoot = STATE.externalSync.directoryHandle;
        const externalConvsDir = await ensureExternalDirectory(externalRoot, EXTERNAL_CONVERSATIONS_DIR);
        const externalConvDir = await ensureExternalDirectory(externalConvsDir, String(timestamp));
        const externalRefDir = await ensureExternalDirectory(externalConvDir, EXTERNAL_REFERENCE_DIR);

        const fileName = String(imageIndex) + ".png";
        const fileHandle = await externalRefDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(await file.arrayBuffer());
        await writable.close();

        return true;
    } catch (e) {
        console.error("Error saving reference image to external directory:", e);
        return false;
    }
}
