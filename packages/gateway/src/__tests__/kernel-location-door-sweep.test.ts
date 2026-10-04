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
 *
 * CROSS-FAMILY REVIEW of #533 (round 1, MEDIUM 1 — implementer-kilo): reproduced three
 * further gaps at 430bafb4 before fixing anything (see n68-medium1-repro logs): (1) leakHits()
 * missed DMS (degrees/minutes/seconds) and plus-code (Open Location Code) renderings of the
 * canary — fixed by dmsLeak()/plusCodeLeak() below, folded into stringLeak(). (2) non-JSON
 * bodies got ONLY the substring-NEEDLES check, not the full detector — fixed by running
 * stringLeak() over the whole raw body unconditionally in leakHits(), not just per JSON leaf.
 * (3) most POST routes other than the original eight SPECIAL_POST_CALLS got a blank `{}` body,
 * so a leak living behind request validation (or behind a 2xx-only response) could never be
 * observed — fixed by tracking CALLED vs. REACHED (2xx) per POST route (FIXTURE_POST_BODIES /
 * NOT_REACHED below) and failing the STRUCTURAL test on any called-but-unexplained non-2xx,
 * timeout, or zero-path-variant route. (4) the GET sweep silently skipped anything matching a
 * stream-shaped regex, including two routes that aren't streams at all (/api/analytics/events,
 * /api/visualizer/events.json) and one plain on-chain-log GET
 * (/api/escrow/chain/:address/events) — fixed by GET_STREAM_ROUTES, an explicit per-url list
 * with reasons (mirrors POST_EXCLUSIONS), so a brand-new stream-shaped GET route is no longer
 * silently dropped and the three false positives above are now sweept normally.
 *
 * #533 MERGE-UP WITH MASTER (test-only refresh, implementer-oscar): merging current master
 * (108c7788) into #533's reviewed head broke 10 POST routes master changed underneath this
 * file. #400 (N4b-gw item 1) retired the /api/ot2/* family behind a catch-all 410 (POST_EXCLUSIONS
 * above gained that entry) and (N4b-gw item 4) added relayAccessGuard — default-deny, per
 * kernel — to every /api/relay/:kernelId/* route, so CANARY.kernelId (owned by this file's
 * OWNER identity) stopped authorizing any relay fixture called as the stranger pass. Fixed by
 * createOwnRelayKernel(), a shared helper every relay dynamic fixture below now uses to
 * register a fresh kernel as the CURRENT pass's own identity before calling tool-call,
 * tool-call/:callId/start (NEW on master, the execution lease), scope, scope/:scopeId/revoke,
 * camera/frame, chat or chat/respond. bounty/claim was independently broken (the shared
 * BountyService never auto-creates a bounty from demand — fixed by seeding one directly via
 * its own _bountyServiceForTests() seam); bounty/verify is now permanently retired (ledger
 * R45, caller-supplied verification refused with an unconditional 410) and moved to
 * POST_EXCLUSIONS rather than NOT_REACHED. setup/test-job needed the one kernel id this
 * gateway process's in-process KernelService actually runs ("kernel_dev_001", the
 * KERNEL_ID-unset default) registered and a real device loaded on it. Verified counts after
 * the fix (FINAL COUNTS, STRUCTURAL test): registered=318 called=234 reached=202 notReached=32
 * excluded=84 — all 32 NOT_REACHED entries carry a reviewable reason, zero are the bare
 * "⚠ NO ENTRY" that failed this merge (up from reached=193 of called=235 pre-fix).
 *
 * N68b MERGED INTO #533's MASTER REFRESH (implementer-romeo): N68b (empirical NOT_REACHED
 * verification, below) branched from the same a6268d21 this refresh did, moving 10 of that
 * paragraph's 32 NOT_REACHED entries into dynamic fixtures (asset-outbound budget+demand,
 * automation-status episode/advance, protocol template publish/fork/runs/validate, protocol-run
 * pause/cancel — none of their underlying handlers were touched by this merge's master pull, so
 * all ten still reach 2xx the same way) and two more (carrier/shipments, lob/letters) into
 * POST_EXCLUSIONS (self-satisfiable ownership, excluded on principle rather than chained-into).
 * Neither side's changed routes overlap this refresh's relay/bounty/ot2/setup work, so the merge
 * combined without rewriting either. Re-verified empirically post-merge (this merge's own run,
 * not carried over from either parent): registered=318 called=232 reached=212 notReached=20
 * excluded=86 — all 20 remaining NOT_REACHED entries now carry an executable `witness` (BY
 * CONSTRUCTION test, below), proven against the merged code, not just a reviewable reason.
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createHash, pbkdf2Sync, randomBytes as cryptoRandomBytes } from "node:crypto";
import nodeHttpMod from "node:http";
import nodeHttpsMod from "node:https";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { geohashCenter, geohashEncode, LOCATION_CELL_PRECISION } from "../facades/populators/public-location.js";
import { signWithPrivateKeyHex } from "../auth/ed25519.js";
import { setCaptureChainClientForTests, type CaptureChainClient } from "../routes/capture.js";
import { _setSmokeTestFetch } from "../routes/kernel-marketplace.js";
import { _bountyServiceForTests } from "../routes/bounty.js";

const ROUTES = vi.hoisted(() => [] as Array<{ method: string | string[]; url: string; websocket?: boolean; schema?: unknown }>);
vi.mock("fastify", async (orig) => {
  const real = (await orig()) as { default: (...a: unknown[]) => FastifyInstance };
  const make = (...a: unknown[]) => {
    const inst = real.default(...a);
    inst.addHook("onRoute", (r) => {
      // schema capture (task item 2): most routes here validate with zod/manual checks
      // inside the handler rather than a Fastify-native `schema.body`, so this is often
      // undefined — captured anyway (cheap) for the handful of routes that DO declare one
      // (e.g. build.ts, job-submit.ts), as a cross-check against this file's hand-written
      // FIXTURE_POST_BODIES.
      ROUTES.push({
        method: r.method as string | string[],
        url: r.url,
        websocket: (r as { websocket?: boolean }).websocket,
        schema: (r as { schema?: unknown }).schema,
      });
    });
    return inst;
  };
  Object.assign(make, real.default);
  return { ...real, default: make };
});

// round-2 fix 4 (re-check): roughly a dozen call sites across this package construct a real
// viem public/wallet client (chain-client.ts, contracts/protocol-client.ts, contracts/
// escrow-client.ts, routes/capture.ts, routes/registry.ts, routes/pgtr-relay.ts, routes/
// gasless.ts, routes/paid-job-flow.ts, services/erc8004-identity-write.ts, routes/fiat-ramp.ts)
// — most gated by an absent private key / write-enabled flag, but several (capture.ts's
// GET-reachable challenge flow, registry.ts's GET routes) are NOT, and reproducibly fired a
// real fetch to sepolia.base.org before this fix (2f0010d9, n68-r2review-r5.log). Rather than
// chase every call site's own gate, override the two viem entry points EVERY one of them goes
// through: createPublicClient/createWalletClient always get a stub transport whose `request`
// rejects without ever calling fetch/http — construction still succeeds (routes that just
// build a client without using it are unaffected), but no RPC call can ever leave the
// process. Every other viem export (verifyMessage, parseUnits, etc. — used throughout the
// gateway AND by this file's own R2 SIWE fixture) passes through unmodified via `orig()`.
vi.mock("viem", async (orig) => {
  const real = (await orig()) as typeof import("viem");
  const noNetworkTransport: typeof real.http = () => ({
    config: { key: "n68-no-network-stub", name: "N68 no-network stub transport", type: "n68-stub", retryCount: 0, retryDelay: 0, timeout: 0 },
    request: async () => {
      throw new Error(
        "N68 no-network guard: this sweep stubs every viem RPC transport — no chain call may " +
        "ever leave the process (round-2 fix 4). If a route legitimately needs on-chain data " +
        "for this test, inject a fake client via that route's own *ForTests hook instead.",
      );
    },
    value: undefined,
  });
  return {
    ...real,
    createPublicClient: ((args: Parameters<typeof real.createPublicClient>[0]) =>
      real.createPublicClient({ ...args, transport: noNetworkTransport } as never)) as typeof real.createPublicClient,
    createWalletClient: ((args: Parameters<typeof real.createWalletClient>[0]) =>
      real.createWalletClient({ ...args, transport: noNetworkTransport } as never)) as typeof real.createWalletClient,
  };
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
// The list above names the integrations this sweep was read against; this clear also covers any
// it does not name, now that fixture bodies drive routes to their success branch (orchestrator
// review of 44b0dcbc: /api/feedback posts to DISCORD_WEBHOOK_URL, /api/telemetry/emit to PostHog,
// a 5xx goes to SENTRY_DSN, evidence storage to STORACHA_*). Every credential-, webhook- or
// endpoint-shaped variable is removed; nothing this harness needs has such a name.
const EXTERNAL_ENV_RE = /(KEY|SECRET|TOKEN|PRIVATE|PASSWORD|PROOF|DSN|WEBHOOK|_DID$|_RPC$|_URL$)/i;
for (const v of Object.keys(process.env)) {
  if (EXTERNAL_ENV_RE.test(v)) delete process.env[v];
}
// round-2 fix 4 (re-check): leaving EVIDENCE_STORAGE unset does NOT mean "no remote storage" —
// services.ts:199-217 / evidence-storage-factory.ts:39 default an UNSET EVIDENCE_STORAGE to
// "helia", which unconditionally starts a real in-process libp2p/Helia node (a genuine
// network attempt to delegated-ipfs.dev for content routing, reproduced at 2f0010d9 — see
// n68-r2review-r5.log). "storacha" selects StorachaStorageService, which the SAME factory
// forces into { mock: true } whenever STORACHA_PROOF is absent (already cleared above by the
// PROOF-matching EXTERNAL_ENV_RE sweep) — a deterministic, fully in-memory, no-network backend
// built for exactly this.
process.env.EVIDENCE_STORAGE = "storacha";

// CROSS-FAMILY REVIEW of #533 (round 2, finding 3 — MEDIUM test-isolation defect): the line
// below used to PRESERVE an ambient NODE_ENV=production instead of forcing "test" ("stay
// production if that's what the environment already says"). That let /api/near/quote
// (contracts/near-client.ts:91-93 — NEAR mocks only under NODE_ENV=test or NEAR_MOCK=true)
// fall through to a REAL fetch() to the fixed external 1Click endpoint whenever this sweep
// happened to run with NODE_ENV=production in its ambient shell (reproduced at 2f0010d9,
// n68-r2review-r5.log). Both lines below are now forced UNCONDITIONALLY, every run,
// regardless of what the ambient environment says — belt (these two env vars) AND
// suspenders (the fetch/http no-network guard immediately below, which blocks and records
// any non-loopback attempt even if some OTHER integration's mock gate is missed).
process.env.NODE_ENV = "test";
process.env.NEAR_MOCK = "true";
// The /api/compose/:id/execute fixture relies on compose.ts's NOOP step runner; the real runner
// (and its SQLite store) is switched on only by this variable, so it is never left to the ambient
// environment (orchestrator review of 189e4fbc).
delete process.env.PCC_COMPOSE_EXECUTE_REAL;
process.env.STORY_MOCK = process.env.STORY_MOCK ?? "true";

// ─────────────────────────────────────────────────────────────────────────────────────────
// No-network guard (round 2, finding 3): installed before `../server.js` is ever imported
// (this whole block runs at module-eval time, strictly before `beforeAll`'s dynamic import).
// Patches globalThis.fetch AND node:http/node:https request/get so ANY outbound attempt to a
// host other than 127.0.0.1 / ::1 / localhost throws instead of leaving the machine, and is
// recorded in EXTERNAL_NETWORK_ATTEMPTS for the STRUCTURAL test's zero-attempts assertion.
// Loopback traffic (this file's own fetchStreamSnapshot() against the app's real listener)
// passes straight through to the real implementation, unpatched.
// ─────────────────────────────────────────────────────────────────────────────────────────
const EXTERNAL_NETWORK_ATTEMPTS: string[] = [];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return LOOPBACK_HOSTS.has(h);
}

function extractFetchUrlHost(input: unknown): { url: string; host: string } {
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else if (input && typeof input === "object" && "url" in (input as Record<string, unknown>)) {
    url = String((input as Record<string, unknown>).url);
  } else url = String(input);
  let host = "";
  try {
    host = new URL(url, "http://127.0.0.1").hostname;
  } catch {
    host = "";
  }
  return { url, host };
}

const realFetch = globalThis.fetch?.bind(globalThis);
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const { url, host } = extractFetchUrlHost(input);
  if (!isLoopbackHost(host)) {
    EXTERNAL_NETWORK_ATTEMPTS.push(`fetch ${url}`);
    throw new Error(
      `N68 no-network guard: blocked non-loopback fetch to "${url}" (resolved host="${host || "<unresolved>"}"). ` +
      `This sweep must never leave the machine — see EXTERNAL_NETWORK_ATTEMPTS.`,
    );
  }
  return realFetch!(input as RequestInfo, init);
}) as typeof fetch;

function guardNodeRequestHost(args: unknown[], label: string): void {
  let host = "";
  const first = args[0];
  if (typeof first === "string") {
    try {
      host = new URL(first).hostname;
    } catch {
      host = "";
    }
  } else if (first instanceof URL) {
    host = first.hostname;
  } else if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    host = String(o.hostname ?? o.host ?? "").split(":")[0] ?? "";
  }
  if (host && !isLoopbackHost(host)) {
    EXTERNAL_NETWORK_ATTEMPTS.push(`${label} ${host}`);
    throw new Error(`N68 no-network guard: blocked non-loopback ${label} request to "${host}".`);
  }
}

for (const [mod, label] of [
  [nodeHttpMod, "http"],
  [nodeHttpsMod, "https"],
] as const) {
  const origRequest = mod.request.bind(mod);
  const origGet = mod.get.bind(mod);
  mod.request = ((...args: unknown[]) => {
    guardNodeRequestHost(args, `${label}.request`);
    return (origRequest as (...a: unknown[]) => unknown)(...args);
  }) as typeof mod.request;
  mod.get = ((...args: unknown[]) => {
    guardNodeRequestHost(args, `${label}.get`);
    return (origGet as (...a: unknown[]) => unknown)(...args);
  }) as typeof mod.get;
}

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

/**
 * A call that takes longer is counted as timed out, and STRUCTURAL fails on any timed-out route
 * it cannot explain. Fixture bodies make routes do real work (a ZK commitment took over 4s under
 * the full suite's parallel load at c8285cfb), so the bound is generous: only a route that hangs
 * trips it.
 */
const CALL_TIMEOUT_MS = 30_000;

/** The store and every file a route derives from PCC_DB_PATH (waitlist, beta, feedback JSONL)
 *  live in a fresh temp directory, never in the working tree. Removed in afterAll. */
let dataDir = "";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "n68-sweep-"));
  process.env.PCC_DB_PATH = join(dataDir, "pcc.sqlite");
  process.env.PCC_SEED_DATA = "true";
  // round-2 fix 4: capture.ts's getChainClient() has NO env-gated mock mode — it always
  // constructs a real viem client against sepolia.base.org (or PCC_RPC_URL) the first time
  // /api/capture/challenge or /api/capture/anchor is reached. The route ships a test-only
  // override for exactly this (capture.ts:218, "Tests inject a fake ... to assert write
  // arguments and skip real RPC") — installed here, before the gateway (and therefore before
  // any route) is ever reachable, so this sweep never takes the real-RPC path regardless of
  // which capture route a fixture or a brand-new route happens to call.
  const fakeChainClient: CaptureChainClient = {
    getChainId: () => 84532,
    async getLatestBlock() {
      return { number: 1, hash: `0x${"0".repeat(64)}` as `0x${string}`, timestamp: Math.floor(Date.now() / 1000) };
    },
    async anchorCapture() {
      return { txHash: `0x${"0".repeat(64)}` as `0x${string}`, blockNumber: 1, gasUsed: "0" };
    },
  };
  setCaptureChainClientForTests(fakeChainClient);
  // round-3 re-triage: kernel-marketplace.ts's runSmokeTest() does a REAL fetch(manifest.
  // endpointURL, ...) to verify a registered kernel (kernel-marketplace.ts:211-220) — the
  // route ships its OWN test-only override for exactly this ("Dependency-injectable fetch so
  // tests can mock the smoke-test network call without monkey-patching globalThis",
  // kernel-marketplace.ts:33-39). Installed here, before the gateway import, so
  // /api/kernels/:kernelId/verify never takes the real-fetch path regardless of which
  // endpointURL a fixture supplies.
  _setSmokeTestFetch((async () => ({ ok: true, status: 200 }) as Response) as typeof fetch);
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
  setCaptureChainClientForTests(null);
  _setSmokeTestFetch(null);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
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
// GET stream/SSE/websocket routes — astra round-1-of-MEDIUM-1 item 4: the GET sweep used to
// silently `continue` past anything matching the SKIP regex above. That regex over-matched
// (e.g. /api/analytics/events and /api/visualizer/events.json aren't streams at all — caught
// only by the bare "events" substring) and, for genuine streams, gave no reviewable trail: a
// brand-new stream-shaped GET route would be skipped forever with zero visibility. Replaced
// with an explicit per-url map (mirrors POST_EXCLUSIONS): every entry here was decided by
// reading the route. A url NOT in this map is swept NORMALLY (not skipped) — if that includes
// a real stream nobody has triaged yet, its `app.inject` call still has the GET loop's
// existing 4s race, so it degrades to a tracked, FAILING timeout (see the STRUCTURAL test's
// "unexplained GET timeout" check) rather than silent invisibility.
//
// Three entries get `mode: "bounded-read"` instead of exclusion: public, no-auth SSE routes
// whose connect-time write plausibly carries accumulated state from this sweep's OWN setup
// calls (visualizer event history, recent logs, recent request traces) — genuinely worth
// checking for a leak, not just theatre. `fetchStreamSnapshot` binds the existing `app` to a
// real loopback port (once) and reads via fetch()+AbortController for a bounded window, since
// `app.inject()` cannot observe a response that never calls `reply.raw.end()`.
// ─────────────────────────────────────────────────────────────────────────────────────────

type GetStreamVerdict =
  | { mode: "excluded"; reason: string }
  | { mode: "bounded-read"; reason: string };

const GET_STREAM_ROUTES: Record<string, GetStreamVerdict> = {
  "/api/visualizer/events": {
    mode: "bounded-read",
    reason: "public SSE (no auth, explicit CORS *); emits a hello + up to a 200-event snapshot via snapshotEvents() on connect (visualizer-events.ts:194-199) — swept boundedly instead of excluded",
  },
  "/api/telemetry/logs/stream": {
    mode: "bounded-read",
    reason: "public SSE, no auth; emits last 50 log entries + active-job telemetry summaries on connect (telemetry.ts:128-149) — swept boundedly instead of excluded",
  },
  "/api/traces/stream": {
    mode: "bounded-read",
    reason: "public SSE, no auth; emits the last 20 request traces on connect (traces.ts:56-60), which can carry prior request/response span data — swept boundedly instead of excluded",
  },
  "/sse/notifications": {
    mode: "excluded",
    reason: "SSE: writes only {type:connected} on open (sse/notifications.ts:67); no producer runs in this harness to emit anything further within a bounded window (producerManager.startAll() lives behind createGateway(...).start(), which beforeAll never calls)",
  },
  "/sse/stream/job/:jobId": {
    mode: "excluded",
    reason: "SSE: writes only {type:connected,topics} on open (sse/topic-sse.ts:130); same no-producer-running reason as /sse/notifications; also gated by checkJobOwnership for a synthetic jobId",
  },
  "/sse/stream/kernel/:kernelId": {
    mode: "excluded",
    reason: "SSE: writes only {type:connected,topics} on open (sse/topic-sse.ts:130); same no-producer-running reason as /sse/notifications",
  },
  "/sse/stream/device/:deviceId": {
    mode: "excluded",
    reason: "SSE: writes only {type:connected,topics} on open (sse/topic-sse.ts:130); same no-producer-running reason as /sse/notifications",
  },
  "/sse/stream/batch/:batchId": {
    mode: "excluded",
    reason: "SSE: writes only {type:connected,topics} on open (sse/topic-sse.ts:130); same no-producer-running reason as /sse/notifications",
  },
  "/api/dht/events/stream": {
    mode: "excluded",
    reason: "SSE: 401 without apiKeyId/userId (dht-ws.ts:136-140); snapshot is DHT connection/replication metrics (dhtTelemetry.getMetrics(), dht-ws.ts:155-158), never kernel/capability location",
  },
  "/api/ot2/camera/stream": {
    mode: "excluded",
    reason: "SSE: writes only {type:connected} on open (ot2-camera.ts:153); real frames need an active camera producer/device this sweep doesn't register",
  },
  "/api/relay/:kernelId/camera/stream": {
    mode: "excluded",
    reason: "SSE: per-device camera frame relay; needs an active device-relay producer this sweep doesn't register (device-relay.ts)",
  },
  "/sse/demo/order/:id": {
    mode: "excluded",
    reason: "pizza-demo substrate SSE topic; DemoOrder's deliveryAddress/deliveryLocation is the CALLER's own self-supplied delivery address, a separate domain object from kernel/capability location — never touches kernel/capability tables (pizza-demo.ts)",
  },
  "/sse/demo/operator/:slug": {
    mode: "excluded",
    reason: "pizza-demo substrate SSE topic; same reason as /sse/demo/order/:id — demo substrate only (pizza-demo.ts)",
  },
  "/sse/demo/driver/:slug": {
    mode: "excluded",
    reason: "pizza-demo substrate SSE topic; same reason as /sse/demo/order/:id — demo substrate only (pizza-demo.ts)",
  },
  "/sse/demo/firehose": {
    mode: "excluded",
    reason: "pizza-demo substrate SSE (cross-order firehose); relays only DemoOrder events, a separate domain object from kernel/capability location (pizza-demo.ts)",
  },
  "/api/commentary/stream": {
    mode: "excluded",
    reason: "LLM commentary narrator (jobs/escrows/attestations); ANTHROPIC_API_KEY is cleared in this test env so the session emits only a static needs_api_key chunk (commentary-narrator.ts), never kernel/capability data",
  },
  "/ws/dht": {
    mode: "excluded",
    reason: "true WebSocket ({websocket:true} registration, dht-ws.ts:49), not fetchable via plain HTTP GET + AbortController; adding a ws client is a new dependency this fix doesn't take on",
  },
};

/** Two GET routes that matched the OLD SKIP regex but are not streams at all, confirmed by
 *  reading the handler — now swept normally (not in GET_STREAM_ROUTES, so no special-casing):
 *  /api/analytics/events (PostHog event-NAME aggregates, analytics.ts:422-439, no location) and
 *  /api/visualizer/events.json (plain JSON snapshot, visualizer-events.ts:218-225, no location).
 *  A third, /api/escrow/chain/:address/events, is a plain on-chain event-log GET (escrow.ts:149)
 *  also freed by this change. */

let streamServerAddress: string | null = null;

/** Lazily binds the existing `app` to a real loopback port so bounded-read SSE routes can be
 *  fetched — `app.inject()` can't observe a response that holds open via `reply.raw.write()`
 *  and never calls `.end()`. Reused across every bounded-read call; torn down implicitly by
 *  the existing `afterAll`'s `app.close()` (closes the HTTP server `.listen()` created, same
 *  as it closes whatever `.inject()` used). */
async function ensureStreamServer(): Promise<string> {
  if (streamServerAddress) return streamServerAddress;
  streamServerAddress = await app.listen({ port: 0, host: "127.0.0.1" });
  return streamServerAddress;
}

