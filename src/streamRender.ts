/**
 * Stream Render Scheduler
 *
 * Frame-coalescing scheduler for streaming DOM updates.
 *
 * A chat model emits roughly one chunk per token, so streaming handlers are
 * invoked far more often than the browser can paint. Re-rendering on every
 * chunk wastes work on frames that are never shown and can saturate the main
 * thread, which makes a stream appear to arrive all at once instead of
 * progressively. That is especially visible now that the streaming request runs
 * in the service worker: the worker is not slowed down by the page's rendering,
 * so nothing paces the chunk rate on the page side.
 *
 * Callers register a render callback keyed by the stream it belongs to. Only the
 * most recent callback per key is kept, and at most one flush runs per frame.
 * Keys must be per-stream (not per-item), because several streams can be active
 * for the same translation at once (main translation, literal retranslation and
 * interpretation) and a shared key would let one stream drop another's render.
 *
 * When the tab is hidden no animation frames are produced, so a timer is used
 * instead. Streaming in a backgrounded tab is the whole point of the service
 * worker, so updates must not stop just because nothing is on screen.
 */

import { DEBUG_STREAM_RENDER } from './debug';

/** A callback that paints the latest accumulated state of one stream to the DOM. */
export type StreamRenderCallback = () => void;

/** Flush interval used while the tab is hidden and animation frames are suspended (ms). */
const STREAM_RENDER_HIDDEN_FALLBACK_MS: number = 100;

/** Latest pending render per stream key; a newer callback replaces the older one. */
const pendingStreamRenders: Map<object, StreamRenderCallback> = new Map();

/** Handle of the scheduled animation frame, or null when no frame is booked. */
let streamRenderFrameHandle: number | null = null;

/** Handle of the scheduled fallback timer, or null when no timer is armed. */
let streamRenderFallbackHandle: number | null = null;

/**
 * Reports whether the page is currently visible and therefore producing frames
 * @returns {boolean} True when animation frames will be delivered
 */
function isPageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * Runs every pending render and clears the scheduled flush.
 * @returns {void}
 */
function flushStreamRenders(): void {
    streamRenderFrameHandle = null;
    if (streamRenderFallbackHandle !== null) {
        window.clearTimeout(streamRenderFallbackHandle);
        streamRenderFallbackHandle = null;
    }

    // Swap the map out before running callbacks so a render that schedules
    // another render is booked for the next frame instead of being dropped.
    const renders = new Map<object, StreamRenderCallback>(pendingStreamRenders);
    pendingStreamRenders.clear();

    const startedAt = DEBUG_STREAM_RENDER ? performance.now() : 0;
    for (const render of renders.values()) {
        try {
            render();
        } catch (error) {
            console.error('[streamRender] Render callback failed:', error);
        }
    }
    if (DEBUG_STREAM_RENDER) {
        console.log(`[streamRender] Flushed ${renders.size} render(s) in ${(performance.now() - startedAt).toFixed(1)}ms`);
    }
}

/**
 * Books the single scheduled flush, using an animation frame when the page is
 * visible and a timer otherwise.
 * @returns {void}
 */
function armStreamRenderFlush(): void {
    if (streamRenderFrameHandle !== null || streamRenderFallbackHandle !== null) {
        return;
    }

    if (isPageVisible()) {
        streamRenderFrameHandle = window.requestAnimationFrame(flushStreamRenders);
    } else {
        streamRenderFallbackHandle = window.setTimeout(flushStreamRenders, STREAM_RENDER_HIDDEN_FALLBACK_MS);
    }
}

/**
 * Schedules a render for the next frame, replacing any render already pending
 * for the same stream key.
 * @param {object} key - Identity of the stream being rendered
 * @param {StreamRenderCallback} render - Callback that paints the stream's latest state
 * @returns {void}
 */
export function scheduleStreamRender(key: object, render: StreamRenderCallback): void {
    pendingStreamRenders.set(key, render);
    armStreamRenderFlush();
}

/**
 * Drops a pending render so a finished or aborted stream cannot paint after its
 * final content has been written.
 * @param {object} key - Stream key used when the render was scheduled
 * @returns {void}
 */
export function cancelStreamRender(key: object): void {
    pendingStreamRenders.delete(key);
}
