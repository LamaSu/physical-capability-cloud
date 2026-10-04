/**
 * The operator read routes must never invent data (product invariant: never silently
 * substitute plausible values for missing real data).
 *
 * These four routes used to return hard-coded machines, certifications and maintenance
 * rows, and RANDOM daily earnings, while the public agent package advertised them as an
 * operator's earnings. They now answer 501 `not_available` with pointers to the reads
 * that are real. The operator policy read no longer turns a failed read into the defaults.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { schema, eq } from "@pcc/store";
import { operatorRoutes } from "../routes/operator.js";
import { initStore, closeStore, getStore } from "../db.js";

// N31 (#6278): the operator write routes now need operator authority. These tests check body
// validation, read honesty and decision semantics, not authority (n31-operator-route-ownership
// does that), so the gateway admin secret stands in for the operator here.
const N31_ADMIN = "n31-test-admin-secret";
const ADMIN_HEADERS = { "x-admin-key": N31_ADMIN };
const PREV_ADMIN_KEY = process.env.PCC_ADMIN_KEY;
process.env.PCC_ADMIN_KEY = N31_ADMIN;
afterAll(() => {
  if (PREV_ADMIN_KEY === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN_KEY;
});

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
      // Certifications' wording is deliberately different from the other three: registration
      // DOES record a certification claim, so its 501 says there is no VERIFIED read rather
      // than "not recorded" (verdict rm-n32-362-r2-7fccd046, M2).
      if (url === "/api/operator/certifications") {
        expect(body.message).toMatch(/no verified operator-certification read/);
      } else {
        expect(body.message).toMatch(/not recorded/);
      }
      expect(Array.isArray(body.see)).toBe(true);
      // Narrow check for these five named fixtures only, not a general fabrication guard
      // (verdict rm-n32-362-r2-7fccd046, L1): it would miss a differently named or shaped
      // leak. The 501/not_available assertions above are the real, behavioral protection.
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
    const res = await app.inject({ method: "GET", url: "/api/operator/policy/kernel-with-no-policy", headers: ADMIN_HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("default");
  });

  it("NEGATIVE: operator policy: a failed read is 503, never the defaults", async () => {
    closeStore(); // every store read now throws
    try {
      const res = await app.inject({ method: "GET", url: "/api/operator/policy/kernel-nyc", headers: ADMIN_HEADERS });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("read_failed");
      expect(res.json()).not.toHaveProperty("policy");
    } finally {
      initStore({ seed: true });
    }
  });
});

/**
 * Operator approvals: a failed read, an omitted field and a repeated decision are each
 * reported as what they are, never as a plausible answer. From the cross-family review of
 * PR #362 (verdict rm-n32-362-r1-d30de649):
 *   M1  a failed read answers 503, never an empty list that hides recorded approvals
 *   M2  an omitted capabilityType is stored as unknown, never as an invented type
 *   M3  approve/reject that change nothing answer 409 already_decided, never a success
 */
