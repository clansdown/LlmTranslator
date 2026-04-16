/**
 * Markdown rendering utility
 * Uses marked to parse markdown and DOMPurify to sanitize HTML
 */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

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