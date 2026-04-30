/**
 * Translation Session data types
 */

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface TranslationSession {
    id: string;
    name: string;
    model: string | null;
    theirLanguage: string;
    myLanguage: string;
    writePromptId: string | null;
    background: string;
    reasoning: ReasoningLevel;
    literalModel?: string | null;
    promptOverride?: string | null;
    interpretationModel?: string | null;
    interpretationReasoning?: ReasoningLevel;
    interlocutorName?: string;
    createdAt: number;
}