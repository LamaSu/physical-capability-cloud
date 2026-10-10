/**
 * FC-8 round 3 (astra pack 61b census closure) — dynamic proof for
 * scripts/real-e2e.ts. See fc8-round3-real-e2e-verbose.test.ts for the
 * full rationale; this mirrors it for real-e2e.ts's own census sites
 * (:269-270, 280/284, 291, 332-333, 352; the :401/:406 sites were already
 * fixed in round 2 and are left as regression coverage here too).
 *
 * At the refactor commit (no validated-field fix yet) these tests FAIL. See
 * returns/pcc-gateway-work/61c-fc8-repro-r3-7701661a.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/real-e2e.js";
import { fakeResponse, makeFakeChain } from "./support/fc8-round3-fakes.js";

const CANARY = "SENTINEL ORACLE KEY 5f1e"; // space: not id/enum/hex/content-type-shaped anywhere
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

function allCapturedText(result?: { report: string }): string {
  const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
  const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
  return [printed, errored, written, result?.report ?? ""].join("\n");
}

function makeCanaryFetch(canary: string): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    if (u.includes("/api/ot2/camera/latest")) {
      return fakeResponse(200, "", { "content-type": `malicious/${canary}`, "content-length": "99" });
    }
    if (u.endsWith("/verify") && opts?.method === "POST") {
      return fakeResponse(200, { verified: true, transactionHash: `txhash-${canary}` });
    }
    if (u.includes("/api/jobs/") && u.includes("/status")) {
      return fakeResponse(200, { status: "completed" });
    }
    if (u.includes("/api/jobs/submit")) {
      return fakeResponse(200, { jobId: `job-${canary}`, status: `jobstatus-${canary}` });
    }
    return fakeResponse(200, { ok: true });
  }) as unknown as typeof fetch;
}

describe("FC-8 round 3 — real-e2e.ts run() — success path, every census site", () => {
  it("[neg] no canary reaches stdout or the returned report", async () => {
    const { wallet, pub } = makeFakeChain();
    const result = await run({
      env: BASE_ENV, fetchImpl: makeCanaryFetch(CANARY), wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR,
    });
    expect(allCapturedText(result).toLowerCase()).not.toContain(CANARY.toLowerCase());
  }, 30_000);
});

describe("FC-8 round 3 — real-e2e.ts run() — malformed oracle response", () => {
  it("[neg] a non-JSON oracle body never reaches output (oracleReq.json() rejects, caught at top level)", async () => {
    const { wallet, pub } = makeFakeChain();
    const fetchImpl = (async (url: string | URL, opts?: any) => {
      const u = String(url);
      if (u.endsWith("/verify") && opts?.method === "POST") {
        return fakeResponse(502, `<html>upstream error: x-oracle-key: ${CANARY}</html>`);
      }
      return (makeCanaryFetch(CANARY) as any)(url, opts);
    }) as unknown as typeof fetch;

    // real-e2e.ts calls oracleReq.json() unconditionally; a non-JSON body
    // makes that reject, which propagates out of run() uncaught — still
    // must never have printed the canary on the way there.
    await run({
      env: BASE_ENV, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR,
    }).catch(() => {});
    expect(allCapturedText().toLowerCase()).not.toContain(CANARY.toLowerCase());
  }, 30_000);
});

describe("FC-8 round 3 — real-e2e.ts run() — oracle failure response", () => {
  it("[neg] a 500 with an error-shaped JSON body never reaches output", async () => {
    const { wallet, pub } = makeFakeChain();
    const fetchImpl = (async (url: string | URL, opts?: any) => {
      const u = String(url);
      if (u.endsWith("/verify") && opts?.method === "POST") {
        return fakeResponse(500, { error: `oracle rejected: x-oracle-key=${CANARY}`, verified: false });
      }
      return (makeCanaryFetch(CANARY) as any)(url, opts);
    }) as unknown as typeof fetch;

    const result = await run({
      env: BASE_ENV, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR,
    });
    expect(allCapturedText(result).toLowerCase()).not.toContain(CANARY.toLowerCase());
  }, 30_000);
});

describe("FC-8 round 3 — real-e2e.ts run() — dependency rejection", () => {
  it("[neg] a gateway fetch that throws with a canary-bearing message never leaks it", async () => {
    const { wallet, pub } = makeFakeChain();
    const fetchImpl = (async (url: string | URL, opts?: any) => {
      const u = String(url);
      if (u.includes("/api/jobs/submit")) {
        throw new Error(`x-oracle-key: ${CANARY}`);
      }
      return (makeCanaryFetch(CANARY) as any)(url, opts);
    }) as unknown as typeof fetch;

    await expect(run({
      env: BASE_ENV, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR,
    })).rejects.toThrow();
    expect(allCapturedText().toLowerCase()).not.toContain(CANARY.toLowerCase());
  }, 30_000);
});
