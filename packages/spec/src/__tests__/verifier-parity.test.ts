/**
 * Parity fixtures for the EXTRACTED verifiers (evidence-vocab v1.5-industrial).
 *
 * These golden fixtures pin the behavior of the shared predicates
 * (`@pcc/spec` evidence/verifiers) byte-for-byte, so any drift in the extraction
 * is caught here in the spec package itself.
 *
 * The extraction is ALSO proven behavior-identical to the originals by the two
 * pre-existing behavioral suites, which now run against this same shared code:
 *   - gateway `src/__tests__/drift-detector.test.ts` (52 tests) — detectDrifts
 *   - kernel  `src/__tests__/log-capture.test.ts`   (25 tests) — verifyLogChain
 * This file is the spec-local pin: exact input → output for the drift envelope
 * checks, and the full chain-verification contract with a deterministic signer.
 *
 * `now`-stamped alerts (duration_mismatch, sensor_gap use `new Date()`) are
 * compared minus their timestamp (asserted ISO separately); event-stamped alerts
 * (power/temperature carry the event's own timestamp) are pinned in full.
 */

import { describe, it, expect } from "vitest";

import {
  detectDrifts,
  type TelemetryDriftAlert,
  type DriftDetectionContext,
  verifyLogChain,
  computeLogEntryHash,
  GENESIS_HASH,
  type LogChainEntryView,
} from "../evidence/verifiers/index.js";
import type { EvidenceEvent, EvidenceEventType } from "../types/evidence.js";
import type { CWMStep } from "../types/cwm.js";
import type { SHA256, Signature, Address } from "../types/common.js";

// ── Fixture builders ────────────────────────────────────────────────

const TS = "2026-01-01T00:00:00.000Z";

function ev(
  type: EvidenceEventType,
  payload: Record<string, unknown>,
  timestamp = TS,
): EvidenceEvent {
  return {
    id: `ev-${String(type)}`,
    type,
    timestamp,
    source: {
      deviceId: "d1",
      deviceType: "plc" as EvidenceEvent["source"]["deviceType"],
      kernelId: "k1",
    },
    payload,
    hash: `sha256:${"a".repeat(64)}` as SHA256,
  };
}

function step(overrides: Partial<CWMStep> = {}): CWMStep {
  return {
    id: "s1",
    capability: "3d_printing",
    params: {},
    assuranceTier: 0,
    dependsOn: [],
    ...overrides,
  } as CWMStep;
}

function omitTs(alerts: TelemetryDriftAlert[]): Omit<TelemetryDriftAlert, "timestamp">[] {
  return alerts.map(({ timestamp: _t, ...rest }) => rest);
}

const isIso = (s: string) => !Number.isNaN(Date.parse(s)) && /\dT\d/.test(s);

// ── Drift / envelope parity (powers #53 / #54) ──────────────────────

describe("parity — detectDrifts power envelope (#53)", () => {
  it("negative power → critical (event-stamped, pinned in full)", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [ev("power_profile_summary", { avgWatts: -5 })],
      assuranceTier: 0,
    };
    const power = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
    expect(power).toEqual([
      {
        type: "power_anomaly",
        severity: "critical",
        message: "Negative power reading detected (-5W) — sensor fault or data corruption.",
        expectedValue: "≥0W",
        actualValue: "-5W",
        timestamp: TS,
      },
    ]);
  });

  it("3d_printing 1000W → high, ratio 3.64 (pinned in full)", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [ev("power_profile_summary", { avgWatts: 1000 })],
      assuranceTier: 0,
      cwmStep: step({ capability: "3d_printing" }),
    };
    const power = detectDrifts(ctx).filter((a) => a.type === "power_anomaly");
    expect(power).toEqual([
      {
        type: "power_anomaly",
        severity: "high",
        message:
          "Power draw 1000W is outside normal range for 3d_printing (expected 50–500W, ratio 3.64).",
        expectedValue: "50–500W",
        actualValue: "1000W",
        timestamp: TS,
      },
    ]);
  });
});

describe("parity — detectDrifts temperature band (#53)", () => {
  it("pla 260°C → high, 60% over band (pinned in full)", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [ev("temperature_log", { temperature: 260 })],
      assuranceTier: 0,
      cwmStep: step({ params: { material: "pla" } as CWMStep["params"] }),
    };
    const temp = detectDrifts(ctx).filter((a) => a.type === "temperature_excursion");
    expect(temp).toEqual([
      {
        type: "temperature_excursion",
        severity: "high",
        message:
          "Temperature 260°C is outside the safe band [180–230°C] for pla (60% over band).",
        expectedValue: "180–230°C",
        actualValue: "260°C",
        timestamp: TS,
      },
    ]);
  });
});

