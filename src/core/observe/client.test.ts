import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetForTests, captureException, captureMessage, close, flush, init } from "./client";
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
    await expect(promise).resolves.toBe(true); // "flush completed" -- the batch was attempted and dropped, not left queued
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
});
