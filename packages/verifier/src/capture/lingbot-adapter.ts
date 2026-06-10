/**
 * LingBot streaming-3D adapter (server-side).
 *
 * Wraps the `scripts/pcc_lingbot_runner.py` Python wrapper so the gateway
 * can request a per-frame point map + camera-pose trace from an uploaded
 * phone video and merge the result into the capture manifest as
 * `pointMaps3D`.
 *
 * Design boundaries:
 *   - This file is the ONLY place that knows about the Python runner. The
 *     gateway route never sees subprocess concerns.
 *   - When `PCC_LINGBOT_STUB=1` (or `PCC_LINGBOT_DISABLED=1`), the adapter
 *     short-circuits without spawning Python. Useful for CI, aarch64 dev
 *     boxes that cannot compile FlashInfer JIT, and gateway smoke tests.
 *   - The runner's JSON output is validated against
 *     `PointMap3DTraceSchemaExport` from `@pcc/spec` BEFORE returning, so
 *     malformed traces fail at the adapter boundary rather than during
 *     `CaptureManifestSchema` validation downstream.
 *   - We persist the runner output to a tempfile because some LingBot
 *     checkpoints emit traces that exceed the 1 MB pipe buffer. The tempfile
 *     is always unlinked, even on error.
 *
 * Author: pcc-lingbot adapter
 * License: Apache-2.0 (matches LingBot-Map upstream)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PointMap3DTraceSchemaExport,
  type PointMap3DTrace,
} from "@pcc/spec";

/** Adapter-level inputs for one inference run. */
export interface LingBotAdapterInput {
  /** Absolute path to the uploaded phone-video file on disk. */
  videoPath: string;
  /** Inference mode (matches LingBot --mode). */
  mode?: "streaming" | "windowed";
  /** Video FPS sampling. Bounded; defaults to 10. */
  fps?: number;
  /** Hard cap on frames processed. Defaults to 32 (~3.2s at 10 FPS). */
  maxFrames?: number;
  /** Sparse points per frame in the returned trace. Defaults to 256. */
  downsamplePoints?: number;
  /** Optional LingBot checkpoint path. Omit for stub/random-init runs. */
  modelPath?: string;
  /** Logical device id stamped into the trace. */
  deviceId?: string;
}

/** Top-level adapter result. */
export interface LingBotAdapterResult {
  trace: PointMap3DTrace;
  /** Total wall-clock time including subprocess spawn. */
  durationMs: number;
  /** True iff the adapter ran in stub mode (no Python / no GPU touched). */
  stubbed: boolean;
}

/** Errors that the gateway route can pattern-match on. */
export class LingBotAdapterError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "LingBotAdapterError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Spawn-callback shape for test injection. Returns the runner's stdout +
 * the path the runner wrote its JSON to. Tests substitute this with a fake
 * that writes a canned trace, bypassing Python entirely.
 */
export interface LingBotSpawner {
  (cmd: string, args: string[], outPath: string): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

let _spawnerOverride: LingBotSpawner | null = null;

/** Test helper — install a fake spawner. Pass `null` to reset. */
export function setLingBotSpawnerForTests(s: LingBotSpawner | null): void {
  _spawnerOverride = s;
}

const DEFAULT_SPAWNER: LingBotSpawner = (cmd, args) =>
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

/**
 * Resolve the project root by walking upward from the gateway/verifier dist
 * location until we hit a `pnpm-workspace.yaml`. We need this because the
 * Python runner lives at the monorepo root (`scripts/pcc_lingbot_runner.py`)
 * and the vendored LingBot tree lives at `vendor/lingbot-map`.
 */
function resolveRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to cwd — the gateway always launches from the repo root via
  // `pnpm dev` / `pnpm start`, so this is a sane default.
  return process.cwd();
}

function isStubEnabled(): boolean {
  const stub = (process.env.PCC_LINGBOT_STUB ?? "").trim().toLowerCase();
  const disabled = (process.env.PCC_LINGBOT_DISABLED ?? "").trim().toLowerCase();
  return ["1", "true", "yes"].includes(stub) ||
         ["1", "true", "yes"].includes(disabled);
}

