/**
 * Core translation logic
 * Pure functions with no DOM dependencies — importable from SW or main thread
 */
import type { Translation, TranslationEntry, TranslationWordItem, MessageReplyReference, TextReplyReference, ReplyReference } from '@/types/translation';
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
 * Formats a timestamp as local date/time with the local UTC offset
 * @param {number} ts - Timestamp in milliseconds
 * @returns {string} Formatted string like "2025-06-02 14:30 +02:00"
 */
export function formatTimestampWithOffset(ts: number): string {
    const d = new Date(ts);
    // getTimezoneOffset returns minutes behind UTC, so negate it to get the offset
    const offsetMinutes = -d.getTimezoneOffset();
    const sign = offsetMinutes < 0 ? '-' : '+';
    const absMinutes = Math.abs(offsetMinutes);
    const pad = (n: number) => String(n).padStart(2, '0');
    const offset = `${sign}${pad(Math.floor(absMinutes / 60))}:${pad(absMinutes % 60)}`;
    return `${formatTimestamp(ts)} ${offset}`;
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

/**
 * A reply reference with its texts resolved against the currently loaded messages.
 */
export type ResolvedReplyReference =
    | {
        kind: 'message';
        pill: 'input' | 'output';
        timestamp: number;
        source: string;
        translation: string;
    }
    | {
        kind: 'text';
        pill?: 'input' | 'output';
        text: string;
    };

/**
 * The display-oriented view of a reply reference.
 * @property {string} roleLabel - Human-readable author label ("Me", "Them", or a quoted label)
 * @property {number | null} timestamp - Target timestamp, or null for a free-text quote
 * @property {string} primaryText - The text the user would naturally read
 * @property {string} secondaryText - The counterpart text, when available
 * @property {boolean} quoted - Whether the reference is a user-supplied quote/description
 */
export interface ReplyReferenceDisplay {
    roleLabel: string;
    timestamp: number | null;
    primaryText: string;
    secondaryText: string;
    quoted: boolean;
}

/**
 * Resolves a reply reference, preferring the live target message when it is loaded.
 * @param {ReplyReference} reference - Reference to resolve
 * @param {ReadonlyArray<Translation>} candidates - Currently loaded messages to search
 * @returns {ResolvedReplyReference} Resolved reference
 */
export function resolveReplyReference(
    reference: ReplyReference,
    candidates: ReadonlyArray<Translation>
): ResolvedReplyReference {
    if (reference.kind === 'text') {
        return {
            kind: 'text',
            pill: reference.pill,
            text: reference.text
        };
    }

    const target = candidates.find(function(candidate: Translation): boolean {
        return candidate.id === reference.messageId;
    });
    if (target) {
        ensureEntries(target);
        const entry = target.entries[target.activeEntryIndex ?? 0];
        if (entry) {
            return {
                kind: 'message',
                pill: reference.pill,
                timestamp: target.timestamp,
                source: entry.source,
                translation: entry.translation
            };
        }
    }

    return {
        kind: 'message',
        pill: reference.pill,
        timestamp: reference.timestamp,
        source: reference.source,
        translation: reference.translation
    };
}

/**
 * Creates a snapshot reference for an already loaded message.
 * @param {Translation} translation - Target message
 * @returns {MessageReplyReference | null} Reference, or null for non-message pills
 */
export function createMessageReplyReference(translation: Translation): MessageReplyReference | null {
    if (translation.pill !== 'input' && translation.pill !== 'output') {
        return null;
    }
    ensureEntries(translation);
    const entry = translation.entries[translation.activeEntryIndex ?? 0];
    return {
        kind: 'message',
        messageId: translation.id,
        timestamp: translation.timestamp,
        pill: translation.pill,
        source: entry?.source ?? '',
        translation: entry?.translation ?? ''
    };
}

/**
 * Creates a free-text reply reference.
 * @param {'input' | 'output' | undefined} pill - Author of the quoted message, when known
 * @param {string} text - Quote or description
 * @returns {TextReplyReference} Reference
 */
export function createTextReplyReference(
    pill: 'input' | 'output' | undefined,
    text: string
): TextReplyReference {
    return {
        kind: 'text',
        pill: pill,
        text: text.trim()
    };
}

/**
 * Builds the display data for a reply reference.
 * @param {ReplyReference} reference - Reference to display
 * @param {ReadonlyArray<Translation>} candidates - Currently loaded messages for live resolution
 * @returns {ReplyReferenceDisplay} Display data
 */
export function getReplyReferenceDisplay(
    reference: ReplyReference,
    candidates: ReadonlyArray<Translation>
): ReplyReferenceDisplay {
    const resolved = resolveReplyReference(reference, candidates);

    if (resolved.kind === 'text') {
        let roleLabel = 'a quoted message';
        if (resolved.pill === 'input') {
            roleLabel = 'Them (quoted)';
        } else if (resolved.pill === 'output') {
            roleLabel = 'Me (quoted)';
        }
        return {
            roleLabel: roleLabel,
            timestamp: null,
            primaryText: resolved.text,
            secondaryText: '',
            quoted: true
        };
    }

    const roleLabel = resolved.pill === 'input' ? 'Them' : 'Me';
    let primaryText = '';
    let secondaryText = '';
    if (resolved.pill === 'input') {
        primaryText = resolved.translation || resolved.source;
        secondaryText = resolved.translation && resolved.source !== resolved.translation ? resolved.source : '';
    } else {
        primaryText = resolved.source || resolved.translation;
        secondaryText = resolved.source && resolved.translation !== resolved.source ? resolved.translation : '';
    }

    return {
        roleLabel: roleLabel,
        timestamp: resolved.timestamp,
        primaryText: primaryText,
        secondaryText: secondaryText,
        quoted: false
    };
}

/**
 * Formats a <replying_to> block for a prompt.
 * @param {ReplyReference | undefined} reference - Reference to format
 * @param {ReadonlyArray<Translation>} candidates - Loaded messages for live resolution
 * @param {boolean} recipientView - Whether to include only the version the listener received
 * @param {TranslationTag[]} outputTags - Tags to strip from output translations
 * @returns {string} Formatted block, or an empty string when there is no reference
 */
export function buildReplyingToBlock(
    reference: ReplyReference | undefined,
    candidates: ReadonlyArray<Translation>,
    recipientView: boolean,
    outputTags: TranslationTag[]
): string {
    if (!reference) {
        return '';
    }

    if (reference.kind === 'text') {
        const roleAttribute = reference.pill
            ? ` role="${reference.pill === 'input' ? 'them' : 'me'}"`
            : '';
        return `<replying_to${roleAttribute} quoted="true">\n<text>${reference.text}</text>\n</replying_to>`;
    }

    const resolved = resolveReplyReference(reference, candidates);
    if (resolved.kind !== 'message') {
        return '';
    }

    const role = resolved.pill === 'input' ? 'them' : 'me';
    const header = `<replying_to role="${role}" ts="${formatTimestamp(resolved.timestamp)}">`;
    const translation = stripIfNeeded(resolved.translation, 'output', outputTags);

    if (recipientView) {
        const receivedText = resolved.pill === 'input' ? resolved.source : translation;
        return `${header}\n<text>${receivedText}</text>\n</replying_to>`;
    }

    return `${header}\n<original>${resolved.source}</original>\n<rendered>${translation}</rendered>\n</replying_to>`;
}
