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
 *
 * Steward ruling on #342 + cross-family review r1 (px2-342-moneyactions-astra), pinned below
 * (sections A-G + the r1 bypass list):
 *  - A: Approve/Deny are kit-owned; a manifest label never labels an executing control; Deny
 *    locks the moment a submission starts;
 *  - B: ONE validated canonical request descriptor drives the gate, the display and the wire;
 *    ambiguous encodings are refused at validation;
 *  - C: only kind "post"/"patch" can write; D: chain Plan + hosted operations take the same policy;
 *  - E: idempotency intents per body fingerprint, money one-shot; F: gate cleanup per instance;
 *  - G: an HTTP acknowledgement is neutral, never settled-green.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"), "utf8");
const PCC = "https://capability.network";

function boot(manifest: unknown, snapshot?: unknown) {
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

  it("a malformed %-escape fails closed: refused at validation (no inert gate, no request)", () => {
    // Ruling 3: a request the kit cannot validate is not a request -- there is nothing to approve,
    // so it is refused at the click with the reason instead of opening a gate whose Approve is dead.
    const calls = installFetch(() => ({ status: 200 }));
    boot(action({ path: "/api/x%E0%A4%A" }));
    btn("Go").click();
    expect(document.querySelector(".pcc-overlay")).toBeNull();
    expect(posts(calls).length).toBe(0);
    expect(document.body.textContent).toContain("Refused: unsafe or ambiguous request path - nothing was sent.");
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

  for (const [kind, p] of [["patch", "/api/artifacts"], ["post", "/API/artifacts"], ["post", "/api/artifacts/a1/fork/x"], ["post", "/api/artifactsX"], ["post", "/api/artifacts?x=1"], ["post", "/api/artifacts/"]] as Array<[string, string]>) {
    it(`a near-miss of the allowlist (${kind.toUpperCase()} ${p}) is still money`, () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ kind, path: p }));
      btn("Go").click();
      expect(document.querySelector(".pcc-overlay")).not.toBeNull();
      expect(posts(calls).length).toBe(0);
    });
  }

  for (const p of ["/api%2Ffeedback", "/api/feedback%2Fagent-report", "/api/artifacts%2Fa1%2Ffork", "/api%2fartifacts", "/api/artifacts/a%2Fb/fork"]) {
    it(`an encoded separator has no canonical form: refused at validation, never sent (${p})`, () => {
      // Decoding would turn these into allowlisted routes, but the gateway does not split on
      // %2F, so the kit cannot know what they route to. Ruling 3 rejects such ambiguous encodings
      // at validation: no gate, no request, an honest reason (previously an inert gate opened).
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ path: p }));
      expect(btn("Go").textContent).toBe("Go · blocked");
      btn("Go").click();
      expect(document.querySelector(".pcc-overlay")).toBeNull();
      expect(posts(calls).length).toBe(0);
      expect(document.body.textContent).toContain("Refused: unsafe or ambiguous request path");
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

// ── steward ruling on #342 + cross-family review r1 (px2-342-moneyactions-astra) ──────────────────
const gateBtn = (label: string) =>
  Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const overlays = () => document.querySelectorAll(".pcc-overlay").length;
const barStatus = () => document.querySelector(".pcc-win .pcc-action-status") as HTMLElement;
const text = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.textContent ?? null;
const winButtons = () => Array.from(document.querySelectorAll(".pcc-win .pcc-actionbar .pcc-btn")) as HTMLButtonElement[];
// A fetch whose writes stay in flight until release(); reads answer at once.
function pendingFetch(getBody: unknown = {}) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const calls: Call[] = [];
  (window as unknown as { fetch: unknown }).fetch = (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const c: Call = { url: String(url), method: init?.method || "GET", headers: { ...(init?.headers || {}) }, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(c);
    const resp = (body: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });
    return c.method === "GET" ? Promise.resolve(resp(getBody)) : gate.then(() => resp({}));
  };
  return { calls, release: () => release() };
}

