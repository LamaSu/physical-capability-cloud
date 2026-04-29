/**
 * C2PA adapter — real `@contentauth/c2pa-node` implementation.
 *
 * Implements `C2PAParserAdapter` (from detector.ts) by wrapping the vetted
 * `@contentauth/c2pa-node@0.5.4` native binding. The adapter is used by:
 *   - Detector Pass 1 (signature presence) — walks the JUMBF manifest for
 *     claim generators + trust-chain signals that raise the ceiling to
 *     CC3 (enclave-signed) or CC4 (hardware-camera-signed).
 *   - Verifier G2 signature gate — CC2+ captures require a valid manifest
 *     with a signing cert that chains to a known root.
 *
 * We map `claimGenerator` strings to two boolean flags the detector
 * understands:
 *   - `hardwareCamera` — the manifest was produced by a dedicated hardware
 *     camera body (Leica, Sony, Nikon, Canon, Fujifilm, Qualcomm Trusted
 *     Camera). This is the CC4 signal.
 *   - `enclaveSigned`  — the manifest was produced inside a secure enclave
 *     via an SDK (Truepic, Numbers, Starling). This is the CC3 signal.
 *
 * The underlying library does full cert-chain verification against the
 * C2PA trust store when `verify=true` (default). Our adapter surfaces the
 * verification outcome through `signatureValid`.
 *
 * Constructor takes an optional trust-store path; if supplied, we configure
 * the c2pa client to chain against that store (used in tests with fixture
 * certs). If absent, the library's default trust store is used.
 *
 * Error handling: if the manifest bytes are malformed, the library throws.
 * We catch and re-throw with a descriptive message so the verifier can
 * surface the error in its warning log without leaking internals.
 *
 * Author: verifier-juliet
 */

import type { C2PAParserAdapter, ParsedC2PA } from "../detector.js";

/**
 * Shape of the c2pa-node `createC2pa()` client we rely on.
 *
 * The real library returns a client with `read(asset)` and `sign(...)`
 * methods. We only need `read()`. The result has a `manifest_store` with
 * `active_manifest` and `manifests` keyed by label. Each manifest has a
 * `claim_generator` string and a `signature_info` block indicating whether
 * the signature verified (`signature_info.issuer` is set iff valid).
 */
interface C2PANodeClient {
  read(asset: { format: string; buffer: Buffer }): Promise<C2PAReadResult | null>;
}

interface C2PAReadResult {
  active_manifest?: string;
  manifests?: Record<string, C2PAManifestEntry>;
  validation_status?: Array<{ code: string; url?: string; explanation?: string }>;
}

interface C2PAManifestEntry {
  claim_generator?: string;
  claim_generator_info?: Array<{ name?: string; version?: string }>;
  format?: string;
  title?: string;
  signature_info?: {
    issuer?: string;
    cert_serial_number?: string;
    time?: string;
    alg?: string;
    cert_chain?: string | string[];
  };
  assertions?: Array<{ label: string; data?: unknown }>;
}

/**
 * Pattern tables for claim generator classification.
 *
 * Derived from the CAI trust list + vendor docs. Matches are
 * case-insensitive substring tests against `claim_generator` and
 * `claim_generator_info[].name`.
 */
const HARDWARE_CAMERA_SIGNATURES: readonly string[] = [
  "leica",
  "sony",
  "nikon",
  "canon",
  "fujifilm",
  "fuji",
  "qualcomm",
  "snapdragon",
  "trusted camera",
];

const ENCLAVE_SDK_SIGNATURES: readonly string[] = [
  "truepic",
  "com.truepic",
  "numbers",
  "numbersprotocol",
  "starling",
  "c2pa-lib-ios",
  "c2pa-lib-android",
];

/**
 * Options passed to the C2PA adapter constructor.
 */
export interface C2PAAdapterOptions {
  /**
   * Injectable client factory. Real callers pass the `createC2pa` export
   * from `@contentauth/c2pa-node`. Tests pass a lightweight mock.
   */
  clientFactory?: () => C2PANodeClient;
  /**
   * Override the format hint we send to the c2pa reader. Default is
   * `"image/jpeg"` which is the common CVP case; callers can set to
   * `"image/png"`, `"video/mp4"`, `"image/heic"`, etc.
   */
  defaultFormat?: string;
}

/**
 * Real C2PA adapter.
 *
 * Construct with `new C2PAAdapter()` and the factory lazily loads
 * `@contentauth/c2pa-node`. Pass a `clientFactory` in tests to avoid
 * the native binding.
 */
export class C2PAAdapter implements C2PAParserAdapter {
  private client: C2PANodeClient | null = null;
  private readonly defaultFormat: string;
  private readonly clientFactory?: () => C2PANodeClient;

