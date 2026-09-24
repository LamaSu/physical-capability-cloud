/**
 * The operator read routes must never invent data (product invariant: never silently
 * substitute plausible values for missing real data).
 *
 * These four routes used to return hard-coded machines, certifications and maintenance
 * rows, and RANDOM daily earnings, while the public agent package advertised them as an
 * operator's earnings. They now answer 501 `not_available` with pointers to the reads
 * that are real. The operator policy read no longer turns a failed read into the defaults.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { operatorRoutes } from "../routes/operator.js";
import { initStore, closeStore } from "../db.js";

const UNAVAILABLE = [
  "/api/operator/machines",
  "/api/operator/earnings",
  "/api/operator/earnings?period=7d",
  "/api/operator/certifications",
  "/api/operator/maintenance",
];

describe("operator read routes: no fabricated data", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    await app.register(operatorRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  for (const url of UNAVAILABLE) {
    it(`${url} answers 501 not_available, never invented rows`, async () => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(501);
      const body = res.json();
      expect(body.error).toBe("not_available");
      expect(body.message).toMatch(/not recorded/);
      expect(Array.isArray(body.see)).toBe(true);
      // NEGATIVE: none of the old fabricated fields come back.
      for (const k of ["machines", "earnings", "total", "certifications", "events"]) {
        expect(body, k).not.toHaveProperty(k);
      }
    });
  }

  it("NEGATIVE: earnings are deterministic (the old route returned new random numbers per call)", async () => {
    const a = await app.inject({ method: "GET", url: "/api/operator/earnings?period=30d" });
    const b = await app.inject({ method: "GET", url: "/api/operator/earnings?period=30d" });
    expect(a.body).toBe(b.body);
    expect(a.body).not.toMatch(/"(earnings|cumulative|total)"\s*:\s*\d/);
  });

  it("points the caller at the reads that are real", async () => {
    expect((await app.inject({ method: "GET", url: "/api/operator/machines" })).json().see).toContain("/api/agent/me");
    expect((await app.inject({ method: "GET", url: "/api/operator/earnings" })).json().see).toContain("/api/jobs/:jobId/execution");
  });

  it("operator policy: no saved row reads as the defaults, labeled default", async () => {
    const res = await app.inject({ method: "GET", url: "/api/operator/policy/kernel-with-no-policy" });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("default");
  });

  it("NEGATIVE: operator policy: a failed read is 503, never the defaults", async () => {
    closeStore(); // every store read now throws
    try {
      const res = await app.inject({ method: "GET", url: "/api/operator/policy/kernel-nyc" });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("read_failed");
      expect(res.json()).not.toHaveProperty("policy");
    } finally {
      initStore({ seed: true });
    }
  });
});

describe("operator.ts source ratchet", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../routes/operator.ts"), "utf-8");

  it("NEGATIVE: holds no mock arrays and no random VALUES (random id suffixes are fine)", () => {
    expect(src).not.toMatch(/\bconst mock[A-Z]/);
    // Math.random() is allowed only as an id suffix: Math.random().toString(36)
    expect(src).not.toMatch(/Math\.random\(\)(?!\.toString\(36\))/);
  });
});
