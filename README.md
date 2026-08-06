# @alplus/sdk

Official instrumentation SDK for [Alplus](https://alplus.dev), the
Cloudflare-native dev toolkit built around three pillars — **Monitor**
(uptime and heartbeat checks), **Observe** (error tracking), and **Measure**
(product analytics) — on one platform, one dashboard, and one bill. This
package ships `heartbeat()` (Monitor), `init`/`captureException`/
`captureMessage`/`flush`/`close` (Observe), and `sendMeasureHit()` (Measure);
see [Roadmap](#roadmap) below for what's not here yet.

## Install

```sh
npm install @alplus/sdk
```

Zero runtime dependencies. Requires Node.js >= 18 for the `/node` entry
point; the `/cloudflare` and neutral (`.`) entry points work anywhere
`fetch` and `URL` are global (workerd, browsers, modern runtimes). A `/core`
entry point is also available if you want the smallest possible bundle and
don't need a platform-specific wrapper.

## Monitor: `heartbeat()`

`heartbeat(token, options?)` sends a ping to a **Heartbeat monitor** you've
created at [console.alplus.dev](https://console.alplus.dev). Heartbeat
monitors watch scheduled jobs — cron tasks, nightly batches, queue
workers — that are supposed to run on a schedule; Alplus alerts you when a
ping doesn't show up on time or reports failure. Every ping ultimately hits:

```
GET|POST https://ingest.alplus.dev/h/{token}
```

so the SDK is just a small, resilient, typed wrapper around a single HTTP
request — nothing you couldn't do with `curl`, which is the point: your job
doesn't need a network SDK at all if a shell one-liner already works.

### Quickstart

Create a Heartbeat monitor in the console first and copy its token (looks
like `hb_...`). Every example below pings that monitor.

#### Cloudflare Workers (Cron Triggers)

Use `ctx.waitUntil()` so the ping doesn't block (or get cancelled when) the
scheduled handler returns:

```ts
import { heartbeat } from "@alplus/sdk/cloudflare";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(heartbeat("hb_your_token", { state: "start" }));
    await runScheduledTask();
    ctx.waitUntil(heartbeat("hb_your_token", { state: "finish" }));
  },
};
```

#### Node.js (cron job or standalone script)

```ts
import { heartbeat } from "@alplus/sdk/node";

try {
  await runNightlyJob();
  await heartbeat("hb_your_token", { state: "finish" });
} catch (err) {
  await heartbeat("hb_your_token", {
    state: "fail",
    message: err instanceof Error ? err.message : String(err),
  });
}
```

Or skip the try/catch and use the process exit-code shortcut, which is
handy at the tail of a script:

```ts
process.on("exit", (code) => {
  void heartbeat("hb_your_token", { exitCode: code });
});
```

#### Plain shell / crontab (no SDK required)

Heartbeat monitors are just a URL, so anything that can run `curl` in a
crontab works without installing this package. The exit-code path form
(`/h/{token}/{exitCode}`) maps `0` to a finish ping and any other value
(`1`-`255`) to a fail ping — the same semantics as the SDK's `exitCode`
option:

```sh
# crontab -e
0 2 * * * /usr/local/bin/nightly-backup.sh; curl -fsS "https://ingest.alplus.dev/h/hb_your_token/$?" > /dev/null
```

### `heartbeat()` options reference

```ts
import { heartbeat } from "@alplus/sdk/node"; // or /cloudflare, /core, or "@alplus/sdk"

await heartbeat(token, options?);
```

| Option | Type | Default | Semantics |
| --- | --- | --- | --- |
| `state` | `"start" \| "finish" \| "fail"` | _(none — a plain ping)_ | `start` records the beginning of a run so the console can track its duration. `finish` closes it out as a success. `fail` **opens an incident immediately** on the monitor. Mutually exclusive with `exitCode`. |
| `exitCode` | `number` | _(none)_ | Shortcut for `state`: `0` maps to `finish`, any value `1`-`255` maps to `fail`. Mutually exclusive with `state`. |
| `message` | `string` | _(none)_ | Diagnostic text attached to `fail` pings, shown on the incident in the console. Silently truncated to 2048 characters. |
| `pingId` | `string` | a fresh generated id | Idempotency key, reused across retries of one call. |
| `baseUrl` | `string` | `https://ingest.alplus.dev` | Override the ingest origin. |
| `fetchImpl` | `typeof fetch` | the platform's global `fetch` | Inject a custom `fetch` implementation — primarily for unit tests. |
| `debug` | `boolean` | `false` | Log a `console.warn` when retries are exhausted or an internal error occurs. |

`heartbeat()` **never throws or rejects**, regardless of network failure or
an internal SDK bug — every ping is attempted up to 3 times total with
jittered exponential backoff, and failures are swallowed after retries are
exhausted (set `debug: true` to log them instead).

## Observe: error tracking

```ts
import { init, captureException, captureMessage, flush, close } from "@alplus/sdk/node"; // or ".", "/cloudflare", "/core"

init({ key: "alp_p_your_ingest_key", environment: "production", release: "1.4.2" });

try {
  riskyOperation();
} catch (err) {
  captureException(err, { context: { feature: "checkout" } });
}

captureMessage("payment webhook received an unexpected status", "warning");

// Before a short-lived script exits:
await flush(2000);
```

`init(options)` configures a single module-scope client (call it once per
process/isolate; calling it again reinitializes rather than throwing).
`key` must be a project API key with the `ingest` scope.

`captureException(error, options?)` accepts any thrown value — an `Error`,
a string, or anything else JavaScript allows you to `throw`. A non-`Error`
value is normalized into a synthetic error with the original value
preserved under `contexts.extra.non_error_value`. `options.context` is
merged into `contexts.extra`. Returns the client-generated `err_`-prefixed
event id synchronously, so you can surface it to a user ("reference id
`err_...`") even before the event is sent.

`captureMessage(message, level?)` records a non-exception event; `level`
defaults to `"info"` and must be one of `"fatal" | "error" | "warning" |
"info"`.

`flush(timeoutMs?)` (default 2000ms) forces an immediate send and resolves
`true` if it drained in time. `close(timeoutMs?)` flushes and then makes
further capture calls no-ops for the rest of the process.

Every capture/transport path is wrapped so **the SDK never throws into your
application** — a malformed capture, a network failure, or an internal bug
is caught, optionally logged via `debug: true`, and swallowed.

### Batching and per-platform flush behavior

Captured events are queued in memory and sent as a batch once any of these
is first true: 10 events queued, ~64 KB of estimated serialized size, or 5
seconds since the oldest queued event. Free-text fields (`message`,
exception `value`, stack traces, context objects) are capped at the same
boundary the server enforces, so an oversized payload is trimmed by the SDK
rather than discovered by a server rejection.

- **Browser** (`.`): the 5-second idle timer applies, plus a `pagehide`
  listener that best-effort flushes any remaining queue via
  `fetch(..., { keepalive: true })` when the page is closed or bfcache'd.
  (This uses `fetch` keepalive rather than `navigator.sendBeacon`, because
  `sendBeacon` cannot carry the `Authorization` header this endpoint
  requires.)
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
  import { init, captureException, flush } from "@alplus/sdk/cloudflare";

  const app = new Hono<{ Bindings: { ALPLUS_KEY: string } }>();
  app.use("*", async (c, next) => {
    init({ key: c.env.ALPLUS_KEY, environment: "production" });
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

No automatic instrumentation (`window.onerror`, `unhandledRejection`,
`uncaughtException`, a Cloudflare `wrapHandler`/Hono middleware), no
breadcrumbs, no `setUser`/`setTag`/`setContext`, no `sampleRate`, no
`tunnel` proxy option, no browser offline queue, and no source map upload
tooling. All manual — call `captureException`/`captureMessage` yourself
wherever you already catch or care about an error.

## Measure: `sendMeasureHit()`

```ts
import { sendMeasureHit } from "@alplus/sdk/node"; // or ".", "/cloudflare", "/core"

await sendMeasureHit({
  site: "proj_your_project_id",
  url: "https://shop.example.com/checkout/complete",
  type: "custom_event",
  name: "signup_completed",
});
```

This is a low-level, programmatic wrapper around `POST /m` for use
somewhere a `<script>` tag isn't an option — a server-rendered app, a
Cloudflare Worker, a batch replay. It is **not** a replacement for Alplus's
first-party browser tracker script; a real website should load that script
instead.

**Read this before calling it from Node or a Workers handler.** `POST /m`
has no API key: the only gate is the request's `Origin` header, checked
against your project's allowlisted domains. A real browser attaches that
header automatically on every POST and JavaScript cannot override it, which
is what makes it trustworthy as a control. `fetch` in Node.js and in a
Cloudflare Worker has no such page context, so a call built by this
function from those environments carries **no** `Origin` header, and the
server treats that as an automatic, silent reject. The response is always
`204 No Content` whether the hit was recorded or rejected, by design, so
there is nothing to inspect to tell the difference — calling this from a
plain Node script or an unrelated Workers handler will appear to succeed
while recording nothing, forever.

This function deliberately does **not** accept an `origin` override to work
around that. Fabricating an Origin value to get a server-side call past the
allowlist would defeat the one security control this endpoint has.

| Option | Type | Notes |
| --- | --- | --- |
| `site` | `string` | The project id (`proj_...`) — public, not secret. |
| `url` | `string` | Full page URL the hit is recorded for. |
| `referrer` | `string \| null` | Optional; omitted or `null` for a direct hit. |
| `type` | `"pageview" \| "custom_event"` | Defaults to `"pageview"`. |
| `name` | `string` | Required when `type` is `"custom_event"`. |
| `props` | `Record<string, unknown>` | Accepted for forward compatibility; the server discards it before rollup and never stores it. |
| `baseUrl` / `fetchImpl` / `debug` | — | Same as `heartbeat()`'s options above. |

There is no retry: unlike Observe, a hit carries no client-generated
idempotency id, so retrying risks double-counting a visit rather than
recovering a lost one. Never throws.

## Troubleshooting

- **Heartbeat returns 404** — the token is wrong, or the monitor has been
  deleted or paused in the console. Copy the token again from the
  monitor's detail page.
- **Pings/hits are fire-and-forget** — none of these functions return
  monitor state, issue status, or analytics numbers. Check the relevant
  page in the console.
- **Nothing shows up in the console** — confirm the process actually
  reaches the network (egress rules, offline dev environment, VPN) and
  that `baseUrl` wasn't overridden to point somewhere else. For Observe,
  confirm the key carries the `ingest` scope. For Measure, see the Origin
  caveat above — this is the single most common "it silently does
  nothing" cause.

## Roadmap

Not available in `@alplus/sdk@0.2.x` — no stub exports, no
reserved-but-throwing placeholders. If it isn't documented above, it
doesn't exist in this package yet:

- Automatic Observe instrumentation: `window.onerror`,
  `onunhandledrejection`, Node's `uncaughtException`/`unhandledRejection`
  hooks, and a Cloudflare `wrapHandler`/Hono `onError` middleware.
- Breadcrumbs, `setUser`, `setTag`, `setContext`, `sampleRate`, the
  `tunnel` proxy option, and a browser offline queue.
- Source map upload tooling (`alplus-cli sourcemaps upload`).
- An IIFE/UMD browser build for non-bundler `<script>` tag usage.
- **Ruby / Rails** — a native `alplus-ruby` gem is the planned integration
  path for Ruby and Rails apps (not this npm package, and not yet
  published).

## Versioning

This package is `0.x`: minor versions (`0.1` -> `0.2`) may introduce
breaking changes as new modules land, though `heartbeat()`, `init`,
`captureException`, `captureMessage`, `flush`, `close`, and
`sendMeasureHit()` documented here are expected to stay stable going
forward. Patch versions are always backwards compatible. See
[GitHub releases](https://github.com/alplus/sdk/releases) for the
changelog.

## License

MIT — see [LICENSE](./LICENSE).
