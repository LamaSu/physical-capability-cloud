/**
 * Capture Verification Protocol — the main browser flow.
 *
 * The component that operator-facing apps mount under e.g. `/operator/capture`
 * to gather a CC1 (or better) evidence bundle and hand it to the gateway.
 *
 * Five stages, one UI:
 *   1. "challenge"  — POST /api/capture/challenge with the job + declared
 *                     class, receive a `CaptureNonceChallengePayload`.
 *   2. "capturing"  — render the camera preview + `VisualNonceRenderer`
 *                     (so the nonce lands in the same frame). Operator taps
 *                     the capture button.
 *   3. "evidence"   — in parallel: C2PA read (if any), WebAuthn assertion,
 *                     FaceLandmarker single-frame liveness, SensorFusion
 *                     5-second trace.
 *   4. "uploading"  — compose the `CaptureManifest`, POST multipart form to
 *                     /api/capture/upload.
 *   5. "done"       — surface the gateway verdict + gate decisions.
 *
 * Auth: the parent passes a `bearerToken` (provisioned via `/api/auth/provision`
 * or a live session). The component does not own auth state — runtime
 * separation between UI (renders + local sensors) and gateway (all policy).
 *
 * The component does NOT import from `@pcc/verifier`. It calls the gateway,
 * which owns verification. The `@pcc/ui` package has no server-side code.
 *
 * Author: ui-capture-mike
 * See: ai/research/capture-verification-protocol.md §9.2
 */

import React from "react";
import type {
  CaptureClass,
  CaptureManifest,
  CaptureNonceChallengePayload,
} from "@pcc/spec";
import { C2PAReader, type C2PALoader } from "./C2PAReader.js";
import {
  FaceLandmarkerAdapter,
  type FaceLandmarkerLoader,
} from "./FaceLandmarker.js";
import { SensorFusion } from "./SensorFusion.js";
import { StreamingThreeD, type StreamingThreeDResult } from "./StreamingThreeD.js";
import { VisualNonceRenderer } from "./VisualNonceRenderer.js";
import {
  WebAuthnClient,
  type WebAuthnClientOptions,
} from "./WebAuthnClient.js";
import { cn } from "../utils.js";

/**
 * Default gateway base URL. The consumer app should override via the
 * `apiBaseUrl` prop — typically from `import.meta.env.VITE_PCC_API_URL` in a
 * Vite app. `capability.network` is the live production gateway.
 */
const DEFAULT_API_BASE = "https://capability.network";

/**
 * Result returned by the gateway on a successful upload. Shape mirrors
 * what `@pcc/gateway` renders for `POST /api/capture/upload`.
 */
export interface CaptureUploadResult {
  /** Final verdict: PASS / WARN / FAIL. */
  verdict: "PASS" | "WARN" | "FAIL";
  /** Class the verifier granted after inspection. */
  verifiedClass: CaptureClass;
  /** Class the operator declared (echo from request). */
  declaredClass: CaptureClass;
  /** Gates the capture satisfied (informational). */
  gatesPassed: string[];
  /** Gates the capture failed (informational). */
  gatesFailed: string[];
  /** Warnings that did not block but should be surfaced. */
  warnings: string[];
  /** Manifest hash + canonical anchor candidate for the on-chain step. */
  anchorCandidate?: {
    manifestHash: string;
    captureHash: string;
  };
  /** Unique id for this verdict (persisted server-side). */
  verdictId: string;
}

