/**
 * inc-3a — TypeScript input types for the producer-side composition-root
 * derivation (composition schema version 1).
 *
 * These types are the *logical* input shapes that `deriveCompositionRoot`
 * encodes byte-exactly per the specification at
 * `ai/research/pcc-inc3a-compositionroot-derivation-spec.md`.
 *
 * Design notes:
 * - Enum-like wire tags (roles, classes, comparators, binding types, tolerance
 *   kinds, rounding modes) are typed as `number` so that "unknown tag" rejection
 *   (spec §7) is a runtime gate exercisable without TS casts.
 * - Tagged unions (Value / Principal / Asset / Condition / FeeRule /
 *   AuthoritySelection) use a string `kind` discriminant chosen for TS
 *   ergonomics; the wire tag byte is produced by the encoder's mapping.
 * - Digest fields accept a raw 32-byte `Uint8Array` OR a hex string (optionally
 *   `sha256:`-prefixed). Normalization to raw 32 bytes happens at the INPUT
 *   boundary, never inside a hash preimage.
 * - Optionality is explicit: `T | null`. An absent option (`null`) and a present
 *   empty value are distinct (spec §1.4, §7).
 * - Maps are ordered arrays of `{ key, value }`; canonical (strictly increasing)
 *   key order is validated, not imposed (spec §1.4, §7).
 */

/** Raw 32-byte digest at the input boundary: bytes, or 64-hex (opt. `sha256:` prefix). */
export type Digest32Input = Uint8Array | string;

/** A rational number: numerator / denominator (spec §1.3). */
export interface RationalInput {
  numerator: bigint;
  denominator: bigint;
}

/** A canonical Value (spec §1.4). */
export type ValueInput =
  | { kind: "bool"; value: boolean }
  | { kind: "u256"; value: bigint }
  | { kind: "i256"; value: bigint }
  | { kind: "rational"; value: RationalInput }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "id"; value: string }
  | { kind: "digest"; value: Digest32Input }
  | { kind: "list"; value: ValueInput[] }
  | { kind: "map"; value: ValueMapEntry[] };

/** One entry of a Value map (spec §1.4). Keys are Ids; order is validated. */
export interface ValueMapEntry {
  key: string;
  value: ValueInput;
}

/** A measure: rational magnitude in a named unit (spec §1.5). */
export interface MeasureInput {
  magnitude: RationalInput;
  unitId: string;
}

/** A tolerance over a parameter path (spec §1.5). `kind`: 1 ABSOLUTE, 2 RELATIVE, 3 INTERVAL. */
export interface ToleranceInput {
  parameterPath: string[];
  kind: number;
  lower: RationalInput;
  upper: RationalInput;
  unitId: string;
}

/** A principal identity (spec §1.6). */
export type PrincipalInput =
  | { kind: "evmAccount"; chainId: bigint; address: Uint8Array | string }
  | { kind: "ed25519Key"; publicKey: Uint8Array | string }
  | { kind: "did"; did: string }
  | { kind: "opaque"; namespace: string; bytes: Uint8Array };

/** An asset identity plus atomic-unit decimals (spec §1.7). */
export type AssetInput =
  | { kind: "evmNative"; chainId: bigint; decimals: number }
  | { kind: "evmErc20"; chainId: bigint; contractAddress: Uint8Array | string; decimals: number }
  | { kind: "opaque"; namespace: string; reference: Uint8Array; decimals: number };

/** A named execution parameter value on a node (spec §4.2). */
export interface ExecutionParameterInput {
  name: string;
  value: ValueInput;
}

/** A plan node record (spec §4.2). Node order = funded execution (topological) order. */
export interface NodeInput {
  nodeInstanceId: string;
  capabilityContractDigest: Digest32Input;
  quantity: MeasureInput;
  executionParameters: ExecutionParameterInput[];
  tolerances: ToleranceInput[];
}

/** A source reference into a node output (spec §4.3). */
export interface SourceRefInput {
  nodeInstanceId: string;
  outputPortId: string;
  outputPath: string[];
}

