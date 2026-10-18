# @postdeploy/sdk

Official error-tracking SDK for [PostDeploy](https://postdeploy.dev). This
package ships `init`/`captureException`/`captureMessage`/`flush`/`close`,
automatic global error capture, breadcrumbs, and scope
(`setUser`/`setTag`/`setContext`). See [Roadmap](#roadmap) below for what's
not here yet.

Setup guide: [JavaScript error tracking](https://postdeploy.dev/docs/observe/javascript).

## Install

```sh
npm install @postdeploy/sdk
```

Zero runtime dependencies. Requires Node.js >= 18 for the `/node` entry
point; the `/cloudflare` and neutral (`.`) entry points work anywhere
`fetch` and `URL` are global (workerd, browsers, modern runtimes). Do not
import `./core`. That entry is adapter-internal.

## Observe: error tracking

```ts
import { init, captureException, captureMessage, flush, close } from "@postdeploy/sdk/node"; // or "." or "/cloudflare"

init({ key: "alp_p_your_ingest_key", environment: "production", release: "1.4.2" });
// That's it -- uncaught exceptions and unhandled rejections are captured
// automatically from here on (browser and Node; see below for Cloudflare).

try {
  riskyOperation();
} catch (err) {
  captureException(err, { context: { feature: "checkout" } });
}

captureMessage("payment webhook received an unexpected status", "warning");

// Before a short-lived script exits:
await flush(2000);
```

`init(options)` configures one module-scope client. Repeated calls update the
active client without discarding pending, queued, or in-flight events.
Calling `init` after `close` starts a new active client. `key` must be a
project API key with the `ingest` scope. `captureUnhandled` (default `true` on
browser/Node) controls automatic capture — see below.

`captureException(error, options?)` accepts any thrown value — an `Error`,
a string, or anything else JavaScript allows you to `throw`. A non-`Error`
value is normalized into a synthetic error with the original value
preserved under `contexts.extra.non_error_value`. `options.context` is
merged into `contexts.extra`; `options.user`/`.tags`/`.contexts`/
`.breadcrumbs` are per-capture scope overrides (see
[Scope](#scope-setuser-settag-setcontext) below), and `options.mechanism`
overrides the default `"generic"` (the automatic capture paths set their
own). Returns the client-generated `err_`-prefixed event id synchronously,
so you can surface it to a user ("reference id `err_...`") even before the
event is sent. The same error object captured twice within ~2 seconds (for
example by both the automatic handler and a manual call) is deduplicated to
one event and returns the same id both times.

`captureMessage(message, level?, options?)` records a non-exception event;
`level` defaults to `"info"` and must be one of `"fatal" | "error" |
"warning" | "info"`. `options` accepts the same scope overrides as
`captureException`.

`flush(timeoutMs?)` (default 2000ms) forces an immediate send and resolves
`true` if it drained in time. `close(timeoutMs?)` detaches automatic capture,
breadcrumb instrumentation, and the browser `pagehide` callback. It flushes
the closing client and rejects further captures until the next `init`.

Every capture/transport path is wrapped so **the SDK never throws into your
application** — a malformed capture, a network failure, or an internal bug
is caught, optionally logged via `debug: true`, and swallowed. Automatic
capture never changes your program's own behavior either: the browser still
logs an uncaught error to the console exactly as it would with no SDK
installed, and a wrapped Cloudflare handler still re-throws so the Worker's
own error response still happens.

### Automatic global error capture

Installing the SDK captures errors by default — opt out with
`captureUnhandled: false`, not opt in.

- **Browser** (`.`): `window.addEventListener("error"
  /"unhandledrejection")`, attached on `init`, detached on `close()`.
- **Node** (`/node`): `process.on("uncaughtException"/"unhandledRejection")`.
  `uncaughtException` captures, flushes (bounded to ~2s so a slow ingest
  endpoint can't hang shutdown), and then calls `process.exit(1)` itself —
  Node suppresses its own default crash-and-exit behavior the instant any
  listener is attached, so this is the only way to reproduce it, not an
  SDK choice to be more aggressive than Node's default. `unhandledRejection`
  captures and flushes but deliberately does **not** exit the process, since
  Node's own default there is configurable (`--unhandled-rejections`) and
  forcing an exit would change the behavior of an app that set it to
  `warn`/`none` on purpose.
- **Cloudflare** (`/cloudflare`): no process-global hooks exist in workerd,
  so there is no `captureUnhandled` flag to flip here. Wrap your handler(s)
  instead:

  ```ts
  import { init, wrapHandler, wrapScheduled } from "@postdeploy/sdk/cloudflare";

  export default {
    fetch: wrapHandler(async (request, env, ctx) => {
      init({ key: env.POSTDEPLOY_API_KEY, environment: "production" });
      // application code; a thrown error is captured, flushed via
      // ctx.waitUntil, and re-thrown -- the Worker's own error response
      // still happens exactly as it would with no SDK installed.
      return handleRequest(request);
    }),
    scheduled: wrapScheduled(async (controller, env, ctx) => {
      init({ key: env.POSTDEPLOY_API_KEY, environment: "production" });
      await runScheduledTask();
    }),
  };
  ```

Every captured event — automatic or manual — carries `mechanism`:
`"onerror"`, `"onunhandledrejection"`, `"uncaughtException"`,
`"unhandledRejection"`, `"instrumentation"` (Cloudflare's wrappers), or
`"generic"` (a direct `captureException`/`captureMessage` call).

### Breadcrumbs

```ts
import { addBreadcrumb } from "@postdeploy/sdk"; // or "/node"

addBreadcrumb({ category: "checkout", message: "clicked pay", level: "info" });
```

A ring buffer (default 30 entries, `maxBreadcrumbs` on `init`) attached to
every subsequent captured event, giving a trail of what led up to it. Never
records input values or request/response bodies, and strips query strings
from URLs by default — and `data` on any breadcrumb (manual or automatic) is
scrubbed of `password`/`secret`/`token`/`api_key`-shaped keys the same way
`context`/`setContext` payloads are.

- **Browser** (`.`): automatic, on by default — navigation
  (`pushState`/`replaceState`/`popstate`), delegated clicks (a CSS selector
  only, e.g. `button#submit.btn-primary`, **never** element text), patched
  `console.log`/`.warn`/`.error`, and patched `fetch` (method, URL with the
  query string stripped, status, duration). Every patch is reversible on
  `close()`, composes with a `fetch` your own code already patched (wraps
  whatever `fetch` currently is, not a reference saved at import time), and
  a breadcrumb-recording failure never affects the underlying call.
- **Node** (`/node`): manual `addBreadcrumb` only, scoped the same way
  `setUser`/etc are — see [Scope](#scope-setuser-settag-setcontext). No
  automatic `fetch` breadcrumbs yet (a global `fetch` patch writing
  anywhere other than a request-scoped buffer would reintroduce the same
  cross-request attribution bug scope avoids).
- **Cloudflare** (`/cloudflare`): no ambient breadcrumb buffer at all — pass
  `breadcrumbs: [...]` directly in `captureException`/`captureMessage`'s
  options for a one-off capture.

### Scope: `setUser`/`setTag`/`setContext`

```ts
import { setUser, setTag, setContext } from "@postdeploy/sdk"; // or "/node"

setUser({ id: "user_123", email: "jane@example.com" }); // or null to clear
setTag("plan", "agency");
setContext("cart", { items: 3 });
```

Merged into every subsequent captured event until changed or cleared.
**How this is scoped differs sharply by platform, and the difference is
deliberate** — a naive module-global `setUser` is safe in a browser tab (one
user, no concurrent requests) and a real bug on a server (request A's
`setUser` would still be set during request B the instant they overlap):

- **Browser** (`.`): a single module-global scope. Correct here.
- **Node** (`/node`): backed by `AsyncLocalStorage`, active **only** inside
  `withScope(fn)`:

  ```ts
  import { withScope, setUser, captureException } from "@postdeploy/sdk/node";

  async function handleRequest(req: Request) {
    return withScope(async () => {
      setUser({ id: req.userId });
      try {
        return await process(req);
      } catch (err) {
        captureException(err); // attributed to req.userId, not some other
        // concurrent request's user
        throw err;
      }
    });
  }
  ```

  Calling `setUser`/`setTag`/`setContext`/`addBreadcrumb` **outside** an
  active `withScope` is a no-op (logged in debug mode) — never a
  module-global write. A single-threaded script can wrap once around its
  whole body; a request-handling server should wrap per request.
- **Cloudflare** (`/cloudflare`): no ambient scope API at all — a Workers
  isolate can serve concurrent requests, and this package cannot assume the
  `nodejs_compat` flag `AsyncLocalStorage` needs there. Pass
  `user`/`tags`/`contexts` directly in `captureException`/
  `captureMessage`'s options instead; this is always safe regardless of
  isolate concurrency, and it works as an escape hatch on every platform,
  where an explicit per-capture value overrides the ambient one.

### Batching and per-platform flush behavior

Captured events are queued in memory and sent as a batch once any of these
is first true: 10 events queued, ~64 KB of estimated serialized size, or 5
seconds since the oldest queued event. Free-text fields (`message`,
exception `value`, stack traces, context objects) are capped at the same
boundary the server enforces, so an oversized payload is trimmed by the SDK
rather than discovered by a server rejection.

- **Browser** (`.`): the 5-second idle timer applies, plus one `pagehide`
  listener that best-effort flushes any remaining queue via
  `fetch(..., { keepalive: true })` when the page is closed or bfcache'd.
  `close` removes that exact callback, so a close/reinit cycle leaves one
  current handler. (This uses `fetch` keepalive rather than
  `navigator.sendBeacon`, because `sendBeacon` cannot carry the
  `Authorization` header this endpoint requires.)
- **Node** (`/node`): the 5-second idle timer applies, and is `unref()`'d so
  it never keeps a short-lived script running on its own — call `flush()` or
  `close()` before your script exits, or a queued batch waiting on the timer
  can be lost.
- **Cloudflare Workers** (`/cloudflare`): the idle timer is always disabled
  (a Workers isolate can be evicted between requests, so a background timer
  is not a reliable flush mechanism there). Call `ctx.waitUntil(flush())` at
  the end of every request that captured something:

  ```ts
  import { Hono } from "hono";
  import { init, captureException, flush } from "@postdeploy/sdk/cloudflare";

  const app = new Hono<{ Bindings: { POSTDEPLOY_API_KEY: string } }>();
  app.use("*", async (c, next) => {
    init({ key: c.env.POSTDEPLOY_API_KEY, environment: "production" });
    await next();
  });
  app.onError((err, c) => {
    captureException(err, { context: { path: c.req.path } });
    c.executionCtx.waitUntil(flush());
    return c.text("Internal Server Error", 500);
  });
  ```

  The 10-event/64KB thresholds still trigger an immediate flush regardless
  of platform.

### What Observe does not do yet

No `sampleRate`/`beforeSend`, no `tunnel` proxy option, no browser offline
queue, no `XMLHttpRequest` breadcrumbs, no automatic Node/Cloudflare `fetch`
breadcrumbs (manual `addBreadcrumb` covers Node; Cloudflare has no ambient
breadcrumb buffer at all — pass `breadcrumbs` explicitly per capture), no
framework helpers (Hono/Express/React), and no source map upload tooling.
See [Roadmap](#roadmap).

## Troubleshooting

- **Captures are fire-and-forget** — no function returns issue status.
  Check the console.
- **Nothing shows up in the console** — confirm the process actually
  reaches the network (egress rules, offline dev environment, VPN) and
  that `baseUrl` wasn't overridden to point somewhere else. Confirm the
  key carries the `ingest` scope.

## Roadmap

Not available in `@postdeploy/sdk@0.6.x` — no stub exports, no
reserved-but-throwing placeholders. If it isn't documented above, it
doesn't exist in this package yet:

- `beforeSend`, `sampleRate`, and the `tunnel` proxy option.
- Framework helpers: `@postdeploy/sdk/hono`, `/express`, `/react`.
- Automatic outbound-`fetch` breadcrumbs on Node/Cloudflare, and any ambient
  breadcrumb/scope API on Cloudflare at all (pass `breadcrumbs`/`user`/
  `tags`/`contexts` explicitly per capture there instead).
- `XMLHttpRequest` breadcrumbs (browser `fetch` breadcrumbs ship; XHR does
  not).
- A browser offline queue.
- Source map upload tooling (`postdeploy-cli sourcemaps upload`).
- An IIFE/UMD browser build for non-bundler `<script>` tag usage.
- **`./core`** is not a host import. Use `.`, `./node`, or `./cloudflare`.
- **Ruby / Rails** — `postdeploy` is the first-party gem. It is not this
  npm package.

## Versioning

This package is `0.x`: minor versions may introduce breaking changes.
0.6.0 removes `heartbeat()` and `sendMeasureHit()`, because the PostDeploy
server no longer serves heartbeat or Measure endpoints. Patch versions are
always backwards compatible. See
[GitHub releases](https://github.com/Alplus-Tech/sdk-js/releases) for the
changelog.

## License

MIT — see [LICENSE](./LICENSE).
