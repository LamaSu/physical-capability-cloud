import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "../routes/health.js";

// GET /api/health + bare GET /health (STATUS-BOARD N5): the original payload
// fields are unchanged, and both paths additionally report WHICH COMMIT is
// being served (commit + commitSource, from build-info.ts).

const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const OTHER40 = "fedcba9876543210fedcba9876543210fedcba98";
const PATHS = ["/api/health", "/health"] as const;
const PAYLOAD_KEYS = ["commit", "commitSource", "status", "timestamp", "version"];

const ENV_KEYS = ["PCC_BUILD_SHA", "RAILWAY_GIT_COMMIT_SHA"] as const;
let savedEnv: Record<string, string | undefined> = {};
let app: FastifyInstance | undefined;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Build a fresh app AFTER the test has set its env (build info is read at registration). */
async function buildApp(): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  await app.register(healthRoutes);
  await app.ready();
  return app;
}

async function getBoth(instance: FastifyInstance) {
  const out: Record<string, { statusCode: number; contentType: string; raw: string; body: Record<string, unknown> }> =
    {};
  for (const url of PATHS) {
    const res = await instance.inject({ method: "GET", url });
    out[url] = {
      statusCode: res.statusCode,
      contentType: String(res.headers["content-type"] ?? ""),
      raw: res.body,
      body: res.json(),
    };
  }
  return out;
}

describe("GET /api/health + /health: original fields unchanged", () => {
  it("both return 200 JSON with status 'ok', version '0.1.0' and an ISO timestamp", async () => {
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      const { statusCode, contentType, body } = both[url]!;
      expect(statusCode, url).toBe(200);
      expect(contentType, url).toContain("application/json");
      expect(body.status, url).toBe("ok");
      expect(body.version, url).toBe("0.1.0");
      expect(typeof body.timestamp, url).toBe("string");
      expect(new Date(body.timestamp as string).toISOString(), url).toBe(body.timestamp);
    }
  });

  it("both paths return the identical shape and the same values (timestamp aside)", async () => {
    process.env.PCC_BUILD_SHA = SHA40;
    const both = await getBoth(await buildApp());
    const api = both["/api/health"]!.body;
    const bare = both["/health"]!.body;
    expect(Object.keys(api).sort()).toEqual(PAYLOAD_KEYS);
    expect(Object.keys(bare).sort()).toEqual(PAYLOAD_KEYS);
    const { timestamp: _a, ...apiRest } = api;
    const { timestamp: _b, ...bareRest } = bare;
    expect(bareRest).toEqual(apiRest);
  });
});

describe("GET /api/health + /health: commit / commitSource", () => {
  it("with nothing set: commit null + commitSource 'unknown' (no invented SHA)", async () => {
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      const { body } = both[url]!;
      expect(body.commit, url).toBeNull();
      expect(body.commitSource, url).toBe("unknown");
      // null is reported explicitly, not omitted
      expect(Object.keys(body), url).toContain("commit");
    }
  });

  it("PCC_BUILD_SHA (baked by CI) -> image_build, lowercased", async () => {
    process.env.PCC_BUILD_SHA = SHA40.toUpperCase();
    process.env.RAILWAY_GIT_COMMIT_SHA = OTHER40;
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      expect(both[url]!.body.commit, url).toBe(SHA40);
      expect(both[url]!.body.commitSource, url).toBe("image_build");
    }
  });

  it("only RAILWAY_GIT_COMMIT_SHA -> railway_deploy", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = OTHER40;
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      expect(both[url]!.body.commit, url).toBe(OTHER40);
      expect(both[url]!.body.commitSource, url).toBe("railway_deploy");
    }
  });

  it("an empty PCC_BUILD_SHA (Dockerfile ARG default) falls back to RAILWAY_GIT_COMMIT_SHA", async () => {
    process.env.PCC_BUILD_SHA = "";
    process.env.RAILWAY_GIT_COMMIT_SHA = OTHER40;
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      expect(both[url]!.body.commit, url).toBe(OTHER40);
      expect(both[url]!.body.commitSource, url).toBe("railway_deploy");
    }
  });

  it("never echoes malformed env content: injection-looking values -> null / 'unknown'", async () => {
    process.env.PCC_BUILD_SHA = "abc1234\nX-Injected: pwned";
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc; rm -rf /";
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      const { body, raw } = both[url]!;
      expect(body.commit, url).toBeNull();
      expect(body.commitSource, url).toBe("unknown");
      expect(raw, url).not.toContain("pwned");
      expect(raw, url).not.toContain("rm -rf");
      expect(raw, url).not.toContain("abc1234");
    }
  });
});

describe("healthRoutes plugin: parent hooks still apply", () => {
  it("root hooks added AFTER registration still fire on both paths, as for the former inline routes", async () => {
    // server.ts registers apiGate / tenantContext / scopeChecker after the
    // health routes; they must keep seeing health requests. (Fastify pushes a
    // parent hook added later into already-registered child plugins too.)
    const seen: string[] = [];
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    app.addHook("onRequest", async (req) => {
      seen.push(req.url);
    });
    await app.ready();
    for (const url of PATHS) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
    }
    expect(seen).toEqual([...PATHS]);
  });
});
