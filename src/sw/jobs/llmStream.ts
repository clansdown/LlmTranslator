/**
 * Streaming chat-completion job executed inside the service worker.
 *
 * Running the OpenRouter request here (rather than on the page) means the
 * stream keeps flowing while the page is backgrounded or frozen. The worker
 * stays alive for the duration because the router passes the promise returned
 * by `handleStreamChat` to `ExtendableMessageEvent.waitUntil()`.
 */
import { SW_CHANNEL } from '@/core/protocol';
import type { SwResponse, SwStreamChatRequest } from '@/core/protocol';
import { streamChatCompletion } from '@/core/openrouter';

/** An in-flight job that can be cancelled from the page. */
export interface SwJob {
    abort: () => void;
}

/** Jobs currently running, keyed by their correlation id. */
const activeJobs: Map<string, SwJob> = new Map();

/**
 * Cancels an in-flight job by id.
 * @param {string} id - Correlation id of the job
 * @returns {boolean} True if a job was found and aborted
 */
export function abortJob(id: string): boolean {
    const job = activeJobs.get(id);
    if (!job) { return false; }
    job.abort();
    return true;
}

/**
 * Runs a streaming chat completion and forwards chunks to the page over `port`.
 * @param {SwStreamChatRequest} request - Stream parameters from the page
 * @param {MessagePort} port - Port transferred by the page for responses
 * @returns {Promise<void>} Resolves when the stream finishes, errors, or is aborted
 */
export function handleStreamChat(request: SwStreamChatRequest, port: MessagePort): Promise<void> {
    let settle: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { settle = resolve; });

    /** Sends a protocol message back to the page. */
    function post(message: SwResponse): void {
        port.postMessage(message);
    }

    /**
     * Clears the job and resolves the `waitUntil` promise exactly once.
     * The port is deliberately left open: per spec `port.close()` discards
     * queued-but-undelivered messages, which could drop the terminal message.
     * The page closes its own end of the channel instead.
     */
    function finish(): void {
        activeJobs.delete(request.id);
        settle();
    }

    // Acknowledge the request before any network work so the page can tell
    // "worker never started the job" apart from "no output from the model yet".
    post({ channel: SW_CHANNEL, kind: 'started', id: request.id });

    const handle = streamChatCompletion(
        request.apiKey,
        request.userMessage,
        request.systemPrompt,
        request.model,
        {
            onChunk: (text: string, reasoning: string) => {
                post({ channel: SW_CHANNEL, kind: 'chunk', id: request.id, text, reasoning });
            },
            onDone: (text: string, reasoning: string, generationId: string | null, usage) => {
                post({ channel: SW_CHANNEL, kind: 'done', id: request.id, text, reasoning, generationId, usage });
                finish();
            },
            onError: (error: Error) => {
                post({ channel: SW_CHANNEL, kind: 'error', id: request.id, message: error.message });
                finish();
            }
        },
        request.reasoningLevel,
        request.temperature,
        request.maxTokens
    );

    activeJobs.set(request.id, {
        abort: () => {
            handle.abort();
            finish();
        }
    });

    return finished;
}
