import { describe, it, expect } from "vitest";
import printAndMailCsd from "../csds/document-print-and-mail.csd.json" with { type: "json" };
import {
  COMMITTED_PROGRAM_REGISTRY,
  INDEPENDENT_PROVENANCE,
  PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM,
  PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
  assertAcceptedProgramForTier,
  assertAcceptedProgramForTierWith,
  requiredRegistryPins,
  checkCommittedProgramForTier,
  computeCommittedProgramHash,
  resolveAcceptedProgram,
  tierNumber,
  type AcceptedProgramGateInput,
  type CommittedProgram,
  type CommittedProgramEntry,
} from "../evidence/committed-program.js";
import * as committedProgramModule from "../evidence/committed-program.js";
import * as evidenceIndex from "../evidence/index.js";
import * as packageRoot from "../index.js";
import { DIGEST_PATTERN, deriveCapabilityContractRoot, validatePlan, type MatchedDAG } from "../csd/composition-commitment.js";
import { computeCsdEligibility } from "../evidence/eligibility.js";
import { EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";
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

/**
 * print-and-mail with the fixes eligibility asks for: ident.registered_key where
 * a signed primitive depends on it, and a Family-G primitive at tier2. Tier3
 * still lists primitives that do not support tier 3, so it stays ineligible.
 */
function fixedTiers(): Record<string, CsdEvidenceTier> {
  const t = structuredClone(tiers);
  for (const k of ["tier1", "tier2", "tier3"]) {
    t[k]!.primitives!.push({ id: "ident.registered_key", params: { registryId: KERNEL_KEYS } });
  }
  for (const k of ["tier2", "tier3"]) t[k]!.primitives!.push({ id: "approval.payer" });
  return t;
}
const KERNEL_KEYS = "pcc.registry.kernel-signing-keys.v1";
const KERNEL_KEY_PIN = [{ primitiveId: "ident.registered_key", registryId: KERNEL_KEYS }];
/** The v1 vocabulary as it reads once every verifier is registered and live. */
const LIVE = new Map(EVIDENCE_PRIMITIVES.map((d) => [d.id, { ...d, verifierStatus: "live" as const }]));

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
  // These negatives exercise the program legs, so they fund a CSD that is
  // eligible with live verifiers; the eligibility leg has its own block below.
  const gate = (
    tierKey: string,
    committedProgramHash: string | null,
    registry: readonly CommittedProgramEntry[] = COMMITTED_PROGRAM_REGISTRY,
  ) =>
    assertAcceptedProgramForTierWith(
      { csd: CSD, tierKey, evidence: fixedTiers(), committedProgramHash },
      registry,
      { primitiveIndex: LIVE },
    );

  it("tier2 with its exact program hash is accepted (hex case is not meaningful)", () => {
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH.toUpperCase().replace("0X", "0x"))).toEqual({
      ok: true,
      registryPins: KERNEL_KEY_PIN,
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
    expect(gate("tier1", computeCommittedProgramHash(PRINT_ONLY), registry)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
  });

  it("a non-zero tier with no program hash is refused", () => {
    expect(gate("tier2", null)).toEqual({ ok: false, code: "program-hash-mismatch" });
  });

  it("tier0 takes no program, and refuses one", () => {
    expect(gate("tier0", null)).toEqual({ ok: true, registryPins: [] });
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

describe("assertAcceptedProgramForTier — the funded tier must be verifiable end to end (N19)", () => {
  const gate = (
    tierKey: string,
    committedProgramHash: string | null,
    evidence: Record<string, CsdEvidenceTier>,
    primitiveIndex?: typeof LIVE,
  ) => assertAcceptedProgramForTierWith({ csd: CSD, tierKey, evidence, committedProgramHash }, COMMITTED_PROGRAM_REGISTRY, { primitiveIndex });

  it("print-and-mail as authored cannot be funded at tier2, and the reasons say why", () => {
    const r = gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, tiers);
    expect(r).toMatchObject({ ok: false, code: "tier-not-eligible" });
    const reasons = (r as { reasons: string[] }).reasons.join("\n");
    expect(reasons).toContain('depends on "ident.registered_key"');
    expect(reasons).toContain("human-attestation");
    expect(reasons).toContain('"capture.photo_nonced" verifier not implemented');
  });

  it("the fixed CSD is still refused while its verifiers are stubs", () => {
    const r = gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, fixedTiers());
    expect(r).toMatchObject({ ok: false, code: "tier-not-eligible" });
    expect((r as { reasons: string[] }).reasons.every((x) => x.includes("verifier not implemented"))).toBe(true);
  });

  it("the fixed CSD with every verifier live is funded", () => {
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, fixedTiers(), LIVE)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
  });

  it("eligibility covers tiers 0..T: a tier1 that is only self-attested blocks tier2", () => {
    const t = fixedTiers();
    t.tier1!.primitives = [{ id: "decl.self_attested" }];
    const r = gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, t, LIVE);
    expect(r).toMatchObject({ ok: false, code: "tier-not-eligible" });
    expect((r as { reasons: string[] }).reasons.join("\n")).toContain("tier1: only decl.self_attested");
  });

  it("a CSD eligible exactly one tier below the funded tier is refused", () => {
    const t = fixedTiers();
    t.tier2!.primitives = t.tier2!.primitives!.filter((p) => p.id !== "approval.payer");
    const r = gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, t, LIVE);
    expect(r).toMatchObject({ ok: false, code: "tier-not-eligible" });
    expect((r as { reasons: string[] }).reasons).toEqual(["tier2: no human-attestation (Family-G) primitive — the tier≥2 human floor"]);
  });

  it("a missing lower tier blocks the funded tier, and the refusal names it", () => {
    const t = fixedTiers();
    delete t.tier1;
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, t, LIVE)).toEqual({
      ok: false,
      code: "tier-not-in-csd",
      reasons: ["tier1 is not declared in the CSD being funded, and funding tier2 needs tiers 0..2"],
    });
  });

  it("the funded tier must be in the CSD being funded", () => {
    const t = fixedTiers();
    delete t.tier2;
    expect(gate("tier2", PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, t, LIVE)).toEqual({
      ok: false,
      code: "tier-not-in-csd",
      reasons: ["tier2 is not declared in the CSD being funded, and funding tier2 needs tiers 0..2"],
    });
  });

  it("tier0 stays fundable with no program", () => {
    expect(gate("tier0", null, tiers)).toEqual({ ok: true, registryPins: [] });
  });
});

