/**
 * MCP Apps security hardening — audit remediation round 2 (directives 10-13).
 *
 *  - 10: dashboard action/origin restriction + honest approval (pcc-ui.js).
 *        The kit is a no-build browser IIFE, so its security-pure helpers are
 *        extracted from source and evaluated directly (node, no DOM needed).
 *  - 11: textContent-only static lint over the kit + the view builder.
 *  - 12: CSP — no unsafe-eval/-inline scripts (nonce+strict-dynamic), no
 *        frame-ancestors in <meta>, real header on the HTTP mirror, no ACAO:*.
 *  - 13: slug entropy (≥96 bits) + failed-lookup rate limiting + no
 *        private-existence reveal on the public share surface.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_CSD_URL, type UiArtifact } from "@pcc/spec";
import {
  buildMcpAppCsp,
  cspNonce,
  MCP_APP_FRAME_ANCESTORS,
  registerMcpAppHttpRoute,
  renderSavedDashboardHtml,
} from "../mcp/mcp-app-view.js";
import {
  artifactsRoutes,
  _clearArtifactsForTests,
  _seedArtifactForTests,
  _resetPublicLookupLimiterForTests,
  publicLookupThrottled,
  notePublicLookupFailure,
} from "../routes/artifacts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const PCC_UI_PATH = resolve(REPO_ROOT, "apps/dashboard/public/ui-kit/v1/pcc-ui.js");
const MCP_APP_VIEW_PATH = resolve(HERE, "..", "mcp", "mcp-app-view.ts");

const PCC_UI_SRC = readFileSync(PCC_UI_PATH, "utf8");
const MCP_APP_VIEW_SRC = readFileSync(MCP_APP_VIEW_PATH, "utf8");
const PCC_ORIGIN = "https://capability.network";

// ---------------------------------------------------------------------------
// Extract the kit's security-pure helpers from source (no DOM). Each helper is
// a self-contained named function; a brace-matched slice + `new Function`
// evaluates them together with only the one constant they close over.
// ---------------------------------------------------------------------------

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`kit fn not found: ${name}`);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

interface KitFns {
  isAbsoluteOrSchemeUrl(p: string): boolean;
  safeApiPath(path: string, isHost: boolean): string | null;
  resolveApiBase(manifest: unknown, isHost: boolean): string;
  describeRealRequest(
    apiBase: string,
    action: unknown,
    body: unknown,
    isHost: boolean,
  ): { method: string; destination: string | null; amount: unknown; asset: unknown; refId: unknown };
}

const kit: KitFns = (() => {
  const bundle = [
    `var API_DEFAULT = ${JSON.stringify(PCC_ORIGIN)};`,
    extractFn(PCC_UI_SRC, "isAbsoluteOrSchemeUrl"),
    extractFn(PCC_UI_SRC, "safeApiPath"),
    extractFn(PCC_UI_SRC, "resolveApiBase"),
    extractFn(PCC_UI_SRC, "describeRealRequest"),
    "return { isAbsoluteOrSchemeUrl:isAbsoluteOrSchemeUrl, safeApiPath:safeApiPath, resolveApiBase:resolveApiBase, describeRealRequest:describeRealRequest };",
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(bundle)() as KitFns;
})();

// ===========================================================================
// Directive 10 — origin forcing, path safety, honest approval.
// ===========================================================================

describe("directive 10 — MCP-App/host mode FORCES the PCC origin", () => {
  it("ignores manifest.api_base in host mode and uses the fixed PCC origin", () => {
    expect(kit.resolveApiBase({ api_base: "https://evil.example" }, true)).toBe(PCC_ORIGIN);
    expect(kit.resolveApiBase({ api_base: "https://evil.example/api" }, true)).toBe(PCC_ORIGIN);
    // Non-host: a manifest api_base is still honored (kept for the standalone shell).
    expect(kit.resolveApiBase({ api_base: "https://capability.network" }, false)).toBe(PCC_ORIGIN);
  });
});

describe("directive 10 — safeApiPath rejects unsafe manifest paths", () => {
  it("passes ordinary root-relative PCC paths", () => {
    expect(kit.safeApiPath("/api/jobs/abc", false)).toBe("/api/jobs/abc");
    expect(kit.safeApiPath("/api/escrow/e1/release", true)).toBe("/api/escrow/e1/release");
    expect(kit.safeApiPath("/api/jobs?status=active", true)).toBe("/api/jobs?status=active");
    expect(kit.safeApiPath("/sse/stream/job/1", true)).toBe("/sse/stream/job/1");
  });

  it("rejects absolute URLs, scheme URLs, and protocol-relative //host", () => {
    expect(kit.safeApiPath("https://evil.example/api/x", true)).toBeNull();
    expect(kit.safeApiPath("http://evil.example/api/x", false)).toBeNull();
    expect(kit.safeApiPath("//evil.example/api/x", true)).toBeNull();
    expect(kit.safeApiPath("javascript:alert(1)", false)).toBeNull();
    expect(kit.safeApiPath("data:text/html,x", false)).toBeNull();
  });

  it("rejects path traversal — literal and percent-encoded", () => {
    expect(kit.safeApiPath("/api/../../etc/passwd", true)).toBeNull();
    expect(kit.safeApiPath("/api/%2e%2e/%2e%2e/secret", true)).toBeNull();
    expect(kit.safeApiPath("/api/x/..%2f..", true)).toBeNull();
    expect(kit.safeApiPath("/api/./x", true)).toBeNull();
    expect(kit.safeApiPath("/api/x\\..\\y", true)).toBeNull();
  });

  it("rejects non-root-relative and malformed paths", () => {
    expect(kit.safeApiPath("api/jobs", true)).toBeNull();
    expect(kit.safeApiPath("", true)).toBeNull();
    expect(kit.safeApiPath("/api/%zz", true)).toBeNull(); // malformed %-escape
  });

  it("host mode enforces the PCC /api|/sse operation-namespace allowlist", () => {
    // Non-namespace root paths are refused ONLY in host mode.
    expect(kit.safeApiPath("/internal/admin", true)).toBeNull();
    expect(kit.safeApiPath("/", true)).toBeNull();
    expect(kit.safeApiPath("/etc/passwd", true)).toBeNull();
    // Same paths are allowed in a non-host (user's own) context.
    expect(kit.safeApiPath("/internal/admin", false)).toBe("/internal/admin");
  });
});

describe("directive 10 — describeRealRequest shows the TRUTH, not the label", () => {
  it("derives method/destination/amount/asset/ref from the ACTUAL request", () => {
    const action = { kind: "post", path: "/api/escrow/esc_42/release", label: "Approve tiny $1 tip" };
    const body = { amount: 9999, currency: "USDC", escrowId: "esc_42" };
    const desc = kit.describeRealRequest(PCC_ORIGIN, action, body, true);
    expect(desc.method).toBe("POST");
    expect(desc.destination).toBe(`${PCC_ORIGIN}/api/escrow/esc_42/release`);
    // The real amount wins over a misleading "$1 tip" label.
    expect(desc.amount).toBe(9999);
    expect(desc.asset).toBe("USDC");
    expect(desc.refId).toBe("esc_42");
  });

  it("marks the destination BLOCKED when the action path is unsafe (host mode)", () => {
    const action = { kind: "patch", path: "https://evil.example/drain", label: "Confirm" };
    const desc = kit.describeRealRequest(PCC_ORIGIN, action, {}, true);
    expect(desc.method).toBe("PATCH");
    expect(desc.destination).toBeNull(); // renderer shows "BLOCKED — unsafe or non-PCC destination"
  });

  it("resolves the destination against the FORCED origin (a forged api_base can't redirect it)", () => {
    // In host mode the caller passes the forced origin; the manifest's api_base is
    // never used to build the destination shown to the human.
    const forced = kit.resolveApiBase({ api_base: "https://evil.example" }, true);
    const desc = kit.describeRealRequest(forced, { kind: "post", path: "/api/pay" }, { amount: 5 }, true);
    expect(desc.destination).toBe(`${PCC_ORIGIN}/api/pay`);
  });
});

// ===========================================================================
// Directive 11 — textContent-only static lint.
// ===========================================================================

describe("directive 11 — kit stays textContent-only (static lint)", () => {
  // USAGE patterns carry the syntactic '.'/'(' that the prose comments
  // ("no innerHTML", "no eval") deliberately lack, so comments don't false-trip.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["innerHTML assignment/use", /\.innerHTML\b/],
    ["outerHTML use", /\.outerHTML\b/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\.write\b/],
    ["eval(", /\beval\s*\(/],
    ["new Function(", /new\s+Function\s*\(/],
    ["srcdoc", /\bsrcdoc\b/i],
    ["javascript: URL", /javascript:/i],
  ];

  it("pcc-ui.js contains none of the dangerous HTML/JS sinks", () => {
    for (const [label, pat] of FORBIDDEN) {
      expect(pat.test(PCC_UI_SRC), `pcc-ui.js must not contain ${label}`).toBe(false);
    }
  });

  it("pcc-ui.js never creates a <script> element (no dynamic script injection in the kit)", () => {
    expect(/createElement\(\s*['"]script['"]\s*\)/.test(PCC_UI_SRC)).toBe(false);
  });

  it("the view builder's ONLY script injection is build-controlled textContent (never .src/innerHTML/srcdoc)", () => {
    for (const pat of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write\b/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bsrcdoc\b/]) {
      expect(pat.test(MCP_APP_VIEW_SRC), `mcp-app-view.ts must not contain ${pat}`).toBe(false);
    }
    // The build-controlled kit injection exists...
    const scriptCreations = MCP_APP_VIEW_SRC.match(/createElement\(\s*['"]script['"]\s*\)/g) ?? [];
    expect(scriptCreations.length).toBeGreaterThan(0);
    // ...and its source is the build-controlled kit literal assigned via textContent,
    // NEVER a .src (network/manifest/host-derived) load.
    expect(/kit\.textContent\s*=\s*(KIT_SOURCE|kitSource)\b/.test(MCP_APP_VIEW_SRC)).toBe(true);
    expect(/\bkit\.src\s*=/.test(MCP_APP_VIEW_SRC)).toBe(false);
  });
});

// ===========================================================================
// Directive 12 — CSP.
// ===========================================================================

describe("directive 12 — buildMcpAppCsp (nonce, no unsafe-*, no frame-ancestors in <meta>)", () => {
  it("uses a nonce + strict-dynamic script-src with NO unsafe-eval / unsafe-inline", () => {
    const csp = buildMcpAppCsp("N0NCE");
    expect(csp).toContain("script-src 'nonce-N0NCE' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    // script-src must not carry unsafe-inline (style-src still may — documented).
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(csp).not.toContain("*");
  });

  it("does NOT put frame-ancestors in the <meta> CSP (meaningless there)", () => {
    expect(buildMcpAppCsp("x")).not.toContain("frame-ancestors");
  });

  it("cspNonce() yields distinct, non-empty nonces", () => {
    const a = cspNonce();
    const b = cspNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it("the <meta> CSP nonce matches the inline <script nonce> in the rendered view", () => {
    _clearArtifactsForTests();
    _resetPublicLookupLimiterForTests();
    seedDashboard("csp-check-1234", "CSP check", "public");
    const html = renderSavedDashboardHtml("csp-check-1234");
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce, "meta CSP carries a script nonce").toBeTruthy();
    expect(csp).not.toContain("frame-ancestors");
    expect(html).toContain(`<script nonce="${nonce}">`);
  });
});

describe("directive 12 — HTTP mirror route (real header, frame-ancestors, no ACAO:*)", () => {
  it("serves a REAL CSP header with nonce+strict-dynamic+frame-ancestors and drops ACAO:*", async () => {
    const app = Fastify({ logger: false });
    registerMcpAppHttpRoute(app);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/mcp-apps/ui/dashboard" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain(`frame-ancestors ${MCP_APP_FRAME_ANCESTORS}`);
    // No wildcard CORS.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    // The served HTML's boot script carries the SAME nonce as the header CSP.
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(res.body).toContain(`<script nonce="${nonce}">`);
  });
});

// ===========================================================================
// Directive 13 — slug entropy, rate limiting, no private-existence reveal.
// ===========================================================================

function manifestFor(title: string) {
  return {
    csd: DASHBOARD_CSD_URL,
    title,
    sections: [{ windows: [{ kind: "note", text: "hi" }] }],
  };
}

function seedDashboard(slug: string, title: string, visibility: UiArtifact["visibility"]): void {
  const now = new Date().toISOString();
  _seedArtifactForTests({
    id: `ua_${slug}`,
    slug,
    csd: DASHBOARD_CSD_URL,
    name: title,
    manifest: manifestFor(title),
    capabilityTypes: [],
    visibility,
    owner: "op_test",
    useCount: 0,
    loadCount: 0,
    forkCount: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as UiArtifact);
}

describe("directive 13 — new slugs carry ≥96 bits of crypto entropy", () => {
  it("mints a slug with a 24-hex-char (96-bit) random suffix on save", async () => {
    _clearArtifactsForTests();
    _resetPublicLookupLimiterForTests();
    const app = Fastify({ logger: false });
    await app.register(artifactsRoutes);
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: { authorization: "Bearer test-token-abc", "content-type": "application/json" },
      payload: { name: "Watch my pizza", manifest: manifestFor("Watch my pizza") },
    });
    await app.close();

    expect(res.statusCode).toBe(201);
    const slug = res.json().slug as string;
    // human prefix preserved + 96-bit hex suffix.
    expect(slug).toMatch(/^watch-my-pizza-[0-9a-f]{24}$/);
  });
});

describe("directive 13 — failed-lookup rate limiter", () => {
  beforeEach(() => _resetPublicLookupLimiterForTests());
  afterEach(() => _resetPublicLookupLimiterForTests());

  it("throttles a key only after repeated FAILURES, and is per-key", () => {
    const key = "ip:198.51.100.7";
    expect(publicLookupThrottled(key)).toBe(false);
    for (let i = 0; i < 30; i++) notePublicLookupFailure(key);
    expect(publicLookupThrottled(key)).toBe(true);
    // A different caller is unaffected.
    expect(publicLookupThrottled("ip:203.0.113.9")).toBe(false);
  });

  it("returns 429 on the /a/:slug shell after a burst of failed lookups from one IP", async () => {
    _clearArtifactsForTests();
    _resetPublicLookupLimiterForTests();
    const app = Fastify({ logger: false });
    await app.register(artifactsRoutes);
    await app.ready();

    let last = await app.inject({ method: "GET", url: "/a/nope-0000", remoteAddress: "198.51.100.55" });
    for (let i = 0; i < 34 && last.statusCode !== 429; i++) {
      last = await app.inject({ method: "GET", url: `/a/nope-${i}`, remoteAddress: "198.51.100.55" });
    }
    await app.close();
    expect(last.statusCode).toBe(429);
  });
});

describe("directive 13 — public share surface never reveals private existence", () => {
  beforeEach(() => {
    _clearArtifactsForTests();
    _resetPublicLookupLimiterForTests();
    seedDashboard("private-secret-0001", "Top Secret Ops", "private");
    seedDashboard("retired-pub-0002", "Retired Public", "public");
    _clearRetired("retired-pub-0002");
  });

  it("a private slug renders the SAME not-found view as a never-seen slug (no oracle, no title leak)", () => {
    const priv = renderSavedDashboardHtml("private-secret-0001");
    const missing = renderSavedDashboardHtml("never-existed-9999");
    expect(priv).toContain("Dashboard not found");
    expect(priv).not.toContain("Top Secret Ops"); // the private title never leaks
    expect(missing).toContain("Dashboard not found");
    // Both are the same not-found template, differing ONLY by the echoed slug and
    // the fresh per-render CSP nonce (a fresh nonce each render is correct). Once
    // those are normalized the two documents are byte-identical — no oracle.
    const norm = (h: string, slug: string) =>
      h.replace(slug, "SLUG").replace(/nonce-[^']+/g, "nonce-X");
    expect(norm(priv, "private-secret-0001")).toBe(norm(missing, "never-existed-9999"));
  });

  it("a retired public slug also collapses to not-found", () => {
    expect(renderSavedDashboardHtml("retired-pub-0002")).toContain("Dashboard not found");
  });
});

/** Flip a seeded artifact to retired (directive 13 no-reveal test helper). */
function _clearRetired(slug: string): void {
  const now = new Date().toISOString();
  _seedArtifactForTests({
    id: `ua_${slug}`,
    slug,
    csd: DASHBOARD_CSD_URL,
    name: "Retired Public",
    manifest: manifestFor("Retired Public"),
    capabilityTypes: [],
    visibility: "public",
    owner: "op_test",
    useCount: 0,
    loadCount: 0,
    forkCount: 0,
    status: "retired",
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as UiArtifact);
}
