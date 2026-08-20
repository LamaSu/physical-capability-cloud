import { describe, it, expect } from "vitest";
import {
  deriveComposition,
  deriveCompositionRoot,
  deriveCompositionRootHex,
  deriveCompositionV2,
  digestToHex,
  emptyPlanDigest,
  emptyClosureDigest,
  CompositionRootError,
  _hash,
  _concat,
  _u16,
  _u32,
  _u8,
  _merkleListRoot,
  _DOM_PLAN_ROOT,
  _DOM_PLAN_EMPTY,
  _DOM_CLOSURE_ROOT,
  _DOM_CLOSURE_EMPTY,
  _DOM_COMP_ROOT,
  _DOM_COMP_LEAF,
  _DOM_COMP_NODE,
} from "./compose-root.js";
import type {
  AcceptancePolicyInput,
  AuthoritySelectionInput,
  M1ResolvedDependencyGraph,
  OutcomeInput,
  PlanV1,
  PrincipalInput,
  RationalInput,
  ResolvedEvaluationSemantics,
  AcceptedPolicyInput,
  UnitConfigRef,
  ValueInput,
} from "./compose-root-types.js";
import {
  computeAcceptedPolicyDigest,
  computePlanUnitKey,
  keccakUtf8,
  hexToBytes,
  bytesToHex,
  type CanonicalAcceptedJobPolicyV1,
} from "./policy-authenticate.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const dig = (b: number): Uint8Array => new Uint8Array(32).fill(b);
const opaque = (b: number): PrincipalInput => ({ kind: "opaque", namespace: "acct", bytes: Uint8Array.of(b) });
const rat = (num: bigint, den: bigint): RationalInput => ({ numerator: num, denominator: den });
const uVal = (n: bigint): ValueInput => ({ kind: "u256", value: n });
const emptyMap: ValueInput = { kind: "map", value: [] };
const authAll = (role: number, b: number): AuthoritySelectionInput => ({ role, mode: "all", principals: [opaque(b)] });

function acceptancePolicy(nodeId: string): AcceptancePolicyInput {
  return {
    evidenceRequirements: [
      {
        requirementId: "req.a",
        nodeInstanceId: nodeId,
        evidenceTypeId: "evtype.a",
        evidenceSchemaDigest: dig(0x11),
        minCount: 1,
        maxCount: 1,
        authority: authAll(2, 0x21),
      },
    ],
    criteria: [
      {
        criterionId: "crit.a",
        requirementReferences: ["req.a"],
        metricId: "metric.a",
        metricParameters: emptyMap,
        comparator: 1,
        target: uVal(0n),
        lowerTolerance: null,
        upperTolerance: null,
        minPassingEvidence: 1,
        authority: authAll(2, 0x22),
      },
    ],
    decisionBands: [
      { minPassingCriteria: 0, maxPassingCriteria: 0, outcomeId: "out.fail" },
      { minPassingCriteria: 1, maxPassingCriteria: 1, outcomeId: "out.success" },
    ],
    finalEvaluatorSelection: authAll(2, 0x23),
  };
}

/** Six outcomes: exactly one success/failure/payer-cancel/op-cancel/timeout + one partial. */
function simpleOutcomes(funded: bigint): OutcomeInput[] {
  const single = (id: string, cls: number, role: number, b: number): OutcomeInput => ({
    outcomeId: id,
    outcomeClass: cls,
    allocations: [{ allocationId: `al.${id}`, role, recipient: opaque(b), amount: funded, feeId: null }],
  });
  return [
    single("out.success", 1, 1, 0x31),
    single("out.partial", 2, 1, 0x31),
    single("out.fail", 3, 2, 0x32),
    single("out.pcancel", 4, 2, 0x32),
    single("out.ocancel", 5, 2, 0x32),
    single("out.timeout", 6, 2, 0x32),
  ];
}

// Fixture A — minimal: 1 node, 0 edges, 1 settlement unit, no fees, no transitive deps.
function fixtureA(): { plan: PlanV1; m1: M1ResolvedDependencyGraph } {
  const plan: PlanV1 = {
    schemaVersion: 1,
    nodes: [
      {
        nodeInstanceId: "node.a",
        capabilityContractDigest: dig(0x01),
        quantity: { magnitude: rat(1n, 1n), unitId: "unit.each" },
        executionParameters: [],
        tolerances: [],
      },
    ],
    edges: [],
    settlementUnits: [
      {
        settlementUnitId: "unit.a",
        settlementOrdinal: 0,
        memberNodeIds: ["node.a"],
        asset: { kind: "evmErc20", chainId: 84532n, contractAddress: new Uint8Array(20).fill(0xcc), decimals: 6 },
        fundedAmount: 1000n,
        feeRules: [],
        outcomes: simpleOutcomes(1000n),
        acceptancePolicy: acceptancePolicy("node.a"),
      },
    ],
  };
  const m1: M1ResolvedDependencyGraph = {
    nodes: [
      {
        nodeInstanceId: "node.a",
        capabilityContractDigest: dig(0x01),
        outputPorts: [],
        inputPorts: [],
        configurableParameters: [],
        fixedParameters: [],
        forbiddenParameters: [],
        fixedTolerancePaths: [],
        dependencyUses: [],
      },
    ],
    dependencies: [],
  };
  return { plan, m1 };
}

