/**
 * Canonical form and hashes for economic agreements (docs/ECONOMIC_AGREEMENTS.md §6).
 *
 *   H(domain, value) = "0x" + hex(sha256(utf8(domain) ‖ 0x0a ‖ utf8(canonicalize(value))))
 *
 * Rights facts and payment facts hash separately, so a change to one never hides inside the other:
 *   rightsTermsHash   = H("PCC:rights-terms:v1",       { licenses, use })
 *   economicTermsHash = H("PCC:economic-terms:v1",     { currency, payer, parties, units, splits, clauses, fee })
 *   agreementHash     = H("PCC:economic-agreement:v1", { agreementId, version, supersedes, asOf, terms,
 *                                                        economicTermsHash, rightsTermsHash })
 *
 * `@noble/hashes` keeps this browser-safe, so a product surface can recompute the hash it displays.
 */

import { sha256 } from "@noble/hashes/sha256";
import { canonicalize } from "../util/canonical.js";
import type { EconomicAgreement, License, RequirableRule, Rule, Split, Unit } from "./types.js";

export const RIGHTS_TERMS_DOMAIN = "PCC:rights-terms:v1";
export const ECONOMIC_TERMS_DOMAIN = "PCC:economic-terms:v1";
export const AGREEMENT_DOMAIN = "PCC:economic-agreement:v1";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Domain-separated sha256 over the canonical JSON of `value`. */
export function domainHash(domain: string, value: unknown): `0x${string}` {
  const body = encoder.encode(`${domain}\n${canonicalize(value)}`);
  return `0x${toHex(sha256(body))}`;
}

/** Plain string order. Every compared string is ASCII (ids, lowercase hex), so this is byte order. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function payeeKey(to: { party: string } | { split: string }): string {
  return "party" in to ? `party:${to.party}` : `split:${to.split}`;
}

function sortedIdSet(values: readonly string[]): string[] {
  return [...values].sort(cmpStr);
}

function normalizeRule<R extends Rule | RequirableRule>(r: R): R {
  if (r.kind === "percent" && r.rateSource !== null) {
    return { ...r, rateSource: { ...r.rateSource, scheduleHash: r.rateSource.scheduleHash.toLowerCase() } };
  }
  if (r.kind === "percent_by_schedule") return { ...r, scheduleHash: r.scheduleHash.toLowerCase() };
  return r;
}

function normalizeLicense(l: License): License {
  return {
    ...l,
    grants: {
      ...l.grants,
      fieldsOfUse: sortedIdSet(l.grants.fieldsOfUse),
      regions: sortedIdSet(l.grants.regions),
    },
    requires: {
      attribution: l.requires.attribution,
      payments: [...l.requires.payments]
        .map((p) => ({
          ...p,
          payee:
            "distribution" in p.payee
              ? { distribution: [...p.payee.distribution].sort((a, b) => cmpStr(a.party, b.party)) }
              : p.payee,
          rule: normalizeRule(p.rule),
        }))
        .sort((a, b) => cmpStr(a.requirementId, b.requirementId)),
    },
  };
}

function normalizeUnit(u: Unit): Unit {
  return {
    ...u,
    components: [...u.components].sort((a, b) => cmpStr(a.ref, b.ref)),
    measures: [...u.measures].sort((a, b) => cmpStr(a.key, b.key)),
  };
}

function normalizeSplit(s: Split): Split {
  return { ...s, members: [...s.members].sort((a, b) => cmpStr(payeeKey(a.to), payeeKey(b.to))) };
}

/**
 * The canonical form (§6): lowercase addresses and hashes, every set-like array sorted. The result
 * is what the compiler reads and what the hashes cover, so an agent's array order changes nothing.
 * The input must already have passed `EconomicAgreementSchema`.
 */
export function normalizeAgreement(a: EconomicAgreement): EconomicAgreement {
  const lower = (s: string) => s.toLowerCase();
  return {
    schema: a.schema,
    agreementId: a.agreementId,
    version: a.version,
    supersedes: a.supersedes === null ? null : lower(a.supersedes),
    asOf: a.asOf,
    currency: { code: a.currency.code, decimals: a.currency.decimals },
    payer: a.payer,
    parties: a.parties
      .map((p) => ({ ...p, payTo: p.payTo === null ? null : lower(p.payTo) }))
      .sort((x, y) => cmpStr(x.partyId, y.partyId)),
    units: a.units.map(normalizeUnit).sort((x, y) => cmpStr(x.unitRef, y.unitRef)),
    splits: a.splits.map(normalizeSplit).sort((x, y) => cmpStr(x.splitId, y.splitId)),
    clauses: a.clauses
      .map((c) => {
        const appliesTo = "units" in c.appliesTo ? { units: sortedIdSet(c.appliesTo.units) } : c.appliesTo;
        return { ...c, appliesTo, rule: normalizeRule(c.rule) };
      })
      .sort((x, y) => cmpStr(x.clauseId, y.clauseId)),
    licenses: a.licenses
      .map(normalizeLicense)
      .sort((x, y) => cmpStr(x.licenseId, y.licenseId) || x.version - y.version),
    use: { ...a.use, modifies: sortedIdSet(a.use.modifies) },
    fee: { feeBps: a.fee.feeBps, feeRecipient: a.fee.feeRecipient === null ? null : lower(a.fee.feeRecipient) },
    terms: { acceptBy: a.terms.acceptBy, changePolicy: a.terms.changePolicy },
  };
}

export interface AgreementHashes {
  agreementHash: `0x${string}`;
  economicTermsHash: `0x${string}`;
  rightsTermsHash: `0x${string}`;
}

/** Hashes of an already-normalized agreement. */
export function hashNormalizedAgreement(n: EconomicAgreement): AgreementHashes {
  const rightsTermsHash = domainHash(RIGHTS_TERMS_DOMAIN, { licenses: n.licenses, use: n.use });
  const economicTermsHash = domainHash(ECONOMIC_TERMS_DOMAIN, {
    currency: n.currency,
    payer: n.payer,
    parties: n.parties,
    units: n.units,
    splits: n.splits,
    clauses: n.clauses,
    fee: n.fee,
  });
  const agreementHash = domainHash(AGREEMENT_DOMAIN, {
    agreementId: n.agreementId,
    version: n.version,
    supersedes: n.supersedes,
    asOf: n.asOf,
    terms: n.terms,
    economicTermsHash,
    rightsTermsHash,
  });
  return { agreementHash, economicTermsHash, rightsTermsHash };
}
