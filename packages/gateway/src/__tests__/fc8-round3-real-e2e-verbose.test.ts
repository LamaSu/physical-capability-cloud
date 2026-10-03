/**
 * FC-8 round 3 (astra pack 61b census closure) — dynamic proof for
 * scripts/real-e2e-verbose.ts. Astra's "Required confirmation" (verdict
 * :83): capture stdout/stderr and report/print payloads with synthetic
 * canaries, mocked services and mocked chain operations; exercise success,
 * malformed responses, failures and dependency rejections, with no live
 * service. The round-3 refactor (commit 18274924) exported `run(deps)`
 * specifically so this file can drive the real script logic with mocks
 * instead of only reading its source text.
 *
 * At the refactor commit (no validated-field fix yet) every one of these
 * tests FAILS: the canary is still printed/returned raw. See
 * returns/pcc-gateway-work/61c-fc8-repro-r3-7701661a.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/real-e2e-verbose.js";
import { fakeResponse, makeFakeChain } from "./support/fc8-round3-fakes.js";

const CANARY = "SENTINEL ORACLE KEY 5f1e"; // space: not id/enum/hex/content-type-shaped anywhere
const REPORT_PATH = "/mnt/sparkbulk/tmp/fc8-r3-verbose-report.txt";
// The script reads compiled contract ABI/bytecode just to pass shapes to
// the (fake, injected) chain client — it never actually dereferences real
// bytecode when wallet/pub are mocked. Point at minimal fixtures instead of
// requiring a real `forge build` (packages/contracts/out/ is also not
// guaranteed to exist in every worktree).
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));

const BASE_ENV = {
  PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
  PCC_ORACLE_KEY: "test-oracle-key-not-a-secret",
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  try { rmSync(REPORT_PATH); } catch {}
});

function allCapturedText(result?: { report: string; log: string[] }): string {
  const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
  const reportFile = (() => { try { return readFileSync(REPORT_PATH, "utf8"); } catch { return ""; } })();
  return [printed, errored, result?.report ?? "", (result?.log ?? []).join("\n"), reportFile].join("\n");
}

/** Dispatches a canary-bearing response per endpoint, covering every census site astra listed for this script. */
function makeCanaryFetch(canary: string): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    if (u.includes("/api/ot2/camera/latest")) {
      return fakeResponse(200, "", { "content-type": `malicious/${canary}`, "content-length": "99" });
    }
    if (u.endsWith("/verify") && opts?.method === "POST") {
      // astra pack 61b's own repro shape (verdict, finding row 1).
      return fakeResponse(200, { headers: { "x-oracle-key": canary }, verified: true });
    }
    if (u.includes("/api/jobs/") && u.includes("/status")) {
      return fakeResponse(200, { status: "completed", progress: `progress-${canary}` });
    }
    if (u.includes("/api/jobs/submit")) {
      return fakeResponse(200, { jobId: `job-${canary}`, status: "queued" });
    }
    if (u.includes("/api/evidence/archive")) {
      return fakeResponse(200, { archived: true, cid: `cid-${canary}`, metadataCid: `mcid-${canary}` });
    }
    if (u.includes("/api/evidence/lit-status")) {
      return fakeResponse(200, { lit: { connected: true, mode: `mode-${canary}`, network: `net-${canary}` } });
    }
    if (u.includes("/api/lit/provision")) {
      return fakeResponse(200, { error: `lit-provision-failed-${canary}` }); // no usageKey -> "no" branch
    }
    if (u.includes("/api/zk/commit")) {
      return fakeResponse(200, { commitment: { id: `commit-${canary}`, commitmentHash: `hash-${canary}` } });
    }
    if (u.includes("/api/zk/prove/tier")) {
      return fakeResponse(200, { proof: { id: `proof-${canary}`, proofType: `type-${canary}`, verified: true } });
    }
    if (u.includes("/api/zk/anchor-starknet/")) {
      return fakeResponse(200, { status: `anchorstatus-${canary}` });
    }
    if (u.includes("/api/zk/anchor-starknet")) {
      return fakeResponse(200, { anchor: { txHash: `txhash-${canary}`, blockNumber: 42 }, mode: `anchormode-${canary}` });
    }
    if (u.includes("/api/near/status")) {
      return fakeResponse(200, {
        integration: `integ-${canary}`, network: `nearnet-${canary}`, mock: true,
        supportedChains: ["near", `chain-${canary}`],
      });
    }
    if (u.includes("/api/near/intent/")) {
      return fakeResponse(200, { status: `intentstatus-${canary}`, txHash: `txhash2-${canary}` });
    }
    if (u.includes("/api/near/quote")) {
      return fakeResponse(200, {
        quote: { quoteId: `quote-${canary}`, estimatedOutput: `out-${canary}`, fee: `fee-${canary}`, route: `route-${canary}` },
      });
    }
    if (u.includes("/api/near/intent")) {
      return fakeResponse(200, { intent: { intentId: `intent-${canary}`, status: `intentstatus2-${canary}` } });
    }
    // kernel state, dht peers/metrics, heartbeat, capabilities, telemetry audit, escrow chain state
    return fakeResponse(200, { ok: true, note: `generic-${canary}` });
  }) as unknown as typeof fetch;
}

