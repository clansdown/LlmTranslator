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
