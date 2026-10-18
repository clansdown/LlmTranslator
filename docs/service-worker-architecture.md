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
    debug.ts                  debug flags (page imports these via src/debug.ts)
  sw/                       worker-only (never imported by the page)
    index.ts                  entry: wires caching + router
    scope.ts                  typed handle to ServiceWorkerGlobalScope
    globals.d.ts              __SW_DEV__ / __SW_BUILD_ID__ declarations
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

The debug flags live in `core/debug.ts` so the worker can read them without
importing a page-root module; `src/debug.ts` re-exports them for page-only
consumers.

## Message protocol (`core/protocol.ts`)

All messages carry `channel: SW_CHANNEL` so the worker ignores unrelated
messages. Requests and responses are correlated by a per-request `id`.

- Page → worker: `SwStreamChatRequest` (`kind: 'stream-chat'`) and
  `SwAbortRequest` (`kind: 'abort'`).
- Worker → page: `SwStartedMessage`, `SwChunkMessage`, `SwDoneMessage`,
  `SwErrorMessage`.

`SwStartedMessage` is posted as soon as the worker begins a job, *before* any
network work. It lets the page tell "the worker never picked the request up"
apart from "the model has not produced output yet" — which is what makes a short
dispatch timeout possible.

Transport is a **per-request `MessageChannel`**: the page creates a channel,
transfers `port2` to the worker with the request, and receives responses on
`port1`. Cancellation is a separate `postMessage` on the worker itself (no port
needed), routed to the job registry in `sw/jobs/llmStream.ts`. The worker never
closes its end of the port, because `port.close()` discards queued-but-undelivered
messages and could drop the terminal one; the page closes `port1` instead.

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
Dispatch targets the same worker (`controller ?? registration.active`), so the
gate and the send never disagree about which worker is in charge.

## Failure handling

A stream must never leave the caller waiting forever. `requestStream`
(`swClient.ts`) watches every in-flight request and ends it with `onError` if:

- **the worker does not acknowledge within 10 s** (`SW_DISPATCH_TIMEOUT_MS`) —
  the request was lost before the worker picked it up;
- **no message arrives for 120 s** (`SW_INACTIVITY_TIMEOUT_MS`, restarted on
  every message) — the worker died mid-stream. Reasoning models emit reasoning
  chunks while they think, so a genuine silence this long means the worker is
  gone;
- **the worker becomes `redundant`** (`statechange`) — it was replaced by an
  update while the job was running;
- **a different worker takes control** (`controllerchange`) — same situation
  seen from the page side;
- the response cannot be deserialized (`onmessageerror`), or
  `postMessage` throws.

All terminal paths funnel through `failStream`/`completeStream`, which clear the
timers, detach the lifecycle listeners and close the port. `abort()` also tears
those down, and — like the local implementation — deliberately produces no
terminal callback.

## Caching

Caching is a normal service-worker duty here; the worker owns asset caching for
the whole app.

- **Namespaced names.** Caches are `translate-static-*` / `translate-dynamic-*`.
  The suite's apps share one origin, so Cache Storage is shared: `activate` only
  deletes caches whose name starts with `translate-` (plus the pre-namespacing
  `llm-translator-*` names, purged once). Other apps' caches are left alone.
- **Build-stamped version.** `CACHE_VERSION` comes from `__SW_BUILD_ID__`, which
  is generated fresh on every build. That makes each `sw.js` byte-different and
  gives each deploy a new cache name, so a deploy always re-installs and
  re-precaches instead of serving a stale app shell.
- **Reads are scoped.** `networkFirst` reads with `{ cacheName }` so it can never
  return a copy from a different cache; the offline shell fallback is pinned to
  the static cache.
- **Precache is best-effort.** A failed `cache.addAll` is logged, not thrown, so
  a flaky install cannot permanently block worker activation.

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
- Build-time defines: `__SW_DEV__` is `true` for the dev build and `false` for
  production; `__SW_BUILD_ID__` is a fresh identifier per build (see Caching).

### Dev vs production caching

In dev the worker still installs, activates and `clients.claim()`s the page — so
the streaming path is exercised — but it does **not** precache, does **not** purge
caches, and the `fetch` handler returns immediately, so nothing is ever read from
or written to Cache Storage. `clients.claim()` must keep running in dev;
without it the dev page would never be controlled and `isSwControlling()` would
stay false.

## Scope of the current implementation

- **Done:** worker build + registration, caching, protocol, and the streaming
  chat-completion job (used by translation, questions, and background updates).
  Streams are watched (dispatch/inactivity timeouts, worker-replacement
  detection) so a caller can never hang.
- **Not yet done:** moving cloud **uploads** into the worker (the page will mint
  the Clerk token and pass it to the worker), and persisting in-flight job state
  to OPFS so a page that was fully discarded can adopt a completed result on
  return.
