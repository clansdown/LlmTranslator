/**
 * OPFS Storage Module
 * 
 * Part of the FindForge suite. This app's data is namespaced under /translate/
 * in OPFS to prevent conflicts with other FindForge tools sharing the same
 * browser origin. Shared settings (like cloud sync toggle) live under /cloud/.
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
 *     ├── preferences/
 *     │   ├── apiKey
 *     │   ├── cloudSync                ← Per-app state (lastSyncTime)
 *     │   ├── syncManifest
 *     │   ├── syncJournal
 *     │   └── ... (other preference files)
 *     ├── sessions/
 *     │   └── {id}/
 *     │       ├── session.json
 *     │       └── translations/
 *     │           └── {ts}.json
 *     ├── translations/               ← Legacy flat translations
 *     │   ├── input/
 *     │   └── output/
 *     └── conversations/               ← Image conversations
 *         └── {timestamp}/
 *             ├── conversation.json
 *             ├── summary.json
 *             └── images/
 *                 └── {index}.png
 */

import type { Conversation, ConversationSummary } from './types/state';
import type { Translation } from './types/translation';
import type { TranslationSession } from './types/session';
import { getDefaultTags } from './defaultTranslationTags';
import { DEBUG_TRANSLATIONS, DEBUG_SESSIONS } from './debug';
import { queueSync, computeHash } from './cloudSync';
import { recordWrite, recordDelete, recordDeleteRecursive } from './syncJournal';
import { saveImageToExternal, saveConversationToExternal, saveSummaryToExternal, saveReferenceImageToExternal } from './externalSync';
import { APP_PREFIX, CLOUD_PREFIX, getOPFSHandle, ensureDirectory } from './opfs';

const STORAGE_PREFERENCES_DIR: string = "preferences";
const STORAGE_CONVERSATIONS_DIR: string = "conversations";
const STORAGE_IMAGES_DIR: string = "images";
const STORAGE_REFERENCE_DIR: string = "reference";
const STORAGE_TRANSLATIONS_DIR: string = "translations";
const STORAGE_INPUT_DIR: string = "input";
const STORAGE_OUTPUT_DIR: string = "output";
const STORAGE_SESSIONS_DIR: string = "sessions";
const STORAGE_SESSION_TRANSLATIONS_DIR: string = "translations";
const DEFAULT_SESSION_ID: string = "default";

/**
 * Saves a preference to OPFS
 * @param {string} key - Preference key (filename)
 * @param {string} value - Value to store
 * @returns {Promise<void>}
 */
export async function savePreference(key: string, value: string): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const prefsDir = await ensureDirectory(root, STORAGE_PREFERENCES_DIR);
        const fileHandle = await prefsDir.getFileHandle(key, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(value);
        await writable.close();
        await recordWrite('preferences/' + key, computeHash(value));
        queueSync();
    } catch (e) {
        console.error("Error saving preference:", e);
    }
}

/**
 * Gets a preference from OPFS
 * @param {string} key - Preference key (filename)
 * @param {string} [defaultValue] - Default value if not found
 * @returns {Promise<string | null>} Preference value
 */
export async function getPreference(key: string, defaultValue?: string): Promise<string | null> {
    try {
        const root = await getOPFSHandle();
        const prefsDir = await ensureDirectory(root, STORAGE_PREFERENCES_DIR);
        const fileHandle = await prefsDir.getFileHandle(key);
        const file = await fileHandle.getFile();
        const content = await file.text();
        if (content && content.trim().length > 0) {
            return content.trim();
        }
        return defaultValue !== undefined ? defaultValue : null;
    } catch (e) {
        return defaultValue !== undefined ? defaultValue : null;
    }
}

/**
 * Lists all preference keys
 * @returns {Promise<string[]>} Array of preference keys
 */
export async function listPreferences(): Promise<string[]> {
    try {
        const root = await getOPFSHandle();
        const prefsDir = await ensureDirectory(root, STORAGE_PREFERENCES_DIR);
        const keys: string[] = [];
        for await (const entry of (prefsDir as any).values()) {
            if (entry.kind === "file") {
                keys.push(entry.name);
            }
        }
        return keys;
    } catch (e) {
        return [];
    }
}

/**
 * Deletes a preference from OPFS
 * @param {string} key - Preference key (filename)
 * @returns {Promise<void>}
 */
export async function deletePreference(key: string): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const prefsDir = await ensureDirectory(root, STORAGE_PREFERENCES_DIR);
        await prefsDir.removeEntry(key);
        await recordDelete('preferences/' + key);
        queueSync();
    } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') return;
        console.error("Error deleting preference:", e);
    }
}

