/**
 * Capture Verification Protocol — browser-side WebAuthn client.
 *
 * Thin wrapper around `@simplewebauthn/browser@13.3.0` for the CC1 capture
 * flow. Two verbs:
 *
 *   1. `registerCredential()` — first-time registration (Touch ID / Windows
 *      Hello / Android biometric). Called during the "first-time operator"
 *      path described in design doc §9.1.
 *
 *   2. `signCaptureHash(captureHash, challenge)` — per-capture assertion over
 *      a raw SHA256 of the capture bytes. The `challenge` is the server-
 *      issued `challengeId` from `POST /api/capture/challenge` (base64url)
 *      so the assertion is bound to a fresh nonce.
 *
 * Gateway routes used (already implemented in `@pcc/verifier` +
 * `@pcc/gateway`):
 *   - `POST /api/capture/webauthn/register/options` → PublicKeyCredentialCreationOptions JSON
 *   - `POST /api/capture/webauthn/register/verify`  → `{verified, credentialId}`
 *   - `POST /api/capture/webauthn/assert/options`   → PublicKeyCredentialRequestOptions JSON
 *
 * This module is pure ES (no React) so it can be reused from native/agent
 * clients too.
 *
 * See: ai/research/capture-verification-protocol.md §9.2 steps 6-8
 */

import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";

/**
 * Options the caller supplies to construct a `WebAuthnClient`.
 *
 * `fetchRegistrationOptions` and `fetchAssertionOptions` are abstracted so
 * unit tests can inject deterministic fakes without wiring a real fetch.
 * Production callers pass simple fetch-wrappers that hit the gateway.
 */
export interface WebAuthnClientOptions {
  /** Fetch `PublicKeyCredentialCreationOptionsJSON` from the gateway */
  fetchRegistrationOptions: () =>
    | Promise<PublicKeyCredentialCreationOptionsJSON>
    | PublicKeyCredentialCreationOptionsJSON;
  /**
   * POST the resulting registration response to the gateway for server-side
   * verification. Should resolve to the credentialId the server accepted.
   */
  submitRegistrationResponse: (
    response: RegistrationResponseJSON,
  ) => Promise<{ verified: boolean; credentialId: string }>;
  /** Fetch `PublicKeyCredentialRequestOptionsJSON` for a specific challenge */
  fetchAssertionOptions: (params: {
    captureHash: Uint8Array;
    challenge: string;
  }) =>
    | Promise<PublicKeyCredentialRequestOptionsJSON>
    | PublicKeyCredentialRequestOptionsJSON;
}

/** Output of a successful `signCaptureHash` call. */
export interface WebAuthnCaptureAssertion {
  /** The credential ID used to sign (base64url) */
  credentialId: string;
  /** The assertion signature (base64url) */
  signature: string;
  /** Authenticator data blob (base64url) */
  authenticatorData: string;
  /** Client data JSON blob (base64url) */
  clientDataJSON: string;
  /** Server-issued challenge echoed in the assertion (base64url) */
  challenge: string;
  /** Monotonic signature counter reported by the authenticator (0 if absent) */
  signCount: number;
}

/**
 * The browser-side WebAuthn verbs the capture flow needs.
 *
 * Thin, testable, no hidden network side-effects: all fetches are routed
 * through the injected `WebAuthnClientOptions` callbacks so the test suite
 * can mock them deterministically.
 */
export class WebAuthnClient {
  constructor(private readonly options: WebAuthnClientOptions) {}

  /**
   * Run the first-time WebAuthn registration flow.
   *
   * 1. Ask the gateway for `PublicKeyCredentialCreationOptionsJSON`.
   * 2. Invoke `startRegistration` which prompts the user for biometric.
   * 3. POST the response back to the gateway for verification.
   * 4. Return the accepted credentialId on success.
   *
   * Throws if:
   *   - user denies or cancels the WebAuthn prompt (propagated from
   *     `startRegistration`)
   *   - gateway fails to verify
   */
  async registerCredential(): Promise<{ credentialId: string }> {
    const creationOptions = await this.options.fetchRegistrationOptions();
    const response = await startRegistration({ optionsJSON: creationOptions });
    const verify = await this.options.submitRegistrationResponse(response);
    if (!verify.verified) {
      throw new Error("webauthn_register_not_verified");
    }
    return { credentialId: verify.credentialId };
  }

  /**
   * Sign a capture hash with the user's authenticator.
   *
   * The `captureHash` is the raw SHA-256 bytes of the canonical capture
   * manifest (browser code computes this before calling — see
   * `CaptureFlow.tsx`). `challenge` is the base64url-encoded
   * `challengeId` from `POST /api/capture/challenge`.
   *
   * Returns a `WebAuthnCaptureAssertion` ready to embed into a
   * `CaptureManifest.webAuthnAssertion` field.
   */
  async signCaptureHash(
    captureHash: Uint8Array,
    challenge: string,
  ): Promise<WebAuthnCaptureAssertion> {
    if (captureHash.byteLength !== 32) {
      throw new Error(
        `webauthn_capture_hash_invalid: expected 32 bytes, got ${captureHash.byteLength}`,
      );
    }
    if (!challenge || typeof challenge !== "string") {
      throw new Error("webauthn_challenge_missing");
    }

    const requestOptions = await this.options.fetchAssertionOptions({
      captureHash,
      challenge,
    });
    const response: AuthenticationResponseJSON = await startAuthentication({
      optionsJSON: requestOptions,
    });

    // Extract signCount from the assertion — simplewebauthn returns the raw
    // authenticator response. signCount lives in authenticatorData bytes
    // 33-36 (big-endian). We decode defensively: malformed authenticators
    // (or emulators) may omit it. Treat absence as 0.
    const signCount = decodeSignCount(response.response.authenticatorData);

    return {
      credentialId: response.id,
      signature: response.response.signature,
      authenticatorData: response.response.authenticatorData,
      clientDataJSON: response.response.clientDataJSON,
      challenge,
      signCount,
    };
  }
}

/**
 * Decode the 4-byte big-endian signCount from a base64url authenticatorData
 * blob.
 *
 * AuthenticatorData layout (WebAuthn spec):
 *   bytes 0-31  = rpIdHash
 *   byte  32    = flags
 *   bytes 33-36 = signCount (big-endian uint32)
 *   ...         = (optional) attestedCredentialData / extensions
 *
 * Returns 0 if the blob is too short or fails to decode.
 */
export function decodeSignCount(authenticatorDataB64Url: string): number {
  if (!authenticatorDataB64Url || authenticatorDataB64Url.length < 1) {
    return 0;
  }
  try {
    const bytes = base64urlToBytes(authenticatorDataB64Url);
    if (bytes.byteLength < 37) return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(33, false);
  } catch {
    return 0;
  }
}

/** Decode a base64url string to a `Uint8Array`. Pure; browser-safe. */
export function base64urlToBytes(s: string): Uint8Array {
  // Convert base64url → base64
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    "=",
  );
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/** Encode a `Uint8Array` to base64url. Pure; browser-safe. */
export function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
