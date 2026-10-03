/**
 * E11c HIGH (cross-family review of #560): an event's `id` and the order of `events` are NOT committed.
 * The bundle hash commits the sorted multiset of event hashes, and each event hash commits `type`,
 * `timestamp`, `source` and `payload`. So neither may change EvidenceVerifier's signed verdict.
 */
import { describe, it, expect } from "vitest";
import { EvidenceVerifier } from "../evidence-verifier.js";
import { hashBundle, hashEvent } from "@pcc/spec";
import type { DigitalWorkflowStep, EvidenceBundle, EvidenceEvent, SHA256, Signature } from "@pcc/spec";

const source = { deviceId: "dev_uncommitted", deviceType: "controller" as const, kernelId: "kernel_uncommitted" };
type Raw = Omit<EvidenceEvent, "id" | "hash">;
const T = (s: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, s)).toISOString();

async function sealed(raw: Raw, id: string): Promise<EvidenceEvent> {
  return { ...raw, id, hash: (await hashEvent(raw as never)) as SHA256 } as EvidenceEvent;
}

async function bundleOf(events: EvidenceEvent[]): Promise<EvidenceBundle> {
  return {
    id: "bun_uncommitted",
    jobId: "job_uncommitted",
    stepId: "step_uncommitted",
    kernelId: "kernel_uncommitted",
    assuranceTier: 1,
    events,
    bundleHash: (await hashBundle(events as never)) as SHA256,
    kernelSignature: {
      signer: "0x1234567890123456789012345678901234567890" as `0x${string}`,
      algorithm: "secp256k1" as const,
      value: "mock_sig",
    } satisfies Signature,
    createdAt: T(0),
  } as EvidenceBundle;
}

/** What decides the verdict: the result and every finding's check, outcome and severity. */
function verdictOf(a: Awaited<ReturnType<EvidenceVerifier["verify"]>>) {
  return {
    result: a.result,
    findings: a.findings.map((f) => `${f.check}:${f.passed}:${f.severity ?? "-"}`).sort(),
  };
}

/** The tier these bundles were accepted at, as a caller passes it from authenticated state (N118). */
const ACCEPTED = { acceptedTier: 1 as const };
const verifier = new EvidenceVerifier("ver_uncommitted", "0x1234567890123456789012345678901234567890");
const steps = [{ stepId: "step-1", stepType: "transform", description: "the one declared step" }] as DigitalWorkflowStep[];

describe("E11c HIGH — an unsigned event id never drives EvidenceVerifier's verdict", () => {
  it("relabelling a step event's id does not cover a declared step: only a committed payload.stepId does", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(1), source, payload: {} }, "ev-start");
    // Everything else in the bundle passes (tier 1's power summary included), so the step alone decides.
    const stepPayload = { durationMs: 10, outputSummary: "transformed ten rows" };
    const stepRaw: Raw = { type: "workflow_step_completed", timestamp: T(3), source, payload: stepPayload };
    const done = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-done");
    const power = await sealed({ type: "power_profile_summary", timestamp: T(6), source, payload: { durationSeconds: 4 } }, "ev-power");
    const unrelated = await bundleOf([gcode, started, await sealed(stepRaw, "unrelated"), done, power]);
    const relabelled = await bundleOf([gcode, started, await sealed(stepRaw, "step-1"), done, power]);
    expect(relabelled.bundleHash).toBe(unrelated.bundleHash);
    const a = verdictOf(await verifier.verify(unrelated, { workflowSteps: steps, acceptedTier: 1 }));
    const b = verdictOf(await verifier.verify(relabelled, { workflowSteps: steps, acceptedTier: 1 }));
    expect(b, "the same signed bundle, relabelled").toEqual(a);
    expect(a.result, "no committed payload.stepId covers the declared step").toBe("invalid");
    // Positive control: a COMMITTED payload.stepId covers the step, and the bundle is valid.
    const committed = await bundleOf([gcode, started, await sealed({ ...stepRaw, payload: { ...stepPayload, stepId: "step-1" } }, "any"), done, power]);
    const c = await verifier.verify(committed, { workflowSteps: steps, acceptedTier: 1 });
    expect(c.findings.filter((f) => !f.passed && f.severity === "critical")).toEqual([]);
    expect(c.result).toBe("valid");
  });
});

