/**
 * Tests for PullCameraAdapter (LO-SE-1): the kernel acquires every camera
 * frame itself, from the configured device, for a named job. A camera event
 * can therefore never be made from bytes someone handed in.
 *
 * Also covers:
 *   - the "photo" registration in adapter-factory.ts (createCameraAdapter)
 *   - the push-fed PhotoCameraAdapter, which stays simulated-only
 *   - the camera call sites in JobRunner (before-snapshot + CV inspection)
 *
 * A FAKE FrameGrabber (identity()/grab()) and an injected `now` are used
 * throughout — no real ffmpeg is ever invoked.
 */

import { describe, it, expect, vi } from "vitest";
import type { EvidenceEvent, EvidenceSource, SHA256, WorkflowChallenge } from "@pcc/spec";
import { isFabricated, kernelPullCaptureIssue } from "@pcc/spec";

import {
  PullCameraAdapter,
  type CameraDeviceSpec,
  type FrameGrabber,
} from "../adapters/pull-camera-adapter.js";
import type { CaptureContext, MachineAdapter, CameraAdapter } from "../adapters/types.js";
import { PhotoCameraAdapter } from "../adapters/photo-camera-adapter.js";
import { PhotoCaptureService } from "../photo-capture-service.js";
import { createCameraAdapter } from "../adapter-factory.js";
import type { DeviceConfig } from "../kernel-config.js";
import { EvidenceEmitter } from "../evidence-emitter.js";
import { JobRunner } from "../job-runner.js";

// Mock Sentry so JobRunner tests (bottom of file) never hit the network.
vi.mock("@sentry/node", () => ({
  startSpan: vi.fn().mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
}));

type EmittedEvent = Omit<EvidenceEvent, "id" | "hash">;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KERNEL_ID = "kernel-pull-cam-test";
const FIXED_NOW_MS = 1_700_000_000_000; // fixed clock injected via options.now

const DEVICE: CameraDeviceSpec = {
  platform: "linux-v4l2",
  device: "/dev/video0",
  identity: "USB-SERIAL-001",
};

/**
 * Minimal valid JPEG: SOI (FF D8) + APP0 (FF E0) + a JFIF tail, padded past
 * the 10KB size-plausibility floor so PhotoCaptureService's checks pass.
 */
function makeJpegFrame(sizeBytes = 15_000): Uint8Array {
  const buf = new Uint8Array(sizeBytes);
  buf[0] = 0xff; buf[1] = 0xd8; // SOI
  buf[2] = 0xff; buf[3] = 0xe0; // APP0 marker start
  buf[4] = 0x00; buf[5] = 0x10; // APP0 length = 16
  buf[6] = 0x4a; buf[7] = 0x46; buf[8] = 0x49; buf[9] = 0x46; buf[10] = 0x00; // "JFIF\0"
  for (let i = 11; i < sizeBytes; i++) buf[i] = (i % 200) + 1;
  return buf;
}

interface FakeGrabber extends FrameGrabber {
  grabCalls: CameraDeviceSpec[];
  identityCalls: CameraDeviceSpec[];
}

/** A fake FrameGrabber: records every call, never touches real hardware. */
function makeFakeGrabber(
  opts: {
    identity?: string | null;
    frame?: Uint8Array;
    grabImpl?: () => Promise<Uint8Array>;
  } = {},
): FakeGrabber {
  const grabCalls: CameraDeviceSpec[] = [];
  const identityCalls: CameraDeviceSpec[] = [];
  return {
    grabCalls,
    identityCalls,
    async identity(device) {
      identityCalls.push(device);
      return opts.identity === undefined ? DEVICE.identity : opts.identity;
    },
    async grab(device) {
      grabCalls.push(device);
      if (opts.grabImpl) return opts.grabImpl();
      return opts.frame ?? makeJpegFrame();
    },
  };
}

