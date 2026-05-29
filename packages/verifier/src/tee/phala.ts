/**
 * Phala Cloud / Dstack adapter shim.
 *
 * Phala wraps Intel TDX with a Dstack guest-agent that exposes a quote-
 * generation HTTP endpoint inside the Confidential VM. PCC's verifier side
 * is the same as raw TDX (uses dcap-qvl). This module is a thin client for
 * the OPERATOR side — when an operator runs their MCP tool inside Phala
 * Cloud and PCC needs to confirm "yes, that quote really came from Phala",
 * it cross-references against Phala's published Dstack manifest.
 *
 * Architectures (scope §2.1):
 *   - Architecture A: operator-hosted Phala TEE (stronger).
 *   - Architecture B: PCC-hosted proxy in Phala (weaker — attests middleware,
 *     not upstream tool).
 *
 * Phase 1 ships:
 *   - `fetchPhalaManifest(url)` to pull the operator's Dstack manifest.
 *   - `crossCheckPhalaManifest(manifest, parsedQuote)` to confirm
 *     mrTd / rtmr_0 / rtmr_3 line up with what Phala published for that
 *     image (mr_aggregated for the Phala-runtime layer).
 *
 * The TDX cert-chain + signature verification is handled by
 * `./tdx-verifier.ts` — this module is the operator-side metadata bridge.
 *
 * See ai/scoping/dcc4-dcc5-auto-flows-2026-05-23.md §1.1, §2.1, §4.4.
 */

import type { ParsedTdxQuote } from "./tdx-verifier.js";

export interface PhalaDstackManifest {
  /** Phala App ID for the deployment. */
  appId: string;
  /** Dstack guest-agent version. */
  dstackVersion: string;
  /** Container image OCI ref the operator deployed. */
  imageRef: string;
  /**
   * Expected mrTd for the Phala Confidential VM image. PCC verifies the
   * observed TDX quote's MRTD matches one of these.
   */
  expectedMrTd: string;
  /**
   * Expected rtmr_0 / rtmr_3 set Phala publishes for this image. These are
   * the runtime-extended measurements that bind to the container image.
   */
  expectedRtmr0?: string;
  expectedRtmr3?: string;
}

export interface PhalaCrossCheck {
  appIdMatch: boolean;
  mrTdMatch: boolean;
  rtmrMatch: boolean;
  notes: string[];
}

/**
 * Fetch the operator's published Dstack manifest from the URL they advertised
 * at /claim-tee time. Returns null on any fetch / parse failure (caller
 * downgrades to plain TDX verification).
 */
export async function fetchPhalaManifest(
  manifestUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PhalaDstackManifest | null> {
  try {
    const res = await fetchImpl(manifestUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      // Conservative timeout for an operator-published manifest.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<PhalaDstackManifest>;
    if (
      typeof json.appId !== "string" ||
      typeof json.expectedMrTd !== "string"
    ) {
      return null;
    }
    return {
      appId: json.appId,
      dstackVersion: String(json.dstackVersion ?? "unknown"),
      imageRef: String(json.imageRef ?? "unknown"),
      expectedMrTd: json.expectedMrTd,
      expectedRtmr0: json.expectedRtmr0,
      expectedRtmr3: json.expectedRtmr3,
    };
  } catch {
    return null;
  }
}

/**
 * Cross-check a parsed TDX quote against the Phala manifest.
 *
 * MRTD must match exactly. RTMR0 + RTMR3 are checked if the manifest
 * provides them (Phala publishes both for production images).
 */
export function crossCheckPhalaManifest(
  manifest: PhalaDstackManifest,
  parsed: ParsedTdxQuote,
): PhalaCrossCheck {
  const notes: string[] = [];

  const mrTdMatch =
    parsed.mrTd.toLowerCase() === manifest.expectedMrTd.toLowerCase();
  if (!mrTdMatch) {
    notes.push(
      `phala: MRTD mismatch (manifest ${manifest.expectedMrTd.slice(0, 16)}…, observed ${parsed.mrTd.slice(0, 16)}…)`,
    );
  }

  let rtmrMatch = true;
  if (manifest.expectedRtmr0) {
    if (parsed.rtmr0.toLowerCase() !== manifest.expectedRtmr0.toLowerCase()) {
      rtmrMatch = false;
      notes.push("phala: rtmr_0 mismatch");
    }
  }
  if (manifest.expectedRtmr3) {
    if (parsed.rtmr3.toLowerCase() !== manifest.expectedRtmr3.toLowerCase()) {
      rtmrMatch = false;
      notes.push("phala: rtmr_3 mismatch");
    }
  }

  // appId presence is informational at this layer — PCC's claim-tee endpoint
  // already validated the appId at registration time.
  const appIdMatch = Boolean(manifest.appId);

  return { appIdMatch, mrTdMatch, rtmrMatch, notes };
}
