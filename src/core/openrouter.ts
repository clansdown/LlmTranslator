/**
 * Core OpenRouter streaming functions
 * Pure LLM API calls with no DOM dependencies — importable from SW or main thread
 */
import type { StreamCallbacks, StreamingAbortHandle, StreamingChatCompletionChunk, StreamUsage } from './types';

const OPENROUTER_BASE_URL: string = "https://openrouter.ai/api/v1";

/** When true, streaming calls log request/response diagnostics to the console. */
let debugApiCalls: boolean = false;

/**
 * Enables or disables debug logging for the streaming calls in this module.
 * Called by both the page and the service worker so the app's debug setting is
 * shared across the boundary.
 * @param {boolean} enabled - True to log streaming diagnostics
 * @returns {void}
 */
export function setDebugApiCalls(enabled: boolean): void {
    debugApiCalls = enabled;
}

/**
 * Logs a diagnostic message when debug logging is enabled.
 * @param {string} message - Message to log
 * @returns {void}
 */
function debugLog(message: string): void {
    if (debugApiCalls) { console.log(message); }
}

/**
 * Strips XML tags from a message and returns the first 60 characters of plain text
 * @param {string} text - The message text to trim
 * @returns {string} Trimmed plain text
 */
function trimApiText(text: string): string {
    return text.length > 60 ? text.substring(0, 60) + '...' : text;
}

/**
 * Extracts content from between XML-style tags
 * @param {string} content - Content to search
 * @param {string} tag - Tag name to extract
 * @returns {string} Content inside the tag, or empty string if not found
 */
export function parseTag(content: string, tag: string): string {
    const regex = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = content.match(regex);
    return match ? match[1].trim() : '';
}

/**
 * Streams a chat completion from OpenRouter using Server-Sent Events.
 * This is the low-level streaming function used by all streaming variants.
 * @param {string} apiKey - OpenRouter API key
 * @param {string} userMessage - User message content
 * @param {string} systemPrompt - System prompt
 * @param {string} model - Model ID to use
 * @param {StreamCallbacks} callbacks - Object with onChunk, onDone, onError callbacks
 * @param {string} reasoningLevel - Reasoning effort level
 * @param {number} temperature - Temperature for generation
 * @param {number} [maxTokens] - Optional max_tokens override
 * @returns {StreamingAbortHandle} Object with an abort method to cancel the stream
 */
