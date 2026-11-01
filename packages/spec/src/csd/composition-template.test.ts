import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import vectors from "./composition-template.vectors.json" with { type: "json" };
import {
  acceptedDealDigest,
  compileAcceptedPlan,
  MAX_EVIDENCE_REQUIREMENTS_PER_NODE,
  MAX_PLAN_EDGES,
  MAX_PLAN_NODES,
  type AcceptedPlanInput,
  type AcceptedPlanNode,
  type CompiledAcceptedPlan,
} from "./accepted-plan-compiler.js";
import { deriveCapabilityContractRoot } from "./composition-commitment.js";
import { planHashOf } from "./canonical-plan.js";
import { PLAN_JSON_LIMITS } from "./plan-json.js";
import { CSD_CAPABILITY_URL_PATTERN } from "../types/capability-kit.js";
import { canonicalize } from "../util/canonical.js";
import { compareCodeUnits } from "../util/code-unit-order.js";
import {
  COMPOSITION_TEMPLATE_DOMAIN,
  COMPOSITION_TEMPLATE_SCHEMA,
  COMPOSITION_TEMPLATE_SLUG_MAX_LENGTH,
  COMPOSITION_TEMPLATE_SLUG_PATTERN,
  COMPOSITE_CAPABILITY_TYPE_PREFIX,
  COMPOSITE_CSD_CLASS_PREFIX,
  MAX_COMPOSITION_TEMPLATE_VERSION,
  CompositionTemplateError,
  checkSupersession,
  compositeCapabilityType,
  compositeCapabilityUrl,
  compositionTemplateDigest,
  compositionTemplatePreimage,
  diffCompositionTemplates,
  extractCompositionTemplate,
  isCompositeCapabilityType,
  isCompositeCsdUrl,
  validateCompositionTemplate,
  type CompositionTemplateResult,
  type CompositionTemplateV1,
  type ExtractCompositionTemplateInput,
} from "./composition-template.js";

const address = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`;
const program = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`;
const digest = (byte: string) => `sha256:${byte.repeat(32)}` as `sha256:${string}`;
const PROGRAM = program("d2");
const IDENTITIES = {
  "print-kit": { url: "pcc://capabilities/document-printing/v1", contractDigest: digest("ab") },
};
const EDGES = [{ from: "a-print", to: "b-inspect" }, { from: "b-inspect", to: "c-mail" }];

function makeNode(nodeId: string, variant = 0, tiered = false): AcceptedPlanNode {
  return {
    nodeId,
    capabilityId: `private-capability-${variant}-${nodeId}`,
    capabilityType: nodeId === "c-mail" ? "mail.drop" : "document-printing",
    csd: "print-kit",
    tierKey: tiered ? "tier2" : "tier0",
    operator: address(variant === 0 ? "a1" : "b1"),
    payoutAddress: address(variant === 0 ? "a2" : "b2"),
    grossBaseUnits: variant === 0 ? 13_456_789n : 25_987_654n,
    matchedCapabilityDigest: program(variant === 0 ? "c1" : "c2"),
    committedProgramHash: tiered ? PROGRAM : null,
    evidenceRequirements: [
      { requirementId: `private-requirement-${variant}-z`, evidenceTypeId: "receipt.kernel_signed", tier: 0 },
      { requirementId: `private-requirement-${variant}-a`, evidenceTypeId: "receipt.photo", tier: tiered ? 2 : 0 },
    ],
    inputs: { z: `private-input-${variant}`, a: variant === 0 ? 163_285 : 263_285, "😀": true, "\ue000": null },
    constraints: { z: `private-constraint-${variant}`, a: variant === 0 ? 173_285 : 273_285 },
  };
}

function makePlan(variant = 0, tiered = false): AcceptedPlanInput {
  const requestId = `private-request-${variant}`;
  return {
    planId: `private-plan-${variant}`,
    requestId,
    payer: address(variant === 0 ? "11" : "22"),
    currency: "USDC",
    feeBps: 0,
    feeRecipient: address("00"),
    reclaimAt: 1_900_000_000n,
    nodes: [makeNode("a-print", variant), makeNode("b-inspect", variant, tiered), makeNode("c-mail", variant)],
    edges: EDGES.map((edge) => ({ ...edge })),
    reservation: { reservationId: `private-reservation-${variant}`, requestId, currency: "USDC", maxAmountBaseUnits: 999_999_999n },
  };
}

function compile(input = makePlan()): CompiledAcceptedPlan {
  const result = compileAcceptedPlan(input, { assertProgramForTier: () => ({ ok: true }) });
  if (!result.ok) throw new Error(JSON.stringify(result.violations));
  return result.plan;
}

function extraction(deal = compile(), partial: Partial<ExtractCompositionTemplateInput> = {}): ExtractCompositionTemplateInput {
  return { deal, edges: EDGES, csdIdentities: IDENTITIES, slug: "print-and-mail", version: 1, supersedes: null, ...partial };
}

