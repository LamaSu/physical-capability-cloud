/**
 * Versioned, content-addressed agreement templates (ECONOMIC_AGREEMENTS.md §11).
 * Only scalar, explicitly declared economic leaves are editable. A template never
 * grants authority to select a payout address, license term or protocol fee.
 */
import { z } from "zod";
import { canonicalize } from "../util/canonical.js";
import type { CompileOptions } from "./compile.js";
import { AGREEMENT_TEMPLATES } from "./examples.js";
import { domainHash, cmpStr } from "./hash.js";
import { snapshotJson } from "./input.js";
import { comparePaths } from "./refusals.js";
import { ADDRESS_PATTERN, AMOUNT_PATTERN, EconomicAgreementSchema, ID_PATTERN, IdSchema, AmountSchema, BpsSchema, type EconomicAgreement } from "./types.js";

export const AGREEMENT_TEMPLATE_DOMAIN = "PCC:agreement-template:v1";
export const AGREEMENT_TEMPLATE_SCHEMA = "pcc.agreement-template.v1" as const;

const SlotNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/);
const PointerSchema = z.string().refine((p) => p === "" || p.startsWith("/"), "invalid JSON pointer").refine(
  (p) => !/(~(?![01]))/.test(p),
  "a JSON pointer may escape only ~ and /, as ~0 and ~1",
);
const SlotPathsSchema = z.array(PointerSchema).min(1).refine(
  (paths) => paths.every((p, i) => i === 0 || cmpStr(paths[i - 1]!, p) < 0),
  "slot paths must be sorted in byte order without repeats",
);
const slot = <K extends string, S extends z.ZodTypeAny>(kind: K, value: S) =>
  z.object({ name: SlotNameSchema, kind: z.literal(kind), default: value, paths: SlotPathsSchema }).strict();
export const SlotV1Schema = z.discriminatedUnion("kind", [
  slot("party", IdSchema),
  slot("unit", IdSchema),
  slot("amount", AmountSchema),
  slot("bps", BpsSchema),
  // A license slot can be described, but validation rejects it in v1, even if unfilled.
  slot("license", z.string()),
]);
export type SlotV1 = z.infer<typeof SlotV1Schema>;

export const AgreementTemplateV1Schema = z.object({
  schema: z.literal(AGREEMENT_TEMPLATE_SCHEMA),
  templateId: IdSchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  title: z.string().min(1),
  summary: z.string().min(1),
  slots: z.array(SlotV1Schema),
  body: EconomicAgreementSchema,
}).strict();
export type AgreementTemplateV1 = z.infer<typeof AgreementTemplateV1Schema>;

export const TEMPLATE_REFUSAL_CODES = [
  "TEMPLATE_SCHEMA_INVALID",
  "SLOT_KIND_RESERVED",
  "SLOT_NAME_DUPLICATE",
  "SLOT_PATH_DUPLICATE",
  "SLOT_PATH_FORBIDDEN",
  "SLOT_KIND_MISMATCH",
  "SLOT_DEFAULT_MISMATCH",
  "SLOT_PATHS_INCOMPLETE",
  "PARAMS_INVALID",
  "SLOT_UNKNOWN",
  "SLOT_VALUE_INVALID",
  "SLOT_VALUE_ADDRESS",
  "SLOT_ID_COLLISION",
  "INSTANCE_SCHEMA_INVALID",
  "TEMPLATE_UNKNOWN",
  "TEMPLATE_HASH_MISMATCH",
  "TEMPLATE_ORIGIN_MISMATCH",
] as const;
export type TemplateRefusalCode = (typeof TEMPLATE_REFUSAL_CODES)[number];
export interface TemplateRefusal { code: TemplateRefusalCode; message: string; path: string[] }
export type TemplateValidationResult = { ok: true; template: AgreementTemplateV1 } | { ok: false; refusals: TemplateRefusal[] };
export type TemplateInstantiationResult = { ok: true; agreement: EconomicAgreement } | { ok: false; refusals: TemplateRefusal[] };
export type TemplateOriginResult = { ok: true } | { ok: false; refusals: TemplateRefusal[] };

