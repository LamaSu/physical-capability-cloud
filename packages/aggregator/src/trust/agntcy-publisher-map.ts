/**
 * Trust mapping — AGNTCY Sigstore OIDC identity → PCC TrustTier + DCC.
 *
 * Inbound records from AGNTCY ADS may carry a Sigstore signature with a
 * Fulcio certificate that names an OIDC identity (Google IDP email,
 * GitHub Actions OIDC, etc). We map that identity to a PCC trust tier
 * so the rest of the pipeline can gate invocation properly.
 *
 * The mapping table (scope doc §6.1):
 *
 *   OIDC identity                                       → TrustTier / DCC
 *   ---------------------------------------------       --------------------------
 *   anthropic.com / cisco.com / outshift.io             VERIFIED_PARTNER / DCC4
 *   dell.com / google.com / oracle.com / redhat.com     VERIFIED_PARTNER / DCC4
 *     (LF AGNTCY founding members)
 *   Verified GitHub OIDC (any repo)                     VERIFIED_PUBLISHER / DCC3
 *   Anonymous / no Sigstore bundle                      AUTO_INDEXED / DCC2
 *   Sigstore present but Rekor proof fails              QUARANTINED / DCC0
 */

import {
  DigitalCaptureClass,
  type IndexedTool,
  TrustTier,
} from "@pcc/spec";

/**
 * What we extracted (or failed to extract) from a Sigstore bundle.
 *
 * In Phase 1 the AGNTCY adapter passes this in unverified — Phase 2
 * will run a live Rekor proof check inside the enrichment stage and
 * flip `rekorVerified` to true/false based on the proof outcome.
 */
export interface SigstoreIdentity {
  /** OIDC issuer URL (e.g. "https://accounts.google.com"). */
  issuer?: string;
  /** OIDC subject — email for Google IDP, repo URL for GitHub OIDC. */
  subject?: string;
  /** Whether the Rekor inclusion proof verified. Undefined = not checked. */
  rekorVerified?: boolean;
}

export interface TrustMappingResult {
  trustTier: TrustTier;
  assuranceCeiling: DigitalCaptureClass;
  /** Free-form reason the mapping landed where it did — audited. */
  reason: string;
}

/** LF AGNTCY founding member domains — DCC4 / VERIFIED_PARTNER. */
const FOUNDER_DOMAINS = new Set([
  "anthropic.com",
  "cisco.com",
  "outshift.io",
  "dell.com",
  "google.com",
  "oracle.com",
  "redhat.com",
]);

/** GitHub OIDC issuer URL prefix. */
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * Map an extracted Sigstore identity to a PCC trust tier. Pure function;
 * no I/O. The pipeline's enrich stage calls this after fetching the
 * Sigstore bundle.
 */
export function mapAgntcyIdentityToTrust(
  identity: SigstoreIdentity | undefined,
): TrustMappingResult {
  // Anonymous / no Sigstore bundle.
  if (!identity) {
    return {
      trustTier: TrustTier.AUTO_INDEXED,
      assuranceCeiling: DigitalCaptureClass.DCC2,
      reason: "no_sigstore_bundle",
    };
  }
  // Sigstore present but Rekor proof failed → quarantine.
  if (identity.rekorVerified === false) {
    return {
      trustTier: TrustTier.QUARANTINED,
      assuranceCeiling: DigitalCaptureClass.DCC0,
      reason: "rekor_proof_failed",
    };
  }
  // GitHub Actions OIDC.
  if (identity.issuer && identity.issuer.startsWith(GITHUB_OIDC_ISSUER)) {
    return {
      trustTier: TrustTier.VERIFIED_PUBLISHER,
      assuranceCeiling: DigitalCaptureClass.DCC3,
      reason: "github_oidc",
    };
  }
  // Domain-based founder mapping (e.g. user@cisco.com).
  if (identity.subject) {
    const domain = extractDomain(identity.subject);
    if (domain && FOUNDER_DOMAINS.has(domain)) {
      return {
        trustTier: TrustTier.VERIFIED_PARTNER,
        assuranceCeiling: DigitalCaptureClass.DCC4,
        reason: `founder_org:${domain}`,
      };
    }
  }
  // Verified Sigstore identity but not from a known publisher class —
  // treat as VERIFIED_PUBLISHER / DCC3 (one tier below founder).
  if (identity.rekorVerified) {
    return {
      trustTier: TrustTier.VERIFIED_PUBLISHER,
      assuranceCeiling: DigitalCaptureClass.DCC3,
      reason: "rekor_verified_unknown_publisher",
    };
  }
  // Sigstore present but rekorVerified is undefined (Phase 1 case).
  // Conservative default: VERIFIED_PARTNER / DCC4 because the adapter
  // sets this floor explicitly for agntcy-dht source type and the
  // signature being present is itself a positive signal.
  return {
    trustTier: TrustTier.VERIFIED_PARTNER,
    assuranceCeiling: DigitalCaptureClass.DCC4,
    reason: "sigstore_present_unverified",
  };
}

/**
 * Apply the mapping to an IndexedTool draft, returning a new draft with
 * trust fields populated. Does not mutate the input.
 */
export function applyTrustMapping(
  tool: IndexedTool,
  identity: SigstoreIdentity | undefined,
): IndexedTool {
  const mapped = mapAgntcyIdentityToTrust(identity);
  return {
    ...tool,
    trustTier: mapped.trustTier,
    assuranceCeiling: mapped.assuranceCeiling,
  };
}

function extractDomain(subject: string): string | undefined {
  // Email pattern.
  const atIdx = subject.lastIndexOf("@");
  if (atIdx !== -1) return subject.slice(atIdx + 1).toLowerCase();
  // URL pattern — match host.
  try {
    const u = new URL(subject);
    return u.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
