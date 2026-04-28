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

export interface Translation {
    id: string;
    pill: 'input' | 'output' | 'question';
    source: string;
    translation: string;
    intent?: string;
    explanation: string;
    nuances: string;
    reasoning: string;
    reasoningDetails: string;
    literalRetranslation?: string;
    literalPending?: boolean;
    wordDefinitions?: string;
    wordData?: TranslationWordItem[];
    wordPending?: boolean;
    model: string;
    modelName: string;
    prompt: string;
    promptContent: string;
    timestamp: number;
    status: 'pending' | 'complete' | 'error';
    error: string | null;
    answerCollapsed?: boolean;
    sectionsCollapsed?: boolean;
}