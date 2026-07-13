import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  __resetRateLimitState,
  rateLimiter,
} from "../middleware/rate-limiter.js";

describe("global API rate-limit headers", () => {
  afterEach(() => {
    __resetRateLimitState();
  });

  it("applies to sibling API routes and exposes the 200/minute policy", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimiter);
    app.get("/api/test", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/api/test",
      remoteAddress: "192.0.2.10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["ratelimit-limit"]).toBe("200");
    expect(response.headers["ratelimit-remaining"]).toBe("199");
    expect(Number(response.headers["ratelimit-reset"])).toBeGreaterThan(0);
    await app.close();
  });

  it("returns Retry-After with the standard headers after the limit", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimiter);
    app.get("/api/test", async () => ({ ok: true }));

    for (let count = 0; count < 200; count++) {
      const allowed = await app.inject({
        method: "GET",
        url: "/api/test",
        remoteAddress: "192.0.2.20",
      });
      expect(allowed.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/api/test",
      remoteAddress: "192.0.2.20",
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["ratelimit-limit"]).toBe("200");
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
    expect(Number(limited.headers["ratelimit-reset"])).toBeGreaterThan(0);
    expect(limited.headers["retry-after"]).toBe(
      limited.headers["ratelimit-reset"],
    );
    await app.close();
  });
});
