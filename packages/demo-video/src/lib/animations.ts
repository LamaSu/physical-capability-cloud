import { spring, interpolate, Easing } from "remotion";

// ─── ORIGINAL SPRINGS (kept) ───

/** Smooth spring with no bounce — use for most UI entrances */
export const smoothSpring = (
  frame: number,
  fps: number,
  delay = 0,
  durationInFrames?: number,
) =>
  spring({
    frame: frame - delay,
    fps,
    config: { damping: 200 },
    ...(durationInFrames ? { durationInFrames } : {}),
  });

/** Bouncy spring — use for emphasis/attention */
export const bouncySpring = (frame: number, fps: number, delay = 0) =>
  spring({
    frame: frame - delay,
    fps,
    config: { stiffness: 300, damping: 15 },
  });

/** Snappy spring — use for buttons/cards */
export const snappySpring = (frame: number, fps: number, delay = 0) =>
  spring({
    frame: frame - delay,
    fps,
    config: { stiffness: 300, damping: 30, overshootClamping: true },
    durationInFrames: 20,
  });

/** Fade in with upward slide */
export const fadeSlideUp = (
  frame: number,
  fps: number,
  delay = 0,
): { opacity: number; translateY: number } => {
  const progress = smoothSpring(frame, fps, delay);
  return {
    opacity: progress,
    translateY: interpolate(progress, [0, 1], [30, 0]),
  };
};

/** Counter animation value */
export const countTo = (
  frame: number,
  to: number,
  duration = 60,
  delay = 0,
  from = 0,
): number => {
  const adjusted = Math.max(0, frame - delay);
  return Math.round(
    interpolate(adjusted, [0, duration], [from, to], {
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }),
  );
};

/** Stagger delay for array items */
export const staggerDelay = (index: number, perItem = 5) => index * perItem;

/** Typewriter character count */
export const typewriterChars = (
  frame: number,
  delay = 0,
  charsPerFrame = 0.8,
  maxChars: number,
): number => {
  const adjusted = Math.max(0, frame - delay);
  return Math.min(Math.floor(adjusted * charsPerFrame), maxChars);
};

// ─── NEW: DnB / TikTok TRAILER ANIMATIONS ───

/**
 * SLAM spring — element arrives at high scale and SNAPS to 1x.
 * Aggressive stiffness, low damping, fast settle.
 * The "drop" moment in a DnB track.
 */
export const slamSpring = (frame: number, fps: number, delay = 0) =>
  spring({
    frame: frame - delay,
    fps,
    config: { stiffness: 800, damping: 22, mass: 0.5 },
    durationInFrames: 12,
  });

/**
 * SLAM scale — element enters at `from` scale, snaps to 1x.
 * Default 3x → 1x for maximum impact. Use 2x for secondary elements.
 */
export const slamScale = (
  frame: number,
  fps: number,
  delay = 0,
  from = 3,
): number => {
  const p = slamSpring(frame, fps, delay);
  return interpolate(p, [0, 1], [from, 1]);
};

/**
 * WHIP IN — ultra-fast entrance from off-screen + opacity snap.
 * Direction: positive distance = from right, negative = from left.
 */
export const whipIn = (
  frame: number,
  fps: number,
  delay = 0,
  distance = 200,
): { opacity: number; translateX: number } => {
  const p = slamSpring(frame, fps, delay);
  return {
    opacity: Math.min(p * 5, 1), // nearly instant opacity
    translateX: interpolate(p, [0, 1], [distance, 0]),
  };
};

/**
 * WHIP UP — same energy but vertical.
 */
export const whipUp = (
  frame: number,
  fps: number,
  delay = 0,
  distance = 150,
): { opacity: number; translateY: number } => {
  const p = slamSpring(frame, fps, delay);
  return {
    opacity: Math.min(p * 5, 1),
    translateY: interpolate(p, [0, 1], [distance, 0]),
  };
};

/**
 * FLASH BURST — 2-frame brightness spike, then gone.
 * Returns 0→1→0. Use for beat-drop white/discord flashes.
 */
export const flashBurst = (
  frame: number,
  triggerFrame: number,
  duration = 2,
): number => {
  if (frame < triggerFrame || frame >= triggerFrame + duration) return 0;
  const t = (frame - triggerFrame) / duration;
  return 1 - t; // bright peak → instant fade
};

/**
 * BEAT PULSE — periodic brightness at BPM.
 * Default 170 BPM (DnB). At 30fps, one beat = ~10.6 frames.
 * Sharp attack, exponential decay. Use for background rhythm.
 */
export const beatPulse = (
  frame: number,
  fps: number,
  bpm = 170,
  intensity = 0.3,
): number => {
  const beatFrames = (60 / bpm) * fps;
  const phase = (frame % beatFrames) / beatFrames;
  return Math.max(0, (1 - phase * 4) * intensity); // sharp attack, fast decay
};

/**
 * HARD CUT opacity — binary on/off at a specific frame.
 * No spring, no interpolation. Just appears.
 */
export const hardCut = (frame: number, appearFrame: number): number =>
  frame >= appearFrame ? 1 : 0;

/**
 * STROBE — rapid on-off flicker for tension moments.
 * period = frames per cycle. duty = fraction that's "on" (0-1).
 */
export const strobe = (
  frame: number,
  startFrame: number,
  endFrame: number,
  period = 4,
  duty = 0.5,
): number => {
  if (frame < startFrame || frame >= endFrame) return 0;
  return ((frame - startFrame) % period) / period < duty ? 1 : 0;
};

/**
 * VELOCITY RAMP — accelerates or decelerates over a range.
 * Returns 0→1 with easing. Use for "quickening" or "slowing" storytelling.
 */
export const velocityRamp = (
  frame: number,
  startFrame: number,
  endFrame: number,
  mode: "accelerate" | "decelerate" = "accelerate",
): number => {
  const t = interpolate(frame, [startFrame, endFrame], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return mode === "accelerate"
    ? Easing.in(Easing.cubic)(t)
    : Easing.out(Easing.cubic)(t);
};

/**
 * BREATHE — slow sinusoidal oscillation for reverent/meditative moments.
 * Returns value between min and max. Default cycle = 3 seconds.
 */
export const breathe = (
  frame: number,
  fps: number,
  min = 0.7,
  max = 1.0,
  cycleSec = 3,
): number => {
  const t = (frame / fps) * (Math.PI * 2) / cycleSec;
  return min + (max - min) * (0.5 + 0.5 * Math.sin(t));
};
