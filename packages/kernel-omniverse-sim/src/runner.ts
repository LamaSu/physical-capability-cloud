/**
 * Sim runner — spawns a headless Omniverse Kit Python process that loads
 * the lab USD scene, replays a MADSci workflow against simulated robots,
 * and returns a SimRunResult.
 *
 * Status: shells out to a Python helper at `python/omniverse_sim_runner.py`
 * in this package. The helper is a *stub* that produces deterministic
 * fake results when Omniverse is unavailable (returns verdict="pass" with
 * a synthetic trace), and runs the real Kit pipeline when
 * OMNIVERSE_AVAILABLE=1 is set in env. Replace the stub with PRISM's
 * Stage 2 sim core when the assets are wired up.
 *
 * The runner exposes `detectCapabilities()` so the kernel manifest can
 * advertise honest tier support.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimRunResult, SimRunnerCapabilities } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_HELPER = path.resolve(
  __dirname,
  "..",
  "python",
  "omniverse_sim_runner.py",
);

export interface RunnerOptions {
  /** Python interpreter to spawn. Defaults to "python". */
  python?: string;
  /** Override the helper script path (for tests). */
  helperPath?: string;
  /** Max wall-clock for the sim before SIGTERM. Defaults to 5min. */
  timeoutMs?: number;
  /** Env vars to pass through. Defaults to inheriting process.env. */
  env?: NodeJS.ProcessEnv;
}

export async function detectCapabilities(
  opts: RunnerOptions = {},
): Promise<SimRunnerCapabilities> {
  const python = opts.python ?? "python";
  const helperPath = opts.helperPath ?? PYTHON_HELPER;

  try {
    await fs.access(helperPath);
  } catch {
    return {
      available: false,
      gpuRtx: false,
      unavailableReason: `helper script missing at ${helperPath}`,
    };
  }

  return new Promise((resolve) => {
    const proc = spawn(python, [helperPath, "--detect"], {
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", (e) =>
      resolve({
        available: false,
        gpuRtx: false,
        unavailableReason: `spawn failed: ${e.message}`,
      }),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({
          available: false,
          gpuRtx: false,
          unavailableReason: err.slice(0, 500) || `exit ${code}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(out.trim()) as SimRunnerCapabilities;
        resolve(parsed);
      } catch {
        resolve({
          available: false,
          gpuRtx: false,
          unavailableReason: "helper returned invalid JSON",
        });
      }
    });
  });
}

export async function runSim(
  workflow: MadsciWorkflow,
  opts: RunnerOptions = {},
): Promise<SimRunResult> {
  const python = opts.python ?? "python";
  const helperPath = opts.helperPath ?? PYTHON_HELPER;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const proc = spawn(python, [helperPath, "--run"], {
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let out = "";
    let err = "";
    const killTimer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);

    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(
          new Error(
            `omniverse_sim_runner exited ${code}: ${err.slice(0, 500)}`,
          ),
        );
        return;
      }
      try {
        const parsed = JSON.parse(out.trim()) as SimRunResult;
        resolve(parsed);
      } catch (e) {
        reject(new Error(`invalid JSON from runner: ${(e as Error).message}`));
      }
    });

    proc.stdin.write(JSON.stringify(workflow));
    proc.stdin.end();
  });
}