describe("A (ruling 4): Approve/Deny are kit-owned; a manifest label never labels an executing control", () => {
  const hostile = { ...approvalWin, approve: { ...approvalWin.approve, label: "Deny" }, deny: { ...approvalWin.deny, label: "Approve" } };

  it("approval window: the controls read the KIT's 'Approve' / 'Deny' whatever the manifest labels say", async () => {
    installFetch(okGetsAnd({ status: 200 }));
    boot(man([hostile]));
    await flush();
    expect(winButtons().map((b) => b.textContent)).toEqual(["Approve", "Deny"]);
    // The manifest's approve label survives only as quoted, attributed text, outside every control.
    const quoted = Array.from(document.querySelectorAll(".pcc-win .pcc-untrusted-label")).map((n) => n.textContent);
    expect(quoted).toEqual(["The dashboard calls this: “Deny”"]);
    expect(winButtons().some((b) => b.querySelector(".pcc-untrusted-label") !== null)).toBe(false);
  });

  it("approval window: the control that READS 'Deny' sends nothing; only the kit's 'Approve' sends", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([hostile]));
    await flush();
    winButtons().find((b) => b.textContent === "Deny")!.click();
    await flush();
    expect(posts(calls).length).toBe(0);

    const calls2 = installFetch(okGetsAnd({ status: 200 }));
    boot(man([hostile]));
    await flush();
    winButtons().find((b) => b.textContent === "Approve")!.click();
    await flush();
    expect(posts(calls2, "/api/escrow/chain/0xabc/fund").length).toBe(1);
  });

  for (const label of ["Deny", "Cancel", "Close"]) {
    it(`actions bar: a write labelled "${label}" always ends in the kit's tag, and its click only opens the gate`, () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ label, path: "/api/pool/stake" }));
      const b = btn(label);
      expect(b.textContent).toBe(`${label} · needs approval`);
      expect((b.lastChild as HTMLElement).className).toBe("pcc-btn-tag");
      b.click();
      expect(overlays()).toBe(1);
      expect(posts(calls).length).toBe(0);
    });
  }

  it("actions bar: an allowlisted non-money write labelled 'Cancel' still says that it sends now", () => {
    installFetch(() => ({ status: 200 }));
    boot(act({ label: "Cancel", path: "/api/feedback" }));
    expect(btn("Cancel").textContent).toBe("Cancel · sends now");
  });

  it("form submit and inline-confirm writes carry the kit tag too", () => {
    installFetch(() => ({ status: 200 }));
    boot(man([
      { kind: "form", schema: { properties: {} }, submit: { id: "s", label: "Deny", kind: "post", path: "/api/escrow/chain/0xabc/fund" } },
      { kind: "actions", actions: [{ id: "f", label: "Close", kind: "post", path: "/api/feedback", confirm: "inline" }] },
    ]));
    expect(btn("Deny").textContent).toBe("Deny · needs approval");
    expect(btn("Close").textContent).toBe("Close · asks to confirm");
  });

  it("the Approval gate's controls are kit-owned; the manifest label is quoted text, never a button", () => {
    installFetch(() => ({ status: 200 }));
    boot(act({ label: "Deny", path: "/api/escrow/chain/0xabc/fund" }));
    btn("Deny").click();
    expect(Array.from(document.querySelectorAll(".pcc-overlay .pcc-btn")).map((b) => b.textContent)).toEqual(["Approve", "Cancel"]);
    expect(text(".pcc-overlay .pcc-untrusted-label")).toBe("The dashboard calls this: “Deny”");
  });

  it("Deny locks the moment a submission starts: it can never claim 'nothing was sent' while a request is in flight", async () => {
    const f = pendingFetch({ summary: "Pizza" });
    boot(man([approvalWin]));
    await flush();
    btn("Approve").click();
    expect(btn("Approve").disabled).toBe(true);
    expect(btn("Deny").disabled).toBe(true);
    // Even invoking Deny's handler directly (bypassing the disabled attribute) claims nothing.
    (btn("Deny") as unknown as { onclick: () => void }).onclick();
    expect(document.body.textContent).not.toContain("nothing was sent");
    f.release();
    await flush();
    expect(f.calls.filter((c) => c.method === "POST").length).toBe(1);
    expect(btn("Deny").disabled).toBe(true);
    expect(document.body.textContent).not.toContain("nothing was sent");
  });

  it("after a FAILED approval, Approve may retry with the SAME key but Deny stays locked (a request was sent)", async () => {
    let fail = true;
    const calls = installFetch((c) => (c.method === "GET" ? { status: 200, body: { summary: "Pizza" } } : fail ? { status: 503 } : { status: 200 }));
    boot(man([approvalWin]));
    await flush();
    btn("Approve").click();
    await flush();
    expect(btn("Approve").disabled).toBe(false);
    expect(btn("Deny").disabled).toBe(true);
    fail = false;
    btn("Approve").click();
    await flush();
    const ps = posts(calls, "/api/escrow/chain/0xabc/fund");
    expect(ps.length).toBe(2);
    expect(ps[1]!.headers["Idempotency-Key"]).toBe(ps[0]!.headers["Idempotency-Key"]);
    expect(btn("Approve").disabled).toBe(true); // accepted: the approval is consumed
  });
});