/**
 * Clears all preferences
 * @returns {Promise<void>}
 */
export async function clearAllPreferences(): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const prefsDir = await ensureDirectory(root, STORAGE_PREFERENCES_DIR);
        for await (const entry of (prefsDir as any).values()) {
            await prefsDir.removeEntry(entry.name, { recursive: true });
        }
    } catch (e) {
        console.error("Error clearing preferences:", e);
    }
}

/**
 * Creates a new conversation directory
 * @param {number} [timestamp] - Optional timestamp, will generate if not provided
 * @returns {Promise<number>} Epoch timestamp for the conversation
 */
export async function createConversation(timestamp?: number): Promise<number> {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await ensureDirectory(convsDir, String(ts));
        await ensureDirectory(convDir, STORAGE_IMAGES_DIR);
        await ensureDirectory(convDir, STORAGE_REFERENCE_DIR);
        return ts;
    } catch (e) {
        console.error("Error creating conversation:", e);
        return ts;
    }
}

/**
 * Lists all conversation timestamps
 * @returns {Promise<number[]>} Array of epoch timestamps
 */
export async function listConversations(): Promise<number[]> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const timestamps: number[] = [];
        for await (const entry of (convsDir as any).values()) {
            if (entry.kind === "directory") {
                const num = parseInt(entry.name, 10);
                if (!isNaN(num)) {
                    timestamps.push(num);
                }
            }
        }
        timestamps.sort(function(a: number, b: number): number { return b - a; });
        return timestamps;
    } catch (e) {
        return [];
    }
}

/**
 * Loads a conversation by timestamp
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<Conversation | null>} Conversation data
 */
export async function loadConversation(timestamp: number): Promise<Conversation | null> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const fileHandle = await convDir.getFileHandle("conversation.json");
        const file = await fileHandle.getFile();
        const content = await file.text();
        const conversation = JSON.parse(content) as Conversation;

        if (conversation.entries) {
            conversation.entries.forEach(function(entry) {
                if (entry.response?.imageFilenames && !entry.response.imageResolutions) {
                    entry.response.imageResolutions = entry.response.imageFilenames.map(function(): '1K' | '2K' | '4K' { return "1K"; }) as Array<'1K' | '2K' | '4K'>;
                }
            });
        }

        return conversation;
    } catch (e) {
        return null;
    }
}

/**
 * Saves a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {Conversation} conversationData - Conversation object
 * @returns {Promise<void>}
 */
export async function saveConversation(timestamp: number, conversationData: Conversation): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await ensureDirectory(convsDir, String(timestamp));
        const fileHandle = await convDir.getFileHandle("conversation.json", { create: true });
        const writable = await fileHandle.createWritable();
        const json = JSON.stringify(conversationData, null, 2);
        await writable.write(json);
        await writable.close();
        await recordWrite('conversations/' + timestamp + '/conversation.json', computeHash(json));
        saveConversationToExternal(timestamp, conversationData);
        queueSync();
    } catch (e) {
        console.error("Error saving conversation:", e);
    }
}

/**
 * Deletes a conversation and all its contents
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<void>}
 */
export async function deleteConversation(timestamp: number): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        await convsDir.removeEntry(String(timestamp), { recursive: true });
        await recordDeleteRecursive('conversations/' + timestamp);
        queueSync();
    } catch (e) {
        console.error("Error deleting conversation:", e);
    }
}

/**
 * Saves an image to a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {string} imageData - Base64 data URL or raw base64 string
 * @returns {Promise<number | null>} Image index number, or null on error
 */
export async function saveImage(timestamp: number, imageData: string): Promise<number | null> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const imagesDir = await ensureDirectory(convDir, STORAGE_IMAGES_DIR);

        const nextIndex = await getNextImageIndex(imagesDir);

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

        const fileHandle = await imagesDir.getFileHandle(String(nextIndex) + ".png", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();

        saveImageToExternal(timestamp, imageData, nextIndex);
        await recordWrite('conversations/' + timestamp + '/images/' + nextIndex + '.png', computeHash(bytes.buffer));
        queueSync();

        return nextIndex;
    } catch (e) {
        console.error("Error saving image:", e);
        return null;
    }
}

/**
 * Gets the next available image index for a conversation
 * @param {FileSystemDirectoryHandle} imagesDir - Images directory handle
 * @returns {Promise<number>} Next image number
 */
