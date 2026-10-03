/**
 * Per-(CSD, tier) evidence ladders (N19): compiled from the CSD's own tiers,
 * pinned by digest, fail-closed on any CSD the event recompute cannot read.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import printAndMail from "../csds/document-print-and-mail.csd.json" with { type: "json" };
import vectors from "../evidence/tier-ladder.vectors.json" with { type: "json" };
import { CsdSchema, type CSD } from "../csd/schema.js";
import { computeContractDigest } from "../csd/capability-contract-identity.js";
import {
  achievedTierFromEventTypes,
  compileTierLadder,
  computeTierLadderDigest,
  PINNED_TIER_LADDER_DIGESTS,
  TierLadderError,
  type TierLadderV1,
} from "../evidence/tier-ladder.js";
import type { TierEvidenceRequirements } from "../types/evidence.js";

const PRINT_AND_MAIL = "pcc://capabilities/document-print-and-mail/v1";
const csd = (): CSD => structuredClone(CsdSchema.parse(printAndMail));
type Tier = { required: string[]; primitives?: { id: string; bind?: string; params?: Record<string, unknown> }[] };
const tierOf = (c: CSD, k: number) => (c.evidence as Record<string, Tier>)[`tier${k}`]!;
const eventsOf = (l: TierLadderV1, k: number) => l.tiers[k]!.requiredEventTypes.map((g) => g[0]);

async function codeOf(c: CSD): Promise<string> {
  try {
    await compileTierLadder(c);
    return "compiled";
  } catch (e) {
    return e instanceof TierLadderError ? e.code : `non-ladder error: ${String(e)}`;
  }
}

describe("tier ladder — document.print-and-mail is pinned", () => {
  it("compiles to the pinned vector and digest, bound to the exact CSD revision", async () => {
    const ladder = await compileTierLadder(csd());
    const vector = vectors.vectors.find((v) => v.ladder.capabilityContractId === PRINT_AND_MAIL)!;
    expect(ladder).toEqual(vector.ladder);
    expect(computeTierLadderDigest(ladder)).toBe(vector.ladderDigest);
    expect(PINNED_TIER_LADDER_DIGESTS[PRINT_AND_MAIL]).toBe(vector.ladderDigest);
    expect(ladder.capabilityContractDigest).toBe(await computeContractDigest(csd()));
  });

  it("tier 2 requires the photo, the anti-spoof check, the job log and the carrier scan as events", async () => {
    const ladder = await compileTierLadder(csd());
    expect(eventsOf(ladder, 0)).toEqual([]);
    expect(eventsOf(ladder, 1)).toEqual(["execution_completed", "printer_job_verified", "printer_log_captured"]);
    expect(eventsOf(ladder, 2)).toEqual([
      "courier_pickup_confirmed",
      "execution_completed",
      "photo_anti_spoof_check",
      "photo_captured",
      "printer_job_verified",
      "printer_log_captured",
    ]);
    expect(eventsOf(ladder, 3)).toContain("courier_delivery_confirmed");
    expect(ladder.tiers[3]!.nonEventRequirements).toContain("recipientSignatureCid");
  });

  it("marking a primitive supporting never removes its bind from the ladder, and the flag is committed", async () => {
    const before = await compileTierLadder(csd());
    const c = csd();
    const photo = tierOf(c, 2).primitives!.find((p) => p.id === "capture.photo_nonced")!;
    photo.params = { ...photo.params, role: "supporting" };
    const after = await compileTierLadder(c);
    expect(eventsOf(after, 2)).toEqual(eventsOf(before, 2));
    expect(after.tiers[2]!.primitives.find((p) => p.id === "capture.photo_nonced")!.supporting).toBe(true);
    expect(computeTierLadderDigest(after)).not.toBe(computeTierLadderDigest(before));
  });

  it("each tier drops into every DEFAULT_TIER_REQUIREMENTS consumer", async () => {
    const tiers: TierEvidenceRequirements[] = (await compileTierLadder(csd())).tiers;
    for (const t of tiers) expect(t.minimumEvents).toBe(t.requiredEventTypes.length);
  });
});

describe("tier ladder — the recompute is the monotone closure over authenticated event types", () => {
  const TIER1 = ["execution_completed", "printer_job_verified", "printer_log_captured"];
  const TIER2 = [...TIER1, "photo_captured", "photo_anti_spoof_check", "courier_pickup_confirmed"];

  it("reaches exactly the highest tier whose every lower tier is also met", async () => {
    const ladder = await compileTierLadder(csd());
    expect(achievedTierFromEventTypes(ladder, [])).toBe(0);
    expect(achievedTierFromEventTypes(ladder, TIER1)).toBe(1);
    expect(achievedTierFromEventTypes(ladder, TIER2.filter((e) => e !== "photo_anti_spoof_check"))).toBe(1);
    expect(achievedTierFromEventTypes(ladder, TIER2)).toBe(2);
    expect(achievedTierFromEventTypes(ladder, [...TIER2, "courier_delivery_confirmed"])).toBe(3);
  });

  it("a higher tier's events cannot skip a missing lower tier", async () => {
    const ladder = await compileTierLadder(csd());
    const noPhoto = [...TIER1, "courier_pickup_confirmed", "courier_delivery_confirmed"];
    expect(achievedTierFromEventTypes(ladder, noPhoto)).toBe(1);
  });

  it("FDM evidence does not reach print-and-mail tier 1", async () => {
    const ladder = await compileTierLadder(csd());
    expect(achievedTierFromEventTypes(ladder, ["gcode_hash_verified", "execution_completed", "power_profile_summary"])).toBe(0);
  });

  it("closure holds for a ladder that is not cumulative, and a missing tier stops the climb", () => {
    // Compiled ladders are cumulative, so closure is only observable on one that is not
    // (a hand-built or mirrored ladder): meeting tier 2 alone must not grant tier 2.
    const t = (tier: number, events: string[]) => ({ tier, requiredEventTypes: events.map((e) => [e]) });
    const disjoint = { tiers: [t(0, []), t(1, ["execution_completed"]), t(2, ["photo_captured"])] } as unknown as TierLadderV1;
    expect(achievedTierFromEventTypes(disjoint, ["photo_captured"])).toBe(0);
    expect(achievedTierFromEventTypes(disjoint, ["execution_completed", "photo_captured"])).toBe(2);
    const gap = { tiers: [t(0, []), t(2, ["photo_captured"])] } as unknown as TierLadderV1;
    expect(achievedTierFromEventTypes(gap, ["photo_captured"])).toBe(0);
  });

  it("no tier is reached when tier 0 itself is unmet", () => {
    const ladder = { tiers: [{ tier: 0 as const, requiredEventTypes: [["execution_completed" as const]] }] } as unknown as TierLadderV1;
    expect(achievedTierFromEventTypes(ladder, [])).toBeNull();
    expect(achievedTierFromEventTypes(ladder, ["execution_completed"])).toBe(0);
  });
});

describe("tier ladder — compilation fails closed", () => {
  it("no evidence tiers", async () => {
    const c = csd();
    delete (c as { evidence?: unknown }).evidence;
    expect(await codeOf(c)).toBe("no-evidence-tiers");
  });

  it("a key that is not tier0..tier3", async () => {
    for (const key of ["tier4", "notes"]) {
      const c = csd();
      (c.evidence as Record<string, unknown>)[key] = structuredClone(tierOf(c, 3));
      expect(await codeOf(c)).toBe("unknown-tier-key");
    }
  });

  it("a gap in the tiers", async () => {
    const c = csd();
    delete (c.evidence as Record<string, unknown>).tier1;
    expect(await codeOf(c)).toBe("tiers-not-contiguous");
  });

  it("a primitive bound to evidence its tier does not require", async () => {
    const c = csd();
    tierOf(c, 2).required = tierOf(c, 2).required.filter((r) => r !== "photo_captured");
    expect(await codeOf(c)).toBe("bind-not-required");
  });

  it("a tier that drops a lower tier's requirement", async () => {
    const c = csd();
    const t3 = tierOf(c, 3);
    t3.required = t3.required.filter((r) => r !== "photo_anti_spoof_check");
    t3.primitives = t3.primitives!.filter((p) => p.bind !== "photo_anti_spoof_check");
    expect(await codeOf(c)).toBe("tier-drops-requirement");
  });

  it("a tier that adds no event type over the tier below (the recompute could not tell them apart)", async () => {
    const c = csd();
    const t3 = tierOf(c, 3);
    t3.required = t3.required.filter((r) => r !== "courier_delivery_confirmed");
    t3.primitives = t3.primitives!.filter((p) => p.bind !== "courier_delivery_confirmed");
    expect(await codeOf(c)).toBe("tier-adds-no-event-type");
  });

  it("malformed tiers", async () => {
    const empty = csd();
    tierOf(empty, 1).required.push("");
    expect(await codeOf(empty)).toBe("malformed-tier");
    const notArray = csd();
    (tierOf(notArray, 1) as unknown as { primitives: unknown }).primitives = { id: "artifact.hash" };
    expect(await codeOf(notArray)).toBe("malformed-tier");
  });

  it("legacy CSDs whose required[] names fields, not events, get no ladder above tier 0", async () => {
    const dir = fileURLToPath(new URL("../csds/", import.meta.url));
    const results: Record<string, string> = {};
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".csd.json")).sort()) {
      results[f] = await codeOf(CsdSchema.parse(JSON.parse(readFileSync(dir + f, "utf8"))));
    }
    expect(results["document-print-and-mail.csd.json"]).toBe("compiled");
    for (const [f, code] of Object.entries(results)) {
      if (f !== "document-print-and-mail.csd.json") expect(code, f).toBe("tier-adds-no-event-type");
    }
  });
});

describe("tier ladder — the digest", () => {
  it("ignores key order and moves with any committed field", async () => {
    const ladder = await compileTierLadder(csd());
    const reordered = Object.fromEntries(Object.entries(ladder).reverse()) as unknown as TierLadderV1;
    expect(computeTierLadderDigest(reordered)).toBe(computeTierLadderDigest(ladder));
    const edited = structuredClone(ladder);
    edited.tiers[1]!.description += ".";
    expect(computeTierLadderDigest(edited)).not.toBe(computeTierLadderDigest(ladder));
  });
});
