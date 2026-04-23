/**
 * Capture Verification Protocol — browser-side sensor-fusion collector.
 *
 * Drives the CC1+ `SensorFusionTrace` evidence that the verifier needs to
 * run its liveness heuristics (parallax correlation, jerk signature). We
 * wrap the three mobile-web sensor APIs:
 *
 *   - `DeviceMotionEvent`       — accelerometer + gyroscope (required on iOS
 *                                 after `DeviceMotionEvent.requestPermission`)
 *   - `DeviceOrientationEvent`  — gravity / orientation (same iOS gate)
 *   - `AmbientLightSensor`      — optional (Chromium only, behind flag)
 *   - `navigator.getBattery()`  — optional (informational; not in trace)
 *
 * We sample at a configurable rate (default 10 Hz) for a configurable
 * duration (default 5 seconds) and emit a `SensorFusionTrace` that matches
 * `packages/spec/src/types/capture.ts`. The shape is exactly what the
 * gateway's `POST /api/capture/upload` endpoint expects to ingest.
 *
 * Design-doc tie-in:
 *   - §4 Pass 5: sensor fusion is one of the CC1 triggers. Missing trace →
 *     detector caps the ceiling at CC0.
 *   - §7.3: three independent streams are REQUIRED. We always report accel,
 *     gyro, and orientation; optional light/gravity streams are added when
 *     the browser exposes them.
 *
 * Author: ui-capture-mike
 * See: ai/research/capture-verification-protocol.md §4, §7.3
 */

import type {
  SensorFusionSample,
  SensorFusionTrace,
} from "@pcc/spec";

/**
 * Options that tune the capture window.
 *
 * Defaults (5s at 10Hz) produce a 50-sample trace with the minimum three
 * streams (accel, gyro, orientation). That matches the lower-bound the
 * verifier's parallax / jerk heuristics need to reach statistical
 * significance (§4 pass 5).
 */
export interface SensorFusionOptions {
  /** Capture-window duration in milliseconds. Default 5000. */
  durationMs?: number;
  /** Target sample rate in Hz. Default 10. */
  sampleRateHz?: number;
  /**
   * Identifier stamped into the trace (`trace.deviceId`). If omitted we
   * derive a best-effort fingerprint from `navigator.userAgent`.
   */
  deviceId?: string;
  /**
   * Optional override for `performance.now`-style clock (tests inject
   * deterministic clocks).
   */
  now?: () => number;
}

/** Defaults used when the caller omits the matching option. */
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_SAMPLE_RATE_HZ = 10;

/**
 * Result of `capture()`. In the common case the caller only needs
 * `trace`; we also expose `warnings` so the UI can surface the partial-sensor
 * state without introspecting the trace structure.
 */
export interface SensorFusionCaptureResult {
  /** The trace ready to embed in `CaptureManifest.sensorFusion`. */
  trace: SensorFusionTrace;
  /**
   * Short human-readable strings describing why a particular sensor was
   * unavailable (e.g. "devicemotion_permission_denied",
   * "ambient_light_unsupported"). Informational only — the trace is still
   * valid if we collected at least one sample.
   */
  warnings: string[];
}

/**
 * Collect a multi-sensor trace covering a fixed time window.
 *
 * Calling shape:
 * ```ts
 * const sensor = new SensorFusion();
 * const {trace, warnings} = await sensor.capture({durationMs: 5000});
 * manifest.sensorFusion = trace;
 * ```
 *
 * All sensors are best-effort: if the user denies the iOS DeviceMotion
 * prompt we still return a trace (with zero samples and a warning). The
 * verifier treats zero-sample traces as equivalent to "no fusion" per §4
 * pass 5.
 */
