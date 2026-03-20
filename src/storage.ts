/**
 * OPFS Storage Module
 * 
 * Directory Structure:
 * 
 * OPFS Root:
 * ├── preferences/
 * │   ├── apiKey
 * │   ├── selectedModel
 * │   ├── minPrice
 * │   ├── maxPrice
 * │   ├── selectedPrompt
 * │   └── ... (other preference files)
 * ├── prompts/
 * │   └── {prompt-id}.json   (one file per prompt)
 * └── conversations/
 *     └── {timestamp}/         (epoch seconds, e.g., 1737991234)
 *         ├── conversation.json
 *         ├── summary.json
 *         └── images/
 *             ├── 1.png
 *             ├── 2.png
 *             ├── 3.png
 *             └── ... (sequential numbering for all images in conversation)
 */

import type { Conversation, ConversationSummary } from './types/state';
import type { Prompt } from './types/prompt';
import { saveImageToExternal, saveConversationToExternal, saveSummaryToExternal, saveReferenceImageToExternal } from './externalSync';

const STORAGE_PREFERENCES_DIR: string = "preferences";
const STORAGE_CONVERSATIONS_DIR: string = "conversations";
const STORAGE_IMAGES_DIR: string = "images";
const STORAGE_REFERENCE_DIR: string = "reference";
const STORAGE_PROMPTS_DIR: string = "prompts";

/**
 * Gets the OPFS root directory handle
 * @returns {Promise<FileSystemDirectoryHandle>} Root directory handle
 */
export function getOPFSHandle(): Promise<FileSystemDirectoryHandle> {
    return window.navigator.storage.getDirectory();
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
        for await (const entry of prefsDir.values()) {
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
    } catch (e) {
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
        for await (const entry of prefsDir.values()) {
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
        for await (const entry of convsDir.values()) {
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
                    entry.response.imageResolutions = entry.response.imageFilenames.map(function(): string { return "1K"; });
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
        await writable.write(JSON.stringify(conversationData, null, 2));
        await writable.close();

        saveConversationToExternal(timestamp, conversationData);
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
    for await (const entry of imagesDir.values()) {
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
        for await (const entry of imagesDir.values()) {
            await imagesDir.removeEntry(entry.name);
        }
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
        const convDir = await convsDir.getDirectoryHandle(String(timestamp), { create: true });
        const fileHandle = await convDir.getFileHandle("summary.json", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(summaryData, null, 2));
        await writable.close();

        saveSummaryToExternal(timestamp, summaryData);
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
 * Saves a prompt to OPFS
 * @param {Prompt} prompt - Prompt object to save
 * @returns {Promise<void>}
 */
export async function savePrompt(prompt: Prompt): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const promptsDir = await ensureDirectory(root, STORAGE_PROMPTS_DIR);
        const fileHandle = await promptsDir.getFileHandle(prompt.id + ".json", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(prompt, null, 2));
        await writable.close();
    } catch (e) {
        console.error("Error saving prompt:", e);
        throw e;
    }
}

/**
 * Loads a prompt from OPFS by ID
 * @param {string} id - Prompt ID
 * @returns {Promise<Prompt | null>} Prompt object or null if not found
 */
export async function loadPrompt(id: string): Promise<Prompt | null> {
    try {
        const root = await getOPFSHandle();
        const promptsDir = await ensureDirectory(root, STORAGE_PROMPTS_DIR);
        const fileHandle = await promptsDir.getFileHandle(id + ".json");
        const file = await fileHandle.getFile();
        const content = await file.text();
        return JSON.parse(content) as Prompt;
    } catch (e) {
        return null;
    }
}

/**
 * Deletes a prompt from OPFS
 * @param {string} id - Prompt ID to delete
 * @returns {Promise<void>}
 */
export async function deletePrompt(id: string): Promise<void> {
    try {
        const root = await getOPFSHandle();
        const promptsDir = await ensureDirectory(root, STORAGE_PROMPTS_DIR);
        await promptsDir.removeEntry(id + ".json");
    } catch (e) {
        console.error("Error deleting prompt:", e);
        throw e;
    }
}

/**
 * Lists all prompts in OPFS
 * @returns {Promise<Prompt[]>} Array of prompt objects
 */
export async function listPrompts(): Promise<Prompt[]> {
    try {
        const root = await getOPFSHandle();
        const promptsDir = await ensureDirectory(root, STORAGE_PROMPTS_DIR);
        const prompts: Prompt[] = [];
        // @ts-expect-error - OPFS does not have standard types
        for await (const entry of promptsDir.values()) {
            if (entry.kind === "file" && entry.name.endsWith(".json")) {
                const fileHandle = await promptsDir.getFileHandle(entry.name);
                const file = await fileHandle.getFile();
                const content = await file.text();
                try {
                    const prompt = JSON.parse(content) as Prompt;
                    prompts.push(prompt);
                } catch (e) {
                    console.warn("Invalid prompt file:", entry.name);
                }
            }
        }
        prompts.sort(function(a, b) { return a.name.localeCompare(b.name); });
        return prompts;
    } catch (e) {
        console.error("Error listing prompts:", e);
        return [];
    }
}

/**
 * Initializes default prompts if no prompts exist
 * @param {Prompt[]} defaultPrompts - Array of default prompts to save
 * @returns {Promise<void>}
 */
export async function initializeDefaultPrompts(defaultPrompts: Prompt[]): Promise<void> {
    const existingPrompts = await listPrompts();
    if (existingPrompts.length === 0) {
        for (const prompt of defaultPrompts) {
            await savePrompt(prompt);
        }
    }
}
