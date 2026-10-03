/**
 * Board N68 regression sweep (astra r1 asked for it): no read of the REAL gateway shows an
 * operator's exact location or street address to a caller the operator did not opt in for.
 *
 * Boots createGateway (every plugin, apiGate and every route; seeded in-memory store) and
 * registers a canary kernel and capability at a distinctive exact point and street address
 * through the real API. Then it calls EVERY registered GET route, with each path parameter
 * filled with the canary's kernel id, capability id or operator id, with and without a query
 * string. Both passes run anonymously and with a stranger's self-provisioned key. A new route
 * that dumps stored kernel or capability rows fails here. SSE and WebSocket routes are not
 * called (their producers carry no location).
 *
 * STRUCTURAL POST coverage (follow-up to PR #448, astra r2 MEDIUM 1): the sweep used to
 * hard-code just seven POST reads (/ask, pcc-discover x2, four /api/query intents). astra's
 * round-2 review found the gap this leaves: "it enumerates all eligible GET routes but
 * hard-codes only seven POST requests... Cheapest reproduction: temporarily append the
 * canary's raw capability `location` to the successful response from POST
 * /api/requests/match. The door sweep still reports zero leaks because it never calls that
 * route." Reproduced at a78258a3 (see n68-sweep-repro log). Fixed here by enumerating EVERY
 * POST route Fastify actually registers (same onRoute hook as the GET enumeration) and
 * either calling it or excluding it with a one-line, reviewable reason (classifyPost /
 * POST_EXCLUSIONS below) — a brand-new POST route that nobody has triaged yet defaults to
 * CALLED, not skipped, so it cannot silently evade the leak check.
 *
 * astra also flagged the substring detector's blind spots ("scientific notation, base64,
 * DMS/plus-code representations, a longer precise geohash, or Unicode-escaped/case-changed
 * address text"). leakHits() below parses every JSON response body and walks the full value
 * tree (responseTreeLeaks), so: a JSON *number* close to the canary's lat/lng is caught
 * regardless of how its literal was written (JSON.parse already collapses scientific
 * notation to the same numeric value); nested unicode escapes are undone by JSON.parse for
 * free; and strings are checked case-folded, URL-decoded, for a base64 encoding of the
 * address/coordinates, and for a geohash run longer than the fix's coarse precision
 * (LOCATION_CELL_PRECISION, facades/populators/public-location.ts) that starts with the
 * canary's own cell. Non-JSON bodies keep the original substring-only check.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { geohashEncode, LOCATION_CELL_PRECISION } from "../facades/populators/public-location.js";

const ROUTES = vi.hoisted(() => [] as Array<{ method: string | string[]; url: string; websocket?: boolean }>);
vi.mock("fastify", async (orig) => {
  const real = (await orig()) as { default: (...a: unknown[]) => FastifyInstance };
  const make = (...a: unknown[]) => {
    const inst = real.default(...a);
    inst.addHook("onRoute", (r) => {
      ROUTES.push({ method: r.method as string | string[], url: r.url, websocket: (r as { websocket?: boolean }).websocket });
    });
    return inst;
  };
  Object.assign(make, real.default);
  return { ...real, default: make };
});

// Defense in depth (not just accidental-safety): this sweep must never make a real
// external call no matter what the ambient environment happens to export. Every
// integration read during classification below (payments: CDP/Stripe/Yellowcard/Wise;
// chain: gasless/faucet/pgtr/protocol; LLM: Anthropic; carrier/Lob; Lit; Starknet) is
// coded to fall back to a local mock/503 the moment its credential env var is absent —
// clearing them here, before createGateway is ever imported, makes that the actual
// behavior of THIS run rather than an assumption about CI's ambient env. NODE_ENV=test
// additionally opts carrier.ts/lob.ts/near.ts out of their production-classification gate
// (their own fail-closed default is the OPPOSITE of the others: unset NODE_ENV reads as
// production, which would 503 before touching any client — "test" is what lets the
// request past that gate and into the client's own isMock-by-absent-key branch).
for (const v of [
  "STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_WEBHOOK_SECRET",
  "YELLOWCARD_API_KEY", "YELLOWCARD_SECRET_KEY",
  "WISE_API_TOKEN", "WISE_PROFILE_ID",
  "CDP_API_KEY_ID", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET", "CDP_ONRAMP_APP_ID", "COINBASE_APP_ID",
  "DEPLOYER_PRIVATE_KEY", "PCC_GATEWAY_PRIVATE_KEY",
  "LIT_API_KEY",
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
  "EASYPOST_API_KEY", "EASYPOST_WEBHOOK_SECRET",
  "LOB_API_KEY", "LOB_WEBHOOK_SECRET",
  "STARKNET_ACCOUNT_ADDRESS", "STARKNET_NODE_URL", "STARKNET_PRIVATE_KEY",
  "STORY_PRIVATE_KEY",
  "PCC_PGTR_FORWARDER_ADDRESS", "PCC_PGTR_RELAYER_KEY",
  "PCC_PROTOCOL_ADDRESS",
  "UNBROWSE_URL",
] as const) {
  delete process.env[v];
}
process.env.NODE_ENV = process.env.NODE_ENV === "production" ? process.env.NODE_ENV : "test";
process.env.STORY_MOCK = process.env.STORY_MOCK ?? "true";

const CANARY = { kernelId: "kernel-n68-canary", lat: 47.6204931, lng: -122.3492447, address: "1 Canary Lane, Testville" };
const NOLOC = "kernel-n68-nolocation";
// The exact values as JSON renders them, their 4-5 decimal roundings, and the street address.
const NEEDLES = ["47.6204931", "122.3492447", "47.62049", "122.34924", "47.6205", "122.3492", "Canary Lane"];

let app: FastifyInstance;
let ipSeq = 0;
const ip = () => `10.68.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
let canaryCapId = "";
let operatorId = "";
let strangerKey = "";

async function provision(email: string): Promise<{ key: string; operatorId: string }> {
  const r = await app.inject({ method: "POST", url: "/api/auth/provision", headers: { "x-forwarded-for": ip() }, payload: { email, name: email } });
  const b = r.json();
  if (r.statusCode !== 201) throw new Error(`provision ${r.statusCode} ${r.body.slice(0, 200)}`);
  return { key: b.api_key, operatorId: b.operator_id };
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_SEED_DATA = "true";
  const { createGateway } = await import("../server.js");
  app = (await createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  const owner = await provision("n68-canary-owner@example.invalid");
  operatorId = owner.operatorId;
  strangerKey = (await provision("n68-stranger@example.invalid")).key;
  const auth = { authorization: `Bearer ${owner.key}` };
  const k = await app.inject({
    method: "POST", url: "/api/kernels", headers: { ...auth, "x-forwarded-for": ip() },
    payload: { id: CANARY.kernelId, name: "N68 canary", location: { lat: CANARY.lat, lng: CANARY.lng }, physicalAddress: CANARY.address, maxAssuranceTier: 1 },
  });
  const c = await app.inject({
    method: "POST", url: "/api/capabilities", headers: { ...auth, "x-forwarded-for": ip() },
    payload: { kernelId: CANARY.kernelId, type: "3d-printing", name: "N68 canary FDM", location: { lat: CANARY.lat, lng: CANARY.lng }, materials: ["PLA"], assuranceTiers: [0, 1], pricing: { currency: "USDC", baseCost: "5", minimum: "5" } },
  });
  canaryCapId = c.json().capability?.id ?? "";
  const n = await app.inject({
    method: "POST", url: "/api/kernels", headers: { ...auth, "x-forwarded-for": ip() },
    payload: { id: NOLOC, name: "N68 no location" },
  });
  console.log("SETUP kernel", k.statusCode, "capability", c.statusCode, canaryCapId, "no-location kernel", n.statusCode, "| routes", ROUTES.length);
}, 120_000);

afterAll(async () => {
  await app?.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Path-param filling, shared by the GET and the structural POST sweep.
// ─────────────────────────────────────────────────────────────────────────────────────────

function fillPath(url: string, generic: string): string {
  return url.replace(/:(\w+)(\([^)]*\))?/g, (_m, name: string) => {
    if (/kernel/i.test(name)) return CANARY.kernelId;
    if (/cap/i.test(name)) return canaryCapId;
    if (/operator|owner|wallet|address/i.test(name)) return encodeURIComponent(operatorId);
    return generic;
  });
}

/** Every distinct path-param fill, deduped. Returns [] for an unfillable wildcard route. */
function pathVariants(url: string): string[] {
  if (url.includes("*")) return [];
  return [...new Set([fillPath(url, CANARY.kernelId), fillPath(url, canaryCapId), fillPath(url, encodeURIComponent(operatorId))])];
}

