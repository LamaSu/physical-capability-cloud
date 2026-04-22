/**
 * Capture Verification Protocol — in-scene visual-nonce renderer.
 *
 * A `VisualNonce` has to be visually present in the frame the operator
 * captures, so the detector's pass-5 (browser) and pass-3 (liveness) can
 * confirm this specific capture was taken against this specific challenge.
 * Three nonce kinds, each rendered differently:
 *
 *   - `qr`      — draw a QR of the `payload` on a canvas (via `qrcode`). The
 *                 detector re-reads the QR from the captured frame and
 *                 compares to the server-issued payload.
 *   - `color`   — render a prominent six-hex color swatch plus the hex text
 *                 (so operators don't need a colorimeter). The detector runs
 *                 a dominant-color extraction on the frame and matches.
 *   - `gesture` — render a short instruction string ("Look up, then left").
 *                 The verifier confirms the landmarker yaw/pitch pattern
 *                 matches the gesture.
 *
 * The component is deliberately self-contained (no context / redux / routes)
 * so the parent `CaptureFlow` can render it alongside the camera preview and
 * the detector sees both the user + nonce in a single frame.
 *
 * Author: ui-capture-mike
 * See: ai/research/capture-verification-protocol.md §4 pass 5, §9.2 step 3
 */

import React from "react";
import QRCode from "qrcode";
import type { VisualNonce } from "@pcc/spec";
import { cn } from "../utils.js";

/** Props for the renderer. */
export interface VisualNonceRendererProps {
  /** The nonce the gateway issued for this capture challenge. */
  nonce: VisualNonce;
  /**
   * Optional tailwind/raw class string. Applies to the outer container
   * alongside our default layout utilities.
   */
  className?: string;
  /**
   * Optional size override for the QR canvas / color swatch (pixels).
   * Minimum 128 (the design doc requires a ≥128 px visual so the detector
   * can reliably reconstruct it from the capture). Default 200.
   */
  sizePx?: number;
}

/** Design-doc-mandated minimum visual size. */
const MIN_NONCE_SIZE = 128;
const DEFAULT_NONCE_SIZE = 200;

/**
 * Render the visual nonce the operator must embed in their capture frame.
 *
 * Usage:
 * ```tsx
 * <VisualNonceRenderer nonce={challenge.visualNonce} />
 * ```
 *
 * The component never throws — QR-render failures surface as a fallback
 * text block so the operator can still manually type the payload if needed.
 */
export function VisualNonceRenderer({
  nonce,
  className,
  sizePx = DEFAULT_NONCE_SIZE,
}: VisualNonceRendererProps): React.JSX.Element {
  const size = Math.max(MIN_NONCE_SIZE, sizePx);

  switch (nonce.type) {
    case "qr":
      return <QrNonceView payload={nonce.payload} size={size} className={className} />;
    case "color":
      return <ColorNonceView payload={nonce.payload} size={size} className={className} />;
    case "gesture":
      return <GestureNonceView payload={nonce.payload} size={size} className={className} />;
    default:
      // Exhaustiveness guard — VisualNonce.type is a string-literal union,
      // but older issuers could theoretically emit something unknown. Render
      // a safe fallback.
      return (
        <div
          className={cn(
            "rounded-xl border border-amber-400/30 bg-amber-500/[0.06] p-4",
            className,
          )}
          data-nonce-type="unknown"
        >
          <p className="text-sm text-amber-300/80 font-mono">
            Unknown nonce kind. Payload:
          </p>
          <p className="mt-1 font-mono text-xs break-all text-amber-200/70">
            {String((nonce as VisualNonce).payload ?? "")}
          </p>
        </div>
      );
  }
}

// -----------------------------------------------------------------------
// QR sub-view
// -----------------------------------------------------------------------

interface QrNonceViewProps {
  payload: string;
  size: number;
  className?: string;
}

/**
 * Render a QR code on an HTML canvas using the `qrcode` package.
 *
 * We run the draw in an effect (not during render) because `qrcode.toCanvas`
 * is async. The payload is drawn at full contrast with an 8-pixel margin
 * and ECC level `M` (default) — enough redundancy to survive phone-camera
 * compression and auto-focus smearing.
 */
