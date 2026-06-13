/**
 * seed-pizza-demo.ts — bootstrap the vibecodenights pizza demo.
 *
 * Seeds:
 *   - 3 pizza shops as compose-engine candidates AND graph-search nodes
 *     (capabilityType "make-pizza", produces "pizza")
 *   - 4 delivery drivers as compose-engine candidates AND graph-search nodes
 *     (capabilityType "delivered-pizza", consumes "pizza", produces "delivered-pizza")
 *   - graph-search edges: every shop → every driver via "pizza" handoff (12 edges)
 *
 * Usage:
 *   PCC_BASE=https://capability.network PCC_API_KEY=pcc_live_... pnpm tsx scripts/seed-pizza-demo.ts
 *
 * The shop/driver slugs match the URLs the demo UIs use:
 *   operator.html?shop=<slug>
 *   driver.html?driver=<slug>
 */

const BASE = (process.env.PCC_BASE ?? "http://localhost:8080").replace(/\/$/, "");
const KEY = process.env.PCC_API_KEY ?? "";

interface ProviderSpec {
  slug: string;
  name: string;
  capabilityType: string;
  priceUSD: number;
  etaMs: number;
  tier: 0 | 1 | 2 | 3;
  reputation: number;
  location: { lat: number; lng: number };
  outputTypes: string[];
  inputTypes: string[];
}

const SHOPS: ProviderSpec[] = [
  {
    slug: "shop-roma",
    name: "Pizza Roma",
    capabilityType: "make-pizza",
    priceUSD: 15,
    etaMs: 15 * 60_000,
    tier: 1,
    reputation: 600,
    location: { lat: 37.78, lng: -122.41 },
    outputTypes: ["pizza"],
    inputTypes: [],
  },
  {
    slug: "shop-slice-heaven",
    name: "Slice Heaven",
    capabilityType: "make-pizza",
    priceUSD: 12,
    etaMs: 20 * 60_000,
    tier: 1,
    reputation: 540,
    location: { lat: 37.77, lng: -122.40 },
    outputTypes: ["pizza"],
    inputTypes: [],
  },
  {
    slug: "shop-mamas-kitchen",
    name: "Mama's Kitchen",
    capabilityType: "make-pizza",
    priceUSD: 18,
    etaMs: 25 * 60_000,
    tier: 2,
    reputation: 720,
    location: { lat: 37.76, lng: -122.42 },
    outputTypes: ["pizza"],
    inputTypes: [],
  },
];

const DRIVERS: ProviderSpec[] = [
  {
    slug: "driver-alex",
    name: "Alex",
    capabilityType: "delivered-pizza",
    priceUSD: 5,
    etaMs: 25 * 60_000,
    tier: 1,
    reputation: 580,
    location: { lat: 37.78, lng: -122.41 },
    outputTypes: ["delivered-pizza"],
    inputTypes: ["pizza"],
  },
  {
    slug: "driver-beth",
    name: "Beth",
    capabilityType: "delivered-pizza",
    priceUSD: 7,
    etaMs: 22 * 60_000,
    tier: 1,
    reputation: 620,
    location: { lat: 37.77, lng: -122.42 },
    outputTypes: ["delivered-pizza"],
    inputTypes: ["pizza"],
  },
  {
    slug: "driver-carlos",
    name: "Carlos",
    capabilityType: "delivered-pizza",
    priceUSD: 6,
    etaMs: 28 * 60_000,
    tier: 1,
    reputation: 560,
    location: { lat: 37.79, lng: -122.40 },
    outputTypes: ["delivered-pizza"],
    inputTypes: ["pizza"],
  },
  {
    slug: "driver-dana",
    name: "Dana",
    capabilityType: "delivered-pizza",
    priceUSD: 4,
    etaMs: 30 * 60_000,
    tier: 1,
    reputation: 510,
    location: { lat: 37.76, lng: -122.43 },
    outputTypes: ["delivered-pizza"],
    inputTypes: ["pizza"],
  },
];

