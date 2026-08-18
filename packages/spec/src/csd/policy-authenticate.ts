// ===========================================================================
// policy-authenticate.ts — composition-side AUTHENTICATION of evidence's
// committed policy + authorityPolicy projection (sol comprehensive-review f1/f2).
//
// WHY: deriveCompositionV2 commits `acceptedPolicyDigest` (opaque) but must PROVE
// that the evidenceSubjectBindings + assuranceTier it statically checks are the
// ones actually committed in that digest (sol f1), and that the projection rows
// it checks against are the authoritative committed table (sol f2 / evidence
// #1014 embed-and-recompute). Both are keccak256(ethers-ABI-encode(...)) digests,
// so composition recomputes them here with keccak + a minimal ABI encoder and
// asserts equality against the committed / pinned value.
//
// The encoder is a byte-for-byte port of evidence's authoritative mirrors
// (canonical-acceptedjobpolicy-v1-mirror.cjs, authoritypolicy-projection-v1-mirror.cjs);
// its correctness is PROVEN in policy-authenticate.test.ts by reproducing evidence's
// published goldens (acceptedPolicyDigest 0xf6af20eb.., projectionDigest 0xb044b20b..).
// Only the static ABI types + single static-element dynamic arrays those digests use
// are supported — never a general ABI codec.
// ===========================================================================
import { keccak_256 } from "@noble/hashes/sha3";

