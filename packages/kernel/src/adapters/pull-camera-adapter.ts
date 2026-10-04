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
 *   - `device {path, identity}`: the identity is checked against the
 *     configuration before AND after every grab, and it is bound to the node
 *     that is opened (astra pack 155 HIGH 3):
 *       - Linux: `device` must be a canonical `/dev/videoN`. linuxV4l2Identity
 *         lstat()s it: it must be a character device, not a symlink, and its
 *         rdev must equal the MAJOR:MINOR that sysfs reports for videoN. Only
 *         then is the serial read: sysfs videoN/device/../serial.
 *       - Windows: `device` must be a dshow ALTERNATIVE NAME (`@device_...`,
 *         the device instance path, unique per device), and `identity` must
 *         equal it. A friendly name is neither unique nor a hardware identity.
 *         The grab opens `video=<alternative name>`. The identity check passes
 *         only if ffmpeg's device list names that alternative name EXACTLY.
 *     Residual: the check runs in user space, before and after the grab.
 *     That narrows a device swap to the grab itself; a swap during the grab
 *     is beyond any user-space check;
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
import { lstat, readFile } from "node:fs/promises";

import type { EvidenceEvent, EvidenceSource, WorkflowChallenge } from "@pcc/spec";

import type { PhotoCaptureService } from "../photo-capture-service.js";
import type { CameraAdapter, CaptureContext } from "./types.js";
import { OutstandingWork } from "./outstanding-work.js";

/** Where the frames come from. Every field is required configuration; none is defaulted. */
export interface CameraDeviceSpec {
  platform: "linux-v4l2" | "windows-dshow";
  /** A canonical `/dev/videoN` on Linux; the dshow ALTERNATIVE NAME (`@device_...`) on Windows. */
  device: string;
  /** The expected identity: the USB serial (Linux sysfs), or the alternative name itself (Windows). */
  identity: string;
}

/** The only Linux device a capture may name: a canonical /dev/videoN node, N from 0 to 9999, no leading zero. */
const LINUX_VIDEO_NODE = /^\/dev\/video(0|[1-9][0-9]{0,3})$/;

/** A dshow alternative name (the device instance path) starts with this; a friendly name does not. */
const DSHOW_ALTERNATIVE_NAME_PREFIX = "@device_";

/** One line of ffmpeg's dshow device list that carries an alternative name. */
const DSHOW_ALTERNATIVE_NAME_LINE = /Alternative name "(.*)"\s*$/;

/** The filesystem reads linuxV4l2Identity needs. Injectable, so tests need neither a device node nor root. */
export interface LinuxFsOps {
  /** lstat with bigint fields: it describes a symlink itself, never its target. */
  lstat(path: string): Promise<{ isCharacterDevice(): boolean; isSymbolicLink(): boolean; rdev: bigint }>;
  readFile(path: string): Promise<string>;
}

export const nodeLinuxFsOps: LinuxFsOps = Object.freeze({
  lstat: (path: string) => lstat(path, { bigint: true }),
  readFile: (path: string) => readFile(path, "utf8"),
});

/**
 * The USB serial of the V4L2 device at `devicePath`, bound to the node that
 * ffmpeg opens; null when any link of that binding fails:
 *   1. `devicePath` is a canonical /dev/videoN, and N comes from it;
 *   2. lstat (with bigint fields): it is a character device, not a symlink;
 *   3. its rdev, decoded with glibc's major()/minor(), equals the
 *      "MAJOR:MINOR" that sysfs reports in /sys/class/video4linux/videoN/dev;
 *   4. the serial is /sys/class/video4linux/videoN/device/../serial, trimmed,
 *      non-blank.
 * Any read error gives null.
 */
