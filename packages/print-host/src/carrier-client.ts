import { inspect } from "node:util";
import { z } from "zod";
import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import { isGatewayBaseUrl } from "./config.js";
import { GatewayClientError, type GwCode, type GwResult } from "./gateway-client.js";
import { createGatewayRequest, isRequestFailure, object, own, validId, type ObjectBody } from "./gateway-request.js";

export interface CarrierClientConfig {
  baseUrl: string;
  apiKey: string;
  kernelId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  spendApprovalId?: string;
}

function text(max: number, allowEmpty = false) {
  return z.string().max(max).refine((value) => {
    if ((!allowEmpty && value.trim().length === 0) || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
    try { encodeURIComponent(value); return true; } catch { return false; }
  });
}

const id = z.string().refine(validId);
const hex = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().max(40).datetime({ offset: true });
const mode = z.enum(["production", "test", "mock"]);
const status = z.enum([
  "reserved", "buy_in_flight", "purchased_pending", "reconciliation_required",
  "label_bought", "in_transit", "delivered", "return_to_sender", "failed",
]);
const address = z.object({
  name: text(200), street1: text(200), street2: text(200, true).optional(),
  city: text(200), state: text(100), zip: text(32),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(), phone: text(32).optional(),
}).strict();
const dimension = z.number().finite().positive().max(1000);
const buyInput = z.object({
  jobId: id, documentHash: hex, toAddress: address, fromAddress: address,
  parcel: z.object({
    weightOz: z.number().finite().positive().max(70 * 16),
    lengthIn: dimension.optional(), widthIn: dimension.optional(), heightIn: dimension.optional(),
  }).strict(),
}).strict();

/** Client views reuse spec evidence fields; the gateway owns carrier DTOs. */
export type CarrierEvent = Omit<EvidenceEvent, "type" | "source" | "hash"> & {
  type: Extract<EvidenceEvent["type"], "courier_pickup_confirmed" | "courier_delivery_confirmed">;
  source: Pick<EvidenceSource, "deviceId" | "kernelId"> & {
    deviceType: "courier_api";
    simulated: boolean;
  };
  /** The carrier event's hash is passed through, never recomputed here. */
  hash: string;
};

/** Preserve hashed payloads exactly, with limits on depth, nodes and strings. */
function boundedPayload(value: unknown): value is Record<string, unknown> {
  let nodes = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 16) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= 8192;
    if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
    if (!object(item)) return false;
    return Object.entries(item).every(([key, child]) => key.length <= 200 && visit(child, depth + 1));
  }
  return object(value) && visit(value, 0);
}

