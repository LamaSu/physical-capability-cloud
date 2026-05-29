/**
 * AGNTCY ADS publisher (outbound).
 *
 * Projects a PCC `IndexedTool` into an OASF v1.0.0 agent record, signs
 * it via Sigstore (Phase 1 shells out to `cosign sign-blob`; Phase 2
 * swaps in `@sigstore/sign` in-process), pushes it to the AGNTCY ADS
 * REST endpoint, and announces the resulting CID on the DHT.
 *
 * The OASF baseline doesn't model PCC's physical-capability-rich fields
 * (pricing, work envelope, tolerances, ALCOA+ status). Those ride on a
 * custom `physical-capability/v1` module in `modules[]`. OASF's policy
 * is "consumers ignore unknown modules", so AGNTCY-native clients that
 * don't know about physical capabilities still see the basic record
 * and can route around it safely.
 *
 * Idempotency: pushing the same record yields the same CID (OASF
 * content-addressable storage), so re-push is a no-op at the OCI layer.
 * DHT announce is deduped by `(cid, peer_id)`. If the caller passes an
 * IndexedTool whose `agntcyRecordCid` already matches the CID computed
 * from its projection, callers can skip the push entirely (handled at
 * the pipeline layer, not the publisher).
 *
 * Phase 1 limitations (acceptable for the bridge MVP):
 *   - REST not gRPC (mirrors the source-adapter constraint).
 *   - Cosign shell-out instead of in-process `@sigstore/sign` — keeps
 *     the dependency footprint small for the bridge MVP.
 *   - No batch publish — fan out per-tool at the pipeline layer.
 *
 * Spec: ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md §5
 */

import {
  type DigitalCaptureClass,
  type IndexedTool,
  type OasfModule,
  type ToolSourceType,
  type TrustTier,
} from "@pcc/spec";
import {
  inferLocatorType,
  lookupDomainId,
  lookupSkillId,
} from "../oasf/catalog.js";
import type {
  CosignInput,
  CosignSpawn,
  Publisher,
  PublisherInput,
  PublishResult,
} from "../types.js";

const DEFAULT_ENDPOINT = "https://prod.api.ads.outshift.io";
const DEFAULT_TOP_SKILL_ID = 1001; // agent_orchestration/task_decomposition
const DEFAULT_TOP_DOMAIN_ID = 1500;

// ── OASF record shape (mirror of source adapter's OasfRecord) ─────────────

interface OasfRecord {
  name: string;
  description: string;
  version: string;
  schema_version: string;
  authors: string[];
  created_at: string;
  domains: Array<{ name: string; id: number }>;
  skills: Array<{ name: string; id: number }>;
  modules: OasfModule[];
  locators: Array<{ type: string; urls: string[] }>;
}

// ── Publisher options ─────────────────────────────────────────────────────

export interface AgntcyAdsPublisherOpts {
  /** ADS REST endpoint. Defaults to the hosted public anchor. */
  endpoint?: string;
  /** If false, skip Sigstore signing (records still publish, no proof). */
  enableSigstore?: boolean;
  /**
   * ERC-8004 registry address — projected into the
   * `physical-capability/v1` module's `pcc_facets` block.
   */
  erc8004Registry?: string;
  /** Agent card URL — projected into pcc_facets. */
  agentCardUrl?: string;
  /** MCP server URL — projected into pcc_facets. */
  mcpServerUrl?: string;
}

// ── Publisher ─────────────────────────────────────────────────────────────

export class AgntcyAdsPublisher implements Publisher {
  readonly id = "agntcy-ads";
  readonly targetType: ToolSourceType = "agntcy-dht";
  private readonly opts: AgntcyAdsPublisherOpts;

  constructor(opts: AgntcyAdsPublisherOpts = {}) {
    this.opts = opts;
  }

