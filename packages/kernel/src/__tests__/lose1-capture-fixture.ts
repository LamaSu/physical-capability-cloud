/**
 * A complete LO-SE-1 kernel-pull capture, shaped as the PullCameraAdapter emits it (#489). Since
 * #489 a camera event counts toward a tier only as one (kernelPullCaptureIssue in @pcc/spec), so a
 * test camera whose evidence must count emits this, bound to the job it was asked for.
 */
import type { EvidenceEvent } from "@pcc/spec";

const IMAGE_HASH = `sha256:${"cd".repeat(32)}`;

export function lose1Capture(
  type: "camera_snapshot" | "cv_inspection_result",
  deviceId: string,
  kernelId: string,
  jobId: string,
  timestamp: string = new Date().toISOString(),
): Omit<EvidenceEvent, "id" | "hash"> {
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
  return { type, timestamp, source: { deviceId, deviceType: "camera", kernelId }, payload } as Omit<EvidenceEvent, "id" | "hash">;
}
