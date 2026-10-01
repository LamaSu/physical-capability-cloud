/**
 * WP-C, astra pack 90 finding F2 (MEDIUM): graph registration serves the raw
 * claimed tier.
 *
 * POST /api/capabilities/graph/_dev/register-node answered `{ ok: true, node }`
 * straight after the upsert, so the response showed the node's UNCLAMPED
 * assuranceTier (3 for a node on an unsigned owned kernel) while every later
 * graph search served that same node at the kernel's served tier (0). The
 * stored node keeps the raw claim, by design; searches clamp.
 *
 * Now the response serves the node at the SAME tier a search will (its claim
 * capped at the kernel's served ceiling, effectiveMaxAssuranceTier), and keeps
 * the raw claim under an explicitly named field, `claimedAssuranceTier`.
 *
 * Driven over HTTP through the REAL apiGate and real API keys. The file imports
 * only modules that exist at 3d392e60 (plus a fixture), so it runs unchanged
 * there: every [neg] case fails there.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { schema } from "@pcc/store";
import { apiGate } from "../middleware/api-gate.js";
import { graphSearchRoutes, _clearGraphSearchForTests } from "../routes/graph-search.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getStore, initStore } from "../db.js";
import {
  ensureKernelRow,
  SIGNED_FRESH_KERNEL_FIELDS,
  TRUSTED_KERNEL_FIELDS,
  UNSIGNED_KERNEL_FIELDS,
} from "./fixtures/authorized-kernels.js";

const OWNER = "n85-f2-owner@x.test";
let app: FastifyInstance;
let ownerKey = "";
const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;

function kernel(prefix: string, fields: Record<string, unknown>, claim: number): string {
  const id = uid(prefix);
  ensureKernelRow(id, { operatorAddress: OWNER, ...fields, maxAssuranceTier: claim });
  return id;
}

function nodeBody(kernelId: string, type: string, assuranceTier: unknown) {
  return {
    capabilityId: uid("f2-node"),
    capabilityType: type,
    kernelId,
    estimatedPriceUSD: 10,
    estimatedDurationMs: 1_000,
    assuranceTier,
    reputation: 500,
    outputTypes: [type],
  };
}

async function registerNode(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/capabilities/graph/_dev/register-node", headers: asOwner(), payload: body });
}

/** The tier a graph search serves the node at (the HIGHEST min tier that still returns it), or -1. */
async function searchServedTier(type: string): Promise<number> {
  let max = -1;
  for (const tier of [0, 1, 2, 3]) {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/graph-search",
      payload: { outcomeType: type, budgetUSD: 1_000, minAssuranceTier: tier },
    });
    expect(res.statusCode, res.body).toBe(201);
    const options = res.json().options as Array<{ steps: Array<{ assuranceTier: number }> }>;
    if (options.length > 0) max = options[0].steps[0].assuranceTier;
  }
  return max;
}

/** The raw node row as stored. */
function storedNode(capabilityId: string): { assuranceTier: number } | undefined {
  const rows = getStore().db.select().from(schema.graphSearchNodes).all();
  return rows.find((r) => r.capabilityId === capabilityId)?.data as { assuranceTier: number } | undefined;
}

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  ownerKey = provisionApiKey({ operatorId: OWNER, scopes: ["operator"] }).rawKey;
  app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(graphSearchRoutes);
  await app.ready();
});

beforeEach(() => {
  _clearGraphSearchForTests();
});

afterAll(async () => {
  await app?.close();
  closeStore();
});

describe("astra pack 90 F2: the graph registration response serves the same tier a search will", () => {
  it("[neg] astra's reproduction: an unsigned owned kernel, a node claiming 3: the response serves 0 and names the claim 3; a search serves 0 too", async () => {
    const kernelId = kernel("kernel-f2-unsigned", UNSIGNED_KERNEL_FIELDS, 3);
    const type = uid("f2-type");
    const body = nodeBody(kernelId, type, 3);
    const res = await registerNode(body);
    expect(res.statusCode, res.body).toBe(201);
    const { ok, node } = res.json();
    expect(ok).toBe(true);
    // At 3d392e60 this is 3: the response is the raw upserted node.
    expect(node.assuranceTier).toBe(0);
    expect(node.claimedAssuranceTier).toBe(3);
    expect(await searchServedTier(type)).toBe(0);
    // The stored node keeps the raw claim: only what is SERVED is capped.
    expect(storedNode(body.capabilityId)?.assuranceTier).toBe(3);
  });

  it.each([
    ["a signed but fresh kernel (ceiling 1) claiming 3", SIGNED_FRESH_KERNEL_FIELDS, 3, 3, 1],
    ["a proven kernel (ceiling 3) that claims only 1 (the F1 bound), node claiming 3", TRUSTED_KERNEL_FIELDS, 1, 3, 1],
    ["a proven kernel claiming 2, node claiming 3", TRUSTED_KERNEL_FIELDS, 2, 3, 2],
    ["a proven kernel claiming 3, node claiming 2 (the node's own lower claim wins)", TRUSTED_KERNEL_FIELDS, 3, 2, 2],
    ["an unsigned kernel, node claiming 0", UNSIGNED_KERNEL_FIELDS, 3, 0, 0],
  ])("[neg] %s: the response's assuranceTier is the served tier, claimedAssuranceTier the raw claim, and a search agrees", async (_label, fields, kernelClaim, nodeClaim, served) => {
    const kernelId = kernel("kernel-f2", fields, kernelClaim);
    const type = uid("f2-type");
    const res = await registerNode(nodeBody(kernelId, type, nodeClaim));
    expect(res.statusCode, res.body).toBe(201);
    const { node } = res.json();
    expect(node.assuranceTier).toBe(served);
    expect(node.claimedAssuranceTier).toBe(nodeClaim);
    expect(await searchServedTier(type)).toBe(served);
  });

  it("control: a TRUSTED kernel (ceiling 3, claim 3) with a node claiming 3 is served at 3, in the response and in a search", async () => {
    const kernelId = kernel("kernel-f2-trusted", TRUSTED_KERNEL_FIELDS, 3);
    const type = uid("f2-type");
    const res = await registerNode(nodeBody(kernelId, type, 3));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().node.assuranceTier).toBe(3);
    expect(await searchServedTier(type)).toBe(3);
  });

  it("the rest of the node is returned as before: its id, type, kernel, price and the authenticated operator", async () => {
    const kernelId = kernel("kernel-f2-shape", TRUSTED_KERNEL_FIELDS, 3);
    const type = uid("f2-type");
    const body = nodeBody(kernelId, type, 2);
    const { node } = (await registerNode(body)).json();
    expect(node).toMatchObject({
      capabilityId: body.capabilityId,
      capabilityType: type,
      kernelId,
      estimatedPriceUSD: 10,
      operatorAddress: OWNER,
    });
  });
});
