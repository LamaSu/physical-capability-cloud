/**
 * Row-37 INTEGRATED proof — steward decision #5892 (genui 4df1e691, Opus design).
 *
 * This is the POSITIVE and NEGATIVE proof that makes ledger row 37 INTEGRATED once #495
 * (the ui:// resource prod-domain gate), #344 (the closed-IR render tool + binder/renderer)
 * and #348 (PX-4 provenance: fresh/stale/unavailable/absent/time-unknown) are merged. It
 * runs on THIS tree, recording its own `git rev-parse HEAD`, and lives in the repo so
 * anyone can rerun it.
 *
 * FROZEN CONSUMER INTERFACE this test pins:
 *   1. The IR manifest schema — `csd: "pcc://artifacts/dashboard/v1"`, the exact input of
 *      `dashboardManifestToIr` (src/mcp/dashboard-ir.ts) — delivered as
 *      `structuredContent.manifest` of the `render_pcc_dashboard_ir` tool result.
 *   2. The `ui://pcc/dashboard/render-ir` view (`MCP_APP_RENDER_IR_URI`,
 *      src/mcp/mcp-app-view.ts), served on `/mcp`, consumed by an MCP Apps host.
 *
 * Rerun (optionally dumping the proof record):
 *   PCC_ROW37_PROOF_OUT=/abs/path/proof.json \
 *     pnpm --dir packages/gateway exec vitest run src/__tests__/genui-row37-integration-proof.test.ts
 *
 * Shape — ONE Fastify app registers BOTH `/mcp` (httpMcpRoutes, which also carries the
 * plain HTTP mirror) and the real data routes (capabilities/kernels/jobs) over
 * `initStore({ seed: true })`:
 *
 *  POSITIVE (prod, OPEN gate — NODE_ENV=production, PCC_MCP_APP_DOMAIN=https://pcc-apps.example):
 *   P1 tools/list advertises render_pcc_dashboard_ir, linked (`_meta.ui.resourceUri`) to
 *      ui://pcc/dashboard/render-ir.
 *   P2 a manifest is built from REAL seeded ids (one capability, one kernel) picked by
 *      GETting /api/capabilities + /api/kernels via inject; tools/call renders it with no
 *      isError, and structuredContent.manifest deep-equals what was sent (the server-side
 *      projection, projectDashboardForMcpApp, is a no-op for metric/capability/list windows
 *      that carry no action/write fields).
 *   P3 resources/read on that URI returns the view HTML (the pcc-ir-root mount, the
 *      origin-injecting boot script).
 *   P4 an MCP Apps host (jsdom, runScripts:"dangerously", a fetch bridge onto `app.inject`,
 *      a fully fake clock/timers installed in beforeParse) loads that HTML exactly as a
 *      real host's iframe would — on the APP domain's own origin, which is deliberately
 *      NOT the kit's fixed data origin, proving the cross-origin fetch bridge.
 *   P5 the ui/initialize <-> ui/notifications/initialized handshake, then the P2 tool
 *      result delivered as ui/notifications/tool-result with the EXACT structuredContent
 *      /mcp returned.
 *   P6 every bound element shows the REAL seeded values. Measured fact: none of the three
 *      real routes exercised here (the kernel detail, the capability detail, the
 *      capabilities list) reports `asOf` — so the HONEST rendered state is "source time not
 *      reported" (time-unknown), never a false "fresh". Asserted, not assumed.
 *
 *  STATES (the SAME host; a per-path override map + the fake clock drive the rest):
 *   S1 STALE — an override delivers an already-overdue `asOf` to the metric and the list
 *      (budgets 120s / 300s, dashboard-ir.ts BIND_POLICY); both go `pcc-stale` with "...
 *      stale" on arrival. DEVIATION (documented, not silently skipped): the capability
 *      card's budget is 3 600 000 ms (1h) — longer than the whole binding session cap
 *      (BINDER_LIM.sessionMs = 30 min) — so it can never be observed going stale inside one
 *      session; this is asserted explicitly: it stays honestly time-unknown throughout.
 *   S2 UNAVAILABLE — HTTP 500 on the list's next poll clears its rows: "unavailable · HTTP 500".
 *   S3 ABSENT — a timed row missing its one profiled meta field ("type") shows PCC's "not
 *      reported" marker for that cell, never an empty one.
 *   S4 OFF-CONTRACT — a timed reply with no rows key at all is "unavailable · unexpected
 *      response shape" — never a fresh "none".
 *   S5 EMPTY — a timed reply in the route's real envelope shape with zero rows shows the
 *      `.pcc-empty` marker.
 *
 *  NEGATIVE (prod, CLOSED gate — PCC_MCP_APP_DOMAIN deleted => the `.invalid` placeholder):
 *   N1 tools/list does NOT include render_pcc_dashboard_ir (nor render_pcc_dashboard).
 *   N2 tools/call render_pcc_dashboard_ir returns isError with the gate message.
 *   N3 resources/read ui://pcc/dashboard/render-ir is refused.
 *   N4 the plain HTTP mirror (the shared D14 gate every ui:// read answers to) returns 503.
 *
 * THE PROOF RECORD: only if PCC_ROW37_PROOF_OUT is set, a JSON record (sha, when,
 * consumerInterface, positive, states, negative) is written once, after every assertion
 * above has already run (the env var changes nothing about what runs).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeStore, getRepos, initStore } from "../db.js";
import { httpMcpRoutes } from "../mcp/http-mcp-server.js";
import { MCP_APP_RENDER_IR_URI } from "../mcp/mcp-app-view.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { jobRoutes } from "../routes/jobs.js";
import { kernelRoutes } from "../routes/kernels.js";

// ── MCP JSON-RPC over app.inject (mirrors mcp-apps-readonly-surface.test.ts) ──────────────
const JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
interface McpSession {
  sessionId: string;
  protocolVersion: string;
}

async function initSession(app: FastifyInstance, mountPath: string): Promise<McpSession> {
  const res = await app.inject({
    method: "POST",
    url: mountPath,
    headers: JSON_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "row37-proof", version: "1.0.0" },
      },
    },
  });
  const sessionId = String(res.headers["mcp-session-id"]);
  const protocolVersion = res.json().result.protocolVersion as string;
  await app.inject({
    method: "POST",
    url: mountPath,
    headers: { ...JSON_HEADERS, "mcp-session-id": sessionId, "mcp-protocol-version": protocolVersion },
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  return { sessionId, protocolVersion };
}

async function rpc(
  app: FastifyInstance,
  mountPath: string,
  session: McpSession,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: "POST",
    url: mountPath,
    headers: {
      ...JSON_HEADERS,
      "mcp-session-id": session.sessionId,
      "mcp-protocol-version": session.protocolVersion,
    },
    payload: { jsonrpc: "2.0", ...payload },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

async function listTools(app: FastifyInstance, mountPath: string, session: McpSession): Promise<any[]> {
  const { body } = await rpc(app, mountPath, session, { id: 2, method: "tools/list", params: {} });
  return body.result.tools as any[];
}

// ── the MCP Apps host (jsdom) — a fetch bridge onto app.inject, a fully fake clock ───────
const PCC_API_ORIGIN = "https://capability.network"; // MCP_APP_API_BASE_URL (mcp-app-view.ts) — fixed, never the app domain
const APP_DOMAIN = "https://pcc-apps.example"; // this run's PCC_MCP_APP_DOMAIN — a DIFFERENT origin, on purpose (cross-origin proof)
const KIT_PROTOCOL = "2026-01-26"; // CAP.protocol, dashboard-ir-browser-entry.ts

// M6 fix (astra #565 r1): the FROZEN literal, never the mutable production import —
// every functional comparison below targets this literal. MCP_APP_RENDER_IR_URI is
// compared to it exactly once (a dedicated pin in P1), so a rename of the production
// constant's VALUE fails that pin directly instead of the whole suite silently
// "following" the rename.
const FROZEN_RENDER_IR_URI = "ui://pcc/dashboard/render-ir";
// M1 fix: the exact MCP Apps resource-content contract a conforming host relies on
// (mcp-app-view.ts MCP_APP_MIME_TYPE / MCP_APP_CSP_META), pinned as literals here —
// never read back from the same response being checked.
const FROZEN_RENDER_IR_MIME_TYPE = "text/html;profile=mcp-app";
const FROZEN_CONNECT_DOMAINS = ["https://capability.network"];
// M7 fix: pinned canonical-JSON SHA256 digest of render_pcc_dashboard_ir's advertised
// inputSchema (readDashboardManifestJsonSchema() via buildRenderIrDashboardTool,
// mcp-app-view.ts:1972-1981), computed below with canonicalJson+sha256Hex over the
// CURRENT schema at the time this proof was written. A DELIBERATE schema change (a new
// property, an altered constraint, a new window variant) requires updating this literal
// — that update IS the frozen-interface guarantee working as intended; an accidental or
// unreviewed drift fails this assertion instead of passing silently.
const FROZEN_RENDER_IR_INPUT_SCHEMA_SHA256 = "8f13ec9caf3c8972abd81beb158b5876836d59e36f4a067bc87d18fddde914c1";

/** Stable JSON serialization with recursively SORTED object keys, so the digest below
 *  depends only on the schema's values/structure, never on its property insertion order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// M5 fix: the closed set of provenance markers the renderer ever paints on a bound HOST
// element (dashboard-ir-renderer.ts CLS.fresh/stale/unavail/timeUnknown — "pcc-fresh" is
// included defensively: production code never paints it on the HOST today, only on the
// metadata LINE, but a regression that did would be exactly this hole). Exactly one of
// these (or, for a genuinely fresh non-stale read, NONE of them) may be on the host.
const PROVENANCE_MARKERS = ["pcc-fresh", "pcc-stale", "pcc-unavail", "pcc-time-unknown"] as const;
type ProvenanceMarker = (typeof PROVENANCE_MARKERS)[number];
/** The real CSS classes among PROVENANCE_MARKERS present on `el` — a token match (split on
 *  whitespace), never a substring match, so "pcc-stale" can't accidentally match some
 *  unrelated future class name. */
