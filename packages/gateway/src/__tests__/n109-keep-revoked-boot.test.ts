import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { createStore, sql, type Store } from "@pcc/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key-auth.js";
import { closeStore, getStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import { provisionRoutes } from "../routes/provision.js";
import { runWildcardKeyMigration } from "../services/wildcard-key-migration.js";

const owner = "founder@example.com";
const wildcard = JSON.stringify(["*"]);
const basic = JSON.stringify(["operator:basic"]);
const migrationPrefix = "[wildcard-key-migration]";

function insert(store: Store, operatorId: string) {
  const credential = generateApiKey();
  const record = store.repos.apiKeys.insert({
    id: randomUUID(), keyHash: credential.keyHash, keyPrefix: credential.keyPrefix,
    operatorId, name: "kept-key boot regression", scopes: wildcard,
    rateLimit: "1000/hour", usageCount: "7", createdAt: "2020-01-02T03:04:05.000Z",
    metadata: JSON.stringify({ source: "landing-page", fixture: true }),
  })!;
  return { record, rawKey: credential.rawKey };
}

// Read every stored column, including fields outside the gateway's public key representation.
function rowBytes(store: Store, id: string): string {
  return JSON.stringify(store.db.get(sql`SELECT * FROM api_keys WHERE id = ${id}`));
}

function allBytes(store: Store): string {
  return JSON.stringify(store.db.all(sql`SELECT * FROM api_keys ORDER BY id`));
}

describe("N109 a standing migration gate tolerates an inactive kept key on every boot", () => {
  let directory: string;
  let path: string;
  let kept: ReturnType<typeof insert>;
  let other: ReturnType<typeof insert>;
  let app: FastifyInstance | undefined;

  beforeEach(() => {
    closeStore();
    const tmpRoot = resolve("../../tmp");
    mkdirSync(tmpRoot, { recursive: true });
    directory = mkdtempSync(join(tmpRoot, "n109-keep-"));
    path = join(directory, "gateway.sqlite");
    for (const name of ["RAILWAY_VOLUME_MOUNT_PATH", "PCC_GATEWAY_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "POSTHOG_API_KEY", "VITE_POSTHOG_KEY"]) {
      vi.stubEnv(name, "");
      delete process.env[name];
    }
    vi.stubEnv("DATABASE_URL", path);
    vi.stubEnv("PCC_DB_PATH", path);
    vi.stubEnv("PCC_WILDCARD_KEY_MIGRATION", "apply");
    vi.stubEnv("PCC_REVOKE_API_KEY_IDS", "");
    const seed = createStore({ dbPath: path, seed: false });
    try {
      kept = insert(seed, owner);
      other = insert(seed, "other@example.com");
    } finally {
      seed.close();
    }
    vi.stubEnv("PCC_WILDCARD_KEY_KEEP_IDS", kept.record.id);
    vi.spyOn(console, "log").mockImplementation(() => {});
    __resetScopeCacheForTests();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    closeStore();
    rmSync(directory, { recursive: true, force: true });
    __resetScopeCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function firstBoot() {
    const store = initStore({ seed: false });
    expect(store.repos.apiKeys.findById(kept.record.id)).toEqual(kept.record);
    expect(store.repos.apiKeys.findById(kept.record.id)!.scopes).toBe(wildcard);
    expect(store.repos.apiKeys.findById(other.record.id)!.scopes).toBe(basic);
    app = Fastify({ logger: false });
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(apiGate);
    await app.register(scopeChecker);
    await app.register(provisionRoutes);
    await app.ready();
    return app;
  }

  function rebootUnchanged(before: string, keptBefore: string) {
    closeStore();
    let store: Store | undefined;
    expect(() => { store = initStore({ seed: false }); }).not.toThrow();
    expect(allBytes(store!)).toBe(before);
    expect(rowBytes(store!, kept.record.id)).toBe(keptBefore);
    expect(store!.repos.apiKeys.findById(other.record.id)!.scopes).toBe(basic);
    return store!;
  }

  function validate(currentApp: FastifyInstance, rawKey: string) {
    return currentApp.inject({ method: "GET", url: "/api/auth/validate", headers: { authorization: `Bearer ${rawKey}` } });
  }

  it("the reviewer's outsider provision/list/revoke repro survives three reboots with counts-only logs", async () => {
    const currentApp = await firstBoot();
    const provision = await currentApp.inject({ method: "POST", url: "/api/auth/provision", payload: { email: owner } });
    expect(provision.statusCode).toBe(201);
    const headers = { authorization: `Bearer ${provision.json().api_key}` };
    const listed = await currentApp.inject({ method: "GET", url: "/api/auth/keys", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().keys.map((key: { id: string }) => key.id)).toContain(kept.record.id);
    const revoked = await currentApp.inject({ method: "DELETE", url: `/api/auth/keys/${kept.record.id}`, headers });
    expect(revoked.statusCode).toBe(200);
    expect(getStore().repos.apiKeys.findById(kept.record.id)!.revokedAt).not.toBeNull();
    const before = allBytes(getStore());
    const keptBefore = rowBytes(getStore(), kept.record.id);
    for (let boot = 0; boot < 3; boot++) {
      vi.mocked(console.log).mockClear();
      rebootUnchanged(before, keptBefore);
      expect((await validate(currentApp, kept.rawKey)).statusCode).toBe(401);
      const messages = vi.mocked(console.log).mock.calls
        .filter(([message]) => typeof message === "string" && message.startsWith(migrationPrefix));
      expect(messages).toEqual([["[wildcard-key-migration] narrowed 0, revoked 0, already revoked 0, kept 0, kept inactive 1"]]);
      expect(messages[0]).toHaveLength(1);
      expect(messages[0][0]).not.toContain(kept.record.id);
      expect(messages[0][0]).not.toContain(owner);
      expect(messages[0][0]).not.toContain(kept.rawKey);
      expect(allBytes(getStore())).toBe(before);
    }
  });

  it("the owner revokes the kept key with its own token and the next boot leaves it revoked", async () => {
    const currentApp = await firstBoot();
    const revoked = await currentApp.inject({
      method: "DELETE", url: `/api/auth/keys/${kept.record.id}`,
      headers: { authorization: `Bearer ${kept.rawKey}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(getStore().repos.apiKeys.findById(kept.record.id)!.revokedAt).not.toBeNull();
    rebootUnchanged(allBytes(getStore()), rowBytes(getStore(), kept.record.id));
    expect((await validate(currentApp, kept.rawKey)).statusCode).toBe(401);
  });

  it("an admin narrows the kept key and boot never restores its wildcard scopes", async () => {
    await firstBoot();
    getStore().db.run(sql`UPDATE api_keys SET scopes = ${basic} WHERE id = ${kept.record.id}`);
    const store = rebootUnchanged(allBytes(getStore()), rowBytes(getStore(), kept.record.id));
    expect(store.repos.apiKeys.findById(kept.record.id)!.scopes).toBe(basic);
  });

  it("a re-sourced kept key is left untouched on the next boot", async () => {
    await firstBoot();
    const metadata = JSON.stringify({ source: "admin-import", fixture: true });
    getStore().db.run(sql`UPDATE api_keys SET metadata = ${metadata} WHERE id = ${kept.record.id}`);
    const store = rebootUnchanged(allBytes(getStore()), rowBytes(getStore(), kept.record.id));
    expect(store.repos.apiKeys.findById(kept.record.id)!.metadata).toBe(metadata);
  });

  it.each(["revoked", "narrowed", "re-sourced"])("a kept key changed to %s before the first apply boot is skipped", (state) => {
    const seed = createStore({ dbPath: path, seed: false });
    let before: string;
    try {
      if (state === "revoked") seed.db.run(sql`UPDATE api_keys SET revoked_at = '2025-01-01T00:00:00.000Z' WHERE id = ${kept.record.id}`);
      if (state === "narrowed") seed.db.run(sql`UPDATE api_keys SET scopes = ${basic} WHERE id = ${kept.record.id}`);
      if (state === "re-sourced") seed.db.run(sql`UPDATE api_keys SET metadata = '{"source":"other"}' WHERE id = ${kept.record.id}`);
      before = rowBytes(seed, kept.record.id);
    } finally {
      seed.close();
    }
    let store: Store | undefined;
    expect(() => { store = initStore({ seed: false }); }).not.toThrow();
    expect(rowBytes(store!, kept.record.id)).toBe(before!);
    expect(store!.repos.apiKeys.findById(other.record.id)!.scopes).toBe(basic);
  });

  it.each(["missing kept", "missing revoke", "on both lists"])("configuration error %s fails before any write and carries counts only", (error) => {
    const store = createStore({ dbPath: path, seed: false });
    try {
      const before = allBytes(store);
      const keptIds = error === "missing kept" ? [randomUUID()] : [kept.record.id];
      const revokeIds = error === "missing revoke" ? [other.record.id, randomUUID()]
        : error === "on both lists" ? [other.record.id, kept.record.id] : [other.record.id];
      store.db.run(sql.raw("CREATE TRIGGER forbid_config_writes BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT, 'unexpected migration write'); END;"));
      let failure: unknown;
      try {
        runWildcardKeyMigration(store, ["operator:basic"], revokeIds, () => "2030-01-01T00:00:00.000Z", keptIds);
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("wildcard key migration verification failed");
      const counts = (failure as Error & { counts: Record<string, unknown> }).counts;
      expect(Object.values(counts).length).toBeGreaterThan(0);
      expect(Object.values(counts).every((value) => typeof value === "number")).toBe(true);
      expect(JSON.stringify(counts)).not.toContain(kept.record.id);
      expect(JSON.stringify(counts)).not.toContain(other.record.id);
      expect(allBytes(store)).toBe(before);
    } finally {
      store.close();
    }
  });
});
