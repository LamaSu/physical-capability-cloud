/**
 * POST /api/capture/sim — gateway route tests.
 *
 * Mirrors capture-3d.test.ts: real Fastify, mocked resolveSession, fake
 * Genesis spawner so no Python is invoked. Covers:
 *   - auth gate
 *   - happy path (single rollout)
 *   - input validation (empty body, oversize, hash mismatch)
 *   - adapter error mapping (runner exit nonzero, schema invalid)
 *   - cross-check on trace.rolloutHash vs request artefact hash
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";

vi.mock("../auth/siwe-auth.js", () => ({
  resolveSession: vi.fn(),
}));

import {
  captureSimRoutes,
  setGenesisSpawnerForTests,
  type GenesisSpawner,
} from "../routes/capture-sim.js";
import { resolveSession } from "../auth/siwe-auth.js";
import type { SimulationTrace } from "@pcc/spec";

const AUTH_ADDRESS = "0x0000000000000000000000000000000000000001" as const;
const mockSession = resolveSession as ReturnType<typeof vi.fn>;

const NOW = "2026-04-21T00:00:00.000Z";
const LATER = "2026-04-21T00:00:05.000Z";
const SCENE_HASH = `sha256:${"d".repeat(64)}` as const;

function makeFakeSpawner(
  buildTrace: (rolloutHash: string) => SimulationTrace,
  exitCode = 0,
  stderr = "",
): GenesisSpawner {
  return async (_cmd, _args, outPath) => {
    // The route writes the rollout artefact to a temp .bin before spawning,
    // so the adapter sees a real file at args[args.indexOf('--rollout-path')+1].
    // The spawner reads it back and hashes for the canned trace.
    const idx = _args.indexOf("--rollout-path");
    let rolloutHash = "sha256:" + "0".repeat(64);
    if (idx > -1 && idx + 1 < _args.length) {
      const artefactPath = _args[idx + 1]!;
      try {
        const bytes = fs.readFileSync(artefactPath);
        rolloutHash = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
      } catch {
        /* file missing -> use placeholder hash; assertion will fail by design */
      }
    }
    fs.writeFileSync(outPath, JSON.stringify(buildTrace(rolloutHash)));
    return { code: exitCode, stdout: "ok\n", stderr };
  };
}

function cannedTrace(
  rolloutHash: string,
  overrides: Partial<SimulationTrace> = {},
): SimulationTrace {
  return {
    deviceId: "test-sim-device",
    startedAt: NOW,
    endedAt: LATER,
    rolloutHash,
    scene: {
      simulator: "genesis",
      simulatorVersion: "0.2.0",
      embodiment: "franka-panda",
      taskId: "cube-stack",
      sceneHash: SCENE_HASH,
      randomSeed: 0,
      actionDim: 7,
      observationDim: 7,
    },
    fps: 30,
    frameCount: 2,
    frames: [
      {
        frameIndex: 0,
        timestampSec: 0,
        action: [0, 0, 0, 0, 0, 0, 0],
        observation: [0.1, 0.2, 0.0, 0.5, 0.3, 0.0, 1.57],
        reward: 0.0,
        done: false,
      },
      {
        frameIndex: 1,
        timestampSec: 1 / 30,
        action: [0.1, 0, 0, 0, 0, 0, 0],
        observation: [0.15, 0.2, 0.0, 0.5, 0.3, 0.0, 1.57],
        reward: 1.0,
        done: true,
        info: { success: true },
      },
    ],
    summary: {
      totalReturn: 1.0,
      episodeLength: 2,
      success: true,
      terminatedReason: "success",
      meanReward: 0.5,
    },
    model: "genesis-stub-policy",
    adapterVersion: "0.1.0",
    stubbed: true,
    ...overrides,
  };
}

let app: FastifyInstance;

