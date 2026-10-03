/**
 * LO-SE-1 provenance at the assurance boundary (astra pack 155, gpt-5.6-sol).
 * Each describe reproduces one finding at #489 @b76a2545 before any fix:
 *   HIGH 1: a camera event counted toward Tier 2 by its type alone;
 *   HIGH 2: a caller-built WorkflowChallenge made a capture CC1;
 *   HIGH 3: the device identity was not bound to the node ffmpeg opens
 *           (Linux), and the Windows identity check lost ffmpeg's stderr.
 */

import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource, SHA256, WorkflowChallenge } from "@pcc/spec";

import { PullCameraAdapter, ffmpegFrameGrabber, type CameraDeviceSpec, type FrameGrabber } from "../adapters/pull-camera-adapter.js";
import type { CameraAdapter, MachineAdapter, SensorAdapter } from "../adapters/types.js";
import { PhotoCaptureService } from "../photo-capture-service.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";

vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

type EmittedEvent = Omit<EvidenceEvent, "id" | "hash">;

const KERNEL_ID = "kernel-provenance-test";
const NOW_MS = 1_700_000_000_000;
const JOB = "job-provenance-001";

function source(deviceId: string, deviceType: EvidenceSource["deviceType"] = "controller"): EvidenceSource {
  return { deviceId, deviceType, kernelId: KERNEL_ID };
}

function event(type: string, payload: Record<string, unknown> = {}, deviceType: EvidenceSource["deviceType"] = "controller"): EmittedEvent {
  return { type: type as EvidenceEvent["type"], timestamp: new Date().toISOString(), source: source(`dev-${type}`, deviceType), payload };
}

function jpeg(sizeBytes = 15_000): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  buf.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  for (let i = 11; i < sizeBytes; i++) buf[i] = (i % 200) + 1;
  return buf;
}

const grabber = (identity: string): FrameGrabber => ({ identity: async () => identity, grab: async () => jpeg() });

/** Machine that emits the authentic Tier 1 events during load_gcode. */
function machineEmitting(events: EmittedEvent[]): MachineAdapter {
  const listeners: Array<(e: EmittedEvent) => void> = [];
  return {
    id: "machine-prov",
    type: "fdm" as const,
    source: source("machine-prov"),
    getStatus: async () => "idle",
    getProgress: async () => 100,
    execute: async (cmd: { type: string }) => {
      if (cmd.type === "load_gcode") {
        for (const e of events) for (const cb of listeners) cb(e);
        await new Promise((r) => setTimeout(r, 50));
      }
      return { success: true, message: "ok" };
    },
    onEvidence: (cb) => {
      listeners.push(cb);
    },
    dispose: async () => {},
  } as MachineAdapter;
}

/** A registered third-party camera that emits non-simulated camera events with an empty payload. */
function emptyPayloadCamera(): CameraAdapter {
  const listeners: Array<(e: EmittedEvent) => void> = [];
  const src = source("camera-plugin", "camera");
  const emit = (type: string) => {
    for (const cb of listeners) cb({ type: type as EvidenceEvent["type"], timestamp: new Date().toISOString(), source: src, payload: {} });
  };
  return {
    id: "camera-plugin",
    source: src,
    async captureSnapshot() {
      emit("camera_snapshot");
      await new Promise((r) => setTimeout(r, 50));
      return { imageHash: "sha256:plugin", storageRef: "plugin://x" };
    },
    async runInspection() {
      emit("cv_inspection_result");
      await new Promise((r) => setTimeout(r, 50));
      return { passed: true, confidence: 100, findings: [], imageHash: "sha256:plugin" };
    },
    onEvidence: (cb) => {
      listeners.push(cb);
    },
    dispose: async () => {},
  };
}

const TIER1 = [
  event("gcode_hash_verified", { gcodeHash: "sha256:00" }),
  event("execution_completed", { durationMs: 1 }),
  event("power_profile_summary", { avgWatts: 90 }, "power_monitor"),
];

