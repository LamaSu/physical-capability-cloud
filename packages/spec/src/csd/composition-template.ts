/**
 * Composition template v1 — the republishable shape of an accepted plan (N41).
 *
 * A template pins node types, CSD urls and contract digests, assurance tiers,
 * evidence, execution key names, optional kit digests and directed edges. It
 * carries no operator, price, payee, reservation or execution input values.
 * Publishing an improvement creates another immutable version; it never edits
 * an earlier accepted deal or a pinned execution.
 *
 * Identity: canonicalize({ domain: "PCC:composition-template:v1", template })
 * over the validated normal form, then SHA-256 of those UTF-8 bytes, expressed
 * as "sha256:" plus 64 lowercase hex characters. Array order is immaterial.
 * A successor has the same slug, exactly the next version, and supersedes the
 * prior template's digest. A fork under another slug starts at v1 with null.
 *
 * Extraction verifies the sealed deal digest, each canonical-plan hash, node
 * identity, tier and program agreement, and the supplied edges against the
 * sealed contract root. These checks do not prove that the deal was really
 * accepted: the caller must read it from the sealed-deal store. They also do
 * not prove that a resolved CSD revision is the one the deal ran: a v1
 * matchedCapabilityDigest commits no CSD. Its identity is pinned as resolved
 * at extraction.
 *
 * Composite names have one definition here: type "pcc.composite/<slug>" and
 * url "pcc://capabilities/composite-<slug>/v<version>". Nested composites are
 * refused. Storage, routes, the composite capability row and buying are later
 * steps; this module is synchronous and pure.
 *
 * Validation does not bind a node's csd {url, contractDigest} to the CSD
 * registry or its capabilityType. The contract root commits only each node's
 * nodeId, capabilityType and evidence, plus the edges and program. The later
 * store's publish checks both bindings with the server's resolver and refuses
 * a template that fails. Slug ownership and version uniqueness belong there.
 */

import { sha256 } from "@noble/hashes/sha256";
import type { SHA256 } from "../types/common.js";
import { CSD_CAPABILITY_URL_PATTERN } from "../types/capability-kit.js";
import { canonicalize } from "../util/canonical.js";
import { compareCodeUnits } from "../util/code-unit-order.js";
import { deriveCapabilityContractRoot, ID_PATTERN, type EvidenceRequirement } from "./composition-commitment.js";
import {
  acceptedDealDigest, tierFromKey, canonicalTopologicalOrder,
  MAX_PLAN_NODES, MAX_PLAN_EDGES, MAX_EVIDENCE_REQUIREMENTS_PER_NODE,
  type CompiledAcceptedPlan, type AcceptedPlanEdge,
} from "./accepted-plan-compiler.js";
import { planHashOf, type CanonicalPlan } from "./canonical-plan.js";
import { PLAN_JSON_LIMITS } from "./plan-json.js";

export const COMPOSITION_TEMPLATE_SCHEMA = "pcc.composition-template/v1" as const;
export const COMPOSITION_TEMPLATE_DOMAIN = "PCC:composition-template:v1" as const;
export const COMPOSITION_TEMPLATE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The v2 url check allows a 64-character class: composite- (10) plus at most 54 slug characters.
export const COMPOSITION_TEMPLATE_SLUG_MAX_LENGTH = 54;
export const MAX_COMPOSITION_TEMPLATE_VERSION = 1_000_000;
export const COMPOSITE_CAPABILITY_TYPE_PREFIX = "pcc.composite/" as const;
export const COMPOSITE_CSD_CLASS_PREFIX = "composite-" as const;