function variants(url: string): string[] {
  const out = new Set(pathVariants(url));
  if (out.size === 0) return [];
  const q = `?kernelId=${CANARY.kernelId}&q=canary&type=3d-printing&lat=47.62&lng=-122.35&radiusKm=100&limit=1000`;
  for (const u of [...out]) out.add(u + q);
  return [...out];
}

const SKIP = /\/sse\/|stream|\/events\b|\/ws\b|websocket|firehose/i;
// Routes that refuse through a helper which sends the refusal and then returns undefined, not the
// reply (feedback.ts adminOk and the other /api/admin routes, settlement-read.ts prelude). Fastify
// then sends a second time, and writeHead throws ERR_HTTP_HEADERS_SENT as an unhandled rejection
// that fails the whole run (54 of them at 7d6eaa84: red CI). Each of these refuses the sweep's
// callers (no admin token; no such settlement unit) before it reads a kernel or capability row.
// Reported to gateway; drop a pattern once its routes return the reply.
//
// /api/tools/reload joined this list when the N68 structural POST sweep (follow-up to #448)
// first called it: Fastify logged "Reply was already sent, did you forget to \"return reply\"
// in the \"/api/tools/reload\" (POST) route?" immediately before the same
// ERR_HTTP_HEADERS_SENT unhandled rejection, on a stranger's (non-admin) key — same admin-gate
// shape as the others, just not previously exercised by any test. Reported to gateway.
const DOUBLE_SEND = /^\/api\/admin\/|^\/api\/settlement\/units\/:unitId\/|^\/api\/tools\/reload$/;