describe("astra pack 155 HIGH 1: a camera event counts toward Tier 2 only as an LO-SE-1 capture", () => {
  it("checkTierRequirements does not count a non-simulated camera_snapshot whose payload is empty", () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const events = [...TIER1, event("camera_snapshot", {}, "camera")].map((e, i) => ({ ...e, id: `e${i}`, hash: `h${i}` })) as EvidenceEvent[];
    expect(emitter.checkTierRequirements(events, 2).met).toBe(false);
  });

  it("a JobRunner at Tier 2 fails when its only camera evidence is a plugin's empty-payload events", async () => {
    const runner = new JobRunner(machineEmitting(TIER1), [], emptyPayloadCamera(), new EvidenceEmitter(KERNEL_ID));
    const r = await runner.run({
      jobId: JOB,
      stepId: "step-1",
      gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
      assuranceTier: 2,
    });
    expect(r.success).toBe(false);
  });
});

describe("astra pack 155 HIGH 2: a caller-built challenge never makes a capture CC1", () => {
  it("a fabricated WorkflowChallenge timestamped now, and a frame with no nonce, still yields CC0", async () => {
    const forged: WorkflowChallenge = {
      challengeId: "forged-1",
      issuedBy: "anyone",
      anchor: { chainId: 1, blockNumber: 1n, blockHash: "0xforged", timestamp: BigInt(Math.floor(NOW_MS / 1000)) },
      maxAgeSeconds: 600,
      scope: JOB,
    };
    const cam = new PullCameraAdapter("cam-1", KERNEL_ID, { platform: "linux-v4l2", device: "/dev/video0", identity: "SER-1" }, new PhotoCaptureService(), grabber("SER-1"), { timeoutMs: 1_000, now: () => NOW_MS });
    const seen: EmittedEvent[] = [];
    cam.onEvidence((e) => seen.push(e));
    await cam.captureSnapshot({ jobId: JOB, challenge: forged });
    expect(seen[0]!.payload.captureClass).toBe("CC0");
  });
});