export type CompositionTemplateDigest = SHA256;
export interface CompositionTemplateEvidenceV1 { evidenceTypeId: string; tier: number }
export interface CompositionTemplateEdgeV1 { from: string; to: string }
export interface CompositionTemplateNodeV1 {
  nodeId: string;
  capabilityType: string;
  csd: { url: string; contractDigest: SHA256 };
  tier: number;
  evidence: CompositionTemplateEvidenceV1[];
  inputKeys: string[];
  constraintKeys: string[];
  kitDigest?: SHA256;
}
export interface CompositionTemplateV1 {
  schema: typeof COMPOSITION_TEMPLATE_SCHEMA;
  slug: string;
  version: number;
  supersedes: CompositionTemplateDigest | null;
  contractRoot: `0x${string}`;
  verificationProgramHash: `0x${string}` | null;
  nodes: CompositionTemplateNodeV1[];
  edges: CompositionTemplateEdgeV1[];
}

export type CompositionTemplateRefusal =
  | { code: "unreadable" }
  | { code: "invalid-field" | "unknown-key"; path: string }
  | { code: "supersedes-required" | "supersedes-on-first-version" }
  | { code: "empty-template" | "too-many-nodes" | "too-many-edges" }
  | { code: "invalid-node-field" | "duplicate-key"; nodeId: string; field: string }
  | { code: "duplicate-node" | "duplicate-evidence" | "nested-composite"; nodeId: string }
  | { code: "edge-unknown-node" | "duplicate-edge"; from: string; to: string }
  | { code: "self-loop"; nodeId: string }
  | { code: "cycle" | "program-presence" | "contract-root-mismatch" }
  | { code: "deal-digest-mismatch" }
  | { code: "plan-hash-mismatch" | "node-id-mismatch" | "tier-mismatch" | "program-mismatch"; nodeId: string }
  | { code: "unknown-csd" | "invalid-csd-identity"; nodeId: string; csd: string }
  | { code: "kit-pin-unknown-node"; nodeId: string }
  | { code: "mixed-programs" }
  | { code: "supersedes-slug-mismatch" | "supersedes-version-gap" | "supersedes-digest-mismatch" }
  | { code: "invalid-template"; template: "prior" | "next" };

export type CompositionTemplateResult =
  | { ok: true; template: CompositionTemplateV1 }
  | { ok: false; refusals: CompositionTemplateRefusal[] };

export interface ExtractCompositionTemplateInput {
  deal: CompiledAcceptedPlan;
  edges: readonly AcceptedPlanEdge[];
  csdIdentities: Readonly<Record<string, { url: string; contractDigest: string }>>;
  slug: string;
  version: number;
  supersedes: string | null;
  kitDigests?: Readonly<Record<string, string>>;
}

export interface CompositionTemplateDiff {
  identical: boolean;
  fields: string[];
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: { nodeId: string; fields: string[] }[];
  edgesAdded: CompositionTemplateEdgeV1[];
  edgesRemoved: CompositionTemplateEdgeV1[];
}

export type SupersessionResult = { ok: true } | { ok: false; refusals: CompositionTemplateRefusal[] };

export class CompositionTemplateError extends Error {
  readonly refusals: CompositionTemplateRefusal[];
  constructor(refusals: CompositionTemplateRefusal[]) {
    super("Invalid composition template");
    this.name = "CompositionTemplateError";
    this.refusals = refusals;
  }
}

const SHA_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ROOT_PATTERN = /^0x[0-9a-f]{64}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const own = (o: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(o, key);
const matches = (v: unknown, pattern: RegExp): v is string => typeof v === "string" && pattern.test(v);
const validSlug = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 1 && s.length <= COMPOSITION_TEMPLATE_SLUG_MAX_LENGTH && COMPOSITION_TEMPLATE_SLUG_PATTERN.test(s);
const validVersion = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_COMPOSITION_TEMPLATE_VERSION;
const validTier = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3;
const compareEdges = (a: CompositionTemplateEdgeV1, b: CompositionTemplateEdgeV1): number =>
  compareCodeUnits(a.from, b.from) || compareCodeUnits(a.to, b.to);

export function compositeCapabilityType(slug: string): string {
  if (!validSlug(slug)) throw new RangeError("Invalid composition template slug");
  return COMPOSITE_CAPABILITY_TYPE_PREFIX + slug;
}

export function compositeCapabilityUrl(slug: string, version: number): string {
  if (!validSlug(slug) || !validVersion(version)) throw new RangeError("Invalid composition template slug or version");
  return `pcc://capabilities/${COMPOSITE_CSD_CLASS_PREFIX}${slug}/v${version}`;
}

export function isCompositeCapabilityType(type: string): boolean {
  return typeof type === "string" && type.toLowerCase().startsWith(COMPOSITE_CAPABILITY_TYPE_PREFIX);
}

export function isCompositeCsdUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const match = /^pcc:\/\/capabilities\/([^/]+)(?:\/|$)/i.exec(url);
  return match !== null && match[1]!.toLowerCase().startsWith(COMPOSITE_CSD_CLASS_PREFIX);
}

