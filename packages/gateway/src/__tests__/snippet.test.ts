/**
 * Tests for the static onboarding-snippet routes (owner ask #178).
 *
 * Three endpoints, all unauthenticated:
 *   GET /snippet.md           — text/markdown body
 *   GET /onboard/snippet      — alias
 *   GET /onboard/snippet.json — JSON wrapper
 *
 * We register only `snippetRoutes` against a bare Fastify so the test is
 * fast and doesn't drag the gateway's full plugin tree along.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { snippetRoutes, SNIPPET_BODY, SNIPPET_VERSION } from "../routes/snippet.js";

describe("snippetRoutes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(snippetRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /snippet.md", () => {
    it("returns the markdown body", async () => {
      const res = await app.inject({ method: "GET", url: "/snippet.md" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("capability.network");
      expect(res.body).toContain("agent-package.json");
      expect(res.body).toContain("system_prompt");
    });

    it("sets text/markdown content-type", async () => {
      const res = await app.inject({ method: "GET", url: "/snippet.md" });
      expect(res.headers["content-type"]).toContain("text/markdown");
    });

    it("sets a permissive CORS header", async () => {
      const res = await app.inject({ method: "GET", url: "/snippet.md" });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("includes the version header", async () => {
      const res = await app.inject({ method: "GET", url: "/snippet.md" });
      expect(res.headers["x-pcc-snippet-version"]).toBe(SNIPPET_VERSION);
    });

    it("is cacheable (max-age)", async () => {
      const res = await app.inject({ method: "GET", url: "/snippet.md" });
      const cc = String(res.headers["cache-control"] ?? "");
      expect(cc).toMatch(/max-age=\d+/);
    });
  });

  describe("GET /onboard/snippet", () => {
    it("returns the same body as /snippet.md", async () => {
      const a = await app.inject({ method: "GET", url: "/snippet.md" });
      const b = await app.inject({ method: "GET", url: "/onboard/snippet" });
      expect(b.statusCode).toBe(200);
      expect(b.body).toBe(a.body);
    });
  });

  describe("GET /onboard/snippet.json", () => {
    it("returns a JSON envelope", async () => {
      const res = await app.inject({ method: "GET", url: "/onboard/snippet.json" });
      expect(res.statusCode).toBe(200);
      const json = res.json() as Record<string, unknown>;
      expect(json.version).toBe(SNIPPET_VERSION);
      expect(json.gateway).toBe("https://capability.network");
      expect(json.body).toBe(SNIPPET_BODY);
      expect(json.npx).toBe("npx @pcc/onboard");
    });

    it("sets CORS to *", async () => {
      const res = await app.inject({ method: "GET", url: "/onboard/snippet.json" });
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });
  });

  describe("SNIPPET_BODY contents", () => {
    it("primes a tool-using LLM to drive the chat", () => {
      expect(SNIPPET_BODY.toLowerCase()).toMatch(/buy|offer|connect|register/);
    });

    it("tells the host LLM how to call endpoints", () => {
      expect(SNIPPET_BODY).toContain("endpoint");
      expect(SNIPPET_BODY).toMatch(/POST|GET/);
    });

    it("references the actual production gateway", () => {
      expect(SNIPPET_BODY).toContain("https://capability.network");
    });
  });
});