function collect(adapter: { onEvidence(cb: (e: EmittedEvent) => void): void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  adapter.onEvidence((e) => events.push(e));
  return events;
}

/** A PullCameraAdapter wired to a fake grabber and a fixed clock. */
function makeAdapter(
  opts: {
    grabber?: FakeGrabber;
    device?: CameraDeviceSpec;
    photoCaptureService?: PhotoCaptureService;
    nowMs?: number;
  } = {},
): {
  adapter: PullCameraAdapter;
  grabber: FakeGrabber;
  events: EmittedEvent[];
  photoCaptureService: PhotoCaptureService;
} {
  const grabber = opts.grabber ?? makeFakeGrabber();
  const photoCaptureService = opts.photoCaptureService ?? new PhotoCaptureService();
  const nowMs = opts.nowMs ?? FIXED_NOW_MS;
  const adapter = new PullCameraAdapter(
    "cam-pull-01",
    KERNEL_ID,
    opts.device ?? DEVICE,
    photoCaptureService,
    grabber,
    { timeoutMs: 5_000, now: () => nowMs },
  );
  const events = collect(adapter);
  return { adapter, grabber, events, photoCaptureService };
}

/** Builds a WorkflowChallenge whose anchor timestamp (seconds, bigint) is `ageSeconds` old relative to `nowMs`. */
function makeChallenge(opts: {
  jobId: string;
  challengeId?: string;
  ageSeconds?: number;
  maxAgeSeconds?: number;
  scope?: string;
  nowMs?: number;
}): WorkflowChallenge {
  const nowMs = opts.nowMs ?? FIXED_NOW_MS;
  const issuedAtSeconds = Math.floor(nowMs / 1000) - (opts.ageSeconds ?? 0);
  return {
    challengeId: opts.challengeId ?? "challenge-abc-123",
    issuedBy: "kernel-test-issuer",
    anchor: {
      chainId: 1,
      blockNumber: 12_345n,
      blockHash: "0xblockhash0123456789",
      timestamp: BigInt(issuedAtSeconds),
    },
    maxAgeSeconds: opts.maxAgeSeconds ?? 600,
    scope: opts.scope ?? opts.jobId,
  };
}

// ---------------------------------------------------------------------------
// 1. Construction
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — construction", () => {
  const svc = new PhotoCaptureService();

  it("refuses a missing platform", () => {
    expect(
      () => new PullCameraAdapter("c1", KERNEL_ID, { ...DEVICE, platform: "" as CameraDeviceSpec["platform"] }, svc),
    ).toThrow(/capture\.platform is required configuration/);
  });

  it("refuses a missing device path", () => {
    expect(() => new PullCameraAdapter("c1", KERNEL_ID, { ...DEVICE, device: "" }, svc)).toThrow(
      /capture\.device is required configuration/,
    );
  });

  it("refuses a missing identity", () => {
    expect(() => new PullCameraAdapter("c1", KERNEL_ID, { ...DEVICE, identity: "" }, svc)).toThrow(
      /capture\.identity is required configuration/,
    );
  });

  it("refuses an invalid platform", () => {
    expect(
      () =>
        new PullCameraAdapter(
          "c1",
          KERNEL_ID,
          { ...DEVICE, platform: "macos-avfoundation" as CameraDeviceSpec["platform"] },
          svc,
        ),
    ).toThrow(/not linux-v4l2 or windows-dshow/);
  });
});

