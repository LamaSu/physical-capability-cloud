/**
 * FC-8 round 4 (astra pack 61c) — the steward's generic test (bus #6482) for
 * scripts/real-e2e.ts. See fc8-round4-real-e2e-verbose.test.ts for the full
 * rationale. ONE test, parameterized over an ID-shaped canary and a
 * space-containing canary, each planted in EVERY response field this
 * script reads.
 *
 * At 68b9f098 this FAILS for both canaries — see
 * returns/pcc-gateway-work/61d-fc8-repro-68b9f098.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/real-e2e.js";
import { makeFakeChain, allEncodings, makeAllFieldsCanaryFetchRealE2e } from "./support/fc8-round4-fakes.js";

const ID_CANARY = "PCCOracleKey5f1e";
const SPACE_CANARY = "SENTINEL ORACLE KEY 5f1e";
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));

const BASE_ENV = {
  PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
  PCC_ORACLE_KEY: "test-oracle-key-not-a-secret",
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  stdoutSpy.mockRestore();
});

describe.each([
  ["ID-shaped canary", ID_CANARY],
  ["space-containing canary", SPACE_CANARY],
])("FC-8 round 4 — real-e2e.ts — %s in every response field", (_label, canary) => {
  it("[neg] no encoding of the canary reaches stdout, stderr, or the returned report", async () => {
    const sentBodies: unknown[] = [];
    const { wallet, pub } = makeFakeChain();

    const result = await run({
      env: BASE_ENV,
      fetchImpl: makeAllFieldsCanaryFetchRealE2e(canary, sentBodies),
      wallet, pub,
      pollSleepMs: 0, pollAttempts: 1,
      contractsDir: CONTRACTS_DIR,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const sent = sentBodies.map((b) => (typeof b === "string" ? b : JSON.stringify(b))).join("\n");

    const all = [printed, errored, written, result.report, sent].join("\n").toLowerCase();

    for (const encoded of allEncodings(canary)) {
      expect(all, `encoding "${encoded}" of canary leaked`).not.toContain(encoded.toLowerCase());
    }
  }, 30_000);
});
