/**
 * WP-A repair R6: the DLP redactor reads a key's scopes exactly as the
 * scope-checker does (JSON array of strings only), and a legacy "*" is NOT
 * admin.
 *
 * The redactor had its own parse: `"*"` mapped to every role, admin included —
 * i.e. the fully unredacted view (contradicting A1: the wildcard is not admin
 * authority) — and a malformed `scopes` column fell back to a CSV split, so a
 * bare `admin` string also unlocked the admin view (contradicting the H3
 * fail-closed parse). It is inert in production today only because
 * dlpRedactor is registered encapsulated (its onSend hook reaches no sibling
 * route); these tests register the hook and the route in ONE context so they
 * exercise it as it would behave once de-encapsulated.
 */

import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

let keyScopes: string;

vi.mock("../db.js", () => ({
  getRepos: () => ({
    governance: {
      findAllDlpRules: () => [],
      findAllEndpointScopes: () => [],
    },
    apiKeys: { findById: () => ({ id: "key-1", scopes: keyScopes }) },
  }),
}));

const { dlpRedactor } = await import("../middleware/dlp-redactor.js");

const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const KERNEL = {
  id: "k1",
  operatorAddress: ADDRESS,
  physicalAddress: "1 Secret Street",
  keyHash: "deadbeefcafebabe0011223344556677",
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { apiKeyId?: string }).apiKeyId = "key-1";
  });
  // Hook and route in the SAME encapsulation context, so the onSend hook runs.
  await app.register(async (inst) => {
    await dlpRedactor(inst);
    inst.get("/api/kernels/k1", async () => KERNEL);
  });
  await app.ready();
  return app;
}

async function fetchKernel(scopes: string): Promise<Record<string, unknown>> {
  keyScopes = scopes;
  const app = await buildApp();
  try {
    const res = await app.inject({ method: "GET", url: "/api/kernels/k1" });
    expect(res.statusCode).toBe(200);
    return res.json() as Record<string, unknown>;
  } finally {
    await app.close();
  }
}

/** The fully redacted view: address masked, physical address removed, hash masked. */
function expectRedacted(body: Record<string, unknown>): void {
  expect(body.operatorAddress).toBe("0x****5678");
  expect(body.physicalAddress).toBeUndefined();
  expect(body.keyHash).not.toBe(KERNEL.keyHash);
}

describe("R6 — the DLP redactor: \"*\" is not admin", () => {
  it("a legacy wildcard key gets the REDACTED view, not the admin view", async () => {
    expectRedacted(await fetchKernel(JSON.stringify(["*"])));
  });

  it("an explicit admin key still sees everything (control)", async () => {
    expect(await fetchKernel(JSON.stringify(["admin"]))).toEqual(KERNEL);
  });

  it("an explicit operator key sees operator fields, but not the admin-only key hash (control)", async () => {
    const body = await fetchKernel(JSON.stringify(["operator"]));
    expect(body.operatorAddress).toBe(ADDRESS);
    expect(body.physicalAddress).toBe(KERNEL.physicalAddress);
    expect(body.keyHash).not.toBe(KERNEL.keyHash);
  });
});

describe("R6 — the DLP redactor parses scopes like getCallerScopes (fail closed)", () => {
  it.each([
    ["a bare string (no JSON)", "admin"],
    ["a CSV string", "operator,admin"],
    ["a JSON string, not an array", JSON.stringify("admin")],
    ["a MIXED array", JSON.stringify([42, "admin"])],
    ["a JSON object", JSON.stringify({ admin: true })],
  ])("%s grants no role: the redacted view", async (_label, scopes) => {
    expectRedacted(await fetchKernel(scopes));
  });
});