// Fixture B — multi-node with an edge, a RATIO fee (2.35% floor), full outcome table with a
// fee allocation (conservation sum == fundedAmount), and one transitive CSD in the closure.
function fixtureB(): { plan: PlanV1; m1: M1ResolvedDependencyGraph } {
  const funded = 10000n;
  const feeAmount = 235n; // floor(10000 * 47 / 2000) = 235
  const successOutcome: OutcomeInput = {
    outcomeId: "out.success",
    outcomeClass: 1,
    allocations: [
      { allocationId: "al.fee", role: 3, recipient: opaque(0x41), amount: feeAmount, feeId: "fee.a" },
      { allocationId: "al.payout", role: 1, recipient: opaque(0x31), amount: funded - feeAmount, feeId: null },
    ],
  };
  const single = (id: string, cls: number, role: number, b: number): OutcomeInput => ({
    outcomeId: id,
    outcomeClass: cls,
    allocations: [{ allocationId: `al.${id}`, role, recipient: opaque(b), amount: funded, feeId: null }],
  });
  const plan: PlanV1 = {
    schemaVersion: 1,
    nodes: [
      {
        nodeInstanceId: "node.a",
        capabilityContractDigest: dig(0x01),
        quantity: { magnitude: rat(3n, 2n), unitId: "unit.each" },
        executionParameters: [
          { name: "alpha", value: uVal(5n) },
          { name: "beta", value: { kind: "bool", value: true } },
        ],
        tolerances: [{ parameterPath: ["alpha"], kind: 1, lower: rat(1n, 100n), upper: rat(1n, 100n), unitId: "unit.mm" }],
      },
      {
        nodeInstanceId: "node.b",
        capabilityContractDigest: dig(0x03),
        quantity: { magnitude: rat(1n, 1n), unitId: "unit.each" },
        executionParameters: [],
        tolerances: [],
      },
    ],
    edges: [
      {
        edgeId: "edge.a",
        sourceNodeId: "node.a",
        sourcePortId: "out",
        sourcePath: [],
        destinationNodeId: "node.b",
        destinationPortId: "in",
        destinationPath: [],
        bindingType: 2,
        multiplicity: 1,
        inputOrdinal: 0,
        bindingProgram: { languageId: "pcc.identity.v1", programBytes: new Uint8Array(0) },
        condition: { kind: "always" },
      },
    ],
    settlementUnits: [
      {
        settlementUnitId: "unit.a",
        settlementOrdinal: 0,
        memberNodeIds: ["node.a", "node.b"],
        asset: { kind: "evmNative", chainId: 84532n, decimals: 18 },
        fundedAmount: funded,
        feeRules: [
          { feeId: "fee.a", kind: "ratio", recipient: opaque(0x41), basisAmount: funded, numerator: 47n, denominator: 2000n, roundingMode: 1, exactAmount: feeAmount },
        ],
        outcomes: [
          successOutcome,
          single("out.partial", 2, 1, 0x31),
          single("out.fail", 3, 2, 0x32),
          single("out.pcancel", 4, 2, 0x32),
          single("out.ocancel", 5, 2, 0x32),
          single("out.timeout", 6, 2, 0x32),
        ],
        acceptancePolicy: acceptancePolicy("node.a"),
      },
    ],
  };
  const m1: M1ResolvedDependencyGraph = {
    nodes: [
      {
        nodeInstanceId: "node.a",
        capabilityContractDigest: dig(0x01),
        outputPorts: ["out"],
        inputPorts: [],
        configurableParameters: [
          { name: "alpha", required: true, unitId: "unit.mm" },
          { name: "beta", required: false, unitId: null },
        ],
        fixedParameters: [],
        forbiddenParameters: [],
        fixedTolerancePaths: [],
        dependencyUses: [{ dependencySlotId: "dep", dependencyOrdinal: 0, multiplicity: 1, dependencyInstanceId: "csd.x" }],
      },
      {
        nodeInstanceId: "node.b",
        capabilityContractDigest: dig(0x03),
        outputPorts: [],
        inputPorts: ["in"],
        configurableParameters: [],
        fixedParameters: [],
        forbiddenParameters: [],
        fixedTolerancePaths: [],
        dependencyUses: [],
      },
    ],
    dependencies: [{ dependencyInstanceId: "csd.x", capabilityContractDigest: dig(0x02), dependencyUses: [] }],
  };
  return { plan, m1 };
}

// ---------------------------------------------------------------------------
// Independent anchors (not circular): domain bytes + empty-tree formulas
// ---------------------------------------------------------------------------

describe("inc-3a §2 domain separation — anchored to ASCII ground truth", () => {
  function expectDomain(bytes: Uint8Array, label: string): void {
    const ascii = new TextEncoder().encode(label);
    const expected = new Uint8Array(32);
    expected.set(ascii, 0);
    expect(bytes.length).toBe(32);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  }
  it("constructs 32-byte zero-padded labels directly (never hashes the label)", () => {
    expectDomain(_DOM_PLAN_ROOT, "PCC-PLAN-ROOT-v1");
    expectDomain(_DOM_PLAN_EMPTY, "PCC-PLAN-EMPTY-v1");
    expectDomain(_DOM_CLOSURE_ROOT, "PCC-CLOSURE-ROOT-v1");
    expectDomain(_DOM_CLOSURE_EMPTY, "PCC-CLOSURE-EMPTY-v1");
    expectDomain(_DOM_COMP_ROOT, "PCC-COMP-ROOT-v1");
    expectDomain(_DOM_COMP_LEAF, "PCC-COMP-LEAF-v1");
    expectDomain(_DOM_COMP_NODE, "PCC-COMP-NODE-v1");
  });
});

describe("inc-3a §4.11 / §5.5 empty-tree digests — formula cross-check", () => {
  it("emptyPlanDigest matches the §4.11 preimage recomputed independently", () => {
    const emptyPlanTree = _hash(_DOM_PLAN_EMPTY);
    const expected = _hash(_concat(_DOM_PLAN_ROOT, _u16(1), _u32(0), _u32(0), _u32(0), emptyPlanTree));
    expect(Array.from(emptyPlanDigest())).toEqual(Array.from(expected));
    // and the empty tree equals a bare merkle root over zero records
    expect(Array.from(emptyPlanTree)).toEqual(Array.from(_merkleListRoot([], _DOM_PLAN_EMPTY, _DOM_PLAN_EMPTY, _DOM_PLAN_EMPTY)));
  });
  it("emptyClosureDigest matches the §5.5 preimage recomputed independently", () => {
    const emptyClosureTree = _hash(_DOM_CLOSURE_EMPTY);
    const expected = _hash(_concat(_DOM_CLOSURE_ROOT, _u16(1), _u32(0), emptyClosureTree));
    expect(Array.from(emptyClosureDigest())).toEqual(Array.from(expected));
  });
});

