/**
 * FC-8 round 3 (astra pack 61b census closure) — dynamic proof for
 * scripts/hp-full-chain-e2e.ts. See fc8-round3-real-e2e-verbose.test.ts for
 * the full rationale; this mirrors it for this script's own census sites
 * (:188 scopeId, :215 tool-call id/status, :233 evidence.printResult,
 * :260 oracle status+body, :281 signature slice; :351 was already fixed in
 * round 2 and is left as regression coverage here too).
 *
 * At the refactor commit (no validated-field fix yet) these tests FAIL. See
 * returns/pcc-gateway-work/61c-fc8-repro-r3-7701661a.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/hp-full-chain-e2e.js";
import { fakeResponse, makeFakeChain } from "./support/fc8-round3-fakes.js";

const CANARY = "SENTINEL-ORACLE-KEY-5f1e";
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));
const REPORT_PATH = "/mnt/sparkbulk/tmp/fc8-r3-hp-full-chain-report.txt";

const BASE_ENV = {
  PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
  PCC_API_KEY: "pcc_test_not_a_real_secret",
  PCC_ORACLE_KEY: "test-oracle-key-not-a-secret",
  ORACLE_URL: "http://fake-oracle.invalid:4100",
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

function allCapturedText(result?: { report: string }): string {
  const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
  const reportFile = (() => { try { return readFileSync(REPORT_PATH, "utf8"); } catch { return ""; } })();
  return [printed, errored, result?.report ?? "", reportFile].join("\n");
}

function makeCanaryFetch(canary: string): typeof fetch {
  return (async (url: string | URL, opts?: any) => {
    const u = String(url);
    if (u.endsWith("/verify") && opts?.method === "POST") {
      // astra's own repro shape, plus a canary-bearing signature.
      return fakeResponse(200, {
        headers: { "x-oracle-key": canary },
        verified: true,
        attestation: { signature: `notHex-${canary}` },
      });
    }
    if (u.includes("/api/relay/") && u.endsWith("/scope")) {
      return fakeResponse(200, { id: `scope-${canary}` });
    }
    if (u.includes("/api/relay/") && u.endsWith("/tool-call")) {
      return fakeResponse(200, { id: `toolcall-${canary}`, status: `toolstatus-${canary}` });
    }
    return fakeResponse(200, { ok: true });
  }) as unknown as typeof fetch;
}

describe("FC-8 round 3 — hp-full-chain-e2e.ts run() — success path, every census site", () => {
  it("[neg] no canary reaches stdout, the returned report, or the report file", async () => {
    const { wallet, pub } = makeFakeChain();
    const result = await run({
      env: BASE_ENV, fetchImpl: makeCanaryFetch(CANARY), wallet, pub,
      contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    });
    expect(allCapturedText(result)).not.toContain(CANARY);
  }, 30_000);
});

describe("FC-8 round 3 — hp-full-chain-e2e.ts run() — malformed oracle response", () => {
  it("[neg] a non-JSON oracle body never reaches output", async () => {
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
      contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    });
    expect(allCapturedText(result)).not.toContain(CANARY);
  }, 30_000);
});

describe("FC-8 round 3 — hp-full-chain-e2e.ts run() — oracle failure response", () => {
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
      contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    });
    expect(allCapturedText(result)).not.toContain(CANARY);
  }, 30_000);
});

describe("FC-8 round 3 — hp-full-chain-e2e.ts run() — dependency rejection", () => {
  it("[neg] a gateway fetch that throws with a canary-bearing message never leaks it", async () => {
    const { wallet, pub } = makeFakeChain();
    const fetchImpl = (async (url: string | URL, opts?: any) => {
      const u = String(url);
      if (u.includes("/api/relay/") && u.endsWith("/scope")) {
        throw new Error(`x-oracle-key: ${CANARY}`);
      }
      return (makeCanaryFetch(CANARY) as any)(url, opts);
    }) as unknown as typeof fetch;

    await expect(run({
      env: BASE_ENV, fetchImpl, wallet, pub,
      contractsDir: CONTRACTS_DIR, reportPath: REPORT_PATH,
    })).rejects.toThrow();
    expect(allCapturedText()).not.toContain(CANARY);
  }, 30_000);
});