describe("B (ruling 3): ONE canonical request descriptor drives the gate, the display and the wire", () => {
  // r1 finding 2's probes that have no single meaning: refused at validation, nothing sent, no gate.
  const refused = [
    "/api%252Fcompose/plan", "/api%2Fcompose/plan", "/api%2fcompose/plan", "/api/fiat-\tramp/session",
    "/api/compose#x", "/api/compose%23x", "/api/compose%3Fq=1", "/api/compose%5Cplan", "/api/x%25",
    "/api/%2e%2e/compose", "/api/compose\u0085",
  ];
  for (const p of refused) {
    it(`refused at validation (no gate, nothing sent, honest reason): ${JSON.stringify(p)}`, async () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ path: p, body: { amount: 1 } }));
      expect(btn("Go").textContent).toBe("Go · blocked");
      btn("Go").click();
      await flush();
      expect(overlays()).toBe(0);
      expect(calls.length).toBe(0);
      expect(barStatus().className).toContain("st-failed");
      expect(barStatus().textContent).toMatch(/^Refused: .+ - nothing was sent\.$/);
    });
  }

  // Unambiguous requests: gated (unlisted = money), and the wire carries EXACTLY the URL and method
  // the gate displayed -- the transport sends desc.url and never re-derives it.
  const gated: Array<[string, string, string]> = [
    ["post", "/api/x/fund/", `${PCC}/api/x/fund/`],
    ["post", "/api/x/fund", `${PCC}/api/x/fund`],
    ["post", "/api/fiat%2Dramp/session", `${PCC}/api/fiat%2Dramp/session`],
    ["post", "/API/COMPOSE/plan/", `${PCC}/API/COMPOSE/plan/`],
    ["post", "/api/compose/plan?q=x", `${PCC}/api/compose/plan?q=x`],
    ["post", "/api/café/fund", `${PCC}/api/caf%C3%A9/fund`],
    ["post", "/api/feedback?x=1", `${PCC}/api/feedback?x=1`], // allowlisted route + a query: not an exact match
    ["post", "/api/feedback\uFF0Fagent-report", `${PCC}/api/feedback%EF%BC%8Fagent-report`], // fullwidth-solidus lookalike
    ["patch", "/api/jobs/j1/status", `${PCC}/api/jobs/j1/status`],
  ];
  for (const [kind, p, wire] of gated) {
    it(`${kind.toUpperCase()} ${JSON.stringify(p)} is gated, and the wire gets exactly the displayed ${wire}`, async () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(act({ kind, path: p, body: { amount: 3 } }));
      btn("Go").click();
      expect(posts(calls).length).toBe(0);
      const shownUrl = text(".pcc-overlay .pcc-realreq-dest");
      const shownMethod = text(".pcc-overlay .pcc-realreq-method");
      expect(shownUrl).toBe(wire);
      expect(shownMethod).toBe(kind.toUpperCase());
      gateApproveBtn()!.click();
      await flush();
      const ps = posts(calls);
      expect(ps.length).toBe(1);
      expect(ps[0]!.url).toBe(shownUrl);
      expect(ps[0]!.method).toBe(shownMethod);
    });
  }

  it("the approval window sends exactly the URL its 'This will send' block displays", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([{ ...approvalWin, approve: { ...approvalWin.approve, path: "/api/escrow/chain/0x%41bc/fund" } }]));
    await flush();
    const shown = text(".pcc-win .pcc-realreq-dest");
    expect(shown).toBe(`${PCC}/api/escrow/chain/0x%41bc/fund`);
    btn("Approve").click();
    await flush();
    expect(posts(calls).map((c) => c.url)).toEqual([shown]);
  });

  it("an approval window whose approve path is ambiguous shows BLOCKED and sends nothing", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([{ ...approvalWin, approve: { ...approvalWin.approve, path: "/api%252Fescrow/chain/0xabc/fund" } }]));
    await flush();
    expect(text(".pcc-win .pcc-realreq-blocked")).toContain("BLOCKED");
    btn("Approve").click();
    await flush();
    expect(posts(calls).length).toBe(0);
    expect(document.body.textContent).toContain("Refused");
  });

  for (const p of ["/api%2Fjobs", "/api%252Fjobs", "/api/jobs%3Fx"]) {
    it(`a READ binding with an ambiguous encoding is refused too, no fetch (${p})`, async () => {
      const calls = installFetch(() => ({ status: 200, body: { n: 1 } }));
      boot(man([{ kind: "metric", label: "M", binding: { path: p }, format: "int" }]));
      await flush();
      expect(calls.length).toBe(0);
      expect(document.body.textContent).toContain("refused unsafe request path");
    });
  }
});

describe("r1 finding 3: the nine listed money routes are all gated (neutral label and id, no confirm)", () => {
  const nine = [
    "/api/settlement/flush", "/api/pool/stake", "/api/rewards/claims", "/api/swf/claims", "/api/bounty/claim",
    "/api/bounty/verify", "/api/bounty/demand", "/api/tool-catalog/bounty", "/api/onboard/redeem",
  ];
  for (const p of nine) {
    it(`POST ${p}: "Continue" opens the gate and sends nothing; Approve sends exactly one POST`, async () => {
      const calls = installFetch(() => ({ status: 200 }));
      boot(man([{ kind: "actions", actions: [{ id: "x", label: "Continue", kind: "post", path: p, body: {} }] }]));
      const b = btn("Continue");
      expect(b.className).toContain("pcc-btn-primary");
      expect(b.textContent).toBe("Continue · needs approval");
      b.click();
      expect(overlays()).toBe(1);
      expect(posts(calls).length).toBe(0);
      gateApproveBtn()!.click();
      await flush();
      expect(posts(calls).map((c) => c.url)).toEqual([`${PCC}${p}`]);
    });
  }
});

describe("r1 findings 2 + 4: only the path decides; labels, ids and confirm:'inline' never steer the policy", () => {
  it("a money-sounding label/id on an allowlisted route still sends now; a neutral one on a money route is gated", () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(man([{ kind: "actions", actions: [
      { id: "fund", label: "Fund escrow", kind: "post", path: "/api/feedback", body: {} },
      { id: "view", label: "View", kind: "post", path: "/api/bounty/claim", body: {} },
    ] }]));
    expect(btn("Fund escrow").textContent).toBe("Fund escrow · sends now");
    expect(btn("View").textContent).toBe("View · needs approval");
    btn("View").click();
    expect(overlays()).toBe(1);
    expect(posts(calls).length).toBe(0);
  });

  it("confirm:'inline' cannot downgrade a money write: the Approval gate opens, not an inline confirm", () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(act({ path: "/api/pool/stake", confirm: "inline" }));
    btn("Go").click();
    expect(overlays()).toBe(1);
    expect(document.querySelector(".pcc-confirm-q")).toBeNull();
    expect(posts(calls).length).toBe(0);
  });
});

