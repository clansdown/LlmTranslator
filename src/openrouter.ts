/**
 * OpenRouter API functions
 * Handles communication with OpenRouter for models, balance, and image generation
 */

import { SYSTEM_PROMPT } from './prompts';
import type { 
    ChatCompletionResponse, 
    VisionModel, 
    BalanceInfo, 
    GenerationInfo, 
    ImageConfig, 
    ImageInput,
    Message 
} from './types/api';

const OPENROUTER_BASE_URL: string = "https://openrouter.ai/api/v1";

/**
 * Fetches all available models from OpenRouter
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<VisionModel[]>} Array of model objects with image generation capability
 * @throws {Error} If API request fails
 */
export async function fetchModels(apiKey: string): Promise<VisionModel[]> {
    const response = await fetch(OPENROUTER_BASE_URL + "/models", {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        const text = await response.text();
        console.log("Error response body:", text);
        let errorMessage = "Failed to fetch models: " + response.status;
        
        try {
            const errorData = JSON.parse(text);
            console.log("Parsed error data:", errorData);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();
    const allModels = data.data || [];
    const imageModels = allModels.filter(function(model: VisionModel): boolean {
        const hasMod = model.architecture != null;
        const hasOut = hasMod && model.architecture!.output_modalities != null;
        const hasImage = hasOut && model.architecture!.output_modalities!.indexOf("image") !== -1;
        return hasImage;
    });
    imageModels.sort(function(a: VisionModel, b: VisionModel): number {
        const nameA = (a.name || "").toLowerCase();
        const nameB = (b.name || "").toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        const priceA = parseFloat(a.pricing?.prompt || "0");
        const priceB = parseFloat(b.pricing?.prompt || "0");
        if (priceA < priceB) return -1;
        if (priceA > priceB) return 1;
        const completionA = parseFloat(a.pricing?.completion || "0");
        const completionB = parseFloat(b.pricing?.completion || "0");
        if (completionA < completionB) return -1;
        if (completionA > completionB) return 1;
        return 0;
    });
    return imageModels;
}

/**
 * Fetches all available vision models from OpenRouter (image input + image output)
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<VisionModel[]>} Array of vision model objects
 * @throws {Error} If API request fails
 */
export async function fetchVisionModels(apiKey: string): Promise<VisionModel[]> {
    const response = await fetch(OPENROUTER_BASE_URL + "/models", {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        const text = await response.text();
        console.log("Error response body:", text);
        let errorMessage = "Failed to fetch models: " + response.status;
        
        try {
            const errorData = JSON.parse(text);
            console.log("Parsed error data:", errorData);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();
    const allModels = data.data || [];
    const visionModels = allModels.filter(function(model: VisionModel): boolean {
        const hasOut = model.architecture != null && model.architecture!.output_modalities != null;
        const hasImageOut = hasOut && model.architecture!.output_modalities!.indexOf("image") !== -1;
        const hasIn = model.architecture != null && model.architecture!.input_modalities != null;
        const hasImageIn = hasIn && model.architecture!.input_modalities!.indexOf("image") !== -1;
        return hasImageOut && hasImageIn;
    });
    visionModels.sort(function(a: VisionModel, b: VisionModel): number {
        const nameA = (a.name || "").toLowerCase();
        const nameB = (b.name || "").toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        const priceA = parseFloat(a.pricing?.prompt || "0");
        const priceB = parseFloat(b.pricing?.prompt || "0");
        if (priceA < priceB) return -1;
        if (priceA > priceB) return 1;
        const completionA = parseFloat(a.pricing?.completion || "0");
        const completionB = parseFloat(b.pricing?.completion || "0");
        if (completionA < completionB) return -1;
        if (completionA > completionB) return 1;
        return 0;
    });
    return visionModels;
}

/**
 * Fetches ZDR (Zero Data Retention) models from OpenRouter
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<VisionModel[]>} Array of ZDR vision model objects
 * @throws {Error} If API request fails
 */
export async function fetchZdrModels(apiKey: string): Promise<VisionModel[]> {
    console.log("[fetchZdrModels] Fetching from:", OPENROUTER_BASE_URL + "/endpoints/zdr");
    const response = await fetch(OPENROUTER_BASE_URL + "/endpoints/zdr", {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        }
    });

    console.log("[fetchZdrModels] Response status:", response.status);

    if (!response.ok) {
        const text = await response.text();
        console.log("Error response body:", text);
        let errorMessage = "Failed to fetch ZDR models: " + response.status;
        
        try {
            const errorData = JSON.parse(text);
            console.log("Parsed error data:", errorData);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();
    console.log("[fetchZdrModels] Raw response data:", data);
    console.log("[fetchZdrModels] Models count:", data.data?.length);
    
    const allModels = data.data || [];
    
    // Map ZDR response field names to our VisionModel type
    const models = allModels.map(function(model: {
        model_id?: string;
        model_name?: string;
        provider_name?: string;
        pricing?: { prompt: string; completion: string };
    }): VisionModel {
        return {
            id: model.model_id ?? "",
            name: model.model_name ?? "",
            providerName: model.provider_name,
            pricing: model.pricing ? {
                prompt: model.pricing.prompt,
                completion: model.pricing.completion
            } : undefined
        };
    });
    
    // Sort alphabetically by name
    models.sort(function(a: VisionModel, b: VisionModel): number {
        const nameA = (a.name ?? "").toLowerCase();
        const nameB = (b.name ?? "").toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        const priceA = parseFloat(a.pricing?.prompt || "0");
        const priceB = parseFloat(b.pricing?.prompt || "0");
        if (priceA < priceB) return -1;
        if (priceA > priceB) return 1;
        const completionA = parseFloat(a.pricing?.completion || "0");
        const completionB = parseFloat(b.pricing?.completion || "0");
        if (completionA < completionB) return -1;
        if (completionA > completionB) return 1;
        return 0;
    });
    
    return models;
}

/**
 * Fetches the account balance from OpenRouter
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<BalanceInfo>} Object with total_credits and total_usage
 * @throws {Error} If API request fails
 */
export async function fetchBalance(apiKey: string): Promise<BalanceInfo> {
    const response = await fetch(OPENROUTER_BASE_URL + "/credits", {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        const text = await response.text();
        console.log("Error response body:", text);
        let errorMessage = "Failed to fetch balance: " + response.status;
        
        try {
            const errorData = JSON.parse(text);
            console.log("Parsed error data:", errorData);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }
        
        throw new Error(errorMessage);
    }

    const data = await response.json();
    return {
        totalCredits: data.data.total_credits,
        totalUsage: data.data.total_usage
    };
}

/**
 * Generates an image using OpenRouter chat completion
 * @param {string} apiKey - OpenRouter API key
 * @param {string} prompt - User's image generation prompt
 * @param {string} model - Model ID to use
 * @param {string | null} systemPrompt - System prompt
 * @param {Message[]} conversationHistory - Previous messages for context
 * @param {ImageConfig | undefined} imageConfig - Image configuration options
 * @param {number | undefined} seed - Seed for reproducible generation
 * @param {ImageInput | undefined} imageInput - Optional image input for vision models
 * @param {string[] | undefined} referenceImages - Optional reference image data URLs
 * @returns {Promise<ChatCompletionResponse>} Chat completion response with images
 * @throws {Error} If API request fails
 */
export async function generateImage(
    apiKey: string,
    prompt: string,
    model: string,
    systemPrompt: string | null,
    conversationHistory: Message[],
    imageConfig: ImageConfig | undefined,
    seed: number | undefined,
    imageInput: ImageInput | undefined,
    referenceImages?: string[]
): Promise<ChatCompletionResponse> {
    /** @type {Array<{role: string, content: string | Array<object>}>} */
    const messages: Array<{role: string; content: string | Array<{type: string; text?: string; image_url?: {url: string}; url?: string}>}> = [];

    if (systemPrompt) {
        messages.push({
            role: "system",
            content: systemPrompt
        });
    }

    if (conversationHistory && conversationHistory.length > 0) {
        conversationHistory.forEach(function(msg: Message) {
            messages.push({
                role: msg.role,
                content: msg.content || ""
            });
        });
    }

    const hasReferenceImages = referenceImages && referenceImages.length > 0;
    const hasImageInput = imageInput && imageInput.imageData;

    if (hasReferenceImages || hasImageInput) {
        /** @type {Array<{type: string; text?: string; image_url?: {url: string}}>} */
        const contentArray: Array<{type: string; text?: string; image_url?: {url: string}}> = [];

        if (prompt && prompt.trim().length > 0) {
            contentArray.push({
                type: "text",
                text: prompt
            });
        }

        if (hasReferenceImages) {
            for (const refUrl of referenceImages!) {
                contentArray.push({
                    type: "image_url",
                    image_url: {
                        url: refUrl
                    }
                });
            }
        }

        if (hasImageInput) {
            contentArray.push({
                type: "image_url",
                image_url: {
                    url: imageInput!.imageData
                }
            });
        }

        messages.push({
            role: "user",
            content: contentArray
        });
    } else {
        messages.push({
            role: "user",
            content: prompt
        });
    }

    /** @type {object} */
    const body: Record<string, unknown> = {
        model: model,
        messages: messages,
        modalities: ["image", "text"]
    };

    if (imageConfig) {
        /** @type {object} */
        const imageConfigObj: Record<string, string> = {};
        if (imageConfig.imageSize) {
            imageConfigObj.image_size = imageConfig.imageSize;
        }
        if (imageConfig.aspectRatio) {
            imageConfigObj.aspect_ratio = imageConfig.aspectRatio;
        }
        if (Object.keys(imageConfigObj).length > 0) {
            body.image_config = imageConfigObj;
        }
    }

    if (typeof seed !== "undefined" && seed !== null) {
        body.seed = seed;
    }

    console.log("Image generation request:", {
        model: model,
        prompt: prompt.substring(0, 100) + "...",
        image_config: imageConfig,
        hasImageInput: !!imageInput
    });

    try {
        const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        console.log("Response status:", response.status, response.statusText);

        if (!response.ok) {
            const text = await response.text();
            console.log("Error response body:", text);

            const errorInfo: { message: string; status?: number; code?: string; type?: string; rawResponse?: string } = {
                message: "Failed to generate image: " + response.status
            };

            try {
                const errorData = JSON.parse(text);
                console.log("Parsed error data:", errorData);

                if (errorData.error && errorData.error.message) {
                    errorInfo.message = errorData.error.message;
                    errorInfo.code = errorData.error.code;
                    errorInfo.type = errorData.error.type;
                }
            } catch (e) {
                errorInfo.message += " - " + text;
            }

            errorInfo.status = response.status;
            errorInfo.rawResponse = text;

            const error = new Error(errorInfo.message);
            (error as unknown as { info: typeof errorInfo }).info = errorInfo;
            throw error;
        }

        const data = await response.json() as ChatCompletionResponse;

        console.log("Response structure keys:", Object.keys(data));
        console.log("Choices count:", data.choices?.length);

        if (!data.choices || data.choices.length === 0) {
            console.error("Invalid response: No choices in response");
            throw new Error("No choices returned from OpenRouter");
        }

        const message = data.choices[0].message;
        console.log("Message keys:", message ? Object.keys(message) : "null");

        const images = message?.images;
        if (!images || images.length === 0) {
            console.error("No images returned in response");
            console.log("Full response data:", JSON.stringify(data, null, 2));
            throw new Error("No images returned by model");
        }

        console.log("Images count:", images.length);

        return data;
    } catch (error) {
        console.error("generateImage error:", error);
        throw error;
    }
}

/**
 * Queries generation information from OpenRouter
 * @param {string} apiKey - OpenRouter API key
 * @param {string} generationId - Generation ID from chat completion response
 * @returns {Promise<GenerationInfo>} Generation info with usage and cost
 * @throws {Error} If API request fails
 */
export async function getGenerationInfo(apiKey: string, generationId: string): Promise<GenerationInfo> {
    const response = await fetch(OPENROUTER_BASE_URL + "/generation?id=" + generationId, {
        method: "GET",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error("Failed to fetch generation info: " + response.status);
    }

    return await response.json();
}

/**
 * Generates text-only completion for conversation title
 * @param {string} apiKey - OpenRouter API key
 * @param {string} prompt - User's prompt to summarize
 * @param {string} systemPrompt - System prompt for title generation
 * @param {string} model - Model ID (google/gemma-3n-e4b-it)
 * @returns {Promise<string>} Generated title text
 * @throws {Error} If API request fails
 */
export async function generateTitle(apiKey: string, prompt: string, systemPrompt: string, model: string): Promise<string> {
    /** @type {Array<{role: string, content: string}>} */
    const messages: Array<{role: string; content: string}> = [];
    
    messages.push({
        role: "system",
        content: systemPrompt
    });
    
    messages.push({
        role: "user",
        content: prompt
    });
    
    /** @type {object} */
    const body: Record<string, unknown> = {
        model: model,
        messages: messages
    };
    
    const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error("Failed to generate title: " + response.status + " - " + text);
    }

    const data = await response.json() as ChatCompletionResponse;
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
        return data.choices[0].message.content || "";
    }
    return "";
}

/**
 * Translates text using OpenRouter chat completion with ZDR enforcement
 * @param {string} apiKey - OpenRouter API key
 * @param {string} sourceText - Text to translate
 * @param {string} systemPrompt - System prompt (e.g., "Translate to English:")
 * @param {string} model - Model ID to use
 * @returns {Promise<string>} Translated text
 * @throws {Error} If API request fails
 */
export async function translateText(
    apiKey: string,
    sourceText: string,
    systemPrompt: string,
    model: string
): Promise<string> {
    /** @type {Array<{role: string; content: string}>} */
    const messages: Array<{role: string; content: string}> = [];

    messages.push({
        role: "system",
        content: systemPrompt
    });

    messages.push({
        role: "user",
        content: sourceText
    });

    /** @type {object} */
    const body: Record<string, unknown> = {
        model: model,
        messages: messages,
        provider: {
            zdr: true
        }
    };

    const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        let errorMessage = "Translation failed: " + response.status;

        try {
            const errorData = JSON.parse(text);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }

        throw new Error(errorMessage);
    }

    const data = await response.json() as ChatCompletionResponse;
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
        return data.choices[0].message.content || "";
    }
    return "";
}

/**
 * Result of a structured translation
 */
export interface TranslationResult {
    translation: string;
    explanation: string;
    nuances: string;
    reasoning: string;
    reasoningDetails: string;
}

/**
 * Parses a tagged section from the response content
 * @param {string} content - Full response content
 * @param {string} tag - Tag name to extract (e.g., "TRANSLATION")
 * @returns {string} Content inside the tag, or empty string if not found
 */
function parseTag(content: string, tag: string): string {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = content.match(regex);
    return match ? match[1].trim() : '';
}

/**
 * Translates text using OpenRouter with structured XML response
 * @param {string} apiKey - OpenRouter API key
 * @param {string} userMessage - Complete user message with BACKGROUND, HISTORY, TRANSLATE, INSTRUCTIONS
 * @param {string} systemPrompt - System prompt
 * @param {string} model - Model ID to use
 * @param {string} reasoningLevel - Reasoning effort level ('none' | 'minimal' | 'low' | 'medium' | 'high')
 * @returns {Promise<TranslationResult>} Object containing translation, explanation, nuances, reasoning
 * @throws {Error} If API request fails
 */
export async function translateStructured(
    apiKey: string,
    userMessage: string,
    systemPrompt: string,
    model: string,
    reasoningLevel: string = 'none'
): Promise<TranslationResult> {
    /** @type {Array<{role: string; content: string}>} */
    const messages: Array<{role: string; content: string}> = [];

    messages.push({
        role: "system",
        content: systemPrompt
    });

    messages.push({
        role: "user",
        content: userMessage
    });

    /** @type {object} */
    const body: Record<string, unknown> = {
        model: model,
        messages: messages,
        provider: {
            zdr: true
        }
    };

    if (reasoningLevel !== 'none') {
        body.reasoning = {
            effort: reasoningLevel
        };
    }

    const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        let errorMessage = "Translation failed: " + response.status;

        try {
            const errorData = JSON.parse(text);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }

        throw new Error(errorMessage);
    }

    const data = await response.json() as ChatCompletionResponse;
    const message = data.choices && data.choices.length > 0 ? data.choices[0].message : null;
    const content = message?.content ?? "";
    const reasoning = message?.reasoning ?? "";
    const reasoningDetails = JSON.stringify(message?.reasoning_details ?? []);

    return {
        translation: parseTag(content, 'TRANSLATION'),
        explanation: parseTag(content, 'EXPLANATION'),
        nuances: parseTag(content, 'NUANCES'),
        reasoning: reasoning,
        reasoningDetails: reasoningDetails
    };
}

/**
 * Translates text using OpenRouter and returns the raw response content (no XML parsing)
 * @param {string} apiKey - OpenRouter API key
 * @param {string} userMessage - User message content
 * @param {string} systemPrompt - System prompt
 * @param {string} model - Model ID to use
 * @param {string} reasoningLevel - Reasoning effort level ('none' | 'minimal' | 'low' | 'medium' | 'high')
 * @returns {Promise<string>} Raw content string from the model
 * @throws {Error} If API request fails
 */
export async function translateRaw(
    apiKey: string,
    userMessage: string,
    systemPrompt: string,
    model: string,
    reasoningLevel: string = 'none'
): Promise<string> {
    /** @type {Array<{role: string; content: string}>} */
    const messages: Array<{role: string; content: string}> = [];

    messages.push({
        role: "system",
        content: systemPrompt
    });

    messages.push({
        role: "user",
        content: userMessage
    });

    /** @type {object} */
    const body: Record<string, unknown> = {
        model: model,
        messages: messages,
        provider: {
            zdr: true
        }
    };

    if (reasoningLevel !== 'none') {
        body.reasoning = {
            effort: reasoningLevel
        };
    }

    const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        let errorMessage = "Translation failed: " + response.status;

        try {
            const errorData = JSON.parse(text);
            if (errorData.error && errorData.error.message) {
                errorMessage = errorData.error.message;
            }
        } catch (e) {
            if (text && text.trim().length > 0) {
                errorMessage = text;
            }
        }

        throw new Error(errorMessage);
    }

    const data = await response.json() as ChatCompletionResponse;
    const message = data.choices && data.choices.length > 0 ? data.choices[0].message : null;
    return message?.content ?? "";
}
