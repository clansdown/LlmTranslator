/**
 * Message protocol shared between the main thread and the Translate service worker.
 *
 * This module is part of the `core/` layer: it may be imported by both the page
 * and the worker, and must not import from `sw/` or any page-only module.
 *
 * Transport: the page starts a request by calling `ServiceWorker.postMessage`
 * with a `MessageChannel` port transferred in the port list. The worker replies
 * on that port with `SwResponse` messages correlated by `id`. Cancellation is
 * sent as a separate `SwAbortRequest` on the worker (no port needed).
 */
import type { StreamUsage } from './types';

/** Identifies messages that belong to this application's worker protocol. */
export const SW_CHANNEL: string = 'translate-service-worker';

/** Fields required to start a streaming chat completion in the worker. */
export interface SwStreamChatInput {
    apiKey: string;
    userMessage: string;
    systemPrompt: string;
    model: string;
    reasoningLevel: string;
    temperature: number;
    maxTokens?: number;
}

/** Request that asks the worker to start a streaming chat completion. */
export interface SwStreamChatRequest extends SwStreamChatInput {
    channel: string;
    kind: 'stream-chat';
    id: string;
}

/** Request that asks the worker to cancel an in-flight job. */
export interface SwAbortRequest {
    channel: string;
    kind: 'abort';
    id: string;
}

/** Any request the page may send to the worker. */
export type SwRequest = SwStreamChatRequest | SwAbortRequest;

/** Incremental text/reasoning emitted during a stream. */
export interface SwChunkMessage {
    channel: string;
    kind: 'chunk';
    id: string;
    text: string;
    reasoning: string;
}

/** Terminal success message for a stream. */
export interface SwDoneMessage {
    channel: string;
    kind: 'done';
    id: string;
    text: string;
    reasoning: string;
    generationId: string | null;
    usage?: StreamUsage;
}

/** Terminal failure message for a stream. */
export interface SwErrorMessage {
    channel: string;
    kind: 'error';
    id: string;
    message: string;
}

/** Any response the worker may send back to the page. */
export type SwResponse = SwChunkMessage | SwDoneMessage | SwErrorMessage;
