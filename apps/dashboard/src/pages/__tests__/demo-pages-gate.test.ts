// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PUBLIC = resolve(__dirname, "../../../public");
const offText = "The pizza demo is off on this deployment.";
const origin = location.origin;
const PAGES = [
  { file: "order.html", query: "", marker: "Order a pizza from any shop, any driver.", startup: [], streams: [] },
  { file: "driver.html", query: "?driver=driver-alex", marker: "available — waiting for the next delivery.", startup: [["GET", origin + "/api/demo/jobs/driver-alex/queue"]], streams: [origin + "/sse/demo/driver/driver-alex"] },
  { file: "operator.html", query: "?shop=shop-roma", marker: "idle — waiting for the next job to come in via PCC.", startup: [["GET", origin + "/api/demo/jobs/shop-roma/queue"]], streams: [origin + "/sse/demo/operator/shop-roma"] },
  { file: "operator-capture.html", query: "?jobId=job_t&shop=shop-roma&phase=complete", marker: "Prove the pizza.", startup: [["POST", "/api/auth/provision"], ["POST", "/api/capture/challenge"]], streams: [] },
  { file: "pizza-observability.html", query: "", marker: "Live event feed", startup: [["GET", origin + "/api/demo/orders/observability"]], streams: [origin + "/sse/demo/firehose"] },
  { file: "pizza-llm-bootstrap.html", query: "", marker: "Order pizza with your AI.", startup: [["GET", "/pizza-llm-agent-prompt.md"]], streams: [] },
  { file: "pizza-onboard-driver.html", query: "", marker: "Deliver pizza for the network.", startup: [], streams: [] },
  { file: "pizza-onboard-shop.html", query: "", marker: "Sell pizza to any agent on the network.", startup: [], streams: [] },
  { file: "pizza-onboard-user.html", query: "", marker: "Get an agent that orders pizza for you.", startup: [], streams: [] },
  { file: "pizza-llm-agent-prompt.html", query: "", marker: "You are a pizza-ordering agent on PCC", startup: [["GET", "/pizza-llm-agent-prompt.md"]], streams: [] },
  { file: "pizza-demo-index.html", query: "", marker: "Already onboarded?", startup: [], streams: [] },
];
type Page = typeof PAGES[number];
type Answer = "off" | "on" | "unknown" | "pending";
let requests: [string, string][];
let streams: string[];
let sequence: [string, string][];
let answer: Answer;
let reply: ((response: Response) => void) | undefined;
let permissions: unknown[];
const read = (file: string) => readFileSync(resolve(PUBLIC, file), "utf8");
const off = () => new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
const stream = () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
const gate = () => (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
const click = (selector: string) => document.querySelector<HTMLElement>(selector)?.click();
const bodyText = () => {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll("script").forEach((el) => el.remove());
  return body.textContent || "";
};
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
function drive() {
  click("#backBtn");
  for (let step = 0; step < 6; step++) {
    const next = document.querySelector<HTMLButtonElement>("#nextBtn");
    if (!next || next.style.display === "none") break;
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
function presses(page: Page) {
  if (page.file === "order.html") {
    const user = document.querySelector<HTMLInputElement>("#userId");
    if (user) user.value = "probe";
    click("#planBtn");
  } else if (page.file === "operator-capture.html") click("#captureBtn");
  else if (page.file === "pizza-llm-bootstrap.html") click("#copyBtn");
  else if (page.file === "pizza-llm-agent-prompt.html") click("#copyAll");
  else if (page.file.startsWith("pizza-onboard-")) drive();
}
function expectOff() {
  expect(document.querySelector("#demo-off h1")?.textContent).toBe(offText);
  const link = document.querySelector("#demo-off a");
  expect(link?.textContent).toBe("Home");
  expect(link?.getAttribute("href")).toBe("/");
  const header = document.querySelector("body > header")!;
  expect(Array.from(header.children)).toEqual([header.querySelector(".brand")]);
  expect(document.querySelectorAll("body > main")).toHaveLength(1);
  expect(document.querySelector("body > main")?.id).toBe("demo-off");
}
async function expectStartup(page: Page, probe: boolean) {
  const expected = [...(probe ? [["GET", origin + "/sse/demo/firehose"]] : []), ...page.startup];
  expect(requests).toEqual(expected);
  expect(streams).toEqual(page.streams);
  expect(sequence).toEqual([...expected, ...page.streams.map((url) => ["EventSource", url])]);
  expect(bodyText()).toContain(page.marker);
  if (page.file.startsWith("pizza-onboard-")) expect(document.querySelector<HTMLButtonElement>("#nextBtn")?.onclick).toBeTypeOf("function");
  if (page.file === "order.html") {
    presses(page);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toEqual([...expected, ["POST", origin + "/api/demo/pizza-order"]]);
  }
  if (page.file === "pizza-observability.html") {
    await vi.advanceTimersByTimeAsync(8000);
    expect(requests).toEqual([...expected, ...page.startup, ...page.startup]);
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollTo", vi.fn());
  sessionStorage.clear();
  localStorage.clear();
  requests = [];
  streams = [];
  sequence = [];
  answer = "off";
  reply = undefined;
  vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
    const entry: [string, string] = [options?.method || "GET", String(url)];
    requests.push(entry);
    sequence.push(entry);
    if (String(url).endsWith("/sse/demo/firehose")) {
      if (answer === "pending") return new Promise<Response>((resolve) => { reply = resolve; });
      if (answer === "unknown") return Promise.reject(new TypeError("fetch failed"));
      return Promise.resolve(answer === "off" ? off() : stream());
    }
    if (url === "/api/auth/provision") return Promise.resolve(new Response('{"api_key":"pcc_live_test"}', { status: 201 }));
    if (url === "/pizza-llm-agent-prompt.md") return Promise.resolve(new Response("# You are a pizza-ordering agent on PCC", { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 503 }));
  }));
  vi.stubGlobal("EventSource", class {
    constructor(url: string) { streams.push(url); sequence.push(["EventSource", url]); }
    close() {}
  });
  const getUserMedia = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  const getCurrentPosition = vi.fn((_success: unknown, failure: (error: { message: string }) => void) => failure({ message: "fetch failed" }));
  const watchPosition = vi.fn();
  const requestPermission = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  const get = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  const create = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
  permissions = [getUserMedia, getCurrentPosition, watchPosition, requestPermission, get, create];
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition, watchPosition } });
  Object.defineProperty(navigator, "credentials", { configurable: true, value: { get, create } });
  vi.stubGlobal("DeviceMotionEvent", { requestPermission });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
});

