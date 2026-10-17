/**
 * Main-thread client for the Translate service worker.
 *
 * This module belongs to the page layer: it may import from `core/`
 * (protocol/types) only, and must never import from `sw/`.
 */
import { SW_CHANNEL } from './core/protocol';
import type { SwAbortRequest, SwResponse, SwStreamChatInput, SwStreamChatRequest } from './core/protocol';
import type { StreamUsage, StreamingAbortHandle } from './types/api';

/** Callbacks invoked as the worker streams a completion back to the page. */
export interface SwStreamHandlers {
    onChunk: (text: string, reasoning: string) => void;
    onDone: (text: string, reasoning: string, generationId: string | null, usage?: StreamUsage) => void;
    onError: (error: Error) => void;
}

/**
 * Reports whether the current environment can use a service worker.
 * @returns {boolean} True when `navigator.serviceWorker` exists
 */
export function isSwAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Reports whether an active service worker is currently controlling this page.
 * Unlike {@link isSwAvailable}, this is a safe gate for routing work to the
 * worker: it is only true once the worker is actually running, so requests will
 * not hang waiting for `navigator.serviceWorker.ready`.
 * @returns {boolean} True when the worker can receive requests right now
 */
export function isSwControlling(): boolean {
    return isSwAvailable() && !!navigator.serviceWorker.controller;
}

/**
 * Waits until a service worker is active and able to receive messages.
 * @returns {Promise<ServiceWorkerRegistration | null>} The registration, or null if unavailable
 */
export async function ensureSwReady(): Promise<ServiceWorkerRegistration | null> {
    if (!isSwAvailable()) { return null; }
    try {
        return await navigator.serviceWorker.ready;
    } catch {
        return null;
    }
}

/**
 * Generates a correlation id for a worker request.
 * @returns {string} A unique id
 */
function generateRequestId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Starts a streaming chat completion in the service worker.
 * @param {SwStreamChatInput} input - Stream parameters
 * @param {SwStreamHandlers} handlers - Chunk/done/error callbacks
 * @returns {StreamingAbortHandle} Handle whose `abort()` cancels the stream
 */
export function requestStream(input: SwStreamChatInput, handlers: SwStreamHandlers): StreamingAbortHandle {
    const id: string = generateRequestId();
    let worker: ServiceWorker | null = null;
    let cancelled: boolean = false;
    let settled: boolean = false;

    /** Sends a cancellation request to the worker if it has been reached. */
    function sendAbort(): void {
        if (!worker) { return; }
        const abortRequest: SwAbortRequest = { channel: SW_CHANNEL, kind: 'abort', id };
        worker.postMessage(abortRequest);
    }

    /** Establishes the message channel and starts the stream in the worker. */
    async function start(): Promise<void> {
        const registration = await ensureSwReady();
        const activeWorker = registration?.active ?? null;
        if (!activeWorker) {
            settled = true;
            handlers.onError(new Error('Service worker is not available'));
            return;
        }
        worker = activeWorker;
        if (cancelled) {
            sendAbort();
            return;
        }

        const channel = new MessageChannel();
        channel.port1.onmessage = (event: MessageEvent<SwResponse>) => {
            const message = event.data;
            if (!message || message.id !== id) { return; }
            if (message.kind === 'chunk') {
                handlers.onChunk(message.text, message.reasoning);
            } else if (message.kind === 'done') {
                settled = true;
                handlers.onDone(message.text, message.reasoning, message.generationId, message.usage);
                channel.port1.close();
            } else if (message.kind === 'error') {
                settled = true;
                handlers.onError(new Error(message.message));
                channel.port1.close();
            }
        };
        channel.port1.start();

        const request: SwStreamChatRequest = {
            channel: SW_CHANNEL,
            kind: 'stream-chat',
            id,
            apiKey: input.apiKey,
            userMessage: input.userMessage,
            systemPrompt: input.systemPrompt,
            model: input.model,
            reasoningLevel: input.reasoningLevel,
            temperature: input.temperature,
            maxTokens: input.maxTokens
        };
        activeWorker.postMessage(request, [channel.port2]);
    }

    void start();

    return {
        abort: (): void => {
            if (cancelled || settled) { return; }
            cancelled = true;
            sendAbort();
        }
    };
}
