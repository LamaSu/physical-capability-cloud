/**
 * POST /api/capture/sim — Genesis-sim rollout artefact → SimulationTrace.
 *
 * Mirror of `routes/capture-3d.ts`. Where capture-3d.ts hands a phone-video
 * blob to the LingBot streaming-3D inference runner, capture-sim.ts hands a
 * Genesis-sim rollout artefact (jsonl/npz/h5 bytes the operator's sim runner
 * produced) to `scripts/pcc_genesis_runner.py`, which normalizes it into the
 * `SimulationTrace` schema. The caller folds the returned traces into the
 * `CaptureManifest.simulations` array before POSTing to `/api/capture/upload`
 * (which already hashes the manifest including the new field — no other
 * gateway changes required).
 *
 * Design choices (1:1 with capture-3d.ts):
 *   - Plain JSON + base64 rollout bytes (no @fastify/multipart). Keeps the
 *     route Zod-first and matches routes/capture.ts:upload.
 *   - Hard caps: 32 MB inbound artefact, 4096 frames processed, 16384
 *     observation/action width.
 *   - The runner handles stub mode internally (PCC_GENESIS_STUB=1), so CI /
 *     aarch64 dev boxes that can't compile CUDA-bound deps still get a real
 *     round-trip through this route.
 *   - The spawn + validate logic lives inline (not behind a separate
 *     verifier-package adapter) so this single file is the entire surface;
 *     a `setGenesisSpawnerForTests` hook lets tests inject a fake spawner.
 *
 * Author: pcc-genesis adapter
 * License: Apache-2.0 (matches Genesis upstream)
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SimulationTraceSchemaExport,
  type SimulationTrace,
} from "@pcc/spec";
import { requireAuth } from "../auth/require-auth.js";
import { pipelineTelemetry } from "../telemetry.js";

// ---------------------------------------------------------------------------
// Inline adapter — spawn the Python runner and validate its JSON output.
// ---------------------------------------------------------------------------

const ADAPTER_VERSION = "0.1.0";
const MAX_ARTEFACT_BYTES = 32 * 1024 * 1024; // 32 MB

/** Errors that the route handler pattern-matches on. */
export class GenesisAdapterError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "GenesisAdapterError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Spawn-callback shape for test injection. Returns the runner's stdout/stderr
 * + the path the runner was asked to write its JSON to. Tests substitute this
 * with a fake that writes a canned trace, bypassing Python entirely.
 */
export interface GenesisSpawner {
  (cmd: string, args: string[], outPath: string): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

let _spawnerOverride: GenesisSpawner | null = null;

/** Test helper — install a fake spawner. Pass `null` to reset. */
export function setGenesisSpawnerForTests(s: GenesisSpawner | null): void {
  _spawnerOverride = s;
}

const DEFAULT_SPAWNER: GenesisSpawner = (cmd, args) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}\nspawn_error: ${err.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** Walk upward to find the monorepo root (`pnpm-workspace.yaml`). */
function resolveRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isStubEnabled(): boolean {
  const stub = (process.env.PCC_GENESIS_STUB ?? "").trim().toLowerCase();
  const disabled = (process.env.PCC_GENESIS_DISABLED ?? "").trim().toLowerCase();
  return ["1", "true", "yes"].includes(stub) ||
         ["1", "true", "yes"].includes(disabled);
}

/** Clamp to bounded ints — keeps adapter latency / output size predictable. */
function clampInt(value: number | undefined, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(value)));
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* best-effort cleanup */
  }
}

interface GenesisAdapterInput {
  /** Absolute path to the uploaded rollout artefact on disk */
  artefactPath: string;
  /** Steps-per-second the simulator was driven at */
  fps?: number;
  /** Hard cap on frames recorded in the trace */
  maxFrames?: number;
  /** Downsample width for flat observation/action vectors */
  downsamplePoints?: number;
  /** Optional checkpoint identifier (records into trace.model) */
  modelPath?: string;
  /** Logical device id stamped into the trace */
  deviceId?: string;
  /** Optional task identifier (records into trace.scene.taskId) */
  taskId?: string;
  /** Optional simulator identifier (records into trace.scene.simulator) */
  simulator?: string;
}

interface GenesisAdapterResult {
  trace: SimulationTrace;
  durationMs: number;
  stubbed: boolean;
}

/**
 * Run the Genesis runner against an on-disk rollout artefact and return the
 * validated `SimulationTrace`. Throws `GenesisAdapterError` on any failure.
 */