function refused(refusals: CompositionTemplateRefusal[]): { ok: false; refusals: CompositionTemplateRefusal[] } {
  return { ok: false, refusals: refusals.sort((a, b) => compareCodeUnits(canonicalize(a), canonicalize(b))) };
}

/** Read each own field once; validation and normalization inspect only this owned record. */
function readRecord(value: unknown, path: string, allowed: readonly string[], refusals: CompositionTemplateRefusal[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refusals.push({ code: "invalid-field", path });
    return null;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    refusals.push({ code: "invalid-field", path });
    return null;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      refusals.push({ code: "unknown-key", path: `${path}.${String(key)}` });
    } else {
      out[key] = Reflect.get(value, key);
    }
  }
  return out;
}

/** Bounded array copy, including strict rejection of named, symbol and inherited elements. */
function readArray(value: unknown, path: string, max: number, refusals: CompositionTemplateRefusal[], overflow: CompositionTemplateRefusal): unknown[] | null {
  if (!Array.isArray(value)) {
    refusals.push({ code: "invalid-field", path });
    return null;
  }
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    refusals.push({ code: "invalid-field", path });
    return null;
  }
  if (length > max) {
    refusals.push(overflow);
    return null;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      refusals.push({ code: "unknown-key", path: `${path}.${String(key)}` });
    }
  }
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const present = own(value, i);
    if (!present) refusals.push({ code: "invalid-field", path: `${path}[]` });
    out.push(present ? value[i] : undefined);
  }
  return out;
}

function readKeys(value: unknown, nodeId: string, field: "inputKeys" | "constraintKeys", path: string, refusals: CompositionTemplateRefusal[]): string[] {
  const invalid: CompositionTemplateRefusal = { code: "invalid-node-field", nodeId, field };
  const list = readArray(value, path, PLAN_JSON_LIMITS.maxKeysPerObject, refusals, invalid);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of list ?? []) {
    if (typeof key !== "string" || key.length > PLAN_JSON_LIMITS.maxKeyLength || key === "__proto__" || LONE_SURROGATE.test(key)) {
      refusals.push(invalid);
      continue;
    }
    if (seen.has(key)) refusals.push({ code: "duplicate-key", nodeId, field });
    seen.add(key);
    keys.push(key);
  }
  return keys.sort(compareCodeUnits);
}

/** Only well-formed, uniquely identified edges reach the shared cycle checker. */
function readEdges(value: unknown, nodeIds: readonly string[], refusals: CompositionTemplateRefusal[]): CompositionTemplateEdgeV1[] {
  const list = readArray(value, "$.edges", MAX_PLAN_EDGES, refusals, { code: "too-many-edges" });
  const edges: CompositionTemplateEdgeV1[] = [];
  const ids = new Set(nodeIds);
  const seen = new Set<string>();
  let graphValid = ids.size === nodeIds.length;
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const e = readRecord(list![i], "$.edges[]", ["from", "to"], refusals);
    if (!e) { graphValid = false; continue; }
    if (!matches(e.from, ID_PATTERN) || !matches(e.to, ID_PATTERN)) {
      refusals.push({ code: "invalid-field", path: "$.edges[]" });
      graphValid = false;
      continue;
    }
    const edge = { from: e.from, to: e.to };
    edges.push(edge);
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      refusals.push({ code: "edge-unknown-node", ...edge });
      graphValid = false;
    }
    if (edge.from === edge.to) {
      refusals.push({ code: "self-loop", nodeId: edge.from });
      graphValid = false;
    }
    const key = canonicalize([edge.from, edge.to]);
    if (seen.has(key)) {
      refusals.push({ code: "duplicate-edge", ...edge });
      graphValid = false;
    }
    seen.add(key);
  }
  if (graphValid && canonicalTopologicalOrder(nodeIds, edges) === null) refusals.push({ code: "cycle" });
  return edges.sort(compareEdges);
}