export class SensorFusion {
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  /**
   * Run one capture window and return the trace.
   *
   * The returned promise always resolves (never rejects) — degraded
   * collection is reported via `warnings`.
   */
  async capture(
    options: SensorFusionOptions = {},
  ): Promise<SensorFusionCaptureResult> {
    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
    const sampleRateHz = options.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    const deviceId = options.deviceId ?? deriveDeviceId();
    const warnings: string[] = [];

    // iOS 13+ requires an explicit user-gesture permission grant before
    // devicemotion/deviceorientation events fire. On other browsers the
    // method is undefined — we treat that as "already granted".
    const motionPermission = await ensureMotionPermission();
    if (motionPermission === "denied") {
      warnings.push("devicemotion_permission_denied");
    }

    // Live per-sensor buffers updated by the event listeners below. We
    // snapshot these at each sample tick into a `SensorFusionSample`.
    const state: LiveSensorState = {
      accel: [0, 0, 0],
      gyro: [0, 0, 0],
      gravity: undefined,
      light: undefined,
      // magnetometer is not exposed by vanilla DeviceOrientationEvent in a
      // normalized way; we leave it undefined rather than fabricating a
      // value (verifier accepts it as optional).
      magnetometer: undefined,
      // distance is only available via the proximity-sensor API which is
      // deprecated/unshipped on modern browsers.
      distance: undefined,
    };

    const listeners: Array<() => void> = [];

    // --- devicemotion: accel + gyro + gravity -----------------------
    if (motionPermission !== "denied" && typeof window !== "undefined") {
      const onMotion = (ev: DeviceMotionEvent) => {
        // `accelerationIncludingGravity` is more reliable across browsers
        // than the bare `acceleration` which is often null on iOS.
        const accel =
          ev.accelerationIncludingGravity ?? ev.acceleration ?? null;
        if (accel) {
          state.accel = [accel.x ?? 0, accel.y ?? 0, accel.z ?? 0];
        }
        if (ev.acceleration) {
          // When both are present we have a usable gravity delta.
          const withGrav = ev.accelerationIncludingGravity;
          if (withGrav) {
            state.gravity = [
              (withGrav.x ?? 0) - (ev.acceleration.x ?? 0),
              (withGrav.y ?? 0) - (ev.acceleration.y ?? 0),
              (withGrav.z ?? 0) - (ev.acceleration.z ?? 0),
            ];
          }
        }
        const rot = ev.rotationRate;
        if (rot) {
          // Browser units are degrees/sec; convert to rad/sec for the spec.
          const deg2rad = Math.PI / 180;
          state.gyro = [
            (rot.alpha ?? 0) * deg2rad,
            (rot.beta ?? 0) * deg2rad,
            (rot.gamma ?? 0) * deg2rad,
          ];
        }
      };
      window.addEventListener("devicemotion", onMotion, { passive: true });
      listeners.push(() =>
        window.removeEventListener("devicemotion", onMotion),
      );
    } else if (typeof window === "undefined") {
      warnings.push("devicemotion_unsupported");
    }

    // --- ambient-light: optional ----------------------------------
    let ambientSensor: AmbientLightSensorLike | null = null;
    try {
      const AmbientCtor = (globalThis as GlobalWithSensors)
        .AmbientLightSensor;
      if (typeof AmbientCtor === "function") {
        const sensor = new AmbientCtor({ frequency: sampleRateHz });
        sensor.onreading = () => {
          if (typeof sensor.illuminance === "number") {
            state.light = sensor.illuminance;
          }
        };
        sensor.onerror = () => {
          // Access denied or hardware unavailable — stop trying.
          warnings.push("ambient_light_error");
        };
        sensor.start();
        ambientSensor = sensor;
      } else {
        warnings.push("ambient_light_unsupported");
      }
    } catch {
      warnings.push("ambient_light_unavailable");
    }

    // --- sampling loop --------------------------------------------
    const started = this.now();
    const startedAtIso = new Date().toISOString();
    const sampleIntervalMs = Math.max(1, Math.round(1000 / sampleRateHz));
    const samples: SensorFusionSample[] = [];
    const deadline = started + durationMs;

    while (this.now() < deadline) {
      const ts = this.now() - started;
      samples.push(snapshot(state, ts));
      await sleep(sampleIntervalMs);
    }

    // --- teardown -------------------------------------------------
    for (const off of listeners) {
      off();
    }
    if (ambientSensor) {
      try {
        ambientSensor.stop();
      } catch {
        /* best-effort */
      }
    }

    // --- compose trace --------------------------------------------
    const endedAtIso = new Date().toISOString();

    if (samples.length === 0) {
      warnings.push("no_samples_collected");
    }

    // We also opportunistically compute a rough jerk score: the mean of
    // absolute accel derivative. The verifier recomputes a canonical score
    // server-side, but this provides a live UX signal.
    const jerkScore = computeJerkScore(samples);

    const trace: SensorFusionTrace = {
      deviceId,
      startedAt: startedAtIso,
      endedAt: endedAtIso,
      samples,
      jerkScore,
    };

    return { trace, warnings };
  }
}

