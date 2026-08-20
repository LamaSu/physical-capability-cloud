/**
 * inc-3a — producer-side composition-root derivation (composition schema v1).
 *
 * Byte-exact reference implementation of
 * `ai/research/pcc-inc3a-compositionroot-derivation-spec.md`.
 *
 * ⚠ Every hash preimage uses the RAW 32-byte SHA-256 digest. There are NO hex
 * strings, JSON, ABI, or text concatenations in any preimage. Domain tags are
 * constructed as 32-byte ASCII-label-zero-padded bytes directly (§2) — the label
 * is never hashed. This module therefore does NOT use `@pcc/spec`'s branded
 * `sha256()` (which returns `sha256:<hex>`); the branded form appears only at the
 * OUTPUT boundary via `deriveCompositionRootHex`.
 *
 * Pure + offline + deterministic: no Date.now, no Math.random, no I/O.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import type { SHA256 } from "../types/common.js";
import type {
  AcceptanceCriterionInput,
  AcceptancePolicyInput,
  AssetInput,
  AuthoritySelectionInput,
  BindingProgramInput,
  ConditionInput,
  DecisionBandInput,
  Digest32Input,
  EdgeInput,
  EvidenceRequirementInput,
  FeeRuleInput,
  M1DependencyResolution,
  M1DependencyUse,
  M1NodeResolution,
  M1ResolvedDependencyGraph,
  MeasureInput,
  NodeInput,
  OutcomeInput,
  PlanV1,
  PrincipalInput,
  RationalInput,
  SerializedClosureInput,
  SettlementUnitInput,
  SourceRefInput,
  ToleranceInput,
  TransferAllocationInput,
  ValueInput,
  ValueMapEntry,
  // compositionRoot v2 inputs
  ResolvedEvaluationSemantics,
  MetricCatalogRow,
  EvidenceTypeRow,
  AcceptedPolicyInput,
} from "./compose-root-types.js";
// compositionRoot v2 — policy + projection AUTHENTICATION (sol comprehensive-review f1/f2).
// keccak + minimal-ABI recompute, proven byte-exact vs evidence's mirrors in policy-authenticate.test.ts.
import {
  buildProjectionRows,
  computeProjectionDigest,
  computeAcceptedPolicyDigest,
  keccakUtf8 as pacKeccakUtf8,
  lookupProjection,
  bytesToHex as pacBytesToHex,
  type ProjectionRow,
  type CanonicalAcceptedJobPolicyV1,
} from "./policy-authenticate.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown for every rejection (spec §7). `code` is a stable machine-readable tag. */
export class CompositionRootError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CompositionRootError";
    this.code = code;
  }
}

function reject(code: string, message: string): never {
  throw new CompositionRootError(code, message);
}

// ---------------------------------------------------------------------------
// §1.1 Integers, framing, primitives
// ---------------------------------------------------------------------------

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const U256_MAX = (1n << 256n) - 1n;
const I256_MIN = -(1n << 255n);
const I256_MAX = (1n << 255n) - 1n;

function u8(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) reject("U8_RANGE", `u8 out of range: ${n}`);
  return Uint8Array.of(n);
}

function u16(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > U16_MAX) reject("U16_RANGE", `u16 out of range: ${n}`);
  return Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
}

function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > U32_MAX) reject("U32_RANGE", `u32 out of range: ${n}`);
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function u256(n: bigint): Uint8Array {
  if (typeof n !== "bigint" || n < 0n || n > U256_MAX) reject("U256_RANGE", `u256 out of range: ${n}`);
  const b = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function i256(n: bigint): Uint8Array {
  if (typeof n !== "bigint" || n < I256_MIN || n > I256_MAX) reject("I256_RANGE", `i256 out of range: ${n}`);
  let v = n < 0n ? n + (1n << 256n) : n;
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function lp16(x: Uint8Array): Uint8Array {
  if (x.length > U16_MAX) reject("LP16_LEN", `LP16 too long: ${x.length}`);
  return concat(u16(x.length), x);
}

function lp32(x: Uint8Array): Uint8Array {
  if (x.length > U32_MAX) reject("LP32_LEN", `LP32 too long: ${x.length}`);
  return concat(u32(x.length), x);
}

function optionNone(): Uint8Array {
  return Uint8Array.of(0x00);
}

function optionSome(x: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(0x01), lp32(x));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Object-shape guards (spec §7 — unknown fields / missing required)
// ---------------------------------------------------------------------------

// Runtime-only guard: validates without changing the argument's static type
// (all callers pass already-typed values; malformed inputs arrive via test casts).
function assertObject(v: unknown, ctx: string): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) reject("NOT_OBJECT", `${ctx}: expected object`);
}

// Runtime-only guard (sol B1): reject SPARSE arrays (holes). Encoders serialize
// `.length` as a count but iterate with forEach/map, which SKIP holes — so a sparse
// array (`new Array(3)`, `[1,,3]`) yields a count that overstates the elements actually
// emitted, malformed count-prefixed bytes a dense mirror (JSON/Solidity) cannot
// reproduce, and a large hole-count is a cheap count-bomb. Every array whose `.length`
// is serialized as a count MUST be dense with own-indexed elements. Call after the
// `Array.isArray` gate, before reading `.length`.
function assertDense(v: readonly unknown[], ctx: string): void {
  for (let i = 0; i < v.length; i++) {
    if (!(i in v)) reject("SPARSE_ARRAY", `${ctx}: array has a hole at index ${i} (dense arrays required)`);
  }
}

function assertExactKeys(v: object, allowed: readonly string[], ctx: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) reject("UNKNOWN_FIELD", `${ctx}: unknown field '${k}'`);
  }
}

// Spec §7 "missing required fields": every listed key must be an own-property.
// assertExactKeys only rejects EXTRA keys; a nullable-but-required Option<T> field
// (feeId, lowerTolerance, upperTolerance) whose key is simply absent would otherwise
// read as `undefined` and be silently coerced to Option-None (0x00) — accepting a
// malformed input two conformant implementations could disagree on (one rejects, one
// hashes). Presence is required here; only an explicit `null` value means Option-None.
function assertRequiredKeys(v: object, required: readonly string[], ctx: string): void {
  for (const k of required) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) {
      reject("MISSING_FIELD", `${ctx}: missing required field '${k}'`);
    }
  }
}

// ---------------------------------------------------------------------------
// §1.2 Identifiers, paths, ASCII
// ---------------------------------------------------------------------------

function asciiBytes(s: string, ctx: string): Uint8Array {
  if (typeof s !== "string") reject("ASCII_TYPE", `${ctx}: expected string`);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) reject("NON_ASCII", `${ctx}: non-ASCII byte`);
    out[i] = c;
  }
  return out;
}

const ID_RE = /^[a-z][a-z0-9]{0,31}(?:[._:/-][a-z0-9]{1,32})*$/;

function encodeId(s: string, ctx: string): Uint8Array {
  if (typeof s !== "string") reject("ID_TYPE", `${ctx}: identifier not a string`);
  if (s.length < 1 || s.length > 255) reject("ID_LENGTH", `${ctx}: id length ${s.length} not in 1..255`);
  if (!ID_RE.test(s)) reject("ID_GRAMMAR", `${ctx}: invalid identifier grammar: ${JSON.stringify(s)}`);
  return lp16(asciiBytes(s, ctx));
}

function encodePath(segments: string[], ctx: string): Uint8Array {
  if (!Array.isArray(segments)) reject("PATH_TYPE", `${ctx}: path must be an array`);
  assertDense(segments, ctx);
  const parts: Uint8Array[] = [u16(segments.length)];
  segments.forEach((seg, i) => parts.push(encodeId(seg, `${ctx}.seg[${i}]`)));
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// §1.3 Rationals
// ---------------------------------------------------------------------------

function bigAbs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

function bigGcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

function encodeRational(r: RationalInput, ctx: string): Uint8Array {
  assertObject(r, ctx);
  assertExactKeys(r, ["numerator", "denominator"], ctx);
  const { numerator, denominator } = r;
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    reject("RATIONAL_TYPE", `${ctx}: numerator/denominator must be bigint`);
  }
  if (denominator <= 0n) reject("RATIONAL_DENOM", `${ctx}: denominator must be > 0`);
  if (numerator === 0n) {
    if (denominator !== 1n) reject("RATIONAL_ZERO", `${ctx}: zero numerator requires denominator 1`);
  } else if (bigGcd(numerator, denominator) !== 1n) {
    reject("RATIONAL_NONCANONICAL", `${ctx}: numerator/denominator not in lowest terms`);
  }
  return concat(i256(numerator), u256(denominator));
}