/** An edge condition (spec §4.3). Order in ALL/ANY is significant. */
export type ConditionInput =
  | { kind: "always" }
  | { kind: "outputExists"; source: SourceRefInput }
  | { kind: "compare"; source: SourceRefInput; comparator: number; value: ValueInput }
  | { kind: "all"; children: ConditionInput[] }
  | { kind: "any"; children: ConditionInput[] }
  | { kind: "not"; child: ConditionInput };

/** A binding program (spec §4.3). `pcc.identity.v1` requires empty programBytes. */
export interface BindingProgramInput {
  languageId: string;
  programBytes: Uint8Array;
}

/** A plan edge record (spec §4.4). `bindingType`: 1 Material, 2 Data, 3 Control, 4 Prerequisite-only. */
export interface EdgeInput {
  edgeId: string;
  sourceNodeId: string;
  sourcePortId: string;
  sourcePath: string[];
  destinationNodeId: string;
  destinationPortId: string;
  destinationPath: string[];
  bindingType: number;
  multiplicity: number;
  inputOrdinal: number;
  bindingProgram: BindingProgramInput;
  condition: ConditionInput;
}

/** A fee rule (spec §4.5). */
export type FeeRuleInput =
  | { feeId: string; kind: "fixed"; recipient: PrincipalInput; exactAmount: bigint }
  | {
      feeId: string;
      kind: "ratio";
      recipient: PrincipalInput;
      basisAmount: bigint;
      numerator: bigint;
      denominator: bigint;
      roundingMode: number;
      exactAmount: bigint;
    };

/** A transfer allocation (spec §4.6). `role`: 1 payout, 2 refund, 3 fee, 4 other. */
export interface TransferAllocationInput {
  allocationId: string;
  role: number;
  recipient: PrincipalInput;
  amount: bigint;
  /** Present exactly for role 3 (fee); null otherwise (spec §4.6). */
  feeId: string | null;
}

/** An outcome (spec §4.6). `outcomeClass`: 1 success,2 partial,3 failure,4 payer-cancel,5 op-cancel,6 timeout. */
export interface OutcomeInput {
  outcomeId: string;
  outcomeClass: number;
  allocations: TransferAllocationInput[];
}

/** An authority selection (spec §4.7). `role`: 1 emitter, 2 evaluator, 3 oracle. */
export type AuthoritySelectionInput =
  | { role: number; mode: "all"; principals: PrincipalInput[] }
  | { role: number; mode: "mOfN"; threshold: number; principals: PrincipalInput[] }
  | { role: number; mode: "firstValid"; principals: PrincipalInput[] }
  | {
      role: number;
      mode: "externalPolicy";
      selectionPolicyId: string;
      selectionPolicyDigest: Digest32Input;
      registrySnapshotDigest: Digest32Input;
      threshold: number;
    };

/** An evidence requirement (spec §4.8). */
export interface EvidenceRequirementInput {
  requirementId: string;
  nodeInstanceId: string;
  evidenceTypeId: string;
  evidenceSchemaDigest: Digest32Input;
  minCount: number;
  maxCount: number;
  authority: AuthoritySelectionInput;
}

/** An acceptance criterion (spec §4.8). */
export interface AcceptanceCriterionInput {
  criterionId: string;
  requirementReferences: string[];
  metricId: string;
  /** Must be a Value with tag 0x09 (map) (spec §4.8). */
  metricParameters: ValueInput;
  comparator: number;
  target: ValueInput;
  lowerTolerance: ValueInput | null;
  upperTolerance: ValueInput | null;
  minPassingEvidence: number;
  authority: AuthoritySelectionInput;
}

/** A decision band (spec §4.8). */
export interface DecisionBandInput {
  minPassingCriteria: number;
  maxPassingCriteria: number;
  outcomeId: string;
}

/** An acceptance policy (spec §4.8). */
export interface AcceptancePolicyInput {
  evidenceRequirements: EvidenceRequirementInput[];
  criteria: AcceptanceCriterionInput[];
  decisionBands: DecisionBandInput[];
  finalEvaluatorSelection: AuthoritySelectionInput;
}

