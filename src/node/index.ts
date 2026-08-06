/**
 * `@alplus/sdk/node` -- Node.js >= 18 entry point. v0.2.0 adds Observe
 * (`init`/`captureException`/`captureMessage`/`flush`/`close`, using the
 * core client's default 5-second idle-flush timer, `unref`'d so it never
 * keeps a short-lived script alive -- see `../core/observe/client.ts`) and
 * the Measure hit helper. Automatic `uncaughtException`/`unhandledRejection`
 * hooks are not implemented in this release; see this package's README for
 * the full list of what v0.2.x does and does not ship.
 */
export { heartbeat } from "../core/heartbeat";
export type { HeartbeatOptions } from "../core/heartbeat";

export { init, captureException, captureMessage, flush, close } from "../core/observe";
export type { ObserveInitOptions, CaptureExceptionOptions, ErrorLevel } from "../core/observe";

export { sendMeasureHit } from "../core/measure";
export type { MeasureHitOptions } from "../core/measure";
