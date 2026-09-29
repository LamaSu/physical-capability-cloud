/**
 * Summit signup: a lost reply or a page exit never splits or drops a lead (astra,
 * pack 53 verdict: NEW-3 PARTIAL and new defect 1). Reproduced at 91d793db before
 * any code changed.
 *
 * The page waited for the server to issue the lead's token in its FIRST reply and
 * serialized saves until then. So:
 *   - NEW-3: when that first reply was lost (the record written, the response
 *     not), the next save went out without a token and opened a second record;
 *   - new defect 1: a pagehide while the first save was pending only set a flag,
 *     so the fields collected since were never sent once the document was gone.
 *
 * This runs the page's REAL script (extracted from SUMMIT_HTML) in a VM, with a
 * fetch whose replies the test controls (including losing them) and captured
 * window listeners, so it can fire pagehide.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { SUMMIT_HTML } from "../routes/summit-page.js";

type Call = { url: string; body: Record<string, unknown> | null; respond: (payload: unknown) => void; lose: () => void };

function harness() {
  const calls: Call[] = [];
  const els = new Map<string, any>();
  const windowListeners: Record<string, Array<() => void>> = {};
  const el = (id: string): any => {
    if (!els.has(id)) {
      const listeners: Record<string, Array<(e: unknown) => void>> = {};
      els.set(id, {
        id,
        value: "",
        hidden: false,
        textContent: "",
        disabled: false,
        listeners,
        addEventListener(type: string, fn: (e: unknown) => void) {
          (listeners[type] ??= []).push(fn);
        },
        getAttribute: () => "0",
        classList: { toggle() {}, add() {}, remove() {} },
        querySelector: () => el(`${id}-child`),
      });
    }
    return els.get(id);
  };
  const context = {
    document: {
      getElementById: el,
      querySelector: (sel: string) => el(`q:${sel}`),
      querySelectorAll: () => [],
      addEventListener() {},
      visibilityState: "visible",
    },
    window: {
      addEventListener(type: string, fn: () => void) {
        (windowListeners[type] ??= []).push(fn);
      },
    },
    location: { search: "" },
    URLSearchParams,
    crypto: globalThis.crypto,
    fetch: (url: string, init?: { body?: string }) =>
      new Promise((resolve, reject) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
          respond: (payload) => resolve({ json: () => Promise.resolve(payload) }),
          lose: () => reject(new TypeError("network error: the reply was lost")),
        });
      }),
  };
  const script = /<script>([\s\S]*?)<\/script>/.exec(SUMMIT_HTML)?.[1];
  if (!script) throw new Error("no <script> in SUMMIT_HTML");
  vm.runInNewContext(script, context);
  const submit = (formId: string) => {
    for (const fn of el(formId).listeners.submit ?? []) fn({ preventDefault() {}, target: el(`${formId}-target`) });
  };
  const fire = (type: string) => {
    for (const fn of windowListeners[type] ?? []) fn();
  };
  const saves = () => calls.filter((c) => c.url === "/api/waitlist");
  return { calls, el, submit, fire, saves };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("summit signup: a lost reply or a page exit never splits or drops a lead", () => {
  it("[neg] NEW-3: after the first reply is LOST, every later save still continues the SAME lead (same token)", async () => {
    const h = harness();
    h.el("email").value = "ann@x.test";
    h.submit("fEmail");
    await flush();
    h.saves()[0].lose(); // the record was written; the reply never arrived
    await flush();
    h.el("name").value = "Ann";
    h.submit("fName");
    await flush();
    const tokens = h.saves().map((c) => c.body?.leadToken);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    for (const t of tokens) expect(typeof t === "string" && t.length >= 16, `token ${String(t)}`).toBe(true);
    expect(new Set(tokens).size).toBe(1);
  });

  it("[neg] new defect 1: a pagehide while the first save is pending sends the fields collected since, at once", async () => {
    const h = harness();
    h.el("email").value = "bea@x.test";
    h.submit("fEmail"); // first save in flight, no reply yet
    await flush();
    h.el("name").value = "Bea"; // typed, not submitted
    h.fire("pagehide");
    await flush();
    const withName = h.saves().filter((c) => c.body?.name === "Bea");
    expect(withName.length).toBeGreaterThanOrEqual(1);
    // ...and it continues the same lead as the first save.
    expect(withName[0].body?.leadToken).toBe(h.saves()[0].body?.leadToken);
  });

  it("control: the normal flow sends each step with the same lead id and token", async () => {
    const h = harness();
    h.el("email").value = "cy@x.test";
    h.submit("fEmail");
    await flush();
    h.saves()[0].respond({ status: "ok", leadToken: h.saves()[0].body?.leadToken });
    await flush();
    h.el("name").value = "Cy";
    h.submit("fName");
    await flush();
    const s = h.saves();
    expect(new Set(s.map((c) => c.body?.leadId)).size).toBe(1);
    expect(new Set(s.map((c) => c.body?.leadToken)).size).toBe(1);
  });
});