function provenanceMarkersOn(el: any): ProvenanceMarker[] {
  const classes = String(el.className).split(" ").filter(Boolean);
  return PROVENANCE_MARKERS.filter((m) => classes.includes(m));
}
/** M5 fix: assert the host carries EXACTLY the one expected provenance marker — never a
 *  simultaneous "pcc-fresh" alongside stale/unavailable/time-unknown — and never shows the
 *  empty marker while in one of these four non-empty-eligible states. */
function assertExclusiveProvenance(el: any, expected: ProvenanceMarker, label: string): void {
  expect(provenanceMarkersOn(el), `${label}: provenance markers on the host`).toEqual([expected]);
  expect(el.querySelector(".pcc-empty"), `${label}: must not show the empty marker`).toBeNull();
}

interface Reply {
  status: number;
  json?: unknown;
  raw?: string;
  ct?: string;
}

function replyToResponse(r: Reply): Promise<unknown> {
  const text = r.raw !== undefined ? r.raw : JSON.stringify(r.json ?? {});
  const bytes = new NodeTextEncoder().encode(text);
  let sent = false;
  return Promise.resolve({
    status: r.status,
    redirected: false,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? (r.ct ?? "application/json") : null) },
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
      }),
      cancel: async () => {},
    },
  });
}

interface Host {
  w: any;
  posted: unknown[];
  mount: any;
  overrides: Record<string, Reply>;
  now(): number;
  settle(): Promise<void>;
  advance(ms: number): Promise<void>;
  deliverInit(): Promise<void>;
  deliverToolResult(structuredContent: unknown): Promise<void>;
  q(sel: string): any;
  lineOf(el: any): any;
  close(): void;
}

