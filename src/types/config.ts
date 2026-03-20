/**
 * Application configuration types
 */

/**
 * Application configuration stored in memory
 */
export interface Config {
    openRouterApiKey: string | null;
    selectedModel: string | null;
    minPrice: number | null;
    maxPrice: number | null;
    selectedPromptId: string | null;
}
