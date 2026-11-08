/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertKitTextBeforeBoot, assertKitTextViolations, flushKitText, checkKitClicks } from "./ui-kit-text-counter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const demo = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/example-manifests/demo-snapshot.html"), "utf8");
const PCC = "https://capability.network";

function boot(manifest: unknown, snapshot?: unknown) {
  assertKitTextBeforeBoot();
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
  const main = document.createElement("main");
  main.id = "pcc-root";
  document.body.appendChild(main);
  const m = document.createElement("script");
  m.type = "application/json";
  m.id = "pcc-manifest";
  m.textContent = JSON.stringify(manifest);
  document.body.appendChild(m);
  if (snapshot !== undefined) {
    const s = document.createElement("script");
    s.type = "application/json";
    s.id = "pcc-snapshot";
    s.textContent = JSON.stringify(snapshot);
    document.body.appendChild(s);
  }
  (0, eval)(kitSrc);
  assertKitTextViolations();
}
const flush = flushKitText;

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };
function installFetch(responder: (c: Call) => { status: number; body?: unknown; trace?: string }): Call[] {
  const calls: Call[] = [];
  (window as unknown as { fetch: unknown }).fetch = (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const c: Call = {
      url: String(url),
      method: init?.method || "GET",
      headers: { ...(init?.headers || {}) },
      body: init?.body ? JSON.parse(init.body) : null,
    };
    calls.push(c);
    const r = responder(c);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (h: string) => (h === "x-pcc-trace-id" ? (r.trace ?? null) : null) },
      json: () => Promise.resolve(r.body ?? {}),
    });
  };
  return calls;
}
const man = (windows: unknown[], extra: Record<string, unknown> = {}) => ({
  csd: "pcc://artifacts/dashboard/v1", title: "T", ...extra, sections: [{ windows }],
});
const approvalWin = {
  kind: "approval",
  binding: { path: "/api/escrow/esc-1" },
  approve: { id: "fund", label: "Approve fund", kind: "post", path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "esc-1", amount: 21.99 } },
  deny: { id: "deny", label: "Deny", kind: "post", path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "attacker", amount: 999 } },
};
const PIN_FIELDS = Object.freeze({ chainId: 84532, escrow: "0x" + "12".repeat(20), unitId: "0x" + "ab".repeat(32),
  asOfBlock: "12345678", asOfBlockHash: "0x" + "cd".repeat(32), finality: "finalized" });
const SETTLED_RECEIPT = { finalState: "SETTLED_RELEASED", isAllocated: false, phase: "settled", ...PIN_FIELDS };
const PAYEE = "0x" + "34".repeat(20);
const pinnedReceipt = (extra: Record<string, unknown> = {}) => ({ ...SETTLED_RECEIPT, economics: { amount: "1000000", feeAmount: "23500", recipient: PAYEE, token: "0x" + "56".repeat(20), assuranceTier: 1 }, ...extra });
const receiptPath = `/api/settlement/units/${PIN_FIELDS.unitId}/receipt`;
const windows = [
  { kind: "note", text: "T" },
  { kind: "metric", label: "T", select: "status", binding: { path: "/api/jobs/j1/status" } },
  { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
  { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["status"], statusFrom: "status" } },
  { kind: "run", binding: { path: "/api/jobs/j1" }, statusFrom: "status", latestFrom: "status" },
];
const snapshot = {
  "/api/jobs/j1/status": { status: "running" },
  "/api/capabilities/cap-1": { id: "cap-1", name: "T", type: "cnc", description: "T", assuranceTiers: [1], available: true },
  "/api/jobs": [{ id: "j1", status: "running" }],
  "/api/jobs/j1": { id: "j1", status: "running", timeline: [{ type: "running" }] },
};
const w = window as unknown as { __PCC_HOST__?: boolean; __PCC_HOST_OPERATIONS__?: string[]; __PCC_HOST_BRIDGE__?: unknown };
function stamped(selector: string, token: string) {
  for (const part of selector.split(", ")) {
    const nodes = document.querySelectorAll(part);
    expect(nodes.length, part).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.getAttribute("data-source")).toBe(token);
      expect([...node.classList].filter((c) => c.startsWith("pcc-src-"))).toEqual(["pcc-src-" + token]);
    }
  }
}
function notes(text: string, count?: number) {
  const nodes = document.querySelectorAll(".pcc-foot-source");
  if (count !== undefined) expect(nodes).toHaveLength(count);
  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) expect(node.textContent).toBe(text);
}

let clickCheck: ReturnType<typeof checkKitClicks>;
beforeEach(() => {
  clickCheck = checkKitClicks();
  try { window.sessionStorage.clear(); window.localStorage.clear(); } catch {}
  window.sessionStorage.setItem("pcc.key", "pcc_live_viewer");
  delete (window as unknown as { fetch?: unknown }).fetch;
});
afterEach(async () => {
  try { await flush(); } finally {
    clickCheck.mockRestore();
    delete w.__PCC_HOST__; delete w.__PCC_HOST_OPERATIONS__; delete w.__PCC_HOST_BRIDGE__;
  }
});