describe("requiredRegistryPins — what the accepted deal must pin (bus #3391)", () => {
  it("dedupes across tiers, sorts by primitiveId then registryId, and ignores non-registry primitives", () => {
    const t = fixedTiers();
    t["tier2"]!.primitives!.push({ id: "ident.registered_key", params: { registryId: "pcc.registry.a.v1" } });
    t["tier2"]!.primitives!.push({ id: "artifact.hash", params: { registryId: "pcc.registry.ignored.v1" } } as never);
    expect(requiredRegistryPins(t, 2)).toEqual({
      ok: true,
      pins: [
        { primitiveId: "ident.registered_key", registryId: "pcc.registry.a.v1" },
        { primitiveId: "ident.registered_key", registryId: KERNEL_KEYS },
      ],
    });
    expect(requiredRegistryPins(t, 0)).toEqual({ ok: true, pins: [] });
  });

  it("a registry-backed primitive that names no registry is refused, at the gate too", () => {
    const t = fixedTiers();
    t["tier1"]!.primitives = t["tier1"]!.primitives!.map((p) => (p.id === "ident.registered_key" ? { id: p.id } : p));
    expect(requiredRegistryPins(t, 1)).toEqual({
      ok: false,
      reasons: ['tier1: "ident.registered_key" names no registryId, so the deal cannot pin its registry'],
    });
    expect(requiredRegistryPins(t, 0)).toEqual({ ok: true, pins: [] });
    const r = assertAcceptedProgramForTierWith(
      { csd: CSD, tierKey: "tier2", evidence: t, committedProgramHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH },
      COMMITTED_PROGRAM_REGISTRY,
      { primitiveIndex: LIVE },
    );
    expect(r).toMatchObject({ ok: false, code: "registry-not-named" });
  });

  it("a registryId outside 1-128 printable ASCII characters is refused, at the gate too (composition v3, #4568)", () => {
    const withId = (registryId: string) => {
      const t = fixedTiers();
      t["tier1"]!.primitives = t["tier1"]!.primitives!.map((p) => (p.id === "ident.registered_key" ? { id: p.id, params: { registryId } } : p));
      return t;
    };
    for (const bad of ["pcc.registry." + String.fromCharCode(0x212a) + ".v1", "pcc registry", "pcc.registry.v1" + String.fromCharCode(0x7f), "x".repeat(129)]) {
      const r = requiredRegistryPins(withId(bad), 1);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      const g = assertAcceptedProgramForTierWith(
        { csd: CSD, tierKey: "tier2", evidence: withId(bad), committedProgramHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH },
        COMMITTED_PROGRAM_REGISTRY,
        { primitiveIndex: LIVE },
      );
      expect(g, JSON.stringify(bad)).toMatchObject({ ok: false, code: "registry-not-named" });
    }
    expect(requiredRegistryPins(withId("x".repeat(128)), 1)).toEqual({
      ok: true,
      pins: [{ primitiveId: "ident.registered_key", registryId: "x".repeat(128) }],
    });
  });
});

