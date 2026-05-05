/**
 * T1.9 — tenant context middleware tests.
 *
 * The middleware is a Wave 4 prerequisite: it attaches `req.tenantId` so
 * repo helpers can scope queries during the upcoming RLS migration. Today
 * the call sites still call `findAll()` unfiltered; this test verifies the
 * hook works end-to-end so the migration can land without touching the
 * pipeline a second time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { tenantContext, getTenantContext } from "../middleware/tenant-context.ts";
import { initStore, closeStore } from "../db.js";

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(() => null),
}));

vi.mock("../auth/api-key-auth.js", async () => {
  const actual = await vi.importActual<typeof import("../auth/api-key-auth.ts")>(
    "../auth/api-key-auth.ts"
  );
  return {
    ...actual,
    resolveApiKey: vi.fn(() => null),
  };
});

describe("T1.9 — tenantContext middleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });

    app = Fastify({ logger: false });
    await app.register(tenantContext);
    app.get("/api/probe", async (req) => ({
      tenantId: (req as FastifyRequest).tenantId,
      ctx: getTenantContext(req as FastifyRequest),
    }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    vi.clearAllMocks();
  });

  it("sets req.tenantId = null when the request is anonymous", async () => {
    const res = await app.inject({ method: "GET", url: "/api/probe" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe(null);
    expect(body.ctx.byApiKey).toBe(false);
    expect(body.ctx.bySession).toBe(false);
  });

  it("sets req.tenantId from a resolved API key (operatorId)", async () => {
    const { resolveApiKey } = await import("../auth/api-key-auth.js");
    (resolveApiKey as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      id: "key-1",
      operatorId: "operator@example.com",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/probe",
      headers: { authorization: "Bearer pcc_live_real_key" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe("operator@example.com");
  });

  it("sets req.tenantId from a SIWE session (wallet address)", async () => {
    const { resolveSession } = await import("../auth/siwe-auth.js");
    (resolveSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      address: "0xdeadbeef00000000000000000000000000000000",
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/probe",
      headers: { cookie: "session=foo" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tenantId).toBe("0xdeadbeef00000000000000000000000000000000");
  });

  it("plugin is non-encapsulated (Symbol.for('skip-override') is set)", () => {
    expect((tenantContext as unknown as { [k: symbol]: unknown })[Symbol.for("skip-override")]).toBe(
      true
    );
  });
});
