/**
 * Message router for the Translate service worker.
 *
 * A single `message` listener dispatches page requests. Streaming jobs are run
 * under `event.waitUntil()` so the worker is not terminated mid-stream.
 */
import { SW_CHANNEL } from '@/core/protocol';
import type { SwRequest } from '@/core/protocol';
import { abortJob, handleStreamChat } from './jobs/llmStream';
import { swSelf } from './scope';

/**
 * Registers the service worker's `message` listener.
 * @returns {void}
 */
export function installRouter(): void {
    swSelf.addEventListener('message', (event: ExtendableMessageEvent) => {
        const request = event.data as SwRequest | undefined;
        if (!request || request.channel !== SW_CHANNEL) { return; }

        if (request.kind === 'abort') {
            abortJob(request.id);
            return;
        }

        if (request.kind === 'stream-chat') {
            const port = event.ports[0];
            if (!port) {
                console.warn('[sw] stream-chat request arrived without a response port');
                return;
            }
            event.waitUntil(handleStreamChat(request, port));
            return;
        }

        console.warn('[sw] Unhandled message kind:', (request as { kind: string }).kind);
    });
}
