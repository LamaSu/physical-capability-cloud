// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUBLIC = resolve(__dirname, "../../../public");
let requests: [string, string, Record<string, unknown> | undefined][];
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
    requests.push([method, String(url), options?.body ? JSON.parse(String(options.body)) : undefined]);
    const path = new URL(String(url), location.origin).pathname;
    if (path === "/sse/demo/firehose") return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
    if (path === "/api/auth/provision") return new Response('{"api_key":"pcc_live_test"}', { status: 201 });
    if (path === "/api/kernels") return new Response('{"kernel":{"id":"kernel_t1_ab12"}}');
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

describe("the onboarding wizards' dashboard links", () => {
  it("the shop wizard registers as a source and links its dashboard to its kernel id", async () => {
    load("pizza-onboard-shop.html");
    await settle();
    drive("auto");
    await vi.runAllTimersAsync();

    const node = requests.find(([method, url]) => method === "POST" && new URL(url, location.origin).pathname === "/api/capabilities/graph/_dev/register-node");
    expect.soft(node?.[2]?.inputTypes).toEqual([]);
    expect.soft(document.querySelector("[data-copy]")?.getAttribute("data-copy")).toBe(location.origin + "/operator.html?shop=kernel_t1_ab12");
    const slug = Array.from(document.querySelectorAll(".live-card .meta > span")).find((el) => el.textContent?.startsWith("slug · "));
    expect.soft(slug?.textContent).toBe("slug · kernel_t1_ab12");
  });

  it("the driver wizard's kernel id is the slug its dashboard link carries", async () => {
    load("pizza-onboard-driver.html");
    await settle();
    drive("auto");
    await vi.runAllTimersAsync();

    const link = document.querySelector("[data-copy]")?.getAttribute("data-copy");
    expect(link).toBeTruthy();
    const slug = new URL(link!).searchParams.get("driver");
    expect(slug).toBeTruthy();
    for (const path of ["/api/compose/_dev/register-candidate", "/api/capabilities/graph/_dev/register-node"]) {
      const request = requests.find(([method, url]) => method === "POST" && new URL(url, location.origin).pathname === path);
      expect.soft(request?.[2]?.kernelId).toBe(slug);
    }
  });

  it("the policy step's hints claim no effect", async () => {
    for (const file of ["pizza-onboard-shop.html", "pizza-onboard-driver.html"]) {
      load(file);
      await settle();
      drive("auto", true);

      if (file === "pizza-onboard-driver.html") expect.soft(document.querySelector("#stepBody .human")).toBeNull();
      const floor = document.querySelector('[data-f="priceFloor"]');
      expect.soft(floor?.closest(".field")?.querySelector(".hint")?.textContent).toBe("USDC");
    }
  });
});