const event: z.ZodType<CarrierEvent> = z.object({
  id, type: z.enum(["courier_pickup_confirmed", "courier_delivery_confirmed"]), timestamp,
  source: z.object({
    deviceId: text(200).refine((value) => value.startsWith("easypost:") && value.length > 9),
    deviceType: z.literal("courier_api"), kernelId: id, simulated: z.boolean(),
  }).strict(),
  payload: z.custom<Record<string, unknown>>(boundedPayload), hash: text(200),
}).strict();
const events = z.array(event).max(1000);
const commitment = z.object({
  v: z.literal(1), jobId: id, kernelId: id, documentHash: hex, destinationHash: hex,
  trackingCode: text(200), shipmentId: id, trackerId: id.nullable(),
  carrier: text(200), service: text(200), labelHash: hex, labelCid: text(200),
  providerMode: mode, mock: z.boolean(), committedAt: timestamp, hash: hex,
  signature: z.object({ alg: text(64), kid: text(200), jws: text(8192) }).strict().nullable(),
}).strict();
const labelUrl = text(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch { return false; }
});
const shipment = z.object({
  jobId: id, kernelId: id, status,
  reconciliationReason: text(200).nullable(), shipmentId: id.nullable(), trackerId: id.nullable(),
  trackingCode: text(200).nullable(), labelUrl: labelUrl.nullable(), labelHash: hex.nullable(),
  labelCid: text(200).nullable(), labelFetch: text(400).nullable(), carrier: text(200).nullable(),
  service: text(200).nullable(), rate: z.string().max(32).regex(/^\d+(?:\.\d+)?$/).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), providerMode: mode.nullable(),
  mock: z.boolean(), commitment: commitment.nullable(), events, createdAt: timestamp, updatedAt: timestamp,
}).strict();
const purchase = shipment.extend({
  // Current POST routes add these diagnostics; validate and discard them.
  note: text(200).optional(), replayedScans: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const carrierEvidence = z.object({ jobId: id, kernelId: id, status, events }).strict();

export type BuyLabelInput = z.infer<typeof buyInput>;
type ParsedShipment = z.infer<typeof shipment>;
export type CarrierShipmentValue = Omit<ParsedShipment, "reconciliationReason">;
export type CarrierEventsValue = z.infer<typeof carrierEvidence>;
export interface LabelReceipt {
  shipmentId: string;
  trackerId: string | null;
  trackingCode: string;
  labelUrl: string;
  labelHash: string;
  carrier: string;
  service: string;
  providerMode: z.infer<typeof mode>;
  mock: boolean;
  commitment: { hash: string; committedAt: string };
  replayed: boolean;
}
export interface CarrierClient {
  buyLabel(input: BuyLabelInput): Promise<GwResult<LabelReceipt>>;
  getShipment(jobId: string): Promise<GwResult<CarrierShipmentValue>>;
  pullCarrierEvents(jobId: string): Promise<GwResult<CarrierEventsValue>>;
  toJSON(): { baseUrl: string; kernelId: string };
  toString(): string;
  [inspect.custom](): { baseUrl: string; kernelId: string };
}

type Failure = Extract<GwResult<never>, { ok: false }>;
function failure(code: GwCode, status: number | null): Failure { return { ok: false, code, status }; }

/** Map only local constants, never a provider discriminator or diagnostic. */
function classify(httpStatus: number, body: ObjectBody): Failure {
  const error = own(body, "error");
  if (httpStatus === 401) return failure("unauthenticated", httpStatus);
  if (httpStatus === 403) {
    for (const code of ["kernel_unowned", "not_kernel_operator"] as const) {
      if (error === code) return failure(code, httpStatus);
    }
    return failure("forbidden", httpStatus);
  }
  if (httpStatus === 404) {
    for (const code of ["job_not_found", "kernel_not_found"] as const) {
      if (error === code) return failure(code, httpStatus);
    }
    return failure("route_unavailable", httpStatus);
  }
  if (httpStatus === 400) {
    for (const code of [
      "missing_fields", "invalid_parcel", "invalid_document_hash", "provider_mode_not_production",
      "weight_exceeds_ceiling", "rate_exceeds_ceiling",
    ] as const) if (error === code) return failure(code, httpStatus);
    return failure("bad_request", httpStatus);
  }
  if (httpStatus === 409) {
    for (const code of [
      "idempotency_conflict", "reconciliation_required", "kernel_mismatch", "job_not_active",
      "carrier_record_ownership_mismatch",
    ] as const) if (error === code) return failure(code, httpStatus);
    return failure("bad_request", httpStatus);
  }
  if (httpStatus === 429) return failure("rate_limited", httpStatus);
  if (httpStatus === 503) return failure(error === "carrier_not_configured" ? "carrier_not_configured" : "unavailable", httpStatus);
  if (httpStatus >= 500 && httpStatus <= 599) return failure("server_error", httpStatus);
  return failure("route_unavailable", httpStatus);
}

const trackable = new Set(["label_bought", "in_transit", "delivered", "return_to_sender", "failed"]);
function coherent(value: ParsedShipment): boolean {
  const bought = value.shipmentId !== null && value.trackingCode !== null && value.labelUrl !== null
    && value.carrier !== null && value.service !== null && value.rate !== null && value.currency !== null
    && value.providerMode !== null;
  if ((trackable.has(value.status) || value.status === "purchased_pending") && !bought) return false;
  if (trackable.has(value.status) && (value.commitment === null || value.labelHash === null || value.labelCid === null)) return false;
  if (value.labelFetch !== (value.labelCid === null ? null : `/api/storage/${value.labelCid}`)) return false;
  if (value.providerMode !== null && value.mock !== (value.providerMode === "mock")) return false;
  const c = value.commitment;
  if (c !== null && (c.jobId !== value.jobId || c.kernelId !== value.kernelId || c.shipmentId !== value.shipmentId
    || c.trackerId !== value.trackerId || c.trackingCode !== value.trackingCode || c.carrier !== value.carrier
    || c.service !== value.service || c.labelHash !== value.labelHash || c.labelCid !== value.labelCid
    || c.providerMode !== value.providerMode || c.mock !== value.mock)) return false;
  return value.events.every((e) => e.source.kernelId === value.kernelId
    && (value.trackingCode === null || e.source.deviceId === `easypost:${value.trackingCode}`));
}

/** Prevent inherited fields, getters or exotic objects from supplying purchase data. */
function ownInput(value: unknown, required: string[]): boolean {
  if (!object(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (!required.every((key) => Object.hasOwn(value, key))) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value") && descriptor.enumerable === true;
  });
}

export function createCarrierClient(cfg: CarrierClientConfig): Readonly<CarrierClient> {
  let input: Readonly<CarrierClientConfig>;
  try {
    if (!object(cfg)) throw undefined;
    input = Object.freeze({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, kernelId: cfg.kernelId,
      fetchImpl: cfg.fetchImpl, timeoutMs: cfg.timeoutMs, maxResponseBytes: cfg.maxResponseBytes,
      spendApprovalId: cfg.spendApprovalId,
    });
  } catch { throw new GatewayClientError("bad_config"); }
  const { baseUrl, apiKey, kernelId, spendApprovalId } = input;
  if (typeof baseUrl !== "string" || !isGatewayBaseUrl(baseUrl)) throw new GatewayClientError("bad_base_url");
  if (typeof apiKey !== "string" || !/^pcc_(live|test)_[A-Za-z0-9_-]{16,256}$/.test(apiKey)) throw new GatewayClientError("bad_api_key");
  if (!validId(kernelId)) throw new GatewayClientError("bad_kernel_id");
  const timeoutMs = input.timeoutMs === undefined ? 15_000 : input.timeoutMs;
  const maxResponseBytes = input.maxResponseBytes === undefined ? 1024 * 1024 : input.maxResponseBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new GatewayClientError("bad_timeout");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new GatewayClientError("bad_response_limit");
  const fetchImpl = input.fetchImpl === undefined ? globalThis.fetch : input.fetchImpl;
  if (typeof fetchImpl !== "function") throw new GatewayClientError("bad_fetch");
  if (spendApprovalId !== undefined && (typeof spendApprovalId !== "string" || spendApprovalId.length > 200
    || /[\u0000-\u001f\u007f-\u009f]/.test(spendApprovalId))) throw new GatewayClientError("bad_config");
  const transport = createGatewayRequest({ apiKey, fetchImpl, timeoutMs, maxResponseBytes });
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/carrier/shipments`;
  const publicIdentity = () => ({ baseUrl, kernelId });
  // An echoed credential must never enter even an otherwise valid DTO/payload.
  const safeBody = (body: ObjectBody) => {
    try { return !JSON.stringify(body).includes(apiKey); }
    catch { return false; }
  };

  return Object.freeze({
    async buyLabel(params: BuyLabelInput): Promise<GwResult<LabelReceipt>> {
      if (spendApprovalId === undefined || spendApprovalId.trim().length === 0) return failure("spend_not_approved", null);
      let checked: BuyLabelInput;
      let body: string;
      try {
        if (!ownInput(params, ["jobId", "documentHash", "toAddress", "fromAddress", "parcel"])
          || !ownInput(params.toAddress, ["name", "street1", "city", "state", "zip"])
          || !ownInput(params.fromAddress, ["name", "street1", "city", "state", "zip"])
          || !ownInput(params.parcel, ["weightOz"])) {
          return failure("bad_request", null);
        }
        const parsed = buyInput.safeParse(params);
        if (!parsed.success) return failure("bad_request", null);
        checked = parsed.data;
        body = JSON.stringify({ jobId: checked.jobId, kernelId, documentHash: checked.documentHash,
          toAddress: checked.toAddress, fromAddress: checked.fromAddress, parcel: checked.parcel });
      } catch { return failure("bad_request", null); }
      // Serialize ONCE: recovery must use the exact approved request bytes.
      for (let attempt = 0; attempt <= 2; attempt++) {
        const reply = await transport(endpoint, body);
        if (isRequestFailure(reply)) return reply;
        if (reply.status === 502 && reply.body !== null && own(reply.body, "retry") === true && attempt < 2) continue;
        if (reply.status !== 200 && reply.status !== 201) return classify(reply.status, reply.body ?? {});
        if (reply.body === null || !safeBody(reply.body)) return failure("malformed_response", reply.status);
        const parsed = purchase.safeParse(reply.body);
        if (!parsed.success) return failure("malformed_response", reply.status);
        const value = parsed.data;
        if (value.jobId !== checked.jobId || value.kernelId !== kernelId || !coherent(value)
          || !trackable.has(value.status) || value.commitment?.documentHash !== checked.documentHash
          || value.shipmentId === null || value.trackingCode === null || value.labelUrl === null
          || value.labelHash === null || value.carrier === null || value.service === null
          || value.providerMode === null || value.commitment === null) return failure("malformed_response", reply.status);
        return { ok: true, value: {
          shipmentId: value.shipmentId, trackerId: value.trackerId, trackingCode: value.trackingCode,
          labelUrl: value.labelUrl, labelHash: value.labelHash, carrier: value.carrier, service: value.service,
          providerMode: value.providerMode, mock: value.mock,
          commitment: { hash: value.commitment.hash, committedAt: value.commitment.committedAt }, replayed: reply.status === 200,
        } };
      }
      return failure("server_error", 502);
    },
    async getShipment(jobId: string): Promise<GwResult<CarrierShipmentValue>> {
      if (!validId(jobId)) return failure("bad_request", null);
      const reply = await transport(`${endpoint}/${encodeURIComponent(jobId)}`);
      if (isRequestFailure(reply)) return reply;
      if (reply.status !== 200) return classify(reply.status, reply.body ?? {});
      if (reply.body === null || !safeBody(reply.body)) return failure("malformed_response", 200);
      const parsed = shipment.safeParse(reply.body);
      if (!parsed.success || parsed.data.jobId !== jobId || parsed.data.kernelId !== kernelId || !coherent(parsed.data)) {
        return failure("malformed_response", 200);
      }
      const { reconciliationReason: _diagnostic, ...value } = parsed.data;
      return { ok: true, value };
    },
    async pullCarrierEvents(jobId: string): Promise<GwResult<CarrierEventsValue>> {
      if (!validId(jobId)) return failure("bad_request", null);
      const reply = await transport(`${endpoint}/${encodeURIComponent(jobId)}/evidence`);
      if (isRequestFailure(reply)) return reply;
      if (reply.status !== 200) return classify(reply.status, reply.body ?? {});
      if (reply.body === null || !safeBody(reply.body)) return failure("malformed_response", 200);
      const parsed = carrierEvidence.safeParse(reply.body);
      if (!parsed.success || parsed.data.jobId !== jobId || parsed.data.kernelId !== kernelId
        || parsed.data.events.some((e) => e.source.kernelId !== kernelId)) return failure("malformed_response", 200);
      return { ok: true, value: parsed.data };
    },
    toJSON: publicIdentity,
    toString: () => JSON.stringify(publicIdentity()),
    [inspect.custom]: publicIdentity,
  });
}