describe("B: Transport.send sends only a validated, pinned descriptor (#288 re-checked, never re-derived)", () => {
  type Tx = { send(desc: unknown, body: unknown, key?: string): Promise<{ ok: boolean; refused?: boolean }> };
  // The shipped Transport region, evaluated as the gateway host-integration suite does.
  function kitTransport(fetchImpl: (u: string, init?: Record<string, unknown>) => Promise<unknown>): Tx {
    const startMarker = "function Transport(apiBase, isHost) {";
    const endMarker = "HostTransport.prototype.streamSSE = Transport.prototype.streamSSE;";
    const start = kitSrc.indexOf(startMarker);
    const end = kitSrc.indexOf(endMarker, start) + endMarker.length;
    const bundle = [
      `var API_ORIGIN = ${JSON.stringify(PCC)};`,
      "function getKey(){ return 'pcc_live_viewer'; }",
      kitSrc.slice(start, end),
      "return new Transport(API_ORIGIN, false);",
    ].join("\n");
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    return new Function("fetch", "window", bundle)(fetchImpl, {}) as Tx;
  }
  const ok = () => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) });
  const forged: Array<[string, Record<string, unknown>]> = [
    ["not ok", { ok: false, method: "POST", url: `${PCC}/api/x`, reason: "r" }],
    ["off-origin url", { ok: true, method: "POST", url: "https://evil.example/api/x" }],
    ["url not in canonical serialization", { ok: true, method: "POST", url: `${PCC}/api/x/../escrow/fund` }],
    ["credentials in the url", { ok: true, method: "POST", url: "https://user:pw@capability.network/api/x" }],
    ["unsupported method", { ok: true, method: "PUT", url: `${PCC}/api/x` }],
    ["no url", { ok: true, method: "POST", path: "/api/x" }],
  ];
  for (const [name, desc] of forged) {
    it(`refuses a forged descriptor (${name}): no fetch, so no Bearer leaves`, async () => {
      const urls: string[] = [];
      const tx = kitTransport((u) => { urls.push(u); return ok(); });
      const res = await tx.send(desc, {}, "k1");
      expect(res.ok).toBe(false);
      expect(res.refused).toBe(true);
      expect(urls.length).toBe(0);
    });
  }

  it("a valid descriptor is fetched at exactly desc.url with desc.method (+ the pinned fetch options)", async () => {
    const seen: Array<{ u: string; init?: Record<string, unknown> }> = [];
    const tx = kitTransport((u, init) => { seen.push({ u, init }); return ok(); });
    await tx.send({ ok: true, method: "PATCH", url: `${PCC}/api/jobs/j%31/status` }, { a: 1 }, "k2");
    expect(seen.length).toBe(1);
    expect(seen[0]!.u).toBe(`${PCC}/api/jobs/j%31/status`);
    expect(seen[0]!.init).toMatchObject({ method: "PATCH", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store" });
    expect((seen[0]!.init!.headers as Record<string, string>)["Idempotency-Key"]).toBe("k2");
  });
});

describe("C: only kind 'post' -> POST and 'patch' -> PATCH; any other kind sends nothing", () => {
  const badKinds: Array<[string, unknown]> = [
    ["put", "put"], ["delete", "delete"], ["PATCH", "PATCH"], ["POST", "POST"], ["get", "get"], ["missing", undefined], ["a number", 1],
  ];
  for (const [name, kind] of badKinds) {
    it(`kind ${name}: refused with an honest status; no gate, no request`, async () => {
      const calls = installFetch(() => ({ status: 200 }));
      const a: Record<string, unknown> = { id: "x", label: "Go", path: "/api/escrow/chain/0xabc/fund", body: { amount: 1 } };
      if (kind !== undefined) a.kind = kind;
      boot(man([{ kind: "actions", actions: [a] }]));
      expect(btn("Go").textContent).toBe("Go · blocked");
      btn("Go").click();
      await flush();
      expect(overlays()).toBe(0);
      expect(calls.length).toBe(0);
      expect(barStatus().textContent).toContain('unsupported action kind (only "post" and "patch" can write)');
    });
  }

  it("the allowlist never widens the kinds: PUT /api/feedback is refused", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(act({ kind: "put", path: "/api/feedback" }));
    btn("Go").click();
    await flush();
    expect(calls.length).toBe(0);
  });

  it("approval window: approve.kind 'delete' is BLOCKED in 'This will send' and Approve sends nothing", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([{ ...approvalWin, approve: { ...approvalWin.approve, kind: "delete" } }]));
    await flush();
    expect(text(".pcc-win .pcc-realreq-blocked")).toContain("unsupported action kind");
    btn("Approve").click();
    await flush();
    expect(posts(calls).length).toBe(0);
  });

  it("form submit with kind 'PATCH' (wrong case) sends nothing", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(man([{ kind: "form", schema: { properties: {} }, submit: { id: "s", label: "Send", kind: "PATCH", path: "/api/feedback" } }]));
    btn("Send").click();
    await flush();
    expect(calls.length).toBe(0);
    expect(document.body.textContent).toContain("unsupported action kind");
  });
});

