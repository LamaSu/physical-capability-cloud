/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — dynamic
 * proof for scripts/real-e2e-verbose.ts covering the three remaining
 * reproductions:
 *   4. ENV canaries: every env var this script reads, plus the injected
 *      reportPath, set to a distinct canary. None may appear in stdout,
 *      stderr, the report, the report FILE, or any request body, in any
 *      encoding (env values are never legitimately part of a body at all,
 *      unlike a gateway-issued id).
 *   5. DEPENDENCY canary: the fake chain client returns the HEX ENCODING
 *      of a canary as every tx hash/address/topic. With PUBLIC_ID_RULE =
 *      "fingerprint" (the default), none of it may appear verbatim.
 *   6. Full request capture: every outgoing request is captured
 *      (destination/method/path template/body), not just printer-bound
 *      ones. The printer destination's printed content must be fully
 *      clean of BOTH canaries; the gateway/oracle destinations may
 *      legitimately echo the RESPONSE canary back (protocol traffic to
 *      the service that issued it) but must never carry an ENV canary.
 *
 * At 4dbafd7f: the env canaries (ORACLE_VERIFIER_ADDRESS, reportPath) and
 * the chain-hex canary (tx hash/address/topic) are printed raw — see the
 * verdict's additional blocking finding. This file fails for those real
 * reasons, independent of fc8-round5-fakes.ts's own existence (unlike the
 * redact-log unit tests, nothing here depends on a not-yet-existing
 * export).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/real-e2e-verbose.js";
import { makeAllFieldsCanaryFetchVerbose } from "./support/fc8-round4-fakes.js";
import {
  allEncodings, canaryReportPath, captureRequests, isPrinterBody,
  leafPathsContaining, makeFakeChainWithHexCanary,
  makeFakeChainWithInvalidHexCanary, printedContentOf,
  type CapturedRequest,
} from "./support/fc8-round5-fakes.js";

const RESPONSE_CANARY = "PCCOracleKey5f1e";
// <=32 ASCII chars so its hex encoding (<=64 chars) fits UNTRUNCATED in the
// 64-hex-char hash field (hexHashOf) — a longer canary would only ever
// appear as a truncated prefix there, which would make this test blind to
// mutant (f) (PUBLIC_ID_RULE flipped to "verbatim") for this script specifically.
const CHAIN_CANARY = "FC8R5-CHAIN-CANARY-verbose";
const ENV_ORACLE_VERIFIER_CANARY = "FC8R5-ENV-ORACLE-VERIFIER-9c21";
const ENV_ORACLE_KEY_CANARY = "FC8R5-ENV-ORACLE-KEY-4b88";
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let reportPath: string;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  reportPath = canaryReportPath("FC8R5-ENV-REPORTPATH-verbose");
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  try { rmSync(dirname(reportPath), { recursive: true, force: true }); } catch {}
});

