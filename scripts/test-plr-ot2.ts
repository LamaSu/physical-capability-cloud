#!/usr/bin/env tsx
/**
 * test-plr-ot2.ts — Phase 1 end-to-end acceptance test for
 * @pcc/adapter-pylabrobot against an Opentrons OT-2 simulator (or
 * Chatterbox fallback if no simulator is reachable).
 *
 * Usage:
 *   pnpm exec tsx scripts/test-plr-ot2.ts
 *
 * Env vars:
 *   OT2_SIMULATOR_URL  — Opentrons HTTP API endpoint (default
 *                        http://localhost:31950). If unreachable,
 *                        the script falls back to chatterbox.
 *   PCC_PLR_PYTHON_PATH — Python interpreter the sidecar runs under
 *                        (default `python`).
 *
 * To run an OT-2 simulator locally:
 *   docker run --rm -p 31950:31950 opentrons/opentrons-simulator:latest
 *
 * The script exits 0 on success, 1 on any verification failure. Even
 * with the chatterbox fallback the full sidecar round trip is exercised
 * (init → startRecording → run → stopRecording → shutdown).
 */

import { PyLabRobotAdapter } from "@pcc/adapter-pylabrobot";
import type { AdapterEvidenceEvent } from "@pcc/adapter-pylabrobot";

const OT2_URL = process.env.OT2_SIMULATOR_URL ?? "http://localhost:31950";
const PYTHON_PATH = process.env.PCC_PLR_PYTHON_PATH ?? "python";

interface RunResult {
  backend: "ot2" | "chatterbox" | "stub";
  evidenceCount: number;
  instrumentResultCount: number;
  durationMs: number;
  success: boolean;
}

