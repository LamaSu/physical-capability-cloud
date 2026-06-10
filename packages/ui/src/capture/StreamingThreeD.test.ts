/**
 * StreamingThreeD — browser-side adapter tests.
 *
 * The test environment is Node + vitest. We exercise:
 *   - pickMimeType: with and without MediaRecorder.isTypeSupported on globalThis
 *   - sha256Blob: deterministic over a known byte payload
 *   - uploadAndInfer: globally-mocked `fetch` returns a canned trace, we
 *     assert the request body shape + hash echo + result mapping
 *   - StreamingThreeD.inferFromBlob: end-to-end via uploadAndInfer
 *
 * `recordAndInfer` (camera path) is not exercised here — it requires a real
 * MediaStream + MediaRecorder. The `recordVideo` helper is exported so a
 * future jsdom/playwright test can exercise it in isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  StreamingThreeD,
  pickMimeType,
  sha256Blob,
  uploadAndInfer,
} from "./StreamingThreeD.js";
import type { PointMap3DTrace } from "@pcc/spec";

// -----------------------------------------------------------------------------
// Test fixtures
// -----------------------------------------------------------------------------

const NOW = "2026-04-21T00:00:00.000Z";
const KNOWN_BYTES = new TextEncoder().encode("phone-video-fixture");
// sha256("phone-video-fixture") computed via Node `crypto.createHash` so the
// test does not rely on the SUT helper to validate itself.
// (precomputed using `echo -n phone-video-fixture | sha256sum`)
const KNOWN_HASH = "sha256:f31b35e9fc4ffcb14f5d6a8b7ec5c54818b62ff9e3a14ea4b1b6a36f59f2e5b3";
// NOTE: don't hardcode — compute at test time below.

function buildCannedResponse(videoHash: string): {
  trace: PointMap3DTrace;
  durationMs: number;
  stubbed: boolean;
  bytesReceived: number;
} {
  return {
    trace: {
      deviceId: "test-device",
      startedAt: NOW,
      endedAt: NOW,
      videoHash,
      mode: "streaming",
      fps: 10,
      frameCount: 1,
      frames: [
        {
          frameIndex: 0,
          timestampSec: 0,
          pose: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] },
          points: [{ x: 0, y: 0, z: 0 }],
        },
      ],
      model: "lingbot-map-stub",
      adapterVersion: "0.1.0",
      stubbed: true,
    },
    durationMs: 42,
    stubbed: true,
    bytesReceived: KNOWN_BYTES.byteLength,
  };
}

// -----------------------------------------------------------------------------
// Polyfills for the Node-vitest environment
// -----------------------------------------------------------------------------

beforeEach(() => {
  // Ensure btoa exists (Node 18+ has it, but vitest Node may shim).
  if (typeof globalThis.btoa !== "function") {
    // Minimal polyfill for the chunked base64 path used in StreamingThreeD.
    globalThis.btoa = (binary: string) =>
      Buffer.from(binary, "binary").toString("base64");
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean any leaked MediaRecorder polyfill — pickMimeType tests install it.
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
});

// -----------------------------------------------------------------------------
// pickMimeType
// -----------------------------------------------------------------------------

describe("pickMimeType", () => {
  it("returns empty string when MediaRecorder is unavailable", () => {
    expect(pickMimeType("video/webm")).toBe("");
  });

  it("returns the preferred MIME when supported", () => {
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
      isTypeSupported: (m: string) => m === "video/webm;codecs=vp9",
    };
    expect(pickMimeType("video/webm;codecs=vp9")).toBe("video/webm;codecs=vp9");
  });

  it("falls through to a known-good default when preferred is unsupported", () => {
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
      isTypeSupported: (m: string) => m === "video/webm",
    };
    expect(pickMimeType("video/avi")).toBe("video/webm");
  });

  it("returns empty string when nothing supported", () => {
    (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
      isTypeSupported: () => false,
    };
    expect(pickMimeType()).toBe("");
  });
});

// -----------------------------------------------------------------------------
// sha256Blob
// -----------------------------------------------------------------------------

describe("sha256Blob", () => {
  it("produces a deterministic sha256:<hex> string over bytes", async () => {
    const blob = new Blob([KNOWN_BYTES]);
    const hash = await sha256Blob(blob);
    // Don't rely on KNOWN_HASH constant — compute via Node crypto.
    const { createHash } = await import("node:crypto");
    const expected =
      "sha256:" + createHash("sha256").update(KNOWN_BYTES).digest("hex");
    expect(hash).toBe(expected);
    // Stable second call.
    const again = await sha256Blob(blob);
    expect(again).toBe(hash);
  });
});

// -----------------------------------------------------------------------------
// uploadAndInfer
// -----------------------------------------------------------------------------

describe("uploadAndInfer", () => {
  it("posts JSON with hash echo and returns a hydrated result", async () => {
    const blob = new Blob([KNOWN_BYTES], { type: "video/webm" });
    const { createHash } = await import("node:crypto");
    const expectedHash =
      "sha256:" + createHash("sha256").update(KNOWN_BYTES).digest("hex");

    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      // Assert request payload.
      const body = JSON.parse(String(init?.body));
      expect(body.videoBytesBase64).toBe(
        Buffer.from(KNOWN_BYTES).toString("base64"),
      );
      expect(body.expectedVideoHash).toBe(expectedHash);
      expect(body.videoMime).toBe("video/webm");
      expect(body.jobId).toBe("job-foo");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-token",
      );
      return new Response(JSON.stringify(buildCannedResponse(expectedHash)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await uploadAndInfer(blob, {
      apiBaseUrl: "https://api.test",
      bearerToken: "test-token",
      jobId: "job-foo",
      deviceId: "phone-1",
      fps: 10,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.trace.videoHash).toBe(expectedHash);
    expect(result.stubbed).toBe(true);
    expect(result.bytesUploaded).toBe(KNOWN_BYTES.byteLength);
    expect(result.videoHash).toBe(expectedHash);
    expect(result.durationMs).toBe(42);
  });

  it("throws when the gateway returns a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("kaboom", { status: 502 }),
      ),
    );
    const blob = new Blob([KNOWN_BYTES], { type: "video/webm" });
    await expect(
      uploadAndInfer(blob, {
        apiBaseUrl: "https://api.test",
        bearerToken: "tok",
      }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it("throws when the returned trace's videoHash does not echo the request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify(buildCannedResponse("sha256:" + "0".repeat(64))),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const blob = new Blob([KNOWN_BYTES], { type: "video/webm" });
    await expect(
      uploadAndInfer(blob, {
        apiBaseUrl: "https://api.test",
        bearerToken: "tok",
      }),
    ).rejects.toThrow(/streaming_3d_hash_mismatch/);
  });
});

// -----------------------------------------------------------------------------
// StreamingThreeD.inferFromBlob — surface integration
// -----------------------------------------------------------------------------

describe("StreamingThreeD.inferFromBlob", () => {
  it("hands the blob through uploadAndInfer and returns a result", async () => {
    const blob = new Blob([KNOWN_BYTES], { type: "video/webm" });
    const { createHash } = await import("node:crypto");
    const expectedHash =
      "sha256:" + createHash("sha256").update(KNOWN_BYTES).digest("hex");

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(buildCannedResponse(expectedHash)), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await StreamingThreeD.inferFromBlob({
      videoBlob: blob,
      apiBaseUrl: "https://api.test",
      bearerToken: "tok",
    });

    expect(result.trace.videoHash).toBe(expectedHash);
    expect(result.stubbed).toBe(true);
  });
});