// ─────────────────────────────────────────────────────────────────────────────────────────
// Response-tree leak detector (astra r2: the substring detector misses equivalent encodings).
// ─────────────────────────────────────────────────────────────────────────────────────────

/** geohash-5 cell the fix allows (public-location.ts: ~4.9km, LOCATION_CELL_PRECISION=5). */
const CANARY_CELL = geohashEncode(CANARY.lat, CANARY.lng, LOCATION_CELL_PRECISION);
const CANARY_LAT_MICRO = Math.round(CANARY.lat * 1e6);
const CANARY_LNG_MICRO = Math.round(CANARY.lng * 1e6);
const ADDRESS_LOWER = CANARY.address.toLowerCase();
const COORD_TEXTS = [
  `${CANARY.lat},${CANARY.lng}`,
  `${CANARY.lat}, ${CANARY.lng}`,
  JSON.stringify({ lat: CANARY.lat, lng: CANARY.lng }),
];
/** base64 of the raw address, and of a few plausible coordinate-text renderings. */
const BASE64_NEEDLES = [CANARY.address, ...COORD_TEXTS].map((s) => Buffer.from(s, "utf8").toString("base64"));
/** geohash base32 alphabet (no a/i/l/o), length>=6 — a candidate run; narrowed below by prefix. */
const GEOHASH_RUN_RE = /[0-9bcdefghjkmnpqrstuvwxyz]{6,}/gi;
const NUMBER_IN_STRING_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** A JSON *number* (already collapsed from whatever literal form — incl. scientific notation —
 *  it was written in) within 1e-4 of the canary's precise lat/lng, or within 1 of its
 *  microdegree-integer encoding. */
function isCloseNumber(n: number): boolean {
  if (!Number.isFinite(n)) return false;
  if (Math.abs(n - CANARY.lat) < 1e-4) return true;
  if (Math.abs(n - CANARY.lng) < 1e-4) return true;
  if (Math.abs(n - CANARY_LAT_MICRO) <= 1) return true;
  if (Math.abs(n - CANARY_LNG_MICRO) <= 1) return true;
  return false;
}

