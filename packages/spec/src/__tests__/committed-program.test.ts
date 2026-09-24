import { describe, it, expect } from "vitest";
import printAndMailCsd from "../csds/document-print-and-mail.csd.json" with { type: "json" };
import {
  COMMITTED_PROGRAM_REGISTRY,
  PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM,
  PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
  assertAcceptedProgramForTier,
  checkCommittedProgramForTier,
  computeCommittedProgramHash,
  resolveAcceptedProgram,
  tierNumber,
  type CommittedProgram,
  type CommittedProgramEntry,
} from "../evidence/committed-program.js";
import type { CsdEvidenceTier } from "../csd/schema.js";

const CSD = "document-print-and-mail";
const tiers = (printAndMailCsd as unknown as { evidence: Record<string, CsdEvidenceTier> }).evidence;

/** The v3 independence program, whose print leg was bare printer_job_verified. */
const V3_INDEPENDENCE: CommittedProgram = {
  version: 1,
  schemaHash: "verification-program/v1",
  stages: [
    { id: "print", predicate: "event-present", eventType: "printer_job_verified" },
    {
      id: "mail",
      predicate: "event-present-independent",
      eventType: "courier_pickup_confirmed",
      allowedProvenance: ["independent_carrier_scan"],
    },
    { id: "auth", predicate: "not-simulated" },
  ],
};

const PRINT_ONLY: CommittedProgram = {
  version: 1,
  schemaHash: "verification-program/v1",
  stages: [
    { id: "print-ok", predicate: "event-present", eventType: "execution_completed" },
    { id: "print-not-failed", predicate: "event-absent", eventType: "execution_failed" },
    { id: "auth", predicate: "not-simulated" },
  ],
};

const entry = (tier: string, program: CommittedProgram): CommittedProgramEntry => ({
  csd: CSD,
  tier,
  program,
  programHash: computeCommittedProgramHash(program),
});

describe("committed programs — hashes reproduce the published pins", () => {
  it("v4 independence and honest-asymmetry programs hash to their pins", () => {
    expect(computeCommittedProgramHash(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM)).toBe(
      PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
    );
    expect(computeCommittedProgramHash(PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM)).toBe(
      PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH,
    );
  });

  it("the same formula reproduces the v3 pin the oracle confirmed", () => {
    expect(computeCommittedProgramHash(V3_INDEPENDENCE)).toBe(
      "0xe1cac43536cae93c76510c76fa99ca234ad0113e4464a1bd0cd4c9f7d16ff100",
    );
  });

  it("every registry entry's hash is its program's hash", () => {
    for (const e of COMMITTED_PROGRAM_REGISTRY) {
      expect(computeCommittedProgramHash(e.program), `${e.csd}/${e.tier}`).toBe(e.programHash);
    }
  });
});

describe("checkCommittedProgramForTier — against the real print-and-mail CSD", () => {
  it("tier2 + the v4 independence program: no violations; the unchecked tier evidence is named", () => {
    const check = checkCommittedProgramForTier(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM, tiers.tier2!);
    expect(check.violations).toEqual([]);
    expect(check.unenforcedTierEvidence).toEqual([
      "photo_anti_spoof_check",
      "photo_captured",
      "printer_log_captured",
    ]);
  });

  it("the v3 program (released on printer_job_verified) is refused for tier2", () => {
    const check = checkCommittedProgramForTier(V3_INDEPENDENCE, tiers.tier2!);
    expect(check.violations).toEqual([
      { code: "positive-stage-on-supporting-evidence", stageId: "print", eventType: "printer_job_verified" },
      { code: "positive-stage-proves-no-level", stageId: "print", eventType: "printer_job_verified" },
      { code: "no-device-reported-stage" },
    ]);
  });

  it("a program that releases on mail cannot back tier1, which binds no carrier event", () => {
    const check = checkCommittedProgramForTier(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM, tiers.tier1!);
    expect(check.violations).toEqual([
      { code: "positive-stage-not-bound-by-tier", stageId: "mail", eventType: "courier_pickup_confirmed" },
    ]);
  });

  it("the print-only program fits tier1", () => {
    expect(checkCommittedProgramForTier(PRINT_ONLY, tiers.tier1!).violations).toEqual([]);
  });

  it("a non-zero-tier program must exclude simulated evidence", () => {
    const noAuth = { ...PRINT_ONLY, stages: PRINT_ONLY.stages.filter((s) => s.predicate !== "not-simulated") };
    expect(checkCommittedProgramForTier(noAuth, tiers.tier1!).violations).toEqual([
      { code: "missing-not-simulated" },
    ]);
  });

  it("completion must be paired with the absence of failure", () => {
    const noAbsence = { ...PRINT_ONLY, stages: PRINT_ONLY.stages.filter((s) => s.predicate !== "event-absent") };
    expect(checkCommittedProgramForTier(noAbsence, tiers.tier1!).violations).toEqual([
      { code: "completion-without-failure-absence" },
    ]);
  });

  it("rejects unknown predicates, missing event types and non-vocabulary events", () => {
    const bad: CommittedProgram = {
      version: 1,
      schemaHash: "verification-program/v1",
      stages: [
        ...PRINT_ONLY.stages,
        { id: "x1", predicate: "event-count" as never, eventType: "execution_completed" },
        { id: "x2", predicate: "event-present" },
        { id: "x3", predicate: "event-present", eventType: "job_started" },
      ],
    };
    expect(checkCommittedProgramForTier(bad, tiers.tier1!).violations).toEqual([
      { code: "unknown-predicate", stageId: "x1" },
      { code: "stage-missing-event-type", stageId: "x2" },
      { code: "stage-event-not-in-vocabulary", stageId: "x3", eventType: "job_started" },
    ]);
  });
});

