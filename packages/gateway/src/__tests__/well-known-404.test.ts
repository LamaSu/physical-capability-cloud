/**
 * /.well-known/* must 404 instead of serving the SPA.
 *
 * Measured on prod 2026-08-26:
 *   /.well-known/agent-card.json          200 application/json   (correct)
 *   /.well-known/agent-registration.json  200 application/json   (correct)
 *   /.well-known/ai-agent.json            200 text/html          (LYING)
 *   /.well-known/mcp.json                 200 text/html          (LYING)
 * plus relay 5dcb6641's negative control: an INVENTED path returned 200 too.
 *
 * A 200 carrying HTML is worse than a 404: a 404 says "not implemented", a 200
 * says "implemented" and returns markup, which a conformance checker scores as
 * PRESENT.
 *
 * WHY THIS FILE IMPORTS THE REAL DECISION RATHER THAN RESTATING IT:
 * the first version of these tests MIRRORED the handler's logic in a local
 * helper. Every test passed — and would have passed identically if server.ts
 * had never been touched, because the mirror was self-consistent. That is
 * exactly the "a proxy satisfiable without the property" failure class escrow
 * catalogued in coord #1219, reproduced in a test written to guard against it.
 * The negative control that catches it: "what would this look like if the fix
 * were absent?" — the answer was "the same". So the decision now lives in
 * routes/well-known.ts, server.ts calls it, and this file imports THAT.
 *
 * What these tests do NOT prove, stated plainly: that server.ts invokes the
 * decision at the right POINT in setNotFoundHandler — i.e. after the static-file
 * and directory-index checks. That ordering is what keeps agent-card.json alive,
 * and it is verified by curling prod after deploy, not here.
 */

import { describe, it, expect } from "vitest";
import {
  unimplementedWellKnownBody,
  PUBLISHED_WELL_KNOWN,
} from "../routes/well-known.js";

describe("unimplementedWellKnownBody — the real decision used by server.ts", () => {
  it("returns a 404 body for an unimplemented /.well-known path", () => {
    for (const p of ["/.well-known/ai-agent.json", "/.well-known/mcp.json"]) {
      const body = unimplementedWellKnownBody(p);
      expect(body, `${p} must produce a 404 body`).not.toBeNull();
      expect(body!.error).toBe("not_found");
      expect(body!.message).toContain(p);
    }
  });

  it("returns a 404 body for an INVENTED path — relay 5dcb6641's negative control", () => {
    // The request that proved the catch-all: a path that cannot possibly exist.
    const body = unimplementedWellKnownBody(
      "/.well-known/zzz-definitely-not-a-real-path-5dcb",
    );
    expect(body).not.toBeNull();
  });

  it("returns null for ordinary SPA routes — this must not become a site-wide 404", () => {
    for (const p of ["/", "/dashboard", "/start", "/some/deep/route"]) {
      expect(unimplementedWellKnownBody(p), `${p} must fall through`).toBeNull();
    }
  });

  it("matches on PREFIX, not substring", () => {
    // /docs/.well-known/explainer contains the string but is not on the prefix.
    expect(unimplementedWellKnownBody("/docs/.well-known/explainer")).toBeNull();
    expect(unimplementedWellKnownBody("/x/.well-known/y")).toBeNull();
  });

  it("hands a probing agent the paths that DO resolve", () => {
    // A dead discovery path should still leave the client better off than an
    // HTML page did — this is the part that may matter most for scoring.
    const body = unimplementedWellKnownBody("/.well-known/anything.json");
    expect(body!.available).toEqual([...PUBLISHED_WELL_KNOWN]);
    expect(body!.available).toContain("/.well-known/agent-card.json");
    // The MCP surface IS discoverable, just not at the conventional path.
    expect(body!.available).toContain("/.well-known/mcp/server-card.json");
  });

  it("lists only absolute /.well-known paths, no ellipses or placeholders", () => {
    for (const p of PUBLISHED_WELL_KNOWN) {
      expect(p.startsWith("/.well-known/")).toBe(true);
      expect(p).not.toContain("...");
    }
  });
});

describe("the paths the fix must NOT break", () => {
  it("agent-card.json is on the published list — it is a static file, not a route", () => {
    // Blanket-404ing the prefix would kill the one path that is fully correct
    // today. It is a real 10,837-byte A2A card served from the dashboard build,
    // NOT a registered route, so it reaches setNotFoundHandler and is rescued by
    // the static-file check BEFORE the 404 decision runs.
    expect([...PUBLISHED_WELL_KNOWN]).toContain("/.well-known/agent-card.json");
  });

  it("the decision itself is order-independent and pure", () => {
    // It cannot know whether a static file exists — that is the caller's job,
    // and calling it too early is the failure mode. Same input, same output.
    const a = unimplementedWellKnownBody("/.well-known/agent-card.json");
    const b = unimplementedWellKnownBody("/.well-known/agent-card.json");
    expect(a).toEqual(b);
    // NOTE: it DOES return a body for agent-card.json. That is correct and is
    // why call-site ORDER is load-bearing: server.ts must only consult this
    // after the static file has had its chance.
    expect(a).not.toBeNull();
  });
});
