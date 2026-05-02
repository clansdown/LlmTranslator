/**
 * Translation Session data types
 */

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface TranslationSession {
    id: string;
    name: string;
    model: string | null;
    theirLanguage: string;
    myLanguage: string;
    background: string;
    reasoning: ReasoningLevel;
    literalModel?: string | null;
    translationInstructions?: string | null;
    interpretationModel?: string | null;
    interpretationReasoning?: ReasoningLevel;
    interlocutorName?: string;
    createdAt: number;
}