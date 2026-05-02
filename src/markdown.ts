/**
 * Markdown rendering utility
 * Uses marked to parse markdown and DOMPurify to sanitize HTML
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({
    renderer: {
        del(token) {
            return token.raw;
        }
    }
});

/**
 * Normalizes plain text for markdown rendering by converting single newlines
 * into appropriate markdown formatting based on line length.
 * - If text already contains blank lines (double newlines), returns as-is
 * @param {string} text - Raw plain text to normalize
 * @returns {string} Normalized text with markdown-appropriate line breaks
 */
export function normalizeForMarkdown(text: string): string {
    if (!text) return '';
    text = text.replace(/\n+$/, '');
    if (text.includes('\n\n')) return text;

    const lines = text.split('\n');
    if (lines.length <= 1) return text;

    for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].length >= 80) {
            lines[i] = lines[i] + '\n';
        } else {
            lines[i] = lines[i] + '  ';
        }
    }

    return lines.join('\n');
}

/**
 * Renders markdown text to sanitized HTML
 * @param {string} markdown - Raw markdown text
 * @returns {string} Sanitized HTML string
 */
export function renderMarkdown(markdown: string): string {
    if (!markdown) {
        return '';
    }
    const rawHtml = marked.parse(markdown) as string;
    return DOMPurify.sanitize(rawHtml);
}