describe("assertAcceptedProgramForTier — the production gate takes no overrides (E8 F4)", () => {
  /** The production gate through a cast: JS, or a cast, can still hand it a 2nd and 3rd argument. */
  const smuggle = assertAcceptedProgramForTier as unknown as (input: unknown, registry?: unknown, options?: unknown) => unknown;
  const input = (evidence: Record<string, CsdEvidenceTier> = fixedTiers()) => ({
    csd: CSD,
    tierKey: "tier2",
    evidence,
    committedProgramHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
  });

  it("declares exactly one parameter", () => {
    expect(assertAcceptedProgramForTier.length).toBe(1);
  });

  it("an all-live primitive index passed as a 3rd argument is ignored: tier2 is still not eligible", () => {
    const r = smuggle(input(), COMMITTED_PROGRAM_REGISTRY, { primitiveIndex: LIVE });
    expect(r).toMatchObject({ ok: false, code: "tier-not-eligible" });
    expect((r as { reasons: string[] }).reasons.length).toBeGreaterThan(0);
    expect((r as { reasons: string[] }).reasons.every((x) => x.includes("verifier not implemented"))).toBe(true);
    // The same call through the test-only form funds it, which is exactly why that form is test-only.
    expect(assertAcceptedProgramForTierWith(input(), COMMITTED_PROGRAM_REGISTRY, { primitiveIndex: LIVE })).toEqual({
      ok: true,
      registryPins: KERNEL_KEY_PIN,
    });
  });

  it("a registry passed as a 2nd argument is ignored: only COMMITTED_PROGRAM_REGISTRY resolves programs", () => {
    const weaker = [entry("tier2", PRINT_ONLY)];
    const r = smuggle({ ...input(), committedProgramHash: weaker[0]!.programHash }, weaker, { primitiveIndex: LIVE });
    expect(r).toEqual({ ok: false, code: "program-hash-mismatch" });
  });

  it("print-and-mail, as authored and as fixed, cannot be funded above tier 0: its built-in verifiers are stubs", () => {
    for (const evidence of [tiers, fixedTiers()]) {
      const r = assertAcceptedProgramForTier(input(evidence));
      expect(r).toMatchObject({ ok: false, code: "tier-not-eligible" });
    }
    expect(assertAcceptedProgramForTier({ ...input(), tierKey: "tier1", committedProgramHash: null })).toEqual({
      ok: false,
      code: "no-committed-program",
    });
  });

  it("tier 0 is unaffected: it takes no program and is fundable", () => {
    expect(assertAcceptedProgramForTier({ ...input(), tierKey: "tier0", committedProgramHash: null })).toEqual({
      ok: true,
      registryPins: [],
    });
  });
});

describe("the public surface keeps the override form of the gate test-only (E8 F4)", () => {
  const OVERRIDE_FORM = "assertAcceptedProgramForTierWith";

  it("the module exports it, so tests import it from the module path", () => {
    expect(Object.keys(committedProgramModule)).toContain(OVERRIDE_FORM);
  });

  it("neither evidence/index.ts nor the package root exposes it (and both expose the production gate)", () => {
    expect(Object.keys(evidenceIndex)).toContain("assertAcceptedProgramForTier");
    expect(Object.keys(packageRoot)).toContain("assertAcceptedProgramForTier");
    expect(Object.keys(evidenceIndex)).not.toContain(OVERRIDE_FORM);
    expect(Object.keys(packageRoot)).not.toContain(OVERRIDE_FORM);
  });

  it("evidence/index.ts re-exports every other runtime export of the module, so the explicit list loses nothing", () => {
    const expected = Object.keys(committedProgramModule).filter((name) => name !== OVERRIDE_FORM);
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.filter((name) => !(name in evidenceIndex))).toEqual([]);
    expect(expected.filter((name) => !(name in packageRoot))).toEqual([]);
  });
});

