/**
 * The public EvidenceVerifier checks a bundle against the funded capability's
 * ladder (N19): compileTierLadder(csd).tiers from @pcc/spec. Without one it
 * keeps DEFAULT_TIER_REQUIREMENTS, which is FDM-shaped, so a print-and-mail
 * bundle fails every tier there on gcode_hash_verified.
 */
import { describe, it, expect } from "vitest";
import {
  compileTierLadder,
  CsdSchema,
  hashBundle,
  hashEvent,
  type EvidenceBundle,
  type EvidenceEvent,
  type SHA256,
  type TierEvidenceRequirements,
} from "@pcc/spec";
import printAndMail from "../../../spec/src/csds/document-print-and-mail.csd.json" with { type: "json" };
import { EvidenceVerifier } from "../evidence-verifier.js";

const source = { deviceId: "dev-printer", deviceType: "machine" as const, kernelId: "kernel-pm" };

async function bundleAt(tier: number, types: string[]): Promise<EvidenceBundle> {
  const events: EvidenceEvent[] = [];
  for (const [i, type] of types.entries()) {
    const core = { type, timestamp: `2026-09-24T12:00:0${i}.000Z`, source, payload: { jobId: "job-pm" } };
    events.push({ ...core, id: `ev-${i}`, hash: await hashEvent(core as never) } as unknown as EvidenceEvent);
  }
  return {
    id: "bundle-pm",
    jobId: "job-pm",
    stepId: "step-pm",
    kernelId: "kernel-pm",
    assuranceTier: tier,
    events,
    bundleHash: (await hashBundle(events)) as SHA256,
    kernelSignature: { signer: "0x1234567890123456789012345678901234567890", algorithm: "secp256k1", value: "sig" },
    createdAt: "2026-09-24T12:00:09.000Z",
  } as unknown as EvidenceBundle;
}

const TIER1 = ["execution_completed", "printer_job_verified", "printer_log_captured"];
const tierFindings = (a: { findings: { check: string; passed: boolean }[] }) =>
  a.findings.filter((f) => f.check.startsWith("tier_requirement_"));

describe("EvidenceVerifier — tier requirements from the funded CSD's ladder (N19)", () => {
  const verifier = new EvidenceVerifier("ver-ladder", "0x1234567890123456789012345678901234567890");
  const ladder = async (): Promise<readonly TierEvidenceRequirements[]> =>
    (await compileTierLadder(CsdSchema.parse(printAndMail))).tiers;

  it("the FDM default fails a print-and-mail tier-1 bundle on gcode_hash_verified", async () => {
    const a = await verifier.verify(await bundleAt(1, TIER1));
    expect(tierFindings(a).some((f) => !f.passed && f.check.includes("gcode_hash_verified"))).toBe(true);
  });

  it("the same bundle meets every tier-1 requirement under the CSD's own ladder", async () => {
    const a = await verifier.verify(await bundleAt(1, TIER1), { tierRequirements: await ladder() });
    const checks = tierFindings(a);
    expect(checks.length).toBe(3);
    expect(checks.every((f) => f.passed)).toBe(true);
  });

  it("a tier-2 claim without the photo evidence fails under the ladder", async () => {
    const a = await verifier.verify(await bundleAt(2, [...TIER1, "courier_pickup_confirmed"]), {
      tierRequirements: await ladder(),
    });
    const failed = tierFindings(a).filter((f) => !f.passed).map((f) => f.check);
    expect(failed).toEqual(["tier_requirement_photo_anti_spoof_check", "tier_requirement_photo_captured"]);
  });

  it("a claimed tier the ladder does not define fails closed instead of passing silently", async () => {
    const tiersZeroToOne = (await ladder()).filter((t) => t.tier <= 1);
    const a = await verifier.verify(await bundleAt(2, TIER1), { tierRequirements: tiersZeroToOne });
    expect(a.findings).toContainEqual(
      expect.objectContaining({ check: "tier_requirement_defined", passed: false, severity: "critical" }),
    );
  });
});
