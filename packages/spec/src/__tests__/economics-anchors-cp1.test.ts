import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../util/canonical.js";
import {
  BIND_REFUSAL_CODES,
  netSplitterFor,
  type IpAnchor,
  type PlanSplitResult,
  type PlanSplitUnit,
  type ServerEconomicsFacts,
} from "../economics/bind.js";
import { compileEconomics } from "../economics/compile.js";
import {
  AGREEMENT_TEMPLATES,
  EXAMPLE_AGREEMENTS,
  exampleIncompatibleLicense,
  exampleSparePrinter,
  PRINTER_KIT_SCHEDULE,
} from "../economics/examples.js";
import { domainHash, licenseTermsHash, normalizeAgreement } from "../economics/hash.js";
import {
  LICENSE_TERMS_DOMAIN as LICENSE_TERMS_DOMAIN_FROM_INDEX,
  licenseTermsHash as licenseTermsHashFromIndex,
} from "../economics/index.js";
import { kitSplitAgreement, licenseHash } from "../economics/kits.js";
import type { Clause, EconomicAgreement, License } from "../economics/types.js";
import type { AcceptedAgreementHashes } from "../economics/verify.js";
import { baseAgreement } from "./economics-helpers.js";

/** Server-owned registry, clock and unit facts for an agreement. */
function server(ag: EconomicAgreement, over: Partial<ServerEconomicsFacts> = {}): ServerEconomicsFacts {
  return {
    feeBps: ag.fee.feeBps,
    feeRecipient: ag.fee.feeRecipient ?? "0x0000000000000000000000000000000000000000",
    currency: { code: "USDC", decimals: 6 },
    now: ag.asOf + 600,
    intendedUse: structuredClone(ag.use),
    licenses: structuredClone(ag.licenses),
    parties: ag.parties.flatMap((p) => (p.payTo === null ? [] : [{ partyId: p.partyId, payTo: p.payTo }])),
    unitFacts: Object.fromEntries(ag.units.map((u) => [u.unitRef, { components: structuredClone(u.components), measures: structuredClone(u.measures) }])),
    schedules: [PRINTER_KIT_SCHEDULE],
    forbiddenRecipients: ["0x00000000000000000000000000000000000e5c0f"],
    ...over,
  };
}

/** The accepted-plan compiler's units, with a minimal covered operator quote. */
function planUnits(ag: EconomicAgreement): PlanSplitUnit[] {
  const compiled = compileEconomics(ag, { schedules: [PRINTER_KIT_SCHEDULE] });
  return ag.units.map((unit) => {
    const g = BigInt(unit.gross);
    const f = (g * BigInt(ag.fee.feeBps)) / 10000n;
    const payoutAddress = compiled.ok
      ? compiled.units.find((u) => u.unitRef === unit.unitRef)?.payouts[0]?.recipient ?? "0x0000000000000000000000000000000000000abc"
      : "0x0000000000000000000000000000000000000abc";
    return { nodeId: unit.unitRef, operator: payoutAddress, payoutAddress, quote: 1n, g, f, n: g - f };
  });
}

const AG = exampleSparePrinter();
const L2 = structuredClone(AG.licenses[0]!);
const L1: License = { ...L2, version: 1 };
const L3: License = { ...L2, version: 3 };
const LX: License = { ...L2, licenseId: "lic-other-kit", subject: "kit:other@1" };
const PRIYA = "0x00000000000000000000000000000000009a1a03";
const T2 = "0xe4ca059e69e9c17493bc98d3de8eb34ead24e8a46aab97f64af2ebb3c9adc711";
const T3 = "0xfe48cbfb8e5f76f0772cc9e23f1d5030adaf2a1d583cdaa5d16f64c3ae3d37df";
const TX = "0x0205cb741a5a806350bd7bc9ab46bba921f88620ef414ebdbdc1a45af23b2411";

