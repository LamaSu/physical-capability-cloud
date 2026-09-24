import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "../routes/health.js";
import { readBuildInfo, type BuildInfo } from "../build-info.js";

// GET /api/health + bare GET /health (STATUS-BOARD N5): the original payload
// fields are unchanged, and both paths additionally report WHICH COMMIT is
// being served. The commit comes only from the image's build-info file
// (build-info.ts); the tests inject it through the plugin's buildInfo option.

const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const OTHER40 = "fedcba9876543210fedcba9876543210fedcba98";
const PATHS = ["/api/health", "/health"] as const;
const PAYLOAD_KEYS = ["buildArg", "commit", "commitSource", "deployMetadata", "status", "timestamp", "version"];

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

/** The build info a given image file (or none) yields, with the current env. */
const fromFile = (content: string | null) => () => readBuildInfo({ readFile: () => content });
const baked = (commit: string, buildArg = "PCC_BUILD_SHA") => JSON.stringify({ commit, buildArg });

/** Build a fresh app AFTER the test has set its env (build info is read at registration). */
async function buildApp(buildInfo: () => BuildInfo = fromFile(null)): Promise<FastifyInstance> {
  app = Fastify({ logger: false });
  await app.register(healthRoutes, { buildInfo });
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
    const both = await getBoth(await buildApp(fromFile(baked(SHA40))));
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
  it("with no build-info file: commit null + commitSource 'unknown' (no invented SHA)", async () => {
    const both = await getBoth(await buildApp());
    for (const url of PATHS) {
      const { body } = both[url]!;
      expect(body.commit, url).toBeNull();
      expect(body.commitSource, url).toBe("unknown");
      expect(body.buildArg, url).toBeNull();
      // null is reported explicitly, not omitted
      expect(Object.keys(body), url).toContain("commit");
    }
  });

  it("the image file's commit -> image_build, with the build argument that supplied it", async () => {
    const both = await getBoth(await buildApp(fromFile(baked(SHA40, "RAILWAY_GIT_COMMIT_SHA"))));
    for (const url of PATHS) {
      expect(both[url]!.body.commit, url).toBe(SHA40);
      expect(both[url]!.body.commitSource, url).toBe("image_build");
      expect(both[url]!.body.buildArg, url).toBe("RAILWAY_GIT_COMMIT_SHA");
    }
  });

  it("NEGATIVE (review #2886): runtime variables never change the reported commit", async () => {
    process.env.PCC_BUILD_SHA = OTHER40;
    process.env.RAILWAY_GIT_COMMIT_SHA = OTHER40;
    const withFile = await getBoth(await buildApp(fromFile(baked(SHA40))));
    for (const url of PATHS) {
      expect(withFile[url]!.body.commit, url).toBe(SHA40);
      // Railway's value is reported, but only as deploy metadata.
      expect(withFile[url]!.body.deployMetadata, url).toEqual({ railwayGitCommitSha: OTHER40 });
    }
    await app?.close();
    const noFile = await getBoth(await buildApp(fromFile(null)));
    for (const url of PATHS) {
      expect(noFile[url]!.body.commit, url).toBeNull();
      expect(noFile[url]!.body.commitSource, url).toBe("unknown");
    }
  });

  it("never echoes malformed content: injection-looking values -> null / 'unknown'", async () => {
    process.env.RAILWAY_GIT_COMMIT_SHA = "abc; rm -rf /";
    const both = await getBoth(await buildApp(fromFile(baked("abc1234\nX-Injected: pwned"))));
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

describe("healthRoutes: per-request freshness and caching", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the timestamp is taken per request, not at registration", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    await app.ready();
    vi.setSystemTime(new Date("2031-01-01T00:05:00.000Z"));
    for (const url of PATHS) {
      const res = await app.inject({ method: "GET", url });
      expect(res.json().timestamp, url).toBe("2031-01-01T00:05:00.000Z");
    }
  });

  it("answers with cache-control: no-store on both paths", async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes);
    await app.ready();
    for (const url of PATHS) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["cache-control"], url).toBe("no-store");
    }
  });
});
