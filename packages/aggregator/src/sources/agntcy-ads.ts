/**
 * AGNTCY ADS source adapter (inbound).
 *
 * Pulls OASF v1.0.0 agent records from the AGNTCY Agent Directory
 * Service (https://docs.agntcy.org/dir/) via REST POST /v1/search
 * (Phase 1) and projects each record into an IndexedTool draft for the
 * universal aggregator pipeline.
 *
 * AGNTCY spec G6: queries MUST specify a `skill` filter — unfiltered
 * queries are rejected at the directory side. We enforce this at
 * construction time so callers get a clear error instead of a 400 from
 * the directory.
 *
 * Round-trip detection: records carrying a `physical-capability/v1`
 * module with a `pcc_facets` block are treated as having originated
 * from a PCC node and preserve PCC_NATIVE / DCC5 trust. Outside records
 * get the `agntcy-dht` default floor (VERIFIED_PARTNER / DCC4).
 *
 * Phase 1 limitations (acceptable for the bridge MVP — see scope doc §4.3):
 *   - REST not gRPC; Phase 2 swaps in @buf/agntcy_oasf-sdk.grpc_node
 *   - No streaming — each fetch() returns one bounded page
 *   - No local DHT participation — reads from the hosted public anchor
 *   - Sigstore identity extraction stubbed — Phase 2 will run live
 *     Rekor proof checks in the enrich stage
 *
 * Spec: ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md §4
 */

import {
  DigitalCaptureClass,
  type IndexedTool,
  type IndexedToolActionClass,
  type OasfModule,
  type SHA256,
  type ToolSourceType,
  TrustTier,
} from "@pcc/spec";
import type { AdapterInput, SourceAdapter } from "../types.js";
import { assertSafeFetchUrl } from "../url-guard.js";

// ── OASF record shape (subset of v1.0.0 we consume) ───────────────────────

/**
 * One OASF agent record per the v1.0.0 schema. Mirrors the shape at
 * https://docs.agntcy.org/oasf/agent-record-guide/.
 */
export interface OasfRecord {
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

interface SearchResponse {
  records?: OasfRecord[];
  cids?: string[];
}

// ── Adapter options ───────────────────────────────────────────────────────

export interface AgntcyAdsAdapterOptions {
  /**
   * Skill filter — REQUIRED per AGNTCY spec G6. Queries omitting a skill
   * filter are rejected to prevent unbounded scans.
   */
  skill: string;
  /** Optional domain intersection (slash-hierarchical slugs). */
  domains?: string[];
  /** Optional feature/module intersection. */
  features?: string[];
  /** Page size, max 100 per AGNTCY spec. Defaults to 50. */
  limit?: number;
  /**
   * OIDC bearer token for the hosted IdP (`prod.idp.ads.outshift.io`).
   * Anonymous reads work against the public anchor; tokens are only
   * required for publish.
   */
  authToken?: string;
}

const DEFAULT_LIMIT = 50;

// ── Adapter ───────────────────────────────────────────────────────────────

export class AgntcyAdsSourceAdapter implements SourceAdapter {
  readonly id = "agntcy-ads";
  readonly sourceType: ToolSourceType = "agntcy-dht";
  private readonly opts: AgntcyAdsAdapterOptions;

  constructor(opts: AgntcyAdsAdapterOptions) {
    if (!opts.skill || opts.skill.trim().length === 0) {
      throw new Error(
        "AgntcyAdsSourceAdapter: `skill` is required (AGNTCY spec rejects unfiltered queries)",
      );
    }
    this.opts = opts;
  }