describe("assertAcceptedProgramForTier — one snapshot of the input (E8 F3)", () => {
  const HASH = PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH;
  /** The test-only gate with every verifier live, taking whatever shape the attack gives it. */
  const gate = (input: unknown) =>
    assertAcceptedProgramForTierWith(input as AcceptedProgramGateInput, COMMITTED_PROGRAM_REGISTRY, { primitiveIndex: LIVE });
  const plain = (evidence: unknown) => ({ csd: CSD, tierKey: "tier2", evidence, committedProgramHash: HASH });
  const withoutRegistryKey = (t: Record<string, CsdEvidenceTier>) => {
    for (const k of ["tier1", "tier2", "tier3"]) t[k]!.primitives = t[k]!.primitives!.filter((p) => p.id !== "ident.registered_key");
    return t;
  };

  /** An input whose four fields are getters that count their reads. */
  function countingInput(fields: { csd: unknown; tierKey: unknown; committedProgramHash: unknown; evidence: unknown }) {
    const reads = { csd: 0, tierKey: 0, committedProgramHash: 0, evidence: 0 };
    const input = {
      get csd() {
        reads.csd++;
        return fields.csd;
      },
      get tierKey() {
        reads.tierKey++;
        return fields.tierKey;
      },
      get committedProgramHash() {
        reads.committedProgramHash++;
        return fields.committedProgramHash;
      },
      get evidence() {
        reads.evidence++;
        return fields.evidence;
      },
    };
    return { input, reads };
  }

  it("a getter that returns three different maps is evaluated on its first answer only, and the pins come from that same map", () => {
    const mapA = fixedTiers(); // passes the program check and names the kernel registry
    const mapB = fixedTiers(); // what a second read would show eligibility: another registry
    for (const k of ["tier1", "tier2", "tier3"]) {
      for (const p of mapB[k]!.primitives!) if (p.id === "ident.registered_key") p.params = { registryId: "pcc.registry.other.v1" };
    }
    const mapC = withoutRegistryKey(fixedTiers()); // what a third read would show the pins: none
    const maps = [mapA, mapB, mapC];
    let reads = 0;
    const input = {
      csd: CSD,
      tierKey: "tier2",
      committedProgramHash: HASH,
      get evidence() {
        return maps[Math.min(reads++, 2)];
      },
    };
    const r = gate(input);
    expect(reads).toBe(1);
    expect(r).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    // It is the result of evaluating the first map alone.
    expect(r).toEqual(gate(plain(mapA)));
  });

  it("every field of the input is read exactly once, on every path through the gate", () => {
    const once = { csd: 1, tierKey: 1, committedProgramHash: 1, evidence: 1 };
    const paths: Array<[string, string, string | null, object]> = [
      ["funded tier2", "tier2", HASH, { ok: true }],
      ["tier0", "tier0", null, { ok: true }],
      ["tier0 carrying a program", "tier0", HASH, { code: "program-on-tier-zero" }],
      ["no committed program", "tier3", HASH, { code: "no-committed-program" }],
      ["wrong hash", "tier2", PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH, { code: "program-hash-mismatch" }],
      ["no hash", "tier2", null, { code: "program-hash-mismatch" }],
    ];
    for (const [name, tierKey, committedProgramHash, expected] of paths) {
      const { input, reads } = countingInput({ csd: CSD, tierKey, committedProgramHash, evidence: fixedTiers() });
      expect(gate(input), name).toMatchObject(expected);
      expect(reads, name).toEqual(once);
    }
    // The production gate reads once too.
    const { input, reads } = countingInput({ csd: CSD, tierKey: "tier2", committedProgramHash: HASH, evidence: fixedTiers() });
    expect(assertAcceptedProgramForTier(input as unknown as AcceptedProgramGateInput)).toMatchObject({ ok: false, code: "tier-not-eligible" });
    expect(reads).toEqual(once);
  });

  it("a getter on committedProgramHash that changes its answer is read once, so it cannot show the check one hash and the funder another", () => {
    let reads = 0;
    const input = {
      csd: CSD,
      tierKey: "tier2",
      evidence: fixedTiers(),
      get committedProgramHash() {
        return reads++ === 0 ? HASH : null;
      },
    };
    expect(gate(input)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    expect(reads).toBe(1);
  });

  it("a getter nested inside a tier is read once, so the pins come from the primitives the program check saw", () => {
    const t = fixedTiers();
    const real = t["tier2"]!.primitives!;
    const stripped = real.filter((p) => p.id !== "ident.registered_key");
    let reads = 0;
    Object.defineProperty(t["tier2"]!, "primitives", { enumerable: true, get: () => (reads++ === 0 ? real : stripped) });
    expect(gate(plain(t))).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    expect(reads).toBe(1);
  });

  it("a proxy that answers each key once with the real tier and afterwards with a stripped one is evaluated on the real one", () => {
    const real = fixedTiers();
    const strip = (tier: CsdEvidenceTier): CsdEvidenceTier => ({
      ...structuredClone(tier),
      primitives: (tier.primitives ?? []).filter((p) => p.id !== "ident.registered_key"),
    });
    const reads = new Map<string, number>();
    const proxy = new Proxy(real, {
      get(target, key, receiver) {
        if (typeof key === "string" && /^tier\d$/.test(key)) {
          const n = (reads.get(key) ?? 0) + 1;
          reads.set(key, n);
          return n === 1 ? Reflect.get(target, key, receiver) : strip(target[key]!);
        }
        return Reflect.get(target, key, receiver);
      },
    });
    expect(gate(plain(proxy))).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    expect([...reads.values()].every((n) => n === 1)).toBe(true);
    expect(reads.size).toBe(4);
  });

  it("a toJSON on the evidence is consulted once", () => {
    let calls = 0;
    const evidence = {
      toJSON() {
        return calls++ === 0 ? fixedTiers() : withoutRegistryKey(fixedTiers());
      },
    };
    expect(gate(plain(evidence))).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    expect(calls).toBe(1);
  });

  it("evidence that is not plain JSON data is refused as invalid-input, never thrown", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const bad: Array<[string, unknown]> = [
      ["undefined", undefined],
      ["null", null],
      ["an array", [fixedTiers()]],
      ["a string", "tier0"],
      ["a number", 7],
      ["a boolean", true],
      ["a function", () => fixedTiers()],
      ["a cycle", cycle],
      ["a BigInt inside", { tier0: { description: "x", required: [], n: 1n } }],
      ["a toJSON that returns an array", { toJSON: () => [] }],
      ["a toJSON that returns null", { toJSON: () => null }],
      [
        "a throwing getter inside",
        {
          get tier0(): unknown {
            throw new Error("boom");
          },
        },
      ],
    ];
    for (const [name, evidence] of bad) {
      expect(gate(plain(evidence)), name).toEqual({ ok: false, code: "invalid-input" });
    }
    const throwing = {
      csd: CSD,
      tierKey: "tier2",
      committedProgramHash: HASH,
      get evidence(): unknown {
        throw new Error("boom");
      },
    };
    expect(gate(throwing)).toEqual({ ok: false, code: "invalid-input" });
  });

  it("an input that is not an object, or whose csd or tierKey is not a string, is invalid-input", () => {
    for (const input of [undefined, null, "tier2", 7, [plain(fixedTiers())]]) {
      expect(gate(input), String(input)).toEqual({ ok: false, code: "invalid-input" });
    }
    for (const csd of [undefined, null, 7, { toString: () => CSD }]) {
      expect(gate({ ...plain(fixedTiers()), csd }), String(csd)).toEqual({ ok: false, code: "invalid-input" });
    }
    // An object with a stateful toString cannot pass as tier0 on one read and tier2 on the next.
    let calls = 0;
    const sneaky = { toString: () => (calls++ === 0 ? "tier0" : "tier2") };
    expect(gate({ csd: CSD, tierKey: sneaky, evidence: fixedTiers(), committedProgramHash: null })).toEqual({
      ok: false,
      code: "invalid-input",
    });
    for (const field of ["csd", "tierKey", "committedProgramHash"]) {
      const throwingField = { ...plain(fixedTiers()) };
      Object.defineProperty(throwingField, field, {
        enumerable: true,
        get(): unknown {
          throw new Error("boom");
        },
      });
      expect(gate(throwingField), field).toEqual({ ok: false, code: "invalid-input" });
    }
  });

  it("evidence that is plain data in any other shape is accepted: a null-prototype map, a class instance", () => {
    const nullProto = Object.assign(Object.create(null) as Record<string, CsdEvidenceTier>, fixedTiers());
    class Holder {
      tier0 = fixedTiers().tier0!;
      tier1 = fixedTiers().tier1!;
      tier2 = fixedTiers().tier2!;
      tier3 = fixedTiers().tier3!;
    }
    for (const evidence of [nullProto, new Holder()]) {
      expect(gate(plain(evidence))).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    }
  });
});

