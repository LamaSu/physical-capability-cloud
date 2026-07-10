import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactsRoutes, _clearArtifactsForTests } from "../routes/artifacts.js";
import { closeStore } from "../db.js";

const DASHBOARD_CSD_URL = "pcc://artifacts/dashboard/v1";

// Two distinct callers. resolveCaller() derives a stable owner id from the
// Bearer token when there's no api_keys table (the bare-app test harness), so
// different tokens are different owners.
const ALICE = { authorization: "Bearer key-alice" };
const BOB = { authorization: "Bearer key-bob" };

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(artifactsRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearArtifactsForTests();
});

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    csd: DASHBOARD_CSD_URL,
    title: "Watch my pizza",
    description: "Live order status",
    theme: "auto",
    sections: [
      {
        heading: "Status",
        windows: [
          { kind: "note", text: "Your order is on the way." },
          {
            kind: "metric",
            label: "ETA (min)",
            binding: { path: "/api/jobs/job-1", select: "job.etaMinutes" },
            format: "int",
          },
          {
            kind: "run",
            binding: { path: "/api/jobs/job-1", sse: "/sse/stream/job/job-1", pollMs: 30000 },
            statusFrom: "job.status",
            latestFrom: "job.events.0",
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function save(
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = ALICE,
) {
  return app.inject({
    method: "POST",
    url: "/api/artifacts",
    headers,
    payload: {
      name: "Watch my pizza",
      capabilityTypes: ["pizza.order"],
      manifest: validManifest(),
      visibility: "public",
      ...overrides,
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// POST /api/artifacts — save / publish
// ───────────────────────────────────────────────────────────────────────────

describe("POST /api/artifacts", () => {
  it("saves an artifact (201) with minted id/slug, owner, counts, version", async () => {
    const res = await save();
    expect(res.statusCode).toBe(201);
    const a = res.json();
    expect(a.id).toMatch(/^ua_/);
    expect(a.slug).toMatch(/^watch-my-pizza-/);
    expect(a.csd).toBe(DASHBOARD_CSD_URL);
    expect(a.owner).toBeTruthy();
    expect(a.useCount).toBe(0);
    expect(a.loadCount).toBe(0);
    expect(a.forkCount).toBe(0);
    expect(a.version).toBe(1);
    expect(a.status).toBe("active");
    expect(a.capabilityTypes).toEqual(["pizza.order"]);
  });

  it("defaults visibility to 'unlisted' when omitted (§5.4)", async () => {
    const res = await save({ visibility: undefined });
    expect(res.statusCode).toBe(201);
    expect(res.json().visibility).toBe("unlisted");
  });

  it("rejects a missing Bearer (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { name: "x", manifest: validManifest() },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  });

  it("rejects an invalid manifest (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: ALICE,
      payload: { name: "x", manifest: { csd: DASHBOARD_CSD_URL, title: "", sections: [] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Key-refusal (acceptance #2) — a key ANYWHERE in the manifest → 400
// ───────────────────────────────────────────────────────────────────────────

describe("no-key refuse", () => {
  it("rejects a manifest whose note text contains a pcc_live_ key (400)", async () => {
    const manifest = validManifest({
      sections: [
        { windows: [{ kind: "note", text: "my key is pcc_live_abc123 keep it safe" }] },
      ],
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: ALICE,
      payload: { name: "leaky", manifest },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects a pcc_test_ key hidden in api_base (400)", async () => {
    const manifest = validManifest({ api_base: "https://x/pcc_test_deadbeef" });
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: ALICE,
      payload: { name: "leaky2", manifest },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts an otherwise-identical manifest with no key (201)", async () => {
    const res = await save({ name: "clean" });
    expect(res.statusCode).toBe(201);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/artifacts/:idOrSlug — recall
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/artifacts/:idOrSlug", () => {
  it("recalls by id and by slug, and increments loadCount", async () => {
    const created = (await save()).json();

    const byId = await app.inject({ method: "GET", url: `/api/artifacts/${created.id}` });
    expect(byId.statusCode).toBe(200);
    expect(byId.json().id).toBe(created.id);
    expect(byId.json().loadCount).toBe(1);

    const bySlug = await app.inject({ method: "GET", url: `/api/artifacts/${created.slug}` });
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json().loadCount).toBe(2);
  });

  it("404s an unknown id/slug", async () => {
    const res = await app.inject({ method: "GET", url: "/api/artifacts/ua_nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Visibility auth (acceptance #8)
// ───────────────────────────────────────────────────────────────────────────

describe("visibility", () => {
  it("private: 403 for a non-owner, 200 for the owner", async () => {
    const created = (await save({ visibility: "private" }, ALICE)).json();

    const asBob = await app.inject({
      method: "GET",
      url: `/api/artifacts/${created.id}`,
      headers: BOB,
    });
    expect(asBob.statusCode).toBe(403);
    expect(asBob.json().error).toBe("forbidden");

    const asAlice = await app.inject({
      method: "GET",
      url: `/api/artifacts/${created.id}`,
      headers: ALICE,
    });
    expect(asAlice.statusCode).toBe(200);
  });

  it("unlisted: loads by slug for anyone, but is absent from the public listing", async () => {
    const created = (await save({ visibility: "unlisted" })).json();

    const bySlug = await app.inject({ method: "GET", url: `/api/artifacts/${created.slug}` });
    expect(bySlug.statusCode).toBe(200);

    const listing = await app.inject({ method: "GET", url: "/api/artifacts" });
    const ids = listing.json().entries.map((e: { id: string }) => e.id);
    expect(ids).not.toContain(created.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /api/artifacts — discovery (filter + sort)
// ───────────────────────────────────────────────────────────────────────────

describe("GET /api/artifacts (discovery)", () => {
  it("filters by capabilityType and lists only public artifacts", async () => {
    await save({ name: "pizza dash", capabilityTypes: ["pizza.order"] });
    await save({ name: "courier dash", capabilityTypes: ["courier.dispatch"] });
    await save({ name: "hidden", capabilityTypes: ["pizza.order"], visibility: "unlisted" });

    const res = await app.inject({
      method: "GET",
      url: "/api/artifacts?capabilityType=pizza.order",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1); // the unlisted pizza one is excluded
    expect(body.entries[0].name).toBe("pizza dash");
  });

  it("sort=popular ranks by usage (use+load+fork)", async () => {
    const quiet = (await save({ name: "quiet" })).json();
    const busy = (await save({ name: "busy" })).json();
    // Drive up the busy one's loadCount via reads.
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: `/api/artifacts/${busy.slug}` });
    }
    const res = await app.inject({ method: "GET", url: "/api/artifacts?sort=popular" });
    const entries = res.json().entries;
    expect(entries[0].id).toBe(busy.id);
    expect(entries[1].id).toBe(quiet.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fork lineage
// ───────────────────────────────────────────────────────────────────────────

describe("POST /api/artifacts/:id/fork", () => {
  it("forks with lineage and bumps the source forkCount", async () => {
    const src = (await save({ name: "original" }, ALICE)).json();

    const res = await app.inject({
      method: "POST",
      url: `/api/artifacts/${src.id}/fork`,
      headers: BOB,
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const fork = res.json();
    expect(fork.id).not.toBe(src.id);
    expect(fork.forkOf).toBe(src.id);
    expect(fork.owner).not.toBe(src.owner); // BOB, not ALICE
    expect(fork.forkCount).toBe(0);
    expect(fork.manifest.title).toBe(src.manifest.title); // manifest inherited

    const after = (await app.inject({ method: "GET", url: `/api/artifacts/${src.id}` })).json();
    expect(after.forkCount).toBe(1);
  });

  it("cannot fork a private artifact you do not own (403)", async () => {
    const src = (await save({ visibility: "private" }, ALICE)).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/artifacts/${src.id}/fork`,
      headers: BOB,
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PUT / DELETE — owner gating
// ───────────────────────────────────────────────────────────────────────────

describe("PUT /api/artifacts/:id", () => {
  it("owner modify bumps version; non-owner is 403", async () => {
    const a = (await save({ name: "editable" }, ALICE)).json();

    const owner = await app.inject({
      method: "PUT",
      url: `/api/artifacts/${a.id}`,
      headers: ALICE,
      payload: { name: "renamed" },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json().name).toBe("renamed");
    expect(owner.json().version).toBe(2);

    const stranger = await app.inject({
      method: "PUT",
      url: `/api/artifacts/${a.id}`,
      headers: BOB,
      payload: { name: "hijack" },
    });
    expect(stranger.statusCode).toBe(403);
  });
});

describe("DELETE /api/artifacts/:id", () => {
  it("owner soft-retires; the artifact then 404s and is unlisted", async () => {
    const a = (await save({ name: "temp" }, ALICE)).json();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/${a.id}`,
      headers: ALICE,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().retired).toBe(true);

    const gone = await app.inject({ method: "GET", url: `/api/artifacts/${a.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it("rejects a non-owner (403)", async () => {
    const a = (await save({ name: "temp2" }, ALICE)).json();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/artifacts/${a.id}`,
      headers: BOB,
    });
    expect(res.statusCode).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /a/:slug — the render shell
// ───────────────────────────────────────────────────────────────────────────

describe("GET /a/:slug — render shell", () => {
  it("serves CSP-compliant HTML: same-origin kit script + inlined manifest JSON", async () => {
    const a = (await save({ name: "shell test" })).json();
    const res = await app.inject({ method: "GET", url: `/a/${a.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain('<script src="/ui-kit/v1/pcc-ui.js"');
    expect(html).toContain('<script type="application/json" id="pcc-manifest">');
    expect(html).toContain("Watch my pizza"); // title rendered
    expect(html).toContain("Loading the PCC dashboard kit"); // graceful placeholder
    expect(html).not.toContain("innerHTML");
  });

  it("escapes hostile manifest content — no script breakout (XSS-safe)", async () => {
    const manifest = validManifest({
      sections: [
        { windows: [{ kind: "note", text: "</script><script>window.__pwned=1</script>" }] },
      ],
    });
    const a = (await save({ name: "xss", manifest })).json();
    const res = await app.inject({ method: "GET", url: `/a/${a.slug}` });
    expect(res.statusCode).toBe(200);
    // The hostile </script><script> must be neutralised (< escaped to <
    // inside the JSON data block), never emitted as a live script element.
    expect(res.body).not.toContain("<script>window.__pwned");
    expect(res.body).toContain("\\u003c/script");
  });

  it("private dashboard: 403 HTML for a non-owner", async () => {
    const a = (await save({ visibility: "private" }, ALICE)).json();
    const res = await app.inject({ method: "GET", url: `/a/${a.slug}`, headers: BOB });
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("404 HTML for an unknown slug", async () => {
    const res = await app.inject({ method: "GET", url: "/a/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Durability (acceptance #1 — the CSD-gap test): persists across a store
// restart. Runs LAST and manages its own file-backed store lifecycle.
// ───────────────────────────────────────────────────────────────────────────

describe("durability across a store restart", () => {
  it("an artifact saved to SQLite survives closing and re-opening the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pcc-artifacts-"));
    const dbPath = join(dir, "pcc.sqlite");
    const prev = process.env.PCC_DB_PATH;
    process.env.PCC_DB_PATH = dbPath;
    closeStore(); // drop any in-memory singleton from earlier tests

    try {
      // Phase 1 — create in a file-backed store, then "redeploy" (close).
      const appA = Fastify({ logger: false });
      await appA.register(artifactsRoutes);
      await appA.ready();
      const created = (
        await appA.inject({
          method: "POST",
          url: "/api/artifacts",
          headers: ALICE,
          payload: { name: "Durable dash", manifest: validManifest(), visibility: "public" },
        })
      ).json();
      expect(created.id).toMatch(/^ua_/);
      await appA.close();
      closeStore(); // simulate gateway shutdown — close the SQLite connection

      // Phase 2 — fresh store from the SAME file. The artifact is still there.
      const appB = Fastify({ logger: false });
      await appB.register(artifactsRoutes);
      await appB.ready();
      const got = await appB.inject({ method: "GET", url: `/api/artifacts/${created.slug}` });
      expect(got.statusCode).toBe(200);
      expect(got.json().id).toBe(created.id);
      await appB.close();
    } finally {
      closeStore();
      if (prev === undefined) delete process.env.PCC_DB_PATH;
      else process.env.PCC_DB_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
