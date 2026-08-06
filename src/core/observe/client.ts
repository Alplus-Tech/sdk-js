/**
 * @alplus/sdk Observe client: `init`, `captureException`, `captureMessage`,
 * `flush`, `close`. Platform-neutral -- `./browser`, `./node`, and
 * `./cloudflare` re-export this verbatim except for how each schedules (or
 * deliberately doesn't schedule) the idle-flush timer, since Workers
 * isolates, long-lived Node processes, and browser tabs have very different
 * lifetimes.
 *
 * State is a single module-level singleton, matching `heartbeat.ts`'s
 * platform-neutral design and the SDK spec's "a module-scope `init()` call
 * is correct and recommended" guidance -- one client per process/isolate,
 * calling `init` again reinitializes it rather than creating a second one.
 */

import { generateEventId } from "../id";
import { SDK_NAME, SDK_VERSION } from "../version";
import {
  BATCH_FLUSH_MS,
  BATCH_MAX_BYTES,
  BATCH_MAX_ITEMS,
  MAX_CONTEXT_CHARS,
  MAX_ENVELOPE_BYTES,
  MAX_EXCEPTION_VALUE_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_STACK_TRACE_CHARS,
  capContext,
  capFrames,
  capText,
  type ErrorLevel,
  type WireErrorItem,
} from "./envelope";
import { parseStack } from "./stack";
import { delay, postJsonWithRetries } from "./transport";

const DEFAULT_BASE_URL = "https://ingest.alplus.dev";
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

export interface ObserveInitOptions {
  /** Project API key, e.g. `"alp_p_..."`. Must carry the `ingest` scope. Required. */
  key: string;
  /** Logical deploy environment. Defaults to `"production"`. */
  environment?: string;
  /** Release identifier (git SHA, semver tag) attached to every captured event. */
  release?: string;
  /** Override the ingest origin. Defaults to `https://ingest.alplus.dev`. Mainly for testing against a local/self-hosted ingest endpoint. */
  baseUrl?: string;
  /** Injectable `fetch` implementation, primarily for tests. Defaults to the platform global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Enables `console.warn` diagnostics for dropped events and transport failures. Default `false`. */
  debug?: boolean;
  /**
   * Idle-queue flush interval in ms: once the oldest queued event has waited
   * this long, the queue is flushed even if it hasn't hit the item/byte
   * threshold. Set to `0` to disable the background timer entirely -- what
   * the `/cloudflare` adapter's `init` always does, since a Workers isolate
   * can be evicted between requests and a `setTimeout` that outlives the
   * request it was scheduled in is not a reliable flush mechanism there.
   * Default `5000`.
   */
  autoFlushIntervalMs?: number;
}

export interface CaptureExceptionOptions {
  /** Arbitrary structured data local to this one capture, merged into the event's `contexts.extra`. */
  context?: Record<string, unknown>;
}