beforeAll(async () => {
  // bodyLimit raised to 96 MB so the route's 32 MB cap is exercised by the
  // oversize test rather than Fastify's default 1 MB JSON parser limit
  // tripping first. Production gateway uses 1 MB on createGateway(); routes
  // that legitimately accept large payloads do their own bytes check after
  // base64 decoding (see capture-sim.ts:MAX_ARTEFACT_BYTES).
  app = Fastify({ logger: false, bodyLimit: 96 * 1024 * 1024 });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  await app.register(captureSimRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setGenesisSpawnerForTests(null);
});

beforeEach(() => {
  mockSession.mockReturnValue({ address: AUTH_ADDRESS });
  setGenesisSpawnerForTests(null);
});

describe("POST /api/capture/sim — auth gate", () => {
  it("returns 401 without a session", async () => {
    mockSession.mockReturnValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: { rolloutBytesBase64: Buffer.from([0, 1, 2, 3]).toString("base64") },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/capture/sim — happy path", () => {
  it("accepts a small rollout artefact and returns a validated trace", async () => {
    setGenesisSpawnerForTests(makeFakeSpawner((h) => cannedTrace(h)));

    const bytes = Buffer.from("genesis-rollout-bytes-placeholder");
    const expectedHash =
      "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");

    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: {
        rolloutBytesBase64: bytes.toString("base64"),
        fps: 30,
        maxFrames: 64,
        jobId: "job-sim-1",
        deviceId: "kernel-sim-1",
        taskId: "cube-stack",
        simulator: "genesis",
        expectedRolloutHash: expectedHash,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trace.rolloutHash).toBe(expectedHash);
    expect(body.trace.frameCount).toBe(2);
    expect(body.trace.frames).toHaveLength(2);
    expect(body.trace.summary.success).toBe(true);
    expect(body.trace.scene.simulator).toBe("genesis");
    expect(body.stubbed).toBe(true);
    expect(body.bytesReceived).toBe(bytes.length);
  });

  it("propagates a custom simulator setting through to the trace", async () => {
    setGenesisSpawnerForTests(
      makeFakeSpawner((h) =>
        cannedTrace(h, {
          scene: {
            simulator: "isaac-gym",
            simulatorVersion: "1.5",
            embodiment: "franka-panda",
            taskId: "reach",
            sceneHash: SCENE_HASH,
          },
        }),
      ),
    );
    const bytes = Buffer.from("rollout");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: {
        rolloutBytesBase64: bytes.toString("base64"),
        simulator: "isaac-gym",
        taskId: "reach",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().trace.scene.simulator).toBe("isaac-gym");
    expect(res.json().trace.scene.taskId).toBe("reach");
  });
});

describe("POST /api/capture/sim — input validation", () => {
  it("rejects an empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("rejects a zero-length decoded rollout artefact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: { rolloutBytesBase64: "" }, // Zod min(1) catches first
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an over-size rollout artefact (>32 MB)", async () => {
    // Allocate a real 33 MB buffer and base64-encode it once. Naively
    // repeating a base64-encoded chunk produces an invalid base64 string
    // (each chunk has `==` padding mid-stream) that decodes to only the
    // first segment — masking the size check this test is meant to exercise.
    const big = Buffer.alloc(33 * 1024 * 1024, 0).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: { rolloutBytesBase64: big },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("rollout_too_large");
  });

  it("rejects when expectedRolloutHash does not match decoded bytes", async () => {
    const bytes = Buffer.from("rollout-bytes");
    const wrongHash = "sha256:" + "0".repeat(64);
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: {
        rolloutBytesBase64: bytes.toString("base64"),
        expectedRolloutHash: wrongHash,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("rollout_hash_mismatch");
  });
});

describe("POST /api/capture/sim — adapter error mapping", () => {
  it("maps runner_exit_nonzero to 502", async () => {
    setGenesisSpawnerForTests(makeFakeSpawner((h) => cannedTrace(h), 1, "kaboom"));
    const bytes = Buffer.from("rollout");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: { rolloutBytesBase64: bytes.toString("base64") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("runner_exit_nonzero");
  });

  it("maps trace_schema_invalid to 502", async () => {
    setGenesisSpawnerForTests(
      makeFakeSpawner((h) =>
        // Schema-invalid: rolloutHash isn't sha256:<hex>
        ({ ...cannedTrace(h), rolloutHash: "garbage" } as unknown as SimulationTrace),
      ),
    );
    const bytes = Buffer.from("rollout");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: { rolloutBytesBase64: bytes.toString("base64") },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("trace_schema_invalid");
  });

  it("rejects when adapter returned a trace whose rolloutHash does not match the request", async () => {
    // Force a fake trace whose rolloutHash is a fixed-but-wrong value.
    setGenesisSpawnerForTests(
      makeFakeSpawner(() =>
        cannedTrace("sha256:" + "f".repeat(64)),
      ),
    );
    const bytes = Buffer.from("the-real-rollout");
    const res = await app.inject({
      method: "POST",
      url: "/api/capture/sim",
      payload: { rolloutBytesBase64: bytes.toString("base64") },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("trace_rollout_hash_mismatch");
  });
});
