import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { scopeChecker } from "../middleware/scope-checker.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { initStore, closeStore } from "../db.js";

/**
 * Report-only rollout mode (audit P0, lane d749deff). The default mode: a
 * would-be 403 is LOGGED and the request is ALLOWED, so enabling the scope-checker
 * on ~500 unpoliced routes doesn't brick the API before the manifest is seeded.
 * Proves both would-be-denial paths (no-policy AND lacks-required-scope) permit +
 * record — the inverse of the enforce-mode integration test.
 */

// Minimal pino-compatible logger that records warn() calls so we can assert the
// would-be denial is not just permitted but observable.
const warnings: Array<Record<string, unknown>> = [];
function capturingLogger() {
  const log: Record<string, unknown> = {
    warn: (obj: Record<string, unknown>) => warnings.push(obj),
    info: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
    trace: () => {}, silent: () => {}, level: "warn",
  };
  log.child = () => log;
  return log;
}

describe("scopeChecker report-only mode (permit + record)", () => {
  let app: FastifyInstance;
  const prevMode = process.env.SCOPE_ENFORCEMENT_MODE;
  let n = 0;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.SCOPE_ENFORCEMENT_MODE = "report-only";
    initStore({ seed: false });
    app = Fastify({ logger: capturingLogger() as never });
    await app.register(apiGate);
    await app.register(scopeChecker);
    app.post("/api/itest/unpoliced", async () => ({ ok: true })); // no policy
    app.post("/api/admin/itest", async () => ({ ok: true })); // default ["admin"]
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    if (prevMode === undefined) delete process.env.SCOPE_ENFORCEMENT_MODE;
    else process.env.SCOPE_ENFORCEMENT_MODE = prevMode;
  });

  const bearer = (scopes: string[]) => ({
    authorization: `Bearer ${provisionApiKey({ operatorId: `ro-${++n}@x.com`, scopes }).rawKey}`,
  });
  const post = (url: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url, headers });
  const loggedReason = (reason: string) => warnings.some((w) => w.reason === reason);

  it("PERMITS an authenticated caller on an unpoliced route, and records it", async () => {
    warnings.length = 0;
    expect((await post("/api/itest/unpoliced", bearer(["operator"]))).statusCode).toBe(200);
    expect(loggedReason("no_scope_policy")).toBe(true);
  });

  it("PERMITS a caller lacking a required scope, and records it", async () => {
    warnings.length = 0;
    // operator lacks admin on /api/admin/* — enforce would 403; report-only allows.
    expect((await post("/api/admin/itest", bearer(["operator"]))).statusCode).toBe(200);
    expect(loggedReason("insufficient_scope")).toBe(true);
  });

  it("still 401s an unauthenticated request (apiGate is unaffected by the mode)", async () => {
    expect((await post("/api/admin/itest", {})).statusCode).toBe(401);
  });
});
