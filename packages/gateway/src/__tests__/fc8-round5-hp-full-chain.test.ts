/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — dynamic
 * proof for scripts/hp-full-chain-e2e.ts. See
 * fc8-round5-real-e2e-verbose.test.ts for the full rationale (items 4, 5,
 * 6). This script is the one case where ORACLE_URL is itself env-derived
 * (the other two scripts hardcode it), and where the printer-bound text
 * (`printText`/`finalText`) is built OUTSIDE the L()-accumulated log —
 * round 4's printer-only capture would have caught a leak INTO that text,
 * but nothing before round 5 ever drove an env canary through ORACLE_URL
 * or a hex-encoded chain canary through this script's addresses/hashes.
 *
 * At 4dbafd7f: ORACLE_URL and reportPath are printed raw, and the
 * chain-hex canary (tx hash/address) is printed raw in both the L() log
 * AND inside printText/finalText — see the verdict's additional blocking
 * finding ("hp-full-chain-e2e.ts logs environment-derived ORACLE_URL
 * (:84,143) and places the injected reportPath into printer output
 * (:345-369)").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/hp-full-chain-e2e.js";
import { makeAllFieldsCanaryFetchHpFullChain } from "./support/fc8-round4-fakes.js";
import {
  allEncodings, canaryReportPath, captureRequests, leafPathsContaining,
  makeFakeChainWithHexCanary, makeFakeChainWithInvalidHexCanary,
  printedContentOf, type CapturedRequest,
} from "./support/fc8-round5-fakes.js";

const RESPONSE_CANARY = "PCCOracleKey5f1e";
const CHAIN_CANARY = "FC8R5-CHAIN-CANARY-hpfc";
const ENV_ORACLE_URL_CANARY = "envcanary-oracle-url-hpfc-55e1";
const ENV_ORACLE_KEY_CANARY = "FC8R5-ENV-ORACLE-KEY-hpfc-6a19";
const ENV_API_KEY_CANARY = "FC8R5-ENV-API-KEY-hpfc-2f08";
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let reportPath: string;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  reportPath = canaryReportPath("FC8R5-ENV-REPORTPATH-hpfc");
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  try { rmSync(dirname(reportPath), { recursive: true, force: true }); } catch {}
});