// ---------------------------------------------------------------------------
// 2. CaptureContext required
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — CaptureContext required", () => {
  it("captureSnapshot with no context throws, emits nothing, never calls grab()", async () => {
    const { adapter, events, grabber } = makeAdapter();
    await expect(adapter.captureSnapshot()).rejects.toThrow(/needs the job it is for/);
    expect(events).toHaveLength(0);
    expect(grabber.grabCalls).toHaveLength(0);
    expect(grabber.identityCalls).toHaveLength(0);
  });

  it("captureSnapshot with a blank jobId throws, emits nothing, never calls grab()", async () => {
    const { adapter, events, grabber } = makeAdapter();
    await expect(adapter.captureSnapshot({ jobId: "   " })).rejects.toThrow(/needs the job it is for/);
    expect(events).toHaveLength(0);
    expect(grabber.grabCalls).toHaveLength(0);
    expect(grabber.identityCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Identity check
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — identity check", () => {
  it("a mismatched identity throws, naming both the presented and configured values", async () => {
    const grabber = makeFakeGrabber({ identity: "WRONG-SERIAL" });
    const { adapter, events } = makeAdapter({ grabber });
    await expect(adapter.captureSnapshot({ jobId: "job-id-mismatch" })).rejects.toThrow(
      /presents identity "WRONG-SERIAL", not the configured "USB-SERIAL-001"/,
    );
    expect(events).toHaveLength(0);
    expect(grabber.grabCalls).toHaveLength(0);
  });

  it("a null identity throws", async () => {
    const grabber = makeFakeGrabber({ identity: null });
    const { adapter, events } = makeAdapter({ grabber });
    await expect(adapter.captureSnapshot({ jobId: "job-id-null" })).rejects.toThrow(
      /presents identity null, not the configured "USB-SERIAL-001"/,
    );
    expect(events).toHaveLength(0);
    expect(grabber.grabCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Frame validity
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — frame validity", () => {
  it("grab() returning an empty Uint8Array throws, no event is emitted", async () => {
    const grabber = makeFakeGrabber({ frame: new Uint8Array(0) });
    const { adapter, events } = makeAdapter({ grabber });
    await expect(adapter.captureSnapshot({ jobId: "job-empty-frame" })).rejects.toThrow(/returned no frame/);
    expect(events).toHaveLength(0);
  });

  it("grab() throwing propagates, no event is emitted", async () => {
    const boom = new Error("ffmpeg exploded");
    const grabber = makeFakeGrabber({
      grabImpl: async () => {
        throw boom;
      },
    });
    const { adapter, events } = makeAdapter({ grabber });
    await expect(adapter.captureSnapshot({ jobId: "job-grab-throws" })).rejects.toThrow(/ffmpeg exploded/);
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Happy path — exactly one camera_snapshot
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — captureSnapshot happy path", () => {
  it("emits exactly one camera_snapshot with the expected payload shape", async () => {
    const jobId = "job-happy-001";
    const frame = makeJpegFrame();
    const grabber = makeFakeGrabber({ frame });
    const { adapter, events, photoCaptureService } = makeAdapter({ grabber });

    const result = await adapter.captureSnapshot({ jobId });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("camera_snapshot");

    const expectedIso = new Date(FIXED_NOW_MS).toISOString();
    expect(event.timestamp).toBe(expectedIso);
    expect(event.payload.acquiredAt).toBe(expectedIso);
    expect(event.payload.jobId).toBe(jobId);

    // imageHash must equal what PhotoCaptureService independently computes for the same bytes.
    const independentlyComputed = await photoCaptureService.capture(frame);
    expect(event.payload.imageHash).toBe(independentlyComputed.imageHash);
    expect(result.imageHash).toBe(independentlyComputed.imageHash);

    expect(event.payload.captureMode).toBe("kernel-pull");
    expect(event.payload.captureClass).toBe("CC0");
    // astra pack 155 HIGH 2: the challenge fields are declarations, renamed from challengeId/challengeAnchor.
    expect(event.payload.declaredChallengeId).toBeNull();
    expect(event.payload.declaredChallengeAnchor).toBeNull();
    expect(event.payload.device).toEqual({ path: DEVICE.device, identity: DEVICE.identity });
    // No storage service: the frame is not retained, and the payload says so.
    expect(event.payload.frameStored).toBe(false);
    expect(event.payload.storageRef).toBe(`photo:${independentlyComputed.imageHash}`);
    // The emitted payload is exactly the closed LO-SE-1 contract the tier gate applies.
    expect(kernelPullCaptureIssue(event, jobId)).toBeNull();

    expect(event.source.simulated).toBeUndefined();
    expect(event.source.deviceType).toBe("camera");
  });
});

// ---------------------------------------------------------------------------
// 6. WorkflowChallenge freshness
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — WorkflowChallenge freshness", () => {
  const jobId = "job-challenge-test";

  // astra pack 155 HIGH 2: a challenge never makes a capture CC1. A fresh one for
  // the job is recorded as an unverified declaration (declaredChallengeId and
  // declaredChallengeAnchor, renamed from challengeId and challengeAnchor).
  it("fresh challenge scoped to the job -> CC0, with its id and block hash recorded as declarations", async () => {
    const { adapter, events } = makeAdapter();
    const challenge = makeChallenge({ jobId, ageSeconds: 10 });
    await adapter.captureSnapshot({ jobId, challenge });
    const payload = events[0]!.payload;
    expect(payload.captureClass).toBe("CC0");
    expect(payload.declaredChallengeId).toBe(challenge.challengeId);
    expect(payload.declaredChallengeAnchor).toBe(challenge.anchor.blockHash);
    expect(kernelPullCaptureIssue(events[0]!, jobId)).toBeNull();
  });

  it("stale challenge (age > maxAgeSeconds) -> CC0, declaredChallengeId and declaredChallengeAnchor null", async () => {
    const { adapter, events } = makeAdapter();
    const challenge = makeChallenge({ jobId, ageSeconds: 700, maxAgeSeconds: 600 });
    await adapter.captureSnapshot({ jobId, challenge });
    const payload = events[0]!.payload;
    expect(payload.captureClass).toBe("CC0");
    expect(payload.declaredChallengeId).toBeNull();
    expect(payload.declaredChallengeAnchor).toBeNull();
  });

  it("challenge scoped to a different job -> CC0", async () => {
    const { adapter, events } = makeAdapter();
    const challenge = makeChallenge({ jobId, scope: "some-other-job", ageSeconds: 10 });
    await adapter.captureSnapshot({ jobId, challenge });
    const payload = events[0]!.payload;
    expect(payload.captureClass).toBe("CC0");
    expect(payload.declaredChallengeId).toBeNull();
    expect(payload.declaredChallengeAnchor).toBeNull();
  });

  it("challenge anchored in the future (negative age) -> CC0", async () => {
    const { adapter, events } = makeAdapter();
    const challenge = makeChallenge({ jobId, ageSeconds: -60 });
    await adapter.captureSnapshot({ jobId, challenge });
    const payload = events[0]!.payload;
    expect(payload.captureClass).toBe("CC0");
    expect(payload.declaredChallengeId).toBeNull();
    expect(payload.declaredChallengeAnchor).toBeNull();
  });

  it.each(["", "   "])("a fresh challenge whose anchor blockHash is %j records neither declaration", async (blockHash) => {
    const { adapter, events } = makeAdapter();
    const challenge = makeChallenge({ jobId, ageSeconds: 10 });
    challenge.anchor = { ...challenge.anchor, blockHash };
    await adapter.captureSnapshot({ jobId, challenge });
    const payload = events[0]!.payload;
    expect(payload.captureClass).toBe("CC0");
    expect(payload.declaredChallengeId).toBeNull();
    expect(payload.declaredChallengeAnchor).toBeNull();
    expect(kernelPullCaptureIssue(events[0]!, jobId)).toBeNull();
  });

  it("each challenge field is read once: a challengeId that changes between reads cannot reach the payload unchecked", async () => {
    const { adapter, events } = makeAdapter();
    const challenge = makeChallenge({ jobId, ageSeconds: 10 });
    const reads: string[] = ["challenge-first-read", "   "];
    Object.defineProperty(challenge, "challengeId", { get: () => reads.shift() ?? "", configurable: true });
    await adapter.captureSnapshot({ jobId, challenge });
    expect(events[0]!.payload.declaredChallengeId).toBe("challenge-first-read");
    expect(reads).toEqual(["   "]);
  });
});

describe("PullCameraAdapter: frameStored says whether the frame bytes were retained", () => {
  it("with a storage service that stores the frame: frameStored true, and a storacha storageRef", async () => {
    const storage = { isReady: () => true, init: async () => {} } as unknown as ConstructorParameters<typeof PhotoCaptureService>[0];
    const { adapter, events } = makeAdapter({ photoCaptureService: new PhotoCaptureService(storage) });
    await adapter.captureSnapshot({ jobId: "job-stored" });
    const payload = events[0]!.payload;
    expect(payload.frameStored).toBe(true);
    expect(payload.storageRef).toMatch(/^storacha:\/\/./);
    expect(kernelPullCaptureIssue(events[0]!, "job-stored")).toBeNull();
  });

  it("the cv_inspection_result carries the same capture fields, and meets the contract", async () => {
    const { adapter, events } = makeAdapter();
    await adapter.runInspection("sha256:ref", { jobId: "job-inspect-contract" });
    expect(events[0]!.payload.frameStored).toBe(false);
    expect(events[0]!.payload.referenceHash).toBe("sha256:ref");
    expect(kernelPullCaptureIssue(events[0]!, "job-inspect-contract")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. runInspection
// ---------------------------------------------------------------------------

describe("PullCameraAdapter — runInspection", () => {
  it("needs context; without it, it throws", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.runInspection()).rejects.toThrow(/needs the job it is for/);
    await expect(adapter.runInspection(undefined, undefined)).rejects.toThrow(/needs the job it is for/);
  });

  it("acquires a fresh frame: grab() is called once per inspection", async () => {
    const grabber = makeFakeGrabber();
    const { adapter } = makeAdapter({ grabber });
    await adapter.runInspection(undefined, { jobId: "job-inspect-once" });
    expect(grabber.grabCalls).toHaveLength(1);
  });

  it("grab() is called twice across a capture plus an inspection", async () => {
    const grabber = makeFakeGrabber();
    const { adapter } = makeAdapter({ grabber });
    await adapter.captureSnapshot({ jobId: "job-inspect-twice" });
    await adapter.runInspection(undefined, { jobId: "job-inspect-twice" });
    expect(grabber.grabCalls).toHaveLength(2);
  });

  it("emits one cv_inspection_result with model, jobId and captureMode", async () => {
    const jobId = "job-inspect-payload";
    const { adapter, events } = makeAdapter();
    const result = await adapter.runInspection(undefined, { jobId });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("cv_inspection_result");
    expect(event.payload.model).toBe("anti-spoof-heuristic");
    expect(event.payload.jobId).toBe(jobId);
    expect(event.payload.captureMode).toBe("kernel-pull");
    expect(result.imageHash).toBe(event.payload.imageHash);
  });
});

// ---------------------------------------------------------------------------
// 8. adapter-factory — "photo" camera registration
// ---------------------------------------------------------------------------

describe("adapter-factory — 'photo' camera registration", () => {
  function photoDevice(capture?: Record<string, unknown>): DeviceConfig {
    return {
      id: "test-photo-cam-01",
      type: "camera",
      adapterType: "photo" as DeviceConfig["adapterType"],
      config: { kernelId: KERNEL_ID, ...(capture !== undefined ? { capture } : {}) },
    };
  }

  it("returns a PullCameraAdapter when config.capture has platform, device, identity", () => {
    const adapter = createCameraAdapter(
      photoDevice({ platform: "linux-v4l2", device: "/dev/video2", identity: "SN-FACTORY-01" }),
    );
    expect(adapter).toBeInstanceOf(PullCameraAdapter);
    expect(adapter.id).toBe("test-photo-cam-01");
  });

  it("throws when config.capture is missing entirely", () => {
    expect(() => createCameraAdapter(photoDevice())).toThrow(/capture\.platform is required configuration/);
  });

  it("throws when config.capture is missing device", () => {
    expect(() => createCameraAdapter(photoDevice({ platform: "linux-v4l2", identity: "SN-1" }))).toThrow(
      /capture\.device is required configuration/,
    );
  });

  it("throws when config.capture is missing identity", () => {
    expect(() => createCameraAdapter(photoDevice({ platform: "linux-v4l2", device: "/dev/video3" }))).toThrow(
      /capture\.identity is required configuration/,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Push-fed PhotoCameraAdapter stays simulated-only
// ---------------------------------------------------------------------------

describe("PhotoCameraAdapter (push-fed) stays simulated-only", () => {
  it("camera_snapshot is tagged simulated + handed-in, and isFabricated() is true", async () => {
    const svc = new PhotoCaptureService();
    const cam = new PhotoCameraAdapter("cam-push-01", KERNEL_ID, svc);
    const events = collect(cam);
    cam.setNextCapture(makeJpegFrame());
    await cam.captureSnapshot();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("camera_snapshot");
    expect(event.source.simulated).toBe(true);
    expect(event.payload.captureMode).toBe("handed-in");
    expect(isFabricated(event as unknown as EvidenceEvent)).toBe(true);
  });

  it("cv_inspection_result is tagged simulated + handed-in, and isFabricated() is true", async () => {
    const svc = new PhotoCaptureService();
    const cam = new PhotoCameraAdapter("cam-push-02", KERNEL_ID, svc);
    cam.setNextCapture(makeJpegFrame());
    await cam.captureSnapshot();
    const events = collect(cam); // start listening fresh so only the inspection event lands here
    await cam.runInspection();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("cv_inspection_result");
    expect(event.source.simulated).toBe(true);
    expect(event.payload.captureMode).toBe("handed-in");
    expect(isFabricated(event as unknown as EvidenceEvent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. JobRunner camera call sites (tier >= 2)
// ---------------------------------------------------------------------------

describe("JobRunner — camera call sites (tier >= 2)", () => {
  function makeMinimalMachine(): MachineAdapter {
    return {
      id: "machine-minimal",
      type: "fdm" as const,
      source: { deviceId: "machine-minimal", deviceType: "controller", kernelId: KERNEL_ID },
      getStatus: async () => "idle",
      getProgress: async () => 100,
      execute: async () => ({ success: true, message: "ok" }),
      onEvidence: () => {},
      dispose: async () => {},
    };
  }

  function makeArgRecordingCamera(): CameraAdapter & {
    captureCalls: Array<CaptureContext | undefined>;
    inspectCalls: Array<[string | undefined, CaptureContext | undefined]>;
  } {
    const listeners: Array<(e: EmittedEvent) => void> = [];
    const source: EvidenceSource = { deviceId: "camera-arg-rec", deviceType: "camera", kernelId: KERNEL_ID };
    const captureCalls: Array<CaptureContext | undefined> = [];
    const inspectCalls: Array<[string | undefined, CaptureContext | undefined]> = [];
    return {
      id: "camera-arg-rec",
      source,
      captureCalls,
      inspectCalls,
      async captureSnapshot(context) {
        captureCalls.push(context);
        for (const cb of listeners) {
          cb({ type: "camera_snapshot", timestamp: new Date().toISOString(), source, payload: {} });
        }
        return { imageHash: "sha256:arg-rec", storageRef: "mock://arg-rec" };
      },
      async runInspection(referenceHash, context) {
        inspectCalls.push([referenceHash, context]);
        for (const cb of listeners) {
          cb({ type: "cv_inspection_result", timestamp: new Date().toISOString(), source, payload: {} });
        }
        return { passed: true, confidence: 100, findings: [], imageHash: "sha256:arg-rec" };
      },
      onEvidence(cb) {
        listeners.push(cb);
      },
      async dispose() {
        listeners.length = 0;
      },
    };
  }

  it("passes { jobId } to captureSnapshot and (undefined, { jobId }) to runInspection", async () => {
    const emitter = new EvidenceEmitter(KERNEL_ID);
    const machine = makeMinimalMachine();
    const camera = makeArgRecordingCamera();
    const runner = new JobRunner(machine, [], camera, emitter);
    const jobId = "job-camera-args-001";

    await runner.run({
      jobId,
      stepId: "step-1",
      gcodeHash: "sha256:deadbeef00000000000000000000000000000000000000000000000000000001" as SHA256,
      assuranceTier: 2,
    });

    expect(camera.captureCalls).toEqual([{ jobId }]);
    expect(camera.inspectCalls).toEqual([[undefined, { jobId }]]);
  });
});