function refuse(code: TemplateRefusalCode, message: string, path: string[] = []): TemplateRefusal {
  return { code, message, path };
}
function ordered(refusals: readonly TemplateRefusal[]): TemplateRefusal[] {
  const seen = new Set<string>();
  const unique: TemplateRefusal[] = [];
  for (const r of refusals) {
    const key = JSON.stringify([r.code, r.path]);
    if (!seen.has(key)) { seen.add(key); unique.push(r); }
  }
  return unique.sort((a, b) => cmpStr(a.code, b.code) || comparePaths(a.path, b.path));
}
function failed(code: TemplateRefusalCode, message: string, path: string[] = []): { ok: false; refusals: TemplateRefusal[] } {
  return { ok: false, refusals: [refuse(code, message, path)] };
}

/** A defensive one-time copy; even input.ts's known N183 thrown-trap defect cannot escape this API. */
function snapshot(input: unknown, canonical = false): ReturnType<typeof snapshotJson> {
  try { return snapshotJson(input, { canonical }); }
  catch { return { ok: false, reason: "the input could not be read as JSON data" }; }
}

/** RFC 6901 JSON-pointer traversal, constrained to existing own properties. */
function parts(pointer: string): string[] | null {
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) return null;
  return pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function at(root: unknown, pointer: string): { exists: true; value: unknown } | { exists: false } {
  const path = parts(pointer);
  if (path === null) return { exists: false };
  let cursor: unknown = root;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object" || Object.getOwnPropertyDescriptor(cursor, key) === undefined) return { exists: false };
    if (Array.isArray(cursor) && !/^(0|[1-9][0-9]*)$/.test(key)) return { exists: false };
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return { exists: true, value: cursor };
}
function replaceAt(root: object, pointer: string, value: string | number): void {
  const path = parts(pointer)!;
  let cursor: Record<string, unknown> = root as Record<string, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
  cursor[path[path.length - 1]!] = value;
}

type EditableKind = Exclude<SlotV1["kind"], "license">;
const index = "(?:0|[1-9][0-9]*)";
const positions: readonly { kind: EditableKind; pattern: RegExp }[] = [
  { kind: "party", pattern: /^\/payer$/ },
  { kind: "party", pattern: new RegExp(`^/parties/${index}/partyId$`) },
  { kind: "party", pattern: new RegExp(`^/clauses/${index}/to/party$`) },
  { kind: "party", pattern: new RegExp(`^/splits/${index}/members/${index}/to/party$`) },
  { kind: "unit", pattern: new RegExp(`^/units/${index}/unitRef$`) },
  { kind: "unit", pattern: new RegExp(`^/clauses/${index}/appliesTo/units/${index}$`) },
  { kind: "amount", pattern: new RegExp(`^/units/${index}/gross$`) },
  { kind: "amount", pattern: new RegExp(`^/clauses/${index}/rule/(?:amount|rate|cost|min|max|cap)$`) },
  { kind: "bps", pattern: new RegExp(`^/clauses/${index}/rule/(?:bps|markupBps)$`) },
];

/** A potential slot path may be structurally valid even when it names a missing leaf. */
function positionKind(body: EconomicAgreement, pointer: string): EditableKind | null {
  const possible = positions.find((x) => x.pattern.test(pointer));
  if (!possible) return null;
  const match = /^\/clauses\/(0|[1-9][0-9]*)\/rule\//.exec(pointer);
  if (match) {
    const c = body.clauses[Number(match[1])];
    if (c && (c.underLicense !== null || (c.rule.kind === "percent" && c.rule.rateSource !== null))) return null;
  }
  return possible.kind;
}

/** Only actual reference positions, not coincidentally equal roles, subjects or clause ids. */
function partyPositions(body: EconomicAgreement): Array<[string, string]> {
  const out: Array<[string, string]> = [["/payer", body.payer]];
  body.parties.forEach((p, i) => out.push([`/parties/${i}/partyId`, p.partyId]));
  body.clauses.forEach((c, i) => { if ("party" in c.to) out.push([`/clauses/${i}/to/party`, c.to.party]); });
  body.splits.forEach((s, i) => s.members.forEach((m, j) => {
    if ("party" in m.to) out.push([`/splits/${i}/members/${j}/to/party`, m.to.party]);
  }));
  return out;
}
function unitPositions(body: EconomicAgreement): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  body.units.forEach((u, i) => out.push([`/units/${i}/unitRef`, u.unitRef]));
  body.clauses.forEach((c, i) => {
    if ("units" in c.appliesTo) c.appliesTo.units.forEach((u, j) => out.push([`/clauses/${i}/appliesTo/units/${j}`, u]));
  });
  return out;
}
function licensedPartyIds(body: EconomicAgreement): Set<string> {
  const ids = new Set<string>();
  for (const l of body.licenses) {
    ids.add(l.licensor);
    for (const p of l.requires.payments) {
      if ("distribution" in p.payee) for (const member of p.payee.distribution) ids.add(member.party);
    }
  }
  return ids;
}