export async function getNextImageIndex(imagesDir: FileSystemDirectoryHandle): Promise<number> {
    let maxIndex = 0;
    for await (const entry of (imagesDir as any).values()) {
        if (entry.kind === "file" && entry.name.endsWith(".png")) {
            const num = parseInt(entry.name.replace(".png", ""), 10);
            if (!isNaN(num) && num > maxIndex) {
                maxIndex = num;
            }
        }
    }
    return maxIndex + 1;
}

/**
 * Gets an image from a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {number} imageIndex - Image index number
 * @returns {Promise<Blob | null>} Image blob
 */
export async function getImage(timestamp: number, imageIndex: number): Promise<Blob | null> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const imagesDir = await ensureDirectory(convDir, STORAGE_IMAGES_DIR);
        const fileHandle = await imagesDir.getFileHandle(String(imageIndex) + ".png");
        return await fileHandle.getFile();
    } catch (e) {
        return null;
    }
}

/**
 * Gets the data URL for an image
 * @param {number} timestamp - Conversation timestamp
 * @param {number} imageIndex - Image index number
 * @returns {Promise<string | null>} Base64 data URL
 */
export async function getImageDataURL(timestamp: number, imageIndex: number): Promise<string | null> {
    try {
        const blob = await getImage(timestamp, imageIndex);
        if (!blob) return null;
        return new Promise<string | null>(function(resolve) {
            const reader = new FileReader();
            reader.onloadend = function() {
                resolve(reader.result as string);
            };
            reader.onerror = function() {
                resolve(null);
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return null;
    }
}

/**
 * Deletes all images for a conversation
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<void>}
 */
export async function deleteImagesForConversation(timestamp: number): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const imagesDir = await ensureDirectory(convDir, STORAGE_IMAGES_DIR);
        for await (const entry of (imagesDir as any).values()) {
            await imagesDir.removeEntry(entry.name);
        }
        await recordDeleteRecursive('conversations/' + timestamp + '/images');
        queueSync();
    } catch (e) {
        console.error("Error deleting images:", e);
    }
}

/**
 * Saves or updates summary.json for a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {ConversationSummary} summaryData - Summary data object
 * @returns {Promise<void>}
 */
export async function saveSummary(timestamp: number, summaryData: ConversationSummary): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await ensureDirectory(convsDir, String(timestamp));
        const fileHandle = await convDir.getFileHandle("summary.json", { create: true });
        const writable = await fileHandle.createWritable();
        const json = JSON.stringify(summaryData, null, 2);
        await writable.write(json);
        await writable.close();
        await recordWrite('conversations/' + timestamp + '/summary.json', computeHash(json));
        queueSync();
    } catch (e) {
        console.error("Error saving summary:", e);
    }
}

/**
 * Loads summary.json for a conversation
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<ConversationSummary | null>} Summary data or null
 */
export async function loadSummary(timestamp: number): Promise<ConversationSummary | null> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const fileHandle = await convDir.getFileHandle("summary.json");
        const file = await fileHandle.getFile();
        const content = await file.text();
        return JSON.parse(content) as ConversationSummary;
    } catch (e) {
        return null;
    }
}

/**
 * Gets or creates the reference directory for a conversation
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<FileSystemDirectoryHandle>} Reference directory handle
 */
export async function getReferenceDirectory(timestamp: number): Promise<FileSystemDirectoryHandle> {
    const root = await getOPFSHandle();
    const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
    const convDir = await convsDir.getDirectoryHandle(String(timestamp));
    return await ensureDirectory(convDir, STORAGE_REFERENCE_DIR);
}

/**
 * Uploads an image file to the reference directory of a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {File} file - File to upload
 * @returns {Promise<number | null>} Image index number, or null on error
 */
export async function uploadReferenceImage(timestamp: number, file: File): Promise<number | null> {
    try {
        const refDir = await getReferenceDirectory(timestamp);
        const nextIndex = await getNextReferenceImageIndex(refDir);

        const arrayBuffer = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);

        const fileHandle = await refDir.getFileHandle(String(nextIndex) + ".png", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();

        saveReferenceImageToExternal(timestamp, file, nextIndex);
        await recordWrite('conversations/' + timestamp + '/reference/' + nextIndex + '.png', computeHash(arrayBuffer));
        queueSync();

        return nextIndex;
    } catch (e) {
        console.error("Error uploading reference image:", e);
        return null;
    }
}

/**
 * Gets the next available image index for reference images
 * @param {FileSystemDirectoryHandle} refDir - Reference directory handle
 * @returns {Promise<number>} Next image number
 */
