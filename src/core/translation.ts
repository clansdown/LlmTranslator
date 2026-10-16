/**
 * Core translation logic
 * Pure functions with no DOM dependencies — importable from SW or main thread
 */
import type { Translation, TranslationEntry, TranslationWordItem } from '@/types/translation';
import type { TranslationTag } from '@/types/translationTag';

/**
 * Formats a timestamp as local date/time string
 * @param {number} ts - Timestamp in milliseconds
 * @returns {string} Formatted string like "2025-06-02 14:30"
 */
export function formatTimestamp(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Strips user-defined translation tags from text
 * @param {string} text - Text to strip tags from
 * @param {TranslationTag[]} tags - Tags to strip
 * @returns {string} Clean text
 */
export function stripTranslationTags(text: string, tags: TranslationTag[]): string {
    let cleaned = text;
    for (const tag of tags) {
        const openEscaped = tag.openTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const closeEscaped = tag.closeTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        cleaned = cleaned.replace(new RegExp(openEscaped, 'g'), '');
        cleaned = cleaned.replace(new RegExp(closeEscaped, 'g'), '');
    }
    return cleaned;
}

/**
 * Strips translation tags from text based on entry mode
 * Used for building history where output text may contain register/formality tags
 * @param {string} text - Text to strip
 * @param {string} pill - The entry's pill type
 * @param {TranslationTag[]} outputTags - Tags to strip for output pills
 * @returns {string} Stripped text
 */
export function stripIfNeeded(text: string, pill: string, outputTags: TranslationTag[]): string {
    if (pill === 'output' && outputTags.length > 0) {
        return stripTranslationTags(text, outputTags);
    }
    return text;
}

/**
 * Extracts structured result from raw streaming text
 * Parses <translation>, <explanation>, and <nuances> XML tags
 * @param {string} rawText - Raw streaming output text
 * @returns {{ translation: string; explanation: string; nuances: string }} Parsed sections
 */
export function extractStructuredResult(rawText: string): { translation: string; explanation: string; nuances: string } {
    let translation = "";
    let explanation = "";
    let nuances = "";

    const transMatch = rawText.match(/<translation>([\s\S]*?)<\/translation>/i);
    if (transMatch) {
        translation = transMatch[1].trim();
    }

    const explMatch = rawText.match(/<explanation>([\s\S]*?)<\/explanation>/i);
    if (explMatch) {
        explanation = explMatch[1].trim();
    }

    const nuancesMatch = rawText.match(/<nuances>([\s\S]*?)<\/nuances>/i);
    if (nuancesMatch) {
        nuances = nuancesMatch[1].trim();
    }

    return { translation, explanation, nuances };
}

/**
 * Parses word definitions XML into structured items
 * Strips markdown code fences from XML before parsing
 * @param {string} xml - Raw XML string from LLM
 * @returns {TranslationWordItem[]} Parsed word definition items
 */
export function parseWordDefinitions(xml: string): TranslationWordItem[] {
    // Strip markdown code fences from the XML
    xml = xml.replace(/```[\s\S]*?```/g, function(m) {
        return m.replace(/```\w*\n?/, '').replace(/\n?```/, '');
    });

    const items: TranslationWordItem[] = [];

    const itemRegex = /<item><word>([\s\S]*?)<\/word><def>([\s\S]*?)<\/def><exp>([\s\S]*?)<\/exp><\/item>/g;
    const nonItemParts = xml.split(/(<item>[\s\S]*?<\/item>)/);

    for (const part of nonItemParts) {
        if (/^<item>/.test(part)) {
            const match = itemRegex.exec(part);
            if (match) {
                items.push({
                    type: 'word',
                    word: match[1].trim(),
                    def: match[2].trim(),
                    exp: match[3].trim()
                });
            }
            itemRegex.lastIndex = 0;
        } else {
            const punctRegex = /<p>([\s\S]*?)<\/p>/g;
            let punctMatch;
            while ((punctMatch = punctRegex.exec(part)) !== null) {
                items.push({
                    type: 'punct',
                    text: punctMatch[1]
                });
            }
            const nlRegex = /<nl\s*\/>/g;
            let nlMatch;
            while ((nlMatch = nlRegex.exec(part)) !== null) {
                items.push({
                    type: 'nl'
                });
            }
        }
    }

    return items;
}

/**
 * Ensures a translation has entries array with at least one entry
 * Constructs entries[0] from top-level fields if missing for backward compat
 * @param {Translation} translation - Translation object to check
 * @returns {void}
 */
export function ensureEntries(translation: Translation): void {
    if (translation.entries && translation.entries.length > 0) {
        return;
    }
    const entry: TranslationEntry = {
        source: (translation as any).source ?? '',
        intent: (translation as any).intent ?? '',
        model: (translation as any).model ?? '',
        modelName: (translation as any).modelName ?? '',
        prompt: (translation as any).prompt ?? '',
        promptContent: (translation as any).promptContent ?? '',
        translation: (translation as any).translation ?? '',
        explanation: (translation as any).explanation ?? '',
        nuances: (translation as any).nuances ?? '',
        reasoning: (translation as any).reasoning ?? '',
        reasoningDetails: (translation as any).reasoningDetails ?? '',
        literalRetranslation: (translation as any).literalRetranslation,
        literalPending: (translation as any).literalPending,
        wordDefinitions: (translation as any).wordDefinitions,
        wordData: (translation as any).wordData,
        wordPending: (translation as any).wordPending,
        interpretation: (translation as any).interpretation,
        interpretationPending: (translation as any).interpretationPending
    };
    translation.entries = [entry];
    translation.activeEntryIndex = 0;
    translation.includeInContext = (translation as any).includeInContext ?? false;
}
