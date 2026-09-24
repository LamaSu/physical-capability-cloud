/**
 * @vitest-environment jsdom
 *
 * Money-action / approval hardening of the SHIPPED kit (apps/dashboard/public/ui-kit/v1/pcc-ui.js),
 * driven through the real render + dispatch path in LIVE mode with a recording fetch stub.
 *
 * Ports the still-valid part of PR #282 onto current master (its origin hard-bind is superseded by
 * merged #288's API_ORIGIN pin, which must not regress) and closes what #282 left open:
 *  - Deny is UI-only (it never dispatches a manifest action, even a money one);
 *  - fail-closed money detection on the DECODED path + a money-namespace backstop;
 *  - a real Idempotency-Key header, stable per (action, body), rotated after a 2xx;
 *  - one effect per click (re-entrancy, one gate per action, one Approve per gate opening);
 *  - the approval action bar can no longer be deleted by footer rendering;
 *  - accepted != settled: a money write never renders green; the gate mirrors its outcome.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const PCC = "https://capability.network";

function boot(manifest: unknown) {
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
  // eslint-disable-next-line no-eval
  (0, eval)(kitSrc); // no snapshot node -> LIVE mode
}
const flush = () => new Promise((r) => setTimeout(r, 0));

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
const posts = (calls: Call[], frag?: string) => calls.filter((c) => c.method !== "GET" && (!frag || c.url.indexOf(frag) !== -1));
const buttons = () => Array.from(document.querySelectorAll(".pcc-actionbar .pcc-btn")) as HTMLButtonElement[];
const btn = (label: string) => buttons().find((b) => (b.textContent || "").indexOf(label) === 0)!;

const man = (windows: unknown[], extra: Record<string, unknown> = {}) => ({
  csd: "pcc://artifacts/dashboard/v1", title: "T", ...extra, sections: [{ windows }],
});
// Approval window whose Deny is deliberately wired to a MONEY POST: the attack Deny-UI-only defends.
const approvalWin = {
  kind: "approval",
  binding: { path: "/api/escrow/esc-1" },
  approve: { id: "fund", label: "Approve fund", kind: "post", path: "/api/escrow/fund", body: { escrowId: "esc-1", amount: 21.99 } },
  deny: { id: "deny", label: "Deny", kind: "post", path: "/api/escrow/fund", body: { escrowId: "attacker", amount: 999 } },
};
const okGetsAnd = (post: { status: number; body?: unknown; trace?: string }) => (c: Call) =>
  c.method === "GET" ? { status: 200, body: { summary: "Pizza", amount: 21.99, currency: "USDC" } } : post;

beforeEach(() => {
  try { window.sessionStorage.clear(); window.localStorage.clear(); } catch { /* jsdom has both */ }
  delete (window as unknown as { fetch?: unknown }).fetch;
});

describe("approval window (live)", () => {
  it("renders its Approve/Deny controls at all (footer rendering no longer deletes the action bar)", async () => {
    installFetch(okGetsAnd({ status: 200 }));
    boot(man([approvalWin]));
    await flush();
    expect(btn("Approve")).toBeTruthy();
    expect(btn("Deny")).toBeTruthy();
  });

  it("keeps the action bar even when a trace footer is rendered (x-pcc-trace-id present)", async () => {
    installFetch((c) => (c.method === "GET" ? { status: 200, body: { amount: 1 }, trace: "t-get" } : { status: 200 }));
    boot(man([approvalWin]));
    await flush();
    expect(document.querySelector(".pcc-foot-meta")).not.toBeNull(); // the trace footer exists
    expect(btn("Approve")).toBeTruthy(); // and the action bar survived it
  });

  it("Deny is UI-only: it NEVER dispatches the manifest's deny action, even a money POST", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([approvalWin]));
    await flush();
    const before = calls.length;
    btn("Deny").click();
    await flush();
    expect(calls.length).toBe(before); // no network call of ANY kind
    expect(document.body.textContent).toContain("nothing was sent");
    expect(btn("Deny").disabled).toBe(true);
    expect(btn("Approve").disabled).toBe(true);
  });

  it("Approve sends a real Idempotency-Key HEADER (== the legacy body field)", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([approvalWin]));
    await flush();
    btn("Approve").click();
    await flush();
    const p = posts(calls, "/api/escrow/fund")[0]!;
    expect(p.headers["Idempotency-Key"]).toMatch(/^idem-/);
    expect(p.body!["idempotencyKey"]).toBe(p.headers["Idempotency-Key"]);
  });

  it("a triple-click Approve creates exactly ONE effect", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([approvalWin]));
    await flush();
    const a = btn("Approve");
    a.click(); a.click(); a.click();
    await flush();
    a.click(); // after success the approval is consumed
    await flush();
    expect(posts(calls, "/api/escrow/fund").length).toBe(1);
    expect(a.disabled).toBe(true);
  });

  it("a successful money approval reads 'submitted' (waiting), never settled-green", async () => {
    installFetch(okGetsAnd({ status: 200 }));
    boot(man([approvalWin]));
    await flush();
    btn("Approve").click();
    await flush();
    const pill = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(pill.textContent).toBe("submitted");
    expect(pill.className).toContain("st-waiting");
    expect(pill.className).not.toContain("st-settled");
    expect(document.body.textContent).toContain("Submitted");
    expect(document.body.textContent).not.toMatch(/\bDone\b/);
  });

  it("a removed endpoint (410) explains itself instead of a bare status code", async () => {
    installFetch(okGetsAnd({ status: 410 }));
    boot(man([approvalWin]));
    await flush();
    btn("Approve").click();
    await flush();
    expect(document.body.textContent!.toLowerCase()).toContain("no longer available");
  });
});

