/** CC5: one immutable template identity, explicit scalar slots, and exact origin bytes. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalize } from "../util/canonical.js";
import { compileEconomics, type CompiledEconomics } from "../economics/compile.js";
import { AGREEMENT_TEMPLATES } from "../economics/examples.js";
import {
  AGREEMENT_TEMPLATES_V1, TEMPLATE_REFUSAL_CODES, instantiateTemplate, templateHash,
  validateTemplate, verifyTemplateOrigin, type AgreementTemplateV1,
  type TemplateRefusal, type TemplateRefusalCode,
} from "../economics/templates.js";
import type { EconomicAgreement } from "../economics/types.js";

interface GoldenUnit { gross: string; fee: string; net: string; payouts: [string, string][] }
interface TemplateGolden {
  templateId: string;
  version: number;
  slots: AgreementTemplateV1["slots"];
  templateHash: string;
  defaultAgreementHash: string;
  nonDefault: { params: Record<string, string | number>; agreementHash: string; units: Record<string, GoldenUnit> };
}
const fixture = JSON.parse(readFileSync(new URL("./fixtures/agreement-templates-v1.json", import.meta.url), "utf8")) as {
  templates: Record<string, TemplateGolden>;
};
const previous = JSON.parse(readFileSync(new URL("./fixtures/economics-golden-v1.json", import.meta.url), "utf8")) as {
  agreements: Record<string, { agreementHash: string }>;
};
const catalog = AGREEMENT_TEMPLATES_V1;
const keys = catalog.map((x) => x.template.templateId);
const byId = (id: string) => {
  const x = catalog.find((e) => e.template.templateId === id);
  if (!x) throw new Error(`unknown fixture: ${id}`);
  return x;
};
const copyTemplate = (id = "spare-printer"): AgreementTemplateV1 =>
  JSON.parse(JSON.stringify(byId(id).template)) as AgreementTemplateV1;
const copyAgreement = (a: EconomicAgreement): EconomicAgreement => JSON.parse(JSON.stringify(a)) as EconomicAgreement;
const compile = (id: string, ag: EconomicAgreement): CompiledEconomics => {
  const r = compileEconomics(ag, byId(id).compileOptions);
  if (!r.ok) throw new Error(`${id} compile refused: ${JSON.stringify(r.refusals)}`);
  return r;
};
const resultCodes = (r: { ok: boolean; refusals?: TemplateRefusal[] }): TemplateRefusalCode[] =>
  r.ok ? [] : (r.refusals ?? []).map((x) => x.code);
function assertRefusal(r: { ok: boolean; refusals?: TemplateRefusal[] }, code: TemplateRefusalCode): void {
  expect(r.ok).toBe(false);
  expect(resultCodes(r)).toContain(code);
}
/** A placeholder MUST fail and print the exact unabridged value for round 2. */
function assertGoldenHash(id: string, fixtureKey: string, expected: string, actual: string): void {
  if (expected === "FROM-RUN") throw new Error(`${id} ${fixtureKey}: FROM-RUN; actual=${actual}`);
  expect(actual, `${id} ${fixtureKey}: actual=${actual}`).toBe(expected);
}
function origin(id: string, params: unknown = {}) {
  const e = byId(id);
  return { templateKey: `${e.template.templateId}@${e.template.version}`, templateHash: e.templateHash, params };
}
function tweak(id: string, index: number, replacement: AgreementTemplateV1["slots"][number]): AgreementTemplateV1 {
  const t = copyTemplate(id);
  t.slots[index] = replacement;
  return t;
}
function freezeAll<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeAll(child);
    Object.freeze(value);
  }
  return value;
}

