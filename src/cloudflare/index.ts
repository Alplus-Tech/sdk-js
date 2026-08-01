/**
 * `@alplus/sdk/cloudflare` -- Cloudflare Workers (workerd) entry point
 * (docs/sdk/01-sdk-spec.md section 1). v0.1.0 re-exports the
 * platform-neutral heartbeat transport verbatim; `alplusWrap` / Hono
 * `onError` middleware (section 6.3) ship with Observe in a later 0.x
 * release.
 */
export { heartbeat } from "../core/heartbeat";
export type { HeartbeatOptions } from "../core/heartbeat";
