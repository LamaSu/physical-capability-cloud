/**
 * WP-A round 8 (astra authz r2: "check existing identities for collisions before
 * enabling the broader normalization policy"). findIdentityCollisions groups the
 * stored identities by normalizeIdentity. It flags as `newMerge` the groups whose
 * spellings were DISTINCT under master's comparison (trim + lowercase): those are
 * the principals the new normalization would join.
 * scripts/identity-collision-audit.mjs runs it before deploy.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { generateApiKey } from "../auth/api-key-auth.js";
import { findIdentityCollisions } from "../auth/identity-collisions.js";

let seq = 0;
function key(operatorId: string): void {
  const { keyHash, keyPrefix } = generateApiKey();
  getRepos().apiKeys.insert({
    id: `collide-${++seq}`,
    keyHash,
    keyPrefix,
    operatorId,
    scopes: JSON.stringify(["operator"]),
    rateLimit: "1000/hour",
    usageCount: "0",
    createdAt: new Date().toISOString(),
  } as never);
}

beforeAll(() => {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  key("Alice@X.test");
  key("alice@x.test"); // same under master (trim + lowercase): an existing merge, not a new one
  key("straße@x.test");
  key("STRASSE@x.test"); // distinct under master, one identity under case folding: NEW merge
  key("ｖｉｃｔｉｍ@x.test");
  key("victim@x.test"); // NFKC: NEW merge
  key("alıce@x.test"); // dotless i: its own identity, never merged with alice
  key("bob@x.test");
});

afterAll(() => closeStore());

describe("findIdentityCollisions", () => {
  it("groups spellings that normalize alike and flags the NEW merges", () => {
    const { collisions, read } = findIdentityCollisions((getStore().db as unknown as { $client: never }).$client);
    expect(read).toContain("api_keys.operator_id");
    const by = Object.fromEntries(collisions.map((c) => [c.spellings.join(" | "), c.newMerge]));
    expect(by).toEqual({
      "Alice@X.test | alice@x.test": false,
      "STRASSE@x.test | straße@x.test": true,
      "victim@x.test | ｖｉｃｔｉｍ@x.test": true,
    });
  });

  it("[neg] dotless i and unrelated identities are in no group", () => {
    const { collisions } = findIdentityCollisions((getStore().db as unknown as { $client: never }).$client);
    const all = collisions.flatMap((c) => c.spellings);
    expect(all).not.toContain("alıce@x.test");
    expect(all).not.toContain("bob@x.test");
  });
});
