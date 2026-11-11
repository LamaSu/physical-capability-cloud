// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const gatePath = resolve(__dirname, "../../../public/demo-gate.js");
const offText = "The pizza demo is off on this deployment.";
const stream = () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
const off = () => new Response('{"error":"not_found"}', { status: 404, headers: { "content-type": "application/json; charset=utf-8" } });
const gate = () => (window as unknown as { pccDemoGate: Promise<string> }).pccDemoGate;
let requests: [string, string][];
let fake: ReturnType<typeof vi.fn<[string, RequestInit], Promise<Response>>>;

function load(attribute = "", query = "") {
  history.replaceState(null, "", "/order.html" + query);
  document.head.innerHTML = "";
  document.body.innerHTML = `<header><div class="brand">PCC</div><span>live</span></header><main id="old"></main><script src="/demo-gate.js" ${attribute}></script>`;
  new Function(readFileSync(gatePath, "utf8"))();
}
async function settle() {
  const state = await gate();
  await vi.advanceTimersByTimeAsync(0);
  return state;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("scrollTo", vi.fn());
  requests = [];
  fake = vi.fn((_url: string, _options: RequestInit) => Promise.resolve(stream()));
  vi.stubGlobal("fetch", (url: string, options: RequestInit) => {
    requests.push([options?.method || "GET", String(url)]);
    return fake(url, options);
  });
  vi.stubGlobal("EventSource", class { constructor(_url: string) {} });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
});

describe("demo gate", () => {
  it("answers on for an event stream and closes the stream", async () => {
    load();
    expect(await settle()).toBe("on");
    expect(fake.mock.calls[0][1].signal!.aborted).toBe(true);
  });
  it("asks only the demo stream on its own origin, uncached and without credentials", async () => {
    load();
    await settle();
    expect(requests).toEqual([["GET", location.origin + "/sse/demo/firehose"]]);
    expect(fake.mock.calls[0][1]).toMatchObject({ cache: "no-store", credentials: "omit" });
  });
  it("answers unknown for a 200 that is not an event stream", async () => {
    fake.mockResolvedValue(new Response("", { status: 200, headers: { "content-type": "text/html" } }));
    load();
    expect(await settle()).toBe("unknown");
  });
  it.each([401, 429, 500, 502, 503])("answers unknown, never off, for HTTP %i", async (status) => {
    fake.mockResolvedValue(new Response("{}", { status }));
    load();
    expect(await settle()).toBe("unknown");
    expect(document.querySelector("#demo-off")).toBeNull();
  });
  it("answers unknown when the request fails", async () => {
    fake.mockRejectedValue(new TypeError("fetch failed"));
    load();
    expect(await settle()).toBe("unknown");
  });
  it("answers unknown after 5 seconds without a reply and aborts the request", async () => {
    fake.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new TypeError("fetch failed")));
    }));
    load();
    let answered = false;
    void gate().then(() => { answered = true; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle()).toBe("unknown");
    expect(fake.mock.calls[0][1].signal!.aborted).toBe(true);
  });
  it("never reads the host name and names no fixed host", () => {
    const source = readFileSync(gatePath, "utf8");
    expect(source).not.toContain("hostname");
    expect(source).not.toContain("location.host");
    expect(source).not.toContain("capability.network");
  });
  it("asks again on every load and stores nothing", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    fake.mockResolvedValueOnce(off()).mockResolvedValueOnce(stream());
    load();
    expect(await settle()).toBe("off");
    load();
    expect(await settle()).toBe("on");
    expect(requests).toHaveLength(2);
    expect(storage).not.toHaveBeenCalled();
  });
  it("answers off for a 404 and shows the off notice", async () => {
    fake.mockResolvedValue(off());
    load();
    expect(await settle()).toBe("off");
    expect(document.querySelector("#demo-off h1")?.textContent).toBe(offText);
    const link = document.querySelector("#demo-off a");
    expect(link?.textContent).toBe("Home");
    expect(link?.getAttribute("href")).toBe("/");
    expect(Array.from(document.querySelector("body > header")!.children)).toEqual([document.querySelector(".brand")]);
    expect(document.querySelector("#old")).toBeNull();
  });
  it("asks the base the page names in its query when the tag says so", async () => {
    load('data-base-param="base"', "?base=http://other.test/");
    await settle();
    expect(requests).toEqual([["GET", "http://other.test/sse/demo/firehose"]]);
    load("", "?base=http://other.test/");
    await settle();
    expect(requests[1]).toEqual(["GET", location.origin + "/sse/demo/firehose"]);
  });
});
