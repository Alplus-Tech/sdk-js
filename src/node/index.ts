/**
 * `@postdeploy/sdk/node` -- Node.js >= 18 entry point. v0.3.0 adds automatic
 * `uncaughtException`/`unhandledRejection` capture (default on -- see
 * `./observe.ts`) and request-scoped scope/breadcrumbs via
 * `AsyncLocalStorage` (`setUser`/`setTag`/`setContext`/`addBreadcrumb`,
 * active only inside `withScope(fn)` -- see `./observe.ts`'s file comment
 * for why there is no ambient module-global scope here).
 */
export { init, close } from "./observe";
export { addBreadcrumb, setContext, setTag, setUser, withScope } from "./scope";
export { captureException, captureMessage, flush } from "../core/observe";
export type { ObserveInitOptions, CaptureExceptionOptions, CaptureMessageOptions, ErrorLevel, WireUser } from "../core/observe";
export type { BreadcrumbInput } from "../core/observe";