describe("money gate (actions bar, live)", () => {
  const action = (a: Record<string, unknown>) => man([{ kind: "actions", actions: [{ id: "x", label: "Go", kind: "post", ...a }] }]);

  it("a money NAMESPACE write with no money verb (/api/compose/plan) still needs approval", () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/compose/plan" }));
    btn("Go").click();
    expect(document.querySelector(".pcc-overlay")).not.toBeNull();
    expect(posts(calls).length).toBe(0);
  });

  it("a PERCENT-ENCODED money namespace (/api/fiat%2Dramp/session) cannot skip the gate", () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/fiat%2Dramp/session" }));
    btn("Go").click();
    expect(document.querySelector(".pcc-overlay")).not.toBeNull();
    expect(posts(calls).length).toBe(0);
  });

  it("a malformed %-escape fails closed to the gate", () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/x%E0%A4%A" }));
    btn("Go").click();
    expect(document.querySelector(".pcc-overlay")).not.toBeNull();
    expect(posts(calls).length).toBe(0);
  });

  it("button styling uses the same predicate as the gate (namespace money looks like money)", () => {
    installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/escrow/x/anything" }));
    expect(btn("Go").className).toContain("pcc-btn-primary");
  });

  it("a rapid second click opens ONE gate, and the gate's Approve fires ONE POST", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/escrow/fund", body: { escrowId: "e" } }));
    btn("Go").click(); btn("Go").click();
    expect(document.querySelectorAll(".pcc-overlay").length).toBe(1);
    const gateApprove = Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement;
    gateApprove.click(); gateApprove.click();
    await flush();
    expect(posts(calls, "/api/escrow/fund").length).toBe(1);
    expect(gateApprove.disabled).toBe(true);
  });

  it("the gate mirrors the FINAL outcome to the action bar (never stuck at 'Working')", async () => {
    installFetch(() => ({ status: 503 }));
    boot(action({ path: "/api/escrow/fund", body: { escrowId: "e" } }));
    btn("Go").click();
    (Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement).click();
    await flush();
    const barStatus = document.querySelector(".pcc-win .pcc-action-status") as HTMLElement;
    expect(barStatus.textContent).toContain("nothing was charged");
    expect(barStatus.className).toContain("st-failed");
  });

  it("#288 origin pin is not regressed: a hostile api_base cannot redirect the money POST or the key", async () => {
    window.sessionStorage.setItem("pcc.key", "pcc_live_viewer");
    const calls = installFetch(() => ({ status: 200 }));
    // api_base is attacker-chosen content; the kit must still pin every request to the PCC origin.
    boot({ ...action({ path: "/api/escrow/fund", body: { escrowId: "e" } }), api_base: "https://evil.example" });
    btn("Go").click();
    (Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement).click();
    await flush();
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe(PCC);
      expect(c.url).not.toContain("evil.example");
    }
    expect(posts(calls, "/api/escrow/fund").length).toBe(1);
  });
});

describe("idempotency key lifecycle (non-money form, direct POST)", () => {
  const form = man([{
    kind: "form",
    schema: { properties: { note: { type: "string" } } },
    submit: { id: "req", label: "Send", kind: "post", path: "/api/requests" },
  }]);
  const setNote = (v: string) => {
    const input = document.querySelector(".pcc-form-fields input") as HTMLInputElement;
    input.value = v;
  };

  it("a retry after a failure resends the SAME key (the server dedupes; no double effect)", async () => {
    let fail = true;
    const calls = installFetch(() => (fail ? { status: 503 } : { status: 200 }));
    boot(form);
    setNote("A");
    btn("Send").click();
    await flush();
    fail = false;
    btn("Send").click();
    await flush();
    const ps = posts(calls, "/api/requests");
    expect(ps.length).toBe(2);
    expect(ps[1]!.headers["Idempotency-Key"]).toBe(ps[0]!.headers["Idempotency-Key"]);
  });

  it("a DIFFERENT body is a different intent: new key (a stale response is never replayed for it)", async () => {
    const calls = installFetch(() => ({ status: 503 }));
    boot(form);
    setNote("A");
    btn("Send").click();
    await flush();
    setNote("B");
    btn("Send").click();
    await flush();
    const ps = posts(calls, "/api/requests");
    expect(ps[1]!.headers["Idempotency-Key"]).not.toBe(ps[0]!.headers["Idempotency-Key"]);
  });

  it("a 2xx consumes the instance: the next submission gets a new key", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(form);
    setNote("A");
    btn("Send").click();
    await flush();
    btn("Send").click();
    await flush();
    const ps = posts(calls, "/api/requests");
    expect(ps[1]!.headers["Idempotency-Key"]).not.toBe(ps[0]!.headers["Idempotency-Key"]);
  });

  it("a non-money write that succeeds still reads 'Done'", async () => {
    installFetch(() => ({ status: 200 }));
    boot(form);
    setNote("A");
    btn("Send").click();
    await flush();
    expect(document.body.textContent).toContain("Done");
  });
});
