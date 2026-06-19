/**
 * Courier-jobs tests — ports the v0.2 acceptance suite (37 local + 22 prod
 * tests in pcc-courier-jobs-service) into the gateway. Covers every route
 * in the surface mirror, the race-safe claim, source-verify, TTL sweep,
 * heartbeat sweep, PATCH/DELETE auth gating, and the filtered open feed.
 *
 * No external network: a stub verify fn is injected on the store so we
 * never hit httpbin.org. Time control is via the now() injector so the
 * sweeper can be triggered deterministically (no 70s waits).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { courierJobsRoutes } from "../routes/courier-jobs.js";
import {
  initCourierJobsStore,
  _resetCourierJobsStoreForTests,
  type VerifyFn,
} from "../services/courier-jobs-store.js";

// ── Time controller ────────────────────────────────────────────────────────

let mockNowMs = 0;
const now = () => new Date(mockNowMs);
const advance = (ms: number): void => { mockNowMs += ms; };

// ── Verify stub ────────────────────────────────────────────────────────────

let verifyResponses: Map<string, "ok" | "fail-404" | "fail-placed-false"> = new Map();
const stubVerify: VerifyFn = async (url) => {
  const r = verifyResponses.get(url) ?? "ok";
  if (r === "ok") return { ok: true, body: { ok: true } };
  if (r === "fail-404") {
    return { ok: false, reason: "http_non_2xx", status: 404, body: "Not Found" };
  }
  return {
    ok: false,
    reason: "source_says_not_real",
    status: 200,
    body: { placed: false },
  };
};

// ── Test app — courier routes only, no apiGate (we trust X-Posted-By) ──────

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(courierJobsRoutes);
  await app.ready();
  return app;
}

// ── Setup / teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  _resetCourierJobsStoreForTests();
  mockNowMs = Date.parse("2026-06-19T00:00:00.000Z");
  verifyResponses = new Map();
  initCourierJobsStore({ verify: stubVerify, now });
});

afterEach(() => {
  _resetCourierJobsStoreForTests();
});

// ── Healthz ────────────────────────────────────────────────────────────────

describe("GET /api/courier-jobs/healthz", () => {
  it("returns ok=true with counter snapshot", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/courier-jobs/healthz" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.service).toContain("courier-jobs");
      expect(body.jobs).toBe(0);
      expect(body.open).toBe(0);
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/courier-jobs — create ────────────────────────────────────────

describe("POST /api/courier-jobs", () => {
  it("creates an open job and returns 201 + verified=false on plain post", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs",
        headers: { "x-posted-by": "tester" },
        payload: {
          deliveryId: "job-plain",
          pickup: { name: "A" },
          dropoff: { name: "B" },
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.id).toBe("job-plain");
      expect(body.status).toBe("open");
      expect(body.verified).toBe(false);
      expect(body.validUntil).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("returns 400 with required fields when body is missing pickup/dropoff/deliveryId", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs",
        payload: { deliveryId: "job-bad" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("missing_fields");
      expect(body.required).toEqual(["deliveryId", "pickup", "dropoff"]);
    } finally {
      await app.close();
    }
  });

  it("verified=true when sourceVerifyUrl returns 2xx", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs",
        headers: { "x-posted-by": "tester" },
        payload: {
          deliveryId: "job-verified",
          pickup: { name: "A", lat: 37.77, lng: -122.42 },
          dropoff: { name: "B" },
          sourceVerifyUrl: "https://example.com/order",
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().verified).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 400 source_verify_failed when sourceVerifyUrl returns 404", async () => {
    verifyResponses.set("https://example.com/missing", "fail-404");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs",
        payload: {
          deliveryId: "job-404",
          pickup: { name: "A" },
          dropoff: { name: "B" },
          sourceVerifyUrl: "https://example.com/missing",
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("source_verify_failed");
      expect(body.reason).toBe("http_non_2xx");
      expect(body.sourceStatus).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 400 source_verify_failed when source returns placed:false", async () => {
    verifyResponses.set("https://example.com/fake", "fail-placed-false");
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/courier-jobs",
        payload: {
          deliveryId: "job-fake",
          pickup: { name: "A" },
          dropoff: { name: "B" },
          sourceVerifyUrl: "https://example.com/fake",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().reason).toBe("source_says_not_real");
    } finally {
      await app.close();
    }
  });

  it("returns 200 + note=already posted when the same id is posted twice", async () => {
    const app = await buildApp();
    try {
      const payload = {
        deliveryId: "job-dup",
        pickup: { name: "A" },
        dropoff: { name: "B" },
      };
      await app.inject({ method: "POST", url: "/api/courier-jobs", payload });
      const res2 = await app.inject({ method: "POST", url: "/api/courier-jobs", payload });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().note).toBe("already posted");
    } finally {
      await app.close();
    }
  });
});

// ── GET /api/courier-jobs/open — feed ──────────────────────────────────────

describe("GET /api/courier-jobs/open", () => {
  it("returns only open jobs sorted by postedAt desc", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j1", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      advance(1000);
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j2", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({ method: "GET", url: "/api/courier-jobs/open" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(2);
      expect(body.jobs[0].id).toBe("j2");
      expect(body.jobs[1].id).toBe("j1");
    } finally {
      await app.close();
    }
  });

  it("?verified=true filters to verified jobs only", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j-plain", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: {
          deliveryId: "j-verified",
          pickup: { name: "A" },
          dropoff: { name: "B" },
          sourceVerifyUrl: "https://example.com/order",
        },
      });
      const res = await app.inject({
        method: "GET", url: "/api/courier-jobs/open?verified=true",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.count).toBe(1);
      expect(body.jobs[0].id).toBe("j-verified");
    } finally {
      await app.close();
    }
  });

  it("?minFeeUSD / ?maxFeeUSD filter by fee range", async () => {
    const app = await buildApp();
    try {
      const mk = async (id: string, fee: number) => app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: id, pickup: { name: "A" }, dropoff: { name: "B" }, feeUSD: fee },
      });
      await mk("low", 3); await mk("mid", 7); await mk("high", 15);
      const r1 = await app.inject({ method: "GET", url: "/api/courier-jobs/open?minFeeUSD=5" });
      expect(r1.json().jobs.map((j: { id: string }) => j.id).sort()).toEqual(["high", "mid"]);
      const r2 = await app.inject({ method: "GET", url: "/api/courier-jobs/open?maxFeeUSD=10" });
      expect(r2.json().jobs.map((j: { id: string }) => j.id).sort()).toEqual(["low", "mid"]);
      const r3 = await app.inject({
        method: "GET", url: "/api/courier-jobs/open?minFeeUSD=5&maxFeeUSD=10",
      });
      expect(r3.json().jobs.map((j: { id: string }) => j.id)).toEqual(["mid"]);
    } finally {
      await app.close();
    }
  });

  it("?within=lat,lng,miles filters by haversine pickup distance", async () => {
    const app = await buildApp();
    try {
      // SF
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: {
          deliveryId: "sf",
          pickup: { name: "SF", lat: 37.7749, lng: -122.4194 },
          dropoff: { name: "B" },
        },
      });
      // NYC (~2570 mi from SF)
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: {
          deliveryId: "nyc",
          pickup: { name: "NYC", lat: 40.7128, lng: -74.006 },
          dropoff: { name: "B" },
        },
      });
      const sfRes = await app.inject({
        method: "GET", url: "/api/courier-jobs/open?within=37.77,-122.42,50",
      });
      const ids = sfRes.json().jobs.map((j: { id: string }) => j.id);
      expect(ids).toContain("sf");
      expect(ids).not.toContain("nyc");
    } finally {
      await app.close();
    }
  });
});

// ── GET /api/courier-jobs/:id ──────────────────────────────────────────────

describe("GET /api/courier-jobs/:id", () => {
  it("returns the job + events", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "id1", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({ method: "GET", url: "/api/courier-jobs/id1" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.job.id).toBe("id1");
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events[0].event).toBe("posted");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for unknown id", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/courier-jobs/nope" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/courier-jobs/:id/claim — race-safe ───────────────────────────

describe("POST /api/courier-jobs/:id/claim", () => {
  it("claims an open job and returns ok+job", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j-claim", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "POST", url: "/api/courier-jobs/j-claim/claim",
        payload: { driverAgent: "driver-7" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.job.claimedBy).toBe("driver-7");
      expect(body.job.status).toBe("claimed");
    } finally {
      await app.close();
    }
  });

  it("returns 400 when driverAgent missing", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j-mc", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "POST", url: "/api/courier-jobs/j-mc/claim", payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_field");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for unknown job", async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST", url: "/api/courier-jobs/missing/claim",
        payload: { driverAgent: "d1" },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("race-safe: 10 concurrent claims yield exactly 1 winner and 9 × 409", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "race", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const claims = Array.from({ length: 10 }, (_, i) => app.inject({
        method: "POST", url: "/api/courier-jobs/race/claim",
        payload: { driverAgent: `driver-${i}` },
      }));
      const results = await Promise.all(claims);
      const wins = results.filter((r) => r.statusCode === 200);
      const losses = results.filter((r) => r.statusCode === 409);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(9);
      const winnerBody = wins[0]!.json();
      const winnerName = winnerBody.job.claimedBy;
      for (const l of losses) {
        const lb = l.json();
        expect(lb.error).toBe("not_open");
        expect(lb.claimedBy).toBe(winnerName);
      }
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/courier-jobs/:id/events ──────────────────────────────────────

describe("POST /api/courier-jobs/:id/events", () => {
  it("pickup → status=in_transit, delivered → status=delivered", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j-ev", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const r1 = await app.inject({
        method: "POST", url: "/api/courier-jobs/j-ev/events",
        payload: { event: "pickup", driverAgent: "d1" },
      });
      expect(r1.statusCode).toBe(200);
      expect(r1.json().status).toBe("in_transit");
      const r2 = await app.inject({
        method: "POST", url: "/api/courier-jobs/j-ev/events",
        payload: { event: "delivered", driverAgent: "d1" },
      });
      expect(r2.statusCode).toBe(200);
      expect(r2.json().status).toBe("delivered");
    } finally {
      await app.close();
    }
  });

  it("returns 400 invalid_event for unsupported event types", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "j-ev2", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "POST", url: "/api/courier-jobs/j-ev2/events",
        payload: { event: "lasered" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_event");
    } finally {
      await app.close();
    }
  });
});

// ── PATCH /api/courier-jobs/:id — ownership ────────────────────────────────

describe("PATCH /api/courier-jobs/:id", () => {
  it("patches fee + description with matching X-Posted-By", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        headers: { "x-posted-by": "alice" },
        payload: { deliveryId: "p1", pickup: { name: "A" }, dropoff: { name: "B" }, feeUSD: 5 },
      });
      const res = await app.inject({
        method: "PATCH", url: "/api/courier-jobs/p1",
        headers: { "x-posted-by": "alice" },
        payload: { feeUSD: 8.5, description: "patched" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.job.feeUSD).toBe(8.5);
      expect(body.job.description).toBe("patched");
    } finally {
      await app.close();
    }
  });

  it("returns 403 when poster identity does not match", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        headers: { "x-posted-by": "alice" },
        payload: { deliveryId: "p2", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "PATCH", url: "/api/courier-jobs/p2",
        headers: { "x-posted-by": "mallory" },
        payload: { feeUSD: 999 },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("forbidden");
    } finally {
      await app.close();
    }
  });

  it("returns 401 missing_identity when no auth header at all", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        headers: { "x-posted-by": "alice" },
        payload: { deliveryId: "p3", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "PATCH", url: "/api/courier-jobs/p3", payload: { feeUSD: 99 },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("missing_identity");
    } finally {
      await app.close();
    }
  });
});

// ── DELETE /api/courier-jobs/:id ───────────────────────────────────────────

describe("DELETE /api/courier-jobs/:id", () => {
  it("cancels a job + writes deleted_by_poster event", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        headers: { "x-posted-by": "alice" },
        payload: { deliveryId: "d1", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "DELETE", url: "/api/courier-jobs/d1",
        headers: { "x-posted-by": "alice" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("cancelled");
      const got = await app.inject({ method: "GET", url: "/api/courier-jobs/d1" });
      const events = got.json().events as Array<{ event: string }>;
      expect(events.some((e) => e.event === "deleted_by_poster")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 403 when poster identity does not match", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        headers: { "x-posted-by": "alice" },
        payload: { deliveryId: "d2", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      const res = await app.inject({
        method: "DELETE", url: "/api/courier-jobs/d2",
        headers: { "x-posted-by": "mallory" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

// ── POST /api/courier-jobs/:id/heartbeat ───────────────────────────────────

describe("POST /api/courier-jobs/:id/heartbeat", () => {
  it("updates lastHeartbeatAt", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        headers: { "x-posted-by": "alice" },
        payload: {
          deliveryId: "hb1",
          pickup: { name: "A" },
          dropoff: { name: "B" },
          requireHeartbeat: true,
        },
      });
      advance(1000);
      const res = await app.inject({
        method: "POST", url: "/api/courier-jobs/hb1/heartbeat",
        headers: { "x-posted-by": "alice" }, payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().lastHeartbeatAt).toBeDefined();
    } finally {
      await app.close();
    }
  });
});

// ── Background sweeper — TTL + heartbeat + re-verify ───────────────────────

describe("background sweep", () => {
  it("expires past-TTL jobs and removes them from /open", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: { deliveryId: "ttl", pickup: { name: "A" }, dropoff: { name: "B" } },
      });
      // Default TTL = postedAt + 2h. Advance past it.
      advance(3 * 60 * 60 * 1000);
      const store = (await import("../services/courier-jobs-store.js")).getCourierJobsStore();
      const result = await store.sweep();
      expect(result.expired).toBe(1);
      const list = await app.inject({ method: "GET", url: "/api/courier-jobs/open" });
      expect(list.json().count).toBe(0);
      const got = await app.inject({ method: "GET", url: "/api/courier-jobs/ttl" });
      expect(got.json().job.status).toBe("expired");
    } finally {
      await app.close();
    }
  });

  it("auto-cancels jobs whose sourceVerifyUrl starts failing after post", async () => {
    verifyResponses.set("https://src/order", "ok");
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: {
          deliveryId: "rv",
          pickup: { name: "A" },
          dropoff: { name: "B" },
          sourceVerifyUrl: "https://src/order",
        },
      });
      // Flip the source to fail and advance past the early re-verify window
      verifyResponses.set("https://src/order", "fail-404");
      advance(2 * 60 * 1000);
      const store = (await import("../services/courier-jobs-store.js")).getCourierJobsStore();
      const result = await store.sweep();
      expect(result.autoCancelled).toBe(1);
      const got = await app.inject({ method: "GET", url: "/api/courier-jobs/rv" });
      expect(got.json().job.status).toBe("cancelled");
    } finally {
      await app.close();
    }
  });

  it("expires requireHeartbeat=true jobs when heartbeat stops landing", async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: "POST", url: "/api/courier-jobs",
        payload: {
          deliveryId: "hb-lost",
          pickup: { name: "A" },
          dropoff: { name: "B" },
          requireHeartbeat: true,
        },
      });
      // Heartbeat grace = 5min; advance past it
      advance(6 * 60 * 1000);
      const store = (await import("../services/courier-jobs-store.js")).getCourierJobsStore();
      const result = await store.sweep();
      expect(result.expired).toBe(1);
      const got = await app.inject({ method: "GET", url: "/api/courier-jobs/hb-lost" });
      expect(got.json().job.status).toBe("expired");
    } finally {
      await app.close();
    }
  });
});
