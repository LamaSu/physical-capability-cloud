import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import {
  artifactsRoutes,
  _clearArtifactsForTests,
  _seedArtifactForTests,
} from "../routes/artifacts.js";
import { initStore, closeStore } from "../db.js";
import { DASHBOARD_CSD_URL, type UiArtifact } from "@pcc/spec";

// ───────────────────────────────────────────────────────────────────────────
// RF-1 — artifacts routes behind apiGate (the PRODUCTION mount).
//
// server.ts registers apiGate (the /api/* auth hook) BEFORE artifactsRoutes.
// The plain artifacts.test.ts mounts the routes on a BARE app with no gate, so
// anonymous GETs pass there and the gate's real effect is invisible — a true
// test-vs-prod divergence. This file closes that gap. It proves:
//   • GET discovery + GET recall of a public/unlisted artifact are PUBLIC (200)
//   • a PRIVATE artifact still 403s an anonymous caller on the now-public path
//     (making the read public must NOT leak private content)
//   • POST / PUT / fork stay Bearer-gated (401) — only GET reads went public
//
// resolveSession() (via apiGate) calls getRepos(), so the store must be live —
// mirror apigate-encapsulation.test.ts and initStore() a :memory: db.
// ───────────────────────────────────────────────────────────────────────────

const PREV_DB = process.env.PCC_DB_PATH;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  closeStore(); // drop any singleton a prior test file left behind
  initStore({ seed: false }); // apiGate → resolveSession() → getRepos() needs it
  app = Fastify({ logger: false });
  await app.register(apiGate); //         gate first …
  await app.register(artifactsRoutes); // … routes second (mirrors server.ts)
  await app.ready();
});

afterAll(async () => {
  await app.close();
  closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
});

beforeEach(() => {
  _clearArtifactsForTests();
});

/**
 * Seed a fully-formed artifact directly into the store, bypassing the POST
 * route (which is Bearer-gated under apiGate and can't be reached anonymously
 * in this bare-key test harness).
 */
function seed(overrides: Partial<UiArtifact> = {}): UiArtifact {
  const suffix = Math.random().toString(16).slice(2, 10);
  const now = new Date().toISOString();
  const a: UiArtifact = {
    id: `ua_${suffix}`,
    slug: `dash-${suffix}`,
    csd: DASHBOARD_CSD_URL,
    name: "Seeded dash",
    description: "seeded fixture",
    manifest: {
      csd: DASHBOARD_CSD_URL,
      title: "Seeded dash",
      theme: "auto",
      sections: [{ windows: [{ kind: "note", text: "hello" }] }],
    },
    capabilityTypes: ["pizza.order"],
    visibility: "public",
    owner: "op_owner",
    useCount: 0,
    loadCount: 0,
    forkCount: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
  _seedArtifactForTests(a);
  return a;
}

describe("RF-1 — artifacts behind apiGate: public reads, gated mutations", () => {
  it("anonymous GET /api/artifacts (discovery) is public → 200 and lists public artifacts", async () => {
    const pub = seed({ visibility: "public" });
    const res = await app.inject({ method: "GET", url: "/api/artifacts" });
    expect(res.statusCode).toBe(200);
    const ids = res.json().entries.map((e: { id: string }) => e.id);
    expect(ids).toContain(pub.id);
  });

  it("anonymous GET /api/artifacts/:slug (public recall) → 200", async () => {
    const a = seed({ visibility: "public" });
    const res = await app.inject({ method: "GET", url: `/api/artifacts/${a.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(a.id);
  });

  it("anonymous GET /api/artifacts/:slug (unlisted recall by slug) → 200", async () => {
    const a = seed({ visibility: "unlisted" });
    const res = await app.inject({ method: "GET", url: `/api/artifacts/${a.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(a.id);
  });

  it("anonymous GET of a PRIVATE artifact → 403, NOT 401 and NOT leaked", async () => {
    // The read path is public in apiGate, but the route's own visibility check
    // still runs: with no operatorId (gate skipped) and no Bearer, the caller
    // is anonymous, so a private artifact is refused. 403 forbidden — never a
    // 200 that would leak the manifest.
    const a = seed({ visibility: "private", owner: "op_secret" });
    const res = await app.inject({ method: "GET", url: `/api/artifacts/${a.id}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("anonymous POST /api/artifacts stays Bearer-gated → 401 (apiGate blocks)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: {
        name: "x",
        manifest: { csd: DASHBOARD_CSD_URL, title: "x", sections: [] },
      },
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous PUT /api/artifacts/:id stays Bearer-gated → 401 (apiGate blocks)", async () => {
    const a = seed({ visibility: "public" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/artifacts/${a.id}`,
      payload: { name: "renamed" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("anonymous POST /api/artifacts/:id/fork stays gated → 401 (single-segment regex never covers /fork)", async () => {
    const a = seed({ visibility: "public" });
    const res = await app.inject({
      method: "POST",
      url: `/api/artifacts/${a.id}/fork`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});
