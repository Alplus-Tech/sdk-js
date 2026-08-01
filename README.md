# @alplus/sdk

Official instrumentation SDK for [Alplus](https://alplus.dev), the
Cloudflare-native dev toolkit built around three pillars — **Monitor**
(uptime and heartbeat checks), **Observe** (error tracking), and **Measure**
(product analytics) — on one platform, one dashboard, and one bill. This
package currently ships the **Monitor** pillar's `heartbeat()` function; see
[Roadmap](#roadmap) below for what's not here yet.

## Install

```sh
npm install @alplus/sdk
```

Zero runtime dependencies. Requires Node.js >= 18 for the `/node` entry
point; the `/cloudflare` and neutral (`.`) entry points work anywhere
`fetch` and `URL` are global (workerd, browsers, modern runtimes). A `/core`
entry point is also available if you want the smallest possible bundle and
don't need a platform-specific wrapper.

## What this SDK does

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

## Quickstart

Create a Heartbeat monitor in the console first and copy its token (looks
like `hb_...`). Every example below pings that monitor.

### Cloudflare Workers (Cron Triggers)

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

### Node.js (cron job or standalone script)

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

### Plain shell / crontab (no SDK required)

Heartbeat monitors are just a URL, so anything that can run `curl` in a
crontab works without installing this package. The exit-code path form
(`/h/{token}/{exitCode}`) maps `0` to a finish ping and any other value
(`1`-`255`) to a fail ping — the same semantics as the SDK's `exitCode`
option:

```sh
# crontab -e
0 2 * * * /usr/local/bin/nightly-backup.sh; curl -fsS "https://ingest.alplus.dev/h/hb_your_token/$?" > /dev/null
```

The `trap` form reports success or failure of an entire script, including
crashes and signals, not just its final command:

```sh
#!/usr/bin/env bash
set -e
trap 'curl -fsS "https://ingest.alplus.dev/h/hb_your_token/$?" > /dev/null' EXIT

run_nightly_backup
```

### GitHub Actions

```yaml
jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - run: ./scripts/nightly-job.sh
      - if: always()
        run: |
          curl -fsS "https://ingest.alplus.dev/h/hb_your_token/${{ job.status == 'success' && '0' || '1' }}" > /dev/null
```

All four SDK entry points (`.`, `./node`, `./cloudflare`, `./core`) export
the identical `heartbeat` function and `HeartbeatOptions` type; pick
whichever subpath matches your platform for the smallest, most idiomatic
build output.

## `heartbeat()` options reference

```ts
import { heartbeat } from "@alplus/sdk/node"; // or /cloudflare, /core, or "@alplus/sdk"

await heartbeat(token, options?);
```

| Option | Type | Default | Semantics |
| --- | --- | --- | --- |
| `state` | `"start" \| "finish" \| "fail"` | _(none — a plain ping)_ | `start` records the beginning of a run so the console can track its duration. `finish` closes it out as a success. `fail` **opens an incident immediately** on the monitor (heartbeat failures don't wait for a second consecutive miss, unlike passive HTTP/keyword checks). Mutually exclusive with `exitCode`. |
| `exitCode` | `number` | _(none)_ | Shortcut for `state`: `0` maps to `finish`, any value `1`-`255` maps to `fail`. Mutually exclusive with `state`. Mirrors the `/h/{token}/{exitCode}` URL form used by shell scripts. |
| `message` | `string` | _(none)_ | Diagnostic text attached to `fail` pings (e.g. an error message or stderr tail) — shown on the incident in the console. Silently truncated to 2048 characters. |
| `pingId` | `string` | a fresh generated id | Idempotency key. The same id is reused across all retry attempts of one `heartbeat()` call so the ingest endpoint can dedupe retried pings of the same logical event. Supply your own if you need to correlate a ping with an external run id. |
| `baseUrl` | `string` | `https://ingest.alplus.dev` | Override the ingest origin. Mainly useful for testing against a local or self-hosted ingest endpoint. |
| `fetchImpl` | `typeof fetch` | the platform's global `fetch` | Inject a custom `fetch` implementation — primarily for unit tests. |
| `debug` | `boolean` | `false` | Log a `console.warn` when all retry attempts are exhausted or an internal error occurs, instead of failing silently. Useful in local development; most production deployments leave this off. |

Omitting both `state` and `exitCode` sends a plain "I'm alive" ping without
opening or closing a run — useful for simple liveness pings on a fixed
interval that don't track start/finish duration.

### Retry and never-throw guarantees

- Every ping is attempted up to **3 times total**, with jittered
  exponential backoff between attempts (base 500ms, doubling, +/-50%
  jitter).
- `heartbeat()` **never throws or rejects**, regardless of network failure,
  an unreachable host, or an internal SDK bug — it's designed to be safe to
  call from a cron handler or request path without a surrounding
  try/catch. Failures are simply swallowed after all retries are
  exhausted (set `debug: true` to log them instead).

## Configuring the monitor's schedule

The ping schedule itself — when Alplus expects to hear from you, and how
late is "late" — is configured on the monitor in the console, not in SDK
code:

- **Interval schedules** expect a ping at least once every _N_ minutes
  (e.g. "every 5 minutes"). Good for continuously running workers or
  polling loops.
- **Cron schedules** expect a ping according to a cron expression
  (`0 2 * * *`) evaluated in a **timezone** you choose per monitor — set
  this to match wherever your job's own cron actually fires, so alerts
  line up with when the job was really supposed to run.
- **Grace period** is extra time added after the expected ping time before
  Alplus treats a miss as overdue and opens an incident. Use it to absorb
  normal run-time variance (a backup that usually takes 5-10 minutes
  shouldn't page you at minute 6).

None of this is passed through `heartbeat()` — the SDK only sends the
ping; the monitor you configured in the console decides whether that ping
was on time.

## Troubleshooting

- **Ping returns 404** — the token is wrong, or the monitor has been
  deleted or paused in the console. Copy the token again from the
  monitor's detail page.
- **Pings are fire-and-forget** — `heartbeat()` (and the raw `curl`
  equivalent) don't return monitor state, alert status, or anything about
  whether the ping was "on time." Check the monitor's page in the console
  for uptime history and incidents.
- **Nothing shows up in the console** — confirm the job actually reaches
  the network (egress rules, offline dev environment, VPN) and that
  `baseUrl` wasn't overridden to point somewhere else.

## Roadmap

Not available in `@alplus/sdk@0.1.x` — no stub exports, no
reserved-but-throwing placeholders. If it isn't documented above, it
doesn't exist in this package yet:

- **Observe** (error tracking / exception capture) — planned as a later
  `0.x` minor release.
- **Measure** (custom event / product analytics tracking) — planned as a
  later `0.x` minor release.
- **Ruby / Rails** — a native `alplus-ruby` gem is the planned integration
  path for Ruby and Rails apps (not this npm package, and not yet
  published).

## Versioning

This package is `0.x`: minor versions (`0.1` -> `0.2`) may introduce
breaking changes as Observe and Measure land, though the existing
`heartbeat()` surface documented here is expected to stay stable. Patch
versions (`0.1.0` -> `0.1.1`) are always backwards compatible. See
[GitHub releases](https://github.com/alplus/sdk/releases) for the
changelog.

## License

MIT — see [LICENSE](./LICENSE).
