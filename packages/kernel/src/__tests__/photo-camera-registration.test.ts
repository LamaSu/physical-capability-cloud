/**
 * Registration tests for the real photo-evidence camera (adapterType "photo").
 *
 * Contract under test:
 *   1. "photo" is a registered camera adapterType — a kernel config naming it
 *      gets PhotoCameraAdapter, never a silent MockCameraAdapter.
 *   2. NEGATIVE CONTROL: the factory-built adapter with no bytes pushed rejects
 *      captureSnapshot() instead of returning a fabricated hash.
 *   3. Push-fed happy path: setNextCapture(bytes) → captureSnapshot() returns
 *      the SHA-256 of exactly those bytes plus a storageRef.
 *   4. Misconfiguration throws a clear error; globalMockMode still wins.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  createCameraAdapter,
  createAdaptersFromConfig,
  listRegisteredCameraAdapters,
} from "../adapter-factory.js";
import { PhotoCameraAdapter } from "../adapters/photo-camera-adapter.js";
import { MockCameraAdapter } from "../adapters/mock-camera.js";
import type { KernelConfig, DeviceConfig } from "../kernel-config.js";
import type { EvidenceEvent } from "@pcc/spec";

type EmittedEvent = Omit<EvidenceEvent, "id" | "hash">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cameraDevice(
  adapterType: DeviceConfig["adapterType"],
  extra: Record<string, unknown> = {},
): DeviceConfig {
  return {
    id: "test_photo_cam_01",
    type: "camera",
    adapterType,
    config: { kernelId: "kernel_test", ...extra },
  };
}

/** A minimal but real PNG-magic byte payload; PhotoCaptureService hashes raw bytes. */
function imageBytes(seed = 7): Uint8Array {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const body = Array.from({ length: 256 }, (_, i) => (i * seed) % 256);
  return new Uint8Array([...png, ...body]);
}

