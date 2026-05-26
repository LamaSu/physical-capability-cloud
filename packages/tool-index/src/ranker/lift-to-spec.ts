/**
 * Adapter that lifts the @pcc/tool-index Phase 1 lightweight IndexedTool
 * into the @pcc/spec rich IndexedTool, so the HybridRanker can rank PCC's
 * own 218-tool agent-package alongside federated aggregator tools.
 *
 * Defaults applied (since PCC's own tools are inherently PCC_NATIVE):
 *   - source.type = "pcc-native"
 *   - trustTier = PCC_NATIVE
 *   - assuranceCeiling = DCC5
 *   - actionClass = inferred from endpoint method (GET → read, else → write)
 *                   if no endpoint, defaults to "read"
 *   - invocationCount = 0, successRate undefined (the receipts denorm job
 *     will populate these once it's wired in Phase 2.5)
 *
 * The adapter is one-way (light → spec). Callers that want to round-trip
 * a rich record back to the lightweight shape just read the relevant
 * fields directly off the spec IndexedTool.
 */

import {
  type IndexedTool as SpecIndexedTool,
  type IndexedToolActionClass,
  DigitalCaptureClass,
  TrustTier,
} from "@pcc/spec";
import type { IndexedTool as LightweightIndexedTool } from "../types.js";

const SHA_PLACEHOLDER = "sha256:" + "0".repeat(64);

/** Heuristic: HTTP method → actionClass mapping. Safe for PCC's own tools. */
function actionClassFromMethod(method: string | undefined): IndexedToolActionClass {
  if (!method) return "read";
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  return "write";
}

/**
 * Lift one lightweight IndexedTool into the spec IndexedTool shape.
 *
 * `nowIso` defaults to the current time; injected for deterministic tests.
 */
export function liftLightweightTool(
  light: LightweightIndexedTool,
  nowIso: string = new Date().toISOString(),
): SpecIndexedTool {
  return {
    id: light.id,
    cid: SHA_PLACEHOLDER,
    version: "1.0.0",
    source: {
      type: "pcc-native",
      url: light.endpoint
        ? `https://capability.network${light.endpoint.path}`
        : "https://capability.network",
      fetchedAt: nowIso,
    },
    ingestedAt: nowIso,
    ingestionMethod: "manual",
    upstreamUrl: light.endpoint
      ? `https://capability.network${light.endpoint.path}`
      : "https://capability.network",
    skills: light.capabilities ?? [],
    domains: light.tags ?? [],
    features: [],
    inputSchema: light.schema,
    description: light.description,
    actionClass: actionClassFromMethod(light.endpoint?.method),
    assuranceCeiling: DigitalCaptureClass.DCC5,
    trustTier: TrustTier.PCC_NATIVE,
    knownVulns: [],
    lastFetchedAt: nowIso,
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA_PLACEHOLDER],
    hostingPeers: [],
  };
}

/** Bulk-lift an array of lightweight tools. */
export function liftLightweightTools(
  lights: LightweightIndexedTool[],
  nowIso?: string,
): SpecIndexedTool[] {
  const stamp = nowIso ?? new Date().toISOString();
  return lights.map((l) => liftLightweightTool(l, stamp));
}
