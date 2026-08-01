/**
 * `@alplus/sdk/node` -- Node.js >= 18 entry point (docs/sdk/01-sdk-spec.md
 * section 1). v0.1.0 re-exports the platform-neutral heartbeat transport
 * verbatim; Node-specific automatic instrumentation (uncaughtException /
 * unhandledRejection hooks, section 6.2) ships with Observe in a later
 * 0.x release.
 */
export { heartbeat } from "../core/heartbeat";
export type { HeartbeatOptions } from "../core/heartbeat";
