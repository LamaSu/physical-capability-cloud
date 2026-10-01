/**
 * WP-A round 7 (wpa-326-admingates-r2-astra, new defect 3): progressive signup
 * could split one lead into several records. The server issues a lead's token in its
 * FIRST reply. Two saves sent before that reply both lacked it, so each opened a
 * record of its own.
 *
 * This runs the page's REAL script (extracted from SUMMIT_HTML) in a VM with a
 * controllable fetch and minimal DOM stubs, and drives it through the form's own
 * submit handlers.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { SUMMIT_HTML } from "../routes/summit-page.js";

type Call = { url: string; body: Record<string, unknown> | null; respond: (payload: unknown) => void };

function harness() {
  const calls: Call[] = [];
  const els = new Map<string, any>();
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
    window: { addEventListener() {} },
    location: { search: "" },
    URLSearchParams,
    fetch: (url: string, init?: { body?: string }) =>
      new Promise((resolve) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(init.body) : null,
          respond: (payload) => resolve({ json: () => Promise.resolve(payload) }),
        });
      }),
  };
  const script = /<script>([\s\S]*?)<\/script>/.exec(SUMMIT_HTML)?.[1];
  if (!script) throw new Error("no <script> in SUMMIT_HTML");
  vm.runInNewContext(script, context);
  const submit = (formId: string) => {
    for (const fn of el(formId).listeners.submit ?? []) fn({ preventDefault() {}, target: el(`${formId}-target`) });
  };
  return { calls, el, submit };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("summit signup: one lead is one record", () => {
  it("[neg] a second step before the first reply waits, then carries the issued token", async () => {
    const h = harness();
    h.el("email").value = "ann@x.test";
    h.submit("fEmail"); // first save: in flight
    h.el("name").value = "Ann";
    h.submit("fName"); // asked for before the token exists
    h.el("company").value = "Ann Co";
    h.submit("fCompany"); // collapses into the same follow-up

    const saves = () => h.calls.filter((c) => c.url === "/api/waitlist");
    expect(saves()).toHaveLength(1); // the old page sent all three at once, none with a token
    expect(saves()[0]!.body?.leadToken).toBeUndefined();

    saves()[0]!.respond({ status: "ok", leadToken: "tok_0123456789abcdef" });
    await flush();
    await flush();

    expect(saves()).toHaveLength(2); // ONE follow-up for the two queued steps
    expect(saves()[1]!.body).toMatchObject({ email: "ann@x.test", name: "Ann", company: "Ann Co", leadToken: "tok_0123456789abcdef" });
    expect(saves()[1]!.body?.leadId).toBe(saves()[0]!.body?.leadId);
  });

  it("control: once the token is known, each save goes out at once", async () => {
    const h = harness();
    h.el("email").value = "bo@x.test";
    h.submit("fEmail");
    const saves = () => h.calls.filter((c) => c.url === "/api/waitlist");
    saves()[0]!.respond({ status: "ok", leadToken: "tok_fedcba9876543210" });
    await flush();
    await flush();
    h.el("name").value = "Bo";
    h.submit("fName");
    h.el("company").value = "Bo Co";
    h.submit("fCompany");
    expect(saves()).toHaveLength(3);
    expect(saves().slice(1).every((c) => c.body?.leadToken === "tok_fedcba9876543210")).toBe(true);
  });
});
