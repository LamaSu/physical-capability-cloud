/**
 * WP-C C2: POST /api/query (natural-language query) returned RAW capability and
 * kernel rows, so a legacy row's self-declared tiers were served verbatim. It
 * now serves them the same way the DTOs do: capability tiers clamped to the
 * owning kernel's authorized ceiling, kernel maxAssuranceTier = min(claim,
 * ceiling).
 *
 * Imports only modules that exist on the pre-change code, so it runs unchanged
 * there to prove polarity.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { nlQueryRoutes } from "../routes/nl-query.js";
import { closeStore, getRepos, initStore } from "../db.js";

let app: FastifyInstance;
const KERNEL = `wpcnlq-kernel-${Date.now().toString(36)}`;
const CAP_TYPE = `wpcnlq-printer-${Date.now().toString(36)}`;
const CAP_ID = `cap-${KERNEL}-${CAP_TYPE}`;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  // A legacy row: no proven signing key (ceiling 0) but a strong track record
  // and a self-declared tier-3 claim.
  getRepos().kernels.insert({
    id: KERNEL,
    name: "NLQ legacy kernel",
    operatorAddress: "wpcnlq-owner",
    location: { lat: 0, lng: 0 },
    physicalAddress: "",
    maxAssuranceTier: 3,
    publicKey: `0x${"00".repeat(32)}`,
    reputation: 950,
    totalJobsCompleted: 127,
    status: "online",
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    version: "0.1.0",
  } as never);
  getRepos().capabilities.insert({
    id: CAP_ID,
    kernelId: KERNEL,
    type: CAP_TYPE,
    name: "NLQ legacy capability",
    description: "",
    materials: [],
    assuranceTiers: [0, 1, 2, 3],
    pricing: { currency: "USDC", baseCost: "10", minimum: "10" },
    availability: {},
    location: { lat: 0, lng: 0 },
  } as never);
  app = Fastify({ logger: false });
  await app.register(nlQueryRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
});

describe("WP-C C2: the NL query serves clamped tiers", () => {
  it("[neg] find_capability serves a legacy row's [0,1,2,3] claim clamped to its kernel's ceiling ([0])", async () => {
    const res = await app.inject({ method: "POST", url: "/api/query", payload: { query: `find a ${CAP_TYPE} for me` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intent).toBe("find_capability");
    const row = (body.data as Array<{ id: string; assuranceTiers: number[] }>).find((r) => r.id === CAP_ID);
    expect(row).toBeTruthy();
    expect(row!.assuranceTiers).toEqual([0]);
  });

  it("[neg] kernel_health serves the kernel's capped tier (0), not its tier-3 claim", async () => {
    const res = await app.inject({ method: "POST", url: "/api/query", payload: { query: `is kernel ${KERNEL} healthy?` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.intent).toBe("kernel_health");
    const row = (body.data as Array<{ id: string; maxAssuranceTier: number }>).find((r) => r.id === KERNEL);
    expect(row).toBeTruthy();
    expect(row!.maxAssuranceTier).toBe(0);
    // The stored CLAIM is untouched; only what is served is capped.
    expect(getRepos().kernels.findById(KERNEL)?.maxAssuranceTier).toBe(3);
  });
});
