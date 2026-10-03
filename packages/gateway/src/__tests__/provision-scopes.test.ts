/**
 * Provisioning scope-default tests (retire-the-wildcard #1099, piece 2).
 *
 * routes/provision.ts used to mint every self-service key with scopes:["*"],
 * which the scope-checker wildcard short-circuit (middleware/scope-checker.ts,
 * `if (callerScopes.includes("*")) return;`) then let bypass every scope
 * requirement, including the money path (see scope-checker-money-path.test.ts
 * "KNOWN GAP"). That test's gap is about EXISTING wildcard keys, which this
 * change deliberately does not touch (see routes/admin-key-audit.ts). This
 * file pins the other half: NEW keys are no longer minted with "*".
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { provisionRoutes } from "../routes/provision.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));
vi.mock("../middleware/security-hardening.js", () => ({
  canProvision: vi.fn(() => true),
}));

describe("POST /api/auth/provision — scope defaults (retire the wildcard)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    app = Fastify({ logger: false });
    await app.register(provisionRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("mints a self-service email key with a narrow scope, never '*'", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `scopes-${Date.now()}@example.com`, name: "test" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { scopes: string[] };
    expect(body.scopes).not.toContain("*");
    expect(body.scopes).toEqual(["operator"]);
  });

  it("the minted scope is real enough to satisfy the operator-gated money path", async () => {
    // Cross-check against the ApiScope union in packages/spec, not a guess:
    // DEFAULT_SCOPE_REQUIREMENTS in middleware/scope-checker.ts accepts
    // "operator" for /api/kernels/*, /api/evidence/*, and /api/escrow/**
    // writes — the actual self-service flow documented in CLAUDE.md.
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: `scopes2-${Date.now()}@example.com` },
    });
    const body = JSON.parse(res.body) as { scopes: string[] };
    expect(body.scopes).toContain("operator");
  });
});
