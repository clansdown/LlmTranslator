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
    defaultQuestionModel: string | null;
    defaultQuestionReasoning: ReasoningLevel;
}