async function getNextReferenceImageIndex(refDir: FileSystemDirectoryHandle): Promise<number> {
    let maxIndex = 0;
    try {
        for await (const entry of (refDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "file" && entry.name.endsWith(".png")) {
                const num = parseInt(entry.name.replace(".png", ""), 10);
                if (!isNaN(num) && num > maxIndex) {
                    maxIndex = num;
                }
            }
        }
    } catch (e) {
        console.error("Error getting next reference image index:", e);
    }
    return maxIndex + 1;
}

/**
 * Gets a reference image from a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {number} imageIndex - Image index number
 * @returns {Promise<Blob | null>} Image blob
 */
export async function getReferenceImage(timestamp: number, imageIndex: number): Promise<Blob | null> {
    try {
        const refDir = await getReferenceDirectory(timestamp);
        const fileHandle = await refDir.getFileHandle(String(imageIndex) + ".png");
        return await fileHandle.getFile();
    } catch (e) {
        return null;
    }
}

/**
 * Gets the data URL for a reference image
 * @param {number} timestamp - Conversation timestamp
 * @param {number} imageIndex - Image index number
 * @returns {Promise<string | null>} Base64 data URL
 */
export async function getReferenceImageDataUrl(timestamp: number, imageIndex: number): Promise<string | null> {
    try {
        const blob = await getReferenceImage(timestamp, imageIndex);
        if (!blob) return null;
        return new Promise<string | null>(function(resolve) {
            const reader = new FileReader();
            reader.onloadend = function() {
                resolve(reader.result as string);
            };
            reader.onerror = function() {
                resolve(null);
            };
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return null;
    }
}

/**
 * Lists all reference images in a conversation
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<number[]>} Array of image indices
 */
export async function listReferenceImages(timestamp: number): Promise<number[]> {
    try {
        const refDir = await getReferenceDirectory(timestamp);
        const indices: number[] = [];
        for await (const entry of (refDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "file" && entry.name.endsWith(".png")) {
                const num = parseInt(entry.name.replace(".png", ""), 10);
                if (!isNaN(num)) {
                    indices.push(num);
                }
            }
        }
        indices.sort(function(a: number, b: number): number { return a - b; });
        return indices;
    } catch (e) {
        return [];
    }
}

/**
 * Lists all images in a conversation's images directory
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<number[]>} Array of image indices that actually exist
 */
export async function listImages(timestamp: number): Promise<number[]> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const imagesDir = await ensureDirectory(convDir, STORAGE_IMAGES_DIR);
        
        const indices: number[] = [];
        for await (const entry of (imagesDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "file" && entry.name.endsWith(".png")) {
                const num = parseInt(entry.name.replace(".png", ""), 10);
                if (!isNaN(num)) {
                    indices.push(num);
                }
            }
        }
        indices.sort(function(a: number, b: number): number { return a - b; });
        return indices;
    } catch (e) {
        return [];
    }
}

/**
 * Deletes a reference image from a conversation
 * @param {number} timestamp - Conversation timestamp
 * @param {number} imageIndex - Image index number
 * @returns {Promise<void>}
 */
export async function deleteReferenceImage(timestamp: number, imageIndex: number): Promise<void> {
    try {
        const refDir = await getReferenceDirectory(timestamp);
        await refDir.removeEntry(String(imageIndex) + ".png");
        await recordDelete('conversations/' + timestamp + '/reference/' + imageIndex + '.png');
        queueSync();
    } catch (e) {
        console.error("Error deleting reference image:", e);
    }
}

/**
 * Gets all available images from all conversations for the reference image dialog
 * @returns {Promise<Array<{timestamp: number; imageIndex: number; title: string}>>} Array of image info
 */
export async function getAllAvailableImages(): Promise<Array<{timestamp: number; imageIndex: number; title: string}>> {
    const allImages: Array<{timestamp: number; imageIndex: number; title: string}> = [];
    const timestamps = await listConversations();

    for (const timestamp of timestamps) {
        const summary = await loadSummary(timestamp);
        const title = summary?.title || "Conversation " + timestamp;

        const regularImages = await listImages(timestamp);
        for (const i of regularImages) {
            allImages.push({ timestamp: timestamp, imageIndex: i, title: title });
        }

        const refImages = await listReferenceImages(timestamp);
        for (const i of refImages) {
            allImages.push({ timestamp: timestamp, imageIndex: i, title: title + " (Reference)" });
        }
    }

    return allImages;
}

/**
 * Gets the next image index for regular images via directory handle
 * @param {number} timestamp - Conversation timestamp
 * @returns {Promise<number>} Next image number
 */
