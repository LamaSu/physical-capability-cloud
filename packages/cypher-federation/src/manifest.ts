/**
 * buildPccFederationManifest — generate the body for
 * `POST /api/federation/instances/register`.
 *
 * The PCC capability list is fetched live from
 * `${gatewayUrl}/api/capabilities/types` (and, when available,
 * `/api/capabilities/templates` for friendly names + base price). We
 * keep the network call narrow and tolerant: if `templates` is
 * missing or unauthenticated the manifest still ships a usable
 * service entry built from the type string alone.
 */

import type { FederationManifest, PccCapabilitySummary } from "./types.js";

export interface BuildManifestOptions {
  /** PCC gateway base URL (e.g. `https://capability.network`). */
  gatewayUrl: string;
  /** Stable instance id Cypher will refer to PCC by. */
  instanceId: string;
  /** Display name. */
  name: string;
  /** Public URL of the PCC peer endpoint. */
  baseUrl: string;
  /** Contact email (Cypher displays this on the instance card). */
  contactEmail: string;
  /** Free-text description. */
  description?: string;
  /** Inject a custom fetch (for tests). */
  fetchImpl?: typeof fetch;
  /**
   * Optional bearer token for the PCC gateway. When provided we'll
   * call `/api/capabilities/templates` for richer service metadata;
   * without it we fall back to types-only.
   */
  pccApiKey?: string;
  /** Skip the network call entirely and ship the manifest with no services. */
  skipServices?: boolean;
}

/**
 * Fetch PCC's capability catalog and reduce it to summaries usable
 * in the federation manifest.
 *
 * `GET /api/capabilities/types` is PUBLIC and returns
 * `{ types: string[] }` — that's the floor. With a bearer token we
 * also try `/api/capabilities/templates` which exposes pricing hints
 * and human names; failures there are non-fatal.
 */
export async function fetchPccCapabilities(
  gatewayUrl: string,
  opts: { fetchImpl?: typeof fetch; pccApiKey?: string } = {},
): Promise<PccCapabilitySummary[]> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = gatewayUrl.replace(/\/+$/, "");

  // 1. Always pull types — public endpoint.
  let types: string[] = [];
  try {
    const r = await fetchImpl(`${base}/api/capabilities/types`, {
      headers: opts.pccApiKey ? { Authorization: `Bearer ${opts.pccApiKey}` } : {},
    });
    if (r.ok) {
      const body = (await r.json()) as { types?: string[] };
      if (Array.isArray(body.types)) types = body.types;
    }
  } catch {
    // Soft fail — the manifest can still register without services.
    types = [];
  }

  // 2. Try templates for richer metadata. Auth-required, so this is
  //    expected to fail when no key is provided. Non-fatal.
  let templates: Array<Record<string, unknown>> = [];
  if (opts.pccApiKey) {
    try {
      const r = await fetchImpl(`${base}/api/capabilities/templates`, {
        headers: { Authorization: `Bearer ${opts.pccApiKey}` },
      });
      if (r.ok) {
        const body = (await r.json()) as { templates?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
        templates = Array.isArray(body) ? body : body.templates ?? [];
      }
    } catch {
      templates = [];
    }
  }

  const byType = new Map<string, Record<string, unknown>>();
  for (const t of templates) {
    const tt = (t.type ?? t.capabilityType) as string | undefined;
    if (typeof tt === "string") byType.set(tt, t);
  }

  return types.map((type) => {
    const tmpl = byType.get(type);
    const summary: PccCapabilitySummary = {
      id: `pcc-tmpl-${type}`,
      kernelId: "pcc-network",
      type,
      name: typeof tmpl?.name === "string" ? (tmpl.name as string) : humanizeType(type),
      description:
        typeof tmpl?.description === "string"
          ? (tmpl.description as string)
          : `PCC capability of type "${type}". Routed across all online PCC kernels.`,
      assuranceTiers:
        Array.isArray(tmpl?.assuranceTiers)
          ? (tmpl?.assuranceTiers as number[]).filter((n): n is number => typeof n === "number")
          : [0, 1, 2],
      pricing: {
        currency: typeof tmpl?.currency === "string" ? (tmpl?.currency as string) : "USD",
        baseCost: typeof tmpl?.basePrice === "string" || typeof tmpl?.basePrice === "number" ? (tmpl?.basePrice as string | number) : undefined,
        pricingModel: "quote",
        priceDescription:
          typeof tmpl?.priceDescription === "string" ? (tmpl?.priceDescription as string) : "Quote on submit",
      },
      tags: Array.isArray(tmpl?.tags) ? (tmpl?.tags as string[]) : undefined,
      inputSchema:
        tmpl && typeof tmpl?.inputSchema === "object" && tmpl?.inputSchema !== null
          ? (tmpl?.inputSchema as Record<string, unknown>)
          : undefined,
    };
    return summary;
  });
}

/**
 * Build a manifest body from PCC env + live capability list.
 *
 * Returns the JSON body Cypher expects at
 * `POST /api/federation/instances/register`. Safe to log /
 * print — contains no secrets.
 */
export async function buildPccFederationManifest(
  opts: BuildManifestOptions,
): Promise<FederationManifest> {
  if (!opts.instanceId) throw new Error("buildPccFederationManifest: instanceId required");
  if (!opts.name) throw new Error("buildPccFederationManifest: name required");
  if (!opts.baseUrl) throw new Error("buildPccFederationManifest: baseUrl required");
  if (!opts.gatewayUrl) throw new Error("buildPccFederationManifest: gatewayUrl required");

  const services = opts.skipServices
    ? []
    : await fetchPccCapabilities(opts.gatewayUrl, {
        fetchImpl: opts.fetchImpl,
        pccApiKey: opts.pccApiKey,
      });

  const manifest: FederationManifest = {
    instanceId: opts.instanceId,
    name: opts.name,
    baseUrl: opts.baseUrl,
    contactEmail: opts.contactEmail ?? "",
    description:
      opts.description ??
      "Physical Capability Cloud — physical manufacturing capabilities (3D printing, CNC, HPLC, PCB, lab work) routed via assurance-tiered escrow.",
    services,
  };
  return manifest;
}

function humanizeType(type: string): string {
  return type
    .split(/[-_]/g)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
