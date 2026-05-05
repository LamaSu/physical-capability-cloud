import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { apiGate } from "../middleware/api-gate.js";

describe("T1.5 — apiGate is non-encapsulated (sibling-scope hooks)", () => {
  it("encapsulated plugins do NOT propagate hooks to siblings (regression guard)", async () => {
    // Documenting Fastify's default behavior: a plugin without skip-override
    // keeps its hooks isolated to its own scope. If this test ever flips
    // Fastify changed semantics and we should reconsider the apiGate workaround.
    let hookFired = false;
    const app = Fastify({ logger: false });
    await app.register(async (innerApp) => {
      innerApp.addHook("onRequest", async () => {
        hookFired = true;
      });
    });
    app.get("/sibling", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/sibling" });
    expect(res.statusCode).toBe(200);
    expect(hookFired).toBe(false);
  });

  it("apiGate IS marked non-encapsulated (skip-override symbol set)", () => {
    // The gate plugin uses Symbol.for('skip-override') = true to opt out of
    // encapsulation. Without this, the auth hook never fires for sibling
    // route plugins — every /api/* route would be effectively public.
    expect((apiGate as any)[Symbol.for("skip-override")]).toBe(true);
  });

  it("apiGate's onRequest hook fires on sibling routes registered after it", async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const { initStore, closeStore } = await import("../db.js");
    initStore({ seed: true });
    try {
      const app = Fastify({ logger: false });
      await app.register(apiGate);
      // Register sibling route directly on the parent app (NOT inside apiGate).
      app.post("/api/test/protected", async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/api/test/protected",
        payload: {},
      });
      // If the hook didn't fire we'd get 200. With skip-override it fires
      // and rejects with 401.
      expect(res.statusCode).toBe(401);
      await app.close();
    } finally {
      closeStore();
    }
  });
});