/** Bounded clamp — keeps adapter latency / output size predictable. */
function clampInt(value: number | undefined, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(value)));
}

/**
 * Run streaming-3D inference on a phone video and return the validated
 * `PointMap3DTrace`. Throws `LingBotAdapterError` on any failure.
 */
export async function runLingBotInference(
  input: LingBotAdapterInput,
): Promise<LingBotAdapterResult> {
  const start = Date.now();

  if (!input.videoPath) {
    throw new LingBotAdapterError("missing_video_path", "videoPath is required");
  }

  const stubbed = isStubEnabled();
  const repoRoot = resolveRepoRoot();
  const runnerPath = process.env.PCC_LINGBOT_RUNNER
    ?? path.join(repoRoot, "scripts", "pcc_lingbot_runner.py");
  const lingbotRoot = process.env.PCC_LINGBOT_ROOT
    ?? path.join(repoRoot, "vendor", "lingbot-map");
  const pythonBin = process.env.PCC_LINGBOT_PYTHON ?? "python3";

  const fps = clampInt(input.fps, 1, 60, 10);
  const maxFrames = clampInt(input.maxFrames, 1, 512, 32);
  const downsamplePoints = clampInt(input.downsamplePoints, 16, 4096, 256);
  const mode = input.mode === "windowed" ? "windowed" : "streaming";

  const outPath = path.join(os.tmpdir(), `pcc-lingbot-${process.pid}-${Date.now()}.json`);

  const args = [
    runnerPath,
    "--video-path", input.videoPath,
    "--out", outPath,
    "--mode", mode,
    "--fps", String(fps),
    "--max-frames", String(maxFrames),
    "--downsample-points", String(downsamplePoints),
    "--lingbot-root", lingbotRoot,
  ];
  if (input.modelPath) {
    args.push("--model-path", input.modelPath);
  }

  // Inject runner env. Always force stub mode if the adapter is stubbed —
  // otherwise let the user's env decide.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (stubbed) childEnv.PCC_LINGBOT_STUB = "1";
  if (input.deviceId) childEnv.PCC_DEVICE_ID = input.deviceId;

  const spawner = _spawnerOverride ?? DEFAULT_SPAWNER;

  // Test spawner gets the outPath so it can drop a canned trace there.
  let spawnRes: { code: number; stdout: string; stderr: string };
  try {
    spawnRes = await spawnWithEnv(spawner, pythonBin, args, outPath, childEnv);
  } catch (err) {
    safeUnlink(outPath);
    throw new LingBotAdapterError(
      "spawn_failed",
      `Failed to spawn LingBot runner: ${(err as Error).message}`,
      { cmd: pythonBin, args },
    );
  }

  if (spawnRes.code !== 0) {
    safeUnlink(outPath);
    throw new LingBotAdapterError(
      "runner_exit_nonzero",
      `LingBot runner exited with code ${spawnRes.code}`,
      { stderr: spawnRes.stderr.slice(0, 2000), stdout: spawnRes.stdout.slice(0, 2000) },
    );
  }

  // Read + validate the trace.
  let raw: string;
  try {
    raw = fs.readFileSync(outPath, "utf8");
  } catch (err) {
    throw new LingBotAdapterError(
      "trace_not_written",
      `LingBot runner did not write ${outPath}: ${(err as Error).message}`,
    );
  } finally {
    safeUnlink(outPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LingBotAdapterError(
      "trace_json_invalid",
      `LingBot trace was not valid JSON: ${(err as Error).message}`,
      { snippet: raw.slice(0, 200) },
    );
  }

  const result = PointMap3DTraceSchemaExport.safeParse(parsed);
  if (!result.success) {
    throw new LingBotAdapterError(
      "trace_schema_invalid",
      "LingBot trace failed PointMap3DTraceSchema validation",
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
 * The default DEFAULT_SPAWNER ignores `outPath`/`env`; the test spawner uses
 * `outPath` to drop a canned trace. We thread `env` into the real spawn path
 * here so tests don't have to mock env handling.
 */
function spawnWithEnv(
  spawner: LingBotSpawner,
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

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* best-effort cleanup */
  }
}
