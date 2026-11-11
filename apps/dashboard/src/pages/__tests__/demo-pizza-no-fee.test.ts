// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const REPO = resolve(__dirname, "../../../../..");
const PUBLIC = resolve(__dirname, "../../../public");
const read = (file: string) => readFileSync(resolve(PUBLIC, file), "utf8");
const gate = () => (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
const FEE_WORDING =
  /\bplatform (?:fees?|tax(?:es)?)\b|\bprotocol fees?\b|\bpcc(?:['\u2019]s)? (?:cut|fees?)\b|\bfee (?:rate|collection|recipient|flows?)\b|\b2\.35 ?%/i;
const NEW_FEE = /\bfees?\b|pccfee|treasury|feebps|protocol-fee|\btax(?:es)?\b/i;
const PAGES = ["order.html", "driver.html", "operator.html", "operator-capture.html", "pizza-observability.html", "pizza-llm-bootstrap.html", "pizza-onboard-driver.html", "pizza-onboard-shop.html", "pizza-onboard-user.html", "pizza-llm-agent-prompt.html", "pizza-demo-index.html"];

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
function strings(value: unknown, location: string): Array<[string, string]> {
  if (typeof value === "string") return [[location, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${location}/${i}`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      strings(item, `${location}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
    );
  }
  return [];
}
function bodyText() {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll("script").forEach((el) => el.remove());
  return body.textContent || "";
}
class Stream {
  static instances: Stream[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) { Stream.instances.push(this); }
  close() {}
  push(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const pack = () => JSON.parse(read("pcc-agent-package-pizza.json"));
const tool = (name: string) => pack().tools.find((item: { name: string }) => item.name === name);

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  Stream.instances = [];
  vi.stubGlobal("EventSource", Stream);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } }))));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { pccDemoGate?: Promise<string> }).pccDemoGate;
});

