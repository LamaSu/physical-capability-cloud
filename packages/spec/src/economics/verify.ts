/**
 * verifyAcceptedAgreement — does this agreement still say what was accepted? (docs §6)
 *
 * The funding path calls this with the hashes the parties accepted and the agreement it is about to
 * compile. Any change after acceptance, however small, is refused, and the refusal says which half
 * moved: the rights (a license version, a grant), the payments (an amount, a party, a unit), or only
 * the envelope (asOf, version, the offer deadline). An old deal can therefore never be mutated by a
 * newer rate schedule or license version: the newer one hashes differently and fails here.
 *
 * Acceptance binds `agreementHash`, which covers both terms hashes and the envelope. The two terms
 * hashes are carried beside it only so a mismatch can say which half moved.
 */

import { z } from "zod";
import { hashNormalizedAgreement, normalizeAgreement, type AgreementHashes } from "./hash.js";
import { snapshotJson } from "./input.js";
import { EconomicAgreementSchema, HashSchema } from "./types.js";

export type AcceptedAgreementHashes = AgreementHashes;

/** The accepted hashes. Other fields (for example a whole compiled result) are ignored. */
export const AcceptedAgreementHashesSchema = z.object({
  agreementHash: HashSchema,
  economicTermsHash: HashSchema,
  rightsTermsHash: HashSchema,
});

export type AgreementPart = "rights" | "economics" | "envelope";

export type VerifyAcceptedResult =
  | { ok: true; hashes: AgreementHashes }
  | { ok: false; code: "SCHEMA_INVALID"; message: string }
  | { ok: false; code: "AGREEMENT_HASH_MISMATCH"; changed: AgreementPart[]; hashes: AgreementHashes };

export function verifyAcceptedAgreement(accepted: AcceptedAgreementHashes, agreement: unknown): VerifyAcceptedResult {
  const acceptedCopy = snapshotJson(accepted);
  if (!acceptedCopy.ok) return { ok: false, code: "SCHEMA_INVALID", message: `accepted: ${acceptedCopy.reason}` };
  const acc = AcceptedAgreementHashesSchema.safeParse(acceptedCopy.value);
  if (!acc.success) {
    return { ok: false, code: "SCHEMA_INVALID", message: `accepted: ${acc.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
  }
  const agreementCopy = snapshotJson(agreement);
  if (!agreementCopy.ok) return { ok: false, code: "SCHEMA_INVALID", message: agreementCopy.reason };
  const parsed = EconomicAgreementSchema.safeParse(agreementCopy.value);
  if (!parsed.success) {
    return { ok: false, code: "SCHEMA_INVALID", message: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const hashes = hashNormalizedAgreement(normalizeAgreement(parsed.data));
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (same(hashes.agreementHash, acc.data.agreementHash)) {
    // The agreement hash covers both terms hashes, so equal here means equal everywhere.
    return { ok: true, hashes };
  }
  const changed: AgreementPart[] = [];
  if (!same(hashes.rightsTermsHash, acc.data.rightsTermsHash)) changed.push("rights");
  if (!same(hashes.economicTermsHash, acc.data.economicTermsHash)) changed.push("economics");
  if (changed.length === 0) changed.push("envelope");
  return { ok: false, code: "AGREEMENT_HASH_MISMATCH", changed, hashes };
}
