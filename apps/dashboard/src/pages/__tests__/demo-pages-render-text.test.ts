import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { builtinEnvironments } from "vitest/environments";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const name = '<img src=x onerror="window.__hit=1">';
const value = '"><svg onload="window.__hit=1">';
let page: Window & typeof globalThis & { __hit?: number };
let teardown: () => void | PromiseLike<void>;
let fetchMock: Mock<[], Promise<Response>>;

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    EventSourceStub.instances.push(this);
  }
  close() {}
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event }) });
  }
}

beforeEach(async () => {
  const environment = await builtinEnvironments.jsdom.setupVM!({
    jsdom: {
      url: "https://example.test/",
      beforeParse(window: typeof page) { page = window; },
    },
  });
  teardown = () => environment.teardown();
  fetchMock = vi.fn(async () => Response.json({}));
  page.fetch = fetchMock as typeof fetch;
  page.EventSource = EventSourceStub as unknown as typeof EventSource;
  EventSourceStub.instances = [];
});

afterEach(() => teardown());

function boot(file: string, query = "") {
  const html = readFileSync(resolve(__dirname, "../../../public", file), "utf8");
  const between = (start: string, end: string) => {
    const offset = html.indexOf(start) + start.length;
    return html.slice(offset, html.indexOf(end, offset));
  };
  page.history.replaceState(null, "", `/${file}${query}`);
  page.document.head.innerHTML = `<style>${between("<style>", "</style>")}</style>`;
  page.document.body.innerHTML = between("<body>", "<script>");
  page.eval(between("<script>", "</script>"));
}

function expectText(selector: string, ...texts: string[]) {
  const region = page.document.querySelector(selector)!;
  expect.soft(region.querySelector("img, svg")).toBeNull();
  for (const text of texts) expect.soft(region.textContent).toContain(text);
  expect.soft(page.__hit).toBeUndefined();
}

function order(shopName = "Shop", driverName = "Driver") {
  return {
    order: {
      orderId: "order-test",
      composition: {
        shop: { name: shopName, etaSec: 600, priceUSD: 15 },
        driver: { name: driverName, etaSec: 300, priceUSD: 5 },
        totalPriceUSD: 20,
        etaSec: 900,
      },
    },
  };
}

async function plan() {
  (page.document.querySelector("#userId") as HTMLInputElement).value = "customer";
  (page.document.querySelector("#planBtn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(page.document.querySelectorAll("#steps .step")).toHaveLength(2));
}

it("the order page shows a plan's names as text", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(order(name, value)));
  boot("order.html");
  await plan();
  expectText("#steps", name, value);
});

it("the order page's timeline shows an assignee as text", async () => {
  fetchMock.mockResolvedValueOnce(Response.json(order()));
  boot("order.html");
  await plan();
  (page.document.querySelector("#confirmBtn") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(EventSourceStub.instances).toHaveLength(1));
  EventSourceStub.instances[0].emit({
    type: "job_accepted",
    job: { type: "make-pizza", assigneeSlug: value },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expectText("#timeline", value);
});

it("the shop dashboard shows an order and its own name as text", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ active: [], completed: [] }));
  boot("operator.html", `?shop=${encodeURIComponent(value)}`);
  await vi.waitFor(() => expect(page.document.querySelector("#queue #topicSlug")).toBeNull());
  expectText("#queue", value);
  fetchMock.mockResolvedValueOnce(Response.json({
    active: [{
      jobId: "job-test",
      status: "queued",
      details: { description: name, priceUSD: 15, deadlineSec: 600 },
    }],
    completed: [],
  }));
  await page.eval("loadQueue()");
  expectText("#queue", name);
});

it("the driver dashboard shows an order and its addresses as text", async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ active: [], completed: [] }));
  boot("driver.html", `?driver=${encodeURIComponent(value)}`);
  await vi.waitFor(() => expect(page.document.querySelector("#queue #topicSlug")).toBeNull());
  expectText("#queue", value);
  fetchMock.mockResolvedValueOnce(Response.json({
    active: [{
      jobId: "job-test",
      status: "queued",
      details: {
        description: name,
        priceUSD: 5,
        deadlineSec: 300,
        pickupAddress: name,
        deliveryAddress: value,
      },
    }],
    completed: [],
  }));
  await page.eval("loadQueue()");
  expectText("#queue", name, value);
  expectText("#queue .from", name);
  expectText("#queue .to", value);
});

it("the operator status page shows agent card links and error replies as text", async () => {
  fetchMock.mockResolvedValueOnce(new Response(name, { status: 502 }));
  boot("operator-status.html", "?slug=x");
  await vi.waitFor(() => expect(page.document.querySelector("#out .error")).not.toBeNull());
  expectText("#out", name);
  const url = 'https://x/" onmouseover="window.__hit=1';
  fetchMock.mockResolvedValueOnce(Response.json({
    operatorSlug: "x",
    status: "ready",
    totals: {
      kernelCount: 0,
      capabilityCount: 0,
      channelCount: 0,
      enabledChannelCount: 0,
      humanLaneCount: 0,
      machineLaneCount: 0,
    },
    kernels: [],
    capabilities: [],
    channels: [],
    agentCardUrls: [url],
  }));
  page.document.querySelector("#form")!.dispatchEvent(new page.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(page.document.querySelector("#out .acard-link")).not.toBeNull());
  expectText("#out", url);
  expect.soft(page.document.querySelector("[onmouseover]")).toBeNull();
  expect.soft(page.document.querySelector("#out .acard-link")!.getAttribute("href")).toBe(url);
});

it("the observability board shows a delivery location as text", async () => {
  const deliveryLocation = { lat: name, lng: value };
  fetchMock.mockResolvedValueOnce(Response.json({
    orders: [{
      ...order().order,
      status: "delivered",
      deliveryLocation,
      timeline: [{
        step: "pizza_delivered",
        at: "2026-01-01T12:00:00.000Z",
        detail: { gps: deliveryLocation },
      }],
    }],
  }));
  boot("pizza-observability.html");
  await vi.waitFor(() => expect(page.document.querySelector("#orders .ocard")).not.toBeNull());
  (page.document.querySelector('#orders [data-step="pizza_delivered"]') as HTMLButtonElement).click();
  expectText("#orders .ocard", name, value);
});