  async fetch(input: AdapterInput): Promise<IndexedTool[]> {
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = new Date().toISOString();

    // SSRF guard — reject internal/private/loopback hosts BEFORE fetch.
    // Mirrors the McpSourceAdapter pattern in this package.
    assertSafeFetchUrl(input.url);

    // The base URL passed in `input.url` is the AGNTCY endpoint (e.g.
    // "https://prod.api.ads.outshift.io"). We append /v1/search for the
    // REST call.
    const searchUrl = joinUrl(input.url, "/v1/search");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(input.headers ?? {}),
    };
    if (this.opts.authToken) {
      headers["Authorization"] = `Bearer ${this.opts.authToken}`;
    }

    const body = JSON.stringify({
      skill: this.opts.skill,
      domains: this.opts.domains ?? [],
      features: this.opts.features ?? [],
      limit: this.opts.limit ?? DEFAULT_LIMIT,
    });

    const response = await fetchImpl(searchUrl, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      throw new Error(
        `AGNTCY ADS search ${response.status} ${response.statusText} from ${searchUrl}`,
      );
    }
    const json = (await response.json()) as SearchResponse;
    const records = json.records ?? [];
    const cids = json.cids ?? [];

    const drafts: IndexedTool[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const cid = cids[i] ?? "unknown";
      drafts.push(oasfToIndexedTool(record, cid, input.url, now));
    }
    return drafts;
  }
}

export function makeAgntcyAdsSourceAdapter(
  opts: AgntcyAdsAdapterOptions,
): AgntcyAdsSourceAdapter {
  return new AgntcyAdsSourceAdapter(opts);
}

// ── Projection: OASF → IndexedTool ────────────────────────────────────────

/**
 * Project one OASF record to an IndexedTool draft. The pipeline's
 * enrich stage fills in the canonical `cid` and may further upgrade
 * trust after Sigstore verification.
 *
 * Round-trip detection: if a `physical-capability/v1` module is present
 * with a `pcc_facets` block, we treat this record as having originated
 * from a PCC node and preserve PCC_NATIVE / DCC5. Otherwise we use the
 * agntcy-dht defaults (VERIFIED_PARTNER / DCC4) — the trust mapper may
 * downgrade later if Sigstore verification fails.
 */
export function oasfToIndexedTool(
  record: OasfRecord,
  agntcyCid: string,
  endpoint: string,
  now: string,
): IndexedTool {
  // Locator triage — prefer a callable surface for upstreamUrl.
  const restLoc = record.locators.find((l) => l.type === "rest_endpoint");
  const mcpLoc = record.locators.find((l) => l.type === "mcp_server");
  const a2aLoc = record.locators.find((l) => l.type === "a2a_card");
  const sourceCodeLoc = record.locators.find((l) => l.type === "source_code");
  const primaryUrl =
    restLoc?.urls[0] ??
    mcpLoc?.urls[0] ??
    a2aLoc?.urls[0] ??
    sourceCodeLoc?.urls[0] ??
    endpoint;

  // Round-trip detection.
  const physicalCapModule = record.modules.find(
    (m) => m.name === "physical-capability/v1",
  );
  const pccFacets = (physicalCapModule?.data?.pcc_facets ?? undefined) as
    | { dcc_max?: string; trust_tier?: string; cid_pcc?: string }
    | undefined;
  const isPccRoundTrip = pccFacets != null && typeof pccFacets === "object";

  // Placeholder CID — pipeline.enrich recomputes from canonical JSON.
  const placeholderCid =
    `sha256:${"0".repeat(64)}` as SHA256;

  // Description: clamp to 280 chars per the autoSummarize policy.
  const desc = autoSummarize(record.description);

  // Input/output schemas: ride on the optional tool-schema/v1 module.
  const toolSchemaModule = record.modules.find(
    (m) => m.name === "tool-schema/v1",
  );
  const inputSchema =
    (toolSchemaModule?.data?.input as Record<string, unknown> | undefined) ?? {};
  const outputSchema = toolSchemaModule?.data?.output as
    | Record<string, unknown>
    | undefined;

  // Trust defaults — PCC_NATIVE/DCC5 on round-trip, otherwise
  // VERIFIED_PARTNER/DCC4 floor for agntcy-dht.
  const assuranceCeiling: DigitalCaptureClass = isPccRoundTrip
    ? coerceDcc(pccFacets?.dcc_max) ?? DigitalCaptureClass.DCC5
    : DigitalCaptureClass.DCC4;
  const trustTier: TrustTier = isPccRoundTrip
    ? coerceTrustTier(pccFacets?.trust_tier) ?? TrustTier.PCC_NATIVE
    : TrustTier.VERIFIED_PARTNER;

  return {
    id: `agntcy:${agntcyCid}`,
    cid: placeholderCid,
    version: record.version,
    source: {
      type: "agntcy-dht",
      url: joinUrl(endpoint, `/v1/records/${agntcyCid}`),
      fetchedAt: now,
      scoreSnapshot: {
        agntcyRecordSize: JSON.stringify(record).length,
      },
    },
    ingestedAt: now,
    ingestionMethod: "oasf",
    upstreamId: record.name,
    upstreamUrl: primaryUrl,
    upstreamVendor: record.authors[0],
    skills: record.skills.map((s) => s.name),
    domains: record.domains.map((d) => d.name),
    features: record.modules.map((m) => m.name),
    inputSchema,
    outputSchema,
    description: desc,
    actionClass: inferActionClassFromSkills(record.skills),
    assuranceCeiling,
    trustTier,
    knownVulns: [],
    lastFetchedAt: now,
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [],
    hostingPeers: [],
    // OASF round-trip fields.
    locatorUrls: record.locators.flatMap((l) => l.urls),
    oasfModules: record.modules,
    agntcyRecordCid: agntcyCid,
  };
}

