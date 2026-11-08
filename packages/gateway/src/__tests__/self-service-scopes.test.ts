import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { provisionRoutes } from "../routes/provision.js";
import { isIdentityWriteEnabled } from "../services/erc8004-identity-write.js";
import { SCOPE_COVERED_ROUTES, UNSCOPED_ROUTES } from "./helpers/scope-covered-routes.js";

interface ScopeRule {
  readonly method: string;
  readonly pattern: string;
  readonly scopes: readonly string[];
}

describe("self-service keys hold only the basic operator scope", () => {
  let app: FastifyInstance;
  let rawKey: string;
  let provisionResponse: Awaited<ReturnType<FastifyInstance["inject"]>>;

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", ":memory:");
    for (const name of ["PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
      vi.stubEnv(name, "");
      delete process.env[name];
    }
    initStore({ seed: true });
    sc.__resetScopeCacheForTests();
    app = Fastify();
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(apiGate);
    await app.register(sc.scopeChecker);
    await app.register(provisionRoutes);
    for (const route of [...SCOPE_COVERED_ROUTES, ...UNSCOPED_ROUTES]) {
      app.route({ method: route.method, url: route.path, handler: async () => ({ reached: true }) });
    }
    await app.ready();
    provisionResponse = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      payload: { email: "basic-operator@example.com" },
    });
    rawKey = provisionResponse.json().api_key;
  });

  afterAll(async () => {
    await app?.close();
    closeStore();
    vi.unstubAllEnvs();
  });

  it("provision returns exactly the basic operator scope with identity writes disabled", async () => {
    expect(isIdentityWriteEnabled()).toBe(false);
    expect(provisionResponse.statusCode).toBe(201);
    const body = provisionResponse.json();
    expect(body.scopes).toEqual(["operator:basic"]);
    expect(body.scopes).not.toContain("*");
    expect(body.scopes).not.toContain("admin");
    expect(body.scopes).not.toContain("operator");
    expect(body.onchain.status).toBe("disabled");
    expect(body.operator_wallet.source).toBe("none");
  });

  it("basic operator keys cannot write money or satisfy admin requirements", async () => {
    const moneyWrites = SCOPE_COVERED_ROUTES.filter((route) => route.class === "money-write");
    const admin = SCOPE_COVERED_ROUTES.filter((route) => route.class === "admin");
    expect(moneyWrites).toHaveLength(25);
    expect(admin).toHaveLength(13);
    for (const route of [...moneyWrites, ...admin]) {
      const response = await app.inject({ method: route.method, url: route.url, headers: { authorization: `Bearer ${rawKey}` } });
      // The public feedback route's separate token gate receives no principal from apiGate.
      if (route.url === "/api/admin/feedback") {
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ reached: true });
      } else {
        expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
        expect(response.json().error).toBe("insufficient_scope");
        expect(response.json().reached).toBeUndefined();
      }
    }
    expect(admin.filter((route) => route.url !== "/api/admin/feedback")).toHaveLength(12);
  });

  it("basic operator keys reach every non-money operator pair and every unscoped pair", async () => {
    const operatorPairs = SCOPE_COVERED_ROUTES.filter((route) => (
      route.class === "other-write" && route.requirement !== "money-default-deny" && route.requirement.includes("operator")
    ));
    expect(operatorPairs).toHaveLength(13);
    expect(UNSCOPED_ROUTES).toHaveLength(6);
    for (const route of [...operatorPairs, ...UNSCOPED_ROUTES]) {
      const response = await app.inject({ method: route.method, url: route.url, headers: { authorization: `Bearer ${rawKey}` } });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(200);
      expect(response.json()).toEqual({ reached: true });
    }
  });

  it("basic operator keys hold no attestation, contributor or audit scopes", async () => {
    const attestations = SCOPE_COVERED_ROUTES.filter((route) => route.url.includes("/attestations/"));
    const contributors = SCOPE_COVERED_ROUTES.filter((route) => route.url.startsWith("/api/contributors"));
    const audits = SCOPE_COVERED_ROUTES.filter((route) => route.url.startsWith("/api/audit/"));
    expect(attestations).toHaveLength(1);
    expect(contributors).toHaveLength(3);
    expect(audits).toHaveLength(2);
    for (const route of [...attestations, ...contributors, ...audits]) {
      const response = await app.inject({ method: route.method, url: route.url, headers: { authorization: `Bearer ${rawKey}` } });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(403);
      expect(response.json().error).toBe("insufficient_scope");
      expect(response.json().reached).toBeUndefined();
    }
  });

  it("the basic scope is derived only from non-money, non-admin operator rules", () => {
    const exports = sc as typeof sc & {
      SELF_SERVICE_OPERATOR_SCOPE?: string;
      SELF_SERVICE_KEY_SCOPES?: readonly string[];
      DEFAULT_SCOPE_RULES?: readonly ScopeRule[];
    };
    expect(exports.SELF_SERVICE_OPERATOR_SCOPE).toBeDefined();
    expect(exports.SELF_SERVICE_KEY_SCOPES).toBeDefined();
    expect(exports.DEFAULT_SCOPE_RULES).toBeDefined();
    const scopes = exports.SELF_SERVICE_KEY_SCOPES!;
    expect(exports.SELF_SERVICE_OPERATOR_SCOPE).toBe("operator:basic");
    expect(scopes).toEqual([exports.SELF_SERVICE_OPERATOR_SCOPE]);
    expect(Object.isFrozen(scopes)).toBe(true);
    for (const excluded of ["*", "admin", "operator"]) expect(scopes).not.toContain(excluded);
    for (const rule of exports.DEFAULT_SCOPE_RULES!) {
      const moneyWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(rule.method) &&
        ["/api/escrow/", "/api/fiat-ramp/", "/api/settlement/"].some((prefix) => rule.pattern.startsWith(prefix));
      const admin = rule.pattern.startsWith("/api/admin/");
      if (rule.scopes.includes("operator") && !moneyWrite && !admin) {
        expect(rule.scopes, `${rule.method} ${rule.pattern}`).toContain(exports.SELF_SERVICE_OPERATOR_SCOPE);
      } else {
        for (const scope of scopes) expect(rule.scopes, `${rule.method} ${rule.pattern}`).not.toContain(scope);
      }
    }
  });

  it("omitting scopes from provisionApiKey stores the self-service scope set", () => {
    const result = provisionApiKey({ operatorId: "default-basic-operator@example.com" });
    expect(result.record).toBeDefined();
    expect(JSON.parse(getRepos().apiKeys.findById(result.record!.id)!.scopes)).toEqual(["operator:basic"]);
  });
});
