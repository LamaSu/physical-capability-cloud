/**
 * The public EvidenceVerifier checks a bundle against the funded capability's
 * ladder (N19): compileTierLadder(csd).tiers from @pcc/spec. Without one it
 * keeps DEFAULT_TIER_REQUIREMENTS, which is FDM-shaped, so a print-and-mail
 * bundle fails every tier there on gcode_hash_verified. The accepted tier
 * always comes from authenticated caller state, never the bundle's own tier.
 */
import { describe, it, expect } from "vitest";
import {
  compileTierLadder,
  CsdSchema,
  DEFAULT_TIER_REQUIREMENTS,
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

async function bundleOf(types: string[]): Promise<EvidenceBundle> {
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
    assuranceTier: 0, // Unsigned metadata; the caller supplies the accepted tier separately.
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
    const a = await verifier.verify(await bundleOf(TIER1), { acceptedTier: 1 });
    expect(tierFindings(a).some((f) => !f.passed && f.check.includes("gcode_hash_verified"))).toBe(true);
  });

  it("the same bundle meets every tier-1 requirement under the CSD's own ladder", async () => {
    const a = await verifier.verify(await bundleOf(TIER1), { acceptedTier: 1, tierRequirements: await ladder() });
    const checks = tierFindings(a);
    expect(checks.length).toBe(3);
    expect(checks.every((f) => f.passed)).toBe(true);
  });

  it("an accepted tier 2 without the photo evidence fails under the ladder", async () => {
    const a = await verifier.verify(await bundleOf([...TIER1, "courier_pickup_confirmed"]), {
      acceptedTier: 2,
      tierRequirements: await ladder(),
    });
    const failed = tierFindings(a).filter((f) => !f.passed).map((f) => f.check);
    expect(failed).toEqual(["tier_requirement_photo_anti_spoof_check", "tier_requirement_photo_captured"]);
  });

  it("an accepted tier the ladder does not define fails closed instead of passing silently", async () => {
    const tiersZeroToOne = (await ladder()).filter((t) => t.tier <= 1);
    const a = await verifier.verify(await bundleOf(TIER1), { acceptedTier: 2, tierRequirements: tiersZeroToOne });
    expect(a.findings).toContainEqual(
      expect.objectContaining({ check: "tier_requirement_defined", passed: false, severity: "critical" }),
    );
  });

  it("(a) accepted tier 1 uses the funded ladder identically when the bundle's tier is 0, 3 or absent", async () => {
    const tierRequirements = await ladder();
    // Both complete and incomplete evidence must have the same findings across unsigned labels.
    for (const types of [TIER1, TIER1.filter((t) => t !== "printer_log_captured")]) {
      const base = await bundleOf(types);
      const tierZero = { ...base, assuranceTier: 0 } as EvidenceBundle;
      const tierThree = { ...base, assuranceTier: 3 } as EvidenceBundle;
      const withoutTier = { ...base };
      delete (withoutTier as Partial<EvidenceBundle>).assuranceTier;
      const results = [];
      for (const bundle of [tierZero, tierThree, withoutTier]) {
        results.push(await verifier.verify(bundle, { acceptedTier: 1, tierRequirements }));
      }
      for (const a of results) {
        expect(a.findings).toEqual(results[0]!.findings);
        expect(a.attestationHash).toBe(results[0]!.attestationHash);
        expect(tierFindings(a).map((f) => f.check)).toEqual([
          "tier_requirement_execution_completed",
          "tier_requirement_printer_job_verified",
          "tier_requirement_printer_log_captured",
        ]);
        expect(a.result).toBe(types.length === TIER1.length ? "valid" : "invalid");
      }
    }
  });

  it("(b) a funded ladder without an accepted tier fails critically and applies no ladder requirements", async () => {
    const a = await verifier.verify(await bundleOf(TIER1), { tierRequirements: await ladder() });
    expect(a.result).toBe("invalid");
    expect(a.findings).toContainEqual({
      evidenceEventId: "",
      check: "assurance_tier_accepted",
      passed: false,
      details:
        "No accepted tier was supplied: the bundle's own assuranceTier is not signed, so it cannot choose the evidence required",
      severity: "critical",
    });
    expect(tierFindings(a)).toEqual([]);
  });

  it("(c) accepted tier 2 fails critically when the funded ladder only defines tiers 0 and 1", async () => {
    const tierRequirements = (await ladder()).filter((t) => t.tier <= 1);
    const a = await verifier.verify(await bundleOf(TIER1), { acceptedTier: 2, tierRequirements });
    expect(a.result).toBe("invalid");
    expect(a.findings).toContainEqual({
      evidenceEventId: "",
      check: "assurance_tier_accepted",
      passed: true,
      details: "The evidence required is the accepted tier 2's",
    });
    expect(tierFindings(a)).toEqual([{
      evidenceEventId: "",
      check: "tier_requirement_defined",
      passed: false,
      details: "Tier 2 is not defined by the tier requirements in force",
      severity: "critical",
    }]);
  });

  it("(d) without a funded ladder the default table is selected by the accepted tier, as on master", async () => {
    // Tier 0/1 pass, tier 2/3 fail: a bundle labelled 0 cannot lower its accepted requirements.
    const bundle = await bundleOf(["gcode_hash_verified", "execution_completed", "power_profile_summary"]);
    for (const acceptedTier of [0, 1, 2, 3] as const) {
      const fallback = await verifier.verify(bundle, { acceptedTier });
      const explicit = await verifier.verify(bundle, { acceptedTier, tierRequirements: DEFAULT_TIER_REQUIREMENTS });
      expect(fallback.findings).toEqual(explicit.findings);
      expect(fallback.attestationHash).toBe(explicit.attestationHash);
      expect(tierFindings(fallback)).toHaveLength([2, 3, 4, 5][acceptedTier]!);
      expect(fallback.result).toBe(acceptedTier <= 1 ? "valid" : "invalid");
      if (acceptedTier === 2) {
        expect(tierFindings(fallback)).toContainEqual(expect.objectContaining({
          check: "tier_requirement_cv_inspection_result_or_camera_snapshot", passed: false, severity: "critical",
        }));
      }
    }
  });
});