/** Validate all field rules before any contract-root derivation. */
function templateFields(untrusted: unknown, refusals: CompositionTemplateRefusal[]): CompositionTemplateV1 | null {
  const t = readRecord(untrusted, "$", ["schema", "slug", "version", "supersedes", "contractRoot", "verificationProgramHash", "nodes", "edges"], refusals);
  if (!t) return null;
  if (t.schema !== COMPOSITION_TEMPLATE_SCHEMA) refusals.push({ code: "invalid-field", path: "$.schema" });
  if (!validSlug(t.slug)) refusals.push({ code: "invalid-field", path: "$.slug" });
  if (!validVersion(t.version)) refusals.push({ code: "invalid-field", path: "$.version" });
  if (t.version === 1 && t.supersedes !== null) refusals.push({ code: "supersedes-on-first-version" });
  else if (typeof t.version === "number" && t.version > 1 && (t.supersedes === null || t.supersedes === undefined)) refusals.push({ code: "supersedes-required" });
  if (t.supersedes !== null && !matches(t.supersedes, SHA_PATTERN)) refusals.push({ code: "invalid-field", path: "$.supersedes" });
  if (!matches(t.contractRoot, ROOT_PATTERN)) refusals.push({ code: "invalid-field", path: "$.contractRoot" });
  if (t.verificationProgramHash !== null && !matches(t.verificationProgramHash, ROOT_PATTERN)) refusals.push({ code: "invalid-field", path: "$.verificationProgramHash" });
  const list = readArray(t.nodes, "$.nodes", MAX_PLAN_NODES, refusals, { code: "too-many-nodes" });
  if (list?.length === 0) refusals.push({ code: "empty-template" });
  const nodes: CompositionTemplateNodeV1[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const path = "$.nodes[]";
    const n = readRecord(list![i], path, ["nodeId", "capabilityType", "csd", "tier", "evidence", "inputKeys", "constraintKeys", "kitDigest"], refusals);
    if (!n) continue;
    const nodeId = typeof n.nodeId === "string" ? n.nodeId : "";
    const invalid = (field: string): void => { refusals.push({ code: "invalid-node-field", nodeId, field }); };
    if (!matches(n.nodeId, ID_PATTERN)) invalid("nodeId");
    if (ids.has(nodeId)) refusals.push({ code: "duplicate-node", nodeId });
    ids.add(nodeId);
    if (!matches(n.capabilityType, ID_PATTERN)) invalid("capabilityType");
    if (!validTier(n.tier)) invalid("tier");
    const csd = readRecord(n.csd, `${path}.csd`, ["url", "contractDigest"], refusals);
    if (!matches(csd?.url, CSD_CAPABILITY_URL_PATTERN)) invalid("csd.url");
    if (!matches(csd?.contractDigest, SHA_PATTERN)) invalid("csd.contractDigest");
    if (isCompositeCapabilityType(n.capabilityType as string) || isCompositeCsdUrl(csd?.url as string)) refusals.push({ code: "nested-composite", nodeId });
    if (own(n, "kitDigest") && !matches(n.kitDigest, SHA_PATTERN)) invalid("kitDigest");
    const evidence: CompositionTemplateEvidenceV1[] = [];
    const evidenceList = readArray(n.evidence, `${path}.evidence`, MAX_EVIDENCE_REQUIREMENTS_PER_NODE, refusals, { code: "invalid-node-field", nodeId, field: "evidence" });
    const seen = new Set<string>();
    for (let j = 0; j < (evidenceList?.length ?? 0); j++) {
      const e = readRecord(evidenceList![j], `${path}.evidence[]`, ["evidenceTypeId", "tier"], refusals);
      if (!e) continue;
      if (!matches(e.evidenceTypeId, ID_PATTERN) || !validTier(e.tier)) { invalid("evidence"); continue; }
      const key = canonicalize([e.evidenceTypeId, e.tier]);
      if (seen.has(key)) refusals.push({ code: "duplicate-evidence", nodeId });
      seen.add(key);
      evidence.push({ evidenceTypeId: e.evidenceTypeId, tier: e.tier });
    }
    nodes.push({
      nodeId,
      capabilityType: n.capabilityType as string,
      csd: { url: csd?.url as string, contractDigest: csd?.contractDigest as SHA256 },
      tier: n.tier as number,
      evidence: evidence.sort((a, b) => compareCodeUnits(a.evidenceTypeId, b.evidenceTypeId) || a.tier - b.tier),
      inputKeys: readKeys(n.inputKeys, nodeId, "inputKeys", `${path}.inputKeys`, refusals),
      constraintKeys: readKeys(n.constraintKeys, nodeId, "constraintKeys", `${path}.constraintKeys`, refusals),
      ...(own(n, "kitDigest") ? { kitDigest: n.kitDigest as SHA256 } : {}),
    });
  }
  const edges = readEdges(t.edges, nodes.map((n) => n.nodeId), refusals);
  if ((t.verificationProgramHash === null) !== nodes.every((n) => n.tier === 0)) refusals.push({ code: "program-presence" });
  return {
    schema: COMPOSITION_TEMPLATE_SCHEMA,
    slug: t.slug as string,
    version: t.version as number,
    supersedes: t.supersedes as SHA256 | null,
    contractRoot: t.contractRoot as `0x${string}`,
    verificationProgramHash: t.verificationProgramHash as `0x${string}` | null,
    nodes: nodes.sort((a, b) => compareCodeUnits(a.nodeId, b.nodeId)),
    edges,
  };
}

