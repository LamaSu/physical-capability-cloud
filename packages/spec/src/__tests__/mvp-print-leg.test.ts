import { readFileSync } from "node:fs";

import { keccak_256 } from "@noble/hashes/sha3";
import { describe, expect, it } from "vitest";

import printLegCsd from "../csds/document-print-leg.csd.json" with { type: "json" };
import printAndMailCsd from "../csds/document-print-and-mail.csd.json" with { type: "json" };
import goldens from "../evidence/mvp-print-leg.goldens.json" with { type: "json" };
import vectors from "../evidence/tier-ladder.vectors.json" with { type: "json" };
import { computeContractDigest } from "../csd/capability-contract-identity.js";
import { loadBuiltinCsds } from "../csd/registry.js";
import { CsdSchema, type CSD, type CsdEvidenceTier } from "../csd/schema.js";
import {
  COMMITTED_PROGRAM_REGISTRY,
  DOCUMENT_PRINT_LEG_PROGRAM,
  DOCUMENT_PRINT_LEG_PROGRAM_HASH,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM,
  PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH,
  assertAcceptedProgramForTier,
  assertAcceptedProgramForTierWith,
  checkCommittedProgramForTier,
  computeCommittedProgramHash,
  resolveAcceptedProgram,
  type AcceptedProgramGateInput,
  type CommittedProgram,
  type TierAssuranceViolation,
} from "../evidence/committed-program.js";
import { EVIDENCE_PRIMITIVES } from "../evidence/primitives.js";
import {
  PINNED_TIER_LADDER_DIGESTS,
  achievedTierFromEventTypes,
  compileTierLadder,
  computeTierLadderDigest,
  type TierLadderV1,
} from "../evidence/tier-ladder.js";
import { canonicalize } from "../util/canonical.js";

const PRINT_LEG_URL = "pcc://capabilities/document-print-leg/v1";
const DPM_URL = "pcc://capabilities/document-print-and-mail/v1";
const ATTSET_TAG = "PCC:vnext:attestation-set:v1";
const WORK_PRODUCT_TAG = "PCC:vnext:work-product:none:v1";
const ZERO_WORD = `0x${"00".repeat(32)}`;
const AB_WORD = `0x${"ab".repeat(32)}`;
const D4_EMPTY_ROOTS = [
  { programHash: ZERO_WORD, root: "0xfa5d8d6e62798ae6c9a812af6ebcb3a9e74b26bf2f7334911769b136ed2fd8f9" },
  { programHash: AB_WORD, root: "0x96c3e7c793a4bc2dda245ef16c490b408f5ee6aaf200b4008750eb93750d942a" },
];
const EXPECTED_TIER1_PRIMITIVES = [
  { id: "receipt.kernel_signed", bind: "execution_completed", supporting: false, params: { capability: "document-printing" } },
];
const ORACLE_VERIFIED = new Set(["receipt.kernel_signed", "confirm.target_system"]);
const DESCRIPTION = "Goldens for the Thursday 10/15 PRINT unit at R5(a)'s print-leg tier, consumed by pcc-oracle task D and pcc-printhost's job inputs.";
const DEFINITIONS = {
  capabilityContractId: "packages/spec/src/csd/schema.ts: CsdSchema.parse (url)",
  capabilityContractDigest: "packages/spec/src/csd/capability-contract-identity.ts: computeContractDigest",
  programHash: "packages/spec/src/evidence/committed-program.ts: computeCommittedProgramHash",
  ladder: "packages/spec/src/evidence/tier-ladder.ts: compileTierLadder",
  ladderDigest: "packages/spec/src/evidence/tier-ladder.ts: computeTierLadderDigest",
  attestationSetRoot: "packages/spec/src/__tests__/mvp-print-leg.test.ts: emptyAttestationSetRoot (independent 128-byte ABI encoder)",
  attestationSetRootDomain: "@noble/hashes/sha3: keccak_256 (UTF-8 tag)",
  attestationSetRootSelfCheck: "packages/spec/src/__tests__/mvp-print-leg.test.ts: emptyAttestationSetRoot (D4 empty-set goldens)",
  workProductRoot: "@noble/hashes/sha3: keccak_256 (UTF-8 workProductRootTag)",
  achievedTier: "packages/spec/src/evidence/tier-ladder.ts: achievedTierFromEventTypes",
};

