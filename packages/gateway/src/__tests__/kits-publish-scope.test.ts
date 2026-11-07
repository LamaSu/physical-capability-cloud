import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { generateApiKey } from "../auth/api-key-auth.js";
import { closeStore, getRepos, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import * as sc from "../middleware/scope-checker.js";
import { kitRoutes } from "../routes/kits.js";
import { provisionRoutes } from "../routes/provision.js";
import { KitRegistry } from "../services/kit-registry.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const KIT_URL = `/api/kits/${digest("a")}`;
const FORK_URL = `${KIT_URL}/fork`;
const completeKit = () => ({
  schema: "pcc.capability-kit/v1",
  name: "OT-2 dye serial dilution",
  version: "1.0.0",
  parentKitDigest: null,
  capabilities: [{ csdUrl: "pcc://capabilities/liquid-handling/v1", capabilityContractDigest: digest("a") }],
  artifacts: [
    { role: "method", name: "serial-dilution.py", mediaType: "text/x-python", digest: digest("1") },
    { role: "tests", name: "checks.json", mediaType: "application/json", digest: digest("5") },
    { role: "install-recipe", name: "INSTALL.md", mediaType: "text/markdown", digest: digest("6") },
    { role: "provenance-recipe", name: "provenance.json", mediaType: "application/json", digest: digest("7") },
  ],
  economics: { spdxLicense: "Apache-2.0" },
});

function insertIssuedKey(scopes: string[]): string {
  const key = generateApiKey();
  getRepos().apiKeys.insert({
    id: randomUUID(),
    keyHash: key.keyHash,
    keyPrefix: key.keyPrefix,
    operatorId: `kit-${scopes[0]}@example.com`,
    scopes: JSON.stringify(scopes),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  });
  return key.rawKey;
}

async function provisionSelfServiceKey(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/provision",
    payload: { email: "kit-basic-operator@example.com" },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().scopes).toEqual(["operator:basic"]);
  return response.json().api_key;
}

describe("Capability Kit publishing scopes with provisioned keys", () => {
  let app: FastifyInstance;
  let registry: KitRegistry;
  let rootDir: string;

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", ":memory:");
    for (const name of ["PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
      vi.stubEnv(name, "");
      delete process.env[name];
    }
    initStore({ seed: true });
    sc.__resetScopeCacheForTests();
    rootDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "kits-publish-scope-"));
    registry = new KitRegistry({ rootDir, durable: () => true, audit: () => undefined });
    app = Fastify();
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(apiGate);
    await app.register(sc.scopeChecker);
    await app.register(provisionRoutes);
    await app.register(kitRoutes, { registry });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    closeStore();
    sc.__resetScopeCacheForTests();
    vi.unstubAllEnvs();
    if (rootDir) await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("K1: a provisioned operator:basic key cannot publish or fork a kit", async () => {
    const rawKey = await provisionSelfServiceKey(app);
    for (const url of ["/api/kits", FORK_URL]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: { authorization: `Bearer ${rawKey}` },
        payload: completeKit(),
      });
      expect(response.statusCode, url).toBe(403);
      expect(response.json().error, url).toBe("insufficient_scope");
      expect((await registry.list()).total).toBe(0);
    }
  });

  it("K2: an issued template_author key can publish a kit", async () => {
    const rawKey = insertIssuedKey(["template_author"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/kits",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: completeKit(),
    });
    expect(response.statusCode).toBe(201);
    expect((await registry.list()).total).toBe(1);
  });

  it("K3: an issued operator key cannot publish a kit", async () => {
    const rawKey = insertIssuedKey(["operator"]);
    const response = await app.inject({
      method: "POST",
      url: "/api/kits",
      headers: { authorization: `Bearer ${rawKey}` },
      payload: completeKit(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("insufficient_scope");
    expect((await registry.list()).total).toBe(0);
  });

  it("K4: anonymous kit listing and detail reads require an API key", async () => {
    for (const url of ["/api/kits", KIT_URL]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json().error, url).toBe("api_key_required");
    }
  });

  it("K5: a provisioned operator:basic key can list kits", async () => {
    const rawKey = await provisionSelfServiceKey(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/kits",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(response.statusCode).toBe(200);
  });
});
