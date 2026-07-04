/**
 * Option B passkey registration — pure orchestration.
 *
 * Runs the browser side of the WebAuthn registration ceremony against the
 * gateway's Phase A endpoints (merged in PR #198):
 *   POST /api/onboard/passkey/register-challenge  -> challenge + rp params
 *   POST /api/onboard/passkey/verify-attestation  -> { verified, credentialId }
 *
 * Kept dependency-injected (fetch-like callbacks + a `startRegistration` fn)
 * so the whole flow is unit-testable without a real authenticator or network,
 * mirroring packages/ui/src/capture/WebAuthnClient.ts. The React hook
 * (hooks/usePasskey.ts) is a thin wrapper that supplies the real
 * `@simplewebauthn/browser` startRegistration + window.fetch.
 *
 * See ai/research/option-b-smart-wallet-passkey-plan.md + coord bulletins
 * 235 / 254 / 262. Phase B (ERC-4337 mint that consumes the registered
 * credential) is a separate follow-up blocked on paymaster funding.
 */

// The subset of a WebAuthn registration options JSON we assemble client-side
// from the gateway's challenge response. Matches the shape
// @simplewebauthn/browser's startRegistration expects as `optionsJSON`.
export interface PublicKeyCredentialCreationOptionsJSONLite {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number;
  authenticatorSelection?: Record<string, unknown>;
  attestation?: "none" | "indirect" | "direct";
}

/** The gateway's register-challenge response shape (Phase A). */
export interface ChallengeResponse {
  sessionId: string;
  challenge: string;
  rpId: string;
  rpName: string;
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  authenticatorSelection?: Record<string, unknown>;
  timeout_ms?: number;
}

/** The gateway's verify-attestation success response shape (Phase A). */
export interface VerifyResponse {
  sessionId: string;
  credentialId: string;
  publicKey: string;
  rpId: string;
  persisted: boolean;
  verification: "verified";
}

/** Anything `@simplewebauthn/browser`'s startRegistration returns. */
export type AttestationResponseJSON = Record<string, unknown>;

export interface PasskeyRegistrationDeps {
  /** Base URL for gateway API calls (e.g. VITE_PCC_URL, "" for same-origin). */
  apiBase: string;
  /**
   * Optional operator binding. When set, the challenge request carries the
   * Bearer key and the credential is persisted to that operator's api_keys
   * row on verify. Without it, the challenge is anonymous (verify succeeds
   * but persisted:false). The gateway enforces the auth match (PR #198).
   */
  operatorId?: string;
  apiKey?: string;
  /** Injected fetch (window.fetch in prod; a fake in tests). */
  fetchFn: typeof fetch;
  /** Injected startRegistration (from @simplewebauthn/browser in prod). */
  startRegistration: (args: {
    optionsJSON: PublicKeyCredentialCreationOptionsJSONLite;
  }) => Promise<AttestationResponseJSON>;
}

export interface PasskeyRegistrationResult {
  verified: boolean;
  credentialId: string;
  persisted: boolean;
}

/** base64url-encode a UTF-8 string (browser-safe, no Buffer). */
export function utf8ToBase64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Assemble the WebAuthn creation options the browser needs from the gateway's
 * partial challenge response. The gateway returns challenge + rp params but
 * NOT the WebAuthn `user` handle (it's identity-agnostic), so we derive it:
 * an operator-bound flow uses the operatorId; anonymous uses a random handle.
 */
export function assembleCreationOptions(
  challenge: ChallengeResponse,
  operatorId: string | undefined,
  randomHandle: string,
): PublicKeyCredentialCreationOptionsJSONLite {
  const userName = operatorId ?? `anon-${randomHandle}`;
  return {
    challenge: challenge.challenge,
    rp: { id: challenge.rpId, name: challenge.rpName },
    user: {
      id: utf8ToBase64url(userName),
      name: userName,
      displayName: userName,
    },
    pubKeyCredParams: challenge.pubKeyCredParams,
    timeout: challenge.timeout_ms,
    authenticatorSelection: challenge.authenticatorSelection,
    attestation: "none",
  };
}

/**
 * Run the full registration ceremony. Throws a descriptive Error on any
 * failure (challenge 4xx/5xx, user cancels the WebAuthn prompt, verify
 * rejects). Returns the credential + persistence outcome on success.
 */
export async function runPasskeyRegistration(
  deps: PasskeyRegistrationDeps,
  randomHandle: string,
): Promise<PasskeyRegistrationResult> {
  const { apiBase, operatorId, apiKey, fetchFn, startRegistration } = deps;

  // 1. Challenge — carry Bearer when binding an operator.
  const challengeHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  if (operatorId && apiKey) {
    challengeHeaders["authorization"] = `Bearer ${apiKey}`;
  }
  const challengeRes = await fetchFn(
    `${apiBase}/api/onboard/passkey/register-challenge`,
    {
      method: "POST",
      headers: challengeHeaders,
      body: JSON.stringify(operatorId ? { operatorId } : {}),
    },
  );
  if (!challengeRes.ok) {
    const body = await safeJson(challengeRes);
    throw new Error(
      body?.message ?? body?.error ?? `challenge failed (HTTP ${challengeRes.status})`,
    );
  }
  const challenge = (await challengeRes.json()) as ChallengeResponse;

  // 2. Assemble options + run the authenticator ceremony (biometric prompt).
  const optionsJSON = assembleCreationOptions(challenge, operatorId, randomHandle);
  const attestationResponse = await startRegistration({ optionsJSON });

  // 3. Verify server-side (real cryptographic check in Phase A).
  const verifyRes = await fetchFn(
    `${apiBase}/api/onboard/passkey/verify-attestation`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: challenge.sessionId,
        attestationResponse,
      }),
    },
  );
  if (!verifyRes.ok) {
    const body = await safeJson(verifyRes);
    throw new Error(
      body?.message ?? body?.error ?? `verify failed (HTTP ${verifyRes.status})`,
    );
  }
  const verify = (await verifyRes.json()) as VerifyResponse;
  return {
    verified: verify.verification === "verified",
    credentialId: verify.credentialId,
    persisted: verify.persisted,
  };
}

async function safeJson(res: Response): Promise<{ error?: string; message?: string } | null> {
  try {
    return (await res.json()) as { error?: string; message?: string };
  } catch {
    return null;
  }
}

/**
 * Browser support detection for platform passkeys. Returns a coarse verdict
 * the UI uses to decide whether to offer the passkey path or fall back to the
 * option-A (gateway-custody) flow.
 *
 * `available` = WebAuthn API present. `platformAuthenticator` = a built-in
 * biometric (Touch ID / Windows Hello / Android) is usable — resolved
 * asynchronously via isUserVerifyingPlatformAuthenticatorAvailable().
 */
export async function detectPasskeySupport(
  win: { PublicKeyCredential?: unknown } | undefined = typeof window !== "undefined"
    ? (window as { PublicKeyCredential?: unknown })
    : undefined,
): Promise<{ available: boolean; platformAuthenticator: boolean }> {
  const PublicKeyCredential = win?.PublicKeyCredential as
    | {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
      }
    | undefined;
  if (!PublicKeyCredential) {
    return { available: false, platformAuthenticator: false };
  }
  let platformAuthenticator = false;
  try {
    if (
      typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable ===
      "function"
    ) {
      platformAuthenticator =
        await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    }
  } catch {
    platformAuthenticator = false;
  }
  return { available: true, platformAuthenticator };
}