const freshCsd = (): CSD => structuredClone(CsdSchema.parse(printLegCsd));
const tierOf = (csd: CSD, k: number): CsdEvidenceTier => csd.evidence![`tier${k}`]!;
const freshProgram = (): CommittedProgram => ({
  version: 1,
  schemaHash: "verification-program/v1",
  stages: [
    { id: "print-ok", predicate: "event-present", eventType: "execution_completed" },
    { id: "print-not-failed", predicate: "event-absent", eventType: "execution_failed" },
    { id: "auth", predicate: "not-simulated" },
  ],
});
const keccakUtf8 = (tag: string): `0x${string}` => `0x${Buffer.from(keccak_256(new TextEncoder().encode(tag))).toString("hex")}`;

/** Independent ABI words; no production attestation-set builder or ABI library. */
function uint256Word(value: bigint): Uint8Array {
  const word = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    word[i] = Number(value & 255n);
    value >>= 8n;
  }
  return word;
}

function bytes32Word(hex: string): Uint8Array {
  if (!/^0x[0-9a-f]{64}$/i.test(hex)) throw new Error("expected bytes32");
  return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}

function emptyAttestationSetRoot(programHash: string): `0x${string}` {
  // abi.encode(bytes32 domain, bytes32 programHash, bytes32[] []):
  // domain || programHash || uint256(0x60) || uint256(0), exactly 128 bytes.
  const encoded = new Uint8Array(128);
  encoded.set(bytes32Word(keccakUtf8(ATTSET_TAG)), 0);
  encoded.set(bytes32Word(programHash), 32);
  encoded.set(uint256Word(0x60n), 64);
  encoded.set(uint256Word(0n), 96);
  return `0x${Buffer.from(keccak_256(encoded)).toString("hex")}`;
}

async function buildGoldens() {
  const csd = freshCsd();
  const program = freshProgram();
  const programHash = computeCommittedProgramHash(program);
  const ladder = await compileTierLadder(csd);
  return {
    schema: "pcc.evidence.mvp-print-leg-goldens/v1",
    description: DESCRIPTION,
    capabilityContractId: csd.url,
    capabilityContractDigest: await computeContractDigest(csd),
    tierKey: "tier1",
    requiredTier: 1,
    program,
    programHash,
    ladderDigest: computeTierLadderDigest(ladder),
    ladder,
    attestationSetRoot: emptyAttestationSetRoot(programHash),
    attestationSetRootDomain: ATTSET_TAG,
    attestationSetRootSelfCheck: [ZERO_WORD, AB_WORD].map((hash) => ({ programHash: hash, root: emptyAttestationSetRoot(hash) })),
    workProductRoot: keccakUtf8(WORK_PRODUCT_TAG),
    workProductRootTag: WORK_PRODUCT_TAG,
    oracleVerifiedPrimitivesRequired: ["receipt.kernel_signed"],
    oracleVerifiedPerRequest: ["decl.self_attested"],
    achievedTier: [
      ["execution_completed", "execution_started"],
      ["execution_failed", "execution_started"],
      ["execution_completed"],
      [],
    ].map((events) => ({ events: [...events].sort(), tier: achievedTierFromEventTypes(ladder, events) })),
    definitions: { ...DEFINITIONS },
  };
}

// These predicates are also run against freshly compiled D8 mutants.
const tier1ExactPrimitiveSet = (ladder: TierLadderV1): boolean =>
  canonicalize(ladder.tiers[1]?.primitives ?? []) === canonicalize(EXPECTED_TIER1_PRIMITIVES);
const tier1VerifiedSubset = (ladder: TierLadderV1): boolean =>
  (ladder.tiers[1]?.primitives ?? []).every((p) => ORACLE_VERIFIED.has(p.id));
const tier0DeclarationSet = (ladder: TierLadderV1): boolean =>
  canonicalize(ladder.tiers[0]?.primitives.map((p) => p.id).sort() ?? []) === canonicalize(["decl.self_attested"]);