describe("FC-8 round 5 — real-e2e-verbose.ts — env canaries, chain-hex canary, full request capture", () => {
  it("[neg] no env canary leaks to stdout/stderr/report/report-file/any body; FC-8 round 5b: a SHAPE-VALID chain-hex canary now MAY appear verbatim on stdout/in the report, but still MUST NOT appear anywhere in the printer-bound body", async () => {
    const env = {
      PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      PCC_ORACLE_KEY: ENV_ORACLE_KEY_CANARY,
      ORACLE_VERIFIER_ADDRESS: ENV_ORACLE_VERIFIER_CANARY,
    };

    const requests: CapturedRequest[] = [];
    const printerBodies: unknown[] = [];
    const innerFetch = makeAllFieldsCanaryFetchVerbose(RESPONSE_CANARY, printerBodies);
    const fetchImpl = captureRequests(innerFetch, requests);
    const { wallet, pub } = makeFakeChainWithHexCanary(CHAIN_CANARY);

    const result = await run({
      env, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 1,
      reportPath, contractsDir: CONTRACTS_DIR,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const reportFile = (() => { try { return readFileSync(reportPath, "utf8"); } catch { return ""; } })();
    const allBodiesText = requests.map((r) => JSON.stringify(r.body)).join("\n");
    // FC-8 round 5b: stdout/stderr/the report (file + in-memory) are the
    // ONLY sinks the ruling allows a chain value verbatim in — kept
    // separate from request-body text so the chain-canary checks below can
    // assert PRESENCE here and ABSENCE in the printer body specifically,
    // rather than one blended "nowhere" check.
    const stdoutAndReport = [printed, errored, result.report, result.log.join("\n"), reportFile].join("\n").toLowerCase();
    const all = [stdoutAndReport, allBodiesText].join("\n").toLowerCase();

    // Item 4: env canaries (and their URI/base64/hex encodings) — never anywhere, any sink, any destination. Unaffected by the round-5b ruling (chain values only).
    for (const envCanary of [ENV_ORACLE_VERIFIER_CANARY, ENV_ORACLE_KEY_CANARY, "FC8R5-ENV-REPORTPATH-verbose"]) {
      for (const encoded of allEncodings(envCanary)) {
        expect(all, `env canary leaked: encoding "${encoded}" of ${envCanary}`).not.toContain(encoded.toLowerCase());
      }
    }
    // reportPath's own directory name embeds the canary above — redundant
    // with the loop, but explicit: the PATH ITSELF must never be printed.
    expect(all).not.toContain(reportPath.toLowerCase());

    // FC-8 round 5b: the shape-valid chain-hex canary now prints VERBATIM
    // on stdout and in the report, via publicChainRef — the exact behavior
    // the steward's ruling asks for. (Round 5 asserted the opposite here;
    // that assertion was correct for round 5's default and is superseded,
    // not merely loosened, by this round's ruling.)
    const hexChain = Buffer.from(CHAIN_CANARY, "utf8").toString("hex");
    expect(stdoutAndReport, "shape-valid chain-hex canary should now appear verbatim on stdout/in the report").toContain(hexChain.toLowerCase());

    // Item 6: the printer-bound body's PRINTED CONTENT must still be fully
    // clean of both canaries (an even stricter destination than
    // stdout/report) — redactChainValuesFromText scrubs the chain-hex
    // canary back out before this script ever sends it to the printer,
    // even though the SAME text is verbatim on stdout/in the report above.
    for (const body of printerBodies) {
      const content = printedContentOf(body).toLowerCase();
      for (const canary of [RESPONSE_CANARY, CHAIN_CANARY, hexChain]) {
        expect(content, `printer content carries "${canary}"`).not.toContain(canary.toLowerCase());
      }
    }

    // Item 6: NO captured request body — gateway, oracle, or other — may
    // ever carry an ENV canary (unlike a gateway-issued/chain id, an env
    // value is never legitimately part of ANY body).
    for (const req of requests) {
      for (const envCanary of [ENV_ORACLE_VERIFIER_CANARY, ENV_ORACLE_KEY_CANARY]) {
        const hits = leafPathsContaining(req.body, envCanary);
        expect(hits, `env canary in a ${req.destination} body (${req.pathTemplate}): ${hits.join(", ")}`).toEqual([]);
      }
    }

    // sanity: the run actually exercised every site under test, not a no-op.
    expect(requests.length).toBeGreaterThan(5);
    expect(printerBodies.length).toBeGreaterThan(0);
  }, 30_000);

  it("[neg] FC-8 round 5b: a NON-shape-valid chain canary (wrong hex length) never appears anywhere — always \"(invalid)\"", async () => {
    const env = {
      PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      PCC_ORACLE_KEY: ENV_ORACLE_KEY_CANARY,
      ORACLE_VERIFIER_ADDRESS: ENV_ORACLE_VERIFIER_CANARY,
    };
    const INVALID_CHAIN_CANARY = "FC8R5B-INVALID-SHAPE-CANARY-vb";

    const requests: CapturedRequest[] = [];
    const printerBodies: unknown[] = [];
    const innerFetch = makeAllFieldsCanaryFetchVerbose(RESPONSE_CANARY, printerBodies);
    const fetchImpl = captureRequests(innerFetch, requests);
    const { wallet, pub } = makeFakeChainWithInvalidHexCanary(INVALID_CHAIN_CANARY);

    const result = await run({
      env, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 1,
      reportPath, contractsDir: CONTRACTS_DIR,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const reportFile = (() => { try { return readFileSync(reportPath, "utf8"); } catch { return ""; } })();
    const allBodiesText = requests.map((r) => JSON.stringify(r.body)).join("\n");
    const all = [printed, errored, result.report, result.log.join("\n"), reportFile, allBodiesText].join("\n").toLowerCase();

    for (const encoded of allEncodings(INVALID_CHAIN_CANARY)) {
      expect(all, `non-shape-valid chain canary leaked: encoding "${encoded}"`).not.toContain(encoded.toLowerCase());
    }
    const hexInvalid = Buffer.from(INVALID_CHAIN_CANARY, "utf8").toString("hex");
    expect(all, "hex-encoded non-shape-valid chain canary leaked").not.toContain(hexInvalid.toLowerCase());

    // publicChainRef must have printed "(invalid)" at every one of those
    // call sites, not silently fallen back to something else.
    expect(result.report).toContain("(invalid)");

    expect(requests.length).toBeGreaterThan(5);
  }, 30_000);
});
