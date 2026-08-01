import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPingUrl, heartbeat } from "./heartbeat";

/** Minimal fetch-shaped Response stub, avoids depending on a DOM lib global at test time. */
function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status } as Response;
}

describe("buildPingUrl", () => {
  it("builds the default URL with only a ping_id query param", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1" });
    expect(url).toBe("https://ingest.alplus.dev/h/hb_abc123?ping_id=ping-1");
  });

  it("encodes the token", () => {
    const url = buildPingUrl("hb_a b/c", { pingId: "ping-1" });
    expect(url).toContain("/h/hb_a%20b%2Fc");
  });

  it("respects a custom baseUrl, stripping trailing slashes", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", baseUrl: "https://ingest.example.test/" });
    expect(url).toBe("https://ingest.example.test/h/hb_abc123?ping_id=ping-1");
  });

  it("maps state via the ?state= query param", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", state: "start" });
    expect(url).toBe("https://ingest.alplus.dev/h/hb_abc123?state=start&ping_id=ping-1");
  });

  it("maps exitCode 0 to the /0 path suffix (finish)", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", exitCode: 0 });
    expect(url).toBe("https://ingest.alplus.dev/h/hb_abc123/0?ping_id=ping-1");
  });

  it("maps a non-zero exitCode to its /N path suffix (fail)", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", exitCode: 17 });
    expect(url).toBe("https://ingest.alplus.dev/h/hb_abc123/17?ping_id=ping-1");
  });

  it("clamps an out-of-range exitCode into 0-255", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", exitCode: 999 });
    expect(url).toContain("/h/hb_abc123/255");
  });

  it("prefers state over exitCode when both are somehow set", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", state: "fail", exitCode: 0 });
    expect(url).toBe("https://ingest.alplus.dev/h/hb_abc123?state=fail&ping_id=ping-1");
  });

  it("appends a message under ?msg=", () => {
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", message: "boom" });
    expect(url).toBe("https://ingest.alplus.dev/h/hb_abc123?ping_id=ping-1&msg=boom");
  });

  it("truncates a message over 2048 chars silently", () => {
    const longMessage = "x".repeat(3000);
    const url = buildPingUrl("hb_abc123", { pingId: "ping-1", message: longMessage });
    const msgParam = new URL(url).searchParams.get("msg");
    expect(msgParam).toHaveLength(2048);
    expect(msgParam).toBe("x".repeat(2048));
  });
});

describe("heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves without retrying on a first-attempt success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await heartbeat("hb_abc123", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure and succeeds on the second attempt, reusing the same pingId", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(okResponse());

    const promise = heartbeat("hb_abc123", { fetchImpl });
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchImpl.mock.calls[0]![0] as string);
    const secondUrl = new URL(fetchImpl.mock.calls[1]![0] as string);
    expect(firstUrl.searchParams.get("ping_id")).toBe(secondUrl.searchParams.get("ping_id"));
    expect(firstUrl.searchParams.get("ping_id")).not.toBeNull();
  });

  it("resolves without throwing after exhausting all 3 attempts", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const promise = heartbeat("hb_abc123", { fetchImpl });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats a non-ok response as a failure requiring retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(errorResponse(503)).mockResolvedValueOnce(okResponse());

    const promise = heartbeat("hb_abc123", { fetchImpl });
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("logs via console.warn on final failure only when debug is true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const promise = heartbeat("hb_abc123", { fetchImpl, debug: true });
    await vi.runAllTimersAsync();
    await promise;

    expect(warnSpy).toHaveBeenCalled();
  });

  it("stays silent on final failure when debug is not set", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const promise = heartbeat("hb_abc123", { fetchImpl });
    await vi.runAllTimersAsync();
    await promise;

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("passes exitCode/state/message options through to the request URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await heartbeat("hb_abc123", { fetchImpl, exitCode: 1, message: "disk full" });

    const url = new URL(fetchImpl.mock.calls[0]![0] as string);
    expect(url.pathname).toBe("/h/hb_abc123/1");
    expect(url.searchParams.get("msg")).toBe("disk full");
  });

  it("never rejects even when no fetch implementation is available", async () => {
    vi.stubGlobal("fetch", undefined);
    await expect(heartbeat("hb_abc123")).resolves.toBeUndefined();
  });
});
