/**
 * Core translation logic
 * Pure functions with no DOM dependencies — importable from SW or main thread
 */
import type { Translation, TranslationEntry, TranslationWordItem, WordItem, MessageReplyReference, TextReplyReference, ReplyReference } from '@/types/translation';
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
 * Decodes common XML entities found in model output
 * @param {string} text - Text to decode
 * @returns {string} Decoded text
 */
function decodeXmlEntities(text: string): string {
    return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function(match: string, entity: string): string {
        const lower = entity.toLowerCase();
        if (lower === 'amp') return '&';
        if (lower === 'lt') return '<';
        if (lower === 'gt') return '>';
        if (lower === 'quot') return '"';
        if (lower === 'apos') return "'";
        if (lower === 'nbsp') return '\u00A0';

        let code = NaN;
        if (lower.startsWith('#x')) {
            code = parseInt(lower.slice(2), 16);
        } else if (lower.startsWith('#')) {
            code = parseInt(lower.slice(1), 10);
        }

        if (Number.isFinite(code)) {
            try {
                return String.fromCodePoint(code);
            } catch {
                return match;
            }
        }

        return match;
    });
}

/**
 * Strips nested markup from a field value
 * @param {string} text - Field text
 * @returns {string} Text without nested tags
 */
function stripNestedMarkup(text: string): string {
    return text.replace(/<[^>]*>/g, '');
}

/**
 * Extracts a named field from a word item, tolerating attributes and whitespace
 * @param {string} inner - The content inside an item tag
 * @param {string} tagName - Field tag to extract
 * @returns {string | null} Field text, or null when the tag is absent
 */
function extractWordField(inner: string, tagName: string): string | null {
    const regex = new RegExp('<' + tagName + '\\b[^>]*>([\\s\\S]*?)<\\/' + tagName + '>', 'i');
    const match = regex.exec(inner);
    if (!match) {
        return null;
    }
    return decodeXmlEntities(stripNestedMarkup(match[1])).trim();
}

/**
 * Parses one item into a WordItem
 * @param {string} inner - The content inside an item tag
 * @returns {WordItem | null} Parsed word item, or null when no word is present
 */
function parseWordItem(inner: string): WordItem | null {
    const word = extractWordField(inner, 'word');
    if (!word) {
        return null;
    }

    const item: WordItem = {
        type: 'word',
        word: word,
        def: extractWordField(inner, 'def') ?? ''
    };

    const pos = extractWordField(inner, 'pos');
    const lemma = extractWordField(inner, 'lemma');
    const grammar = extractWordField(inner, 'grammar');
    const exp = extractWordField(inner, 'exp');

    if (pos) item.pos = pos;
    if (lemma) item.lemma = lemma;
    if (grammar) item.grammar = grammar;
    if (exp) item.exp = exp;

    return item;
}

/**
 * Normalizes model output before tokenizing
 * @param {string} xml - Raw model output
 * @returns {string} XML without fences, declarations, or comments
 */
function normalizeWordDefinitionsXml(xml: string): string {
    return xml
        .replace(/```[a-z]*\s*([\s\S]*?)```/gi, function(_match: string, body: string): string {
            return body;
        })
        .replace(/<\?xml[\s\S]*?\?>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Parses word definitions XML into structured items.
 * Tolerates whitespace, attributes, mixed case, code fences, and old <exp>/<nl> output.
 * @param {string} xml - Raw XML string from LLM
 * @returns {TranslationWordItem[]} Parsed word definition items
 */
export function parseWordDefinitions(xml: string): TranslationWordItem[] {
    const normalized = normalizeWordDefinitionsXml(xml);
    const items: TranslationWordItem[] = [];
    const tokenRegex = /<item\b[^>]*>([\s\S]*?)<\/item>|<p\b[^>]*>([\s\S]*?)<\/p>|<br\s*\/?>|<nl\s*\/?>|<space\s*\/?>/gi;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(normalized)) !== null) {
        const token = match[0];
        if (/^<item\b/i.test(token)) {
            const item = parseWordItem(match[1] ?? '');
            if (item) {
                items.push(item);
            }
        } else if (/^<p\b/i.test(token)) {
            items.push({
                type: 'punct',
                text: decodeXmlEntities(match[2] ?? '')
            });
        } else if (/^<space\b/i.test(token)) {
            items.push({
                type: 'space'
            });
        } else {
            items.push({
                type: 'nl'
            });
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