describe("the pizza demo surfaces", () => {
  it("no page or agent document carries fee, treasury or tax text", () => {
    for (const file of [...PAGES, "pizza-llm-agent-prompt.md"]) {
      read(file).split(/\r?\n/).forEach((line, i) => {
        expect.soft(line, `${file}:${i + 1}`).not.toMatch(FEE_WORDING);
        expect.soft(line, `${file}:${i + 1}`).not.toMatch(NEW_FEE);
      });
    }
    const file = "pcc-agent-package-pizza.json";
    const source = read(file);
    for (const [, value] of strings(JSON.parse(source), file)) {
      const line = source.slice(0, source.indexOf(JSON.stringify(value))).split("\n").length;
      expect.soft(value, `${file}:${line}`).not.toMatch(FEE_WORDING);
      expect.soft(value, `${file}:${line}`).not.toMatch(NEW_FEE);
    }
  });

  it("the observability page shows four tiles, and a delivered order's sum equals its total", async () => {
    const example = tool("place_pizza_order").example.response.order;
    const at = "2026-06-12T23:30:00Z";
    const settlement = { shopPayoutUSD: 12, driverPayoutUSD: 4 };
    const order = {
      ...example, status: "delivered", userId: "alex@vibecode", description: "1 large pepperoni, extra cheese", deliveryAddress: "vibecodenights venue", deliveryLocation: { lat: 37.77, lng: -122.42 },
      createdAt: at, updatedAt: at, jobs: { makePizza: null, delivery: null },
      timeline: [{ step: "settlement_released", at, label: "Settlement released", role: "chain", detail: settlement }],
      chainEvents: [
        { type: "escrow_locked", amountUSDC: "16.00", contract: "MilestoneEscrowV2" },
        { type: "escrow_released", amountUSDC: "16.00", contract: "MilestoneEscrowV2" },
        { type: "usdc_transfer", amountUSDC: "12.00", contract: "USDC", data: { leg: "shop-payout" } },
        { type: "usdc_transfer", amountUSDC: "4.00", contract: "USDC", data: { leg: "driver-payout" } },
      ].map((event, i) => ({ ...event, id: String(i), orderId: example.orderId, at, txHash: "", blockNumber: 1, explorerUrl: "", mock: true })),
    };
    const stats = { activeOrders: 0, completedToday: 1, totalVolumeUSD: 16, avgTimeToDeliverSec: 60, totalOrders: 1 };
    const probe = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => String(url).endsWith("/api/demo/orders/observability")
      ? Promise.resolve(new Response(JSON.stringify({ orders: [order], stats, serverTime: at }), { status: 200 }))
      : probe(url, options)));
    load("pizza-observability.html");
    await settle();
    Stream.instances.find((stream) => stream.url.endsWith("/sse/demo/firehose"))!.push({ topic: `order:${order.orderId}`, event: { type: "delivered", settlement }, ts: at });
    document.querySelector<HTMLElement>('[data-step="settlement_released"]')?.click();
    document.querySelector<HTMLElement>(".fe")?.click();
    expect.soft(bodyText()).not.toMatch(FEE_WORDING);
    expect.soft(bodyText()).not.toMatch(NEW_FEE);
    expect.soft(document.querySelectorAll(".statbar .tile")).toHaveLength(4);
    const rule = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules)).find((entry) => "selectorText" in entry && entry.selectorText === ".statbar") as CSSStyleRule;
    expect.soft(rule.style.getPropertyValue("grid-template-columns")).toBe("repeat(4,1fr)");
    expect.soft(document.querySelector("#stVolume")?.textContent).toBe("$16.00");
    expect.soft(document.querySelector(".oc-price")?.textContent).toBe("$16.00");
    expect.soft(document.querySelector(".fe-msg")?.textContent).toBe("delivered · settled $16.00");
    expect.soft(document.querySelectorAll("#clog .crow")).toHaveLength(4);
    expect.soft(document.querySelector(".stepdetail pre")?.textContent).toBe(JSON.stringify(settlement, null, 2));
    expect.soft(document.querySelector(".fe.open pre")?.textContent).toContain(JSON.stringify(settlement, null, 2).split("\n")[1].trim());
  });

  it("the order page's settlement line names the two payouts, which add up to the plan total", async () => {
    const order = tool("place_pizza_order").example.response.order;
    const probe = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => String(url).endsWith("/api/demo/pizza-order")
      ? Promise.resolve(new Response(JSON.stringify({ order }), { status: 201 }))
      : String(url).endsWith(`/api/demo/orders/${order.orderId}/confirm`)
        ? Promise.resolve(new Response(JSON.stringify({ order }), { status: 200 }))
        : probe(url, options)));
    load("order.html");
    await settle();
    document.querySelector<HTMLInputElement>("#userId")!.value = "alex@vibecode";
    document.querySelector<HTMLElement>("#planBtn")!.click();
    await settle();
    document.querySelector<HTMLElement>("#confirmBtn")!.click();
    await settle();
    const settlement = { shopPayoutUSD: 12, driverPayoutUSD: 4 };
    Stream.instances.find((stream) => stream.url.endsWith(`/sse/demo/order/${order.orderId}`))!.push({ topic: `order:${order.orderId}`, event: { type: "delivered", settlement, reputation: { shopDelta: 15, driverDelta: 15 } } });
    expect.soft(document.querySelector("#timeline")?.textContent).toContain("settlement — shop $12 · driver $4");
    expect.soft(settlement.shopPayoutUSD + settlement.driverPayoutUSD).toBe(Number(document.querySelector("#totalPrice")?.textContent));
    expect.soft(Number(document.querySelector("#totalPrice")?.textContent)).toBe(16);
    expect.soft(bodyText()).not.toMatch(FEE_WORDING);
    expect.soft(bodyText()).not.toMatch(NEW_FEE);
  });

  it("the agent documents describe a settlement of exactly the two payouts", () => {
    const md = read("pizza-llm-agent-prompt.md");
    expect.soft(md).toContain('| `delivered` | Delivered. Carries `settlement` + `reputation`. | "Delivered! 🍕 Shop got $X, driver got $Y." |');
    expect.soft(md).toContain("`shopPayoutUSD` (what the shop earns), `driverPayoutUSD` (what the driver earns).\n**The `reputation` object:** `shopDelta`, `driverDelta`.");
    const watch = tool("watch_order");
    expect.soft(watch.output_schema.properties.event.properties.settlement.description).toBe("Present on delivered — shopPayoutUSD, driverPayoutUSD.");
    const event = watch.example.stream.map((line: string) => JSON.parse(line.slice(6))).find((item: { event?: { type: string } }) => item.event?.type === "delivered").event;
    expect.soft(Object.keys(event.settlement).sort()).toEqual(["driverPayoutUSD", "shopPayoutUSD"]);
    expect.soft(Object.values(event.settlement).reduce<number>((sum, amount) => sum + Number(amount), 0)).toBe(tool("place_pizza_order").example.response.order.composition.totalPriceUSD);
    expect.soft(tool("place_pizza_order").example.response.order.composition.totalPriceUSD).toBe(16);
  });

  it("the fee pattern catches each planted phrase and passes each near miss", () => {
    for (const phrase of ["pcc fee $0.38", "PCC fee today", "2.35% protocol fee", "PCC takes a 2.35% fee", "pccFeeUSD", "pcc-treasury", "feeBps", "sales tax"]) {
      expect.soft(FEE_WORDING.test(phrase) || NEW_FEE.test(phrase), phrase).toBe(true);
    }
    for (const phrase of ["Live event feed", "feedSearch", "feedCount", "filter by order id / role…", "Shop got $X, driver got $Y."]) {
      expect.soft(FEE_WORDING.test(phrase) || NEW_FEE.test(phrase), phrase).toBe(false);
    }
  });

  it("the outreach script sits unchanged in docs/outreach and no longer in public/", () => {
    expect.soft(existsSync(resolve(PUBLIC, "pizza-shop-outreach.md"))).toBe(false);
    expect(createHash("sha256").update(readFileSync(resolve(REPO, "docs/outreach/pizza-shop-outreach.md"))).digest("hex")).toBe("327ffe71203aec9006fdecdd45d18d6a55af78d6f8edf2a9faf1171d9cbcc083");
    for (const file of ["packages/gateway/src/routes/docs.ts", "packages/gateway/src/mcp/docs-mcp-server.ts"]) {
      expect(readFileSync(resolve(REPO, file), "utf8")).not.toMatch(/outreach/i);
    }
    expect(readFileSync(resolve(REPO, "apps/dashboard/vite.config.ts"), "utf8")).not.toContain("publicDir");
  });
});