const primitivePinsHold = (ladder: TierLadderV1): boolean =>
  tier1ExactPrimitiveSet(ladder) && tier1VerifiedSubset(ladder) && tier0DeclarationSet(ladder) &&
  ladder.tiers.every((t) => t.primitives.every((p) => p.id !== "confirm.target_system"));
function eventPinsHold(ladder: TierLadderV1): boolean {
  const groups = ladder.tiers.map((t) => t.requiredEventTypes);
  const requirements = ladder.tiers.flatMap((t) => [
    ...t.requiredEventTypes.flat(), ...t.nonEventRequirements, ...t.primitives.flatMap((p) => p.bind === null ? [] : [p.bind]),
  ]);
  return ladder.tiers.length === 2 &&
    canonicalize(groups) === canonicalize([[["execution_started"]], [["execution_completed"], ["execution_started"]]]) &&
    ladder.tiers.every((t) => t.nonEventRequirements.length === 0) &&
    requirements.every((r) => !/^courier_|^photo_|label|tracking/i.test(r));
}
function achievedTierPinsHold(ladder: TierLadderV1): boolean {
  return achievedTierFromEventTypes(ladder, ["execution_started", "execution_completed"]) === 1 &&
    achievedTierFromEventTypes(ladder, ["execution_started", "execution_failed"]) === 0 &&
    achievedTierFromEventTypes(ladder, ["execution_completed"]) === null &&
    achievedTierFromEventTypes(ladder, ["execution_failed"]) === null &&
    achievedTierFromEventTypes(ladder, []) === null;
}
const gateInput = (csd = freshCsd()): AcceptedProgramGateInput => ({
  csd: "document-print-leg", tierKey: "tier1", evidence: csd.evidence!, committedProgramHash: DOCUMENT_PRINT_LEG_PROGRAM_HASH,
});
const KNOWN_GAP = 'tier1: primitive "receipt.kernel_signed" depends on "ident.registered_key" absent from tier ≤ 1';

