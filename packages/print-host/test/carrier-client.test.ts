import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createCarrierClient } from "../src/carrier-client.js";
import { GatewayClientError } from "../src/gateway-client.js";

const baseUrl = "https://gateway.example.test";
const kernelId = "kernel:print-demo";
const jobId = "job:print-demo";
const documentHash = "a".repeat(64);
const labelHash = "b".repeat(64);
const commitmentHash = "c".repeat(64);
const committedAt = "2026-10-15T12:00:00.000Z";
const apiKey = ["pcc", "test", randomBytes(24).toString("hex")].join("_");
const canary = `server-canary-${randomBytes(24).toString("hex")}`;
const spendApprovalId = "approval:operator-demo";

type Client = ReturnType<typeof createCarrierClient>;
type ClientConfig = Parameters<typeof createCarrierClient>[0];
type LabelInput = Parameters<Client["buyLabel"]>[0];

function input() {
  return {
    jobId, documentHash,
    toAddress: { name: "Demo Recipient", street1: "123 Demo Way", city: "Oakland", state: "CA", zip: "94612", country: "US", phone: "5105550100" },
    fromAddress: { name: "Print Operator", street1: "456 Example Ave", street2: "Suite 2", city: "Oakland", state: "CA", zip: "94607" },
    parcel: { weightOz: 4, lengthIn: 9, widthIn: 6, heightIn: 1 },
  };
}

function event(type: "courier_pickup_confirmed" | "courier_delivery_confirmed" = "courier_pickup_confirmed") {
  return {
    id: "evt:opaque:pickup", type, timestamp: "2026-10-15T14:00:00.000Z",
    source: { deviceId: "easypost:TRACK-DEMO", deviceType: "courier_api", kernelId, simulated: true },
    payload: { jobId, providerMode: "test", details: { location: "Oakland", scans: [1, true, null] } },
    hash: "opaque-event-hash",
  };
}

function shipment(extra: Record<string, unknown> = {}) {
  const commitment = {
    v: 1, jobId, kernelId, documentHash, destinationHash: "d".repeat(64),
    trackingCode: "TRACK-DEMO", shipmentId: "shp_demo", trackerId: "trk_demo",
    carrier: "USPS", service: "First", labelHash, labelCid: "bafy-label-demo",
    providerMode: "test", mock: false, committedAt, hash: commitmentHash, signature: null,
  };
  return {
    jobId, kernelId, status: "label_bought", reconciliationReason: null,
    shipmentId: "shp_demo", trackerId: "trk_demo", trackingCode: "TRACK-DEMO",
    labelUrl: "https://labels.example.test/demo.png", labelHash,
    labelCid: "bafy-label-demo", labelFetch: "/api/storage/bafy-label-demo",
    carrier: "USPS", service: "First", rate: "4.50", currency: "USD", providerMode: "test", mock: false,
    commitment, events: [event()], createdAt: committedAt, updatedAt: committedAt, ...extra,
  };
}

function evidence(extra: Record<string, unknown> = {}) {
  return { jobId, kernelId, status: "in_transit", events: [event()], ...extra };
}

function publicShipment(dto: ReturnType<typeof shipment>) {
  const { reconciliationReason: _diagnostic, ...value } = dto;
  return value;
}