/**
 * Load a REAL MCP Apps view HTML into jsdom exactly as a host's iframe would: a fully fake
 * clock/timers (never a real setTimeout — nothing here can leak a real pending handle), a
 * recorder for window.parent.postMessage (a top-level jsdom window is its own parent), and
 * a fetch bridge that accepts ONLY the kit's own fixed origin, maps path+query onto
 * `app.inject`, and takes a one-shot per-path override so a test can force a reply for
 * exactly the next poll of that path.
 *
 * `hostOrigin` (M1 fix) is the document origin a real host would frame this view under —
 * the CALLER derives it from the resource's own returned `_meta.ui.domain` (P3), never
 * from this test's hardcoded APP_DOMAIN constant, so the host simulation depends on what
 * production actually returned.
 */
function buildHost(app: FastifyInstance, html: string, startAt: number, hostOrigin: string): Host {
  let now = startAt;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let tid = 0;
  const posted: unknown[] = [];
  const overrides: Record<string, Reply> = {};

  const dom = new JSDOM(html, {
    url: hostOrigin + "/",
    runScripts: "dangerously",
    beforeParse(w: any) {
      w.setTimeout = (fn: () => void, ms?: number) => {
        const id = ++tid;
        timers.push({ id, at: now + (ms || 0), fn });
        return id;
      };
      w.clearTimeout = (id: number) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      };
      w.Date.now = () => now;
      w.TextDecoder = NodeTextDecoder;
      w.TextEncoder = NodeTextEncoder;
      // A top-level jsdom window is its own parent — record what the kit posts rather than
      // loop it back through the real (same-window) postMessage machinery.
      w.parent.postMessage = (m: unknown) => {
        posted.push(m);
      };
      w.fetch = (url: string) => {
        let u: URL;
        try {
          u = new URL(url);
        } catch {
          return Promise.reject(new TypeError("fetch bridge: unparseable URL " + String(url)));
        }
        if (u.origin !== PCC_API_ORIGIN) {
          return Promise.reject(new TypeError("fetch bridge refused a foreign origin: " + u.origin));
        }
        const forced = overrides[u.pathname];
        if (forced) {
          delete overrides[u.pathname];
          return replyToResponse(forced);
        }
        return app.inject({ method: "GET", url: u.pathname + u.search }).then((res) => {
          const ct = String(res.headers["content-type"] ?? "application/json").split(";")[0].trim();
          return replyToResponse({ status: res.statusCode, raw: res.body, ct });
        });
      };
    },
  });
  const w: any = dom.window;

  // Real (not fake) microtask + one macrotask flush. Safe to await for real: this never
  // touches the fake clock above, it only lets app.inject's own promise chain settle.
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      now = Math.max(now, due.at);
      due.fn();
      await settle();
    }
    now = end;
  };

  return {
    w,
    posted,
    overrides,
    mount: w.document.getElementById("pcc-ir-root"),
    now: () => now,
    settle,
    advance,
    async deliverInit() {
      w.dispatchEvent(
        new w.MessageEvent("message", {
          source: w.parent,
          data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: KIT_PROTOCOL } },
        }),
      );
      await settle();
    },
    async deliverToolResult(structuredContent: unknown) {
      // A real host delivers the manifest via postMessage, which structured-clones it into
      // the view's realm. structuredContent here was built in THIS (Node) realm — its plain
      // objects carry Node's Object.prototype, not the jsdom window's — so the kit's isPlain
      // guard would (correctly) reject it as foreign. Clone it through the window's OWN
      // JSON first, exactly as a real postMessage would (and as dashboard-ir-kit.browser.test.ts
      // does for the same reason).
      const cloned = w.JSON.parse(w.JSON.stringify(structuredContent));
      w.dispatchEvent(
        new w.MessageEvent("message", {
          source: w.parent,
          data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: cloned } },
        }),
      );
      await settle();
    },
    q: (sel: string) => w.document.querySelector(sel),
    lineOf: (el: any) => el?.nextElementSibling ?? null,
    close: () => w.close(),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ── accumulated proof record (written once, at file end, iff PCC_ROW37_PROOF_OUT is set) ──
