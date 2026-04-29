/**
 * T1.5 — Auth gate on /api/onboard/register
 *
 * The audit (review-alpha) flagged this endpoint as "unauthenticated → sybil
 * farm w/ +570 reputation cold-start exploit". The apiGate middleware was
 * already gating it (the route is NOT in PUBLIC_PREFIXES / PUBLIC_EXACT),
 * but we add this test as a regression guard so a future PR doesn't
 * accidentally add `/api/onboard/register` to the public list.
 *
 * The cold-start cap fix (50, was 600) is covered in reputation-service.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { onboardRoutes } from "../routes/onboard.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

async function buildAppWithGate(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

describe("T1.5 — /api/onboard/register requires authentication", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildAppWithGate();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns 401 when no Authorization header is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/register",
      payload: {
        name: "Sybil Operator",
        category: "fdm",
      },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("api_key_required");
  });

  it("returns 401 when an invalid Bearer token is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/register",
      headers: {
        authorization: "Bearer pcc_live_invalid_key_does_not_exist",
      },
      payload: {
        name: "Sybil Operator",
        category: "fdm",
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when a non-pcc Bearer token is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboard/register",
      headers: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.fake.jwt",
      },
      payload: {
        name: "Sybil Operator",
        category: "fdm",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
