/**
 * @vitest-environment jsdom
 *
 * Money-action / approval hardening of the SHIPPED kit (apps/dashboard/public/ui-kit/v1/pcc-ui.js),
 * driven through the real render + dispatch path in LIVE mode with a recording fetch stub.
 *
 * Ports the still-valid part of PR #282 onto current master (its origin hard-bind is superseded by
 * merged #288's API_ORIGIN pin, which must not regress) and closes what #282 left open:
 *  - Deny is UI-only (it never dispatches a manifest action, even a money one);
 *  - money detection FAIL-CLOSED BY CONSTRUCTION: every write is money unless it is on a short exact
 *    allowlist of non-money writes, classified on the path the wire actually carries;
 *  - a real Idempotency-Key header, stable per (action, body), rotated after a 2xx;
 *  - one effect per click (re-entrancy, one gate per action, one Approve per gate opening);
 *  - the approval action bar can no longer be deleted by footer rendering;
 *  - accepted != settled: a money write never renders green; the gate mirrors its outcome.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
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
  approve: { id: "fund", label: "Approve fund", kind: "post", path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "esc-1", amount: 21.99 } },
  deny: { id: "deny", label: "Deny", kind: "post", path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "attacker", amount: 999 } },
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
    const p = posts(calls, "/api/escrow/chain/0xabc/fund")[0]!;
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
    expect(posts(calls, "/api/escrow/chain/0xabc/fund").length).toBe(1);
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

  it("an unlisted write with no money verb (/api/compose/plan) still needs approval", () => {
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

  it("button styling uses the same predicate as the gate (an unlisted write looks like money)", () => {
    installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/escrow/x/anything" }));
    expect(btn("Go").className).toContain("pcc-btn-primary");
  });

  it("a rapid second click opens ONE gate, and the gate's Approve fires ONE POST", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "e" } }));
    btn("Go").click(); btn("Go").click();
    expect(document.querySelectorAll(".pcc-overlay").length).toBe(1);
    const gateApprove = Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement;
    gateApprove.click(); gateApprove.click();
    await flush();
    expect(posts(calls, "/api/escrow/chain/0xabc/fund").length).toBe(1);
    expect(gateApprove.disabled).toBe(true);
  });

  it("the gate mirrors the FINAL outcome to the action bar (never stuck at 'Working')", async () => {
    installFetch(() => ({ status: 503 }));
    boot(action({ path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "e" } }));
    btn("Go").click();
    (Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement).click();
    await flush();
    const barStatus = document.querySelector(".pcc-win .pcc-action-status") as HTMLElement;
    expect(barStatus.textContent).toContain("the outcome is unknown");
    expect(barStatus.textContent).not.toContain("nothing was charged");
    expect(barStatus.className).toContain("st-failed");
  });

  it("#288 origin pin is not regressed: a hostile api_base cannot redirect the money POST or the key", async () => {
    window.sessionStorage.setItem("pcc.key", "pcc_live_viewer");
    const calls = installFetch(() => ({ status: 200 }));
    // api_base is attacker-chosen content; the kit must still pin every request to the PCC origin.
    boot({ ...action({ path: "/api/escrow/chain/0xabc/fund", body: { escrowId: "e" } }), api_base: "https://evil.example" });
    btn("Go").click();
    (Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement).click();
    await flush();
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe(PCC);
      expect(c.url).not.toContain("evil.example");
    }
    expect(posts(calls, "/api/escrow/chain/0xabc/fund").length).toBe(1);
  });
});

describe("idempotency key lifecycle (non-money form, direct POST)", () => {
  const form = man([{
    kind: "form",
    schema: { properties: { note: { type: "string" } } },
    submit: { id: "req", label: "Send", kind: "post", path: "/api/feedback" },
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
    const ps = posts(calls, "/api/feedback");
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
    const ps = posts(calls, "/api/feedback");
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
    const ps = posts(calls, "/api/feedback");
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

// ── independent review (reviewer-bravo, 2026-09-24) — each finding pinned ──────────────────────
const gateApproveBtn = () =>
  Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Approve") as HTMLButtonElement | undefined;
const act = (a: Record<string, unknown>) => man([{ kind: "actions", actions: [{ id: "x", label: "Go", kind: "post", ...a }] }]);

describe("F1: the path we classify is the path we send (URL-parser normalization)", () => {
  // The WHATWG URL parser strips TAB/LF/CR anywhere, trims edge spaces/C0, and drops '#fragment':
  // each of these would be SENT as a real route. None may produce a request.
  const variants = [
    "/api/comp\tose", "/api/comp\nose", "/api/comp\rose", "/api/compose ", "/api/compose\t", "/api/compose#x",
    "/api/esc\trow/chain/0xabc/fu\tnd", "/api/fiat-r\tamp/coinbase/onr\tamp",
    "/api/feed\tback", "/api/feedback ", "/api/feedback#frag", // canonicalize to an ALLOWLISTED route: still refused
    "/api/escrow\u0000/chain/0xabc/fund",
  ];
  for (const v of variants) {
    it(`no request for ${JSON.stringify(v)}, and never a green outcome`, async () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ path: v, body: { escrowId: "e" } }));
      btn("Go").click();
      const ga = gateApproveBtn();
      if (ga) ga.click();
      await flush();
      expect(posts(calls).length).toBe(0);
      expect(document.body.innerHTML).not.toContain("st-settled");
    });
  }

  it("an approval window whose approve path hides a TAB cannot fund, and never turns green", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([{ ...approvalWin, approve: { ...approvalWin.approve, path: "/api/esc\trow/chain/0xabc/fu\tnd" } }]));
    await flush();
    btn("Approve").click();
    await flush();
    expect(posts(calls).length).toBe(0);
    const pill = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(pill.className).not.toContain("st-settled");
    expect(document.body.textContent).toContain("Refused");
  });
});

describe("F2: money detection is fail-closed by construction (unlisted writes are money)", () => {
  // Real gateway write routes the old 3-namespace denylist let through ungated (reviewer's table),
  // plus the paid x402 capability routes and a job-status PATCH.
  const moneyRoutes: Array<[string, string]> = [
    ["post", "/api/lob/letters"], ["post", "/api/settlement/submit"], ["post", "/api/settlement/flush"],
    ["post", "/api/jobs/j1/resume-settlement"], ["post", "/api/near/intent"],
    ["post", "/api/negotiate/session/s1/retry-settlement"], ["post", "/api/gasless/onboard"],
    ["post", "/api/marketplace/orders"], ["post", "/api/pool/stake"], ["post", "/api/rewards/claims"],
    ["post", "/api/bounty/claim"], ["post", "/api/swf/claims"], ["post", "/api/capabilities/quote"],
    ["post", "/api/capabilities/simulate"], ["patch", "/api/jobs/j1/status"], ["post", "/api/some/future/route"],
  ];
  for (const [kind, p] of moneyRoutes) {
    it(`${kind.toUpperCase()} ${p} opens the Approval gate; nothing is sent on click`, () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ kind, path: p }));
      btn("Go").click();
      expect(document.querySelector(".pcc-overlay")).not.toBeNull();
      expect(posts(calls).length).toBe(0);
      expect(btn("Go").className).toContain("pcc-btn-primary");
    });
  }

  it("an ALLOWLISTED non-money write (POST /api/artifacts) posts directly and reads 'Done'", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(act({ path: "/api/artifacts", body: { title: "t" } }));
    btn("Go").click();
    await flush();
    expect(document.querySelector(".pcc-overlay")).toBeNull();
    expect(posts(calls, "/api/artifacts").length).toBe(1);
    expect(document.body.textContent).toContain("Done");
  });

  for (const [kind, p] of [["patch", "/api/artifacts"], ["post", "/API/artifacts"], ["post", "/api/artifacts/a1/fork/x"], ["post", "/api/artifacts/a%2Fb/fork"], ["post", "/api/artifactsX"]] as Array<[string, string]>) {
    it(`a near-miss of the allowlist (${kind.toUpperCase()} ${p}) is still money`, () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ kind, path: p }));
      btn("Go").click();
      expect(document.querySelector(".pcc-overlay")).not.toBeNull();
      expect(posts(calls).length).toBe(0);
    });
  }

  for (const p of ["/api%2Ffeedback", "/api/feedback%2Fagent-report", "/api/artifacts%2Fa1%2Ffork", "/api%2fartifacts"]) {
    it(`an encoded separator has no canonical form and fails closed (${p})`, () => {
      // Decoding would turn these into allowlisted routes, but the gateway does not split on
      // %2F, so the kit cannot know what they route to: money until proven otherwise.
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ path: p }));
      btn("Go").click();
      expect(document.querySelector(".pcc-overlay")).not.toBeNull();
      expect(posts(calls).length).toBe(0);
    });
  }

  it("every allowlist entry is a real, non-x402 gateway write route (no dead or paid entries)", () => {
    const list = /var NON_MONEY_WRITES = \[([\s\S]*?)\];/.exec(kitSrc)![1]!;
    const entries = Array.from(list.matchAll(/'(POST|PATCH) ([^']+)'/g)).map((m) => [m[1]!, m[2]!] as const);
    expect(entries.length).toBeGreaterThan(0);
    const routesDir = path.resolve(here, "../../../gateway/src/routes");
    const src = readdirSync(routesDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(path.join(routesDir, f), "utf8")).join("\n");
    const x402 = readFileSync(path.resolve(here, "../../../gateway/src/middleware/x402-gate.ts"), "utf8");
    for (const [method, tpl] of entries) {
      const re = new RegExp("\\." + method.toLowerCase() + "(?:<[^>]*>)?\\(\\s*[\"'`]" +
        tpl.split("/").map((seg) => (seg === ":" ? ":[A-Za-z_]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "[\"'`]");
      expect(re.test(src), `${method} ${tpl} is not a gateway route`).toBe(true);
      expect(x402.includes(`"${method} ${tpl.replace(/:/g, ":")}"`), `${method} ${tpl} is x402-paid`).toBe(false);
    }
  });
});

describe("F6/F7: idempotency state is kit-owned; keys follow the body", () => {
  const refForm = (extra: Record<string, unknown> = {}) => man([{
    kind: "form",
    schema: { properties: { note: { type: "string", default: "K" }, amount: { type: "number" } } },
    submit: { id: "req", label: "Send", kind: "post", path: "/api/feedback", idempotencyFrom: "note", ...extra },
  }]);
  const setField = (name: string, v: string) => {
    const input = document.querySelector(`.pcc-form-fields [id^="pf-${name}-"]`) as HTMLInputElement;
    input.value = v;
  };

  it("idempotencyFrom cannot pin one key across DIFFERENT bodies", async () => {
    const calls = installFetch(() => ({ status: 503 }));
    boot(refForm());
    setField("note", "K"); setField("amount", "1");
    btn("Send").click(); await flush();
    setField("amount", "2");
    btn("Send").click(); await flush();
    const ps = posts(calls, "/api/feedback");
    expect(ps.length).toBe(2);
    expect(ps[1]!.headers["Idempotency-Key"]).not.toBe(ps[0]!.headers["Idempotency-Key"]);
  });

  it("the same reference + body gets the SAME key, even after a fresh boot (dedupes across reloads)", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const calls = installFetch(() => ({ status: 503 }));
      boot(refForm());
      setField("note", "order-7"); setField("amount", "3");
      btn("Send").click(); await flush();
      keys.push(posts(calls, "/api/feedback")[0]!.headers["Idempotency-Key"]!);
    }
    expect(keys[0]).toMatch(/^idem-/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("a manifest cannot pre-seed kit state: no stripped/pinned key, no inert action, gate still opens", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    const body = { title: "t" };
    boot(man([{ kind: "actions", actions: [
      { id: "a", label: "Save", kind: "post", path: "/api/artifacts", body,
        __idem: { key: "", fp: JSON.stringify(body) }, __posting: true, __gateOpen: true },
      { id: "m", label: "Fund", kind: "post", path: "/api/escrow/chain/0xabc/fund", body: { amount: 1 },
        __idem: { key: "attacker-chosen", fp: JSON.stringify({ amount: 1 }) }, __gateOpen: true },
    ] }]));
    btn("Save").click();
    await flush();
    const save = posts(calls, "/api/artifacts");
    expect(save.length).toBe(1);
    expect(save[0]!.headers["Idempotency-Key"]).toMatch(/^idem-/);
    btn("Fund").click();
    expect(document.querySelector(".pcc-overlay")).not.toBeNull();
    gateApproveBtn()!.click();
    await flush();
    const fund = posts(calls, "/api/escrow/chain/0xabc/fund");
    expect(fund.length).toBe(1);
    expect(fund[0]!.headers["Idempotency-Key"]).not.toBe("attacker-chosen");
    expect(fund[0]!.headers["Idempotency-Key"]).toMatch(/^idem-/);
  });
});

describe("F5 + nits: failure text never asserts an outcome the kit cannot know", () => {
  for (const code of [500, 502, 503, 504]) {
    it(`HTTP ${code} says the outcome is unknown (never 'nothing was charged')`, async () => {
      installFetch(() => ({ status: code }));
      boot(act({ path: "/api/artifacts" }));
      btn("Go").click();
      await flush();
      const t = document.body.textContent!;
      expect(t).toContain("the outcome is unknown");
      expect(t).not.toContain("nothing was charged");
    });
  }

  it("410 (removed endpoint, pre-execution) still says nothing was executed", async () => {
    installFetch(() => ({ status: 410 }));
    boot(act({ path: "/api/artifacts" }));
    btn("Go").click();
    await flush();
    expect(document.body.textContent).toContain("Nothing was executed");
  });

  it("404 'funding refused' only for the real escrow fund route, not any path containing /fund", async () => {
    installFetch(() => ({ status: 404 }));
    boot(act({ path: "/api/jobs/j1/fund" }));
    btn("Go").click();
    gateApproveBtn()!.click();
    await flush();
    expect(document.body.textContent).not.toContain("Funding was refused");
    installFetch(() => ({ status: 404 }));
    boot(act({ path: "/api/escrow/chain/0xabc/fund" }));
    btn("Go").click();
    gateApproveBtn()!.click();
    await flush();
    expect(document.body.textContent).toContain("Funding was refused");
  });

  it("a structured server error renders as JSON text, not '[object Object]'", async () => {
    installFetch(() => ({ status: 400, body: { error: { code: "E_BAD", detail: "nope" } } }));
    boot(act({ path: "/api/artifacts" }));
    btn("Go").click();
    await flush();
    expect(document.body.textContent).not.toContain("[object Object]");
    expect(document.body.textContent).toContain("E_BAD");
  });
});

describe("F10 + gate lifecycle", () => {
  it("Deny leaves a NEUTRAL local state: it does not assert a network-side denial", async () => {
    installFetch(okGetsAnd({ status: 200 }));
    boot(man([approvalWin]));
    await flush();
    btn("Deny").click();
    const pill = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(pill.textContent).toBe("not approved here");
    expect(pill.className).not.toContain("st-failed");
    expect(document.body.textContent).toContain("does not decline it on the network");
  });

  it("while a gated request is in flight the gate stays open, and a new click says 'Already submitted'", async () => {
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    (window as unknown as { fetch: unknown }).fetch = (url: unknown, init?: { method?: string }) => {
      calls.push(`${init?.method || "GET"} ${String(url)}`);
      return pending.then(() => ({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) }));
    };
    boot(act({ path: "/api/escrow/chain/0xabc/fund", body: { amount: 1 } }));
    btn("Go").click();
    gateApproveBtn()!.click();
    await new Promise((r) => setTimeout(r, 1300)); // longer than the old fixed 1.2 s auto-close
    expect(document.querySelector(".pcc-overlay")).not.toBeNull(); // still open: request unsettled
    // close it by hand, then click again while the request is still in flight
    (Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === "Cancel") as HTMLButtonElement).click();
    btn("Go").click();
    expect(document.querySelector(".pcc-overlay")).toBeNull(); // no inert second gate
    expect(document.body.textContent).toContain("Already submitted");
    release();
    await flush();
    expect(calls.filter((c) => c.startsWith("POST")).length).toBe(1);
  });
});
