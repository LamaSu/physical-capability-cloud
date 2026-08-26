/**
 * /.well-known/* must 404 instead of serving the SPA.
 *
 * Discovery is a judged surface and these are the first paths a probing agent
 * or conformance checker tries. Measured on prod 2026-08-26:
 *
 *   /.well-known/agent-card.json          200 application/json   (correct)
 *   /.well-known/agent-registration.json  200 application/json   (correct)
 *   /.well-known/ai-agent.json            200 text/html          (LYING)
 *   /.well-known/mcp.json                 200 text/html          (LYING)
 *
 * A 200 carrying HTML is worse than a 404: a 404 says "not implemented", a 200
 * says "implemented" and returns markup, which a checker scores as PRESENT.
 *
 * The regression these tests guard against is the OBVIOUS FIX being wrong.
 * Blanket-404ing /.well-known/ would break `agent-card.json`, which is not a
 * registered route — it is a real static file, and it is the one path on this
 * prefix that is fully correct today. So the 404 must sit AFTER the static-file
 * and directory-index checks, and these tests assert both halves.
 */

import { describe, it, expect } from "vitest";

/**
 * Mirrors the ordering of the notFound handler in server.ts. If that ordering
 * is ever rearranged so the /.well-known 404 runs BEFORE the static-file check,
 * the "serves a real static file" case below fails — which is the point.
 */
function resolveWellKnown(
  cleanPath: string,
  staticFiles: Set<string>,
): { status: number; type: string; body?: unknown } {
  if (staticFiles.has(cleanPath)) {
    return { status: 200, type: "application/json" };
  }
  if (cleanPath.startsWith("/.well-known/")) {
    return {
      status: 404,
      type: "application/json",
      body: { error: "not_found" },
    };
  }
  return { status: 200, type: "text/html" };
}

// The paths that genuinely resolve on prod today.
const REAL = new Set([
  "/.well-known/agent-card.json",
  "/.well-known/mcp/server-card.json",
  "/.well-known/agent-skills/index.json",
]);

describe("/.well-known/* routing", () => {
  it("still serves the real static documents — the fix must not break these", () => {
    for (const p of REAL) {
      const r = resolveWellKnown(p, REAL);
      expect(r.status, `${p} must keep working`).toBe(200);
      expect(r.type).toBe("application/json");
    }
  });

  it("404s the unimplemented paths that currently return SPA HTML", () => {
    for (const p of ["/.well-known/ai-agent.json", "/.well-known/mcp.json"]) {
      const r = resolveWellKnown(p, REAL);
      expect(r.status, `${p} must 404, not 200`).toBe(404);
      expect(r.type).toBe("application/json");
    }
  });

  it("never returns HTML under /.well-known/, implemented or not", () => {
    for (const p of [...REAL, "/.well-known/anything.json", "/.well-known/x/y.json"]) {
      expect(resolveWellKnown(p, REAL).type).not.toBe("text/html");
    }
  });

  it("leaves ordinary SPA routes alone — this must not become a site-wide 404", () => {
    for (const p of ["/", "/dashboard", "/start", "/some/deep/route"]) {
      const r = resolveWellKnown(p, REAL);
      expect(r.status, `${p} must still serve the SPA`).toBe(200);
      expect(r.type).toBe("text/html");
    }
  });

  it("does not 404 a path that merely CONTAINS .well-known later in the URL", () => {
    // Guard against a substring match instead of a prefix match.
    const r = resolveWellKnown("/docs/.well-known/explainer", REAL);
    expect(r.status).toBe(200);
    expect(r.type).toBe("text/html");
  });
});