describe("D: every write entry point goes through the same policy (chain Plan)", () => {
  const chainWin = {
    kind: "chain",
    composeRef: { outcomeType: "pizza", budgetUSD: 25, minAssuranceTier: 0 },
    execute: { id: "exec", label: "Execute", kind: "post", path: "/api/compose/c1/execute", body: {} },
  };
  const planned = { steps: [{ capabilityType: "oven", estimatedPriceUSD: 12 }], totalPriceUSD: 12 };

  it("chain Plan is a gated write: its click opens ONE Approval gate and sends nothing", () => {
    const calls = installFetch(() => ({ status: 201, body: planned }));
    boot(man([chainWin]));
    expect(btn("Plan").textContent).toBe("Plan · needs approval");
    btn("Plan").click();
    btn("Plan").click();
    expect(overlays()).toBe(1);
    expect(posts(calls).length).toBe(0);
  });

  it("after Approve, Plan sends exactly ONE POST /api/compose (the displayed URL, an Idempotency-Key) and renders the plan", async () => {
    const calls = installFetch(() => ({ status: 201, body: planned }));
    boot(man([chainWin]));
    btn("Plan").click();
    const shown = text(".pcc-overlay .pcc-realreq-dest");
    gateApproveBtn()!.click();
    gateApproveBtn()!.click();
    await flush();
    const ps = posts(calls);
    expect(ps.length).toBe(1);
    expect(ps[0]!.url).toBe(`${PCC}/api/compose`);
    expect(ps[0]!.url).toBe(shown);
    expect(ps[0]!.headers["Idempotency-Key"]).toMatch(/^idem-/);
    expect(ps[0]!.body).toMatchObject({ outcomeType: "pizza", budgetUSD: 25, minAssuranceTier: 0 });
    expect(document.body.textContent).toContain("oven");
    expect(document.body.textContent).toContain("total 12.00 USDC");
  });

  it("Plan is busy-guarded and one-shot: in flight -> 'Already submitted'; once accepted nothing more is sent", async () => {
    const f = pendingFetch();
    boot(man([chainWin]));
    btn("Plan").click();
    gateApproveBtn()!.click();
    gateBtn("Cancel")!.click();
    btn("Plan").click(); // while the request is in flight
    expect(overlays()).toBe(0);
    expect(document.body.textContent).toContain("Already submitted");
    f.release();
    await flush();
    btn("Plan").click(); // an accepted money write is one-shot
    await flush();
    expect(overlays()).toBe(0);
    expect(f.calls.filter((c) => c.method === "POST").length).toBe(1);
  });

  it("in snapshot mode Plan hands back the intent chip, never a request", () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(man([chainWin]), { _ts: "2026-09-24T00:00:00Z" });
    btn("Plan").click();
    expect(calls.length).toBe(0);
    expect(overlays()).toBe(0);
    expect(text(".pcc-chip")).toBe("pcc: plan pizza");
  });
});

describe("D: a hosted typed operation has a per-action re-entrancy guard", () => {
  const w = window as unknown as { __PCC_HOST__?: boolean; __PCC_HOST_OPERATIONS__?: string[]; __PCC_HOST_BRIDGE__?: unknown };
  afterEach(() => { delete w.__PCC_HOST__; delete w.__PCC_HOST_OPERATIONS__; delete w.__PCC_HOST_BRIDGE__; });
  const hostBoot = (callOperation: unknown) => {
    w.__PCC_HOST__ = true;
    w.__PCC_HOST_OPERATIONS__ = ["job.cancel"];
    w.__PCC_HOST_BRIDGE__ = { callOperation };
    boot(man([{ kind: "actions", actions: [
      { id: "c", label: "Cancel job", kind: "post", path: "/api/jobs/j1/cancel", operation_id: "job.cancel", arguments: { jobId: "j1" } },
    ] }]));
  };

  it("one in-flight call per action: a triple-click runs the operation ONCE; once settled it may run again", async () => {
    let release!: (v: unknown) => void;
    const callOperation = vi.fn(() => new Promise((r) => { release = r; }));
    installFetch(() => ({ status: 200 }));
    hostBoot(callOperation);
    const b = btn("Cancel job");
    expect(b.disabled).toBe(false);
    b.click(); b.click(); b.click();
    expect(callOperation).toHaveBeenCalledTimes(1);
    expect(barStatus().textContent).toContain("Already submitted");
    release({ structuredContent: {} });
    await flush();
    expect(barStatus().textContent).toBe("Done");
    expect(barStatus().className).toBe("pcc-action-status st-ack"); // G: a neutral acknowledgement
    expect(document.body.innerHTML).not.toContain("st-settled");
    b.click();
    expect(callOperation).toHaveBeenCalledTimes(2);
  });

  it("a bridge that throws synchronously releases the guard (never stuck at 'Working')", () => {
    const callOperation = vi.fn(() => { throw new Error("bridge down"); });
    installFetch(() => ({ status: 200 }));
    hostBoot(callOperation);
    btn("Cancel job").click();
    expect(barStatus().textContent).toBe("bridge down");
    btn("Cancel job").click();
    expect(callOperation).toHaveBeenCalledTimes(2);
  });
});