describe.each(PAGES)("$file", (page) => {
  it("makes no request but the check, opens no stream and starts no timer when the demo is off", async () => {
    answer = "pending";
    load(page.file, page.query);
    presses(page);
    if (reply) reply(off());
    await settle();
    presses(page);
    await vi.advanceTimersByTimeAsync(60000);
    expect(requests).toEqual(existsSync(resolve(PUBLIC, "demo-gate.js")) ? [["GET", origin + "/sse/demo/firehose"]] : []);
    expect(streams).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shows only the brand and the off notice when the demo is off", async () => {
    load(page.file, page.query);
    await settle();
    expectOff();
    const text = bodyText();
    expect(text).not.toContain(page.marker);
    expect(text).not.toMatch(/\$|\b(?:USDC|PASS|FAIL|hash|tier|live|earnings|settle|fee|reconnecting|down|outage|error|unavailable|try again)\b/i);
  });
  it("runs today's start-up after the check when the demo is on", async () => {
    answer = "on";
    load(page.file, page.query);
    await settle();
    await expectStartup(page, true);
  });
  it("runs today's start-up when the check gets no answer", async () => {
    answer = "unknown";
    load(page.file, page.query);
    await settle();
    await expectStartup(page, existsSync(resolve(PUBLIC, "demo-gate.js")));
    expect(document.querySelector("#demo-off")).toBeNull();
  });
  it("runs today's start-up when the gate script is missing", async () => {
    load(page.file, page.query, false);
    await settle();
    await expectStartup(page, false);
    expect(document.querySelector("#demo-off")).toBeNull();
  });
  it("asks search engines not to index it", () => {
    const parsed = new DOMParser().parseFromString(read(page.file), "text/html");
    expect(parsed.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex");
  });
  it("loads the gate before its own script", () => {
    const html = read(page.file);
    const gateIndex = html.indexOf('<script src="/demo-gate.js"');
    const inlineIndex = html.search(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i);
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    if (inlineIndex !== -1) expect(gateIndex).toBeLessThan(inlineIndex);
    expect(html).toMatch(/<script src="\/demo-gate\.js"(?: data-base-param="\w+")?><\/script>/);
  });
});
describe("deep links", () => {
  it.each(["/driver.html?driver=driver-carlos", "/operator.html?shop=shop-mamas-kitchen", "/operator-capture.html?jobId=job_deeplink&driver=driver-dana&phase=pickup", "/operator-capture.html"])("shows the notice and none of the link's query text for %s when the demo is off", async (link) => {
    const url = new URL(link, origin);
    load(url.pathname.slice(1), url.search);
    await settle();
    expectOff();
    for (const text of ["driver-carlos", "shop-mamas-kitchen", "job_deeplink", "driver-dana", "No jobId in URL"]) expect(bodyText()).not.toContain(text);
  });
});
describe("capture page", () => {
  it("asks for no device permission and mints no key when the demo is off", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    load(PAGES[3].file, PAGES[3].query);
    await settle();
    click("#captureBtn");
    await vi.advanceTimersByTimeAsync(0);
    for (const permission of permissions) expect(permission).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
    expect(requests).toEqual([["GET", origin + "/sse/demo/firehose"]]);
  });
  it("checks the demo before it mints a key when the demo is on", async () => {
    answer = "pending";
    load(PAGES[3].file, PAGES[3].query);
    expect(requests).toEqual([["GET", origin + "/sse/demo/firehose"]]);
    reply?.(stream());
    await settle();
    expect(requests.slice(0, 2)).toEqual([["GET", origin + "/sse/demo/firehose"], ["POST", "/api/auth/provision"]]);
  });
});
describe("demo labels", () => {
  it.each(["order.html", "driver.html", "operator.html", "pizza-observability.html", "operator-capture.html"])("%s names the pizza demo in its header", (file) => {
    const parsed = new DOMParser().parseFromString(read(file), "text/html");
    expect(parsed.querySelector("body > header .brand")?.textContent).toContain("// pizza demo");
  });
  it("the observability step details tag the evidence and tier rows as mock", () => {
    const html = read("pizza-observability.html");
    expect(html).toContain('if(det.evidenceHash)rows.push(["evidence",`${esc(det.evidenceHash)} <span class="tag mock">mock</span>`]);');
    expect(html).toContain('if(det.assuranceTier!=null)rows.push(["assurance tier",`T${det.assuranceTier} <span class="tag mock">mock</span>`]);');
  });
});
describe("wizard API override", () => {
  it.each(["pizza-onboard-driver.html", "pizza-onboard-shop.html", "pizza-onboard-user.html"])("checks the API the wizard writes to: %s", async (file) => {
    answer = "pending";
    load(file, "?api=http://other.test/");
    expect(requests[0]).toEqual(["GET", "http://other.test/sse/demo/firehose"]);
    reply?.(stream());
    await settle();
    drive();
    await vi.advanceTimersByTimeAsync(0);
    expect(requests[1]).toEqual(["POST", "http://other.test/api/auth/provision"]);
    vi.clearAllTimers();
    delete (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
    requests = [];
    answer = "pending";
    load(file, "?api=http://other.test/%20");
    expect(requests[0]).toEqual(["GET", "http://other.test/sse/demo/firehose"]);
  });
});