describe("resolveAcceptedProgram — one program per (CSD, non-zero tier), else fail closed", () => {
  it("tier0 needs no program", () => {
    expect(resolveAcceptedProgram(CSD, "tier0")).toEqual({ ok: true, program: null, programHash: null });
  });

  it("tier2 resolves to the independence program", () => {
    expect(resolveAcceptedProgram(CSD, "tier2")).toEqual({
      ok: true,
      program: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM,
      programHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
    });
  });

  it("tiers, CSDs and keys without a committed program fail closed", () => {
    for (const [csd, tier] of [
      [CSD, "tier1"],
      [CSD, "tier3"],
      ["2d-print", "tier1"],
      [CSD, "gold"],
    ] as const) {
      expect(resolveAcceptedProgram(csd, tier), `${csd}/${tier}`).toEqual({
        ok: false,
        code: "no-committed-program",
      });
    }
  });

  it("an ambiguous registry (two programs for one tier) fails closed", () => {
    const twice = [entry("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM), entry("tier2", PRINT_ONLY)];
    expect(resolveAcceptedProgram(CSD, "tier2", twice)).toEqual({ ok: false, code: "no-committed-program" });
  });

  it("parses tier keys", () => {
    expect([tierNumber("tier0"), tierNumber("tier3"), tierNumber("T2"), tierNumber("tier")]).toEqual([
      0, 3, null, null,
    ]);
  });
});

describe("assertAcceptedProgramForTier — the pre-funding gate (required negatives)", () => {
  const gate = (
    tierKey: string,
    committedProgramHash: string | null,
    registry: readonly CommittedProgramEntry[] = COMMITTED_PROGRAM_REGISTRY,
  ) =>
    assertAcceptedProgramForTier(
      { csd: CSD, tierKey, tier: tiers[tierKey]!, committedProgramHash },
      registry,
    );

  it("tier2 with its exact program hash is accepted (hex case is not meaningful)", () => {
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH)).toEqual({ ok: true });
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH.toUpperCase().replace("0X", "0x"))).toEqual({
      ok: true,
    });
  });

  it("tier2 carrying the weaker honest-asymmetry program is refused", () => {
    expect(gate("tier2", PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH)).toEqual({
      ok: false,
      code: "program-hash-mismatch",
    });
  });

  it("a tier upgrade without its own program is refused (tier3 carrying tier2's program)", () => {
    expect(gate("tier3", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH)).toEqual({
      ok: false,
      code: "no-committed-program",
    });
  });

  it("downgrade and upgrade between two committed tiers are both refused", () => {
    const registry = [entry("tier1", PRINT_ONLY), entry("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM)];
    expect(gate("tier2", computeCommittedProgramHash(PRINT_ONLY), registry)).toEqual({
      ok: false,
      code: "program-hash-mismatch",
    });
    expect(gate("tier1", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, registry)).toEqual({
      ok: false,
      code: "program-hash-mismatch",
    });
    expect(gate("tier1", computeCommittedProgramHash(PRINT_ONLY), registry)).toEqual({ ok: true });
  });

  it("a non-zero tier with no program hash is refused", () => {
    expect(gate("tier2", null)).toEqual({ ok: false, code: "program-hash-mismatch" });
  });

  it("tier0 takes no program, and refuses one", () => {
    expect(gate("tier0", null)).toEqual({ ok: true });
    expect(gate("tier0", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH)).toEqual({
      ok: false,
      code: "program-on-tier-zero",
    });
  });

  it("a registry entry whose hash is not its program's hash is refused", () => {
    const forged = [{ ...entry("tier2", PRINT_ONLY), programHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH }];
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, forged)).toEqual({
      ok: false,
      code: "registry-hash-mismatch",
    });
  });

  it("a registered program that does not fit its tier is refused at the gate", () => {
    const misfiled = [entry("tier1", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM)];
    expect(gate("tier1", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, misfiled)).toMatchObject({
      ok: false,
      code: "program-fails-tier-check",
      violations: [{ code: "positive-stage-not-bound-by-tier", stageId: "mail" }],
    });
  });
});