  async publish(
    tool: IndexedTool,
    input: PublisherInput,
  ): Promise<PublishResult> {
    const endpoint =
      input.endpoint ?? this.opts.endpoint ?? DEFAULT_ENDPOINT;
    const errors: string[] = [];

    if (!input.authToken) {
      return {
        externalCid: "",
        announced: false,
        errors: [
          "AGNTCY publish requires authToken (OIDC bearer from prod.idp.ads.outshift.io)",
        ],
      };
    }

    const fetchImpl = input.fetchImpl ?? fetch;

    // 1. Project the IndexedTool to an OASF record.
    const record = indexedToolToOasf(tool, this.opts);
    const recordBytes = new TextEncoder().encode(JSON.stringify(record));

    // 2. Push to OCI via REST.
    let pushResponse: Response;
    try {
      pushResponse = await fetchImpl(`${endpoint}/v1/records`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.authToken}`,
        },
        body: JSON.stringify(record),
      });
    } catch (e: unknown) {
      return {
        externalCid: "",
        announced: false,
        errors: [`push: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
    if (!pushResponse.ok) {
      return {
        externalCid: "",
        announced: false,
        errors: [`push: ${pushResponse.status} ${pushResponse.statusText}`],
      };
    }
    const pushJson = (await pushResponse.json()) as { cid?: string };
    const cid = pushJson.cid ?? "";
    if (!cid) {
      return {
        externalCid: "",
        announced: false,
        errors: ["push: response missing cid"],
      };
    }

    // 3. Sigstore sign (Phase 1 = cosign shell-out).
    let sigstoreBundle: string | undefined;
    if (this.opts.enableSigstore !== false && input.cosignSpawn) {
      try {
        sigstoreBundle = await input.cosignSpawn({
          payload: recordBytes,
          identityToken: input.authToken,
        });
      } catch (e: unknown) {
        // Sigstore failure is non-fatal in Phase 1 — the record is
        // still indexed (AUTO_INDEXED upstream).
        errors.push(
          `sigstore: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // 4. Announce on DHT (default true).
    let announced = false;
    if (input.announce !== false) {
      try {
        const announceResp = await fetchImpl(
          `${endpoint}/v1/routing/publish`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${input.authToken}`,
            },
            body: JSON.stringify({ cid }),
          },
        );
        announced = announceResp.ok;
        if (!announceResp.ok) {
          errors.push(
            `announce: ${announceResp.status} ${announceResp.statusText}`,
          );
        }
      } catch (e: unknown) {
        errors.push(
          `announce: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return {
      externalCid: cid,
      announced,
      sigstoreBundle,
      errors,
    };
  }
}

export function makeAgntcyAdsPublisher(
  opts: AgntcyAdsPublisherOpts = {},
): AgntcyAdsPublisher {
  return new AgntcyAdsPublisher(opts);
}

// ── Cosign shell-out (Phase 1) ────────────────────────────────────────────

/**
 * Default Cosign shell-out implementation. Phase 1 uses
 * `cosign sign-blob --new-bundle-format` against a stdin payload. Phase
 * 2 swaps this for `@sigstore/sign` in-process to avoid a binary
 * dependency. Returns the bundle as a string.
 *
 * The implementation lives in a separate file (`cosign-shell.ts`) so
 * tests can mock the child_process surface; this module just provides
 * the constructor wiring.
 */
export const cosignShellSpawn: CosignSpawn = async (input: CosignInput) => {
  // Lazy import so the publisher doesn't pull in node:child_process
  // when used in tests with a stubbed cosignSpawn.
  const { runCosignShell } = await import("./cosign-shell.js");
  return runCosignShell(input);
};

// ── Projection: IndexedTool → OASF ────────────────────────────────────────

/**
 * Project an IndexedTool to an OASF agent record. The custom
 * `physical-capability/v1` module carries the PCC-specific fields that
 * the OASF baseline doesn't model.
 */
export function indexedToolToOasf(
  tool: IndexedTool,
  pubOpts: AgntcyAdsPublisherOpts = {},
): OasfRecord {
  return {
    name: tool.upstreamId ?? tool.id,
    description: tool.description,
    version: tool.version,
    schema_version: "1.0.0",
    authors: [
      tool.upstreamVendor ??
        "Physical Capability Cloud <noreply@capability.network>",
    ],
    created_at: tool.ingestedAt,
    domains: tool.domains.map((d) => ({
      name: d,
      id: lookupDomainId(d) ?? DEFAULT_TOP_DOMAIN_ID,
    })),
    skills: tool.skills.map((s) => ({
      name: s,
      id: lookupSkillId(s) ?? DEFAULT_TOP_SKILL_ID,
    })),
    modules: buildPccModules(tool, pubOpts),
    locators: buildLocators(tool),
  };
}

/**
 * Build the OASF `modules[]` array for an IndexedTool. Always includes
 * `tool-schema/v1` (the tool's input/output JSON schema) and
 * `physical-capability/v1` (the PCC facets). Pre-existing
 * `tool.oasfModules` are preserved to keep round-trip fidelity for
 * records ingested from outside — but the publisher's own two slots
 * are deduplicated so we don't double-emit them on republish.
 */
export function buildPccModules(
  tool: IndexedTool,
  pubOpts: AgntcyAdsPublisherOpts,
): OasfModule[] {
  // Preserve incoming modules (round-trip), but drop our own slots so
  // we don't duplicate them on republish.
  const preserved = (tool.oasfModules ?? []).filter(
    (m) =>
      m.name !== "physical-capability/v1" && m.name !== "tool-schema/v1",
  );

  const toolSchema: OasfModule = {
    name: "tool-schema/v1",
    data: {
      input: tool.inputSchema,
      output: tool.outputSchema,
      action_class: tool.actionClass,
    },
  };

  const physicalCapability: OasfModule = {
    name: "physical-capability/v1",
    data: {
      pcc_facets: {
        agent_card_url:
          pubOpts.agentCardUrl ??
          "https://capability.network/.well-known/agent-card.json",
        mcp_url:
          pubOpts.mcpServerUrl ?? "https://capability.network/mcp",
        erc8004_registry:
          pubOpts.erc8004Registry ?? process.env.ERC8004_REGISTRY ?? null,
        dcc_max: tool.assuranceCeiling as DigitalCaptureClass,
        trust_tier: tool.trustTier as TrustTier,
        cid_pcc: tool.cid,
        action_class: tool.actionClass,
        pricing: tool.pricing ?? null,
      },
    },
  };

  return [...preserved, toolSchema, physicalCapability];
}

/**
 * Build the OASF `locators[]` array. Combines the IndexedTool's
 * upstreamUrl and any locatorUrls, inferring locator types from URL
 * shape. Always emits at least one locator to keep the record valid.
 */
export function buildLocators(
  tool: IndexedTool,
): Array<{ type: string; urls: string[] }> {
  const urls = new Set<string>();
  if (tool.upstreamUrl) urls.add(tool.upstreamUrl);
  for (const u of tool.locatorUrls ?? []) urls.add(u);
  // Group by inferred type.
  const grouped = new Map<string, string[]>();
  for (const u of urls) {
    const t = inferLocatorType(u);
    const bucket = grouped.get(t) ?? [];
    bucket.push(u);
    grouped.set(t, bucket);
  }
  const out = Array.from(grouped.entries()).map(([type, urls]) => ({
    type,
    urls,
  }));
  if (out.length === 0) {
    // Fallback so the record always has at least one locator.
    return [
      {
        type: "rest_endpoint",
        urls: [
          `https://capability.network/api/aggregator/tools/${tool.id}`,
        ],
      },
    ];
  }
  return out;
}
