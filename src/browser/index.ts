/**
 * `@alplus/sdk` (unqualified package root) -- browser/neutral entry point
 * (docs/sdk/01-sdk-spec.md section 1). v0.1.0 re-exports the
 * platform-neutral heartbeat transport verbatim; automatic
 * window.onerror/onunhandledrejection instrumentation (section 6.1) ships
 * with Observe in a later 0.x release. There is no IIFE/UMD build in
 * v0.1.0 (heartbeat is a server/CLI-side primitive, not a script-tag
 * feature); that ships alongside the browser Observe bundle.
 */
export { heartbeat } from "../core/heartbeat";
export type { HeartbeatOptions } from "../core/heartbeat";
