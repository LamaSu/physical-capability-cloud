// ---------------------------------------------------------------------------
// GestureRecognizer — detects hand gestures from MediaPipe landmarks
//
// Gestures:
//   - PINCH:       thumb tip + index tip close (< threshold)
//   - OPEN_PALM:   all fingers extended
//   - FIST:        all fingers curled
//   - PEACE:       index + middle extended, others curled
//   - FLICK:       fast horizontal hand movement
// ---------------------------------------------------------------------------

export type GestureType = "pinch" | "open_palm" | "fist" | "peace" | "flick" | "none";

export interface GestureEvent {
  type: GestureType;
  /** Normalized screen position (0-1 range) of the palm center */
  x: number;
  y: number;
  /** Raw landmark data if needed */
  landmarks: Array<{ x: number; y: number; z: number }>;
}

// MediaPipe hand landmark indices
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const INDEX_MCP = 5;
const MIDDLE_TIP = 12;
const MIDDLE_MCP = 9;
const RING_TIP = 16;
const RING_MCP = 13;
const PINKY_TIP = 20;
const PINKY_MCP = 17;

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function isFingerExtended(
  tip: { x: number; y: number },
  mcp: { x: number; y: number },
  wrist: { x: number; y: number },
): boolean {
  // A finger is extended if the tip is farther from the wrist than the MCP joint
  return distance(tip, wrist) > distance(mcp, wrist) * 1.1;
}

// ---------------------------------------------------------------------------
// Flick detection — tracks palm position over time
// ---------------------------------------------------------------------------

let prevPalmX: number | null = null;
let prevPalmTime = 0;
const FLICK_THRESHOLD = 0.15; // 15% of screen width per frame
const FLICK_COOLDOWN = 500; // ms
let lastFlickTime = 0;

// ---------------------------------------------------------------------------
// Recognize gesture from landmarks
// ---------------------------------------------------------------------------

export function recognizeGesture(
  landmarks: Array<{ x: number; y: number; z: number }>,
): GestureEvent {
  if (!landmarks || landmarks.length < 21) {
    return { type: "none", x: 0.5, y: 0.5, landmarks: [] };
  }

  const wrist = landmarks[WRIST];
  const thumbTip = landmarks[THUMB_TIP];
  const indexTip = landmarks[INDEX_TIP];
  const indexMcp = landmarks[INDEX_MCP];
  const middleTip = landmarks[MIDDLE_TIP];
  const middleMcp = landmarks[MIDDLE_MCP];
  const ringTip = landmarks[RING_TIP];
  const ringMcp = landmarks[RING_MCP];
  const pinkyTip = landmarks[PINKY_TIP];
  const pinkyMcp = landmarks[PINKY_MCP];

  // Palm center (average of MCP joints)
  const palmX = (indexMcp.x + middleMcp.x + ringMcp.x + pinkyMcp.x) / 4;
  const palmY = (indexMcp.y + middleMcp.y + ringMcp.y + pinkyMcp.y) / 4;

  // Finger extension checks
  const indexExtended = isFingerExtended(indexTip, indexMcp, wrist);
  const middleExtended = isFingerExtended(middleTip, middleMcp, wrist);
  const ringExtended = isFingerExtended(ringTip, ringMcp, wrist);
  const pinkyExtended = isFingerExtended(pinkyTip, pinkyMcp, wrist);

  const base: Omit<GestureEvent, "type"> = { x: palmX, y: palmY, landmarks };

  // Flick detection
  const now = Date.now();
  if (prevPalmX !== null && now - prevPalmTime < 100) {
    const dx = Math.abs(palmX - prevPalmX);
    if (dx > FLICK_THRESHOLD && now - lastFlickTime > FLICK_COOLDOWN) {
      lastFlickTime = now;
      prevPalmX = palmX;
      prevPalmTime = now;
      return { type: "flick", ...base };
    }
  }
  prevPalmX = palmX;
  prevPalmTime = now;

  // Pinch: thumb tip close to index tip
  const pinchDist = distance(thumbTip, indexTip);
  if (pinchDist < 0.05) {
    return { type: "pinch", ...base };
  }

  // Peace sign: index + middle extended, ring + pinky curled
  if (indexExtended && middleExtended && !ringExtended && !pinkyExtended) {
    return { type: "peace", ...base };
  }

  // Open palm: all 4 fingers extended
  if (indexExtended && middleExtended && ringExtended && pinkyExtended) {
    return { type: "open_palm", ...base };
  }

  // Fist: all 4 fingers curled
  if (!indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
    return { type: "fist", ...base };
  }

  return { type: "none", ...base };
}