/** astra round-2 finding 1(c): the old 8192-byte cap silently truncated — a leak living past
 *  that cutoff in a real snapshot (e.g. deep in a 200-event visualizer dump) would never be
 *  seen, and the function returned normally either way. Raised generously (a 200-event
 *  visualizer snapshot, 50 telemetry log lines, or 20 request traces all fit comfortably
 *  under this) so a legitimate snapshot never trips it; genuinely hitting it now means either
 *  a runaway/unbounded stream or a leak hiding past the old cutoff — either way `
 *  fetchStreamSnapshot` THROWS (see below) instead of returning truncated text silently. */
const STREAM_SNAPSHOT_CAP_BYTES = 131_072;

/** Fetches an SSE-shaped route (GET by default; pass `opts.method`/`opts.body` for a POST
 *  stream, e.g. /api/commentary/stream) for a bounded window, returning whatever text arrived
 *  before the window closed (expected/normal exit — an SSE connection never completes on its
 *  own) plus whether a response was ever obtained at all (`ok`; false means the connection
 *  itself failed, which IS worth surfacing).
 *
 *  THROWS, naming the route, if the read hits STREAM_SNAPSHOT_CAP_BYTES without the stream
 *  ending on its own (astra round-2 finding 1(c) — a bounded read that hits its cap must FAIL,
 *  not silently return truncated text that could be hiding a leak past the cutoff). Every
 *  OTHER failure mode (connection refused, abort-at-window-close) is still reported via the
 *  returned `ok`/`text`, not thrown — only the specific "we stopped because we ran out of
 *  cap, not because the stream ended" case throws. */
async function fetchStreamSnapshot(
  path: string,
  headers: Record<string, string> = {},
  windowMs = 600,
  opts: { method?: "GET" | "POST"; body?: string; baseOverride?: string } = {},
): Promise<{ text: string; ok: boolean; status: number }> {
  let base: string;
  try {
    base = opts.baseOverride ?? (await ensureStreamServer());
  } catch (e) {
    return { text: `ensureStreamServer failed: ${String(e)}`, ok: false, status: -2 };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);
  let text = "";
  let ok = false;
  let status = -2;
  let capExceeded = false;
  try {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body,
      signal: controller.signal,
    });
    ok = true;
    status = res.status;
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      while (text.length < STREAM_SNAPSHOT_CAP_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      if (text.length >= STREAM_SNAPSHOT_CAP_BYTES) {
        capExceeded = true;
      }
      try {
        await reader.cancel();
      } catch {
        // already aborted — fine
      }
    }
  } catch {
    // Expected: the abort that ends the bounded window. If `ok` never flipped true, the
    // connection itself failed — surfaced via the returned `ok: false`, not swallowed.
  } finally {
    clearTimeout(timer);
  }
  if (capExceeded) {
    throw new Error(
      `N68 bounded stream read for "${path}" hit its ${STREAM_SNAPSHOT_CAP_BYTES}-byte cap ` +
      `without the stream ending on its own — this must be investigated (raise the cap only ` +
      `after confirming nothing past it is a leak), not silently truncated. See astra round-2 ` +
      `finding 1(c).`,
    );
  }
  return { text, ok, status };
}

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

// ─────────────────────────────────────────────────────────────────────────────────────────
// DMS (degrees/minutes/seconds) detector — astra round-1-of-MEDIUM-1 bullet: "DMS and
// plus-code representations remain undetected." Two source shapes, both with an OPTIONAL
// seconds component (degrees-decimal-minutes omits seconds entirely):
//   symbol form: 47°37′13.77516″N   (Unicode ° ′ ″, or ASCII ' " — both accepted)
//   spaced form: 47 37 13.8 N       (no symbols at all, whitespace-separated)
// A trailing N/S/E/W hemisphere letter is REQUIRED in both so the sign is unambiguous and so
// three random adjacent numbers can't false-positive (see isCloseNumber-grade tolerance below).
// ─────────────────────────────────────────────────────────────────────────────────────────

