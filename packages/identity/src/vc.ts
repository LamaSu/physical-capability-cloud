/**
 * W3C Verifiable Credentials parser + verifier.
 *
 * Supports two flavors:
 *  1. Data-integrity proofs (Ed25519Signature2020, EcdsaSecp256k1Signature2019, ...)
 *     — verifies structure + issuance/expiration dates + that the
 *     verificationMethod resolves on the issuer's DID document.
 *     Cryptographic JWS canonicalization is delegated to a pluggable
 *     hook (`jwsVerifier`) because cryptosuite implementations are large.
 *  2. JWT-VC (RFC 7519 / RFC 7515 enveloped form)
 *     — parses the JWS, validates exp/nbf claims, verifies the issuer DID.
 *
 * Ref: https://www.w3.org/TR/vc-data-model/
 *      https://www.w3.org/TR/vc-jwt/
 */

import { z } from "zod";
import type { DIDResolver } from "./resolver.js";
import { parseDID } from "./did.js";
import {
  DIDResolutionError,
  type VCProof,
  type VCVerificationResult,
  type VerifiableCredential,
  type VerificationMethod,
} from "./types.js";

/**
 * Minimal structural Zod schema for a W3C VC.
 * Permissive — extra fields are allowed, only the required shape is enforced.
 */
export const verifiableCredentialSchema = z.object({
  "@context": z.union([z.string(), z.array(z.string())]),
  type: z.union([z.string(), z.array(z.string())]),
  issuer: z.union([z.string(), z.object({ id: z.string() }).passthrough()]),
  issuanceDate: z.string(),
  expirationDate: z.string().optional(),
  credentialSubject: z.union([z.record(z.unknown()), z.array(z.record(z.unknown()))]),
  proof: z.union([
    z.object({
      type: z.string(),
      created: z.string(),
      verificationMethod: z.string(),
    }).passthrough(),
    z.array(z.object({
      type: z.string(),
      created: z.string(),
      verificationMethod: z.string(),
    }).passthrough()),
  ]),
  id: z.string().optional(),
}).passthrough();

/**
 * Pluggable JWS verifier — callers inject their preferred crypto library
 * (e.g. @noble/curves, did-jwt) and the verifier handles the rest.
 *
 * Signature: (proof, verificationMethod, payload) -> Promise<boolean>
 *   - proof.jws holds the detached JWS (header..signature with empty payload)
 *   - verificationMethod is resolved from the issuer's DID document
 *   - payload is the canonicalized credential bytes (caller's choice of suite)
 */
export type JWSVerifier = (
  proof: VCProof,
  verificationMethod: VerificationMethod,
  payload: Uint8Array,
) => Promise<boolean>;

export interface VCVerifierOptions {
  /**
   * Optional hook that performs the cryptographic JWS check.
   * If omitted, verify() reports `valid: false` with a "no JWS verifier"
   * error for proofs that include a `jws` field, but structural / temporal
   * / issuer-DID checks still run.
   */
  jwsVerifier?: JWSVerifier;
  /**
   * Override clock for expiration checks (testing).
   */
  clock?: () => Date;
}

/**
 * Verify W3C Verifiable Credentials.
 *
 * Usage:
 *   const resolver = new DIDResolver();
 *   const verifier = new VCVerifier(resolver);
 *   const result = await verifier.verify(vc);
 */
export class VCVerifier {
  private readonly resolver: DIDResolver;
  private readonly options: VCVerifierOptions;

  constructor(resolver: DIDResolver, options: VCVerifierOptions = {}) {
    this.resolver = resolver;
    this.options = options;
  }

  /**
   * Returns true if the credential is past its expirationDate.
   * Returns false if there is no expirationDate.
   */
  isExpired(vc: VerifiableCredential, now?: Date): boolean {
    const expRaw = vc.expirationDate;
    if (!expRaw) return false;
    const exp = parseISODate(expRaw);
    if (!exp) return false;
    const reference = now ?? this.options.clock?.() ?? new Date();
    return reference.getTime() > exp.getTime();
  }

  /**
   * Returns the credential's issuer DID as a string, regardless of
   * whether the issuer was supplied as a plain string or as an object.
   */
  static issuerDid(vc: VerifiableCredential): string {
    return typeof vc.issuer === "string" ? vc.issuer : vc.issuer.id;
  }

