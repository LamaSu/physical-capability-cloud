/**
 * FC-8 round 4 (astra pack 61c) — the steward's generic test (bus #6482) for
 * scripts/hp-full-chain-e2e.ts. See fc8-round4-real-e2e-verbose.test.ts for
 * the full rationale. ONE test, parameterized over an ID-shaped canary and
 * a space-containing canary, each planted in EVERY response field this
 * script reads. Explicitly captures every outgoing request body, since
 * this script's "printer payload" (the `args.text` sent to the
 * printer_print_text tool-call) embeds the evidence/printResult id.
 *
 * At 68b9f098 this FAILS for both canaries — see
 * returns/pcc-gateway-work/61d-fc8-repro-68b9f098.log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run } from "../../../../scripts/hp-full-chain-e2e.js";
import { makeFakeChain, allEncodings, makeAllFieldsCanaryFetchHpFullChain } from "./support/fc8-round4-fakes.js";

const ID_CANARY = "PCCOracleKey5f1e";
const SPACE_CANARY = "SENTINEL ORACLE KEY 5f1e";
const CONTRACTS_DIR = fileURLToPath(new URL("./support/fake-contracts", import.meta.url));
const REPORT_PATH = "/mnt/sparkbulk/tmp/fc8-r4-hp-full-chain-report.txt";

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

describe.each([
  ["ID-shaped canary", ID_CANARY],
  ["space-containing canary", SPACE_CANARY],
])("FC-8 round 4 — hp-full-chain-e2e.ts — %s in every response field", (_label, canary) => {
  it("[neg] no encoding of the canary leaks, including into the printer payload", async () => {
    const sentBodies: unknown[] = [];
    const { wallet, pub } = makeFakeChain();

    const result = await run({
      env: BASE_ENV,
      fetchImpl: makeAllFieldsCanaryFetchHpFullChain(canary, sentBodies),
      wallet, pub,
      contractsDir: CONTRACTS_DIR,
      reportPath: REPORT_PATH,
    });

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errored = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    const reportFile = (() => { try { return readFileSync(REPORT_PATH, "utf8"); } catch { return ""; } })();
    const sent = sentBodies.map((b) => (typeof b === "string" ? b : JSON.stringify(b))).join("\n");

    const all = [printed, errored, result.report, reportFile, sent].join("\n").toLowerCase();

    for (const encoded of allEncodings(canary)) {
      expect(all, `encoding "${encoded}" of canary leaked`).not.toContain(encoded.toLowerCase());
    }
  }, 30_000);
});
