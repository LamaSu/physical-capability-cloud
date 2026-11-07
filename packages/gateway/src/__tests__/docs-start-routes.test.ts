/**
 * Tests for the public /docs and /start pages.
 *
 * /docs/whitepaper must serve the published whitepaper, the /docs handoff must
 * give an agent the agent-package prompt, and /start must not link npm pages
 * for packages that are not published. We register only the two route
 * plugins against a bare Fastify so the test stays fast.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { docRoutes } from "../routes/docs.js";
import { startRoutes } from "../routes/start.js";

describe("docRoutes and startRoutes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(docRoutes);
    await app.register(startRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves the published whitepaper at /docs/whitepaper", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/whitepaper?format=md" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("**Version**: 3.0");
  });

  it("renders /docs/whitepaper as HTML", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/whitepaper" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("links the agent golden path and agent-package prompt from /docs", async () => {
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("fetch('/snippet.md')");
    expect(res.body).toContain('href="/agent-package.json"');
    expect(res.body).toContain('href="/.well-known/agent.md"');
    expect(res.body).not.toContain("/docs/agent-guide");
  });

  it.each([
    "/docs/agent-guide",
    "/docs/agent-guide?format=md",
    "/docs/agent-guide?format=html",
    "/docs/agent-guide?format=anything",
  ])("permanently redirects %s to the agent golden path", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe("/.well-known/agent.md");
  });

  it("links no npm page from /start for an unpublished package", async () => {
    const res = await app.inject({ method: "GET", url: "/start" });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("npmjs.com/package/@pcc/");
  });
});