/** Complete, closed, non-throwing template validation (no compiler refusal code is reused). */
export function validateTemplate(input: unknown): TemplateValidationResult {
  const copied = snapshot(input);
  if (!copied.ok) return failed("TEMPLATE_SCHEMA_INVALID", copied.reason);
  const parsed = AgreementTemplateV1Schema.safeParse(copied.value);
  if (!parsed.success) return failed("TEMPLATE_SCHEMA_INVALID", parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  const template = parsed.data;
  const out: TemplateRefusal[] = [];
  const names = new Set<string>();
  const owners = new Map<string, string>();
  const parties = partyPositions(template.body);
  const units = unitPositions(template.body);
  const licensed = licensedPartyIds(template.body);
  for (const s of template.slots) {
    const slotPath = ["slots", s.name];
    if (names.has(s.name)) out.push(refuse("SLOT_NAME_DUPLICATE", `slot "${s.name}" is declared more than once`, slotPath));
    names.add(s.name);
    if (s.kind === "license") {
      out.push(refuse("SLOT_KIND_RESERVED", `license slots are reserved in v1`, slotPath));
      continue;
    }
    if (s.kind === "party" && licensed.has(s.default)) {
      out.push(refuse("SLOT_PATH_FORBIDDEN", `party "${s.default}" is named by a fixed license and cannot be rebound`, slotPath));
    }
    for (const pointer of s.paths) {
      const where = [...slotPath, pointer];
      const owner = owners.get(pointer);
      if (owner !== undefined) out.push(refuse("SLOT_PATH_DUPLICATE", `pointer ${pointer} belongs to slots "${owner}" and "${s.name}"`, where));
      else owners.set(pointer, s.name);
      const kind = positionKind(template.body, pointer);
      if (kind === null) { out.push(refuse("SLOT_PATH_FORBIDDEN", `${pointer} is not an editable position`, where)); continue; }
      if (kind !== s.kind) { out.push(refuse("SLOT_KIND_MISMATCH", `${pointer} is ${kind}, not ${s.kind}`, where)); continue; }
      const leaf = at(template.body, pointer);
      if (!leaf.exists || leaf.value !== s.default) out.push(refuse("SLOT_DEFAULT_MISMATCH", `${pointer} does not contain the declared default`, where));
    }
    if (s.kind === "party" || s.kind === "unit") {
      const expected = (s.kind === "party" ? parties : units)
        .filter(([, value]) => value === s.default).map(([path]) => path).sort(cmpStr);
      if (expected.length !== s.paths.length || expected.some((p, i) => s.paths[i] !== p)) {
        out.push(refuse("SLOT_PATHS_INCOMPLETE", `slot "${s.name}" must cover exactly ${JSON.stringify(expected)}`, slotPath));
      }
    }
  }
  return out.length ? { ok: false, refusals: ordered(out) } : { ok: true, template };
}

/** Hash only the four normative identity fields, not UI copy or the schema tag. */
export function templateHash(t: AgreementTemplateV1): `0x${string}` {
  return domainHash(AGREEMENT_TEMPLATE_DOMAIN, { templateId: t.templateId, version: t.version, slots: t.slots, body: t.body });
}

function validValue(kind: EditableKind, value: unknown): TemplateRefusalCode | null {
  if ((kind === "party" || kind === "unit") && typeof value === "string" && ADDRESS_PATTERN.test(value)) return "SLOT_VALUE_ADDRESS";
  if (kind === "party" || kind === "unit") return typeof value === "string" && ID_PATTERN.test(value) ? null : "SLOT_VALUE_INVALID";
  if (kind === "amount") return typeof value === "string" && AMOUNT_PATTERN.test(value) ? null : "SLOT_VALUE_INVALID";
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10000 ? null : "SLOT_VALUE_INVALID";
}

/** Fill a copy once; changed parties have no payout address until server binding. */
export function instantiateTemplate(template: unknown, params: unknown): TemplateInstantiationResult {
  const checked = validateTemplate(template);
  if (!checked.ok) return checked;
  const copied = snapshot(params);
  if (!copied.ok || copied.value === null || typeof copied.value !== "object" || Array.isArray(copied.value)) {
    return failed("PARAMS_INVALID", copied.ok ? "params must be a plain JSON object" : copied.reason, ["params"]);
  }
  const supplied = copied.value as Record<string, unknown>;
  const declarations = new Map(checked.template.slots.map((s) => [s.name, s] as const));
  const out: TemplateRefusal[] = [];
  for (const key of Object.keys(supplied)) {
    const s = declarations.get(key);
    if (!s) { out.push(refuse("SLOT_UNKNOWN", `unknown slot "${key}"`, ["params", key])); continue; }
    if (s.kind === "license") continue; // validation already refuses all license slots
    const code = validValue(s.kind, supplied[key]);
    if (code) out.push(refuse(code, `invalid ${s.kind} value for slot "${key}"`, ["params", key]));
  }
  if (out.length) return { ok: false, refusals: ordered(out) };
  const bodyCopy = snapshot(checked.template.body);
  if (!bodyCopy.ok) return failed("INSTANCE_SCHEMA_INVALID", bodyCopy.reason);
  const body = bodyCopy.value as EconomicAgreement;
  for (const s of checked.template.slots) {
    if (s.kind === "license") continue;
    const value = Object.getOwnPropertyDescriptor(supplied, s.name) !== undefined ? supplied[s.name] as string | number : s.default;
    if (value === s.default) continue;
    for (const pointer of s.paths) replaceAt(body, pointer, value);
    if (s.kind === "party") {
      // The party row's label and payTo are not param slots: never inherit somebody else's wallet.
      const party = body.parties.find((p) => p.partyId === value);
      if (party) { party.payTo = null; party.label = value as string; }
    }
  }
  for (const kind of ["party", "unit"] as const) {
    const refs = kind === "party" ? body.parties.map((p) => p.partyId) : body.units.map((u) => u.unitRef);
    const seen = new Set<string>();
    for (const id of refs) {
      if (seen.has(id)) out.push(refuse("SLOT_ID_COLLISION", `the filled agreement has a duplicate ${kind} id "${id}"`, ["params"]));
      seen.add(id);
    }
  }
  if (out.length) return { ok: false, refusals: ordered(out) };
  const parsed = EconomicAgreementSchema.safeParse(body);
  if (!parsed.success) return failed("INSTANCE_SCHEMA_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return { ok: true, agreement: parsed.data };
}

export interface AgreementTemplateCatalogEntry {
  readonly template: AgreementTemplateV1;
  readonly templateHash: `0x${string}`;
  readonly compileOptions: CompileOptions;
}

/** The hardcoded, intentional edit surfaces of the five existing examples; array indices are at the base commit. */
const CATALOG_SLOTS: readonly (readonly SlotV1[])[] = [
  [
    { name: "buyer", kind: "party", default: "dana", paths: ["/parties/0/partyId", "/payer"] },
    { name: "printerOwner", kind: "party", default: "sam", paths: ["/clauses/1/to/party", "/parties/1/partyId"] },
    { name: "printUnit", kind: "unit", default: "print", paths: ["/clauses/1/appliesTo/units/0", "/units/0/unitRef"] },
    { name: "printPrice", kind: "amount", default: "25000000", paths: ["/units/0/gross"] },
  ],
  [
    { name: "buyer", kind: "party", default: "buyer", paths: ["/parties/0/partyId", "/payer"] },
    { name: "composer", kind: "party", default: "orbit", paths: ["/clauses/4/to/party", "/parties/1/partyId"] },
    { name: "printStep", kind: "unit", default: "a-print", paths: ["/clauses/0/appliesTo/units/0", "/units/0/unitRef"] },
    { name: "mailStep", kind: "unit", default: "b-mail", paths: ["/clauses/1/appliesTo/units/0", "/clauses/2/appliesTo/units/0", "/units/1/unitRef"] },
    { name: "printGross", kind: "amount", default: "14000000", paths: ["/units/0/gross"] },
    { name: "mailGross", kind: "amount", default: "8000000", paths: ["/units/1/gross"] },
    { name: "shopPrice", kind: "amount", default: "12000000", paths: ["/clauses/0/rule/amount"] },
    { name: "deliveryPrice", kind: "amount", default: "5000000", paths: ["/clauses/1/rule/amount"] },
    { name: "postageCost", kind: "amount", default: "680000", paths: ["/clauses/2/rule/cost"] },
    { name: "postageMarkupBps", kind: "bps", default: 0, paths: ["/clauses/2/rule/markupBps"] },
  ],
  [
    { name: "homeowner", kind: "party", default: "homeowner", paths: ["/parties/0/partyId", "/payer"] },
    { name: "ana", kind: "party", default: "ana", paths: ["/parties/2/partyId", "/splits/1/members/0/to/party"] },
    { name: "ben", kind: "party", default: "ben", paths: ["/parties/3/partyId", "/splits/1/members/1/to/party"] },
    { name: "cy", kind: "party", default: "cy", paths: ["/parties/4/partyId", "/splits/1/members/2/to/party"] },
    { name: "partsBuyer", kind: "party", default: "lee", paths: ["/clauses/0/to/party", "/parties/5/partyId"] },
    { name: "inspector", kind: "party", default: "inspector", paths: ["/clauses/1/to/party", "/parties/6/partyId"] },
    { name: "repairUnit", kind: "unit", default: "repair", paths: ["/clauses/0/appliesTo/units/0", "/clauses/1/appliesTo/units/0", "/clauses/2/appliesTo/units/0", "/units/0/unitRef"] },
    { name: "repairGross", kind: "amount", default: "180010000", paths: ["/units/0/gross"] },
    { name: "partsCost", kind: "amount", default: "42500000", paths: ["/clauses/0/rule/cost"] },
    { name: "partsMarkupBps", kind: "bps", default: 0, paths: ["/clauses/0/rule/markupBps"] },
    { name: "inspectionBps", kind: "bps", default: 150, paths: ["/clauses/1/rule/bps"] },
  ],
  [
    { name: "client", kind: "party", default: "client", paths: ["/parties/0/partyId", "/payer"] },
    { name: "lab", kind: "party", default: "lab", paths: ["/clauses/0/to/party", "/clauses/3/to/party", "/parties/1/partyId"] },
    { name: "assayUnit", kind: "unit", default: "assay", paths: ["/clauses/0/appliesTo/units/0", "/clauses/3/appliesTo/units/0", "/units/0/unitRef"] },
    { name: "assayGross", kind: "amount", default: "400000000", paths: ["/units/0/gross"] },
    { name: "labRunPrice", kind: "amount", default: "320000000", paths: ["/clauses/0/rule/amount"] },
    { name: "protocolBps", kind: "bps", default: 50, paths: ["/clauses/2/rule/bps"] },
  ],
  [
    { name: "homeowner", kind: "party", default: "homeowner", paths: ["/parties/0/partyId", "/payer"] },
    { name: "contractor", kind: "party", default: "contractor", paths: ["/clauses/4/to/party", "/parties/1/partyId"] },
    { name: "lumberYard", kind: "party", default: "lumber", paths: ["/clauses/1/to/party", "/parties/3/partyId"] },
    { name: "insurer", kind: "party", default: "insurer", paths: ["/clauses/2/to/party", "/parties/4/partyId"] },
    { name: "inspector", kind: "party", default: "inspector", paths: ["/clauses/3/to/party", "/parties/5/partyId"] },
    { name: "designStep", kind: "unit", default: "m1-design", paths: ["/clauses/0/appliesTo/units/0", "/units/0/unitRef"] },
    { name: "buildStep", kind: "unit", default: "m2-build", paths: ["/clauses/1/appliesTo/units/0", "/clauses/2/appliesTo/units/0", "/units/1/unitRef"] },
    { name: "inspectionStep", kind: "unit", default: "m3-inspect", paths: ["/clauses/3/appliesTo/units/0", "/units/2/unitRef"] },
    { name: "designGross", kind: "amount", default: "800000000", paths: ["/units/0/gross"] },
    { name: "buildGross", kind: "amount", default: "6500000000", paths: ["/units/1/gross"] },
    { name: "inspectionGross", kind: "amount", default: "700000000", paths: ["/units/2/gross"] },
    { name: "designFee", kind: "amount", default: "600000000", paths: ["/clauses/0/rule/amount"] },
    { name: "lumberCost", kind: "amount", default: "3210400000", paths: ["/clauses/1/rule/cost"] },
    { name: "lumberMarkupBps", kind: "bps", default: 0, paths: ["/clauses/1/rule/markupBps"] },
    { name: "insuranceBps", kind: "bps", default: 120, paths: ["/clauses/2/rule/bps"] },
    { name: "inspectionFee", kind: "amount", default: "250000000", paths: ["/clauses/3/rule/amount"] },
  ],
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Catalog order, builder bytes and compile options are inherited from the untouched examples. */
export const AGREEMENT_TEMPLATES_V1: readonly AgreementTemplateCatalogEntry[] = deepFreeze(
  AGREEMENT_TEMPLATES.map((entry, i) => {
    const template: AgreementTemplateV1 = {
      schema: AGREEMENT_TEMPLATE_SCHEMA,
      templateId: entry.templateId,
      version: 1,
      title: entry.title,
      summary: entry.summary,
      slots: CATALOG_SLOTS[i]!.map((s) => ({ ...s, paths: [...s.paths] })),
      body: entry.build(),
    };
    const copied = snapshot(entry.compileOptions);
    if (!copied.ok) throw new Error(`invalid built-in template compile options: ${entry.templateId}`);
    return { template, templateHash: templateHash(template), compileOptions: copied.value as CompileOptions };
  }),
);

/** Verify provenance on the unmodified instance, before server retiming or fee binding. */
export function verifyTemplateOrigin(
  agreement: unknown,
  origin: { templateKey: string; templateHash: string; params: unknown },
  catalog: readonly AgreementTemplateCatalogEntry[] = AGREEMENT_TEMPLATES_V1,
): TemplateOriginResult {
  // Read only the three own data descriptors, once each. In particular, do NOT recursively
  // snapshot params here: instantiateTemplate must own its validation and PARAMS_INVALID refusal.
  const own = (key: string): { exists: true; value: unknown } | { exists: false } => {
    try {
      if (origin === null || typeof origin !== "object") return { exists: false };
      const descriptor = Object.getOwnPropertyDescriptor(origin, key);
      return descriptor && "value" in descriptor ? { exists: true, value: descriptor.value } : { exists: false };
    } catch { return { exists: false }; }
  };
  const key = own("templateKey");
  const hash = own("templateHash");
  const params = own("params");
  let entry: AgreementTemplateCatalogEntry | undefined;
  try {
    entry = Array.isArray(catalog) && key.exists && typeof key.value === "string"
      ? catalog.find((e) => `${e.template.templateId}@${e.template.version}` === key.value)
      : undefined;
  } catch {
    return failed("TEMPLATE_UNKNOWN", "the catalog could not be read", ["origin"]);
  }
  if (!entry) return failed("TEMPLATE_UNKNOWN", "the template key is not in the catalog", ["origin"]);
  if (!hash.exists || hash.value !== entry.templateHash) return failed("TEMPLATE_HASH_MISMATCH", "template hash differs from the catalog", ["origin"]);
  const filled = instantiateTemplate(entry.template, params.exists ? params.value : undefined);
  if (!filled.ok) return filled;
  const copied = snapshot(agreement, true);
  if (!copied.ok) return failed("TEMPLATE_ORIGIN_MISMATCH", `agreement has no canonical form: ${copied.reason}`, ["origin"]);
  try {
    if (canonicalize(filled.agreement) !== canonicalize(copied.value)) {
      return failed("TEMPLATE_ORIGIN_MISMATCH", "agreement differs from the exact template instantiation", ["origin"]);
    }
  } catch {
    return failed("TEMPLATE_ORIGIN_MISMATCH", "agreement could not be compared canonically", ["origin"]);
  }
  return { ok: true };
}
