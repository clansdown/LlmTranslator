export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    service_tier?: 'auto' | 'default' | 'flex' | 'scale' | 'priority';
    system_fingerprint?: string;
    choices: Choice[];
    usage?: UsageObject;
}

export interface Choice {
    message: Message;
    finish_reason?: FinishReason;
    index?: number;
    logprobs?: Logprobs;
}

export interface Message {
    role: 'assistant';
    content?: string;
    images?: ImageObject[];
    refusal?: string;
    tool_calls?: unknown[];
    reasoning?: string;
    reasoning_details?: unknown[];
}

export interface ImageObject {
    type: 'image_url';
    image_url: ImageUrl;
}

export interface ImageUrl {
    url: string;
}

export interface Logprobs {
    content?: TokenLogprob[];
    refusal?: TokenLogprob[];
}

export interface TokenLogprob {
    token: string;
    bytes?: number[];
    logprob: number;
    top_logprobs?: TopLogprob[];
}

export interface TopLogprob {
    token: string;
    bytes?: number[];
    logprob: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';

export interface UsageObject {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
}

/**
 * Token usage data from the final streaming chunk.
 * Only available in the last chunk before [DONE].
 */
export interface StreamUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface ImageConfig {
    imageSize?: '1K' | '2K' | '4K';
    aspectRatio?: '1:1' | '16:9' | '3:2' | '21:9';
}

export interface ImageInput {
    imageData: string;
}

export interface VisionModel {
    id: string;
    name: string;
    providerName?: string;
    pricing?: {
        prompt: string;
        completion: string;
    };
    architecture?: {
        input_modalities?: string[];
        output_modalities?: string[];
    };
}

export interface BalanceInfo {
    totalCredits: number;
    totalUsage: number;
}

export interface GenerationInfo {
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    cost?: number;
}

/**
 * Represents the delta (new token data) within a streaming chat completion chunk.
 * In streaming mode, each chunk delivers a small piece of the full response via delta fields.
 * @property {string} content - New text content for this chunk (accumulated across chunks)
 * @property {string} role - Role of the message author (usually 'assistant')
 * @property {StreamingReasoningDetail[]} reasoning_details - Reasoning tokens from reasoning-capable models
 */
export interface StreamingDelta {
    content?: string;
    role?: string;
    reasoning_details?: StreamingReasoningDetail[];
}

/**
 * A reasoning detail entry from a reasoning-capable model's streaming output.
 * Represents one atomic reasoning token or summary block.
 */
export interface StreamingReasoningTextDetail {
    type: 'reasoning.text';
    text: string;
    id: string;
    format: string;
    index: number;
}

/**
 * A summary-type reasoning detail indicating a reasoning summary block.
 */
export interface StreamingReasoningSummaryDetail {
    type: 'reasoning.summary';
    summary: string;
    id: string;
    format: string;
}

/**
 * An encrypted reasoning detail whose content is not visible.
 */
export interface StreamingReasoningEncryptedDetail {
    type: 'reasoning.encrypted';
    data: string;
    id: string;
    format: string;
}

/**
 * Union type for all possible reasoning detail shapes in streaming mode.
 */
export type StreamingReasoningDetail = StreamingReasoningTextDetail | StreamingReasoningSummaryDetail | StreamingReasoningEncryptedDetail;

/**
 * A single choice entry within a streaming chat completion chunk.
 * Streaming choices use `delta` instead of `message` (used in non-streaming responses).
 * @property {string | null} finish_reason - Why the stream finished (stop, length, error, etc.)
 * @property {string | null} native_finish_reason - The provider's original finish reason
 * @property {StreamingDelta} delta - The incremental content for this chunk
 * @property {StreamingError} error - Provider-side error, if any
 */
export interface StreamingChoice {
    finish_reason: string | null;
    native_finish_reason: string | null;
    delta: StreamingDelta;
    error?: StreamingError;
}

/**
 * Error object that may appear in a streaming chunk (mid-stream errors).
 */
export interface StreamingError {
    code: number;
    message: string;
}

/**
 * A single SSE chunk from a streaming chat completion response.
 * The object type is 'chat.completion.chunk' (not 'chat.completion').
 * @property {StreamingChoice[]} choices - Streaming choices (typically one)
 * @property {UsageObject} usage - Usage statistics (only present in the final chunk)
 */
export interface StreamingChatCompletionChunk {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: StreamingChoice[];
    usage?: UsageObject;
}

/**
 * Callback interface for streaming chat completion consumers.
 * onChunk is called repeatedly during streaming with accumulated content.
 * onDone signals successful stream completion with the full text.
 * onError signals a failure during streaming.
 */
export interface StreamCallbacks {
    onChunk: (accumulatedText: string, accumulatedReasoning: string) => void;
    onDone: (fullText: string, fullReasoning: string, generationId: string | null, usage?: StreamUsage) => void;
    onError: (error: Error) => void;
}

/**
 * Handle returned by streaming functions, allowing the caller to abort mid-stream.
 */
export interface StreamingAbortHandle {
    abort: () => void;
}