describe("MVP PRINT unit — A: fresh inputs reproduce the cross-lane goldens", () => {
  it("A1: parses and resolves the built-in print-leg base without inheritance", () => {
    const csd = freshCsd();
    expect(CsdSchema.safeParse(structuredClone(printLegCsd)).success).toBe(true);
    const registry = loadBuiltinCsds();
    expect(registry.get(PRINT_LEG_URL)).toEqual(csd);
    expect(registry.resolve(PRINT_LEG_URL)).toEqual(csd);
    expect(csd.kind).toBe("base");
    expect(csd.baseDefinition).toBeNull();
    expect(registry.findUrlByType("document-print-leg")).toBe(PRINT_LEG_URL);
    expect(registry.get(`${PRINT_LEG_URL}-absent`)).toBeUndefined();
    expect(CsdSchema.safeParse({ ...csd, version: "invalid" }).success).toBe(false);
  });

  it("A2: reproduces the ladder vector, pin and exact CSD digest while preserving DPM", async () => {
    const csd = freshCsd();
    const ladder = await compileTierLadder(csd);
    expect(vectors.vectors.map((v) => v.csd)).toEqual(["csds/document-print-and-mail.csd.json", "csds/document-print-leg.csd.json"]);
    const vector = vectors.vectors[1]!;
    expect(ladder).toEqual(vector.ladder);
    expect(ladder).toEqual(goldens.ladder);
    expect(computeTierLadderDigest(ladder)).toBe(vector.ladderDigest);
    expect(vector.ladderDigest).toBe(PINNED_TIER_LADDER_DIGESTS[PRINT_LEG_URL]);
    expect(vector.ladderDigest).toBe(goldens.ladderDigest);
    expect(ladder.capabilityContractDigest).toBe(await computeContractDigest(csd));
    expect(ladder.capabilityContractDigest).toBe(goldens.capabilityContractDigest);
    const dpm = await compileTierLadder(structuredClone(CsdSchema.parse(printAndMailCsd)));
    expect(dpm).toEqual(vectors.vectors[0]!.ladder);
    const dpmDigest = "0xe9cf2a2f9f6dcc355a5c71cd503b7598c0cbf1b58429e452adfafe6cf0fe0560";
    expect(computeTierLadderDigest(dpm)).toBe(dpmDigest);
    expect(vectors.vectors[0]!.ladderDigest).toBe(dpmDigest);
    expect(PINNED_TIER_LADDER_DIGESTS[DPM_URL]).toBe(dpmDigest);
    expect(computeTierLadderDigest(ladder)).not.toBe(dpmDigest);
  });

  it("A3: pins exactly the DPM tier2 and print-leg tier1 registry entries", () => {
    expect(computeCommittedProgramHash(DOCUMENT_PRINT_LEG_PROGRAM)).toBe(DOCUMENT_PRINT_LEG_PROGRAM_HASH);
    expect(computeCommittedProgramHash(freshProgram())).toBe(goldens.programHash);
    expect(DOCUMENT_PRINT_LEG_PROGRAM_HASH).toBe(goldens.programHash);
    expect(DOCUMENT_PRINT_LEG_PROGRAM).toEqual(goldens.program);
    expect(COMMITTED_PROGRAM_REGISTRY).toEqual([
      { csd: "document-print-and-mail", tier: "tier2", program: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM, programHash: PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH },
      { csd: "document-print-leg", tier: "tier1", program: DOCUMENT_PRINT_LEG_PROGRAM, programHash: DOCUMENT_PRINT_LEG_PROGRAM_HASH },
    ]);
    expect(PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH).toBe("0xd229c8daa76cb3022041b6ff076d30a5ecb614d71f50a07f80f680629dcc2b86");
    expect(resolveAcceptedProgram("document-print-leg", "tier1")).toEqual({ ok: true, program: DOCUMENT_PRINT_LEG_PROGRAM, programHash: DOCUMENT_PRINT_LEG_PROGRAM_HASH });
    expect(resolveAcceptedProgram("document-print-leg", "tier2")).toEqual({ ok: false, code: "no-committed-program" });
    expect(resolveAcceptedProgram("document-print-leg", "tier0")).toEqual({ ok: true, program: null, programHash: null });
  });

  it("A4: independently encodes the EMPTY attestation set, first matching both ratified D4 goldens", () => {
    for (const vector of D4_EMPTY_ROOTS) expect(emptyAttestationSetRoot(vector.programHash)).toBe(vector.root);
    expect(goldens.attestationSetRootSelfCheck).toEqual(D4_EMPTY_ROOTS);
    expect(keccakUtf8(ATTSET_TAG)).toBe("0xf030abee776440d2f7c282ccb86af6198857c8b267814067fff27130046be146");
    expect(emptyAttestationSetRoot(DOCUMENT_PRINT_LEG_PROGRAM_HASH)).toBe(goldens.attestationSetRoot);
    expect(emptyAttestationSetRoot(ZERO_WORD)).not.toBe(goldens.attestationSetRoot);
    expect(emptyAttestationSetRoot(AB_WORD)).not.toBe(goldens.attestationSetRoot);
  });

  it("A5: the MVP work product root is the nonzero no-work-product tag hash", () => {
    expect(keccakUtf8(WORK_PRODUCT_TAG)).toBe(goldens.workProductRoot);
    expect(goldens.workProductRoot).not.toBe(ZERO_WORD);
    expect(keccakUtf8(`${WORK_PRODUCT_TAG}:changed`)).not.toBe(goldens.workProductRoot);
  });

  it("A6: fresh regeneration is byte-identical twice and to the shipped goldens file", async () => {
    const first = JSON.stringify(await buildGoldens(), null, 2) + "\n";
    const second = JSON.stringify(await buildGoldens(), null, 2) + "\n";
    expect(first).toBe(second);
    expect(first).toBe(readFileSync(new URL("../evidence/mvp-print-leg.goldens.json", import.meta.url), "utf8"));
  });

  it("A7: all independently probed section 7 values are literal pins", async () => {
    const generated = await buildGoldens();
    expect(generated.programHash).toBe("0x56c1897725442876a5b7adfde81b81c83b9ef09aade75aa3a81a911856330e4a");
    expect(generated.ladderDigest).toBe("0x8d353c7ce7a41e60c1e6167ccd7a7fe0f66d7d031c3c8db45127b2c53b0cf14b");
    expect(generated.capabilityContractDigest).toBe("sha256:e24f691b9dbe5fcb519782cc0d57ddfca2439f9d5841b76b5636cc6138e3d837");
    expect(generated.attestationSetRoot).toBe("0xafe770b61a150099cc2ab8a2585d8ecb33bdf345de947d6c4cf49c625471f366");
    expect(generated.workProductRoot).toBe("0x75325f8e90829d6e5d7c91479290dd711f3b7c314ab16fb147c3a7af5030c089");
    expect(keccakUtf8(ATTSET_TAG)).toBe("0xf030abee776440d2f7c282ccb86af6198857c8b267814067fff27130046be146");
  });
});