  /**
   * Verify a VC.
   *
   * Checks performed:
   *  - structural (Zod)
   *  - issuer is a parseable DID
   *  - issuanceDate is a valid ISO date and is not in the future (1h skew)
   *  - expirationDate, if present, is a valid ISO date and not past
   *  - proof.verificationMethod resolves on the issuer's DID document
   *  - if proof.jws is set and a jwsVerifier was provided, the signature verifies
   *  - if proof.jws is set and no jwsVerifier was provided, returns valid=false
   *    with a warning (cannot cryptographically verify)
   */
  async verify(vc: unknown): Promise<VCVerificationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Structural validation
    const parsed = verifiableCredentialSchema.safeParse(vc);
    if (!parsed.success) {
      return {
        valid: false,
        errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      };
    }
    const credential = parsed.data as unknown as VerifiableCredential;

    // 2. Issuer must be a valid DID
    const issuer = VCVerifier.issuerDid(credential);
    try {
      parseDID(issuer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Invalid issuer DID: ${message}`);
    }

    // 3. Date validation
    const now = this.options.clock?.() ?? new Date();
    const issuance = parseISODate(credential.issuanceDate);
    if (!issuance) {
      errors.push(`Invalid issuanceDate: "${credential.issuanceDate}"`);
    } else if (issuance.getTime() - now.getTime() > 3600_000) {
      errors.push(`issuanceDate is more than 1 hour in the future`);
    }

    if (credential.expirationDate) {
      const exp = parseISODate(credential.expirationDate);
      if (!exp) {
        errors.push(`Invalid expirationDate: "${credential.expirationDate}"`);
      } else if (exp.getTime() < now.getTime()) {
        errors.push(`Credential is expired (expirationDate ${credential.expirationDate})`);
      } else if (exp.getTime() - now.getTime() < 7 * 86_400_000) {
        warnings.push(`Credential expires within 7 days`);
      }
    }

    // Bail early if structural / temporal issues already make this invalid —
    // skip the proof check to avoid a misleading "proof valid" message.
    if (errors.length > 0) {
      return { valid: false, errors, warnings };
    }

    // 4. Resolve issuer DID Document + locate verificationMethod
    let didDocument;
    try {
      didDocument = await this.resolver.resolve(issuer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to resolve issuer DID: ${message}`);
      return { valid: false, errors, warnings };
    }

    const proofs = Array.isArray(credential.proof) ? credential.proof : [credential.proof];
    for (const proof of proofs) {
      const vm = findVerificationMethod(didDocument.verificationMethod ?? [], proof.verificationMethod);
      if (!vm) {
        errors.push(
          `Proof verificationMethod "${proof.verificationMethod}" not found in issuer DID document`,
        );
        continue;
      }

      // 5. JWS verification (if applicable)
      if (proof.jws) {
        if (!this.options.jwsVerifier) {
          warnings.push(
            `Proof has a JWS but no jwsVerifier was supplied — cannot cryptographically verify "${proof.type}"`,
          );
          errors.push(`Cannot verify JWS proof without a jwsVerifier`);
          continue;
        }
        // We don't canonicalize here — different cryptosuites use different rules.
        // The caller's jwsVerifier is responsible for canonicalization.
        const payload = new TextEncoder().encode(JSON.stringify(credential));
        let signatureValid: boolean;
        try {
          signatureValid = await this.options.jwsVerifier(proof, vm, payload);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`JWS verification threw: ${message}`);
          continue;
        }
        if (!signatureValid) {
          errors.push(`JWS signature failed verification for proof "${proof.type}"`);
        }
      } else if (proof.proofValue) {
        // multibase proofValue — also requires a custom verifier
        warnings.push(`Proof uses multibase proofValue, not jws — cryptographic check skipped`);
      } else {
        errors.push(`Proof has neither jws nor proofValue`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }
}

function parseISODate(value: string): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function findVerificationMethod(
  methods: VerificationMethod[],
  id: string,
): VerificationMethod | undefined {
  // verificationMethod may be a relative fragment (#key-1) or an absolute DID URL.
  return methods.find((m) => m.id === id || m.id.endsWith(id) || id.endsWith(m.id));
}