/** A settlement-unit record (spec §4.9). */
export interface SettlementUnitInput {
  settlementUnitId: string;
  settlementOrdinal: number;
  memberNodeIds: string[];
  asset: AssetInput;
  fundedAmount: bigint;
  feeRules: FeeRuleInput[];
  outcomes: OutcomeInput[];
  acceptancePolicy: AcceptancePolicyInput;
}

/** The funded plan (spec §4). */
export interface PlanV1 {
  /** Composition schema version. Must be 1 (spec §4.1, §7). */
  schemaVersion: number;
  /** Nodes in funded execution order (must be a valid topological order, spec §4.10). */
  nodes: NodeInput[];
  /** Edges in explicit edge order. */
  edges: EdgeInput[];
  /** Settlement units in settlement order. */
  settlementUnits: SettlementUnitInput[];
}

/**
 * One resolved dependency use of a parent CSD (spec §5.1/§5.2).
 * The child's capability-contract digest is sourced from the child dependency
 * resolution (single source of truth) — not duplicated here — which makes spec
 * §5.4 rule 8 hold by construction.
 */
export interface M1DependencyUse {
  dependencySlotId: string;
  dependencyOrdinal: number;
  multiplicity: number;
  /** The transitive dependency instance this use resolves to. */
  dependencyInstanceId: string;
}

/** Resolved-CSD metadata for a plan node instance (spec §4.2, §4.4, §5.1). */
export interface M1NodeResolution {
  nodeInstanceId: string;
  /** M1 digest of the resolved canonical CSD. Must equal the plan node's digest (spec §5.4 rule 2). */
  capabilityContractDigest: Digest32Input;
  /** Output port IDs present in the resolved CSD (edge source-port existence, spec §4.4). */
  outputPorts: string[];
  /** Input port IDs present in the resolved CSD (edge destination-port existence, spec §4.4). */
  inputPorts: string[];
  /** Parameters the CSD leaves configurable (may appear in the node's execution params). */
  configurableParameters: M1ParameterMeta[];
  /** Parameters the CSD marks fixed — a plan override is rejected (spec §4.2). */
  fixedParameters: string[];
  /** Parameters the CSD forbids — presence is rejected (spec §4.2). */
  forbiddenParameters: string[];
  /** Tolerance paths fixed by the CSD — a plan tolerance on such a path is rejected (spec §4.2). */
  fixedTolerancePaths: string[][];
  /** Ordered resolved dependency uses of this node (spec §5.1). */
  dependencyUses: M1DependencyUse[];
}

/** Resolved-CSD metadata for a transitive dependency instance (spec §5.1, §5.2). */
export interface M1DependencyResolution {
  dependencyInstanceId: string;
  /** M1 digest of the resolved canonical CSD for this dependency (spec §5.4 rule 8). */
  capabilityContractDigest: Digest32Input;
  /** Ordered resolved dependency uses of this dependency (its own children, spec §5.1). */
  dependencyUses: M1DependencyUse[];
}

/** Metadata for one configurable parameter. */
export interface M1ParameterMeta {
  name: string;
  required: boolean;
  /** Declared unit, if any. Used for the narrow tolerance-unit compatibility check (spec §4.2). */
  unitId?: string | null;
}

/**
 * The validated M1 resolution result (spec §5.1). The composition function
 * constructs the dependency closure from this; it is not an independently
 * authoritative producer-supplied view.
 */
export interface M1ResolvedDependencyGraph {
  /** One entry per plan node instance, keyed by nodeInstanceId order-independently. */
  nodes: M1NodeResolution[];
  /** Transitive CSD instances (need not be executable plan nodes). */
  dependencies: M1DependencyResolution[];
}

/**
 * Optional pre-serialized closure carried alongside the plan (spec §5.1). If
 * present it MUST regenerate byte-for-byte equal to the closure the function
 * builds from M1, else derivation rejects.
 */
export interface SerializedClosureInput {
  /** Full closure record bytes, in canonical order, one entry per record. */
  records: Uint8Array[];
}
