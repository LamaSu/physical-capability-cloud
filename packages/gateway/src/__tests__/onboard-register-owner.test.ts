/**
 * POST /api/onboard/register binds a registration's owner to the
 * AUTHENTICATED caller, never to an identity named in the body (WP-B round 5,
 * M3; cross-WP with #326 N2, which treats registration owners as claimed
 * identities).
 *
 * The audit service is not mocked: audit assertions read the real audit_log.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { onboardRoutes } from "../routes/onboard.js";
import { initStore, closeStore, getRepos } from "../db.js";

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: {
    emit: vi.fn(),
    getTimeline: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({}),
  },
}));

const OWNER = "owner@example.com";
const ATTACKER = "attacker@example.com";
const VICTIM_EMAIL = "victim@example.com";
const VICTIM_WALLET = "0x1111111111111111111111111111111111111111";
const SIWE_WALLET = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const ZERO = "0x0000000000000000000000000000000000000000";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  // Stand-in for api-gate: an API key sets operatorId (and userId to the same
  // value); a SIWE session sets userId only.
  app.addHook("onRequest", async (req) => {
    const key = req.headers["x-test-operator"];
    if (typeof key === "string") {
      (req as any).operatorId = key;
      (req as any).userId = key;
    }
    const siwe = req.headers["x-test-siwe"];
    if (typeof siwe === "string") (req as any).userId = siwe;
  });
  await app.register(onboardRoutes);
  await app.ready();
  return app;
}

function register(app: FastifyInstance, headers: Record<string, string>, operator?: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/onboard/register",
    headers,
    payload: { name: "Printer", category: "fdm", manufacturer: "Co", model: "M1", ...(operator !== undefined ? { operator } : {}) },
  });
}

const rows = () => getRepos().registrations.findAll();
const registeredAudits = () => getRepos().auditLog.query({ eventType: "operator.registered", limit: 1000 });

describe("/register binds the owner to the authenticated caller (M3)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
  });

  it("registering with someone else's email is 403 and stores nothing", async () => {
    const res = await register(app, { "x-test-operator": ATTACKER }, { email: VICTIM_EMAIL, displayName: "Victim" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "operator_must_be_caller", field: "operator.email" });
    expect(rows()).toHaveLength(0);
    expect(registeredAudits()).toHaveLength(0);
  });

  it("registering with someone else's wallet is 403 and stores nothing (API key or SIWE caller)", async () => {
    for (const headers of [{ "x-test-operator": ATTACKER }, { "x-test-siwe": SIWE_WALLET }]) {
      const res = await register(app, headers, { walletAddress: VICTIM_WALLET });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "operator_must_be_caller", field: "operator.walletAddress" });
    }
    expect(rows()).toHaveLength(0);
    expect(registeredAudits()).toHaveLength(0);
  });

  it("the caller's own identity plus someone else's is still 403", async () => {
    const res = await register(app, { "x-test-operator": ATTACKER }, { walletAddress: ATTACKER, email: VICTIM_EMAIL });
    expect(res.statusCode).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("naming an identity without authenticating is 403 and stores nothing", async () => {
    const res = await register(app, {}, { walletAddress: VICTIM_WALLET });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("operator_must_be_caller");
    expect(rows()).toHaveLength(0);
  });

  it("the caller's own identity is accepted, compared case-folded, and stored as the caller's", async () => {
    const siwe = await register(app, { "x-test-siwe": SIWE_WALLET }, { walletAddress: `  ${SIWE_WALLET.toLowerCase()} `, displayName: "Me" });
    expect(siwe.statusCode).toBe(200);
    const siweId: string = siwe.json().registration.id;
    expect(getRepos().registrations.findById(siweId)!.operator).toMatchObject({ walletAddress: SIWE_WALLET, displayName: "Me" });
    // The registration audit names the caller, not the body's spelling.
    expect(registeredAudits().find((r) => r.resourceId === siweId)!.actor).toBe(SIWE_WALLET);

    const byEmail = await register(app, { "x-test-operator": OWNER }, { email: "Owner@Example.com" });
    expect(byEmail.statusCode).toBe(200);
    expect(getRepos().registrations.findById(byEmail.json().registration.id)!.operator).toMatchObject({ walletAddress: OWNER, email: OWNER });
  });

  it("with no identity in the body the owner is the caller, who can then prove it; another operator cannot", async () => {
    const res = await register(app, { "x-test-operator": OWNER });
    expect(res.statusCode).toBe(200);
    const regId: string = res.json().registration.id;
    expect(getRepos().registrations.findById(regId)!.operator).toMatchObject({ walletAddress: OWNER });

    const prove = (operator: string) =>
      app.inject({
        method: "POST",
        url: `/api/onboard/registrations/${regId}/prove`,
        headers: { "x-test-operator": operator },
        payload: { evidence: { deviceHealth: { status: "idle", model: "M1" } } },
      });
    expect((await prove(ATTACKER)).statusCode).toBe(403);
    expect((await prove(OWNER)).statusCode).toBe(200);
  });

  it("the zero-address placeholder and empty strings name nobody", async () => {
    const res = await register(app, { "x-test-operator": OWNER }, { walletAddress: ZERO, email: "", displayName: "Me" });
    expect(res.statusCode).toBe(200);
    const operator = getRepos().registrations.findById(res.json().registration.id)!.operator as Record<string, unknown>;
    expect(operator.walletAddress).toBe(OWNER);
    expect(operator).not.toHaveProperty("email");
  });

  it("a non-object operator is 400 and stores nothing", async () => {
    const res = await register(app, { "x-test-operator": ATTACKER }, VICTIM_EMAIL);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_operator");
    expect(rows()).toHaveLength(0);
  });
});

describe("/register ids and persistence (L4)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeStore();
  });

  it("two registrations in the same millisecond get distinct random ids, each for its own row", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const a = await register(app, { "x-test-operator": OWNER }, { displayName: "A" });
    const b = await register(app, { "x-test-operator": ATTACKER }, { displayName: "B" });
    now.mockRestore();
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const idA: string = a.json().registration.id;
    const idB: string = b.json().registration.id;
    expect(idA).toMatch(/^reg-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(idB).not.toBe(idA);
    // Before the fix the second caller got a 200 carrying the first caller's id.
    expect(getRepos().registrations.findById(idA)!.operator).toMatchObject({ walletAddress: OWNER, displayName: "A" });
    expect(getRepos().registrations.findById(idB)!.operator).toMatchObject({ walletAddress: ATTACKER, displayName: "B" });
  });

  it("a failed insert is 500 with no registration in the response, and nothing is recorded", async () => {
    vi.spyOn(getRepos().registrations, "insert").mockImplementation(() => {
      throw new Error("SQLITE_FULL: database or disk is full");
    });
    const res = await register(app, { "x-test-operator": OWNER });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "registration_persist_failed" });
    expect(res.json()).not.toHaveProperty("registration");
    expect(registeredAudits()).toHaveLength(0);
  });
});