function receipt(replayed = false) {
  const dto = shipment();
  return {
    shipmentId: dto.shipmentId, trackerId: dto.trackerId, trackingCode: dto.trackingCode,
    labelUrl: dto.labelUrl, labelHash, carrier: dto.carrier, service: dto.service,
    providerMode: dto.providerMode, mock: dto.mock,
    commitment: { hash: commitmentHash, committedAt }, replayed,
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function fixture(response: Response | (() => Response) = () => json(shipment(), 201), options: Partial<ClientConfig> = {}) {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => typeof response === "function" ? response() : response);
  const client = createCarrierClient({ baseUrl, apiKey, kernelId, spendApprovalId, fetchImpl, ...options });
  return { client, fetchImpl };
}

function request(fetchImpl: ReturnType<typeof fixture>["fetchImpl"], index = 0) {
  const [url, init] = fetchImpl.mock.calls[index]!;
  return {
    url: String(url), method: init?.method,
    headers: Object.fromEntries(new Headers(init?.headers)), body: init?.body, redirect: init?.redirect,
  };
}

function expectNoCanaries(value: unknown) {
  for (const rendered of [String(value), JSON.stringify(value), inspect(value, { showHidden: true, depth: 12 })]) {
    expect(rendered).not.toContain(canary);
    expect(rendered).not.toContain(apiKey);
  }
}

describe("carrier client construction and public surface", () => {
  it("freezes exactly three carrier methods and safe display methods", () => {
    const { client } = fixture();
    expect(Object.isFrozen(client)).toBe(true);
    expect(Reflect.ownKeys(client)).toEqual(expect.arrayContaining([
      "buyLabel", "getShipment", "pullCarrierEvents", "toJSON", "toString", inspect.custom,
    ]));
    expect(Reflect.ownKeys(client)).toHaveLength(6);
    expect(client.toJSON()).toEqual({ baseUrl, kernelId });
    expect(String(client)).toContain(baseUrl);
    expect(String(client)).toContain(kernelId);
    expectNoCanaries(client);
  });

  it("captures configuration once so later key, kernel, and approval mutations cannot change requests", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json(shipment(), 201));
    const config: ClientConfig = { baseUrl, apiKey, kernelId, spendApprovalId, fetchImpl };
    const client = createCarrierClient(config);
    config.apiKey = ["pcc", "test", randomBytes(24).toString("hex")].join("_");
    config.kernelId = "kernel:changed";
    config.spendApprovalId = "";
    expect(await client.buyLabel(input())).toEqual({ ok: true, value: receipt() });
    expect(request(fetchImpl).headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(request(fetchImpl).body)).kernelId).toBe(kernelId);
    expectNoCanaries(client);
  });

  it.each([
    { baseUrl: `https://${canary}@example.test` }, { apiKey: `${apiKey} ${canary}` },
    { kernelId: `${canary}\n` }, { timeoutMs: 0 }, { maxResponseBytes: 0 },
    { fetchImpl: canary }, { spendApprovalId: null }, { spendApprovalId: 42 }, { spendApprovalId: "approval\nother" },
  ])("rejects invalid configuration without retaining input or exception text (%j)", (options) => {
    let caught: unknown;
    try { fixture(undefined, options as unknown as Partial<ClientConfig>); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expectNoCanaries(caught);
    expect((caught as GatewayClientError).code).toMatch(/^[a-z_]+$/);
    expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  });

  it("sanitizes configuration getter exceptions", () => {
    let caught: unknown;
    try { createCarrierClient({ baseUrl, kernelId, get apiKey(): string { throw new Error(`${canary} ${apiKey}`); } }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(GatewayClientError);
    expect((caught as GatewayClientError).code).toBe("bad_config");
    expectNoCanaries(caught);
  });
});

describe("the three gateway carrier requests", () => {
  it("buys the label with the exact gateway request and reduced receipt", async () => {
    const { client, fetchImpl } = fixture();
    expect(await client.buyLabel(input())).toEqual({ ok: true, value: receipt() });
    const body = input();
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/carrier/shipments`, method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ jobId, kernelId, documentHash, toAddress: body.toAddress, fromAddress: body.fromAddress, parcel: body.parcel }),
      redirect: "error",
    });
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("C6: a 200 replay is successful and records replayed true", async () => {
    const { client, fetchImpl } = fixture(json({ ...shipment(), note: "already bought for this jobId", replayedScans: 0 }));
    expect(await client.buyLabel(input())).toEqual({ ok: true, value: receipt(true) });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("gets the full shipment through the exact encoded gateway path", async () => {
    const encodedJobId = "job:demo /?#";
    const dto = shipment({ jobId: encodedJobId, commitment: { ...shipment().commitment, jobId: encodedJobId } });
    const { client, fetchImpl } = fixture(json(dto));
    expect(await client.getShipment(encodedJobId)).toEqual({ ok: true, value: publicShipment(dto) });
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/carrier/shipments/${encodeURIComponent(encodedJobId)}`, method: "GET",
      headers: { authorization: `Bearer ${apiKey}` }, body: undefined, redirect: "error",
    });
  });

  it("pulls allowlisted carrier events through the exact evidence path with opaque fields intact", async () => {
    const dto = evidence({ events: [event(), event("courier_delivery_confirmed")] });
    const { client, fetchImpl } = fixture(json(dto));
    expect(await client.pullCarrierEvents(jobId)).toEqual({ ok: true, value: dto });
    expect(request(fetchImpl)).toEqual({
      url: `${baseUrl}/api/carrier/shipments/${encodeURIComponent(jobId)}/evidence`, method: "GET",
      headers: { authorization: `Bearer ${apiKey}` }, body: undefined, redirect: "error",
    });
  });

  it.each(["test", "production", "mock"])("records provider mode %s without refusing it", async (mode) => {
    const mock = mode === "mock";
    const dto = shipment({ providerMode: mode, mock, commitment: { ...shipment().commitment, providerMode: mode, mock } });
    const { client } = fixture(json(dto, 201));
    expect(await client.buyLabel(input())).toEqual({ ok: true, value: { ...receipt(), providerMode: mode, mock } });
  });

  it("allows a null tracker identity when the commitment agrees", async () => {
    const dto = shipment({ trackerId: null, commitment: { ...shipment().commitment, trackerId: null } });
    const { client } = fixture(json(dto, 201));
    expect(await client.buyLabel(input())).toEqual({ ok: true, value: { ...receipt(), trackerId: null } });
  });

  it("C5: every carrier request forbids following redirects", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => String(url).endsWith("/evidence") ? json(evidence()) : json(shipment(), String(url).endsWith("/shipments") ? 201 : 200));
    const client = createCarrierClient({ baseUrl, apiKey, kernelId, spendApprovalId, fetchImpl });
    await client.buyLabel(input());
    await client.getShipment(jobId);
    await client.pullCarrierEvents(jobId);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchImpl.mock.calls) expect(init?.redirect).toBe("error");
  });
});

