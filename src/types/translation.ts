/**
 * Translation data types
 */

export interface Translation {
    id: string;
    pill: 'input' | 'output' | 'question';
    source: string;
    translation: string;
    explanation: string;
    nuances: string;
    reasoning: string;
    reasoningDetails: string;
    literalRetranslation?: string;
    literalPending?: boolean;
    model: string;
    modelName: string;
    prompt: string;
    promptContent: string;
    timestamp: number;
    status: 'pending' | 'complete' | 'error';
    error: string | null;
    answerCollapsed?: boolean;
}