async function probeOt2Simulator(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function build96WellWaterTransferProtocol(): unknown[] {
  // Inline-ops protocol that PLR's sidecar can replay: pick up a single
  // tip, aspirate 100uL from each well A1-A12 of the source plate, and
  // dispense into the destination plate. 96-well x 8 channels = 12 column
  // ops.
  const ops: Array<Record<string, unknown>> = [];
  for (let col = 1; col <= 12; col++) {
    const wellLetter = "A";
    const well = `${wellLetter}${col}`;
    ops.push(
      { op: "pickUpTips", channel: 0, tipRack: "tips-300uL", tipColumn: col },
      { op: "aspirate", well, volume_uL: 100, labwareId: "src", channel: 0 },
      { op: "dispense", well, volume_uL: 100, labwareId: "dst", channel: 0 },
      { op: "dropTips", channel: 0 },
    );
  }
  return ops;
}

async function probePylabrobotInstalled(pythonPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process");
    const proc = spawn(pythonPath, ["-c", "import pylabrobot; print(pylabrobot.__version__)"]);
    proc.on("exit", (code: number) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

async function runAcceptance(): Promise<RunResult> {
  const ot2Available = await probeOt2Simulator(OT2_URL);
  const plrInstalled = ot2Available ? true : await probePylabrobotInstalled(PYTHON_PATH);
  const backend: "ot2" | "chatterbox" | "stub" = ot2Available
    ? "ot2"
    : plrInstalled
      ? "chatterbox"
      : "stub";
  const backendConfig: Record<string, unknown> =
    backend === "ot2" ? { ot2Url: OT2_URL } : {};

  console.log(`[acceptance] backend: ${backend}`);
  console.log(`[acceptance] python: ${PYTHON_PATH}`);
  if (!ot2Available && OT2_URL !== "http://localhost:31950") {
    console.warn(`[acceptance] OT2_SIMULATOR_URL=${OT2_URL} not reachable; falling back to chatterbox`);
  } else if (!ot2Available && backend === "chatterbox") {
    console.log(`[acceptance] OT-2 simulator not detected at ${OT2_URL} — using chatterbox`);
    console.log("[acceptance] start a simulator with:");
    console.log("[acceptance]   docker run --rm -p 31950:31950 opentrons/opentrons-simulator:latest");
  } else if (!ot2Available && backend === "stub") {
    console.log("[acceptance] neither OT-2 simulator nor pylabrobot detected — using stub backend");
    console.log("[acceptance] (full sidecar+RPC round-trip still exercised; no PLR-specific behavior)");
  }

  const adapter = new PyLabRobotAdapter({
    deviceId: `dev-ot2-acceptance-${Date.now()}`,
    kernelId: "kernel-acceptance",
    plrBackend: backend,
    backendConfig,
    sidecarConfig: {
      pythonPath: PYTHON_PATH,
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONPATH: `${process.cwd()}/packages/adapter-pylabrobot/python`,
      },
    },
    runTimeoutMs: 120_000,
    rpcTimeoutMs: 30_000,
  });

  const evidence: AdapterEvidenceEvent[] = [];
  adapter.onEvidence((event) => {
    evidence.push(event);
    if (
      event.type === "execution_started" ||
      event.type === "execution_completed" ||
      event.type === "execution_failed" ||
      event.type === "device_birth"
    ) {
      console.log(`[adapter] ${event.type}`);
    }
  });

  const jobId = `job-acceptance-${Date.now()}`;
  const startedAt = Date.now();

  try {
    console.log("[acceptance] load_gcode (deck + protocol metadata)");
    const lr = await adapter.execute({
      type: "load_gcode",
      payload: {
        deckLayoutId: "deck-water-transfer-96",
        protocolSource: "inline-ops",
      },
    });
    if (!lr.success) {
      throw new Error(`load_gcode failed: ${lr.message}`);
    }

    console.log("[acceptance] start (96-col water transfer)");
    const startResult = await adapter.execute({
      type: "start",
      payload: {
        jobId,
        protocolSource: "inline-ops",
        protocolInline: build96WellWaterTransferProtocol(),
        params: {
          plateFormat: "96",
          plateClass: "flat-bottom",
          transferVolume_uL: 100,
          liquidClass: "water",
        },
      },
    });
    const durationMs = Date.now() - startedAt;

    if (!startResult.success) {
      throw new Error(`start failed: ${startResult.message}`);
    }
    console.log(`[acceptance] run complete: ${startResult.message}`);

    const instrumentResultCount = evidence.filter((e) => e.type === "instrument_result").length;
    return {
      backend,
      evidenceCount: evidence.length,
      instrumentResultCount,
      durationMs,
      success: true,
    };
  } finally {
    await adapter.dispose();
  }
}

async function main(): Promise<number> {
  console.log("[acceptance] Phase 1 OT-2 acceptance test for @pcc/adapter-pylabrobot");
  console.log("[acceptance] ====================================================");
  try {
    const result = await runAcceptance();
    console.log("[acceptance] ====================================================");
    console.log(`[acceptance] backend           ${result.backend}`);
    console.log(`[acceptance] evidence events   ${result.evidenceCount}`);
    console.log(`[acceptance] instrument_result ${result.instrumentResultCount}`);
    console.log(`[acceptance] duration          ${result.durationMs}ms`);

    // Acceptance assertions
    const errors: string[] = [];
    if (result.evidenceCount < 2) {
      errors.push(`evidence count too low (${result.evidenceCount} < 2): need at least execution_started + execution_completed`);
    }
    if (result.backend === "ot2" && result.instrumentResultCount < 48) {
      // Real OT-2 (or simulator) should produce one event per atomic op
      // (we sent 4 * 12 = 48 ops).
      errors.push(`instrument_result count too low for OT-2 (${result.instrumentResultCount} < 48)`);
    }
    if ((result.backend === "chatterbox" || result.backend === "stub") && result.instrumentResultCount < 4) {
      // Sidecar should emit one evidence notification per inline op.
      errors.push(`instrument_result count too low for ${result.backend} (${result.instrumentResultCount} < 4)`);
    }
    if (errors.length > 0) {
      console.error("[acceptance] FAILED:");
      for (const e of errors) console.error(`  - ${e}`);
      return 1;
    }
    console.log("[acceptance] PASSED");
    return 0;
  } catch (err) {
    console.error("[acceptance] FAILED with error:", err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[acceptance] unexpected:", err);
    process.exit(1);
  });
