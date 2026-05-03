/**
 * Translation data types
 */

export interface WordItem {
    type: 'word';
    word: string;
    def: string;
    exp: string;
}

export interface PunctItem {
    type: 'punct';
    text: string;
}

export interface NewlineItem {
    type: 'nl';
}

export type TranslationWordItem = WordItem | PunctItem | NewlineItem;

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
 * @property {TranslationEntry[]} entries - All translation entries for this item (newer field)
 * @property {number} activeEntryIndex - Which entry is currently displayed (defaults to 0)
 */
export interface Translation {
    id: string;
    pill: 'input' | 'output' | 'question';
    entries: TranslationEntry[];
    activeEntryIndex: number;
    timestamp: number;
    status: 'pending' | 'streaming' | 'complete' | 'error';
    error: string | null;
    answerCollapsed?: boolean;
    sectionsCollapsed?: boolean;
    includeInContext?: boolean;
}