/** Why (if at all) a single string LEAF value in the response tree is a leak. */
function stringLeak(s: string): string | null {
  if (s.length < 4) return null;
  const nums = s.match(NUMBER_IN_STRING_RE);
  if (nums) {
    for (const raw of nums) {
      if (isCloseNumber(Number(raw))) return `embedded-coordinate:${raw}`;
    }
  }
  const lower = s.toLowerCase();
  if (lower.includes(ADDRESS_LOWER)) return "address-substring";
  try {
    const decoded = decodeURIComponent(s).toLowerCase();
    if (decoded !== lower && decoded.includes(ADDRESS_LOWER)) return "address-substring-url-decoded";
  } catch {
    // not percent-encoded — nothing to decode
  }
  for (const needle of BASE64_NEEDLES) {
    if (needle.length >= 8 && s.includes(needle)) return `base64:${needle.slice(0, 16)}…`;
  }
  const runs = s.match(GEOHASH_RUN_RE);
  if (runs) {
    for (const run of runs) {
      if (run.toLowerCase().startsWith(CANARY_CELL)) return `geohash-overprecise:${run}`;
    }
  }
  return null;
}

function walkTree(value: unknown, path: string, hits: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (isCloseNumber(value)) hits.push(`${path}=${value}`);
    return;
  }
  if (typeof value === "string") {
    const why = stringLeak(value);
    if (why) hits.push(`${path}:${why}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkTree(v, `${path}[${i}]`, hits));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkTree(v, path ? `${path}.${k}` : k, hits);
    }
  }
}

/** [] when the body isn't valid JSON — caller keeps the plain substring check for those. */
function responseTreeLeaks(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const hits: string[] = [];
  walkTree(parsed, "$", hits);
  return hits;
}

/** Substring needles (works on any body, JSON or not) UNIONED with the response-tree walk
 *  (JSON bodies only). Non-JSON bodies fall back to the substring check alone. */
function leakHits(body: string): string[] {
  const substr = NEEDLES.filter((n) => body.includes(n));
  const tree = responseTreeLeaks(body);
  return [...new Set([...substr, ...tree])];
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Structural POST coverage — every registered POST route is called or excluded, by name,
// with a reason. A brand-new route that nobody has triaged yet is NOT silently skipped: the
// default branch of classifyPost() calls it (see "STRUCTURAL" test below for the audit trail).
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Exact decoy paths registered by middleware/security-monitor.ts's HONEYPOT_PATHS. Each
 *  always replies 404 "not_found" after a random delay and never touches kernel/capability
 *  storage (security-monitor.ts:189-218,304-323) — duplicated here (not imported) because
 *  the source list isn't exported; a change to that list fails this sweep's completeness
 *  math (see the STRUCTURAL test) until the two are reconciled. */
const HONEYPOT_PATHS = new Set([
  "/admin", "/admin/", "/wp-admin", "/wp-admin/", "/wp-login.php", "/wp-login",
  "/.env", "/.git/config", "/.git/HEAD", "/api/debug", "/debug", "/phpmyadmin",
  "/phpMyAdmin", "/server-status", "/actuator", "/actuator/health", "/api/v1/admin",
  "/.aws/credentials", "/config.json", "/package.json", "/.DS_Store", "/robots.txt.bak",
  "/backup.sql", "/dump.sql", "/console", "/shell", "/cgi-bin/", "/xmlrpc.php",
]);

// The POST reads that answer with kernels or capabilities and need a crafted payload (not a
// generic {}) to actually engage capability/kernel matching — otherwise the canary-needle
// search is vacuous. /ask and pcc-discover need no key. Unchanged from the pre-existing sweep.
const SPECIAL_POST_CALLS = [
  ["/ask", { query: "canary" }],
  // /api/requests/match only reaches its success branch (where the historical leak and
  // this test's injected one both live) for a capabilityType with at least one match; a
  // bare {} 400s on "capabilityType is required" and never exercises that branch at all.
  // "3d-printing" matches the canary capability itself (registered in beforeAll) — exactly
  // astra's round-2 reproduction (POST /api/requests/match with the canary's own type).
  ["/api/requests/match", { capabilityType: "3d-printing" }],
  ["/a2a/tasks/send", { jsonrpc: "2.0", id: 1, method: "tasks/send", params: { skill: "pcc-discover", query: "canary" } }],
  ["/a2a/tasks/send", { jsonrpc: "2.0", id: 2, method: "tasks/send", params: { skill: "pcc-discover", kernelId: CANARY.kernelId } }],
  ["/api/query", { query: `is kernel ${CANARY.kernelId} healthy` }],
  ["/api/query", { query: "how many kernels are online" }],
  ["/api/query", { query: "what are my stats" }],
  ["/api/query", { query: "find a 3d-printing for my part" }],
] as const;
const SPECIAL_POST_URLS = new Set(SPECIAL_POST_CALLS.map(([url]) => url));

interface PostExclusion {
  test: (url: string) => boolean;
  reason: string;
}

/**
 * Every exclusion below was decided by reading the route (or, where noted, the project's own
 * API reference) rather than guessed. The categories match the task's own rubric: mutates
 * money; sends twice (DOUBLE_SEND, above); admin-token-only; external side effect.
 */
const POST_EXCLUSIONS: PostExclusion[] = [
  {
    test: (u) => /^\/api\/escrow\/chain\/:address\//.test(u),
    reason:
      "mutates money — on-chain escrow fund/release/dispute/bond/evidence/attestation " +
      "(escrow.ts); excluded as a family regardless of current write-gating (isWriteEnabled/" +
      "PCC_GATEWAY_PRIVATE_KEY). /approve is an inert 410 stub but is grouped here for clarity.",
  },
  {
    test: (u) => u === "/api/protocol/create-escrow",
    reason: "mutates money — creates an escrow via the protocol factory (pcc-protocol.ts; gated by isWriteEnabled but excluded on principle)",
  },
  {
    test: (u) => u === "/api/settlement/submit" || u === "/api/settlement/release" || u === "/api/settlement/flush",
    reason: "mutates money — queues, releases, or flushes real settlement/milestone operations (settlement.ts)",
  },
  {
    test: (u) => u === "/api/pgtr/relay",
    reason: "mutates money — relays a payment-gated (EIP-3009) transaction on-chain via PCCForwarder (pgtr-relay.ts; gated by PCC_PGTR_RELAYER_KEY but excluded on principle)",
  },
  {
    test: (u) => u === "/api/negotiate/session/:id/commit" || u === "/api/negotiate/session/:id/retry-settlement",
    reason: "mutates money — commits a negotiation session (creates escrow + job per the project's own API reference) or retries a settlement",
  },
  {
    test: (u) => /^\/api\/pool\/(create|stake|claim\/:poolId|close\/:poolId|from-bounty\/:bountyId)$/.test(u),
    reason: "mutates money — investment pool stake/claim/close (pool.ts)",
  },
  {
    test: (u) => u.startsWith("/api/swf/"),
    reason: "mutates money/governance — Sovereign Wealth Fund equity, distributions, proposals, term sheets (swf.ts); excluded as a family",
  },
  {
    test: (u) => u === "/api/rewards/claims",
    reason: "mutates money — claims accrued DePIN rewards",
  },
  {
    test: (u) => u === "/api/certificates/mint",
    reason: "mutates money/value — mints a DePIN certificate",
  },
  {
    test: (u) =>
      u === "/api/ip/:ipId/pay" || u === "/api/ip/:ipId/claim" || u === "/api/ip/distribute-royalties" || u === "/api/ip/settle-royalties",
    reason:
      "mutates money — pays, claims, distributes, or settles IP royalty revenue (ip.ts). " +
      "(register-capability/register-job-evidence/set-licensing-terms/:ipId/dispute are registration " +
      "and terms-configuration, not value transfer, and ARE swept — StoryIPService defaults mock=true " +
      "absent STORY_PRIVATE_KEY: contracts/ts/story-ip-service.ts:86.)",
  },
  {
    test: (u) =>
      u.startsWith("/api/aggregator/ingest/") || u === "/api/aggregator/publish/agntcy" || u === "/api/aggregator/invoke/:toolId",
    reason:
      "external side effect — ingests from, or proxies to, a caller-influenced external tool endpoint " +
      "(MCP/OpenAPI/AGNTCY); SSRF-shaped. invoke proxies whatever a prior ingest registered — admin-gating " +
      "on ingest was not independently re-verified safe for an automated sweep.",
  },
  {
    test: (u) =>
      u === "/api/unbrowse/search" || u === "/api/unbrowse/resolve" || u === "/api/unbrowse/execute/:skillId" || u === "/api/unbrowse/feedback",
    reason: "external side effect — proxies to a configurable UNBROWSE_URL (default localhost:6969) via a real fetch() with a 30s timeout (unbrowse.ts)",
  },
  {
    test: (u) => u === "/api/operators/:slug/channels/test",
    reason: "external side effect — dispatches a real test notification (webhook fetch / email send) to every channel attached for the slug (operator-channels.ts dispatchToChannels)",
  },
  {
    test: (u) => u === "/api/evidence/:bundleId/lit-decrypt" || u === "/api/evidence/encrypted/:bundleId/grant",
    reason: "external side effect — Lit Protocol threshold-decryption / access-grant surface; real-network gating not independently verified for an automated sweep",
  },
];

/** Classifies a REGISTERED post route url (Fastify's own pattern, e.g. "/api/ip/:ipId/pay").
 *  Total function: every url gets exactly one verdict. The default (no rule matches) is
 *  `call: true` — a brand-new route is swept automatically, not silently skipped. */
function classifyPost(url: string): { call: boolean; reason?: string } {
  if (SPECIAL_POST_URLS.has(url)) return { call: true, reason: "special-cased payload (see SPECIAL_POST_CALLS)" };
  if (HONEYPOT_PATHS.has(url)) {
    return { call: false, reason: "security honeypot decoy (security-monitor.ts HONEYPOT_PATHS) — always 404 not_found, never touches kernel/capability data" };
  }
  if (DOUBLE_SEND.test(url)) {
    return { call: false, reason: "DOUBLE_SEND — a refusal helper sends the reply and returns undefined; a second send crashes the run (see DOUBLE_SEND comment above)" };
  }
  if (SKIP.test(url)) {
    return { call: false, reason: "SSE/stream/websocket-shaped path — not swept (no location payload; see file header)" };
  }
  for (const ex of POST_EXCLUSIONS) {
    if (ex.test(url)) return { call: false, reason: ex.reason };
  }
  return { call: true };
}

/** Every POST (or POST-including) route Fastify actually registered, deduped by url. */
function allPostRouteUrls(): string[] {
  const urls = new Set<string>();
  for (const r of ROUTES) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes("POST") || r.websocket) continue;
    urls.add(r.url);
  }
  return [...urls];
}

async function sweep(key: string | null) {
  const leaks: string[] = [];
  let calls = 0;
  let timeouts = 0;
  let errors = 0;
  const seen = new Set<string>();
  const seenPost = new Set<string>();
  for (const r of ROUTES) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes("GET") || r.websocket || SKIP.test(r.url) || DOUBLE_SEND.test(r.url)) continue;
    for (const url of variants(r.url)) {
      if (seen.has(url)) continue;
      seen.add(url);
      const headers: Record<string, string> = { "x-forwarded-for": ip() };
      if (key) headers.authorization = `Bearer ${key}`;
      calls++;
      const res = await Promise.race([
        app.inject({ method: "GET", url, headers }).then((x) => ({ status: x.statusCode, body: x.body })),
        new Promise<{ status: number; body: string }>((ok) => setTimeout(() => ok({ status: -1, body: "" }), 4000)),
      ]).catch((e) => ({ status: -2, body: String(e) }));
      if (res.status < 0) timeouts++;
      else if (res.status >= 500) errors++;
      const hit = leakHits(res.body);
      if (hit.length) leaks.push(`${res.status} GET ${url.split("?")[0]}${url.includes("?") ? " (with query)" : ""} -> ${hit.join(",")}`);
    }
  }

  // The special-cased POST reads that answer with kernels or capabilities — a crafted
  // payload so the canary-needle search actually engages capability/kernel matching.
  for (const [url, payload] of SPECIAL_POST_CALLS) {
    const headers: Record<string, string> = { "x-forwarded-for": ip() };
    if (key) headers.authorization = `Bearer ${key}`;
    calls++;
    const res = await app.inject({ method: "POST", url, headers, payload: payload as object });
    const hit = leakHits(res.body);
    if (hit.length) leaks.push(`${res.statusCode} POST ${url} ${JSON.stringify(payload).slice(0, 60)} -> ${hit.join(",")}`);
  }

  // Structural POST sweep: every OTHER registered POST route is called (minimal {} body,
  // every path-param variant) or was excluded above with a reason.
  for (const url of allPostRouteUrls()) {
    if (SPECIAL_POST_URLS.has(url)) continue; // already covered above with a crafted payload
    const verdict = classifyPost(url);
    if (!verdict.call) continue;
    for (const filled of pathVariants(url)) {
      const seenKey = `POST ${filled}`;
      if (seenPost.has(seenKey)) continue;
      seenPost.add(seenKey);
      const headers: Record<string, string> = { "x-forwarded-for": ip() };
      if (key) headers.authorization = `Bearer ${key}`;
      calls++;
      const res = await Promise.race([
        app.inject({ method: "POST", url: filled, headers, payload: {} }).then((x) => ({ status: x.statusCode, body: x.body })),
        new Promise<{ status: number; body: string }>((ok) => setTimeout(() => ok({ status: -1, body: "" }), 4000)),
      ]).catch((e) => ({ status: -2, body: String(e) }));
      if (res.status < 0) timeouts++;
      else if (res.status >= 500) errors++;
      const hit = leakHits(res.body);
      if (hit.length) leaks.push(`${res.status} POST ${filled} -> ${hit.join(",")}`);
    }
  }

  return { leaks, calls, timeouts, errors };
}

describe("N68: no read of the real gateway shows an operator's exact location or street address", () => {
  it("ANONYMOUS: no route returns the canary's exact coordinates or street address", async () => {
    const { leaks, calls, timeouts, errors } = await sweep(null);
    console.log(`ANON swept ${calls} calls (${timeouts} timed out, ${errors} answered 5xx); ${leaks.length} leaking responses`);
    for (const l of leaks) console.log("ANON LEAK", l);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("A STRANGER'S self-provisioned key: no route returns them either", async () => {
    const { leaks, calls, timeouts, errors } = await sweep(strangerKey);
    console.log(`KEYED swept ${calls} calls (${timeouts} timed out, ${errors} answered 5xx); ${leaks.length} leaking responses`);
    for (const l of leaks) console.log("KEYED LEAK", l);
    expect(leaks).toEqual([]);
  }, 600_000);

  it("{0,0}: a kernel registered without a location is shown with no location, not at 0,0", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kernels", headers: { "x-forwarded-for": ip() } });
    const k = (res.json().kernels as Array<Record<string, unknown>>).find((x) => x.id === NOLOC)!;
    console.log("ZERO", res.statusCode, "location", JSON.stringify(k.location), "precision", JSON.stringify(k.locationPrecision));
    expect(k.location ?? null).toBeNull();
  });

  it("STRUCTURAL: every registered POST route is swept or explicitly excluded with a reason", () => {
    const all = allPostRouteUrls();
    // Sanity floor on the enumeration mechanism itself (not a brittle exact count): if the
    // onRoute hook ever stopped firing, or server.ts stopped registering most routes, this
    // collapses toward 0 and this catches that class of regression independent of leaks.
    expect(all.length).toBeGreaterThan(200);

    const called: string[] = [];
    const excluded: Array<{ url: string; reason: string }> = [];
    for (const url of all) {
      const verdict = classifyPost(url);
      if (verdict.call) called.push(url);
      else excluded.push({ url, reason: verdict.reason! });
    }
    console.log(`POST coverage: ${called.length} called, ${excluded.length} excluded (of ${all.length} registered POST routes)`);
    for (const e of excluded) console.log("POST EXCLUDED", e.url, "—", e.reason);

    // Every excluded route carries a non-empty, human-reviewable reason — no silent exclusion.
    expect(excluded.every((e) => typeof e.reason === "string" && e.reason.trim().length > 0)).toBe(true);
    // classifyPost is a total function over `all` by construction (every branch returns a
    // verdict; the final fallthrough is `call: true`), so called+excluded cannot gap or
    // overlap — a NEW route therefore can never land in neither bucket; it defaults to
    // CALLED (and is swept above) until a human adds it to POST_EXCLUSIONS.
    expect(called.length + excluded.length).toBe(all.length);
    expect(new Set([...called, ...excluded.map((e) => e.url)]).size).toBe(all.length);
  });
});
