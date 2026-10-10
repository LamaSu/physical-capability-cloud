/**
 * Closed parameter schemas for every evidence primitive (N128): THE parameter contract.
 *
 * A CSD evidence ref and an emitter declaration carry per-primitive `params`, and setup returns emitter
 * manifests PUBLICLY. Until N128, `params` was an open record (`csd/schema.ts`), so a value nobody
 * recognizes, a secret under a harmless name included, went out verbatim. The registry described the params
 * but never enforced them, and most of its objects were open.
 *
 * THE PROPERTY. A public param is one of a closed set of shapes, and nothing else: an enum member, a boolean,
 * a bounded number, an identifier, a fixed-format reference (bytes32, a `sha256:` digest, an address), or an
 * array or closed object of those. Every object is closed (an unknown key is refused) and every primitive
 * id must be in the registry. A free-form string has no place in it. Identifiers name something the
 * consumer can resolve (a job, a capability type, a server-side matcher). A confidential value never goes
 * here: it belongs in a separate, non-public representation (none exists today).
 *
 * ONE SOURCE (N128 r1, finding 4). PRIMITIVE_PARAMS is the only statement of a primitive's params. The
 * registry's `paramsSchema` (primitives.ts) is RENDERED from it by `renderParamsSchema`, so the registry and
 * the validator can't disagree on a field, a requiredness, a type or a bound, and VOCAB_MANIFEST_HASH commits
 * the closed contract.
 *
 * CLOSED NAMES (finding 3). `bind` and `via` name things, so each must be a member of a closed namespace,
 * not merely identifier-shaped: `bind` an evidence field (EVIDENCE_BIND_FIELDS) or an event type, `via` an
 * emitter channel (EMITTER_CHANNELS) or an event type. A new name is a reviewed change to these lists.
 *
 * No regular expressions: every format is checked by a character loop, and nothing tries to recognize a
 * secret by its pattern. A secret can't hide where only closed shapes fit.
 *
 * Own data only (finding 5). The validator reads through property descriptors, and the public schemas parse
 * a descriptor-only copy of `params` (`ownDataSnapshot`), so an accessor inside params is never called, an
 * inherited key is never read, and a non-plain object is refused.
 */

import { KNOWN_UNITS } from "../csd/composition.js";
import { EVIDENCE_EVENT_TYPES } from "../types/evidence.js";
import { isProxy } from "../util/plain-data.js";

/** One param's closed shape. */
export type ParamKind =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "boolean" }
  | { readonly kind: "integer"; readonly min: number; readonly max: number }
  | { readonly kind: "number"; readonly min: number; readonly max: number }
  | { readonly kind: "identifier" }
  | { readonly kind: "bytes32" }
  | { readonly kind: "digest" }
  | { readonly kind: "address" }
  | { readonly kind: "array"; readonly items: ParamKind; readonly maxItems: number }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, ParamField>> }
  | { readonly kind: "oneOf"; readonly options: readonly ParamKind[] };

/** A field of a closed object: its shape, whether it must be present, and the value a verifier assumes without it. */
export interface ParamField {
  readonly type: ParamKind;
  readonly required?: boolean;
  /** The enum member a verifier assumes when the field is absent, as the registry documents it. */
  readonly default?: string;
}

/** The longest identifier: enough for a job id, a capability type or a field name, too short for prose. */
export const MAX_IDENTIFIER_LENGTH = 128;

const id: ParamKind = { kind: "identifier" };
const bytes32: ParamKind = { kind: "bytes32" };
const digest: ParamKind = { kind: "digest" };
const seconds = (max: number): ParamKind => ({ kind: "integer", min: 1, max });
const enumOf = (...values: string[]): ParamKind => ({ kind: "enum", values });
const optional = (type: ParamKind, defaultValue?: string): ParamField =>
  defaultValue === undefined ? { type } : { type, default: defaultValue };
const required = (type: ParamKind): ParamField => ({ type, required: true });

/**
 * The closed params of every registry primitive, keyed by primitive id. A primitive with no params has
 * an empty field set: any key is refused. primitives.ts renders each registry `paramsSchema` from here.
 */
