import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backoffFor,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  clearAll,
  dequeue,
  drain,
  enqueue,
  listAll,
  MAX_ATTEMPTS,
  newIdempotencyKey,
  recordAttempt,
  size,
} from "./offline-queue.js";

beforeEach(async () => {
  await clearAll();
});

afterEach(async () => {
  await clearAll();
});

describe("offline-queue", () => {
  describe("backoffFor", () => {
    it("returns 0 for 0 attempts", () => {
      expect(backoffFor(0)).toBe(0);
    });

    it("returns BACKOFF_BASE_MS after first attempt", () => {
      expect(backoffFor(1)).toBe(BACKOFF_BASE_MS);
    });

    it("doubles each subsequent attempt", () => {
      expect(backoffFor(2)).toBe(BACKOFF_BASE_MS * 2);
      expect(backoffFor(3)).toBe(BACKOFF_BASE_MS * 4);
      expect(backoffFor(4)).toBe(BACKOFF_BASE_MS * 8);
    });

    it("caps at BACKOFF_CAP_MS", () => {
      expect(backoffFor(20)).toBe(BACKOFF_CAP_MS);
    });
  });

  describe("newIdempotencyKey", () => {
    it("returns a non-empty string", () => {
      const k = newIdempotencyKey();
      expect(typeof k).toBe("string");
      expect(k.length).toBeGreaterThan(8);
    });

    it("returns unique values across calls", () => {
      const a = newIdempotencyKey();
      const b = newIdempotencyKey();
      expect(a).not.toBe(b);
    });
  });

  describe("enqueue + size + listAll + dequeue", () => {
    it("starts empty", async () => {
      expect(await size()).toBe(0);
      expect(await listAll()).toEqual([]);
    });

    it("enqueues a request and returns an id", async () => {
      const id = await enqueue({
        method: "POST",
        url: "https://capability.network/api/photo/upload",
        headers: { Authorization: "Bearer test" },
        body: JSON.stringify({ image: "data:..." }),
      });
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
      expect(await size()).toBe(1);
    });

    it("auto-generates an idempotency key when not provided", async () => {
      await enqueue({
        method: "POST",
        url: "https://capability.network/api/issues",
        body: '{"text":"test"}',
      });
      const all = await listAll();
      expect(all[0].idempotencyKey.length).toBeGreaterThan(8);
    });

    it("preserves a provided idempotency key", async () => {
      const myKey = "my-explicit-key-1234";
      await enqueue({
        method: "POST",
        url: "https://capability.network/api/issues",
        body: '{"text":"test"}',
        idempotencyKey: myKey,
      });
      const all = await listAll();
      expect(all[0].idempotencyKey).toBe(myKey);
    });

    it("listAll returns oldest-first", async () => {
      const id1 = await enqueue({ method: "POST", url: "/api/issues", body: "1" });
      // Force a delay so createdAt differs
      await new Promise((r) => setTimeout(r, 5));
      const id2 = await enqueue({ method: "POST", url: "/api/issues", body: "2" });
      await new Promise((r) => setTimeout(r, 5));
      const id3 = await enqueue({ method: "POST", url: "/api/issues", body: "3" });
      const all = await listAll();
      expect(all.map((r) => r.id)).toEqual([id1, id2, id3]);
    });

    it("dequeue removes a single request", async () => {
      const id = await enqueue({ method: "POST", url: "/api/issues", body: "x" });
      expect(await size()).toBe(1);
      await dequeue(id);
      expect(await size()).toBe(0);
    });
  });

  describe("recordAttempt", () => {
    it("increments attempts and records error", async () => {
      const id = await enqueue({ method: "POST", url: "/api/issues", body: "x" });
      await recordAttempt(id, { error: "timeout" });
      const [row] = await listAll();
      expect(row.attempts).toBe(1);
      expect(row.lastError).toBe("timeout");
      expect(row.lastAttemptAt).not.toBeNull();
    });

    it("supports multiple attempts", async () => {
      const id = await enqueue({ method: "POST", url: "/api/issues", body: "x" });
      await recordAttempt(id, { error: "first" });
      await recordAttempt(id, { error: "second" });
      const [row] = await listAll();
      expect(row.attempts).toBe(2);
      expect(row.lastError).toBe("second");
    });
  });

  describe("drain", () => {
    it("dequeues successful requests", async () => {
      await enqueue({ method: "POST", url: "/api/issues", body: "1" });
      await enqueue({ method: "POST", url: "/api/issues", body: "2" });
      const result = await drain({ executor: async () => true });
      expect(result.succeeded).toBe(2);
      expect(result.failedRetriable).toBe(0);
      expect(result.abandoned).toBe(0);
      expect(await size()).toBe(0);
    });

    it("retains failed retriable requests with incremented attempts", async () => {
      const id = await enqueue({ method: "POST", url: "/api/issues", body: "1" });
      const result = await drain({ executor: async () => false });
      expect(result.succeeded).toBe(0);
      expect(result.failedRetriable).toBe(1);
      expect(result.abandoned).toBe(0);
      expect(await size()).toBe(1);
      const [row] = await listAll();
      expect(row.id).toBe(id);
      expect(row.attempts).toBe(1);
    });

    it("abandons after MAX_ATTEMPTS attempts", async () => {
      const id = await enqueue({ method: "POST", url: "/api/issues", body: "1" });
      for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
        await recordAttempt(id, { error: `try-${i}` });
      }
      const abandons: { url: string; reason: string }[] = [];
      const result = await drain({
        executor: async () => false,
        onAbandon: (req, reason) => abandons.push({ url: req.url, reason }),
      });
      expect(result.abandoned).toBe(1);
      expect(result.failedRetriable).toBe(0);
      expect(await size()).toBe(0);
      expect(abandons).toHaveLength(1);
      expect(abandons[0].url).toBe("/api/issues");
    });

    it("processes oldest-first (FIFO)", async () => {
      await enqueue({ method: "POST", url: "/a", body: "1" });
      await new Promise((r) => setTimeout(r, 5));
      await enqueue({ method: "POST", url: "/b", body: "2" });
      await new Promise((r) => setTimeout(r, 5));
      await enqueue({ method: "POST", url: "/c", body: "3" });
      const seen: string[] = [];
      await drain({
        executor: async (req) => {
          seen.push(req.url);
          return true;
        },
      });
      expect(seen).toEqual(["/a", "/b", "/c"]);
    });

    it("treats executor exceptions as retriable failures", async () => {
      await enqueue({ method: "POST", url: "/api/issues", body: "1" });
      const result = await drain({
        executor: async () => {
          throw new Error("boom");
        },
      });
      expect(result.succeeded).toBe(0);
      expect(result.failedRetriable).toBe(1);
      const [row] = await listAll();
      expect(row.lastError).toBe("boom");
    });
  });

  describe("clearAll", () => {
    it("removes everything", async () => {
      await enqueue({ method: "POST", url: "/a", body: "1" });
      await enqueue({ method: "POST", url: "/b", body: "2" });
      expect(await size()).toBe(2);
      await clearAll();
      expect(await size()).toBe(0);
    });
  });
});