describe("spend approval and closed purchase input", () => {
  it.each([undefined, "", " ", "   "])("C1: missing or blank spendApprovalId never sends a label purchase (%j)", async (approval) => {
    const { client, fetchImpl } = fixture(undefined, { spendApprovalId: approval });
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "spend_not_approved", status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("read requests require no spend approval", async () => {
    const { client, fetchImpl } = fixture(() => json(shipment()), { spendApprovalId: undefined });
    expect(await client.getShipment(jobId)).toEqual({ ok: true, value: publicShipment(shipment()) });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    null, [], {}, { ...input(), unknown: canary }, { ...input(), kernelId },
    { ...input(), jobId: "" }, { ...input(), jobId: "x".repeat(201) }, { ...input(), jobId: "job\nother" },
    { ...input(), documentHash: "A".repeat(64) }, { ...input(), documentHash: `sha256:${documentHash}` },
    { ...input(), documentHash: "a".repeat(63) }, { ...input(), documentHash: "a".repeat(65) },
    { ...input(), documentHash: `${documentHash}\n` }, { ...input(), documentHash: 42 },
    { ...input(), toAddress: null }, { ...input(), fromAddress: [] },
    { ...input(), toAddress: { ...input().toAddress, extra: true } },
    { ...input(), fromAddress: { ...input().fromAddress, company: "Extra" } },
    { ...input(), toAddress: { ...input().toAddress, name: " " } },
    { ...input(), toAddress: { ...input().toAddress, name: "x".repeat(201) } },
    { ...input(), toAddress: { ...input().toAddress, street1: "x".repeat(201) } },
    { ...input(), toAddress: { ...input().toAddress, street2: "x".repeat(201) } },
    { ...input(), toAddress: { ...input().toAddress, city: "x".repeat(201) } },
    { ...input(), toAddress: { ...input().toAddress, state: "x".repeat(101) } },
    { ...input(), toAddress: { ...input().toAddress, zip: "x".repeat(33) } },
    { ...input(), toAddress: { ...input().toAddress, country: "USA" } },
    { ...input(), toAddress: { ...input().toAddress, phone: "x".repeat(33) } },
    { ...input(), toAddress: { ...input().toAddress, city: "Oakland\u0000" } },
    { ...input(), parcel: null }, { ...input(), parcel: { weightOz: 0 } },
    { ...input(), parcel: { weightOz: -1 } }, { ...input(), parcel: { weightOz: 1120.1 } },
    { ...input(), parcel: { weightOz: Number.NaN } }, { ...input(), parcel: { weightOz: Number.POSITIVE_INFINITY } },
    { ...input(), parcel: { weightOz: "4" } }, { ...input(), parcel: { weightOz: 4, extra: true } },
    { ...input(), parcel: { weightOz: 4, lengthIn: 0 } }, { ...input(), parcel: { weightOz: 4, widthIn: -1 } },
    { ...input(), parcel: { weightOz: 4, heightIn: 1001 } }, { ...input(), parcel: { weightOz: 4, heightIn: Number.NaN } },
  ])("rejects invalid or open purchase input before fetching (%j)", async (body) => {
    const { client, fetchImpl } = fixture();
    const result = await client.buyLabel(body as LabelInput);
    expect(result).toEqual({ ok: false, code: "bad_request", status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoCanaries(result);
  });

  it("accepts 70 pounds and bounded optional empty street2", async () => {
    const body = { ...input(), toAddress: { ...input().toAddress, street2: "" }, parcel: { weightOz: 1120 } };
    const { client, fetchImpl } = fixture();
    expect(await client.buyLabel(body)).toEqual({ ok: true, value: receipt() });
    expect(JSON.parse(String(request(fetchImpl).body)).parcel).toEqual({ weightOz: 1120 });
  });

  it.each(["getShipment", "pullCarrierEvents"] as const)("%s rejects invalid job identities without fetching", async (method) => {
    const { client, fetchImpl } = fixture();
    for (const invalid of ["", "x".repeat(201), "job\nother", null, 42]) {
      expect(await client[method](invalid as string)).toEqual({ ok: false, code: "bad_request", status: null });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("purchase recovery retries and closed errors", () => {
  it("C3: authorized 502 recovery retries reuse the byte-identical first request body", async () => {
    let calls = 0;
    const { client, fetchImpl } = fixture(() => ++calls <= 2 ? json({ error: "buy_ambiguous_retry_to_recover", retry: true }, 502) : json(shipment(), 201));
    expect(await client.buyLabel(input())).toEqual({ ok: true, value: receipt() });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const first = request(fetchImpl).body;
    expect(typeof first).toBe("string");
    expect(request(fetchImpl, 1).body).toBe(first);
    expect(request(fetchImpl, 2).body).toBe(first);
    expect(new TextEncoder().encode(String(request(fetchImpl, 1).body))).toEqual(new TextEncoder().encode(String(first)));
  });

  it("caps authorized 502 recovery at two retries", async () => {
    const { client, fetchImpl } = fixture(() => json({ error: "recovery_failed", retry: true }, 502));
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "server_error", status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Set(fetchImpl.mock.calls.map(([, init]) => init?.body)).size).toBe(1);
  });

  it.each([undefined, false, "true", 1, null])("C2: a 502 without literal retry true never retries (%j)", async (retry) => {
    const { client, fetchImpl } = fixture(() => json({ error: "easypost_label_purchase_failed", retry }, 502));
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "server_error", status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([500, 501, 503, 504, 599])("HTTP %s never retries even when retry true is present", async (status) => {
    const { client, fetchImpl } = fixture(() => json({ error: "recovery_failed", retry: true }, status));
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: status === 503 ? "unavailable" : "server_error", status });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["getShipment", "pullCarrierEvents"] as const)("%s never retries a 502 recovery response", async (method) => {
    const { client, fetchImpl } = fixture(() => json({ error: "recovery_failed", retry: true }, 502));
    expect(await client[method](jobId)).toEqual({ ok: false, code: "server_error", status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["idempotency_conflict", "reconciliation_required"] as const)("maps 409 %s to its closed code", async (error) => {
    const { client, fetchImpl } = fixture(json({ error, reason: canary, message: `${canary} ${apiKey}` }, 409));
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: false, code: error, status: 409 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });

  it("C4: server messages, headers, and the API key never leak into failure results", async () => {
    const { client } = fixture(json({ error: canary, message: `${canary} ${apiKey}`, detailCode: canary }, 500, { "X-Debug": `${canary} ${apiKey}` }));
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: false, code: "server_error", status: 500 });
    expectNoCanaries(result);
  });

  it.each([
    [401, "authentication_required", "unauthenticated"], [403, "not_kernel_operator", "not_kernel_operator"],
    [404, "job_not_found", "job_not_found"], [404, "kernel_not_found", "kernel_not_found"],
    [400, "invalid_document_hash", "invalid_document_hash"], [503, "carrier_not_configured", "carrier_not_configured"],
  ] as const)("maps HTTP %s %s to %s without external text", async (status, error, code) => {
    const { client } = fixture(json({ error, message: canary, detailCode: apiKey }, status, { "X-Debug": canary }));
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: false, code, status });
    expectNoCanaries(result);
  });

  it("drops POST diagnostics from a successful receipt", async () => {
    const { client } = fixture(json({ ...shipment(), note: canary, replayedScans: 2 }, 201, { "X-Debug": canary }));
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: true, value: receipt() });
    expectNoCanaries(result);
  });

  it("refuses a key echoed in successful diagnostics or a preserved DTO field", async () => {
    for (const dto of [
      { ...shipment(), note: apiKey, replayedScans: 0 },
      shipment({ events: [{ ...event(), payload: { echoed: apiKey } }] }),
    ]) {
      const { client } = fixture(json(dto, 201));
      const result = await client.buyLabel(input());
      expect(result).toEqual({ ok: false, code: "malformed_response", status: 201 });
      expectNoCanaries(result);
    }
  });

  it("drops the gateway reconciliation diagnostic from a full shipment result", async () => {
    const dto = shipment({ status: "reconciliation_required", reconciliationReason: canary });
    const { client } = fixture(json(dto));
    const result = await client.getShipment(jobId);
    expect(result).toEqual({ ok: true, value: publicShipment(dto) });
    expectNoCanaries(result);
  });

  it("sanitizes fetch rejections and never retries network errors", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`${canary} ${apiKey}`); });
    const client = createCarrierClient({ baseUrl, apiKey, kernelId, spendApprovalId, fetchImpl });
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: false, code: "network", status: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expectNoCanaries(result);
  });
});

describe("strict successful carrier DTO parsing", () => {
  it.each([
    null, [], {}, shipment({ extra: canary }), shipment({ shipmentId: 42 }), shipment({ shipmentId: "" }),
    shipment({ trackerId: 42 }), shipment({ trackingCode: "" }), shipment({ labelHash: "B".repeat(64) }),
    shipment({ labelUrl: "http://labels.example.test/demo.png" }), shipment({ labelUrl: `https://${canary}@labels.example.test/demo.png` }),
    shipment({ status: "unknown" }), shipment({ providerMode: "sandbox" }), shipment({ mock: "false" }),
    shipment({ rate: 4.5 }), shipment({ currency: 42 }), shipment({ createdAt: "not-a-date" }),
    shipment({ updatedAt: "not-a-date" }), shipment({ reconciliationReason: 42 }),
    shipment({ commitment: null }), shipment({ commitment: { ...shipment().commitment, v: 2 } }),
    shipment({ commitment: { ...shipment().commitment, committedAt: "not-a-date" } }),
    shipment({ commitment: { ...shipment().commitment, hash: "C".repeat(64) } }),
    shipment({ commitment: { ...shipment().commitment, signature: { alg: "EdDSA", kid: "kid", jws: 42 } } }),
    shipment({ commitment: { ...shipment().commitment, unknown: canary } }), shipment({ events: {} }),
  ])("buyLabel rejects a malformed DTO (%j)", async (dto) => {
    const { client } = fixture(json(dto, 201));
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: false, code: "malformed_response", status: 201 });
    expectNoCanaries(result);
  });

  it.each([
    { jobId: "job:other" }, { kernelId: "kernel:other" }, { documentHash: "f".repeat(64) },
    { shipmentId: "shp_other" }, { trackerId: "trk_other" }, { trackingCode: "TRACK-OTHER" },
    { carrier: "UPS" }, { service: "Other" }, { labelHash: "f".repeat(64) },
    { labelCid: "bafy-other" }, { providerMode: "production" }, { mock: true },
  ])("refuses a commitment that does not bind the purchased DTO or sent document (%j)", async (fields) => {
    const dto = shipment({ commitment: { ...shipment().commitment, ...fields } });
    const { client } = fixture(json(dto, 201));
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "malformed_response", status: 201 });
  });

  it.each(["buyLabel", "getShipment", "pullCarrierEvents"] as const)("%s refuses a response for another job or kernel", async (method) => {
    for (const fields of [{ jobId: "job:other" }, { kernelId: "kernel:other" }]) {
      const dto = method === "pullCarrierEvents" ? evidence(fields) : shipment({ ...fields, commitment: { ...shipment().commitment, ...fields } });
      const { client } = fixture(json(dto, method === "buyLabel" ? 201 : 200));
      const result = method === "buyLabel" ? await client.buyLabel(input()) : await client[method](jobId);
      expect(result).toEqual({ ok: false, code: "malformed_response", status: method === "buyLabel" ? 201 : 200 });
    }
  });

  it.each(["reserved", "buy_in_flight", "purchased_pending", "reconciliation_required", "label_bought", "in_transit", "delivered", "return_to_sender", "failed"])("accepts evidence status %s from the closed list", async (status) => {
    const dto = evidence({ status });
    const { client } = fixture(json(dto));
    expect(await client.pullCarrierEvents(jobId)).toEqual({ ok: true, value: dto });
  });

  it("reads a pre-purchase reserved record with nullable purchase fields", async () => {
    const dto = shipment({ status: "reserved", shipmentId: null, trackerId: null, trackingCode: null,
      labelUrl: null, labelHash: null, labelCid: null, labelFetch: null, carrier: null, service: null,
      rate: null, currency: null, providerMode: null, mock: false, commitment: null, events: [] });
    const { client } = fixture(json(dto));
    expect(await client.getShipment(jobId)).toEqual({ ok: true, value: publicShipment(dto) });
  });

  it.each([
    null, [], {}, evidence({ extra: canary }), evidence({ status: "unknown" }), evidence({ events: {} }),
    evidence({ events: [null] }), evidence({ events: [{ ...event(), type: "print_completed" }] }),
    evidence({ events: [{ ...event(), unknown: true }] }), evidence({ events: [{ ...event(), id: "" }] }),
    evidence({ events: [{ ...event(), id: "x".repeat(201) }] }), evidence({ events: [{ ...event(), hash: "x".repeat(201) }] }),
    evidence({ events: [{ ...event(), hash: null }] }), evidence({ events: [{ ...event(), timestamp: "not-a-date" }] }),
    evidence({ events: [{ ...event(), source: null }] }),
    evidence({ events: [{ ...event(), source: { ...event().source, deviceId: "not-easypost" } }] }),
    evidence({ events: [{ ...event(), source: { ...event().source, deviceType: "printer" } }] }),
    evidence({ events: [{ ...event(), source: { ...event().source, kernelId: "kernel:other" } }] }),
    evidence({ events: [{ ...event(), source: { ...event().source, simulated: "true" } }] }),
    evidence({ events: [{ ...event(), source: { ...event().source, extra: true } }] }),
    evidence({ events: [{ ...event(), payload: null }] }), evidence({ events: [{ ...event(), payload: [] }] }),
    evidence({ events: [{ ...event(), payload: { long: "x".repeat(8193) } }] }),
  ])("pullCarrierEvents rejects malformed, open, or unallowlisted evidence (%j)", async (dto) => {
    const { client } = fixture(json(dto));
    const result = await client.pullCarrierEvents(jobId);
    expect(result).toEqual({ ok: false, code: "malformed_response", status: 200 });
    expectNoCanaries(result);
  });

  it("rejects opaque payloads exceeding the depth and node bounds", async () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20; index++) deep = { nested: deep };
    const wide = Object.fromEntries(Array.from({ length: 4100 }, (_, index) => [`field${index}`, index]));
    for (const payload of [deep, wide]) {
      const { client } = fixture(json(evidence({ events: [{ ...event(), payload }] })));
      expect(await client.pullCarrierEvents(jobId)).toEqual({ ok: false, code: "malformed_response", status: 200 });
    }
  });

  it("returns a closed refusal for JSON nesting beyond serialization depth", async () => {
    const shallow = evidence({ events: [{ ...event(), payload: { nested: null } }] });
    const deeplyNestedJson = JSON.stringify(shallow).replace('"nested":null',
      `"nested":${"[".repeat(10_000)}0${"]".repeat(10_000)}`);
    const { client } = fixture(new Response(deeplyNestedJson, { headers: { "Content-Type": "application/json" } }));
    expect(await client.pullCarrierEvents(jobId)).toEqual({ ok: false, code: "malformed_response", status: 200 });
  });

  it("getShipment also rejects malformed nested events and unknown top-level fields", async () => {
    for (const dto of [shipment({ events: [{ ...event(), type: "print_completed" }] }), shipment({ extra: canary })]) {
      const { client } = fixture(json(dto));
      expect(await client.getShipment(jobId)).toEqual({ ok: false, code: "malformed_response", status: 200 });
    }
  });

  it.each([202, 204])("does not accept HTTP %s as a label purchase", async (status) => {
    const response = status === 204 ? new Response(null, { status }) : json(shipment(), status);
    const { client, fetchImpl } = fixture(response);
    const result = await client.buyLabel(input());
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("carrier response transport bounds", () => {
  it("one timeout covers a request that never returns headers", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>(() => {}));
    const client = createCarrierClient({ baseUrl, apiKey, kernelId, spendApprovalId, fetchImpl, timeoutMs: 10 });
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "timeout", status: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("the same timeout covers a stalled response body after headers", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({}), { status: 201, headers: { "Content-Type": "application/json" } });
    const { client, fetchImpl } = fixture(response, { timeoutMs: 10 });
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "timeout", status: 201 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("cancels an oversized streaming body as soon as the byte bound is crossed", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(33)); }, cancel }),
      { status: 201, headers: { "Content-Type": "application/json" } });
    const { client, fetchImpl } = fixture(response, { maxResponseBytes: 32 });
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "malformed_response", status: 201 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accumulates body size across chunks", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(20)); controller.enqueue(new Uint8Array(20)); }, cancel,
    }), { headers: { "Content-Type": "application/json" } });
    const { client } = fixture(response, { maxResponseBytes: 32 });
    expect(await client.getShipment(jobId)).toEqual({ ok: false, code: "malformed_response", status: 200 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["text/plain", "text/html", "application/xml", ""])("rejects a success with non-JSON content type %j", async (contentType) => {
    const response = new Response(JSON.stringify(shipment()), { status: 201, headers: { "Content-Type": contentType } });
    const { client } = fixture(response);
    expect(await client.buyLabel(input())).toEqual({ ok: false, code: "malformed_response", status: 201 });
  });

  it("never returns malformed JSON excerpts", async () => {
    const response = new Response(`${canary} ${apiKey} {`, { status: 201, headers: { "Content-Type": "application/json" } });
    const { client } = fixture(response);
    const result = await client.buyLabel(input());
    expect(result).toEqual({ ok: false, code: "malformed_response", status: 201 });
    expectNoCanaries(result);
  });
});