function compareRationals(a: RationalInput, b: RationalInput): number {
  // denominators validated > 0 before this is called.
  const lhs = a.numerator * b.denominator;
  const rhs = b.numerator * a.denominator;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Digest normalization (input boundary only — never in a preimage)
// ---------------------------------------------------------------------------

function toDigest32(x: Digest32Input, ctx: string): Uint8Array {
  if (x instanceof Uint8Array) {
    if (x.length !== 32) reject("DIGEST_LEN", `${ctx}: digest must be 32 bytes, got ${x.length}`);
    return x;
  }
  if (typeof x === "string") {
    const h = x.startsWith("sha256:") ? x.slice(7) : x;
    if (!/^[0-9a-f]{64}$/.test(h)) reject("DIGEST_HEX", `${ctx}: digest hex must be 64 lowercase hex chars`);
    return hexToBytes(h);
  }
  reject("DIGEST_TYPE", `${ctx}: digest must be Uint8Array or hex string`);
}

function toFixedBytes(x: Uint8Array | string, len: number, ctx: string): Uint8Array {
  if (x instanceof Uint8Array) {
    if (x.length !== len) reject("FIXED_LEN", `${ctx}: expected ${len} bytes, got ${x.length}`);
    return x;
  }
  if (typeof x === "string") {
    const h = x.startsWith("0x") ? x.slice(2) : x;
    if (!new RegExp(`^[0-9a-fA-F]{${len * 2}}$`).test(h)) reject("FIXED_HEX", `${ctx}: expected ${len * 2} hex chars`);
    return hexToBytes(h.toLowerCase());
  }
  reject("FIXED_TYPE", `${ctx}: expected Uint8Array or hex string`);
}

// ---------------------------------------------------------------------------
// §1.4 Canonical Values
// ---------------------------------------------------------------------------

const MAX_VALUE_DEPTH = 32;

function encodeValue(v: ValueInput, ctx: string, depth = 1): Uint8Array {
  if (depth > MAX_VALUE_DEPTH) reject("VALUE_DEPTH", `${ctx}: value nesting exceeds ${MAX_VALUE_DEPTH}`);
  assertObject(v, ctx);
  const kind = (v as { kind?: unknown }).kind;
  switch (kind) {
    case "bool": {
      assertExactKeys(v, ["kind", "value"], ctx);
      const b = (v as { value: unknown }).value;
      if (typeof b !== "boolean") reject("VALUE_BOOL", `${ctx}: bool value must be boolean`);
      return concat(u8(0x01), u8(b ? 1 : 0));
    }
    case "u256":
      assertExactKeys(v, ["kind", "value"], ctx);
      return concat(u8(0x02), u256((v as { value: bigint }).value));
    case "i256":
      assertExactKeys(v, ["kind", "value"], ctx);
      return concat(u8(0x03), i256((v as { value: bigint }).value));
    case "rational":
      assertExactKeys(v, ["kind", "value"], ctx);
      return concat(u8(0x04), encodeRational((v as { value: RationalInput }).value, `${ctx}.rational`));
    case "bytes": {
      assertExactKeys(v, ["kind", "value"], ctx);
      const bb = (v as { value: unknown }).value;
      if (!(bb instanceof Uint8Array)) reject("VALUE_BYTES", `${ctx}: bytes value must be Uint8Array`);
      return concat(u8(0x05), lp32(bb));
    }
    case "id":
      assertExactKeys(v, ["kind", "value"], ctx);
      return concat(u8(0x06), encodeId((v as { value: string }).value, `${ctx}.id`));
    case "digest":
      assertExactKeys(v, ["kind", "value"], ctx);
      return concat(u8(0x07), toDigest32((v as { value: Digest32Input }).value, `${ctx}.digest`));
    case "list": {
      assertExactKeys(v, ["kind", "value"], ctx);
      const items = (v as { value: unknown }).value;
      if (!Array.isArray(items)) reject("VALUE_LIST", `${ctx}: list value must be an array`);
      assertDense(items as unknown[], ctx);
      const parts: Uint8Array[] = [u32(items.length)];
      (items as ValueInput[]).forEach((it, i) => parts.push(lp32(encodeValue(it, `${ctx}[${i}]`, depth + 1))));
      return concat(u8(0x08), concat(...parts));
    }
    case "map": {
      assertExactKeys(v, ["kind", "value"], ctx);
      const entries = (v as { value: unknown }).value;
      if (!Array.isArray(entries)) reject("VALUE_MAP", `${ctx}: map value must be an array`);
      assertDense(entries as unknown[], ctx);
      const parts: Uint8Array[] = [u32(entries.length)];
      let prevKey: Uint8Array | null = null;
      (entries as ValueMapEntry[]).forEach((e, i) => {
        assertObject(e, `${ctx}.entry[${i}]`);
        assertExactKeys(e, ["key", "value"], `${ctx}.entry[${i}]`);
        const keyBytes = encodeId(e.key, `${ctx}.key[${i}]`);
        const keyText = asciiBytes(e.key, `${ctx}.key[${i}]`);
        if (prevKey !== null && compareBytes(prevKey, keyText) >= 0) {
          reject("MAP_ORDER", `${ctx}: map keys must be strictly increasing by ASCII bytes`);
        }
        prevKey = keyText;
        parts.push(keyBytes);
        parts.push(lp32(encodeValue(e.value, `${ctx}.val[${i}]`, depth + 1)));
      });
      return concat(u8(0x09), concat(...parts));
    }
    default:
      reject("VALUE_TAG", `${ctx}: unknown value kind ${JSON.stringify(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// §1.5 Measures and tolerances
// ---------------------------------------------------------------------------

function encodeMeasure(m: MeasureInput, ctx: string, requirePositive: boolean): Uint8Array {
  assertObject(m, ctx);
  assertExactKeys(m, ["magnitude", "unitId"], ctx);
  const magBytes = encodeRational(m.magnitude, `${ctx}.magnitude`);
  if (requirePositive && m.magnitude.numerator <= 0n) {
    reject("MEASURE_POSITIVE", `${ctx}: quantity magnitude must be positive`);
  }
  return concat(magBytes, encodeId(m.unitId, `${ctx}.unitId`));
}

function encodeTolerance(t: ToleranceInput, ctx: string): Uint8Array {
  assertObject(t, ctx);
  assertExactKeys(t, ["parameterPath", "kind", "lower", "upper", "unitId"], ctx);
  const kind = t.kind;
  if (kind !== 1 && kind !== 2 && kind !== 3) reject("TOLERANCE_TAG", `${ctx}: unknown tolerance kind ${kind}`);
  const lowerBytes = encodeRational(t.lower, `${ctx}.lower`);
  const upperBytes = encodeRational(t.upper, `${ctx}.upper`);
  const cmp = compareRationals(t.lower, t.upper);
  if (kind === 1) {
    if (cmp !== 0) reject("TOLERANCE_ABS", `${ctx}: ABSOLUTE requires lower=upper`);
    if (t.lower.numerator < 0n) reject("TOLERANCE_ABS_NEG", `${ctx}: ABSOLUTE requires >= 0`);
  } else if (kind === 2) {
    if (cmp !== 0) reject("TOLERANCE_REL", `${ctx}: RELATIVE requires lower=upper`);
    if (t.lower.numerator < 0n) reject("TOLERANCE_REL_NEG", `${ctx}: RELATIVE requires >= 0`);
    if (t.unitId !== "ratio") reject("TOLERANCE_REL_UNIT", `${ctx}: RELATIVE requires unitId 'ratio'`);
  } else {
    if (cmp > 0) reject("TOLERANCE_INTERVAL", `${ctx}: INTERVAL requires lower <= upper`);
  }
  return concat(encodePath(t.parameterPath, `${ctx}.path`), u8(kind), lowerBytes, upperBytes, encodeId(t.unitId, `${ctx}.unitId`));
}

// ---------------------------------------------------------------------------
// §1.6 Principals
// ---------------------------------------------------------------------------

const DID_RE = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

function validatePercentEscapes(s: string, ctx: string): void {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%") {
      const h = s.slice(i + 1, i + 3);
      if (h.length !== 2 || !/^[0-9A-F]{2}$/.test(h)) {
        reject("DID_PERCENT", `${ctx}: percent escape must be two uppercase hex digits`);
      }
      i += 2;
    }
  }
}

function encodePrincipal(p: PrincipalInput, ctx: string): Uint8Array {
  assertObject(p, ctx);
  const kind = (p as { kind?: unknown }).kind;
  switch (kind) {
    case "evmAccount": {
      assertExactKeys(p, ["kind", "chainId", "address"], ctx);
      const pp = p as { chainId: bigint; address: Uint8Array | string };
      return concat(u8(0x01), u256(pp.chainId), toFixedBytes(pp.address, 20, `${ctx}.address`));
    }
    case "ed25519Key": {
      assertExactKeys(p, ["kind", "publicKey"], ctx);
      const pp = p as { publicKey: Uint8Array | string };
      return concat(u8(0x02), toFixedBytes(pp.publicKey, 32, `${ctx}.publicKey`));
    }
    case "did": {
      assertExactKeys(p, ["kind", "did"], ctx);
      const did = (p as { did: string }).did;
      if (typeof did !== "string") reject("DID_TYPE", `${ctx}: did must be string`);
      if (did.length < 1 || did.length > 255) reject("DID_LENGTH", `${ctx}: did length not in 1..255`);
      for (let i = 0; i < did.length; i++) {
        const c = did.charCodeAt(i);
        if (c < 0x21 || c > 0x7e) reject("DID_BYTE", `${ctx}: did byte out of 0x21..0x7e`);
      }
      if (!DID_RE.test(did)) reject("DID_GRAMMAR", `${ctx}: invalid did grammar`);
      validatePercentEscapes(did, ctx);
      return concat(u8(0x03), lp16(asciiBytes(did, ctx)));
    }
    case "opaque": {
      assertExactKeys(p, ["kind", "namespace", "bytes"], ctx);
      const pp = p as { namespace: string; bytes: unknown };
      if (!(pp.bytes instanceof Uint8Array)) reject("PRINCIPAL_OPAQUE_BYTES", `${ctx}: opaque bytes must be Uint8Array`);
      if (pp.bytes.length < 1) reject("PRINCIPAL_OPAQUE_EMPTY", `${ctx}: opaque bytes must be nonempty`);
      return concat(u8(0x7f), encodeId(pp.namespace, `${ctx}.namespace`), lp16(pp.bytes));
    }
    default:
      reject("PRINCIPAL_TAG", `${ctx}: unknown principal kind ${JSON.stringify(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// §1.7 Assets
// ---------------------------------------------------------------------------

function encodeAssetIdentity(a: AssetInput, ctx: string): Uint8Array {
  assertObject(a, ctx);
  const kind = (a as { kind?: unknown }).kind;
  switch (kind) {
    case "evmNative": {
      assertExactKeys(a, ["kind", "chainId", "decimals"], ctx);
      return concat(u8(0x01), u256((a as { chainId: bigint }).chainId));
    }
    case "evmErc20": {
      assertExactKeys(a, ["kind", "chainId", "contractAddress", "decimals"], ctx);
      const aa = a as { chainId: bigint; contractAddress: Uint8Array | string };
      return concat(u8(0x02), u256(aa.chainId), toFixedBytes(aa.contractAddress, 20, `${ctx}.contractAddress`));
    }
    case "opaque": {
      assertExactKeys(a, ["kind", "namespace", "reference", "decimals"], ctx);
      const aa = a as { namespace: string; reference: unknown };
      if (!(aa.reference instanceof Uint8Array)) reject("ASSET_OPAQUE_REF", `${ctx}: opaque reference must be Uint8Array`);
      if (aa.reference.length < 1) reject("ASSET_OPAQUE_EMPTY", `${ctx}: opaque reference must be nonempty`);
      return concat(u8(0x7f), encodeId(aa.namespace, `${ctx}.namespace`), lp16(aa.reference));
    }
    default:
      reject("ASSET_TAG", `${ctx}: unknown asset kind ${JSON.stringify(kind)}`);
  }
}

function encodeAsset(a: AssetInput, ctx: string, decimalsRegistry: Map<string, number>): Uint8Array {
  const identity = encodeAssetIdentity(a, ctx);
  const decimals = (a as { decimals: number }).decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 0xff) {
    reject("ASSET_DECIMALS", `${ctx}: decimals must be a u8`);
  }
  const key = bytesToHex(identity);
  const prev = decimalsRegistry.get(key);
  if (prev === undefined) decimalsRegistry.set(key, decimals);
  else if (prev !== decimals) {
    reject("ASSET_DECIMALS_MISMATCH", `${ctx}: same asset identity used with different decimals (${prev} vs ${decimals})`);
  }
  return concat(identity, u8(decimals));
}

// ---------------------------------------------------------------------------
// §2 Domain separation
// ---------------------------------------------------------------------------

function domain(label: string): Uint8Array {
  const bytes = asciiBytes(label, `domain(${label})`);
  if (bytes.length > 32) reject("DOMAIN_LEN", `domain label too long: ${label}`);
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

const DOM_COMP_ROOT = domain("PCC-COMP-ROOT-v1");
const DOM_COMP_LEAF = domain("PCC-COMP-LEAF-v1");
const DOM_COMP_NODE = domain("PCC-COMP-NODE-v1");
const DOM_PLAN_ROOT = domain("PCC-PLAN-ROOT-v1");
const DOM_PLAN_LEAF = domain("PCC-PLAN-LEAF-v1");
const DOM_PLAN_NODE = domain("PCC-PLAN-NODE-v1");
const DOM_PLAN_EMPTY = domain("PCC-PLAN-EMPTY-v1");
const DOM_CLOSURE_ROOT = domain("PCC-CLOSURE-ROOT-v1");
const DOM_CLOSURE_LEAF = domain("PCC-CLOSURE-LEAF-v1");
const DOM_CLOSURE_NODE = domain("PCC-CLOSURE-NODE-v1");
const DOM_CLOSURE_EMPTY = domain("PCC-CLOSURE-EMPTY-v1");
// compositionRoot v2 — EVAL domain family for the evalSemanticsLeaf Merkle-list (F6).
const DOM_EVAL_ROOT = domain("PCC-EVAL-ROOT-v1");
const DOM_EVAL_LEAF = domain("PCC-EVAL-LEAF-v1");
const DOM_EVAL_NODE = domain("PCC-EVAL-NODE-v1");
const DOM_EVAL_EMPTY = domain("PCC-EVAL-EMPTY-v1");

// ---------------------------------------------------------------------------
// §3 Merkle-list
// ---------------------------------------------------------------------------

function H(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

function merkleListRoot(
  records: Uint8Array[],
  leafDomain: Uint8Array,
  nodeDomain: Uint8Array,
  emptyDomain: Uint8Array,
): Uint8Array {
  if (records.length === 0) return H(emptyDomain);
  let level = records.map((r, i) => H(concat(leafDomain, u32(i), u32(r.length), r)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(H(concat(nodeDomain, left, right)));
    }
    level = next;
  }
  return level[0];
}

export {
  // low-level surface intentionally exported for the golden cross-check tests
  domain as _domain,
  H as _hash,
  merkleListRoot as _merkleListRoot,
  u8 as _u8,
  u16 as _u16,
  u32 as _u32,
  u256 as _u256,
  i256 as _i256,
  concat as _concat,
  DOM_PLAN_ROOT as _DOM_PLAN_ROOT,
  DOM_PLAN_EMPTY as _DOM_PLAN_EMPTY,
  DOM_CLOSURE_ROOT as _DOM_CLOSURE_ROOT,
  DOM_CLOSURE_EMPTY as _DOM_CLOSURE_EMPTY,
  DOM_COMP_ROOT as _DOM_COMP_ROOT,
  DOM_COMP_LEAF as _DOM_COMP_LEAF,
  DOM_COMP_NODE as _DOM_COMP_NODE,
};

// ---------------------------------------------------------------------------
// §4.3 Source references, conditions, binding programs
// ---------------------------------------------------------------------------

function encodeSourceRef(s: SourceRefInput, ctx: string): Uint8Array {
  assertObject(s, ctx);
  assertExactKeys(s, ["nodeInstanceId", "outputPortId", "outputPath"], ctx);
  return concat(
    encodeId(s.nodeInstanceId, `${ctx}.nodeInstanceId`),
    encodeId(s.outputPortId, `${ctx}.outputPortId`),
    encodePath(s.outputPath, `${ctx}.outputPath`),
  );
}

const COMPARATORS = new Set([1, 2, 3, 4, 5, 6]);

function encodeCondition(c: ConditionInput, ctx: string, depth = 1): Uint8Array {
  if (depth > 64) reject("CONDITION_DEPTH", `${ctx}: condition nesting too deep`);
  assertObject(c, ctx);
  const kind = (c as { kind?: unknown }).kind;
  switch (kind) {
    case "always":
      assertExactKeys(c, ["kind"], ctx);
      return u8(0x01);
    case "outputExists":
      assertExactKeys(c, ["kind", "source"], ctx);
      return concat(u8(0x02), encodeSourceRef((c as { source: SourceRefInput }).source, `${ctx}.source`));
    case "compare": {
      assertExactKeys(c, ["kind", "source", "comparator", "value"], ctx);
      const cc = c as { source: SourceRefInput; comparator: number; value: ValueInput };
      if (!COMPARATORS.has(cc.comparator)) reject("COMPARATOR_TAG", `${ctx}: unknown comparator ${cc.comparator}`);
      return concat(u8(0x03), encodeSourceRef(cc.source, `${ctx}.source`), u8(cc.comparator), lp32(encodeValue(cc.value, `${ctx}.value`)));
    }
    case "all":
    case "any": {
      assertExactKeys(c, ["kind", "children"], ctx);
      const children = (c as { children: unknown }).children;
      if (!Array.isArray(children) || children.length < 1) reject("CONDITION_LIST", `${ctx}: ${kind} requires >= 1 child`);
      const tag = kind === "all" ? 0x04 : 0x05;
      const parts: Uint8Array[] = [u32((children as ConditionInput[]).length)];
      (children as ConditionInput[]).forEach((ch, i) => parts.push(lp32(encodeCondition(ch, `${ctx}[${i}]`, depth + 1))));
      return concat(u8(tag), concat(...parts));
    }
    case "not":
      assertExactKeys(c, ["kind", "child"], ctx);
      return concat(u8(0x06), lp32(encodeCondition((c as { child: ConditionInput }).child, `${ctx}.child`, depth + 1)));
    default:
      reject("CONDITION_TAG", `${ctx}: unknown condition kind ${JSON.stringify(kind)}`);
  }
}

function collectConditionNodeRefs(c: ConditionInput, acc: Set<string>): void {
  switch (c.kind) {
    case "always":
      return;
    case "outputExists":
    case "compare":
      acc.add(c.source.nodeInstanceId);
      return;
    case "all":
    case "any":
      c.children.forEach((ch) => collectConditionNodeRefs(ch, acc));
      return;
    case "not":
      collectConditionNodeRefs(c.child, acc);
      return;
  }
}

function encodeBindingProgram(b: BindingProgramInput, ctx: string): Uint8Array {
  assertObject(b, ctx);
  assertExactKeys(b, ["languageId", "programBytes"], ctx);
  if (!(b.programBytes instanceof Uint8Array)) reject("BINDING_PROG_BYTES", `${ctx}: programBytes must be Uint8Array`);
  if (b.languageId === "pcc.identity.v1" && b.programBytes.length !== 0) {
    reject("BINDING_IDENTITY_NONEMPTY", `${ctx}: pcc.identity.v1 requires empty programBytes`);
  }
  return concat(encodeId(b.languageId, `${ctx}.languageId`), lp32(b.programBytes));
}

// ---------------------------------------------------------------------------
// §4.2 Node record
// ---------------------------------------------------------------------------

function encodeNodeRecord(n: NodeInput, ctx: string): Uint8Array {
  assertObject(n, ctx);
  assertExactKeys(n, ["nodeInstanceId", "capabilityContractDigest", "quantity", "executionParameters", "tolerances"], ctx);
  const parts: Uint8Array[] = [
    u8(0x10),
    encodeId(n.nodeInstanceId, `${ctx}.nodeInstanceId`),
    toDigest32(n.capabilityContractDigest, `${ctx}.capabilityContractDigest`),
    lp32(encodeMeasure(n.quantity, `${ctx}.quantity`, true)),
  ];
  const params = n.executionParameters;
  if (!Array.isArray(params)) reject("NODE_PARAMS", `${ctx}: executionParameters must be an array`);
  assertDense(params, `${ctx}.executionParameters`);
  parts.push(u32(params.length));
  let prevName: Uint8Array | null = null;
  params.forEach((p, i) => {
    assertObject(p, `${ctx}.param[${i}]`);
    assertExactKeys(p, ["name", "value"], `${ctx}.param[${i}]`);
    const idBytes = encodeId(p.name, `${ctx}.param[${i}].name`);
    const nameBytes = asciiBytes(p.name, `${ctx}.param[${i}].name`);
    if (prevName !== null && compareBytes(prevName, nameBytes) >= 0) {
      reject("NODE_PARAM_ORDER", `${ctx}: execution parameter names must be strictly increasing`);
    }
    prevName = nameBytes;
    parts.push(idBytes);
    parts.push(lp32(encodeValue(p.value, `${ctx}.param[${i}].value`)));
  });
  const tols = n.tolerances;
  if (!Array.isArray(tols)) reject("NODE_TOLERANCES", `${ctx}: tolerances must be an array`);
  assertDense(tols, `${ctx}.tolerances`);
  parts.push(u16(tols.length));
  const seenPaths = new Set<string>();
  tols.forEach((t, i) => {
    const tb = encodeTolerance(t, `${ctx}.tol[${i}]`);
    const pathKey = bytesToHex(encodePath(t.parameterPath, `${ctx}.tol[${i}].path`));
    if (seenPaths.has(pathKey)) reject("TOLERANCE_DUP_PATH", `${ctx}: duplicate tolerance path`);
    seenPaths.add(pathKey);
    parts.push(lp32(tb));
  });
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// §4.4 Edge record
// ---------------------------------------------------------------------------

const BINDING_TYPES = new Set([1, 2, 3, 4]);

function encodeEdgeRecord(e: EdgeInput, ctx: string): Uint8Array {
  assertObject(e, ctx);
  assertExactKeys(
    e,
    [
      "edgeId",
      "sourceNodeId",
      "sourcePortId",
      "sourcePath",
      "destinationNodeId",
      "destinationPortId",
      "destinationPath",
      "bindingType",
      "multiplicity",
      "inputOrdinal",
      "bindingProgram",
      "condition",
    ],
    ctx,
  );
  if (!BINDING_TYPES.has(e.bindingType)) reject("BINDING_TYPE_TAG", `${ctx}: unknown binding type ${e.bindingType}`);
  if (!Number.isInteger(e.multiplicity) || e.multiplicity < 1) reject("EDGE_MULTIPLICITY", `${ctx}: multiplicity >= 1`);
  return concat(
    u8(0x20),
    encodeId(e.edgeId, `${ctx}.edgeId`),
    encodeId(e.sourceNodeId, `${ctx}.sourceNodeId`),
    encodeId(e.sourcePortId, `${ctx}.sourcePortId`),
    encodePath(e.sourcePath, `${ctx}.sourcePath`),
    encodeId(e.destinationNodeId, `${ctx}.destinationNodeId`),
    encodeId(e.destinationPortId, `${ctx}.destinationPortId`),
    encodePath(e.destinationPath, `${ctx}.destinationPath`),
    u8(e.bindingType),
    u32(e.multiplicity),
    u32(e.inputOrdinal),
    lp32(encodeBindingProgram(e.bindingProgram, `${ctx}.bindingProgram`)),
    lp32(encodeCondition(e.condition, `${ctx}.condition`)),
  );
}

// ---------------------------------------------------------------------------
// §4.5 Fee rules
// ---------------------------------------------------------------------------

const ROUNDING_MODES = new Set([1, 2, 3, 4]);

function computeRatioAmount(basis: bigint, num: bigint, den: bigint, mode: number, ctx: string): bigint {
  const p = basis * num;
  const q = p / den;
  const r = p % den;
  switch (mode) {
    case 1:
      return q;
    case 2:
      return r === 0n ? q : q + 1n;
    case 3: {
      const twice = r * 2n;
      if (twice < den) return q;
      if (twice > den) return q + 1n;
      return q % 2n === 0n ? q : q + 1n;
    }
    case 4:
      if (r !== 0n) reject("FEE_EXACT_NONZERO_REM", `${ctx}: exact rounding requires zero remainder`);
      return q;
    default:
      reject("ROUNDING_MODE_TAG", `${ctx}: unknown rounding mode ${mode}`);
  }
}

function encodeFeeRule(f: FeeRuleInput, ctx: string): Uint8Array {
  assertObject(f, ctx);
  const kind = (f as { kind?: unknown }).kind;
  if (kind === "fixed") {
    assertExactKeys(f, ["feeId", "kind", "recipient", "exactAmount"], ctx);
    const ff = f as { feeId: string; recipient: PrincipalInput; exactAmount: bigint };
    return concat(encodeId(ff.feeId, `${ctx}.feeId`), u8(0x01), lp32(encodePrincipal(ff.recipient, `${ctx}.recipient`)), u256(ff.exactAmount));
  }
  if (kind === "ratio") {
    assertExactKeys(f, ["feeId", "kind", "recipient", "basisAmount", "numerator", "denominator", "roundingMode", "exactAmount"], ctx);
    const ff = f as {
      feeId: string;
      recipient: PrincipalInput;
      basisAmount: bigint;
      numerator: bigint;
      denominator: bigint;
      roundingMode: number;
      exactAmount: bigint;
    };
    if (
      typeof ff.basisAmount !== "bigint" ||
      typeof ff.numerator !== "bigint" ||
      typeof ff.denominator !== "bigint" ||
      typeof ff.exactAmount !== "bigint"
    ) {
      reject("FEE_RATIO_TYPE", `${ctx}: ratio amounts must be bigint`);
    }
    if (ff.denominator <= 0n) reject("FEE_RATIO_DENOM", `${ctx}: denominator > 0`);
    if (bigGcd(ff.numerator, ff.denominator) !== 1n) reject("FEE_RATIO_GCD", `${ctx}: gcd(numerator,denominator)=1`);
    if (ff.numerator < 0n || ff.basisAmount < 0n) reject("FEE_RATIO_NEG", `${ctx}: basis/numerator must be >= 0`);
    if (!ROUNDING_MODES.has(ff.roundingMode)) reject("ROUNDING_MODE_TAG", `${ctx}: unknown rounding mode ${ff.roundingMode}`);
    const computed = computeRatioAmount(ff.basisAmount, ff.numerator, ff.denominator, ff.roundingMode, ctx);
    if (computed > U256_MAX) reject("FEE_RESULT_OVERFLOW", `${ctx}: computed fee exceeds u256`);
    if (computed !== ff.exactAmount) reject("FEE_EXACT_MISMATCH", `${ctx}: exactAmount ${ff.exactAmount} != computed ${computed}`);
    return concat(
      encodeId(ff.feeId, `${ctx}.feeId`),
      u8(0x02),
      lp32(encodePrincipal(ff.recipient, `${ctx}.recipient`)),
      u256(ff.basisAmount),
      u256(ff.numerator),
      u256(ff.denominator),
      u8(ff.roundingMode),
      u256(ff.exactAmount),
    );
  }
  reject("FEE_KIND_TAG", `${ctx}: unknown fee kind ${JSON.stringify(kind)}`);
}

// ---------------------------------------------------------------------------
// §4.6 Transfer allocations and outcomes
// ---------------------------------------------------------------------------

interface FeeInfo {
  recipient: Uint8Array;
  amount: bigint;
}

function encodeTransferAllocation(a: TransferAllocationInput, ctx: string, feeMap: Map<string, FeeInfo>): Uint8Array {
  assertObject(a, ctx);
  assertExactKeys(a, ["allocationId", "role", "recipient", "amount", "feeId"], ctx);
  assertRequiredKeys(a, ["allocationId", "role", "recipient", "amount", "feeId"], ctx);
  const role = a.role;
  if (role !== 1 && role !== 2 && role !== 3 && role !== 4) reject("ROLE_TAG", `${ctx}: unknown role ${role}`);
  const recipientBytes = encodePrincipal(a.recipient, `${ctx}.recipient`);
  if (typeof a.amount !== "bigint") reject("ALLOC_AMOUNT_TYPE", `${ctx}: amount must be bigint`);
  let feeOption: Uint8Array;
  if (role === 3) {
    if (a.feeId === null || a.feeId === undefined) reject("ALLOC_FEE_MISSING", `${ctx}: fee role requires a feeId`);
    const fee = feeMap.get(a.feeId);
    if (!fee) reject("ALLOC_FEE_UNKNOWN", `${ctx}: referenced fee ${a.feeId} not in unit`);
    if (compareBytes(fee.recipient, recipientBytes) !== 0) reject("ALLOC_FEE_RECIPIENT", `${ctx}: fee recipient mismatch`);
    if (fee.amount !== a.amount) reject("ALLOC_FEE_AMOUNT", `${ctx}: fee amount mismatch`);
    feeOption = optionSome(encodeId(a.feeId, `${ctx}.feeId`));
  } else {
    // key presence guaranteed above; only an explicit null encodes Option-None —
    // a present `undefined` (or any value) on a non-fee role rejects.
    if (a.feeId !== null) reject("ALLOC_FEE_PRESENT", `${ctx}: non-fee role must set feeId to null, not ${a.feeId === undefined ? "undefined" : "a value"}`);
    feeOption = optionNone();
  }
  return concat(encodeId(a.allocationId, `${ctx}.allocationId`), u8(role), lp32(recipientBytes), u256(a.amount), feeOption);
}

const OUTCOME_CLASSES = new Set([1, 2, 3, 4, 5, 6]);

function encodeOutcome(o: OutcomeInput, ctx: string, fundedAmount: bigint, feeMap: Map<string, FeeInfo>): Uint8Array {
  assertObject(o, ctx);
  assertExactKeys(o, ["outcomeId", "outcomeClass", "allocations"], ctx);
  if (!OUTCOME_CLASSES.has(o.outcomeClass)) reject("OUTCOME_CLASS_TAG", `${ctx}: unknown outcome class ${o.outcomeClass}`);
  const allocs = o.allocations;
  if (!Array.isArray(allocs)) reject("OUTCOME_ALLOCS", `${ctx}: allocations must be an array`);
  assertDense(allocs, `${ctx}.allocations`);
  const seen = new Set<string>();
  let sum = 0n;
  const parts: Uint8Array[] = [encodeId(o.outcomeId, `${ctx}.outcomeId`), u8(o.outcomeClass), u32(allocs.length)];
  allocs.forEach((al, i) => {
    if (seen.has(al.allocationId)) reject("ALLOC_DUP_ID", `${ctx}: duplicate allocation id ${al.allocationId}`);
    seen.add(al.allocationId);
    const ab = encodeTransferAllocation(al, `${ctx}.alloc[${i}]`, feeMap);
    sum += al.amount;
    parts.push(lp32(ab));
  });
  if (sum !== fundedAmount) reject("OUTCOME_CONSERVATION", `${ctx}: sum(allocations)=${sum} != fundedAmount=${fundedAmount}`);
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// §4.7 Authority selection
// ---------------------------------------------------------------------------

function encodeAuthoritySelection(a: AuthoritySelectionInput, ctx: string, allowedRoles: Set<number>): Uint8Array {
  assertObject(a, ctx);
  const role = (a as { role: number }).role;
  if (role !== 1 && role !== 2 && role !== 3) reject("AUTHORITY_ROLE_TAG", `${ctx}: unknown role ${role}`);
  if (!allowedRoles.has(role)) reject("AUTHORITY_ROLE_NOT_ALLOWED", `${ctx}: role ${role} not permitted here`);
  const mode = (a as { mode?: unknown }).mode;
  if (mode === "all" || mode === "mOfN" || mode === "firstValid") {
    if (mode === "mOfN") assertExactKeys(a, ["role", "mode", "threshold", "principals"], ctx);
    else assertExactKeys(a, ["role", "mode", "principals"], ctx);
    const modeByte = mode === "all" ? 0x01 : mode === "mOfN" ? 0x02 : 0x03;
    const principals = (a as { principals: unknown }).principals;
    if (!Array.isArray(principals) || principals.length < 1) reject("AUTHORITY_PRINCIPALS", `${ctx}: principals must be a nonempty array`);
    assertDense(principals as unknown[], `${ctx}.principals`);
    if ((principals as PrincipalInput[]).length > U16_MAX) reject("AUTHORITY_PRINCIPAL_COUNT", `${ctx}: too many principals`);
    const encoded = (principals as PrincipalInput[]).map((p, i) => encodePrincipal(p, `${ctx}.principal[${i}]`));
    if (mode === "all" || mode === "mOfN") {
      for (let i = 1; i < encoded.length; i++) {
        if (compareBytes(encoded[i - 1], encoded[i]) >= 0) reject("AUTHORITY_NOT_SORTED", `${ctx}: principals must be strictly increasing`);
      }
    } else {
      const seen = new Set<string>();
      for (const e of encoded) {
        const k = bytesToHex(e);
        if (seen.has(k)) reject("AUTHORITY_DUP_PRINCIPAL", `${ctx}: duplicate principal`);
        seen.add(k);
      }
    }
    let threshold: number;
    if (mode === "all") threshold = encoded.length;
    else if (mode === "firstValid") threshold = 1;
    else {
      threshold = (a as { threshold: number }).threshold;
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > encoded.length) {
        reject("AUTHORITY_THRESHOLD", `${ctx}: require 1 <= threshold <= principalCount`);
      }
    }
    const parts: Uint8Array[] = [u8(role), u8(modeByte), u16(threshold), u16(encoded.length)];
    encoded.forEach((e) => parts.push(lp32(e)));
    return concat(...parts);
  }
  if (mode === "externalPolicy") {
    assertExactKeys(a, ["role", "mode", "selectionPolicyId", "selectionPolicyDigest", "registrySnapshotDigest", "threshold"], ctx);
    const aa = a as {
      selectionPolicyId: string;
      selectionPolicyDigest: Digest32Input;
      registrySnapshotDigest: Digest32Input;
      threshold: number;
    };
    if (!Number.isInteger(aa.threshold) || aa.threshold < 0 || aa.threshold > U16_MAX) reject("AUTHORITY_EXT_THRESHOLD", `${ctx}: threshold must be u16`);
    return concat(
      u8(role),
      u8(0x04),
      encodeId(aa.selectionPolicyId, `${ctx}.selectionPolicyId`),
      toDigest32(aa.selectionPolicyDigest, `${ctx}.selectionPolicyDigest`),
      toDigest32(aa.registrySnapshotDigest, `${ctx}.registrySnapshotDigest`),
      u16(aa.threshold),
    );
  }
  reject("AUTHORITY_MODE_TAG", `${ctx}: unknown authority mode ${JSON.stringify(mode)}`);
}

// ---------------------------------------------------------------------------
// §4.8 Evidence, criteria, decision bands, acceptance policy
// ---------------------------------------------------------------------------

function encodeEvidenceRequirement(r: EvidenceRequirementInput, ctx: string): Uint8Array {
  assertObject(r, ctx);
  assertExactKeys(r, ["requirementId", "nodeInstanceId", "evidenceTypeId", "evidenceSchemaDigest", "minCount", "maxCount", "authority"], ctx);
  if (!Number.isInteger(r.minCount) || !Number.isInteger(r.maxCount)) reject("EVIDENCE_COUNT_TYPE", `${ctx}: counts must be integers`);
  if (!(r.minCount >= 1 && r.minCount <= r.maxCount)) reject("EVIDENCE_COUNT_RANGE", `${ctx}: require 1 <= minCount <= maxCount`);
  return concat(
    encodeId(r.requirementId, `${ctx}.requirementId`),
    encodeId(r.nodeInstanceId, `${ctx}.nodeInstanceId`),
    encodeId(r.evidenceTypeId, `${ctx}.evidenceTypeId`),
    toDigest32(r.evidenceSchemaDigest, `${ctx}.evidenceSchemaDigest`),
    u32(r.minCount),
    u32(r.maxCount),
    lp32(encodeAuthoritySelection(r.authority, `${ctx}.authority`, new Set([1, 2, 3]))),
  );
}

function encodeAcceptanceCriterion(c: AcceptanceCriterionInput, ctx: string): Uint8Array {
  assertObject(c, ctx);
  assertExactKeys(
    c,
    ["criterionId", "requirementReferences", "metricId", "metricParameters", "comparator", "target", "lowerTolerance", "upperTolerance", "minPassingEvidence", "authority"],
    ctx,
  );
  assertRequiredKeys(
    c,
    ["criterionId", "requirementReferences", "metricId", "metricParameters", "comparator", "target", "lowerTolerance", "upperTolerance", "minPassingEvidence", "authority"],
    ctx,
  );
  const refs = c.requirementReferences;
  if (!Array.isArray(refs) || refs.length < 1) reject("CRITERION_REFS", `${ctx}: requirementReferences must be nonempty`);
  assertDense(refs, `${ctx}.requirementReferences`);
  if (refs.length > U16_MAX) reject("CRITERION_REFS_COUNT", `${ctx}: too many requirement references`);
  const seen = new Set<string>();
  const refParts: Uint8Array[] = [];
  refs.forEach((rid, i) => {
    if (seen.has(rid)) reject("CRITERION_REF_DUP", `${ctx}: duplicate requirement reference ${rid}`);
    seen.add(rid);
    refParts.push(encodeId(rid, `${ctx}.ref[${i}]`));
  });
  if (!c.metricParameters || (c.metricParameters as { kind?: unknown }).kind !== "map") {
    reject("CRITERION_METRIC_PARAMS", `${ctx}: metricParameters must be a map Value (tag 0x09)`);
  }
  if (!COMPARATORS.has(c.comparator)) reject("CRITERION_COMPARATOR_TAG", `${ctx}: unknown comparator ${c.comparator}`);
  if (!Number.isInteger(c.minPassingEvidence) || c.minPassingEvidence < 1) reject("CRITERION_MIN_PASS", `${ctx}: minPassingEvidence >= 1`);
  // key presence guaranteed above; only an explicit null encodes Option-None. A
  // missing key already rejected (MISSING_FIELD); a present `undefined` falls through
  // to encodeValue and rejects — never silently coerced to None.
  const lowerOpt = c.lowerTolerance === null ? optionNone() : optionSome(encodeValue(c.lowerTolerance, `${ctx}.lowerTolerance`));
  const upperOpt = c.upperTolerance === null ? optionNone() : optionSome(encodeValue(c.upperTolerance, `${ctx}.upperTolerance`));
  return concat(
    encodeId(c.criterionId, `${ctx}.criterionId`),
    u16(refs.length),
    concat(...refParts),
    encodeId(c.metricId, `${ctx}.metricId`),
    lp32(encodeValue(c.metricParameters, `${ctx}.metricParameters`)),
    u8(c.comparator),
    lp32(encodeValue(c.target, `${ctx}.target`)),
    lowerOpt,
    upperOpt,
    u32(c.minPassingEvidence),
    lp32(encodeAuthoritySelection(c.authority, `${ctx}.authority`, new Set([2, 3]))),
  );
}

function encodeDecisionBand(b: DecisionBandInput, ctx: string): Uint8Array {
  assertObject(b, ctx);
  assertExactKeys(b, ["minPassingCriteria", "maxPassingCriteria", "outcomeId"], ctx);
  if (!Number.isInteger(b.minPassingCriteria) || !Number.isInteger(b.maxPassingCriteria)) reject("BAND_TYPE", `${ctx}: band counts must be integers`);
  return concat(u32(b.minPassingCriteria), u32(b.maxPassingCriteria), encodeId(b.outcomeId, `${ctx}.outcomeId`));
}

function encodeAcceptancePolicy(ap: AcceptancePolicyInput, ctx: string, outcomeClassById: Map<string, number>): Uint8Array {
  assertObject(ap, ctx);
  assertExactKeys(ap, ["evidenceRequirements", "criteria", "decisionBands", "finalEvaluatorSelection"], ctx);
  const reqs = ap.evidenceRequirements;
  const crits = ap.criteria;
  const bands = ap.decisionBands;
  if (!Array.isArray(reqs) || reqs.length < 1) reject("POLICY_REQS", `${ctx}: at least one evidence requirement`);
  assertDense(reqs, `${ctx}.evidenceRequirements`);
  if (!Array.isArray(crits) || crits.length < 1) reject("POLICY_CRITERIA", `${ctx}: at least one criterion`);
  assertDense(crits, `${ctx}.criteria`);
  if (!Array.isArray(bands) || bands.length < 1) reject("POLICY_BANDS", `${ctx}: at least one decision band`);
  assertDense(bands, `${ctx}.decisionBands`);
  const reqIds = new Set<string>();
  reqs.forEach((r) => {
    if (reqIds.has(r.requirementId)) reject("POLICY_REQ_DUP", `${ctx}: duplicate requirement id ${r.requirementId}`);
    reqIds.add(r.requirementId);
  });
  const critIds = new Set<string>();
  crits.forEach((c) => {
    if (critIds.has(c.criterionId)) reject("POLICY_CRIT_DUP", `${ctx}: duplicate criterion id ${c.criterionId}`);
    critIds.add(c.criterionId);
  });
  crits.forEach((c, i) => {
    c.requirementReferences.forEach((rid) => {
      if (!reqIds.has(rid)) reject("POLICY_REF_UNRESOLVED", `${ctx}.crit[${i}]: requirement ref ${rid} not local`);
    });
  });
  const reqBytes = reqs.map((r, i) => encodeEvidenceRequirement(r, `${ctx}.req[${i}]`));
  const critBytes = crits.map((c, i) => encodeAcceptanceCriterion(c, `${ctx}.crit[${i}]`));
  const criterionCount = crits.length;
  const SPF = new Set([1, 2, 3]);
  let expectedMin = 0;
  const bandBytes: Uint8Array[] = [];
  bands.forEach((b, i) => {
    if (b.minPassingCriteria !== expectedMin) reject("POLICY_BAND_COVER", `${ctx}.band[${i}]: expected minPassingCriteria=${expectedMin}, got ${b.minPassingCriteria}`);
    if (b.maxPassingCriteria < b.minPassingCriteria) reject("POLICY_BAND_RANGE", `${ctx}.band[${i}]: max < min`);
    const cls = outcomeClassById.get(b.outcomeId);
    if (cls === undefined) reject("POLICY_BAND_OUTCOME_UNKNOWN", `${ctx}.band[${i}]: outcome ${b.outcomeId} not in unit`);
    if (!SPF.has(cls)) reject("POLICY_BAND_OUTCOME_CLASS", `${ctx}.band[${i}]: band must reference a success/partial/failure outcome`);
    bandBytes.push(encodeDecisionBand(b, `${ctx}.band[${i}]`));
    expectedMin = b.maxPassingCriteria + 1;
  });
  if (expectedMin !== criterionCount + 1) reject("POLICY_BAND_COVERAGE", `${ctx}: decision bands must cover 0..${criterionCount} exactly once`);
  const finalBytes = encodeAuthoritySelection(ap.finalEvaluatorSelection, `${ctx}.finalEvaluatorSelection`, new Set([2, 3]));
  const parts: Uint8Array[] = [u32(reqs.length)];
  reqBytes.forEach((b) => parts.push(lp32(b)));
  parts.push(u32(crits.length));
  critBytes.forEach((b) => parts.push(lp32(b)));
  parts.push(u32(bands.length));
  bandBytes.forEach((b) => parts.push(lp32(b)));
  parts.push(lp32(finalBytes));
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// §4.9 Settlement-unit record
// ---------------------------------------------------------------------------

function encodeSettlementUnitRecord(
  u: SettlementUnitInput,
  ctx: string,
  expectedOrdinal: number,
  nodeOrderIndex: Map<string, number>,
  decimalsRegistry: Map<string, number>,
  globalMemberTracker: Map<string, string>,
): Uint8Array {
  assertObject(u, ctx);
  assertExactKeys(u, ["settlementUnitId", "settlementOrdinal", "memberNodeIds", "asset", "fundedAmount", "feeRules", "outcomes", "acceptancePolicy"], ctx);
  if (u.settlementOrdinal !== expectedOrdinal) reject("UNIT_ORDINAL", `${ctx}: settlementOrdinal ${u.settlementOrdinal} != expected ${expectedOrdinal}`);
  const members = u.memberNodeIds;
  if (!Array.isArray(members) || members.length < 1) reject("UNIT_MEMBERS", `${ctx}: memberCount >= 1`);
  assertDense(members, `${ctx}.memberNodeIds`);
  const localSeen = new Set<string>();
  let prevIdx = -1;
  members.forEach((mid) => {
    if (localSeen.has(mid)) reject("UNIT_MEMBER_DUP", `${ctx}: duplicate member ${mid}`);
    localSeen.add(mid);
    const idx = nodeOrderIndex.get(mid);
    if (idx === undefined) reject("UNIT_MEMBER_UNKNOWN", `${ctx}: member ${mid} is not a plan node`);
    if (idx <= prevIdx) reject("UNIT_MEMBER_ORDER", `${ctx}: member order must follow global node order`);
    prevIdx = idx;
    if (globalMemberTracker.has(mid)) reject("UNIT_PARTITION_DUP", `${ctx}: node ${mid} appears in multiple settlement units`);
    globalMemberTracker.set(mid, u.settlementUnitId);
  });
  if (typeof u.fundedAmount !== "bigint" || u.fundedAmount <= 0n) reject("UNIT_FUNDED", `${ctx}: fundedAmount > 0`);
  if (u.fundedAmount > U256_MAX) reject("UNIT_FUNDED_RANGE", `${ctx}: fundedAmount must fit u256`);
  const fees = u.feeRules;
  if (!Array.isArray(fees)) reject("UNIT_FEES", `${ctx}: feeRules must be an array`);
  assertDense(fees, `${ctx}.feeRules`);
  const feeMap = new Map<string, FeeInfo>();
  const feeBytes: Uint8Array[] = [];
  fees.forEach((f, i) => {
    if (feeMap.has(f.feeId)) reject("UNIT_FEE_DUP", `${ctx}: duplicate fee id ${f.feeId}`);
    const fb = encodeFeeRule(f, `${ctx}.fee[${i}]`);
    const recipient = encodePrincipal(f.recipient, `${ctx}.fee[${i}].recipient`);
    feeMap.set(f.feeId, { recipient, amount: f.exactAmount });
    feeBytes.push(fb);
  });
  const outcomes = u.outcomes;
  if (!Array.isArray(outcomes)) reject("UNIT_OUTCOMES", `${ctx}: outcomes must be an array`);
  assertDense(outcomes, `${ctx}.outcomes`);
  const outcomeIds = new Set<string>();
  const outcomeClassById = new Map<string, number>();
  const classCounts = new Map<number, number>();
  const outcomeBytes: Uint8Array[] = [];
  outcomes.forEach((o, i) => {
    if (outcomeIds.has(o.outcomeId)) reject("UNIT_OUTCOME_DUP", `${ctx}: duplicate outcome id ${o.outcomeId}`);
    outcomeIds.add(o.outcomeId);
    const ob = encodeOutcome(o, `${ctx}.outcome[${i}]`, u.fundedAmount, feeMap);
    outcomeClassById.set(o.outcomeId, o.outcomeClass);
    classCounts.set(o.outcomeClass, (classCounts.get(o.outcomeClass) ?? 0) + 1);
    outcomeBytes.push(ob);
  });
  for (const cls of [1, 3, 4, 5, 6]) {
    if ((classCounts.get(cls) ?? 0) !== 1) reject("UNIT_OUTCOME_REQUIRED", `${ctx}: exactly one outcome of class ${cls} is required`);
  }
  if ((classCounts.get(2) ?? 0) < 1) reject("UNIT_OUTCOME_PARTIAL", `${ctx}: at least one partial outcome is required`);
  const apBytes = encodeAcceptancePolicy(u.acceptancePolicy, `${ctx}.acceptancePolicy`, outcomeClassById);
  const parts: Uint8Array[] = [u8(0x30), encodeId(u.settlementUnitId, `${ctx}.settlementUnitId`), u32(u.settlementOrdinal), u32(members.length)];
  members.forEach((mid) => parts.push(encodeId(mid, `${ctx}.member`)));
  parts.push(lp32(encodeAsset(u.asset, `${ctx}.asset`, decimalsRegistry)));
  parts.push(u256(u.fundedAmount));
  parts.push(u16(fees.length));
  feeBytes.forEach((b) => parts.push(lp32(b)));
  parts.push(u16(outcomes.length));
  outcomeBytes.forEach((b) => parts.push(lp32(b)));
  parts.push(lp32(apBytes));
  return concat(...parts);
}

// ---------------------------------------------------------------------------
// §5 Dependency closure
// ---------------------------------------------------------------------------

interface UseSite {
  parentKind: number; // 0x01 plan node, 0x02 transitive CSD
  parentId: string;
  slotId: string;
  ordinal: number;
  multiplicity: number;
}

function detectCycle(edges: Map<string, Set<string>>): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const allNodes = new Set<string>();
  edges.forEach((outs, k) => {
    allNodes.add(k);
    outs.forEach((o) => allNodes.add(o));
  });
  // iterative DFS to avoid deep recursion
  for (const start of allNodes) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue;
    const stack: Array<{ id: string; it: Iterator<string> }> = [{ id: start, it: (edges.get(start) ?? new Set<string>()).values() }];
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = top.it.next();
      if (next.done) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const v = next.value;
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) reject("CLOSURE_CYCLE", `closure dependency graph has a cycle at ${v}`);
      if (c === WHITE) {
        color.set(v, GRAY);
        stack.push({ id: v, it: (edges.get(v) ?? new Set<string>()).values() });
      }
    }
  }
}

function buildClosureRecords(
  plan: PlanV1,
  m1: M1ResolvedDependencyGraph,
  nodeDigest: Map<string, Uint8Array>,
  m1NodeById: Map<string, M1NodeResolution>,
  ctx: string,
): Uint8Array[] {
  const depById = new Map<string, M1DependencyResolution>();
  m1.dependencies.forEach((d) => {
    if (depById.has(d.dependencyInstanceId)) reject("CLOSURE_DEP_DUP", `${ctx}: duplicate transitive dependency id ${d.dependencyInstanceId}`);
    depById.set(d.dependencyInstanceId, d);
  });

  const useSitesByChild = new Map<string, UseSite[]>();
  const parentEdges = new Map<string, Set<string>>();
  const qual = (kind: number, id: string): string => `${kind}:${id}`;

  const processParent = (parentKind: number, parentId: string, uses: M1DependencyUse[]): void => {
    if (!Array.isArray(uses)) reject("CLOSURE_USES", `${ctx}: dependencyUses must be an array for ${parentId}`);
    assertDense(uses, `${ctx}.dependencyUses(${parentId})`);
    const ordinals = new Set<number>();
    uses.forEach((use) => {
      assertObject(use, `${ctx}.use(${parentId})`);
      assertExactKeys(use, ["dependencySlotId", "dependencyOrdinal", "multiplicity", "dependencyInstanceId"], `${ctx}.use(${parentId})`);
      if (!Number.isInteger(use.multiplicity) || use.multiplicity < 1) reject("CLOSURE_MULT", `${ctx}: use multiplicity >= 1`);
      if (!Number.isInteger(use.dependencyOrdinal) || use.dependencyOrdinal < 0) reject("CLOSURE_ORDINAL", `${ctx}: use ordinal must be a non-negative integer`);
      if (ordinals.has(use.dependencyOrdinal)) reject("CLOSURE_ORDINAL_DUP", `${ctx}: duplicate dependencyOrdinal for parent ${parentId}`);
      ordinals.add(use.dependencyOrdinal);
      const child = use.dependencyInstanceId;
      if (!depById.has(child)) reject("CLOSURE_CHILD_UNKNOWN", `${ctx}: use references unknown transitive dependency ${child}`);
      const arr = useSitesByChild.get(child) ?? [];
      arr.push({ parentKind, parentId, slotId: use.dependencySlotId, ordinal: use.dependencyOrdinal, multiplicity: use.multiplicity });
      useSitesByChild.set(child, arr);
      const set = parentEdges.get(qual(parentKind, parentId)) ?? new Set<string>();
      set.add(qual(0x02, child));
      parentEdges.set(qual(parentKind, parentId), set);
    });
    for (let k = 0; k < uses.length; k++) {
      if (!ordinals.has(k)) reject("CLOSURE_ORDINAL_GAP", `${ctx}: parent ${parentId} dependencyOrdinals must be exactly 0..${uses.length - 1}`);
    }
  };

  plan.nodes.forEach((n) => processParent(0x01, n.nodeInstanceId, m1NodeById.get(n.nodeInstanceId)!.dependencyUses));
  m1.dependencies.forEach((d) => processParent(0x02, d.dependencyInstanceId, d.dependencyUses));

  detectCycle(parentEdges);

  // reachability: every transitive dependency reachable from some plan node (§5.4 rule 6)
  const reachable = new Set<string>();
  const stack: string[] = plan.nodes.map((n) => qual(0x01, n.nodeInstanceId));
  while (stack.length) {
    const cur = stack.pop()!;
    const outs = parentEdges.get(cur);
    if (outs) {
      for (const c of outs) {
        if (!reachable.has(c)) {
          reachable.add(c);
          stack.push(c);
        }
      }
    }
  }
  m1.dependencies.forEach((d) => {
    if (!reachable.has(qual(0x02, d.dependencyInstanceId))) {
      reject("CLOSURE_UNREACHABLE", `${ctx}: transitive dependency ${d.dependencyInstanceId} is not reachable from any plan node`);
    }
  });

  const records: Uint8Array[] = [];
  // plan-node entries in plan node order (§5.2, §5.3)
  plan.nodes.forEach((n) => {
    records.push(concat(u8(0x01), encodeId(n.nodeInstanceId, `${ctx}.node`), nodeDigest.get(n.nodeInstanceId)!, u16(0)));
  });
  // transitive entries sorted by dependencyInstanceId ASCII bytes (§5.3)
  const sortedDeps = [...m1.dependencies].sort((a, b) => compareBytes(asciiBytes(a.dependencyInstanceId, "dep"), asciiBytes(b.dependencyInstanceId, "dep")));
  sortedDeps.forEach((d) => {
    const digest = toDigest32(d.capabilityContractDigest, `${ctx}.dep(${d.dependencyInstanceId}).digest`);
    const sites = (useSitesByChild.get(d.dependencyInstanceId) ?? []).slice();
    sites.sort((x, y) => {
      if (x.parentKind !== y.parentKind) return x.parentKind < y.parentKind ? -1 : 1;
      const pc = compareBytes(asciiBytes(x.parentId, "p"), asciiBytes(y.parentId, "p"));
      if (pc !== 0) return pc;
      if (x.ordinal !== y.ordinal) return x.ordinal < y.ordinal ? -1 : 1;
      const sc = compareBytes(asciiBytes(x.slotId, "s"), asciiBytes(y.slotId, "s"));
      if (sc !== 0) return sc;
      if (x.multiplicity !== y.multiplicity) return x.multiplicity < y.multiplicity ? -1 : 1;
      return 0;
    });
    for (let i = 1; i < sites.length; i++) {
      const a = sites[i - 1];
      const b = sites[i];
      if (a.parentKind === b.parentKind && a.parentId === b.parentId && a.ordinal === b.ordinal && a.slotId === b.slotId && a.multiplicity === b.multiplicity) {
        reject("CLOSURE_USESITE_DUP", `${ctx}: duplicate use site for ${d.dependencyInstanceId}`);
      }
    }
    const parts: Uint8Array[] = [u8(0x02), encodeId(d.dependencyInstanceId, `${ctx}.dep`), digest, u16(sites.length)];
    sites.forEach((s) => {
      const site = concat(u8(s.parentKind), encodeId(s.parentId, `${ctx}.site.parent`), encodeId(s.slotId, `${ctx}.site.slot`), u32(s.ordinal), u32(s.multiplicity));
      parts.push(lp32(site));
    });
    records.push(concat(...parts));
  });
  return records;
}

// ---------------------------------------------------------------------------
// Node-vs-M1 validation (§4.2). Never affects bytes; adds rejections only.
// ---------------------------------------------------------------------------

function validateNodeAgainstM1(n: NodeInput, m: M1NodeResolution, ctx: string): void {
  const configurable = new Map<string, { required: boolean; unitId?: string | null }>();
  m.configurableParameters.forEach((p) => {
    assertObject(p, `${ctx}.m1.param`);
    assertExactKeys(p, ["name", "required", "unitId"], `${ctx}.m1.param`);
    configurable.set(p.name, { required: p.required, unitId: p.unitId });
  });
  const fixed = new Set(m.fixedParameters);
  const forbidden = new Set(m.forbiddenParameters);
  const present = new Set<string>();
  n.executionParameters.forEach((p) => {
    present.add(p.name);
    if (forbidden.has(p.name)) reject("NODE_PARAM_FORBIDDEN", `${ctx}: parameter ${p.name} is forbidden by the resolved CSD`);
    if (fixed.has(p.name)) reject("NODE_PARAM_FIXED_OVERRIDE", `${ctx}: parameter ${p.name} is fixed by the CSD (override forbidden)`);
    if (!configurable.has(p.name)) reject("NODE_PARAM_UNKNOWN", `${ctx}: parameter ${p.name} is not configurable in the resolved CSD`);
  });
  configurable.forEach((meta, name) => {
    if (meta.required && !present.has(name)) reject("NODE_PARAM_MISSING_REQUIRED", `${ctx}: required parameter ${name} is missing`);
  });
  const fixedTolPaths = new Set(m.fixedTolerancePaths.map((p) => p.join(" ")));
  n.tolerances.forEach((t) => {
    const key = t.parameterPath.join(" ");
    if (fixedTolPaths.has(key)) reject("NODE_TOL_FIXED", `${ctx}: tolerance path is fixed by the CSD`);
    if (t.kind !== 2 && t.parameterPath.length >= 1) {
      const meta = configurable.get(t.parameterPath[0]);
      if (meta && meta.unitId != null && meta.unitId !== t.unitId) {
        reject("NODE_TOL_UNIT", `${ctx}: tolerance unit ${t.unitId} incompatible with declared ${meta.unitId}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Orchestrator: planDigest (§4.1), depClosureDigest (§5.5), compositionRoot (§6)
// ---------------------------------------------------------------------------

/** Options for {@link deriveComposition}. */
export interface DeriveOptions {
  /**
   * An optional pre-serialized closure carried alongside the plan (spec §5.1).
   * If present, it must regenerate byte-for-byte equal to the closure this
   * function builds from M1, else derivation rejects.
   */
  serializedClosure?: SerializedClosureInput;
}

/** Raw 32-byte digests produced by the derivation (spec §4/§5/§6). */
export interface CompositionResult {
  planDigest: Uint8Array;
  depClosureDigest: Uint8Array;
  compositionRoot: Uint8Array;
}

/**
 * Derive `planDigest`, `depClosureDigest`, and `compositionRoot` (all raw 32
 * bytes) from a funded plan and its validated M1 resolution. Pure + offline +
 * deterministic. Rejects (throws {@link CompositionRootError}) rather than
 * hashing on any spec §7 violation.
 */
export function deriveComposition(plan: PlanV1, m1: M1ResolvedDependencyGraph, options: DeriveOptions = {}): CompositionResult {
  assertObject(plan, "plan");
  assertExactKeys(plan, ["schemaVersion", "nodes", "edges", "settlementUnits"], "plan");
  if (plan.schemaVersion !== 1) reject("SCHEMA_VERSION", `unsupported schema version ${plan.schemaVersion}`);
  assertObject(m1, "m1");
  assertExactKeys(m1, ["nodes", "dependencies"], "m1");

  const nodes = plan.nodes;
  const edges = plan.edges;
  const units = plan.settlementUnits;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(units)) reject("PLAN_ARRAYS", `plan nodes/edges/settlementUnits must be arrays`);
  assertDense(nodes, "plan.nodes");
  assertDense(edges, "plan.edges");
  assertDense(units, "plan.settlementUnits");
  if (!Array.isArray(m1.nodes) || !Array.isArray(m1.dependencies)) reject("M1_ARRAYS", `m1 nodes/dependencies must be arrays`);
  assertDense(m1.nodes, "m1.nodes");
  assertDense(m1.dependencies, "m1.dependencies");

  const N = nodes.length;
  const E = edges.length;
  const U = units.length;
  // Empty plan (§4.11) and schema-v1 minimums (§4.1) — rejected, never hashed (§7).
  if (N === 0 && E === 0 && U === 0) reject("EMPTY_PLAN", `an empty plan is rejected under schema version 1`);
  if (N < 1) reject("PLAN_NODE_COUNT", `schema version 1 requires N >= 1`);
  if (U < 1) reject("PLAN_UNIT_COUNT", `schema version 1 requires U >= 1`);

  // M1 node lookup + uniqueness.
  const m1NodeById = new Map<string, M1NodeResolution>();
  m1.nodes.forEach((nd, i) => {
    assertObject(nd, `m1.nodes[${i}]`);
    assertExactKeys(
      nd,
      ["nodeInstanceId", "capabilityContractDigest", "outputPorts", "inputPorts", "configurableParameters", "fixedParameters", "forbiddenParameters", "fixedTolerancePaths", "dependencyUses"],
      `m1.nodes[${i}]`,
    );
    if (m1NodeById.has(nd.nodeInstanceId)) reject("M1_NODE_DUP", `duplicate m1 node ${nd.nodeInstanceId}`);
    m1NodeById.set(nd.nodeInstanceId, nd);
  });
  m1.dependencies.forEach((d, i) => {
    assertObject(d, `m1.dependencies[${i}]`);
    assertExactKeys(d, ["dependencyInstanceId", "capabilityContractDigest", "dependencyUses"], `m1.dependencies[${i}]`);
  });

  // Nodes (§4.2, §4.10 ordering enforced against edges below).
  const nodeOrderIndex = new Map<string, number>();
  const nodeDigest = new Map<string, Uint8Array>();
  const nodeRecs: Uint8Array[] = [];
  nodes.forEach((n, i) => {
    if (nodeOrderIndex.has(n.nodeInstanceId)) reject("NODE_DUP_ID", `duplicate node instance id ${n.nodeInstanceId}`);
    nodeOrderIndex.set(n.nodeInstanceId, i);
    nodeRecs.push(encodeNodeRecord(n, `plan.nodes[${i}]`));
    const digest = toDigest32(n.capabilityContractDigest, `plan.nodes[${i}].capabilityContractDigest`);
    nodeDigest.set(n.nodeInstanceId, digest);
    const m = m1NodeById.get(n.nodeInstanceId);
    if (!m) reject("NODE_NO_M1", `plan node ${n.nodeInstanceId} has no M1 resolution`);
    const m1digest = toDigest32(m.capabilityContractDigest, `m1.node(${n.nodeInstanceId}).capabilityContractDigest`);
    if (compareBytes(digest, m1digest) !== 0) reject("NODE_DIGEST_MISMATCH", `plan node ${n.nodeInstanceId} digest != M1 digest (§5.4 rule 2)`);
    validateNodeAgainstM1(n, m, `plan.nodes[${i}]`);
  });
  m1.nodes.forEach((nd) => {
    if (!nodeOrderIndex.has(nd.nodeInstanceId)) reject("M1_NODE_EXTRA", `M1 node ${nd.nodeInstanceId} has no corresponding plan node (§5.4 rule 9)`);
  });

  // Edges (§4.4, §4.10).
  const edgeRecs: Uint8Array[] = [];
  const edgeIds = new Set<string>();
  const ordinalTracker = new Map<string, Set<number>>();
  edges.forEach((e, i) => {
    if (edgeIds.has(e.edgeId)) reject("EDGE_DUP_ID", `duplicate edge id ${e.edgeId}`);
    edgeIds.add(e.edgeId);
    edgeRecs.push(encodeEdgeRecord(e, `plan.edges[${i}]`));
    const si = nodeOrderIndex.get(e.sourceNodeId);
    if (si === undefined) reject("EDGE_SRC_UNKNOWN", `edge ${e.edgeId} source node ${e.sourceNodeId} does not exist`);
    const di = nodeOrderIndex.get(e.destinationNodeId);
    if (di === undefined) reject("EDGE_DST_UNKNOWN", `edge ${e.edgeId} destination node ${e.destinationNodeId} does not exist`);
    const sm = m1NodeById.get(e.sourceNodeId)!;
    const dm = m1NodeById.get(e.destinationNodeId)!;
    if (!sm.outputPorts.includes(e.sourcePortId)) reject("EDGE_SRC_PORT", `edge ${e.edgeId} source port ${e.sourcePortId} not in resolved CSD`);
    if (!dm.inputPorts.includes(e.destinationPortId)) reject("EDGE_DST_PORT", `edge ${e.edgeId} destination port ${e.destinationPortId} not in resolved CSD`);
    if (si >= di) reject("EDGE_NOT_TOPOLOGICAL", `edge ${e.edgeId}: index(source) must be < index(destination)`);
    const refs = new Set<string>();
    collectConditionNodeRefs(e.condition, refs);
    for (const rid of refs) {
      const ri = nodeOrderIndex.get(rid);
      if (ri === undefined) reject("EDGE_COND_NODE_UNKNOWN", `edge ${e.edgeId}: condition references unknown node ${rid}`);
      if (ri >= di) reject("EDGE_COND_NOT_TOPOLOGICAL", `edge ${e.edgeId}: condition node ${rid} must precede the destination`);
    }
    const key = `${e.destinationNodeId} ${e.destinationPortId}`;
    const set = ordinalTracker.get(key) ?? new Set<number>();
    if (set.has(e.inputOrdinal)) reject("EDGE_ORDINAL_DUP", `edge ${e.edgeId}: duplicate inputOrdinal ${e.inputOrdinal} for (${e.destinationNodeId},${e.destinationPortId})`);
    set.add(e.inputOrdinal);
    ordinalTracker.set(key, set);
  });
  ordinalTracker.forEach((set, key) => {
    const k = set.size;
    for (let x = 0; x < k; x++) {
      if (!set.has(x)) reject("EDGE_ORDINAL_GAP", `(${key}) inputOrdinals must be exactly 0..${k - 1}`);
    }
  });

  // Settlement units (§4.9) + exact partition of nodes.
  const unitRecs: Uint8Array[] = [];
  const decimalsRegistry = new Map<string, number>();
  const memberTracker = new Map<string, string>();
  const unitIds = new Set<string>();
  units.forEach((u, i) => {
    if (unitIds.has(u.settlementUnitId)) reject("UNIT_DUP_ID", `duplicate settlement unit id ${u.settlementUnitId}`);
    unitIds.add(u.settlementUnitId);
    unitRecs.push(encodeSettlementUnitRecord(u, `plan.settlementUnits[${i}]`, i, nodeOrderIndex, decimalsRegistry, memberTracker));
  });
  if (memberTracker.size !== N) reject("PARTITION_INCOMPLETE", `settlement units must partition all ${N} nodes; covered ${memberTracker.size}`);

  // planDigest (§4.1).
  const planTree = merkleListRoot([...nodeRecs, ...edgeRecs, ...unitRecs], DOM_PLAN_LEAF, DOM_PLAN_NODE, DOM_PLAN_EMPTY);
  const planDigest = H(concat(DOM_PLAN_ROOT, u16(1), u32(N), u32(E), u32(U), planTree));

  // Closure (§5) + optional serialized-closure equality (§5.1).
  const closureRecords = buildClosureRecords(plan, m1, nodeDigest, m1NodeById, "closure");
  if (options.serializedClosure) {
    assertObject(options.serializedClosure, "serializedClosure");
    assertExactKeys(options.serializedClosure, ["records"], "serializedClosure");
    const provided = options.serializedClosure.records;
    if (!Array.isArray(provided) || provided.length !== closureRecords.length) {
      reject("CLOSURE_SERIALIZED_MISMATCH", `serialized closure record count differs from the regenerated closure`);
    }
    for (let i = 0; i < closureRecords.length; i++) {
      if (!(provided[i] instanceof Uint8Array) || compareBytes(provided[i], closureRecords[i]) !== 0) {
        reject("CLOSURE_SERIALIZED_MISMATCH", `serialized closure record ${i} differs from the regenerated closure`);
      }
    }
  }
  const closureTree = merkleListRoot(closureRecords, DOM_CLOSURE_LEAF, DOM_CLOSURE_NODE, DOM_CLOSURE_EMPTY);
  const depClosureDigest = H(concat(DOM_CLOSURE_ROOT, u16(1), u32(closureRecords.length), closureTree));

  // compositionRoot (§6).
  const closureLeaf = H(concat(DOM_COMP_LEAF, u8(0x01), u32(0), depClosureDigest));
  const planLeaf = H(concat(DOM_COMP_LEAF, u8(0x02), u32(1), planDigest));
  const merkleRoot = H(concat(DOM_COMP_NODE, closureLeaf, planLeaf));
  const compositionRoot = H(concat(DOM_COMP_ROOT, u16(1), merkleRoot));

  return { planDigest, depClosureDigest, compositionRoot };
}

/**
 * Derive the raw 32-byte `compositionRoot` from a funded plan and its validated
 * M1 resolution (spec §6). Pure + offline + deterministic.
 */
export function deriveCompositionRoot(plan: PlanV1, m1: M1ResolvedDependencyGraph, options?: DeriveOptions): Uint8Array {
  return deriveComposition(plan, m1, options).compositionRoot;
}

/**
 * Convenience wrapper returning the branded `sha256:<hex>` form of the
 * composition root. The branded/hex form is produced ONLY here, at the output
 * boundary — never inside a hash preimage.
 */
export function deriveCompositionRootHex(plan: PlanV1, m1: M1ResolvedDependencyGraph, options?: DeriveOptions): SHA256 {
  return `sha256:${bytesToHex(deriveCompositionRoot(plan, m1, options))}` as SHA256;
}

/** Lowercase hex of a raw digest (output-boundary helper). */
export function digestToHex(d: Uint8Array): string {
  return bytesToHex(d);
}

/** The DEFINED (but rejected) empty-plan digest (spec §4.11), for golden vectors. */
export function emptyPlanDigest(): Uint8Array {
  const emptyPlanTree = H(DOM_PLAN_EMPTY);
  return H(concat(DOM_PLAN_ROOT, u16(1), u32(0), u32(0), u32(0), emptyPlanTree));
}

/** The DEFINED empty-closure digest (spec §5.5), for golden vectors. */
export function emptyClosureDigest(): Uint8Array {
  const emptyClosureTree = H(DOM_CLOSURE_EMPTY);
  return H(concat(DOM_CLOSURE_ROOT, u16(1), u32(0), emptyClosureTree));
}

// ===========================================================================
// compositionRoot v2 — evalSemanticsLeaf (§3) + policyLeaf (§4) + F8 (§5) +
// deriveCompositionV2 (§1). Spec: ai/research/pcc-inc3a-v2-evalsemantics-leaf-spec.md.
// The v1 derivation above is unchanged; v2 reuses it for planDigest/depClosureDigest.
// ===========================================================================

const COMPARATOR_TAGS = new Set([1, 2, 3, 4, 5, 6]); // §4.3 comparator enum
const VALUE_KIND_TAGS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]); // §1.4 Value-kind tags
// sol f2: the pinned authoritative authorityPolicy-projection digest (evidence golden, cross-confirmed by
// composition #1032/#1036 + oracle #820). deriveCompositionV2 embeds the 51 rows, recomputes, and asserts this.
const PINNED_PROJECTION_DIGEST = "0xb044b20b6ea2470f0d80e2fc73651c77a9dfc406707df1dfec460335f5a83900";

/** Encode a strictly-ascending, tag-validated u8 set: u8(count) || u8(v)*. */
function u8AscSet(values: number[], allowed: Set<number>, ctx: string): Uint8Array {
  if (!Array.isArray(values)) reject("U8SET_TYPE", `${ctx}: expected array`);
  if (values.length > 0xff) reject("U8SET_COUNT", `${ctx}: too many entries (${values.length})`);
  const parts: Uint8Array[] = [u8(values.length)];
  let prev = -1;
  for (const v of values) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) reject("U8SET_RANGE", `${ctx}: value ${v} is not a u8`);
    if (v <= prev) reject("U8SET_ORDER", `${ctx}: values must be strictly ascending (got ${v} after ${prev})`);
    if (!allowed.has(v)) reject("U8SET_TAG", `${ctx}: value ${v} is not an allowed tag`);
    prev = v;
    parts.push(u8(v));
  }
  return concat(...parts);
}

/** evidence-type entry (§3): 0x01 || Id(evidenceTypeId) || specificationDigest32 (opaque). */
function encodeEvTypeEntry(row: EvidenceTypeRow, ctx: string): Uint8Array {
  assertObject(row, ctx);
  assertExactKeys(row, ["evidenceTypeId", "specificationDigest"], ctx);
  return concat(u8(0x01), encodeId(row.evidenceTypeId, `${ctx}.evidenceTypeId`), toDigest32(row.specificationDigest, `${ctx}.specificationDigest`));
}

/** metric entry (§3): 0x02 || Id || specDigest32 || comparators || targetKinds || tolKinds || requireBoth || paramSchemaDigest32. */
function encodeMetricEntry(row: MetricCatalogRow, ctx: string): Uint8Array {
  assertObject(row, ctx);
  assertExactKeys(
    row,
    ["metricId", "specificationDigest", "permittedComparators", "targetValueKinds", "toleranceValueKinds", "requireBothTolerances", "parameterSchemaDigest"],
    ctx,
  );
  if (typeof row.requireBothTolerances !== "boolean") reject("METRIC_REQBOTH_TYPE", `${ctx}: requireBothTolerances must be boolean`);
  return concat(
    u8(0x02),
    encodeId(row.metricId, `${ctx}.metricId`),
    toDigest32(row.specificationDigest, `${ctx}.specificationDigest`),
    u8AscSet(row.permittedComparators, COMPARATOR_TAGS, `${ctx}.permittedComparators`),
    u8AscSet(row.targetValueKinds, VALUE_KIND_TAGS, `${ctx}.targetValueKinds`),
    u8AscSet(row.toleranceValueKinds, VALUE_KIND_TAGS, `${ctx}.toleranceValueKinds`),
    u8(row.requireBothTolerances ? 1 : 0),
    toDigest32(row.parameterSchemaDigest, `${ctx}.parameterSchemaDigest`),
  );
}

/**
 * F8 (§5) — id-SET resolution ONLY (increment 2): reject any extra/missing/duplicate
 * id vs the plan-referenced set; return sorted by id (ascending ASCII bytes). This does
 * NOT yet enforce row-CONTENT authority (a supplied row == the pinned authoritative row)
 * — a producer can still inject permissive contents until the cross-lane fix at bulletin
 * #772 lands. See spec §5 IMPLEMENTATION STATUS.
 */
function resolveExactRows<T>(rows: T[], idOf: (r: T) => string, referenced: Set<string>, ctx: string): T[] {
  if (!Array.isArray(rows)) reject("EVAL_ROWS_TYPE", `${ctx}: expected array`);
  const byId = new Map<string, T>();
  rows.forEach((r, i) => {
    assertObject(r, `${ctx}[${i}]`);
    const id = idOf(r);
    if (typeof id !== "string") reject("EVAL_ROW_ID_TYPE", `${ctx}[${i}]: id must be a string`);
    if (byId.has(id)) reject("EVAL_ROW_DUP", `${ctx}: duplicate row id ${id}`);
    byId.set(id, r);
  });
  referenced.forEach((id) => {
    if (!byId.has(id)) reject("EVAL_ID_SET_MISMATCH", `${ctx}: plan references '${id}' but there is no pinned row`);
  });
  byId.forEach((_v, id) => {
    if (!referenced.has(id)) reject("EVAL_ID_SET_MISMATCH", `${ctx}: pinned row '${id}' is not referenced by the plan (no extras)`);
  });
  return [...byId.keys()].sort((a, b) => compareBytes(asciiBytes(a, ctx), asciiBytes(b, ctx))).map((id) => byId.get(id)!);
}

/**
 * increment-3 (sol comprehensive-review f1; evidence #853 answer A): the STATIC evidenceSubjectBindings
 * check, run over the AUTHENTICATED policy preimage. requirementId is globally unique across a plan, so
 * composition matches each plan EvidenceRequirement to its binding by requirementIdHash = keccak(requirementId)
 * ALONE; the chain-bound settlementUnitId is carried opaquely and re-bound by the ORACLE at settlement (the F3
 * split — composition cannot form the chain-bound id pre-funding). Per requirement: exactly-one binding;
 * propositionKind in {0..16}; propositionKind == the authoritative projection's propositionSubjectConstraint for
 * (evidenceType, tier); authority.role in allowedSourceRoles. tier = the authenticated policy assuranceTier
 * (job-global, evidence #1027). Rejects rather than derives on any violation; does NOT touch planDigest.
 * NOTE: the A-vs-C layering (evidence A here vs escrow's predict-the-address C) is under cross-family review;
 * A is chosen because C is circular against the committed binding struct (settlementUnitId -> acceptedPolicyDigest
 * -> predicted address -> settlementUnitId). Shadow-only until that review confirms.
 */
function checkEvidenceSubjectBindings(
  plan: PlanV1,
  preimage: CanonicalAcceptedJobPolicyV1,
  projectionRows: ProjectionRow[],
): void {
  const tier = Number(preimage.assuranceTier);
  // index bindings by requirementIdHash; reject a duplicate (globally-unique requirementId — evidence #853).
  const bindingByReq = new Map<string, number>(); // requirementIdHash hex -> propositionKind
  preimage.evidenceSubjectBindings.forEach((b, i) => {
    if (!Number.isInteger(b.propositionKind) || b.propositionKind < 0 || b.propositionKind > 16) {
      reject("SUBJECT_BINDING_KIND", `evidenceSubjectBindings[${i}]: propositionKind ${b.propositionKind} not in {0..16}`);
    }
    const key = pacBytesToHex(b.requirementIdHash);
    if (bindingByReq.has(key)) reject("SUBJECT_BINDING_DUPLICATE", `two bindings share requirementIdHash ${key}`);
    bindingByReq.set(key, b.propositionKind);
  });
  const matched = new Set<string>();
  plan.settlementUnits.forEach((u) => {
    u.acceptancePolicy.evidenceRequirements.forEach((r) => {
      const reqKey = pacBytesToHex(pacKeccakUtf8(r.requirementId));
      if (!bindingByReq.has(reqKey)) reject("SUBJECT_BINDING_MISSING", `no evidenceSubjectBinding for requirement '${r.requirementId}'`);
      matched.add(reqKey);
      const propositionKind = bindingByReq.get(reqKey)!;
      const proj = lookupProjection(projectionRows, pacKeccakUtf8(r.evidenceTypeId), tier);
      if (proj === null) reject("SUBJECT_BINDING_MISMATCH", `no authority projection row for (${r.evidenceTypeId}, tier ${tier})`);
      if (propositionKind !== proj!.propositionSubjectConstraint) {
        reject("SUBJECT_BINDING_MISMATCH", `requirement '${r.requirementId}' propositionKind ${propositionKind} != authoritative ${proj!.propositionSubjectConstraint}`);
      }
      const role = r.authority.role;
      if (!Number.isInteger(role) || role < 1 || role > 3) reject("SUBJECT_BINDING_ROLE", `requirement '${r.requirementId}': authority.role ${role} not in {1,2,3}`);
      const roleBit = 1 << (role - 1); // 1 emitter->0b001, 2 evaluator->0b010, 3 oracle->0b100
      if ((roleBit & proj!.allowedSourceRoles) === 0) {
        reject("SUBJECT_BINDING_ROLE", `requirement '${r.requirementId}' role ${role} not in allowedSourceRoles ${proj!.allowedSourceRoles}`);
      }
    });
  });
  bindingByReq.forEach((_v, key) => {
    if (!matched.has(key)) reject("SUBJECT_BINDING_ORPHAN", `evidenceSubjectBinding requirementIdHash ${key} matches no plan requirement`);
  });
}

/** Raw 32-byte digests produced by the v2 derivation (composition schema version 2). */
export interface CompositionV2Result {
  planDigest: Uint8Array;
  depClosureDigest: Uint8Array;
  evalSemanticsDigest: Uint8Array;
  compositionRoot: Uint8Array;
}

/**
 * Derive the v2 (schema version 2) `compositionRoot` — a four-leaf tree
 * (closure / plan / evalSemantics / policy). Reuses the v1 derivation for full
 * plan + closure validation and its digests, then commits the evaluation
 * semantics (id-set resolved; row-CONTENT authority NOT yet enforced — sol #772,
 * spec §5 status), the authorityPolicy projection, and the accepted-policy digest.
 * Pure + offline + deterministic; rejects rather than hashing on any violation.
 * (The evidenceSubjectBindings static check is increment 3, pending #1007.)
 */
export function deriveCompositionV2(
  plan: PlanV1,
  m1: M1ResolvedDependencyGraph,
  evalSemantics: ResolvedEvaluationSemantics,
  policy: AcceptedPolicyInput,
  options: DeriveOptions = {},
): CompositionV2Result {
  // Reuse v1: validates the whole plan + closure and yields planDigest/depClosureDigest.
  const v1 = deriveComposition(plan, m1, options);

  assertObject(evalSemantics, "evalSemantics");
  assertExactKeys(evalSemantics, ["vocabManifestHash", "evidenceTypes", "metrics"], "evalSemantics");
  assertObject(policy, "policy");
  assertExactKeys(policy, ["committedAcceptedPolicyDigest", "preimage"], "policy");

  const vocabManifestHash = toDigest32(evalSemantics.vocabManifestHash, "evalSemantics.vocabManifestHash");
  // sol f2: EMBED the authoritative 51-row authorityPolicy projection and RECOMPUTE projectionDigest here
  // (evidence #1014: it is a fixed-global table composition can recompute) — assert it equals the pinned
  // authoritative value rather than trusting a caller-supplied digest. There is no caller projectionDigest input.
  const projectionRows = buildProjectionRows();
  const projectionDigest = computeProjectionDigest(projectionRows);
  if (pacBytesToHex(projectionDigest) !== PINNED_PROJECTION_DIGEST) {
    reject("PROJECTION_DIGEST_MISMATCH", `embedded projectionDigest ${pacBytesToHex(projectionDigest)} != pinned ${PINNED_PROJECTION_DIGEST}`);
  }
  // sol f1: AUTHENTICATE the policy — recompute acceptedPolicyDigest from the preimage and assert it equals
  // the committed digest. This proves the evidenceSubjectBindings + assuranceTier read from the preimage are
  // exactly the ones inside the committed digest; no caller-supplied sidecar is trusted.
  const committedAcceptedPolicyDigest = toDigest32(policy.committedAcceptedPolicyDigest, "policy.committedAcceptedPolicyDigest");
  const acceptedPolicyDigest = computeAcceptedPolicyDigest(policy.preimage);
  if (compareBytes(acceptedPolicyDigest, committedAcceptedPolicyDigest) !== 0) {
    reject("POLICY_DIGEST_MISMATCH", `recomputed acceptedPolicyDigest ${pacBytesToHex(acceptedPolicyDigest)} != committed ${pacBytesToHex(committedAcceptedPolicyDigest)}`);
  }

  // increment-3 (evidence #853 = A): the authenticated evidenceSubjectBindings static check — the bindings +
  // tier are now proven committed (recompute above), so checking them against the embedded projection is sound.
  checkEvidenceSubjectBindings(plan, policy.preimage, projectionRows);

  // Collect the EXACT evidence-type + metric ids the plan references (§5 / F8).
  const refEvTypes = new Set<string>();
  const refMetrics = new Set<string>();
  plan.settlementUnits.forEach((u) => {
    u.acceptancePolicy.evidenceRequirements.forEach((r) => refEvTypes.add(r.evidenceTypeId));
    u.acceptancePolicy.criteria.forEach((c) => refMetrics.add(c.metricId));
  });

  const evRows = resolveExactRows(evalSemantics.evidenceTypes, (r) => r.evidenceTypeId, refEvTypes, "evalSemantics.evidenceTypes");
  const metricRows = resolveExactRows(evalSemantics.metrics, (r) => r.metricId, refMetrics, "evalSemantics.metrics");

  const evEntries = evRows.map((r, i) => encodeEvTypeEntry(r, `evalSemantics.evidenceTypes[${i}]`));
  const metricEntries = metricRows.map((r, i) => encodeMetricEntry(r, `evalSemantics.metrics[${i}]`));

  // evalSemanticsDigest (§3): EVAL Merkle-list over evidence-type ++ metric entries.
  const evalTree = merkleListRoot([...evEntries, ...metricEntries], DOM_EVAL_LEAF, DOM_EVAL_NODE, DOM_EVAL_EMPTY);
  const evalSemanticsDigest = H(
    concat(
      DOM_EVAL_ROOT,
      u16(1), // eval-semantics sub-schema version
      vocabManifestHash,
      projectionDigest, // evidence #982 Model A input; collapses into vocabManifestHash post-fold
      acceptedPolicyDigest, // self-containment fold (oracle #710)
      u32(evRows.length),
      u32(metricRows.length),
      evalTree,
    ),
  );

  // compositionRoot v2 (§1): four typed leaves, explicit balanced tree (F5).
  const closureLeaf = H(concat(DOM_COMP_LEAF, u8(0x01), u32(0), v1.depClosureDigest));
  const planLeaf = H(concat(DOM_COMP_LEAF, u8(0x02), u32(1), v1.planDigest));
  const evalSemanticsLeaf = H(concat(DOM_COMP_LEAF, u8(0x03), u32(2), evalSemanticsDigest));
  const policyLeaf = H(concat(DOM_COMP_LEAF, u8(0x04), u32(3), acceptedPolicyDigest));
  const p0 = H(concat(DOM_COMP_NODE, closureLeaf, planLeaf));
  const p1 = H(concat(DOM_COMP_NODE, evalSemanticsLeaf, policyLeaf));
  const merkleRoot = H(concat(DOM_COMP_NODE, p0, p1));
  const compositionRoot = H(concat(DOM_COMP_ROOT, u16(2), merkleRoot));

  return { planDigest: v1.planDigest, depClosureDigest: v1.depClosureDigest, evalSemanticsDigest, compositionRoot };
}
