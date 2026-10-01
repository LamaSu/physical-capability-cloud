/**
 * N15 round 4 (cross-family review A05b, finding 3, AccountingReconcileKernel):
 * execute() hashed `params.ledgerData` and later ran step 1 against the original
 * object, and runStep() hashed `params.input` and then passed that same original
 * object to the step logic. A Proxy whose descriptors say one thing and whose get
 * trap says another was therefore executed as something other than what the
 * evidence committed to. Both now canonicalize first, parse the canonical text
 * once, and hash and execute that one snapshot.
 */

import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { canonicalize, sha256 } from "@pcc/spec";
import type { EvidenceSource, SessionKey } from "@pcc/spec";
import { AccountingReconcileKernel } from "../accounting-kernel.js";

const sessionPair = nacl.sign.keyPair();
const sessionKey = {
  sessionId: "session-1",
  parentAgentId: "eip155:1:0x0000000000000000000000000000000000000001",
  publicKey: sessionPair.publicKey,
  issuedAt: 0,
  expiresAt: 0,
  scope: { allowedActions: [], contractIds: [], maxSignatures: 1 },
  parentSignature: new Uint8Array(64),
} as unknown as SessionKey;

const SAFE_LEDGER = {
  entries: [{ date: "2026-01-01", description: "rent", amount: 100, account: "cash", reference: "R-1" }],
  periodStart: "2026-01-01",
};
const DANGER_LEDGER = {
  entries: [
    { date: "2026-01-01", description: "danger", amount: 999, account: "cash" },
    { date: "2026-01-02", description: "danger too", amount: -50, account: "cash" },
  ],
  periodStart: "1999-01-01",
};
const SAFE_INVOICES = { invoices: [{ invoiceId: "inv-1", date: "2026-01-01", amount: 100, reference: "R-1" }] };
const DANGER_INVOICES = { invoices: [{ invoiceId: "inv-9", date: "2030-01-01", amount: 12345 }] };

/** Descriptors (what canonicalize reads) say `safe`; the get trap (what a later read sees) says `danger`. */
function liar<T extends object>(safe: T, danger: Record<string, unknown>) {
  const reads = { count: 0 };
  const proxy = new Proxy(safe, {
    get(target, key, receiver) {
      reads.count++;
      return typeof key === "string" && key in danger ? danger[key] : Reflect.get(target, key, receiver);
    },
  });
  return { proxy, reads };
}

const run = (params: { ledgerData: Record<string, unknown>; invoiceData?: Record<string, unknown> }) =>
  new AccountingReconcileKernel("kernel-snapshot-test").execute({
    ...params,
    sessionKey,
    sessionPrivateKey: sessionPair.secretKey,
    jobId: "job-snapshot",
  });

describe("AccountingReconcileKernel — hashes and executes the same snapshot (N15 round 4, A05b #3)", () => {
  it("execute(): a ledger Proxy that lies on get is executed as the snapshot that was hashed", async () => {
    const clean = await run({ ledgerData: SAFE_LEDGER, invoiceData: SAFE_INVOICES });
    const { proxy, reads } = liar(structuredClone(SAFE_LEDGER), DANGER_LEDGER);
    const hostile = await run({ ledgerData: proxy, invoiceData: SAFE_INVOICES });

    expect(hostile.report).toEqual(clean.report); // round 3 reconciled the "danger" ledger
    expect(hostile.stepTraces.map((t) => t.outputHash)).toEqual(clean.stepTraces.map((t) => t.outputHash));
    expect(hostile.stepTraces.map((t) => t.inputHash)).toEqual(clean.stepTraces.map((t) => t.inputHash));
    expect(reads.count).toBe(0);
  });

  it("execute(): an invoice Proxy that lies on get is executed as the snapshot that was hashed", async () => {
    const clean = await run({ ledgerData: SAFE_LEDGER, invoiceData: SAFE_INVOICES });
    const { proxy, reads } = liar(structuredClone(SAFE_INVOICES), DANGER_INVOICES);
    const hostile = await run({ ledgerData: SAFE_LEDGER, invoiceData: proxy });

    expect(hostile.report).toEqual(clean.report);
    expect(hostile.stepTraces.map((t) => t.inputHash)).toEqual(clean.stepTraces.map((t) => t.inputHash));
    expect(reads.count).toBe(0);
  });

  it("execute(): the input commitment is the hash of the snapshot the steps ran on", async () => {
    const { proxy } = liar(structuredClone(SAFE_LEDGER), DANGER_LEDGER);
    const result = await run({ ledgerData: proxy, invoiceData: SAFE_INVOICES });
    const committed = (result.evidenceBundle.events[0].payload as { inputHash: string }).inputHash;
    expect(committed).toBe(await sha256(canonicalize({ ledgerData: SAFE_LEDGER, invoiceData: SAFE_INVOICES })));
    // step 1 hashed exactly the ledger part of that snapshot
    expect(result.stepTraces[0].inputHash).toBe(await sha256(canonicalize(SAFE_LEDGER)));
  });

  it("runStep(): the step logic receives exactly what was hashed, not the original object", async () => {
    const kernel = new AccountingReconcileKernel("kernel-snapshot-test");
    const source: EvidenceSource = { deviceId: "d", deviceType: "digital_agent", kernelId: "k" };
    const { proxy, reads } = liar({ n: 1, tag: "safe" }, { n: 2, tag: "danger" });
    const step = await (kernel as unknown as {
      runStep(p: { stepId: string; source: EvidenceSource; input: unknown; execute: (input: { n: number; tag: string }) => unknown }): Promise<{
        output: unknown;
        trace: { inputHash: string };
      }>;
    }).runStep({
      stepId: "probe",
      source,
      input: proxy,
      execute: (input) => ({ sawN: input.n, sawTag: input.tag }),
    });
    expect(step.output).toEqual({ sawN: 1, sawTag: "safe" }); // round 3 handed the step { sawN: 2, sawTag: "danger" }
    expect(step.trace.inputHash).toBe(await sha256(canonicalize({ n: 1, tag: "safe" })));
    expect(reads.count).toBe(0);
  });

  it("keeps the evidence it wrote before: same hashes and report on plain input", async () => {
    const result = await run({ ledgerData: SAFE_LEDGER, invoiceData: SAFE_INVOICES });
    const committed = (result.evidenceBundle.events[0].payload as { inputHash: string }).inputHash;
    expect(committed).toBe(await sha256(canonicalize({ ledgerData: SAFE_LEDGER, invoiceData: SAFE_INVOICES })));
    expect(result.stepTraces.map((t) => t.stepId)).toEqual([
      "fetch_ledger",
      "parse_entries",
      "match_invoices",
      "compute_adjustments",
      "emit_report",
    ]);
    expect(result.stepTraces[0].inputHash).toBe(await sha256(canonicalize(SAFE_LEDGER)));
    expect(result.report).toMatchObject({ matchedCount: 1, unmatchedLedgerCount: 0, unmatchedInvoiceCount: 0, status: "clean" });
  });

  it("refuses a ledger with no JSON form before any step runs", async () => {
    await expect(run({ ledgerData: { entries: [{ amount: Number.NaN }] } })).rejects.toMatchObject({ name: "NonCanonicalValueError" });
  });
});