const DMS_SYMBOL_RE =
  /(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*['′]\s*(?:(\d{1,2}(?:\.\d+)?)\s*["″]\s*)?([NSEWnsew](?![A-Za-z]))?/g;
/** 47:37:13.8 (N) — colon-separated; the hemisphere is optional, as in the symbol form. */
const DMS_COLON_RE = /(\d{1,3}):(\d{1,2}(?:\.\d+)?)(?::(\d{1,2}(?:\.\d+)?))?\s*([NSEWnsew](?![A-Za-z]))?/g;
const DMS_SPACED_RE =
  /\b(\d{1,3})\s+(\d{1,2}(?:\.\d+)?)(?:\s+(\d{1,2}(?:\.\d+)?))?\s+([NSEWnsew])\b/g;

function dmsToDecimal(deg: number, min: number, sec: number, hemi: string): number {
  const magnitude = deg + min / 60 + sec / 3600;
  return /[SsWw]/.test(hemi) ? -magnitude : magnitude;
}

/** First DMS/DDM match (either shape) that decodes within ~110m of the canary's lat OR lng,
 *  else null. 1e-3 decimal degrees (vs. the numeric tree-walk's 1e-4) gives slack for the
 *  lower-precision spaced form's 1-decimal seconds — still ~45x tighter than the ~0.045°
 *  coarse cell the production fix allows, so nowhere near a false accept. */
function dmsLeak(text: string): string | null {
  for (const re of [DMS_SYMBOL_RE, DMS_SPACED_RE, DMS_COLON_RE]) {
    for (const m of text.matchAll(re)) {
      const deg = Number(m[1]);
      const min = Number(m[2]);
      const sec = m[3] !== undefined ? Number(m[3]) : 0;
      const hemi = m[4];
      if (deg > 180 || min >= 60 || sec >= 60) continue; // not a plausible coordinate triple
      // With no hemisphere letter (a signed or hemisphere-first form), compare the magnitude.
      const close = hemi
        ? (dec: number) => Math.abs(dec - CANARY.lat) < 1e-3 || Math.abs(dec - CANARY.lng) < 1e-3
        : (dec: number) => Math.abs(dec - Math.abs(CANARY.lat)) < 1e-3 || Math.abs(dec - Math.abs(CANARY.lng)) < 1e-3;
      if (close(dmsToDecimal(deg, min, sec, hemi ?? "N"))) return `dms-overprecise:${m[0]}`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Plus-code (Open Location Code) detector. Encoder implemented from the public OLC algorithm
// from scratch (clean room: no fetch, no new dependency) — only the 10-digit "pair" stage
// (resolution table below), which is all the ~275m threshold the task asks for needs; the
// digits-11-15 grid-refinement stage is intentionally not implemented.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** 20-symbol OLC alphabet — excludes 0/1 and visually-confusable letters (public spec). */
const OLC_ALPHABET = "23456789CFGHJMPQRVWX";
/** Degrees-per-digit at each pair stage (2/4/6/8/10 digits): 20°, 1°, 0.05°, 0.0025°, 0.000125°. */
const OLC_PAIR_RESOLUTIONS = [20.0, 1.0, 0.05, 0.0025, 0.000125];
const OLC_SEPARATOR_POSITION = 8;

function olcEncodePairs(latitude: number, longitude: number, codeLength = 10): string {
  let lat = latitude + 90; // → [0, 180]
  let lng = longitude + 180; // → [0, 360)
  let code = "";
  let digitCount = 0;
  while (digitCount < codeLength) {
    const placeValue = OLC_PAIR_RESOLUTIONS[Math.floor(digitCount / 2)];
    let digit = Math.floor(lat / placeValue);
    lat -= digit * placeValue;
    code += OLC_ALPHABET[digit];
    digitCount++;
    digit = Math.floor(lng / placeValue);
    lng -= digit * placeValue;
    code += OLC_ALPHABET[digit];
    digitCount++;
    if (digitCount === OLC_SEPARATOR_POSITION && digitCount < codeLength) code += "+";
  }
  if (code.length <= OLC_SEPARATOR_POSITION) code = code.padEnd(OLC_SEPARATOR_POSITION, "0") + "+";
  return code;
}

/** First 8 alphabet digits (~275m resolution) of the canary's own plus code, no "+". A
 *  6-digit PREFIX match (~5.5km) is the fix's allowed coarse precision and must NOT be
 *  flagged; matching 8+ digits locates the canary more finely than the ~5km cell and IS a
 *  leak. The OLC padding scheme (zero-pad short codes before the "+") means a genuinely
 *  coarse 6-digit code naturally can't match 8 alphabet characters — '0' isn't in
 *  OLC_ALPHABET, so the run below stops there. */
const CANARY_PLUS_CODE = olcEncodePairs(CANARY.lat, CANARY.lng, 10);
const CANARY_PLUS8 = CANARY_PLUS_CODE.replace("+", "").toUpperCase().slice(0, 8);
const PLUS_CODE_RUN_RE = /[23456789CFGHJMPQRVWXcfghjmpqrvwx+]{4,}/g;

/** The canary's short code (digits 5-10 around the "+", e.g. JMC2+58): about 14 m once a
 *  locality is named beside it, which is how maps render it. */
const CANARY_SHORT_CODE = CANARY_PLUS_CODE.slice(4, 11).toUpperCase();

function plusCodeLeak(text: string): string | null {
  if (text.toUpperCase().includes(CANARY_SHORT_CODE)) return `plus-code-short:${CANARY_SHORT_CODE}`;
  for (const run of text.match(PLUS_CODE_RUN_RE) ?? []) {
    const digits = run.replace(/\+/g, "").toUpperCase();
    if (digits.length < 8) continue; // ≤6-digit (~5.5km) coarse form is the allowed precision
    if (digits.startsWith(CANARY_PLUS8)) return `plus-code-overprecise:${run}`;
  }
  return null;
}

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
  const dms = dmsLeak(s);
  if (dms) return dms;
  const plus = plusCodeLeak(s);
  if (plus) return plus;
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
 *  (JSON bodies only) UNIONED with a whole-body run of the FULL string detector (works on
 *  any body, JSON or not). astra round-1-of-MEDIUM-1: "Non-JSON responses receive only the
 *  original substring check" — responseTreeLeaks() still only walks parsed JSON, but
 *  stringLeak() (number-closeness, address substring/base64, geohash, DMS, plus-code) now
 *  also runs over the raw body text unconditionally, so a non-JSON (e.g. text/html) body, or
 *  a JSON body with the leak embedded inside a longer string that isn't its own clean leaf
 *  value, is no longer invisible to everything but the seven literal NEEDLES. */
function leakHits(body: string): string[] {
  const substr = NEEDLES.filter((n) => body.includes(n));
  const tree = responseTreeLeaks(body);
  const wholeBodyWhy = stringLeak(body);
  const whole = wholeBodyWhy ? [`$body:${wholeBodyWhy}`] : [];
  return [...new Set([...substr, ...tree, ...whole])];
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// astra round-1-of-MEDIUM-1 item 2 ("reached, not called"): the structural POST loop below
// used to send every non-special route a blank `{}` body. A route requiring real input just
// 400s on validation and never exercises its success branch — the exact gap the review's
// cheapest reproduction demonstrated against /api/requests (R2 log: n68-medium1-repro).
//
// FIXTURE_POST_BODIES supplies a schema/handler-appropriate crafted body for every route
// below that can be pushed from a blank-body 4xx to a genuine 2xx — each one was decided by
// reading that route's validation and handler (not guessed), per implementer-kilo's
// triage-{alpha,bravo,charlie,delta} research passes (full per-url rationale recorded in this
// commit's body; cited here per-group). Every url NOT in this map is either SPECIAL_POST_CALLS
// (above), a POST_EXCLUSIONS family (below), or must have a NOT_REACHED entry (below) — the
// STRUCTURAL test fails on any called route in none of these three buckets that doesn't reach
// a 2xx (see "reached, not called" in that test).
//
// /api/capabilities is the standout: a stranger POSTing just {kernelId, type} derives the
// SAME deterministic id the canary's own capability got at creation
// (`cap-${kernelId}-${type}`, capability.facade.ts:314) and hits the upsert's existing-row
// short-circuit (capability.facade.ts: `if (existing) { ...; return {capability: dto,
// created:false}; }` — never overwrites, just returns the real DTO). That makes this one of
// the highest-value calls in the whole sweep: a write route that is ALSO a read path onto the
// canary's own row, with no ownership check at all. Confirmed safe only because
// populateCapabilityDTO still coarsens through publicLocation()/locationVisibilityOf()
// (capability.populator.ts:34, public-location.ts:132-153) — if that coarsening path were ever
// bypassed for this route, this exact fixture call would catch it.
// ─────────────────────────────────────────────────────────────────────────────────────────
// Dynamic fixtures (round-2 required fix 1): a FIXTURE_POST_BODIES entry can now be either a
// static object (unchanged — used across every generic path-param fill, same as before) OR a
// SELF-DRIVING async function that makes its OWN app.inject() calls (as the SAME caller: the
// anonymous pass has no key, the keyed pass carries the stranger's own Bearer token
// throughout every call it makes) and returns the {status, body} of whichever call is "the"
// recorded one — a setup call to create prerequisite state, then the real target call, often
// at a REAL id the setup call minted (not the generic kernelId/capId/operatorId fill, which a
// freshly-created anomaly/approval/scope/job/session id never matches). The structural loop
// below calls a function fixture exactly ONCE per pass (not once per generic path variant —
// a self-driving fixture already targets a specific, real id) and records its {status, body}
// directly into POST_CALL_LOG, same as any other structural call.
//
// This is what finally closes astra's "reached, not called" gap for routes needing a binary
// body, a signed message, or a row that only exists after a prior POST — e.g. /api/storage
// (binary + auth), /api/auth/verify (nonce + a locally-generated SIWE signature), and the many
// NOT_REACHED entries below that turned out to be the SAME gap (an entity created by a
// prior, already-reachable POST, keyed by a real id the generic path-param filler could never
// guess) rather than something structurally unreachable. Every dynamic fixture here was
// decided by reading that route's handler (not guessed) — see the NOT_REACHED table and its
// STALE-entry check for the full accounting of what moved and why.
//
// N68b (follow-up to #533 r5): ten more of those entries turned out to be the SAME gap, just
// with a stateless-mock twist round 2-5 missed — astra's r5 reproduction (and this round's own
// wider re-check of every sibling route sharing the same seed) moved them here too; see this
// block's own extended comment just above the Object.assign that adds them, and the NOT_REACHED
// table for the exact 20 entries that remain, each now carrying an executable `witness`.
// ─────────────────────────────────────────────────────────────────────────────────────────
interface FixtureCtx {
  app: FastifyInstance;
  /** The CURRENT pass's own identity: null for ANONYMOUS, the stranger's key for KEYED. A
   *  dynamic fixture's prior calls use this SAME key, so any ownership check the route
   *  applies (e.g. "only the creator may heartbeat this job") is satisfied by construction —
   *  this is the self-consistent "create your own, then act on your own" pattern, not an
   *  attempt to defeat an ownership check on someone ELSE's resource. */
  key: string | null;
  ip: () => string;
}
type DynamicFixture = (ctx: FixtureCtx) => Promise<{ status: number; body: string }>;

/** One HTTP call a dynamic fixture makes — either a SETUP call (only `.json` matters, to
 *  extract a freshly-minted id) or the FINAL recorded call (`.status`/`.body` ARE the
 *  fixture's result). Always carries the pass's own identity (ctx.key) and a fresh
 *  x-forwarded-for. Never throws — a failed setup call just yields an empty `json`, and
 *  whatever call is marked "final" surfaces the real resulting status/body, visible in
 *  STRUCTURAL's NOT_REACHED accounting if a fixture's assumption about the chain was wrong
 *  (not silently masked). */
async function fixtureCall(
  ctx: FixtureCtx,
  method: "GET" | "POST" | "PUT",
  url: string,
  payload?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "x-forwarded-for": ctx.ip(), ...extraHeaders };
  if (ctx.key) headers.authorization = `Bearer ${ctx.key}`;
  const res = await ctx.app.inject({ method, url, headers, payload: payload as object });
  let json: Record<string, unknown> = {};
  try {
    json = res.json();
  } catch {
    // non-JSON or empty body — fine, callers that don't need it won't look.
  }
  return { status: res.statusCode, body: res.body, json };
}

// ── Pizza-demo family shared fixture helper ─────────────────────────────────────────────────
// Round 4 re-triage: pizza-demo.ts's planComposition(outcomeChain:["make-pizza","delivered-
// pizza"]) ALWAYS routes to graph-search's Dijkstra traversal (compose.ts:539-541 — an explicit
// outcomeChain short-circuits past the in-memory /api/compose/_dev/register-candidate pool
// entirely), so seeding THAT pool can never satisfy it (the prior round-4 reasoning that it
// "could in principle" was wrong — re-read fresh). graph-search.ts DOES expose real dev-seed
// routes though: POST /api/capabilities/graph/_dev/register-node + register-edge
// (graph-search.ts:691-720), persisted via upsert (never dupes) into the SAME SQLite snapshot
// searchGraph() reads (graph-search.ts:504-505). One make-pizza node (empty inputTypes, so it
// qualifies as a start candidate per findStartNodes, graph-search.ts:334-342) feeding one
// deliver-pizza node (outputTypes includes "delivered-pizza", so it qualifies as an end
// candidate per findEndNodes, graph-search.ts:345-349) via one edge is a real, legal 2-step
// path within pizza-demo's own $30 default budget and assuranceTier:1 floor — confirmed
// empirically below, not just in theory. Those _dev endpoints require auth (not in
// api-gate.ts's PUBLIC_PREFIXES/PUBLIC_EXACT, confirmed by reading api-gate.ts fresh this
// round), so the ANONYMOUS pass (ctx.key === null) provisions its own throwaway key first;
// fixtureCall only auto-attaches ctx.key's Bearer when ctx.key is truthy, so a KEYED pass's
// own stranger key is reused as-is. Every downstream pizza-demo fixture below (confirm/cancel/
// accept/pickup/complete/reject) places a FRESH order via this helper, then drives its own
// extra step(s) on that SAME order/job — closing the cascade of 6 other NOT_REACHED entries
// whose own stated reason was "pizza-order, itself blocked below, never populates this Map".
const PIZZA_SHOP_CAP_ID = "n68-dynfix-pizza-shop";
const PIZZA_DRIVER_CAP_ID = "n68-dynfix-pizza-driver";
/** Matches pizza-demo.ts's own default deliveryLocation fallback — zero haversine distance,
 *  always inside the composeReq's 25km radius regardless of registration order. */
const PIZZA_LOC = { lat: 37.77, lng: -122.42 };

async function pizzaAuthHeader(ctx: FixtureCtx): Promise<Record<string, string>> {
  if (ctx.key) return {}; // fixtureCall already attaches ctx.key's own Bearer automatically
  const prov = await fixtureCall(ctx, "POST", "/api/auth/provision", {
    email: `n68-dynfix-pizzagraph-${ctx.ip()}@example.invalid`,
    name: "N68 dynamic fixture",
  });
  const apiKey = String(prov.json.api_key ?? "");
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function createPizzaOrderForFixture(
  ctx: FixtureCtx,
): Promise<{ status: number; body: string; json: Record<string, unknown>; orderId: string }> {
  const auth = await pizzaAuthHeader(ctx);
  const nodeShop = await fixtureCall(ctx, "POST", "/api/capabilities/graph/_dev/register-node", {
    capabilityId: PIZZA_SHOP_CAP_ID, capabilityType: "make-pizza", kernelId: "kernel-n68-pizza-dynfix-shop",
    estimatedPriceUSD: 5, estimatedDurationMs: 60_000, assuranceTier: 1,
    location: PIZZA_LOC, available: true, inputTypes: [], outputTypes: ["n68-dynfix-pizza-wip"],
  }, auth);
  const nodeDriver = await fixtureCall(ctx, "POST", "/api/capabilities/graph/_dev/register-node", {
    capabilityId: PIZZA_DRIVER_CAP_ID, capabilityType: "deliver-pizza", kernelId: "kernel-n68-pizza-dynfix-driver",
    estimatedPriceUSD: 5, estimatedDurationMs: 60_000, assuranceTier: 1,
    location: PIZZA_LOC, available: true, inputTypes: ["n68-dynfix-pizza-wip"], outputTypes: ["delivered-pizza"],
  }, auth);
  const edge = await fixtureCall(ctx, "POST", "/api/capabilities/graph/_dev/register-edge", {
    fromCapabilityId: PIZZA_SHOP_CAP_ID, toCapabilityId: PIZZA_DRIVER_CAP_ID, capabilityTypeFlow: "n68-dynfix-pizza-wip",
    estimatedHandoffPriceUSD: 0, estimatedHandoffDurationMs: 0,
  }, auth);
  if (nodeShop.status !== 201 || nodeDriver.status !== 201 || edge.status !== 201) {
    return {
      status: -3,
      body: `dynamic fixture graph setup failed: shop=${nodeShop.status} driver=${nodeDriver.status} edge=${edge.status}`,
      json: {},
      orderId: "",
    };
  }
  const order = await fixtureCall(ctx, "POST", "/api/demo/pizza-order", {
    userId: "n68-dynfix-pizza-user",
    description: "N68 dynamic fixture order",
    deliveryAddress: "1 Market St, San Francisco, CA",
    deliveryLocation: PIZZA_LOC,
  });
  const orderId = String((order.json.order as Record<string, unknown> | undefined)?.orderId ?? "");
  return { status: order.status, body: order.body, json: order.json, orderId };
}

const FIXTURE_POST_BODIES: Record<string, object | DynamicFixture> = {
  "/api/a2a/send": {"id":"msg-n68-sweep-1","to":"stranger-agent-test","from":"n68-sweep","intent":{"type":"ping"},"conversationId":"conv-n68-sweep-1","timestamp":"2026-01-01T00:00:00.000Z"},
  "/api/anomaly/protocol-failure": {"protocol":"evidence_submission","errorCode":"E1","errorMessage":"test failure","involvedAgents":["agent-1"]},
  "/api/anomaly/report": {"severity":"info","category":"timeout","description":"test anomaly description"},
  "/api/artifacts": {"name":"N68 Test Dashboard","manifest":{"csd":"pcc://artifacts/dashboard/v1","title":"Test","sections":[]}},
  "/api/auth/provision": {"email":"stranger-sweep-test@example.com","name":"Sweep Test"},
  "/api/batches/shared": {"kernelId":"kernel-n68-canary","capabilityType":"3d-printing","totalSlots":10,"protocolType":"hplc-batch","pricePerSlot":"5.00"},
  "/api/beta-apply": {"email":"n68-sweep-stranger@example.com"},
  "/api/bounty/demand": {"requesterId":"stranger@example.com","capabilityType":"3d-printing","description":"Need 3D printing capacity nearby"},
  "/api/build/contract": {"type":"3d-printing","selections":{"quantity":1},"assuranceTier":0},
  "/api/build/options": {"type":"3d-printing"},
  "/api/build/price": {"type":"3d-printing","selections":{"quantity":1}},
  "/api/capabilities": {"kernelId":"kernel-n68-canary","type":"3d-printing"},
  "/api/capabilities/graph-search": {"outcomeType":"3d-printing","budgetUSD":100,"minAssuranceTier":0},
  "/api/capabilities/graph/_dev/register-edge": {"fromCapabilityId":"cap-a","toCapabilityId":"cap-b","capabilityTypeFlow":"3d-printing->shipping"},
  "/api/capabilities/graph/_dev/register-node": {"capabilityId":"cap-test-node-1","capabilityType":"3d-printing","kernelId":"kernel-n68-canary","estimatedPriceUSD":5,"estimatedDurationMs":1000,"assuranceTier":0},
  "/api/capabilities/templates/match": {"input":"I run a 3D printing shop"},
  "/api/compliance/profiles": {"kernelId":"kernel-n68-canary"},
  "/api/compliance/templates": {"regulationId":"reg-test-1","name":"Test Regulation","version":"1.0"},
  "/api/compose": {"outcomeType":"3d-printing","budgetUSD":100,"minAssuranceTier":0},
  "/api/compose/_dev/register-candidate": {"capabilityId":"cap-test-1","kernelId":"kernel-n68-canary","operatorAddress":"0xtest","capabilityType":"3d-printing","estimatedPriceUSD":10,"estimatedDurationMs":60000,"assuranceTier":0,"available":true},
  "/api/compositions/:compositionId/finalize-reputation": {"finalizerId":"stranger-agent"},
  "/api/compositions/:compositionId/step-outcome": {"compositionId":"test-comp-1","stepIndex":0,"capabilityId":"cap-test","agentId":"stranger-agent","status":"success","startedAt":"2026-01-01T00:00:00Z"},
  "/api/contributors": {"address":"0xabcd1234abcd1234abcd1234abcd1234abcd1234","role":"operator","scheduleHash":"0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234"},
  "/api/contributors/quickstart": {"email":"stranger-test@example.com","role":"operator","ratePercent":1.5},
  "/api/contributors/schedules": {"publishedBy":"0xabcd1234abcd1234abcd1234abcd1234abcd1234","schedule":{"version":1,"segments":[{"kind":"constant","startTime":1700000000,"endTime":null,"bps":150}]}},
  "/api/contributors/training-manifests": {"modelIpId":"ip-test-1","datasetWeights":[{"datasetIpId":"ip-dataset-1","weightBps":5000}]},
  "/api/courier-jobs": {"deliveryId":"del-test-1","pickup":{"address":"123 Test St"},"dropoff":{"address":"456 Test Ave"}},
  "/api/courier-jobs/jobs": {"deliveryId":"del-test-2","pickup":{"address":"123 Test St"},"dropoff":{"address":"456 Test Ave"}},
  "/api/csd": {"url":"pcc://capabilities/n68-test/v1","version":"1.0.0","status":"draft","name":"N68 Test CSD","description":"test","kind":"base","baseDefinition":null,"parameters":[],"constraints":[],"pricing":{"basePrice":"5","currency":"USDC"}},
  "/api/csd/resolve": {"url":"pcc://capabilities/fdm/v2"},
  "/api/devices/register": {"kernelId":"kernel-n68-canary","id":"dev-test-1","type":"machine","model":"Test Device","adapterType":"mock","capabilities":["3d-printing"]},
  "/api/discover/generate-csd": {"device":{"protocol":"ipp","name":"Test Printer","uri":"ipp://192.168.1.50/ipp/print","makeModel":"Test Printer","capabilities":{}}},
  "/api/evidence/archive": {"bundle":{"id":"test-bundle-1","jobId":"job-test-1","stepId":"step-test-1","kernelId":"kernel-n68-canary","assuranceTier":0,"bundleHash":"sha256:test","events":[],"kernelSignature":{"signer":"0x0000000000000000000000000000000000000001","signature":"0x00"},"createdAt":"2026-01-01T00:00:00.000Z"}},
  "/api/faucet/usdc": {"walletAddress":"0x0000000000000000000000000000000000000001","amount":10},
  "/api/feedback": {"summary":"test feedback from sweep"},
  "/api/feedback/agent-report": {"summary":"Agent is stuck on step 3 of onboarding"},
  "/api/fiat-ramp/cdp/spend-permission": {"walletAddress":"0x1111111111111111111111111111111111111111","spender":"0x2222222222222222222222222222222222222222","allowanceUSDC":10},
  "/api/fiat-ramp/coinbase/onramp": {"walletAddress":"0x3333333333333333333333333333333333333333"},
  "/api/fiat-ramp/stripe/onramp": {"walletAddress":"0x0000000000000000000000000000000000000001"},
  "/api/fiat-ramp/wise/batch-payout": {"payouts":[{"sourceAmount":10,"recipient":{"name":"Test Recipient","currency":"USD","type":"email","details":{}},"reference":"test-ref-1"}]},
  "/api/fiat-ramp/wise/payout": {"sourceAmount":10,"recipient":{"name":"Test Recipient","currency":"USD","type":"email","details":{}},"reference":"test-ref-1"},
  "/api/fiat-ramp/yellowcard/deposit": {"fiatAmount":"100","fiatCurrency":"USD","country":"US","channelId":"chan-1","recipient":{"name":"Test","country":"US","phone":"+15555550100","address":"123 Test St","dob":"1990-01-01","idNumber":"ID123","idType":"passport"},"walletAddress":"0x0000000000000000000000000000000000000001"},
  "/api/fiat-ramp/yellowcard/withdraw": {"walletAddress":"0x0000000000000000000000000000000000000001","amountUsd":"50","fiatCurrency":"USD","country":"US","channelId":"chan-1","destination":{"type":"bank_transfer","accountName":"Test","accountNumber":"000123456","country":"US"},"sender":{"name":"Test Sender","country":"US","address":"123 Test St","dob":"1990-01-01","email":"stranger@example.com","idNumber":"ID123","idType":"passport"}},
  "/api/gasless/onboard": {"signerAddress":"0x1234567890123456789012345678901234567890"},
  "/api/identity/session": {"principalAgentId":"stranger-test-agent-1"},
  "/api/identity/session/revoke": {"sessionId":"test-session-1"},
  "/api/identity/session/verify": {"event":{"eventData":"0011","sessionSignature":"abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab","proof":{"sessionKey":{"sessionId":"test-session-1","parentAgentId":"eip155:84532:0x0000000000000000000000000000000000000001","publicKey":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","issuedAt":0,"expiresAt":9999999999,"scope":{"allowedActions":["evidence_submit"],"contractIds":[],"maxSignatures":1000},"parentSignature":"efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef"},"parentPublicKey":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"}},"action":"evidence_submit"},
  "/api/intents/ingest": {"id":"intent-test-1","source":"sdk","compositionSignature":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","capabilityTypes":["3d-printing"],"summary":"test intent","budgetBand":"under_100","urgencyBand":"standard","createdAt":"2026-10-03T00:00:00.000Z"},
  "/api/ip/:ipId/dispute": {"evidenceHash":"sha256:test","reason":"test dispute"},
  "/api/ip/register-capability": {"capability":{"id":"cap-test-1","name":"Test Cap","type":"3d-printing","kernelId":"kernel-n68-canary"},"designerAddress":"0x0000000000000000000000000000000000000001","designerName":"Test Designer"},
  "/api/ip/register-job-evidence": {"parentIpId":"ip-test-parent-1","jobId":"job-test-1","evidenceBundleHash":"sha256:test","operatorAddress":"0x0000000000000000000000000000000000000001","operatorName":"Test Operator"},
  "/api/ip/set-licensing-terms": {"ipId":"ip-test-1","designerAddress":"0x0000000000000000000000000000000000000001"},
  "/api/job-offers": {"capabilityType":"3d-printing","requirements":{"material":"PLA"},"pricing":{"amount":10,"currency":"USDC","model":"fixed"}},
  "/api/jobs/submit": {"stepId":"step-n68-sweep-1","kernelId":"kernel-n68-canary","capabilityType":"3d-printing","parameters":{}},
  "/api/jobs/submit-from-discovery": {"kernelId":"kernel-n68-canary","capabilityType":"3d-printing","userAgentId":"stranger-agent"},
  "/api/kernels/register": {"manifestVersion":"1.0.0","kernelId":"kernel-test-marketplace-1","name":"Test Marketplace Kernel","description":"test","builder":{"agentId":"agent-test-1"},"capabilityType":"3d-printing","workflowSteps":[{"step":"print"}],"pricing":{"currency":"USDC","baseUSD":1},"maxAssuranceTier":1,"endpointURL":"https://example.com/webhook","sessionKeyPolicy":{"maxTTLSeconds":3600,"allowedActions":["evidence_submit"]}},
  "/api/marketplace/listings": {"name":"Test Listing","category":"raw-metals","pricePerUnit":10,"unit":"kg"},
  "/api/marketplace/orders": {"listingId":"lst-al6061-bar","quantity":1},
  "/api/milestones/:id/tmp-task": {"mode":"auction","modeConfig":{"mode":"auction"}},
  "/api/near/intent": {"quoteId":"quote-test-1","workflowId":"workflow-test-1"},
  "/api/near/quote": {"fromChain":"near","fromAsset":"USDC","toChain":"base","toAsset":"USDC","amount":"1000000"},
  "/api/negotiate/session": {"userAgentId":"stranger-agent","kernelId":"kernel-n68-canary","capabilityType":"3d-printing"},
  "/api/onboard/analyze": {"text":"I run a 3D printing shop with two Prusa MK4s"},
  "/api/onboard/chat": {"message":"hello"},
  "/api/onboard/start": {"name":"N68 Sweep Test Co"},
  "/api/operator/approvals": {"kernelId":"kernel-n68-canary","agentId":"stranger-agent"},
  "/api/operator/diagnostics": {"kernelId":"kernel-n68-canary","encrypted":{"ciphertext_b64":"QQ==","iv_b64":"QQ==","salt_b64":"QQ==","tag_b64":"QQ=="}},
  "/api/operator/emergency-stop": {"kernelId":"kernel-n68-test-nonexistent","reason":"sweep test"},
  "/api/operator/evidence": {"jobId":"fake-test-job-xyz","evidence":{"note":"test"}},
  "/api/operator/heartbeat": {"kernelId":"kernel-n68-canary","status":"online"},
  "/api/operator/job-status": {"jobId":"fake-test-job-xyz","status":"queued"},
  "/api/operator/support": {"kernelId":"kernel-n68-canary","message":"N68 sweep test message"},
  "/api/operators/:slug/channels": {"transport":"manual","label":"stranger-channel","describe":"test notification channel"},
  "/api/orchestrator/data-product/start": {"name":"Stranger Data Co"},
  "/api/ot2/camera/frame": {"kernelId":"kernel-n68-canary","frame":"dGVzdA=="},
  "/api/ot2/chat": {"kernelId":"kernel-n68-canary","message":"test"},
  "/api/ot2/chat/respond": {"response":"test reply"},
  "/api/ot2/scope": {"kernelId":"kernel-n68-canary","createdBy":"stranger-agent","allowedTools":["ot2_health"]},
  "/api/ot2/tool-call": {"kernelId":"kernel-n68-canary","toolName":"ot2_health"},
  "/api/photo/compare": {"capturedImageBase64":"dGVzdA==","referenceImageBase64":"dGVzdA=="},
  "/api/photo/upload": {"imageBase64":"dGVzdA=="},
  // /api/relay/:kernelId/{camera/frame,chat,chat/respond,scope} moved to dynamic fixtures
  // below (#533 merge-up with master): master's relayAccessGuard (device-relay.ts:318-346,
  // see the dynamic-fixture comment near createOwnRelayKernel) now default-denies every relay
  // route to a caller who isn't the kernel's operator or an active scope holder, so a STATIC
  // body posted against a generic kernelId/capId/operatorId path-fill can no longer reach a
  // real kernel this pass controls.
  "/api/requests": {"title":"N68 sweep test request","description":"Direct-match request pinned to the canary capability — the task's own cheapest-repro target (requests.ts's direct-match branch shares the exact success return as the generic NL-decompose branch; R2 mutated both and confirmed the sweep now catches an injected leak on this line)","capabilityType":"3d-printing","kernelId":"kernel-n68-canary"},
  "/api/setup/generate-config": {"devices":[{"name":"Test Printer","type":"machine","adapterType":"mock"}]},
  "/api/setup/register-device": {"kernelId":"kernel-n68-canary","deviceId":"dev-n68-sweep-001","type":"machine","adapterType":"mock"},
  "/api/skills/register": {"humanDid":"did:example:stranger-tester","name":"Test Handyperson","description":"General repair services for sweep test","skillType":"handyperson","hourlyRateUSD":25,"location":{"lat":47.0,"lng":-122.0},"weeklyAvailableHours":10},
  "/api/telemetry/emit": {"jobId":"job-n68-sweep-1","phase":"discovery","status":"success"},
  "/api/templates/capabilities": {"capabilityType":"3d-printing","name":"N68 Sweep Test Template"},
  "/api/templates/machines": {"capabilityType":"3d-printing","machineName":"N68 Sweep Test Machine"},
  "/api/templates/verification": {"capabilityType":"3d-printing","name":"N68 Sweep Verification Template"},
  "/api/tmp/select-mode": {"capabilityType":"3d-printing"},
  "/api/tool-catalog/bounty": {"capabilityType":"3d-printing","description":"N68 sweep bounty test","budgetUSD":10},
  "/api/tool-catalog/register": {"name":"N68 Sweep Test Tool","description":"Synthetic tool registration for door-sweep coverage","repoUrl":"https://github.com/example/n68-sweep-tool","capabilityTypes":["3d-printing"],"maintainerDid":"did:example:stranger"},
  "/api/tools/search": {"query":"3d printing"},
  "/api/touchstone/inject": {"libraryId":"lib-accounting-v1"},
  "/api/unbrowse/skills/share": {"skillId":"skill-n68-sweep-test","domain":"example.com","intent":"test intent for sweep","discoveredBy":"stranger-tester"},
  "/api/verification/submit": {"bundleHash":"sha256:test123","photoRef":"photo-ref-1","referenceRef":"ref-1"},
  "/api/waitlist": {"email":"n68-sweep-stranger@example.com"},
  "/api/wizard/sessions": {"track":"platform-setup"},
  "/api/zk/commit": {"bundleHash":"sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"},
  "/api/zk/prove/tier": {"bundleHash":"sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef","requiredTier":1},
  "/api/zk/tree": {"bundleHashes":["sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"]},
  "/mcp": {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"n68-sweep","version":"1.0.0"}}},
  "/mcp/apps": {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"n68","version":"1.0.0"}}},
  "/mcp/docs": {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"n68-sweep","version":"1.0.0"}}},
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// Dynamic (self-driving) fixtures — round-2 required fix 1, plus the re-check of every OTHER
// NOT_REACHED entry the task asked for. Each one was moved here only after reading the
// route's handler (and, where relevant, its creation route) directly — see the per-entry
// comment at its OLD home in NOT_REACHED below for the citation this replaces. Two routes
// (/api/storage, /api/auth/verify) are the task's named examples; the rest turned out to be
// the identical gap — a real row/entity that only exists after a prior, already-reachable
// POST, keyed by an id the generic kernelId/capId/operatorId path-filler could never guess.
// ─────────────────────────────────────────────────────────────────────────────────────────

// ── #533 merge-up with master (N68 sweep refresh, implementer-oscar): master's #400 (N4b-gw
// item 4) added relayAccessGuard to every /api/relay/:kernelId/* route (device-relay.ts:
// 318-346) — default-deny per kernel, admitting only the kernel's recorded operator or an
// active execution-scope holder. CANARY.kernelId (owned by this file's OWNER identity, not
// the stranger pass) stopped working for every relay fixture below that used it, tool-call
// included — pre-#400 the only gate there was per-tool safety. createOwnRelayKernel() is the
// shared fix: register a FRESH kernel as the CURRENT pass's own authenticated identity (POST
// /api/kernels sets operatorAddress from the authenticated caller, kernel.facade.ts:493), so
// isKernelOperator(kernelId, principal) is true for that kernel — device-relay.ts:334-336
// checks this before ever branching on the route's listed access level, so it satisfies
// "kernel_operator" AND "operator_or_grant" routes alike, and object_owner routes (scope
// revoke) via ownsScope()'s own operator fallback (device-relay.ts:283-289). Shared by every
// /api/relay/* dynamic fixture below (tool-call, tool-call/:callId/start, tool-result, scope,
// scope/:scopeId/revoke, camera/frame, chat, chat/respond).
async function createOwnRelayKernel(ctx: FixtureCtx): Promise<string> {
  const kernelId = `n68-dynfix-relay-${ctx.ip()}-${Date.now()}`;
  await fixtureCall(ctx, "POST", "/api/kernels", {
    id: kernelId, name: "N68 dynamic fixture relay kernel", maxAssuranceTier: 1,
  });
  return kernelId;
}

Object.assign(FIXTURE_POST_BODIES, {
  // ── R1: binary body + auth (storage.ts requireAuth; non-JSON Content-Type) ──────────────
  "/api/storage": (async (ctx: FixtureCtx) => {
    const bytes = Buffer.from(`N68 dynamic-fixture binary blob ${ctx.ip()} ${Date.now()}`, "utf8");
    const r = await fixtureCall(ctx, "POST", "/api/storage", bytes, { "content-type": "application/octet-stream" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── R2: nonce + a locally-generated SIWE signature (viem, no network) ──────────────────
  "/api/auth/verify": (async (ctx: FixtureCtx) => {
    const nonceRes = await fixtureCall(ctx, "GET", "/api/auth/nonce");
    const nonce = String(nonceRes.json.nonce ?? "");
    const pk = generatePrivateKey();
    const account = privateKeyToAccount(pk);
    const domain = "n68-dynamic-fixture.test";
    const issuedAt = new Date().toISOString();
    const message =
      `${domain} wants you to sign in with your Ethereum account:\n${account.address}\n\n` +
      `N68 dynamic fixture login\n\nURI: https://${domain}/\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
    const signature = await account.signMessage({ message });
    const r = await fixtureCall(ctx, "POST", "/api/auth/verify", { message, signature }, { host: domain });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── agents/:id/verify: PUBLIC route; provision mints a real Ed25519 keypair + key_id, and
  // auth/ed25519.ts exports a matching signWithPrivateKeyHex "test/CLI helper" — a genuinely
  // local signature, same technique as /api/auth/verify. (provision.ts:391-442) ────────────
  "/api/agents/:id/verify": (async (ctx: FixtureCtx) => {
    const prov = await fixtureCall(ctx, "POST", "/api/auth/provision", {
      email: `n68-dynfix-agentverify-${ctx.ip()}@example.invalid`,
      name: "N68 dynamic fixture",
    });
    const keyId = String(prov.json.key_id ?? "");
    const ed = (prov.json.ed25519 as Record<string, unknown> | undefined) ?? {};
    const privHex = String(ed.private_key ?? "");
    const message = "N68 dynamic fixture agent-verify message";
    const sig = privHex ? signWithPrivateKeyHex(privHex, Buffer.from(message, "utf8")) : null;
    if (!keyId || !sig) return { status: -3, body: "dynamic fixture setup failed: no key_id/signature" };
    const r = await fixtureCall(ctx, "POST", `/api/agents/${encodeURIComponent(keyId)}/verify`, { message, signature: sig });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── anomaly/:anomalyId/resolve: fully public in-memory Map, no ownership gate at all
  // (anomaly.ts). /api/anomaly/report (already fixture'd) mints a real anomalyId. ──────────
  "/api/anomaly/:anomalyId/resolve": (async (ctx: FixtureCtx) => {
    const report = await fixtureCall(ctx, "POST", "/api/anomaly/report", {
      severity: "info", category: "timeout", description: "N68 dynamic fixture anomaly",
    });
    const anomalyId = String(report.json.anomalyId ?? "");
    if (!anomalyId) return { status: -3, body: "dynamic fixture setup failed: no anomalyId" };
    const r = await fixtureCall(ctx, "POST", `/api/anomaly/${encodeURIComponent(anomalyId)}/resolve`, {
      resolution: "N68 dynamic fixture resolved it",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── artifacts/:id/fork: canRead() treats default "unlisted" visibility same as "public"
  // for read/fork purposes — any caller may fork (artifacts.ts). ─────────────────────────
  "/api/artifacts/:id/fork": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/artifacts", {
      name: "N68 dynamic fixture artifact",
      manifest: { csd: "pcc://artifacts/dashboard/v1", title: "N68", sections: [] },
    });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no artifact id" };
    const r = await fixtureCall(ctx, "POST", `/api/artifacts/${encodeURIComponent(id)}/fork`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── batches/shared/:batchId/claim: fully public in-memory Map (batches.ts); the OTHER
  // batches entry (/api/batches/:batchId/slots, a DIFFERENT BatchTracker store) is NOT moved
  // — re-checked and confirmed DEAD below (services.ts seeds exactly one BatchTracker batch,
  // already sealed+started before this test ever runs; no route creates another). ─────────
  "/api/batches/shared/:batchId/claim": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/batches/shared", {
      kernelId: CANARY.kernelId, capabilityType: "3d-printing", totalSlots: 10,
      protocolType: "hplc-batch", pricePerSlot: "5.00",
    });
    const batchId = String((created.json.batch as Record<string, unknown> | undefined)?.id ?? "");
    if (!batchId) return { status: -3, body: "dynamic fixture setup failed: no batch id" };
    const r = await fixtureCall(ctx, "POST", `/api/batches/shared/${encodeURIComponent(batchId)}/claim`, {
      agentId: "n68-dynfix-agent", slotCount: 1,
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── bounty/claim (#533 merge-up with master, implementer-oscar): bounty/verify (the sibling
  // this entry used to chain into) is now retired — POST_EXCLUSIONS above — so this sweep
  // never calls it. claim itself was ALSO already broken before that, for an unrelated reason:
  // the shared bountyService instance (routes/bounty.ts:13, "Treasury auto-bounties stay off
  // (the service default)") is `new BountyService()` with no options, and checkAndCreateBounties()
  // (bounty-service.ts:285-286) returns [] unconditionally whenever autoCreateTreasuryBounties
  // is not explicitly true — no demand signal, however large, EVER auto-creates a bounty
  // through the public /api/bounty/demand route. The chain this fixture used to drive
  // (demand -> auto-create -> list -> claim) could never produce a bountyId to claim.
  // _bountyServiceForTests() (bounty.ts:16-18) is the route file's own test seam for exactly
  // this: seed an open bounty directly on the SAME shared instance the route reads, then claim
  // it as this pass's own authenticated identity (claim derives operatorId from the auth
  // header, not the body — red team #10, bounty.ts:114-118 — so the KEYED pass's stranger key
  // satisfies it; the ANON pass 401s, which is fine since only one pass needs to reach 2xx). ──
  "/api/bounty/claim": (async (ctx: FixtureCtx) => {
    const bounty = _bountyServiceForTests().createBounty({
      capabilityType: `n68-dynfix-bounty-claim-${ctx.ip()}`,
      description: "N68 dynamic fixture bounty",
      bountyReward: 100,
      currency: "USDC",
      requirements: { minimumAssuranceTier: 0, mustComplete1Job: false, mustPassVerification: false },
      expiresInDays: 30,
    });
    const r = await fixtureCall(ctx, "POST", "/api/bounty/claim", { bountyId: bounty.id });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── setup/test-job (#533 merge-up with master, implementer-oscar): N59/ADK item 8 (setup.ts:
  // 783-803) owner-gates this to the kernel's OWN recorded operator, AND (setup.ts:836-852)
  // "the gateway runs jobs only for its OWN in-process kernel" — the kernelId in the body must
  // equal svc.kernelId, the ONE kernel id this gateway process's KernelService was constructed
  // with. With KERNEL_ID/KERNEL_CONFIG/KERNEL_CONFIG_FILE all unset in this sweep (confirmed:
  // none match the env-clearing list or EXTERNAL_ENV_RE above), loadKernelConfig() falls
  // through to buildDefaultConfig() (packages/kernel/src/kernel-config.ts:61-65), which fixes
  // that id at the literal string "kernel_dev_001" for the life of this process — not a kernel
  // this sweep gets to choose, so the fixture registers THAT exact id as its own identity (no
  // row exists for it yet; a fresh create sets operatorAddress = the caller, kernel.facade.ts:
  // 493) rather than minting a fresh random one like every other relay/kernel fixture here.
  // register-device (setup.ts:605-612, no ownership check of its own) then installs a real
  // "mock" adapter runner for a fresh deviceId via refreshDeviceFromDb (kernel-service.ts:
  // 257-268, since both rows' kernelId agree), which is what hasRunner(deviceId) (setup.ts:860,
  // 867) needs before test-job will dispatch anything. The route's final reply has no
  // `.code()` override (setup.ts:1010), so it answers 200 regardless of whether the mock job's
  // polled outcome reports simulated/passed — ran:true is all REACHED needs. ─────────────────
  "/api/setup/test-job": (async (ctx: FixtureCtx) => {
    const kernelId = "kernel_dev_001";
    const deviceId = `n68-dynfix-test-job-device-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", "/api/kernels", {
      id: kernelId, name: "N68 dynamic fixture dev kernel", maxAssuranceTier: 1,
    });
    await fixtureCall(ctx, "POST", "/api/setup/register-device", {
      kernelId, deviceId, type: "machine", adapterType: "mock",
    });
    const r = await fixtureCall(ctx, "POST", "/api/setup/test-job", { kernelId, deviceId, assuranceTier: 0 });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── kernels/:kernelId/suspend: separate manifestRegistry (kernel-marketplace.ts); PUBLIC
  // register, and isAdminAuthorized()'s own "no admin key configured + NODE_ENV!==production"
  // dev-mode bypass is wide open now that NODE_ENV is force-set to "test" (round-2 fix 4).
  // NOTE: the SIBLING /verify route is NOT moved — re-checked and still holds: its smoke test
  // does a REAL fetch to manifest.endpointURL, which this file's OWN no-network guard (round-2
  // fix 4) now blocks for any non-loopback URL; see its refreshed NOT_REACHED reason below. ──
  "/api/kernels/:kernelId/suspend": (async (ctx: FixtureCtx) => {
    const kernelId = `n68-dynfix-kernel-${ctx.ip()}-${Date.now()}`;
    await fixtureCall(ctx, "POST", "/api/kernels/register", {
      manifestVersion: "1.0.0", kernelId, name: "N68 dynamic fixture kernel", description: "test",
      builder: { agentId: "n68-dynfix-builder" }, capabilityType: "3d-printing",
      workflowSteps: [{ step: "print" }], pricing: { currency: "USDC", baseUSD: 1 },
      maxAssuranceTier: 1, endpointURL: "https://example.invalid/webhook",
      sessionKeyPolicy: { maxTTLSeconds: 3600, allowedActions: ["evidence_submit"] },
    });
    const r = await fixtureCall(ctx, "POST", `/api/kernels/${encodeURIComponent(kernelId)}/suspend`, {
      reason: "N68 dynamic fixture",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── milestones/:id/tmp-{bid,claim,pitch,validate}: tmp-tasks.ts has NO auth/ownership gate
  // at all — pure mode-matching on an in-memory Map keyed by milestoneId. tmp-task (already
  // fixture'd, mode=auction) only covers ONE mode; the other three need their OWN milestoneId
  // pre-seeded with the matching mode first. tmp-validate's acceptance may legitimately be
  // false (bogus proof) but the ROUTE still returns 200 either way (tmp-tasks.ts has no
  // reply.code() override on that branch). ──────────────────────────────────────────────────
  "/api/milestones/:id/tmp-bid": (async (ctx: FixtureCtx) => {
    const id = `n68-dynfix-ms-bid-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-task`, { mode: "auction", modeConfig: { mode: "auction" } });
    const r = await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-bid`, { bidder: "n68-dynfix-bidder", amount: "10" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/milestones/:id/tmp-claim": (async (ctx: FixtureCtx) => {
    const id = `n68-dynfix-ms-claim-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-task`, { mode: "claim", modeConfig: { mode: "claim" } });
    const r = await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-claim`, { worker: "n68-dynfix-worker" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/milestones/:id/tmp-pitch": (async (ctx: FixtureCtx) => {
    const id = `n68-dynfix-ms-pitch-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-task`, { mode: "pitch", modeConfig: { mode: "pitch" } });
    const r = await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-pitch`, { pitcher: "n68-dynfix-pitcher", proposal: "N68 dynamic fixture proposal" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/milestones/:id/tmp-validate": (async (ctx: FixtureCtx) => {
    const id = `n68-dynfix-ms-validate-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-task`, { mode: "benchmark", modeConfig: { mode: "benchmark" } });
    const r = await fixtureCall(ctx, "POST", `/api/milestones/${id}/tmp-validate`, {
      proofType: "n68-dynfix-proof", proof: "0xdynfix", worker: "n68-dynfix-worker",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── operator/approvals/:id/{approve,reject}: no auth/ownership gate (operator.ts); POST
  // /api/operator/approvals (already fixture'd) returns the real row with its minted id. ────
  "/api/operator/approvals/:id/approve": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/operator/approvals", { kernelId: CANARY.kernelId, agentId: "n68-dynfix-agent" });
    const id = String((created.json.approval as Record<string, unknown> | undefined)?.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no approval id" };
    const r = await fixtureCall(ctx, "POST", `/api/operator/approvals/${encodeURIComponent(id)}/approve`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/operator/approvals/:id/reject": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/operator/approvals", { kernelId: CANARY.kernelId, agentId: "n68-dynfix-agent-2" });
    const id = String((created.json.approval as Record<string, unknown> | undefined)?.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no approval id" };
    const r = await fixtureCall(ctx, "POST", `/api/operator/approvals/${encodeURIComponent(id)}/reject`, { reason: "N68 dynamic fixture reject" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── operator/emergency-resume: no auth gate (operator.ts); chicken/egg solved by stopping
  // first, on a fresh synthetic kernelId so this never touches the canary's own policy. ──────
  "/api/operator/emergency-resume": (async (ctx: FixtureCtx) => {
    const kernelId = `n68-dynfix-estop-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", "/api/operator/emergency-stop", { kernelId, reason: "N68 dynamic fixture setup" });
    const r = await fixtureCall(ctx, "POST", "/api/operator/emergency-resume", { kernelId });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── operator/diagnostics/decrypt: we hold BOTH sides — encrypt our own bundle with the
  // EXACT recipe diagnostic-logs.ts expects (PBKDF2-SHA256/100k/32B key, AES-256-GCM), upload
  // it, then decrypt with the same retrieval code. No auth gate on either route. ─────────────
  "/api/operator/diagnostics/decrypt": (async (ctx: FixtureCtx) => {
    const retrievalCode = `n68-dynfix-code-${ctx.ip()}`;
    const salt = cryptoRandomBytes(16);
    const iv = cryptoRandomBytes(12);
    const key = pbkdf2Sync(retrievalCode, salt, 100_000, 32, "sha256");
    const bundle = { note: "N68 dynamic fixture diagnostic bundle", ts: new Date().toISOString() };
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(bundle), "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    const uploaded = await fixtureCall(ctx, "POST", "/api/operator/diagnostics", {
      kernelId: CANARY.kernelId,
      encrypted: {
        ciphertext_b64: ciphertext.toString("base64"),
        iv_b64: iv.toString("base64"),
        salt_b64: salt.toString("base64"),
        tag_b64: tag.toString("base64"),
      },
      bundleHash: "sha256:dynfix", bundleSize: ciphertext.length, logLineCount: 1,
      systemPlatform: "n68-dynfix", collectedAt: new Date().toISOString(),
    });
    const uploadId = String(uploaded.json.uploadId ?? "");
    if (!uploadId) return { status: -3, body: "dynamic fixture setup failed: no diagnostic uploadId" };
    const r = await fixtureCall(ctx, "POST", "/api/operator/diagnostics/decrypt", { uploadId, retrievalCode });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── operator/support/:threadId/reply: ownership check only blocks a MISMATCHED non-admin
  // caller (support-messages.ts); creating and replying as the SAME pass's identity self-
  // satisfies it (or dev-mode treats an unauthenticated anonymous caller as neither admin
  // nor a mismatch — the route's own `!isAdmin && callerId && ...` guard short-circuits false
  // when callerId is falsy). ──────────────────────────────────────────────────────────────
  "/api/operator/support/:threadId/reply": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/operator/support", { kernelId: CANARY.kernelId, message: "N68 dynamic fixture support message" });
    const threadId = String(
      created.json.threadId ?? (created.json.thread as Record<string, unknown> | undefined)?.id ?? "",
    );
    if (!threadId) return { status: -3, body: "dynamic fixture setup failed: no support threadId" };
    const r = await fixtureCall(ctx, "POST", `/api/operator/support/${encodeURIComponent(threadId)}/reply`, { message: "N68 dynamic fixture reply" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── ot2/scope/:id/revoke + ot2/tool-result: no ownership gate on revoke (ot2-scope.ts);
  // tool-result is pure callId lookup (ot2-relay.ts) — /api/ot2/tool-call (already fixture'd,
  // "ot2_health" is a SAFE_TOOLS member so no scope is required) mints the real callId. ──────
  "/api/ot2/scope/:id/revoke": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/ot2/scope", { kernelId: CANARY.kernelId, createdBy: "n68-dynfix-agent", allowedTools: ["ot2_health"] });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no ot2 scope id" };
    const r = await fixtureCall(ctx, "POST", `/api/ot2/scope/${encodeURIComponent(id)}/revoke`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/ot2/tool-result": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/ot2/tool-call", { kernelId: CANARY.kernelId, toolName: "ot2_health" });
    const callId = String(created.json.id ?? "");
    if (!callId) return { status: -3, body: "dynamic fixture setup failed: no ot2 tool-call id" };
    const r = await fixtureCall(ctx, "POST", "/api/ot2/tool-result", { callId, result: { ok: true } });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── relay/:kernelId/scope + scope/:scopeId/revoke (#533 merge-up with master): POST scope
  // is "kernel_operator"-only (device-relay.ts:230) — CANARY.kernelId is owned by this file's
  // OWNER identity, not the stranger pass, so relayAccessGuard (device-relay.ts:318-346) now
  // 403s scope creation there regardless of the "createdBy" body field (that field only names
  // who the scope belongs to AFTER creation; creating one at all still requires being the
  // kernel's operator). createOwnRelayKernel() (defined above) registers a fresh kernel as
  // the CURRENT pass's own identity instead. ownsScope() (device-relay.ts:283-289) allows the
  // scope's own creator OR the kernel operator; createdBy is left unset so it defaults to the
  // caller's own principal (device-relay.ts:1401), which is also this fresh kernel's operator
  // either way. ──────────────────────────────────────────────────────────────────────────────
  "/api/relay/:kernelId/scope": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/scope`, {
      allowedTools: ["move_to"],
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/relay/:kernelId/scope/:scopeId/revoke": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const created = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/scope`, {
      allowedTools: ["move_to"],
    });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no device-relay scope id" };
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/scope/${encodeURIComponent(id)}/revoke`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── templates/capabilities/:id/{fork,publish,rate}: fork/rate have no gate at all; publish
  // only blocks a MISMATCHED authorId — a fresh create (authorId = this pass's own operatorId,
  // or null for anonymous) immediately followed by publish as the SAME caller never mismatches
  // (templates.ts). ──────────────────────────────────────────────────────────────────────────
  "/api/templates/capabilities/:id/fork": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/templates/capabilities", { capabilityType: "3d-printing", name: "N68 dynamic fixture template fork-src" });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no template id" };
    const r = await fixtureCall(ctx, "POST", `/api/templates/capabilities/${encodeURIComponent(id)}/fork`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/templates/capabilities/:id/publish": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/templates/capabilities", { capabilityType: "3d-printing", name: "N68 dynamic fixture template publish-src" });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no template id" };
    const r = await fixtureCall(ctx, "POST", `/api/templates/capabilities/${encodeURIComponent(id)}/publish`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/templates/capabilities/:id/rate": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/templates/capabilities", { capabilityType: "3d-printing", name: "N68 dynamic fixture template rate-src" });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no template id" };
    const r = await fixtureCall(ctx, "POST", `/api/templates/capabilities/${encodeURIComponent(id)}/rate`, { score: 5, comment: "N68 dynamic fixture rating" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── courier-jobs/:id/{claim,events}: fully public (courier-jobs.ts); heartbeat requires
  // the SAME poster identity at both create and heartbeat — x-posted-by makes this work even
  // on the anonymous pass (resolvePoster falls back to that header when no key is present). ──
  "/api/courier-jobs/:id/claim": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/courier-jobs", { deliveryId: `n68-dynfix-del-claim-${ctx.ip()}`, pickup: { address: "123 Test St" }, dropoff: { address: "456 Test Ave" } });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no courier job id" };
    const r = await fixtureCall(ctx, "POST", `/api/courier-jobs/${encodeURIComponent(id)}/claim`, { driverAgent: "n68-dynfix-driver" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/courier-jobs/:id/heartbeat": (async (ctx: FixtureCtx) => {
    const poster = "n68-dynfix-poster";
    const created = await fixtureCall(ctx, "POST", "/api/courier-jobs", { deliveryId: `n68-dynfix-del-hb-${ctx.ip()}`, pickup: { address: "123 Test St" }, dropoff: { address: "456 Test Ave" } }, { "x-posted-by": poster });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no courier job id" };
    const r = await fixtureCall(ctx, "POST", `/api/courier-jobs/${encodeURIComponent(id)}/heartbeat`, {}, { "x-posted-by": poster });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/courier-jobs/:id/events": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/courier-jobs", { deliveryId: `n68-dynfix-del-ev-${ctx.ip()}`, pickup: { address: "123 Test St" }, dropoff: { address: "456 Test Ave" } });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no courier job id" };
    const r = await fixtureCall(ctx, "POST", `/api/courier-jobs/${encodeURIComponent(id)}/events`, { event: "note", note: "N68 dynamic fixture event" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── job-offers/:id/{claim,events}: fully public (job-offers.ts); heartbeat same
  // same-poster-identity technique as courier-jobs above. ─────────────────────────────────
  "/api/job-offers/:id/claim": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/job-offers", { capabilityType: "3d-printing", requirements: { material: "PLA" }, pricing: { amount: 10, currency: "USDC", model: "fixed" } });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no job-offer id" };
    const r = await fixtureCall(ctx, "POST", `/api/job-offers/${encodeURIComponent(id)}/claim`, { kernelId: CANARY.kernelId });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/job-offers/:id/heartbeat": (async (ctx: FixtureCtx) => {
    const poster = "n68-dynfix-poster";
    const created = await fixtureCall(ctx, "POST", "/api/job-offers", { capabilityType: "3d-printing", requirements: { material: "PLA" }, pricing: { amount: 10, currency: "USDC", model: "fixed" } }, { "x-posted-by": poster });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no job-offer id" };
    const r = await fixtureCall(ctx, "POST", `/api/job-offers/${encodeURIComponent(id)}/heartbeat`, {}, { "x-posted-by": poster });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/job-offers/:id/events": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/job-offers", { capabilityType: "3d-printing", requirements: { material: "PLA" }, pricing: { amount: 10, currency: "USDC", model: "fixed" } });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no job-offer id" };
    const r = await fixtureCall(ctx, "POST", `/api/job-offers/${encodeURIComponent(id)}/events`, { event: "acknowledged" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── requests/:id/{decompose,publish} + requests/:id/nodes/:nodeId/assign: /api/requests
  // (already fixture'd AND confirmed reachable) mints a real request id; decompose/publish
  // have no ownership gate; assign needs an authenticated caller (anonymous 401s there, which
  // is fine — the keyed pass still reaches 2xx). ─────────────────────────────────────────────
  "/api/requests/:id/decompose": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/requests", { title: "N68 dynamic fixture request decompose", description: "N68 dynamic fixture", capabilityType: "3d-printing", kernelId: CANARY.kernelId });
    const reqObj = (created.json.request as Record<string, unknown> | undefined) ?? created.json;
    const id = String(reqObj.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no request id" };
    const r = await fixtureCall(ctx, "POST", `/api/requests/${encodeURIComponent(id)}/decompose`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/requests/:id/nodes/:nodeId/assign": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/requests", { title: "N68 dynamic fixture request assign", description: "N68 dynamic fixture", capabilityType: "3d-printing", kernelId: CANARY.kernelId });
    const reqObj = (created.json.request as Record<string, unknown> | undefined) ?? created.json;
    const id = String(reqObj.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no request id" };
    const decomposed = await fixtureCall(ctx, "POST", `/api/requests/${encodeURIComponent(id)}/decompose`, {});
    const decReq = (decomposed.json.request as Record<string, unknown> | undefined) ?? {};
    const dag = (decReq.capabilityDag as Array<Record<string, unknown>> | undefined) ?? [];
    const nodeId = String(dag[0]?.id ?? "");
    if (!nodeId) return { status: -3, body: "dynamic fixture setup failed: no DAG node id" };
    const r = await fixtureCall(ctx, "POST", `/api/requests/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}/assign`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/requests/:id/publish": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/requests", { title: "N68 dynamic fixture request publish", description: "N68 dynamic fixture", capabilityType: "3d-printing", kernelId: CANARY.kernelId });
    const reqObj = (created.json.request as Record<string, unknown> | undefined) ?? created.json;
    const id = String(reqObj.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no request id" };
    await fixtureCall(ctx, "POST", `/api/requests/${encodeURIComponent(id)}/decompose`, {});
    const r = await fixtureCall(ctx, "POST", `/api/requests/${encodeURIComponent(id)}/publish`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── skills/:id/hire + skills/jobs/:jobId/{accept,start,complete}: skills.ts has NO real
  // auth — accept's "ownership" is just matching the SAME humanDid string this fixture itself
  // chose at registration. Each builds its own skill+job to avoid cross-pass state coupling. ─
  "/api/skills/:id/hire": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/skills/register", {
      humanDid: `did:example:n68-dynfix-hire-${ctx.ip()}`, name: "N68 Dynamic Fixture Handyperson",
      description: "test", skillType: "handyperson", hourlyRateUSD: 25,
      location: { lat: 47.0, lng: -122.0 }, weeklyAvailableHours: 10,
    });
    const id = String(created.json.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no skill id" };
    const r = await fixtureCall(ctx, "POST", `/api/skills/${encodeURIComponent(id)}/hire`, {
      posterDid: "did:example:n68-dynfix-poster", description: "N68 dynamic fixture job",
      budgetUSD: 100, expectedDurationHours: 1, location: { lat: 47.0, lng: -122.0 },
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/skills/jobs/:jobId/accept": (async (ctx: FixtureCtx) => {
    const did = `did:example:n68-dynfix-accept-${ctx.ip()}`;
    const created = await fixtureCall(ctx, "POST", "/api/skills/register", {
      humanDid: did, name: "N68 Dynamic Fixture Handyperson", description: "test", skillType: "handyperson",
      hourlyRateUSD: 25, location: { lat: 47.0, lng: -122.0 }, weeklyAvailableHours: 10,
    });
    const skillId = String(created.json.id ?? "");
    if (!skillId) return { status: -3, body: "dynamic fixture setup failed: no skill id" };
    const hired = await fixtureCall(ctx, "POST", `/api/skills/${encodeURIComponent(skillId)}/hire`, {
      posterDid: "did:example:n68-dynfix-poster", description: "N68 dynamic fixture job",
      budgetUSD: 100, expectedDurationHours: 1, location: { lat: 47.0, lng: -122.0 },
    });
    const jobId = String(hired.json.jobId ?? "");
    if (!jobId) return { status: -3, body: "dynamic fixture setup failed: no skill job id" };
    const r = await fixtureCall(ctx, "POST", `/api/skills/jobs/${encodeURIComponent(jobId)}/accept`, { humanDid: did });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/skills/jobs/:jobId/start": (async (ctx: FixtureCtx) => {
    const did = `did:example:n68-dynfix-start-${ctx.ip()}`;
    const created = await fixtureCall(ctx, "POST", "/api/skills/register", {
      humanDid: did, name: "N68 Dynamic Fixture Handyperson", description: "test", skillType: "handyperson",
      hourlyRateUSD: 25, location: { lat: 47.0, lng: -122.0 }, weeklyAvailableHours: 10,
    });
    const skillId = String(created.json.id ?? "");
    if (!skillId) return { status: -3, body: "dynamic fixture setup failed: no skill id" };
    const hired = await fixtureCall(ctx, "POST", `/api/skills/${encodeURIComponent(skillId)}/hire`, {
      posterDid: "did:example:n68-dynfix-poster", description: "N68 dynamic fixture job",
      budgetUSD: 100, expectedDurationHours: 1, location: { lat: 47.0, lng: -122.0 },
    });
    const jobId = String(hired.json.jobId ?? "");
    if (!jobId) return { status: -3, body: "dynamic fixture setup failed: no skill job id" };
    await fixtureCall(ctx, "POST", `/api/skills/jobs/${encodeURIComponent(jobId)}/accept`, { humanDid: did });
    const r = await fixtureCall(ctx, "POST", `/api/skills/jobs/${encodeURIComponent(jobId)}/start`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/skills/jobs/:jobId/complete": (async (ctx: FixtureCtx) => {
    const did = `did:example:n68-dynfix-complete-${ctx.ip()}`;
    const created = await fixtureCall(ctx, "POST", "/api/skills/register", {
      humanDid: did, name: "N68 Dynamic Fixture Handyperson", description: "test", skillType: "handyperson",
      hourlyRateUSD: 25, location: { lat: 47.0, lng: -122.0 }, weeklyAvailableHours: 10,
    });
    const skillId = String(created.json.id ?? "");
    if (!skillId) return { status: -3, body: "dynamic fixture setup failed: no skill id" };
    const hired = await fixtureCall(ctx, "POST", `/api/skills/${encodeURIComponent(skillId)}/hire`, {
      posterDid: "did:example:n68-dynfix-poster", description: "N68 dynamic fixture job",
      budgetUSD: 100, expectedDurationHours: 1, location: { lat: 47.0, lng: -122.0 },
    });
    const jobId = String(hired.json.jobId ?? "");
    if (!jobId) return { status: -3, body: "dynamic fixture setup failed: no skill job id" };
    await fixtureCall(ctx, "POST", `/api/skills/jobs/${encodeURIComponent(jobId)}/accept`, { humanDid: did });
    await fixtureCall(ctx, "POST", `/api/skills/jobs/${encodeURIComponent(jobId)}/start`, {});
    const r = await fixtureCall(ctx, "POST", `/api/skills/jobs/${encodeURIComponent(jobId)}/complete`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── negotiate/session/:id/{quote,review}: no ownership gate found in negotiation.ts;
  // review requires quote to have run first on the same session. ─────────────────────────
  "/api/negotiate/session/:id/quote": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/negotiate/session", { userAgentId: "n68-dynfix-agent", kernelId: CANARY.kernelId, capabilityType: "3d-printing" });
    const sess = (created.json.session as Record<string, unknown> | undefined) ?? created.json;
    const id = String(sess.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no negotiation session id" };
    const r = await fixtureCall(ctx, "POST", `/api/negotiate/session/${encodeURIComponent(id)}/quote`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/negotiate/session/:id/review": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/negotiate/session", { userAgentId: "n68-dynfix-agent-2", kernelId: CANARY.kernelId, capabilityType: "3d-printing" });
    const sess = (created.json.session as Record<string, unknown> | undefined) ?? created.json;
    const id = String(sess.id ?? "");
    if (!id) return { status: -3, body: "dynamic fixture setup failed: no negotiation session id" };
    await fixtureCall(ctx, "POST", `/api/negotiate/session/${encodeURIComponent(id)}/quote`, {});
    const r = await fixtureCall(ctx, "POST", `/api/negotiate/session/${encodeURIComponent(id)}/review`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── contributors/schedules/:scheduleHash/evaluate: the CURRENT reason was a pure param-
  // shape issue (scheduleHash filled with kernelId/capId/operatorId never matches the
  // required 0x+64hex regex) — /api/contributors/schedules (already fixture'd) returns the
  // REAL recomputed hash in its response; chain that in instead of the generic id filler. ────
  "/api/contributors/schedules/:scheduleHash/evaluate": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/contributors/schedules", {
      publishedBy: "0xabcd1234abcd1234abcd1234abcd1234abcd1234",
      schedule: { version: 1, segments: [{ kind: "constant", startTime: 1700000000, endTime: null, bps: 150 }] },
    });
    const scheduleHash = String(created.json.scheduleHash ?? "");
    if (!scheduleHash) return { status: -3, body: "dynamic fixture setup failed: no scheduleHash" };
    const r = await fixtureCall(ctx, "POST", `/api/contributors/schedules/${encodeURIComponent(scheduleHash)}/evaluate`, {
      now: 1700000500, jobValueCents: 500, jobsPerDay: 1,
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // round 3 (cross-family review of #533, the one OPEN MEDIUM): every entry below replaces a
  // round-2 NOT_REACHED reason that deferred the actual re-check ("not chased", "not
  // attempted", "not independently re-verified", ...) or — for /api/capture/challenge — stated
  // a blocker that was already false (the fake chain client was installed, just not used by
  // this route's own reason). Each was decided by reading the route AND its prerequisites,
  // same standard as every other dynamic fixture in this file.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  // ── capture/challenge: getChainClient() (capture.ts:223-237) already returns the fake chain
  // client installed in beforeAll (setCaptureChainClientForTests) — no real RPC call on this
  // path at all. getChallengeService() (verifier-factory.ts:115-120) builds a REAL
  // ChallengeService, but it's a pure in-memory nonce issuer; the only network-shaped call
  // (chain.getLatestBlock()) is already satisfied by the fake. requireAuth passes with any
  // key. capture.ts:437-450. ─────────────────────────────────────────────────────────────────
  "/api/capture/challenge": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/capture/challenge", {
      jobId: "n68-dynfix-capture-job", declaredClass: "CC0",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── compose/:id/execute: executeComposition()'s effective step runner (compose.ts:722-739)
  // is binding.runStep (none passed by this route) → PCC_COMPOSE_EXECUTE_REAL==="true" (unset
  // here) → the MODULE-LEVEL DEFAULT, which is NOOP_RUNNER (compose.ts:617,625: "the scaffold
  // assumes every step succeeds" — a pure Promise.resolve(), no job submission, no money, no
  // network) UNLESS a test or PCC_COMPOSE_EXECUTE_REAL explicitly rebinds it, which this sweep
  // never does. /api/compose alone isn't enough to reach a "proposed" composition though — by
  // default it draws candidates from an in-memory pool that starts EMPTY (production uses
  // PCC_COMPOSE_USE_FACADE=true, unset here), so an outcomeType with no registered candidate
  // returns status "no_path_found" (confirmed empirically) and :id/execute then 409s
  // "not_executable". /api/compose/_dev/register-candidate (already fixture'd for its own url)
  // seeds a matching candidate for a FRESH capabilityType first. ──────────────────────────────
  "/api/compose/:id/execute": (async (ctx: FixtureCtx) => {
    const capType = `n68-dynfix-compose-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", "/api/compose/_dev/register-candidate", {
      capabilityId: `cap-n68-dynfix-compose-${ctx.ip()}`, kernelId: CANARY.kernelId,
      operatorAddress: "0xn68dynfixcompose", capabilityType: capType,
      estimatedPriceUSD: 10, estimatedDurationMs: 60000, assuranceTier: 0,
    });
    const created = await fixtureCall(ctx, "POST", "/api/compose", {
      outcomeType: capType, budgetUSD: 100, minAssuranceTier: 0,
    });
    const compositionId = String(created.json.compositionId ?? "");
    if (!compositionId) return { status: -3, body: "dynamic fixture setup failed: no compositionId" };
    const r = await fixtureCall(ctx, "POST", `/api/compose/${encodeURIComponent(compositionId)}/execute`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── compositions/:compositionId/disputes: recordStepOutcome() (reputation.ts:593) does NOT
  // validate that compositionId matches a real /api/compose row — it inserts a step-outcome
  // keyed by WHATEVER compositionId string the caller supplies (reputation.ts:577-603). A
  // self-chosen fresh id removes any dependency on the (separately fixture'd, fake-id) step-
  // outcome entry above: create our OWN step-outcome, then dispute that exact step. ──────────
  "/api/compositions/:compositionId/disputes": (async (ctx: FixtureCtx) => {
    const compositionId = `n68-dynfix-comp-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", `/api/compositions/${encodeURIComponent(compositionId)}/step-outcome`, {
      compositionId, stepIndex: 0, capabilityId: "cap-n68-dynfix", agentId: "n68-dynfix-agent",
      status: "success", startedAt: new Date().toISOString(),
    });
    const r = await fixtureCall(ctx, "POST", `/api/compositions/${encodeURIComponent(compositionId)}/disputes`, {
      disputerId: "n68-dynfix-disputer", stepIndex: 0, reason: "timeout",
      description: "N68 dynamic fixture dispute",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── kernels/:kernelId/verify: isAdminAuthorized()'s dev-mode bypass (no PCC_ADMIN_KEY, NODE_
  // ENV!==production, both true here) clears auth; runSmokeTest() (kernel-marketplace.ts:211-
  // 220) now resolves through _setSmokeTestFetch's fake {ok:true} response installed in
  // beforeAll — no real fetch to manifest.endpointURL on this path at all. ───────────────────
  "/api/kernels/:kernelId/verify": (async (ctx: FixtureCtx) => {
    const kernelId = `n68-dynfix-kernel-verify-${ctx.ip()}-${Date.now()}`;
    await fixtureCall(ctx, "POST", "/api/kernels/register", {
      manifestVersion: "1.0.0", kernelId, name: "N68 dynamic fixture kernel", description: "test",
      builder: { agentId: "n68-dynfix-builder" }, capabilityType: "3d-printing",
      workflowSteps: [{ step: "print" }], pricing: { currency: "USDC", baseUSD: 1 },
      maxAssuranceTier: 1, endpointURL: "https://example.invalid/webhook",
      sessionKeyPolicy: { maxTTLSeconds: 3600, allowedActions: ["evidence_submit"] },
    });
    const r = await fixtureCall(ctx, "POST", `/api/kernels/${encodeURIComponent(kernelId)}/verify`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── operators/:id/rate: repos.registrations.findById(operatorId) (operators-public.ts:171)
  // needs a real onboard-registrations row — /api/onboard/register (onboard.ts:62-98) takes
  // ANY body (every field optional, defaulted) and always 200s with a real `reg-<ts>` id. The
  // buyer-identity check only requires SOME authenticated identity (any truthy operatorId/
  // apiKeyId/userId/walletAddress); the TODO at operators-public.ts:196-200 confirms no real
  // buyer-of-jobId check exists yet, so a self-chosen jobId is fine. ──────────────────────────
  "/api/operators/:id/rate": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/onboard/register", {
      name: "N68 Dynamic Fixture Machine", category: "custom",
    });
    const regId = String((created.json.registration as Record<string, unknown> | undefined)?.id ?? "");
    if (!regId) return { status: -3, body: "dynamic fixture setup failed: no registration id" };
    const r = await fixtureCall(ctx, "POST", `/api/operators/${encodeURIComponent(regId)}/rate`, {
      rating: 5, jobId: "n68-dynfix-job", comment: "N68 dynamic fixture rating",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── print-and-mail/:jobId/handoff: print-and-mail.ts's own doc comment (print-and-mail.ts:
  // 1-20) says this route "READS the claim state the courier-jobs store ALREADY holds" — the
  // SAME getCourierJobsStore() the /api/courier-jobs/:id/claim dynamic fixture above already
  // uses (round-2's reason calling this "a SEPARATE store" was simply wrong, not just
  // deferred). getCarrierBridge() is unwired by default (print-and-mail.ts:172-188), so the
  // commitment-match branch is skipped entirely — any commitmentHash/trackingCode is accepted
  // as caller-attested. Chain: create the courier job, claim it as the SAME driverAgent, then
  // hand off as that driver. ──────────────────────────────────────────────────────────────────
  "/api/print-and-mail/:jobId/handoff": (async (ctx: FixtureCtx) => {
    const driverAgent = "n68-dynfix-driver";
    const created = await fixtureCall(ctx, "POST", "/api/courier-jobs", {
      deliveryId: `n68-dynfix-del-handoff-${ctx.ip()}`, pickup: { address: "123 Test St" }, dropoff: { address: "456 Test Ave" },
    });
    const jobId = String(created.json.id ?? "");
    if (!jobId) return { status: -3, body: "dynamic fixture setup failed: no courier job id" };
    const claimed = await fixtureCall(ctx, "POST", `/api/courier-jobs/${encodeURIComponent(jobId)}/claim`, { driverAgent });
    if (claimed.status < 200 || claimed.status >= 300) return { status: claimed.status, body: claimed.body };
    const r = await fixtureCall(ctx, "POST", `/api/print-and-mail/${encodeURIComponent(jobId)}/handoff`, {
      driverAgent, kernelId: CANARY.kernelId, commitmentHash: "sha256:n68dynfix", trackingCode: "N68DYNFIXTRACK",
      printJobId: "n68-dynfix-printjob", photo: { imageHash: "sha256:n68dynfixphoto", capturedAt: new Date().toISOString() },
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── relay/:kernelId/tool-call + tool-call/:callId/start (#533 merge-up with master):
  // relayAccessGuard (device-relay.ts:318-346) now default-denies every relay route to a
  // caller who is neither the kernel's recorded operator nor an active scope holder.
  // CANARY.kernelId (owned by this file's OWNER identity) used to work for tool-call alone —
  // pre-#400 the only gate was per-tool safety — but no longer does for the stranger pass.
  // createOwnRelayKernel() (defined above) is the fix: register a FRESH kernel as the CURRENT
  // pass's own identity, so isKernelOperator(kernelId, principal) is true for it and the guard
  // admits every access level (device-relay.ts:334-336 checks isKernelOperator before ever
  // branching on the route's listed access level). resolveDeviceType() (device-relay.ts:
  // 158-176) falls back to "generic" for this device-less kernel, and generic.tools.json's
  // safeTools list (packages/spec/src/tool-manifests/generic.tools.json) includes "health",
  // so isToolSafe("generic","health") is true and POST tool-call needs no scopeId at all
  // (device-relay.ts:637-644) once the caller is the kernel's own operator.
  // tool-call/:callId/start is NEW on master (N4b-gw r7/r8, the execution lease, F3): the
  // executor must claim the call via GET pending with X-PCC-Lease: 1 (RELAY_LEASE_ENFORCE
  // defaults to requiring one, device-relay.ts:120-124,893-896) before it may start it. Access
  // is "kernel_operator" for both the poll and the start (device-relay.ts:226-227) — the same
  // fresh kernel qualifies for both. tool-result (below, unchanged) already used this exact
  // own-kernel pattern before #400 landed, so it needs no fix. ─────────────────────────────
  "/api/relay/:kernelId/tool-call": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/tool-call`, {
      toolName: "health",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/relay/:kernelId/tool-call/:callId/start": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const created = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/tool-call`, {
      toolName: "health",
    });
    const callId = String(created.json.id ?? "");
    if (!callId) {
      return { status: -3, body: `dynamic fixture setup failed: no relay tool-call id (status=${created.status})` };
    }
    const pending = await fixtureCall(ctx, "GET", `/api/relay/${encodeURIComponent(kernelId)}/tool-call/pending`, undefined, {
      "x-pcc-lease": "1",
    });
    const calls = (pending.json.calls as Array<Record<string, unknown>> | undefined) ?? [];
    const claimToken = String(calls.find((c) => c.id === callId)?.claimToken ?? "");
    if (!claimToken) {
      return {
        status: -3,
        body: `dynamic fixture setup failed: no claim token (pending status=${pending.status}, body=${pending.body.slice(0, 200)})`,
      };
    }
    const r = await fixtureCall(
      ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/tool-call/${encodeURIComponent(callId)}/start`,
      { claimToken },
    );
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  // ── camera/frame + chat + chat/respond (#533 merge-up with master): camera/frame and
  // chat/respond are "kernel_operator"-only (device-relay.ts:234,241); chat itself is
  // "operator_or_grant" (device-relay.ts:238), which the operator check also satisfies
  // (device-relay.ts:334-336). Same fresh-kernel pattern as tool-call above — these three were
  // STATIC entries in FIXTURE_POST_BODIES before #400 (removed above), reached only because a
  // generic path-param fill happened to be irrelevant when the only gate was per-tool safety. ──
  "/api/relay/:kernelId/camera/frame": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/camera/frame`, {
      frame: "dGVzdA==",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/relay/:kernelId/chat": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/chat`, {
      message: "test message",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/relay/:kernelId/chat/respond": (async (ctx: FixtureCtx) => {
    const kernelId = await createOwnRelayKernel(ctx);
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/chat/respond`, {
      response: "test response",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/relay/:kernelId/tool-result": (async (ctx: FixtureCtx) => {
    const kernelId = `n68-dynfix-relay-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", "/api/kernels", {
      id: kernelId, name: "N68 dynamic fixture relay kernel", maxAssuranceTier: 1,
    });
    const created = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/tool-call`, {
      toolName: "health",
    });
    const callId = String(created.json.id ?? "");
    if (!callId) return { status: -3, body: "dynamic fixture setup failed: no relay tool-call id" };
    const r = await fixtureCall(ctx, "POST", `/api/relay/${encodeURIComponent(kernelId)}/tool-result`, {
      callId, result: { ok: true },
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // round 4 (cross-family review of #533, the SAME MEDIUM still open): round 3's own
  // deferring-language guard had a blind spot — "too complex to confidently craft" doesn't
  // contain any of its trigger phrases — and the round-3 rating fixture (above) already
  // proved /api/onboard/register populates a real registration, directly contradicting the
  // round-2 reasons on the sibling registrations/:id/* routes below. Every entry here was
  // re-read fresh this round, NOT trusted from a prior reason.
  // ═══════════════════════════════════════════════════════════════════════════════════════

  // ── capture/upload: the route returns 200 for ANY verdict (PASS or FAIL) the verifier
  // produces — it never branches on result.verdict (capture.ts:649-660). CaptureManifestSchema
  // (spec/types/capture.ts:656-668) requires only {class, declaredAt, deviceFingerprint,
  // mediaHash} — every other field (webAuthnAssertion, c2paManifest, sensorFusion, ...) is
  // OPTIONAL. "Too complex to confidently craft a PASSING manifest" was true but irrelevant:
  // this route doesn't need a passing one. mediaHash must equal sha256(captureBytes), computed
  // locally. requireAuth passes with any key. ─────────────────────────────────────────────────
  "/api/capture/upload": (async (ctx: FixtureCtx) => {
    const bytes = Buffer.from(`N68 dynamic fixture capture bytes ${ctx.ip()}`, "utf8");
    const mediaHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const r = await fixtureCall(ctx, "POST", "/api/capture/upload", {
      manifest: {
        class: "CC0",
        declaredAt: new Date().toISOString(),
        deviceFingerprint: "n68-dynfix-device",
        mediaHash,
      },
      captureBytesBase64: bytes.toString("base64"),
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── onboard/registrations/:id/{approve,reject,activate}: no admin-key or ownership check
  // at all on approve/reject (onboard.ts:174-217) — a fresh registration is status "submitted"
  // (onboard.ts:95), which both accept. activate needs status "approved" first
  // (onboard.ts:334-336), so its fixture chains register -> approve -> activate. ─────────────
  "/api/onboard/registrations/:id/approve": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/onboard/register", {
      name: "N68 dynamic fixture machine (approve)", category: "custom",
    });
    const regId = String((created.json.registration as Record<string, unknown> | undefined)?.id ?? "");
    if (!regId) return { status: -3, body: "dynamic fixture setup failed: no registration id" };
    const r = await fixtureCall(ctx, "POST", `/api/onboard/registrations/${encodeURIComponent(regId)}/approve`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/onboard/registrations/:id/reject": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/onboard/register", {
      name: "N68 dynamic fixture machine (reject)", category: "custom",
    });
    const regId = String((created.json.registration as Record<string, unknown> | undefined)?.id ?? "");
    if (!regId) return { status: -3, body: "dynamic fixture setup failed: no registration id" };
    const r = await fixtureCall(ctx, "POST", `/api/onboard/registrations/${encodeURIComponent(regId)}/reject`, {
      reason: "N68 dynamic fixture reject",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/onboard/registrations/:id/activate": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/onboard/register", {
      name: "N68 dynamic fixture machine (activate)", category: "custom",
    });
    const regId = String((created.json.registration as Record<string, unknown> | undefined)?.id ?? "");
    if (!regId) return { status: -3, body: "dynamic fixture setup failed: no registration id" };
    await fixtureCall(ctx, "POST", `/api/onboard/registrations/${encodeURIComponent(regId)}/approve`, {});
    const r = await fixtureCall(ctx, "POST", `/api/onboard/registrations/${encodeURIComponent(regId)}/activate`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── onboard/registrations/:id/prove: ownership check only fires when BOTH callerId AND
  // regOperator are truthy and differ (onboard.ts:354-361) — GET /api/auth/validate resolves
  // the CURRENT pass's own operatorId, which we stuff into operator.walletAddress at
  // registration time, so the two always match for whichever pass has a key. ─────────────────
  "/api/onboard/registrations/:id/prove": (async (ctx: FixtureCtx) => {
    const validated = await fixtureCall(ctx, "GET", "/api/auth/validate");
    const myOperatorId = String(validated.json.operatorId ?? "");
    const created = await fixtureCall(ctx, "POST", "/api/onboard/register", {
      name: "N68 dynamic fixture machine (prove)", category: "custom",
      operator: { walletAddress: myOperatorId, displayName: "N68 dynamic fixture" },
    });
    const regId = String((created.json.registration as Record<string, unknown> | undefined)?.id ?? "");
    if (!regId) return { status: -3, body: "dynamic fixture setup failed: no registration id" };
    const r = await fixtureCall(ctx, "POST", `/api/onboard/registrations/${encodeURIComponent(regId)}/prove`, {
      evidence: { deviceHealth: { status: "idle", model: "N68 dynamic fixture", firmware: "1.0.0" } },
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── onboard/:id/{ingest-docs,scrape} + orchestrator/data-product/:id/{build-agent,ingest-docs,scrape}:
  // template-session.ts registers these sub-routes at BOTH the "/api/onboard" prefix
  // (server.ts:803-808) and the "/api/orchestrator/data-product" prefix (server.ts:809-813).
  // <prefix>/start (template-session.ts:251-273) needs only {name: "..."}, no auth shown, and
  // mints a real session via randomUUID(); scrape/ingest-docs then only require that session to
  // exist (template-session.ts:317,378) — no further state, and both degrade gracefully (still
  // 200) even if their hook throws. /api/onboard/:id/build-agent is DIFFERENT: its "onboard"
  // template agent's onBuild hook (template-agents.ts:149-166) calls publishOperator(), which
  // makes a real outbound fetch (confirmed below) — so it is excluded here and left in
  // NOT_REACHED with category "external_service". The sibling
  // /api/orchestrator/data-product/:id/build-agent uses the data-product template's explicit
  // stub onBuild (template-agents.ts:238-248, "minimal stub" per its own doc comment) which does
  // no network I/O, so that one DOES reach 2xx via the dynamic fixture below. ─────────────────
  "/api/onboard/:id/ingest-docs": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/onboard/start", { name: "N68 Dynamic Fixture Co" });
    const sessionId = String(created.json.session_id ?? "");
    if (!sessionId) return { status: -3, body: "dynamic fixture setup failed: no session_id" };
    const r = await fixtureCall(ctx, "POST", `/api/onboard/${encodeURIComponent(sessionId)}/ingest-docs`, {
      doc_urls: ["local://n68-dynfix-doc"],
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/onboard/:id/scrape": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/onboard/start", { name: "N68 Dynamic Fixture Co" });
    const sessionId = String(created.json.session_id ?? "");
    if (!sessionId) return { status: -3, body: "dynamic fixture setup failed: no session_id" };
    const r = await fixtureCall(ctx, "POST", `/api/onboard/${encodeURIComponent(sessionId)}/scrape`, {
      url: "https://n68-dynfix.example.invalid",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/orchestrator/data-product/:id/build-agent": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/orchestrator/data-product/start", { name: "N68 Dynamic Fixture Data Co" });
    const sessionId = String(created.json.session_id ?? "");
    if (!sessionId) return { status: -3, body: "dynamic fixture setup failed: no session_id" };
    const r = await fixtureCall(ctx, "POST", `/api/orchestrator/data-product/${encodeURIComponent(sessionId)}/build-agent`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/orchestrator/data-product/:id/ingest-docs": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/orchestrator/data-product/start", { name: "N68 Dynamic Fixture Data Co" });
    const sessionId = String(created.json.session_id ?? "");
    if (!sessionId) return { status: -3, body: "dynamic fixture setup failed: no session_id" };
    const r = await fixtureCall(ctx, "POST", `/api/orchestrator/data-product/${encodeURIComponent(sessionId)}/ingest-docs`, {
      doc_urls: ["local://n68-dynfix-doc"],
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/orchestrator/data-product/:id/scrape": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/orchestrator/data-product/start", { name: "N68 Dynamic Fixture Data Co" });
    const sessionId = String(created.json.session_id ?? "");
    if (!sessionId) return { status: -3, body: "dynamic fixture setup failed: no session_id" };
    const r = await fixtureCall(ctx, "POST", `/api/orchestrator/data-product/${encodeURIComponent(sessionId)}/scrape`, {
      url: "https://n68-dynfix.example.invalid",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── verification/:requestId/{respond,dispute}: /api/verification/submit is fully public,
  // no auth, and mints a real hvreq_ id plus real assignedVerifiers (human-verification.ts:
  // 75-135). respond needs the verifierId to be one of THOSE assigned verifiers (human-
  // verification.ts:300-304) — grabbed straight from submit's own response. dispute needs the
  // disputer to have ALREADY responded (human-verification.ts:388-393), so its fixture chains
  // submit -> respond -> dispute with the SAME verifier id throughout. ────────────────────────
  "/api/verification/:requestId/respond": (async (ctx: FixtureCtx) => {
    const submitted = await fixtureCall(ctx, "POST", "/api/verification/submit", {
      bundleHash: "sha256:" + "0".repeat(64), photoRef: "n68-dynfix-photo", referenceRef: "n68-dynfix-ref",
    });
    const requestId = String(submitted.json.requestId ?? "");
    const verifiers = (submitted.json.assignedVerifiers as Array<Record<string, unknown>> | undefined) ?? [];
    const verifierId = String(verifiers[0]?.id ?? "");
    if (!requestId || !verifierId) return { status: -3, body: "dynamic fixture setup failed: no requestId/verifierId" };
    const r = await fixtureCall(ctx, "POST", `/api/verification/${encodeURIComponent(requestId)}/respond`, {
      verifierId, verdict: "match", signature: "0xn68dynfix",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/verification/:requestId/dispute": (async (ctx: FixtureCtx) => {
    const submitted = await fixtureCall(ctx, "POST", "/api/verification/submit", {
      bundleHash: "sha256:" + "1".repeat(64), photoRef: "n68-dynfix-photo-2", referenceRef: "n68-dynfix-ref-2",
    });
    const requestId = String(submitted.json.requestId ?? "");
    const verifiers = (submitted.json.assignedVerifiers as Array<Record<string, unknown>> | undefined) ?? [];
    const verifierId = String(verifiers[0]?.id ?? "");
    if (!requestId || !verifierId) return { status: -3, body: "dynamic fixture setup failed: no requestId/verifierId" };
    await fixtureCall(ctx, "POST", `/api/verification/${encodeURIComponent(requestId)}/respond`, {
      verifierId, verdict: "no_match", signature: "0xn68dynfix",
    });
    const r = await fixtureCall(ctx, "POST", `/api/verification/${encodeURIComponent(requestId)}/dispute`, {
      disputerId: verifierId, reason: "N68 dynamic fixture dispute", evidenceCid: "bafkn68dynfix",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── disputes/:disputeId/resolve: getDispute() (reputation.ts:688) reads the SAME in-memory
  // store /api/compositions/:compositionId/disputes (already dynamically fixture'd above)
  // writes to via saveDispute() — a fresh dispute is "pending" (reputation.ts:647), which
  // ResolveDisputeSchema + the status check both accept. ──────────────────────────────────────
  "/api/disputes/:disputeId/resolve": (async (ctx: FixtureCtx) => {
    const compositionId = `n68-dynfix-comp-resolve-${ctx.ip()}`;
    await fixtureCall(ctx, "POST", `/api/compositions/${encodeURIComponent(compositionId)}/step-outcome`, {
      compositionId, stepIndex: 0, capabilityId: "cap-n68-dynfix-resolve", agentId: "n68-dynfix-agent",
      status: "success", startedAt: new Date().toISOString(),
    });
    const disputed = await fixtureCall(ctx, "POST", `/api/compositions/${encodeURIComponent(compositionId)}/disputes`, {
      disputerId: "n68-dynfix-disputer-resolve", stepIndex: 0, reason: "timeout",
      description: "N68 dynamic fixture dispute for resolve",
    });
    const disputeId = String((disputed.json.dispute as Record<string, unknown> | undefined)?.disputeId ?? "");
    if (!disputeId) return { status: -3, body: "dynamic fixture setup failed: no disputeId" };
    const r = await fixtureCall(ctx, "POST", `/api/disputes/${encodeURIComponent(disputeId)}/resolve`, {
      resolverId: "n68-dynfix-resolver", decision: "rejected", resolutionNote: "N68 dynamic fixture resolution",
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── wizard/sessions/:id/complete: a session created by this pass's own key has no ownerId
  // bound by anything OTHER than the creator (isOwnerOrUnbound, wizard.ts:129-133) — same pass
  // throughout satisfies it trivially. All 5 platform-setup steps need `completed:true` first
  // (wizard.ts:271-300 for PUT .../steps/:step; wizard.ts:338+ for complete's own check) — any
  // truthy `data` object marks a step complete, so 5 PUT calls (steps 0..4) precede complete. ──
  "/api/wizard/sessions/:id/complete": (async (ctx: FixtureCtx) => {
    const created = await fixtureCall(ctx, "POST", "/api/wizard/sessions", { track: "platform-setup" });
    const sessionId = String((created.json.session as Record<string, unknown> | undefined)?.id ?? "");
    if (!sessionId) return { status: -3, body: "dynamic fixture setup failed: no wizard session id" };
    for (let step = 0; step < 5; step++) {
      await fixtureCall(ctx, "PUT", `/api/wizard/sessions/${encodeURIComponent(sessionId)}/steps/${step}`, {
        data: { ok: true },
      });
    }
    const r = await fixtureCall(ctx, "POST", `/api/wizard/sessions/${encodeURIComponent(sessionId)}/complete`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,

  // ── pizza-demo family: pizza-order + the 6 downstream order/job routes whose own prior
  // NOT_REACHED reasons said "pizza-order, itself blocked below, never populates this Map" —
  // see createPizzaOrderForFixture's doc comment above for why that blocker doesn't hold once
  // the graph-search dev-seed routes are used instead of compose's candidate pool. None of
  // confirm/cancel/accept/pickup/complete/reject check ownership (confirmed by reading every
  // handler, pizza-demo.ts:448-776 — pure state-machine gates on the looked-up order/job's OWN
  // `.status`), so each fixture below only needs to drive ITS OWN freshly-created order/job
  // through the preconditions its target route requires. ───────────────────────────────────
  "/api/demo/pizza-order": (async (ctx: FixtureCtx) => {
    const r = await createPizzaOrderForFixture(ctx);
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/demo/orders/:id/confirm": (async (ctx: FixtureCtx) => {
    const setup = await createPizzaOrderForFixture(ctx);
    if (!setup.orderId) return { status: -3, body: `dynamic fixture setup failed: ${setup.body}` };
    const r = await fixtureCall(ctx, "POST", `/api/demo/orders/${encodeURIComponent(setup.orderId)}/confirm`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/demo/orders/:id/cancel": (async (ctx: FixtureCtx) => {
    // cancel accepts status "proposed" OR "awaiting_shop" — a freshly-created order is already
    // "proposed", so no confirm step is needed first (pizza-demo.ts:488).
    const setup = await createPizzaOrderForFixture(ctx);
    if (!setup.orderId) return { status: -3, body: `dynamic fixture setup failed: ${setup.body}` };
    const r = await fixtureCall(ctx, "POST", `/api/demo/orders/${encodeURIComponent(setup.orderId)}/cancel`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/demo/jobs/:jobId/accept": (async (ctx: FixtureCtx) => {
    const setup = await createPizzaOrderForFixture(ctx);
    if (!setup.orderId) return { status: -3, body: `dynamic fixture setup failed: ${setup.body}` };
    const confirmed = await fixtureCall(ctx, "POST", `/api/demo/orders/${encodeURIComponent(setup.orderId)}/confirm`, {});
    const jobId = String((confirmed.json.job as Record<string, unknown> | undefined)?.jobId ?? "");
    if (!jobId) return { status: -3, body: `dynamic fixture setup failed: no make-pizza jobId, confirm=${confirmed.status}` };
    const r = await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(jobId)}/accept`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/demo/jobs/:jobId/reject": (async (ctx: FixtureCtx) => {
    // reject accepts status "queued" OR "accepted" — reject the make-pizza job while still
    // queued, right after confirm/dispatch, no accept step needed first (pizza-demo.ts:760).
    const setup = await createPizzaOrderForFixture(ctx);
    if (!setup.orderId) return { status: -3, body: `dynamic fixture setup failed: ${setup.body}` };
    const confirmed = await fixtureCall(ctx, "POST", `/api/demo/orders/${encodeURIComponent(setup.orderId)}/confirm`, {});
    const jobId = String((confirmed.json.job as Record<string, unknown> | undefined)?.jobId ?? "");
    if (!jobId) return { status: -3, body: `dynamic fixture setup failed: no make-pizza jobId, confirm=${confirmed.status}` };
    const r = await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(jobId)}/reject`, { reason: "N68 dynamic fixture reject" });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/demo/jobs/:jobId/complete": (async (ctx: FixtureCtx) => {
    // Completes the make-pizza leg (status "accepted" -> "complete", pizza-demo.ts:607-623) —
    // the shortest chain that reaches this route's success path.
    const setup = await createPizzaOrderForFixture(ctx);
    if (!setup.orderId) return { status: -3, body: `dynamic fixture setup failed: ${setup.body}` };
    const confirmed = await fixtureCall(ctx, "POST", `/api/demo/orders/${encodeURIComponent(setup.orderId)}/confirm`, {});
    const makeJobId = String((confirmed.json.job as Record<string, unknown> | undefined)?.jobId ?? "");
    if (!makeJobId) return { status: -3, body: `dynamic fixture setup failed: no make-pizza jobId, confirm=${confirmed.status}` };
    await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(makeJobId)}/accept`, {});
    const r = await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(makeJobId)}/complete`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/demo/jobs/:jobId/pickup": (async (ctx: FixtureCtx) => {
    // pickup requires type "deliver-pizza" AND status "accepted" (pizza-demo.ts:572-578) — only
    // reachable after the make-pizza leg completes and dispatches the delivery job (confirm ->
    // accept make-pizza -> complete make-pizza -> accept delivery -> pickup delivery).
    const setup = await createPizzaOrderForFixture(ctx);
    if (!setup.orderId) return { status: -3, body: `dynamic fixture setup failed: ${setup.body}` };
    const confirmed = await fixtureCall(ctx, "POST", `/api/demo/orders/${encodeURIComponent(setup.orderId)}/confirm`, {});
    const makeJobId = String((confirmed.json.job as Record<string, unknown> | undefined)?.jobId ?? "");
    if (!makeJobId) return { status: -3, body: `dynamic fixture setup failed: no make-pizza jobId, confirm=${confirmed.status}` };
    await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(makeJobId)}/accept`, {});
    const completed = await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(makeJobId)}/complete`, {});
    const completedOrder = completed.json.order as Record<string, unknown> | undefined;
    const orderJobs = completedOrder?.jobs as Record<string, unknown> | undefined;
    const deliveryJobId = String(orderJobs?.delivery ?? "");
    if (!deliveryJobId) return { status: -3, body: `dynamic fixture setup failed: no delivery jobId, complete=${completed.status}` };
    await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(deliveryJobId)}/accept`, {});
    const r = await fixtureCall(ctx, "POST", `/api/demo/jobs/${encodeURIComponent(deliveryJobId)}/pickup`, {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// N68b (empirical NOT_REACHED verification, follow-up to #533 r5 — the FOURTH round on the
// same MEDIUM: "NOT_REACHED claims a route is unreachable when it is reachable"). The
// cross-family reviewer reproduced four of these at a6268d21 BEFORE this fix (see
// n68-r6-repro.log, SHA a6268d21e0794cb91b92075e60ad5e1e1c1b7c9f as its first line) — each is
// moved here with the SAME verified mechanism, generalized to its unreached siblings that share
// the identical gap (confirmed by reading every handler involved, not guessed):
//   - asset-outbound.ts's PUT .../budget creates a budget fixtureCall already knows how to drive
//     (fixtureCall supports PUT; see its own docstring above) — the two framework_limit entries
//     that claimed this sweep's GET/POST pair "never exercises" PUT were simply wrong about what
//     this file's own helper can do.
//   - protocols.ts's automation-status / template / run handlers are ALL stateless reads of
//     hardcoded seed arrays (mockAutomationStatuses, mockTemplates, mockRuns) — none of them
//     ever assigns back into the seed (grepped the whole file for `.push(`/`.status =`/index
//     writes: zero hits outside two unrelated LOCAL arrays inside /validate). A precondition
//     that a SEEDED row already satisfies is therefore satisfied FOREVER, not just on the one
//     reproduction, and every sibling route reading the SAME seed under the SAME kind of
//     precondition is equally reachable:
//       * node-liquid/node-centrifuge (mockAutomationStatuses[0], protocols.ts:404-416)
//         satisfies BOTH /episode (any existing pair) and /advance (currentLevel="manual" is
//         index 0 of 5, not the last — protocols.ts:685-706).
//       * ptpl_3dprint_qc001 (mockTemplates[1], protocols.ts:209-265, status "draft") satisfies
//         /publish (status != "published", protocols.ts:521-534) AND /fork, /runs, /validate
//         (protocols.ts:536-549,587-601,720-765 — no status precondition at all; existence is
//         the only gate, and none of the four ever flips the template's in-memory status).
//       * prun_active_001 (mockRuns[0], protocols.ts:377-399, status "running" — NEVER mutated,
//         see the NOT_REACHED entries for /start and /resume below for why) satisfies /pause
//         (status=="running", protocols.ts:612-619) AND /cancel (status not in
//         {completed,cancelled}, protocols.ts:630-637) — but genuinely NOT /start or /resume.
// ─────────────────────────────────────────────────────────────────────────────────────────
Object.assign(FIXTURE_POST_BODIES, {
  "/api/assets/:id/outbound-demand": (async (ctx: FixtureCtx) => {
    const assetId = `n68b-dynfix-asset-${ctx.ip()}`;
    await fixtureCall(ctx, "PUT", `/api/assets/${encodeURIComponent(assetId)}/budget`, {
      ownerDid: "did:n68b-dynfix", budgetCapUSD: 10, dailyCapUSD: 10, requiresOwnerApproval: true,
    });
    const r = await fixtureCall(ctx, "POST", `/api/assets/${encodeURIComponent(assetId)}/outbound-demand`, {
      description: "N68b dynamic fixture outbound demand", requiredCapabilityType: "3d-printing",
      maxPriceUSD: 5, minAssuranceTier: 0,
    });
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/assets/:id/outbound-demand/:demandId/approve": (async (ctx: FixtureCtx) => {
    const assetId = `n68b-dynfix-asset-approve-${ctx.ip()}`;
    await fixtureCall(ctx, "PUT", `/api/assets/${encodeURIComponent(assetId)}/budget`, {
      ownerDid: "did:n68b-dynfix", budgetCapUSD: 10, dailyCapUSD: 10, requiresOwnerApproval: true,
    });
    const created = await fixtureCall(ctx, "POST", `/api/assets/${encodeURIComponent(assetId)}/outbound-demand`, {
      description: "N68b dynamic fixture outbound demand for approval", requiredCapabilityType: "3d-printing",
      maxPriceUSD: 5, minAssuranceTier: 0,
    });
    const demandId = String(created.json.demandId ?? "");
    const r = await fixtureCall(
      ctx, "POST",
      `/api/assets/${encodeURIComponent(assetId)}/outbound-demand/${encodeURIComponent(demandId)}/approve`,
      { approved: false, approverDid: "did:n68b-dynfix" },
    );
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/automation-status/:fromNodeId/:toNodeId/episode": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/automation-status/node-liquid/node-centrifuge/episode", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/automation-status/:fromNodeId/:toNodeId/advance": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/automation-status/node-liquid/node-centrifuge/advance", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/protocols/:id/publish": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/protocols/ptpl_3dprint_qc001/publish", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/protocols/:id/fork": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/protocols/ptpl_3dprint_qc001/fork", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/protocols/:id/runs": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/protocols/ptpl_3dprint_qc001/runs", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/protocols/:id/validate": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/protocols/ptpl_3dprint_qc001/validate", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/protocol-runs/:runId/pause": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/protocol-runs/prun_active_001/pause", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
  "/api/protocol-runs/:runId/cancel": (async (ctx: FixtureCtx) => {
    const r = await fixtureCall(ctx, "POST", "/api/protocol-runs/prun_active_001/cancel", {});
    return { status: r.status, body: r.body };
  }) as DynamicFixture,
});

/** A handful of FIXTURE_POST_BODIES routes also need a non-default header to reach 2xx — the
 *  MCP Streamable-HTTP surfaces (mcp/http-mcp-server.ts, mcp/docs-mcp-server.ts) 406 a plain
 *  JSON-only Accept header with "Not Acceptable: Client must accept both application/json and
 *  text/event-stream" (confirmed empirically, n68-medium1-repro diag2 log). Keyed the same way
 *  as FIXTURE_POST_BODIES. */
const EXTRA_POST_HEADERS: Record<string, Record<string, string>> = {
  "/mcp": { accept: "application/json, text/event-stream" },
  "/mcp/apps": { accept: "application/json, text/event-stream" },
  "/mcp/docs": { accept: "application/json, text/event-stream" },
};

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
    // Master's #400 (N4b-gw item 1) retired the OT-2 relay family: ot2-legacy-gone.ts registers
    // one catch-all that answers 410 Gone for every /api/ot2/* request, reading and writing
    // nothing. The /api/ot2/* fixtures above no longer match a registered route.
    test: (u) => u === "/api/ot2/*",
    reason: "retired family (#400, routes/ot2-legacy-gone.ts): every /api/ot2/* request answers 410 Gone; nothing is read or written",
  },
  {
    // Master retired caller-supplied bounty verification (ledger R45, astra pack 36 HIGH 2):
    // the handler unconditionally replies 410 Gone for every request, same shape as the
    // retired /api/ot2/* family above — no auth state, body or env can change the outcome, so
    // this sweep calls it never, with a reviewable reason, instead of recording a permanent
    // called-but-unreachable row.
    test: (u) => u === "/api/bounty/verify",
    reason: "retired (ledger R45, astra pack 36 HIGH 2, routes/bounty.ts:139-145): every /api/bounty/verify request answers 410 Gone unconditionally — caller-supplied verification is no longer accepted, and the route reads/writes nothing",
  },
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
    test: (u) => u === "/api/jobs/:jobId/resume-settlement",
    reason:
      "mutates money — round-3 re-check (the prior 404-only reason deferred this, round 2): " +
      "with a real job in evidence_submitted status, this route re-drives the SAME on-chain " +
      "settlement path as /api/settlement/* — driveSettlement() funds/submits-evidence/RELEASES " +
      "a milestone and the subsequent EAS attestation mint (paid-job-flow.ts:1629-1676, gated by " +
      "escrowWriteEnabled() but excluded on principle, same as the other settlement/escrow " +
      "entries above). Chaining a job into evidence_submitted purely to reach this route would " +
      "also require simulating most of the paid-job-flow lifecycle, for a route whose own doc " +
      "comment (paid-job-flow.ts:1518-1537) describes it as a funds-recovery operation.",
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
  // N68b (follow-up to #533 r5): carrier.ts's /shipments and lob.ts's /letters previously
  // carried a NOT_REACHED entry classified admin_or_owner_only ("even a real job would 403
  // since the stranger pass is neither submitter nor kernel-operator"). Re-checked fresh: that
  // was the WRONG blocker. kernels.ts:163 resolves actorId from the caller's own auth context,
  // and kernel.facade.ts:493 stamps a freshly-created kernel's operatorAddress with THAT SAME
  // actorId automatically ("Authenticated creates are owned by the stable actor identity") — so
  // a stranger who registers their OWN kernel+job would clear carrier.ts's/lob.ts's
  // owner.toLowerCase()===caller.toLowerCase() check (carrier.ts:588; lob.ts's callerId() at
  // lob.ts:65 resolves the identical req.operatorId??req.userId). Ownership is not a boundary
  // this sweep structurally respects here, unlike e.g. compliance.ts's attestations/aggregate
  // (see that NOT_REACHED entry, which verified the OPPOSITE: neither of ITS two ownership
  // paths is ever satisfiable by anyone). The real and ONLY reason these two stay uncalled is
  // the category this comment block already covers — moved here per money_movement's own
  // "prefer POST_EXCLUSIONS for these" rule, instead of a NOT_REACHED entry with an inaccurate
  // blocker.
  {
    test: (u) => u === "/api/carrier/shipments",
    reason:
      "mutates money — reserves, buys, and finalizes a real (EASYPOST_API_KEY absent in this " +
      "test env, so mocked) shipping-label purchase through a multi-step reserve/buy/finalize " +
      "state machine; the route's own comment self-describes it as \"this money route\" " +
      "(carrier.ts:582). Excluded on principle, same as the on-chain escrow/settlement entries " +
      "above — NOT because ownership is unreachable (it is: see this block's own header note).",
  },
  {
    test: (u) => u === "/api/lob/letters",
    reason:
      "mutates money — self-described as \"this MONEY route\" (lob.ts:330) that \"spends the " +
      "deployment's Lob balance\" (lob.ts:347) to create and charge a real (LOB_API_KEY absent " +
      "in this test env, so mocked) mailed letter. Excluded on principle, same shape as " +
      "carrier/shipments above — NOT because ownership is unreachable (see this block's own " +
      "header note).",
  },
];

// ─────────────────────────────────────────────────────────────────────────────────────────
// astra round-1-of-MEDIUM-1 item 2 ("reached, not called"): every CALLED post route (i.e.
// `classifyPost(url).call === true` and not covered by FIXTURE_POST_BODIES above reaching a
// 2xx) must appear here BY EXACT URL with a specific reason, decided by reading that route —
// or the STRUCTURAL test fails and names it. Each reason below also states whether the
// route's response could ever carry kernel/capability location or operator PII
// ("no-location-data-confirmed" throughout — zero PRODUCTION_LEAK_SUSPECTED findings came out
// of this triage). The STRUCTURAL test also fails on a STALE entry here: a url that's no
// longer called (excluded, deregistered, or now reaches 2xx) — this map decays with the route
// table, it doesn't accumulate forever.
// ─────────────────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────────────────
// round 4 (cross-family review of #533, the SAME MEDIUM still open): a phrase blocklist will
// always miss some wording ("too complex to confidently craft" slipped past round 3's
// DEFERRING_LANGUAGE_RE untouched). Replaced the implicit "trust the prose" contract with an
// explicit one: every entry now carries a `category` drawn from a CLOSED set of structural
// blocker shapes, plus a `cite` pointing at the production line that proves it. STRUCTURAL
// validates both mechanically (unknown category -> fail; cite that doesn't look like a file:
// line -> fail) — a reason can still be prose, but it can no longer be ONLY prose.
// ─────────────────────────────────────────────────────────────────────────────────────────
// N68b (follow-up to #533 r5, the FOURTH round on this MEDIUM): round 4's category+cite
// mechanism still let a WRONG blocker claim pass review — it checked the SHAPE of the claim
// (an allowed category word, a cite that looks like file.ts:line), never whether the claim was
// TRUE. Closed by construction here: every entry now ALSO carries an executable `witness`. For
// the categories below that are believed GENUINELY blocked (env_or_feature_gate,
// admin_or_owner_only, no_creation_route, framework_limit) the witness is a real HTTP call —
// the BY-CONSTRUCTION test further down actually RUNS it through the same `app` and asserts the
// response lands on the declared status/code. If it ever lands on 2xx instead, that test fails
// with "claimed unreachable but reached" — exactly the bug this whole round exists to close.
// For the two categories that are deliberate SAFETY exclusions rather than genuine
// unreachability (real_subprocess, external_service) the witness does NOT make a call (it never
// exercises the hazard); it instead asserts the route is a member of a small, closed,
// hand-reviewed list for that exact hazard, so the claim stays mechanically checked without
// ever running the dangerous thing it describes.
//
// Two categories from the prior round's closed set are REMOVED here, per this file's own rule
// ("Remove a category from the closed set when no entry uses it any more"):
//   - "sse_or_websocket": zero NOT_REACHED entries ever used it — every SSE/WS-shaped POST
//     route is classified by POST_STREAM_ROUTES above and never reaches this table at all.
//   - "money_movement": re-checked fresh (N68b) — its two candidate entries (carrier/shipments,
//     lob/letters) turned out to have an INACCURATE admin_or_owner_only blocker (ownership is
//     actually self-satisfiable; see compliance.ts's attestations/aggregate below for a case
//     where it genuinely is NOT), so their true-and-only blocker is the category's own
//     documented preference ("prefer POST_EXCLUSIONS for these") — both now live in
//     POST_EXCLUSIONS instead (see that array's N68b addition), leaving zero NOT_REACHED
//     consumers of "money_movement".
type NotReachedCategory =
  | "env_or_feature_gate" // an env var or feature flag this sweep deliberately leaves off/absent
  | "admin_or_owner_only" // the sweep's ANON/STRANGER model is specifically meant to respect this gate
  | "no_creation_route" // no reachable route (POST or otherwise) ever populates a row satisfying THIS route's own precondition
  | "real_subprocess" // the handler spawns a real external process (python3, etc.) — deliberate policy exclusion, never called
  | "external_service" // the handler makes a real call to a third-party service with no mock mode — deliberate policy exclusion, never called
  | "framework_limit"; // a limitation of THIS sweep's own GET/POST method pair or request plumbing, not of the production route

const NOT_REACHED_CATEGORIES: ReadonlySet<NotReachedCategory> = new Set([
  "env_or_feature_gate", "admin_or_owner_only", "no_creation_route", "real_subprocess",
  "external_service", "framework_limit",
] satisfies NotReachedCategory[]);

/** Must match a `path/to/file.ts:123` (or `:123-456`) shape somewhere in the string — i.e.
 *  point at an ACTUAL line in production source, not just assert a conclusion in prose. */
const CITE_RE = /\w[\w./-]*\.ts:\d+/;

/** A witness that is actually EXECUTED (the BY-CONSTRUCTION test below calls it through the
 *  same `app`): for entries believed genuinely blocked, proves the block is real right now, not
 *  merely plausible in prose. `expect.code` is matched against the JSON body's `error` field
 *  (this codebase's universal error-shape key) when present. A 2xx response fails the suite. */
interface CalledWitness {
  method: "GET" | "POST" | "PUT";
  /** May contain the literal token ":batchId", resolved at run time via a live GET /api/batches
   *  lookup — the one entry here whose blocking precondition is live state, not a fixed id. */
  url: string;
  body?: unknown;
  /** True when this route requires no Authorization header (public per api-gate.ts). Every
   *  other witness gets the stranger's own Bearer token automatically. */
  noAuth?: true;
  /** N68b r2 (astra r1 item 1a): optional live-state setup for a witness whose blocking
   *  precondition needs a REAL row minted first, not a fixed/missing id — run through the
   *  SAME app, reusing the existing fixtureCall/FixtureCtx machinery above (so it runs with
   *  whatever identity the caller passes in, with no network and no money). Returns a map of
   *  literal tokens (e.g. ":verdictId") to their resolved values; each token is substituted
   *  into BOTH `url` and `body` (substituteTokens, below) before the call — the SAME ":batchId"
   *  treatment the live-batch lookup already gets, generalized to any field. */
  prepare?: (ctx: FixtureCtx) => Promise<Record<string, string>>;
  expect: { status: number[]; code?: string };
}

/** A witness that is NEVER called (N68b task rule for this shape: "Don't call it"). Proves the
 *  hazard the category claims by closed-list membership instead of by exercising it — the list
 *  itself is the reviewable, cite-checked assertion, checked both ways (url ∈ list, and the
 *  list used IS that hazard's own canonical list) so neither side can drift unnoticed. */
interface PolicyExclusionWitness {
  hazard: "real_subprocess" | "external_service";
  closedList: readonly string[];
}

/** N68b r2 (astra r1 item 1a): a witness that proves "no reachable route ever creates the row
 *  this lookup needs" NOT by calling the route under test (a missing-id call can only ever
 *  prove that ONE id is absent, never that no OTHER id-minting path exists — astra's exact
 *  complaint about the old archive witness), but by grepping every PRODUCTION .ts file under
 *  `scanDir` (resolved against this test file's own directory; any directory literally named
 *  __tests__ is always excluded) for a call site matching `callPattern` — the repository
 *  method that is the ONLY writer of the table the route's own lookup reads. Zero matches is
 *  the proof; a match means the "no creation route" claim just went FALSE and this entry must
 *  become a dynamic fixture instead. `httpCheck`, when present, is additionally run as an
 *  ordinary CalledWitness — kept because "this specific id is absent" is still a true, separate
 *  fact worth asserting; it is NOT what proves "no creation route exists at all". */
interface StructuralNoCreationWitness {
  repoMethod: string;
  scanDir: string;
  callPattern: RegExp;
  httpCheck?: CalledWitness;
}

type NotReachedWitness = CalledWitness | PolicyExclusionWitness | StructuralNoCreationWitness;

function isPolicyExclusionWitness(w: NotReachedWitness): w is PolicyExclusionWitness {
  return "hazard" in w;
}

function isStructuralNoCreationWitness(w: NotReachedWitness): w is StructuralNoCreationWitness {
  return "repoMethod" in w;
}

/** The two closed, hand-reviewed lists a PolicyExclusionWitness may cite. */
const REAL_SUBPROCESS_NOT_REACHED_ROUTES = [
  "/api/capture/sim", "/api/capture/3d-stream",
] as const;
const EXTERNAL_SERVICE_NOT_REACHED_ROUTES = [
  "/api/onboard/:id/build-agent", "/api/onboard/redeem",
] as const;

interface NotReachedEntry {
  category: NotReachedCategory;
  /** e.g. "onboard.ts:176-177" or "capture/verifier-factory.ts:115-120" — must match CITE_RE. */
  cite: string;
  reason: string;
  witness: NotReachedWitness;
}

const NOT_REACHED: Record<string, NotReachedEntry> = {
  "/api/batches/:batchId/slots": {
    category: "no_creation_route", cite: "kernel/batch-tracker.ts:24-39",
    reason: "services.ts:130-156 seeds exactly ONE BatchTracker batch at module load, then immediately seal()s + start()s it before this test ever runs; addSample() 400s \"Cannot add samples to batch in running state\" regardless of :batchId. batches.ts (full file) has no OTHER route that calls batchTracker.createBatch — confirmed no second, still-assembling batch is ever reachable. (The sibling /api/batches/shared/:batchId/claim is a wholly separate in-memory Map, already reached via a dynamic fixture.) Verified empirically at a6268d21 (N68b): the one seeded batch's addSample always 400s with that exact message.",
    witness: {
      method: "POST", url: "/api/batches/:batchId/slots", body: {},
      expect: { status: [400], code: "Cannot add samples to batch in running state" },
    },
  },
  "/api/capture/anchor": {
    category: "no_creation_route", cite: "capture.ts:690-704",
    reason: "N68b r2 (astra r1 item 1a, OPEN MEDIUM): the old witness supplied a nonexistent UUID and saw verdict_not_found — true, but that 404 fires at capture.ts:683, BEFORE the claimed Gate A (capture.ts:690-704) is ever reached, so it never proved the gate's own refusal. Fixed by a `prepare` step: mints a REAL verdict row first, through the SAME /api/capture/upload route (and the exact minimal-CC0-manifest mechanism) this file's own dynamic fixture above already uses, so there is only one place that knows what a minimal manifest looks like. CORRECTING a stale claim in the prior reason: that minimal manifest does NOT produce a FAIL verdict — CC0's only mandatory gate is G1 (MANDATORY_GATES, verifier.ts:226-240), which a well-formed minimal manifest passes, so mandatoryPassed is true with no ceiling slip, landing in the PASS branch (verifier.ts:396-399). What IS false for this manifest is anchorCandidate: verifier.ts:401-408 requires verifiedClass to rank ABOVE CC0, or a detector-asserted anchorCandidate (never set — no sensorFusion supplied) — \"CC0 captures with no positive evidence at all are NOT anchored\" (verifier.ts:401-402, its own comment). The witness now calls anchor with THAT real PASS-but-not-anchor-candidate verdict's id: selectVerdict finds the row (capture.ts:682-683, no longer a 404), the first half of Gate A passes (verdict.verdict===\"PASS\", capture.ts:691), and the second half (capture.ts:698, `!verdict.anchorCandidate`) is what actually refuses it, returning its own 400/not_anchor_candidate — the gate's own refusal, not the existence check's, and not the guess in the prior reason either. Freshly confirmed empirically at N68b r2: calling the real route and reading the real response is what caught the stale FAIL-verdict claim prose alone had missed.",
    witness: {
      // Must be UUID-SHAPED (AnchorBodySchema: z.string().uuid(), capture.ts:111); :verdictId
      // is replaced with a REAL id by `prepare` below before the call is ever made.
      method: "POST", url: "/api/capture/anchor", body: { verdictId: ":verdictId" },
      prepare: async (ctx) => {
        const bytes = Buffer.from(`N68b r2 witness capture bytes ${ctx.ip()}`, "utf8");
        const mediaHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const upload = await fixtureCall(ctx, "POST", "/api/capture/upload", {
          manifest: {
            class: "CC0", declaredAt: new Date().toISOString(),
            deviceFingerprint: "n68b-r2-witness-device", mediaHash,
          },
          captureBytesBase64: bytes.toString("base64"),
        });
        const verdictId = String(upload.json.verdictId ?? "");
        expect(verdictId, "witness setup: POST /api/capture/upload must mint a real verdictId").toBeTruthy();
        return { ":verdictId": verdictId };
      },
      expect: { status: [400], code: "not_anchor_candidate" },
    },
  },
  "/api/carrier/webhook/easypost": {
    category: "env_or_feature_gate", cite: "carrier.ts:846-851",
    reason: "503 — EASYPOST_WEBHOOK_SECRET is deliberately cleared in this test env, checked before any signature/business logic. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/carrier/webhook/easypost", body: {}, noAuth: true,
      expect: { status: [503], code: "webhook_secret_not_configured" },
    },
  },
  "/api/dht/announce": {
    category: "framework_limit", cite: "middleware/api-gate.ts:35",
    reason: "api-gate.ts lists \"/api/dht/\" as a public-path prefix (api-gate.ts:35), so apiGate's own onRequest hook returns at its EARLY \"skip public routes\" check (api-gate.ts:151-152) WITHOUT ever attempting resolveApiKey/resolveSession for this whole family — req.apiKeyId/operatorId/userId stay unset whether or not the caller presents a real Bearer token, and the handler's own auth check (dht-ws.ts:84-88) 401s whenever both are unset. A routing/middleware interaction a real caller could not clear either, Bearer token or not — confirmed by reading the full isPublicRoute early-return at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/dht/announce", body: { kernelId: "n68b-witness-kernel", capabilities: ["3d-printing"] },
      expect: { status: [401], code: "Authentication required for DHT announcements" },
    },
  },
  "/api/evidence/:bundleId/archive": {
    category: "no_creation_route", cite: "evidence-encrypted.ts:130-131",
    reason: "N68b r2 (astra r1 item 1a, OPEN MEDIUM): the old witness called a synthetic, nonexistent bundleId and saw not_found — true, but that only proves THIS id is absent, never that no reachable route mints ANY row satisfying findEncryptedByBundleId (evidence-encrypted.ts:17, read again at :130). That row is written by exactly one repository method, insertEncryptedBundle (IEncryptionRepository.ts:26, implemented at db/src/repositories/encryption.ts:26) — the ONLY writer of the encryptedEvidenceBundles table (db/src/schema). Fixed by a STRUCTURAL witness (below, a new witness kind): greps every production .ts file under packages/gateway/src, excluding __tests__, for a call to insertEncryptedBundle and asserts zero hits — re-run mechanically on every test run, not a one-time grep result. Confirmed fresh at N68b r2: zk-proofs.ts calls insertCommitment/insertTree/insertProof, and evidence-encrypted.ts's own /grant route calls insertGrant — neither is insertEncryptedBundle; no call site exists anywhere in gateway/src. The original HTTP call is kept as `httpCheck` — still true and still worth asserting, just not what proves \"no creation route exists\" by itself. Verified empirically at a6268d21 (N68b) for the single-id absence; the structural no-call-site proof added at N68b r2.",
    witness: {
      repoMethod: "insertEncryptedBundle",
      scanDir: "..",
      callPattern: /\binsertEncryptedBundle\s*\(/,
      httpCheck: {
        method: "POST", url: "/api/evidence/n68b-witness-nonexistent-bundle/archive", body: {},
        expect: { status: [404], code: "not_found" },
      },
    },
  },
  "/api/fiat-ramp/stripe/credits/deposit": {
    category: "env_or_feature_gate", cite: "fiat-ramp.ts:410-412",
    reason: "410 Gone — PCC_LEGACY_FIAT_WEBHOOKS unset, returned unconditionally before any body check. This path was RETIRED by a prior security audit (its own in-file comment: an unsigned webhook \"any authenticated caller could forge\"); re-enabling the flag would restore a named hazard, not flip a neutral toggle. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/fiat-ramp/stripe/credits/deposit", body: { amountUsd: 1 },
      expect: { status: [410], code: "gone" },
    },
  },
  "/api/fiat-ramp/webhook/stripe": {
    category: "env_or_feature_gate", cite: "fiat-ramp.ts:706-708",
    reason: "same PCC_LEGACY_FIAT_WEBHOOKS gate as the credits/deposit entry above, unconditional regardless of body — also a security-retired unsigned webhook. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/fiat-ramp/webhook/stripe", body: {},
      expect: { status: [410], code: "gone" },
    },
  },
  "/api/fiat-ramp/webhook/yellowcard": {
    category: "env_or_feature_gate", cite: "fiat-ramp.ts:731-733",
    reason: "same PCC_LEGACY_FIAT_WEBHOOKS gate, unconditional regardless of body — also a security-retired unsigned webhook. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/fiat-ramp/webhook/yellowcard", body: {},
      expect: { status: [410], code: "gone" },
    },
  },
  "/api/jobs/:jobId/attestations/aggregate": {
    category: "admin_or_owner_only", cite: "compliance.ts:122-133",
    reason: "N68b r2 (astra r1 item 1a, OPEN MEDIUM): the old witness called a nonexistent jobId and saw not_found at compliance.ts:120 — true, but that 404 fires BEFORE the owner gate at compliance.ts:122-133 is ever reached, so it never exercised the OR'd ownership check or saw its 403. Fixed by a `prepare` step: submits a REAL job first (POST /api/jobs/submit, as the SAME stranger identity, on the canary's own kernel/capability — the exact body FIXTURE_POST_BODIES already uses for this route), then calls aggregate on THAT real jobId. compliance.ts:119's findById now succeeds (no longer a 404), so the owner gate itself runs: (1) job.submittedBy===operatorId — job.facade.ts's submit() (job.facade.ts:260-307) never assigns `submittedBy` anywhere in its DB insert (job.facade.ts:293-307; grepped the whole method, zero writes to that field; contrast kernels.ts's actorId, which kernel.facade.ts:493 DOES stamp onto a new kernel's operatorAddress), so this path is false for every job, self-created or not. (2) kernel.operatorId===operatorId — kernels.ts (db/src/schema) has no operatorId COLUMN at all, only operatorAddress (kernels.ts:7); `(kernel as any).operatorId` is always undefined, never equal to any real operatorId string. Both paths are structurally dead, not merely unmet by this sweep's stranger identity — freshly confirmed at N68b r2: the stranger's own self-submitted job still gets refused, by the gate itself, with its own 403/forbidden (compliance.ts:128-133), not a 404. (Contrast carrier.ts's /shipments and lob.ts's /letters, in POST_EXCLUSIONS: THEIR ownership check genuinely is self-satisfiable — this route's is not.)",
    witness: {
      method: "POST", url: "/api/jobs/:jobId/attestations/aggregate", body: { attestations: [] },
      prepare: async (ctx) => {
        const submitted = await fixtureCall(ctx, "POST", "/api/jobs/submit", {
          stepId: "step-n68b-r2-aggregate-witness", kernelId: CANARY.kernelId,
          capabilityType: "3d-printing", parameters: {},
        });
        const jobId = String(submitted.json.jobId ?? "");
        expect(jobId, "witness setup: POST /api/jobs/submit must mint a real jobId").toBeTruthy();
        return { ":jobId": jobId };
      },
      expect: { status: [403], code: "forbidden" },
    },
  },
  "/api/lit/provision": {
    category: "env_or_feature_gate", cite: "lit-provision.ts:26-40",
    reason: "503 — LIT_API_KEY is deliberately cleared in this test env, checked right after field validation and before any fetch. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/lit/provision", body: { kernelId: "n68b-witness-kernel", operatorDid: "did:n68b-witness" },
      expect: { status: [503], code: "lit_not_configured" },
    },
  },
  "/api/lob/webhook": {
    category: "env_or_feature_gate", cite: "lob.ts:464-469",
    reason: "503 — LOB_WEBHOOK_SECRET is deliberately cleared; the plugin's \"webhook\" gate passes through (not production) but the handler's own hasWebhookSecret check 503s before any signature check. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/lob/webhook", body: {}, noAuth: true,
      expect: { status: [503], code: "webhook_secret_not_configured" },
    },
  },
  "/api/onboard/:id/build-agent": {
    category: "external_service", cite: "pcc-discovery.ts:113",
    reason: "the onboard template's onBuild hook (template-agents.ts:149-166) calls publishOperator() from @pcc/orchestrator-sdk, which issues an unconditional real fetch to PCC_BASE_URL/api/onboard/register (pcc-discovery.ts:68-117, the live call at :113) — no test-injection seam like captureVerifier/chainClient/smokeTestFetch/lingbotSpawner exists for this SDK call, and MOCK_PCC_DISCOVERY is unset in this test env, so it is not a MOCK-gated no-op. This sweep's own no-network guard blocks and records the attempt rather than letting it leave the process — excluded BY POLICY (a real network attempt), never called. Contrast: the sibling /api/orchestrator/data-product/:id/build-agent uses the data-product template's explicit stub onBuild (template-agents.ts:238-248, a \"minimal stub\" per its own doc comment) which does no network I/O — that one DOES reach 2xx via a dynamic fixture below.",
    witness: { hazard: "external_service", closedList: EXTERNAL_SERVICE_NOT_REACHED_ROUTES },
  },
  "/api/onboard/identify-device": {
    category: "env_or_feature_gate", cite: "identify-device.ts:95-98",
    reason: "503 — ANTHROPIC_API_KEY is deliberately cleared in this test env, checked after body validation but before any model call. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/onboard/identify-device", body: { text: "a 3d printer" }, noAuth: true,
      expect: { status: [503], code: "Device identification temporarily unavailable" },
    },
  },
  "/api/onboard/passkey/register-challenge": {
    category: "env_or_feature_gate", cite: "passkey.ts:139-144",
    reason: "503 — PCC_PASSKEY_ENABLED feature flag defaults off (isPasskeyEnabled() checks `=== \"true\"`, passkey.ts:71-73), checked as the FIRST line of the handler; no body can enable it. Setting the flag would not lead to a safely-callable 2xx either way — the rest of the flow needs a genuine hardware/software WebAuthn attestation this sweep has no way to fabricate. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/onboard/passkey/register-challenge", body: {},
      expect: { status: [503], code: "passkey_not_enabled" },
    },
  },
  "/api/onboard/passkey/verify-attestation": {
    category: "env_or_feature_gate", cite: "passkey.ts:231-236",
    reason: "503, the same feature-flag gate as register-challenge above — same reasoning for why enabling it would not help. Verified empirically at a6268d21 (N68b).",
    witness: {
      method: "POST", url: "/api/onboard/passkey/verify-attestation", body: {},
      expect: { status: [503], code: "passkey_not_enabled" },
    },
  },
  "/api/onboard/redeem": {
    category: "external_service", cite: "onboard.ts:577-593",
    reason: "needs a real Gatecraft invite code from the external GATECRAFT_URL identity service; the response status is proxied straight from that service's own reply, which this sweep has no valid code to produce, and no mock mode exists for it. Excluded BY POLICY (a real network attempt), never called.",
    witness: { hazard: "external_service", closedList: EXTERNAL_SERVICE_NOT_REACHED_ROUTES },
  },
  "/api/protocol-runs/:runId/resume": {
    category: "no_creation_route", cite: "protocols.ts:621-628",
    reason: "N68b correction: prun_active_001 (protocols.ts:377-399) IS a real, permanent seeded row — the PRIOR \"no POST ever makes a runId\" framing reached the right conclusion with the wrong mechanism, since /pause and /cancel above now prove that SAME row is reachable. The actual reason resume (and start, below) stay unreached: none of protocols.ts's start/pause/resume/cancel handlers ever assigns back into mockRuns (grepped the whole file for `.status =`/`.push(` touching it: zero hits) — prun_active_001's status is permanently \"running\" no matter how many times any of them run. resume requires status===\"paused\" (protocols.ts:624), which this one row can never actually be in storage, and the only nominal run-creation route (POST /api/protocols/:id/runs, protocols.ts:587-601) mints a runId it never pushes into mockRuns — so no second row ever exists either. Verified empirically at a6268d21 (N68b): resume on prun_active_001 returns 409 every time.",
    witness: {
      method: "POST", url: "/api/protocol-runs/prun_active_001/resume", body: {},
      expect: { status: [409], code: "invalid_state" },
    },
  },
  "/api/protocol-runs/:runId/start": {
    category: "no_creation_route", cite: "protocols.ts:603-610",
    reason: "same corrected mechanism as resume above: prun_active_001 is a real, permanent seeded row whose status is permanently \"running\" (no handler ever mutates mockRuns) — start requires status in {\"ready\",\"binding\"} (protocols.ts:606), which this row can never reach, and no second run is ever persisted (protocols.ts:587-601 mints a runId it never stores). Verified empirically at a6268d21 (N68b): start on prun_active_001 returns 409 every time.",
    witness: {
      method: "POST", url: "/api/protocol-runs/prun_active_001/start", body: {},
      expect: { status: [409], code: "invalid_state" },
    },
  },
  "/api/capture/sim": {
    category: "real_subprocess", cite: "capture-sim.ts:163-226",
    reason: "spawns a real python3 pcc_genesis_runner.py subprocess regardless of body. A test-injection seam exists (setGenesisSpawnerForTests, capture-sim.ts:78) but per this category's own rule this sweep deliberately does not install it — excluded BY POLICY (a real subprocess), never called.",
    witness: { hazard: "real_subprocess", closedList: REAL_SUBPROCESS_NOT_REACHED_ROUTES },
  },
  "/api/capture/3d-stream": {
    category: "real_subprocess", cite: "capture-3d.ts:146-150",
    reason: "requireAuth + a minimal valid videoBytesBase64 clear validation, but the handler then calls runLingBotInference, which unconditionally does a real OS-level spawn() of python3 (lingbot-adapter.ts:194,272) even when PCC_LINGBOT_STUB=1 — that flag only changes what the SPAWNED script does internally (lingbot-adapter.ts:12,191), not whether a real process is spawned at all. A test-injection seam exists (setLingBotSpawnerForTests, lingbot-adapter.ts:91) that would avoid the spawn entirely, but per this category's own rule this sweep deliberately does not install it — excluded BY POLICY (a real subprocess), never called. Not a kernel/capability location surface either way (point maps/poses from the caller's own uploaded video).",
    witness: { hazard: "real_subprocess", closedList: REAL_SUBPROCESS_NOT_REACHED_ROUTES },
  },
};

// ─────────────────────────────────────────────────────────────────────────────────────────
// POST stream routes — astra round-2 finding 1(c): the broad SKIP regex used to silently
// exclude EVERY POST url containing "stream"/"/events"/etc, with no reviewable trail. That
// swallowed /api/capture/3d-stream, /api/job-offers/:id/events, and /api/courier-jobs/:id/
// events (none of which are SSE at all — "stream"/"events" only appear in their NAME) along
// with the real target: POST /api/commentary/stream, which returns a genuinely bounded-
// readable 200 SSE stream and needs no external service when ANTHROPIC_API_KEY is absent
// (confirmed empirically — n68-r2review-r3.log). Mirrors GET_STREAM_ROUTES: an explicit
// per-url map decided by reading the route, not a regex. A url NOT in this map is classified
// normally by classifyPost() below — so the three non-stream false positives are now swept
// like any other POST route (FIXTURE_POST_BODIES / NOT_REACHED / POST_EXCLUSIONS), and a
// brand-new POST route whose name happens to contain "stream" is no longer silently dropped.
// ─────────────────────────────────────────────────────────────────────────────────────────
type PostStreamVerdict =
  | { mode: "excluded"; reason: string }
  | { mode: "bounded-read"; reason: string };

const POST_STREAM_ROUTES: Record<string, PostStreamVerdict> = {
  "/api/commentary/stream": {
    mode: "bounded-read",
    reason:
      "LLM commentary narrator SSE — POST is canonical (GET is a convenience alias handled " +
      "the same way by GET_STREAM_ROUTES above, which excludes it); protected by the global " +
      "apiGate (keyed call only, commentary.ts). ANTHROPIC_API_KEY is cleared in this test " +
      "env so the session emits a static needs_api_key chunk (commentary-narrator.ts), but " +
      "the route itself still opens a genuine bounded-readable 200 stream with no external " +
      "service required — swept boundedly (POST + abort) instead of excluded.",
  },
};

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
  const postStream = POST_STREAM_ROUTES[url];
  if (postStream) {
    if (postStream.mode === "excluded") return { call: false, reason: postStream.reason };
    // "bounded-read": still CALLED (real HTTP traffic happens), just via fetchStreamSnapshot
    // in sweep()'s structural POST loop rather than a normal app.inject() + FIXTURE body.
    return { call: true, reason: postStream.reason };
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

/** One call's outcome, keyed by the REGISTERED route PATTERN (not the filled url) — e.g.
 *  "/api/ip/:ipId/pay", not "/api/ip/cap-xyz/pay". Accumulated across BOTH sweep() calls
 *  (ANONYMOUS then KEYED) into the module-level logs below, which the STRUCTURAL test reads
 *  after both have run (vitest runs `it` blocks in declaration order within a `describe` by
 *  default — no `test.concurrent` is used here). */
interface CallRecord {
  patternUrl: string;
  status: number; // -1 timeout, -2 thrown/aborted, else HTTP status
}
const GET_CALL_LOG: CallRecord[] = [];
const POST_CALL_LOG: CallRecord[] = [];

// ─────────────────────────────────────────────────────────────────────────────────────────
// GET routes with a real external side effect regardless of body/auth value — round-2 fix 4
// found these empirically (the no-network guard threw where it had previously been silent).
// Mirrors GET_STREAM_ROUTES' "excluded" mode, same reviewable-reason discipline, but for a
// different cause (an onward fetch to a third party, not a stream). None carry kernel/
// capability location data — they proxy/read the CALLER's own third-party-identity state.
// ─────────────────────────────────────────────────────────────────────────────────────────
const GET_EXTERNAL_EXCLUSIONS: Record<string, string> = {
  "/api/onboard/status": "only checks that an Authorization header STARTS WITH \"Bearer \" (no " +
    "local validation that it's an actual Gatecraft token) and then unconditionally fires three " +
    "parallel fetches to GATECRAFT_URL (v1/auth/me, api/v2/proxy/wallet, api/v2/proxy/credentials) " +
    "— the KEYED pass's real pcc_live_ key satisfies the format check, so this fired on every run " +
    "before the no-network guard existed (silently, over real network); never kernel/capability " +
    "data — proxies the CALLER's own third-party account state, onboard.ts:706-722",
  "/api/onboard/check/:code": "unconditionally fetches GATECRAFT_URL/v1/hackathon/invite/:code to " +
    "validate ANY code string — no local shape check first, so the generic kernelId/capId/" +
    "operatorId path-param fill reaches the real fetch every time; never kernel/capability " +
    "location data (an external invite-code lookup), onboard.ts:682-692",
};

async function sweep(key: string | null) {
  const leaks: string[] = [];
  let calls = 0;
  let timeouts = 0;
  let errors = 0;
  const seen = new Set<string>();
  const seenPost = new Set<string>();
  for (const r of ROUTES) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes("GET") || r.websocket || DOUBLE_SEND.test(r.url)) continue;

    if (GET_EXTERNAL_EXCLUSIONS[r.url]) continue; // explicit, reviewable — see the map above

    const streamVerdict = GET_STREAM_ROUTES[r.url];
    if (streamVerdict?.mode === "excluded") continue; // explicit, reviewable — see the map

    if (streamVerdict?.mode === "bounded-read") {
      // Real-socket bounded read instead of inject() — see fetchStreamSnapshot's docstring.
      // These 3 routes have no path params, so a single plain-url fetch suffices (no
      // variants()/query-string duplication — irrelevant for an SSE connect-time snapshot).
      calls++;
      const headers: Record<string, string> = {};
      if (key) headers.authorization = `Bearer ${key}`;
      const snap = await fetchStreamSnapshot(r.url, headers);
      GET_CALL_LOG.push({ patternUrl: r.url, status: snap.ok ? snap.status : -2 });
      if (!snap.ok) errors++;
      const hit = leakHits(snap.text);
      if (hit.length) leaks.push(`SSE-SNAPSHOT GET ${r.url} -> ${hit.join(",")}`);
      continue;
    }

    // Normal GET handling (unchanged) — includes anything NOT in GET_STREAM_ROUTES at all,
    // so a brand-new stream-shaped route is swept like any other GET, not silently skipped.
    for (const url of variants(r.url)) {
      if (seen.has(url)) continue;
      seen.add(url);
      const headers: Record<string, string> = { "x-forwarded-for": ip() };
      if (key) headers.authorization = `Bearer ${key}`;
      calls++;
      const res = await Promise.race([
        app.inject({ method: "GET", url, headers }).then((x) => ({ status: x.statusCode, body: x.body })),
        new Promise<{ status: number; body: string }>((ok) => setTimeout(() => ok({ status: -1, body: "" }), CALL_TIMEOUT_MS)),
      ]).catch((e) => ({ status: -2, body: String(e) }));
      GET_CALL_LOG.push({ patternUrl: r.url, status: res.status });
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
    POST_CALL_LOG.push({ patternUrl: url, status: res.statusCode });
    const hit = leakHits(res.body);
    if (hit.length) leaks.push(`${res.statusCode} POST ${url} ${JSON.stringify(payload).slice(0, 60)} -> ${hit.join(",")}`);
  }

  // Structural POST sweep: every OTHER registered POST route is called — with a crafted
  // FIXTURE_POST_BODIES payload when one exists (so its success/read branch is actually
  // exercised, not just its 400 validation path), falling back to `{}` otherwise — or was
  // excluded above with a reason. Every path-param variant is called for a STATIC fixture; a
  // DYNAMIC (function) fixture is self-driving and called exactly once (see FixtureCtx docs).
  for (const url of allPostRouteUrls()) {
    if (SPECIAL_POST_URLS.has(url)) continue; // already covered above with a crafted payload
    const verdict = classifyPost(url);
    if (!verdict.call) continue;

    const postStream = POST_STREAM_ROUTES[url];
    if (postStream?.mode === "bounded-read") {
      // Real bounded loopback POST+abort read — mirrors the GET-side bounded-read branch
      // above (fetchStreamSnapshot's docstring). Status comes from the actual response (not
      // assumed 200) since, unlike the public no-auth GET bounded-read routes, this one is
      // auth-gated: the ANONYMOUS pass is expected to get a non-2xx here.
      calls++;
      const headers: Record<string, string> = { "x-forwarded-for": ip(), "content-type": "application/json" };
      if (key) headers.authorization = `Bearer ${key}`;
      const snap = await fetchStreamSnapshot(url, headers, 600, { method: "POST", body: "{}" });
      const status = snap.ok ? snap.status : -2;
      POST_CALL_LOG.push({ patternUrl: url, status });
      if (status >= 500) errors++;
      const hit = leakHits(snap.text);
      if (hit.length) leaks.push(`POST-STREAM-SNAPSHOT ${status} POST ${url} -> ${hit.join(",")}`);
      continue;
    }

    const fixture = FIXTURE_POST_BODIES[url];
    if (typeof fixture === "function") {
      // Self-driving dynamic fixture: makes its own prior calls to mint real state, then the
      // real recorded call — once per pass, not once per generic path-param variant (a fresh
      // id this fixture itself minted is never kernelId/capId/operatorId-shaped anyway).
      calls++;
      const result = await fixture({ app, key, ip });
      POST_CALL_LOG.push({ patternUrl: url, status: result.status });
      if (result.status < 0) timeouts++;
      else if (result.status >= 500) errors++;
      const hit = leakHits(result.body);
      if (hit.length) leaks.push(`${result.status} POST ${url} (dynamic fixture) -> ${hit.join(",")}`);
      continue;
    }

    const payload = fixture ?? {};
    for (const filled of pathVariants(url)) {
      const seenKey = `POST ${filled}`;
      if (seenPost.has(seenKey)) continue;
      seenPost.add(seenKey);
      const headers: Record<string, string> = { "x-forwarded-for": ip(), ...EXTRA_POST_HEADERS[url] };
      if (key) headers.authorization = `Bearer ${key}`;
      calls++;
      const res = await Promise.race([
        app.inject({ method: "POST", url: filled, headers, payload }).then((x) => ({ status: x.statusCode, body: x.body })),
        new Promise<{ status: number; body: string }>((ok) => setTimeout(() => ok({ status: -1, body: "" }), CALL_TIMEOUT_MS)),
      ]).catch((e) => ({ status: -2, body: String(e) }));
      POST_CALL_LOG.push({ patternUrl: url, status: res.status });
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

  it("DETECTOR: flags DMS, plus codes and non-JSON bodies; allows the coarse cell and its centre", () => {
    const flagged = [
      "47°37′13.77516″N 122°20′57.28092″W", // the review's own reproduction
      JSON.stringify({ note: `site at 47°37'13.8"N` }), // ASCII symbols inside a JSON string
      "-122°20′57.28″", // signed, no hemisphere letter
      "N47°37′13.8″", // hemisphere first
      "47°37.2296′N", // degrees and decimal minutes
      "47 37 13.8 N", // spaced
      "47:37:13.8", // colon-separated
      CANARY_PLUS_CODE, // full code, 10 digits
      `${CANARY_PLUS_CODE.slice(0, 8)}+`, // full code, 8 digits (about 275 m)
      `${CANARY_PLUS_CODE.slice(4, 11)} Testville`, // short code with a locality
      "<html><body>47.6204931, -122.3492447</body></html>", // a non-JSON body
    ];
    for (const body of flagged) expect(leakHits(body), body).not.toEqual([]);
    const centre = geohashCenter(CANARY_CELL);
    const allowed = [
      JSON.stringify({ location: centre, locationCell: CANARY_CELL, locationPrecision: "approximate" }),
      `${CANARY_PLUS_CODE.slice(0, 6)}00+`, // a 6-digit (about 5.5 km) code
      "12:30:00 order 4762 at 122 Main St",
    ];
    for (const body of allowed) expect(leakHits(body), body).toEqual([]);
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

    // ── astra round-1-of-MEDIUM-1 item 3 (wildcard): a called route that pathVariants() can't
    // fill at all would be CALLED-by-classification but execute ZERO actual requests — silent
    // non-coverage masquerading as coverage. No current POST route is wildcard-shaped (see
    // n68-medium1-repro R3 log), but this guards the invariant going forward. ──
    const zeroVariantCalled = called.filter((u) => pathVariants(u).length === 0);
    console.log("ZERO-PATH-VARIANT called routes (would make 0 requests):", JSON.stringify(zeroVariantCalled));
    expect(zeroVariantCalled).toEqual([]);

    // ── astra round-1-of-MEDIUM-1 item 2 (reached, not called): a route is REACHED only if at
    // least one of its actual HTTP calls (recorded in POST_CALL_LOG by both the ANONYMOUS and
    // KEYED sweeps, which ran before this test per vitest's declaration-order execution) came
    // back 2xx. Every called-but-unreached route must have a NOT_REACHED entry, and every
    // NOT_REACHED entry must correspond to a route that's still called-and-unreached (no stale
    // entries). ──
    const reachedSet = new Set(
      POST_CALL_LOG.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.patternUrl),
    );
    const notReached = called.filter((u) => !reachedSet.has(u));
    const notReachedMissingEntry = notReached.filter((u) => !(u in NOT_REACHED));
    const staleNotReached = Object.keys(NOT_REACHED).filter(
      (u) => !called.includes(u) || reachedSet.has(u),
    );

    console.log(`POST reached: ${reachedSet.size} of ${called.length} called routes`);
    for (const u of notReached) {
      const entry = NOT_REACHED[u];
      console.log("POST NOT_REACHED", u, entry ? `— ${entry.reason}` : "— ⚠ NO ENTRY (test will fail)");
    }
    if (staleNotReached.length) console.log("STALE NOT_REACHED entries (now reached, excluded, or deregistered):", JSON.stringify(staleNotReached));

    expect(notReachedMissingEntry).toEqual([]);
    expect(staleNotReached).toEqual([]);

    // ── cross-family review of #533 (round 3): round 2 promised every remaining NOT_REACHED
    // entry was re-checked, but several reasons just SAID that and deferred the actual work.
    // Permanent guard: no reason may contain language that defers work to a future round.
    // Kept as a SECOND net (round 4 below is the primary one) — a phrase list alone proved
    // incomplete ("too complex to confidently craft" slipped past round 3's own list
    // untouched, astra round-4 finding), so it is extended here rather than trusted alone.
    const DEFERRING_LANGUAGE_RE =
      /not chased|not attempted|not independently re-verified|deliberately not|this round|not verified|too complex|confidently|not craft|unclear|later/i;
    const deferringNotReached = Object.entries(NOT_REACHED)
      .filter(([, entry]) => DEFERRING_LANGUAGE_RE.test(entry.reason))
      .map(([url]) => url);
    console.log("NOT_REACHED entries with deferring language:", JSON.stringify(deferringNotReached));
    expect(deferringNotReached).toEqual([]);

    // ── cross-family review of #533 (round 4, the SAME MEDIUM still open): a phrase
    // blocklist will always miss some wording — the primary guard is now structural, not
    // lexical. Every entry's `category` must be one of the CLOSED set NOT_REACHED_CATEGORIES
    // enumerates (an entry with a typo'd or invented category fails outright, not silently
    // passing), and every entry's `cite` must look like an actual `file.ts:line` pointer
    // (CITE_RE) — prose alone, with no citation shape, also fails outright. Neither check
    // replaces reading the code; both make it impossible to SKIP citing it. ──
    const unknownCategoryNotReached = Object.entries(NOT_REACHED)
      .filter(([, entry]) => !NOT_REACHED_CATEGORIES.has(entry.category))
      .map(([url, entry]) => `${url} (category=${JSON.stringify(entry.category)})`);
    console.log("NOT_REACHED entries with an unknown category:", JSON.stringify(unknownCategoryNotReached));
    expect(unknownCategoryNotReached).toEqual([]);

    const missingCiteNotReached = Object.entries(NOT_REACHED)
      .filter(([, entry]) => !CITE_RE.test(entry.cite))
      .map(([url, entry]) => `${url} (cite=${JSON.stringify(entry.cite)})`);
    console.log("NOT_REACHED entries with a missing/invalid cite:", JSON.stringify(missingCiteNotReached));
    expect(missingCiteNotReached).toEqual([]);

    // At least these three — the review's own named examples — must reach a genuine 2xx with
    // a meaningful body, not just a blank-body validation 400.
    for (const mustReach of ["/api/requests", "/api/capabilities/templates/match", "/api/capabilities/graph-search"]) {
      expect(reachedSet.has(mustReach), `${mustReach} must REACH 2xx with a meaningful body (astra round-1-of-MEDIUM-1)`).toBe(true);
    }

    // ── astra round-1-of-MEDIUM-1 item 4 (GET side): a GET route that timed out (or threw)
    // during either sweep() run must be a known stream (GET_STREAM_ROUTES) — otherwise it's a
    // NEW silently-hanging route nobody has triaged, exactly the "invisible by default" failure
    // mode this fix replaces with "visible by default, excluded only by name". ──
    const getTimeouts = [...new Set(GET_CALL_LOG.filter((r) => r.status === -1 || r.status === -2).map((r) => r.patternUrl))];
    const unexplainedGetTimeouts = getTimeouts.filter((u) => !(u in GET_STREAM_ROUTES));
    console.log("GET timeouts/errors this run:", JSON.stringify(getTimeouts), "— unexplained:", JSON.stringify(unexplainedGetTimeouts));
    expect(unexplainedGetTimeouts).toEqual([]);

    // ── Final tally, printed once, in the order the task asks for. ──
    console.log(
      `FINAL COUNTS: registered=${all.length} called=${called.length} reached=${reachedSet.size} ` +
      `notReached=${notReached.length} excluded=${excluded.length}`,
    );

    // ── round-2 required fix 4: zero external network attempts, ever. ──
    // Both sweep() passes (and every dynamic fixture's prior calls) ran before this test, per
    // vitest's declaration-order execution — EXTERNAL_NETWORK_ATTEMPTS is the cumulative
    // record across the whole file's run. The guard installed at module-eval time (before
    // ../server.js is ever imported) throws AND records on first use; this assertion is the
    // other half: proving nothing outbound was ever attempted, not just that attempts (if
    // any) were blocked.
    console.log("EXTERNAL_NETWORK_ATTEMPTS:", JSON.stringify(EXTERNAL_NETWORK_ATTEMPTS));
    expect(EXTERNAL_NETWORK_ATTEMPTS).toEqual([]);
  });

  // ───────────────────────────────────────────────────────────────────────────────────────
  // N68b r2 (astra r1 item 1a, OPEN MEDIUM): three CalledWitness entries didn't prove their
  // declared blocker (their fixed/missing id 404d at an EXISTENCE check before the claimed
  // gate was ever reached), and nothing bound a witness's `url` to the NOT_REACHED key it
  // lives under — astra's cheapest repro pointed the aggregate witness at the archive
  // witness's own URL and the suite still passed. witnessBindingError (pinned just below)
  // closes the second gap; the three entries above now use `prepare` (anchor, aggregate) or a
  // new StructuralNoCreationWitness kind (archive) to close the first.
  // ───────────────────────────────────────────────────────────────────────────────────────
  const THIS_DIR = fileURLToPath(new URL(".", import.meta.url));

  /** Recursively lists every production .ts file under `relDir` (resolved against this test
   *  file's own directory), skipping any directory literally named __tests__ at any depth —
   *  used by StructuralNoCreationWitness to grep only shipped route/service code, never test
   *  fixtures (which legitimately DO call insert* helpers directly). */
  function listProductionTsFiles(relDir: string): string[] {
    const root = join(THIS_DIR, relDir);
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "__tests__") continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith(".ts")) out.push(full);
      }
    };
    walk(root);
    return out;
  }

  /** Replaces every literal occurrence of each `subs` token with its resolved value, inside a
   *  URL string or (recursively) inside a JSON-shaped request body — the SAME ":token" syntax
   *  works in either position. A string that EQUALS a token is replaced wholesale (so a
   *  UUID-typed body field gets a real UUID, not a string merely containing one); a token
   *  embedded inside a longer string (a URL path segment) is replaced via substring
   *  split/join. */
  function substituteTokens<T>(value: T, subs: Record<string, string>): T {
    if (typeof value === "string") {
      let out: string = value;
      for (const [token, replacement] of Object.entries(subs)) {
        if (out === token) return replacement as unknown as T;
        if (out.includes(token)) out = out.split(token).join(replacement);
      }
      return out as unknown as T;
    }
    if (Array.isArray(value)) return value.map((v) => substituteTokens(v, subs)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substituteTokens(v, subs);
      return out as T;
    }
    return value;
  }

  /** Pure: does a CalledWitness's ACTUAL call (after any token substitution) prove it hit the
   *  route its own NOT_REACHED key claims to be testing? Every NOT_REACHED key is a POST route
   *  (this whole table is built from classifyPost's POST-only enumeration, above), so the
   *  method itself must be POST; then the path (query string stripped) must satisfy the key's
   *  own pattern, segment-for-segment — a `:param` segment matches exactly one non-empty path
   *  segment, every other segment must match literally, and segment COUNTS must be equal (no
   *  partial/prefix match). Returns null when correctly bound, else a reviewable message
   *  naming the mismatch. */
  function witnessBindingError(key: string, method: string, callUrl: string): string | null {
    if (method !== "POST") {
      return `NOT_REACHED["${key}"] witness calls ${method} ${callUrl}, not its own route`;
    }
    const patternSegs = key.split("/");
    const pathSegs = callUrl.split("?")[0].split("/");
    const bound =
      patternSegs.length === pathSegs.length &&
      patternSegs.every((seg, i) => (seg.startsWith(":") ? pathSegs[i].length > 0 : seg === pathSegs[i]));
    return bound ? null : `NOT_REACHED["${key}"] witness calls ${method} ${callUrl}, not its own route`;
  }

  /** Runs one CalledWitness through the real app exactly as the BY CONSTRUCTION test did
   *  inline before N68b r2 — extracted so a StructuralNoCreationWitness's optional
   *  `httpCheck` can reuse the identical call/assert path instead of a second copy. */
  async function runCalledWitness(key: string, w: CalledWitness): Promise<void> {
    const bearer = { authorization: `Bearer ${strangerKey}` };
    let callUrl = w.url;
    let callBody: unknown = w.body;

    if (callUrl.includes(":batchId")) {
      // The one entry whose blocker is live state, not a fixed id: discover the real seeded
      // batch id instead of guessing one (a synthetic id would 404 for an unrelated reason).
      const list = await app.inject({ method: "GET", url: "/api/batches", headers: { ...bearer, "x-forwarded-for": ip() } });
      const batches = (list.json().batches as Array<{ id: string }> | undefined) ?? [];
      const realId = batches[0]?.id;
      expect(realId, "witness setup: GET /api/batches must return the one seeded batch").toBeTruthy();
      callUrl = callUrl.replace(":batchId", encodeURIComponent(realId));
    }

    if (w.prepare) {
      const subs = await w.prepare({ app, key: strangerKey, ip });
      callUrl = substituteTokens(callUrl, subs);
      callBody = substituteTokens(callBody, subs);
    }

    const bindingError = witnessBindingError(key, w.method, callUrl);
    if (bindingError) throw new Error(bindingError);

    const headers: Record<string, string> = { "x-forwarded-for": ip() };
    if (!w.noAuth) Object.assign(headers, bearer);
    const res = await app.inject({ method: w.method, url: callUrl, headers, payload: callBody as object });

    if (res.statusCode >= 200 && res.statusCode < 300) {
      throw new Error(
        `NOT_REACHED["${key}"] claimed unreachable but reached: witness ${w.method} ${callUrl} ` +
        `returned ${res.statusCode}. body=${res.body.slice(0, 300)}`,
      );
    }
    expect(w.expect.status, `${key}: witness status (body=${res.body.slice(0, 200)})`).toContain(res.statusCode);
    if (w.expect.code) {
      let json: Record<string, unknown> = {};
      try {
        json = res.json();
      } catch {
        // non-JSON body — code match falls through to the raw body substring below.
      }
      const codeMatch = json.error === w.expect.code || json.code === w.expect.code || res.body.includes(w.expect.code);
      expect(codeMatch, `${key}: witness code "${w.expect.code}" (body=${res.body.slice(0, 200)})`).toBe(true);
    }
  }

  describe("witnessBindingError: pure matcher pins (N68b r2, astra r1 item 1a)", () => {
    it("binds when the real call satisfies its own :param pattern", () => {
      expect(witnessBindingError(
        "/api/jobs/:jobId/attestations/aggregate", "POST", "/api/jobs/job-abc123/attestations/aggregate",
      )).toBeNull();
    });
    it("rejects a :param shifted into the wrong segment position", () => {
      expect(witnessBindingError(
        "/api/jobs/:jobId/attestations/aggregate", "POST", "/api/jobs/attestations/job-abc123/aggregate",
      )).not.toBeNull();
    });
    it("rejects a completely different route — astra's own cheapest reproduction", () => {
      // The exact regression this guards: pointing the aggregate witness at the archive
      // witness's own URL (and expected 404/not_found) used to still pass.
      expect(witnessBindingError(
        "/api/jobs/:jobId/attestations/aggregate", "POST", "/api/evidence/n68b-witness-nonexistent-bundle/archive",
      )).not.toBeNull();
    });
    it("rejects a different method even on a textually-matching path", () => {
      expect(witnessBindingError(
        "/api/jobs/:jobId/attestations/aggregate", "GET", "/api/jobs/job-abc123/attestations/aggregate",
      )).not.toBeNull();
    });
  });

  it("BY CONSTRUCTION: every NOT_REACHED entry's witness proves its blocker, or proves the policy exclusion without ever calling it", async () => {
    for (const [url, entry] of Object.entries(NOT_REACHED)) {
      const w = entry.witness;

      if (isPolicyExclusionWitness(w)) {
        expect(entry.category, `${url}: witness hazard must equal the entry's own category`).toBe(w.hazard);
        expect(w.closedList, `${url}: must be a member of its own hazard's closed list`).toContain(url);
        const canonical =
          w.hazard === "real_subprocess" ? REAL_SUBPROCESS_NOT_REACHED_ROUTES : EXTERNAL_SERVICE_NOT_REACHED_ROUTES;
        expect(w.closedList, `${url}: closedList must be that hazard's own canonical list, not a copy`).toBe(canonical);
        continue; // Never called — see PolicyExclusionWitness's own docstring ("Don't call it").
      }

      if (isStructuralNoCreationWitness(w)) {
        const files = listProductionTsFiles(w.scanDir);
        const hits = files.filter((f) => w.callPattern.test(readFileSync(f, "utf8")));
        expect(
          hits,
          `${url}: structural witness found a call to ${w.repoMethod} in production source — ` +
            `the "no creation route" claim is now FALSE; this entry must become a dynamic fixture`,
        ).toEqual([]);
        if (w.httpCheck) await runCalledWitness(url, w.httpCheck);
        continue;
      }

      await runCalledWitness(url, w);
    }
  });
});