function anchor(version: number, termsHash: string, payTo: string): IpAnchor {
  return {
    subject: "kit:octoprint-fdm@2",
    licenseId: "lic-octoprint-fdm-kit",
    version,
    termsHash,
    nft: { chainId: 84532, contract: "0x00000000000000000000000000000000000c0de1", tokenId: "7" },
    payTo,
  };
}

/** The unknown input deliberately permits malformed anchors at the runtime validation boundary. */
function facts(licenses: readonly License[], anchors: unknown = "none", over: Partial<ServerEconomicsFacts> = {}): ServerEconomicsFacts {
  return server(AG, {
    licenses,
    ...(anchors === "none" ? {} : { ipAnchors: anchors as readonly IpAnchor[] }),
    ...over,
  });
}

function bind(agreement: EconomicAgreement, f: ServerEconomicsFacts, accepted: AcceptedAgreementHashes | null = null): PlanSplitResult {
  return netSplitterFor({ agreement, accepted, server: f })(planUnits(AG));
}

function answer(result: PlanSplitResult): string {
  return result.ok ? "ok" : result.code;
}

function successful(result: PlanSplitResult): Extract<PlanSplitResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a split, got ${result.code}`);
  return result;
}

const compiledOwn = compileEconomics(AG, { schedules: [PRINTER_KIT_SCHEDULE] });
if (!compiledOwn.ok) throw new Error("the spare printer fixture must compile");
const OWN: AcceptedAgreementHashes = {
  agreementHash: compiledOwn.agreementHash,
  economicTermsHash: compiledOwn.economicTermsHash,
  rightsTermsHash: compiledOwn.rightsTermsHash,
};

function baseline(): PlanSplitResult {
  return bind(AG, facts([L2]));
}

function anchored(): PlanSplitResult {
  return bind(AG, facts([L2], [anchor(2, T2, PRIYA)]));
}

describe("economics IP anchors", () => {
  it("CP1 N1: a registered older license refuses before hashing, with or without accepted hashes", () => {
    const f = facts([L2, L3], [anchor(3, T3, PRIYA)]);
    for (const accepted of [null, OWN]) {
      expect(answer(bind(AG, f, accepted))).toBe("economics:LICENSE_NOT_CURRENT:lic-octoprint-fdm-kit@2");
    }
  });

  it("CP1 N2: absent and empty anchor lists preserve the same successful split", () => {
    const absent = bind(AG, facts([L2], "none"));
    const empty = bind(AG, facts([L2], []));
    expect(answer(absent)).toBe("ok");
    expect(answer(empty)).toBe("ok");
    expect(empty).toEqual(absent);
  });

  it("CP1 B1: a current anchor preserves both accepted and immediate payouts", () => {
    const withoutAnchors = successful(baseline());
    for (const accepted of [null, OWN]) {
      const result = successful(bind(AG, facts([L2], [anchor(2, T2, PRIYA)]), accepted));
      expect(result).toEqual(withoutAnchors);
      expect(result.units).toHaveLength(1);
      expect(result.units[0]!.unitRef).toBe("print");
      expect(result.units[0]!.payouts).toHaveLength(2);
      expect(result.units[0]!.payouts).toEqual(expect.arrayContaining([
        { recipient: PRIYA, amount: "100000" },
        { recipient: "0x00000000000000000000000000000000005a0002", amount: "24312500" },
      ]));
    }
  });

  it("CP1 B2: anchor payout wallets are compared after lowercasing", () => {
    const result = bind(AG, facts([L2], [anchor(2, T2, "0x00000000000000000000000000000000009A1A03")]));
    expect(answer(result)).toBe("ok");
    expect(result).toEqual(anchored());
  });

  it("CP1 R1: a used component selects its anchor before license id and version checks", () => {
    const L2b: License = { ...L2, licenseId: "lic-octoprint-fdm-kit-b" };
    const otherId = { ...anchor(2, T2, PRIYA), licenseId: L2b.licenseId };
    expect(answer(bind(AG, facts([L2, L2b], [otherId])))).toBe("economics:LICENSE_NOT_CURRENT:lic-octoprint-fdm-kit@2");
    expect(answer(bind(AG, facts([L1, L2], [anchor(1, T2, PRIYA)])))).toBe("economics:LICENSE_NOT_CURRENT:lic-octoprint-fdm-kit@2");
  });

  it("CP1 R2: a current license must match the terms hash, not the kit license hash", () => {
    const kitHash = licenseHash(L2);
    if (!kitHash.ok) throw new Error(kitHash.reason);
    for (const hash of [T3, kitHash.hash]) {
      expect(answer(bind(AG, facts([L2], [anchor(2, hash, PRIYA)])))).toBe("economics:LICENSE_MISMATCH:lic-octoprint-fdm-kit@2");
    }
  });

  it("CP1 R3: terms are checked before the licensor's anchor payout wallet", () => {
    const otherWallet = "0x00000000000000000000000000000000009a1a04";
    expect(answer(bind(AG, facts([L2], [anchor(2, T2, otherWallet)])))).toBe("economics:PARTY_MISMATCH:priya");
    expect(answer(bind(AG, facts([L2], [anchor(2, T3, otherWallet)])))).toBe("economics:LICENSE_MISMATCH:lic-octoprint-fdm-kit@2");
  });

  it("CP1 R4: registry authority requires a matching anchor", () => {
    const AGr = structuredClone(AG);
    AGr.licenses[0]!.authority = "registry-anchored";
    expect(answer(bind(AGr, facts(AGr.licenses)))).toBe("economics:LICENSE_UNANCHORED:lic-octoprint-fdm-kit@2");
    expect(answer(bind(AGr, facts(AGr.licenses, [anchor(2, T2, PRIYA)])))).toBe("ok");
  });

  it("CP1 R5: external attestation is refused after the used-component anchor checks", () => {
    const AGx = structuredClone(AG);
    AGx.licenses[0]!.authority = "externally-attested";
    for (const anchors of ["none", [anchor(2, T2, PRIYA)]]) {
      expect(answer(bind(AGx, facts(AGx.licenses, anchors)))).toBe("economics:LICENSE_ATTESTATION_UNSUPPORTED:lic-octoprint-fdm-kit@2");
    }
    expect(answer(bind(AGx, facts([...AGx.licenses, L3], [anchor(3, T3, PRIYA)])))).toBe("economics:LICENSE_NOT_CURRENT:lic-octoprint-fdm-kit@2");
  });

  it("CP1 R6: a used anchored component with no cited license still reaches the compiler", () => {
    const AGo = structuredClone(AG);
    AGo.licenses = [LX];
    AGo.clauses.find((clause) => clause.clauseId === "kit-royalty")!.underLicense = { licenseId: "lic-other-kit", version: 2 };
    for (const anchors of [[anchor(2, T2, PRIYA)], "none"]) {
      expect(answer(bind(AGo, facts([L2, LX], anchors)))).toBe("economics:COMPILE_REFUSED:LICENSE_PAYMENT_UNMATCHED,RIGHTS_UNKNOWN");
    }
  });

  it("CP1 R7: even an unused cited registry license needs its own matching terms hash", () => {
    const LXr: License = { ...LX, authority: "registry-anchored" };
    const AGu = { ...structuredClone(AG), licenses: [L2, LXr] };
    const anchorX = (hash: string): IpAnchor => ({ ...anchor(2, hash, PRIYA), subject: "kit:other@1", licenseId: "lic-other-kit" });
    expect(answer(bind(AGu, facts([L2, LXr], [anchorX(T2)])))).toBe("economics:LICENSE_UNANCHORED:lic-other-kit@2");
    const result = successful(bind(AGu, facts([L2, LXr], [anchorX(TX)])));
    expect(result.units).toEqual(successful(anchored()).units);
  });

  it("CP1 O1: anchor versions are checked before the compiler's license validity window", () => {
    const AGe = structuredClone(AG);
    AGe.licenses[0]!.validUntil = AG.asOf - 1;
    expect(answer(bind(AGe, facts([...AGe.licenses, L3], [anchor(3, T3, PRIYA)])))).toBe("economics:LICENSE_NOT_CURRENT:lic-octoprint-fdm-kit@2");
    expect(answer(bind(AGe, facts(AGe.licenses)))).toBe("economics:COMPILE_REFUSED:LICENSE_NOT_IN_FORCE");
  });

  it("CP1 O2: registry license copies are checked before anchor versions", () => {
    expect(answer(bind(AG, facts([L3], [anchor(3, T3, PRIYA)])))).toBe("economics:LICENSE_NOT_REGISTERED:lic-octoprint-fdm-kit@2");
  });

  it("CP1 O3: server unit facts are checked before anchor versions", () => {
    const unitFacts = {
      ...structuredClone(server(AG).unitFacts),
      print: { components: [{ ref: "kit:octoprint-fdm@2", uses: "2" }], measures: [] },
    };
    expect(answer(bind(AG, facts([L2, L3], [anchor(3, T3, PRIYA)], { unitFacts })))).toBe("economics:UNIT_FACTS_MISMATCH:print");
  });

  it("CP1 F1: terms hashes require exactly 64 lowercase hexadecimal digits", () => {
    for (const hash of [T2.replace("e", "E"), T2.slice(0, -1)]) {
      expect(answer(bind(AG, facts([L2, L3], [anchor(2, hash, PRIYA)])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.termsHash");
    }
  });

  it("CP1 F2: payout and NFT contract addresses are validated at their own paths", () => {
    expect(answer(bind(AG, facts([L2, L3], [anchor(2, T2, "0x1234")])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.payTo");
    const invalidContract = anchor(2, T2, PRIYA);
    invalidContract.nft.contract = "0x1234";
    expect(answer(bind(AG, facts([L2, L3], [invalidContract])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.nft.contract");
  });

  it("CP1 F3: NFT chain ids are positive integers and token ids are canonical amounts", () => {
    for (const chainId of [0, 1.5]) {
      const invalidChain = anchor(2, T2, PRIYA);
      invalidChain.nft.chainId = chainId;
      expect(answer(bind(AG, facts([L2, L3], [invalidChain])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.nft.chainId");
    }
    for (const tokenId of ["01", "1".repeat(79)]) {
      const invalidToken = anchor(2, T2, PRIYA);
      invalidToken.nft.tokenId = tokenId;
      expect(answer(bind(AG, facts([L2, L3], [invalidToken])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.nft.tokenId");
    }
    const zeroToken = anchor(2, T2, PRIYA);
    zeroToken.nft.tokenId = "0";
    expect(answer(bind(AG, facts([L2, L3], [zeroToken])))).toBe("ok");
  });

  it("CP1 F4: license versions, license ids and subjects use the license schema rules", () => {
    expect(answer(bind(AG, facts([L2, L3], [anchor(0, T2, PRIYA)])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.version");
    expect(answer(bind(AG, facts([L2, L3], [{ ...anchor(2, T2, PRIYA), licenseId: "" }])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.licenseId");
    expect(answer(bind(AG, facts([L2, L3], [{ ...anchor(2, T2, PRIYA), subject: "" }])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.subject");
  });

  it("CP1 F5: anchor and NFT objects are strict and anchors must be an array", () => {
    expect(answer(bind(AG, facts([L2, L3], [{ ...anchor(2, T2, PRIYA), note: "x" }])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0");
    const valid = anchor(2, T2, PRIYA);
    expect(answer(bind(AG, facts([L2, L3], [{ ...valid, nft: { ...valid.nft, note: "x" } }])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0.nft");
    expect(answer(bind(AG, facts([L2, L3], {})))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors");
  });

  it("CP1 F6: a subject cannot have two anchors", () => {
    expect(answer(bind(AG, facts([L2, L3], [anchor(2, T2, PRIYA), anchor(2, T2, PRIYA)])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors");
  });

  it("CP1 F6b: a repeated subject is refused wherever its copies sit and however they differ", () => {
    const a2 = anchor(2, T2, PRIYA);
    const aX = { ...anchor(2, TX, PRIYA), subject: "kit:other@1", licenseId: "lic-other-kit" };
    const LB: License = { ...L2, licenseId: "lic-octoprint-fdm-alt", version: 7 };
    const aB = { ...anchor(7, licenseTermsHash(LB), "0x00000000000000000000000000000000009a1a04"), licenseId: "lic-octoprint-fdm-alt" };
    aB.nft.tokenId = "8";
    for (const f of [
      facts([L2, LX], [a2, aX, a2]),
      facts([L2, LB], [aB, a2]),
      facts([L2, LX], [aX, a2, a2]),
      facts([L2, LX], [a2, a2, aX]),
    ]) {
      expect(answer(bind(AG, f, null))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors");
    }
  });

  it("CP1 F7: every anchor must name a registered license for the same subject", () => {
    expect(answer(bind(AG, facts([L2, L3], [anchor(9, T2, PRIYA)])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0");
    expect(answer(bind(AG, facts([L2, L3], [{ ...anchor(2, T2, PRIYA), subject: "kit:other@1" }])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.0");
    const missing = { ...anchor(9, T2, PRIYA), subject: "kit:other@1", licenseId: "lic-other-kit" };
    expect(answer(bind(AG, facts([L2, L3], [anchor(2, T2, PRIYA), missing])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.1");
  });

  it("CP1 F8: unused anchors are validated and anchor lists are capped at 1024", () => {
    const unusedMalformed = { ...anchor(2, "0x12", PRIYA), subject: "kit:other@1", licenseId: "lic-other-kit" };
    expect(answer(bind(AG, facts([L2, LX], [anchor(2, T2, PRIYA), unusedMalformed])))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors.1.termsHash");
    expect(answer(bind(AG, facts([L2, LX], Array.from({ length: 1025 }, () => anchor(2, T2, PRIYA)))))).toBe("economics:SERVER_FACTS_INVALID:ipAnchors");
  });

  it("CP1 H1: literal terms hash vectors cover license versions two and three", () => {
    expect(licenseTermsHash(L2)).toBe(T2);
    expect(licenseTermsHash(L3)).toBe(T3);
  });

  it("CP1 H2: terms hash is domain-separated SHA-256 of canonical normalized terms", () => {
    const normalized: Partial<License> = normalizeAgreement(AG).licenses[0]!;
    delete normalized.authority;
    expect(licenseTermsHash(L2)).toBe(domainHash("PCC:license-terms:v1", normalized));
    const digest = sha256(new TextEncoder().encode("PCC:license-terms:v1" + "\n" + canonicalize(normalized)));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(licenseTermsHash(L2)).toBe(`0x${hex}`);
  });

  it("CP1 H3: set order in fields of use and regions does not change the terms hash", () => {
    const forward: License = { ...L2, grants: { ...L2.grants, fieldsOfUse: ["fou-a", "fou-b"], regions: ["r-a", "r-b"] } };
    const reversed: License = { ...forward, grants: { ...forward.grants, fieldsOfUse: ["fou-b", "fou-a"], regions: ["r-b", "r-a"] } };
    expect(licenseTermsHash(forward)).toBe(licenseTermsHash(reversed));
  });

  it("CP1 H4: authority is excluded while all eleven license term fields are covered", () => {
    for (const authority of ["self-asserted", "counterparty-accepted", "registry-anchored", "externally-attested"] as const) {
      expect(licenseTermsHash({ ...L2, authority })).toBe(T2);
    }
    const changed: License[] = [
      { ...L2, licenseId: "lic-changed" },
      { ...L2, version: 3 },
      { ...L2, label: "Changed terms" },
      { ...L2, licensor: "another-licensor" },
      { ...L2, subject: "kit:changed@1" },
      { ...L2, class: "open" },
      { ...L2, shareAlikeTag: "changed-tag" },
      { ...L2, grants: { ...L2.grants, commercialUse: !L2.grants.commercialUse } },
      { ...L2, requires: { ...L2.requires, attribution: !L2.requires.attribution } },
      { ...L2, validFrom: AG.asOf },
      { ...L2, validUntil: AG.asOf + 1 },
    ];
    expect(changed).toHaveLength(11);
    const hashes = changed.map(licenseTermsHash);
    for (const hash of hashes) expect(hash).not.toBe(T2);
    expect(new Set(hashes).size).toBe(11);
  });

  it("CP1 H5: the economics barrel exports the exact terms domain and hash function", () => {
    expect(LICENSE_TERMS_DOMAIN_FROM_INDEX).toBe("PCC:license-terms:v1");
    expect(licenseTermsHashFromIndex).toBe(licenseTermsHash);
  });

  it("CP1 T1: downstream and metered clauses retain the exact OD-4 refusal code and words", () => {
    const downstream: Clause = {
      clauseId: "future",
      label: "5% of all future revenue",
      role: "integrator",
      to: { party: "seller" },
      subject: null,
      appliesTo: { allUnits: true },
      underLicense: null,
      rule: { kind: "downstream", bps: 500, horizon: "forever" },
    };
    const metered: Clause = { ...downstream, rule: { kind: "metered", rate: "100", meter: "pages" } };
    for (const clause of [downstream, metered]) {
      const result = compileEconomics(baseAgreement({ clauses: [...baseAgreement().clauses, clause] }));
      if (result.ok) throw new Error(`expected the ${clause.rule.kind} clause to be refused`);
      expect(result.refusals).toContainEqual({
        code: "ECONOMICS_UNDECIDED_OD4",
        message: `clause "future" is ${clause.rule.kind}: cross-job metering and a share of later revenue aren't supported yet, so the clause is refused, not approximated. Under OD-4, an IP's royalties are paid in each contract that uses the IP`,
        path: ["clause", "future"],
      });
    }
  });

  it("CP1 L1: examples, templates and kit agreements claim no unverified higher authority", () => {
    const agreements = [
      ...EXAMPLE_AGREEMENTS.map((build) => build()),
      exampleIncompatibleLicense(),
      ...AGREEMENT_TEMPLATES.map((entry) => entry.build()),
      kitSplitAgreement(25_000_000n, { currency: { code: "USDC", decimals: 6 }, feeBps: 235, licenseBps: 50, lineage: ["carol", "bob", "ann"] }),
    ];
    const licenses = agreements.flatMap((agreement) => agreement.licenses);
    expect(licenses.length).toBeGreaterThanOrEqual(5);
    for (const license of licenses) expect(["registry-anchored", "externally-attested"]).not.toContain(license.authority);
  });

  it("CP1 C1: the binding refusal catalog includes the three anchor refusals in order", () => {
    expect(BIND_REFUSAL_CODES).toEqual([
      "SERVER_FACTS_INVALID",
      "PLAN_UNITS_INVALID",
      "SCHEMA_INVALID",
      "AGREEMENT_HASH_MISMATCH",
      "FEE_MISMATCH",
      "CURRENCY_MISMATCH",
      "AS_OF_OUT_OF_WINDOW",
      "OFFER_EXPIRED",
      "USE_MISMATCH",
      "LICENSE_NOT_REGISTERED",
      "LICENSE_MISMATCH",
      "PARTY_NOT_REGISTERED",
      "PARTY_MISMATCH",
      "UNIT_SET_MISMATCH",
      "GROSS_MISMATCH",
      "UNIT_FACTS_MISMATCH",
      "QUOTE_NOT_COVERED",
      "LICENSE_NOT_CURRENT",
      "LICENSE_UNANCHORED",
      "LICENSE_ATTESTATION_UNSUPPORTED",
      "COMPILE_REFUSED",
      "FEE_RULE_DIVERGED",
      "OPERATOR_BELOW_QUOTE",
    ]);
  });
});
