/**
 * Translation Session data types
 */

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface TranslationSession {
    id: string;
    name: string;
    model: string | null;
    readLanguage: string;
    writeLanguage: string;
    writePromptId: string | null;
    background: string;
    reasoning: ReasoningLevel;
    literalModel?: string | null;
    promptOverride?: string | null;
    createdAt: number;
}