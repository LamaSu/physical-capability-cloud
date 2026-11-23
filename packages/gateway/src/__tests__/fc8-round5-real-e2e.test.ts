/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — dynamic
 * proof for scripts/real-e2e.ts. See fc8-round5-real-e2e-verbose.test.ts
 * for the full rationale (items 4, 5, 6); this mirrors it for real-e2e.ts's
 * smaller env/endpoint surface (no reportPath dependency here — this
 * script never writes a report file).
 *
 * At 4dbafd7f: ORACLE_VERIFIER_ADDRESS is printed raw and the chain-hex
 * canary (tx hash/address/topic) is printed raw — see the verdict's
 * additional blocking finding ("real-e2e.ts logs the environment-derived
 * verifier address (:186-187) and numerous raw dependency-returned hashes
 * and addresses (:179-220)").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/real-e2e.js";
import { makeAllFieldsCanaryFetchRealE2e } from "./support/fc8-round4-fakes.js";
import {
  allEncodings, captureRequests, leafPathsContaining, makeFakeChainWithHexCanary,
  makeFakeChainWithInvalidHexCanary, type CapturedRequest,
} from "./support/fc8-round5-fakes.js";

const RESPONSE_CANARY = "PCCOracleKey5f1e";
const CHAIN_CANARY = "FC8R5-CHAIN-CANARY-real-e2e";
const ENV_ORACLE_VERIFIER_CANARY = "FC8R5-ENV-ORACLE-VERIFIER-re2e-71fa";
const ENV_ORACLE_KEY_CANARY = "FC8R5-ENV-ORACLE-KEY-re2e-30dd";
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));

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

describe("FC-8 round 5 — real-e2e.ts — env canaries, chain-hex canary, full request capture", () => {
  it("[neg] no env canary leaks to stdout or any body; FC-8 round 5b: a SHAPE-VALID chain-hex canary now MAY appear verbatim on stdout/in the report, but still MUST NOT appear in the printer-bound request body", async () => {
    const env = {
      PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      PCC_ORACLE_KEY: ENV_ORACLE_KEY_CANARY,
      ORACLE_VERIFIER_ADDRESS: ENV_ORACLE_VERIFIER_CANARY,
    };

    const requests: CapturedRequest[] = [];
    const innerFetch = makeAllFieldsCanaryFetchRealE2e(RESPONSE_CANARY, []);
    const fetchImpl = captureRequests(innerFetch, requests);
    const { wallet, pub } = makeFakeChainWithHexCanary(CHAIN_CANARY);

    const result = await run({
      env, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 1, contractsDir: CONTRACTS_DIR,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const allBodiesText = requests.map((r) => JSON.stringify(r.body)).join("\n");
    // FC-8 round 5b: stdout/the report are the ONLY sinks the ruling
    // allows a chain value verbatim in — kept separate from request-body
    // text (this script's only printer-bound body is the final print
    // job's `parameters.content`, scrubbed via redactChainValuesFromText
    // before it is sent) so presence/absence can be asserted precisely.
    const stdoutAndReport = [printed, errored, written, result.report].join("\n").toLowerCase();
    const all = [stdoutAndReport, allBodiesText].join("\n").toLowerCase();

    // Unaffected by the round-5b ruling (chain values only).
    for (const envCanary of [ENV_ORACLE_VERIFIER_CANARY, ENV_ORACLE_KEY_CANARY]) {
      for (const encoded of allEncodings(envCanary)) {
        expect(all, `env canary leaked: encoding "${encoded}" of ${envCanary}`).not.toContain(encoded.toLowerCase());
      }
    }

    // FC-8 round 5b: the shape-valid chain-hex canary now prints VERBATIM
    // on stdout/in the report, via publicChainRef — superseding round 5's
    // opposite assertion here (that assertion was correct for round 5's
    // default; this round's ruling changes the default itself).
    const hexChain = Buffer.from(CHAIN_CANARY, "utf8").toString("hex");
    expect(stdoutAndReport, "shape-valid chain-hex canary should now appear verbatim on stdout/in the report").toContain(hexChain.toLowerCase());
    // ...but it must still never reach the printer-bound request body —
    // this script has no other body that could carry it (the oracle body
    // uses the real ESCROW/evidenceHash values directly, unaffected by
    // this scrub; see leafPathsContaining checks below for env canaries).
    expect(allBodiesText, "chain-hex canary leaked into a request body (printer-bound content is the only risk here)").not.toContain(hexChain.toLowerCase());

    for (const req of requests) {
      for (const envCanary of [ENV_ORACLE_VERIFIER_CANARY, ENV_ORACLE_KEY_CANARY]) {
        const hits = leafPathsContaining(req.body, envCanary);
        expect(hits, `env canary in a ${req.destination} body (${req.pathTemplate}): ${hits.join(", ")}`).toEqual([]);
      }
    }

    expect(requests.length).toBeGreaterThan(2);
  }, 30_000);

  it("[neg] FC-8 round 5b: a NON-shape-valid chain canary (wrong hex length) never appears anywhere — always \"(invalid)\"", async () => {
    const env = {
      PCC_GATEWAY_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      PCC_ORACLE_KEY: ENV_ORACLE_KEY_CANARY,
      ORACLE_VERIFIER_ADDRESS: ENV_ORACLE_VERIFIER_CANARY,
    };
    const INVALID_CHAIN_CANARY = "FC8R5B-INVALID-SHAPE-CANARY-re2e";

    const requests: CapturedRequest[] = [];
    const innerFetch = makeAllFieldsCanaryFetchRealE2e(RESPONSE_CANARY, []);
    const fetchImpl = captureRequests(innerFetch, requests);
    const { wallet, pub } = makeFakeChainWithInvalidHexCanary(INVALID_CHAIN_CANARY);

    const result = await run({
      env, fetchImpl, wallet, pub,
      pollSleepMs: 0, pollAttempts: 1, contractsDir: CONTRACTS_DIR,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const allBodiesText = requests.map((r) => JSON.stringify(r.body)).join("\n");
    const all = [printed, errored, written, result.report, allBodiesText].join("\n").toLowerCase();

    for (const encoded of allEncodings(INVALID_CHAIN_CANARY)) {
      expect(all, `non-shape-valid chain canary leaked: encoding "${encoded}"`).not.toContain(encoded.toLowerCase());
    }
    const hexInvalid = Buffer.from(INVALID_CHAIN_CANARY, "utf8").toString("hex");
    expect(all, "hex-encoded non-shape-valid chain canary leaked").not.toContain(hexInvalid.toLowerCase());
    expect(result.report).toContain("(invalid)");

    expect(requests.length).toBeGreaterThan(2);
  }, 30_000);
});
