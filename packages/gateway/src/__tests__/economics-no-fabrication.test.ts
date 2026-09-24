/**
 * Money-like routes that had no real source must say so (501 not_available), never invent state.
 * Readmodels' server-side fabrication census (2026-09-24) assigned these to pcc-economics:
 *   - POST /api/swf/epochs/:epochId/distribute scored participants with Math.random() and then
 *     DISTRIBUTED the epoch on those scores;
 *   - /api/rewards/*, /api/certificates* and /api/treasury/summary served fixtures (a treasury of
 *     "50000.00" USDC, "claimed" claims with a fake tx hash, a mint that reported minted:true).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { rewardRoutes } from "../routes/rewards.js";
import { swfRoutes } from "../routes/swf.js";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rewardRoutes);
  await app.register(swfRoutes);
  await app.ready();
  return app;
}

describe("rewards, certificates and treasury: not available, never fabricated", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it.each([
    ["GET", "/api/rewards/epochs"],
    ["GET", "/api/rewards/epochs/epoch_completed_001"],
    ["GET", "/api/rewards/kernels/kernel-biolab-01"],
    ["POST", "/api/rewards/claims"],
    ["GET", "/api/rewards/claims/claim_biolab_ep1"],
    ["GET", "/api/certificates"],
    ["GET", "/api/certificates/cnft_biolab_fdm_001"],
    ["POST", "/api/certificates/mint"],
    ["GET", "/api/treasury/summary"],
  ] as const)("%s %s answers 501 not_available with pointers and no invented values", async (method, url) => {
    const res = await app.inject({
      method,
      url,
      ...(method === "POST" ? { payload: { kernelId: "k", epochId: "e", amount: "1", kernelDid: "d", capabilityType: "fdm" } } : {}),
    });
    expect(res.statusCode).toBe(501);
    const body = res.json<{ error: string; message: string; see: string[] }>();
    expect(body.error).toBe("not_available");
    expect(Array.isArray(body.see)).toBe(true);
    // None of the old fixture values may leak through.
    expect(res.body).not.toMatch(/50000\.00|85000\.00|mockTxHash|"minted":true|"status":"claimed"|4115\.000000/);
  });
});

describe("SWF epoch distribution is refused until real contribution inputs exist", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("answers 501 and does not distribute the epoch", async () => {
    const epochs = (await app.inject({ method: "GET", url: "/api/swf/epochs" })).json<{ epochs: Array<{ id: string; status: string }> }>();
    const epoch = epochs.epochs[0]!;
    const res = await app.inject({ method: "POST", url: `/api/swf/epochs/${epoch.id}/distribute` });
    expect(res.statusCode).toBe(501);
    expect(res.json<{ error: string }>().error).toBe("not_available");
    const after = (await app.inject({ method: "GET", url: `/api/swf/epochs/${epoch.id}` })).json<{ epoch: { status: string } }>();
    expect(after.epoch.status).toBe(epoch.status);
  });
});