describe("MVP PRINT unit — B: the print-leg properties", () => {
  it("B1: exact primitive sets stay inside the oracle's verified set, with no carrier confirmation", async () => {
    const ladder = await compileTierLadder(freshCsd());
    expect(ladder.tiers[1]!.primitives).toEqual(EXPECTED_TIER1_PRIMITIVES);
    expect(new Set(ladder.tiers[1]!.primitives.map((p) => p.id))).toEqual(new Set(["receipt.kernel_signed"]));
    expect(tier1VerifiedSubset(ladder)).toBe(true);
    expect(ladder.tiers.every((t) => t.primitives.every((p) => p.id !== "confirm.target_system"))).toBe(true);
    expect(new Set(ladder.tiers[0]!.primitives.map((p) => p.id))).toEqual(new Set(["decl.self_attested"]));
    expect(primitivePinsHold(ladder)).toBe(true);
  });

  it("B2: exactly two tiers require print events only, with no non-event requirements", async () => {
    const ladder = await compileTierLadder(freshCsd());
    expect(ladder.tiers[0]!.requiredEventTypes).toEqual([["execution_started"]]);
    expect(ladder.tiers[1]!.requiredEventTypes).toEqual([["execution_completed"], ["execution_started"]]);
    expect(ladder.tiers.map((t) => t.nonEventRequirements)).toEqual([[], []]);
    expect(eventPinsHold(ladder)).toBe(true);
  });

  it("B3: exactly ordered print success, failure absence and auth stages, without mail parameters", () => {
    expect(DOCUMENT_PRINT_LEG_PROGRAM).toEqual(freshProgram());
    expect(DOCUMENT_PRINT_LEG_PROGRAM.stages.map((s) => s.id)).toEqual(["print-ok", "print-not-failed", "auth"]);
    expect(DOCUMENT_PRINT_LEG_PROGRAM.stages.some((s) => s.predicate === "event-present-independent")).toBe(false);
    expect(DOCUMENT_PRINT_LEG_PROGRAM.stages.some((s) => s.eventType?.startsWith("courier_"))).toBe(false);
    expect(Object.keys(DOCUMENT_PRINT_LEG_PROGRAM)).toEqual(["version", "schemaHash", "stages"]);
    expect(Object.hasOwn(DOCUMENT_PRINT_LEG_PROGRAM, "closeOn")).toBe(false);
    expect(Object.hasOwn(DOCUMENT_PRINT_LEG_PROGRAM, "requiresIndependentCarrierScan")).toBe(false);
  });

  it("B4: every tier1 program stage is bound and there is no unenforced tier evidence", () => {
    expect(checkCommittedProgramForTier(DOCUMENT_PRINT_LEG_PROGRAM, tierOf(freshCsd(), 1))).toEqual({ violations: [], unenforcedTierEvidence: [] });
  });

  it("B5: success reaches tier1 and a started failed print reaches the signed tier0 floor", async () => {
    const ladder = await compileTierLadder(freshCsd());
    expect(achievedTierPinsHold(ladder)).toBe(true);
    expect(achievedTierFromEventTypes(ladder, ["execution_started", "execution_completed"])).toBe(1);
    expect(achievedTierFromEventTypes(ladder, ["execution_started", "execution_failed"])).toBe(0);
    for (const events of [["execution_completed"], ["execution_failed"], []]) expect(achievedTierFromEventTypes(ladder, events)).toBeNull();
    // The ladder alone gives tier1 for {started, completed, failed}. The oracle's
    // event-absent program stage refuses that bundle; B3 and D2 pin that stage.
    expect(achievedTierFromEventTypes(ladder, ["execution_started", "execution_completed", "execution_failed"])).toBe(1);
  });
});