function contractRootOf(template: CompositionTemplateV1): `0x${string}` {
  return deriveCapabilityContractRoot({
    requestId: "composition-template",
    nodes: template.nodes.map((n) => ({
      nodeId: n.nodeId,
      capabilityType: n.capabilityType,
      matchStatus: "none" as const,
      evidenceRequirements: n.evidence.map((e, i): EvidenceRequirement => ({ requirementId: `e${i}`, ...e })),
    })),
    edges: template.edges,
    ...(template.verificationProgramHash !== null ? { verificationProgramHash: template.verificationProgramHash } : {}),
  }, { version: 3 }) as `0x${string}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateCompositionTemplate(untrusted: unknown): CompositionTemplateResult {
  try {
    const refusals: CompositionTemplateRefusal[] = [];
    const template = templateFields(untrusted, refusals);
    if (refusals.length || !template) return refused(refusals);
    if (contractRootOf(template) !== template.contractRoot) return refused([{ code: "contract-root-mismatch" }]);
    return { ok: true, template: deepFreeze(template) };
  } catch {
    return refused([{ code: "unreadable" }]);
  }
}

function requireTemplate(t: unknown): CompositionTemplateV1 {
  const result = validateCompositionTemplate(t);
  if (!result.ok) throw new CompositionTemplateError(result.refusals);
  return result.template;
}

function preimageOf(template: CompositionTemplateV1): string {
  return canonicalize({ domain: COMPOSITION_TEMPLATE_DOMAIN, template });
}

function digestOf(template: CompositionTemplateV1): CompositionTemplateDigest {
  const bytes = sha256(new TextEncoder().encode(preimageOf(template)));
  return `sha256:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function compositionTemplatePreimage(t: CompositionTemplateV1): string {
  const template = requireTemplate(t);
  try { return preimageOf(template); }
  catch { throw new CompositionTemplateError([{ code: "unreadable" }]); }
}

export function compositionTemplateDigest(t: CompositionTemplateV1): CompositionTemplateDigest {
  const template = requireTemplate(t);
  try { return digestOf(template); }
  catch { throw new CompositionTemplateError([{ code: "unreadable" }]); }
}

/** Snapshot the compiled deal, including bigint settlement data, before verifying or extracting. */
function snapshot<T>(value: T, active = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (active.has(value)) throw new TypeError("Cyclic extraction input");
  active.add(value);
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid extraction object");
  const out = array ? [] : Object.create(prototype === null ? null : Object.prototype);
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) throw new TypeError("Unreadable extraction field");
    Object.defineProperty(out, key, {
      value: snapshot(Reflect.get(value, key), active), enumerable: descriptor.enumerable, writable: true, configurable: true,
    });
  }
  if (array) out.length = (value as unknown[]).length;
  active.delete(value);
  return out as T;
}