describe("E: idempotency intents (kit-owned, per body fingerprint) and money one-shot", () => {
  const noteForm = (p: string) => man([{
    kind: "form",
    schema: { properties: { note: { type: "string" } } },
    submit: { id: "req", label: "Send", kind: "post", path: p },
  }]);
  const setNote = (v: string) => { (document.querySelector(".pcc-form-fields input") as HTMLInputElement).value = v; };

  it("A (unknown outcome) -> B -> retry A reuses A's key; retry B reuses B's", async () => {
    const calls = installFetch(() => ({ status: 503 }));
    boot(noteForm("/api/feedback"));
    for (const v of ["A", "B", "A", "B"]) { setNote(v); btn("Send").click(); await flush(); }
    const k = posts(calls, "/api/feedback").map((c) => c.headers["Idempotency-Key"]);
    expect(k.length).toBe(4);
    expect(k[1]).not.toBe(k[0]);
    expect(k[2]).toBe(k[0]);
    expect(k[3]).toBe(k[1]);
  });

  it("A/B/A through the Approval gate (a money form) reuses A's key as well", async () => {
    const calls = installFetch(() => ({ status: 503 }));
    boot(noteForm("/api/escrow/chain/0xabc/fund"));
    for (const v of ["A", "B", "A"]) {
      setNote(v);
      btn("Send").click();
      gateApproveBtn()!.click();
      await flush();
      gateBtn("Cancel")!.click();
    }
    const k = posts(calls).map((c) => c.headers["Idempotency-Key"]);
    expect(k.length).toBe(3);
    expect(k[1]).not.toBe(k[0]);
    expect(k[2]).toBe(k[0]);
  });

  it("a 2xx consumes only THAT fingerprint's key: B keeps its key; A re-sends under a NEW key (non-money)", async () => {
    let okFor = "";
    const calls = installFetch((c) => (c.body && c.body["note"] === okFor ? { status: 200 } : { status: 503 }));
    boot(noteForm("/api/feedback"));
    setNote("A"); btn("Send").click(); await flush(); // A unresolved
    setNote("B"); btn("Send").click(); await flush(); // B unresolved
    okFor = "A";
    setNote("A"); btn("Send").click(); await flush(); // A retried under A's key -> 2xx: consumed
    setNote("B"); btn("Send").click(); await flush(); // B retried: still B's key
    setNote("A"); btn("Send").click(); await flush(); // A after its success: a new intent, a new key
    const k = posts(calls, "/api/feedback").map((c) => c.headers["Idempotency-Key"]);
    expect(k.length).toBe(5);
    expect(k[2]).toBe(k[0]);
    expect(k[3]).toBe(k[1]);
    expect(k[4]).not.toBe(k[0]);
    expect(k[4]).not.toBe(k[1]);
  });

  it("an idempotencyFrom key is bound to its route: the same reference + body on two routes never share a key", async () => {
    const calls = installFetch(() => ({ status: 503 }));
    const refSubmit = (id: string, p: string) => ({
      kind: "form",
      schema: { properties: { note: { type: "string", default: "order-7" } } },
      submit: { id, label: id, kind: "post", path: p, idempotencyFrom: "note" },
    });
    boot(man([refSubmit("One", "/api/feedback"), refSubmit("Two", "/api/feedback/agent-report")]));
    btn("One").click(); await flush();
    btn("Two").click(); await flush();
    const ps = posts(calls);
    expect(ps.length).toBe(2);
    expect(ps[0]!.body).toMatchObject({ note: "order-7" });
    expect(ps[1]!.body).toMatchObject({ note: "order-7" });
    expect(ps[1]!.headers["Idempotency-Key"]).not.toBe(ps[0]!.headers["Idempotency-Key"]);
  });

  it("a MONEY action that was accepted is one-shot: another click says 'Already submitted' and sends nothing", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(act({ path: "/api/escrow/chain/0xabc/fund", body: { amount: 1 } }));
    btn("Go").click();
    gateApproveBtn()!.click();
    await flush();
    expect(posts(calls).length).toBe(1);
    gateBtn("Cancel")!.click();
    btn("Go").click();
    btn("Go").click();
    await flush();
    expect(overlays()).toBe(0);
    expect(posts(calls).length).toBe(1);
    expect(barStatus().textContent).toContain("Already submitted");
  });

  it("a money FORM is one-shot even with a different body: a new intent needs a reload", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(noteForm("/api/escrow/chain/0xabc/fund"));
    setNote("A"); btn("Send").click(); gateApproveBtn()!.click(); await flush();
    gateBtn("Cancel")!.click();
    setNote("B"); btn("Send").click(); await flush();
    expect(overlays()).toBe(0);
    expect(posts(calls).length).toBe(1);
    expect(document.body.textContent).toContain("Already submitted");
  });
});

describe("F: Approval-gate cleanup is instance-specific", () => {
  it("approve, cancel, reopen, then the OLD gate's delayed close fires: the newer gate's guard survives", async () => {
    const calls = installFetch(() => ({ status: 503 })); // a failed attempt keeps the action re-openable
    boot(act({ path: "/api/escrow/chain/0xabc/fund", body: { amount: 1 } }));
    btn("Go").click();
    gateApproveBtn()!.click();
    await flush(); // settled: gate 1 schedules its own close in 1.2 s
    gateBtn("Cancel")!.click(); // ...but is closed by hand first
    expect(overlays()).toBe(0);
    btn("Go").click(); // gate 2
    expect(overlays()).toBe(1);
    await new Promise((r) => setTimeout(r, 1300)); // gate 1's stale timer fires now
    btn("Go").click(); // must NOT stack a third gate on gate 2
    expect(overlays()).toBe(1);
    // gate 2 still works, and retries the unresolved body under the SAME key
    gateApproveBtn()!.click();
    await flush();
    const ps = posts(calls);
    expect(ps.length).toBe(2);
    expect(ps[1]!.headers["Idempotency-Key"]).toBe(ps[0]!.headers["Idempotency-Key"]);
  });
});