const proofRecord: {
  positive: Record<string, unknown>;
  states: Record<string, unknown>;
  negative: Record<string, unknown>;
} = { positive: {}, states: {}, negative: {} };

function snapshotElement(el: any, host: Host): { classList: string[]; value: string | null; line: string | null } {
  if (!el) return { classList: [], value: null, line: null };
  const valueEl = el.querySelector(".pcc-value");
  const line = host.lineOf(el);
  return {
    classList: String(el.className).split(" ").filter(Boolean),
    value: valueEl ? (valueEl.textContent as string) : null,
    line: line ? (line.textContent as string) : null,
  };
}

// ====================================================================================
// POSITIVE + STATES — prod, OPEN gate. One continuous proof sequence (P1..P6, S1..S5)
// sharing one app + one host, exactly as the brief frames it ("the same host").
// ====================================================================================
describe("row-37 proof: POSITIVE + STATES (prod, open gate)", () => {
  const SAVED: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    PCC_MCP_APP_DOMAIN: process.env.PCC_MCP_APP_DOMAIN,
    PCC_API_BASE_URL: process.env.PCC_API_BASE_URL,
    PCC_DEPLOYMENT_ENV: process.env.PCC_DEPLOYMENT_ENV,
    // M8 fix (astra #565 r1): db.ts:31-48 prefers DATABASE_URL, then a Railway volume
    // mount, then PCC_DB_PATH — vitest.setup.ts sets PCC_DB_PATH only when it is ABSENT,
    // so an ambient DATABASE_URL/RAILWAY_VOLUME_MOUNT_PATH would otherwise be inherited
    // and this proof would run against a real/persistent store instead of the seeded
    // in-memory one. Save + force all three below; restored by the same loop as the rest.
    DATABASE_URL: process.env.DATABASE_URL,
    RAILWAY_VOLUME_MOUNT_PATH: process.env.RAILWAY_VOLUME_MOUNT_PATH,
    PCC_DB_PATH: process.env.PCC_DB_PATH,
  };
  let app: FastifyInstance;
  let host: Host | null = null;

  // Threaded across the its below by design (see header): P2 picks real ids + builds the
  // manifest; P3 fetches the view HTML; P4-P6 boot the host and render it; S1-S5 drive the
  // SAME host through the rest of the states.
  let capRow: any;
  let kernelRow: any;
  let kernelDetail: any;
  let listBody: any;
  let manifest: Record<string, unknown>;
  let viewHtml: string;
  let hostDomain: string; // M1 fix: read from the resource's own _meta.ui.domain in P3
  let toolResultStructured: unknown;
  // M2 fix: expectations anchored to the seeded REPOSITORY (getRepos(), src/db.ts),
  // independent of the route responses being rendered — set in P2, used from P6 on.
  let expectedCapName: string;
  let expectedCapType: string;
  let expectedCapabilityCount: number;

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    process.env.PCC_MCP_APP_DOMAIN = APP_DOMAIN;
    // The upstream-proxy base gate runs BEFORE the domain gate; give it a valid, isolated
    // base (mirrors mcp-apps-readonly-surface.test.ts) so this suite exercises the DOMAIN
    // gate, not an incidental base-gate failure.
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app";
    // M8 fix: force the in-memory, ephemeral store regardless of the ambient environment.
    delete process.env.DATABASE_URL;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
    process.env.PCC_DB_PATH = ":memory:";

    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register(capabilityRoutes);
    await app.register(kernelRoutes);
    await app.register(jobRoutes);
    await app.register(httpMcpRoutes); // /mcp + the plain HTTP mirror
    await app.ready();
  });

  afterAll(async () => {
    host?.close();
    await app.close();
    closeStore();
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("P1: tools/list on /mcp advertises render_pcc_dashboard_ir, linked to ui://pcc/dashboard/render-ir", async () => {
    // M6 fix: pin the constant itself, once, against the frozen literal — independent of
    // every other comparison below (which all target the literal directly, never the
    // import, so a rename of the production constant's VALUE cannot make the rest of this
    // test silently "follow" it).
    expect(MCP_APP_RENDER_IR_URI).toBe(FROZEN_RENDER_IR_URI);

    const session = await initSession(app, "/mcp");
    const tools = await listTools(app, "/mcp", session);
    const tool = tools.find((t) => t.name === "render_pcc_dashboard_ir");
    expect(tool).toBeDefined();
    // M7 fix: pin the literal tool name.
    expect(tool.name).toBe("render_pcc_dashboard_ir");
    const link = tool._meta?.ui?.resourceUri ?? tool._meta?.["ui/resourceUri"];
    expect(link).toBe(FROZEN_RENDER_IR_URI);
    // M7 fix: pin the exact advertised inputSchema as a canonical-JSON SHA256 digest, so
    // compatible-looking drift (an added optional property, a loosened constraint, a new
    // window variant) fails here instead of passing because P2 only samples one manifest
    // shape. See FROZEN_RENDER_IR_INPUT_SCHEMA_SHA256's comment for what to do when this
    // assertion fails on a DELIBERATE schema change.
    const schemaDigest = sha256Hex(canonicalJson(tool.inputSchema));
    expect(schemaDigest).toBe(FROZEN_RENDER_IR_INPUT_SCHEMA_SHA256);

    proofRecord.positive.p1 = link === FROZEN_RENDER_IR_URI;
  });

  it("P2: a manifest built from REAL seeded ids renders via render_pcc_dashboard_ir (structuredContent.manifest equals what was sent)", async () => {
    const capsRes = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(capsRes.statusCode).toBe(200);
    listBody = capsRes.json();
    expect(Array.isArray(listBody.items)).toBe(true);
    expect(listBody.items.length).toBeGreaterThan(0);
    // The adapter's reserved-collision guard (ID_SEG, dashboard-ir.ts) refuses a detail-route
    // id that is itself a "pure lowercase-alpha(-hyphen) word" — that shape is reserved for
    // collection/status/verb sibling routes (types/templates/search/graph-stats/...), so a
    // bindable id must carry a digit, underscore, uppercase letter, or 0x-prefix. Several
    // seeded ids (e.g. "cap-bio-liquid") are pure-alpha and would be refused as a binding
    // path; pick one that the adapter actually accepts.
    const isBindableId = (id: unknown): boolean => typeof id === "string" && id.length > 0 && !/^[a-z]+(-[a-z]+)*$/.test(id);
    capRow = listBody.items.find((c: any) => isBindableId(c.id));
    expect(capRow, "no seeded capability id passes the adapter's ID_SEG grammar").toBeDefined();

    const kernelsRes = await app.inject({ method: "GET", url: "/api/kernels" });
    expect(kernelsRes.statusCode).toBe(200);
    const kernelsBody = kernelsRes.json();
    expect(Array.isArray(kernelsBody.kernels)).toBe(true);
    expect(kernelsBody.kernels.length).toBeGreaterThan(0);
    kernelRow = kernelsBody.kernels.find((k: any) => isBindableId(k.id));
    expect(kernelRow, "no seeded kernel id passes the adapter's ID_SEG grammar").toBeDefined();

    const kernelDetailRes = await app.inject({ method: "GET", url: `/api/kernels/${kernelRow.id}` });
    expect(kernelDetailRes.statusCode).toBe(200);
    kernelDetail = kernelDetailRes.json();
    expect(kernelDetail.kernel).toBeDefined();

    // Measured, not assumed: neither the kernel detail nor the capabilities list carries
    // `asOf` — this is WHY P6 below expects honest time-unknown, never a false "fresh".
    expect(Object.prototype.hasOwnProperty.call(kernelDetail, "asOf")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(listBody, "asOf")).toBe(false);

    // M2 fix: anchor the EXPECTED values to the seeded REPOSITORY directly (getRepos(),
    // src/db.ts), independent of the route responses this test is about to render — a
    // route/populator bug that returns an internally-consistent but WRONG value (an
    // arbitrary capabilityCount, a swapped-but-valid capability) cannot pass silently,
    // because the comparison basis never comes from the same response being checked.
    const repoCapabilities = getRepos().capabilities.findAll();
    const repoCapRow = repoCapabilities.find((c) => c.id === capRow.id);
    expect(repoCapRow, "capRow must exist in the seeded repository, independent of the route").toBeDefined();
    expect(capRow.name).toBe(repoCapRow!.name);
    expect(capRow.type).toBe(repoCapRow!.type);
    // M4 fix: prove the chosen row genuinely HAS an own, valid `type` TODAY — so S3's later
    // removal of it is a real present -> absent transition, not a field that was already
    // missing (which would make P6 and S3 both pass vacuously).
    expect(typeof repoCapRow!.type, "capRow.type must be an own, valid string before S3 removes it").toBe("string");
    expect(repoCapRow!.type.length).toBeGreaterThan(0);
    expectedCapName = repoCapRow!.name;
    expectedCapType = repoCapRow!.type;
    expectedCapabilityCount = repoCapabilities.filter((c) => c.kernelId === kernelRow.id).length;
    expect(expectedCapabilityCount, "the seeded kernel must own at least one capability").toBeGreaterThan(0);

    manifest = {
      csd: "pcc://artifacts/dashboard/v1",
      title: "Row-37 proof dashboard",
      sections: [
        {
          windows: [
            {
              kind: "metric",
              label: "Capabilities on kernel",
              select: "capabilityCount",
              binding: { path: `/api/kernels/${kernelRow.id}` },
            },
            { kind: "capability", binding: { path: `/api/capabilities/${capRow.id}` } },
            {
              kind: "list",
              binding: { path: "/api/capabilities" },
              item: { title: "name", meta: ["type"], statusFrom: "available" },
            },
          ],
        },
      ],
    };

    // M7 fix: pin the literal CSD this interface is frozen to — a deliberate change here
    // requires updating this test, which IS the frozen-interface guarantee.
    expect(manifest.csd).toBe("pcc://artifacts/dashboard/v1");

    const session = await initSession(app, "/mcp");
    const call = await rpc(app, "/mcp", session, {
      id: 10,
      method: "tools/call",
      params: { name: "render_pcc_dashboard_ir", arguments: manifest },
    });
    expect(call.body.result.isError).not.toBe(true);
    // M7 fix: pin the literal structured-content field name, not just its value.
    expect(Object.prototype.hasOwnProperty.call(call.body.result.structuredContent, "manifest")).toBe(true);
    expect(call.body.result.structuredContent.manifest).toEqual(manifest);
    toolResultStructured = call.body.result.structuredContent;

    proofRecord.positive.p2 = call.body.result.isError !== true;
    proofRecord.positive.manifest = manifest;
  });

  it("P3: resources/read ui://pcc/dashboard/render-ir returns the view HTML (mount point + origin boot script)", async () => {
    const session = await initSession(app, "/mcp");
    const read = await rpc(app, "/mcp", session, {
      id: 11,
      method: "resources/read",
      params: { uri: FROZEN_RENDER_IR_URI },
    });
    expect(read.body.error).toBeUndefined();
    const content = read.body.result.contents[0];
    // M1 fix: a conforming MCP Apps host reads the FULL resource-content contract, not
    // just the HTML text (mcp-app-view.ts:1549-1550, mcpAppUiResourceMeta()) — the literal
    // URI, the literal MCP App MIME type, the CONFIGURED per-view domain (D14 storage
    // isolation), and the fixed CSP connect-src the kit's fetches are declared against.
    expect(content.uri).toBe(FROZEN_RENDER_IR_URI);
    expect(content.mimeType).toBe(FROZEN_RENDER_IR_MIME_TYPE);
    expect(content._meta?.ui?.domain).toBe(APP_DOMAIN);
    expect(content._meta?.ui?.csp?.connectDomains).toEqual(FROZEN_CONNECT_DOMAINS);

    const html = content.text as string;
    expect(html).toContain('id="pcc-ir-root"');
    expect(html).toContain("__PCC_IR_ORIGIN__");
    viewHtml = html;
    // M1 fix: the host (P4) is built from THIS returned domain, never the test's own
    // hardcoded constant — even though they're equal here, the host simulation now
    // depends on what production actually returned, not on an assumption.
    hostDomain = content._meta.ui.domain;
    proofRecord.positive.p3 = typeof html === "string" && html.length > 0;
  });

  it("P4-P6, the HOST: renders the real seeded data — honestly time-unknown, never a false 'fresh'", async () => {
    host = buildHost(app, viewHtml, Date.parse("2026-10-03T00:00:00.000Z"), hostDomain);

    // P4: jsdom (runScripts:"dangerously") executes the outer boot <script> synchronously
    // during construction, which injects+runs the kit <script>, which calls boot() — by the
    // time `new JSDOM` returns, the kit has already announced itself.
    expect(
      host.posted.some((m: any) => m?.method === "ui/initialize" && m.params?.appInfo?.name === "pcc-dashboard-ir"),
    ).toBe(true);

    // P5: the handshake, then the P2 tool result delivered exactly as /mcp returned it.
    await host.deliverInit();
    expect(host.posted.some((m: any) => m?.method === "ui/notifications/initialized")).toBe(true);
    await host.deliverToolResult(toolResultStructured);

    const stat = host.q(".pcc-stat");
    const card = host.q(".pcc-schema-card");
    const list = host.q(".pcc-list");
    expect(stat, "metric element").not.toBeNull();
    expect(card, "capability card element").not.toBeNull();
    expect(list, "list element").not.toBeNull();

    // P6, the honest rule: every read succeeded (never unavailable), and none is shown as
    // fresh without a source time. M5 fix: assert the provenance markers are MUTUALLY
    // EXCLUSIVE (never a stray "pcc-fresh" alongside "pcc-time-unknown") and that nothing
    // shows the empty marker while honestly time-unknown.
    for (const [name, el] of [["metric", stat], ["capability", card], ["list", list]] as const) {
      expect(el.getAttribute("data-as-of"), name).toBeNull();
      assertExclusiveProvenance(el, "pcc-time-unknown", name);
      expect(host.lineOf(el)!.textContent, name).toContain("source time not reported");
    }
    // M2 fix: compared against the REPOSITORY-anchored expectations from P2, never against
    // the same route response being rendered.
    expect(stat.querySelector(".pcc-value").textContent).toBe(String(expectedCapabilityCount));
    expect(card.textContent).toContain(expectedCapName);
    expect(list.querySelectorAll(".pcc-row").length).toBeGreaterThan(0);
    expect(list.textContent).toContain(expectedCapName);
    // M4 fix: the real, present `type` field renders — no absent marker — so S3's later
    // removal of it is a genuine present -> absent transition, not a pre-existing gap.
    expect(list.querySelectorAll(".pcc-absent").length, "P6 must show the real type field, not absent").toBe(0);
    expect(list.textContent).toContain(expectedCapType);

    proofRecord.states.p6 = {
      metric: snapshotElement(stat, host),
      capability: snapshotElement(card, host),
      list: snapshotElement(list, host),
    };
  });

  it("S1 STALE: an already-overdue asOf drives the metric and the list visibly pcc-stale on arrival", async () => {
    const h = host!;
    const base = h.now();
    const METRIC_MAX_AGE_MS = 120_000; // BIND_POLICY.metric.maxAgeMs (dashboard-ir.ts)
    const LIST_MAX_AGE_MS = 300_000; // BIND_POLICY.list.maxAgeMs
    const MARGIN_MS = 10_000;

    h.overrides[`/api/kernels/${kernelRow.id}`] = {
      status: 200,
      json: { ...kernelDetail, asOf: iso(base - (METRIC_MAX_AGE_MS + MARGIN_MS)) },
    };
    h.overrides["/api/capabilities"] = {
      status: 200,
      json: { ...listBody, asOf: iso(base - (LIST_MAX_AGE_MS + MARGIN_MS)) },
    };
    await h.advance(65_000); // >= one poll tick (default cadence 30s, worst-case backoff 60s)

    const stat = h.q(".pcc-stat");
    const card = h.q(".pcc-schema-card");
    const list = h.q(".pcc-list");

    // M5 fix: exactly one provenance marker, never a stray "pcc-fresh" alongside "stale",
    // and no empty marker while stale.
    assertExclusiveProvenance(stat, "pcc-stale", "metric");
    expect(h.lineOf(stat)!.textContent).toContain("stale");
    expect(stat.getAttribute("data-as-of")).not.toBeNull(); // now genuinely timed (just old)

    assertExclusiveProvenance(list, "pcc-stale", "list");
    expect(h.lineOf(list)!.textContent).toContain("stale");
    expect(list.querySelectorAll(".pcc-row").length).toBeGreaterThan(0); // stale != cleared

    // DEVIATION (documented): the capability card's maxAgeMs (3 600 000 ms = 1h) exceeds
    // BINDER_LIM.sessionMs (30 min, dashboard-ir-binder.ts) — it cannot be observed going
    // stale inside one binding session, by construction. It must still never be falsely
    // "fresh": asserted here to stay exactly P6's honest time-unknown.
    assertExclusiveProvenance(card, "pcc-time-unknown", "capability");
    expect(h.lineOf(card)!.textContent).toContain("source time not reported");

    proofRecord.states.s1 = {
      metric: snapshotElement(stat, h),
      capability: snapshotElement(card, h),
      list: snapshotElement(list, h),
    };
  });

  it("S2 UNAVAILABLE: HTTP 500 on the list's next poll clears its rows", async () => {
    const h = host!;
    h.overrides["/api/capabilities"] = { status: 500 };
    await h.advance(65_000);

    const list = h.q(".pcc-list");
    expect(list.querySelectorAll(".pcc-row").length).toBe(0);
    // M5 fix: exactly "pcc-unavail", never alongside a stray "pcc-fresh"; no empty marker.
    assertExclusiveProvenance(list, "pcc-unavail", "list");
    expect(h.lineOf(list)!.textContent).toBe("unavailable · HTTP 500");

    proofRecord.states.s2 = { list: snapshotElement(list, h) };
  });

  it("S3 ABSENT: a timed row missing its one profiled meta field shows 'not reported', never an empty cell", async () => {
    const h = host!;
    // M4 fix: P2 already proved (via the seeded repository, independent of this route)
    // that this row's `type` is a real, present, non-empty field — so dropping it here is
    // a genuine present -> absent transition, not a field P6 never actually exercised.
    expect(Object.prototype.hasOwnProperty.call(capRow, "type")).toBe(true);
    expect(capRow.type).toBe(expectedCapType);
    const { type: _droppedType, ...rowWithoutType } = capRow;
    h.overrides["/api/capabilities"] = {
      status: 200,
      json: { ...listBody, items: [rowWithoutType], asOf: iso(h.now()) },
    };
    await h.advance(65_000);

    const list = h.q(".pcc-list");
    expect(list.className).not.toContain("pcc-unavail");
    const row = list.querySelector(".pcc-row");
    expect(row).not.toBeNull();
    expect(row.textContent).toContain(capRow.name);
    const absent = Array.from(row.querySelectorAll(".pcc-absent")) as any[];
    expect(absent.length).toBe(1);
    expect(absent[0].textContent).toBe("not reported");

    proofRecord.states.s3 = { list: snapshotElement(list, h) };
  });

  it("S4 OFF-CONTRACT: a timed reply with no rows key is unavailable, never a fresh 'none'", async () => {
    const h = host!;
    h.overrides["/api/capabilities"] = { status: 200, json: { asOf: iso(h.now()) } };
    await h.advance(65_000);

    const list = h.q(".pcc-list");
    // M5 fix: exactly "pcc-unavail" (the helper also asserts no .pcc-empty), never a
    // simultaneous stray "pcc-fresh" that would make this look like a fresh "none".
    assertExclusiveProvenance(list, "pcc-unavail", "list");
    expect(h.lineOf(list)!.textContent).toBe("unavailable · unexpected response shape");

    proofRecord.states.s4 = { list: snapshotElement(list, h) };
  });

  it("S5 EMPTY: a timed reply in the route's real shape with zero rows shows the empty marker", async () => {
    const h = host!;
    // The route's real envelope for an EMPTY collection reports total 0. N110 claims "none" only when
    // the paging evidence vouches for the whole collection; zero rows under a nonzero total is "no rows
    // in this window" (pinned in dashboard-ir-list-window.test.ts), so the total must say 0 here too.
    h.overrides["/api/capabilities"] = { status: 200, json: { ...listBody, items: [], total: 0, hasMore: false, asOf: iso(h.now()) } };
    await h.advance(65_000);

    const list = h.q(".pcc-list");
    // S5 is a genuinely fresh (timed, valid) read: NONE of the four provenance markers —
    // the brief's M5 fix calls out S5 specifically as the one state where .pcc-empty MUST
    // be present; a fresh non-stale read carries no marker class on the host at all.
    expect(provenanceMarkersOn(list), "list").toEqual([]);
    const empty = list.querySelector(".pcc-empty");
    expect(empty).not.toBeNull();
    expect(empty.textContent).toBe("none");

    proofRecord.states.s5 = { list: snapshotElement(list, h) };
  });
});

