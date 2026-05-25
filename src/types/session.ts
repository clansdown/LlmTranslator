/**
 * Translation Session data types
 */

export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface TranslationSession {
    id: string;
    deviceId?: string;
    name: string;
    model: string | null;
    theirLanguage: string;
    myLanguage: string;
    background: string;
    reasoning: ReasoningLevel | null;
    literalModel?: string | null;
    translationInstructions?: string | null;
    interpretationModel?: string | null;
    interpretationReasoning?: ReasoningLevel;
    quickQuestionModel?: string | null;
    quickQuestionReasoning?: ReasoningLevel;
    questionModel?: string | null;
    questionReasoning?: ReasoningLevel;
    wordDefModel?: string | null;
    wordDefReasoning?: ReasoningLevel;
    interlocutorName?: string;
    translationTags?: import('./translationTag').TranslationTag[];
    selectedContextIds?: string[];
    createdAt: number;
}