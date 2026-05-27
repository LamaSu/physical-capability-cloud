/**
 * JSON-source fetch + validate tests.
 *
 * Uses an injected fetchImpl so tests don't depend on the network.
 */

import { describe, it, expect } from "vitest";
import {
  fetchJsonDirectory,
  parseDirectoryJson,
} from "../src/json-source.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __tests__ -> bridge-directory -> packages -> repo root -> apps/dashboard/public/bridges.json
const BRIDGES_JSON_PATH = resolve(
  __dirname,
  "../../../apps/dashboard/public/bridges.json",
);

const goodDirectory = {
  name: "Test Directory",
  timestamp: "2026-05-27T00:00:00Z",
  version: { major: 0, minor: 1, patch: 0 },
  bridges: [
    {
      namespace: "test",
      name: "Test Bridge",
      repoUrl: "https://example.com/test",
      maintainerAddress: "0x0000000000000000000000000000000000000001",
      adapterPackage: "@pcc/test",
      version: "0.1.0",
      status: "experimental" as const,
    },
  ],
};

function mockFetch(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return async () =>
    ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: "OK",
      json: async () => body,
    }) as unknown as Response;
}

describe("parseDirectoryJson (pure)", () => {
  it("parses a valid directory", () => {
    const out = parseDirectoryJson(goodDirectory);
    expect(out.bridges[0]!.namespace).toBe("test");
  });

  it("throws with structured error info on invalid input", () => {
    expect(() =>
      parseDirectoryJson({
        ...goodDirectory,
        bridges: [{ ...goodDirectory.bridges[0]!, namespace: "BAD" }],
      }),
    ).toThrow(/schema validation failed/);
  });
});

describe("fetchJsonDirectory (with injected fetch)", () => {
  it("fetches and parses a valid response", async () => {
    const dir = await fetchJsonDirectory({
      jsonUrl: "https://test.invalid/bridges.json",
      fetchImpl: mockFetch(goodDirectory),
    });
    expect(dir.name).toBe("Test Directory");
    expect(dir.bridges).toHaveLength(1);
  });

  it("throws on non-2xx response", async () => {
    await expect(
      fetchJsonDirectory({
        jsonUrl: "https://test.invalid/bridges.json",
        fetchImpl: mockFetch(null, { ok: false, status: 404 }),
      }),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws on invalid JSON body", async () => {
    const badFetch = async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => {
          throw new Error("Unexpected token");
        },
      }) as unknown as Response;
    await expect(
      fetchJsonDirectory({
        jsonUrl: "https://test.invalid/bridges.json",
        fetchImpl: badFetch,
      }),
    ).rejects.toThrow(/did not return valid JSON/);
  });

  it("throws on schema-invalid body", async () => {
    await expect(
      fetchJsonDirectory({
        jsonUrl: "https://test.invalid/bridges.json",
        fetchImpl: mockFetch({ random: "garbage" }),
      }),
    ).rejects.toThrow(/schema validation failed/);
  });
});

describe("bridges.json (apps/dashboard/public)", () => {
  it("validates against the schema", () => {
    const raw = JSON.parse(readFileSync(BRIDGES_JSON_PATH, "utf-8"));
    const out = parseDirectoryJson(raw);
    expect(out.name).toBe("PCC Bridge Directory");
    expect(out.bridges.length).toBeGreaterThanOrEqual(3);
  });

  it("includes the three seed bridges (hamilton, trilobio, pylabrobot)", () => {
    const raw = JSON.parse(readFileSync(BRIDGES_JSON_PATH, "utf-8"));
    const dir = parseDirectoryJson(raw);
    const namespaces = dir.bridges.map((b) => b.namespace).sort();
    expect(namespaces).toContain("hamilton");
    expect(namespaces).toContain("trilobio");
    expect(namespaces).toContain("pylabrobot");
  });

  it("all maintainer addresses are syntactically valid (even if zero)", () => {
    const raw = JSON.parse(readFileSync(BRIDGES_JSON_PATH, "utf-8"));
    const dir = parseDirectoryJson(raw);
    for (const b of dir.bridges) {
      expect(b.maintainerAddress).toMatch(/^0x[a-f0-9]{40}$/);
    }
  });
});