export function streamChatCompletion(
    apiKey: string,
    userMessage: string,
    systemPrompt: string,
    model: string,
    callbacks: StreamCallbacks,
    reasoningLevel: string = 'none',
    temperature: number = 0.2,
    maxTokens?: number
): StreamingAbortHandle {
    let aborted = false;
    const abortController = new AbortController();

    const responsePromise = (async () => {
        try {
            const messages: Array<{role: string; content: string}> = [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ];

            const body: Record<string, unknown> = {
                model: model,
                messages: messages,
                stream: true,
                provider: { zdr: true },
                reasoning: {
                    effort: reasoningLevel,
                    exclude: reasoningLevel === 'none'
                },
                temperature: temperature
            };

            if (maxTokens && maxTokens > 0) {
                body.max_tokens = maxTokens;
            }

            debugLog(`[API] streamChatCompletion starting - model: ${model}, chars: ${userMessage.length}, text: "${trimApiText(userMessage)}"`);

            const response = await fetch(OPENROUTER_BASE_URL + "/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + apiKey,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(body),
                signal: abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMessage = "Stream request failed: " + response.status;
                try {
                    const errorData = JSON.parse(errorText);
                    if (errorData.error && errorData.error.message) {
                        errorMessage = errorData.error.message;
                    }
                } catch (e) {
                    if (errorText && errorText.trim().length > 0) {
                        errorMessage = errorText;
                    }
                }
                throw new Error(errorMessage);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("No response body stream available");
            }

            const decoder = new TextDecoder();
            let buffer = "";
            let accumulatedText = "";
            let accumulatedReasoning = "";
            let generationId: string | null = null;
            let usage: StreamUsage | null = null;
            let streamEnded = false;

            while (!streamEnded) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                while (true) {
                    const lineEnd = buffer.indexOf('\n');
                    if (lineEnd === -1) break;

                    const line = buffer.slice(0, lineEnd);
                    buffer = buffer.slice(lineEnd + 1);

                    const trimmedLine = line.trim();
                    if (!trimmedLine) continue;
                    if (trimmedLine.startsWith(':')) continue;
                    if (!trimmedLine.startsWith('data: ')) continue;

                    const data = trimmedLine.slice(6);
                    if (data === '[DONE]') {
                        streamEnded = true;
                        break;
                    }

                    try {
                        const chunk: StreamingChatCompletionChunk = JSON.parse(data);

                        if (!generationId && chunk.id) {
                            generationId = chunk.id;
                        }

                        if (chunk.choices && chunk.choices.length > 0) {
                            const choice = chunk.choices[0];

                            if (choice.error) {
                                throw new Error("Stream error: " + choice.error.message);
                            }

                            const delta = choice.delta;

                            if (delta.content) {
                                accumulatedText += delta.content;
                            }

                            if (delta.reasoning_details) {
                                for (const detail of delta.reasoning_details) {
                                    if (detail.type === 'reasoning.text') {
                                        accumulatedReasoning += detail.text;
                                    }
                                }
                            }

                            callbacks.onChunk(accumulatedText, accumulatedReasoning);
                        }

                        if (chunk.usage) {
                            usage = {
                                prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                                completion_tokens: chunk.usage.completion_tokens ?? 0,
                                total_tokens: chunk.usage.total_tokens ?? 0
                            };
                        }
                    } catch (parseError) {
                        if (parseError instanceof SyntaxError) {
                            console.error('[API] Failed to parse streaming chunk:', parseError.message, 'line:', trimmedLine);
                        } else {
                            throw parseError;
                        }
                    }
                }
            }

            debugLog(`[API] streamChatCompletion completed - model: ${model}, generationId: ${generationId}`);
            callbacks.onDone(accumulatedText, accumulatedReasoning, generationId, usage ?? undefined);
        } catch (error) {
            if (aborted) return;
            if (error instanceof DOMException && error.name === 'AbortError') return;
            callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        }
    })();

    return {
        abort: (): void => {
            debugLog('[API] streamChatCompletion abort called');
            aborted = true;
            abortController.abort();
        }
    };
}

/**
 * Streams a plain-text chat message from OpenRouter (for questions).
 * Thin wrapper around streamChatCompletion.
 * @param {string} apiKey - OpenRouter API key
 * @param {string} userMessage - User message content
 * @param {string} systemPrompt - System prompt
 * @param {string} model - Model ID to use
 * @param {StreamCallbacks} callbacks - Object with onChunk, onDone, onError callbacks
 * @param {string} reasoningLevel - Reasoning effort level
 * @param {number} temperature - Temperature for generation
 * @returns {StreamingAbortHandle} Object with an abort method
 */
export function streamSendChatMessage(
    apiKey: string,
    userMessage: string,
    systemPrompt: string,
    model: string,
    callbacks: StreamCallbacks,
    reasoningLevel: string = 'none',
    temperature: number = 0.2
): StreamingAbortHandle {
    return streamChatCompletion(apiKey, userMessage, systemPrompt, model, callbacks, reasoningLevel, temperature);
}

/**
 * Streams a structured translation from OpenRouter (for input/output translations).
 * Thin wrapper around streamChatCompletion.
 * @param {string} apiKey - OpenRouter API key
 * @param {string} userMessage - User message content
 * @param {string} systemPrompt - System prompt
 * @param {string} model - Model ID to use
 * @param {StreamCallbacks} callbacks - Object with onChunk, onDone, onError callbacks
 * @param {string} reasoningLevel - Reasoning effort level
 * @param {number} temperature - Temperature for generation
 * @returns {StreamingAbortHandle} Object with an abort method
 */
export function streamTranslateStructured(
    apiKey: string,
    userMessage: string,
    systemPrompt: string,
    model: string,
    callbacks: StreamCallbacks,
    reasoningLevel: string = 'none',
    temperature: number = 0.2
): StreamingAbortHandle {
    return streamChatCompletion(apiKey, userMessage, systemPrompt, model, callbacks, reasoningLevel, temperature);
}
