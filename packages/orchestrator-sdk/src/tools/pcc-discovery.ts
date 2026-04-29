// PCC discovery — replaces Senso/cited.md and agentic.market.
// Operators are announced into the PCC's own discovery surfaces:
//
//   1. POST /api/onboard/register     — persistent registration record (open, no auth required).
//                                       Verified live: returns {status, registration: {id, ...}}.
//   2. POST /api/dht/announce         — broadcasts capabilities to the gossip network so
//                                       buyer agents see them via /api/dht/query.
//                                       Requires Authorization: Bearer pcc_live_* (best-effort —
//                                       degraded path skips DHT and returns the registration only).
//   3. GET  /api/capabilities/search?q=  — search the catalog (open, no auth).
//   4. GET  /api/capabilities/templates?query=  — search templates (open, no auth).
//
// Endpoint shapes confirmed by probing https://capability.network on 2026-04-24
// (wave 1.3 Navi v2 migration). Source of truth for the tool list:
// https://capability.network/agent-package.json (schema pcc-agent-package/2.0).
//
// Mode: when MOCK_PCC_DISCOVERY=true returns deterministic fakes so the
// wider build flow can run without a live network. Defaults to FALSE so
// production deploys never silently mint fake registration IDs — set the
// env var explicitly when running fixture-driven tests / dev runs.
//
// Ported from `LamaSu/navi` packages/backend/src/tools/pcc-discovery.ts. Wave 2
// adapts the base URL to live in PCC's ENV name space.
//
// T1.8 (2026-04-29): default flipped from `!== "false"` to `=== "true"`.

import { emit } from "../core/event-bus.js";

const MOCK = process.env.MOCK_PCC_DISCOVERY === "true";
const PCC_BASE = process.env.PCC_BASE_URL ?? "https://capability.network";
const PCC_API_KEY = process.env.PCC_API_KEY ?? "";

export interface DiscoveryProfile {
  enterprise_id: string;
  name: string;
  url?: string;
  city?: string;
  capabilities: string[];
  materials?: string[];
  hours?: string;
  certifications?: string[];
  agent_url?: string;
  marketplace_url?: string;
  contact_email?: string;
}

export interface PublishResult {
  registration_id: string;
  discovery_url: string;
  dht_announced: boolean;
  dht_error?: string;
}

export interface SearchOptions {
  limit?: number;
  type?: string;
}

/**
 * Announce an operator profile to PCC. Two-step process:
 *   1. Always: register them via /api/onboard/register so they have a persistent
 *      registration_id. This works without auth and is the canonical "they
 *      exist on PCC" record.
 *   2. Best-effort: announce to the DHT so buyer agents can discover them.
 *      Requires PCC_API_KEY; if absent or rejected we report dht_announced=false
 *      with the specific error and continue.
 */
export async function publishOperator(profile: DiscoveryProfile): Promise<PublishResult> {
  emit({
    kind: "pcc.discovery.start",
    sponsor: "PCC",
    level: "info",
    session_id: profile.enterprise_id,
    text: `announcing ${profile.name} (${profile.capabilities.length} capabilities) to ${PCC_BASE}`,
    payload: { capabilities_count: profile.capabilities.length },
  });

  if (MOCK) {
    const r: PublishResult = {
      registration_id: `pcc-mock-reg-${profile.enterprise_id.slice(0, 8)}`,
      discovery_url: `${PCC_BASE}/operators/${profile.enterprise_id.slice(0, 8)}`,
      dht_announced: true,
    };
    emit({
      kind: "pcc.discovery.mock",
      sponsor: "PCC",
      level: "warn",
      text: `MOCK_PCC_DISCOVERY=true · returning fake registration_id`,
      payload: r as unknown as Record<string, unknown>,
    });
    return r;
  }

  // Step 1: persistent registration (open endpoint).
  const registerBody = {
    name: profile.name,
    category: "custom",
    description: profile.capabilities.slice(0, 3).join(" · "),
    capabilities: profile.capabilities.map((label, i) => ({
      id: `cap-${i}`,
      type: "custom",
      name: label,
    })),
    operator: {
      walletAddress: "0x0000000000000000000000000000000000000000",
      displayName: profile.name,
      certifications: profile.certifications ?? [],
      trainingAcknowledgments: {},
      contact_email: profile.contact_email,
    },
  };

  const regRes = await fetch(`${PCC_BASE}/api/onboard/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registerBody),
  });
  if (!regRes.ok) {
    const text = await regRes.text();
    emit({
      kind: "pcc.discovery.err",
      sponsor: "PCC",
      level: "err",
      session_id: profile.enterprise_id,
      text: `register failed: HTTP ${regRes.status} ${text.slice(0, 120)}`,
    });
    throw new Error(`PCC register failed: ${regRes.status} ${text}`);
  }
  const reg = (await regRes.json()) as { status: string; registration: { id: string } };
  const registration_id = reg.registration?.id ?? `reg-${Date.now()}`;
  const discovery_url = `${PCC_BASE}/operators/${registration_id}`;

  // Step 2: DHT announce (best-effort).
  let dht_announced = false;
  let dht_error: string | undefined;
  if (!PCC_API_KEY) {
    dht_error = "PCC_API_KEY not set — DHT announce skipped";
  } else {
    try {
      const dhtBody = {
        kernelId: registration_id,
        capabilities: profile.capabilities.map((c) => ({ type: "custom", name: c })),
        ttlSeconds: 3600,
      };
      const dhtRes = await fetch(`${PCC_BASE}/api/dht/announce`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PCC_API_KEY}`,
        },
        body: JSON.stringify(dhtBody),
      });
      if (dhtRes.ok) {
        dht_announced = true;
      } else {
        dht_error = `HTTP ${dhtRes.status}: ${(await dhtRes.text()).slice(0, 120)}`;
      }
    } catch (e) {
      dht_error = e instanceof Error ? e.message : String(e);
    }
  }

  const result: PublishResult = { registration_id, discovery_url, dht_announced, dht_error };
  emit({
    kind: "pcc.discovery.done",
    sponsor: "PCC",
    level: dht_announced ? "ok" : "warn",
    session_id: profile.enterprise_id,
    text: `registered ${registration_id}${dht_announced ? " · DHT announced" : ` · DHT skipped (${dht_error})`}`,
    payload: result as unknown as Record<string, unknown>,
  });
  return result;
}

/**
 * Search the PCC capability network. Returns templates + matching capabilities.
 * Open endpoint, no auth required.
 */
export async function searchCapabilities(
  query: string,
  opts: SearchOptions = {}
): Promise<{ templates: unknown[]; items: unknown[] }> {
  if (MOCK) {
    return {
      templates: [
        { capabilityType: "fdm", name: "FDM 3D Printing", basePrice: "15.00", currency: "USDC" },
      ],
      items: [],
    };
  }
  const limit = opts.limit ?? 10;
  const [tplRes, itemRes] = await Promise.all([
    fetch(`${PCC_BASE}/api/capabilities/templates?query=${encodeURIComponent(query)}`),
    fetch(`${PCC_BASE}/api/capabilities/search?q=${encodeURIComponent(query)}&limit=${limit}`),
  ]);
  if (!tplRes.ok) throw new Error(`PCC templates search failed: ${tplRes.status}`);
  if (!itemRes.ok) throw new Error(`PCC capabilities search failed: ${itemRes.status}`);
  const tpl = (await tplRes.json()) as { templates?: unknown[] };
  const items = (await itemRes.json()) as { items?: unknown[] };
  return { templates: tpl.templates ?? [], items: items.items ?? [] };
}