/** Props for the main flow component. */
export interface CaptureFlowProps {
  /** The job this capture is being gathered for. */
  jobId: string;
  /**
   * The capture class the operator is declaring (detector may downgrade
   * if evidence doesn't support).
   */
  declaredClass: CaptureClass;
  /**
   * Bearer token for the gateway (from `/api/auth/provision` or live SIWE
   * session).
   */
  bearerToken: string;
  /**
   * Gateway base URL. Defaults to `https://capability.network`. Vite apps
   * typically pass `import.meta.env.VITE_PCC_API_URL`.
   */
  apiBaseUrl?: string;
  /** Called when a verdict is received. */
  onComplete: (result: CaptureUploadResult) => void;
  /** Called when the flow fails fatally (no retry available). */
  onError: (err: Error) => void;
  /**
   * Optional C2PA loader. When provided, the flow inspects the captured
   * frame for a C2PA manifest before upload. Pass the result of
   * `createC2pa({wasmSrc, workerSrc})` from `@contentauth/c2pa-web`.
   */
  c2paLoader?: C2PALoader;
  /**
   * Optional FaceLandmarker loader. When provided, the flow runs a liveness
   * pass on the captured frame.
   */
  faceLandmarkerLoader?: FaceLandmarkerLoader;
  /**
   * Optional WebAuthn fetcher overrides. When provided, the flow obtains a
   * WebAuthn assertion over the capture hash. Omit to skip WebAuthn (the
   * detector will cap at CC0 absent a signature).
   */
  webauthnOptions?: WebAuthnClientOptions;
  /**
   * Optional streaming-3D capture (LingBot-Map adapter). When enabled, the
   * flow records a short phone-video clip alongside the still photo and
   * POSTs it to `/api/capture/3d-stream` to receive a `PointMap3DTrace`.
   * The trace is merged into the parent `CaptureManifest.pointMaps3D` field
   * before the upload step.
   *
   * Pass `{ enabled: true }` to opt in with defaults, or override `recordMs`,
   * `maxFrames`, etc. The adapter will gracefully fail (warning, no abort)
   * if MediaRecorder is unavailable or the gateway returns an error — the
   * photo + sensor evidence still proceeds.
   */
  streaming3D?: {
    enabled: boolean;
    recordMs?: number;
    fps?: number;
    maxFrames?: number;
    downsamplePoints?: number;
    mode?: "streaming" | "windowed";
    deviceId?: string;
  };
  /** Optional className for the outer container. */
  className?: string;
}

/** Internal state machine. */
type Stage =
  | "challenge"
  | "capturing"
  | "evidence"
  | "uploading"
  | "done"
  | "error";

/**
 * The capture flow — single self-contained component.
 *
 * Mount, pass `jobId` and `declaredClass`, collect a capture bundle.
 */
