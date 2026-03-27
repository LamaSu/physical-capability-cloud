import React, { useCallback, useEffect, useRef, useState } from "react";
import { recognizeGesture } from "./GestureRecognizer.js";
import { useGestures } from "./useGestures.js";

// ---------------------------------------------------------------------------
// HandTracker — loads MediaPipe Hands from CDN and tracks hand gestures
//
// We load from CDN to avoid wasm/model-file bundling issues with Vite.
// The @mediapipe/hands package bundles .wasm + .tflite models that
// require special Vite config; CDN loading avoids this entirely.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function loadMediaPipe() {
  await loadScript(
    "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.min.js",
  );
  await loadScript(
    "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.min.js",
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HandTracker() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gesture, setGesture] = useState<string>("none");
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<any>(null);
  const handsRef = useRef<any>(null);
  const { handleGesture } = useGestures();

  const startTracking = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await loadMediaPipe();

      // Access the global Hands class
      const HandsClass = (window as any).Hands;
      if (!HandsClass) {
        throw new Error("MediaPipe Hands failed to load");
      }

      const hands = new HandsClass({
        locateFile: (file: string) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`;
        },
      });

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 0, // Lite model for better performance
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });

      hands.onResults((results: any) => {
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
          const landmarks = results.multiHandLandmarks[0];
          const gestureEvent = recognizeGesture(landmarks);
          setGesture(gestureEvent.type);
          handleGesture(gestureEvent);
        } else {
          setGesture("none");
        }
      });

      handsRef.current = hands;

      // Start camera
      const CameraClass = (window as any).Camera;
      if (!CameraClass || !videoRef.current) {
        throw new Error("Camera utils failed to load");
      }

      const camera = new CameraClass(videoRef.current, {
        onFrame: async () => {
          if (handsRef.current && videoRef.current) {
            await handsRef.current.send({ image: videoRef.current });
          }
        },
        width: 320,
        height: 240,
      });

      cameraRef.current = camera;
      await camera.start();

      setEnabled(true);
    } catch (err: any) {
      setError(err.message || "Failed to start hand tracking");
      console.error("HandTracker error:", err);
    } finally {
      setLoading(false);
    }
  }, [handleGesture]);

  const stopTracking = useCallback(() => {
    if (cameraRef.current) {
      cameraRef.current.stop();
      cameraRef.current = null;
    }
    if (handsRef.current) {
      handsRef.current.close();
      handsRef.current = null;
    }
    setEnabled(false);
    setGesture("none");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cameraRef.current) {
        cameraRef.current.stop();
      }
      if (handsRef.current) {
        handsRef.current.close();
      }
    };
  }, []);

  return (
    <div className="fixed bottom-16 right-4 z-[10001] flex flex-col items-end gap-2">
      {/* Gesture indicator */}
      {enabled && gesture !== "none" && (
        <div className="px-2 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono">
          {gesture}
        </div>
      )}

      {/* Camera preview */}
      {enabled && (
        <div className="w-32 h-24 rounded-xl overflow-hidden border border-white/[0.08] opacity-40 hover:opacity-80 transition-opacity">
          <video
            ref={videoRef}
            className="w-full h-full object-cover mirror"
            style={{ transform: "scaleX(-1)" }}
            playsInline
            muted
          />
        </div>
      )}

      {/* Toggle button */}
      <button
        onClick={enabled ? stopTracking : startTracking}
        disabled={loading}
        className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
          enabled
            ? "bg-emerald-500/15 border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/25"
            : "bg-white/[0.04] border-white/[0.08] text-white/50 hover:bg-white/[0.08]"
        } ${loading ? "opacity-50 cursor-wait" : ""}`}
      >
        {loading ? (
          <span className="animate-pulse">Loading...</span>
        ) : enabled ? (
          <>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Gestures On
          </>
        ) : (
          <>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
              <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
              <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
              <path d="M18 8a2 2 0 0 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
            </svg>
            Gestures
          </>
        )}
      </button>

      {/* Error display */}
      {error && (
        <div className="px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] max-w-48">
          {error}
        </div>
      )}

      {/* Hidden video element for non-enabled state */}
      {!enabled && (
        <video ref={videoRef} className="hidden" playsInline muted />
      )}
    </div>
  );
}