describe("FC-8 round 3 — real-e2e-verbose.ts run() — success path, every census site", () => {
  it("[neg] no canary reaches stdout, the returned report, or the report file", async () => {
    const { wallet, pub } = makeFakeChain();
    const result = await run({
      env: BASE_ENV,
      fetchImpl: makeCanaryFetch(CANARY),
      wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR,
      reportPath: REPORT_PATH,
    });
    const all = allCapturedText(result);
    expect(all).not.toContain(CANARY);
    // sanity: the run actually reached the sites under test (not a no-op)
    expect(all).toContain("Provisioned: no");
  }, 30_000);
});

describe("FC-8 round 3 — real-e2e-verbose.ts run() — malformed oracle response", () => {
  it("[neg] a non-JSON oracle body (HTML error page reflecting the key) never reaches output", async () => {
    const { wallet, pub } = makeFakeChain();
    const fetchImpl = (async (url: string | URL, opts?: any) => {
      const u = String(url);
      if (u.endsWith("/verify") && opts?.method === "POST") {
        return fakeResponse(502, `<html>upstream error: x-oracle-key: ${CANARY}</html>`);
      }
      return (makeCanaryFetch(CANARY) as any)(url, opts);
    }) as unknown as typeof fetch;

    const result = await run({
      env: BASE_ENV, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    });
    expect(allCapturedText(result)).not.toContain(CANARY);
  }, 30_000);
});

describe("FC-8 round 3 — real-e2e-verbose.ts run() — oracle failure response", () => {
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
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    });
    expect(allCapturedText(result)).not.toContain(CANARY);
  }, 30_000);
});

describe("FC-8 round 3 — real-e2e-verbose.ts run() — dependency rejection", () => {
  it("[neg] a fetch that throws with a canary-bearing message never leaks it, even uncaught", async () => {
    const { wallet, pub } = makeFakeChain();
    const fetchImpl = (async (url: string | URL, opts?: any) => {
      const u = String(url);
      if (u.includes("/api/lit/provision")) {
        throw new Error(`x-oracle-key: ${CANARY}`);
      }
      return (makeCanaryFetch(CANARY) as any)(url, opts);
    }) as unknown as typeof fetch;

    await expect(run({
      env: BASE_ENV, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    })).rejects.toThrow();

    // Nothing printed before the throw may contain the canary either.
    expect(allCapturedText()).not.toContain(CANARY);
  }, 30_000);

  it("[neg] a chain client that throws with a canary-bearing message never leaks it", async () => {
    const { pub } = makeFakeChain();
    const wallet = {
      deployContract: async () => { throw new Error(`secret deploy failure: ${CANARY}`); },
      writeContract: async () => { throw new Error(`secret write failure: ${CANARY}`); },
    } as any;

    await expect(run({
      env: BASE_ENV, fetchImpl: makeCanaryFetch(CANARY), wallet, pub,
      pollSleepMs: 0, pollAttempts: 2, contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    })).rejects.toThrow();

    expect(allCapturedText()).not.toContain(CANARY);
  }, 30_000);
});
