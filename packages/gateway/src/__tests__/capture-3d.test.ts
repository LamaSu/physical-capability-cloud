/**
 * POST /api/capture/3d-stream — gateway route tests.
 *
 * Mirrors the strategy used in capture.test.ts: real Fastify, mocked
 * resolveSession, fake LingBot spawner so no Python is invoked.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));

import { capture3dRoutes } from "../routes/capture-3d.js";
import { resolveSession } from "../auth/siwe-auth.js";
import {
  setLingBotSpawnerForTests,
  type LingBotSpawner,
} from "@pcc/verifier/dist/capture/lingbot-adapter.js";
import type { PointMap3DTrace } from "@pcc/spec";

const AUTH_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const mockSession = resolveSession as ReturnType<typeof vi.fn>;

const NOW = "2026-04-21T00:00:00.000Z";

function makeFakeSpawner(
  buildTrace: (videoHash: string) => PointMap3DTrace,
  exitCode = 0,
  stderr = "",
): LingBotSpawner {
  return async (_cmd, _args, outPath) => {
    // Match args[*]: scripts/.../runner.py --video-path <path> --out <outPath> ...
    // The route writes the video to a temp .mp4 before spawning, so the
    // adapter sees a real file at args[args.indexOf('--video-path')+1].
    // The spawner reads it back and hashes for the canned trace.
    const idx = _args.indexOf("--video-path");
    let videoHash = "sha256:" + "0".repeat(64);
    if (idx > -1 && idx + 1 < _args.length) {
      const videoPath = _args[idx + 1]!;
      try {
        const bytes = fs.readFileSync(videoPath);
        videoHash = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
      } catch {
        /* file missing -> use placeholder hash; assertion will fail by design */
      }
    }
    fs.writeFileSync(outPath, JSON.stringify(buildTrace(videoHash)));
    return { code: exitCode, stdout: "ok\n", stderr };
  };
}

function cannedTrace(videoHash: string, overrides: Partial<PointMap3DTrace> = {}): PointMap3DTrace {
  return {
    deviceId: "test-3d-device",
    startedAt: NOW,
    endedAt: NOW,
    videoHash,
    mode: "streaming",
    fps: 10,
    frameCount: 2,
    frames: [
      {
        frameIndex: 0,
        timestampSec: 0,
        pose: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] },
        points: [{ x: 0, y: 0, z: 1 }],
      },
      {
        frameIndex: 1,
        timestampSec: 0.1,
        pose: { matrix: [1, 0, 0, 0.01, 0, 1, 0, 0, 0, 0, 1, 0] },
        points: [{ x: 0.01, y: 0, z: 1 }],
      },
    ],
    model: "lingbot-map-stub",
    adapterVersion: "0.1.0",
    stubbed: true,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(capture3dRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setLingBotSpawnerForTests(null);
});

beforeEach(() => {
  mockSession.mockReturnValue({ address: AUTH_ADDRESS });
  setLingBotSpawnerForTests(null);
});

describe("POST /api/capture/3d-stream — auth gate", () => {
  it("returns 401 without a session", async () => {
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: { videoBytesBase64: Buffer.from([0, 1, 2, 3]).toString("base64") },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/capture/3d-stream — happy path", () => {
  it("accepts a small video and returns a validated trace", async () => {
    setLingBotSpawnerForTests(makeFakeSpawner((h) => cannedTrace(h)));

    const bytes = Buffer.from("phone-video-bytes-placeholder");
    const expectedHash = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");

    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: {
        videoBytesBase64: bytes.toString("base64"),
        mode: "streaming",
        fps: 10,
        maxFrames: 8,
        jobId: "job-3d-1",
        deviceId: "phone-1",
        expectedVideoHash: expectedHash,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trace.videoHash).toBe(expectedHash);
    expect(body.trace.frameCount).toBe(2);
    expect(body.trace.frames).toHaveLength(2);
    expect(body.stubbed).toBe(true);
    expect(body.bytesReceived).toBe(bytes.length);
  });

  it("propagates a windowed-mode setting through to the trace", async () => {
    setLingBotSpawnerForTests(
      makeFakeSpawner((h) => cannedTrace(h, { mode: "windowed" })),
    );
    const bytes = Buffer.from("clip");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: {
        videoBytesBase64: bytes.toString("base64"),
        mode: "windowed",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().trace.mode).toBe("windowed");
  });
});

describe("POST /api/capture/3d-stream — input validation", () => {
  it("rejects an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects a zero-length decoded video", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: { videoBytesBase64: "" }, // Zod min(1) catches first
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an over-size video (>32 MB)", async () => {
    // 33 MB of zeros -> base64 ~44 MB. We don't actually allocate; just
    // craft a base64 string of the right size by repeating a chunk.
    const chunk = Buffer.alloc(1024 * 1024, 0).toString("base64"); // ~1.36 MB base64
    const big = chunk.repeat(40); // ~54 MB base64 -> ~40 MB decoded
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: { videoBytesBase64: big },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("video_too_large");
  });

  it("rejects when expectedVideoHash does not match decoded bytes", async () => {
    const bytes = Buffer.from("phone-video");
    const wrongHash = "sha256:" + "0".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: {
        videoBytesBase64: bytes.toString("base64"),
        expectedVideoHash: wrongHash,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("video_hash_mismatch");
  });
});

describe("POST /api/capture/3d-stream — adapter error mapping", () => {
  it("maps runner_exit_nonzero to 502", async () => {
    setLingBotSpawnerForTests(makeFakeSpawner((h) => cannedTrace(h), 1, "kaboom"));
    const bytes = Buffer.from("clip");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: { videoBytesBase64: bytes.toString("base64") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("runner_exit_nonzero");
  });

  it("maps trace_schema_invalid to 502", async () => {
    setLingBotSpawnerForTests(
      makeFakeSpawner((h) =>
        // Schema-invalid: videoHash isn't sha256:<hex>
        ({ ...cannedTrace(h), videoHash: "garbage" } as unknown as PointMap3DTrace),
      ),
    );
    const bytes = Buffer.from("clip");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: { videoBytesBase64: bytes.toString("base64") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("trace_schema_invalid");
  });

  it("rejects when adapter returned a trace whose videoHash does not match the request", async () => {
    // Force a fake trace whose videoHash is a fixed-but-wrong value.
    setLingBotSpawnerForTests(
      makeFakeSpawner(() =>
        cannedTrace("sha256:" + "f".repeat(64)),
      ),
    );
    const bytes = Buffer.from("the-real-clip");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/3d-stream",
      payload: { videoBytesBase64: bytes.toString("base64") },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("trace_video_hash_mismatch");
  });
});