// ====================================================================================
// NEGATIVE — prod, CLOSED gate (PCC_MCP_APP_DOMAIN unset => the .invalid placeholder).
// No store/data routes needed: these are gate checks only.
// ====================================================================================
describe("row-37 proof: NEGATIVE (prod, closed gate)", () => {
  const SAVED: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    PCC_MCP_APP_DOMAIN: process.env.PCC_MCP_APP_DOMAIN,
    PCC_API_BASE_URL: process.env.PCC_API_BASE_URL,
    PCC_DEPLOYMENT_ENV: process.env.PCC_DEPLOYMENT_ENV,
  };
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.NODE_ENV = "production";
    delete process.env.PCC_MCP_APP_DOMAIN; // resolveMcpAppDomain() -> the .invalid placeholder
    process.env.PCC_DEPLOYMENT_ENV = "staging";
    process.env.PCC_API_BASE_URL = "https://pcc-gateway-staging.up.railway.app";

    app = Fastify({ logger: false });
    await app.register(httpMcpRoutes); // /mcp + the plain HTTP mirror (registerMcpAppHttpRoute)
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("N1: tools/list does NOT include render_pcc_dashboard_ir (nor render_pcc_dashboard)", async () => {
    const session = await initSession(app, "/mcp");
    const tools = await listTools(app, "/mcp", session);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("render_pcc_dashboard_ir");
    expect(names).not.toContain("render_pcc_dashboard");
    // M3 fix: prove SELECTIVE removal, not a total surface failure (a closed-gate
    // tools/list that returned [] would otherwise pass this check vacuously) — a stable,
    // always-present read tool (also asserted present on the full surface by
    // mcp-apps-readonly-surface.test.ts's "REGRESSION" case) must still be listed.
    expect(names).toContain("list_kernels");
    proofRecord.negative.n1 = {
      toolAbsent: !names.includes("render_pcc_dashboard_ir") && !names.includes("render_pcc_dashboard"),
      nonViewToolPresent: names.includes("list_kernels"),
    };
  });

  it("N2: tools/call render_pcc_dashboard_ir returns isError with the gate message", async () => {
    const session = await initSession(app, "/mcp");
    const call = await rpc(app, "/mcp", session, {
      id: 20,
      method: "tools/call",
      params: {
        name: "render_pcc_dashboard_ir",
        arguments: { csd: "pcc://artifacts/dashboard/v1", title: "x", sections: [] },
      },
    });
    expect(call.body.result.isError).toBe(true);
    const message = call.body.result.content[0].text as string;
    expect(message).toContain("MCP App surface unavailable");
    proofRecord.negative.n2 = { isError: call.body.result.isError === true, message };
  });

  it("N3: resources/read ui://pcc/dashboard/render-ir is refused", async () => {
    const session = await initSession(app, "/mcp");
    const read = await rpc(app, "/mcp", session, {
      id: 21,
      method: "resources/read",
      params: { uri: FROZEN_RENDER_IR_URI },
    });
    expect(read.body.result).toBeUndefined();
    const message = read.body.error.message as string;
    expect(message).toContain("MCP App surface unavailable");
    proofRecord.negative.n3 = { refused: read.body.result === undefined, message };
  });

  it("N4: the plain HTTP mirror (the shared D14 gate) returns 503", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/mcp-apps/ui/dashboard",
      headers: { host: "capability.network" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("MCP App surface unavailable");
    expect(res.body).not.toMatch(/<html|<script/i);
    proofRecord.negative.n4 = { status: res.statusCode, body: res.body };
  });
});

// ── the proof record — written once, after every describe above has completed ────────────
afterAll(() => {
  const out = process.env.PCC_ROW37_PROOF_OUT;
  if (!out) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
  const record = {
    sha,
    when: new Date().toISOString(),
    consumerInterface: {
      manifest:
        'IR manifest schema — csd: "pcc://artifacts/dashboard/v1", the input of dashboardManifestToIr ' +
        "(src/mcp/dashboard-ir.ts), delivered as structuredContent.manifest of the render_pcc_dashboard_ir tool result",
      view: `${MCP_APP_RENDER_IR_URI} (MCP_APP_RENDER_IR_URI, src/mcp/mcp-app-view.ts) on /mcp, consumed by an MCP Apps host`,
    },
    positive: proofRecord.positive,
    states: proofRecord.states,
    negative: proofRecord.negative,
  };
  writeFileSync(out, JSON.stringify(record, null, 2));
});