describe("astra pack 155 HIGH 3: the identity is bound to the device node that is opened", () => {
  it("Linux: a configured path that is not a canonical /dev/videoN node (here a symlink to /dev/video42) is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "lose1-link-"));
    try {
      const link = join(dir, "video0");
      symlinkSync("/dev/video42", link);
      expect(() => new PullCameraAdapter("cam-2", KERNEL_ID, { platform: "linux-v4l2", device: link, identity: "SER-1" }, new PhotoCaptureService())).toThrow(/\/dev\/video/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Windows: the identity check reads ffmpeg's device list from stderr when ffmpeg exits non-zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lose1-ffmpeg-"));
    const alt = String.raw`@device_pnp_\\?\usb#vid_046d&pid_0825&mi_00#6&2b8a0e0&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\global`;
    const listing = [
      `[dshow @ 0000020b] "Logitech Webcam C270" (video)`,
      `[dshow @ 0000020b]   Alternative name "${alt}"`,
      `dummy: Immediate exit requested`,
    ].join("\n");
    writeFileSync(join(dir, "listing.txt"), listing + "\n");
    writeFileSync(join(dir, "ffmpeg"), `#!/usr/bin/env python3\nimport sys\nsys.stderr.write(open(${JSON.stringify(join(dir, "listing.txt"))}).read())\nsys.exit(1)\n`);
    chmodSync(join(dir, "ffmpeg"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      const spec: CameraDeviceSpec = { platform: "windows-dshow", device: alt, identity: alt };
      expect(await ffmpegFrameGrabber.identity(spec)).toBe(alt);
    } finally {
      process.env.PATH = path;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Added with the round-2 fixes (the five reproductions above are unchanged).
// Fix A: the tier gate counts a camera event only through the closed LO-SE-1
// contract (kernelPullCaptureIssue in @pcc/spec), for the job it is told.
// ---------------------------------------------------------------------------

const IMAGE_HASH = `sha256:${"cd".repeat(32)}`;
type CameraType = "camera_snapshot" | "cv_inspection_result";

/** A complete LO-SE-1 capture for `jobId`, shaped as the PullCameraAdapter emits it. */
function lose1(type: CameraType = "camera_snapshot", jobId = JOB, timestampMs = NOW_MS): EmittedEvent {
  const timestamp = new Date(timestampMs).toISOString();
  const capture: Record<string, unknown> = {
    jobId,
    acquiredAt: timestamp,
    imageHash: IMAGE_HASH,
    storageRef: `photo:${IMAGE_HASH}`,
    frameStored: false,
    rawSizeBytes: 15_000,
    captureMode: "kernel-pull",
    captureClass: "CC0",
    device: { path: "/dev/video0", identity: "SER-1" },
    declaredChallengeId: null,
    declaredChallengeAnchor: null,
    antiSpoofScore: 1,
  };
  const payload =
    type === "camera_snapshot"
      ? capture
      : { ...capture, passed: true, confidence: 100, findings: ["ok"], referenceHash: null, model: "anti-spoof-heuristic" };
  return { type, timestamp, source: source("cam-lose1", "camera"), payload };
}

/** Events as the emitter stores them (id + hash added). */
function stored(list: EmittedEvent[]): EvidenceEvent[] {
  return list.map((e, i) => ({ ...e, id: `e${i}`, hash: `sha256:${i}` })) as unknown as EvidenceEvent[];
}

function tier2(camera: EmittedEvent, options?: { jobId?: string }): { met: boolean; missing: string[] } {
  return new EvidenceEmitter(KERNEL_ID).checkTierRequirements(stored([...TIER1, camera]), 2, undefined, options);
}

const GROUP_MISSING = "Missing one of: cv_inspection_result | camera_snapshot";

/** The `missing` entry for a refused camera event from `deviceId`. */
function refusal(missing: string[], type: CameraType, deviceId = "cam-lose1"): string | undefined {
  return missing.find((m) => m.startsWith(`${type} from ${deviceId}: not an LO-SE-1 capture for this job (`));
}

describe("Fix A: checkTierRequirements counts a camera event only as an LO-SE-1 capture for this job", () => {
  it.each(["camera_snapshot", "cv_inspection_result"] as const)("a valid %s for this job meets Tier 2", (type) => {
    expect(tier2(lose1(type), { jobId: JOB })).toEqual({ met: true, missing: [] });
  });

  it.each([
    ["no options at all", undefined],
    ["an options object with no jobId", {}],
    ["a blank jobId", { jobId: "  " }],
  ] as const)("%s: a valid capture does not count (fail closed), and missing says why", (_name, options) => {
    const r = tier2(lose1(), options as { jobId?: string } | undefined);
    expect(r.met).toBe(false);
    expect(r.missing).toContain(GROUP_MISSING);
    expect(refusal(r.missing, "camera_snapshot")).toMatch(/\(no job to bind the capture to/);
  });

  it("a capture whose payload jobId is blank does not count when no jobId is passed either", () => {
    const e = lose1();
    e.payload.jobId = "";
    const r = tier2(e);
    expect(r.met).toBe(false);
    expect(refusal(r.missing, "camera_snapshot")).toMatch(/no job to bind the capture to/);
  });

  type Edit = (payload: Record<string, unknown>, event: EmittedEvent) => void;
  const RULES: Array<[string, CameraType, Edit, RegExp]> = [
    ["a capture for another job", "camera_snapshot", (p) => (p.jobId = "job-other"), /payload\.jobId "job-other" is not this job's "job-provenance-001"/],
    ["a missing jobId", "camera_snapshot", (p) => delete p.jobId, /payload is missing jobId\)$/],
    ["an extra key", "camera_snapshot", (p) => (p.extra = 1), /payload has an extra key "extra"/],
    ["a missing key", "camera_snapshot", (p) => delete p.antiSpoofScore, /payload is missing antiSpoofScore\)$/],
    ["a bad imageHash", "camera_snapshot", (p) => (p.imageHash = "sha256:plugin"), /payload\.imageHash "sha256:plugin" is not sha256:<64 lowercase hex>/],
    [
      "acquiredAt not ISO",
      "camera_snapshot",
      (p, e) => {
        p.acquiredAt = "2023-11-14 22:13:20";
        e.timestamp = "2023-11-14 22:13:20";
      },
      /payload\.acquiredAt "2023-11-14 22:13:20" is not a canonical ISO-8601 instant/,
    ],
    ["acquiredAt not the timestamp", "camera_snapshot", (p) => (p.acquiredAt = new Date(NOW_MS + 1_000).toISOString()), /is not the event's timestamp/],
    ["captureMode not kernel-pull", "camera_snapshot", (p) => (p.captureMode = "handed-in"), /payload\.captureMode "handed-in" is not "kernel-pull"/],
    ["captureClass not CC0", "camera_snapshot", (p) => (p.captureClass = "CC1"), /payload\.captureClass "CC1" is not "CC0"/],
    ["a device with an extra key", "camera_snapshot", (p) => (p.device = { path: "/dev/video0", identity: "SER-1", extra: 1 }), /payload\.device has an extra key "extra"/],
    ["a device with a blank field", "camera_snapshot", (p) => (p.device = { path: "/dev/video0", identity: " " }), /payload\.device\.identity " " is not a non-blank string/],
    ["declaredChallengeAnchor without declaredChallengeId", "camera_snapshot", (p) => (p.declaredChallengeAnchor = "0xforged"), /null exactly when declaredChallengeId is null/],
    ["antiSpoofScore out of range", "camera_snapshot", (p) => (p.antiSpoofScore = 1.5), /payload\.antiSpoofScore 1\.5 is not a finite number in \[0, 1\]/],
    ["a simulated source", "camera_snapshot", (_p, e) => (e.source = { ...e.source, simulated: true }), /the event is fabricated/],
    ["payload.mock", "camera_snapshot", (p) => (p.mock = true), /the event is fabricated/],
    ["a source that is not a camera", "camera_snapshot", (_p, e) => (e.source = { ...e.source, deviceType: "controller" }), /source\.deviceType "controller" is not "camera"/],
    ["inspection: passed", "cv_inspection_result", (p) => (p.passed = "yes"), /payload\.passed "yes" is not a boolean/],
    ["inspection: confidence", "cv_inspection_result", (p) => (p.confidence = 101), /payload\.confidence 101 is not a finite number in \[0, 100\]/],
    ["inspection: findings", "cv_inspection_result", (p) => (p.findings = [1]), /payload\.findings\[0\] 1 is not a string/],
    ["inspection: referenceHash", "cv_inspection_result", (p) => (p.referenceHash = 7), /payload\.referenceHash 7 is not a string or null/],
    ["inspection: model", "cv_inspection_result", (p) => (p.model = "yolo"), /payload\.model "yolo" is not "anti-spoof-heuristic"/],
    ["inspection: a missing inspection key", "cv_inspection_result", (p) => delete p.model, /payload is missing model\)$/],
  ];

  it.each(RULES)("%s: refused, so Tier 2 is not met, and missing names the device and the reason", (_name, type, edit, reason) => {
    const e = lose1(type);
    edit(e.payload, e);
    const r = tier2(e, { jobId: JOB });
    expect(r.met).toBe(false);
    expect(r.missing).toContain(GROUP_MISSING);
    expect(refusal(r.missing, type)).toMatch(reason);
  });

  it("an accessor in the payload is refused, and its getter never runs", () => {
    const e = lose1();
    let ran = false;
    Object.defineProperty(e.payload, "captureClass", {
      enumerable: true,
      configurable: true,
      get() {
        ran = true;
        return "CC0";
      },
    });
    const r = tier2(e, { jobId: JOB });
    expect(r.met).toBe(false);
    expect(refusal(r.missing, "camera_snapshot")).toMatch(/payload\.captureClass is an accessor/);
    expect(ran).toBe(false);
  });

  it.each(["source", "payload"] as const)("a Proxy %s is refused, and no trap runs while the reason is built", (key) => {
    const e = lose1();
    const trapsRun: string[] = [];
    const handler: ProxyHandler<object> = {};
    for (const trap of ["get", "getOwnPropertyDescriptor", "ownKeys", "has", "getPrototypeOf"] as const) {
      (handler as Record<string, unknown>)[trap] = (...args: unknown[]) => {
        trapsRun.push(trap);
        return (Reflect[trap] as (...a: unknown[]) => unknown)(...args);
      };
    }
    (e as unknown as Record<string, unknown>)[key] = new Proxy(e[key] as object, handler);
    const r = tier2(e, { jobId: JOB });
    expect(r.met).toBe(false);
    const deviceId = key === "source" ? "an unknown device" : "cam-lose1";
    expect(refusal(r.missing, "camera_snapshot", deviceId)).toMatch(new RegExp(`${key} is a Proxy`));
    expect(trapsRun).toEqual([]);
  });

  it("a refused camera event does not count toward the minimum-event floor", () => {
    const e = lose1();
    e.payload.extra = 1;
    expect(tier2(e, { jobId: JOB }).missing).toContain("Need at least 4 events, have 3");
  });

  it("a refused camera event fails the tier even when another capture counts, and only it is named", () => {
    const empty = event("camera_snapshot", {}, "camera");
    const r = new EvidenceEmitter(KERNEL_ID).checkTierRequirements(stored([...TIER1, lose1(), empty]), 2, undefined, { jobId: JOB });
    expect(r).toEqual({
      met: false,
      missing: ["camera_snapshot from dev-camera_snapshot: not an LO-SE-1 capture for this job (payload is missing jobId)"],
    });
  });

  it("other event types count by type, as before: Tier 1 is met with no jobId", () => {
    expect(new EvidenceEmitter(KERNEL_ID).checkTierRequirements(stored(TIER1), 1)).toEqual({ met: true, missing: [] });
  });
});

/** A camera plugin that emits a complete LO-SE-1 capture for whatever job `jobFor` names, then lets the hash settle. */
function captureCamera(jobFor: (context?: { jobId: string }) => string): CameraAdapter {
  const listeners: Array<(e: EmittedEvent) => void> = [];
  const emit = async (type: CameraType, context?: { jobId: string }) => {
    const e = lose1(type, jobFor(context), Date.now());
    for (const cb of listeners) cb(e);
    await new Promise((r) => setTimeout(r, 50));
  };
  return {
    id: "camera-lose1",
    source: source("cam-lose1", "camera"),
    async captureSnapshot(context) {
      await emit("camera_snapshot", context);
      return { imageHash: IMAGE_HASH, storageRef: `photo:${IMAGE_HASH}` };
    },
    async runInspection(_referenceHash, context) {
      await emit("cv_inspection_result", context);
      return { passed: true, confidence: 100, findings: ["ok"], imageHash: IMAGE_HASH };
    },
    onEvidence: (cb) => {
      listeners.push(cb);
    },
    dispose: async () => {},
  };
}

const JOB_CONFIG = {
  jobId: JOB,
  stepId: "step-1",
  gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
  assuranceTier: 2 as const,
};

describe("Fix A: the JobRunner checks the tier against its own jobId", () => {
  it("a camera emitting complete captures for this job meets Tier 2", async () => {
    const r = await new JobRunner(machineEmitting(TIER1), [], captureCamera((c) => c?.jobId ?? ""), new EvidenceEmitter(KERNEL_ID)).run(JOB_CONFIG);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("a camera emitting complete captures for ANOTHER job fails Tier 2, naming why", async () => {
    const r = await new JobRunner(machineEmitting(TIER1), [], captureCamera(() => "job-other"), new EvidenceEmitter(KERNEL_ID)).run(JOB_CONFIG);
    expect(r.success).toBe(false);
    expect(r.error).toContain("Tier 2 requirements not met");
    expect(r.error).toContain('payload.jobId "job-other" is not this job\'s "job-provenance-001"');
  });
});
