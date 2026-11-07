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

// ---------------------------------------------------------------------------
// N15 round 5 (cross-family review A05c, finding F1)
// ---------------------------------------------------------------------------

/**
 * The snapshot inherited Object.prototype, and execute() and every step read it with
 * ordinary property reads, so a polluted prototype fed the workflow members that were
 * never hashed: an inherited `entries` became the ledger of an empty ledger, an
 * inherited `invoiceData` became invoices the caller never sent. The snapshot is
 * prototype-less now, so a key the input does not own reads as undefined.
 */

/** Object.prototype's own names when this file loaded, before any test could pollute it. */
const OBJECT_PROTOTYPE_AT_LOAD = Object.getOwnPropertyNames(Object.prototype).sort();

/**
 * Install `members` on Object.prototype while `fn` settles and always take them off again, even when
 * `fn` throws, so a failing assertion cannot leak a pollution into another test. The members are
 * non-enumerable so nothing that iterates keys while the awaits are pending can trip over them.
 * Assert only after this returns.
 */
async function withPollutedPrototype<T>(members: Record<PropertyKey, unknown>, fn: () => Promise<T>): Promise<T> {
  const target = Object.prototype as unknown as Record<PropertyKey, unknown>;
  const names = Reflect.ownKeys(members);
  try {
    for (const name of names) {
      Object.defineProperty(Object.prototype, name, { value: members[name], writable: true, enumerable: false, configurable: true });
    }
    return await fn();
  } finally {
    for (const name of names) delete target[name];
  }
}

type Run = Awaited<ReturnType<typeof run>>;
const hashes = (r: Run) => ({
  inputs: r.stepTraces.map((t) => t.inputHash),
  outputs: r.stepTraces.map((t) => t.outputHash),
  committed: (r.evidenceBundle.events[0].payload as { inputHash: string }).inputHash,
});

