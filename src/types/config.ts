/**
 * Application configuration types
 */

import type { ReasoningLevel } from './session';

/**
 * Application configuration stored in memory
 */
export interface Config {
    openRouterApiKey: string | null;
    selectedModel: string | null;
    minPrice: number | null;
    maxPrice: number | null;
    defaultMyLanguage: string;
    approvedModelIds: string[] | null;
    temperature: number;
    questionTemperature: number;
    maxTokens: number;
    quickQuestionModel: string | null;
    defaultQuickQuestionReasoning: ReasoningLevel;
    defaultQuestionModel: string | null;
    defaultQuestionReasoning: ReasoningLevel;
    defaultWordDefModel: string | null;
    defaultWordDefReasoning: ReasoningLevel;
    defaultReasoning: ReasoningLevel;
    defaultLiteralModel: string | null;
    defaultInterpretationModel: string | null;
    defaultInterpretationReasoning: ReasoningLevel;
}