describe("MVP PRINT unit — C: the #349 production gate", () => {
  it("C1: the production gate refuses exactly the receipt.kernel_signed registered-key dependency gap until S3", () => {
    expect(assertAcceptedProgramForTier(gateInput())).toEqual({ ok: false, code: "tier-not-eligible", reasons: [KNOWN_GAP] });
  });

  it("C2: re-anchoring only the receipt dependency removes the sole blocker without mutating the vocabulary", () => {
    const original = structuredClone(EVIDENCE_PRIMITIVES);
    const primitiveIndex = new Map(EVIDENCE_PRIMITIVES.map((p) => [p.id, p.id === "receipt.kernel_signed" ? { ...p, dependsOn: [] } : p]));
    expect(assertAcceptedProgramForTierWith(gateInput(), COMMITTED_PROGRAM_REGISTRY, { primitiveIndex })).toEqual({ ok: true, registryPins: [] });
    expect(EVIDENCE_PRIMITIVES).toEqual(original);
    expect(EVIDENCE_PRIMITIVES.find((p) => p.id === "receipt.kernel_signed")!.dependsOn).toEqual(["ident.registered_key"]);
  });

  it("C3: tier0 accepts no program and refuses any committed program", () => {
    const input = { ...gateInput(), tierKey: "tier0" };
    expect(assertAcceptedProgramForTier({ ...input, committedProgramHash: null })).toEqual({ ok: true, registryPins: [] });
    expect(assertAcceptedProgramForTier(input)).toEqual({ ok: false, code: "program-on-tier-zero" });
  });

  it("C4: both the DPM program and a noncanonical 0X prefix fail the print-leg hash pin", () => {
    for (const hash of [PRINT_AND_MAIL_INDEPENDENCE_PROGRAM_HASH, DOCUMENT_PRINT_LEG_PROGRAM_HASH.replace(/^0x/, "0X")]) {
      expect(assertAcceptedProgramForTier({ ...gateInput(), committedProgramHash: hash })).toEqual({ ok: false, code: "program-hash-mismatch" });
    }
  });
});

