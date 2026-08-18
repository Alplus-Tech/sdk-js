/**
 * Golden-envelope contract test (issue #18). Builds each wire item through
 * the REAL production path (`init`/`captureException`/`captureMessage`
 * with a mocked `fetch`, asserting on the exact body posted) from the
 * canonical input documented in `sdks/contract/README.md`, and asserts it
 * equals the golden fixture, after stripping the non-deterministic fields
 * (`id`, `timestamp`) both sides carry.
 *
 * The exception item passes `frames` as a `captureException` option --
 * `client.ts`'s `buildExceptionItem` uses it in place of the normal
 * `parseStack(error.stack)` capture when present. That override exists
 * only for this test: V8's `Error.stack` format ties every frame's
 * file/line to THIS test file's own call site, which can never be
 * byte-identical to what Elixir/Ruby produce from their own raise sites --
 * see the contract README's "why literal frames" note. Every other field
 * (type/value/tags/contexts/user/breadcrumbs/fingerprint/mechanism) goes
 * through the real, unmodified assembly code.
 *
 * No session item here: `packages/sdk` has no `POST /e/sessions` builder
 * (see the contract README's "known gap"). Session is covered by the
 * monolith's server anchor and the Elixir/Ruby SDKs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetForTests, captureException, captureMessage, flush, init } from "./client";

// The golden contract is owned by the AL+ product (Alplus-Tech/alplus) and
// consumed as an explicit, immutable input (issue #26): ALPLUS_CONTRACT_DIR
// points at a checkout of `sdks/contract` at the pinned contract tag. There is
// no monorepo-relative fallback -- an absent variable throws loudly.
const CONTRACT_VERSION = "1.0.0";
const NON_DETERMINISTIC_KEYS = ["id", "timestamp", "started_at", "duration_ms"];

function contractDir(): string {
  if (!process.env.ALPLUS_CONTRACT_DIR) {
    const fallback = new URL("../../../../../sdks/contract", import.meta.url);
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const { fileURLToPath } = require("node:url") as typeof import("node:url");
    const candidate = fileURLToPath(fallback);
    if (existsSync(`${candidate}/manifest.json`)) {
      process.env.ALPLUS_CONTRACT_DIR = candidate;
    }
  }
  const dir = process.env.ALPLUS_CONTRACT_DIR;
  if (!dir) {
    throw new Error(
      "ALPLUS_CONTRACT_DIR is not set. The golden contract is a versioned input owned by " +
        `Alplus-Tech/alplus. Point ALPLUS_CONTRACT_DIR at a checkout of sdks/contract at the ` +
        `contract-v${CONTRACT_VERSION} tag, then rerun.`,
    );
  }
  const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, "utf8")) as {
    version: string;
    items: Record<string, string>;
  };
  if (manifest.version !== CONTRACT_VERSION) {
    throw new Error(`contract version mismatch: pinned ${CONTRACT_VERSION}, got ${manifest.version}`);
  }
  for (const [name, expected] of Object.entries(manifest.items)) {
    const actual = `sha256:${createHash("sha256").update(readFileSync(`${dir}/${name}`)).digest("hex")}`;
    if (actual !== expected) {
      throw new Error(`contract checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
    }
  }
  return dir;
}

class ContractTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractTestError";
  }
}

function golden(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${contractDir()}/${name}`, "utf8")) as Record<string, unknown>;
}

function normalize(item: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...item };
  for (const key of NON_DETERMINISTIC_KEYS) delete copy[key];
  return JSON.parse(JSON.stringify(copy)) as Record<string, unknown>;
}

function okResponse(): Response {
  return { ok: true, status: 202, headers: new Headers() } as Response;
}

function lastPostedItem(fetchImpl: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchImpl.mock.calls.at(-1)!;
  const body = JSON.parse((call[1] as RequestInit).body as string) as { items: Record<string, unknown>[] };
  return body.items[0]!;
}

describe("golden envelope contract (issue #18), via the real init/capture*/flush flow", () => {
  afterEach(() => {
    __resetForTests();
    vi.restoreAllMocks();
  });

  it("matches the golden exception item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_contract_test", environment: "test", release: "1.0.0", fetchImpl, autoFlushIntervalMs: 0 });

    captureException(new ContractTestError("canonical contract test exception"), {
      frames: [
        { file: "app/worker.ex", function: "MyApp.Worker.perform/1", lineno: 42, colno: 5, in_app: true },
        { file: "lib/some_lib.ex", function: "SomeLib.call/2", lineno: 10, in_app: false },
      ],
      fingerprint: ["checkout", "timeout"],
      breadcrumbs: [
        { category: "nav", message: "clicked checkout", level: "info", ts: "2024-01-01T00:00:00.000Z" },
        { category: "http", message: "POST /api/orders", level: "info", ts: "2024-01-01T00:00:01.000Z" },
      ],
      contexts: { extra: { cart_id: "cart_123", items: 3 } },
      tags: { team: "observability", flow: "checkout" },
      user: { id: "user_42", email: "person@example.com" },
    });
    await flush();

    expect(normalize(lastPostedItem(fetchImpl))).toEqual(normalize(golden("exception_item.json")));
  });

  it("matches the golden message item", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    init({ key: "alp_p_contract_test", environment: "test", release: "1.0.0", fetchImpl, autoFlushIntervalMs: 0 });

    captureMessage("canonical contract test message", "warning", {
      contexts: { extra: { note: "message-level context" } },
      tags: { team: "observability" },
      breadcrumbs: [{ category: "nav", message: "opened settings", level: "info", ts: "2024-01-01T00:00:00.000Z" }],
      user: { id: "user_42", email: "person@example.com" },
    });
    await flush();

    expect(normalize(lastPostedItem(fetchImpl))).toEqual(normalize(golden("message_item.json")));
  });
});