/** SHA-256 of the bytes in PhotoCaptureService's `sha256:<hex>` form. */
function sha256Of(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function collect(adapter: { onEvidence(cb: (e: EmittedEvent) => void): void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  adapter.onEvidence((e) => events.push(e));
  return events;
}

/** Run `fn` with GEMINI_API_KEY unset, restoring the prior value afterwards. */
function withoutGeminiKey<T>(fn: () => T): T {
  const saved = process.env["GEMINI_API_KEY"];
  delete process.env["GEMINI_API_KEY"];
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env["GEMINI_API_KEY"] = saved;
  }
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

describe("photo camera registration", () => {
  it("listRegisteredCameraAdapters includes 'photo'", () => {
    expect(listRegisteredCameraAdapters()).toContain("photo");
  });

  it("createCameraAdapter('photo') returns the REAL PhotoCameraAdapter, not a mock", () => {
    const adapter = createCameraAdapter(cameraDevice("photo"), false);

    expect(adapter).toBeInstanceOf(PhotoCameraAdapter);
    expect(adapter).not.toBeInstanceOf(MockCameraAdapter);
    expect(adapter.id).toBe("test_photo_cam_01");
    expect(adapter.source.deviceId).toBe("test_photo_cam_01");
    expect(adapter.source.deviceType).toBe("camera");
    expect(adapter.source.kernelId).toBe("kernel_test");
    // A real device is never tagged as simulated.
    expect(adapter.source.simulated).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. NEGATIVE CONTROL — no bytes pushed means no snapshot, not a fake hash
// ---------------------------------------------------------------------------

describe("photo camera negative control (fail loud, never fabricate)", () => {
  it("captureSnapshot() with no bytes pushed rejects and emits no evidence", async () => {
    const adapter = createCameraAdapter(cameraDevice("photo"), false);
    const events = collect(adapter);

    await expect(adapter.captureSnapshot()).rejects.toThrow(/No image bytes available/);

    // No camera_snapshot event, so nothing fabricated can enter a signed bundle.
    expect(events).toHaveLength(0);

    await adapter.dispose();
  });

  it("a second captureSnapshot() after a consumed capture rejects (no stale reuse)", async () => {
    const adapter = createCameraAdapter(cameraDevice("photo"), false) as PhotoCameraAdapter;
    const bytes = imageBytes();

    adapter.setNextCapture(bytes);
    await adapter.captureSnapshot();

    await expect(adapter.captureSnapshot()).rejects.toThrow(/No image bytes available/);

    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. Push-fed happy path through the factory-built adapter
// ---------------------------------------------------------------------------

describe("photo camera push-fed capture", () => {
  it("hashes exactly the pushed bytes and returns a storageRef", async () => {
    const adapter = createCameraAdapter(cameraDevice("photo"), false) as PhotoCameraAdapter;
    const events = collect(adapter);
    const bytes = imageBytes(11);
    const expectedHash = sha256Of(bytes);

    adapter.setNextCapture(bytes);
    const snap = await adapter.captureSnapshot();

    expect(snap.imageHash).toBe(expectedHash);
    expect(typeof snap.storageRef).toBe("string");
    expect(snap.storageRef.length).toBeGreaterThan(0);
    // No storage service is wired, so the ref is hash-derived (not a fake CID).
    expect(snap.storageRef).toBe(`photo:${expectedHash}`);

    const snapshotEvents = events.filter((e) => e.type === "camera_snapshot");
    expect(snapshotEvents).toHaveLength(1);
    expect(snapshotEvents[0]!.payload.imageHash).toBe(expectedHash);
    expect(snapshotEvents[0]!.payload.rawSizeBytes).toBe(bytes.length);
    // Real capture — never tagged as simulated/mock evidence.
    expect(snapshotEvents[0]!.payload.mock).toBeUndefined();
    expect(snapshotEvents[0]!.source.simulated).toBeUndefined();

    await adapter.dispose();
  });

  it("different bytes produce different hashes (hash tracks the actual image)", async () => {
    const adapter = createCameraAdapter(cameraDevice("photo"), false) as PhotoCameraAdapter;

    adapter.setNextCapture(imageBytes(3));
    const first = await adapter.captureSnapshot();
    adapter.setNextCapture(imageBytes(5));
    const second = await adapter.captureSnapshot();

    expect(first.imageHash).toBe(sha256Of(imageBytes(3)));
    expect(second.imageHash).toBe(sha256Of(imageBytes(5)));
    expect(first.imageHash).not.toBe(second.imageHash);

    await adapter.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. createAdaptersFromConfig wiring + global mock contract
// ---------------------------------------------------------------------------

describe("createAdaptersFromConfig with a photo camera", () => {
  const config = (mockMode: boolean): KernelConfig => ({
    kernelId: "kernel_photo_cfg",
    mockMode,
    devices: [
      {
        id: "cam_photo_01",
        type: "camera",
        adapterType: "photo",
        config: { kernelId: "kernel_photo_cfg" },
      },
    ],
  });

  it("mockMode:false produces exactly one REAL PhotoCameraAdapter", () => {
    const result = createAdaptersFromConfig(config(false));

    expect(result.cameras).toHaveLength(1);
    expect(result.machines).toHaveLength(0);
    expect(result.sensors).toHaveLength(0);
    expect(result.cameras[0]).toBeInstanceOf(PhotoCameraAdapter);
    expect(result.cameras[0]!.id).toBe("cam_photo_01");
  });

  it("mockMode:true still yields the mock camera (global-mock contract preserved)", () => {
    const result = createAdaptersFromConfig(config(true));

    expect(result.cameras).toHaveLength(1);
    expect(result.cameras[0]).toBeInstanceOf(MockCameraAdapter);
    expect(result.cameras[0]).not.toBeInstanceOf(PhotoCameraAdapter);
  });
});

// ---------------------------------------------------------------------------
// 5. Gemini configuration — injected service used, misconfiguration fails loud
// ---------------------------------------------------------------------------

describe("photo camera gemini configuration", () => {
  it("uses an injected comparison service for runInspection", async () => {
    let compareCalls = 0;
    const fakeGemini = {
      compare: async () => {
        compareCalls++;
        return {
          matchScore: 0.91,
          verdict: "match" as const,
          discrepancies: [],
          reasoning: "injected",
          modelUsed: "injected-fake",
          tokensUsed: { prompt: 0, completion: 0 },
        };
      },
    };

    const adapter = createCameraAdapter(
      cameraDevice("photo", { gemini: fakeGemini }),
      false,
    ) as PhotoCameraAdapter;
    const events = collect(adapter);

    const reference = imageBytes(2);
    const referenceHash = sha256Of(reference);
    adapter.setReferenceBytes(referenceHash, reference);
    adapter.setNextCapture(imageBytes(4));

    const inspection = await adapter.runInspection(referenceHash);

    expect(compareCalls).toBe(1);
    expect(inspection.passed).toBe(true);
    expect(inspection.imageHash).toBe(sha256Of(imageBytes(4)));
    const cv = events.find((e) => e.type === "cv_inspection_result");
    expect(cv?.payload.model).toBe("gemini-2.0-flash");

    await adapter.dispose();
  });

  it("gemini:true with no API key anywhere throws instead of silently degrading", () => {
    withoutGeminiKey(() => {
      expect(() => createCameraAdapter(cameraDevice("photo", { gemini: true }), false)).toThrow(
        /no API key is available/,
      );
    });
  });

  it("gemini:true with an explicit key builds the adapter", () => {
    withoutGeminiKey(() => {
      const adapter = createCameraAdapter(
        cameraDevice("photo", { gemini: true, geminiApiKey: "test-key-not-used-offline" }),
        false,
      );
      expect(adapter).toBeInstanceOf(PhotoCameraAdapter);
    });
  });

  it("a malformed gemini config throws a clear error — never a mock fallback", () => {
    let built: unknown;
    expect(() => {
      built = createCameraAdapter(cameraDevice("photo", { gemini: "yes-please" }), false);
    }).toThrow(/adapterType "photo".*config\.gemini must be true or a GeminiComparisonService/s);
    expect(built).toBeUndefined();

    expect(() =>
      createCameraAdapter(cameraDevice("photo", { gemini: true, geminiApiKey: 42 }), false),
    ).toThrow(/config\.geminiApiKey must be a string/);
  });
});
