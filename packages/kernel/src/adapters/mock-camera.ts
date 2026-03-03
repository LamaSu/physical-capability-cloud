/**
 * Mock camera adapter.
 *
 * Simulates a camera system with CV inspection capabilities.
 * In production this would wrap OpenCV, AWS Panorama, or a custom CV pipeline.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { CameraAdapter } from "./types.js";

export class MockCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  /** Simulated inspection pass rate (0-1) */
  private passRate: number;

  constructor(id: string, kernelId: string, passRate = 0.95) {
    this.id = id;
    this.passRate = passRate;
    this.source = {
      deviceId: id,
      deviceType: "camera",
      kernelId,
      firmwareVersion: "MockCam-1.0.0",
    };
  }

  async captureSnapshot(): Promise<{ imageHash: string; storageRef: string }> {
    // Simulate capturing an image
    const fakeHash = `sha256:${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    const storageRef = `file:///mock-images/${Date.now()}.jpg`;

    this.emit({
      type: "camera_snapshot",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        imageHash: fakeHash,
        storageRef,
        resolution: { width: 1920, height: 1080 },
        format: "jpeg",
      },
    });

    return { imageHash: fakeHash, storageRef };
  }

  async runInspection(referenceHash?: string): Promise<{
    passed: boolean;
    confidence: number;
    findings: string[];
    imageHash: string;
  }> {
    const { imageHash } = await this.captureSnapshot();
    const passed = Math.random() < this.passRate;
    const confidence = passed
      ? 85 + Math.random() * 15        // 85-100 if passed
      : 20 + Math.random() * 40;       // 20-60 if failed

    const findings: string[] = [];
    if (passed) {
      findings.push("Part geometry matches expected dimensions");
      findings.push("Surface quality within acceptable range");
      findings.push("No visible defects detected");
    } else {
      findings.push("Dimensional deviation detected: +0.8mm on X axis");
      findings.push("Surface defect detected at coordinates (45, 72)");
    }

    const result = {
      passed,
      confidence: Math.round(confidence * 100) / 100,
      findings,
      imageHash,
    };

    this.emit({
      type: "cv_inspection_result",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        ...result,
        referenceHash: referenceHash ?? null,
        model: "mock-yolo-v8",
        inferenceTimeMs: 120 + Math.random() * 80,
      },
    });

    return result;
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.listeners = [];
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
