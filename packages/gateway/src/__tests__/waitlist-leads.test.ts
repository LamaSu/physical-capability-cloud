/**
 * WP-A round 5 (coord-watch #2883): the public waitlist is a bounded write.
 *
 * - A known leadId used to bypass the per-IP limiter entirely (waitlist.ts:22), so
 *   one valid email plus a chosen leadId gave unlimited appended writes.
 * - Anyone who knew a lead's id could rewrite its merged record (coalesced by
 *   leadId, last value wins).
 * Now a lead's record is keyed by leadId plus a server-issued leadToken, updates
 * with a token this process issued draw on a per-lead budget, and every other
 * request counts against the per-IP window.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh temp dir wherever the runner's tmpdir is (CI runners cannot write the Spark's paths).
const DIR = mkdtempSync(join(tmpdir(), "pcc-waitlist-test-"));
process.env.PCC_DB_PATH = `${DIR}/pcc.sqlite`;
process.env.PCC_ADMIN_KEY = "waitlist-test-admin-key"; // the admin secret gates the exports (round 7, AG-9)

let app: FastifyInstance;
let reset: () => void;
let ipSeq = 0;

beforeAll(async () => {
  const mod = await import("../routes/waitlist.js");
  reset = mod._resetWaitlistStateForTests;
  app = Fastify({ logger: false });
  await app.register(mod.waitlistRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => reset());

const post = (payload: Record<string, unknown>, ip = "203.0.113.10") =>
  app.inject({ method: "POST", url: "/api/waitlist", payload, remoteAddress: ip });
const exportAll = async () =>
  (await app.inject({ method: "GET", url: "/api/admin/waitlist", headers: { "x-admin-key": "waitlist-test-admin-key" } })).json()
    .items as Array<Record<string, unknown>>;

describe("waitlist leads", () => {
  it("[neg] knowing another lead's id does not let a stranger change its record", async () => {
    const ip = `198.51.100.${++ipSeq}`;
    const first = await post({ email: "victim@x.test", leadId: "lead-victim-1", name: "Victim" }, ip);
    expect(first.statusCode).toBe(200);

    const forged = await post({ email: "mallory@x.test", leadId: "lead-victim-1", name: "Mallory" }, "192.0.2.66");
    expect(forged.statusCode).toBe(200);

    const items = await exportAll();
    const victim = items.find((r) => r.leadId === "lead-victim-1" && r.email === "victim@x.test");
    expect(victim).toMatchObject({ name: "Victim", email: "victim@x.test" });
    expect(items.filter((r) => r.leadId === "lead-victim-1")).toHaveLength(2); // the stranger's write is its own record
    expect(typeof first.json().leadToken).toBe("string");
  });

  it("the lead's own token continues its record", async () => {
    const ip = `198.51.100.${++ipSeq}`;
    const first = await post({ email: "owner@x.test", leadId: "lead-owner-1" }, ip);
    const leadToken = first.json().leadToken as string;
    const next = await post({ email: "owner@x.test", leadId: "lead-owner-1", leadToken, company: "Owner Co" }, ip);
    expect(next.statusCode).toBe(200);
    const mine = (await exportAll()).filter((r) => r.leadId === "lead-owner-1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ email: "owner@x.test", company: "Owner Co" });
  });

  it("[neg] a known leadId no longer bypasses the per-IP limit, nor do invented tokens", async () => {
    const ip = `198.51.100.${++ipSeq}`;
    const statuses: number[] = [];
    for (let i = 0; i < 81; i += 1) statuses.push((await post({ email: "flood@x.test", leadId: "lead-flood" }, ip)).statusCode);
    expect(statuses.slice(0, 80).every((s) => s === 200)).toBe(true);
    expect(statuses[80]).toBe(429);

    const ip2 = `198.51.100.${++ipSeq}`;
    let last = 0;
    for (let i = 0; i < 81; i += 1) {
      last = (await post({ email: "flood2@x.test", leadId: "lead-flood-2", leadToken: `invented-token-${String(i).padStart(4, "0")}` }, ip2)).statusCode;
    }
    expect(last).toBe(429);
  });

  it("[neg] updates with the issued token draw on the lead's own budget (20), then 429", async () => {
    const ip = `198.51.100.${++ipSeq}`;
    const leadToken = (await post({ email: "steps@x.test", leadId: "lead-steps" }, ip)).json().leadToken as string;
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      statuses.push((await post({ email: "steps@x.test", leadId: "lead-steps", leadToken, name: `step ${i}` }, ip)).statusCode);
    }
    expect(statuses.slice(0, 19).every((s) => s === 200)).toBe(true);
    expect(statuses[19]).toBe(429);
  });

  it("[neg] a write does not force a count rebuild; the count catches up within 30 s (round 7, AG-23)", async () => {
    // Alternating a write with a count used to force a full read and coalesce of both
    // files every time. Now the count is rebuilt at most once per 30 s.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
      const count = async () => (await app.inject({ method: "GET", url: "/api/waitlist/count" })).json().count as number;
      const before = await count();
      await post({ email: "counted@x.test", leadId: "lead-counted" }, `198.51.100.${++ipSeq}`);
      expect(await count()).toBe(before); // cached: the write did not invalidate it
      vi.setSystemTime(new Date("2026-09-28T12:00:31Z"));
      expect(await count()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a lead's budget starts at its first recorded save, whoever made its token (astra, pack 53: NEW-3 / new defect 1)", () => {
  it("[neg] a page-made token: after its first save, the lead's updates draw on the LEAD's budget, not the exhausted per-IP window", async () => {
    const ip = "198.51.100.177";
    // 79 other signups from the same (NAT'd) address: the per-IP window (80) is one short of full.
    for (let i = 0; i < 79; i += 1) {
      const r = await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: `crowd${i}@x.test`, leadId: `lead-crowd-${i}` }, remoteAddress: ip });
      expect(r.statusCode).toBe(200);
    }
    const token = "a1b2c3d4e5f60718293a4b5c6d7e8f901234"; // made by the page (36 hex characters)
    const first = await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: "dee@x.test", leadId: "lead-dee", leadToken: token }, remoteAddress: ip });
    expect(first.statusCode).toBe(200); // the 80th request: the window is now full
    const next = await app.inject({
      method: "POST",
      url: "/api/waitlist",
      payload: { email: "dee@x.test", leadId: "lead-dee", leadToken: token, name: "Dee" },
      remoteAddress: ip,
    });
    expect(next.statusCode).toBe(200);
  });

  it("control: a stranger's NEW lead from the same address is still limited by the full per-IP window", async () => {
    const ip = "198.51.100.178";
    for (let i = 0; i < 80; i += 1) {
      await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: `busy${i}@x.test`, leadId: `lead-busy-${i}` }, remoteAddress: ip });
    }
    const fresh = await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: "new@x.test", leadId: "lead-new", leadToken: "ffffeeeeddddccccbbbbaaaa999988887777" }, remoteAddress: ip });
    expect(fresh.statusCode).toBe(429);
  });
});