export function extractCompositionTemplate(input: ExtractCompositionTemplateInput): CompositionTemplateResult {
  try {
    const deal = snapshot(input.deal);
    const refusals: CompositionTemplateRefusal[] = [];
    try {
      if (acceptedDealDigest(deal) !== deal.acceptedDealDigest) refusals.push({ code: "deal-digest-mismatch" });
    } catch { refusals.push({ code: "unreadable" }); }
    for (const binding of deal.nodeToUnit) {
      const { nodeId } = binding;
      const p: CanonicalPlan = binding.canonicalPlan;
      try {
        if (planHashOf(p) !== binding.planHash) refusals.push({ code: "plan-hash-mismatch", nodeId });
      } catch { refusals.push({ code: "unreadable" }); }
      if (p.planNodeId !== nodeId) refusals.push({ code: "node-id-mismatch", nodeId });
      if (binding.tier !== p.assurance.tier || binding.tier !== tierFromKey(p.assurance.tierKey)) refusals.push({ code: "tier-mismatch", nodeId });
      if (binding.committedProgramHash?.toLowerCase() !== p.assurance.committedProgramHash?.toLowerCase()) refusals.push({ code: "program-mismatch", nodeId });
    }
    if (refusals.length) return refused(refusals);

    const { edges, csdIdentities, slug, version, supersedes, kitDigests } = snapshot({
      edges: input.edges, csdIdentities: input.csdIdentities,
      slug: input.slug, version: input.version, supersedes: input.supersedes,
      kitDigests: input.kitDigests,
    });
    const programs = new Set<string>();
    const ids = new Set(deal.nodeToUnit.map((b) => b.nodeId));
    for (const key of Reflect.ownKeys(kitDigests ?? {})) {
      if (typeof key !== "string" || !ids.has(key)) refusals.push({ code: "kit-pin-unknown-node", nodeId: String(key) });
    }
    const nodes = deal.nodeToUnit.map((b) => {
      const p = b.canonicalPlan;
      const reference = p.capability.csd;
      // A placeholder permits collecting the other field refusals; it can never be returned.
      let csd = { url: "pcc://capabilities/unresolved/v1", contractDigest: `sha256:${"0".repeat(64)}` };
      if (!own(csdIdentities, reference)) refusals.push({ code: "unknown-csd", nodeId: b.nodeId, csd: reference });
      else {
        const entry = csdIdentities[reference];
        if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
            Reflect.ownKeys(entry).some((k) => k !== "url" && k !== "contractDigest") ||
            !matches(entry.url, CSD_CAPABILITY_URL_PATTERN) || !matches(entry.contractDigest, SHA_PATTERN)) {
          refusals.push({ code: "invalid-csd-identity", nodeId: b.nodeId, csd: reference });
          if (entry && typeof entry === "object" && isCompositeCsdUrl(entry.url)) refusals.push({ code: "nested-composite", nodeId: b.nodeId });
        } else csd = { url: entry.url, contractDigest: entry.contractDigest };
      }
      if (b.committedProgramHash !== null) programs.add(b.committedProgramHash.toLowerCase());
      return {
        nodeId: b.nodeId,
        capabilityType: p.capability.type,
        csd,
        tier: b.tier,
        evidence: p.assurance.evidence.map((e) => ({ evidenceTypeId: e.evidenceTypeId, tier: e.tier })),
        inputKeys: Object.keys(p.inputs),
        constraintKeys: Object.keys(p.constraints),
        ...(kitDigests && own(kitDigests, b.nodeId) ? { kitDigest: kitDigests[b.nodeId] } : {}),
      };
    });
    if (programs.size > 1) refusals.push({ code: "mixed-programs" });
    const candidate = templateFields({
      schema: COMPOSITION_TEMPLATE_SCHEMA, slug, version, supersedes,
      contractRoot: deal.capabilityContractRoot,
      verificationProgramHash: programs.size ? [...programs].sort(compareCodeUnits)[0] : null,
      nodes, edges,
    }, refusals);
    if (refusals.length || !candidate) return refused(refusals);
    candidate.contractRoot = contractRootOf(candidate);
    if (candidate.contractRoot !== deal.capabilityContractRoot) return refused([{ code: "contract-root-mismatch" }]);
    return validateCompositionTemplate(candidate);
  } catch {
    return refused([{ code: "unreadable" }]);
  }
}

