/**
 * Browser-specific `init`: same as the core client, plus a `pagehide`
 * listener that best-effort flushes any queued events before the page is
 * torn down or bfcache'd.
 *
 * The SDK spec's transport section describes `navigator.sendBeacon` as the
 * primary unload-time transport, with `fetch(..., { keepalive: true })` as
 * the fallback. This adapter deliberately inverts that: `sendBeacon` cannot
 * carry an `Authorization` header (it has no header API at all), and
 * `POST /e/errors` authenticates exclusively via that header -- the
 * envelope's own redundant `header.key` field is validated only as a
 * cross-check against an Authorization header that already authenticated,
 * never accepted as a substitute for one. A beacon send to this route would
 * therefore always be rejected as unauthenticated. `fetch` with
 * `keepalive: true` supports custom headers and survives a page unload the
 * same way `sendBeacon` does, so it is used as the only unload-time
 * transport here, not merely the fallback.
 */
import { init as coreInit, buildKeepaliveFlushRequest, type ObserveInitOptions } from "../core/observe";

let pagehideListenerRegistered = false;

function registerPagehideFlush(debug: boolean): void {
  if (pagehideListenerRegistered) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  pagehideListenerRegistered = true;

  window.addEventListener("pagehide", () => {
    const request = buildKeepaliveFlushRequest();
    if (request === null) return;
    const fetchImpl = globalThis.fetch;
    if (typeof fetchImpl !== "function") return;
    fetchImpl(request.url, { method: "POST", headers: request.headers, body: request.body, keepalive: true }).catch((err: unknown) => {
      if (debug) console.warn("[@alplus/sdk] observe: pagehide flush failed", err);
    });
  });
}

/** Initializes the Observe client and arms the `pagehide` unload flush described above. */
export function init(options: ObserveInitOptions): void {
  coreInit(options);
  registerPagehideFlush(options.debug ?? false);
}

/** Test-only: not re-exported from `./index.ts`, so it never reaches a published bundle. */
export function __resetForTests(): void {
  pagehideListenerRegistered = false;
}
