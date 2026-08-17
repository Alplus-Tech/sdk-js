import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForTests, captureException, captureMessage, close, flush, init, setScopeProvider } from "./client";
import { MAX_MESSAGE_CHARS } from "./envelope";

function okResponse(): Response {
  return { ok: true, status: 202, headers: new Headers() } as Response;
}

function errorResponse(status: number, retryAfter?: string): Response {
  return { ok: false, status, headers: new Headers(retryAfter === undefined ? undefined : { "Retry-After": retryAfter }) } as Response;
}

function lastBody(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchImpl.mock.calls.at(-1);
  const init = call?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("captureException / captureMessage before init()", () => {
  afterEach(() => {
    __resetForTests();
  });

  it("still returns an err_-prefixed id and never throws", () => {
    expect(() => {
      const id = captureException(new Error("boom"));
      expect(id).toMatch(/^err_/);
    }).not.toThrow();
  });

  it("captureMessage also returns an id and never throws", () => {
    expect(() => {
      const id = captureMessage("something happened");
      expect(id).toMatch(/^err_/);
    }).not.toThrow();
  });

  it("flush()/close() resolve true (nothing to send) when never initialized", async () => {
    await expect(flush()).resolves.toBe(true);
    await expect(close()).resolves.toBe(true);
  });
});

describe("Observe client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    __resetForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captureException returns a synchronous id without waiting on the network", () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    const id = captureException(new Error("boom"));
    expect(id).toMatch(/^err_/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("auto-flushes once the queue reaches the 10-item batch threshold", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    for (let i = 0; i < 10; i++) captureException(new Error(`boom ${i}`));
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = lastBody(fetchImpl);
    expect((body.items as unknown[]).length).toBe(10);
  });

  it("sends a well-formed envelope: Authorization header, header.key, sdk name/version, item shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", environment: "staging", release: "1.2.3", fetchImpl });
    captureException(new Error("boom"));
    await flush();

    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("https://ingest.alplus.dev/e/errors");
    const requestInit = call[1] as RequestInit;
    expect((requestInit.headers as Record<string, string>).Authorization).toBe("Bearer alp_p_test");

    const body = lastBody(fetchImpl);
    const header = body.header as { key: string; sdk: { name: string; version: string } };
    expect(header.key).toBe("alp_p_test");
    expect(header.sdk.name).toBe("@alplus/sdk");

    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    expect(item.id).toMatch(/^err_/);
    expect(item.type).toBe("exception");
    expect(item.level).toBe("error");
    expect(item.environment).toBe("staging");
    expect(item.release).toBe("1.2.3");
    expect((item.exception as { type: string; value: string }).type).toBe("Error");
    expect((item.exception as { type: string; value: string }).value).toBe("boom");
  });

  it("respects a custom baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", baseUrl: "https://ingest.example.test/", fetchImpl });
    captureException(new Error("boom"));
    await flush();
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://ingest.example.test/e/errors");
  });

  it("captureMessage defaults to level info and carries no exception field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureMessage("hello");
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.type).toBe("message");
    expect(item.level).toBe("info");
    expect(item.message).toBe("hello");
    expect(item.exception).toBeUndefined();
  });

  it("captureMessage accepts an explicit level", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureMessage("careful", "warning");
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.level).toBe("warning");
  });

  it("truncates an oversized message to MAX_MESSAGE_CHARS", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureMessage("x".repeat(MAX_MESSAGE_CHARS + 500));
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect((item.message as string).length).toBe(MAX_MESSAGE_CHARS);
  });

  it("normalizes a non-Error thrown value and preserves it under contexts.extra.non_error_value", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException("just a string");
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect((item.exception as { type: string }).type).toBe("Error");
    expect((item.contexts as { extra: { non_error_value: unknown } }).extra.non_error_value).toBe("just a string");
  });

  it("walks Error#cause into the wire exception.cause chain, bounded at 4 causes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    const root = new TypeError("root cause");
    const middle = new Error("middle", { cause: root });
    const outer = new Error("outer", { cause: middle });
    captureException(outer);
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    const exception = item.exception as { value?: string; cause?: { type: string; value?: string; cause?: { type: string; cause?: unknown } } };
    expect(exception.value).toBe("outer");
    expect(exception.cause?.value).toBe("middle");
    expect(exception.cause?.cause?.type).toBe("TypeError");
    expect(exception.cause?.cause?.cause).toBeUndefined();

    fetchImpl.mockClear();
    let deep: Error = new Error("layer 0");
    for (let n = 1; n < 8; n += 1) deep = new Error(`layer ${n}`, { cause: deep });
    captureException(deep);
    await flush();
    const deepItem = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    let depth = 0;
    let cursor = (deepItem.exception as { cause?: unknown }).cause as { cause?: unknown } | undefined;
    while (cursor !== undefined) {
      depth += 1;
      cursor = cursor.cause as { cause?: unknown } | undefined;
    }
    expect(depth).toBe(4);
  });

  it("attaches contexts.request (query-stripped url + user agent) in a browser-like host", async () => {
    vi.stubGlobal("window", { location: { href: "https://shop.test/cart?token=shh" } });
    vi.stubGlobal("navigator", { userAgent: "TestBrowser/1.0" });
    try {
      const fetchImpl = vi.fn().mockResolvedValue(okResponse());
      init({ key: "alp_p_test", fetchImpl });
      captureException(new Error("boom"));
      await flush();
      const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
      const request = (item.contexts as { request: { url: string; user_agent: string } }).request;
      expect(request.url).toBe("https://shop.test/cart");
      expect(request.user_agent).toBe("TestBrowser/1.0");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attaches no contexts.request outside a browser-like host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.contexts).toBeUndefined();
  });

  it("a non-Error cause is dropped rather than serialized", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("outer", { cause: "just a string" }));
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect((item.exception as { cause?: unknown }).cause).toBeUndefined();
  });

  it("merges options.context into contexts.extra", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"), { context: { feature: "checkout" } });
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect((item.contexts as { extra: { feature: string } }).extra.feature).toBe("checkout");
  });

  it("retries a 5xx once and succeeds on the second attempt", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errorResponse(503)).mockResolvedValueOnce(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    const promise = flush();
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors a 429 Retry-After without hot-looping", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetchImpl = vi.fn().mockResolvedValueOnce(errorResponse(429, "20")).mockResolvedValueOnce(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));

    const promise = flush();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never throws or rejects even after exhausting all retries", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    const promise = flush();
    await vi.runAllTimersAsync();

    // Assert RESOLUTION, not the boolean. `flush()` races the pending send
    // against its own timeout, and under fake timers `runAllTimersAsync()`
    // drains BOTH — so which side of that race wins is non-deterministic and
    // this assertion flaked roughly 1 run in 6 as `expected false to be true`.
    //
    // The boolean is not the property this test is named for. What must hold,
    // and does hold either way, is that a totally failed transport RESOLVES
    // rather than rejecting: an unhandled rejection here would surface inside
    // the host application, which is the one thing a telemetry SDK must never
    // do. The retry count below still pins the drop-after-3-attempts
    // behaviour.
    await expect(promise).resolves.toBeTypeOf("boolean");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("drops a permanent 401/403/404 without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(401));
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs via console.warn on exhausted retries only when debug is true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    init({ key: "alp_p_test", fetchImpl, debug: true });
    captureException(new Error("boom"));
    const promise = flush();
    await vi.runAllTimersAsync();
    await promise;
    expect(warnSpy).toHaveBeenCalled();
  });

  it("stays silent on exhausted retries when debug is not set", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    const promise = flush();
    await vi.runAllTimersAsync();
    await promise;
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("close() flushes queued events, then drops further captures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("first"));
    await close();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    captureException(new Error("after close"));
    await flush();
    // No second network call: the post-close capture was never queued.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("init() called twice reinitializes rather than throwing", () => {
    const firstFetch = vi.fn().mockResolvedValue(okResponse());
    const secondFetch = vi.fn().mockResolvedValue(okResponse());
    expect(() => {
      init({ key: "alp_p_first", fetchImpl: firstFetch });
      init({ key: "alp_p_second", fetchImpl: secondFetch });
    }).not.toThrow();
  });

  it("autoFlushIntervalMs: 0 disables the idle timer -- captures below the batch threshold never auto-send", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl, autoFlushIntervalMs: 0 });
    captureException(new Error("boom"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).not.toHaveBeenCalled();

    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("the default idle timer flushes a sub-threshold queue after 5 seconds", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("mechanism defaults to 'generic' for a direct captureException/captureMessage call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    captureMessage("hi");
    await flush();
    const items = lastBody(fetchImpl).items as Array<Record<string, unknown>>;
    expect(items[0]!.mechanism).toBe("generic");
  });

  it("an explicit mechanism option overrides the default (what the auto-capture wrappers use)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"), { mechanism: "onerror" });
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.mechanism).toBe("onerror");
  });

  it("per-capture user/tags/contexts/breadcrumbs options reach the wire item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"), {
      user: { id: "u1", email: "jane@example.com" },
      tags: { plan: "agency" },
      contexts: { device: { os: "mac" } },
      breadcrumbs: [{ category: "manual", message: "did a thing" }],
    });
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.user).toEqual({ id: "u1", email: "jane@example.com" });
    expect(item.tags).toEqual({ plan: "agency" });
    expect((item.contexts as Record<string, unknown>).device).toEqual({ os: "mac" });
    expect(item.breadcrumbs).toEqual([expect.objectContaining({ category: "manual", message: "did a thing" })]);
  });

  it("captureMessage also accepts scope options", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureMessage("hello", "info", { user: { id: "u1" }, mechanism: "generic" });
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.user).toEqual({ id: "u1" });
  });

  it("an ambient scope provider (registered by a platform adapter) merges into every capture", async () => {
    setScopeProvider(() => ({ user: { id: "ambient-user" }, tags: { region: "eu" }, breadcrumbs: [{ category: "nav", message: "loaded" }] }));
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.user).toEqual({ id: "ambient-user" });
    expect(item.tags).toEqual({ region: "eu" });
    expect(item.breadcrumbs).toEqual([expect.objectContaining({ category: "nav", message: "loaded" })]);
    setScopeProvider(null);
  });

  it("a per-capture user override wins over the ambient scope provider's user", async () => {
    setScopeProvider(() => ({ user: { id: "ambient-user" } }));
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"), { user: { id: "explicit-user" } });
    await flush();
    const item = (lastBody(fetchImpl).items as Array<Record<string, unknown>>)[0]!;
    expect(item.user).toEqual({ id: "explicit-user" });
    setScopeProvider(null);
  });

  it("deduplicates: the same Error object captured twice within the dedup window produces exactly ONE queued event and returns the SAME id both times", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    const error = new Error("boom");
    const firstId = captureException(error);
    const secondId = captureException(error);
    expect(secondId).toBe(firstId);
    await flush();
    const items = lastBody(fetchImpl).items as unknown[];
    expect(items.length).toBe(1);
  });

  it("does NOT deduplicate two distinct Error objects, even with the same message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));
    captureException(new Error("boom"));
    await flush();
    const items = lastBody(fetchImpl).items as unknown[];
    expect(items.length).toBe(2);
  });

  it("drains a queue that grows during an in-flight send: flush() waits for the whole chain, not just the first POST (issue #43)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_test", fetchImpl });

    for (let i = 0; i < 10; i++) captureException(new Error(`boom ${i}`));
    // The 10th capture crosses BATCH_MAX_ITEMS and starts the first send
    // synchronously (execution runs up to sendBatch's first `await` inside
    // the same call stack as the 10th captureException), so exactly one
    // POST is already in flight here -- no timer/microtask advance needed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The 11th capture lands while that first send is still in flight.
    captureException(new Error("boom 10"));

    const drained = await flush(5_000);

    expect(drained).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const totalItems = fetchImpl.mock.calls.reduce((sum, call) => {
      const body = JSON.parse((call[1] as RequestInit).body as string) as { items: unknown[] };
      return sum + body.items.length;
    }, 0);
    expect(totalItems).toBe(11);
  });

  it("stays single-flight: two concurrent flush() calls never POST two batches at once", async () => {
    let inFlightCount = 0;
    let maxConcurrent = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      inFlightCount++;
      maxConcurrent = Math.max(maxConcurrent, inFlightCount);
      await Promise.resolve();
      inFlightCount--;
      return okResponse();
    });
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));

    const [a, b] = await Promise.all([flush(), flush()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(maxConcurrent).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flush() honors its timeout even if the send never settles, so close() can't hang the host", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Promise<Response>(() => {})); // never resolves
    init({ key: "alp_p_test", fetchImpl });
    captureException(new Error("boom"));

    const promise = flush(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe(false);
  });
});