function QrNonceView({
  payload,
  size,
  className,
}: QrNonceViewProps): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, payload, {
      width: size,
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        // Render on white so the detector's binarization step has a clean
        // contrast threshold regardless of the operator's display theme.
        dark: "#000000",
        light: "#FFFFFF",
      },
    }).then(
      () => {
        if (!cancelled) setError(null);
      },
      (err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [payload, size]);

  return (
    <div
      className={cn(
        "inline-flex flex-col items-center gap-2 rounded-xl bg-white p-3",
        className,
      )}
      data-nonce-type="qr"
    >
      {error ? (
        <div
          className="flex items-center justify-center rounded-md bg-red-100 text-red-700 text-xs font-mono p-2"
          style={{ width: size, height: size }}
        >
          {`QR render failed: ${error}`}
        </div>
      ) : (
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          aria-label="Capture-verification QR code"
        />
      )}
      <p className="text-[10px] font-mono text-slate-500 break-all text-center max-w-full px-1">
        {payload}
      </p>
    </div>
  );
}

// -----------------------------------------------------------------------
// Color sub-view
// -----------------------------------------------------------------------

interface ColorNonceViewProps {
  payload: string;
  size: number;
  className?: string;
}

/**
 * Render a single solid color swatch sized to `size` alongside the hex
 * text.
 *
 * The payload is expected to be a 6-hex string ("a3b5c7") or a `#a3b5c7`
 * form. We sanitize into `#RRGGBB`; if the payload isn't parseable we fall
 * back to neutral grey and surface the raw text for the operator.
 */
function ColorNonceView({
  payload,
  size,
  className,
}: ColorNonceViewProps): React.JSX.Element {
  const parsed = parseHexColor(payload);
  const bg = parsed ?? "#6b7280"; // grey-500 fallback
  const textContrast = parsed ? pickContrastColor(parsed) : "#111111";

  return (
    <div
      className={cn(
        "inline-flex flex-col items-center gap-2 rounded-xl border border-white/10 p-3",
        className,
      )}
      data-nonce-type="color"
    >
      <div
        className="flex items-center justify-center rounded-lg"
        style={{
          width: size,
          height: size,
          backgroundColor: bg,
          color: textContrast,
        }}
      >
        <span className="font-mono text-base tracking-widest uppercase">
          {parsed ?? "?"}
        </span>
      </div>
      <p className="text-[10px] font-mono text-white/50 break-all text-center">
        {payload}
      </p>
    </div>
  );
}

/**
 * Parse a hex-color payload. Accepts `#RRGGBB`, `RRGGBB`, `#RGB`, and `RGB`
 * (latter two are expanded). Returns canonical `#RRGGBB` upper-case, or
 * null if the input doesn't look like a hex color.
 *
 * Exported for tests.
 */
export function parseHexColor(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/^#/, "").toUpperCase();
  if (/^[0-9A-F]{6}$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  if (/^[0-9A-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return null;
}

/**
 * Pick a readable foreground (black or white) given a background hex.
 *
 * Uses the WCAG-ish relative-luminance cut at 0.5 — not perfect but does
 * the job for a 6-character display swatch. Exported for tests.
 */
export function pickContrastColor(hex: string): "#000000" | "#FFFFFF" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#000000";
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // sRGB → relative luminance (approximate, no gamma correction).
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.5 ? "#000000" : "#FFFFFF";
}

// -----------------------------------------------------------------------
// Gesture sub-view
// -----------------------------------------------------------------------

interface GestureNonceViewProps {
  payload: string;
  size: number;
  className?: string;
}

/**
 * Render a physical-gesture instruction prominently so the operator can
 * read it while framing the shot.
 *
 * The detector later correlates this with the head-yaw / pitch series from
 * `FaceLandmarkerAdapter`.
 */
function GestureNonceView({
  payload,
  size,
  className,
}: GestureNonceViewProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "inline-flex flex-col items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06] p-4",
        className,
      )}
      style={{ minWidth: size, minHeight: size }}
      data-nonce-type="gesture"
    >
      <p className="text-[10px] uppercase tracking-[0.2em] text-emerald-300/60">
        Perform gesture
      </p>
      <p className="text-xl font-semibold text-emerald-100 text-center max-w-[90%] leading-snug">
        {payload}
      </p>
      <p className="text-[10px] text-emerald-300/40">
        Then tap capture
      </p>
    </div>
  );
}