async function getNextImageIndexViaDir(timestamp: number): Promise<number> {
    try {
        const root = await getOPFSHandle();
        const convsDir = await ensureDirectory(root, STORAGE_CONVERSATIONS_DIR);
        const convDir = await convsDir.getDirectoryHandle(String(timestamp));
        const imagesDir = await ensureDirectory(convDir, STORAGE_IMAGES_DIR);
        return await getNextImageIndex(imagesDir);
    } catch (e) {
        return 1;
    }
}

const INDEXED_DB_NAME: string = "LlmImageCreator";
const INDEXED_DB_VERSION: number = 1;
const STORE_NAME: string = "directoryHandle";

function openIndexedDB(): Promise<IDBDatabase> {
    return new Promise(function(resolve, reject) {
        const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION);

        request.onerror = function() {
            reject(request.error);
        };

        request.onsuccess = function() {
            resolve(request.result);
        };

        request.onupgradeneeded = function(event) {
            const db = (event.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

/**
 * Saves the external directory handle to IndexedDB for persistence across sessions
 * @param {FileSystemDirectoryHandle} handle - Directory handle to save
 * @returns {Promise<void>}
 */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    try {
        const db = await openIndexedDB();
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.put(handle, "externalDirectory");
        await new Promise(function(resolve, reject) {
            transaction.oncomplete = resolve;
            transaction.onerror = function() { reject(transaction.error); };
        });
    } catch (e) {
        console.error("Error saving directory handle:", e);
    }
}

/**
 * Loads the external directory handle from IndexedDB
 * @returns {Promise<FileSystemDirectoryHandle | null>} Directory handle or null if not found
 */
export async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    try {
        const db = await openIndexedDB();
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get("externalDirectory");

        return new Promise(function(resolve, reject) {
            request.onsuccess = function() {
                resolve(request.result ?? null);
            };
            request.onerror = function() {
                reject(request.error);
            };
        });
    } catch (e) {
        console.error("Error loading directory handle:", e);
        return null;
    }
}

/**
 * Clears the stored directory handle from IndexedDB
 * @returns {Promise<void>}
 */
export async function clearDirectoryHandle(): Promise<void> {
    try {
        const db = await openIndexedDB();
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        store.delete("externalDirectory");
        await new Promise(function(resolve, reject) {
            transaction.oncomplete = resolve;
            transaction.onerror = function() { reject(transaction.error); };
        });
    } catch (e) {
        console.error("Error clearing directory handle:", e);
    }
}

/**
 * Saves a translation to OPFS
 * @param {'input' | 'output'} pill - Which pane
 * @param {Translation} translation - Translation object to save
 * @returns {Promise<void>}
 */
export async function saveTranslation(pill: 'input' | 'output', translation: Translation): Promise<void> {
    if (DEBUG_TRANSLATIONS) {
        console.log(`[saveTranslation] Saving ${pill} translation ${translation.timestamp}...`);
    }
    try {
        const root = await getOPFSHandle();
        const translationsDir = await ensureDirectory(root, STORAGE_TRANSLATIONS_DIR);
        const paneDir = pill === 'input' 
            ? await ensureDirectory(translationsDir, STORAGE_INPUT_DIR)
            : await ensureDirectory(translationsDir, STORAGE_OUTPUT_DIR);
        const fileHandle = await paneDir.getFileHandle(String(translation.timestamp) + ".json", { create: true });
        const writable = await fileHandle.createWritable();
        const json = JSON.stringify(translation, null, 2);
        await writable.write(json);
        await writable.close();
        await recordWrite('translations/' + pill + '/' + translation.timestamp + '.json', computeHash(json));
        queueSync();
        if (DEBUG_TRANSLATIONS) {
            console.log(`[saveTranslation] Saved ${pill} translation ${translation.timestamp} successfully`);
        }
    } catch (e) {
        if (DEBUG_TRANSLATIONS) {
            console.error("[saveTranslation] Error saving translation:", e);
        }
    }
}

/**
 * Lists and loads translations from OPFS
 * @param {'input' | 'output'} pill - Which pane
 * @param {number} [limit=1000] - Maximum number of translations to load
 * @returns {Promise<Translation[]>} Array of translation objects, newest first
 */
export async function listTranslations(pill: 'input' | 'output', limit: number = 1000): Promise<Translation[]> {
    if (DEBUG_TRANSLATIONS) {
        console.log(`[listTranslations] Loading ${pill} translations (limit: ${limit})...`);
    }
    try {
        const root = await getOPFSHandle();
        const translationsDir = await ensureDirectory(root, STORAGE_TRANSLATIONS_DIR);
        const paneDir = pill === 'input' 
            ? await ensureDirectory(translationsDir, STORAGE_INPUT_DIR)
            : await ensureDirectory(translationsDir, STORAGE_OUTPUT_DIR);

        const timestamps: number[] = [];
        for await (const entry of (paneDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "file" && entry.name.endsWith(".json")) {
                const num = parseInt(entry.name.replace(".json", ""), 10);
                if (!isNaN(num)) {
                    timestamps.push(num);
                }
            }
        }

        if (DEBUG_TRANSLATIONS) {
            console.log(`[listTranslations] Found ${timestamps.length} files for ${pill}`);
        }

        timestamps.sort(function(a: number, b: number): number { return b - a; });

        const translations: Translation[] = [];
        const limitedTimestamps = timestamps.slice(0, limit);

        for (const timestamp of limitedTimestamps) {
            try {
                const fileHandle = await paneDir.getFileHandle(String(timestamp) + ".json");
                const file = await fileHandle.getFile();
                const content = await file.text();
                const translation = JSON.parse(content) as Translation;
                translations.push(translation);
            } catch (e) {
                if (DEBUG_TRANSLATIONS) {
                    console.warn(`[listTranslations] Skipping invalid translation file: ${timestamp}`);
                }
            }
        }

        if (DEBUG_TRANSLATIONS) {
            console.log(`[listTranslations] Loaded ${translations.length} ${pill} translations`);
        }

        return translations;
    } catch (e) {
        if (DEBUG_TRANSLATIONS) {
            console.error("[listTranslations] Error:", e);
        }
        return [];
    }
}

/**
 * Gets the directory handle for a session
 * @param {string} sessionId - Session ID
 * @returns {Promise<FileSystemDirectoryHandle>} Session directory handle
 */
async function getSessionDirectory(sessionId: string): Promise<FileSystemDirectoryHandle> {
    const root = await getOPFSHandle();
    const sessionsDir = await ensureDirectory(root, STORAGE_SESSIONS_DIR);
    const sessionDir = await ensureDirectory(sessionsDir, sessionId);
    return await ensureDirectory(sessionDir, STORAGE_SESSION_TRANSLATIONS_DIR);
}

/**
 * Saves a session to OPFS
 * @param {TranslationSession} session - Session object to save
 * @returns {Promise<void>}
 */
export async function saveSession(session: TranslationSession): Promise<void> {
    if (DEBUG_SESSIONS) {
        console.log(`[saveSession] Saving session ${session.id}: ${session.name}`);
    }
    try {
        const root = await getOPFSHandle();
        const sessionsDir = await ensureDirectory(root, STORAGE_SESSIONS_DIR);
        const sessionDir = await ensureDirectory(sessionsDir, session.id);
        const fileHandle = await sessionDir.getFileHandle("session.json", { create: true });
        const writable = await fileHandle.createWritable();
        const json = JSON.stringify(session, null, 2);
        await writable.write(json);
        await writable.close();
        await recordWrite('sessions/' + session.id + '/session.json', computeHash(json));
        queueSync();
        if (DEBUG_SESSIONS) {
            console.log(`[saveSession] Saved session ${session.id} successfully`);
        }
    } catch (e) {
        if (DEBUG_SESSIONS) {
            console.error("[saveSession] Error saving session:", e);
        }
    }
}

/**
 * Loads a session from OPFS
 * @param {string} sessionId - Session ID to load
 * @returns {Promise<TranslationSession | null>} Session object or null if not found
 */
export async function loadSession(sessionId: string): Promise<TranslationSession | null> {
    if (DEBUG_SESSIONS) {
        console.log(`[loadSession] Loading session ${sessionId}`);
    }
    try {
        const root = await getOPFSHandle();
        const sessionsDir = await ensureDirectory(root, STORAGE_SESSIONS_DIR);
        const sessionDir = await sessionsDir.getDirectoryHandle(sessionId);
        const fileHandle = await sessionDir.getFileHandle("session.json");
        const file = await fileHandle.getFile();
        const content = await file.text();
        const parsedSession = JSON.parse(content) as TranslationSession;
        const session: TranslationSession = {
            ...parsedSession,
            literalModel: parsedSession.literalModel ?? null
        };
        const legacySession = parsedSession as { inputLanguage?: string; readLanguage?: string; writeLanguage?: string };
        if (!session.theirLanguage) {
            session.theirLanguage = legacySession.readLanguage ?? legacySession.inputLanguage ?? 'english';
        }
        if (!session.myLanguage) {
            session.myLanguage = legacySession.writeLanguage ?? session.theirLanguage;
        }
        if (!session.interlocutorName) {
            session.interlocutorName = session.name;
        }
        if (!session.translationTags) {
            session.translationTags = getDefaultTags(session.theirLanguage);
        }
        if (DEBUG_SESSIONS) {
            console.log(`[loadSession] Loaded session ${sessionId}: ${session.name}`);
        }
        return session;
    } catch (e) {
        if (DEBUG_SESSIONS) {
            console.error(`[loadSession] Error loading session ${sessionId}:`, e);
        }
        return null;
    }
}

/**
 * Lists all sessions from OPFS
 * @returns {Promise<TranslationSession[]>} Array of sessions sorted by createdAt (newest first)
 */
export async function listSessions(): Promise<TranslationSession[]> {
    if (DEBUG_SESSIONS) {
        console.log('[listSessions] Listing sessions...');
    }
    try {
        const root = await getOPFSHandle();
        const sessionsDir = await ensureDirectory(root, STORAGE_SESSIONS_DIR);
        const sessions: TranslationSession[] = [];

        for await (const entry of (sessionsDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "directory") {
                try {
                    const session = await loadSession(entry.name);
                    if (session) {
                        sessions.push(session);
                    }
                } catch (e) {
                    if (DEBUG_SESSIONS) {
                        console.warn(`[listSessions] Skipping invalid session: ${entry.name}`);
                    }
                }
            }
        }

        sessions.sort(function(a: TranslationSession, b: TranslationSession): number {
            return b.createdAt - a.createdAt;
        });

        if (DEBUG_SESSIONS) {
            console.log(`[listSessions] Found ${sessions.length} sessions`);
        }

        return sessions;
    } catch (e) {
        if (DEBUG_SESSIONS) {
            console.error("[listSessions] Error:", e);
        }
        return [];
    }
}

/**
 * Deletes a session and all its translations
 * @param {string} sessionId - Session ID to delete (cannot be default)
 * @returns {Promise<boolean>} True if deleted, false if not allowed or error
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
    if (sessionId === DEFAULT_SESSION_ID) {
        if (DEBUG_SESSIONS) {
            console.log(`[deleteSession] Cannot delete default session`);
        }
        return false;
    }

    if (DEBUG_SESSIONS) {
        console.log(`[deleteSession] Deleting session ${sessionId}`);
    }
    try {
        const root = await getOPFSHandle();
        const sessionsDir = await ensureDirectory(root, STORAGE_SESSIONS_DIR);
        await sessionsDir.removeEntry(sessionId, { recursive: true });
        await recordDeleteRecursive('sessions/' + sessionId);
        queueSync();
        if (DEBUG_SESSIONS) {
            console.log(`[deleteSession] Deleted session ${sessionId} successfully`);
        }
        return true;
    } catch (e) {
        if (DEBUG_SESSIONS) {
            console.error("[deleteSession] Error deleting session:", e);
        }
        return false;
    }
}

/**
 * Gets or creates the default session
 * @param {string} [model] - Optional model to set if creating new default
 * @param {string} [theirLanguage] - Their language to set if creating new default
 * @returns {Promise<TranslationSession>} Default session object
 */
export async function getOrCreateDefaultSession(model?: string | null, theirLanguage?: string): Promise<TranslationSession> {
    const existing = await loadSession(DEFAULT_SESSION_ID);
    if (existing) {
        return existing;
    }

    if (DEBUG_SESSIONS) {
        console.log('[getOrCreateDefaultSession] Creating default session');
    }

    const defaultSession: TranslationSession = {
        id: DEFAULT_SESSION_ID,
        name: "Default",
        model: model ?? null,
        theirLanguage: theirLanguage ?? "english",
        myLanguage: theirLanguage ?? "english",
        background: "",
        reasoning: "none",
        literalModel: null,
        interlocutorName: model ?? "",
        translationTags: getDefaultTags(theirLanguage ?? 'english'),
        createdAt: Date.now()
    };

    await saveSession(defaultSession);
    return defaultSession;
}

/**
 * Saves a translation for a specific session
 * @param {string} sessionId - Session ID
 * @param {Translation} translation - Translation object to save
 * @returns {Promise<void>}
 */
export async function saveSessionTranslation(sessionId: string, translation: Translation): Promise<void> {
    if (DEBUG_TRANSLATIONS) {
        console.log(`[saveSessionTranslation] Saving translation ${translation.timestamp} for session ${sessionId}`);
    }
    try {
        const sessionDir = await getSessionDirectory(sessionId);
        const fileHandle = await sessionDir.getFileHandle(String(translation.timestamp) + ".json", { create: true });
        const writable = await fileHandle.createWritable();
        const json = JSON.stringify(translation, null, 2);
        await writable.write(json);
        await writable.close();
        await recordWrite('sessions/' + sessionId + '/translations/' + translation.timestamp + '.json', computeHash(json));
        queueSync();
        if (DEBUG_TRANSLATIONS) {
            console.log(`[saveSessionTranslation] Saved translation ${translation.timestamp} for session ${sessionId}`);
        }
    } catch (e) {
        if (DEBUG_TRANSLATIONS) {
            console.error("[saveSessionTranslation] Error saving translation:", e);
        }
    }
}

/**
 * Lists translations for a specific session
 * @param {string} sessionId - Session ID
 * @param {'input' | 'output'} pill - Which pane to filter
 * @param {number} [limit=1000] - Maximum number of translations to load
 * @returns {Promise<Translation[]>} Array of translation objects sorted by timestamp (newest first)
 */
export async function listSessionTranslations(sessionId: string, pill: 'input' | 'output' | 'question', limit: number = 1000): Promise<Translation[]> {
    if (DEBUG_TRANSLATIONS) {
        console.log(`[listSessionTranslations] Loading ${pill} translations for session ${sessionId} (limit: ${limit})...`);
    }
    try {
        const sessionDir = await getSessionDirectory(sessionId);
        const timestamps: number[] = [];

        for await (const entry of (sessionDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "file" && entry.name.endsWith(".json")) {
                const num = parseInt(entry.name.replace(".json", ""), 10);
                if (!isNaN(num)) {
                    timestamps.push(num);
                }
            }
        }

        if (DEBUG_TRANSLATIONS) {
            console.log(`[listSessionTranslations] Found ${timestamps.length} files for session ${sessionId}`);
        }

        timestamps.sort(function(a: number, b: number): number { return b - a; });

        const translations: Translation[] = [];
        const limitedTimestamps = timestamps.slice(0, limit);

        for (const timestamp of limitedTimestamps) {
            try {
                const fileHandle = await sessionDir.getFileHandle(String(timestamp) + ".json");
                const file = await fileHandle.getFile();
                const content = await file.text();
                const translation = JSON.parse(content) as Translation;
                if (translation.pill === pill || (pill === 'output' && translation.pill === 'question')) {
                    translations.push(translation);
                }
            } catch (e) {
                if (DEBUG_TRANSLATIONS) {
                    console.warn(`[listSessionTranslations] Skipping invalid translation file: ${timestamp}`);
                }
            }
        }

        if (DEBUG_TRANSLATIONS) {
            console.log(`[listSessionTranslations] Loaded ${translations.length} ${pill} translations for session ${sessionId}`);
        }

        return translations;
    } catch (e) {
        if (DEBUG_TRANSLATIONS) {
            console.error("[listSessionTranslations] Error:", e);
        }
        return [];
    }
}

/**
 * Loads a single translation by session ID and timestamp.
 * @param {string} sessionId - Session ID
 * @param {number} timestamp - Translation timestamp (milliseconds)
 * @returns {Promise<Translation | null>} The translation object, or null if not found
 */
export async function loadSessionTranslation(sessionId: string, timestamp: number): Promise<Translation | null> {
    try {
        const sessionDir = await getSessionDirectory(sessionId);
        const fileHandle = await sessionDir.getFileHandle(String(timestamp) + '.json');
        const file = await fileHandle.getFile();
        const content = await file.text();
        return JSON.parse(content) as Translation;
    } catch {
        return null;
    }
}

/**
 * Clears all translations for a session (used when switching sessions)
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
export async function clearSessionTranslations(sessionId: string): Promise<void> {
    try {
        const sessionDir = await getSessionDirectory(sessionId);
        for await (const entry of (sessionDir as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
            if (entry.kind === "file" && entry.name.endsWith(".json")) {
                await sessionDir.removeEntry(entry.name);
            }
        }
        await recordDeleteRecursive('sessions/' + sessionId + '/translations');
        queueSync();
    } catch (e) {
        if (DEBUG_TRANSLATIONS) {
            console.error("[clearSessionTranslations] Error:", e);
        }
    }
}

export async function deleteSessionTranslation(sessionId: string, timestamp: number): Promise<void> {
    try {
        const sessionDir = await getSessionDirectory(sessionId);
        await sessionDir.removeEntry(String(timestamp) + ".json");
        await recordDelete('sessions/' + sessionId + '/translations/' + timestamp + '.json');
        queueSync();
    } catch (e) {
        if (DEBUG_TRANSLATIONS) {
            console.error("[deleteSessionTranslation] Error:", e);
        }
    }
}