describe("E11c HIGH — the order of events never drives EvidenceVerifier's verdict", () => {
  it("a completion before the start is judged the same in every order", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(10), source, payload: {} }, "ev-start");
    const early = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-early");
    const late = await sealed({ type: "execution_completed", timestamp: T(20), source, payload: { success: true } }, "ev-late");
    const orders = [
      [gcode, started, early, late],
      [gcode, started, late, early],
      [late, early, started, gcode],
    ];
    const verdicts = [];
    for (const events of orders) {
      const bundle = await bundleOf(events);
      verdicts.push({ bundleHash: bundle.bundleHash, ...verdictOf(await verifier.verify(bundle, ACCEPTED)) });
    }
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
    // A completion that precedes a start fails closed, whichever order the events arrive in: the
    // duration check itself fails (not only tier 1's missing power summary).
    expect(verdicts[0]!.result).toBe("invalid");
    expect(verdicts[0]!.findings).toContain("execution_duration_positive:false:critical");
  });

  it("a completion between two starts fails closed in every order (the latest start counts)", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const first = await sealed({ type: "execution_started", timestamp: T(0), source, payload: { attempt: 1 } }, "ev-s1");
    const second = await sealed({ type: "execution_started", timestamp: T(10), source, payload: { attempt: 2 } }, "ev-s2");
    const done = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-done");
    const a = verdictOf(await verifier.verify(await bundleOf([gcode, first, second, done]), ACCEPTED));
    const b = verdictOf(await verifier.verify(await bundleOf([gcode, second, first, done]), ACCEPTED));
    expect(b).toEqual(a);
    expect(a.findings).toContain("execution_duration_positive:false:critical");
  });

  it("two power summaries with the same timestamp are told apart by their hash, not their position", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(0), source, payload: {} }, "ev-start");
    const done = await sealed({ type: "execution_completed", timestamp: T(10), source, payload: { success: true } }, "ev-done");
    const p1 = await sealed({ type: "power_profile_summary", timestamp: T(11), source, payload: { durationSeconds: 10 } }, "ev-p1");
    const p2 = await sealed({ type: "power_profile_summary", timestamp: T(11), source, payload: { durationSeconds: 100 } }, "ev-p2");
    const a = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, p1, p2]), ACCEPTED));
    const b = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, p2, p1]), ACCEPTED));
    expect(b).toEqual(a);
  });

  it("the power summary checked does not depend on the order of events", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(0), source, payload: {} }, "ev-start");
    const done = await sealed({ type: "execution_completed", timestamp: T(10), source, payload: { success: true } }, "ev-done");
    const consistent = await sealed({ type: "power_profile_summary", timestamp: T(11), source, payload: { durationSeconds: 10 } }, "ev-p1");
    const inconsistent = await sealed({ type: "power_profile_summary", timestamp: T(12), source, payload: { durationSeconds: 100 } }, "ev-p2");
    const a = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, consistent, inconsistent]), ACCEPTED));
    const b = verdictOf(await verifier.verify(await bundleOf([gcode, started, done, inconsistent, consistent]), ACCEPTED));
    expect(b).toEqual(a);
  });
});

describe("N118 — the bundle's unsigned assuranceTier never chooses the evidence required", () => {
  it("relabelling a tier-1 bundle as tier 0 does not drop tier 1's power-summary requirement (E11d)", async () => {
    const gcode = await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode");
    const started = await sealed({ type: "execution_started", timestamp: T(1), source, payload: {} }, "ev-start");
    const done = await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-done");
    const tier1 = { ...(await bundleOf([gcode, started, done])), assuranceTier: 1 } as EvidenceBundle;
    const tier0 = { ...tier1, assuranceTier: 0 } as EvidenceBundle;
    expect(tier0.bundleHash).toBe(tier1.bundleHash);
    const accepted = { acceptedTier: 1 } as Parameters<EvidenceVerifier["verify"]>[1];
    expect((await verifier.verify(tier1, accepted)).result, "tier 1 requires a power summary").toBe("invalid");
    expect((await verifier.verify(tier0, accepted)).result, "the same signed bundle, relabelled tier 0").toBe("invalid");
  });
});