describe("AccountingReconcileKernel -- a polluted Object.prototype feeds no step anything that was not hashed (N15 round 5, A05c F1)", () => {
  const POISON_ENTRIES = [{ date: "2026-01-01", description: "from the prototype", amount: 999, account: "cash" }];

  it("A05c F1: execute(): the verdict's repro: an inherited `entries` does not feed an empty ledger", async () => {
    const clean = await run({ ledgerData: {} });
    const polluted = await withPollutedPrototype({ entries: POISON_ENTRIES }, () => run({ ledgerData: {} }));
    expect(polluted.report.unmatchedLedgerCount).toBe(0); // faac0003: 1
    expect(polluted.report).toEqual(clean.report);
    expect(hashes(polluted)).toEqual(hashes(clean));
    expect(hashes(polluted).committed).toBe(await sha256(canonicalize({ ledgerData: {} })));
  });

  it("A05c F1: execute(): an inherited `invoiceData` does not stand in for invoices the caller explicitly left out", async () => {
    // `invoiceData: undefined` is omitted from the snapshot, like a member that is not there. Reading it back
    // from an ordinary snapshot would find the inherited one: executed, but never hashed.
    const clean = await run({ ledgerData: SAFE_LEDGER, invoiceData: undefined });
    const polluted = await withPollutedPrototype({ invoiceData: DANGER_INVOICES }, () =>
      run({ ledgerData: SAFE_LEDGER, invoiceData: undefined }),
    );
    expect(polluted.report).toEqual(clean.report); // faac0003 reconciled the inherited invoice
    expect(hashes(polluted)).toEqual(hashes(clean));
  });

  it("whatever execute() reads from its own params is exactly what the input commitment covers, polluted prototype or not", async () => {
    // The params object is the caller's: a key it does not own is read through its prototype, and the value
    // found is part of the snapshot, so it is hashed. That is consistent (what ran is what was hashed).
    const polluted = await withPollutedPrototype({ invoiceData: DANGER_INVOICES }, () => run({ ledgerData: SAFE_LEDGER }));
    expect(hashes(polluted).committed).toBe(await sha256(canonicalize({ ledgerData: SAFE_LEDGER, invoiceData: DANGER_INVOICES })));
    expect(polluted.report.unmatchedInvoiceCount).toBe(1); // inv-9 really was reconciled, and really was committed
  });

  it("A05c F1: execute(): an inherited `invoices` does not complete an invoiceData that carries none", async () => {
    const clean = await run({ ledgerData: SAFE_LEDGER, invoiceData: {} });
    const polluted = await withPollutedPrototype({ invoices: DANGER_INVOICES.invoices }, () =>
      run({ ledgerData: SAFE_LEDGER, invoiceData: {} }),
    );
    expect(polluted.report).toEqual(clean.report);
    expect(hashes(polluted)).toEqual(hashes(clean));
  });

  it("A05c F1: execute(): inherited members do not fill in what a ledger entry or the ledger leaves out", async () => {
    const ledger = { entries: [{ date: "2026-01-01", description: "rent", amount: 5, account: "cash" }] };
    const clean = await run({ ledgerData: ledger });
    const polluted = await withPollutedPrototype({ reference: "R-1", credit: 3, periodStart: "1999-01-01" }, () =>
      run({ ledgerData: ledger }),
    );
    expect(polluted.report).toEqual(clean.report);
    expect(hashes(polluted)).toEqual(hashes(clean));
  });

  it("A05c F1: execute(): an inherited coercion cannot turn a nested object into text that was never hashed", async () => {
    // The ledger steps coerce entry fields with String(). On an ordinary snapshot object that consults
    // Object.prototype, so a polluted @@toPrimitive handed the kernel a description nobody hashed. A snapshot
    // object has no prototype to consult: coercing one is a TypeError (a deliberate consequence of the
    // prototype-less snapshot, where an ordinary object used to read "[object Object]").
    const ledger = { entries: [{ date: "2026-01-01", description: { not: "text" }, amount: 5, account: "cash" }] };
    const outcome = await withPollutedPrototype({ [Symbol.toPrimitive]: () => "FROM-THE-PROTOTYPE" }, () =>
      run({ ledgerData: ledger }).then(
        (result) => ({ ok: true as const, summary: JSON.stringify(result.stepTraces) }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    );
    expect(outcome.ok).toBe(false); // faac0003 completed, with the inherited text as the entry's description
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(TypeError);
    await expect(run({ ledgerData: ledger })).rejects.toBeInstanceOf(TypeError); // and without any pollution
  });

  it("A05c F1: runStep(): the step logic reads no inherited member of the snapshot it was handed", async () => {
    const kernel = new AccountingReconcileKernel("kernel-snapshot-test");
    const source: EvidenceSource = { deviceId: "d", deviceType: "digital_agent", kernelId: "k" };
    const runStep = (kernel as unknown as {
      runStep(p: {
        stepId: string;
        source: EvidenceSource;
        input: unknown;
        execute: (input: Record<string, unknown>) => unknown;
      }): Promise<{ output: unknown; trace: { inputHash: string } }>;
    }).runStep.bind(kernel);
    const step = await withPollutedPrototype({ entries: POISON_ENTRIES, command: "danger" }, () =>
      runStep({
        stepId: "probe",
        source,
        input: {},
        execute: (input) => ({
          sawEntries: input.entries ?? "none",
          sawCommand: input.command ?? "none",
          keys: Object.keys(input),
          has: "entries" in input,
        }),
      }),
    );
    expect(step.output).toEqual({ sawEntries: "none", sawCommand: "none", keys: [], has: false }); // faac0003: the inherited values
    expect(step.trace.inputHash).toBe(await sha256(canonicalize({})));
  });

  it("leaves Object.prototype exactly as it found it (no test above leaks a pollution)", () => {
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(OBJECT_PROTOTYPE_AT_LOAD);
  });
});
