/**
 * verifyAcceptedAgreement — does this agreement still say what was accepted? (docs §6)
 *
 * The funding path calls this with the hashes the parties accepted and the agreement it is about to
 * compile. Any change after acceptance, however small, is refused, and the refusal says which half
 * moved: the rights (a license version, a grant), the payments (an amount, a party, a unit), or only
 * the envelope (asOf, version, the offer deadline). An old deal can therefore never be mutated by a
 * newer rate schedule or license version: the newer one hashes differently and fails here.
 */

import { hashNormalizedAgreement, normalizeAgreement, type AgreementHashes } from "./hash.js";
import { EconomicAgreementSchema } from "./types.js";

export type AcceptedAgreementHashes = AgreementHashes;

export type AgreementPart = "rights" | "economics" | "envelope";

export type VerifyAcceptedResult =
  | { ok: true; hashes: AgreementHashes }
  | { ok: false; code: "SCHEMA_INVALID"; message: string }
  | { ok: false; code: "AGREEMENT_HASH_MISMATCH"; changed: AgreementPart[]; hashes: AgreementHashes };

export function verifyAcceptedAgreement(
  accepted: AcceptedAgreementHashes,
  agreement: unknown,
): VerifyAcceptedResult {
  const parsed = EconomicAgreementSchema.safeParse(agreement);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_INVALID", message: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const hashes = hashNormalizedAgreement(normalizeAgreement(parsed.data));
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(hashes.agreementHash, accepted.agreementHash)) {
    // The agreement hash covers both terms hashes, so equal here means equal everywhere.
    return { ok: true, hashes };
  }
  const changed: AgreementPart[] = [];
  if (!same(hashes.rightsTermsHash, accepted.rightsTermsHash)) changed.push("rights");
  if (!same(hashes.economicTermsHash, accepted.economicTermsHash)) changed.push("economics");
  if (changed.length === 0) changed.push("envelope");
  return { ok: false, code: "AGREEMENT_HASH_MISMATCH", changed, hashes };
}