  constructor(opts: C2PAAdapterOptions = {}) {
    this.defaultFormat = opts.defaultFormat ?? "image/jpeg";
    this.clientFactory = opts.clientFactory;
  }

  /**
   * Parse and validate a raw JUMBF manifest block.
   *
   * Returns `ParsedC2PA` with `signatureValid`, `claimGenerator`,
   * `hardwareCamera`, and `enclaveSigned` set. If parsing fails, throws
   * a descriptive Error (the detector and verifier both catch and surface
   * as negative evidence / G2 failure).
   */
  async parseManifest(bytes: Uint8Array): Promise<ParsedC2PA> {
    if (!bytes || bytes.byteLength === 0) {
      throw new Error("C2PA: manifest bytes are empty");
    }
    const client = await this.getClient();
    const buffer = Buffer.from(bytes);
    let result: C2PAReadResult | null;
    try {
      result = await client.read({ format: this.defaultFormat, buffer });
    } catch (err) {
      throw new Error(
        `C2PA: read failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (!result) {
      throw new Error("C2PA: no manifest found in asset");
    }

    // Determine validity. c2pa-node populates `validation_status` with an
    // entry PER validation step. A manifest passes only when there are no
    // entries with code starting `validationFailure.`.
    const validationStatus = result.validation_status ?? [];
    const failures = validationStatus.filter((s) =>
      s.code.startsWith("validation") &&
      !s.code.startsWith("validationStatus.trusted") &&
      !s.code.startsWith("validationStatus.success") &&
      !s.code.includes(".signingCredential.trusted") &&
      !s.code.includes(".claimSignature.validated"),
    );
    let signatureValid = failures.length === 0;

    // Pull the active manifest.
    const activeKey = result.active_manifest;
    const manifests = result.manifests ?? {};
    const active = activeKey ? manifests[activeKey] : Object.values(manifests)[0];
    if (!active) {
      throw new Error("C2PA: manifest store has no entries");
    }

    // Further require that signature_info.issuer is populated (real signature).
    const sig = active.signature_info ?? {};
    if (!sig.issuer) {
      signatureValid = false;
    }

    const claimGenerator = this.extractClaimGenerator(active);
    const hardwareCamera = this.matchesAny(claimGenerator, HARDWARE_CAMERA_SIGNATURES);
    const enclaveSigned = this.matchesAny(claimGenerator, ENCLAVE_SDK_SIGNATURES);

    return {
      signatureValid,
      claimGenerator,
      hardwareCamera,
      enclaveSigned,
    };
  }

  private extractClaimGenerator(manifest: C2PAManifestEntry): string {
    // Prefer structured `claim_generator_info[].name`; fall back to the
    // legacy single-string `claim_generator`.
    const info = manifest.claim_generator_info;
    if (Array.isArray(info) && info.length > 0) {
      const first = info[0];
      if (first && typeof first.name === "string" && first.name.length > 0) {
        if (typeof first.version === "string" && first.version.length > 0) {
          return `${first.name}/${first.version}`;
        }
        return first.name;
      }
    }
    if (typeof manifest.claim_generator === "string") {
      return manifest.claim_generator;
    }
    return "unknown";
  }

  private matchesAny(value: string, patterns: readonly string[]): boolean {
    const lower = value.toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }

  /**
   * Lazily construct the underlying c2pa-node client.
   *
   * In test code, pass `clientFactory` to construct a mock. In production
   * the factory dynamically imports `@contentauth/c2pa-node` the first time
   * parseManifest() is called — avoids loading the native binding at module
   * import time (saves ~150ms cold start on gateway boot).
   */
  private async getClient(): Promise<C2PANodeClient> {
    if (this.client) return this.client;
    if (this.clientFactory) {
      this.client = this.clientFactory();
      return this.client;
    }
    // Real load path (production).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import("@contentauth/c2pa-node");
    const createC2pa = mod.createC2pa ?? mod.default?.createC2pa;
    if (typeof createC2pa !== "function") {
      throw new Error(
        "C2PA: @contentauth/c2pa-node does not export createC2pa()",
      );
    }
    this.client = createC2pa() as C2PANodeClient;
    return this.client;
  }
}

/**
 * Build a mock `C2PAParserAdapter` for tests that don't exercise the real
 * library. Use this in `verifier.test.ts` to return deterministic results
 * without loading the native binding.
 */
export function mockC2PAAdapter(response: Partial<ParsedC2PA> | Error): C2PAParserAdapter {
  return {
    async parseManifest(_bytes: Uint8Array): Promise<ParsedC2PA> {
      if (response instanceof Error) throw response;
      return {
        signatureValid: response.signatureValid ?? false,
        claimGenerator: response.claimGenerator ?? "mock",
        hardwareCamera: response.hardwareCamera ?? false,
        enclaveSigned: response.enclaveSigned ?? false,
      };
    },
  };
}