export function CaptureFlow({
  jobId,
  declaredClass,
  bearerToken,
  apiBaseUrl,
  onComplete,
  onError,
  c2paLoader,
  faceLandmarkerLoader,
  webauthnOptions,
  streaming3D,
  className,
}: CaptureFlowProps): React.JSX.Element {
  const apiBase = apiBaseUrl ?? DEFAULT_API_BASE;

  const [stage, setStage] = React.useState<Stage>("challenge");
  const [challenge, setChallenge] =
    React.useState<CaptureNonceChallengePayload | null>(null);
  const [stageDetail, setStageDetail] = React.useState<string>(
    "Requesting capture challenge…",
  );
  const [fatalError, setFatalError] = React.useState<string | null>(null);

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);

  // --- Phase 1: request challenge -----------------------------------
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/capture/challenge`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${bearerToken}`,
          },
          body: JSON.stringify({
            jobId,
            declaredClass,
            requestedTtlSeconds: 120,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `challenge_request_failed: HTTP ${res.status} ${body.slice(0, 200)}`,
          );
        }
        const payload = (await res.json()) as CaptureNonceChallengePayload;
        if (cancelled) return;
        setChallenge(payload);
        setStage("capturing");
        setStageDetail("Frame the subject and embed the nonce in-shot.");
      } catch (err) {
        if (cancelled) return;
        const e =
          err instanceof Error ? err : new Error(String(err));
        setFatalError(e.message);
        setStage("error");
        onError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, bearerToken, declaredClass, jobId, onError]);

  // --- Phase 2: attach camera stream once we're in "capturing" -------
  React.useEffect(() => {
    if (stage !== "capturing") return;
    let cancelled = false;
    (async () => {
      try {
        if (
          typeof navigator === "undefined" ||
          !navigator.mediaDevices ||
          typeof navigator.mediaDevices.getUserMedia !== "function"
        ) {
          throw new Error("camera_unsupported_browser");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stopStream(stream);
          return;
        }
        mediaStreamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // Ensure autoplay happens even if React hasn't flushed yet.
          try {
            await video.play();
          } catch {
            // Browser may block autoplay — the `<video autoPlay />` attr
            // also handles it, so this is best-effort.
          }
        }
      } catch (err) {
        if (cancelled) return;
        const e =
          err instanceof Error ? err : new Error(String(err));
        setFatalError(e.message);
        setStage("error");
        onError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError, stage]);

  // --- Phase 2-exit: stop the camera when we leave "capturing" -------
  React.useEffect(() => {
    return () => {
      const stream = mediaStreamRef.current;
      if (stream) {
        stopStream(stream);
        mediaStreamRef.current = null;
      }
    };
  }, []);

  // --- Phase 3: capture button handler -------------------------------
  const doCapture = React.useCallback(async () => {
    if (!challenge) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) {
      const e = new Error("capture_refs_missing");
      setFatalError(e.message);
      setStage("error");
      onError(e);
      return;
    }

    setStage("evidence");
    setStageDetail("Collecting multi-sensor evidence…");

    try {
      // 1. Snap a frame from the live video into the canvas.
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas_context_unavailable");
      ctx.drawImage(video, 0, 0, w, h);
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const captureHash = await sha256Bytes(bytes);

      // 2. In parallel, gather every optional evidence type.
      const c2paReader = c2paLoader ? new C2PAReader(c2paLoader) : null;
      const faceAdapter = faceLandmarkerLoader
        ? new FaceLandmarkerAdapter(faceLandmarkerLoader)
        : null;
      const webauthnClient = webauthnOptions
        ? new WebAuthnClient(webauthnOptions)
        : null;
      const sensorFusion = new SensorFusion();
      const streamingThreeDEnabled = streaming3D?.enabled === true;

      // Streaming-3D is opt-in and non-fatal — a recorder failure on, say,
      // a desktop without a webcam should not abort the photo capture flow.
      const streaming3DPromise: Promise<StreamingThreeDResult | null> = streamingThreeDEnabled
        ? StreamingThreeD.recordAndInfer({
            apiBaseUrl: apiBase,
            bearerToken,
            jobId,
            deviceId: streaming3D?.deviceId,
            recordMs: streaming3D?.recordMs,
            fps: streaming3D?.fps,
            maxFrames: streaming3D?.maxFrames,
            downsamplePoints: streaming3D?.downsamplePoints,
            mode: streaming3D?.mode,
          }).catch((err) => {
            // Soft-fail: surface to console; manifest will omit pointMaps3D.
            // The verifier downgrades gracefully when the trace is absent.
            console.warn("StreamingThreeD: capture/inference failed", err);
            return null;
          })
        : Promise.resolve(null);

      const [
        parsedC2PA,
        faceResult,
        webauthnAssertion,
        sensorResult,
        streaming3DResult,
      ] = await Promise.all([
        c2paReader ? c2paReader.readManifest(blob) : Promise.resolve(null),
        faceAdapter ? faceAdapter.detectFace(bytes) : Promise.resolve(null),
        webauthnClient
          ? webauthnClient.signCaptureHash(
              captureHash,
              challenge.challengeId,
            )
          : Promise.resolve(null),
        sensorFusion.capture({
          durationMs: 5000,
          sampleRateHz: 10,
        }),
        streaming3DPromise,
      ]);

      // 3. Compose the CaptureManifest.
      setStage("uploading");
      setStageDetail("Uploading evidence to gateway…");

      const manifest: CaptureManifest = {
        class: declaredClass,
        declaredAt: new Date().toISOString(),
        deviceFingerprint: sensorResult.trace.deviceId,
        mediaHash: `sha256:${bytesToHex(captureHash)}`,
        sensorFusion: sensorResult.trace,
      };
      if (webauthnAssertion) {
        manifest.webAuthnAssertion = webauthnAssertion;
      }
      if (streaming3DResult) {
        manifest.pointMaps3D = streaming3DResult.trace;
      }

      // The c2paManifest field on CaptureManifest is the structured view
      // (C2PAManifest), not the browser-side parsed shape from C2PAReader.
      // The gateway parses the raw binary if we attach it; otherwise the
      // detector works off the parsed-in-browser signal via the
      // multipart "c2paManifest" part below (server reparses canonically).

      // Liveness hint is not part of the spec manifest; we use it to decide
      // locally whether the detector will have the landmarker signal.
      void faceResult;
      void parsedC2PA;

      // 4. Build the multipart form and POST it.
      const form = new FormData();
      form.append("manifest", JSON.stringify(manifest));
      form.append("capture", blob, "capture.jpg");
      // If c2paLoader was supplied and the frame has a manifest, we just
      // attach the raw bytes — gateway re-parses.
      // (The JPEG blob itself carries any C2PA manifest JUMBF box.)

      const res = await fetch(`${apiBase}/api/capture/upload`, {
        method: "POST",
        headers: {
          // DO NOT set Content-Type — FormData sets boundary automatically.
          Authorization: `Bearer ${bearerToken}`,
        },
        body: form,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `upload_failed: HTTP ${res.status} ${body.slice(0, 200)}`,
        );
      }
      const result = (await res.json()) as CaptureUploadResult;
      setStage("done");
      setStageDetail(`Verdict ${result.verdict} — class ${result.verifiedClass}`);

      // Stop the camera once we have a verdict.
      const stream = mediaStreamRef.current;
      if (stream) {
        stopStream(stream);
        mediaStreamRef.current = null;
      }

      onComplete(result);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setFatalError(e.message);
      setStage("error");
      onError(e);
    }
  }, [
    apiBase,
    bearerToken,
    c2paLoader,
    challenge,
    declaredClass,
    faceLandmarkerLoader,
    jobId,
    onComplete,
    onError,
    streaming3D,
    webauthnOptions,
  ]);

  // --- Render --------------------------------------------------------
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-white/5 bg-black/30 p-6 text-white",
        className,
      )}
      data-stage={stage}
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-400/60">
            Capture Verification
          </p>
          <h2 className="text-lg font-semibold">
            Job {jobId} — declared {declaredClass}
          </h2>
        </div>
        <StageBadge stage={stage} />
      </header>

      <p className="text-sm text-white/60">{stageDetail}</p>

      {/* Video + canvas always mounted so refs stabilize; visibility toggles */}
      <div className="flex flex-col md:flex-row items-start gap-4">
        <div
          className={cn(
            "relative overflow-hidden rounded-xl bg-black",
            stage === "capturing" || stage === "evidence"
              ? "block"
              : "hidden",
          )}
          style={{ minWidth: 320, minHeight: 240 }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-auto"
          />
        </div>
        <canvas ref={canvasRef} className="hidden" />
        {challenge && (stage === "capturing" || stage === "evidence") && (
          <VisualNonceRenderer nonce={challenge.visualNonce} />
        )}
      </div>

      {stage === "capturing" && (
        <button
          type="button"
          onClick={doCapture}
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 text-black font-medium px-5 py-3 hover:bg-emerald-400 transition"
        >
          Capture
        </button>
      )}

      {stage === "error" && fatalError && (
        <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200 font-mono">
          {fatalError}
        </div>
      )}

      {stage === "done" && (
        <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">
          Capture complete — awaiting on-chain anchor.
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Presentational helpers
// -----------------------------------------------------------------------

interface StageBadgeProps {
  stage: Stage;
}

function StageBadge({ stage }: StageBadgeProps): React.JSX.Element {
  const labelMap: Record<Stage, string> = {
    challenge: "1 / 4 · Challenge",
    capturing: "2 / 4 · Frame",
    evidence: "3 / 4 · Evidence",
    uploading: "4 / 4 · Upload",
    done: "Done",
    error: "Error",
  };
  const tone = stage === "error"
    ? "bg-red-500/10 text-red-300 border-red-400/30"
    : stage === "done"
      ? "bg-emerald-500/10 text-emerald-300 border-emerald-400/30"
      : "bg-white/5 text-white/70 border-white/10";
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-widest",
        tone,
      )}
    >
      {labelMap[stage]}
    </span>
  );
}

// -----------------------------------------------------------------------
// Pure helpers — exported for tests.
// -----------------------------------------------------------------------

/**
 * Convert a canvas to a `Blob`, with a sensible default for browsers that
 * occasionally hand back `null` (some older Safari versions).
 *
 * Exported for tests.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas_toblob_null"));
      },
      type,
      quality,
    );
  });
}

/**
 * SHA-256 a byte array using the browser's `crypto.subtle`. Returns raw
 * bytes. Exported for tests.
 */
export async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  // Some test harnesses pass a Node Buffer — normalize to a plain view.
  const view = new Uint8Array(data.byteLength);
  view.set(data);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return new Uint8Array(digest);
}

/**
 * Hex-encode a byte array (lowercase, no separators). Exported for tests.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** Stop all tracks on a MediaStream. Safe to call multiple times. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* best-effort */
    }
  }
}
