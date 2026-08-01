/**
 * @alplus/sdk core heartbeat transport (docs/sdk/01-sdk-spec.md section 3.5,
 * 5.5; heartbeat-v2 contract "SDK (@alplus/sdk v0.1.0)" section).
 *
 * v0.1.0 ships ONLY this module -- Observe/Measure land in later 0.x minors
 * (see packages/sdk/README.md's scope note). `./node`, `./cloudflare`, and
 * the neutral `.` entry all re-export this file verbatim; the transport
 * (`fetch`) is a Web-standard global on every target platform (Node >= 18,
 * workerd, browsers), so there is no platform branching to do here.
 */

const DEFAULT_BASE_URL = "https://ingest.alplus.dev";
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_JITTER = 0.5;
const MAX_MESSAGE_LENGTH = 2048;

export interface HeartbeatOptions {
  /** Explicit ping state. Mutually exclusive with `exitCode`. */
  state?: "start" | "finish" | "fail";
  /** Exit code shortcut: 0 -> finish, 1-255 -> fail. Mutually exclusive with `state`. */
  exitCode?: number;
  /** Diagnostic message attached to fail pings, truncated silently to 2048 chars. */
  message?: string;
  /** Idempotency id reused across retries. Defaults to a fresh client-generated id. */
  pingId?: string;
  /** Override ingest origin. Defaults to https://ingest.alplus.dev. */
  baseUrl?: string;
  /** Injectable fetch implementation, primarily for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Log a console.warn on final retry exhaustion / internal error. Default false. */
  debug?: boolean;
}

function generatePingId(): string {
  const cryptoRef: Crypto | undefined = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  // Fallback for environments without a global Web Crypto object (older
  // Node < 19 without --experimental-global-webcrypto). Not
  // cryptographically strong, but a ping id is only ever used as an
  // ingest-side dedup key, never a security token.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function normalizeExitCode(exitCode: number): number {
  if (!Number.isFinite(exitCode)) return 1;
  return Math.min(255, Math.max(0, Math.trunc(exitCode)));
}

function truncateMessage(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
}

/**
 * Builds the ping URL for a single heartbeat call. Exported for the SDK's
 * own URL-building tests; not part of the public subpath surface (only
 * `heartbeat` and `HeartbeatOptions` are re-exported by the platform
 * adapters).
 */
export function buildPingUrl(token: string, options: HeartbeatOptions & { pingId: string }): string {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const encodedToken = encodeURIComponent(token);

  let pathSuffix = "";
  const searchParams = new URLSearchParams();

  if (options.state !== undefined) {
    searchParams.set("state", options.state);
  } else if (options.exitCode !== undefined) {
    pathSuffix = `/${normalizeExitCode(options.exitCode)}`;
  }

  searchParams.set("ping_id", options.pingId);

  if (options.message !== undefined) {
    searchParams.set("msg", truncateMessage(options.message));
  }

  return `${baseUrl}/h/${encodedToken}${pathSuffix}?${searchParams.toString()}`;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function backoffMs(attempt: number): number {
  const exponential = BACKOFF_BASE_MS * 2 ** (attempt - 1);
  const jitterFactor = 1 - BACKOFF_JITTER + Math.random() * (2 * BACKOFF_JITTER);
  return exponential * jitterFactor;
}

/**
 * Sends a single heartbeat ping (docs/sdk/01-sdk-spec.md section 3.5).
 *
 * Never throws or rejects: internal errors, network failures, and non-ok
 * responses are retried up to 3 attempts total with jittered exponential
 * backoff, then swallowed (optionally logged via `options.debug`). The
 * same `pingId` is reused across every attempt so the ingest worker can
 * dedupe retried pings of the same logical event.
 */
export async function heartbeat(token: string, options: HeartbeatOptions = {}): Promise<void> {
  const debug = options.debug ?? false;
  try {
    const pingId = options.pingId ?? generatePingId();
    const url = buildPingUrl(token, { ...options, pingId });
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (typeof fetchImpl !== "function") {
      if (debug) {
        console.warn(`[@alplus/sdk] heartbeat: no fetch implementation available (token "${token}")`);
      }
      return;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(url, { method: "POST" });
        if (response.ok) return;
        lastError = new Error(`heartbeat ping responded with status ${response.status}`);
      } catch (err) {
        lastError = err;
      }
      if (attempt < MAX_ATTEMPTS) {
        await delay(backoffMs(attempt));
      }
    }

    if (debug) {
      console.warn(`[@alplus/sdk] heartbeat: exhausted ${MAX_ATTEMPTS} attempts (token "${token}")`, lastError);
    }
  } catch (err) {
    // Belt-and-suspenders: guarantees the "never throw into the host app"
    // contract (spec section 5.5) even against an unforeseen internal bug.
    if (debug) {
      console.warn(`[@alplus/sdk] heartbeat: internal error (token "${token}")`, err);
    }
  }
}
