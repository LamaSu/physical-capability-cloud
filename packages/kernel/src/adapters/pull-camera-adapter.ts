/**
 * PullCameraAdapter (LO-SE-1): the kernel acquires every frame itself, from the
 * configured device, for a named job. A camera event can therefore never be
 * made from bytes someone handed in.
 *
 * Why: gpt-5.6-sol, pack 41 HIGH 1. With the push-fed PhotoCameraAdapter
 * (`setNextCapture(bytes)`), any caller-supplied bytes became signed,
 * non-simulated camera evidence without job, nonce, acquisition-time or
 * device provenance.
 *
 * What each capture binds, inside the signed (hashed) payload. The key set is
 * exactly the closed LO-SE-1 contract (kernelPullCaptureIssue in @pcc/spec),
 * and the tier gate counts a camera event only when it meets it:
 *   - `jobId`: a capture without the job it is for is refused;
 *   - `acquiredAt`: the kernel's clock when the frame arrived, not a
 *     caller's claim;
 *   - `imageHash`, `rawSizeBytes`: of the bytes the kernel acquired;
 *   - `storageRef` and `frameStored`: whether the frame bytes were retained.
 *     With no storage service they are not: the storageRef stays
 *     `photo:<hash>` and `frameStored` is false. The "photo" factory builds
 *     PhotoCaptureService without storage today;
 *   - `device {path, identity}`: checked against the configuration at every
 *     capture (the Linux sysfs serial, or the Windows dshow device name);
 *   - `declaredChallengeId`, `declaredChallengeAnchor`: the job's
 *     WorkflowChallenge id and anchor block hash, when one is supplied, scoped
 *     to this job and still fresh; otherwise both null. They are UNVERIFIED
 *     DECLARATIONS: the kernel authenticates neither the challenge's issuer nor
 *     its anchor. The challenge is meant to be rendered in the camera's field
 *     as a visual nonce, which a downstream verifier (`capture.photo_nonced`)
 *     decodes from the stored bytes against the gateway's issued challenge.
 *     The kernel claims neither;
 *   - `captureMode: "kernel-pull"`, and `captureClass` ALWAYS "CC0" (which
 *     ComplianceFacade refuses at Tier 2+). CC1, in the spec's types/capture.ts,
 *     means operator-session signing plus a WebAuthn assertion plus a
 *     multi-sensor trace, which a kernel camera never has. A caller-built
 *     challenge used to make a capture CC1 (astra pack 155 HIGH 2).
 * A grabber failure, an empty frame or an identity mismatch is an error, and
 * no event is emitted.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { EvidenceEvent, EvidenceSource, WorkflowChallenge } from "@pcc/spec";

import type { PhotoCaptureService } from "../photo-capture-service.js";
import type { CameraAdapter, CaptureContext } from "./types.js";

/** Where the frames come from. Every field is required configuration; none is defaulted. */
export interface CameraDeviceSpec {
  platform: "linux-v4l2" | "windows-dshow";
  /** `/dev/videoN` on Linux; the dshow device name on Windows. */
  device: string;
  /** The expected identity: the USB serial (Linux sysfs), or the dshow device name (Windows). */
  identity: string;
}

/** Acquires exactly one frame from the device. Injectable so tests never touch hardware. */
export interface FrameGrabber {
  grab(device: CameraDeviceSpec, timeoutMs: number): Promise<Uint8Array>;
  /** The identity the device presents now, or null when it cannot be read. */
  identity(device: CameraDeviceSpec): Promise<string | null>;
}

const MAX_FRAME_BYTES = 20 * 1024 * 1024;

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "buffer", timeout: timeoutMs, maxBuffer: MAX_FRAME_BYTES }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

/** The default grabber: ffmpeg writes one MJPEG frame to stdout. No shell is involved. */
export const ffmpegFrameGrabber: FrameGrabber = {
  async grab(device, timeoutMs) {
    const input = device.platform === "linux-v4l2" ? ["-f", "v4l2", "-i", device.device] : ["-f", "dshow", "-i", `video=${device.device}`];
    const { stdout } = await run(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", ...input, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      timeoutMs,
    );
    return new Uint8Array(stdout);
  },
  async identity(device) {
    if (device.platform === "linux-v4l2") {
      // /dev/videoN -> the USB device's serial, two levels up from the video4linux node.
      try {
        const serial = await readFile(`/sys/class/video4linux/${basename(device.device)}/device/../serial`, "utf8");
        return serial.trim() || null;
      } catch {
        return null;
      }
    }
    // Windows: the device is identified by its dshow name, which must be among the devices ffmpeg lists.
    try {
      await run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 15_000);
    } catch (err) {
      // ffmpeg exits non-zero after listing; the list is on stderr.
      const stderr = String((err as { stderr?: Buffer }).stderr ?? "");
      return stderr.includes(`"${device.device}"`) ? device.device : null;
    }
    return null;
  },
};

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * The challenge as the payload declares it: its id and anchor block hash, when
 * it is for this job, still fresh, and both are non-blank; otherwise null.
 * Each field is read once, so what is checked is what is recorded. This is a
 * declaration, not a verification: nothing here authenticates the issuer or
 * the anchor.
 */