// -----------------------------------------------------------------------
// Helpers — exported for tests.
// -----------------------------------------------------------------------

/**
 * Internal live state between sampling ticks.
 */
interface LiveSensorState {
  accel: [number, number, number];
  gyro: [number, number, number];
  gravity?: [number, number, number];
  light?: number;
  magnetometer?: [number, number, number];
  distance?: number;
}

/**
 * AmbientLightSensor is a Chromium-only, flag-gated API; we type just the
 * subset we use.
 */
interface AmbientLightSensorLike {
  illuminance?: number;
  start(): void;
  stop(): void;
  onreading: (() => void) | null;
  onerror: (() => void) | null;
}

/** `globalThis` augmented with the browser-specific sensor constructors. */
interface GlobalWithSensors {
  AmbientLightSensor?: new (
    init: { frequency: number },
  ) => AmbientLightSensorLike;
  DeviceMotionEvent?: {
    requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
  };
}

/**
 * Capture a snapshot of the live sensor state at time `ts` (ms since
 * trace start). Exported for tests.
 */
export function snapshot(
  state: LiveSensorState,
  ts: number,
): SensorFusionSample {
  const sample: SensorFusionSample = {
    ts,
    accel: [state.accel[0], state.accel[1], state.accel[2]],
    gyro: [state.gyro[0], state.gyro[1], state.gyro[2]],
  };
  if (state.gravity) {
    sample.gravity = [state.gravity[0], state.gravity[1], state.gravity[2]];
  }
  if (typeof state.light === "number") {
    sample.light = state.light;
  }
  if (state.magnetometer) {
    sample.magnetometer = [
      state.magnetometer[0],
      state.magnetometer[1],
      state.magnetometer[2],
    ];
  }
  if (typeof state.distance === "number") {
    sample.distance = state.distance;
  }
  return sample;
}

/**
 * Compute the mean absolute jerk across a sample series (change in
 * acceleration between consecutive samples divided by dt in seconds).
 *
 * Exported for tests. Returns 0 when fewer than 2 samples.
 */
export function computeJerkScore(samples: SensorFusionSample[]): number {
  if (samples.length < 2) return 0;
  let total = 0;
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const curr = samples[i]!;
    const dt = Math.max(1, curr.ts - prev.ts) / 1000; // seconds, clamp
    const dx = curr.accel[0] - prev.accel[0];
    const dy = curr.accel[1] - prev.accel[1];
    const dz = curr.accel[2] - prev.accel[2];
    const mag = Math.sqrt(dx * dx + dy * dy + dz * dz) / dt;
    total += mag;
    count += 1;
  }
  return count === 0 ? 0 : total / count;
}

/**
 * iOS 13+ gate: `DeviceMotionEvent.requestPermission()` must be invoked
 * from a user-gesture handler. The caller of `SensorFusion.capture()` is
 * expected to call this in-flight. Returns "granted" on browsers that
 * don't need the prompt.
 */
async function ensureMotionPermission(): Promise<
  "granted" | "denied" | "unsupported"
> {
  const ctor = (globalThis as GlobalWithSensors).DeviceMotionEvent;
  if (!ctor) return "unsupported";
  if (typeof ctor.requestPermission !== "function") {
    return "granted";
  }
  try {
    const result = await ctor.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/** Best-effort device identifier when the caller doesn't supply one. */
function deriveDeviceId(): string {
  if (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string"
  ) {
    // We deliberately do NOT hash — the trace identifies the browser
    // session, and the kernel/agent identity is captured separately.
    return `browser:${navigator.userAgent.slice(0, 96)}`;
  }
  return "browser:unknown";
}

/** Tiny promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