function authHeaders(): Record<string, string> {
  return KEY ? { authorization: `Bearer ${KEY}` } : {};
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    const detail = (j.message as string) || (j.error as string) || `${r.status}`;
    throw new Error(`${method} ${path} → ${r.status} · ${detail}`);
  }
  return j;
}

async function registerComposeCandidate(p: ProviderSpec): Promise<void> {
  await api("POST", "/api/compose/_dev/register-candidate", {
    capabilityId: `cap_${p.slug}`,
    kernelId: `k_${p.slug}`,
    operatorAddress: `${p.slug}@vibecode-demo`,
    capabilityType: p.capabilityType,
    estimatedPriceUSD: p.priceUSD,
    estimatedDurationMs: p.etaMs,
    assuranceTier: p.tier,
    reputation: p.reputation,
    location: p.location,
    available: true,
  });
}

async function registerGraphNode(p: ProviderSpec): Promise<void> {
  await api("POST", "/api/graph-search/_dev/register-node", {
    capabilityId: `cap_${p.slug}`,
    capabilityType: p.capabilityType,
    kernelId: `k_${p.slug}`,
    estimatedPriceUSD: p.priceUSD,
    estimatedDurationMs: p.etaMs,
    assuranceTier: p.tier,
    reputation: p.reputation,
    available: true,
    inputTypes: p.inputTypes,
    outputTypes: p.outputTypes,
  });
}

async function registerGraphEdge(from: string, to: string): Promise<void> {
  await api("POST", "/api/graph-search/_dev/register-edge", {
    fromCapabilityId: `cap_${from}`,
    toCapabilityId: `cap_${to}`,
    capabilityTypeFlow: "pizza",
    estimatedHandoffPriceUSD: 0,
  });
}

async function main(): Promise<void> {
  console.log(`▣ seeding pizza-demo against ${BASE}`);
  if (!KEY) console.log("  (no PCC_API_KEY — will only work against a gateway without auth)");

  let okShops = 0, failShops = 0;
  for (const s of SHOPS) {
    try {
      await registerComposeCandidate(s);
      await registerGraphNode(s);
      console.log(`  ✓ shop ${s.slug.padEnd(20)} $${s.priceUSD}/pizza · tier ${s.tier} · rep ${s.reputation}`);
      okShops++;
    } catch (e) {
      console.error(`  ✗ shop ${s.slug}: ${(e as Error).message}`);
      failShops++;
    }
  }

  let okDrivers = 0, failDrivers = 0;
  for (const d of DRIVERS) {
    try {
      await registerComposeCandidate(d);
      await registerGraphNode(d);
      console.log(`  ◐ driver ${d.slug.padEnd(20)} $${d.priceUSD}/delivery · tier ${d.tier} · rep ${d.reputation}`);
      okDrivers++;
    } catch (e) {
      console.error(`  ✗ driver ${d.slug}: ${(e as Error).message}`);
      failDrivers++;
    }
  }

  let okEdges = 0, failEdges = 0;
  for (const s of SHOPS) for (const d of DRIVERS) {
    try {
      await registerGraphEdge(s.slug, d.slug);
      okEdges++;
    } catch (e) {
      console.error(`  ✗ edge ${s.slug}→${d.slug}: ${(e as Error).message}`);
      failEdges++;
    }
  }

  console.log("");
  console.log(`✓ seeded ${okShops}/${SHOPS.length} shops, ${okDrivers}/${DRIVERS.length} drivers, ${okEdges} graph edges`);
  if (failShops + failDrivers + failEdges > 0) {
    console.log(`✗ ${failShops + failDrivers + failEdges} failures — check the messages above`);
    process.exit(1);
  }

  console.log("");
  console.log("next:");
  console.log(`  ${BASE}/order.html                              ← user/orderer`);
  SHOPS.forEach(s => console.log(`  ${BASE}/operator.html?shop=${s.slug}    ← ${s.name}`));
  DRIVERS.forEach(d => console.log(`  ${BASE}/driver.html?driver=${d.slug}    ← ${d.name}`));
}

main().catch((e: Error) => { console.error(e.message); process.exit(1); });
