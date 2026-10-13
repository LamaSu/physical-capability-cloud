import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { createStore, schema, sql, type Store } from "@pcc/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateApiKey } from "../auth/api-key-auth.js";
import { parseStoredScopes, SELF_SERVICE_KEY_SCOPES } from "../auth/key-scopes.js";
import { closeStore, initStore } from "../db.js";
import { apiGate } from "../middleware/api-gate.js";
import { __resetScopeCacheForTests, scopeChecker } from "../middleware/scope-checker.js";
import {
  applyWildcardKeyMigrationFromEnv,
  runWildcardKeyMigration,
  SELF_SERVICE_METADATA_PREDICATE,
} from "../services/wildcard-key-migration.js";
import { SCOPE_COVERED_ROUTES } from "./helpers/scope-covered-routes.js";

const now = "2030-01-02T03:04:05.000Z";
const earlier = "2020-01-02T03:04:05.000Z";
const sourceMetadata = JSON.stringify({ source: "landing-page" });
type Row = typeof schema.apiKeys.$inferSelect;
type Insert = typeof schema.apiKeys.$inferInsert;

function insert(store: Store, overrides: Partial<Insert> = {}) {
  const credential = generateApiKey();
  const record = store.repos.apiKeys.insert({
    id: randomUUID(),
    keyHash: credential.keyHash,
    keyPrefix: credential.keyPrefix,
    operatorId: randomUUID(),
    name: "invariant fixture",
    description: "row fields remain stable",
    scopes: JSON.stringify(["*"]),
    rateLimit: "1000/hour",
    usageCount: "7",
    lastUsedAt: earlier,
    createdAt: earlier,
    expiresAt: null,
    revokedAt: null,
    metadata: sourceMetadata,
    ...overrides,
  })!;
  return { record, rawKey: credential.rawKey };
}

function rows(store: Store): Row[] {
  return store.db.select().from(schema.apiKeys).orderBy(schema.apiKeys.id).all();
}

function snapshot(store: Store): string {
  return JSON.stringify(rows(store));
}

function seedCases(store: Store) {
  const candidates = [
    insert(store).record,
    insert(store, { scopes: "*" }).record,
    insert(store, { scopes: JSON.stringify("read, *") }).record,
    insert(store, { scopes: JSON.stringify(["read", "*"]), expiresAt: "2001-01-01T00:00:00.000Z" }).record,
  ];
  const unchanged = [
    insert(store, { scopes: JSON.stringify(SELF_SERVICE_KEY_SCOPES) }).record,
    insert(store, { revokedAt: earlier }).record,
    insert(store, { metadata: JSON.stringify({ source: "contributor-quickstart", flow: "quickstart" }) }).record,
    insert(store, { metadata: JSON.stringify({ source: "other" }) }).record,
    insert(store, { metadata: null }).record,
    insert(store, { metadata: "{" }).record,
    insert(store, { metadata: JSON.stringify([{ source: "landing-page" }]) }).record,
    insert(store, { metadata: JSON.stringify(sourceMetadata) }).record,
    insert(store, { scopes: '{"scopes":true}' }).record,
  ];
  return { candidates, unchanged };
}

function expectNarrowed(store: Store, fixtures: ReturnType<typeof seedCases>, keptIds: readonly string[] = []): void {
  for (const record of fixtures.candidates) {
    expect(store.repos.apiKeys.findById(record.id)).toEqual(keptIds.includes(record.id)
      ? record
      : { ...record, scopes: JSON.stringify([...SELF_SERVICE_KEY_SCOPES]) });
  }
  expect(fixtures.candidates[3].expiresAt).toBe("2001-01-01T00:00:00.000Z");
  for (const record of fixtures.unchanged) expect(store.repos.apiKeys.findById(record.id)).toEqual(record);
}