function unwrap(result: CompositionTemplateResult): CompositionTemplateV1 {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.refusals));
  return result.template;
}

function template(tiered = false): CompositionTemplateV1 {
  return unwrap(extractCompositionTemplate(extraction(compile(makePlan(0, tiered)))));
}

function clone<T>(value: T): T { return structuredClone(value); }

function refusalCodes(result: { ok: boolean; refusals?: readonly { code: string }[] }): string[] {
  expect(result.ok).toBe(false);
  return result.refusals?.map((refusal) => refusal.code) ?? [];
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

function expectFrozen(value: unknown): void {
  if (value !== null && typeof value === "object") {
    expect(Object.isFrozen(value)).toBe(true);
    for (const item of Object.values(value)) expectFrozen(item);
  }
}

function refreshRoot(value: CompositionTemplateV1): CompositionTemplateV1 {
  value.contractRoot = deriveCapabilityContractRoot({
    requestId: "composition-template",
    nodes: value.nodes.map((node) => ({
      nodeId: node.nodeId,
      capabilityType: node.capabilityType,
      matchStatus: "none" as const,
      evidenceRequirements: node.evidence.map((entry, index) => ({ requirementId: `e${index}`, ...entry })),
    })),
    edges: value.edges,
    ...(value.verificationProgramHash === null ? {} : { verificationProgramHash: value.verificationProgramHash }),
  }, { version: 3 }) as `0x${string}`;
  return value;
}

function reseal(deal: CompiledAcceptedPlan, refreshPlans = true): CompiledAcceptedPlan {
  if (refreshPlans) for (const binding of deal.nodeToUnit) binding.planHash = planHashOf(binding.canonicalPlan);
  deal.acceptedDealDigest = acceptedDealDigest(deal);
  return deal;
}

describe("composition templates", () => {
  it("T1 extracts identical bytes after deal bindings and execution values change", () => {
    const deals = [compile(makePlan(0)), compile(makePlan(1))];
    const extracted = deals.map((deal) => unwrap(extractCompositionTemplate(extraction(deal))));
    const preimages = extracted.map(compositionTemplatePreimage);
    expect(preimages[0]).toBe(preimages[1]);
    expect(compositionTemplateDigest(extracted[0]!)).toBe(compositionTemplateDigest(extracted[1]!));
    expect(deals[0]!.acceptedDealDigest).not.toBe(deals[1]!.acceptedDealDigest);
    for (let variant = 0; variant < deals.length; variant++) {
      const source = makePlan(variant);
      const hidden = [source.payer, source.planId, source.requestId, source.reservation.reservationId];
      for (const node of source.nodes) {
        hidden.push(node.operator, node.payoutAddress, node.capabilityId, node.matchedCapabilityDigest, node.grossBaseUnits.toString());
        hidden.push(...node.evidenceRequirements.map((entry) => entry.requirementId));
        hidden.push(`private-input-${variant}`, `private-constraint-${variant}`, variant === 0 ? "163285" : "263285", variant === 0 ? "173285" : "273285");
      }
      hidden.push(...deals[variant]!.jobs.map((job) => job.jobId));
      for (const preimage of preimages) for (const value of hidden) expect(preimage).not.toContain(value);
    }
    expect(preimages[0]).not.toContain("requirementId");
    expect(preimages[0]).not.toContain("capabilityId");
    expect(preimages[0]).not.toContain("tierKey");
  });

  it.each([false, true])("T2 preserves the sealed contract root when tiered=%s", (tiered) => {
    const deal = compile(makePlan(0, tiered));
    const extracted = unwrap(extractCompositionTemplate(extraction(deal)));
    expect(extracted.contractRoot).toBe(deal.capabilityContractRoot);
    expect(extracted.verificationProgramHash).toBe(tiered ? PROGRAM : null);
  });

  it("T3 publishes a successor without changing either frozen accepted deal", () => {
    const priorDeal = freezeDeep(compile(makePlan(0, true)));
    const nextDeal = freezeDeep(compile(makePlan(1, true)));
    const prior = unwrap(extractCompositionTemplate(extraction(priorDeal)));
    const next = unwrap(extractCompositionTemplate(extraction(nextDeal, { version: 2, supersedes: compositionTemplateDigest(prior) })));
    expect(compositionTemplateDigest(next)).not.toBe(compositionTemplateDigest(prior));
    expect(checkSupersession(prior, next)).toEqual({ ok: true });
    expect(acceptedDealDigest(priorDeal)).toBe(priorDeal.acceptedDealDigest);
    expect(acceptedDealDigest(nextDeal)).toBe(nextDeal.acceptedDealDigest);
    expectFrozen(priorDeal);
    expectFrozen(nextDeal);
  });

  it("T4 refuses cycles supplied to extraction and validation with only cycle", () => {
    const edges = [...EDGES, { from: "c-mail", to: "a-print" }];
    expect(refusalCodes(extractCompositionTemplate(extraction(compile(), { edges })))).toEqual(["cycle"]);
    const value = clone(template());
    value.edges = edges;
    expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["cycle"]);
  });

  it("T4 refuses a duplicate node with only duplicate-node", () => {
    const value = clone(template());
    value.nodes.push(clone(value.nodes[0]!));
    expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["duplicate-node"]);
  });

  it("T4 refuses missing CSD identities with only unknown-csd", () => {
    const input = makePlan();
    input.nodes = [input.nodes[0]!];
    input.edges = [];
    expect(refusalCodes(extractCompositionTemplate(extraction(compile(input), { edges: [], csdIdentities: {} })))).toEqual(["unknown-csd"]);
  });

  it.each(["constructor", "toString"])("T4 never resolves inherited CSD identity %s", (csd) => {
    const input = makePlan();
    input.nodes = [{ ...input.nodes[0]!, csd }];
    input.edges = [];
    expect(refusalCodes(extractCompositionTemplate(extraction(compile(input), { edges: [], csdIdentities: {} })))).toEqual(["unknown-csd"]);
  });

  it("T5 normalizes all list orders and preserves identity after revalidation and JSON round trip", () => {
    const original = template(true);
    const reordered = clone(original);
    reordered.nodes.reverse();
    reordered.edges.reverse();
    for (const node of reordered.nodes) {
      node.evidence.reverse();
      node.inputKeys.reverse();
      node.constraintKeys.reverse();
    }
    const normalized = unwrap(validateCompositionTemplate(reordered));
    expect(normalized).toEqual(original);
    expect(compositionTemplatePreimage(reordered)).toBe(compositionTemplatePreimage(original));
    expect(compositionTemplateDigest(reordered)).toBe(compositionTemplateDigest(original));
    expect(compositionTemplatePreimage(unwrap(validateCompositionTemplate(normalized)))).toBe(compositionTemplatePreimage(original));
    expect(compositionTemplateDigest(unwrap(validateCompositionTemplate(JSON.parse(JSON.stringify(original)))))).toBe(compositionTemplateDigest(original));
    expect(normalized.nodes[0]!.inputKeys).toEqual(["a", "z", "😀", "\ue000"]);
    expect(normalized.nodes.every((node) => !Object.hasOwn(node, "kitDigest"))).toBe(true);
    expect(diffCompositionTemplates(original, reordered).identical).toBe(true);
  });

  it.each(vectors)("T6 matches golden bytes and both SHA-256 implementations for $name", (vector) => {
    const value = unwrap(validateCompositionTemplate(vector.template));
    expect(compositionTemplatePreimage(value)).toBe(vector.preimage);
    expect(compositionTemplateDigest(value)).toBe(vector.digest);
    expect(`sha256:${createHash("sha256").update(vector.preimage, "utf8").digest("hex")}`).toBe(vector.digest);
    expect(compositeCapabilityUrl(value.slug, value.version)).toBe(vector.compositeCapabilityUrl);
    expect(vector.preimage).toContain('"domain":"PCC:composition-template:v1"');
  });

  it("T6 vectors contain the tiered three-node pinned template and its valid successor", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(2);
    const first = unwrap(validateCompositionTemplate(vectors[0]!.template));
    const second = unwrap(validateCompositionTemplate(vectors[1]!.template));
    expect(first.version).toBe(1);
    expect(first.nodes).toHaveLength(3);
    expect(first.edges).toHaveLength(2);
    expect(first.nodes.some((node) => node.tier === 2)).toBe(true);
    expect(first.verificationProgramHash).not.toBeNull();
    expect(first.nodes.filter((node) => node.kitDigest !== undefined)).toHaveLength(1);
    expect(second.version).toBe(2);
    expect(checkSupersession(first, second)).toEqual({ ok: true });
  });

  it.each([
    ["dropped", [EDGES[0]!]],
    ["extra acyclic", [...EDGES, { from: "a-print", to: "c-mail" }]],
    ["reversed", [{ from: "b-inspect", to: "a-print" }, EDGES[1]!]],
  ])("T7 refuses a sealed root with an edge %s", (_name, edges) => {
    expect(refusalCodes(extractCompositionTemplate(extraction(compile(), { edges: edges as typeof EDGES })))).toEqual(["contract-root-mismatch"]);
  });

  it("T7 refuses a template with an edited contract root", () => {
    const value = clone(template());
    value.contractRoot = program("11");
    expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["contract-root-mismatch"]);
  });

  it("T8 refuses a changed canonical plan against its carried plan hash", () => {
    const deal = clone(compile());
    deal.nodeToUnit[0]!.canonicalPlan.inputs = { a: "tampered-input" };
    reseal(deal, false);
    expect(refusalCodes(extractCompositionTemplate(extraction(deal)))).toEqual(["plan-hash-mismatch"]);
  });

  it("T8 refuses a changed sealed deal digest before mapping", () => {
    const deal = clone(compile());
    deal.acceptedDealDigest = program("11");
    expect(refusalCodes(extractCompositionTemplate(extraction(deal, { csdIdentities: {} })))).toEqual(["deal-digest-mismatch"]);
  });

  it("T8 refuses a changed sealed digest before reading extraction metadata", () => {
    const deal = clone(compile());
    deal.acceptedDealDigest = program("11");
    const input = extraction(deal);
    let metadataReads = 0;
    for (const field of ["edges", "csdIdentities"] as const) {
      Object.defineProperty(input, field, {
        enumerable: true,
        get() { metadataReads++; throw new Error("unreadable metadata"); },
      });
    }
    let result: CompositionTemplateResult | undefined;
    expect(() => { result = extractCompositionTemplate(input); }).not.toThrow();
    expect(refusalCodes(result!)).toEqual(["deal-digest-mismatch"]);
    expect(metadataReads).toBe(0);
  });

  it("T8 refuses an unsealed canonical plan change with all integrity refusals", () => {
    const deal = clone(compile());
    deal.nodeToUnit[0]!.canonicalPlan.inputs = { a: "tampered-input" };
    expect(refusalCodes(extractCompositionTemplate(extraction(deal)))).toEqual(["deal-digest-mismatch", "plan-hash-mismatch"]);
  });

  it.each(["template", "node", "csd", "evidence", "edge"])("T9 refuses an unknown key on %s", (level) => {
    const value = clone(template());
    const target = { template: value, node: value.nodes[0]!, csd: value.nodes[0]!.csd, evidence: value.nodes[0]!.evidence[0]!, edge: value.edges[0]! }[level]!;
    Object.assign(target, { extra: true });
    expect(refusalCodes(validateCompositionTemplate(value))).toContain("unknown-key");
  });

  it.each(["operator", "price", "payTo", "capabilityId"])("T9 refuses deal field %s on a node", (field) => {
    const value = clone(template());
    Object.assign(value.nodes[0]!, { [field]: "private-binding" });
    expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["unknown-key"]);
  });

  it.each(["supersedes", "contractRoot", "verificationProgramHash", "contractDigest", "kitDigest"])("T9 refuses uppercase hex in %s", (field) => {
    const value = clone(template(true));
    if (field === "supersedes") { value.version = 2; value.supersedes = digest("AB"); }
    else if (field === "contractRoot") value.contractRoot = program("AB");
    else if (field === "verificationProgramHash") value.verificationProgramHash = program("AB");
    else if (field === "contractDigest") value.nodes[0]!.csd.contractDigest = digest("AB");
    else value.nodes[0]!.kitDigest = digest("AB");
    expect(refusalCodes(validateCompositionTemplate(value))).toContain(field === "contractDigest" || field === "kitDigest" ? "invalid-node-field" : "invalid-field");
  });

  it.each(["", "Upper", "has_under", "-leading", "trailing-", "two--hyphens", "a".repeat(55)])("T9 refuses invalid slug %j", (slug) => {
    const value = clone(template());
    value.slug = slug;
    expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["invalid-field"]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, MAX_COMPOSITION_TEMPLATE_VERSION + 1, NaN, Infinity])("T9 refuses invalid version %s", (version) => {
    const value = clone(template());
    value.version = version;
    expect(refusalCodes(validateCompositionTemplate(value))).toContain("invalid-field");
  });

  it("T9 requires a predecessor only after version one", () => {
    const first = clone(template());
    first.supersedes = digest("12");
    expect(refusalCodes(validateCompositionTemplate(first))).toEqual(["supersedes-on-first-version"]);
    const second = clone(template());
    second.version = 2;
    expect(refusalCodes(validateCompositionTemplate(second))).toEqual(["supersedes-required"]);
  });

  it("T9 refuses a program at all-zero tiers and an absent program at tier two", () => {
    const zero = clone(template());
    zero.verificationProgramHash = PROGRAM;
    expect(refusalCodes(validateCompositionTemplate(zero))).toEqual(["program-presence"]);
    const tiered = clone(template(true));
    tiered.verificationProgramHash = null;
    expect(refusalCodes(validateCompositionTemplate(tiered))).toEqual(["program-presence"]);
  });

  it("T9 refuses a null kit digest", () => {
    const value = clone(template());
    Object.assign(value.nodes[0]!, { kitDigest: null });
    expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["invalid-node-field"]);
  });

  it.each(["inputKeys", "constraintKeys"] as const)("T9 checks key limits, UTF-16 and uniqueness in %s", (field) => {
    for (const keys of [["__proto__"], ["\ud800"], ["\udc00"], ["a".repeat(PLAN_JSON_LIMITS.maxKeyLength + 1)], Array.from({ length: PLAN_JSON_LIMITS.maxKeysPerObject + 1 }, (_, index) => `key-${index}`)]) {
      const value = clone(template());
      value.nodes[0]![field] = keys;
      expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["invalid-node-field"]);
    }
    const duplicate = clone(template());
    duplicate.nodes[0]![field] = ["same", "same"];
    expect(refusalCodes(validateCompositionTemplate(duplicate))).toEqual(["duplicate-key"]);
    const boundary = clone(template());
    boundary.nodes[0]![field] = ["", "a".repeat(PLAN_JSON_LIMITS.maxKeyLength), "\ud83d\ude00"];
    expect(validateCompositionTemplate(boundary).ok).toBe(true);
  });

  it("T9 enforces node, edge and evidence count bounds", () => {
    const empty = clone(template());
    empty.nodes = [];
    empty.edges = [];
    expect(refusalCodes(validateCompositionTemplate(empty))).toContain("empty-template");
    const manyNodes = clone(template());
    manyNodes.nodes = Array.from({ length: MAX_PLAN_NODES + 1 }, (_, index) => ({ ...clone(manyNodes.nodes[0]!), nodeId: `n-${index}` }));
    manyNodes.edges = [];
    expect(refusalCodes(validateCompositionTemplate(manyNodes))).toContain("too-many-nodes");
    const manyEdges = clone(template());
    manyEdges.edges = Array.from({ length: MAX_PLAN_EDGES + 1 }, () => ({ ...EDGES[0]! }));
    expect(refusalCodes(validateCompositionTemplate(manyEdges))).toContain("too-many-edges");
    const manyEvidence = clone(template());
    manyEvidence.nodes[0]!.evidence = Array.from({ length: MAX_EVIDENCE_REQUIREMENTS_PER_NODE + 1 }, (_, index) => ({ evidenceTypeId: `receipt-${index}`, tier: 0 }));
    expect(refusalCodes(validateCompositionTemplate(manyEvidence))).toContain("invalid-node-field");
  });

  it("T9 refuses duplicate evidence and malformed node fields", () => {
    const duplicate = clone(template());
    duplicate.nodes[0]!.evidence.push(clone(duplicate.nodes[0]!.evidence[0]!));
    expect(refusalCodes(validateCompositionTemplate(duplicate))).toEqual(["duplicate-evidence"]);
    for (const mutation of [
      { nodeId: "bad id" }, { capabilityType: "bad type" }, { tier: -1 }, { tier: 4 }, { tier: 0.5 },
      { csd: { url: "https://invalid.example/csd", contractDigest: digest("12") } },
      { evidence: [{ evidenceTypeId: "bad id", tier: 0 }] }, { evidence: [{ evidenceTypeId: "receipt", tier: 4 }] },
    ]) {
      const value = clone(template());
      Object.assign(value.nodes[0]!, mutation);
      expect(refusalCodes(validateCompositionTemplate(value))).toContain("invalid-node-field");
    }
  });

  it("T9 refuses unknown edge endpoints, self-loops and duplicate edges", () => {
    for (const [edge, code] of [
      [{ from: "unknown", to: "b-inspect" }, "edge-unknown-node"],
      [{ from: "a-print", to: "a-print" }, "self-loop"],
      [EDGES[0]!, "duplicate-edge"],
    ] as const) {
      const value = clone(template());
      value.edges.push({ ...edge });
      expect(refusalCodes(validateCompositionTemplate(value))).toEqual([code]);
      expect(refusalCodes(extractCompositionTemplate(extraction(compile(), { edges: value.edges })))).toEqual([code]);
    }
  });

  it("T9 invalid templates cannot receive a preimage, digest or diff", () => {
    const invalid = clone(template());
    invalid.slug = "";
    for (const operation of [() => compositionTemplatePreimage(invalid), () => compositionTemplateDigest(invalid), () => diffCompositionTemplates(invalid, template()), () => diffCompositionTemplates(template(), invalid)]) {
      expect(operation).toThrow(CompositionTemplateError);
      try { operation(); } catch (error) {
        expect(error).toBeInstanceOf(CompositionTemplateError);
        expect((error as CompositionTemplateError).refusals).toEqual([{ code: "invalid-field", path: "$.slug" }]);
      }
    }
  });

  it("T10 refuses mixed committed programs", () => {
    const deal = clone(compile(makePlan(0, true)));
    const binding = deal.nodeToUnit[0]!;
    binding.tier = 2;
    binding.committedProgramHash = program("d3");
    Object.assign(binding.canonicalPlan.assurance, { tier: 2, tierKey: "tier2", committedProgramHash: program("d3") });
    reseal(deal);
    expect(refusalCodes(extractCompositionTemplate(extraction(deal)))).toContain("mixed-programs");
  });

  it.each(["binding", "assurance", "tierKey"])("T10 refuses a tier disagreement in %s", (field) => {
    const deal = clone(compile());
    const binding = deal.nodeToUnit[0]!;
    if (field === "binding") binding.tier = 2;
    else if (field === "assurance") binding.canonicalPlan.assurance.tier = 2;
    else binding.canonicalPlan.assurance.tierKey = "tier2";
    reseal(deal);
    expect(refusalCodes(extractCompositionTemplate(extraction(deal)))).toEqual(["tier-mismatch"]);
  });

  it("T10 refuses a kit pin for a node outside the deal", () => {
    expect(refusalCodes(extractCompositionTemplate(extraction(compile(), { kitDigests: { unknown: digest("11") } })))).toEqual(["kit-pin-unknown-node"]);
  });

  it("T10 carries an own kit pin and refuses malformed CSD identities", () => {
    const pinned = unwrap(extractCompositionTemplate(extraction(compile(), { kitDigests: { "a-print": digest("11") } })));
    expect(pinned.nodes[0]!.kitDigest).toBe(digest("11"));
    for (const identity of [null, {}, { url: "bad", contractDigest: digest("ab") }, { url: IDENTITIES["print-kit"].url, contractDigest: "bad" }, { ...IDENTITIES["print-kit"], extra: true }]) {
      const input = makePlan();
      input.nodes = [input.nodes[0]!];
      input.edges = [];
      const csdIdentities = { "print-kit": identity } as unknown as ExtractCompositionTemplateInput["csdIdentities"];
      expect(refusalCodes(extractCompositionTemplate(extraction(compile(input), { edges: [], csdIdentities })))).toEqual(["invalid-csd-identity"]);
    }
  });

  it("T10 checks canonical node identity and agreement between program fields", () => {
    const nodeMismatch = clone(compile());
    nodeMismatch.nodeToUnit[0]!.canonicalPlan.planNodeId = "different-node";
    reseal(nodeMismatch);
    expect(refusalCodes(extractCompositionTemplate(extraction(nodeMismatch)))).toEqual(["node-id-mismatch"]);
    const programMismatch = clone(compile(makePlan(0, true)));
    programMismatch.nodeToUnit[1]!.canonicalPlan.assurance.committedProgramHash = program("d3");
    reseal(programMismatch);
    expect(refusalCodes(extractCompositionTemplate(extraction(programMismatch)))).toEqual(["program-mismatch"]);
  });

  it("T11 reports a node added and a node removed", () => {
    const base = template(true);
    const added = clone(base);
    added.nodes.push({ ...clone(added.nodes[0]!), nodeId: "d-deliver" });
    refreshRoot(added);
    expect(diffCompositionTemplates(base, added).nodesAdded).toEqual(["d-deliver"]);
    const removed = clone(base);
    removed.nodes = removed.nodes.filter((node) => node.nodeId !== "b-inspect");
    removed.edges = [];
    removed.verificationProgramHash = null;
    refreshRoot(removed);
    expect(diffCompositionTemplates(base, removed).nodesRemoved).toEqual(["b-inspect"]);
  });

  it.each(["capabilityType", "csd", "tier", "evidence", "inputKeys", "constraintKeys", "kitDigest"] as const)("T11 reports node field %s changed", (field) => {
    const base = template(true);
    const changed = clone(base);
    const node = changed.nodes[1]!;
    if (field === "capabilityType") node.capabilityType = "inspection.photo";
    else if (field === "csd") node.csd.contractDigest = digest("34");
    else if (field === "tier") node.tier = 3;
    else if (field === "evidence") node.evidence.push({ evidenceTypeId: "confirm.inspection", tier: 2 });
    else if (field === "inputKeys") node.inputKeys.push("document");
    else if (field === "constraintKeys") node.constraintKeys.push("deadline");
    else node.kitDigest = digest("56");
    refreshRoot(changed);
    const diff = diffCompositionTemplates(base, changed);
    expect(diff.identical).toBe(false);
    expect(diff.nodesChanged).toEqual([{ nodeId: "b-inspect", fields: [field] }]);
    expect(diffCompositionTemplates(changed, base).nodesChanged).toEqual([{ nodeId: "b-inspect", fields: [field] }]);
  });

  it("T11 reports sorted added and removed edges and all top-level fields", () => {
    const base = template(true);
    const changed = clone(base);
    changed.slug = "improved-print-and-mail";
    changed.version = 2;
    changed.supersedes = compositionTemplateDigest(base);
    changed.verificationProgramHash = program("d3");
    changed.edges = [{ from: "a-print", to: "c-mail" }];
    refreshRoot(changed);
    const diff = diffCompositionTemplates(base, changed);
    expect(diff.fields).toEqual(["contractRoot", "slug", "supersedes", "verificationProgramHash", "version"]);
    expect(diff.edgesAdded).toEqual([{ from: "a-print", to: "c-mail" }]);
    expect(diff.edgesRemoved).toEqual(EDGES);
    expect(diff.nodesChanged).toEqual([]);
  });

  it("T11 reports a fully empty diff between normal-form equivalents", () => {
    const first = template(true);
    const second = clone(first);
    second.nodes.reverse();
    second.edges.reverse();
    expect(diffCompositionTemplates(first, second)).toEqual({ identical: true, fields: [], nodesAdded: [], nodesRemoved: [], nodesChanged: [], edgesAdded: [], edgesRemoved: [] });
  });

  it.each(["slug", "version", "digest"])("T12 refuses supersession with a different %s", (field) => {
    const prior = template();
    const next = clone(prior);
    next.version = 2;
    next.supersedes = compositionTemplateDigest(prior);
    if (field === "slug") next.slug = "another-lineage";
    else if (field === "version") next.version = 3;
    else next.supersedes = digest("11");
    expect(refusalCodes(checkSupersession(prior, next))).toEqual([field === "slug" ? "supersedes-slug-mismatch" : field === "version" ? "supersedes-version-gap" : "supersedes-digest-mismatch"]);
  });

  it.each(["prior", "next"] as const)("T12 identifies an invalid %s template", (which) => {
    const prior = template();
    const next = clone(prior);
    next.version = 2;
    next.supersedes = compositionTemplateDigest(prior);
    const invalid = which === "prior" ? clone(prior) : next;
    invalid.slug = "";
    expect(checkSupersession(which === "prior" ? invalid : prior, which === "next" ? invalid : next)).toEqual({ ok: false, refusals: [{ code: "invalid-template", template: which }] });
  });

  it("T12 allows a fork to start a new slug at version one", () => {
    const fork = clone(template());
    fork.slug = "new-lineage";
    expect(validateCompositionTemplate(fork).ok).toBe(true);
    expect(fork.supersedes).toBeNull();
  });

  it.each(["type", "type uppercase", "url", "url uppercase"])("T13 refuses a nested composite through %s", (kind) => {
    const value = clone(template());
    if (kind.startsWith("type")) value.nodes[0]!.capabilityType = kind.endsWith("uppercase") ? "PCC.COMPOSITE/OTHER" : compositeCapabilityType("other");
    else value.nodes[0]!.csd.url = kind.endsWith("uppercase") ? "PCC://CAPABILITIES/COMPOSITE-OTHER/V1" : compositeCapabilityUrl("other", 1);
    expect(refusalCodes(validateCompositionTemplate(value))).toContain("nested-composite");
    const input = makePlan();
    if (kind.startsWith("type")) input.nodes[0]!.capabilityType = value.nodes[0]!.capabilityType;
    const identities = kind.startsWith("type") ? IDENTITIES : { "print-kit": { ...IDENTITIES["print-kit"], url: value.nodes[0]!.csd.url } };
    expect(refusalCodes(extractCompositionTemplate(extraction(compile(input), { csdIdentities: identities })))).toContain("nested-composite");
  });

  it("T13 uses one bounded composite naming definition and case-insensitive class predicates", () => {
    expect(COMPOSITION_TEMPLATE_SCHEMA).toBe("pcc.composition-template/v1");
    expect(COMPOSITION_TEMPLATE_DOMAIN).toBe("PCC:composition-template:v1");
    expect(COMPOSITE_CAPABILITY_TYPE_PREFIX).toBe("pcc.composite/");
    expect(COMPOSITE_CSD_CLASS_PREFIX).toBe("composite-");
    expect(COMPOSITION_TEMPLATE_SLUG_MAX_LENGTH).toBe(54);
    const slug = "a".repeat(COMPOSITION_TEMPLATE_SLUG_MAX_LENGTH);
    const url = compositeCapabilityUrl(slug, MAX_COMPOSITION_TEMPLATE_VERSION);
    expect(url).toMatch(CSD_CAPABILITY_URL_PATTERN);
    expect(url).toBe(`pcc://capabilities/composite-${slug}/v${MAX_COMPOSITION_TEMPLATE_VERSION}`);
    expect(url.split("/")[3]).toHaveLength(64);
    expect(compositeCapabilityType("print-and-mail")).toBe("pcc.composite/print-and-mail");
    expect("print-and-mail").toMatch(COMPOSITION_TEMPLATE_SLUG_PATTERN);
    expect(isCompositeCapabilityType("PCC.COMPOSITE/ANY")).toBe(true);
    expect(isCompositeCapabilityType("pcc.composite-other")).toBe(false);
    expect(isCompositeCsdUrl("PCC://CAPABILITIES/COMPOSITE-ANY/V1")).toBe(true);
    expect(isCompositeCsdUrl("pcc://capabilities/plain/v1/composite-other")).toBe(false);
    expect(isCompositeCsdUrl("https://example.com/composite-other/v1")).toBe(false);
    expect(isCompositeCsdUrl("pcc://capabilities/compositely-other/v1")).toBe(false);
  });

  it.each(["a".repeat(55), "", "Bad", "two--hyphens", "bad_slug", "has space"])("T13 composite URL rejects invalid slug %j", (slug) => {
    expect(() => compositeCapabilityUrl(slug, 1)).toThrow();
  });

  it.each([0, 1.5, MAX_COMPOSITION_TEMPLATE_VERSION + 1, Number.MAX_SAFE_INTEGER + 1, NaN])("T13 composite URL rejects invalid version %s", (version) => {
    expect(() => compositeCapabilityUrl("good", version)).toThrow();
  });

  it.each([null, undefined, false, 12, "template", 4n, []])("T14 rejects non-object input %s without throwing", (value) => {
    let result: CompositionTemplateResult | undefined;
    expect(() => { result = validateCompositionTemplate(value); }).not.toThrow();
    expect(refusalCodes(result!)).toEqual(["invalid-field"]);
  });

  it("T14 refuses throwing getters and proxies as unreadable", () => {
    const getter = clone(template());
    Object.defineProperty(getter, "slug", { enumerable: true, get() { throw new Error("unreadable"); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("unreadable"); }, get() { throw new Error("unreadable"); } });
    for (const value of [getter, proxy]) {
      expect(() => validateCompositionTemplate(value)).not.toThrow();
      expect(refusalCodes(validateCompositionTemplate(value))).toEqual(["unreadable"]);
    }
  });

  it("T14 rejects a bigint version without invoking numeric coercion", () => {
    const value = clone(template());
    Object.assign(value, { version: 1n });
    expect(() => validateCompositionTemplate(value)).not.toThrow();
    expect(refusalCodes(validateCompositionTemplate(value))).toContain("invalid-field");
  });

  it("T14 extraction and supersession turn hostile reads into typed refusals", () => {
    const hostile = new Proxy({}, { get() { throw new Error("unreadable"); }, ownKeys() { throw new Error("unreadable"); } });
    expect(() => extractCompositionTemplate(hostile as ExtractCompositionTemplateInput)).not.toThrow();
    expect(refusalCodes(extractCompositionTemplate(hostile as ExtractCompositionTemplateInput))).toEqual(["unreadable"]);
    expect(() => checkSupersession(hostile as CompositionTemplateV1, template())).not.toThrow();
    expect(checkSupersession(hostile as CompositionTemplateV1, template())).toEqual({ ok: false, refusals: [{ code: "invalid-template", template: "prior" }] });
    const input = extraction();
    Object.defineProperty(input.deal, "planId", { get() { throw new Error("unreadable"); } });
    expect(refusalCodes(extractCompositionTemplate(input))).toEqual(["unreadable"]);
  });

  it("T14 owns and freezes every output reference before later input mutation", () => {
    const input = clone(template(true));
    const result = unwrap(validateCompositionTemplate(input));
    const preimage = compositionTemplatePreimage(result);
    expectFrozen(result);
    expect(result).not.toBe(input);
    expect(result.nodes).not.toBe(input.nodes);
    expect(result.nodes[0]).not.toBe(input.nodes[0]);
    expect(result.nodes[0]!.csd).not.toBe(input.nodes[0]!.csd);
    expect(result.nodes[0]!.evidence).not.toBe(input.nodes[0]!.evidence);
    expect(result.nodes[0]!.evidence[0]).not.toBe(input.nodes[0]!.evidence[0]);
    expect(result.nodes[0]!.inputKeys).not.toBe(input.nodes[0]!.inputKeys);
    expect(result.nodes[0]!.constraintKeys).not.toBe(input.nodes[0]!.constraintKeys);
    expect(result.edges[0]).not.toBe(input.edges[0]);
    input.slug = "changed";
    input.nodes[0]!.csd.url = "changed";
    input.nodes[0]!.evidence[0]!.evidenceTypeId = "changed";
    input.nodes[0]!.inputKeys.push("changed");
    input.nodes[0]!.constraintKeys.push("changed");
    input.edges[0]!.from = "changed";
    expect(compositionTemplatePreimage(result)).toBe(preimage);
  });

  it("T14 sorts all refusals by canonical JSON independently of node order", () => {
    const first = clone(template());
    Object.assign(first.nodes[0]!, { extra: true, price: 100 });
    first.nodes[1]!.inputKeys = ["same", "same"];
    const second = clone(first);
    second.nodes.reverse();
    second.edges.reverse();
    const left = validateCompositionTemplate(first);
    const right = validateCompositionTemplate(second);
    expect(left.ok).toBe(false);
    expect(right.ok).toBe(false);
    if (left.ok || right.ok) return;
    expect(left.refusals).toEqual(right.refusals);
    const canonical = left.refusals.map(canonicalize);
    expect(canonical).toEqual([...canonical].sort(compareCodeUnits));
  });
});