describe("G (ruling 2): acknowledgements are neutral; settled-green only comes from a read model", () => {
  it("a non-money 2xx reads 'Done' in the neutral st-ack class", async () => {
    installFetch(() => ({ status: 200 }));
    boot(act({ path: "/api/artifacts", body: { title: "t" } }));
    btn("Go").click();
    await flush();
    expect(barStatus().textContent).toBe("Done");
    expect(barStatus().className).toBe("pcc-action-status st-ack");
    expect(document.body.innerHTML).not.toContain("st-settled");
  });

  it("a NON-money approval window acknowledges with a neutral 'resolved' pill", async () => {
    installFetch(okGetsAnd({ status: 200 }));
    boot(man([{ kind: "approval", binding: { path: "/api/csd/doc-1" },
      approve: { id: "v", label: "Validate", kind: "post", path: "/api/csd/validate", body: { doc: "d" } } }]));
    await flush();
    btn("Approve").click();
    await flush();
    const pill = document.querySelector(".pcc-win-head .pcc-pill") as HTMLElement;
    expect(pill.textContent).toBe("resolved");
    expect(pill.className).toBe("pcc-pill st-ack");
    expect(document.body.innerHTML).not.toContain("st-settled");
  });

  it("a MONEY 2xx stays an amber 'Submitted - awaiting network confirmation' (gate + mirrored bar), never green", async () => {
    installFetch(() => ({ status: 200 }));
    boot(act({ path: "/api/escrow/chain/0xabc/fund", body: { amount: 1 } }));
    btn("Go").click();
    gateApproveBtn()!.click();
    await flush();
    expect(barStatus().textContent).toBe("Submitted - awaiting network confirmation");
    expect(barStatus().className).toBe("pcc-action-status st-waiting");
    expect(text(".pcc-overlay .pcc-action-status")).toBe("Submitted - awaiting network confirmation");
    expect(document.body.innerHTML).not.toContain("st-settled");
  });

  it("the kit stylesheet renders st-ack without a hue (never the signal green)", () => {
    installFetch(() => ({ status: 200 }));
    boot(act({ path: "/api/artifacts" }));
    const css = document.getElementById("pcc-ui-styles")!.textContent!;
    expect(css).toContain(".pcc-pill.st-ack{background:var(--surface-3);color:var(--ink-2);}");
    expect(css).toContain(".pcc-action-status.st-ack{color:var(--ink-2);}");
    expect(css).not.toMatch(/st-ack\{[^}]*--signal/);
  });
});

describe("B: each validation layer is closed on its own (defense in depth)", () => {
  // Pure helpers sliced from the SHIPPED source (the same brace-matched slicing the gateway suites use).
  function extractFn(name: string): string {
    const start = kitSrc.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`kit fn not found: ${name}`);
    const open = kitSrc.indexOf("{", start);
    let depth = 0;
    for (let j = open; j < kitSrc.length; j++) {
      if (kitSrc[j] === "{") depth++;
      else if (kitSrc[j] === "}" && --depth === 0) return kitSrc.slice(start, j + 1);
    }
    throw new Error(`unbalanced braces extracting ${name}`);
  }
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
  const kit = new Function([
    extractFn("isAbsoluteOrSchemeUrl"), extractFn("safeApiPath"), extractFn("canonicalPath"),
    "return { safeApiPath: safeApiPath, canonicalPath: canonicalPath };",
  ].join("\n"))() as { safeApiPath(p: string, host: boolean): string | null; canonicalPath(p: string): string | null };
  const ambiguous = ["/api%2Ffeedback", "/api%2ffeedback", "/api%252Ffeedback", "/api/x%25", "/api/x%5C", "/api/x%5c", "/api/x%3F", "/api/x%23"];

  it("canonicalPath refuses every ambiguous escape by itself, so the classifier stays closed if validation regresses", () => {
    for (const p of ambiguous) expect(kit.canonicalPath(p), p).toBeNull();
    expect(kit.canonicalPath("/api/x%E0%A4%A")).toBeNull(); // malformed escape
    expect(kit.canonicalPath("/api/fiat%2Dramp/session")).toBe("/api/fiat-ramp/session");
  });

  it("safeApiPath refuses ambiguous encodings in the PATH (a query may still carry an escaped value)", () => {
    for (const p of ambiguous) expect(kit.safeApiPath(p, false), p).toBeNull();
    expect(kit.safeApiPath("/api/jobs?q=100%25", false)).toBe("/api/jobs?q=100%25");
    expect(kit.safeApiPath("/api/compose\u0085", false)).toBeNull(); // a C1 control
  });
});

