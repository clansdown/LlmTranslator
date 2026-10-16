/**
 * Core types shared between the main thread and the service worker.
 *
 * Streaming API types are re-exported from the canonical definitions in
 * `src/types/api.ts` so there is a single source of truth. Service-worker
 * communication message types (request/response envelopes for the RPC layer)
 * will be added here in a later phase.
 */

export type {
    StreamUsage,
    StreamCallbacks,
    StreamingAbortHandle,
    StreamingDelta,
    StreamingReasoningTextDetail,
    StreamingReasoningSummaryDetail,
    StreamingReasoningEncryptedDetail,
    StreamingReasoningDetail,
    StreamingChoice,
    StreamingError,
    UsageObject,
    StreamingChatCompletionChunk
} from '@/types/api';
