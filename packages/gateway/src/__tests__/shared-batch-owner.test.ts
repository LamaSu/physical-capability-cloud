/**
 * N55: a shared batch is a kernel operator's priced offer, so only the operator
 * of the kernel it names may create one. On master, POST /api/batches/shared
 * checked no identity at all: any authenticated key could publish a shared
 * batch, with its own slots and price, under another operator's kernel.
 *
 * Authorization follows the kernel-operator check in routes/lob.ts and
 * routes/carrier.ts. The caller is req.operatorId ?? req.userId, which the test
 * app maps from an X-Test-Operator header as a stand-in for apiGate.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { batchRoutes } from "../routes/batches.js";
import { closeStore, initStore } from "../db.js";
import { getKernelFacade } from "../facades/index.js";

const OWNER = "0xA11ce00000000000000000000000000000000001";
const STRANGER = "0xB0b0000000000000000000000000000000000002";
const KERNEL = "kernel-n55-owned";
const ZERO_KERNEL = "kernel-n55-zero-operator";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const PREV_DB = process.env.PCC_DB_PATH;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore();
  initStore({ seed: false });
  for (const [id, operatorAddress] of [[KERNEL, OWNER], [ZERO_KERNEL, ZERO_ADDRESS]] as const) {
    const registered = await getKernelFacade().register({
      id, name: id, operatorAddress, location: { lat: 37.77, lng: -122.42 }, physicalAddress: "1 Lab Way", maxAssuranceTier: 1,
    } as never);
    expect(registered.success).toBe(true);
  }
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-test-operator"];
    if (typeof h === "string") (req as unknown as { operatorId?: string }).operatorId = h;
  });
  await app.register(batchRoutes);
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
});

const offer = (kernelId: string) => ({ kernelId, capabilityType: "hplc", totalSlots: 4, protocolType: "hplc-standard", pricePerSlot: "1.50" });

function create(kernelId: string, operator?: string) {
  return app.inject({
    method: "POST",
    url: "/api/batches/shared",
    payload: offer(kernelId),
    headers: operator === undefined ? {} : { "x-test-operator": operator },
  });
}

async function openBatchesOn(kernelId: string): Promise<number> {
  const res = await app.inject({ method: "GET", url: `/api/batches/shared/open?kernelId=${kernelId}`, headers: { "x-test-operator": OWNER } });
  const body = res.json() as { batches?: unknown[] };
  return Array.isArray(body.batches) ? body.batches.length : 0;
}

describe("N55: only a kernel's operator may create a shared batch on it", () => {
  it("the kernel's operator creates one", async () => {
    const res = await create(KERNEL, OWNER);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { batch: { kernelId: string } }).batch.kernelId).toBe(KERNEL);
  });

  it("the operator's address in another letter case is the same operator", async () => {
    const res = await create(KERNEL, OWNER.toLowerCase());
    expect(res.statusCode).toBe(200);
  });

  it("a stranger's key is refused (403 not_kernel_operator), and no batch appears on the kernel", async () => {
    const before = await openBatchesOn(KERNEL);
    const res = await create(KERNEL, STRANGER);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "not_kernel_operator" });
    expect(await openBatchesOn(KERNEL)).toBe(before);
  });

  it("an unknown kernel is 404 kernel_not_found", async () => {
    const res = await create("kernel-n55-does-not-exist", OWNER);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "kernel_not_found" });
  });

  it("a kernel whose operator is the zero address has no operator to act for it (403 kernel_unowned)", async () => {
    for (const caller of [ZERO_ADDRESS, STRANGER]) {
      const res = await create(ZERO_KERNEL, caller);
      expect(res.statusCode, caller).toBe(403);
      expect(res.json()).toMatchObject({ error: "kernel_unowned" });
    }
  });

  it("no identity is 401, before anything else is judged", async () => {
    const res = await create(KERNEL);
    expect(res.statusCode).toBe(401);
    const invalid = await app.inject({ method: "POST", url: "/api/batches/shared", payload: {} });
    expect(invalid.statusCode).toBe(401);
  });

  it("a whitespace-only identity is no identity (401), and a padded one is the trimmed one", async () => {
    expect((await create(KERNEL, "   ")).statusCode).toBe(401);
    expect((await create(KERNEL, `  ${OWNER}  `)).statusCode).toBe(200);
  });

  it("a missing field is still 400 for the operator", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/batches/shared", payload: { kernelId: KERNEL }, headers: { "x-test-operator": OWNER },
    });
    expect(res.statusCode).toBe(400);
  });
});