export const PRIMITIVE_PARAMS: Readonly<Record<string, Readonly<Record<string, ParamField>>>> = {
  "approval.payer": {
    approverRole: optional(enumOf("payer")),
    claimIds: optional({ kind: "array", items: id, maxItems: 64 }),
  },
  "approval.expert": {
    approverRole: optional(enumOf("expert")),
    claimIds: optional({ kind: "array", items: id, maxItems: 64 }),
    rubricRef: optional(digest),
  },
  "decl.self_attested": {
    schemaRef: optional(digest),
  },
  "confirm.execution_mode": {
    expected: optional(enumOf("real")),
  },
  "artifact.hash": {
    mode: optional(enumOf("plain", "redacted-commit"), "plain"),
  },
  "fresh.challenge_bound": {
    form: optional(enumOf("execution", "capture")),
    maxAgeSeconds: optional(seconds(86_400)),
  },
  "pay.escrow_receipt": {
    childJobId: optional(id),
    childEscrow: optional({ kind: "address" }),
  },
  "ident.registered_key": {
    registryId: optional(id),
    // A registry snapshot hash, as types/registry.ts computes it (computeSetSnapshotHash): 0x plus 64 hex.
    snapshotHash: optional(bytes32),
  },
  "receipt.kernel_signed": {
    capability: optional(id),
  },
  "telemetry.geofence_event": {
    lat: required({ kind: "number", min: -90, max: 90 }),
    lng: required({ kind: "number", min: -180, max: 180 }),
    radiusM: required({ kind: "number", min: 0, max: 1_000_000 }),
  },
  "confirm.recipient_nonce": {
    validityWindowSeconds: optional(seconds(604_800)),
  },
  "confirm.recipient_signature": {},
  "measure.io_test_pair": {
    mode: required(enumOf("deterministic", "seeded-stochastic", "statistical-tolerance")),
  },
  "capture.photo_nonced": {
    // Required: minClass decides the tier a capture can reach (CC0-1 tier 1, CC2 tier 2).
    media: required(enumOf("photo", "video")),
    minClass: required(enumOf("CC0", "CC1", "CC2", "CC3", "CC4", "CC5")),
    nonceType: optional(enumOf("qr", "color", "gesture")),
  },
  "telemetry.gps_trail": {
    integrityGrade: required(enumOf("raw", "checked", "fused", "certified")),
    maxGapSeconds: optional(seconds(86_400)),
    plausibility: optional({
      kind: "object",
      fields: { maxSpeedKph: optional({ kind: "number", min: 0, max: 2_000 }) },
    }),
  },
  "confirm.target_system": {
    channel: required(enumOf("api", "webhook", "zktls")),
    matcher: optional(id),
  },
  "machine.execution_log": {
    logKind: required(enumOf("job_log", "command_trace", "alarm_log", "program_transcript")),
    disclosure: optional(enumOf("full", "redacted-commit"), "redacted-commit"),
    minCadenceMs: optional({ kind: "integer", min: 1, max: 86_400_000 }),
    alarmPolicy: optional(enumOf("none-critical", "declared")),
    // A supporting log (not the success signal), as the print-and-mail CSD marks printer_job_verified (8d7fc56e).
    role: optional(enumOf("supporting")),
  },
  "telemetry.envelope_conformance": {
    envelope: optional({
      kind: "oneOf",
      options: [
        enumOf("builtin-defaults"),
        {
          kind: "array",
          maxItems: 64,
          items: {
            kind: "object",
            fields: {
              metric: required(id),
              // A unit from the composition unit table, as the safety-envelope compiler writes it.
              unit: optional({ kind: "enum", values: KNOWN_UNITS }),
              min: optional({ kind: "number", min: -1e12, max: 1e12 }),
              max: optional({ kind: "number", min: -1e12, max: 1e12 }),
              ratioBands: optional({ kind: "array", maxItems: 16, items: { kind: "number", min: -1e12, max: 1e12 } }),
            },
          },
        },
      ],
    }),
    source: optional(enumOf("summary", "stream"), "summary"),
    severityFloor: optional(enumOf("high", "critical"), "high"),
    materialParam: optional(id),
    includePipelineAnomalies: optional({ kind: "boolean" }),
  },
  "telemetry.coverage_gate": {
    requiredGroups: optional({ kind: "array", maxItems: 16, items: { kind: "array", maxItems: 16, items: id } }),
    maxGapSeconds: optional(seconds(86_400)),
    evidenceGradeChannels: optional({ kind: "boolean" }),
  },
  "process.batch_record": {
    // References to the committed recipe, phase graph and sample manifest documents (bytes32, as in
    // accepted-policy.ts). The phase graph was an open inline object before N128.
    recipeRef: required(bytes32),
    phaseGraph: optional(bytes32),
    sampleManifestRef: optional(bytes32),
  },
};

