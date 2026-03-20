/**
 * Default prompts loaded on first use
 */

import type { Prompt } from './types/prompt';

/**
 * Generates a UUID for prompt IDs
 * @returns {string} UUID v4 string
 */
function generateUuid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * @returns {number} Current Unix timestamp in milliseconds
 */
function getCurrentTimestamp(): number {
    return Date.now();
}

/** @type {Prompt[]} */
const DEFAULT_PROMPTS: Prompt[] = [
    {
        id: generateUuid(),
        name: 'Translate to polite Chinese',
        content: 'Translate the following text to polite Chinese:',
        createdAt: getCurrentTimestamp(),
        updatedAt: getCurrentTimestamp()
    },
    {
        id: generateUuid(),
        name: 'Translate to polite Korean',
        content: 'Translate the following text to polite Korean:',
        createdAt: getCurrentTimestamp(),
        updatedAt: getCurrentTimestamp()
    },
    {
        id: generateUuid(),
        name: 'Translate to polite Arabic',
        content: 'Translate the following text to polite Arabic:',
        createdAt: getCurrentTimestamp(),
        updatedAt: getCurrentTimestamp()
    },
    {
        id: generateUuid(),
        name: 'Translate to Greek',
        content: 'Translate the following text to Greek:',
        createdAt: getCurrentTimestamp(),
        updatedAt: getCurrentTimestamp()
    }
];

export { DEFAULT_PROMPTS, generateUuid };