describe("N118 — the verifier reads nothing unsigned (the property, not a route)", () => {
  /** A sealed tier-1 bundle: VALID with a power summary, INVALID without (tier 1 requires one). */
  async function tier1Bundle(withPower: boolean): Promise<EvidenceBundle> {
    const events = [
      await sealed({ type: "gcode_hash_verified", timestamp: T(0), source, payload: { hash: "abc" } }, "ev-gcode"),
      await sealed({ type: "execution_started", timestamp: T(1), source, payload: {} }, "ev-start"),
      await sealed({ type: "execution_completed", timestamp: T(5), source, payload: { success: true } }, "ev-done"),
    ];
    if (withPower) events.push(await sealed({ type: "power_profile_summary", timestamp: T(6), source, payload: { durationSeconds: 4 } }, "ev-power"));
    return bundleOf(events);
  }
  /** Values that differ from `v`, for an uncommitted field. */
  const mutationsOf = (v: unknown): unknown[] =>
    ["mutated-value", "", 0, 7, null, { injected: true }, ["injected"]].filter((m) => JSON.stringify(m) !== JSON.stringify(v));
  // Committed: the bundleHash (recomputed from the events) and each event's hashed fields and hash.
  // assuranceTier is not committed either: it has its own tests below, because a mismatch is rejected.
  const COMMITTED_BUNDLE = new Set(["events", "bundleHash", "assuranceTier"]);
  const COMMITTED_EVENT = new Set(["type", "timestamp", "source", "payload", "hash"]);

  it("mutating any uncommitted field of a sealed bundle, or of any event, or the order, never changes the verdict", async () => {
    for (const honest of [await tier1Bundle(true), await tier1Bundle(false)]) {
      const base = verdictOf(await verifier.verify(honest, ACCEPTED));
      const variants: Array<[string, EvidenceBundle]> = [];
      for (const key of [...Object.keys(honest), "unsignedExtra"]) {
        if (COMMITTED_BUNDLE.has(key)) continue;
        for (const value of mutationsOf((honest as unknown as Record<string, unknown>)[key])) {
          variants.push([`bundle.${key} = ${JSON.stringify(value)}`, { ...honest, [key]: value } as EvidenceBundle]);
        }
      }
      honest.events.forEach((event, i) => {
        for (const key of [...Object.keys(event), "unsignedExtra"]) {
          if (COMMITTED_EVENT.has(key)) continue;
          for (const value of mutationsOf((event as unknown as Record<string, unknown>)[key])) {
            const events = honest.events.map((e, j) => (j === i ? ({ ...e, [key]: value } as EvidenceEvent) : e));
            variants.push([`events[${i}].${key} = ${JSON.stringify(value)}`, { ...honest, events }]);
          }
        }
      });
      variants.push(["events reversed", { ...honest, events: [...honest.events].reverse() }]);
      expect(variants.length).toBeGreaterThan(40);
      for (const [name, variant] of variants) {
        expect(verdictOf(await verifier.verify(variant, ACCEPTED)), name).toEqual(base);
      }
    }
  });

  it("without an accepted tier the verdict fails closed, and is the same whatever tier the bundle claims", async () => {
    const valid = await tier1Bundle(true);
    const verdicts = [];
    for (const tier of [0, 1, 2, 3]) verdicts.push(verdictOf(await verifier.verify({ ...valid, assuranceTier: tier } as EvidenceBundle)));
    for (const v of verdicts) expect(v).toEqual(verdicts[0]);
    expect(verdicts[0]!.result).toBe("invalid");
    expect(verdicts[0]!.findings).toContain("assurance_tier_accepted:false:critical");
    expect(verdicts[0]!.findings.filter((f) => f.startsWith("tier_requirement_")), "no requirement is chosen without an accepted tier").toEqual([]);
  });

  it("a bundle that claims a tier other than the accepted one is rejected; the matching claim is valid", async () => {
    const valid = await tier1Bundle(true);
    const honest = verdictOf(await verifier.verify(valid, ACCEPTED));
    expect(honest.result).toBe("valid");
    const acceptedRequirements = honest.findings.filter((f) => f.startsWith("tier_requirement_"));
    expect(acceptedRequirements).toContain("tier_requirement_power_profile_summary:true:-");
    for (const tier of [0, 2, 3]) {
      const v = verdictOf(await verifier.verify({ ...valid, assuranceTier: tier } as EvidenceBundle, ACCEPTED));
      expect(v.result, `claims ${tier}`).toBe("invalid");
      expect(v.findings, `claims ${tier}`).toContain("assurance_tier_accepted:false:critical");
      // The evidence required is still the ACCEPTED tier's, whatever tier the bundle claims.
      expect(v.findings.filter((f) => f.startsWith("tier_requirement_")), `claims ${tier}`).toEqual(acceptedRequirements);
    }
    // An accepted tier that is not a tier is no accepted tier at all.
    for (const bad of ["1", 4, -1, 1.5, null]) {
      expect((await verifier.verify(valid, { acceptedTier: bad as never })).result, String(bad)).toBe("invalid");
    }
  });
});
