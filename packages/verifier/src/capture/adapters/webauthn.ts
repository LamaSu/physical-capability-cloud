/**
 * WebAuthn adapter — real `@simplewebauthn/server` implementation.
 *
 * Implements `WebAuthnVerifierAdapter` (from verifier.ts) by wrapping
 * `@simplewebauthn/server@13.3.0`'s `verifyAuthenticationResponse`. This is
 * the G2 signature gate for CC1 (browser-signed) captures.
 *
 * Flow:
 *   1. Operator's browser calls `navigator.credentials.get({publicKey: {...}})`
 *      during the CC1 capture flow. The challenge embedded in the
 *      `publicKey.challenge` option is the server-issued `CaptureNonceChallenge`
 *      (base64url-encoded).
 *   2. The browser returns an `AuthenticatorAssertionResponse`; the client
 *      packs it into the `WebAuthnAssertion` type on the `CaptureManifest`.
 *   3. This adapter decodes the base64url fields, runs the full
 *      `@simplewebauthn/server` verification against the previously
 *      registered credential's public key, and returns a structured result.
 *
 * What the underlying library checks:
 *   - `clientDataJSON.challenge` matches `expectedChallenge`
 *   - `clientDataJSON.origin` matches `expectedOrigin`
 *   - `clientDataJSON.type === "webauthn.get"`
 *   - `authenticatorData.rpIdHash === sha256(expectedRpId)`
 *   - `authenticatorData.flags.up` is set (user present)
 *   - `authenticatorData.flags.uv` is set if `requireUserVerification`
 *   - Signature verifies against the credential public key over
 *     `authenticatorData || sha256(clientDataJSON)`
 *   - `signCount > previousSignCount` (monotonic counter anti-replay)
 *
 * Our adapter surfaces all of that through the `WebAuthnVerifierResult`
 * type. Callers (verifier.ts G2) enforce `signatureValid &&
 * challengeMatches` and use `userVerified` to decide whether to raise
 * the ceiling past CC1.
 *
 * Error handling: the library throws on any verification failure. We catch
 * and return a negative result so the verifier can surface the reason in
 * its warnings rather than bubbling an exception up to gateway code.
 *
 * Author: verifier-juliet
 */

import type {
  WebAuthnVerifierAdapter,
  WebAuthnVerifierResult,
} from "../verifier.js";

/**
 * Shape of the `verifyAuthenticationResponse` result from v13 of
 * `@simplewebauthn/server`. Only the fields we use are declared.
 */
interface SimpleWebAuthnVerifiedResult {
  verified: boolean;
  authenticationInfo?: {
    credentialID?: Uint8Array | string;
    newCounter?: number;
    userVerified?: boolean;
    origin?: string;
    rpID?: string;
  };
}

/**
 * Shape of the v13 function. Imported at first-use for fast cold-start.
 */
type VerifyAuthenticationResponseFn = (params: {
  response: {
    id: string;
    rawId: string;
    type: "public-key";
    clientExtensionResults?: Record<string, unknown>;
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
      userHandle?: string;
    };
  };
  expectedChallenge: string;
  expectedOrigin: string | string[];
  expectedRPID: string | string[];
  credential: {
    id: string;
    publicKey: Uint8Array;
    counter: number;
  };
  requireUserVerification?: boolean;
}) => Promise<SimpleWebAuthnVerifiedResult>;

/**
 * Options for the WebAuthn adapter.
 */
export interface WebAuthnAdapterOptions {
  /**
   * Injectable override of `verifyAuthenticationResponse`. Tests pass a
   * mock; production leaves it undefined and the adapter dynamically
   * imports `@simplewebauthn/server`.
   */
  verifyFn?: VerifyAuthenticationResponseFn;
  /**
   * If true, require authenticator user verification (biometric / PIN).
   * Default: true, matching the CVP UX recommendation for CC1.
   */
  requireUserVerification?: boolean;
}

/**
 * Decode base64url → Uint8Array.
 *
 * `@simplewebauthn/server` accepts base64url strings for `response`
 * fields, but the credential publicKey must be `Uint8Array`. CaptureManifest
 * ships base64url strings across the wire, so we decode here once.
 */
function base64UrlToUint8Array(s: string): Uint8Array {
  // Normalize base64url → base64
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + "=".repeat(4 - pad);
  const bin = Buffer.from(padded, "base64");
  return new Uint8Array(bin);
}

/**
 * Decode base64url → utf-8 string.
 */
