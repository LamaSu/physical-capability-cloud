/**
 * WP-A round 7 (wpa-326-admingates-r2-astra, "weakest link: incomplete resource
 * bounds on the anonymous write surfaces"):
 *   - AG-20, AG-24 and new defect 1: the limiters bounded the NUMBER of keys but
 *     appended a timestamp for EVERY request, refused ones included, so one key's
 *     list grew without limit. Now a key holds at most `limit` timestamps, and a
 *     refused request is not recorded.
 *   - AG-20 (retained data): the feedback and waitlist files grew without limit.
 *     Past a size cap each store refuses new rows with 503.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoundedWindowLimiter } from "../middleware/bounded-window-limiter.js";

describe("BoundedWindowLimiter", () => {
  it("[neg] a flood of refused requests allocates nothing: a key never holds more than `limit` timestamps", () => {
    const l = new BoundedWindowLimiter(5, 60_000);
    let refused = 0;
    for (let i = 0; i < 10_000; i += 1) if (l.limited("one-key", 1_000_000 + i)) refused += 1;
    expect(refused).toBe(10_000 - 5);
    expect(l.maxPerKey()).toBe(5);
  });

  it("a refused request does not hold the window open: once the allowed ones age out, the key is allowed again", () => {
    const l = new BoundedWindowLimiter(2, 1_000);
    expect(l.limited("k", 0)).toBe(false);
    expect(l.limited("k", 10)).toBe(false);
    expect(l.limited("k", 500)).toBe(true); // refused, not recorded
    expect(l.limited("k", 1_005)).toBe(false); // the t=0 entry aged out
  });

  it("[neg] a NaN or non-positive limit fails closed (1), never open", () => {
    for (const bad of [Number.NaN, 0, -3]) {
      const l = new BoundedWindowLimiter(bad, 60_000);
      expect(l.limited("k", 1)).toBe(false);
      expect(l.limited("k", 2), String(bad)).toBe(true);
    }
  });

  it("the number of keys is bounded, least recently seen evicted first", () => {
    const l = new BoundedWindowLimiter(3, 60_000, 100);
    for (let i = 0; i < 1_000; i += 1) l.limited(`ip-${i}`, i);
    expect(l.size).toBe(100);
    expect(l.has("ip-999")).toBe(true);
    expect(l.has("ip-0")).toBe(false);
  });
});

describe("the feedback and waitlist limiters are bounded per key", () => {
  let DIR = "";
  let app: FastifyInstance;
  let waitlist: typeof import("../routes/waitlist.js");
  let feedback: typeof import("../routes/feedback.js");

  beforeAll(async () => {
    DIR = mkdtempSync(join(tmpdir(), "pcc-bounds-")); // wherever the runner's tmpdir is
    process.env.PCC_DB_PATH = `${DIR}/pcc.sqlite`;
    delete process.env.DISCORD_WEBHOOK_URL;
    vi.resetModules();
    waitlist = await import("../routes/waitlist.js");
    feedback = await import("../routes/feedback.js");
    app = Fastify({ logger: false });
    await app.register(waitlist.waitlistRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(DIR, { recursive: true, force: true });
  });

  it("[neg] feedback: 1000 requests from one IP leave at most RATE_MAX timestamps for it", () => {
    feedback.__resetFeedbackRateLimit();
    for (let i = 0; i < 1000; i += 1) feedback.__feedbackRateLimited("203.0.113.77");
    expect(feedback.__feedbackRateLimitMaxPerIp()).toBeLessThanOrEqual(60);
  });

  it("[neg] waitlist: over-budget updates on a known lead leave its timestamp list bounded", async () => {
    waitlist._resetWaitlistStateForTests();
    const ip = "198.51.100.200";
    const first = await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: "flood@x.test", leadId: "lead-flood" }, remoteAddress: ip });
    const leadToken = first.json().leadToken as string;
    const statuses: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      statuses.push(
        (await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: "flood@x.test", leadId: "lead-flood", leadToken }, remoteAddress: ip })).statusCode,
      );
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(250);
    expect(waitlist._waitlistLimiterMaxPerKeyForTests()).toBeLessThanOrEqual(80);
  });
});

describe("retained data is bounded: a full store refuses new rows (503)", () => {
  let DIR = "";
  let app: FastifyInstance;

  beforeAll(async () => {
    DIR = mkdtempSync(join(tmpdir(), "pcc-stores-")); // wherever the runner's tmpdir is
    process.env.PCC_DB_PATH = `${DIR}/pcc.sqlite`;
    process.env.PCC_FEEDBACK_MAX_BYTES = "1024";
    process.env.PCC_WAITLIST_MAX_BYTES = "1024";
    delete process.env.DISCORD_WEBHOOK_URL;
    // Each store already holds 2 KB, over its 1 KB cap.
    for (const f of ["feedback.jsonl", "waitlist.jsonl", "beta-applications.jsonl"]) {
      writeFileSync(`${DIR}/${f}`, `${JSON.stringify({ filler: "x".repeat(2000) })}\n`);
    }
    vi.resetModules();
    const { feedbackRoutes } = await import("../routes/feedback.js");
    const { waitlistRoutes } = await import("../routes/waitlist.js");
    app = Fastify({ logger: false });
    await app.register(feedbackRoutes);
    await app.register(waitlistRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.PCC_FEEDBACK_MAX_BYTES;
    delete process.env.PCC_WAITLIST_MAX_BYTES;
    rmSync(DIR, { recursive: true, force: true });
  });

  it("[neg] feedback: 503 feedback_store_full", async () => {
    const res = await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "the store is full" }, remoteAddress: "192.0.2.10" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("feedback_store_full");
  });

  it("[neg] waitlist and beta: 503 waitlist_store_full", async () => {
    const wl = await app.inject({ method: "POST", url: "/api/waitlist", payload: { email: "late@x.test", leadId: "lead-late" }, remoteAddress: "192.0.2.11" });
    expect(wl.statusCode).toBe(503);
    expect(wl.json().error).toBe("waitlist_store_full");
    const beta = await app.inject({ method: "POST", url: "/api/beta-apply", payload: { email: "late@x.test" }, remoteAddress: "192.0.2.12" });
    expect(beta.statusCode).toBe(503);
  });
});
