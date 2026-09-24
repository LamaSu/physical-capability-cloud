/**
 * #52 machine.execution_log real binding (LO-SE-3, bus #2063) — the verifier
 * wraps `verifyLogChain` and fails CLOSED on every degraded input. One
 * rejecting test per failure class, per the steward's acceptance wording.
 */
import { describe, it, expect } from "vitest";

import {
  makeExecutionLogVerifier,
  industrialVerifiers,
  industrialVerifierStubs,
} from "../evidence/verifiers/oracle-binding.js";
import {
  computeLogEntryHash,
  GENESIS_HASH,
  type LogChainEntryView,
} from "../evidence/verifiers/log-chain.js";
import type { SHA256, Signature, Timestamp } from "../types/common.js";

const GOOD_SIG_PREFIX = "sig-ok:";
const verifyOk = (entryHash: SHA256, signature: Signature) =>
  signature === (`${GOOD_SIG_PREFIX}${entryHash}` as Signature);

async function buildChain(
  contents: string[],
  opts: { startMs?: number; stepMs?: number } = {},
): Promise<LogChainEntryView[]> {
  const startMs = opts.startMs ?? Date.parse("2026-09-08T00:00:00.000Z");
  const stepMs = opts.stepMs ?? 100;
  const out: LogChainEntryView[] = [];
  for (let i = 0; i < contents.length; i++) {
    const capturedAt = new Date(startMs + i * stepMs).toISOString() as Timestamp;
    const rawContent = contents[i]!;
    const source = "test-controller";
    const entryHash = await computeLogEntryHash(rawContent, source, capturedAt);
    out.push({
      entryId: `e${i}`,
      entryHash,
      previousHash: i === 0 ? GENESIS_HASH : out[i - 1]!.entryHash,
      rawContent,
      source,
      capturedAt,
      kernelSignature: `${GOOD_SIG_PREFIX}${entryHash}` as Signature,
    });
  }
  return out;
}

const PARAMS = { logKind: "job_log" };
const CTX = { vocabVersion: 2 };
const v = () => makeExecutionLogVerifier({ verifyKernelSignature: verifyOk });

describe("#52 binding — accepts a real kernel-signed chain", () => {
  it("met:true on a valid 3-entry chain", async () => {
    const res = await v().verify(await buildChain(["a", "b", "c"]), PARAMS, CTX);
    expect(res.met).toBe(true);
    expect(res.detail.join(" ")).toContain("3-entry");
  });

  it("disclosure param is capture-side: accepted with a note, never a gate", async () => {
    const res = await v().verify(
      await buildChain(["a", "b"]),
      { logKind: "job_log", disclosure: "redacted-commit" },
      CTX,
    );
    expect(res.met).toBe(true);
    expect(res.detail.join(" ")).toContain("capture-side");
  });

  it("minCadenceMs met when gaps are within bound", async () => {
    const res = await v().verify(
      await buildChain(["a", "b", "c"], { stepMs: 500 }),
      { logKind: "job_log", minCadenceMs: 1000 },
      CTX,
    );
    expect(res.met).toBe(true);
  });
});

describe("#52 binding — one rejecting test per failure class (fail closed)", () => {
  it("tampered rawContent → entryHash mismatch", async () => {
    const chain = await buildChain(["a", "b", "c"]);
    chain[1] = { ...chain[1]!, rawContent: "TAMPERED" };
    const res = await v().verify(chain, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("entryHash mismatch");
  });

  it("broken link → chain link broken", async () => {
    const chain = await buildChain(["a", "b", "c"]);
    chain[2] = { ...chain[2]!, previousHash: GENESIS_HASH };
    const res = await v().verify(chain, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("chain link broken");
  });

  it("invalid kernel signature → rejected", async () => {
    const chain = await buildChain(["a", "b"]);
    chain[1] = { ...chain[1]!, kernelSignature: "sig-forged" as Signature };
    const res = await v().verify(chain, PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("kernel signature invalid");
  });

  it("empty chain is vacuous → never met", async () => {
    const res = await v().verify([], PARAMS, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("vacuous");
  });

  it("deps.minEntries floor enforced", async () => {
    const strict = makeExecutionLogVerifier({ verifyKernelSignature: verifyOk, minEntries: 2 });
    const res = await strict.verify(await buildChain(["only"]), PARAMS, CTX);
    expect(res.met).toBe(false);
  });

  it("cadence gap beyond minCadenceMs → rejected", async () => {
    const res = await v().verify(
      await buildChain(["a", "b"], { stepMs: 5000 }),
      { logKind: "job_log", minCadenceMs: 1000 },
      CTX,
    );
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("cadence gap");
  });

  it("missing logKind → rejected (required by schema)", async () => {
    const res = await v().verify(await buildChain(["a"]), {}, CTX);
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("logKind");
  });

  it("unknown logKind → rejected", async () => {
    const res = await v().verify(await buildChain(["a"]), { logKind: "syslog" }, CTX);
    expect(res.met).toBe(false);
  });

  it("alarmPolicy declared → fails closed, never silently ignored", async () => {
    const res = await v().verify(
      await buildChain(["a"]),
      { logKind: "alarm_log", alarmPolicy: "none-critical" },
      CTX,
    );
    expect(res.met).toBe(false);
    expect(res.detail.join(" ")).toContain("alarmPolicy");
  });

  it("malformed instance → rejected", async () => {
    const res = await v().verify([{ nonsense: true }], PARAMS, CTX);
    expect(res.met).toBe(false);
  });

  it("null instance → pending (data not yet available, per verifier-interface)", async () => {
    const res = await v().verify(null, PARAMS, CTX);
    expect(res.met).toBe("pending");
  });
});

describe("industrial verifier maps", () => {
  it("industrialVerifiers: #52 real, #53–#55 still fail-closed stubs", async () => {
    const map = industrialVerifiers({ verifyKernelSignature: verifyOk });
    const ok = await map["machine.execution_log"].verify(await buildChain(["a"]), PARAMS, CTX);
    expect(ok.met).toBe(true);
    const stub = await map["telemetry.envelope_conformance"].verify({}, {}, CTX);
    expect(stub.met).toBe(false);
  });

  it("industrialVerifierStubs unchanged: all four fail closed", async () => {
    const map = industrialVerifierStubs();
    for (const id of Object.keys(map) as (keyof ReturnType<typeof industrialVerifierStubs>)[]) {
      const res = await map[id].verify(await buildChain(["a"]), PARAMS, CTX);
      expect(res.met).toBe(false);
    }
  });
});