describe("wildcard migration requires explicit operator activation and verifies one transaction", () => {
  let directory: string;
  let app: FastifyInstance | undefined;
  const stores = new Set<Store>();

  function open(path = join(directory, `${randomUUID()}.sqlite`)): Store {
    const store = createStore({ dbPath: path, seed: false });
    stores.add(store);
    return store;
  }

  function close(store: Store): void {
    store.close();
    stores.delete(store);
  }

  function gate(value: string | undefined): void {
    vi.stubEnv("PCC_WILDCARD_KEY_MIGRATION", value ?? "");
    if (value === undefined) delete process.env.PCC_WILDCARD_KEY_MIGRATION;
  }

  beforeEach(() => {
    closeStore();
    directory = mkdtempSync(join(tmpdir(), "pcc-migration-"));
    gate(undefined);
    vi.stubEnv("PCC_REVOKE_API_KEY_IDS", "");
    vi.stubEnv("PCC_WILDCARD_KEY_KEEP_IDS", "");
    __resetScopeCacheForTests();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    closeStore();
    for (const store of stores) store.close();
    stores.clear();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("the exported SQL predicate exactly defines self-service metadata", () => {
    expect(SELF_SERVICE_METADATA_PREDICATE).toBe("json_valid(metadata) AND json_type(metadata) = 'object' AND json_extract(metadata, '$.source') = 'landing-page'");
  });

  it("boot narrows only when the gate is apply and otherwise preserves full rows", () => {
    const originalPath = join(directory, "original.sqlite");
    const original = open(originalPath);
    const fixtures = seedCases(original);
    const before = snapshot(original);
    close(original);
    const offPath = join(directory, "off.sqlite");
    const onPath = join(directory, "on.sqlite");
    copyFileSync(originalPath, offPath);
    copyFileSync(originalPath, onPath);
    vi.stubEnv("DATABASE_URL", offPath);
    vi.stubEnv("PCC_DB_PATH", offPath);
    expect(snapshot(initStore({ seed: false }))).toBe(before);
    closeStore();
    gate("apply");
    vi.stubEnv("DATABASE_URL", onPath);
    vi.stubEnv("PCC_DB_PATH", onPath);
    expectNarrowed(initStore({ seed: false }), fixtures);
  });

  it("failed boot verification preserves rows and remains required on a retry", () => {
    const path = join(directory, "retry.sqlite");
    const original = open(path);
    seedCases(original);
    const live = insert(original, { metadata: null }).record;
    const before = snapshot(original);
    close(original);
    gate("apply");
    vi.stubEnv("DATABASE_URL", path);
    vi.stubEnv("PCC_REVOKE_API_KEY_IDS", `${live.id}, ${randomUUID()}`);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => initStore({ seed: false })).toThrowError("wildcard key migration verification failed");
    }
    expect(snapshot(open(path))).toBe(before);
  });

  it.each([undefined, "", "0", "1", "true", "yes", "APPLY"])("gate %j preserves full rows even with revoke and keep lists", (value) => {
    const store = open();
    const fixtures = seedCases(store);
    const before = snapshot(store);
    gate(value);
    vi.stubEnv("PCC_REVOKE_API_KEY_IDS", `${fixtures.candidates[0].id}, ${fixtures.unchanged[1].id}`);
    vi.stubEnv("PCC_WILDCARD_KEY_KEEP_IDS", `${fixtures.candidates[0].id}, ${fixtures.unchanged[1].id}, ${randomUUID()}`);
    expect(applyWildcardKeyMigrationFromEnv(store)).toBeUndefined();
    expect(snapshot(store)).toBe(before);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("apply narrows exactly unrevoked self-service wildcard rows including expired rows", () => {
    const store = open();
    const fixtures = seedCases(store);
    gate("apply");
    expect(applyWildcardKeyMigrationFromEnv(store)).toEqual({ narrowed: 4, revoked: 0, alreadyRevoked: 0, kept: 0 });
    expectNarrowed(store, fixtures);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("[wildcard-key-migration] narrowed 4, revoked 0, already revoked 0, kept 0");
  });

  it.each(["env", "boot"])("%s preserves kept rows byte-identically and narrows all other candidates", (entryPoint) => {
    const path = join(directory, "keep.sqlite");
    const original = open(path);
    const fixtures = seedCases(original);
    const keptIds = [fixtures.candidates[0].id, fixtures.candidates[3].id];
    gate("apply");
    vi.stubEnv("PCC_WILDCARD_KEY_KEEP_IDS", ` , ${keptIds[0]} , ${keptIds[1]}, ${keptIds[0]}, , `);
    let store: Store;
    if (entryPoint === "boot") {
      close(original);
      vi.stubEnv("DATABASE_URL", path);
      vi.stubEnv("PCC_DB_PATH", path);
      store = initStore({ seed: false });
    } else {
      store = original;
      expect(applyWildcardKeyMigrationFromEnv(store)).toEqual({ narrowed: 2, revoked: 0, alreadyRevoked: 0, kept: 2 });
    }
    expectNarrowed(store, fixtures, keptIds);
    expect(vi.mocked(console.log).mock.calls.filter(([message]) =>
      typeof message === "string" && message.startsWith("[wildcard-key-migration]"),
    )).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith("[wildcard-key-migration] narrowed 2, revoked 0, already revoked 0, kept 2");
  });

  it("the pure function preserves accepted wildcard scope formats and de-duplicates kept ids", () => {
    const store = open();
    const fixtures = seedCases(store);
    const kept = [
      JSON.stringify(["*"]), "*", JSON.stringify("read, *"), " read, *, , ", JSON.stringify(["read", 1, null, "*"]),
    ].map((scopes) => insert(store, { scopes }).record);
    const live = insert(store, { metadata: null }).record;
    const keptIds = kept.flatMap((record) => [record.id, record.id]);
    expect(runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id], () => now, keptIds))
      .toEqual({ narrowed: 4, revoked: 1, alreadyRevoked: 0, kept: 5 });
    expectNarrowed(store, fixtures);
    for (const record of kept) expect(store.repos.apiKeys.findById(record.id)).toEqual(record);
    expect(store.repos.apiKeys.findById(live.id)).toEqual({ ...live, revokedAt: now });
  });

  it.each([
    { label: "missing", overrides: undefined },
    { label: "revoked", overrides: { revokedAt: earlier } },
    { label: "another source", overrides: { metadata: JSON.stringify({ source: "other" }) } },
    { label: "contributor source", overrides: { metadata: JSON.stringify({ source: "contributor-quickstart", flow: "quickstart" }) } },
    { label: "null metadata", overrides: { metadata: null } },
    { label: "malformed metadata", overrides: { metadata: "{" } },
    { label: "array metadata", overrides: { metadata: JSON.stringify([{ source: "landing-page" }]) } },
    { label: "string metadata", overrides: { metadata: JSON.stringify(sourceMetadata) } },
    { label: "array source", overrides: { metadata: JSON.stringify({ source: ["landing-page"] }) } },
    { label: "different source casing", overrides: { metadata: JSON.stringify({ source: "Landing-page" }) } },
    { label: "scopes without wildcard", overrides: { scopes: JSON.stringify(SELF_SERVICE_KEY_SCOPES) } },
    { label: "object scopes", overrides: { scopes: '{"scopes":"*"}' } },
    { label: "null scopes value", overrides: { scopes: "null" } },
    { label: "boolean scopes value", overrides: { scopes: "true" } },
    { label: "empty scope list", overrides: { scopes: "[]" } },
  ] satisfies { label: string; overrides?: Partial<Insert> }[])("a $label kept id fails before any narrowing or revocation write", ({ overrides }) => {
    const store = open();
    seedCases(store);
    const live = insert(store, { metadata: null }).record;
    const keptId = overrides === undefined ? randomUUID() : insert(store, overrides).record.id;
    const before = snapshot(store);
    store.db.run(sql.raw("CREATE TRIGGER forbid_migration_write BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT, 'unexpected migration write'); END;"));
    expect(() => runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id], () => now, [keptId]))
      .toThrowError("wildcard key migration verification failed");
    expect(snapshot(store)).toBe(before);
  });

  it("an id in both keep and revoke lists fails before any row write", () => {
    const store = open();
    const fixtures = seedCases(store);
    const live = insert(store, { metadata: null }).record;
    const keptId = fixtures.candidates[0].id;
    const before = snapshot(store);
    store.db.run(sql.raw("CREATE TRIGGER forbid_migration_write BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT, 'unexpected migration write'); END;"));
    expect(() => runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id, keptId], () => now, [keptId]))
      .toThrowError("wildcard key migration verification failed");
    expect(snapshot(store)).toBe(before);
  });

  it.each(["extra", "missing", "substituted"])("an %s wildcard row violates the exact kept set and rolls back every row", (change) => {
    const store = open();
    const candidate = insert(store).record;
    const kept = insert(store).record;
    const unexpected = insert(store, { scopes: JSON.stringify(SELF_SERVICE_KEY_SCOPES) }).record;
    const live = insert(store, { metadata: null }).record;
    const effects = [
      ...(change === "missing" || change === "substituted" ? [`UPDATE api_keys SET scopes = '[]' WHERE id = '${kept.id}';`] : []),
      ...(change === "extra" || change === "substituted" ? [`UPDATE api_keys SET scopes = '["*"]' WHERE id = '${unexpected.id}';`] : []),
    ].join(" ");
    store.db.run(sql.raw(`CREATE TRIGGER change_remaining_wildcards AFTER UPDATE OF scopes ON api_keys WHEN OLD.id = '${candidate.id}' BEGIN ${effects} END;`));
    const before = snapshot(store);
    expect(() => runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id], () => now, [kept.id]))
      .toThrowError("wildcard key migration verification failed");
    expect(snapshot(store)).toBe(before);
  });

  it("a second run with the same keep-list changes no rows and preserves the kept count", () => {
    const store = open();
    const fixtures = seedCases(store);
    const live = insert(store, { metadata: null }).record;
    const keptIds = [fixtures.candidates[0].id];
    expect(runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id], () => now, keptIds))
      .toEqual({ narrowed: 3, revoked: 1, alreadyRevoked: 0, kept: 1 });
    const before = snapshot(store);
    expect(runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id], () => "2031-01-01T00:00:00.000Z", keptIds))
      .toEqual({ narrowed: 0, revoked: 0, alreadyRevoked: 1, kept: 1 });
    expect(snapshot(store)).toBe(before);
  });

  it("the transaction stores the supplied target scopes exactly", () => {
    const store = open();
    const { record } = insert(store);
    const target = ["read", ...SELF_SERVICE_KEY_SCOPES];
    expect(runWildcardKeyMigration(store, target, [], () => now)).toEqual({ narrowed: 1, revoked: 0, alreadyRevoked: 0, kept: 0 });
    expect(store.repos.apiKeys.findById(record.id)).toEqual({ ...record, scopes: JSON.stringify(target) });
  });

  it("explicit revocation changes only listed live rows and preserves prior revocation timestamps", () => {
    const store = open();
    const live = insert(store, { metadata: JSON.stringify({ source: "other" }) }).record;
    const revoked = insert(store, { revokedAt: earlier }).record;
    const unlisted = [
      insert(store, { scopes: JSON.stringify(SELF_SERVICE_KEY_SCOPES) }).record,
      insert(store, { metadata: null }).record,
    ];
    expect(runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id, revoked.id], () => now)).toEqual({ narrowed: 0, revoked: 1, alreadyRevoked: 1, kept: 0 });
    expect(store.repos.apiKeys.findById(live.id)).toEqual({ ...live, revokedAt: now });
    expect(store.repos.apiKeys.findById(revoked.id)).toEqual(revoked);
    for (const record of unlisted) expect(store.repos.apiKeys.findById(record.id)).toEqual(record);
  });

  it("apply trims full ids and drops empty revoke entries", () => {
    const store = open();
    const live = insert(store, { metadata: null }).record;
    const revoked = insert(store, { revokedAt: earlier }).record;
    gate("apply");
    vi.stubEnv("PCC_REVOKE_API_KEY_IDS", ` , ${live.id} , , ${revoked.id}, `);
    const started = Date.now();
    expect(applyWildcardKeyMigrationFromEnv(store)).toEqual({ narrowed: 0, revoked: 1, alreadyRevoked: 1, kept: 0 });
    const after = store.repos.apiKeys.findById(live.id)!;
    expect(after).toEqual({ ...live, revokedAt: after.revokedAt });
    expect(after.revokedAt).not.toBeNull();
    expect(Date.parse(after.revokedAt!)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(after.revokedAt!)).toBeLessThanOrEqual(Date.now());
    expect(store.repos.apiKeys.findById(revoked.id)).toEqual(revoked);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("[wildcard-key-migration] narrowed 0, revoked 1, already revoked 1, kept 0");
  });

  it("a missing listed row rolls back both narrowing and revocation", () => {
    const store = open();
    seedCases(store);
    const live = insert(store, { metadata: null }).record;
    const before = snapshot(store);
    let failure: unknown;
    try {
      runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id, randomUUID()], () => now);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("wildcard key migration verification failed");
    const counts = (failure as Error & { counts: Record<string, unknown> }).counts;
    expect(Object.values(counts).length).toBeGreaterThan(0);
    expect(Object.values(counts).every((value) => typeof value === "number")).toBe(true);
    expect(snapshot(store)).toBe(before);
  });

  it("an ignored scopes update rolls back every row in the transaction", () => {
    const store = open();
    const ignored = insert(store).record;
    insert(store);
    const live = insert(store, { metadata: null }).record;
    store.db.run(sql.raw(`CREATE TRIGGER ignore_scope_change BEFORE UPDATE OF scopes ON api_keys WHEN OLD.id = '${ignored.id}' BEGIN SELECT RAISE(IGNORE); END;`));
    const before = snapshot(store);
    expect(() => runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id], () => now)).toThrowError("wildcard key migration verification failed");
    expect(snapshot(store)).toBe(before);
  });

  it("an ignored revocation update rolls back narrowing and other revocations", () => {
    const store = open();
    insert(store);
    const ignored = insert(store, { metadata: null }).record;
    const live = insert(store, { metadata: null }).record;
    store.db.run(sql.raw(`CREATE TRIGGER ignore_revocation BEFORE UPDATE OF revoked_at ON api_keys WHEN OLD.id = '${ignored.id}' BEGIN SELECT RAISE(IGNORE); END;`));
    const before = snapshot(store);
    expect(() => runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [live.id, ignored.id], () => now)).toThrowError("wildcard key migration verification failed");
    expect(snapshot(store)).toBe(before);
  });

  it("a second run changes no rows and reports no new narrowing or revocation", () => {
    const store = open();
    seedCases(store);
    const live = insert(store, { metadata: null }).record;
    const revoked = insert(store, { revokedAt: earlier }).record;
    const ids = [live.id, revoked.id];
    expect(runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, ids, () => now)).toEqual({ narrowed: 4, revoked: 1, alreadyRevoked: 1, kept: 0 });
    const before = snapshot(store);
    expect(runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, ids, () => "2031-01-01T00:00:00.000Z")).toEqual({ narrowed: 0, revoked: 0, alreadyRevoked: 2, kept: 0 });
    expect(snapshot(store)).toBe(before);
  });

  it("narrowed credentials deny money and admin pairs while permitting a basic operator pair", async () => {
    const path = join(directory, "middleware.sqlite");
    vi.stubEnv("DATABASE_URL", path);
    vi.stubEnv("PCC_DB_PATH", path);
    const store = initStore({ seed: false });
    const credential = insert(store);
    runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, [], () => now);
    const money = SCOPE_COVERED_ROUTES.find((route) => route.class === "money-write")!;
    const admin = SCOPE_COVERED_ROUTES.find((route) => route.class === "admin" && route.url !== "/api/admin/feedback")!;
    const operator = SCOPE_COVERED_ROUTES.find((route) => route.class === "other-write" && route.requirement !== "money-default-deny" && route.requirement.includes("operator"))!;
    app = Fastify();
    app.decorateRequest("userId", null);
    app.decorateRequest("apiKeyId", null);
    app.decorateRequest("operatorId", null);
    await app.register(apiGate);
    await app.register(scopeChecker);
    for (const route of [money, admin, operator]) {
      app.route({ method: route.method, url: route.path, handler: async () => ({ reached: true }) });
    }
    await app.ready();
    for (const route of [money, admin, operator]) {
      const response = await app.inject({ method: route.method, url: route.url, headers: { authorization: `Bearer ${credential.rawKey}` } });
      expect(response.statusCode).toBe(route === operator ? 200 : 403);
      expect(response.json()).toMatchObject(route === operator ? { reached: true } : { error: "insufficient_scope", caller_scopes: [...SELF_SERVICE_KEY_SCOPES] });
    }
  });

  it("a missing key record yields an empty caller scope set", async () => {
    vi.stubEnv("DATABASE_URL", join(directory, "missing.sqlite"));
    initStore({ seed: false });
    const route = SCOPE_COVERED_ROUTES.find((entry) => entry.class === "admin" && entry.url !== "/api/admin/feedback")!;
    app = Fastify();
    app.decorateRequest("apiKeyId", null);
    app.addHook("onRequest", async (request) => { request.apiKeyId = randomUUID(); });
    await app.register(scopeChecker);
    app.route({ method: route.method, url: route.path, handler: async () => ({ reached: true }) });
    const response = await app.inject({ method: route.method, url: route.url });
    expect(response.statusCode).toBe(403);
    expect(response.json().caller_scopes).toEqual([]);
  });
});

describe("stored scopes preserve the gateway parser's accepted values", () => {
  it.each([
    { raw: JSON.stringify(["*"]), scopes: ["*"] },
    { raw: "*", scopes: ["*"] },
    { raw: JSON.stringify("read, *"), scopes: ["read", "*"] },
    { raw: " read, *, , ", scopes: ["read", "*"] },
    { raw: JSON.stringify(["read", 1, null, "*"]), scopes: ["read", "*"] },
    { raw: JSON.stringify(SELF_SERVICE_KEY_SCOPES), scopes: [...SELF_SERVICE_KEY_SCOPES] },
    { raw: "[]", scopes: [] },
    { raw: '{"scopes":true}', scopes: [] },
    { raw: "null", scopes: [] },
    { raw: "true", scopes: [] },
    { raw: "1", scopes: [] },
    { raw: "", scopes: [] },
    { raw: "   ", scopes: [] },
    { raw: undefined, scopes: [] },
    { raw: null, scopes: [] },
  ])("$raw yields only its parsed string scopes", ({ raw, scopes }) => {
    expect(parseStoredScopes(raw)).toEqual(scopes);
  });
});
