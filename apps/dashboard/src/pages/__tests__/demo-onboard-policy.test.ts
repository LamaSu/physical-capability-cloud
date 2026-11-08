// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUBLIC = resolve(__dirname, "../../../public");
const PAGES = [
  {
    file: "pizza-onboard-shop.html",
    rowText: "Your order policy isn't saved: this demo doesn't save policies.",
    subtitle: "This demo doesn't save your policy, so your choice here doesn't change how orders are handled.",
  },
  {
    file: "pizza-onboard-driver.html",
    rowText: "Your delivery policy isn't saved: this demo doesn't save policies.",
    subtitle: "This demo doesn't save your policy, so your choice here doesn't change how deliveries are handled.",
  },
];
const MODES = [
  { ...PAGES[0], mode: "auto" },
  { ...PAGES[0], mode: "negotiate" },
  { ...PAGES[0], mode: "always-prompt" },
  { ...PAGES[1], mode: "auto" },
  { ...PAGES[1], mode: "always-prompt" },
];
let requests: [string, string][];
const read = (file: string) => readFileSync(resolve(PUBLIC, file), "utf8");
const gate = () => (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
const click = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();

function load(file: string, query = "", runGate = true) {
  history.replaceState(null, "", "/" + file + query);
  const parsed = new DOMParser().parseFromString(read(file), "text/html");
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  if (runGate && document.querySelector('script[src="/demo-gate.js"]') && existsSync(resolve(PUBLIC, "demo-gate.js"))) new Function(read("demo-gate.js"))();
  for (const script of document.querySelectorAll("script:not([src])")) new Function(script.textContent || "")();
}
async function settle() {
  if (gate()) await gate();
  await vi.advanceTimersByTimeAsync(0);
}
function drive(mode: string, policyOnly = false) {
  click("#backBtn");
  for (let step = 0; step < 6; step++) {
    const next = document.querySelector<HTMLButtonElement>("#nextBtn");
    if (!next || next.style.display === "none") break;
    if (document.querySelector("[data-mode]")) {
      click(`[data-mode="${mode}"]`);
      expect(document.querySelector(".pcard.sel")?.getAttribute("data-mode")).toBe(mode);
      if (policyOnly) break;
    }
    for (const input of document.querySelectorAll<HTMLInputElement>("[data-f], [data-mf]")) {
      const field = input.dataset.f || input.dataset.mf;
      if (field === "name") input.value = "probe";
      else if (field === "email") input.value = "operator@example.com";
      else if (input.type === "number" && !input.value) input.value = "1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    next.click();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollTo", vi.fn());
  sessionStorage.clear();
  localStorage.clear();
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    const method = options?.method || "GET";
    requests.push([method, String(url)]);
    const path = new URL(String(url), location.origin).pathname;
    if (path === "/sse/demo/firehose") return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (path === "/api/auth/provision") return new Response('{"api_key":"pcc_live_test"}', { status: 201 });
    if (path === "/api/kernels") return new Response('{"kernel":{"id":"k1"}}');
    if (path === "/api/capabilities") return new Response('{"capability":{"id":"c1"}}');
    if (path === "/api/skills/register") return new Response('{"id":"s1"}');
    if (path === "/api/skills") return new Response('{"entries":[]}');
    if (path === "/api/capabilities/by-type/pizza") return new Response('{"capabilities":[]}');
    if (method === "POST" && path.includes("/_dev/")) return new Response("{}");
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
});

describe("the onboarding wizards' policy step", () => {
  it.each(MODES)("$file in $mode mode ends by saying the policy isn't saved, and sends no policy request", async (page) => {
    load(page.file);
    await settle();
    drive(page.mode);
    await vi.runAllTimersAsync();

    expect.soft(requests.filter(([, url]) => url.includes("operator-policy") || url.includes("/api/operator/policy"))).toEqual([]);
    expect.soft(requests.filter(([method]) => method === "PUT" || method === "PATCH")).toEqual([]);
    const lastRow = document.querySelector("#liveLog .call:last-child");
    expect.soft(lastRow?.querySelector(".lab")?.textContent).toBe(page.rowText);
    expect.soft(lastRow?.querySelector(".st")?.textContent).toBe("not saved");
    expect.soft(lastRow?.className).toBe("call warn");
    const policyLine = Array.from(document.querySelectorAll(".live-card .meta > span")).find((el) => el.textContent?.startsWith("policy · "));
    expect.soft(policyLine?.textContent).toBe("policy · not saved");
    expect.soft(document.querySelector("#liveTitle")?.textContent).toBe("You're live.");
  });

  it.each(PAGES)("$file's policy step says this demo doesn't save the policy", async (page) => {
    load(page.file);
    await settle();
    drive("auto", true);

    expect.soft(document.querySelector("#stepBody p.sub")?.textContent).toBe(page.subtitle);
    for (const card of document.querySelectorAll(".pcard")) expect.soft(card.textContent).not.toContain("best for the demo");
  });

  it("neither wizard keeps the policy request, its body builder or its PUT helper", () => {
    for (const page of PAGES) {
      const source = read(page.file);
      expect.soft(source).not.toContain("/api/demo/operator-policy");
      expect.soft(source).not.toContain("policyBody");
      expect.soft(source).not.toContain("async function put(");
    }
  });
});
