/**
 * `@alplus/sdk/cloudflare` -- Cloudflare Workers (workerd) entry point.
 * v0.2.0 adds Observe and the Measure hit helper. `alplusWrap`/Hono
 * `onError` automatic-capture middleware is not implemented in this
 * release; see this package's README for the full list of what v0.2.x does
 * and does not ship.
 */
import { init as coreInit, type ObserveInitOptions } from "../core/observe";

export { heartbeat } from "../core/heartbeat";
export type { HeartbeatOptions } from "../core/heartbeat";

export { captureException, captureMessage, flush, close } from "../core/observe";
export type { ObserveInitOptions, CaptureExceptionOptions, ErrorLevel } from "../core/observe";

export { sendMeasureHit } from "../core/measure";
export type { MeasureHitOptions } from "../core/measure";

/**
 * Same as the core client's `init`, except the background idle-flush timer
 * is always disabled (`autoFlushIntervalMs: 0`), overriding any value the
 * caller passes. A Workers isolate can be evicted between requests at any
 * time, so a `setTimeout` scheduled during one request is not guaranteed to
 * ever fire -- call `ctx.waitUntil(flush())` at the end of every request
 * that captured something instead of relying on a background timer.
 */
export function init(options: ObserveInitOptions): void {
  coreInit({ ...options, autoFlushIntervalMs: 0 });
}