describe("operator approvals: no silent substitution", () => {
  let app: FastifyInstance;
  const KERNEL = "kernel-nyc"; // seeded

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

  async function submit(payload: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      headers: ADMIN_HEADERS,
      url: "/api/operator/approvals",
      payload: { kernelId: KERNEL, agentId: "agent-test", capabilityType: "fdm", ...payload },
    });
    expect(res.statusCode).toBe(200);
    return res.json().approval as { id: string; status: string };
  }

  /** The row as stored, bypassing the routes. */
  function storedRow(id: string) {
    return getStore().db.select().from(schema.pendingApprovals).where(eq(schema.pendingApprovals.id, id)).get();
  }

  describe("M1 GET /api/operator/approvals", () => {
    it("lists what is recorded, and a real empty result is still an empty list", async () => {
      const a = await submit();
      const all = await app.inject({ method: "GET", url: "/api/operator/approvals", headers: ADMIN_HEADERS });
      expect(all.statusCode).toBe(200);
      expect(all.json().approvals.map((r: { id: string }) => r.id)).toContain(a.id);

      // Nothing recorded for this kernel: absence is a truthful 200 with an empty list.
      const none = await app.inject({ method: "GET", url: "/api/operator/approvals?kernelId=kernel-with-no-approvals", headers: ADMIN_HEADERS });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toEqual({ approvals: [] });
    });

    it("NEGATIVE: M1 a failed read is 503 read_failed, never an empty list", async () => {
      await submit(); // a recorded approval the outage must not hide
      closeStore(); // every store read now throws, as in the operator policy test
      try {
        const res = await app.inject({ method: "GET", url: "/api/operator/approvals", headers: ADMIN_HEADERS });
        expect(res.statusCode).toBe(503);
        expect(res.json().error).toBe("read_failed");
        expect(res.json()).not.toHaveProperty("approvals");
      } finally {
        initStore({ seed: true });
      }
    });

    it("NEGATIVE: a repeated query parameter is a 400 client error, never a failed read", async () => {
    for (const url of ["/api/operator/approvals?status=pending&status=approved", "/api/operator/approvals?kernelId=a&kernelId=b"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toBe("invalid_query");
    }
  });

  it("NEGATIVE: M1 a throwing .all() is 503 for every filter combination", async () => {
      const { db } = getStore();
      const boom = () => {
        throw new Error("SQLITE_IOERR: disk I/O error");
      };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, { from: () => chain, where: () => chain, all: boom });
      const spy = vi.spyOn(db, "select").mockImplementation((() => chain) as never);
      try {
        for (const q of ["", "?kernelId=kernel-nyc", "?status=pending", "?kernelId=kernel-nyc&status=pending"]) {
          const res = await app.inject({ method: "GET", url: `/api/operator/approvals${q}`, headers: ADMIN_HEADERS });
          expect(res.statusCode, `GET approvals${q}`).toBe(503);
          expect(res.json().error, `GET approvals${q}`).toBe("read_failed");
          expect(res.json(), `GET approvals${q}`).not.toHaveProperty("approvals");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("M2 POST /api/operator/approvals: capabilityType", () => {
    it("NEGATIVE: M2 an omitted capabilityType is stored as unknown, never as an invented liquid-handler", async () => {
      // Only kernelId and agentId: the caller asserted no capability type.
      const res = await app.inject({
        method: "POST",
        headers: ADMIN_HEADERS,
        url: "/api/operator/approvals",
        payload: { kernelId: KERNEL, agentId: "agent-no-type" },
      });
      expect(res.statusCode).toBe(200);
      const { approval } = res.json();

      // Returned.
      expect(approval.jobSummary).not.toHaveProperty("capabilityType");
      expect(JSON.stringify(approval)).not.toContain("liquid-handler");

      // Stored.
      const stored = storedRow(approval.id);
      expect(stored?.jobSummary).not.toHaveProperty("capabilityType");
      expect(JSON.stringify(stored)).not.toContain("liquid-handler");

      // Listed.
      const listed = (await app.inject({ method: "GET", url: `/api/operator/approvals?kernelId=${KERNEL}`, headers: ADMIN_HEADERS }))
        .json()
        .approvals.find((r: { id: string }) => r.id === approval.id);
      expect(listed.jobSummary).not.toHaveProperty("capabilityType");
    });

    it("keeps a capabilityType the caller sent, including an explicit liquid-handler", async () => {
      for (const capabilityType of ["fdm", "liquid-handler"]) {
        const a = await submit({ capabilityType });
        expect(storedRow(a.id)?.jobSummary).toMatchObject({ capabilityType });
      }
    });
  });

  describe("M3 approve and reject: a decision that changed nothing is not a success", () => {
    const decide = (id: string, action: "approve" | "reject", payload?: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        headers: ADMIN_HEADERS,
        url: `/api/operator/approvals/${id}/${action}`,
        ...(payload ? { payload } : {}),
      });

    it("NEGATIVE: M3 approving twice: the first approves, the second is 409 already_decided and decides nothing", async () => {
      const a = await submit();
      const first = await decide(a.id, "approve");
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ approved: true, approval: { id: a.id, status: "approved" } });
      const decidedAt = storedRow(a.id)?.decidedAt;
      expect(decidedAt).toBeTruthy();

      const second = await decide(a.id, "approve");
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: "already_decided", status: "approved" });
      // It must not claim that THIS request decided it.
      expect(second.json()).not.toHaveProperty("approved");
      expect(second.json()).not.toHaveProperty("rejected");
      // And it changed nothing.
      expect(storedRow(a.id)).toMatchObject({ status: "approved", decidedAt });
    });

    it("NEGATIVE: M3 rejecting twice: the first rejects, the second is 409 already_decided and keeps the first reason", async () => {
      const a = await submit();
      const first = await decide(a.id, "reject", { reason: "first reason" });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        rejected: true,
        approval: { id: a.id, status: "rejected", rejectionReason: "first reason" },
      });

      const second = await decide(a.id, "reject", { reason: "second reason" });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: "already_decided", status: "rejected" });
      expect(second.json()).not.toHaveProperty("rejected");
      expect(second.json()).not.toHaveProperty("approved");
      expect(storedRow(a.id)).toMatchObject({ status: "rejected", rejectionReason: "first reason" });
    });

    it("NEGATIVE: M3 rejecting after approving is 409 already_decided with status approved", async () => {
      const a = await submit();
      expect((await decide(a.id, "approve")).statusCode).toBe(200);

      const res = await decide(a.id, "reject", { reason: "changed my mind" });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "already_decided", status: "approved" });
      expect(res.json()).not.toHaveProperty("rejected");
      expect(storedRow(a.id)).toMatchObject({ status: "approved", rejectionReason: null });
    });

    it("NEGATIVE: M3 approving after rejecting is 409 already_decided with status rejected", async () => {
      const a = await submit();
      expect((await decide(a.id, "reject", { reason: "no" })).statusCode).toBe(200);

      const res = await decide(a.id, "approve");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "already_decided", status: "rejected" });
      expect(res.json()).not.toHaveProperty("approved");
      expect(storedRow(a.id)).toMatchObject({ status: "rejected", rejectionReason: "no" });
    });

    it("NEGATIVE: M3 an approval created with autoApprove was decided at creation: a later approve or reject is 409", async () => {
      const a = await submit({ autoApprove: true });
      expect(a.status).toBe("approved");

      const approve = await decide(a.id, "approve");
      expect(approve.statusCode).toBe(409);
      expect(approve.json()).toMatchObject({ error: "already_decided", status: "approved" });
      expect(approve.json()).not.toHaveProperty("approved");

      const reject = await decide(a.id, "reject");
      expect(reject.statusCode).toBe(409);
      expect(reject.json()).toMatchObject({ error: "already_decided", status: "approved" });
    });

    it("an approval that does not exist keeps the existing 404 answer for both routes", async () => {
      for (const action of ["approve", "reject"] as const) {
        const res = await decide("approval-does-not-exist", action);
        expect(res.statusCode, action).toBe(404);
        expect(res.json(), action).toEqual({ error: "Approval not found" });
      }
    });
  });
});

describe("operator.ts source ratchet", () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../routes/operator.ts"), "utf-8");

  // Narrow, source-text check for these exact fixture/API names only (verdict
  // rm-n32-362-r2-7fccd046, L1): it misses a differently named mock const, an imported
  // fixture, a `let` declaration, or any random API besides Math.random(). It is not a
  // general fabrication guard; the behavioral contract tests above are the real protection.
  it("NEGATIVE: holds no mock arrays and no random VALUES (random id suffixes are fine)", () => {
    expect(src).not.toMatch(/\bconst mock[A-Z]/);
    // Math.random() is allowed only as an id suffix: Math.random().toString(36)
    expect(src).not.toMatch(/Math\.random\(\)(?!\.toString\(36\))/);
  });
});
