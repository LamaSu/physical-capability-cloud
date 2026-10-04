/**
 * FC-8 round 4 (astra pack 61c) — the steward's generic test (bus #6482) for
 * scripts/real-e2e-verbose.ts. ONE test, parameterized over an ID-shaped
 * canary and a space-containing canary, each planted in EVERY response
 * field the script reads (support/fc8-round4-fakes.ts). Asserts the raw
 * value AND its URI/base64/hex encodings are absent from stdout, stderr,
 * the returned report, the written report file, and every request body the
 * script would have sent (covers the printer payload, since the printer
 * job's content IS the report, and also catches any other outgoing body).
 *
 * This supersedes the per-field-canary tests from round 3
 * (fc8-round3-real-e2e-verbose.test.ts, kept for its malformed/failure/
 * rejection coverage) which astra's round-4 review found gave safeLogId and
 * safeLogUrlPath a canary shaped so it would always pass validation.
 *
 * At 68b9f098 this FAILS for both canaries — see
 * returns/pcc-gateway-work/61d-fc8-repro-68b9f098.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/real-e2e-verbose.js";
import { makeFakeChain, allEncodings, makeAllFieldsCanaryFetchVerbose } from "./support/fc8-round4-fakes.js";

const ID_CANARY = "PCCOracleKey5f1e";
const SPACE_CANARY = "SENTINEL ORACLE KEY 5f1e";
const REPORT_PATH = "/mnt/sparkbulk/tmp/fc8-r4-verbose-report.txt";
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

describe.each([
  ["ID-shaped canary", ID_CANARY],
  ["space-containing canary", SPACE_CANARY],
])("FC-8 round 4 — real-e2e-verbose.ts — %s in every response field", (_label, canary) => {
  it("[neg] no encoding of the canary reaches stdout, stderr, the report, or any sent body", async () => {
    const sentBodies: unknown[] = [];
    const { wallet, pub } = makeFakeChain();

    const result = await run({
      env: BASE_ENV,
      fetchImpl: makeAllFieldsCanaryFetchVerbose(canary, sentBodies),
      wallet, pub,
      pollSleepMs: 0, pollAttempts: 1,
      reportPath: REPORT_PATH,
      contractsDir: CONTRACTS_DIR,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const reportFile = (() => { try { return readFileSync(REPORT_PATH, "utf8"); } catch { return ""; } })();
    const sent = sentBodies.map((b) => (typeof b === "string" ? b : JSON.stringify(b))).join("\n");

    const all = [printed, errored, result.report, result.log.join("\n"), reportFile, sent]
      .join("\n")
      .toLowerCase();

    for (const encoded of allEncodings(canary)) {
      expect(all, `encoding "${encoded}" of canary leaked`).not.toContain(encoded.toLowerCase());
    }
  }, 30_000);
});