interface ObserveState {
  key: string;
  environment: string;
  release: string | undefined;
  baseUrl: string;
  fetchImpl: typeof fetch;
  debug: boolean;
  autoFlushIntervalMs: number;
  queue: WireErrorItem[];
  queuedBytes: number;
  inFlight: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

let state: ObserveState | null = null;

function debugWarn(message: string, ...rest: unknown[]): void {
  // packages/sdk is deliberately exempt from the repo's no-console rule:
  // this IS the documented debug-diagnostics channel for a published
  // package that cannot depend on the app's own logger.
  console.warn(`[@alplus/sdk] ${message}`, ...rest);
}

/**
 * Best-effort, diagnostic-only -- never validated server-side (ingest.md
 * §2.2's `header.sdk` is free-form). Reads `process` through `globalThis`
 * rather than the bare identifier: this package's tsconfig carries no
 * `@types/node` (it must type-check standalone as a published, dependency-free
 * package), so `process` is not an ambient global here even under Node.
 */
function detectPlatform(): string {
  if (typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers") return "cloudflare";
  if (typeof window !== "undefined" && typeof window.document !== "undefined") return "browser";
  const nodeProcess = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (nodeProcess?.versions?.node !== undefined) return "node";
  return "unknown";
}

function clearTimer(s: ObserveState): void {
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
}

function maybeUnref(timer: ReturnType<typeof setTimeout>): void {
  // Real in Node (lets a short script exit without an explicit close()/flush()
  // call keeping the process alive); a no-op everywhere else, since browsers
  // and workerd don't expose `unref` on their timer handles.
  const withUnref = timer as unknown as { unref?: () => void };
  if (typeof withUnref.unref === "function") withUnref.unref();
}

function scheduleTimer(s: ObserveState): void {
  const timer = setTimeout(() => {
    s.timer = null;
    void triggerFlush(s);
  }, s.autoFlushIntervalMs);
  maybeUnref(timer);
  s.timer = timer;
}

function estimateBytes(item: WireErrorItem): number {
  return new TextEncoder().encode(JSON.stringify(item)).byteLength;
}

function enqueue(s: ObserveState, item: WireErrorItem): void {
  const wasEmpty = s.queue.length === 0;
  s.queue.push(item);
  s.queuedBytes += estimateBytes(item);

  if (s.queue.length >= BATCH_MAX_ITEMS || s.queuedBytes >= BATCH_MAX_BYTES) {
    clearTimer(s);
    void triggerFlush(s);
    return;
  }
  if (wasEmpty && s.timer === null && s.autoFlushIntervalMs > 0) {
    scheduleTimer(s);
  }
}

function buildEnvelope(s: ObserveState, items: WireErrorItem[]): Record<string, unknown> {
  return {
    header: { key: s.key, sdk: { name: SDK_NAME, version: SDK_VERSION, platform: detectPlatform() }, sent_at: new Date().toISOString() },
    items,
  };
}

async function sendBatch(s: ObserveState, items: WireErrorItem[]): Promise<void> {
  const body = JSON.stringify(buildEnvelope(s, items));
  if (new TextEncoder().encode(body).byteLength > MAX_ENVELOPE_BYTES) {
    // Should be unreachable given this SDK's own 64 KB batching ceiling
    // (envelope.ts's BATCH_MAX_BYTES), but guard rather than send a request
    // the server would 413 anyway.
    if (s.debug) debugWarn(`observe: dropping oversized envelope (${items.length} events, over ${MAX_ENVELOPE_BYTES} bytes)`);
    return;
  }

  const outcome = await postJsonWithRetries(`${s.baseUrl}/e/errors`, body, { "Content-Type": "application/json", Authorization: `Bearer ${s.key}` }, s.fetchImpl);
  if (s.debug && outcome.outcome === "exhausted") {
    debugWarn(`observe: dropped ${items.length} event(s) after exhausting retries`, outcome.lastError);
  }
}

/** Drains whatever is currently queued and sends it. Single-flight per client: a call while one is already in flight joins it rather than starting a second concurrent send. */
function triggerFlush(s: ObserveState): Promise<void> {
  if (s.inFlight !== null) return s.inFlight;

  const items = s.queue.splice(0, s.queue.length);
  s.queuedBytes = 0;
  if (items.length === 0) return Promise.resolve();

  const promise = sendBatch(s, items)
    .catch((err: unknown) => {
      // Belt-and-suspenders: sendBatch/postJsonWithRetries should never
      // reject, but this guarantees flush()/close() never throw either way.
      if (s.debug) debugWarn("observe: internal error while flushing", err);
    })
    .finally(() => {
      s.inFlight = null;
    });
  s.inFlight = promise;
  return promise;
}

/**
 * Initializes (or reinitializes) the Observe client. Safe to call more than
 * once per process/isolate -- a second call reinitializes with the new
 * options rather than throwing, logging a debug warning if `debug: true`.
 */
export function init(options: ObserveInitOptions): void {
  if (state !== null && options.debug === true) {
    debugWarn("init() called again; reinitializing the client with the new options.");
  }
  if (state !== null) clearTimer(state);

  const autoFlushIntervalMs = options.autoFlushIntervalMs ?? BATCH_FLUSH_MS;
  const next: ObserveState = {
    key: options.key,
    environment: options.environment ?? "production",
    release: options.release,
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    debug: options.debug ?? false,
    autoFlushIntervalMs,
    queue: [],
    queuedBytes: 0,
    inFlight: null,
    timer: null,
    closed: false,
  };
  state = next;
}

function normalizeError(error: unknown): { type: string; value: string | undefined; frames: ReturnType<typeof parseStack>; nonErrorValue: unknown } {
  if (error instanceof Error) {
    return { type: error.name.length > 0 ? error.name : "Error", value: error.message, frames: parseStack(error.stack), nonErrorValue: undefined };
  }
  // Spec §3.2: a non-Error thrown value is normalized into a synthetic
  // error, with the original value preserved under `contexts.extra.non_error_value`.
  return { type: "Error", value: safeStringifyThrown(error), frames: [], nonErrorValue: error };
}

function safeStringifyThrown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function mergeContext(userContext: Record<string, unknown> | undefined, nonErrorValue: unknown): Record<string, unknown> | undefined {
  if (userContext === undefined && nonErrorValue === undefined) return undefined;
  const extra: Record<string, unknown> = { ...userContext };
  if (nonErrorValue !== undefined) extra.non_error_value = nonErrorValue;
  return capContext({ extra }, MAX_CONTEXT_CHARS);
}

function buildExceptionItem(id: string, error: unknown, options: CaptureExceptionOptions | undefined, s: ObserveState): WireErrorItem {
  const normalized = normalizeError(error);
  const contexts = mergeContext(options?.context, normalized.nonErrorValue);
  return {
    id,
    type: "exception",
    timestamp: new Date().toISOString(),
    level: "error",
    release: s.release,
    environment: s.environment,
    exception: {
      type: normalized.type,
      value: capText(normalized.value, MAX_EXCEPTION_VALUE_CHARS),
      ...(normalized.frames.length > 0 ? { stacktrace: { frames: capFrames(normalized.frames, MAX_STACK_TRACE_CHARS) } } : {}),
    },
    ...(contexts !== undefined ? { contexts } : {}),
    mechanism: "generic",
  };
}

/**
 * Captures an exception for Observe. Accepts any thrown value; a non-`Error`
 * value is normalized into a synthetic error with the original preserved
 * under `contexts.extra.non_error_value`. Returns the client-generated
 * event id synchronously, even if `init` hasn't been called yet or the
 * client is closed -- the id is always safe to show a user, whether or not
 * the event was actually queued. Never throws.
 */
export function captureException(error: unknown, options?: CaptureExceptionOptions): string {
  const id = generateEventId();
  try {
    if (state === null) return id;
    if (state.closed) {
      if (state.debug) debugWarn("captureException() called after close(); event dropped.", id);
      return id;
    }
    enqueue(state, buildExceptionItem(id, error, options, state));
  } catch (err) {
    if (state?.debug === true) debugWarn("captureException() failed internally; event dropped.", err);
  }
  return id;
}

/**
 * Captures a non-exception message as an Observe event. Default level
 * `"info"`. Returns the client-generated event id synchronously. Never
 * throws.
 */
export function captureMessage(message: string, level: ErrorLevel = "info"): string {
  const id = generateEventId();
  try {
    if (state === null) return id;
    if (state.closed) {
      if (state.debug) debugWarn("captureMessage() called after close(); event dropped.", id);
      return id;
    }
    enqueue(state, {
      id,
      type: "message",
      timestamp: new Date().toISOString(),
      level,
      release: state.release,
      environment: state.environment,
      message: capText(message, MAX_MESSAGE_CHARS),
      mechanism: "generic",
    });
  } catch (err) {
    if (state?.debug === true) debugWarn("captureMessage() failed internally; event dropped.", err);
  }
  return id;
}

/**
 * Forces an immediate send of any queued events. Resolves `true` if the
 * queue drained within `timeoutMs` (default 2000ms), `false` on timeout --
 * queued events are not discarded on a `flush` timeout, only on `close`.
 * Never throws.
 */
export async function flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
  if (state === null) return true;
  clearTimer(state);
  const pending = triggerFlush(state);
  const timedOut = Symbol("observe-flush-timeout");
  const result = await Promise.race([pending.then(() => "done" as const), delay(timeoutMs).then(() => timedOut)]);
  return result !== timedOut;
}

/**
 * Flushes, then stops the client from accepting further events for the
 * remainder of the process; capture calls after `close` are no-ops (logged
 * in debug mode). Never throws.
 */
export async function close(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<boolean> {
  if (state === null) return true;
  const ok = await flush(timeoutMs);
  if (state !== null) {
    clearTimer(state);
    state.closed = true;
  }
  return ok;
}

/**
 * Drains the queue and returns the exact request a normal `flush()` would
 * have sent, WITHOUT sending it or engaging the retry transport -- for a
 * platform adapter's own unload-time flush (e.g. the browser adapter's
 * `pagehide` handler, which needs a single best-effort attempt, not a
 * multi-second retry loop after the page is already gone). Not part of the
 * platform-neutral public surface (`init`/`capture*`/`flush`/`close`);
 * exported for adapter authors and advanced `/core` users only. Returns
 * `null` if there is nothing queued or the client was never initialized.
 */
export function buildKeepaliveFlushRequest(): { url: string; body: string; headers: Record<string, string> } | null {
  if (state === null) return null;
  clearTimer(state);
  const items = state.queue.splice(0, state.queue.length);
  state.queuedBytes = 0;
  if (items.length === 0) return null;
  return {
    url: `${state.baseUrl}/e/errors`,
    body: JSON.stringify(buildEnvelope(state, items)),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.key}` },
  };
}

/**
 * Test-only: resets the singleton client to its pre-`init` state. Not
 * re-exported from `./index.ts` or any adapter entrypoint, so it never
 * reaches a published bundle -- imported directly by this module's own
 * test file to isolate cases that assert on pre-`init` behavior.
 */
export function __resetForTests(): void {
  if (state !== null) clearTimer(state);
  state = null;
}
