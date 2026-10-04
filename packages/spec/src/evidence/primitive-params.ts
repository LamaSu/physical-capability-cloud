/**
 * Closed parameter schemas for every evidence primitive (N128).
 *
 * A CSD evidence ref and an emitter declaration carry per-primitive `params`, and setup returns emitter
 * manifests PUBLICLY. Until this module, `params` was an open record (`csd/schema.ts`), so a value nobody
 * recognizes, a secret under a harmless name included, went out verbatim. The registry's `paramsSchema`
 * (primitives.ts) described the params but was never enforced, and most of its objects were open.
 *
 * THE PROPERTY. A public param is one of a closed set of shapes, and nothing else: an enum member, a boolean,
 * a bounded number, an identifier, a fixed-format reference (bytes32, a `sha256:` digest, an address), or an
 * array or closed object of those. Every object is closed (an unknown key is refused) and every primitive
 * id must be in the registry. A free-form string has no place in it. Identifiers name something the
 * consumer can resolve (a job, a capability type, a server-side matcher), and the consumer checks that they
 * do. A confidential value never goes here: it belongs in the separate, non-public representation, and
 * the public manifest carries only an opaque handle to it.
 *
 * No regular expressions: every format is checked by a character loop, and nothing tries to recognize a
 * secret by its pattern. A secret can't hide where only closed shapes fit.
 *
 * Reads are own data properties only: an accessor, an inherited key or a non-plain object is refused, so
 * a polluted prototype can't add a field and a getter can't answer differently on a second read.
 */

import { KNOWN_UNITS } from "../csd/composition.js";

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

/** A field of a closed object: its shape, and whether it must be present. */
export interface ParamField {
  readonly type: ParamKind;
  readonly required?: boolean;
}

/** The longest identifier: enough for a job id, a capability type or a field name, too short for prose. */
export const MAX_IDENTIFIER_LENGTH = 128;

const id: ParamKind = { kind: "identifier" };
const bytes32: ParamKind = { kind: "bytes32" };
const digest: ParamKind = { kind: "digest" };
const seconds = (max: number): ParamKind => ({ kind: "integer", min: 1, max });
const enumOf = (...values: string[]): ParamKind => ({ kind: "enum", values });
const optional = (type: ParamKind): ParamField => ({ type });
const required = (type: ParamKind): ParamField => ({ type, required: true });

/**
 * The closed params of every registry primitive, keyed by primitive id. A primitive with no params has
 * an empty field set: any key is refused. A registry test keeps these keys equal to EVIDENCE_PRIMITIVES.
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
    mode: optional(enumOf("plain", "redacted-commit")),
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
    snapshotHash: optional(digest),
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
    mode: optional(enumOf("deterministic", "seeded-stochastic", "statistical-tolerance")),
  },
  "capture.photo_nonced": {
    media: optional(enumOf("photo", "video")),
    minClass: optional(enumOf("CC0", "CC1", "CC2", "CC3", "CC4", "CC5")),
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
    disclosure: optional(enumOf("full", "redacted-commit")),
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
    source: optional(enumOf("summary", "stream")),
    severityFloor: optional(enumOf("high", "critical")),
    materialParam: optional(id),
    includePipelineAnomalies: optional({ kind: "boolean" }),
  },
  "telemetry.coverage_gate": {
    requiredGroups: optional({ kind: "array", maxItems: 16, items: { kind: "array", maxItems: 16, items: id } }),
    maxGapSeconds: optional(seconds(86_400)),
    evidenceGradeChannels: optional({ kind: "boolean" }),
  },
  "process.batch_record": {
    recipeRef: required(bytes32),
    phaseGraph: optional(bytes32),
    sampleManifestRef: optional(bytes32),
  },
};

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
  if (descriptor === undefined || !("value" in descriptor)) return { ok: false };
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