describe("parity — detectDrifts duration ratio (#53, now-stamped)", () => {
  it("ran 60s vs expected 100m → critical, ratio 0.01", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [
        ev("execution_started", {}, new Date(0).toISOString()),
        ev("execution_completed", {}, new Date(60_000).toISOString()),
      ],
      assuranceTier: 0,
      cwmStep: step({ estimatedDuration: 100 }),
    };
    const dur = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
    expect(omitTs(dur)).toEqual([
      {
        type: "duration_mismatch",
        severity: "critical",
        message:
          "Execution completed in 1m but expected ~100m. Job likely did not run (ratio 0.01).",
        expectedValue: "6000s",
        actualValue: "60s",
      },
    ]);
    expect(dur.every((a) => isIso(a.timestamp))).toBe(true);
  });

  it("ran 120s vs expected 10m → high, ratio 0.20", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [
        ev("execution_started", {}, new Date(0).toISOString()),
        ev("execution_completed", {}, new Date(120_000).toISOString()),
      ],
      assuranceTier: 0,
      cwmStep: step({ estimatedDuration: 10 }),
    };
    const dur = detectDrifts(ctx).filter((a) => a.type === "duration_mismatch");
    expect(omitTs(dur)).toEqual([
      {
        type: "duration_mismatch",
        severity: "high",
        message:
          "Execution duration 2m deviates significantly from expected 10m (ratio 0.20).",
        expectedValue: "600s",
        actualValue: "120s",
      },
    ]);
  });
});

describe("parity — detectDrifts coverage gate / sensor_gap (#54, now-stamped)", () => {
  it("tier 1 missing power_profile_summary → high sensor_gap", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [ev("gcode_hash_verified", {}), ev("execution_completed", {})],
      assuranceTier: 1,
    };
    const gaps = detectDrifts(ctx).filter((a) => a.type === "sensor_gap");
    expect(omitTs(gaps)).toEqual([
      {
        type: "sensor_gap",
        severity: "high",
        message:
          "Tier 1 requires at least one of [power_profile_summary] but none were found in the evidence bundle.",
        expectedValue: "power_profile_summary",
        actualValue: "missing",
      },
    ]);
    expect(gaps.every((a) => isIso(a.timestamp))).toBe(true);
  });
});

describe("parity — detectDrifts is deterministic (pure fn)", () => {
  it("same input → same output (modulo now-timestamp)", () => {
    const ctx: DriftDetectionContext = {
      evidenceEvents: [ev("power_profile_summary", { avgWatts: 1000 })],
      assuranceTier: 1,
      cwmStep: step({ capability: "3d_printing" }),
    };
    expect(omitTs(detectDrifts(ctx))).toEqual(omitTs(detectDrifts(ctx)));
  });
});

// ── Log-chain parity (powers #52) ───────────────────────────────────

const SIGNER = "0x0000000000000000000000000000000000000001" as Address;

/** Deterministic fake signer: signature is "valid" iff value === `valid:<hash>`. */
const fakeVerify = (entryHash: SHA256, sig: Signature): boolean =>
  sig.value === `valid:${entryHash}`;

async function entry(
  id: string,
  previousHash: SHA256,
  rawContent: string,
): Promise<LogChainEntryView> {
  const source = "cups://job-1";
  const capturedAt = TS;
  const entryHash = await computeLogEntryHash(rawContent, source, capturedAt);
  return {
    entryId: id,
    entryHash,
    previousHash,
    rawContent,
    source,
    capturedAt,
    kernelSignature: { signer: SIGNER, algorithm: "secp256k1", value: `valid:${entryHash}` },
  };
}

/** Build a well-formed N-entry chain (genesis-linked, valid signatures). */
async function chain(...contents: string[]): Promise<LogChainEntryView[]> {
  const entries: LogChainEntryView[] = [];
  let prev = GENESIS_HASH;
  let i = 0;
  for (const c of contents) {
    const e = await entry(`e${i++}`, prev, c);
    entries.push(e);
    prev = e.entryHash;
  }
  return entries;
}

describe("parity — verifyLogChain (#52)", () => {
  it("intact chain verifies valid", async () => {
    const res = await verifyLogChain(await chain("l1", "l2", "l3"), fakeVerify);
    expect(res).toEqual({ valid: true, entries: 3, brokenAt: undefined, errors: [] });
  });

  it("empty chain is vacuously valid", async () => {
    const res = await verifyLogChain([], fakeVerify);
    expect(res).toEqual({ valid: true, entries: 0, brokenAt: undefined, errors: [] });
  });

  it("tampered rawContent → entryHash mismatch at 0", async () => {
    const entries = await chain("original", "second");
    entries[0]!.rawContent = "TAMPERED"; // hash no longer matches recompute
    const res = await verifyLogChain(entries, fakeVerify);
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(0);
    expect(res.errors.some((e) => e.includes("entryHash mismatch"))).toBe(true);
  });

  it("broken previousHash → chain link broken at 1", async () => {
    const entries = await chain("l1", "l2");
    entries[1]!.previousHash = `sha256:${"f".repeat(64)}` as SHA256;
    const res = await verifyLogChain(entries, fakeVerify);
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(1);
    expect(res.errors.some((e) => e.includes("chain link broken"))).toBe(true);
  });

  it("first entry not genesis-linked → chain link broken at 0", async () => {
    const entries = await chain("l1");
    entries[0]!.previousHash = `sha256:${"b".repeat(64)}` as SHA256;
    const res = await verifyLogChain(entries, fakeVerify);
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(0);
    expect(res.errors.some((e) => e.includes("chain link broken"))).toBe(true);
  });

  it("invalid signature → kernel signature invalid", async () => {
    const entries = await chain("l1");
    entries[0]!.kernelSignature = { signer: SIGNER, algorithm: "secp256k1", value: "0xgarbage" };
    const res = await verifyLogChain(entries, fakeVerify);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("kernel signature invalid"))).toBe(true);
  });
});
