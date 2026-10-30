/**
 * Translation data types
 */

/**
 * A hoverable word with dictionary and grammar information.
 * @property {string} word - Exact surface form from the text
 * @property {string} [pos] - Lexical part of speech of the lemma
 * @property {string} [lemma] - Dictionary form of the word
 * @property {string} def - Common dictionary meanings
 * @property {string} [grammar] - Morphology, particles, inflection, and usage
 * @property {string} [exp] - Legacy context explanation from older saved data
 */
export interface WordItem {
    type: 'word';
    word: string;
    pos?: string;
    lemma?: string;
    def: string;
    grammar?: string;
    exp?: string;
}

/**
 * A punctuation token.
 */
export interface PunctItem {
    type: 'punct';
    text: string;
}

/**
 * A newline token.
 */
export interface NewlineItem {
    type: 'nl';
}

/**
 * A run of spaces between tokens.
 */
export interface SpaceItem {
    type: 'space';
}

export type TranslationWordItem = WordItem | PunctItem | NewlineItem | SpaceItem;

/**
 * Token usage statistics from an API call.
 */
export interface TokenUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
}

/**
 * A single translation result entry.
 * Multiple entries represent retranslations of the same source text (different models, edits, etc.).
 * @property {string} source - Source text for this entry (may differ after retranslateFromEdit)
 * @property {string} intent - Intent text for this entry
 * @property {string} model - Model ID used
 * @property {string} modelName - Display name of the model
 * @property {string} prompt - Prompt name used
 * @property {string} promptContent - Full prompt content
 * @property {string} translation - Translated text
 * @property {string} explanation - Word/phrase explanations
 * @property {string} nuances - Cultural/linguistic nuances
 * @property {string} reasoning - Reasoning content
 * @property {string} reasoningDetails - Detailed reasoning
 * @property {string} literalRetranslation - Word-by-word retranslation
 * @property {boolean} literalPending - True while literal retranslation is in progress
 * @property {string} wordDefinitions - Raw XML word definitions
 * @property {TranslationWordItem[]} wordData - Parsed word items
 * @property {boolean} wordPending - True while word definitions are loading
 * @property {string} interpretation - How the listener understands the message
 * @property {boolean} interpretationPending - True while interpretation is in progress
 * @property {string} generationId - OpenRouter generation ID for info lookup
 * @property {TokenUsage} usage - Token usage from the API call
 * @property {number} cost - Cost of the API call in USD
 */
export interface TranslationEntry {
    source: string;
    intent: string;
    model: string;
    modelName: string;
    prompt: string;
    promptContent: string;
    translation: string;
    explanation: string;
    nuances: string;
    reasoning: string;
    reasoningDetails: string;
    literalRetranslation?: string;
    literalPending?: boolean;
    wordDefinitions?: string;
    wordData?: TranslationWordItem[];
    wordPending?: boolean;
    interpretation?: string;
    interpretationPending?: boolean;
    generationId?: string;
    usage?: TokenUsage;
    cost?: number;
}

/**
 * Snapshot of an earlier message in this session that the current message replies to.
 * @property {'message'} kind - Discriminator for a real message reference
 * @property {string} messageId - Stable id of the target, used for live resolution
 * @property {number} timestamp - Target timestamp at capture time
 * @property {'input' | 'output'} pill - Author of the target
 * @property {string} source - Snapshot of the target's source text
 * @property {string} translation - Snapshot of the target's translation
 */
export interface MessageReplyReference {
    kind: 'message';
    messageId: string;
    timestamp: number;
    pill: 'input' | 'output';
    source: string;
    translation: string;
}

/**
 * User-supplied quote or description of an earlier message not present in the session.
 * @property {'text'} kind - Discriminator for a free-text quote
 * @property {'input' | 'output'} [pill] - Author of the original, when known
 * @property {string} text - Quote or description (may be a paraphrase)
 */
export interface TextReplyReference {
    kind: 'text';
    pill?: 'input' | 'output';
    text: string;
}

/**
 * What a message is replying to: either a session message or a free-text quote.
 */
export type ReplyReference = MessageReplyReference | TextReplyReference;

/**
 * @property {TranslationEntry[]} entries - All translation entries for this item (newer field)
 * @property {number} activeEntryIndex - Which entry is currently displayed (defaults to 0)
 * @property {ReplyReference} [replyTo] - The earlier message this message replies to
 */
export interface Translation {
    id: string;
    deviceId?: string;
    pill: 'input' | 'output' | 'question' | 'context';
    entries: TranslationEntry[];
    activeEntryIndex: number;
    timestamp: number;
    status: 'pending' | 'streaming' | 'complete' | 'error';
    error: string | null;
    answerCollapsed?: boolean;
    sectionsCollapsed?: boolean;
    includeInContext?: boolean;
    replyTo?: ReplyReference;
}