describe("MVP PRINT unit — D: negative controls", () => {
  const programMutants: { id: string; mutate: (program: CommittedProgram) => void; code?: TierAssuranceViolation["code"] }[] = [
    { id: "D1 primitive instead of completion event", mutate: (p) => { p.stages[0]!.eventType = "printer_job_verified"; }, code: "positive-stage-not-bound-by-tier" },
    { id: "D2 missing failure absence", mutate: (p) => { p.stages.splice(1, 1); }, code: "completion-without-failure-absence" },
    { id: "D3 missing auth", mutate: (p) => { p.stages.pop(); }, code: "missing-not-simulated" },
    { id: "D4 closeOn delivery", mutate: (p) => { p.stages.push({ id: "mail", predicate: "event-present", eventType: "courier_delivery_confirmed" }); }, code: "positive-stage-not-bound-by-tier" },
    { id: "D5 closeOn pickup", mutate: (p) => { p.stages.push({ id: "mail", predicate: "event-present", eventType: "courier_pickup_confirmed" }); }, code: "positive-stage-not-bound-by-tier" },
    { id: "D6 independent carrier scan", mutate: (p) => { p.stages.push({ id: "mail", predicate: "event-present-independent", eventType: "courier_pickup_confirmed", allowedProvenance: ["independent_carrier_scan"] }); }, code: "positive-stage-not-bound-by-tier" },
    { id: "D7 swapped committed order", mutate: (p) => { [p.stages[0], p.stages[1]] = [p.stages[1]!, p.stages[0]!]; } },
  ];
  it.each(programMutants)("$id changes the committed hash and catches the named check", ({ mutate, code }) => {
    const program = freshProgram();
    mutate(program);
    expect(computeCommittedProgramHash(program)).not.toBe(computeCommittedProgramHash(freshProgram()));
    const checked = checkCommittedProgramForTier(program, tierOf(freshCsd(), 1));
    if (code === undefined) {
      expect(checked).toEqual({ violations: [], unenforcedTierEvidence: [] });
      expect(program.stages.map((s) => s.id)).not.toEqual(["print-ok", "print-not-failed", "auth"]);
    } else {
      expect(checked.violations.map((v) => v.code)).toContain(code);
    }
  });

  async function changedLadder(csd: CSD): Promise<TierLadderV1> {
    const ladder = await compileTierLadder(csd);
    expect(computeTierLadderDigest(ladder)).not.toBe(computeTierLadderDigest(await compileTierLadder(freshCsd())));
    return ladder;
  }

  it("D8(a): a machine log changes the digest, exact primitive/event/tier pins and program binding", async () => {
    const csd = freshCsd();
    tierOf(csd, 1).primitives = [{ id: "machine.execution_log", bind: "printer_log_captured" }];
    tierOf(csd, 1).required.push("printer_log_captured");
    const ladder = await changedLadder(csd);
    expect(tier1ExactPrimitiveSet(ladder)).toBe(false);
    expect(primitivePinsHold(ladder)).toBe(false);
    expect(eventPinsHold(ladder)).toBe(false);
    expect(achievedTierPinsHold(ladder)).toBe(false);
    expect(checkCommittedProgramForTier(freshProgram(), tierOf(csd, 1)).violations.map((v) => v.code)).toContain("positive-stage-not-bound-by-tier");
  });

  it("D8(b): carrier confirmation changes the digest; exact pins reject even a verified-subset primitive", async () => {
    const csd = freshCsd();
    tierOf(csd, 1).primitives!.push({ id: "confirm.target_system", params: { channel: "webhook", matcher: "carrier.delivery_scan" }, bind: "courier_delivery_confirmed" });
    tierOf(csd, 1).required.push("courier_delivery_confirmed");
    const ladder = await changedLadder(csd);
    expect(tier1ExactPrimitiveSet(ladder)).toBe(false);
    expect(tier1VerifiedSubset(ladder)).toBe(true);
    expect(primitivePinsHold(ladder)).toBe(false);
    expect(eventPinsHold(ladder)).toBe(false);
    expect(achievedTierPinsHold(ladder)).toBe(false);
    expect(assertAcceptedProgramForTier(gateInput(csd))).toEqual({
      ok: false, code: "tier-not-eligible", reasons: [KNOWN_GAP, 'tier1: primitive "confirm.target_system" verifier not implemented (stub)'],
    });
  });

  it("D8(c): supporting receipt changes the digest and cannot prove the program's release stage", async () => {
    const csd = freshCsd();
    const receipt = tierOf(csd, 1).primitives![0]!;
    receipt.params = { ...receipt.params, role: "supporting" };
    const ladder = await changedLadder(csd);
    expect(tier1ExactPrimitiveSet(ladder)).toBe(false);
    expect(primitivePinsHold(ladder)).toBe(false);
    expect(checkCommittedProgramForTier(freshProgram(), tierOf(csd, 1)).violations.map((v) => v.code)).toContain("positive-stage-on-supporting-evidence");
  });

  it("D8(d): removing the declaration changes the digest and fails the tier0 primitive floor", async () => {
    const csd = freshCsd();
    tierOf(csd, 0).primitives = [];
    const ladder = await changedLadder(csd);
    expect(tier0DeclarationSet(ladder)).toBe(false);
    expect(primitivePinsHold(ladder)).toBe(false);
  });

  it("D8(e): removing started changes the digest and wrongly grants a failed-only bundle the floor", async () => {
    const csd = freshCsd();
    tierOf(csd, 0).required = [];
    const ladder = await changedLadder(csd);
    expect(eventPinsHold(ladder)).toBe(false);
    expect(achievedTierPinsHold(ladder)).toBe(false);
    expect(achievedTierFromEventTypes(ladder, ["execution_failed"])).toBe(0);
  });
});
