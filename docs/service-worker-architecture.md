# Service Worker Architecture

The app offloads long-running network work to a **service worker** so it keeps
running when the page is backgrounded or frozen — for example when a phone user
switches apps during a translation. This document describes the layers, the
message protocol, and how the worker is built.

## Why a service worker (and not a Web Worker)

Web Workers share the page's lifecycle, so they freeze when the tab is
backgrounded. Only a service worker runs independently of the page. A service
worker `message` event is an `ExtendableMessageEvent`, so calling
`event.waitUntil(promise)` keeps the worker alive until the promise settles —
which is what lets a long streaming request finish in the background.

Caveat: this is **best-effort**. Chromium keeps the worker alive during the
in-flight request; iOS Safari may still suspend it. When the worker cannot
finish, the page falls back to (or later resumes from) persisted state. There
is no reliable background execution on iOS regardless of architecture.

## Layers and ownership

```
src/
  core/                     shared, DOM-free, runs in BOTH page and worker
    types.ts                  streaming API types (re-exported from types/api)
    protocol.ts               worker/page message contracts
    openrouter.ts             streaming fetch + parseTag
    translation.ts            pure text helpers
  sw/                       worker-only (never imported by the page)
    index.ts                  entry: wires caching + router
    scope.ts                  typed handle to ServiceWorkerGlobalScope
    globals.d.ts              __SW_DEV__ declaration
    cache.ts                  asset caching
    router.ts                 message dispatch
    jobs/llmStream.ts         streaming chat-completion job
  swClient.ts               page-only client for talking to the worker
```

Import rules, enforced by `tsconfig.json` / `tsconfig.sw.json`:

- **`core/`** may import only from `core/` and `types/`. It must stay DOM-free so
  the worker can import it.
- **`sw/`** may import from `core/` and `sw/` only. `sw/` is compiled with the
  `WebWorker` lib and is excluded from the DOM project.
- **`swClient.ts`** (page-only) may import from `core/protocol.ts` and
  `core/types.ts` only, never from `sw/`.

## Message protocol (`core/protocol.ts`)

All messages carry `channel: SW_CHANNEL` so the worker ignores unrelated
messages. Requests and responses are correlated by a per-request `id`.

- Page → worker: `SwStreamChatRequest` (`kind: 'stream-chat'`) and
  `SwAbortRequest` (`kind: 'abort'`).
- Worker → page: `SwChunkMessage`, `SwDoneMessage`, `SwErrorMessage`.

Transport is a **per-request `MessageChannel`**: the page creates a channel,
transfers `port2` to the worker with the request, and receives responses on
`port1`. Cancellation is a separate `postMessage` on the worker itself (no port
needed), routed to the job registry in `sw/jobs/llmStream.ts`.

## Request flow

1. `src/openrouter.ts` wrappers call `isSwControlling()`.
   - **Controlling:** `requestStream(...)` (`swClient.ts`) sends the request to
     the worker. The worker runs the stream under `event.waitUntil()` and posts
     chunks back over the port.
   - **Not controlling:** the wrapper calls the local `core/openrouter.ts`
     implementation directly, so behaviour is unchanged before the worker is
     active (or on browsers without service workers).
2. Prompts are built on the page; the worker receives a fully-formed request
   (`apiKey`, `userMessage`, `systemPrompt`, `model`, `reasoningLevel`,
   `temperature`, `maxTokens`) and needs no OPFS or settings access.

The gate is deliberately `navigator.serviceWorker.controller` (not just feature
detection) so a request never hangs waiting for `navigator.serviceWorker.ready`.

## Build

- **Production:** `vite build` builds the page, then
  `vite build --config vite.sw.config.ts` emits a self-contained classic (IIFE)
  `dist/sw.js`. `emptyOutDir` is disabled on the second build so the page build
  is preserved.
- **Development:** `build/serviceWorkerDevPlugin.ts` bundles the same
  configuration (`build/swBuildConfig.ts`) into `.dev-sw/` and serves it at
  `/sw.js`, rebuilding when `src/sw/**` or `src/core/**` changes.
- The worker is served at the **application root** (`/translate/sw.js`) so its
  default scope covers the whole app. An assets-directory URL would scope it to
  `/translate/assets/` and it would never see app navigations.
- `__SW_DEV__` is injected at build time: `true` for the dev build (caching
  disabled so transformed modules are never cached), `false` for production.

## Scope of the current implementation

- **Done:** worker build + registration, caching, protocol, and the streaming
  chat-completion job (used by translation, questions, and background updates).
- **Not yet done:** moving cloud **uploads** into the worker (the page will mint
  the Clerk token and pass it to the worker), and persisting in-flight job state
  to OPFS so a page that was fully discarded can adopt a completed result on
  return.