function base64UrlToString(s: string): string {
  const bytes = base64UrlToUint8Array(s);
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Real WebAuthn adapter.
 *
 * The adapter is stateless — each verify() call is independent.
 */
export class WebAuthnAdapter implements WebAuthnVerifierAdapter {
  private verifyFn: VerifyAuthenticationResponseFn | null = null;
  private readonly requireUserVerification: boolean;
  private readonly verifyFnInjected?: VerifyAuthenticationResponseFn;

  constructor(opts: WebAuthnAdapterOptions = {}) {
    this.requireUserVerification = opts.requireUserVerification ?? true;
    this.verifyFnInjected = opts.verifyFn;
  }

  async verify(params: {
    assertion: {
      credentialId: string;
      signature: string;
      authenticatorData: string;
      clientDataJSON: string;
      challenge: string;
      signCount: number;
    };
    expectedPublicKey: string;
    expectedChallenge: string;
    expectedOrigin: string;
    expectedRpId: string;
    previousSignCount?: number;
  }): Promise<WebAuthnVerifierResult> {
    const verifyFn = await this.getVerifyFn();

    // Decode the credential public key. `expectedPublicKey` is base64url-
    // encoded CBOR (the COSE key blob `@simplewebauthn/server` expects).
    const publicKey = base64UrlToUint8Array(params.expectedPublicKey);

    // Pre-extract challenge from clientDataJSON so we can report
    // `challengeMatches` independently from the library's global verdict.
    let challengeMatches = false;
    try {
      const clientDataStr = base64UrlToString(params.assertion.clientDataJSON);
      const clientData = JSON.parse(clientDataStr) as {
        challenge?: string;
        origin?: string;
        type?: string;
      };
      if (typeof clientData.challenge === "string") {
        challengeMatches = clientData.challenge === params.expectedChallenge;
      }
    } catch {
      challengeMatches = false;
    }

    // Build the `AuthenticationResponseJSON` the library expects.
    const response = {
      id: params.assertion.credentialId,
      rawId: params.assertion.credentialId,
      type: "public-key" as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: params.assertion.clientDataJSON,
        authenticatorData: params.assertion.authenticatorData,
        signature: params.assertion.signature,
      },
    };

    let result: SimpleWebAuthnVerifiedResult;
    try {
      result = await verifyFn({
        response,
        expectedChallenge: params.expectedChallenge,
        expectedOrigin: params.expectedOrigin,
        expectedRPID: params.expectedRpId,
        credential: {
          id: params.assertion.credentialId,
          publicKey,
          counter: params.previousSignCount ?? 0,
        },
        requireUserVerification: this.requireUserVerification,
      });
    } catch (err) {
      // Library throws on most verification errors. Map to a negative
      // result so the verifier's G2 gate can attach the reason.
      return {
        signatureValid: false,
        challengeMatches,
        userVerified: false,
        signCount: params.assertion.signCount,
        credentialId: params.assertion.credentialId,
      };
    }

    const info = result.authenticationInfo ?? {};
    const newCounter = typeof info.newCounter === "number" ? info.newCounter : params.assertion.signCount;
    const userVerified = info.userVerified === true;

    return {
      signatureValid: result.verified === true,
      challengeMatches,
      userVerified,
      signCount: newCounter,
      credentialId: params.assertion.credentialId,
    };
  }

  private async getVerifyFn(): Promise<VerifyAuthenticationResponseFn> {
    if (this.verifyFn) return this.verifyFn;
    if (this.verifyFnInjected) {
      this.verifyFn = this.verifyFnInjected;
      return this.verifyFn;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("@simplewebauthn/server");
    const fn =
      mod.verifyAuthenticationResponse ??
      mod.default?.verifyAuthenticationResponse;
    if (typeof fn !== "function") {
      throw new Error(
        "WebAuthn: @simplewebauthn/server does not export verifyAuthenticationResponse",
      );
    }
    this.verifyFn = fn as VerifyAuthenticationResponseFn;
    return this.verifyFn;
  }
}

/**
 * Build a mock `WebAuthnVerifierAdapter` for tests.
 *
 * Pass a `WebAuthnVerifierResult` to return, or an `Error` to throw.
 */
export function mockWebAuthnAdapter(
  response: Partial<WebAuthnVerifierResult> | Error,
): WebAuthnVerifierAdapter {
  return {
    async verify(params): Promise<WebAuthnVerifierResult> {
      if (response instanceof Error) throw response;
      return {
        signatureValid: response.signatureValid ?? false,
        challengeMatches: response.challengeMatches ?? false,
        userVerified: response.userVerified ?? false,
        signCount: response.signCount ?? params.assertion.signCount,
        credentialId: response.credentialId ?? params.assertion.credentialId,
      };
    },
  };
}
