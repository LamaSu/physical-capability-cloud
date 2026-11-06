import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { generateApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { SCOPE_COVERED_ROUTES, UNSCOPED_ROUTES } from "./helpers/scope-covered-routes.js";

const scopeSets = [
  ["*"],
  [],
  ["operator"],
  ["admin"],
  ["operator", "admin"],
  ["requestor"],
  ["agent"],
  ["verifier"],
  ["template_author"],
  ["auditor"],
  ["contributor:read", "contributor:write", "schedule:read", "schedule:publish"],
] as const;
const callers = [
  ...scopeSets.map((scopes) => ({ label: JSON.stringify(scopes), scopes: [...scopes] as string[], stored: JSON.stringify(scopes) })),
  { label: "malformed scopes", scopes: [] as string[], stored: '{"scopes":true}' },
];
const cases = [
  ...SCOPE_COVERED_ROUTES.map((route) => ({ ...route, unscoped: false })),
  ...UNSCOPED_ROUTES.map((route) => ({ ...route, requirement: [] as readonly string[], unscoped: true })),
];

describe("API key scope decisions are unchanged", () => {
  let app: FastifyInstance;
  const keys = new Map<string, string>();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", ":memory:");
    initStore({ seed: true });
    sc.__resetScopeCacheForTests();
    for (const caller of callers) {
      const key = generateApiKey();
      getRepos().apiKeys.insert({
        id: randomUUID(),
        keyHash: key.keyHash,
        keyPrefix: key.keyPrefix,
        operatorId: `key-${caller.label}@example.com`,
        scopes: caller.stored,
        rateLimit: "1000/hour",
        usageCount: "0",
        createdAt: new Date().toISOString(),
      });
      keys.set(caller.label, key.rawKey);
    }
    app = Fastify();
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(apiGate);
    await app.register(sc.scopeChecker);
    for (const route of cases) {
      app.route({ method: route.method, url: route.path, handler: async () => ({ reached: true }) });
    }
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    closeStore();
    vi.unstubAllEnvs();
  });

  it("covers all 57 matched pairs and six unscoped pairs", () => {
    expect(SCOPE_COVERED_ROUTES).toHaveLength(57);
    expect(UNSCOPED_ROUTES).toHaveLength(6);
  });

  describe.each(callers)("$label", (caller) => {
    it.each(cases)("$method $path preserves the master's decision", async (route) => {
      // apiGate leaves public routes without a principal even when they carry credentials.
      const publicRoute = route.url === "/api/admin/feedback";
      const allowed = publicRoute || route.unscoped || caller.scopes.includes("*") || (
        route.requirement !== "money-default-deny" && route.requirement.some((scope) => caller.scopes.includes(scope))
      );
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { authorization: `Bearer ${keys.get(caller.label)}` },
      });
      expect(response.statusCode).toBe(allowed ? 200 : 403);
      if (allowed) {
        expect(response.json()).toEqual({ reached: true });
      } else {
        expect(response.json().error).toBe("insufficient_scope");
        expect(response.json().reached).toBeUndefined();
      }
    });
  });
});
