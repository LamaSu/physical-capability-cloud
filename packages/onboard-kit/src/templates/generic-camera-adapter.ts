/**
 * Generic camera adapter template.
 *
 * Wraps any camera/vision system that exposes HTTP endpoints for capture and inspection.
 */

import type { EvidenceEvent, EvidenceSource } from "@pcc/spec";

export interface GenericCameraConfig {
  /** URL to capture a snapshot (POST) */
  captureUrl: string;
  /** URL to run inspection (POST) */
  inspectUrl?: string;
  /** Kernel ID */
  kernelId: string;
  /** JSON path to image URL/hash in capture response */
  imageHashField: string;
  /** JSON path to storage reference in capture response */
  storageRefField: string;
  /** JSON path to pass/fail in inspection response */
  inspectionPassedField?: string;
  /** JSON path to confidence in inspection response */
  inspectionConfidenceField?: string;
  /** JSON path to findings array in inspection response */
  inspectionFindingsField?: string;
  /** Auth config */
  auth?: {
    type: "header" | "bearer";
    key: string;
    value: string;
  };
  /** Mock mode */
  mockMode?: boolean;
  /** Mock pass rate (0-1, default 0.95) */
  mockPassRate?: number;
}

export class GenericCameraAdapter {
  readonly id: string;
  readonly source: EvidenceSource;

  private config: GenericCameraConfig;
  private listeners: Array<(event: Omit<EvidenceEvent, "id" | "hash">) => void> = [];
  private mockImageCounter = 0;

  constructor(id: string, config: GenericCameraConfig) {
    this.id = id;
    this.config = config;
    this.source = {
      deviceId: id,
      deviceType: "camera",
      kernelId: config.kernelId,
      firmwareVersion: "GenericCamera-1.0.0",
    };
  }

  async captureSnapshot(): Promise<{ imageHash: string; storageRef: string }> {
    if (this.config.mockMode) return this.captureMock();

    const headers = this.buildHeaders();
    const res = await fetch(this.config.captureUrl, { method: "POST", headers });
    if (!res.ok) throw new Error(`Camera capture failed: ${res.status}`);

    const data = await res.json();
    const imageHash = String(this.extractField(data, this.config.imageHashField));
    const storageRef = String(this.extractField(data, this.config.storageRefField));

    this.emit({
      type: "camera_snapshot",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: { imageHash, storageRef },
    });

    return { imageHash, storageRef };
  }

  async runInspection(referenceHash?: string): Promise<{
    passed: boolean;
    confidence: number;
    findings: string[];
    imageHash: string;
  }> {
    if (this.config.mockMode) return this.inspectMock();

    const snapshot = await this.captureSnapshot();

    if (!this.config.inspectUrl) {
      // No inspection endpoint — return pass-through
      return { passed: true, confidence: 1.0, findings: [], imageHash: snapshot.imageHash };
    }

    const headers = this.buildHeaders();
    const res = await fetch(this.config.inspectUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ imageHash: snapshot.imageHash, referenceHash }),
    });
    if (!res.ok) throw new Error(`Camera inspect failed: ${res.status}`);

    const data = await res.json();
    const passed = Boolean(this.extractField(data, this.config.inspectionPassedField ?? "passed"));
    const confidence = Number(this.extractField(data, this.config.inspectionConfidenceField ?? "confidence"));
    const findings = (this.extractField(data, this.config.inspectionFindingsField ?? "findings") as string[]) ?? [];

    this.emit({
      type: "cv_inspection_result",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: { passed, confidence, findings, imageHash: snapshot.imageHash },
    });

    return { passed, confidence, findings, imageHash: snapshot.imageHash };
  }

  onEvidence(callback: (event: Omit<EvidenceEvent, "id" | "hash">) => void): void {
    this.listeners.push(callback);
  }

  async dispose(): Promise<void> {
    this.listeners = [];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.auth) {
      if (this.config.auth.type === "bearer") {
        headers["Authorization"] = `Bearer ${this.config.auth.value}`;
      } else {
        headers[this.config.auth.key] = this.config.auth.value;
      }
    }
    return headers;
  }

  private extractField(data: unknown, fieldPath: string): unknown {
    const parts = fieldPath.split(".");
    let current: unknown = data;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  private captureMock(): { imageHash: string; storageRef: string } {
    this.mockImageCounter++;
    const imageHash = `mock_image_${this.mockImageCounter}_${Date.now()}`;
    const storageRef = `mock://captures/${imageHash}.png`;

    this.emit({
      type: "camera_snapshot",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: { imageHash, storageRef, mock: true },
    });

    return { imageHash, storageRef };
  }

  private inspectMock(): { passed: boolean; confidence: number; findings: string[]; imageHash: string } {
    const snapshot = this.captureMock();
    const passed = Math.random() < (this.config.mockPassRate ?? 0.95);
    const confidence = passed ? 0.85 + Math.random() * 0.15 : 0.2 + Math.random() * 0.4;
    const findings = passed ? [] : ["Dimensional deviation detected", "Surface defect at region C"];

    this.emit({
      type: "cv_inspection_result",
      timestamp: new Date().toISOString(),
      source: this.source,
      payload: { passed, confidence, findings, imageHash: snapshot.imageHash, mock: true },
    });

    return { passed, confidence, findings, imageHash: snapshot.imageHash };
  }

  private emit(event: Omit<EvidenceEvent, "id" | "hash">): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
