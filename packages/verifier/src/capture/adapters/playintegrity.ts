/**
 * Google Play Integrity adapter — real `@googleapis/playintegrity@23.0.1`
 * implementation.
 *
 * Implements `PlatformAttestationAdapter` (from detector.ts) for the
 * Android `playintegrity` source. Used by:
 *   - Detector Pass 5 (platform attestation) — raises ceiling to CC2.
 *   - Verifier G5 gate — CC3 Android captures require strong integrity.
 *
 * Google's Play Integrity API (successor to SafetyNet, deprecated 2024)
 * issues a signed token on each client request. Server-side, we call
 * `playintegrity.v1.decodeIntegrityToken(...)` with the package name (the
 * Android app's ID — e.g. `network.capability.pcc`) and the token. Google
 * returns a structured verdict with:
 *   - `requestDetails.nonce`                — must match our expected nonce
 *   - `requestDetails.timestampMillis`      — used for TTL
 *   - `accountDetails.appLicensingVerdict`  — LICENSED / UNLICENSED
 *   - `appIntegrity.appRecognitionVerdict`  — PLAY_RECOGNIZED / UNEVALUATED / UNRECOGNIZED
 *   - `deviceIntegrity.deviceRecognitionVerdict[]` — zero or more of
 *       MEETS_STRONG_INTEGRITY | MEETS_DEVICE_INTEGRITY | MEETS_BASIC_INTEGRITY | MEETS_VIRTUAL_INTEGRITY
 *
 * Mapping to our `integrity` field (CVP §1 CC2 spec item 14):
 *   - MEETS_STRONG_INTEGRITY  → "strong"   (full CC2 credit)
 *   - MEETS_DEVICE_INTEGRITY  → "standard" (standard CC2 credit)
 *   - MEETS_VIRTUAL_INTEGRITY → "virtual"  (soft penalty, still CC2 eligible)
 *   - MEETS_BASIC_INTEGRITY   → "virtual"  (basic is effectively emulator-grade)
 *   - anything else           → "failed"
 *
 * Auth: the library requires a Google service-account JSON or ADC. Production
 * reads `GOOGLE_APPLICATION_CREDENTIALS` from env. Tests inject a
 * `moduleFactory` that returns a deterministic response.
 *
 * Author: verifier-juliet (PIVOT from `@n3arby/play-integrity-verifier` to
 * Google-official client, flagged by vet-beta).
 */

import type {
  PlatformAttestationAdapter,
  PlatformAttestationResult,
} from "../detector.js";
import type { PlatformAttestationSource } from "@pcc/spec";

/**
 * Shape of the decoded integrity-token response from Play Integrity v1.
 * Only the fields we consume are declared — the library's types are
 * permissive (`any`) and we don't want that bleeding into our API.
 */
interface DecodeIntegrityTokenResponse {
  tokenPayloadExternal?: {
    requestDetails?: {
      requestPackageName?: string;
      nonce?: string;
      timestampMillis?: string;
    };
    appIntegrity?: {
      appRecognitionVerdict?: string;
      packageName?: string;
      certificateSha256Digest?: string[];
      versionCode?: string;
    };
    deviceIntegrity?: {
      deviceRecognitionVerdict?: string[];
    };
    accountDetails?: {
      appLicensingVerdict?: string;
    };
    environmentDetails?: {
      appAccessRiskVerdict?: {
        appsDetected?: string[];
      };
      playProtectVerdict?: string;
    };
  };
}

/**
 * Abstracted shape of `@googleapis/playintegrity` we need at runtime.
 */
interface PlayIntegrityClient {
  v1: {
    decodeIntegrityToken(params: {
      packageName: string;
      requestBody: { integrityToken: string };
    }): Promise<{ data: DecodeIntegrityTokenResponse }>;
  };
}

interface PlayIntegrityModule {
  playintegrity?: (version: "v1") => PlayIntegrityClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default?: any;
}

export interface PlayIntegrityAdapterOptions {
  /**
   * Android package name the adapter validates tokens against. Must match
   * the `requestPackageName` in the decoded payload.
   */
  packageName?: string;
  /**
   * Injectable module factory. Tests pass a stub; production leaves it
   * undefined and the adapter dynamically imports the real library.
   */
  moduleFactory?: () => Promise<PlayIntegrityModule>;
  /**
   * TTL for integrity tokens (seconds). Google recommends <= 300s.
   */
  maxAgeSeconds?: number;
}

/**
 * Google Play Integrity adapter.
 *
 * Construct with a package name (or set `CVP_ANDROID_PACKAGE_NAME` env
 * var). The first `verify()` call lazy-loads the Google API client.
 */