describe("assertAcceptedProgramForTier — tiers 0..k must all be declared (E8 F2)", () => {
  const HASH = PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH;
  const gate = (tierKey: string, committedProgramHash: string | null, evidence: unknown, registry: readonly CommittedProgramEntry[] = COMMITTED_PROGRAM_REGISTRY) =>
    assertAcceptedProgramForTierWith({ csd: CSD, tierKey, evidence, committedProgramHash } as AcceptedProgramGateInput, registry, {
      primitiveIndex: LIVE,
    });
  const undeclared = (key: string, funded: string, k: number) =>
    `${key} is not declared in the CSD being funded, and funding ${funded} needs tiers 0..${k}`;

  it("a CSD with no tier0 cannot be funded at tier2, though the eligibility lint alone would let it ascend", () => {
    const t = fixedTiers();
    delete t.tier0;
    // The root cause, as a positive control: with tier0 absent the lint still counts the tier-0 floor.
    expect(computeCsdEligibility({ url: CSD, evidence: t }, { requireImplementedVerifier: true, index: LIVE }).eligibleTier).toBeGreaterThanOrEqual(2);
    expect(gate("tier2", HASH, t)).toEqual({ ok: false, code: "tier-not-in-csd", reasons: [undeclared("tier0", "tier2", 2)] });
  });

  it("every missing tier among 0..k is named, in order", () => {
    const t = fixedTiers();
    delete t.tier0;
    delete t.tier1;
    expect(gate("tier2", HASH, t)).toEqual({
      ok: false,
      code: "tier-not-in-csd",
      reasons: [undeclared("tier0", "tier2", 2), undeclared("tier1", "tier2", 2)],
    });
  });

  it("a tier that is not a plain object is not declared: null, an array, a string, a number", () => {
    for (const key of ["tier0", "tier1"]) {
      for (const bad of [null, [], "tier", 0]) {
        const t = fixedTiers() as Record<string, unknown>;
        t[key] = bad;
        expect(gate("tier2", HASH, t), `${key} = ${JSON.stringify(bad)}`).toEqual({
          ok: false,
          code: "tier-not-in-csd",
          reasons: [undeclared(key, "tier2", 2)],
        });
      }
    }
  });

  it("only own keys count: a tier0 inherited through Object.prototype is not declared", () => {
    const t = fixedTiers();
    const inherited = t.tier0!;
    delete t.tier0;
    Object.defineProperty(Object.prototype, "tier0", { value: inherited, configurable: true, enumerable: false, writable: true });
    try {
      expect(({} as Record<string, unknown>)["tier0"]).toBeDefined(); // the pollution is live
      expect(gate("tier2", HASH, t)).toMatchObject({ ok: false, code: "tier-not-in-csd", reasons: [undeclared("tier0", "tier2", 2)] });
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)["tier0"];
    }
    expect(({} as Record<string, unknown>)["tier0"]).toBeUndefined();
  });

  it("the funded key must be exactly tierN, even when the registry has an entry for it and the CSD declares it", () => {
    for (const key of ["tier02", "gold"]) {
      const registry = [{ csd: CSD, tier: key, program: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM, programHash: HASH }];
      const t = fixedTiers();
      t[key] = t.tier2!;
      expect(gate(key, HASH, t, registry), key).toEqual({
        ok: false,
        code: "tier-not-in-csd",
        reasons: [`"${key}" is not an exact tierN key`],
      });
    }
  });

  it("only tiers 0..k are required: a CSD that declares tiers 0..2 funds tier2 with tier3 absent or malformed", () => {
    const absent = fixedTiers();
    delete absent.tier3;
    expect(gate("tier2", HASH, absent)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    const malformed = fixedTiers() as Record<string, unknown>;
    malformed["tier3"] = null;
    expect(gate("tier2", HASH, malformed)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
  });

  it("tier 0 itself needs no declaration to be funded: it is the permissionless floor", () => {
    expect(gate("tier0", null, {})).toEqual({ ok: true, registryPins: [] });
    const noTier0 = fixedTiers();
    delete noTier0.tier0;
    expect(gate("tier0", null, noTier0)).toEqual({ ok: true, registryPins: [] });
  });
});

describe("assertAcceptedProgramForTier — the committed hash is read in the accepted deal's digest grammar (E8 F5)", () => {
  const HASH = PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH;
  const gate = (committedProgramHash: unknown) =>
    assertAcceptedProgramForTierWith(
      { csd: CSD, tierKey: "tier2", evidence: fixedTiers(), committedProgramHash } as AcceptedProgramGateInput,
      COMMITTED_PROGRAM_REGISTRY,
      { primitiveIndex: LIVE },
    );
  /** A minimal plan that carries `verificationProgramHash`: the accepted deal's own validation and derivation read it. */
  const dealPlan = (verificationProgramHash: string): MatchedDAG => ({
    requestId: "req-1",
    nodes: [{ nodeId: "print", capabilityType: "document-printing", matchStatus: "none" }],
    edges: [],
    verificationProgramHash,
  });
  const dealAccepts = (hash: string) => validatePlan(dealPlan(hash), { bindings: false }).length === 0;
  const digits = HASH.slice(2);
  const OTHER_DIGEST = "0x" + "ab".repeat(32);

  const table: Array<[string, string]> = [
    ["the pinned hash", HASH],
    ["uppercase hex digits under a lowercase 0x", "0x" + digits.toUpperCase()],
    ["mixed-case hex digits", "0x" + digits.slice(0, 20).toUpperCase() + digits.slice(20)],
    ["0X prefix, lowercase digits", "0X" + digits],
    ["0X prefix, uppercase digits (HASH.toUpperCase(), the reviewer's repro)", HASH.toUpperCase()],
    ["no prefix", digits],
    ["63 hex digits", HASH.slice(0, -1)],
    ["65 hex digits", HASH + "0"],
    ["a non-hex digit", HASH.slice(0, -1) + "g"],
    ["a fullwidth letter in the digits", "0x" + digits.replace("d", "\uff44")],
    ["a leading space", " " + HASH],
    ["a trailing space", HASH + " "],
    ["a trailing newline", HASH + "\n"],
    ["an embedded NUL", HASH.slice(0, 10) + "\u0000" + HASH.slice(11)],
    ["the empty string", ""],
    ["another valid digest", OTHER_DIGEST],
  ];

  it("the gate accepts exactly what the accepted deal accepts and canonicalizes to the pinned hash", () => {
    const pinnedRoot = deriveCapabilityContractRoot(dealPlan(HASH), { version: 3 });
    for (const [name, input] of table) {
      const dealCommitsToTheProgram = dealAccepts(input) && deriveCapabilityContractRoot(dealPlan(input), { version: 3 }) === pinnedRoot;
      expect(gate(input).ok, name).toBe(dealCommitsToTheProgram);
      // And the grammar the gate applied is the deal's, not a copy that could drift.
      if (!DIGEST_PATTERN.test(input)) expect(dealAccepts(input), name).toBe(false);
    }
  });

  it("the rows that matter: 0X is refused, and hex case is still not meaningful in the digits", () => {
    expect(gate(HASH.toUpperCase())).toEqual({ ok: false, code: "program-hash-mismatch" });
    expect(gate("0X" + digits)).toEqual({ ok: false, code: "program-hash-mismatch" });
    expect(gate("0x" + digits.toUpperCase())).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    expect(gate(HASH)).toEqual({ ok: true, registryPins: KERNEL_KEY_PIN });
    // The deal reads them the same way.
    expect(dealAccepts(HASH.toUpperCase())).toBe(false);
    expect(dealAccepts("0x" + digits.toUpperCase())).toBe(true);
  });

  it("a committed hash that is not a string is a mismatch, whatever it coerces to", () => {
    for (const bad of [undefined, null, 7, { toString: () => HASH }, [HASH], new String(HASH)]) {
      expect(gate(bad), String(bad)).toEqual({ ok: false, code: "program-hash-mismatch" });
    }
  });
});

describe("checkCommittedProgramForTier — independence rests on evidence-owned provenance, not on the stage's own list (E8 F1)", () => {
  const HASH = PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH;
  const stageOf = (p: CommittedProgram, id: string) => p.stages.find((st) => st.id === id)!;
  const variant = (mutate: (p: CommittedProgram) => void): CommittedProgram => {
    const p = structuredClone(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM);
    mutate(p);
    return p;
  };
  const violationsFor = (p: CommittedProgram) => checkCommittedProgramForTier(p, tiers.tier2!).violations;
  const NOT_INDEPENDENT = { code: "independence-not-established", stageId: "mail", eventType: "courier_pickup_confirmed" };
  const stray = (stageId: string) => ({ code: "provenance-on-dependent-stage", stageId });
  const gateWithRegistered = (program: CommittedProgram) => {
    const e = entry("tier2", program);
    return assertAcceptedProgramForTierWith({ csd: CSD, tierKey: "tier2", evidence: fixedTiers(), committedProgramHash: e.programHash }, [e], {
      primitiveIndex: LIVE,
    });
  };

  it("INDEPENDENT_PROVENANCE is frozen null-prototype data holding exactly the carrier acceptance scan", () => {
    expect(Object.getPrototypeOf(INDEPENDENT_PROVENANCE)).toBeNull();
    expect(Object.isFrozen(INDEPENDENT_PROVENANCE)).toBe(true);
    expect(Object.isFrozen(INDEPENDENT_PROVENANCE["courier_pickup_confirmed"])).toBe(true);
    expect(Object.entries(INDEPENDENT_PROVENANCE)).toEqual([["courier_pickup_confirmed", ["independent_carrier_scan"]]]);
    expect(() => {
      (INDEPENDENT_PROVENANCE as Record<string, readonly string[]>)["execution_completed"] = ["operator_self_report"];
    }).toThrow(TypeError);
    expect(() => (INDEPENDENT_PROVENANCE["courier_pickup_confirmed"] as string[]).push("operator_self_report")).toThrow(TypeError);
  });

  it("the pinned programs, their hashes and the registry are unchanged, and both pinned programs pass the tier check", () => {
    expect(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH).toBe("0xd229c8daa76cb3022041b6ff076d30a5ecb614d71f50a07f80f680629dcc2b86");
    expect(PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH).toBe("0x6e00cad1095c6a2913671e30969436897bd12ce60b3957f7b259f56875c863e0");
    expect(computeCommittedProgramHash(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM)).toBe(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH);
    expect(computeCommittedProgramHash(PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM)).toBe(PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM_HASH);
    expect(COMMITTED_PROGRAM_REGISTRY).toEqual([
      { csd: CSD, tier: "tier2", program: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM, programHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH },
    ]);
    expect(violationsFor(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM)).toEqual([]);
    expect(violationsFor(PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM)).toEqual([]);
    expect(assertAcceptedProgramForTierWith({ csd: CSD, tierKey: "tier2", evidence: fixedTiers(), committedProgramHash: HASH }, COMMITTED_PROGRAM_REGISTRY, { primitiveIndex: LIVE })).toEqual({
      ok: true,
      registryPins: KERNEL_KEY_PIN,
    });
  });

  it("the reviewer's repro: the independence program with an operator_self_report allowlist is refused by the check and by the gate", () => {
    const evil = variant((p) => {
      stageOf(p, "mail").allowedProvenance = ["operator_self_report"];
    });
    expect(computeCommittedProgramHash(evil)).not.toBe(HASH); // it hashes differently, so it needs its own registry entry
    expect(violationsFor(evil)).toEqual([NOT_INDEPENDENT]);
    expect(gateWithRegistered(evil)).toEqual({ ok: false, code: "program-fails-tier-check", violations: [NOT_INDEPENDENT] });
  });

  const attacks: Array<[string, (p: CommittedProgram) => void]> = [
    ["allowedProvenance absent", (p) => void delete stageOf(p, "mail").allowedProvenance],
    ["allowedProvenance empty", (p) => void (stageOf(p, "mail").allowedProvenance = [])],
    ["a duplicate label", (p) => void (stageOf(p, "mail").allowedProvenance = ["independent_carrier_scan", "independent_carrier_scan"])],
    ["a superset that also admits operator_self_report", (p) => void (stageOf(p, "mail").allowedProvenance = ["independent_carrier_scan", "operator_self_report"])],
    ["a label that is only close: wrong case", (p) => void (stageOf(p, "mail").allowedProvenance = ["Independent_Carrier_Scan"])],
    ["a label that is only close: padded", (p) => void (stageOf(p, "mail").allowedProvenance = ["independent_carrier_scan "])],
    ["a string instead of an array", (p) => void (stageOf(p, "mail").allowedProvenance = "independent_carrier_scan" as unknown as string[])],
    ["null instead of an array", (p) => void (stageOf(p, "mail").allowedProvenance = null as unknown as string[])],
    ["an object instead of an array", (p) => void (stageOf(p, "mail").allowedProvenance = { 0: "independent_carrier_scan", length: 1 } as unknown as string[])],
    ["a non-string element", (p) => void (stageOf(p, "mail").allowedProvenance = ["independent_carrier_scan", 1 as unknown as string])],
    ["a nested array element", (p) => void (stageOf(p, "mail").allowedProvenance = [["independent_carrier_scan"] as unknown as string])],
    [
      "a sparse array: the hole is not a label",
      (p) => {
        const sparse: string[] = [];
        sparse[1] = "independent_carrier_scan";
        stageOf(p, "mail").allowedProvenance = sparse;
      },
    ],
  ];
  for (const [name, mutate] of attacks) {
    it(`an independent stage with ${name} is refused by the check and by the gate`, () => {
      const program = variant(mutate);
      expect(violationsFor(program)).toEqual([NOT_INDEPENDENT]);
      expect(gateWithRegistered(program)).toEqual({ ok: false, code: "program-fails-tier-check", violations: [NOT_INDEPENDENT] });
    });
  }

  it("independence is event-specific: a label listed for the carrier scan does not make execution_completed independent", () => {
    const program = variant((p) => {
      const printOk = stageOf(p, "print-ok");
      printOk.predicate = "event-present-independent";
      printOk.allowedProvenance = ["independent_carrier_scan"];
    });
    expect(violationsFor(program)).toEqual([{ code: "independence-not-established", stageId: "print-ok", eventType: "execution_completed" }]);
  });

  it("allowedProvenance on any other stage is stray and refused, even empty or null", () => {
    for (const [stageId, label] of [
      ["print-ok", "event-present"],
      ["print-not-failed", "event-absent"],
      ["auth", "not-simulated"],
    ] as const) {
      for (const value of [["independent_carrier_scan"], [], null]) {
        const program = variant((p) => {
          stageOf(p, stageId).allowedProvenance = value as unknown as string[];
        });
        expect(violationsFor(program), `${label} carrying ${JSON.stringify(value)}`).toEqual([stray(stageId)]);
        expect(gateWithRegistered(program)).toEqual({ ok: false, code: "program-fails-tier-check", violations: [stray(stageId)] });
      }
    }
    // The honest-asymmetry program's mail stage is a plain event-present, so provenance there is stray too.
    const honest = structuredClone(PRINT_AND_MAIL_HONEST_ASYMMETRY_PROGRAM);
    stageOf(honest, "mail").allowedProvenance = ["independent_carrier_scan"];
    expect(violationsFor(honest)).toEqual([stray("mail")]);
  });

  it("an explicitly undefined allowedProvenance is no provenance at all, so it is not stray", () => {
    const program = variant((p) => {
      stageOf(p, "auth").allowedProvenance = undefined;
    });
    expect(violationsFor(program)).toEqual([]);
  });

  it("the new rules add to the existing violations without reordering them, one per offending stage in stage order", () => {
    const program = variant((p) => {
      stageOf(p, "print-ok").allowedProvenance = ["independent_carrier_scan"];
      stageOf(p, "mail").allowedProvenance = ["operator_self_report"];
    });
    expect(violationsFor(program)).toEqual([stray("print-ok"), NOT_INDEPENDENT]);
    // An unknown predicate is refused as such, and its provenance is not also counted as stray.
    const unknown: CommittedProgram = {
      ...PRINT_ONLY,
      stages: [...PRINT_ONLY.stages, { id: "x", predicate: "event-count" as never, eventType: "execution_completed", allowedProvenance: ["a"] }],
    };
    expect(checkCommittedProgramForTier(unknown, tiers.tier1!).violations).toEqual([{ code: "unknown-predicate", stageId: "x" }]);
    // An independent stage with no usable event type is refused for that, and not also as non-independent.
    const noEvent: CommittedProgram = {
      ...PRINT_ONLY,
      stages: [...PRINT_ONLY.stages, { id: "y", predicate: "event-present-independent", allowedProvenance: ["independent_carrier_scan"] }],
    };
    expect(checkCommittedProgramForTier(noEvent, tiers.tier1!).violations).toEqual([{ code: "stage-missing-event-type", stageId: "y" }]);
  });
});