// ── Closed names: what `bind` and `via` may say (N128 r1, finding 3) ────────────────────────────────

/**
 * The evidence fields a primitive ref may name in `bind`, besides an event type: the evidence artifacts (CIDs
 * and committed hashes) that the built-in CSDs declare in their tiers' `required` lists, and the fields the
 * default manifests bind. A test keeps every such CSD field here. A new field is a reviewed change.
 */
export const EVIDENCE_BIND_FIELDS = [
  // Declared by the built-in CSDs (csds/*.csd.json).
  "allergenAttestationCid", // hot-food-prep
  "cmmReportCid", // cnc-3axis
  "commitment.labelHash", // document-print-and-mail's committed shipping label
  "custodyChainCid", // courier-route
  "dropoffPhotoCid", // courier-route
  "gpsTrackCid", // courier-route
  "inspectionPhotosCid", // cnc-3axis
  "machineLogCid", // laser-cut
  "outputPhotoCid", // fdm, hot-food-prep, laser-cut, make-pizza, sla
  "outputScanCid", // 2d-print
  "recipientSignatureCid", // courier-route, document-print-and-mail
  // Bound by the default manifests (adapter-manifests.ts).
  "capturePhotoCid", // the camera role's nonce-bound capture
  "outputArtifactCid", // octoprint's printed artifact
  "outputDocumentCid", // ipp's printed document
  "sensorLogCid", // the sensor role's hashed signal log
] as const;

/**
 * The channels an emitter declaration may name in `via`, besides an event type: how the adapter or device
 * produces the primitive. A new adapter adds its channel here, as a reviewed change.
 */
export const EMITTER_CHANNELS = [
  "toKernelOutput", // the kernel's signed output: the digital receipt core
  "gcode", // octoprint's G-code job
  "telemetry", // octoprint's telemetry stream
  "print", // ipp's print job
  "opcua-node", // an OPC-UA node read
  "sila-feature", // a SiLA 2 feature call
  "http-response", // generic-http's upstream response
  "captureSnapshot", // the camera role's capture command
  "stopRecording", // the sensor role's recording summary
] as const;

const EVENT_TYPES: ReadonlySet<string> = new Set<string>(EVIDENCE_EVENT_TYPES);
const BIND_FIELDS: ReadonlySet<string> = new Set<string>(EVIDENCE_BIND_FIELDS);
const CHANNELS: ReadonlySet<string> = new Set<string>(EMITTER_CHANNELS);

/** A `bind`: an evidence field (EVIDENCE_BIND_FIELDS) or an event type (EVIDENCE_EVENT_TYPES). */
export function isEvidenceBind(value: unknown): value is string {
  return typeof value === "string" && (BIND_FIELDS.has(value) || EVENT_TYPES.has(value));
}

/** A `via`: an emitter channel (EMITTER_CHANNELS) or an event type (EVIDENCE_EVENT_TYPES). */
export function isEmitterVia(value: unknown): value is string {
  return typeof value === "string" && (CHANNELS.has(value) || EVENT_TYPES.has(value));
}

// ── Character-level format checks (no regular expressions) ──────────────────────────────────────────

const isLowerHex = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 97 && c <= 102);

/** `0x` followed by exactly `digits` lowercase hex characters. */
function isPrefixedLowerHex(value: string, digits: number): boolean {
  if (value.length !== 2 + digits || value.charCodeAt(0) !== 48 || value.charCodeAt(1) !== 120) return false;
  for (let i = 2; i < value.length; i++) if (!isLowerHex(value.charCodeAt(i))) return false;
  return true;
}

/** An identifier: 1 to MAX_IDENTIFIER_LENGTH characters from [A-Za-z0-9_.:-], starting with a letter or digit. */
export function isParamIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (alnum) continue;
    if (i > 0 && (c === 95 || c === 46 || c === 58 || c === 45)) continue;
    return false;
  }
  return true;
}

/** `sha256:` followed by exactly 64 lowercase hex characters. */
export function isSha256Digest(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 71 || !value.startsWith("sha256:")) return false;
  for (let i = 7; i < value.length; i++) if (!isLowerHex(value.charCodeAt(i))) return false;
  return true;
}

// ── Own-data reads ──────────────────────────────────────────────────────────────────────────────────

/** A plain object (Object.prototype or a null prototype) whose own keys are all strings. */
function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.getOwnPropertySymbols(value).length === 0;
}

