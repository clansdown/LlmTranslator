/**
 * Main-thread client for the Translate service worker.
 *
 * This module belongs to the page layer: it may import from `core/` only, and
 * must never import from `sw/`.
 */
import { SW_CHANNEL } from './core/protocol';
import type { SwAbortRequest, SwResponse, SwStreamChatInput, SwStreamChatRequest } from './core/protocol';
import { DEBUG_STREAM_RENDER } from './core/debug';
import type { StreamUsage, StreamingAbortHandle } from './types/api';

/** Callbacks invoked as the worker streams a completion back to the page. */
export interface SwStreamHandlers {
    onChunk: (text: string, reasoning: string) => void;
    onDone: (text: string, reasoning: string, generationId: string | null, usage?: StreamUsage) => void;
    onError: (error: Error) => void;
}

/** How long the worker has to acknowledge a request before it is treated as lost. */
const SW_DISPATCH_TIMEOUT_MS: number = 10000;

/** Maximum gap between messages before an in-flight stream is treated as dead. */
const SW_INACTIVITY_TIMEOUT_MS: number = 120000;

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
 *
 * The stream is watched so a caller can never wait forever: the worker must
 * acknowledge the request within `SW_DISPATCH_TIMEOUT_MS`, must keep sending
 * messages within `SW_INACTIVITY_TIMEOUT_MS`, and must not be replaced mid-stream
 * (which is detected via the worker's `statechange` and `controllerchange`).
 * Any of those ends the stream with `handlers.onError`.
 *
 * @param {SwStreamChatInput} input - Stream parameters
 * @param {SwStreamHandlers} handlers - Chunk/done/error callbacks
 * @returns {StreamingAbortHandle} Handle whose `abort()` cancels the stream
 */
export function requestStream(input: SwStreamChatInput, handlers: SwStreamHandlers): StreamingAbortHandle {
    const id: string = generateRequestId();
    let worker: ServiceWorker | null = null;
    let port: MessagePort | null = null;
    let cancelled: boolean = false;
    let settled: boolean = false;
    let dispatchTimer: number | null = null;
    let inactivityTimer: number | null = null;
    let lastChunkAt: number = 0;

    /** Sends a cancellation request to the worker if it has been reached. */
    function sendAbort(): void {
        if (!worker) { return; }
        const abortRequest: SwAbortRequest = { channel: SW_CHANNEL, kind: 'abort', id };
        worker.postMessage(abortRequest);
    }

    /** Clears the dispatch watchdog once the worker has acknowledged the request. */
    function clearDispatchTimer(): void {
        if (dispatchTimer !== null) { window.clearTimeout(dispatchTimer); dispatchTimer = null; }
    }

    /** Clears both watchdogs. */
    function clearTimers(): void {
        clearDispatchTimer();
        if (inactivityTimer !== null) { window.clearTimeout(inactivityTimer); inactivityTimer = null; }
    }

    /** Stops watching the worker's lifecycle. */
    function detachLifecycle(): void {
        worker?.removeEventListener('statechange', onWorkerStateChange);
        navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
    }

    /**
     * Fails the stream exactly once, releasing timers, listeners and the port.
     * @param {string} reason - Human-readable failure reason
     * @returns {void}
     */
    function failStream(reason: string): void {
        if (settled) { return; }
        settled = true;
        clearTimers();
        detachLifecycle();
        port?.close();
        handlers.onError(new Error(reason));
    }

    /**
     * Completes the stream exactly once, releasing timers, listeners and the port.
     * @returns {void}
     */
    function completeStream(): void {
        if (settled) { return; }
        settled = true;
        clearTimers();
        detachLifecycle();
        port?.close();
    }

    /**
     * Starts the dispatch watchdog: the worker must acknowledge within the timeout.
     * @returns {void}
     */
    function armDispatchTimer(): void {
        clearDispatchTimer();
        dispatchTimer = window.setTimeout(function() {
            failStream('Service worker did not start the request');
        }, SW_DISPATCH_TIMEOUT_MS);
    }

    /**
     * Restarts the inactivity watchdog: the worker must keep sending messages.
     * @returns {void}
     */
    function armInactivityTimer(): void {
        if (inactivityTimer !== null) { window.clearTimeout(inactivityTimer); }
        inactivityTimer = window.setTimeout(function() {
            failStream('Service worker stopped responding');
        }, SW_INACTIVITY_TIMEOUT_MS);
    }

    /**
     * Fails the stream if the worker running it is replaced (e.g. by an update).
     * @returns {void}
     */
    function onWorkerStateChange(): void {
        if (worker && worker.state === 'redundant') {
            failStream('Service worker was replaced');
        }
    }

    /**
     * Fails the stream if a different worker takes control mid-stream.
     * @returns {void}
     */
    function onControllerChange(): void {
        failStream('Service worker changed');
    }

    /** Establishes the message channel and starts the stream in the worker. */
    async function start(): Promise<void> {
        const registration = await ensureSwReady();
        // Dispatch to the worker actually controlling this page, matching the
        // `isSwControlling()` gate used by callers.
        const target: ServiceWorker | null = navigator.serviceWorker.controller ?? registration?.active ?? null;
        if (!target) {
            if (!cancelled) { failStream('Service worker is not available'); }
            return;
        }
        worker = target;
        if (cancelled) {
            sendAbort();
            return;
        }

        const channel = new MessageChannel();
        port = channel.port1;
        channel.port1.onmessage = (event: MessageEvent<SwResponse>) => {
            const message = event.data;
            if (!message || message.id !== id) { return; }
            if (message.kind === 'started') {
                clearDispatchTimer();
                armInactivityTimer();
                lastChunkAt = performance.now();
            } else if (message.kind === 'chunk') {
                armInactivityTimer();
                if (DEBUG_STREAM_RENDER) {
                    const now = performance.now();
                    console.log(`[swClient] chunk +${(now - lastChunkAt).toFixed(1)}ms (${message.text.length} chars)`);
                    lastChunkAt = now;
                }
                handlers.onChunk(message.text, message.reasoning);
            } else if (message.kind === 'done') {
                completeStream();
                handlers.onDone(message.text, message.reasoning, message.generationId, message.usage);
            } else if (message.kind === 'error') {
                failStream(message.message);
            }
        };
        channel.port1.onmessageerror = () => {
            failStream('Service worker response could not be read');
        };
        channel.port1.start();

        // The worker running this job is dead if it becomes redundant or a
        // different worker takes over, so treat those as terminal failures.
        worker.addEventListener('statechange', onWorkerStateChange);
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

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
        try {
            target.postMessage(request, [channel.port2]);
        } catch (error) {
            failStream('Failed to send request to service worker: ' + (error instanceof Error ? error.message : String(error)));
            return;
        }
        armDispatchTimer();
    }

    start().catch(function(error: unknown) {
        failStream('Failed to start service worker request: ' + (error instanceof Error ? error.message : String(error)));
    });

    return {
        abort: (): void => {
            if (cancelled || settled) { return; }
            cancelled = true;
            sendAbort();
            clearTimers();
            detachLifecycle();
            port?.close();
        }
    };
}
