/**
 * Translation Session data types
 */

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high';

export interface TranslationSession {
    id: string;
    name: string;
    model: string | null;
    inputLanguage: string;
    promptId: string | null;
    background: string;
    reasoning: ReasoningLevel;
    literalModel?: string | null;
    createdAt: number;
}