describe("FC-8 round 5 — hp-full-chain-e2e.ts — env canaries, chain-hex canary, full request capture", () => {
  it("[neg] no env canary leaks anywhere; FC-8 round 5b: a SHAPE-VALID chain-hex canary now MAY appear verbatim on stdout/in the report, but still MUST NOT appear in printText/finalText (the printer-bound bodies)", async () => {
    const env = {
      PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      PCC_API_KEY: ENV_API_KEY_CANARY,
      PCC_ORACLE_KEY: ENV_ORACLE_KEY_CANARY,
      ORACLE_URL: `http://${ENV_ORACLE_URL_CANARY}.invalid:4100`,
    };

    const requests: CapturedRequest[] = [];
    const printerBodies: unknown[] = [];
    const innerFetch = makeAllFieldsCanaryFetchHpFullChain(RESPONSE_CANARY, printerBodies);
    const fetchImpl = captureRequests(innerFetch, requests);
    const { wallet, pub } = makeFakeChainWithHexCanary(CHAIN_CANARY);

    const result = await run({
      env, fetchImpl, wallet, pub,
      contractsDir: CONTRACTS_DIR, reportPath,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const reportFile = (() => { try { return readFileSync(reportPath, "utf8"); } catch { return ""; } })();
    const allBodiesText = requests.map((r) => JSON.stringify(r.body)).join("\n");
    // FC-8 round 5b: stdout/the report (file + in-memory) are the ONLY
    // sinks the ruling allows a chain value verbatim in — kept separate
    // from request-body text so the chain-canary checks below can assert
    // PRESENCE here and ABSENCE in printText/finalText specifically.
    const stdoutAndReport = [printed, errored, result.report, reportFile].join("\n").toLowerCase();
    const all = [stdoutAndReport, allBodiesText].join("\n").toLowerCase();

    // Unaffected by the round-5b ruling (chain values only).
    for (const envCanary of [ENV_ORACLE_URL_CANARY, ENV_ORACLE_KEY_CANARY, ENV_API_KEY_CANARY, "FC8R5-ENV-REPORTPATH-hpfc"]) {
      for (const encoded of allEncodings(envCanary)) {
        expect(all, `env canary leaked: encoding "${encoded}" of ${envCanary}`).not.toContain(encoded.toLowerCase());
      }
    }
    expect(all).not.toContain(reportPath.toLowerCase());

    // FC-8 round 5b: the shape-valid chain-hex canary now prints VERBATIM
    // on stdout/in the report, via publicChainRef — superseding round 5's
    // opposite assertion here (that assertion was correct for round 5's
    // default; this round's ruling changes the default itself).
    const hexChain = Buffer.from(CHAIN_CANARY, "utf8").toString("hex");
    expect(stdoutAndReport, "shape-valid chain-hex canary should now appear verbatim on stdout/in the report").toContain(hexChain.toLowerCase());

    // The printer-bound bodies here are printText/finalText — built
    // OUTSIDE the L()-accumulated log. They deliberately stay on
    // publicIdForLog (fingerprinted), never publicChainRef, precisely
    // because the ruling forbids a chain value verbatim in a THIRD-PARTY
    // body — so they must still be fully clean of both canaries.
    for (const body of printerBodies) {
      const content = printedContentOf(body).toLowerCase();
      for (const canary of [RESPONSE_CANARY, CHAIN_CANARY, hexChain]) {
        expect(content, `printer content carries "${canary}"`).not.toContain(canary.toLowerCase());
      }
    }

    for (const req of requests) {
      for (const envCanary of [ENV_ORACLE_URL_CANARY, ENV_ORACLE_KEY_CANARY, ENV_API_KEY_CANARY]) {
        const hits = leafPathsContaining(req.body, envCanary);
        expect(hits, `env canary in a ${req.destination} body (${req.pathTemplate}): ${hits.join(", ")}`).toEqual([]);
      }
    }

    expect(requests.length).toBeGreaterThan(2);
    expect(printerBodies.length).toBeGreaterThan(0);
  }, 30_000);

  it("[neg] FC-8 round 5b: a NON-shape-valid chain canary (wrong hex length) never appears anywhere — always \"(invalid)\"", async () => {
    const env = {
      PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      PCC_API_KEY: ENV_API_KEY_CANARY,
      PCC_ORACLE_KEY: ENV_ORACLE_KEY_CANARY,
      ORACLE_URL: `http://${ENV_ORACLE_URL_CANARY}.invalid:4100`,
    };
    const INVALID_CHAIN_CANARY = "FC8R5B-INVALID-SHAPE-CANARY-hpfc";

    const requests: CapturedRequest[] = [];
    const printerBodies: unknown[] = [];
    const innerFetch = makeAllFieldsCanaryFetchHpFullChain(RESPONSE_CANARY, printerBodies);
    const fetchImpl = captureRequests(innerFetch, requests);
    const { wallet, pub } = makeFakeChainWithInvalidHexCanary(INVALID_CHAIN_CANARY);

    const result = await run({
      env, fetchImpl, wallet, pub,
      contractsDir: CONTRACTS_DIR, reportPath,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const reportFile = (() => { try { return readFileSync(reportPath, "utf8"); } catch { return ""; } })();
    const allBodiesText = requests.map((r) => JSON.stringify(r.body)).join("\n");
    const all = [printed, errored, result.report, reportFile, allBodiesText].join("\n").toLowerCase();

    for (const encoded of allEncodings(INVALID_CHAIN_CANARY)) {
      expect(all, `non-shape-valid chain canary leaked: encoding "${encoded}"`).not.toContain(encoded.toLowerCase());
    }
    const hexInvalid = Buffer.from(INVALID_CHAIN_CANARY, "utf8").toString("hex");
    expect(all, "hex-encoded non-shape-valid chain canary leaked").not.toContain(hexInvalid.toLowerCase());
    expect(result.report).toContain("(invalid)");

    expect(requests.length).toBeGreaterThan(2);
  }, 30_000);
});