async function runGenesisInference(
  input: GenesisAdapterInput,
): Promise<GenesisAdapterResult> {
  const start = Date.now();

  if (!input.artefactPath) {
    throw new GenesisAdapterError("missing_artefact_path", "artefactPath is required");
  }

  const stubbed = isStubEnabled();
  const repoRoot = resolveRepoRoot();
  const runnerPath = process.env.PCC_GENESIS_RUNNER
    ?? path.join(repoRoot, "scripts", "pcc_genesis_runner.py");
  const genesisRoot = process.env.PCC_GENESIS_ROOT
    ?? path.join(repoRoot, "vendor", "genesis");
  const pythonBin = process.env.PCC_GENESIS_PYTHON ?? "python3";

  const fps = clampInt(input.fps, 1, 240, 30);
  const maxFrames = clampInt(input.maxFrames, 1, 4096, 256);
  const downsamplePoints = clampInt(input.downsamplePoints, 16, 16384, 256);

  const outPath = path.join(os.tmpdir(), `pcc-genesis-${process.pid}-${Date.now()}.json`);

  const args = [
    runnerPath,
    "--rollout-path", input.artefactPath,
    "--out", outPath,
    "--fps", String(fps),
    "--max-frames", String(maxFrames),
    "--downsample-points", String(downsamplePoints),
    "--genesis-root", genesisRoot,
  ];
  if (input.modelPath) args.push("--model-path", input.modelPath);
  if (input.taskId) args.push("--task-id", input.taskId);
  if (input.simulator) args.push("--simulator", input.simulator);

  // Inject runner env. Always force stub mode if the adapter is stubbed —
  // otherwise let the user's env decide.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (stubbed) childEnv.PCC_GENESIS_STUB = "1";
  if (input.deviceId) childEnv.PCC_DEVICE_ID = input.deviceId;

  const spawner = _spawnerOverride ?? DEFAULT_SPAWNER;

  let spawnRes: { code: number; stdout: string; stderr: string };
  try {
    spawnRes = await spawnWithEnv(spawner, pythonBin, args, outPath, childEnv);
  } catch (err) {
    safeUnlink(outPath);
    throw new GenesisAdapterError(
      "spawn_failed",
      `Failed to spawn Genesis runner: ${(err as Error).message}`,
      { cmd: pythonBin, args },
    );
  }

  if (spawnRes.code !== 0) {
    safeUnlink(outPath);
    throw new GenesisAdapterError(
      "runner_exit_nonzero",
      `Genesis runner exited with code ${spawnRes.code}`,
      { stderr: spawnRes.stderr.slice(0, 2000), stdout: spawnRes.stdout.slice(0, 2000) },
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(outPath, "utf8");
  } catch (err) {
    throw new GenesisAdapterError(
      "trace_not_written",
      `Genesis runner did not write ${outPath}: ${(err as Error).message}`,
    );
  } finally {
    safeUnlink(outPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GenesisAdapterError(
      "trace_json_invalid",
      `Genesis trace was not valid JSON: ${(err as Error).message}`,
      { snippet: raw.slice(0, 200) },
    );
  }

  const result = SimulationTraceSchemaExport.safeParse(parsed);
  if (!result.success) {
    throw new GenesisAdapterError(
      "trace_schema_invalid",
      "Genesis trace failed SimulationTraceSchema validation",
      { issues: result.error.issues.slice(0, 10) },
    );
  }

  return {
    trace: result.data,
    durationMs: Date.now() - start,
    stubbed: result.data.stubbed === true,
  };
}

/**
 * Thread `env` into the real spawn path so tests don't have to mock env.
 * The default spawner ignores `outPath`/`env`; the test spawner uses
 * `outPath` to drop a canned trace.
 */
function spawnWithEnv(
  spawner: GenesisSpawner,
  cmd: string,
  args: string[],
  outPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (spawner === DEFAULT_SPAWNER) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => {
        resolve({ code: -1, stdout, stderr: `${stderr}\nspawn_error: ${err.message}` });
      });
      child.on("close", (code) => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }
  return spawner(cmd, args, outPath);
}

// ---------------------------------------------------------------------------
// Route — POST /api/capture/sim
// ---------------------------------------------------------------------------

const SimBodySchema = z.object({
  /** base64-encoded rollout artefact bytes (jsonl/npz/h5) */
  rolloutBytesBase64: z.string().min(1),
  /** MIME hint (advisory, not enforced) */
  rolloutMime: z.string().min(1).optional(),
  /** Steps-per-second the simulator was driven at */
  fps: z.number().int().positive().max(240).optional(),
  /** Hard cap on frames recorded in the trace */
  maxFrames: z.number().int().positive().max(4096).optional(),
  /** Downsample width for flat observation/action vectors */
  downsamplePoints: z.number().int().positive().max(16384).optional(),
  /** Optional checkpoint identifier */
  modelPath: z.string().min(1).optional(),
  /** Logical job id for telemetry correlation */
  jobId: z.string().min(1).optional(),
  /** Logical device id stamped into the trace */
  deviceId: z.string().min(1).optional(),
  /** Optional task identifier for the runner */
  taskId: z.string().min(1).optional(),
  /** Optional simulator override (default "genesis") */
  simulator: z.string().min(1).optional(),
  /** Optional sha256:<hex> echo — short-circuit verify on the caller's hash */
  expectedRolloutHash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

interface SimResponse {
  trace: SimulationTrace;
  durationMs: number;
  stubbed: boolean;
  bytesReceived: number;
}

/**
 * Register the simulation route on a Fastify instance. Mirror call-site
 * shape of `capture3dRoutes` so the gateway wires both with a one-liner.
 */
export async function captureSimRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/capture/sim",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = SimBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid /api/capture/sim request body",
          details: parsed.error.flatten(),
        });
      }

      const {
        rolloutBytesBase64,
        fps,
        maxFrames,
        downsamplePoints,
        modelPath,
        jobId,
        deviceId,
        taskId,
        simulator,
        expectedRolloutHash,
      } = parsed.data;

      let artefactBytes: Buffer;
      try {
        artefactBytes = Buffer.from(rolloutBytesBase64, "base64");
      } catch (err) {
        return reply.status(400).send({
          error: "invalid_rollout_bytes",
          message: `rolloutBytesBase64 failed to decode: ${(err as Error).message}`,
        });
      }

      if (artefactBytes.length === 0) {
        return reply.status(400).send({
          error: "empty_rollout",
          message: "Decoded rollout artefact has zero bytes",
        });
      }
      if (artefactBytes.length > MAX_ARTEFACT_BYTES) {
        return reply.status(413).send({
          error: "rollout_too_large",
          message: `Rollout exceeds ${MAX_ARTEFACT_BYTES} byte cap (got ${artefactBytes.length})`,
        });
      }

      const actualHash =
        "sha256:" + crypto.createHash("sha256").update(artefactBytes).digest("hex");
      if (
        expectedRolloutHash &&
        expectedRolloutHash.toLowerCase() !== actualHash.toLowerCase()
      ) {
        return reply.status(400).send({
          error: "rollout_hash_mismatch",
          message: `expectedRolloutHash (${expectedRolloutHash}) does not match sha256(rolloutBytes)=${actualHash}`,
        });
      }

      const tempPath = path.join(
        os.tmpdir(),
        `pcc-sim-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bin`,
      );
      try {
        fs.writeFileSync(tempPath, artefactBytes);
      } catch (err) {
        return reply.status(500).send({
          error: "tempfile_write_failed",
          message: (err as Error).message,
        });
      }

      try {
        const result = await runGenesisInference({
          artefactPath: tempPath,
          fps,
          maxFrames,
          downsamplePoints,
          modelPath,
          deviceId,
          taskId,
          simulator,
        });

        // Defense-in-depth: re-validate the returned trace against the spec
        // schema. The adapter already does this, but the gateway never trusts
        // its result blindly.
        const guard = SimulationTraceSchemaExport.safeParse(result.trace);
        if (!guard.success) {
          return reply.status(500).send({
            error: "trace_schema_invalid",
            message: "Adapter returned a trace that failed schema validation",
            details: guard.error.flatten(),
          });
        }

        // Cross-check the trace's rolloutHash against what we computed —
        // catches an adapter bug where the trace was built from a different
        // file (race, leftover tempfile, etc.).
        if (result.trace.rolloutHash.toLowerCase() !== actualHash.toLowerCase()) {
          return reply.status(500).send({
            error: "trace_rollout_hash_mismatch",
            message: `trace.rolloutHash (${result.trace.rolloutHash}) does not match request artefact hash (${actualHash})`,
          });
        }

        pipelineTelemetry.emit(jobId ?? "capture-sim", "evidence_capture", "completed", {
          metadata: {
            subphase: "capture_sim",
            jobId: jobId ?? null,
            frameCount: result.trace.frameCount,
            durationMs: result.durationMs,
            stubbed: result.stubbed,
            simulator: result.trace.scene.simulator,
            taskId: result.trace.scene.taskId,
            model: result.trace.model,
            adapterVersion: ADAPTER_VERSION,
          },
        });

        const response: SimResponse = {
          trace: result.trace,
          durationMs: result.durationMs,
          stubbed: result.stubbed,
          bytesReceived: artefactBytes.length,
        };
        return response;
      } catch (err) {
        if (err instanceof GenesisAdapterError) {
          req.log.error({ err, code: err.code }, "capture_sim adapter failed");
          pipelineTelemetry.emit(jobId ?? "capture-sim", "evidence_capture", "failed", {
            metadata: {
              subphase: "capture_sim",
              jobId: jobId ?? null,
              error: err.code,
              message: err.message,
            },
            level: "error",
          });
          // Map adapter errors to user-actionable HTTP shapes.
          const status = err.code === "missing_artefact_path" ? 400 : 502;
          return reply.status(status).send({
            error: err.code,
            message: err.message,
            detail: err.detail,
          });
        }
        req.log.error({ err }, "capture_sim threw");
        return reply.status(500).send({
          error: "internal_error",
          message: (err as Error).message,
        });
      } finally {
        safeUnlink(tempPath);
      }
    },
  );
}