function declaredChallenge(
  challenge: WorkflowChallenge | undefined,
  jobId: string,
  nowMs: number,
): { id: string; anchor: string } | null {
  if (!challenge) return null;
  const id = challenge.challengeId;
  const anchor = challenge.anchor;
  const maxAgeSeconds = challenge.maxAgeSeconds;
  if (challenge.scope !== jobId || !nonEmpty(id)) return null;
  const issuedAtSeconds = Number(anchor?.timestamp);
  if (!Number.isFinite(issuedAtSeconds) || !Number.isFinite(maxAgeSeconds)) return null;
  const ageSeconds = nowMs / 1000 - issuedAtSeconds;
  if (!(ageSeconds >= 0 && ageSeconds <= maxAgeSeconds)) return null;
  const blockHash = anchor?.blockHash;
  return nonEmpty(blockHash) ? { id, anchor: blockHash } : null;
}

export class PullCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  constructor(
    id: string,
    kernelId: string,
    private readonly device: CameraDeviceSpec,
    private readonly photoCaptureService: PhotoCaptureService,
    private readonly grabber: FrameGrabber = ffmpegFrameGrabber,
    private readonly options: { timeoutMs: number; now: () => number } = { timeoutMs: 10_000, now: () => Date.now() },
  ) {
    for (const key of ["platform", "device", "identity"] as const) {
      if (!nonEmpty(device?.[key])) throw new Error(`[PullCameraAdapter] capture.${key} is required configuration`);
    }
    if (device.platform !== "linux-v4l2" && device.platform !== "windows-dshow") {
      throw new Error(`[PullCameraAdapter] capture.platform ${JSON.stringify(device.platform)} is not linux-v4l2 or windows-dshow`);
    }
    this.id = id;
    this.source = { deviceId: id, deviceType: "camera", kernelId, firmwareVersion: "PullCameraAdapter-1.0.0" };
  }

  /** Acquire one frame from the device, for `context.jobId`, and emit it as a signed-to-be camera_snapshot. */
  async captureSnapshot(context?: CaptureContext): Promise<{ imageHash: string; storageRef: string }> {
    const acquired = await this.acquire(context);
    this.emit({
      type: "camera_snapshot",
      timestamp: acquired.acquiredAt,
      source: this.source,
      payload: acquired.payload,
    });
    return { imageHash: acquired.payload.imageHash as string, storageRef: acquired.payload.storageRef as string };
  }

  /**
   * Inspect a FRESH frame acquired now for `context.jobId`; nothing captured
   * earlier is reused. v1 runs the anti-spoof heuristic only, and says so.
   */
  async runInspection(
    referenceHash?: string,
    context?: CaptureContext,
  ): Promise<{ passed: boolean; confidence: number; findings: string[]; imageHash: string }> {
    const acquired = await this.acquire(context);
    const score = acquired.antiSpoofScore;
    const result = {
      passed: score >= 0.8,
      confidence: Math.round(score * 100 * 100) / 100,
      findings: [`anti-spoof heuristic score ${score.toFixed(2)} on a frame the kernel acquired`],
      imageHash: acquired.payload.imageHash as string,
    };
    this.emit({
      type: "cv_inspection_result",
      timestamp: acquired.acquiredAt,
      source: this.source,
      payload: { ...result, referenceHash: referenceHash ?? null, model: "anti-spoof-heuristic", ...acquired.payload },
    });
    return result;
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.listeners = [];
  }

  private async acquire(context: CaptureContext | undefined): Promise<{
    acquiredAt: string;
    antiSpoofScore: number;
    payload: Record<string, unknown>;
  }> {
    // Each context field is read once: what is checked is what is recorded.
    const jobId = context?.jobId;
    const challenge = context?.challenge;
    if (!nonEmpty(jobId)) {
      throw new Error("[PullCameraAdapter] a capture needs the job it is for (context.jobId)");
    }
    const identity = await this.grabber.identity(this.device);
    if (identity !== this.device.identity) {
      throw new Error(
        `[PullCameraAdapter] device ${JSON.stringify(this.device.device)} presents identity ${JSON.stringify(identity)}, not the configured ${JSON.stringify(this.device.identity)}`,
      );
    }
    const bytes = await this.grabber.grab(this.device, this.options.timeoutMs);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error(`[PullCameraAdapter] device ${JSON.stringify(this.device.device)} returned no frame`);
    }
    const nowMs = this.options.now();
    const acquiredAt = new Date(nowMs).toISOString();
    const result = await this.photoCaptureService.capture(bytes, { deviceId: this.id });
    const declared = declaredChallenge(challenge, jobId, nowMs);
    // The bytes are retained only when a storage service stored them (storageCid set).
    const frameStored = typeof result.storageCid === "string" && result.storageCid !== "";
    return {
      acquiredAt,
      antiSpoofScore: result.antiSpoofScore,
      payload: {
        jobId,
        acquiredAt,
        imageHash: result.imageHash,
        storageRef: frameStored ? `storacha://${result.storageCid}` : `photo:${result.imageHash}`,
        frameStored,
        rawSizeBytes: result.rawSizeBytes,
        captureMode: "kernel-pull",
        // Always CC0: the kernel never has CC1's operator-session signing, WebAuthn and multi-sensor trace.
        captureClass: "CC0",
        device: { path: this.device.device, identity: this.device.identity },
        declaredChallengeId: declared?.id ?? null,
        declaredChallengeAnchor: declared?.anchor ?? null,
        antiSpoofScore: result.antiSpoofScore,
      },
    };
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) listener(event);
  }
}