/**
 * Infer a coarse action-class hint from the record's skills. The
 * tool-broker's risk classifier refines this later.
 *
 * Order matters — the most restrictive class wins when keywords overlap.
 */
export function inferActionClassFromSkills(
  skills: Array<{ name: string }>,
): IndexedToolActionClass {
  const names = skills.map((s) => s.name).join(" ").toLowerCase();
  if (/secret|credential|key|token|password/.test(names)) return "credential";
  if (/delete|remove|write|create|update|publish|push|deploy/.test(names)) {
    return "write";
  }
  if (/execute|invoke|run|trigger|exec/.test(names)) return "exec";
  if (/fetch|request|http|network|connect/.test(names)) return "network";
  return "read";
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Auto-summarize a description to ≤280 chars per the autoSummarize
 * policy (DMCA-safe). Mirrors the helper in `mcp.ts`.
 */
function autoSummarize(input: string | undefined): string {
  if (!input) return "(no description)";
  const trimmed = input.trim();
  if (trimmed.length <= 280) return trimmed;
  const cut = trimmed.slice(0, 280);
  const lastDot = cut.lastIndexOf(".");
  if (lastDot > 100) return cut.slice(0, lastDot + 1);
  return cut + "…";
}

/** Join a base URL with a path, normalizing slashes. */
function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** Coerce a string to a DigitalCaptureClass enum, if valid. */
function coerceDcc(value: string | undefined): DigitalCaptureClass | undefined {
  if (!value) return undefined;
  const valid = ["DCC0", "DCC1", "DCC2", "DCC3", "DCC4", "DCC5"] as const;
  return (valid as readonly string[]).includes(value)
    ? (value as DigitalCaptureClass)
    : undefined;
}

/** Coerce a string to a TrustTier enum, if valid. */
function coerceTrustTier(value: string | undefined): TrustTier | undefined {
  if (!value) return undefined;
  const valid = [
    "QUARANTINED",
    "UNTRUSTED",
    "AUTO_INDEXED",
    "VERIFIED_PUBLISHER",
    "VERIFIED_PARTNER",
    "PCC_NATIVE",
  ] as const;
  return (valid as readonly string[]).includes(value)
    ? (value as TrustTier)
    : undefined;
}
