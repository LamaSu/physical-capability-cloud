/**
 * PhotoCameraAdapter — real CameraAdapter backed by PhotoCaptureService
 * (SHA-256 hashing + Storacha storage) and GeminiComparisonService
 * (multimodal CV inspection via Gemini 2.0 Flash).
 *
 * Usage:
 *   const cam = new PhotoCameraAdapter("cam-01", "kernel-01", photoSvc, geminiSvc);
 *   cam.setNextCapture(imageBytes);   // prime the adapter with raw image bytes
 *   const snap = await cam.captureSnapshot();
 *
 * For runInspection() the adapter primes itself with the last captured bytes
 * (stored in memory) so callers just need to call setNextCapture() once before
 * captureSnapshot() and optionally before runInspection() if a fresh image is
 * desired.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";
import type { CameraAdapter } from "./types.js";
import type { PhotoCaptureService } from "../photo-capture-service.js";
import type { GeminiComparisonService } from "../gemini-comparison-service.js";

export class PhotoCameraAdapter implements CameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;

  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];

  /** Raw bytes that will be consumed by the next captureSnapshot() call. */
  private pendingBytes: Uint8Array | null = null;

  /** Last captured bytes — used as "captured image" in runInspection(). */
  private lastCapturedBytes: Uint8Array | null = null;

  constructor(
    id: string,
    kernelId: string,
    private readonly photoCaptureService: PhotoCaptureService,
    private readonly geminiService?: GeminiComparisonService,
  ) {
    this.id = id;
    this.source = {
      deviceId: id,
      deviceType: "camera",
      kernelId,
      firmwareVersion: "PhotoCameraAdapter-1.0.0",
    };
  }

  /**
   * Prime the adapter with raw image bytes before the next captureSnapshot()
   * call. The CameraAdapter interface defines captureSnapshot() with no
   * arguments; callers must use this method to supply actual image data.
   */
  setNextCapture(imageBytes: Uint8Array): void {
    this.pendingBytes = imageBytes;
  }

  // ---------------------------------------------------------------------------
  // CameraAdapter implementation
  // ---------------------------------------------------------------------------

  async captureSnapshot(): Promise<{ imageHash: string; storageRef: string }> {
    const bytes = this.pendingBytes;
    if (!bytes || bytes.length === 0) {
      throw new Error(
        "[PhotoCameraAdapter] No image bytes available. Call setNextCapture(bytes) before captureSnapshot().",
      );
    }

    // Clear pending so accidental double-calls don't reuse stale data
    this.pendingBytes = null;

    const result = await this.photoCaptureService.capture(bytes);

    // Retain last captured bytes for runInspection()
    this.lastCapturedBytes = bytes;

    const imageHash = result.imageHash;
    const storageRef = result.storageCid
      ? `storacha://${result.storageCid}`
      : `photo:${imageHash}`;

    this.emit({
      type: "camera_snapshot",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: {
        imageHash,
        storageRef,
        rawSizeBytes: result.rawSizeBytes,
        antiSpoofScore: result.antiSpoofScore,
        antiSpoofChecks: result.antiSpoofChecks,
        exif: result.exif,
        storageCid: result.storageCid,
      },
    });

    return { imageHash, storageRef };
  }

  async runInspection(referenceHash?: string): Promise<{
    passed: boolean;
    confidence: number;
    findings: string[];
    imageHash: string;
  }> {
    // Capture a fresh snapshot if pending bytes exist; otherwise use last captured
    let capturedBytes = this.pendingBytes ?? this.lastCapturedBytes;
    if (!capturedBytes || capturedBytes.length === 0) {
      throw new Error(
        "[PhotoCameraAdapter] No image bytes available for inspection. Call setNextCapture(bytes) first.",
      );
    }

    // If pending bytes were set, consume them via captureSnapshot first
    if (this.pendingBytes) {
      await this.captureSnapshot();
      capturedBytes = this.lastCapturedBytes!;
    }

    // Compute the imageHash of the captured image
    const captureResult = await this.photoCaptureService.capture(capturedBytes);
    const imageHash = captureResult.imageHash;

    let passed = false;
    let confidence = 0;
    const findings: string[] = [];

    if (this.geminiService && referenceHash) {
      // referenceHash may be a hex-encoded bytes payload prefixed with "sha256:".
      // For the Gemini comparison we need the reference image bytes, not a hash.
      // When a reference hash is provided without corresponding bytes we fall
      // back to the local heuristic comparison below.
      // Callers that want full Gemini comparison should use setReferenceBytes()
      // (see below) in addition to setting the reference hash.
      const referenceBytes = this._referenceBytes.get(referenceHash);
      if (referenceBytes) {
        try {
          const comparison = await this.geminiService.compare(
            capturedBytes,
            referenceBytes,
            `Inspection against reference ${referenceHash}`,
          );

          if (comparison.matchScore >= 0) {
            passed = comparison.verdict === "match" || comparison.verdict === "partial_match";
            confidence = Math.round(comparison.matchScore * 100 * 100) / 100;
            findings.push(...comparison.discrepancies);
            if (findings.length === 0) {
              findings.push(`Gemini verdict: ${comparison.verdict} (score ${comparison.matchScore.toFixed(2)})`);
            }
          } else {
            // Gemini unavailable — fall through to heuristic
            this._fallbackInspection(captureResult.antiSpoofScore, findings);
            passed = captureResult.antiSpoofScore >= 0.8;
            confidence = captureResult.antiSpoofScore * 100;
          }
        } catch {
          // Gemini error — fall through to heuristic
          this._fallbackInspection(captureResult.antiSpoofScore, findings);
          passed = captureResult.antiSpoofScore >= 0.8;
          confidence = captureResult.antiSpoofScore * 100;
        }
      } else {
        // No reference bytes registered for this hash — heuristic comparison
        this._fallbackInspection(captureResult.antiSpoofScore, findings);
        passed = captureResult.antiSpoofScore >= 0.8;
        confidence = captureResult.antiSpoofScore * 100;
      }
    } else {
      // No Gemini service or no reference — use anti-spoof score as a proxy
      this._fallbackInspection(captureResult.antiSpoofScore, findings);
      passed = captureResult.antiSpoofScore >= 0.8;
      confidence = captureResult.antiSpoofScore * 100;
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
        model: this.geminiService ? "gemini-2.0-flash" : "anti-spoof-heuristic",
        antiSpoofScore: captureResult.antiSpoofScore,
      },
    });

    return result;
  }

  /**
   * Register reference image bytes keyed by their hash so runInspection()
   * can look them up for Gemini comparison.
   *
   * Example:
   *   cam.setReferenceBytes("sha256:abcd...", referenceImageBytes);
   *   await cam.runInspection("sha256:abcd...");
   */
  setReferenceBytes(hash: string, bytes: Uint8Array): void {
    this._referenceBytes.set(hash, bytes);
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.listeners = [];
    this.pendingBytes = null;
    this.lastCapturedBytes = null;
    this._referenceBytes.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** In-memory registry of reference bytes by hash. */
  private readonly _referenceBytes = new Map<string, Uint8Array>();

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private _fallbackInspection(
    antiSpoofScore: number,
    findings: string[],
  ): void {
    if (antiSpoofScore >= 0.8) {
      findings.push("Image passed anti-spoof validation");
      findings.push("No Gemini comparison available — heuristic pass");
    } else {
      findings.push(`Anti-spoof score too low: ${antiSpoofScore.toFixed(2)}`);
      findings.push("Image may be replayed or synthetically generated");
    }
  }
}
