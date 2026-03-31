import { spring, interpolate, Easing } from "remotion";

export const smooth = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { damping: 200 } });

export const slam = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { stiffness: 800, damping: 22, mass: 0.5 }, durationInFrames: 12 });

export const slamScale = (frame: number, fps: number, delay = 0, from = 2.5) =>
  interpolate(slam(frame, fps, delay), [0, 1], [from, 1]);

export const fadeUp = (frame: number, fps: number, delay = 0) => {
  const p = smooth(frame, fps, delay);
  return { opacity: p, y: interpolate(p, [0, 1], [30, 0]) };
};

export const flash = (frame: number, at: number, dur = 3) =>
  frame >= at && frame < at + dur ? 1 - (frame - at) / dur : 0;

export const breathe = (frame: number, fps: number, min = 0.8, max = 1) => {
  const t = (frame / fps) * Math.PI * 2 / 3;
  return min + (max - min) * (0.5 + 0.5 * Math.sin(t));
};

export const countTo = (frame: number, to: number, dur = 60, delay = 0) =>
  Math.round(interpolate(Math.max(0, frame - delay), [0, dur], [0, to], {
    extrapolateRight: "clamp", easing: Easing.out(Easing.cubic),
  }));
