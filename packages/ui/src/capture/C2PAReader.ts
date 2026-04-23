/**
 * Capture Verification Protocol — browser-side C2PA manifest reader.
 *
 * Thin wrapper over `@contentauth/c2pa-web@0.7.1` (Rust+WASM) for inspecting
 * C2PA manifests inside the browser. Used by the `CaptureFlow` component
 * whenever the operator uploads a C2PA-signed still (e.g. Nikon Z6 III,
 * Sony α1, Truepic Lens, Leica M11-P). The parsed shape matches
 * `ParsedC2PA` on the server side so the detector can consume either.
 *
 * Design-doc tie-in:
 *   - §7.1: Nikon Z6 III case — C2PA-only captures are treated as
 *     CC1-equivalent for Tier 2+ workflows. The UI surfaces this via the
 *     tooltip on the declared-class dropdown (see `CaptureFlow.tsx`).
 *   - §4 pass 1: when `signatureValid && hardwareCamera` → detector lifts
 *     ceiling to CC4. `enclaveSigned` → CC3. Any other signature-valid →
 *     CC2-capped.
 *
 * TODO (Wave 4): replace the hard-coded trust-anchor heuristics below with
 * a data-driven lookup against `packages/verifier/trust-anchors/*.json`
 * synced to the browser via a build-time bundle. For now, we match on
 * well-known `claim_generator` / signing-cert CN substrings.
 */

import type { ParsedC2PA } from "./types.js";

/**
 * Minimal adapter interface over the `@contentauth/c2pa-web` package.
 *
 * We abstract it so unit tests can inject fakes without loading the 4 MB
 * WASM blob. The real library is created via `createC2pa({wasmSrc, workerSrc})`
 * and exposes `c2pa.read(blob)` — but the exact module shape changes
 * across semver, so we keep our contract narrow.
 */
export interface C2PANative {
  /**
   * Parse a file/blob and return manifests. Mirrors the `c2pa-web`
   * `read()` call shape (subset).
   */
  read(blob: Blob): Promise<C2PANativeReadResult>;
}

/** Subset of `c2pa-web`'s `read` return shape we consume. */
export interface C2PANativeReadResult {
  /** Manifest store keyed by manifest URI. Empty when no manifest is found. */
  manifestStore?: {
    activeManifest?: C2PANativeManifest | null;
    validationStatus?: C2PANativeValidationStatus[];
  } | null;
}

/** Subset of `c2pa-web`'s Manifest shape we consume. */
export interface C2PANativeManifest {
  claimGenerator?: string;
  signatureInfo?: {
    /**
     * Issuer Common Name of the signing cert. We match well-known roots
     * against substrings of this (e.g. "Leica Camera AG", "Sony",
     * "Nikon", "Canon", "Qualcomm" → hardware camera;
     * "Truepic", "Numbers Protocol", "Starling" → enclave SDK).
     */
    issuer?: string;
  };
}

/** Individual validation row from c2pa-web. */
export interface C2PANativeValidationStatus {
  code?: string;
  url?: string;
  explanation?: string;
}

/**
 * Dynamic loader for the real `@contentauth/c2pa-web` SDK.
 *
 * Production callers pass the result of `createC2pa(...)`. Tests inject
 * a fake that implements `C2PANative` directly.
 */
export type C2PALoader = () => Promise<C2PANative>;

/** Known hardware-camera root-CA issuer fragments (CC4 trigger). */
const HARDWARE_ROOTS: readonly string[] = [
  "leica",
  "sony",
  "nikon",
  "canon",
  "qualcomm",
  "snapdragon",
];

/** Known enclave-SDK root-CA issuer fragments (CC3 trigger). */
const ENCLAVE_ROOTS: readonly string[] = [
  "truepic",
  "numbers protocol",
  "numbers",
  "starling",
];

/**
 * Browser-side C2PA reader for the capture flow.
 *
 * Usage:
 * ```ts
 * import { createC2pa } from "@contentauth/c2pa-web";
 * const reader = new C2PAReader(() =>
 *   createC2pa({ wasmSrc: WASM_URL, workerSrc: WORKER_URL })
 * );
 * const parsed = await reader.readManifest(blob);
 * ```
 *
 * `readManifest` is idempotent and catches errors from the underlying
 * WASM — a bad/unsigned file returns a `ParsedC2PA` with
 * `signatureValid: false, claimGenerator: "", hardwareCamera: false,
 * enclaveSigned: false` instead of throwing, so the detector's pass-1
 * logic can uniformly record it as "no signature".
 */
export class C2PAReader {
  private nativeCache: C2PANative | null = null;

  constructor(private readonly loader: C2PALoader) {}

  /**
   * Parse the given blob and return the normalized `ParsedC2PA` shape.
   *
   * Never throws — returns a null-manifest shape on errors. This keeps
   * the detector happy: the absence of a manifest is meaningful signal,
   * not a crash condition.
   */
  async readManifest(blob: Blob): Promise<ParsedC2PA> {
    let native: C2PANative;
    try {
      native = this.nativeCache ?? (await this.loader());
      this.nativeCache = native;
    } catch {
      return emptyParsed();
    }

    let result: C2PANativeReadResult;
    try {
      result = await native.read(blob);
    } catch {
      return emptyParsed();
    }

    const manifest = result.manifestStore?.activeManifest;
    if (!manifest) {
      return emptyParsed();
    }

    const validationStatus = result.manifestStore?.validationStatus ?? [];
    // c2pa-web convention: a passing manifest has at most validation entries
    // of kind "claimSignature.validated" / "signingCredential.trusted"; any
    // row whose code starts with "signingCredential.untrusted" or
    // "claimSignature.mismatch" indicates invalidity.
    const signatureValid = validationStatusIsPassing(validationStatus);

    const claimGenerator = manifest.claimGenerator ?? "";
    const issuer = manifest.signatureInfo?.issuer ?? "";

    return {
      signatureValid,
      claimGenerator,
      hardwareCamera: signatureValid && matchesAny(issuer, HARDWARE_ROOTS),
      enclaveSigned: signatureValid && matchesAny(issuer, ENCLAVE_ROOTS),
    };
  }
}

/** Shape returned when no manifest / parse failed / file unsigned. */
function emptyParsed(): ParsedC2PA {
  return {
    signatureValid: false,
    claimGenerator: "",
    hardwareCamera: false,
    enclaveSigned: false,
  };
}

/**
 * Treat a `validationStatus` list as "passing" when it is either empty
 * (implicitly valid) or contains no explicit failure codes.
 *
 * We match on well-known c2pa-web failure-code prefixes; an empty list
 * from c2pa-web has historically meant "passed all checks".
 */
export function validationStatusIsPassing(
  rows: readonly C2PANativeValidationStatus[],
): boolean {
  if (rows.length === 0) return true;
  for (const r of rows) {
    const code = (r.code ?? "").toLowerCase();
    if (
      code.startsWith("claimsignature.mismatch") ||
      code.startsWith("signingcredential.untrusted") ||
      code.startsWith("signingcredential.expired") ||
      code.startsWith("signingcredential.invalid") ||
      code.startsWith("manifest.multipleupdates") ||
      code.startsWith("assertion.hashmismatch")
    ) {
      return false;
    }
  }
  return true;
}

/** Case-insensitive substring match against a list of known fragments. */
export function matchesAny(
  haystack: string,
  needles: readonly string[],
): boolean {
  if (!haystack) return false;
  const low = haystack.toLowerCase();
  for (const n of needles) {
    if (low.includes(n.toLowerCase())) return true;
  }
  return false;
}