describe("agreement template v1 goldens (round-1 hashes intentionally FROM-RUN)", () => {
  for (const id of keys) {
    it(`${id}: hashes only declared identity fields and matches template golden`, () => {
      const e = byId(id);
      const expected = fixture.templates[id]!;
      expect(e.template.templateId).toBe(expected.templateId);
      expect(e.template.version).toBe(expected.version);
      expect(e.template.slots).toEqual(expected.slots);
      expect(templateHash(e.template)).toBe(e.templateHash);
      assertGoldenHash(id, "templateHash", expected.templateHash, e.templateHash);
      const renamed = { ...e.template, title: "Renamed for UI", summary: "Copy edited for UI" };
      expect(templateHash(renamed)).toBe(e.templateHash); // title/summary/schema excluded
    });
    it(`${id}: the default compiled hash is the existing example's golden`, () => {
      const e = byId(id);
      const result = instantiateTemplate(e.template, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const compiled = compile(id, result.agreement);
      expect(compiled.agreementHash).toBe(fixture.templates[id]!.defaultAgreementHash);
      expect(compiled.agreementHash).toBe(previous.agreements[result.agreement.agreementId]!.agreementHash);
    });
    it(`${id}: non-default slots compile to independently calculated exact per-unit payouts`, () => {
      const expected = fixture.templates[id]!.nonDefault;
      const filled = instantiateTemplate(byId(id).template, expected.params);
      expect(filled.ok).toBe(true);
      if (!filled.ok) return;
      const compiled = compile(id, filled.agreement);
      const units = Object.fromEntries(compiled.units.map((u) => [u.unitRef, {
        gross: u.gross, fee: u.fee, net: u.net,
        payouts: u.payouts.map((p) => [p.recipient, p.amount]),
      }]));
      expect(units).toEqual(expected.units);
      assertGoldenHash(id, "nonDefault.agreementHash", expected.agreementHash, compiled.agreementHash);
    });
  }

  it("the fixture holds no FROM-RUN placeholder", () => {
    const pending = keys.flatMap((id) => {
      const e = fixture.templates[id]!;
      return [
        ...(e.templateHash === "FROM-RUN" ? [`${id}.templateHash`] : []),
        ...(e.nonDefault.agreementHash === "FROM-RUN" ? [`${id}.nonDefault.agreementHash`] : []),
      ];
    });
    expect(pending, `Round-1 placeholders requiring lane values: ${pending.join(", ")}`).toEqual([]);
  });
});

describe("default instantiation and payout-address authority", () => {
  for (const [i, entry] of catalog.entries()) {
    it(`${entry.template.templateId}: defaults preserve every example byte and object`, () => {
      const r = instantiateTemplate(entry.template, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.agreement).toEqual(entry.template.body);
      expect(r.agreement).toEqual(AGREEMENT_TEMPLATES[i]!.build());
      expect(canonicalize(r.agreement)).toBe(canonicalize(entry.template.body));
    });
  }

  it("a changed payee is unresolved, relabelled, and cannot inherit its old address", () => {
    const e = byId("spare-printer");
    const r = instantiateTemplate(e.template, { printerOwner: "replacement-owner" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.agreement.parties.find((x) => x.partyId === "replacement-owner")!;
    expect(p).toMatchObject({ label: "replacement-owner", payTo: null });
    const compiled = compileEconomics(r.agreement, e.compileOptions);
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.refusals.map((x) => [x.code, x.path])).toContainEqual([
        "UNRESOLVED_PARTY", ["unit", "print", "party", "replacement-owner"],
      ]);
    }
  });
  it("a wallet: party ID is an ID, not a payout-address resolver", () => {
    const walletId = "wallet:0x1111111111111111111111111111111111111111";
    const r = instantiateTemplate(byId("spare-printer").template, { printerOwner: walletId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agreement.parties.find((p) => p.partyId === walletId)!.payTo).toBeNull();
  });
  it("bare addresses are refused for both parties and units", () => {
    const address = "0x1111111111111111111111111111111111111111";
    assertRefusal(instantiateTemplate(byId("spare-printer").template, { buyer: address }), "SLOT_VALUE_ADDRESS");
    assertRefusal(instantiateTemplate(byId("spare-printer").template, { printUnit: address }), "SLOT_VALUE_ADDRESS");
  });
  it("a payTo parameter is unknown; an object with partyId/payTo is never a party scalar", () => {
    const t = byId("spare-printer").template;
    assertRefusal(instantiateTemplate(t, { payTo: "0x1111111111111111111111111111111111111111" }), "SLOT_UNKNOWN");
    assertRefusal(instantiateTemplate(t, { printerOwner: { partyId: "someone", payTo: "0x1111111111111111111111111111111111111111" } }), "SLOT_VALUE_INVALID");
  });
  it("an explicit default ID preserves both the original label and original payTo", () => {
    const t = byId("spare-printer").template;
    const r = instantiateTemplate(t, { printerOwner: "sam" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.agreement.parties[1]).toEqual(t.body.parties[1]);
  });
});

describe("validation: closed, position-specific, license-safe edit surfaces", () => {
  it("all five catalog templates validate; their option and body trees are deep-frozen", () => {
    for (const e of catalog) {
      expect(validateTemplate(e.template)).toMatchObject({ ok: true });
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.template)).toBe(true);
      expect(Object.isFrozen(e.template.body.parties[0])).toBe(true);
      expect(Object.isFrozen(e.template.slots[0]!.paths)).toBe(true);
      expect(Object.isFrozen(e.compileOptions)).toBe(true);
    }
    expect(Object.isFrozen(catalog)).toBe(true);
  });
  it("strict template schema rejects a smuggled field and a body the IR refuses", () => {
    assertRefusal(validateTemplate({ ...copyTemplate(), extra: "smuggled" }), "TEMPLATE_SCHEMA_INVALID");
    const t = copyTemplate();
    assertRefusal(validateTemplate({ ...t, body: { ...t.body, extra: "smuggled" } }), "TEMPLATE_SCHEMA_INVALID");
  });
  it("license slot declarations fail even when never filled", () => {
    const t = copyTemplate();
    t.slots.push({ name: "licenseRef", kind: "license", default: "lic-octoprint-fdm-kit@2", paths: ["/licenses/0/licenseId"] });
    assertRefusal(validateTemplate(t), "SLOT_KIND_RESERVED");
  });
  it("duplicate names and duplicate pointers are separate refusal identities", () => {
    const t = copyTemplate();
    t.slots.push({ ...t.slots[3]!, name: "buyer" });
    assertRefusal(validateTemplate(t), "SLOT_NAME_DUPLICATE");
    const p = copyTemplate();
    p.slots.push({ ...p.slots[0]!, name: "secondBuyer" });
    assertRefusal(validateTemplate(p), "SLOT_PATH_DUPLICATE");
  });
  it("neither party payTo nor the protocol fee can be slotted", () => {
    const party = tweak("spare-printer", 1, { name: "printerOwner", kind: "party", default: "sam", paths: ["/parties/1/payTo"] });
    assertRefusal(validateTemplate(party), "SLOT_PATH_FORBIDDEN");
    const fee = copyTemplate();
    fee.slots.push({ name: "feeBps", kind: "bps", default: 235, paths: ["/fee/feeBps"] });
    assertRefusal(validateTemplate(fee), "SLOT_PATH_FORBIDDEN");
  });
  it("license members and schedule-pinned rates are immutable", () => {
    const lic = copyTemplate();
    lic.slots.push({ name: "kitLicensor", kind: "party", default: "priya", paths: ["/licenses/0/licensor"] });
    assertRefusal(validateTemplate(lic), "SLOT_PATH_FORBIDDEN");
    const pinned = copyTemplate();
    pinned.slots.push({ name: "pinnedRate", kind: "bps", default: 40, paths: ["/clauses/0/rule/bps"] });
    assertRefusal(validateTemplate(pinned), "SLOT_PATH_FORBIDDEN");
    const disguised = copyTemplate();
    disguised.slots.push({ name: "kitAuthor", kind: "party", default: "priya", paths: ["/clauses/0/to/party", "/parties/2/partyId"] });
    assertRefusal(validateTemplate(disguised), "SLOT_PATH_FORBIDDEN");
  });
  it("matching text in a clause ID, subject or role is NOT a party reference", () => {
    const t = copyTemplate("deck-milestones");
    t.slots.push({ name: "clauseName", kind: "party", default: "contractor", paths: ["/clauses/4/clauseId"] });
    assertRefusal(validateTemplate(t), "SLOT_PATH_FORBIDDEN");
    // The actual catalog validates although 'contractor' is also a clauseId,
    // 'lumber' is also a clauseId/subject, and 'insurer' is also a role.
    expect(validateTemplate(byId("deck-milestones").template).ok).toBe(true);
    expect(validateTemplate(byId("lab-assay").template).ok).toBe(true);
  });
  it("a slot at the wrong kind of leaf is not allowed", () => {
    const t = copyTemplate("guild-repair");
    t.slots.push({ name: "wrongKind", kind: "amount", default: "150", paths: ["/clauses/1/rule/bps"] });
    assertRefusal(validateTemplate(t), "SLOT_KIND_MISMATCH");
  });
  it("wrong defaults and nonexistent (but typed) positions refuse, not silently skip", () => {
    const wrong = tweak("spare-printer", 3, { name: "printPrice", kind: "amount", default: "25000001", paths: ["/units/0/gross"] });
    assertRefusal(validateTemplate(wrong), "SLOT_DEFAULT_MISMATCH");
    const missing = copyTemplate();
    missing.slots.push({ name: "missingUnit", kind: "amount", default: "99", paths: ["/units/99/gross"] });
    assertRefusal(validateTemplate(missing), "SLOT_DEFAULT_MISMATCH");
  });
  it("the payer slot must include /payer, even if partyId still matches", () => {
    const t = tweak("spare-printer", 0, { name: "buyer", kind: "party", default: "dana", paths: ["/parties/0/partyId"] });
    assertRefusal(validateTemplate(t), "SLOT_PATHS_INCOMPLETE");
  });
});

describe("instantiation, complete refusal vocabulary, and exact origin proof", () => {
  it("throws nothing on malformed params, including a throwing getter", () => {
    const getter: Record<string, unknown> = {};
    Object.defineProperty(getter, "printPrice", { enumerable: true, get() { throw new Error("should not be executed"); } });
    expect(() => instantiateTemplate(byId("spare-printer").template, getter)).not.toThrow();
    assertRefusal(instantiateTemplate(byId("spare-printer").template, getter), "PARAMS_INVALID");
    assertRefusal(instantiateTemplate(byId("spare-printer").template, new Date()), "PARAMS_INVALID");
    assertRefusal(instantiateTemplate(byId("spare-printer").template, []), "PARAMS_INVALID");
    const trap = new Proxy({ printPrice: "30000000" }, { getPrototypeOf() { throw new Error("proxy trap"); } });
    assertRefusal(instantiateTemplate(byId("spare-printer").template, trap), "PARAMS_INVALID");
  });
  it("an own __proto__ param remains an unknown own key", () => {
    const p = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(p, "__proto__", { value: "intruder", enumerable: true, configurable: true });
    const r = instantiateTemplate(byId("spare-printer").template, p);
    assertRefusal(r, "SLOT_UNKNOWN");
    if (!r.ok) expect(r.refusals.find((x) => x.code === "SLOT_UNKNOWN")!.path).toEqual(["params", "__proto__"]);
  });
  it("collision with an already-filled party is refused before IR or compiler work", () => {
    assertRefusal(instantiateTemplate(byId("guild-repair").template, { ana: "ben" }), "SLOT_ID_COLLISION");
    assertRefusal(instantiateTemplate(byId("deck-milestones").template, { buildStep: "m1-design" }), "SLOT_ID_COLLISION");
  });
  it("an otherwise typed parameter can break an IR refinement and is refused", () => {
    assertRefusal(instantiateTemplate(byId("lab-assay").template, { protocolBps: 0 }), "INSTANCE_SCHEMA_INVALID");
  });
  it("wrong scalar types cannot be interpreted as amounts, basis points or IDs", () => {
    const t = byId("print-and-mail").template;
    assertRefusal(instantiateTemplate(t, { mailGross: 9000000 }), "SLOT_VALUE_INVALID");
    assertRefusal(instantiateTemplate(t, { postageMarkupBps: "500" }), "SLOT_VALUE_INVALID");
    assertRefusal(instantiateTemplate(t, { composer: ["two", "parties"] }), "SLOT_VALUE_INVALID");
  });

  const provoke: Record<TemplateRefusalCode, () => { ok: boolean; refusals?: TemplateRefusal[] }> = {
    TEMPLATE_SCHEMA_INVALID: () => validateTemplate({ ...copyTemplate(), notInSchema: true }),
    SLOT_KIND_RESERVED: () => {
      const t = copyTemplate(); t.slots.push({ name: "licenseRef", kind: "license", default: "x@1", paths: ["/licenses/0/licenseId"] }); return validateTemplate(t);
    },
    SLOT_NAME_DUPLICATE: () => { const t = copyTemplate(); t.slots.push({ ...t.slots[0]! }); return validateTemplate(t); },
    SLOT_PATH_DUPLICATE: () => { const t = copyTemplate(); t.slots.push({ ...t.slots[0]!, name: "buyerAgain" }); return validateTemplate(t); },
    SLOT_PATH_FORBIDDEN: () => { const t = copyTemplate(); t.slots.push({ name: "bad", kind: "bps", default: 235, paths: ["/fee/feeBps"] }); return validateTemplate(t); },
    SLOT_KIND_MISMATCH: () => { const t = copyTemplate(); t.slots.push({ name: "wrong", kind: "amount", default: "150", paths: ["/clauses/1/rule/bps"] }); return validateTemplate(t); },
    SLOT_DEFAULT_MISMATCH: () => validateTemplate(tweak("spare-printer", 3, { name: "printPrice", kind: "amount", default: "999", paths: ["/units/0/gross"] })),
    SLOT_PATHS_INCOMPLETE: () => validateTemplate(tweak("spare-printer", 0, { name: "buyer", kind: "party", default: "dana", paths: ["/parties/0/partyId"] })),
    PARAMS_INVALID: () => instantiateTemplate(byId("spare-printer").template, null),
    SLOT_UNKNOWN: () => instantiateTemplate(byId("spare-printer").template, { payTo: "nope" }),
    SLOT_VALUE_INVALID: () => instantiateTemplate(byId("spare-printer").template, { printPrice: 100 }),
    SLOT_VALUE_ADDRESS: () => instantiateTemplate(byId("spare-printer").template, { buyer: "0x1111111111111111111111111111111111111111" }),
    SLOT_ID_COLLISION: () => instantiateTemplate(byId("guild-repair").template, { ana: "ben" }),
    INSTANCE_SCHEMA_INVALID: () => instantiateTemplate(byId("lab-assay").template, { protocolBps: 0 }),
    TEMPLATE_UNKNOWN: () => verifyTemplateOrigin(byId("spare-printer").template.body, { ...origin("spare-printer"), templateKey: "spare-printer@2" }),
    TEMPLATE_HASH_MISMATCH: () => verifyTemplateOrigin(byId("spare-printer").template.body, { ...origin("spare-printer"), templateHash: `0x${"0".repeat(64)}` }),
    TEMPLATE_ORIGIN_MISMATCH: () => {
      const a = copyAgreement(byId("spare-printer").template.body); a.units[0]!.gross = "30000000";
      return verifyTemplateOrigin(a, origin("spare-printer"));
    },
  };
  it("the closed list is exactly the set provoked by our refusal vectors", () => {
    const reported = new Set<TemplateRefusalCode>();
    expect(Object.keys(provoke).sort()).toEqual([...TEMPLATE_REFUSAL_CODES].sort());
    for (const code of TEMPLATE_REFUSAL_CODES) {
      const r = provoke[code]();
      assertRefusal(r, code);
      for (const x of resultCodes(r)) reported.add(x);
    }
    expect([...reported].sort()).toEqual([...TEMPLATE_REFUSAL_CODES].sort());
  });
  it("refusals are sorted by code and element-by-element path, without duplicate identities", () => {
    const t = copyTemplate();
    t.slots.push({ ...t.slots[0]!, name: "duplicated" }, { ...t.slots[0]!, name: "duplicated" });
    const r = validateTemplate(t);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const ids = r.refusals.map((x) => JSON.stringify([x.code, x.path]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.refusals.map((x) => x.code)).toEqual([...r.refusals.map((x) => x.code)].sort());
  });
  for (const id of keys) {
    it(`${id}: verifies origin at defaults and with the non-default fixture`, () => {
      const e = byId(id);
      const defaults = instantiateTemplate(e.template, {});
      expect(defaults.ok).toBe(true);
      if (!defaults.ok) return;
      expect(verifyTemplateOrigin(defaults.agreement, origin(id))).toEqual({ ok: true });
      const params = fixture.templates[id]!.nonDefault.params;
      const filled = instantiateTemplate(e.template, params);
      expect(filled.ok).toBe(true);
      if (filled.ok) expect(verifyTemplateOrigin(filled.agreement, origin(id, params))).toEqual({ ok: true });
    });
  }
  it("origin propagates the instantiation refusal instead of reclassifying bad params", () => {
    const e = byId("spare-printer");
    const params = { printPrice: 30000000 };
    expect(verifyTemplateOrigin(e.template.body, origin("spare-printer", params))).toEqual(instantiateTemplate(e.template, params));
    const getter: Record<string, unknown> = {};
    Object.defineProperty(getter, "printPrice", { enumerable: true, get() { throw new Error("bad params"); } });
    assertRefusal(verifyTemplateOrigin(e.template.body, origin("spare-printer", getter)), "PARAMS_INVALID");
  });
  it("origin rejects a modified amount even when the agreement remains an IR object", () => {
    const a = copyAgreement(byId("spare-printer").template.body);
    a.units[0]!.gross = "30000000";
    assertRefusal(verifyTemplateOrigin(a, origin("spare-printer")), "TEMPLATE_ORIGIN_MISMATCH");
  });
  it("origin refuses a wrong hash and a nonexistent version before instantiating", () => {
    const a = byId("spare-printer").template.body;
    assertRefusal(verifyTemplateOrigin(a, { ...origin("spare-printer"), templateHash: "wrong" }), "TEMPLATE_HASH_MISMATCH");
    assertRefusal(verifyTemplateOrigin(a, { ...origin("spare-printer"), templateKey: "spare-printer@2" }), "TEMPLATE_UNKNOWN");
  });
  it("deep-frozen template and params are unchanged, and instantiation is deterministic", () => {
    const template = freezeAll(copyTemplate("guild-repair"));
    const params = freezeAll({ repairGross: "200000000", inspectionBps: 200 });
    const beforeTemplate = canonicalize(template);
    const beforeParams = canonicalize(params);
    const a = instantiateTemplate(template, params);
    const b = instantiateTemplate(template, params);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(canonicalize(a.agreement)).toBe(canonicalize(b.agreement));
    expect(canonicalize(template)).toBe(beforeTemplate);
    expect(canonicalize(params)).toBe(beforeParams);
  });
});

describe("review pins: row-exact unbinding, refusal order, each fixed-leaf rule, hostile catalogs", () => {
  it("a swap of two party ids leaves neither row with its old address or label", () => {
    const r = instantiateTemplate(byId("spare-printer").template, { buyer: "sam", printerOwner: "dana" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agreement.payer).toBe("sam");
    expect(r.agreement.parties.slice(0, 2)).toEqual([
      { partyId: "sam", label: "sam", kind: "person", payTo: null },
      { partyId: "dana", label: "dana", kind: "person", payTo: null },
    ]);
  });
  it("a valid template whose party slots are out of row order still unbinds the rebound row", () => {
    const t = copyTemplate();
    [t.slots[0], t.slots[1]] = [t.slots[1]!, t.slots[0]!];
    expect(validateTemplate(t).ok).toBe(true);
    const r = instantiateTemplate(t, { printerOwner: "dana", buyer: "dana-2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agreement.parties.slice(0, 2)).toEqual([
      { partyId: "dana-2", label: "dana-2", kind: "person", payTo: null },
      { partyId: "dana", label: "dana", kind: "person", payTo: null },
    ]);
  });
  it("refusals with one code sort by path, not in the order they were found", () => {
    const t = copyTemplate();
    t.slots.push(
      { name: "zeta", kind: "bps", default: 235, paths: ["/fee/feeBps"] },
      { name: "alpha", kind: "bps", default: 40, paths: ["/clauses/0/rule/bps"] },
    );
    const r = validateTemplate(t);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusals.map((x) => [x.code, x.path])).toEqual([
      ["SLOT_PATH_FORBIDDEN", ["slots", "alpha", "/clauses/0/rule/bps"]],
      ["SLOT_PATH_FORBIDDEN", ["slots", "zeta", "/fee/feeBps"]],
    ]);
  });
  it("origin judges the key and the hash before it reads the params", () => {
    const a = byId("spare-printer").template.body;
    const bad = { printPrice: 30000000 };
    expect(resultCodes(verifyTemplateOrigin(a, { ...origin("spare-printer", bad), templateHash: "wrong" }))).toEqual(["TEMPLATE_HASH_MISMATCH"]);
    expect(resultCodes(verifyTemplateOrigin(a, { ...origin("spare-printer", bad), templateKey: "spare-printer@2" }))).toEqual(["TEMPLATE_UNKNOWN"]);
  });
  it("a license-bound rule leaf and a schedule-pinned rule leaf are each fixed on their own", () => {
    const licensed = copyTemplate("lab-assay"); // clause 1: underLicense set, rateSource null
    licensed.slots.push({ name: "modelBps", kind: "bps", default: 300, paths: ["/clauses/1/rule/bps"] });
    expect(resultCodes(validateTemplate(licensed))).toEqual(["SLOT_PATH_FORBIDDEN"]);
    const pinned = copyTemplate(); // clause 0 keeps its rateSource but loses its license
    pinned.body.clauses[0]!.underLicense = null;
    pinned.slots.push({ name: "pinnedRate", kind: "bps", default: 40, paths: ["/clauses/0/rule/bps"] });
    expect(resultCodes(validateTemplate(pinned))).toEqual(["SLOT_PATH_FORBIDDEN"]);
  });
  it("a license distribution member cannot be a party slot", () => {
    const t = copyTemplate("lab-assay");
    t.slots.push({ name: "datasetA", kind: "party", default: "dataset-a", paths: ["/parties/3/partyId", "/splits/0/members/1/to/party"] });
    const r = validateTemplate(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals.map((x) => [x.code, x.path])).toEqual([["SLOT_PATH_FORBIDDEN", ["slots", "datasetA"]]]);
  });
  it("an unsorted or repeated pointer list is a schema refusal", () => {
    const unsorted = tweak("spare-printer", 0, { name: "buyer", kind: "party", default: "dana", paths: ["/payer", "/parties/0/partyId"] });
    expect(resultCodes(validateTemplate(unsorted))).toEqual(["TEMPLATE_SCHEMA_INVALID"]);
    const repeated = tweak("spare-printer", 3, { name: "printPrice", kind: "amount", default: "25000000", paths: ["/units/0/gross", "/units/0/gross"] });
    expect(resultCodes(validateTemplate(repeated))).toEqual(["TEMPLATE_SCHEMA_INVALID"]);
  });
  it("a caller-supplied catalog whose entry throws is refused, never thrown", () => {
    const e = byId("spare-printer");
    const getter = [{
      get template() { return e.template; },
      get templateHash(): `0x${string}` { throw new Error("hostile catalog"); },
      compileOptions: e.compileOptions,
    }];
    expect(resultCodes(verifyTemplateOrigin(e.template.body, origin("spare-printer"), getter))).toEqual(["TEMPLATE_UNKNOWN"]);
    const trap = [new Proxy({}, {
      get(_t, k) { if (k === "template") return e.template; throw new Error("hostile catalog"); },
    })] as unknown as Parameters<typeof verifyTemplateOrigin>[2];
    expect(resultCodes(verifyTemplateOrigin(e.template.body, origin("spare-printer"), trap))).toEqual(["TEMPLATE_UNKNOWN"]);
  });
  it("section 11's schema, value and origin details hold exactly as stated", () => {
    const badEscape = tweak("spare-printer", 3, { name: "printPrice", kind: "amount", default: "25000000", paths: ["/units/0~2gross"] });
    expect(resultCodes(validateTemplate(badEscape))).toEqual(["TEMPLATE_SCHEMA_INVALID"]);
    const badName = tweak("spare-printer", 3, { name: "Print-price", kind: "amount", default: "25000000", paths: ["/units/0/gross"] });
    expect(resultCodes(validateTemplate(badName))).toEqual(["TEMPLATE_SCHEMA_INVALID"]);
    expect(resultCodes(validateTemplate({ ...copyTemplate(), version: 2 ** 53 }))).toEqual(["TEMPLATE_SCHEMA_INVALID"]);
    expect(resultCodes(instantiateTemplate(byId("guild-repair").template, { inspectionBps: 10001 }))).toEqual(["SLOT_VALUE_INVALID"]);
    const extra = tweak("spare-printer", 1, { name: "printerOwner", kind: "party", default: "sam", paths: ["/clauses/0/to/party", "/clauses/1/to/party", "/parties/1/partyId"] });
    const r = validateTemplate(extra);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusals.map((x) => [x.code, x.path])).toEqual([
        ["SLOT_DEFAULT_MISMATCH", ["slots", "printerOwner", "/clauses/0/to/party"]],
        ["SLOT_PATHS_INCOMPLETE", ["slots", "printerOwner"]],
      ]);
    }
    const e = byId("spare-printer");
    expect(verifyTemplateOrigin({ ...e.template.body, unread: undefined }, origin("spare-printer"))).toEqual({ ok: true });
    expect(resultCodes(verifyTemplateOrigin(e.template.body, { ...origin("spare-printer"), templateHash: e.templateHash.toUpperCase().replace("0X", "0x") }))).toEqual(["TEMPLATE_HASH_MISMATCH"]);
    const accessor = Object.defineProperty({ templateHash: e.templateHash, params: {} }, "templateKey", { enumerable: true, get: () => "spare-printer@1" });
    expect(resultCodes(verifyTemplateOrigin(e.template.body, accessor as never))).toEqual(["TEMPLATE_UNKNOWN"]);
  });
});