describe("B (ruling 3): the display IS the wire -- every field the request sends is shown, nothing it does not send", () => {
  // A body whose "__proto__" key would re-parent a copy made by assignment: the inherited amount/ref
  // would be DISPLAYED while the wire carried only the own keys. Built with JSON.parse so the key is
  // a real own property of the manifest JSON (an object literal's __proto__ sets the prototype instead).
  const protoBody = () =>
    JSON.parse('{"__proto__":{"amount":1,"jobId":"benign"},"totalAmount":1000000,"escrowId":"evil"}') as Record<string, unknown>;
  const all = (sel: string) => Array.from(document.querySelectorAll(sel)).map((e) => e.textContent);
  const bodyRows = (scope: string) => Array.from(document.querySelectorAll(`${scope} .pcc-realreq-body .pcc-args-row`)).map((r) => [
    r.querySelector(".pcc-args-k")!.textContent, r.querySelector(".pcc-args-v")!.textContent,
  ]);
  const FUND = "/api/escrow/chain/0xabc/fund";

  it("an actions-bar body with a __proto__ key is refused at validation: blocked, no gate, nothing sent", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(act({ path: FUND, body: protoBody() }));
    expect(btn("Go").textContent).toBe("Go · blocked");
    btn("Go").click();
    await flush();
    expect(overlays()).toBe(0);
    expect(calls.length).toBe(0);
    expect(barStatus().textContent).toMatch(/^Refused: the request body has a "__proto__" key.* - nothing was sent\.$/);
  });

  it("an approval window whose approve body has a __proto__ key shows BLOCKED, never the inherited amount or ref, and sends nothing", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    boot(man([{ ...approvalWin, approve: { ...approvalWin.approve, body: protoBody() } }]));
    await flush();
    expect(text(".pcc-win .pcc-realreq-blocked")).toContain('"__proto__"');
    const block = text(".pcc-win .pcc-realreq") || "";
    expect(block).not.toContain("benign");
    expect(block).not.toContain("Amount 1.00");
    btn("Approve").click();
    await flush();
    expect(posts(calls).length).toBe(0);
  });

  it("a form field named __proto__ cannot make the gate show an amount the wire does not carry", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    const schema = JSON.parse('{"properties":{"__proto__":{"type":"object","default":"{\\"amount\\":1,\\"jobId\\":\\"benign\\"}"},"note":{"type":"string","default":"hi"}}}');
    boot(man([{ kind: "form", schema, submit: { id: "s", label: "Send", kind: "post", path: FUND } }]));
    btn("Send").click();
    expect(overlays()).toBe(1);
    expect(all(".pcc-overlay .pcc-realreq-amt")).toEqual([]);
    expect(text(".pcc-overlay .pcc-realreq") || "").not.toContain("benign");
    gateApproveBtn()!.click();
    await flush();
    const { idempotencyKey, ...wire } = posts(calls)[0]!.body!;
    expect(idempotencyKey).toMatch(/^idem-/);
    expect(wire).toEqual({ note: "hi" });
  });

  it("several amount fields: the gate names EACH one, so a small 'amount' cannot stand in for a large 'totalAmount'", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    boot(act({ path: FUND, body: { amount: 1, totalAmount: 1000000 } }));
    btn("Go").click();
    expect(all(".pcc-overlay .pcc-realreq-amt")).toEqual(["amount 1.00 USDC", "totalAmount 1,000,000.00 USDC"]);
    gateApproveBtn()!.click();
    await flush();
    expect(posts(calls)[0]!.body).toMatchObject({ amount: 1, totalAmount: 1000000 });
  });

  it("several reference fields: each is named, so a benign jobId cannot hide the escrowId that is also sent", () => {
    installFetch(() => ({ status: 200 }));
    boot(act({ path: FUND, body: { jobId: "benign", escrowId: "evil" } }));
    btn("Go").click();
    expect(all(".pcc-overlay .pcc-realreq-ref")).toEqual(["jobId benign", "escrowId evil"]);
  });

  it("the approval window shows every other body field exactly as the wire carries it", async () => {
    const calls = installFetch(okGetsAnd({ status: 200 }));
    const body = { escrowId: "esc-1", amount: 21.99, payee: "0xevil", split: { a: 1 }, note: "5" };
    boot(man([{ ...approvalWin, approve: { ...approvalWin.approve, body } }]));
    await flush();
    expect(all(".pcc-win .pcc-realreq-amt")).toEqual(["Amount 21.99 USDC"]);
    expect(all(".pcc-win .pcc-realreq-ref")).toEqual(["ref esc-1"]);
    expect(bodyRows(".pcc-win")).toEqual([["payee", '"0xevil"'], ["split", '{"a":1}'], ["note", '"5"']]);
    btn("Approve").click();
    await flush();
    const { idempotencyKey, ...wire } = posts(calls)[0]!.body!;
    expect(idempotencyKey).toMatch(/^idem-/);
    expect(wire).toEqual(body);
  });

  it("the gate accounts for every key the wire carries (only the kit's idempotencyKey is added)", async () => {
    const calls = installFetch(() => ({ status: 200 }));
    const body = { amount: 3, currency: "USDC", asset: "ETH", jobId: "j1", offerId: "o1", memo: "m", n: null, deep: { x: [1, 2] } };
    boot(act({ path: FUND, body }));
    btn("Go").click();
    expect(all(".pcc-overlay .pcc-realreq-amt")).toEqual(["Amount 3.00 USDC"]); // amount + its currency
    expect(all(".pcc-overlay .pcc-realreq-ref")).toEqual(["jobId j1", "offerId o1"]);
    expect(bodyRows(".pcc-overlay")).toEqual([["asset", '"ETH"'], ["memo", '"m"'], ["n", "null"], ["deep", '{"x":[1,2]}']]);
    gateApproveBtn()!.click();
    await flush();
    expect(Object.keys(posts(calls)[0]!.body!).sort()).toEqual([...Object.keys(body), "idempotencyKey"].sort());
  });

  it("an amount that is not a plain number is shown as sent, never coerced into a sum", () => {
    installFetch(() => ({ status: 200 }));
    const cases: Array<[unknown, string]> = [
      [true, "Amount true USDC"], [[1000], "Amount [1000] USDC"], ["0x0F4240", 'Amount "0x0F4240" USDC'],
      [{ v: 5 }, 'Amount {"v":5} USDC'], ["21.99", "Amount 21.99 USDC"], [12, "Amount 12.00 USDC"],
    ];
    for (const [amount, shown] of cases) {
      boot(act({ path: FUND, body: { amount } }));
      btn("Go").click();
      expect(text(".pcc-overlay .pcc-realreq-amt"), JSON.stringify(amount)).toBe(shown);
    }
  });
});