export async function linuxV4l2Identity(devicePath: string, fs: LinuxFsOps = nodeLinuxFsOps): Promise<string | null> {
  const node = LINUX_VIDEO_NODE.exec(devicePath);
  if (node === null) return null;
  const sysfs = `/sys/class/video4linux/video${node[1]}`;
  try {
    const stats = await fs.lstat(devicePath);
    if (stats.isSymbolicLink() || !stats.isCharacterDevice()) return null;
    const rdev = stats.rdev;
    if (typeof rdev !== "bigint") return null;
    const pair = /^([0-9]+):([0-9]+)$/.exec((await fs.readFile(`${sysfs}/dev`)).trim());
    if (pair === null) return null;
    const major = ((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn);
    const minor = (rdev & 0xffn) | ((rdev >> 12n) & ~0xffn);
    if (major !== BigInt(pair[1]!) || minor !== BigInt(pair[2]!)) return null;
    const serial = (await fs.readFile(`${sysfs}/device/../serial`)).trim();
    return serial.length > 0 ? serial : null;
  } catch {
    return null;
  }
}

/** The alternative names in ffmpeg's dshow device list (built by split/map/filter, never by [[Set]]). */
export function dshowAlternativeNames(listing: string): string[] {
  return listing
    .split(/\r?\n/)
    .map((line) => DSHOW_ALTERNATIVE_NAME_LINE.exec(line)?.[1])
    .filter((name): name is string => typeof name === "string");
}

/** `device` when ffmpeg's dshow device list names exactly that alternative name; otherwise null. */
async function dshowIdentity(device: CameraDeviceSpec): Promise<string | null> {
  let listing: string;
  try {
    listing = String((await run("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 15_000)).stderr);
  } catch (err) {
    // ffmpeg exits non-zero after listing; run() keeps its stderr on the error.
    listing = String((err as { stderr?: unknown } | null)?.stderr ?? "");
  }
  return dshowAlternativeNames(listing).some((name) => name === device.device) ? device.device : null;
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
      // Keep ffmpeg's output on failure: execFile's callback error carries neither stream.
      if (err) reject(Object.assign(err, { stdout, stderr }));
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
    // Linux: the serial of the very node that is opened. Windows: the alternative name, matched exactly.
    return device.platform === "linux-v4l2" ? linuxV4l2Identity(device.device) : dshowIdentity(device);
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
  /** A frozen copy of the configuration, each field read once: what is validated is what every check and grab uses. */
  private readonly device: CameraDeviceSpec;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  /** Captures and inspections in flight: the only things that emit (#502's quiesceEvidence contract). */
  private readonly work = new OutstandingWork();

  constructor(
    id: string,
    kernelId: string,
    configured: CameraDeviceSpec,
    private readonly photoCaptureService: PhotoCaptureService,
    private readonly grabber: FrameGrabber = ffmpegFrameGrabber,
    private readonly options: { timeoutMs: number; now: () => number } = { timeoutMs: 10_000, now: () => Date.now() },
  ) {
    const device = Object.freeze({
      platform: configured?.platform,
      device: configured?.device,
      identity: configured?.identity,
    }) as CameraDeviceSpec;
    for (const key of ["platform", "device", "identity"] as const) {
      if (!nonEmpty(device[key])) throw new Error(`[PullCameraAdapter] capture.${key} is required configuration`);
    }
    if (device.platform !== "linux-v4l2" && device.platform !== "windows-dshow") {
      throw new Error(`[PullCameraAdapter] capture.platform ${JSON.stringify(device.platform)} is not linux-v4l2 or windows-dshow`);
    }
    if (device.platform === "linux-v4l2" && !LINUX_VIDEO_NODE.test(device.device)) {
      throw new Error(
        `[PullCameraAdapter] capture.device ${JSON.stringify(device.device)} is not a canonical /dev/videoN node (N from 0 to 9999, no leading zero): the identity is read for the node that is opened, so no other path, symlink or relative name is accepted`,
      );
    }
    if (device.platform === "windows-dshow") {
      if (!device.device.startsWith(DSHOW_ALTERNATIVE_NAME_PREFIX)) {
        throw new Error(
          `[PullCameraAdapter] capture.device ${JSON.stringify(device.device)} is not a dshow alternative name (${DSHOW_ALTERNATIVE_NAME_PREFIX}...): a friendly name is neither unique nor a hardware identity. Configure the device instance path that 'ffmpeg -list_devices true -f dshow -i dummy' prints as its Alternative name`,
        );
      }
      if (device.identity !== device.device) {
        throw new Error(
          "[PullCameraAdapter] on windows-dshow, capture.identity must equal capture.device: the alternative name is the device's identity, and a friendly name is neither unique nor a hardware identity",
        );
      }
    }
    this.device = device;
    this.id = id;
    this.source = { deviceId: id, deviceType: "camera", kernelId, firmwareVersion: "PullCameraAdapter-1.0.0" };
  }

  /** Acquire one frame from the device, for `context.jobId`, and emit it as a signed-to-be camera_snapshot. */
  captureSnapshot(context?: CaptureContext): Promise<{ imageHash: string; storageRef: string }> {
    return this.work.track(this.snapshot(context));
  }

  private async snapshot(context: CaptureContext | undefined): Promise<{ imageHash: string; storageRef: string }> {
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
  runInspection(
    referenceHash?: string,
    context?: CaptureContext,
  ): Promise<{ passed: boolean; confidence: number; findings: string[]; imageHash: string }> {
    return this.work.track(this.inspect(referenceHash, context));
  }

  private async inspect(
    referenceHash: string | undefined,
    context: CaptureContext | undefined,
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

  /**
   * Resolves once no capture or inspection is in flight; at once when none is. Each acquires its
   * frame, then emits, before it returns (as PhotoCameraAdapter, #502).
   */
  quiesceEvidence(): Promise<void> {
    return this.work.idle();
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
    const nowMs = this.options.now();
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error(`[PullCameraAdapter] device ${JSON.stringify(this.device.device)} returned no frame`);
    }
    // Re-check after the grab: a device swapped since the first check is refused. This narrows a
    // swap to the grab itself, which no user-space check can see.
    const identityAfter = await this.grabber.identity(this.device);
    if (identityAfter !== this.device.identity) {
      throw new Error(
        `[PullCameraAdapter] device ${JSON.stringify(this.device.device)} presents identity ${JSON.stringify(identityAfter)} after the grab, not the configured ${JSON.stringify(this.device.identity)}: the device may have changed during the capture`,
      );
    }
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