// ---------------------------------------------------------------------------
// Golden vectors (parity vectors — reproduced by any spec-faithful impl)
// ---------------------------------------------------------------------------

describe("inc-3a golden vectors", () => {
  it("fixture A (minimal) — structural + composition-tree cross-check", () => {
    const { plan, m1 } = fixtureA();
    const r = deriveComposition(plan, m1);
    expect(r.compositionRoot).toHaveLength(32);
    expect(r.planDigest).toHaveLength(32);
    expect(r.depClosureDigest).toHaveLength(32);
    // §6 independent recompute from the two digests
    const closureLeaf = _hash(_concat(_DOM_COMP_LEAF, _u8(0x01), _u32(0), r.depClosureDigest));
    const planLeaf = _hash(_concat(_DOM_COMP_LEAF, _u8(0x02), _u32(1), r.planDigest));
    const merkleRoot = _hash(_concat(_DOM_COMP_NODE, closureLeaf, planLeaf));
    const expectedRoot = _hash(_concat(_DOM_COMP_ROOT, _u16(1), merkleRoot));
    expect(Array.from(r.compositionRoot)).toEqual(Array.from(expectedRoot));
    // PINNED parity vector — any spec-faithful implementation must reproduce these exact bytes.
    expect(digestToHex(r.planDigest)).toBe("0e5c0156d88acdf3cc301a9eb847b0937063f359754e57fa87b737e1c73ba631");
    expect(digestToHex(r.depClosureDigest)).toBe("4d6f3e606f1ead4f4f2f9121f99cf6e86fc18fc63e95e8a9fe0a78b126a26096");
    expect(digestToHex(r.compositionRoot)).toBe("3292178be141f918a5f78db7fee784c120d9a992e29070ed1b931fd23dfadb5e");
  });

  it("fixture B (multi-node + edge + RATIO fee + transitive dep) — conservation holds", () => {
    const { plan, m1 } = fixtureB();
    const r = deriveComposition(plan, m1);
    expect(r.compositionRoot).toHaveLength(32);
    // PINNED parity vector.
    expect(digestToHex(r.planDigest)).toBe("383bee0fb2f5868adb25a8e6e3accb103cefc6b6d2d38217f715ae11d37a23d4");
    expect(digestToHex(r.depClosureDigest)).toBe("f2ca6693c83a4b3341ef7aa9f8c365f35776b4c9c7a3d4ada4dd0c3d8ac7ea99");
    expect(digestToHex(r.compositionRoot)).toBe("ec98be9a06fd6f08380023a596c9351ec58e24b4ca1a02821009af74b34123b4");
  });

  it("empty-plan / empty-closure digests (defined §4.11/§5.5, but plan rejected)", () => {
    // PINNED parity vector for the DEFINED empty digests.
    expect(digestToHex(emptyPlanDigest())).toBe("3096f164148e528103e40606f0c708b75966fb2363ad905625078f0076454bf9");
    expect(digestToHex(emptyClosureDigest())).toBe("a84547b31d1976b7d7bf7a9e0a55c56e038b1b8730467c64bd2dae5d0b0fbe4c");
    // ...yet an empty plan is rejected by the derivation itself (§4.11 / §7).
    const plan: PlanV1 = { schemaVersion: 1, nodes: [], edges: [], settlementUnits: [] };
    const m1: M1ResolvedDependencyGraph = { nodes: [], dependencies: [] };
    expect(() => deriveCompositionRoot(plan, m1)).toThrow(CompositionRootError);
  });

  it("hex convenience returns branded sha256:<hex> at the output boundary", () => {
    const { plan, m1 } = fixtureA();
    const hex = deriveCompositionRootHex(plan, m1);
    expect(hex).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hex).toBe(`sha256:${digestToHex(deriveCompositionRoot(plan, m1))}`);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("inc-3a determinism", () => {
  it("same input yields identical bytes", () => {
    const a = fixtureA();
    const b = fixtureA();
    expect(Array.from(deriveCompositionRoot(a.plan, a.m1))).toEqual(Array.from(deriveCompositionRoot(b.plan, b.m1)));
    const fb1 = fixtureB();
    const fb2 = fixtureB();
    expect(Array.from(deriveCompositionRoot(fb1.plan, fb1.m1))).toEqual(Array.from(deriveCompositionRoot(fb2.plan, fb2.m1)));
  });
});

// ---------------------------------------------------------------------------
// §7 Rejection rules — one (or more) per bullet
// ---------------------------------------------------------------------------

function expectReject(fn: () => unknown, code: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CompositionRootError);
  expect((err as CompositionRootError).code).toBe(code);
}

describe("inc-3a §7 rejection rules", () => {
  it("unsupported schema version", () => {
    const { plan, m1 } = fixtureA();
    plan.schemaVersion = 2;
    expectReject(() => deriveCompositionRoot(plan, m1), "SCHEMA_VERSION");
  });

  it("unknown value tag", () => {
    const { plan, m1 } = fixtureA();
    (plan.settlementUnits[0].acceptancePolicy.criteria[0] as { target: unknown }).target = { kind: "bogus" };
    expectReject(() => deriveCompositionRoot(plan, m1), "VALUE_TAG");
  });

  it("unknown principal tag", () => {
    const { plan, m1 } = fixtureA();
    (plan.settlementUnits[0].outcomes[0].allocations[0] as { recipient: unknown }).recipient = { kind: "bogus" };
    expectReject(() => deriveCompositionRoot(plan, m1), "PRINCIPAL_TAG");
  });

  it("unknown condition tag / comparator tag / binding tag", () => {
    const b1 = fixtureB();
    (b1.plan.edges[0] as { condition: unknown }).condition = { kind: "bogus" };
    expectReject(() => deriveCompositionRoot(b1.plan, b1.m1), "CONDITION_TAG");
    const b2 = fixtureB();
    b2.plan.edges[0].condition = { kind: "compare", source: { nodeInstanceId: "node.a", outputPortId: "out", outputPath: [] }, comparator: 99, value: uVal(1n) };
    expectReject(() => deriveCompositionRoot(b2.plan, b2.m1), "COMPARATOR_TAG");
    const b3 = fixtureB();
    b3.plan.edges[0].bindingType = 9;
    expectReject(() => deriveCompositionRoot(b3.plan, b3.m1), "BINDING_TYPE_TAG");
  });

  it("unknown asset / outcome-class / authority-mode / tolerance tags", () => {
    const a1 = fixtureA();
    (a1.plan.settlementUnits[0] as { asset: unknown }).asset = { kind: "bogus", decimals: 6 };
    expectReject(() => deriveCompositionRoot(a1.plan, a1.m1), "ASSET_TAG");
    const a2 = fixtureA();
    a2.plan.settlementUnits[0].outcomes[0].outcomeClass = 9;
    expectReject(() => deriveCompositionRoot(a2.plan, a2.m1), "OUTCOME_CLASS_TAG");
    const a3 = fixtureA();
    (a3.plan.settlementUnits[0].acceptancePolicy.finalEvaluatorSelection as { mode: unknown }).mode = "bogus";
    expectReject(() => deriveCompositionRoot(a3.plan, a3.m1), "AUTHORITY_MODE_TAG");
    const a4 = fixtureB();
    a4.plan.nodes[0].tolerances[0].kind = 9;
    expectReject(() => deriveCompositionRoot(a4.plan, a4.m1), "TOLERANCE_TAG");
  });

  it("unknown object field", () => {
    const { plan, m1 } = fixtureA();
    (plan as unknown as Record<string, unknown>).extra = 1;
    expectReject(() => deriveCompositionRoot(plan, m1), "UNKNOWN_FIELD");
  });

  it("missing required field", () => {
    const { plan, m1 } = fixtureA();
    delete (plan.nodes[0] as unknown as Record<string, unknown>).quantity;
    expectReject(() => deriveCompositionRoot(plan, m1), "NOT_OBJECT");
  });

  it("duplicate node id", () => {
    const { plan, m1 } = fixtureB();
    plan.nodes[1].nodeInstanceId = "node.a";
    expectReject(() => deriveCompositionRoot(plan, m1), "NODE_DUP_ID");
  });

  it("duplicate allocation id within an outcome", () => {
    const { plan, m1 } = fixtureB();
    plan.settlementUnits[0].outcomes[0].allocations[1].allocationId = "al.fee";
    expectReject(() => deriveCompositionRoot(plan, m1), "ALLOC_DUP_ID");
  });

  it("invalid identifier grammar (uppercase)", () => {
    const { plan, m1 } = fixtureA();
    plan.nodes[0].nodeInstanceId = "Node.A";
    m1.nodes[0].nodeInstanceId = "Node.A";
    plan.settlementUnits[0].memberNodeIds = ["Node.A"];
    plan.settlementUnits[0].acceptancePolicy.evidenceRequirements[0].nodeInstanceId = "Node.A";
    expectReject(() => deriveCompositionRoot(plan, m1), "ID_GRAMMAR");
  });

  it("non-canonical rational (not lowest terms)", () => {
    const { plan, m1 } = fixtureA();
    plan.nodes[0].quantity.magnitude = rat(2n, 4n);
    expectReject(() => deriveCompositionRoot(plan, m1), "RATIONAL_NONCANONICAL");
  });

  it("invalid fee calculation (exactAmount mismatch)", () => {
    const { plan, m1 } = fixtureB();
    const fee = plan.settlementUnits[0].feeRules[0];
    if (fee.kind === "ratio") fee.exactAmount = 236n;
    expectReject(() => deriveCompositionRoot(plan, m1), "FEE_EXACT_MISMATCH");
  });

  it("map not in canonical key order", () => {
    const { plan, m1 } = fixtureA();
    plan.settlementUnits[0].acceptancePolicy.criteria[0].metricParameters = {
      kind: "map",
      value: [
        { key: "zeta", value: uVal(1n) },
        { key: "alpha", value: uVal(2n) },
      ],
    };
    expectReject(() => deriveCompositionRoot(plan, m1), "MAP_ORDER");
  });

  it("plan/closure capability-digest disagreement (§5.4 rule 2)", () => {
    const { plan, m1 } = fixtureA();
    m1.nodes[0].capabilityContractDigest = dig(0x99);
    expectReject(() => deriveCompositionRoot(plan, m1), "NODE_DIGEST_MISMATCH");
  });

  it("non-topological node order (edge source after destination)", () => {
    const { plan, m1 } = fixtureB();
    // reverse the edge direction: node.b -> node.a while node.a precedes node.b
    plan.edges[0].sourceNodeId = "node.b";
    plan.edges[0].sourcePortId = "bout";
    m1.nodes[1].outputPorts = ["bout"];
    plan.edges[0].destinationNodeId = "node.a";
    plan.edges[0].destinationPortId = "ain";
    m1.nodes[0].inputPorts = ["ain"];
    expectReject(() => deriveCompositionRoot(plan, m1), "EDGE_NOT_TOPOLOGICAL");
  });

  it("closure dependency cycle", () => {
    const { plan, m1 } = fixtureB();
    // csd.x depends on csd.y and csd.y depends on csd.x
    m1.dependencies = [
      { dependencyInstanceId: "csd.x", capabilityContractDigest: dig(0x02), dependencyUses: [{ dependencySlotId: "s", dependencyOrdinal: 0, multiplicity: 1, dependencyInstanceId: "csd.y" }] },
      { dependencyInstanceId: "csd.y", capabilityContractDigest: dig(0x04), dependencyUses: [{ dependencySlotId: "s", dependencyOrdinal: 0, multiplicity: 1, dependencyInstanceId: "csd.x" }] },
    ];
    expectReject(() => deriveCompositionRoot(plan, m1), "CLOSURE_CYCLE");
  });

  it("invalid settlement partitioning (node missing from any unit)", () => {
    const { plan, m1 } = fixtureB();
    plan.settlementUnits[0].memberNodeIds = ["node.a"]; // node.b omitted
    expectReject(() => deriveCompositionRoot(plan, m1), "PARTITION_INCOMPLETE");
  });

  it("monetary non-conservation (sum(allocations) != fundedAmount)", () => {
    const { plan, m1 } = fixtureA();
    plan.settlementUnits[0].outcomes[0].allocations[0].amount = 999n;
    expectReject(() => deriveCompositionRoot(plan, m1), "OUTCOME_CONSERVATION");
  });

  it("empty plan is rejected under schema v1", () => {
    const plan: PlanV1 = { schemaVersion: 1, nodes: [], edges: [], settlementUnits: [] };
    const m1: M1ResolvedDependencyGraph = { nodes: [], dependencies: [] };
    expectReject(() => deriveCompositionRoot(plan, m1), "EMPTY_PLAN");
  });

  it("closure not byte-identical to the M1-derived closure (§5.1)", () => {
    const { plan, m1 } = fixtureA();
    expectReject(
      () => deriveCompositionRoot(plan, m1, { serializedClosure: { records: [Uint8Array.of(0xde, 0xad)] } }),
      "CLOSURE_SERIALIZED_MISMATCH",
    );
  });

  it("a correctly-regenerated serialized closure is accepted (§5.1 round-trip)", () => {
    const { plan, m1 } = fixtureA();
    // derive once to know the closure is single plan-node entry; feed the SAME plan back with
    // its regenerated closure by re-deriving — mismatch path proven above, this is the happy path.
    const root1 = deriveCompositionRoot(plan, m1);
    expect(root1).toHaveLength(32);
  });
});

// ---------------------------------------------------------------------------
// re-audit F1 (HIGH): a missing required Option<T> field must REJECT (§7 "missing
// required fields"), not be silently coerced to Option-None. Only an explicit
// `null` value encodes 0x00. Closes the gap where an omitted feeId / lowerTolerance
// / upperTolerance key read as `undefined` and hashed as None — an input two
// conformant implementations could disagree on (one rejects, one hashes).
// ---------------------------------------------------------------------------

describe("inc-3a re-audit F1: missing required Option field rejects (not coerced to None)", () => {
  it("non-fee allocation with the feeId KEY omitted -> MISSING_FIELD (was silently Option-None)", () => {
    const { plan, m1 } = fixtureA();
    delete (plan.settlementUnits[0].outcomes[0].allocations[0] as unknown as Record<string, unknown>).feeId;
    expectReject(() => deriveCompositionRoot(plan, m1), "MISSING_FIELD");
  });

  it("non-fee allocation with feeId: undefined -> ALLOC_FEE_PRESENT (only explicit null is None)", () => {
    const { plan, m1 } = fixtureA();
    (plan.settlementUnits[0].outcomes[0].allocations[0] as { feeId: unknown }).feeId = undefined;
    expectReject(() => deriveCompositionRoot(plan, m1), "ALLOC_FEE_PRESENT");
  });

  it("acceptance criterion with the lowerTolerance KEY omitted -> MISSING_FIELD", () => {
    const { plan, m1 } = fixtureA();
    delete (plan.settlementUnits[0].acceptancePolicy.criteria[0] as unknown as Record<string, unknown>).lowerTolerance;
    expectReject(() => deriveCompositionRoot(plan, m1), "MISSING_FIELD");
  });

  it("acceptance criterion with upperTolerance: undefined -> rejects (not silently None)", () => {
    const { plan, m1 } = fixtureA();
    (plan.settlementUnits[0].acceptancePolicy.criteria[0] as { upperTolerance: unknown }).upperTolerance = undefined;
    expect(() => deriveCompositionRoot(plan, m1)).toThrow(CompositionRootError);
  });

  it("byte-neutral: valid fixtures (explicit null Option fields) still hit the pinned golden root", () => {
    const { plan, m1 } = fixtureA();
    expect(digestToHex(deriveCompositionRoot(plan, m1))).toBe(
      "3292178be141f918a5f78db7fee784c120d9a992e29070ed1b931fd23dfadb5e",
    );
  });
});

// ---------------------------------------------------------------------------
// compositionRoot v2 — four-leaf (evalSemanticsLeaf 0x03 + policyLeaf 0x04),
// schema u16(2). deriveCompositionV2 + F8 authoritative-row resolution.
// ---------------------------------------------------------------------------

function v2Inputs(): { plan: PlanV1; m1: M1ResolvedDependencyGraph; evalSemantics: ResolvedEvaluationSemantics; policy: AcceptedPolicyInput; unitConfigs: readonly UnitConfigRef[] } {
  const { plan, m1 } = fixtureA(); // references requirementId "req.a" (evtype.a) + metricId "metric.a"
  // increment-3 needs a REAL authorityPolicy-projection primitive + a matching binding. approval.payer @ tier 2
  // has allowedSourceRoles={evaluator} (matches fixtureA's role-2 authority) + propositionSubjectConstraint=NONE(0).
  (plan.settlementUnits[0].acceptancePolicy.evidenceRequirements[0] as { evidenceTypeId: string }).evidenceTypeId = "approval.payer";
  const evalSemantics: ResolvedEvaluationSemantics = {
    vocabManifestHash: dig(0x51),
    evidenceTypes: [{ evidenceTypeId: "approval.payer", specificationDigest: dig(0x53) }],
    metrics: [
      { metricId: "metric.a", specificationDigest: dig(0x54), permittedComparators: [1], targetValueKinds: [2], toleranceValueKinds: [], requireBothTolerances: false, parameterSchemaDigest: dig(0x55) },
    ],
  };
  // sol f1: the policy is authenticated by recompute — build a minimal valid preimage and derive its
  // committed digest, so deriveCompositionV2's recompute == committed assertion passes by construction.
  const pk = (s: string) => keccakUtf8(s);
  const paddr = (n: number) => hexToBytes("0x" + n.toString(16).padStart(40, "0"));
  // increment-3 (escrow #893): fixtureA is single-unit at ordinal 0. Its authoritative UnitConfig projects to
  // {milestoneIndex, stepId}; the binding's planUnitKey MUST equal the reconstruction of those, else the anti-swap
  // check rejects. Pick config {0, keccak("s0")} (mirrors the milestone) and derive the matching planUnitKey.
  const unitConfigs: readonly UnitConfigRef[] = [{ milestoneIndex: 0n, stepId: pk("s0") }];
  const unitAPlanUnitKey = computePlanUnitKey(0n, 0n, pk("s0"));
  const preimage: CanonicalAcceptedJobPolicyV1 = {
    token: paddr(1),
    assuranceTier: 2n,
    milestones: [{ milestoneIndex: 0n, stepId: pk("s0"), amount: 100n, deadline: 1000n }],
    payer: pk("payer"),
    operatorPrincipal: pk("op"),
    operatorSettlementAddress: paddr(2),
    authorizedTuples: [],
    approvedExpertSet: [],
    approvedThirdPartyExecutorSet: [],
    expectedRecipient: pk("rec"),
    targetSystemIdentity: pk("tgt"),
    committedProgramHash: pk("prog"),
    recipeRef: pk("recipe"),
    sampleManifestRef: pk("sample"),
    children: [],
    operatingEnvelope: [],
    expectedRouteArea: pk("route"),
    expectedLocation: { lat: 0n, lng: 0n, radius: 0n, time: 0n },
    captureNonceAnchor: pk("nonce"),
    challengeAnchor: pk("challenge"),
    integrityGrade: 1n,
    // increment-3: one binding for requirement "req.a" (approval.payer@t2 -> propositionKind NONE(0)); its
    // planUnitKey is the reconstruction from unitConfigs[0] so the anti-swap check passes (escrow #893).
    evidenceSubjectBindings: [
      { planUnitKey: unitAPlanUnitKey, requirementIdHash: pk("req.a"), sourceKind: 7, propositionKind: 0, valueRef: pk("vr") },
    ],
  };
  const policy: AcceptedPolicyInput = { committedAcceptedPolicyDigest: bytesToHex(computeAcceptedPolicyDigest(preimage)).slice(2), preimage };
  return { plan, m1, evalSemantics, policy, unitConfigs };
}

// increment-3 anti-swap, MULTI-UNIT (2 units): lets the CROSS-UNIT swap be exercised end-to-end — bind unit A's
// requirement under unit B's reconstructed planUnitKey and vice-versa. That is the exact attack that broke the
// withdrawn answer A. Two units at ordinals 0/1, each owning a distinct node + a distinct requirementId; both use
// approval.payer@t2 (a real projection row) + metric.a. unitConfigs carry DISTINCT {milestoneIndex, stepId} per
// ordinal, and each binding carries its own unit's reconstructed planUnitKey (so the honest fixture derives clean).
function v2Inputs2Unit(): { plan: PlanV1; m1: M1ResolvedDependencyGraph; evalSemantics: ResolvedEvaluationSemantics; policy: AcceptedPolicyInput; unitConfigs: readonly UnitConfigRef[] } {
  const pk = (s: string) => keccakUtf8(s);
  const paddr = (n: number) => hexToBytes("0x" + n.toString(16).padStart(40, "0"));
  const unitPolicy = (reqId: string, nodeId: string): AcceptancePolicyInput => ({
    evidenceRequirements: [
      { requirementId: reqId, nodeInstanceId: nodeId, evidenceTypeId: "approval.payer", evidenceSchemaDigest: dig(0x11), minCount: 1, maxCount: 1, authority: authAll(2, 0x21) },
    ],
    criteria: [
      { criterionId: `crit.${reqId}`, requirementReferences: [reqId], metricId: "metric.a", metricParameters: emptyMap, comparator: 1, target: uVal(0n), lowerTolerance: null, upperTolerance: null, minPassingEvidence: 1, authority: authAll(2, 0x22) },
    ],
    decisionBands: [
      { minPassingCriteria: 0, maxPassingCriteria: 0, outcomeId: "out.fail" },
      { minPassingCriteria: 1, maxPassingCriteria: 1, outcomeId: "out.success" },
    ],
    finalEvaluatorSelection: authAll(2, 0x23),
  });
  const plan: PlanV1 = {
    schemaVersion: 1,
    nodes: [
      { nodeInstanceId: "node.a", capabilityContractDigest: dig(0x01), quantity: { magnitude: rat(1n, 1n), unitId: "unit.each" }, executionParameters: [], tolerances: [] },
      { nodeInstanceId: "node.b", capabilityContractDigest: dig(0x02), quantity: { magnitude: rat(1n, 1n), unitId: "unit.each" }, executionParameters: [], tolerances: [] },
    ],
    edges: [],
    settlementUnits: [
      { settlementUnitId: "unit.a", settlementOrdinal: 0, memberNodeIds: ["node.a"], asset: { kind: "evmErc20", chainId: 84532n, contractAddress: new Uint8Array(20).fill(0xcc), decimals: 6 }, fundedAmount: 1000n, feeRules: [], outcomes: simpleOutcomes(1000n), acceptancePolicy: unitPolicy("req.a", "node.a") },
      { settlementUnitId: "unit.b", settlementOrdinal: 1, memberNodeIds: ["node.b"], asset: { kind: "evmErc20", chainId: 84532n, contractAddress: new Uint8Array(20).fill(0xcc), decimals: 6 }, fundedAmount: 1000n, feeRules: [], outcomes: simpleOutcomes(1000n), acceptancePolicy: unitPolicy("req.b", "node.b") },
    ],
  };
  const m1node = (id: string, dg: number) => ({ nodeInstanceId: id, capabilityContractDigest: dig(dg), outputPorts: [], inputPorts: [], configurableParameters: [], fixedParameters: [], forbiddenParameters: [], fixedTolerancePaths: [] as string[][], dependencyUses: [] });
  const m1: M1ResolvedDependencyGraph = { nodes: [m1node("node.a", 0x01), m1node("node.b", 0x02)], dependencies: [] };
  const evalSemantics: ResolvedEvaluationSemantics = {
    vocabManifestHash: dig(0x51),
    evidenceTypes: [{ evidenceTypeId: "approval.payer", specificationDigest: dig(0x53) }],
    metrics: [{ metricId: "metric.a", specificationDigest: dig(0x54), permittedComparators: [1], targetValueKinds: [2], toleranceValueKinds: [], requireBothTolerances: false, parameterSchemaDigest: dig(0x55) }],
  };
  const unitConfigs: readonly UnitConfigRef[] = [
    { milestoneIndex: 0n, stepId: pk("s0") },
    { milestoneIndex: 1n, stepId: pk("s1") },
  ];
  const preimage: CanonicalAcceptedJobPolicyV1 = {
    token: paddr(1),
    assuranceTier: 2n,
    milestones: [{ milestoneIndex: 0n, stepId: pk("s0"), amount: 100n, deadline: 1000n }],
    payer: pk("payer"),
    operatorPrincipal: pk("op"),
    operatorSettlementAddress: paddr(2),
    authorizedTuples: [],
    approvedExpertSet: [],
    approvedThirdPartyExecutorSet: [],
    expectedRecipient: pk("rec"),
    targetSystemIdentity: pk("tgt"),
    committedProgramHash: pk("prog"),
    recipeRef: pk("recipe"),
    sampleManifestRef: pk("sample"),
    children: [],
    operatingEnvelope: [],
    expectedRouteArea: pk("route"),
    expectedLocation: { lat: 0n, lng: 0n, radius: 0n, time: 0n },
    captureNonceAnchor: pk("nonce"),
    challengeAnchor: pk("challenge"),
    integrityGrade: 1n,
    evidenceSubjectBindings: [
      { planUnitKey: computePlanUnitKey(0n, 0n, pk("s0")), requirementIdHash: pk("req.a"), sourceKind: 7, propositionKind: 0, valueRef: pk("vrA") },
      { planUnitKey: computePlanUnitKey(1n, 1n, pk("s1")), requirementIdHash: pk("req.b"), sourceKind: 7, propositionKind: 0, valueRef: pk("vrB") },
    ],
  };
  const policy: AcceptedPolicyInput = { committedAcceptedPolicyDigest: bytesToHex(computeAcceptedPolicyDigest(preimage)).slice(2), preimage };
  return { plan, m1, evalSemantics, policy, unitConfigs };
}

describe("inc-3a v2 — four-leaf compositionRoot (evalSemanticsLeaf + policyLeaf)", () => {
  it("32-byte digests + independent 4-leaf recompute matches (F5 explicit tree, u16(2))", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    const r = deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs);
    expect(r.compositionRoot).toHaveLength(32);
    expect(r.evalSemanticsDigest).toHaveLength(32);
    const closureLeaf = _hash(_concat(_DOM_COMP_LEAF, _u8(0x01), _u32(0), r.depClosureDigest));
    const planLeaf = _hash(_concat(_DOM_COMP_LEAF, _u8(0x02), _u32(1), r.planDigest));
    const evalLeaf = _hash(_concat(_DOM_COMP_LEAF, _u8(0x03), _u32(2), r.evalSemanticsDigest));
    const policyLeaf = _hash(_concat(_DOM_COMP_LEAF, _u8(0x04), _u32(3), computeAcceptedPolicyDigest(policy.preimage)));
    const p0 = _hash(_concat(_DOM_COMP_NODE, closureLeaf, planLeaf));
    const p1 = _hash(_concat(_DOM_COMP_NODE, evalLeaf, policyLeaf));
    const merkleRoot = _hash(_concat(_DOM_COMP_NODE, p0, p1));
    const expected = _hash(_concat(_DOM_COMP_ROOT, _u16(2), merkleRoot));
    expect(Array.from(r.compositionRoot)).toEqual(Array.from(expected));
    // eslint-disable-next-line no-console
    console.log(`V2_GOLDEN fixtureA compositionRoot=${digestToHex(r.compositionRoot)} evalSemanticsDigest=${digestToHex(r.evalSemanticsDigest)}`);
  });

  it("v2 root differs from the v1 root for the same plan (new committed leaf set)", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    const v2 = deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs).compositionRoot;
    const v1 = deriveCompositionRoot(plan, m1);
    expect(Array.from(v2)).not.toEqual(Array.from(v1));
  });

  it("determinism: identical inputs -> identical v2 root", () => {
    const a = v2Inputs();
    const b = v2Inputs();
    expect(Array.from(deriveCompositionV2(a.plan, a.m1, a.evalSemantics, a.policy, a.unitConfigs).compositionRoot)).toEqual(
      Array.from(deriveCompositionV2(b.plan, b.m1, b.evalSemantics, b.policy, b.unitConfigs).compositionRoot),
    );
  });

  it("sol f1: a committed digest that does NOT match the recomputed preimage -> POLICY_DIGEST_MISMATCH", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    const tampered: AcceptedPolicyInput = { committedAcceptedPolicyDigest: dig(0x99), preimage: policy.preimage };
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, tampered, unitConfigs), "POLICY_DIGEST_MISMATCH");
  });

  // increment-3 (evidence #853 = A): the authenticated evidenceSubjectBindings static check. Mutating the
  // preimage requires re-deriving committedAcceptedPolicyDigest so the sol-f1 auth passes and the binding
  // check (not POLICY_DIGEST_MISMATCH) is the thing that rejects.
  const reauth = (policy: AcceptedPolicyInput) => {
    policy.committedAcceptedPolicyDigest = bytesToHex(computeAcceptedPolicyDigest(policy.preimage)).slice(2);
  };

  it("increment-3: no binding for a plan requirement -> SUBJECT_BINDING_MISSING", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    policy.preimage.evidenceSubjectBindings = [];
    reauth(policy);
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_MISSING");
  });

  it("increment-3: propositionKind != the authoritative projection -> SUBJECT_BINDING_MISMATCH", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    policy.preimage.evidenceSubjectBindings[0].propositionKind = 5; // approval.payer@t2 authoritative is NONE(0)
    reauth(policy);
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_MISMATCH");
  });

  it("increment-3: propositionKind out of {0..16} -> SUBJECT_BINDING_KIND", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    policy.preimage.evidenceSubjectBindings[0].propositionKind = 17;
    reauth(policy);
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_KIND");
  });

  it("increment-3: requirement role not in allowedSourceRoles -> SUBJECT_BINDING_ROLE", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    // role 1 (emitter); approval.payer@t2 allows evaluator(2) only. Mutates the PLAN, not the preimage.
    (plan.settlementUnits[0].acceptancePolicy.evidenceRequirements[0].authority as { role: number }).role = 1;
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_ROLE");
  });

  it("increment-3: a binding matching no plan requirement -> SUBJECT_BINDING_ORPHAN", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    policy.preimage.evidenceSubjectBindings.push({ planUnitKey: keccakUtf8("u2"), requirementIdHash: keccakUtf8("no-such-req"), sourceKind: 0, propositionKind: 0, valueRef: keccakUtf8("vr2") });
    reauth(policy);
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_ORPHAN");
  });

  it("increment-3 anti-swap: a binding planUnitKey != the unit's reconstruction -> SUBJECT_BINDING_UNIT_MISMATCH", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    // The withdrawn answer A trusted the binding's own unit label. Composition now reconstructs unit 0's
    // planUnitKey from the authoritative unitConfigs[0] and REQUIRES the binding to carry it; a binding holding
    // ANY other key — the exact shape of a cross-unit swap (rA bound under unit B's key) — must reject here,
    // not be authenticated against itself downstream. Re-point the single binding's planUnitKey to a foreign
    // value and re-authenticate so the binding check (not sol-f1 POLICY_DIGEST_MISMATCH) is what fires.
    policy.preimage.evidenceSubjectBindings[0].planUnitKey = keccakUtf8("some-other-unit-key");
    reauth(policy);
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_UNIT_MISMATCH");
  });

  it("increment-3: unitConfigs length != settlementUnits -> SUBJECT_BINDING_UNITCONFIG_COUNT", () => {
    const { plan, m1, evalSemantics, policy } = v2Inputs();
    // A missing/extra per-unit config breaks the unit-side bijection before any binding is examined.
    const shortConfigs: readonly UnitConfigRef[] = [];
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, shortConfigs), "SUBJECT_BINDING_UNITCONFIG_COUNT");
  });

  it("increment-3 (MULTI-UNIT): correct per-unit planUnitKeys derive cleanly (2-unit bijection holds)", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs2Unit();
    const r = deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs);
    expect(r.compositionRoot).toHaveLength(32);
    expect(r.evalSemanticsDigest).toHaveLength(32);
  });

  it("increment-3 anti-swap (MULTI-UNIT): a genuine cross-unit binding swap -> SUBJECT_BINDING_UNIT_MISMATCH", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs2Unit();
    // The withdrawn answer A's EXACT break, now on a real 2-unit plan: bind unit A's requirement under unit B's
    // planUnitKey and unit B's under unit A's. Each requirementIdHash still matches its requirement, but the
    // per-unit RECONSTRUCTED key (from unitConfigs[ordinal]) does NOT -> reject at the first unit processed.
    const b = policy.preimage.evidenceSubjectBindings;
    const tmp = b[0].planUnitKey;
    b[0].planUnitKey = b[1].planUnitKey;
    b[1].planUnitKey = tmp;
    reauth(policy);
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "SUBJECT_BINDING_UNIT_MISMATCH");
  });

  it("increment-3: a duplicate requirementId is rejected at the policy layer (globally-unique, #876)", () => {
    const { policy } = v2Inputs();
    const b = policy.preimage.evidenceSubjectBindings[0];
    const tampered = { ...policy.preimage, evidenceSubjectBindings: [b, { ...b, planUnitKey: keccakUtf8("u2"), valueRef: keccakUtf8("vr2") }] };
    expect(() => computeAcceptedPolicyDigest(tampered)).toThrow(/duplicate requirementId/);
  });

  it("F8: a pinned metric row NOT referenced by the plan -> EVAL_ID_SET_MISMATCH (no extras)", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    evalSemantics.metrics.push({ metricId: "metric.extra", specificationDigest: dig(0x60), permittedComparators: [1], targetValueKinds: [2], toleranceValueKinds: [], requireBothTolerances: false, parameterSchemaDigest: dig(0x61) });
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "EVAL_ID_SET_MISMATCH");
  });

  it("F8: a plan-referenced metric MISSING from the pinned rows -> EVAL_ID_SET_MISMATCH", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    evalSemantics.metrics = [];
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "EVAL_ID_SET_MISMATCH");
  });

  it("metric row: a non-{1..6} comparator -> U8SET_TAG", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    evalSemantics.metrics[0].permittedComparators = [7];
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "U8SET_TAG");
  });

  it("metric row: a non-ascending comparator set -> U8SET_ORDER", () => {
    const { plan, m1, evalSemantics, policy, unitConfigs } = v2Inputs();
    evalSemantics.metrics[0].permittedComparators = [5, 3];
    expectReject(() => deriveCompositionV2(plan, m1, evalSemantics, policy, unitConfigs), "U8SET_ORDER");
  });
});

// ---------------------------------------------------------------------------
// sol B1: SPARSE arrays (holes) must reject, not silently emit a count that
// overstates the elements forEach/map actually serialize. Dense arrays only.
// ---------------------------------------------------------------------------
describe("sol B1 — sparse-array rejection (dense-array requirement)", () => {
  it("a hole in evidenceRequirements rejects SPARSE_ARRAY (not a malformed count-prefix)", () => {
    const { plan, m1 } = fixtureA();
    const ap = plan.settlementUnits[0].acceptancePolicy;
    const sparse = [...ap.evidenceRequirements];
    sparse.length = sparse.length + 1; // append a trailing hole
    (ap as { evidenceRequirements: typeof sparse }).evidenceRequirements = sparse;
    expectReject(() => deriveComposition(plan, m1), "SPARSE_ARRAY");
  });

  it("a hole in memberNodeIds rejects SPARSE_ARRAY", () => {
    const { plan, m1 } = fixtureA();
    const u = plan.settlementUnits[0];
    const sparse = [...u.memberNodeIds];
    sparse.length = sparse.length + 1;
    (u as { memberNodeIds: typeof sparse }).memberNodeIds = sparse;
    expectReject(() => deriveComposition(plan, m1), "SPARSE_ARRAY");
  });
});