/** The own data value of `key`, or a failure naming why: an accessor is never called. */
function ownData(value: object, key: string): { ok: true; value: unknown } | { ok: false } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, "value")) return { ok: false };
  return { ok: true, value: descriptor.value };
}

/** A genuine array's own data elements, or null (an accessor, a hole, or an extra own key refuses it). */
function ownArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== length + 1 || Object.getOwnPropertySymbols(value).length !== 0) return null;
  const out: unknown[] = [];
  for (let i = 0; i < length; i++) {
    const read = ownData(value, String(i));
    if (!read.ok) return null;
    out.push(read.value);
  }
  return out;
}

/** The deepest a snapshot copies. The closed shapes nest four levels below `params`; a cycle reaches this. */
export const MAX_SNAPSHOT_DEPTH = 16;

export type OwnDataSnapshot = { ok: true; value: unknown } | { ok: false; reason: string };

/**
 * A copy of `value` made through property descriptors only, for a schema to parse in its place (N128 r1,
 * finding 5). JSON data copies exactly, every own string key included. Refused, and no accessor is called:
 * an accessor property, a symbol key, a key named `__proto__`, an object whose prototype is neither
 * Object.prototype nor null, an array that isn't a dense Array.prototype array with only its indices, a
 * function, a bigint or a symbol, and nesting deeper than MAX_SNAPSHOT_DEPTH (so a cycle too).
 *
 * A proxy is refused without running a trap where the runtime offers a trap-free check (Node's
 * util.types.isProxy, through util/plain-data.ts). A browser offers none, so there a proxy's traps can run
 * while this reads descriptors; the browser only renders, and persists no manifest.
 */
export function ownDataSnapshot(value: unknown, root = "params"): OwnDataSnapshot {
  const walk = (v: unknown, path: string, depth: number): OwnDataSnapshot => {
    if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return { ok: true, value: v };
    }
    if (typeof v !== "object") return { ok: false, reason: `${path}: a ${typeof v} is not data` };
    if (depth >= MAX_SNAPSHOT_DEPTH) return { ok: false, reason: `${path}: nested deeper than ${MAX_SNAPSHOT_DEPTH} levels` };
    if (isProxy !== null && isProxy(v)) return { ok: false, reason: `${path}: a proxy` };
    if (Object.getOwnPropertySymbols(v).length !== 0) return { ok: false, reason: `${path}: a symbol key` };
    if (Array.isArray(v)) {
      const items = Object.getPrototypeOf(v) === Array.prototype ? ownArray(v) : null;
      if (items === null) return { ok: false, reason: `${path}: not a plain array (an accessor, a hole or an extra key)` };
      const out: unknown[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = walk(items[i], `${path}[${i}]`, depth + 1);
        if (!item.ok) return item;
        out.push(item.value);
      }
      return { ok: true, value: out };
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return { ok: false, reason: `${path}: not a plain object` };
    const out: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(v)) {
      if (key === "__proto__") return { ok: false, reason: `${path}: a key named __proto__` };
      const read = ownData(v, key);
      if (!read.ok) return { ok: false, reason: `${path}.${key}: an accessor (a getter or setter)` };
      const member = walk(read.value, `${path}.${key}`, depth + 1);
      if (!member.ok) return member;
      // Defined, not assigned: an assignment could run a setter that Object.prototype serves for this key.
      Object.defineProperty(out, key, { value: member.value, enumerable: true, writable: true, configurable: true });
    }
    return { ok: true, value: out };
  };
  return walk(value, root, 0);
}

// ── The registry rendering: one source (N128 r1, finding 4) ─────────────────────────────────────────

/** The JSON-Schema-shaped rendering of one closed kind. A `format` names the character-loop check above. */
function renderKind(kind: ParamKind): Record<string, unknown> {
  switch (kind.kind) {
    case "enum":
      return { type: "string", enum: [...kind.values] };
    case "boolean":
      return { type: "boolean" };
    case "integer":
      return { type: "integer", minimum: kind.min, maximum: kind.max };
    case "number":
      return { type: "number", minimum: kind.min, maximum: kind.max };
    case "identifier":
      return { type: "string", format: "pcc-identifier", minLength: 1, maxLength: MAX_IDENTIFIER_LENGTH };
    case "bytes32":
      return { type: "string", format: "bytes32" };
    case "digest":
      return { type: "string", format: "sha256-digest" };
    case "address":
      return { type: "string", format: "evm-address" };
    case "array":
      return { type: "array", items: renderKind(kind.items), maxItems: kind.maxItems };
    case "object":
      return renderFields(kind.fields);
    case "oneOf":
      return { oneOf: kind.options.map(renderKind) };
  }
}

