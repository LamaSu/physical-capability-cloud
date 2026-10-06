/**
 * @vitest-environment jsdom
 *
 * N140 (steward row; LOW, latent): example-manifests/demo-snapshot.html is ONE self-contained
 * file: the shell, the job-watch manifest, a baked data snapshot and the WHOLE pcc-ui kit,
 * inlined. Its inlined kit had drifted to an OLDER copy of pcc-ui.js's transport: it persisted
 * ?api= to localStorage['pcc.apiBase'] and sent the #pcc_key key to that base, without the
 * kit's fixed API_ORIGIN pin (sol#1, 2026-08-19). Unreachable while the page stays in snapshot
 * mode; live the moment its snapshot block is dropped.
 *
 * The properties:
 *  1. NO DRIFT: the page's one executable script IS the shipped pcc-ui.js, byte for byte, so the
 *     demo can never again carry an older transport than the kit it demonstrates.
 *  2. AS SHIPPED: the page renders fully offline, in snapshot mode, with no request at all.
 *  3. SNAPSHOT DROPPED: with ?api= naming another origin and a #pcc_key fragment, every request
 *     goes to the fixed API origin, and nothing is persisted to localStorage['pcc.apiBase'].
 *
 * The page's scripts run here the way the smoke test runs the kit (ui-kit-render.smoke.test.ts):
 * its DOM is imported into the jsdom document and its executable script is evaluated in the
 * global scope. Every network path is recorded: the kit's transport is fetch (fetch-SSE included),
 * and EventSource is recorded too, in case a copy ever uses it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitDir = path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1");
const kitSrc = readFileSync(path.join(kitDir, "pcc-ui.js"), "utf8");
const pageSrc = readFileSync(path.join(kitDir, "example-manifests/demo-snapshot.html"), "utf8");

const API_ORIGIN = "https://capability.network";
const OTHER_ORIGIN = "https://api-elsewhere.example";
// Built at run time, so no key-shaped literal sits in the source.
const KEY = ["pcc", "test", "n140".repeat(8)].join("_");

const page = new DOMParser().parseFromString(pageSrc, "text/html");
const executable = [...page.querySelectorAll("script")].filter((s) => !s.hasAttribute("type") && !s.hasAttribute("src"));

type Call = { url: string; auth: string | null };
let calls: Call[] = [];

function authOf(headers: unknown): string | null {
  if (headers instanceof Headers) return headers.get("authorization");
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) if (k.toLowerCase() === "authorization") return String(v);
  }
  return null;
}

function boot(opts: { snapshot: boolean; url: string }): void {
  delete (window as unknown as Record<string, unknown>).__PCC_UI_BOOTED__;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, "", opts.url);
  for (const id of ["pcc-root", "pcc-manifest", ...(opts.snapshot ? ["pcc-snapshot"] : [])]) {
    const node = page.getElementById(id);
    expect(node, `#${id} in demo-snapshot.html`).not.toBeNull();
    document.body.appendChild(document.importNode(node!, true));
  }
  // eslint-disable-next-line no-eval
  (0, eval)(executable[0]!.textContent!);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn((input: unknown, init?: { headers?: unknown }) => {
    const raw = typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input);
    calls.push({ url: new URL(raw, location.href).href, auth: authOf(init?.headers) });
    return Promise.reject(new TypeError("offline (test)"));
  }));
  vi.stubGlobal("EventSource", class {
    constructor(url: string) { calls.push({ url: new URL(url, location.href).href, auth: null }); }
    addEventListener(): void {}
    close(): void {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("N140: demo-snapshot.html inlines the shipped kit, never an older transport", () => {
  it("the page has exactly one executable script, and it is pcc-ui.js byte for byte", () => {
    expect(executable).toHaveLength(1);
    // To re-bake: put ../pcc-ui.js, verbatim, between the page's executable <script> tags.
    expect(executable[0]!.textContent!.trim() === kitSrc.trim(), "demo-snapshot.html's inlined kit differs from pcc-ui.js").toBe(true);
  });

  it("as shipped, the page renders fully offline in snapshot mode and makes no request", async () => {
    boot({ snapshot: true, url: "/demo-snapshot.html" });
    await settle();
    expect(calls).toEqual([]);
    expect(document.querySelector(".pcc-wrap")?.getAttribute("data-mode")).toBe("snapshot");
    expect(document.querySelector(".pcc-banner")?.textContent?.toLowerCase()).toContain("snapshot");
    expect(document.body.textContent).toContain("out for delivery");
  });

  it("with the snapshot dropped, ?api= and #pcc_key never move a request off the fixed API origin, and nothing is persisted", async () => {
    boot({ snapshot: false, url: `/demo-snapshot.html?api=${encodeURIComponent(OTHER_ORIGIN)}#pcc_key=${KEY}` });
    await settle();
    expect(calls.length, "the live path ran").toBeGreaterThan(0);
    for (const c of calls) expect(new URL(c.url).origin, c.url).toBe(API_ORIGIN);
    expect(calls.some((c) => c.auth === `Bearer ${KEY}`), "the fragment key reached the pinned origin").toBe(true);
    expect(localStorage.getItem("pcc.apiBase")).toBeNull();
    expect(location.hash).not.toContain(KEY);
  });
});