export function diffCompositionTemplates(a: CompositionTemplateV1, b: CompositionTemplateV1): CompositionTemplateDiff {
  const prior = requireTemplate(a);
  const next = requireTemplate(b);
  const fields = (["slug", "version", "supersedes", "contractRoot", "verificationProgramHash"] as const)
    .filter((key) => prior[key] !== next[key]).sort(compareCodeUnits);
  const priorNodes = new Map(prior.nodes.map((n) => [n.nodeId, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.nodeId, n]));
  const nodesChanged: CompositionTemplateDiff["nodesChanged"] = [];
  for (const node of next.nodes) {
    const old = priorNodes.get(node.nodeId);
    if (!old) continue;
    const changed = (["capabilityType", "csd", "tier", "evidence", "inputKeys", "constraintKeys", "kitDigest"] as const)
      .filter((key) => canonicalize(old[key] ?? null) !== canonicalize(node[key] ?? null)).sort(compareCodeUnits);
    if (changed.length) nodesChanged.push({ nodeId: node.nodeId, fields: changed });
  }
  const edgeKey = (edge: CompositionTemplateEdgeV1): string => canonicalize(edge);
  const priorEdges = new Set(prior.edges.map(edgeKey));
  const nextEdges = new Set(next.edges.map(edgeKey));
  return {
    identical: digestOf(prior) === digestOf(next),
    fields,
    nodesAdded: next.nodes.filter((n) => !priorNodes.has(n.nodeId)).map((n) => n.nodeId),
    nodesRemoved: prior.nodes.filter((n) => !nextNodes.has(n.nodeId)).map((n) => n.nodeId),
    nodesChanged,
    edgesAdded: next.edges.filter((e) => !priorEdges.has(edgeKey(e))),
    edgesRemoved: prior.edges.filter((e) => !nextEdges.has(edgeKey(e))),
  };
}

export function checkSupersession(prior: CompositionTemplateV1, next: CompositionTemplateV1): SupersessionResult {
  try {
    const a = validateCompositionTemplate(prior);
    const b = validateCompositionTemplate(next);
    const refusals: CompositionTemplateRefusal[] = [];
    if (!a.ok) refusals.push({ code: "invalid-template", template: "prior" });
    if (!b.ok) refusals.push({ code: "invalid-template", template: "next" });
    if (!a.ok || !b.ok) return refused(refusals);
    if (a.template.slug !== b.template.slug) refusals.push({ code: "supersedes-slug-mismatch" });
    if (b.template.version !== a.template.version + 1) refusals.push({ code: "supersedes-version-gap" });
    if (b.template.supersedes !== compositionTemplateDigest(a.template)) refusals.push({ code: "supersedes-digest-mismatch" });
    return refusals.length ? refused(refusals) : { ok: true };
  } catch {
    return refused([{ code: "unreadable" }]);
  }
}
