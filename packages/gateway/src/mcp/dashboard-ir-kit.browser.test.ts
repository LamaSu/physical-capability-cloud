/**
 * Behavioral test of the COMMITTED pcc-ir-kit.js bytes (item 8). Loads the shipped
 * bundle into a FRESH jsdom window per case (isolation), drives the read-only
 * lifecycle, and proves the surface is inert: valid renders, invalid/oversized stays
 * inert, a non-parent source is ignored, it renders once, and it NEVER emits a
 * tools/call. Plus a static negative scan (defense-in-depth). The byte-equivalence
 * gate (check:ir-kit) proves these bytes are a fresh build of the audited TS.
 *
 * A real host delivers the manifest via postMessage (structured-cloned into the view's
 * realm), so the scenario clones the manifest into the jsdom window realm before
 * dispatch — otherwise a foreign-realm object is (correctly) rejected by isPlain.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";

const KIT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");
const PROTOCOL = "2026-01-26";
const validManifest = {
  csd: "pcc://artifacts/dashboard/v1", title: "Ops",
  sections: [{ heading: "Sec A", windows: [
    { kind: "note", text: "hello <b>not-html</b>" },
    { kind: "metric", label: "Balance", select: "usdc", binding: { path: "/api/fiat-ramp/cdp/wallet/0xabc/balance" } },
  ] }],
};

interface Scene { w: any; posted: any[]; mount: any; deliver: (m: unknown) => void; close: () => void }
function boot(opts: { badSource?: boolean } = {}): Scene {
  const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p class="pcc-invalid">waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
  const w: any = dom.window;
  const posted: any[] = [];
  w.parent.postMessage = (m: any) => posted.push(m);
  w.__PCC_IR_ORIGIN__ = "https://capability.network"; // server-injected fixed origin
  w.fetch = () => Promise.reject(new Error("no fetch in test"));
  w.eval(KIT);
  const src = () => (opts.badSource ? ({} as any) : w.parent);
  // init result (host → app), then the app is ready for a tool-result
  w.dispatchEvent(new w.MessageEvent("message", { source: src(), data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL } } }));
  const deliver = (manifest: unknown) => {
    // clone into the window realm (as real postMessage structured-clone does)
    const cloned = manifest === undefined ? undefined : w.JSON.parse(w.JSON.stringify(manifest));
    w.dispatchEvent(new w.MessageEvent("message", { source: src(), data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: cloned } } } }));
  };
  return { w, posted, mount: w.document.getElementById("pcc-ir-root"), deliver, close: () => w.close() };
}

describe("pcc-ir-kit.js — static negative scan", () => {
  it("contains none of the forbidden bridge / write identifiers", () => {
    for (const id of ["__PCC_HOST_BRIDGE__", "__PCC_HOST_OPERATIONS__", "tools/call", "registerComponent", "innerHTML", "EventSource"]) {
      expect(KIT.includes(id), `forbidden identifier present: ${id}`).toBe(false);
    }
  });
  it("carries the audited security core + GET-only transport contract", () => {
    for (const sym of ["dashboardManifestToIr", "validateIr", "bootIrView", "startBind", "RESERVED_EXACT"]) expect(KIT.includes(sym)).toBe(true);
    expect(KIT.includes('credentials: "omit"')).toBe(true);
    expect(KIT.includes('redirect: "error"')).toBe(true);
    expect(KIT.includes('method: "GET"')).toBe(true);
  });
});

describe("pcc-ir-kit.js — behavioral (jsdom, committed bytes)", () => {
  it("uses the ui/* read-only lifecycle and NEVER emits tools/call or resources/read", () => {
    const s = boot(); s.deliver(validManifest);
    expect(s.posted.some((m) => m && m.method === "ui/initialize" && m.params?.appInfo?.name)).toBe(true);
    expect(s.posted.some((m) => m && m.method === "ui/notifications/initialized")).toBe(true);
    expect(s.posted.some((m) => m && (m.method === "tools/call" || m.method === "resources/read"))).toBe(false);
    s.close();
  });

  it("answers ui/resource-teardown with a JSON-RPC result", () => {
    const s = boot(); s.deliver(validManifest);
    s.w.dispatchEvent(new s.w.MessageEvent("message", { source: s.w.parent, data: { jsonrpc: "2.0", id: 99, method: "ui/resource-teardown" } }));
    expect(s.posted.some((m) => m && m.id === 99 && m.result !== undefined)).toBe(true);
    s.close();
  });
  it("renders a valid projected manifest as inert text (no <b>/script/iframe)", () => {
    const s = boot(); s.deliver(validManifest);
    expect(s.mount.textContent).toContain("Ops");
    expect(s.mount.textContent).toContain("Balance");
    expect(s.mount.textContent).toContain("hello <b>not-html</b>");
    expect(s.mount.querySelector("b")).toBeNull();
    expect(s.mount.querySelector("script")).toBeNull();
    expect(s.mount.querySelector("iframe")).toBeNull();
    s.close();
  });
  it("keeps an INVALID manifest inert (notice, no section)", () => {
    const s = boot(); s.deliver({ csd: "x", title: "t", sections: [{ windows: [{ kind: "evil" }] }] });
    expect(s.mount.querySelector(".pcc-invalid")).not.toBeNull();
    expect(s.mount.querySelector(".pcc-section")).toBeNull();
    s.close();
  });
  it("keeps an OVERSIZED manifest inert (outer size cap)", () => {
    const s = boot(); s.deliver({ csd: "pcc://artifacts/dashboard/v1", title: "x".repeat(300 * 1024), sections: [] });
    expect(s.mount.querySelector(".pcc-invalid")).not.toBeNull();
    s.close();
  });
  it("ignores a non-parent message source (stays waiting)", () => {
    const s = boot({ badSource: true }); s.deliver(validManifest);
    expect(s.mount.textContent).toContain("waiting");
    s.close();
  });
  it("renders at most once (a second tool-result cannot re-render)", () => {
    const s = boot(); s.deliver(validManifest);
    const first = s.mount.innerHTML;
    s.deliver({ csd: "pcc://artifacts/dashboard/v1", title: "SECOND", sections: [] });
    expect(s.mount.innerHTML).toBe(first);
    expect(s.mount.textContent).not.toContain("SECOND");
    s.close();
  });
});