function renderFields(fields: Readonly<Record<string, ParamField>>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const requiredKeys: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    properties[key] = field.default === undefined ? renderKind(field.type) : { ...renderKind(field.type), default: field.default };
    if (field.required === true) requiredKeys.push(key);
  }
  return { type: "object", properties, ...(requiredKeys.length > 0 ? { required: requiredKeys } : {}), additionalProperties: false };
}

/**
 * A primitive's registry `paramsSchema`, rendered from its closed params: the registry and the validator
 * read one table. Throws for an id with no entry, so a registry primitive without a closed shape fails when
 * the registry module loads.
 */
export function renderParamsSchema(primitiveId: string): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(PRIMITIVE_PARAMS, primitiveId)) {
    throw new Error(`${primitiveId}: no closed params in evidence/primitive-params.ts`);
  }
  return renderFields(PRIMITIVE_PARAMS[primitiveId] as Readonly<Record<string, ParamField>>);
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────────

function check(kind: ParamKind, value: unknown, path: string, issues: string[]): void {
  switch (kind.kind) {
    case "enum":
      if (typeof value !== "string" || !kind.values.includes(value)) issues.push(`${path}: not one of ${kind.values.join(", ")}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") issues.push(`${path}: not a boolean`);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < kind.min || value > kind.max) {
        issues.push(`${path}: not an integer in ${kind.min}..${kind.max}`);
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || value < kind.min || value > kind.max) {
        issues.push(`${path}: not a finite number in ${kind.min}..${kind.max}`);
      }
      return;
    case "identifier":
      if (!isParamIdentifier(value)) issues.push(`${path}: not an identifier`);
      return;
    case "bytes32":
      if (typeof value !== "string" || !isPrefixedLowerHex(value, 64)) issues.push(`${path}: not 0x plus 64 lowercase hex`);
      return;
    case "digest":
      if (!isSha256Digest(value)) issues.push(`${path}: not sha256: plus 64 lowercase hex`);
      return;
    case "address":
      if (typeof value !== "string" || !isPrefixedLowerHex(value, 40)) issues.push(`${path}: not 0x plus 40 lowercase hex`);
      return;
    case "array": {
      const items = ownArray(value);
      if (items === null) {
        issues.push(`${path}: not a plain array`);
        return;
      }
      if (items.length > kind.maxItems) {
        issues.push(`${path}: more than ${kind.maxItems} items`);
        return;
      }
      items.forEach((item, i) => check(kind.items, item, `${path}[${i}]`, issues));
      return;
    }
    case "object":
      checkObject(kind.fields, value, path, issues);
      return;
    case "oneOf": {
      for (const option of kind.options) {
        const optionIssues: string[] = [];
        check(option, value, path, optionIssues);
        if (optionIssues.length === 0) return;
      }
      issues.push(`${path}: matches none of its allowed shapes`);
      return;
    }
  }
}

function checkObject(fields: Readonly<Record<string, ParamField>>, value: unknown, path: string, issues: string[]): void {
  if (!isPlainRecord(value)) {
    issues.push(`${path}: not a plain object`);
    return;
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) issues.push(`${path}.${key}: not a field of this primitive`);
  }
  for (const key of Object.keys(fields)) {
    const field = fields[key] as ParamField;
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      if (field.required === true) issues.push(`${path}.${key}: required`);
      continue;
    }
    const read = ownData(value, key);
    if (!read.ok) {
      issues.push(`${path}.${key}: not a data property`);
      continue;
    }
    check(field.type, read.value, `${path}.${key}`, issues);
  }
}

/**
 * Whether `params` are valid closed params for primitive `primitiveId`. Absent params (undefined) are
 * valid when the primitive requires none. Returns every issue, so an author sees them all at once.
 */
export function validatePrimitiveParams(primitiveId: string, params: unknown): { ok: true } | { ok: false; issues: string[] } {
  if (!Object.prototype.hasOwnProperty.call(PRIMITIVE_PARAMS, primitiveId)) {
    return { ok: false, issues: [`${primitiveId}: not a registry primitive`] };
  }
  const fields = PRIMITIVE_PARAMS[primitiveId] as Readonly<Record<string, ParamField>>;
  const issues: string[] = [];
  if (params === undefined) {
    for (const [key, field] of Object.entries(fields)) if (field.required === true) issues.push(`params.${key}: required`);
  } else {
    checkObject(fields, params, "params", issues);
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