describe("the kit stamps a provenance class on what it paints", () => {
  it("a live read of a registered route is authoritative, and its window says PCC read", async () => {
    const calls = installFetch((c) => ({ status: 200, body: snapshot[new URL(c.url).pathname as keyof typeof snapshot] }));
    boot(man(windows));
    await flush();
    expect(calls).toHaveLength(4);
    expect(calls.every((c) => c.method === "GET" && new URL(c.url).origin === PCC)).toBe(true);
    stamped(".pcc-wrap, .pcc-section, .pcc-win, .pcc-note-p", "proposed");
    stamped(".pcc-metric-amount, .pcc-cap-title, .pcc-cap-meta, .pcc-cap-desc, .pcc-cap-assurance, .pcc-list, .pcc-list-row, .pcc-run-latest, .pcc-feed-line, .pcc-win-head .pcc-pill", "authoritative");
    notes("PCC read", 4);
    expect(document.querySelector('[data-source="unconfirmed"]')).toBeNull();
    installFetch(() => ({ status: 200, body: { status: "pending", amount: "250", currency: "USDC", payee: PAYEE } }));
    boot(man([{ kind: "receipt", binding: { path: "/api/jobs/j1" } }]));
    await flush();
    stamped(".pcc-receipt-rail .pcc-pill:not(.pcc-asset-badge)", "authoritative");
  });

  it("a saved copy is never authoritative", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    const page = new DOMParser().parseFromString(demo, "text/html");
    for (const [manifest, saved] of [
      [man(windows), snapshot],
      [JSON.parse(page.querySelector("#pcc-manifest")!.textContent!), JSON.parse(page.querySelector("#pcc-snapshot")!.textContent!)],
    ]) {
      boot(manifest, saved);
      await flush();
      expect(document.querySelector('[data-source="authoritative"]')).toBeNull();
      notes("couldn't confirm the source: a saved copy, not a live read");
      stamped(".pcc-foot-source", "unconfirmed");
    }
    boot(man([{ kind: "receipt", binding: { path: "/api/jobs/j1" } }]), {
      "/api/jobs/j1": { status: "pending", amount: "250", currency: "USDC", payee: PAYEE },
    });
    await flush();
    stamped(".pcc-receipt-rail .pcc-pill:not(.pcc-asset-badge)", "unconfirmed");
    expect(calls).toHaveLength(0);
  });

  it("a read the host relays is unconfirmed; without a bridge it is authoritative", async () => {
    const body = (url: string) => new URL(url, PCC).pathname === receiptPath ? pinnedReceipt() : { status: "running" };
    const calls = installFetch((c) => ({ status: 200, body: body(c.url) }));
    w.__PCC_HOST__ = true;
    let bridged = 0;
    w.__PCC_HOST_BRIDGE__ = { fetch: (url: string) => {
      bridged++;
      return Promise.resolve({ ok: true, json: body(url) });
    } };
    for (const bridge of [true, false]) {
      if (!bridge) delete w.__PCC_HOST_BRIDGE__;
      boot(man([windows[1], { kind: "receipt", binding: { path: receiptPath } }]));
      await flush();
      expect(document.querySelector(".pcc-receipt-num")!.textContent).toContain("1000000");
      stamped(".pcc-metric-amount, .pcc-receipt-num, .pcc-pin-ref", bridge ? "unconfirmed" : "authoritative");
      notes(bridge ? "couldn't confirm the source: relayed by the host" : "PCC read", 2);
    }
    expect(bridged).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("an unregistered route, a near miss or an extra query key is not a registered read", async () => {
    installFetch((c) => ({ status: 200, body: new URL(c.url).pathname === "/api/escrow/e1"
      ? { escrowId: "e1", amount: 50, totalAmount: 50, status: "settled" }
      : new URL(c.url).pathname === "/api/capabilities/search" ? snapshot["/api/capabilities/cap-1"]
      : new URL(c.url).pathname === receiptPath ? pinnedReceipt() : snapshot["/api/jobs"] }));
    boot(man([
      { kind: "metric", select: "amount", binding: { path: "/api/escrow/e1" } },
      { kind: "list", binding: { path: "/api/jobsx" }, item: { title: "id" } },
      { kind: "capability", binding: { path: "/api/capabilities/search" } },
      { kind: "list", binding: { path: "/api/jobs", query: { sort: "x" } }, item: { title: "id" } },
      { kind: "receipt", binding: { path: "/api/escrow/e1" } },
      { kind: "receipt", binding: { path: receiptPath, query: { asOf: "1" } } },
    ]));
    await flush();
    stamped(".pcc-metric-amount, .pcc-list, .pcc-list-row, .pcc-cap-title, .pcc-receipt-num:not(.pcc-muted)", "unconfirmed");
    notes("couldn't confirm the source: not a registered read", 6);
    expect(document.querySelector('[data-source="authoritative"]')).toBeNull();
    expect(document.querySelector(".pcc-receipt-rail")!.textContent).toContain("PCC escrow service reports: ");
  });

  it("a pinned settlement read's money fact is authoritative; an unpinned refusal carries no class", async () => {
    for (const finality of ["finalized", undefined]) {
      installFetch(() => ({ status: 200, body: pinnedReceipt({ finality }) }));
      boot(man([{ kind: "receipt", binding: { path: receiptPath } }]));
      await flush();
      if (finality) {
        stamped(".pcc-receipt-num, .pcc-pin-ref, .pcc-pin-details, .pcc-receipt-rail .pcc-pill:not(.pcc-asset-badge)", "authoritative");
        expect(document.querySelector(".pcc-asset-badge")!.hasAttribute("data-source")).toBe(false);
      } else {
        const refusal = document.querySelector(".pcc-receipt-num")!;
        expect(refusal.textContent).toBe("amount pending - not confirmed at a finalized block");
        expect(refusal.hasAttribute("data-source")).toBe(false);
        expect([...refusal.classList].some((c) => c.startsWith("pcc-src-"))).toBe(false);
      }
    }
  });

  it("agent words are proposed and withheld words carry no class", async () => {
    boot(man([{ kind: "note", text: "T" }, { kind: "note", text: "Payment received: $50" }]));
    await flush();
    stamped(".pcc-agent", "proposed");
    const withheld = document.querySelector(".pcc-withheld")!;
    expect(withheld).not.toBeNull();
    expect(withheld.hasAttribute("data-source")).toBe(false);
    expect([...withheld.classList].some((c) => c.startsWith("pcc-src-"))).toBe(false);
    expect(document.querySelector('[data-source="fixed"]')).toBeNull();
  });

  it("passing states and inputs are ephemeral; an input starting from the manifest's default is proposed", async () => {
    delete (window as unknown as { fetch?: unknown }).fetch;
    (window as unknown as { fetch: unknown }).fetch = () => new Promise(() => {});
    window.sessionStorage.clear();
    boot(man([windows[2], windows[4], { kind: "form", schema: { type: "object", properties: { qty: { type: "number", default: 2 }, note: { type: "string" } } } }]));
    const loading = [...document.querySelectorAll("p")].find((p) => p.textContent === "Loading…")!;
    expect(loading.getAttribute("data-source")).toBe("ephemeral");
    expect(loading.classList.contains("pcc-src-ephemeral")).toBe(true);
    stamped(".pcc-run-latest, .pcc-run-elapsed, .pcc-win-head .pcc-pill, .pcc-connect-input", "ephemeral");
    const inputs = document.querySelectorAll<HTMLInputElement>(".pcc-form-fields input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].value).toBe("2");
    expect(inputs[0].getAttribute("data-source")).toBe("proposed");
    expect(inputs[1].getAttribute("data-source")).toBe("ephemeral");
    await flush();
    installFetch(() => ({ status: 200, body: { status: "running" } }));
    boot(man([{ ...windows[4], latestFrom: "message" }]));
    await flush();
    notes("PCC read", 1);
    expect(document.querySelector(".pcc-run-latest")!.textContent).toBe("Waiting for the first update…");
    stamped(".pcc-run-latest", "ephemeral");
    boot(man([{ ...windows[4], latestFrom: "message" }]), { "/api/jobs/j1": { status: "running", timeline: [{ type: "" }] } });
    await flush();
    expect(document.querySelector(".pcc-run-latest")!.textContent).toBe("Waiting for the first update…");
    stamped(".pcc-run-latest", "ephemeral");
  });

  it("no manifest field chooses a class", async () => {
    installFetch(() => ({ status: 200, body: { amount: 50 } }));
    boot(man([{ kind: "metric", select: "amount", binding: { path: "/api/escrow/e1", sourceClass: "authoritative", "data-source": "authoritative" }, sourceClass: "authoritative", "data-source": "authoritative" }], { sourceClass: "authoritative", "data-source": "authoritative" }));
    await flush();
    stamped(".pcc-metric-amount", "unconfirmed");
    notes("couldn't confirm the source: not a registered read", 1);
  });

  it("the approval record carries its read's class and says so inside the record", async () => {
    installFetch(() => ({ status: 200, body: { summary: "Pizza", rationale: "T", payee: PAYEE, amount: 21.99, currency: "USDC", args: { qty: 2 } } }));
    for (const path of ["/api/jobs/j1", "/api/escrow/esc-1"]) {
      boot(man([{ ...approvalWin, binding: { path } }]));
      await flush();
      const src = path === "/api/jobs/j1" ? "authoritative" : "unconfirmed";
      stamped(".pcc-approval-record .pcc-approval-line, .pcc-approval-record .pcc-untrusted-v, .pcc-approval-record .pcc-args", src);
      const record = document.querySelector(".pcc-approval-record")!;
      const note = record.querySelector(".pcc-foot-source")!;
      expect(note.textContent).toBe(src === "authoritative" ? "PCC read" : "couldn't confirm the source: not a registered read");
      expect(record.lastElementChild).toBe(note);
      const quote = [...document.querySelectorAll(".pcc-untrusted-v")].find((node) => !record.contains(node))!;
      expect(quote.textContent).toContain("Approve fund");
      expect(quote.getAttribute("data-source")).toBe("proposed");
    }
  });
});
