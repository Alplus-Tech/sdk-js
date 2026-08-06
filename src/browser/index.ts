/**
 * `@alplus/sdk` (unqualified package root) -- browser/neutral entry point.
 * v0.2.0 adds Observe (`init`/`captureException`/`captureMessage`/`flush`/
 * `close`, with a `pagehide`-triggered best-effort unload flush, see
 * `./observe.ts`) and the platform-neutral Measure hit helper. Automatic
 * `window.onerror`/`onunhandledrejection` instrumentation and breadcrumbs
 * are not implemented in this release; see this package's README for the
 * full list of what v0.2.x does and does not ship. There is no IIFE/UMD
 * build yet -- that ships alongside automatic instrumentation.
 */
export { heartbeat } from "../core/heartbeat";
export type { HeartbeatOptions } from "../core/heartbeat";

export { init } from "./observe";
export { captureException, captureMessage, flush, close } from "../core/observe";
export type { ObserveInitOptions, CaptureExceptionOptions, ErrorLevel } from "../core/observe";

export { sendMeasureHit } from "../core/measure";
export type { MeasureHitOptions } from "../core/measure";