export type Bytes32 = Uint8Array; // exactly 32 bytes

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** keccak256(utf8(s)) — evidence's `K(s)` domain/label helper. */
export function keccakUtf8(s: string): Bytes32 {
  return keccak256(utf8(s));
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`policy-authenticate: odd-length hex ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`policy-authenticate: bad hex ${hex}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

// ---- minimal ethers-compatible ABI words (all values fit one 32-byte slot) ----
const WORD = 32;

/** uintN as a 32-byte big-endian word (N ∈ {8,16,64,256}); rejects negatives / overflow. */
function wordUint(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("policy-authenticate: uint word is negative");
  if (v >= 1n << 256n) throw new Error("policy-authenticate: uint word overflows 256 bits");
  const out = new Uint8Array(WORD);
  let x = v;
  for (let i = WORD - 1; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** int256 as a two's-complement 32-byte word. */
function wordInt(v: bigint): Uint8Array {
  const mod = 1n << 256n;
  return wordUint(((v % mod) + mod) % mod);
}

/** bytes32 as-is (must already be 32 bytes). */
function wordBytes32(b: Uint8Array): Uint8Array {
  if (b.length !== 32) throw new Error(`policy-authenticate: bytes32 must be 32 bytes (got ${b.length})`);
  return b;
}

/** 20-byte address right-aligned into a 32-byte word (12 leading zero bytes). */
function wordAddress(b: Uint8Array): Uint8Array {
  if (b.length !== 20) throw new Error(`policy-authenticate: address must be 20 bytes (got ${b.length})`);
  const out = new Uint8Array(WORD);
  out.set(b, 12);
  return out;
}

/** ABI-encode a head of ALL-STATIC args: concatenate their 32-byte words. */
function abiStatic(words: Uint8Array[]): Uint8Array {
  return concatBytes(...words);
}

/**
 * ABI-encode a call whose single argument is a dynamic array `T[]` with STATIC
 * elements: head = offset(0x20); tail = length ‖ element-words. `elements[i]` is
 * the already-encoded 32-byte words of element i's static components, in order.
 */
function abiSingleArray(elements: Uint8Array[][]): Uint8Array {
  const parts: Uint8Array[] = [wordUint(32n), wordUint(BigInt(elements.length))];
  for (const el of elements) for (const w of el) parts.push(w);
  return concatBytes(...parts);
}

// ---- domains (evidence-owned; keccak256(utf8(label))) ----
const TERMS_DOMAIN = keccakUtf8("PCC:vnext:job-terms:v1");
const SUBJECT_DOMAIN = keccakUtf8("PCC:vnext:accepted-policy-subjects:v1");
const POLICY_DOMAIN = keccakUtf8("PCC:vnext:accepted-job-policy:v1");
const PROJECTION_DOMAIN = keccakUtf8("PCC:vnext:authoritypolicy-projection:v1");

// ---------------------------------------------------------------------------
// CanonicalAcceptedJobPolicyV1 -> acceptedPolicyDigest (port of the mirror)
// All bytes32/address are Uint8Array; all ints are bigint.
// ---------------------------------------------------------------------------

export interface Milestone {
  milestoneIndex: bigint;
  stepId: Bytes32;
  amount: bigint;
  deadline: bigint;
}
export interface Tuple3 {
  operator: Bytes32;
  kernel: Bytes32;
  device: Bytes32;
}
export interface ChildUnit {
  childJobId: Bytes32;
  childEscrow: Uint8Array; // 20-byte address
}
export interface EnvelopeBand {
  metric: Bytes32;
  min: bigint;
  max: bigint;
}
export interface ExpectedLocation {
  lat: bigint;
  lng: bigint;
  radius: bigint;
  time: bigint;
}
export interface SubjectBinding {
  settlementUnitId: Bytes32;
  requirementIdHash: Bytes32; // keccak256(utf8(requirementId))
  sourceKind: number; // SubjectSelector u8
  propositionKind: number; // SubjectSelector u8
  valueRef: Bytes32;
}
export interface CanonicalAcceptedJobPolicyV1 {
  // (i) terms it supersets:
  token: Uint8Array; // 20-byte address
  assuranceTier: bigint;
  milestones: Milestone[];
  // (ii) subject values:
  payer: Bytes32;
  operatorPrincipal: Bytes32;
  operatorSettlementAddress: Uint8Array; // 20-byte address
  authorizedTuples: Tuple3[];
  approvedExpertSet: Bytes32[];
  approvedThirdPartyExecutorSet: Bytes32[];
  expectedRecipient: Bytes32;
  targetSystemIdentity: Bytes32;
  committedProgramHash: Bytes32;
  recipeRef: Bytes32;
  sampleManifestRef: Bytes32;
  children: ChildUnit[];
  operatingEnvelope: EnvelopeBand[];
  expectedRouteArea: Bytes32;
  expectedLocation: ExpectedLocation;
  captureNonceAnchor: Bytes32;
  challengeAnchor: Bytes32;
  integrityGrade: bigint;
  // (iii) per-requirement bindings:
  evidenceSubjectBindings: SubjectBinding[];
}

export function computeMilestonesRoot(ms: Milestone[]): Bytes32 {
  // tuple(uint256 milestoneIndex, bytes32 stepId, uint256 amount, uint64 deadline)[]
  const elements = ms.map((m) => [wordUint(m.milestoneIndex), wordBytes32(m.stepId), wordUint(m.amount), wordUint(m.deadline)]);
  return keccak256(abiSingleArray(elements));
}

export function computeTermsHash(p: CanonicalAcceptedJobPolicyV1): Bytes32 {
  const milestonesRoot = computeMilestonesRoot(p.milestones);
  // abi(bytes32 TERMS_DOMAIN, address token, uint8 tier, bytes32 milestonesRoot)
  return keccak256(abiStatic([wordBytes32(TERMS_DOMAIN), wordAddress(p.token), wordUint(p.assuranceTier), wordBytes32(milestonesRoot)]));
}

/** keccak256(abi(tuple(bytes32 metric, uint256 min, uint256 max)[])) — the operatingEnvelope commitment.
 * Exported because it doubles as a binding valueRef (the OPERATING_ENVELOPE proposition). */
export function computeOperatingEnvelopeHash(bands: EnvelopeBand[]): Bytes32 {
  return keccak256(abiSingleArray(bands.map((b) => [wordBytes32(b.metric), wordUint(b.min), wordUint(b.max)])));
}

/** Dedup + ascending-byte sort a bytes32 set (mirror `sortHex`; sol: alias-independent, no author order). */
function sortBytes32Set(xs: Bytes32[]): Bytes32[] {
  const seen = new Set<string>();
  const uniq: Bytes32[] = [];
  for (const x of xs) {
    const h = bytesToHex(x);
    if (!seen.has(h)) { seen.add(h); uniq.push(x); }
  }
  return uniq.sort(compareBytes32);
}

/** Sort a tuple set by the JSON-of-hex key (mirror `sortTup` — sort only). */
function sortTupleSet<T>(xs: T[], parts: (t: T) => Uint8Array[]): T[] {
  const key = (t: T) => JSON.stringify(parts(t).map(bytesToHex)).toLowerCase();
  return [...xs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function computeSubjectBlockHash(p: CanonicalAcceptedJobPolicyV1): Bytes32 {
  // sets are canonical-sorted (+ bytes32 sets deduped) — sol order-malleability fix (evidence 999e6bdb).
  const authorizedTuplesRoot = keccak256(
    abiSingleArray(sortTupleSet(p.authorizedTuples, (t) => [t.operator, t.kernel, t.device]).map((t) => [wordBytes32(t.operator), wordBytes32(t.kernel), wordBytes32(t.device)])),
  );
  const expertSetRoot = keccak256(abiSingleArray(sortBytes32Set(p.approvedExpertSet).map((x) => [wordBytes32(x)])));
  const executorSetRoot = keccak256(abiSingleArray(sortBytes32Set(p.approvedThirdPartyExecutorSet).map((x) => [wordBytes32(x)])));
  const childrenRoot = keccak256(abiSingleArray(sortTupleSet(p.children, (c) => [c.childJobId, c.childEscrow]).map((c) => [wordBytes32(c.childJobId), wordAddress(c.childEscrow)])));
  const operatingEnvelopeHash = computeOperatingEnvelopeHash(p.operatingEnvelope);
  const expectedLocationHash = keccak256(
    abiStatic([wordInt(p.expectedLocation.lat), wordInt(p.expectedLocation.lng), wordUint(p.expectedLocation.radius), wordUint(p.expectedLocation.time)]),
  );
  // 19 fields: SUBJECT_DOMAIN + 2 bytes32 + address + 14 bytes32 + uint8
  return keccak256(
    abiStatic([
      wordBytes32(SUBJECT_DOMAIN),
      wordBytes32(p.payer),
      wordBytes32(p.operatorPrincipal),
      wordAddress(p.operatorSettlementAddress),
      wordBytes32(authorizedTuplesRoot),
      wordBytes32(expertSetRoot),
      wordBytes32(executorSetRoot),
      wordBytes32(p.expectedRecipient),
      wordBytes32(p.targetSystemIdentity),
      wordBytes32(p.committedProgramHash),
      wordBytes32(p.recipeRef),
      wordBytes32(p.sampleManifestRef),
      wordBytes32(childrenRoot),
      wordBytes32(operatingEnvelopeHash),
      wordBytes32(p.expectedRouteArea),
      wordBytes32(expectedLocationHash),
      wordBytes32(p.captureNonceAnchor),
      wordBytes32(p.challengeAnchor),
      wordUint(p.integrityGrade),
    ]),
  );
}

export function computeBindingsRoot(bs: SubjectBinding[]): Bytes32 {
  // sol f1 (evidence 999e6bdb): canonical-sort by (settlementUnitId, requirementId) + exactly-one per
  // (unit,requirement) — deterministic recompute, no caller order-freedom. tuple(bytes32,bytes32,uint8,uint8,bytes32)[]
  const seen = new Set<string>();
  for (const b of bs) {
    const k = bytesToHex(b.settlementUnitId) + bytesToHex(b.requirementIdHash).slice(2);
    if (seen.has(k)) throw new Error("policy-authenticate: duplicate (settlementUnitId,requirementId) binding");
    seen.add(k);
  }
  const sorted = [...bs].sort((a, b) => {
    const c = compareBytes32(a.settlementUnitId, b.settlementUnitId);
    return c !== 0 ? c : compareBytes32(a.requirementIdHash, b.requirementIdHash);
  });
  const elements = sorted.map((b) => [
    wordBytes32(b.settlementUnitId),
    wordBytes32(b.requirementIdHash),
    wordUint(BigInt(b.sourceKind)),
    wordUint(BigInt(b.propositionKind)),
    wordBytes32(b.valueRef),
  ]);
  return keccak256(abiSingleArray(elements));
}

const POLICY_VERSION = 1n;

/** Recompute acceptedPolicyDigest from the full canonical policy preimage (sol f1 authentication). */
export function computeAcceptedPolicyDigest(p: CanonicalAcceptedJobPolicyV1): Bytes32 {
  const termsHash = computeTermsHash(p);
  const subjectBlockHash = computeSubjectBlockHash(p);
  const bindingsRoot = computeBindingsRoot(p.evidenceSubjectBindings);
  // abi(bytes32 POLICY_DOMAIN, uint16 POLICY_VERSION, bytes32 termsHash, bytes32 subjectBlockHash, bytes32 bindingsRoot)
  return keccak256(abiStatic([wordBytes32(POLICY_DOMAIN), wordUint(POLICY_VERSION), wordBytes32(termsHash), wordBytes32(subjectBlockHash), wordBytes32(bindingsRoot)]));
}

// ---------------------------------------------------------------------------
// authorityPolicy projection -> projectionDigest (embedded authoritative table)
// Port of authoritypolicy-projection-v1-mirror.cjs: the fixed-global (evidenceType,
// tier) -> {allowedSourceRoles, propositionSubjectConstraint} table composition
// embeds + recomputes + asserts == the pinned projectionDigest (evidence #1014).
// ---------------------------------------------------------------------------

// roles bitset: emitter=0b001, evaluator=0b010, oracle=0b100
const EMIT = 1, EVAL = 2, ORAC = 4;
// SubjectSelector u8 kinds (0..16)
const SEL = {
  NONE: 0, PAYER: 1, EXPERT: 2, EXECUTOR: 3, RECIPIENT: 4, TARGET: 5, TUPLE: 6, ORACLE_SELF: 7, CHILD: 8,
  CHALLENGE: 9, CAPTURE_NONCE: 10, LOCATION: 11, ROUTE_AREA: 12, ENVELOPE: 13, PROGRAM: 14, RECIPE: 15, CONTENT: 16,
} as const;

// per-primitive: [id, tiers[], roles(bitset), propositionKind]
const PROJECTION_PRIMITIVES: [string, number[], number, number][] = [
  ["approval.payer", [2, 3], EVAL, SEL.NONE],
  ["approval.expert", [2, 3], EVAL, SEL.NONE],
  ["confirm.execution_mode", [0, 1, 2, 3], EMIT, SEL.NONE],
  ["decl.self_attested", [0], EMIT, SEL.NONE],
  ["artifact.hash", [1, 2, 3], EMIT, SEL.CONTENT],
  ["fresh.challenge_bound", [1, 2, 3], EMIT, SEL.CHALLENGE],
  ["pay.escrow_receipt", [0, 1, 2, 3], ORAC, SEL.CHILD],
  ["ident.registered_key", [1, 2, 3], EMIT | EVAL | ORAC, SEL.NONE],
  ["receipt.kernel_signed", [1, 2], EMIT, SEL.NONE],
  ["telemetry.geofence_event", [1, 2], EMIT, SEL.LOCATION],
  ["confirm.recipient_nonce", [2], EVAL, SEL.NONE],
  ["confirm.recipient_signature", [1, 2], EVAL, SEL.NONE],
  ["capture.photo_nonced", [1, 2], EMIT, SEL.CAPTURE_NONCE],
  ["telemetry.gps_trail", [1, 2, 3], EMIT, SEL.ROUTE_AREA],
  ["confirm.target_system", [1, 2], EVAL | ORAC, SEL.TARGET],
  ["machine.execution_log", [1, 2, 3], EMIT, SEL.PROGRAM],
  ["telemetry.envelope_conformance", [1, 2, 3], EMIT, SEL.ENVELOPE],
  ["telemetry.coverage_gate", [0, 1, 2, 3], EMIT, SEL.NONE],
  ["process.batch_record", [1, 2, 3], EMIT, SEL.RECIPE],
];
// tier-VARIANT rows (measure.io_test_pair: t1 operator-run vs t2 oracle/executor)
const PROJECTION_TIER_VARIANT: [string, number, number, number][] = [
  ["measure.io_test_pair", 1, EMIT, SEL.NONE],
  ["measure.io_test_pair", 2, EVAL | ORAC, SEL.NONE],
];

export interface ProjectionRow {
  evidenceTypeId: Bytes32; // keccak256(utf8(id))
  tier: number;
  allowedSourceRoles: number; // bitset
  propositionSubjectConstraint: number; // SubjectSelector u8
}

/** Build the 51 authoritative projection rows, canonical-sorted by (evidenceTypeId asc, tier asc). */
export function buildProjectionRows(): ProjectionRow[] {
  const rows: ProjectionRow[] = [];
  for (const [id, tiers, roles, prop] of PROJECTION_PRIMITIVES) {
    for (const t of tiers) rows.push({ evidenceTypeId: keccakUtf8(id), tier: t, allowedSourceRoles: roles, propositionSubjectConstraint: prop });
  }
  for (const [id, t, roles, prop] of PROJECTION_TIER_VARIANT) {
    rows.push({ evidenceTypeId: keccakUtf8(id), tier: t, allowedSourceRoles: roles, propositionSubjectConstraint: prop });
  }
  rows.sort((a, b) => {
    const c = compareBytes32(a.evidenceTypeId, b.evidenceTypeId);
    return c !== 0 ? c : a.tier - b.tier;
  });
  return rows;
}

function compareBytes32(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

export function computeRowsRoot(rows: ProjectionRow[]): Bytes32 {
  // tuple(bytes32 evidenceTypeId, uint8 tier, uint8 roles, uint8 prop)[]
  const elements = rows.map((r) => [
    wordBytes32(r.evidenceTypeId),
    wordUint(BigInt(r.tier)),
    wordUint(BigInt(r.allowedSourceRoles)),
    wordUint(BigInt(r.propositionSubjectConstraint)),
  ]);
  return keccak256(abiSingleArray(elements));
}

const PROJECTION_VERSION = 1n;

/** Recompute projectionDigest from the embedded rows (evidence #1014 authenticity assert). */
export function computeProjectionDigest(rows: ProjectionRow[]): Bytes32 {
  const rowsRoot = computeRowsRoot(rows);
  // abi(bytes32 PROJECTION_DOMAIN, uint16 version, uint256 rowCount, bytes32 rowsRoot)
  return keccak256(abiStatic([wordBytes32(PROJECTION_DOMAIN), wordUint(PROJECTION_VERSION), wordUint(BigInt(rows.length)), wordBytes32(rowsRoot)]));
}

/** Look up the authoritative (roles, propositionKind) for an (evidenceTypeId, tier). Null if absent. */
export function lookupProjection(rows: ProjectionRow[], evidenceTypeId: Bytes32, tier: number): { allowedSourceRoles: number; propositionSubjectConstraint: number } | null {
  const r = rows.find((x) => compareBytes32(x.evidenceTypeId, evidenceTypeId) === 0 && x.tier === tier);
  return r ? { allowedSourceRoles: r.allowedSourceRoles, propositionSubjectConstraint: r.propositionSubjectConstraint } : null;
}