export class PlayIntegrityAdapter implements PlatformAttestationAdapter {
  private readonly packageName: string;
  private readonly maxAgeSeconds: number;
  private readonly moduleFactory?: () => Promise<PlayIntegrityModule>;
  private client: PlayIntegrityClient | null = null;

  constructor(opts: PlayIntegrityAdapterOptions = {}) {
    this.packageName =
      opts.packageName ??
      process.env.CVP_ANDROID_PACKAGE_NAME ??
      "network.capability.pcc";
    this.maxAgeSeconds = opts.maxAgeSeconds ?? 300;
    this.moduleFactory = opts.moduleFactory;
  }

  async verify(params: {
    source: PlatformAttestationSource;
    token: string;
    expectedNonce: string;
  }): Promise<PlatformAttestationResult> {
    if (params.source !== "playintegrity") {
      return {
        signatureValid: false,
        nonceMatches: false,
        withinTtl: false,
        integrity: "failed",
      };
    }

    let decoded: DecodeIntegrityTokenResponse;
    try {
      const client = await this.getClient();
      const res = await client.v1.decodeIntegrityToken({
        packageName: this.packageName,
        requestBody: { integrityToken: params.token },
      });
      decoded = res.data;
    } catch {
      return {
        signatureValid: false,
        nonceMatches: false,
        withinTtl: false,
        integrity: "failed",
      };
    }

    const payload = decoded.tokenPayloadExternal;
    if (!payload) {
      return {
        signatureValid: false,
        nonceMatches: false,
        withinTtl: false,
        integrity: "failed",
      };
    }

    const reqDetails = payload.requestDetails ?? {};
    const nonceMatches = reqDetails.nonce === params.expectedNonce;

    // Package name enforcement — the decoded payload MUST reference our
    // configured package. Otherwise the token belongs to a different app.
    const packageMatches = reqDetails.requestPackageName === this.packageName;

    // TTL: `timestampMillis` is the moment Google minted the token. Capture
    // submissions arrive ≤120s later (per challenge TTL), plus margin for
    // network / clock skew.
    let withinTtl = false;
    const timestampStr = reqDetails.timestampMillis;
    if (typeof timestampStr === "string") {
      const tokenMs = Number.parseInt(timestampStr, 10);
      if (!Number.isNaN(tokenMs)) {
        const ageSeconds = (Date.now() - tokenMs) / 1000;
        withinTtl = ageSeconds >= 0 && ageSeconds <= this.maxAgeSeconds;
      }
    }

    const deviceVerdicts =
      payload.deviceIntegrity?.deviceRecognitionVerdict ?? [];
    const integrity = this.classifyIntegrity(deviceVerdicts);

    // signatureValid: Google's decode succeeded and app/package matches.
    // Nonce mismatch still returns signatureValid=true but nonceMatches=false
    // so the verifier's G5 logic can distinguish "signer fine, binding bad".
    const signatureValid = packageMatches;

    return {
      signatureValid,
      nonceMatches,
      withinTtl,
      integrity,
    };
  }

  private classifyIntegrity(
    verdicts: string[],
  ): PlatformAttestationResult["integrity"] {
    if (verdicts.includes("MEETS_STRONG_INTEGRITY")) return "strong";
    if (verdicts.includes("MEETS_DEVICE_INTEGRITY")) return "standard";
    if (
      verdicts.includes("MEETS_VIRTUAL_INTEGRITY") ||
      verdicts.includes("MEETS_BASIC_INTEGRITY")
    ) {
      return "virtual";
    }
    return "failed";
  }

  private async getClient(): Promise<PlayIntegrityClient> {
    if (this.client) return this.client;
    const mod = this.moduleFactory
      ? await this.moduleFactory()
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((await import("@googleapis/playintegrity")) as any);
    const factory =
      mod.playintegrity ??
      mod.default?.playintegrity ??
      (typeof mod === "function" ? mod : null);
    if (typeof factory !== "function") {
      throw new Error(
        "PlayIntegrity: @googleapis/playintegrity does not export playintegrity()",
      );
    }
    this.client = factory("v1") as PlayIntegrityClient;
    return this.client;
  }
}

/**
 * Build a mock `PlatformAttestationAdapter` for Android-path tests.
 */
export function mockPlayIntegrityAdapter(
  response: Partial<PlatformAttestationResult> | Error,
): PlatformAttestationAdapter {
  return {
    async verify(_params): Promise<PlatformAttestationResult> {
      if (response instanceof Error) throw response;
      return {
        signatureValid: response.signatureValid ?? false,
        nonceMatches: response.nonceMatches ?? false,
        withinTtl: response.withinTtl ?? false,
        integrity: response.integrity ?? "failed",
      };
    },
  };
}
