import React, { useEffect, useRef } from "react";

/**
 * HoloSkills — a holographic registry of physical skills for the landing hero.
 *
 * A zero-dependency WebGL point cloud renders ten procedurally-built "skill"
 * silhouettes (CNC mill, impact driver, survey drone, FDM printer, forklift,
 * lathe, freight truck, robot arm, wrench, microscope) floating above a
 * projector ring. Every ~5s the cloud warp-morphs into the next skill: each
 * particle swirls around Y and puffs outward while streaming to its new home.
 *
 * Implementation notes:
 *  - No three.js. One shader program, one POINTS draw call, ~6.5k particles.
 *    Both endpoint positions live in attributes; the GPU interpolates, so the
 *    per-frame JS cost is a handful of uniform writes.
 *  - Shapes are sampled from primitive surfaces (box/tube/torus/sphere/disc),
 *    bbox-normalized, then index-shuffled with a seeded RNG so morphs
 *    criss-cross instead of sliding part-to-part. The projector ring occupies
 *    the same trailing indices in every shape, so it holds still.
 *  - aRand carries a per-particle random in its magnitude and "is ring" in its
 *    sign — saves an attribute.
 *  - Each skill is tagged with its PCC lane (MACHINE / HUMAN / ASSET) and the
 *    hologram tint + readout chip shift to the lane color.
 *  - Pauses via IntersectionObserver, honors prefers-reduced-motion, hides
 *    itself below 1200px (the hero copy needs the width).
 */

type Lane = "MACHINE" | "HUMAN" | "ASSET";

type Emit = (out: Float32Array, off: number, n: number, rnd: () => number) => void;

interface Part {
  w: number;
  emit: Emit;
}

interface SkillDef {
  name: string;
  lane: Lane;
  detail: string;
  parts: Part[];
}

const MODEL_N = 5600;
const RING_N = 860;
const N = MODEL_N + RING_N;
const RING_Y = -0.94;
const FOV = 34;
const CAM_Z = 3.6;
const CAM_Y = 0.1;

/* ------------------------------------------------------------------ rng -- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------- primitive samplers ---- */

/** Box surface, s* are full extents. */
function bx(w: number, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Part {
  return {
    w,
    emit: (out, off, n, rnd) => {
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      const aXY = sx * sy, aXZ = sx * sz, aYZ = sy * sz;
      const tot = 2 * (aXY + aXZ + aYZ);
      for (let i = 0; i < n; i++) {
        const r = rnd() * tot;
        const u = rnd() * 2 - 1, v = rnd() * 2 - 1;
        let x: number, y: number, z: number;
        if (r < aXY) { x = u * hx; y = v * hy; z = hz; }
        else if (r < 2 * aXY) { x = u * hx; y = v * hy; z = -hz; }
        else if (r < 2 * aXY + aXZ) { x = u * hx; y = hy; z = v * hz; }
        else if (r < 2 * (aXY + aXZ)) { x = u * hx; y = -hy; z = v * hz; }
        else if (r < 2 * (aXY + aXZ) + aYZ) { x = hx; y = u * hy; z = v * hz; }
        else { x = -hx; y = u * hy; z = v * hz; }
        const j = (off + i) * 3;
        out[j] = cx + x; out[j + 1] = cy + y; out[j + 2] = cz + z;
      }
    },
  };
}

/** Tube (open cylinder) from a to b, lateral surface. */
function tu(w: number, ax: number, ay: number, az: number, bx_: number, by: number, bz: number, r: number): Part {
  return {
    w,
    emit: (out, off, n, rnd) => {
      const dx = bx_ - ax, dy = by - ay, dz = bz - az;
      const L = Math.hypot(dx, dy, dz) || 1;
      const nx = dx / L, ny = dy / L, nz = dz / L;
      // orthonormal basis perpendicular to the axis
      const hx = Math.abs(ny) < 0.99 ? 0 : 1, hy = Math.abs(ny) < 0.99 ? 1 : 0;
      let ux = ny * 0 - nz * hy, uy = nz * hx - nx * 0, uz = nx * hy - ny * hx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
      for (let i = 0; i < n; i++) {
        const t = rnd();
        const th = rnd() * Math.PI * 2;
        const rr = r * (0.88 + 0.24 * rnd());
        const c = Math.cos(th) * rr, s = Math.sin(th) * rr;
        const j = (off + i) * 3;
        out[j] = ax + dx * t + ux * c + vx * s;
        out[j + 1] = ay + dy * t + uy * c + vy * s;
        out[j + 2] = az + dz * t + uz * c + vz * s;
      }
    },
  };
}

/** Torus (full or arc) around the given axis. a0/a1 are the arc range in radians. */
function to(
  w: number, cx: number, cy: number, cz: number, R: number, r: number,
  axis: "x" | "y" | "z", a0 = 0, a1 = Math.PI * 2,
): Part {
  return {
    w,
    emit: (out, off, n, rnd) => {
      for (let i = 0; i < n; i++) {
        const th = a0 + rnd() * (a1 - a0);
        const ph = rnd() * Math.PI * 2;
        const ww = R + r * Math.cos(ph);
        const sv = r * Math.sin(ph);
        const c = Math.cos(th) * ww, s = Math.sin(th) * ww;
        const j = (off + i) * 3;
        if (axis === "y") { out[j] = cx + c; out[j + 1] = cy + sv; out[j + 2] = cz + s; }
        else if (axis === "z") { out[j] = cx + c; out[j + 1] = cy + s; out[j + 2] = cz + sv; }
        else { out[j] = cx + sv; out[j + 1] = cy + c; out[j + 2] = cz + s; }
      }
    },
  };
}

/** Sphere surface. */
function sp(w: number, cx: number, cy: number, cz: number, r: number): Part {
  return {
    w,
    emit: (out, off, n, rnd) => {
      for (let i = 0; i < n; i++) {
        const z = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const s = Math.sqrt(Math.max(0, 1 - z * z));
        const j = (off + i) * 3;
        out[j] = cx + Math.cos(th) * s * r;
        out[j + 1] = cy + z * r;
        out[j + 2] = cz + Math.sin(th) * s * r;
      }
    },
  };
}

/** Filled disc perpendicular to the given axis. */
function ds(w: number, cx: number, cy: number, cz: number, r: number, axis: "x" | "y" | "z"): Part {
  return {
    w,
    emit: (out, off, n, rnd) => {
      for (let i = 0; i < n; i++) {
        const rho = r * Math.sqrt(rnd());
        const th = rnd() * Math.PI * 2;
        const c = Math.cos(th) * rho, s = Math.sin(th) * rho;
        const j = (off + i) * 3;
        if (axis === "y") { out[j] = cx + c; out[j + 1] = cy; out[j + 2] = cz + s; }
        else if (axis === "z") { out[j] = cx + c; out[j + 1] = cy + s; out[j + 2] = cz; }
        else { out[j] = cx; out[j + 1] = cy + c; out[j + 2] = cz + s; }
      }
    },
  };
}

/* ------------------------------------------------------------- skills ---- */

const SKILLS: SkillDef[] = [
  {
    name: "CNC_MILLING", lane: "MACHINE", detail: "3-axis gantry · subtractive",
    parts: [
      bx(14, 0, -0.62, 0, 1.55, 0.14, 0.95),
      bx(2, 0, -0.545, -0.22, 1.45, 0.02, 0.03),
      bx(2, 0, -0.545, 0, 1.45, 0.02, 0.03),
      bx(2, 0, -0.545, 0.22, 1.45, 0.02, 0.03),
      bx(6, -0.66, -0.05, -0.18, 0.14, 1.0, 0.26),
      bx(6, 0.66, -0.05, -0.18, 0.14, 1.0, 0.26),
      bx(10, 0, 0.48, -0.18, 1.45, 0.2, 0.24),
      bx(7, 0.1, 0.28, 0.02, 0.24, 0.5, 0.22),
      tu(3, 0.1, 0.03, 0.06, 0.1, -0.2, 0.06, 0.05),
      tu(2, 0.1, -0.2, 0.06, 0.1, -0.36, 0.06, 0.016),
      bx(6, 0.1, -0.47, 0.12, 0.5, 0.16, 0.34),
    ],
  },
  {
    name: "IMPACT_DRIVING", lane: "HUMAN", detail: "field fastening · torque-cert",
    parts: [
      tu(12, -0.6, 0.3, 0, 0.13, 0.3, 0, 0.17),
      sp(2, -0.6, 0.3, 0, 0.17),
      tu(5, 0.13, 0.3, 0, 0.38, 0.3, 0, 0.115),
      tu(3, 0.38, 0.3, 0, 0.8, 0.3, 0, 0.03),
      tu(1, 0.8, 0.3, 0, 0.92, 0.3, 0, 0.014),
      tu(8, -0.12, 0.18, 0, -0.22, -0.42, 0, 0.105),
      bx(6, -0.26, -0.56, 0, 0.42, 0.2, 0.34),
      bx(1.5, -0.02, 0.1, 0, 0.1, 0.12, 0.06),
    ],
  },
  {
    name: "AERIAL_SURVEY", lane: "ASSET", detail: "autonomous quad · photogrammetry",
    parts: [
      bx(6, 0, 0.02, 0, 0.36, 0.13, 0.36),
      sp(2, 0, 0.11, 0, 0.1),
      tu(3, 0, 0.04, 0, 0.54, 0.1, 0.54, 0.035),
      tu(3, 0, 0.04, 0, -0.54, 0.1, 0.54, 0.035),
      tu(3, 0, 0.04, 0, 0.54, 0.1, -0.54, 0.035),
      tu(3, 0, 0.04, 0, -0.54, 0.1, -0.54, 0.035),
      tu(1.2, 0.54, 0.1, 0.54, 0.54, 0.22, 0.54, 0.05),
      tu(1.2, -0.54, 0.1, 0.54, -0.54, 0.22, 0.54, 0.05),
      tu(1.2, 0.54, 0.1, -0.54, 0.54, 0.22, -0.54, 0.05),
      tu(1.2, -0.54, 0.1, -0.54, -0.54, 0.22, -0.54, 0.05),
      to(3.2, 0.54, 0.24, 0.54, 0.25, 0.022, "y"),
      to(3.2, -0.54, 0.24, 0.54, 0.25, 0.022, "y"),
      to(3.2, 0.54, 0.24, -0.54, 0.25, 0.022, "y"),
      to(3.2, -0.54, 0.24, -0.54, 0.25, 0.022, "y"),
      tu(0.6, 0.34, 0.24, 0.54, 0.74, 0.24, 0.54, 0.012),
      tu(0.6, 0.54, 0.24, 0.34, 0.54, 0.24, 0.74, 0.012),
      tu(0.6, -0.74, 0.24, 0.54, -0.34, 0.24, 0.54, 0.012),
      tu(0.6, -0.54, 0.24, -0.34, -0.54, 0.24, -0.74, 0.012),
      sp(2, 0, -0.1, 0.13, 0.085),
      tu(0.8, 0, -0.1, 0.13, 0, -0.1, 0.22, 0.045),
      tu(1.2, -0.34, -0.26, 0.22, 0.34, -0.26, 0.22, 0.022),
      tu(1.2, -0.34, -0.26, -0.22, 0.34, -0.26, -0.22, 0.022),
    ],
  },
  {
    name: "FDM_PRINTING", lane: "MACHINE", detail: "additive · PLA / ABS / PETG",
    parts: [
      bx(10, 0, -0.7, 0.05, 1.15, 0.16, 0.9),
      bx(5, -0.52, 0.05, -0.2, 0.09, 1.34, 0.09),
      bx(5, 0.52, 0.05, -0.2, 0.09, 1.34, 0.09),
      bx(4, 0, 0.74, -0.2, 1.13, 0.09, 0.09),
      bx(5, 0, 0.22, -0.2, 1.05, 0.07, 0.07),
      bx(4, 0.12, 0.16, -0.08, 0.18, 0.24, 0.16),
      tu(1.5, 0.12, 0.02, -0.04, 0.12, -0.07, -0.04, 0.02),
      bx(8, 0, -0.54, 0.08, 0.85, 0.05, 0.7),
      tu(3, 0.12, -0.52, 0.06, 0.12, -0.24, 0.06, 0.13),
      tu(1.5, 0.12, -0.24, 0.06, 0.12, -0.1, 0.06, 0.07),
      to(3.5, -0.4, 0.95, -0.2, 0.16, 0.045, "z"),
    ],
  },
  {
    name: "FORKLIFT_OPS", lane: "HUMAN", detail: "certified operator · 2.5 t",
    parts: [
      bx(10, -0.18, -0.42, 0, 0.95, 0.34, 0.62),
      bx(5, -0.68, -0.36, 0, 0.3, 0.46, 0.56),
      tu(1.2, -0.52, -0.25, 0.26, -0.52, 0.3, 0.26, 0.03),
      tu(1.2, -0.52, -0.25, -0.26, -0.52, 0.3, -0.26, 0.03),
      tu(1.2, 0.14, -0.25, 0.26, 0.14, 0.3, 0.26, 0.03),
      tu(1.2, 0.14, -0.25, -0.26, 0.14, 0.3, -0.26, 0.03),
      bx(4, -0.19, 0.33, 0, 0.78, 0.07, 0.6),
      bx(2, -0.32, -0.16, 0, 0.3, 0.2, 0.3),
      bx(4, 0.5, 0.05, 0.2, 0.07, 1.15, 0.07),
      bx(4, 0.5, 0.05, -0.2, 0.07, 1.15, 0.07),
      bx(1.5, 0.5, 0.5, 0, 0.07, 0.06, 0.42),
      bx(1.5, 0.5, -0.2, 0, 0.07, 0.06, 0.42),
      bx(2.5, 0.57, -0.3, 0, 0.06, 0.32, 0.5),
      bx(3, 0.86, -0.58, 0.16, 0.55, 0.05, 0.09),
      bx(3, 0.86, -0.58, -0.16, 0.55, 0.05, 0.09),
      bx(1.5, 0.61, -0.44, 0.16, 0.05, 0.3, 0.09),
      bx(1.5, 0.61, -0.44, -0.16, 0.05, 0.3, 0.09),
      to(2.2, 0.28, -0.64, 0.33, 0.13, 0.05, "z"),
      to(2.2, 0.28, -0.64, -0.33, 0.13, 0.05, "z"),
      to(2.2, -0.55, -0.64, 0.33, 0.13, 0.05, "z"),
      to(2.2, -0.55, -0.64, -0.33, 0.13, 0.05, "z"),
    ],
  },
  {
    name: "LATHE_TURNING", lane: "MACHINE", detail: "precision turning · ±0.01 mm",
    parts: [
      bx(12, 0, -0.55, 0.02, 1.7, 0.16, 0.42),
      bx(3, -0.6, -0.78, 0.02, 0.18, 0.32, 0.36),
      bx(3, 0.6, -0.78, 0.02, 0.18, 0.32, 0.36),
      bx(9, -0.58, -0.16, 0, 0.42, 0.58, 0.4),
      tu(5, -0.36, -0.08, 0, -0.22, -0.08, 0, 0.19),
      ds(1.5, -0.22, -0.08, 0, 0.19, "x"),
      tu(6, -0.22, -0.08, 0, 0.4, -0.08, 0, 0.075),
      tu(1.5, 0.4, -0.08, 0, 0.54, -0.08, 0, 0.045),
      bx(4, 0.68, -0.3, 0, 0.26, 0.36, 0.3),
      tu(1, 0.54, -0.08, 0, 0.62, -0.08, 0, 0.04),
      bx(3, 0.08, -0.36, 0.16, 0.3, 0.2, 0.2),
      bx(1.5, 0.08, -0.22, 0.1, 0.14, 0.08, 0.16),
    ],
  },
  {
    name: "FREIGHT_TRANSPORT", lane: "ASSET", detail: "class-8 haul · cold chain",
    parts: [
      bx(8, -0.78, -0.16, 0, 0.42, 0.52, 0.52),
      tu(1.2, -0.55, -0.02, 0.28, -0.55, 0.34, 0.28, 0.035),
      bx(16, 0.3, -0.02, 0, 1.3, 0.62, 0.5),
      bx(5, -0.15, -0.48, 0, 1.8, 0.08, 0.28),
      to(1.8, -0.78, -0.6, 0.28, 0.115, 0.045, "z"),
      to(1.8, -0.78, -0.6, -0.28, 0.115, 0.045, "z"),
      to(1.8, -0.3, -0.6, 0.28, 0.115, 0.045, "z"),
      to(1.8, -0.3, -0.6, -0.28, 0.115, 0.045, "z"),
      to(1.8, 0.62, -0.6, 0.28, 0.115, 0.045, "z"),
      to(1.8, 0.62, -0.6, -0.28, 0.115, 0.045, "z"),
      to(1.8, 0.88, -0.6, 0.28, 0.115, 0.045, "z"),
      to(1.8, 0.88, -0.6, -0.28, 0.115, 0.045, "z"),
    ],
  },
  {
    name: "ROBOTIC_ASSEMBLY", lane: "MACHINE", detail: "6-dof arm · pick & place",
    parts: [
      tu(6, 0, -0.95, 0, 0, -0.76, 0, 0.34),
      ds(3, 0, -0.76, 0, 0.34, "y"),
      tu(4, 0, -0.76, 0, 0, -0.58, 0, 0.22),
      sp(4, 0, -0.53, 0, 0.17),
      tu(10, 0, -0.53, 0, 0.38, 0.12, 0, 0.1),
      sp(4, 0.38, 0.12, 0, 0.14),
      tu(9, 0.38, 0.12, 0, 0.04, 0.6, 0.12, 0.08),
      sp(3, 0.04, 0.6, 0.12, 0.11),
      tu(3, 0.04, 0.6, 0.12, -0.06, 0.78, 0.18, 0.06),
      tu(2, -0.06, 0.78, 0.18, -0.18, 0.95, 0.24, 0.026),
      tu(2, -0.06, 0.78, 0.18, 0.04, 0.97, 0.27, 0.026),
    ],
  },
  {
    name: "MECHANICAL_REPAIR", lane: "HUMAN", detail: "diagnose & service · on-site",
    parts: [
      tu(14, -0.5, -0.62, 0, 0.44, 0.52, 0, 0.085),
      to(7, 0.56, 0.66, 0, 0.17, 0.06, "z"),
      tu(2, 0.56, 0.66, -0.05, 0.56, 0.66, 0.05, 0.095),
      to(6, -0.63, -0.78, 0, 0.16, 0.055, "z", 4.96, 9.34),
    ],
  },
  {
    name: "LAB_ANALYSIS", lane: "MACHINE", detail: "optical inspection · QC",
    parts: [
      bx(8, 0, -0.78, 0.05, 0.72, 0.14, 0.5),
      tu(5, 0.22, -0.72, 0, 0.3, -0.05, 0, 0.075),
      tu(5, 0.3, -0.05, 0, 0.14, 0.42, 0, 0.07),
      tu(3, 0.14, 0.42, 0, -0.06, 0.58, 0, 0.065),
      bx(6, -0.05, -0.28, 0.05, 0.52, 0.05, 0.4),
      bx(0.7, -0.16, -0.245, 0.05, 0.1, 0.02, 0.3),
      bx(0.7, 0.06, -0.245, 0.05, 0.1, 0.02, 0.3),
      tu(2.5, -0.05, 0.16, 0.05, -0.05, 0.28, 0.05, 0.11),
      tu(1.5, -0.05, 0.02, 0.05, -0.05, 0.16, 0.05, 0.035),
      tu(1, -0.17, 0.06, 0.02, -0.12, 0.16, 0.04, 0.03),
      tu(1, 0.07, 0.06, 0.08, 0.02, 0.16, 0.06, 0.03),
      tu(3, -0.06, 0.58, 0, -0.24, 0.78, 0, 0.055),
      tu(1.5, -0.24, 0.78, 0, -0.33, 0.89, 0, 0.045),
      tu(2, -0.05, -0.62, 0.05, -0.05, -0.5, 0.05, 0.07),
      tu(1, 0.3, -0.38, -0.08, 0.3, -0.38, 0.1, 0.06),
    ],
  },
];

const LANE_GLYPH: Record<Lane, string> = { MACHINE: "▣", HUMAN: "◐", ASSET: "◈" };

const LIME: [number, number, number] = [0.776, 0.949, 0.306]; // #c6f24e
const LANE_TINT: Record<Lane, [number, number, number]> = {
  MACHINE: [0.424, 0.839, 1.0], // #6cd6ff
  HUMAN: [1.0, 0.698, 0.302], // #ffb24d
  ASSET: [0.784, 0.635, 1.0], // #c8a2ff
};

/* ----------------------------------------------------------- builders ---- */

let ringCache: Float32Array | null = null;

function buildRing(): Float32Array {
  if (ringCache) return ringCache;
  const out = new Float32Array(RING_N * 3);
  const rnd = mulberry32(777);
  let i = 0;
  const put = (x: number, y: number, z: number) => {
    out[i * 3] = x; out[i * 3 + 1] = y; out[i * 3 + 2] = z; i++;
  };
  for (let k = 0; k < 380; k++) {
    const th = rnd() * Math.PI * 2;
    const r = 0.98 + (rnd() - 0.5) * 0.025;
    put(Math.cos(th) * r, RING_Y + (rnd() - 0.5) * 0.012, Math.sin(th) * r);
  }
  for (let k = 0; k < 200; k++) {
    const th = rnd() * Math.PI * 2;
    const r = 0.76 + (rnd() - 0.5) * 0.02;
    put(Math.cos(th) * r, RING_Y + (rnd() - 0.5) * 0.01, Math.sin(th) * r);
  }
  for (let k = 0; k < 240; k++) {
    const tick = Math.floor(rnd() * 24);
    const th = (tick / 24) * Math.PI * 2 + (rnd() - 0.5) * 0.006;
    const r = 0.86 + rnd() * 0.12;
    put(Math.cos(th) * r, RING_Y, Math.sin(th) * r);
  }
  for (let k = 0; k < 40; k++) {
    const th = rnd() * Math.PI * 2;
    const r = 0.06 * Math.sqrt(rnd());
    put(Math.cos(th) * r, RING_Y, Math.sin(th) * r);
  }
  ringCache = out;
  return out;
}

function buildShape(def: SkillDef, seed: number): Float32Array {
  const out = new Float32Array(N * 3);
  const rnd = mulberry32(seed);
  const W = def.parts.reduce((s, p) => s + p.w, 0);

  // distribute MODEL_N among parts via cumulative rounding (sums exactly)
  let acc = 0, given = 0;
  for (const part of def.parts) {
    acc += part.w;
    const target = Math.round((acc / W) * MODEL_N);
    const n = target - given;
    if (n > 0) part.emit(out, given, n, rnd);
    given = target;
  }

  // bbox-normalize the model so every skill fills the stage consistently
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < MODEL_N; i++) {
    const x = out[i * 3], y = out[i * 3 + 1], z = out[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const s = Math.min(1.7 / (maxY - minY || 1), 2.0 / (maxX - minX || 1), 2.0 / (maxZ - minZ || 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  for (let i = 0; i < MODEL_N; i++) {
    out[i * 3] = (out[i * 3] - cx) * s;
    out[i * 3 + 1] = (out[i * 3 + 1] - cy) * s + 0.08;
    out[i * 3 + 2] = (out[i * 3 + 2] - cz) * s;
  }

  // shuffle model triples so morph trajectories criss-cross
  for (let i = MODEL_N - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    for (let k = 0; k < 3; k++) {
      const t = out[i * 3 + k];
      out[i * 3 + k] = out[j * 3 + k];
      out[j * 3 + k] = t;
    }
  }

  out.set(buildRing(), MODEL_N * 3);
  return out;
}

/* ------------------------------------------------------------ shaders ---- */

const VERT = `
attribute vec3 aPosA;
attribute vec3 aPosB;
attribute float aRand;
uniform mat4 uProj;
uniform float uMorph;
uniform float uTime;
uniform float uRotY;
uniform float uPtScale;
uniform float uWarpAmp;
varying float vRand;
varying float vY;
varying float vBoost;
const float PI = 3.14159265;
void main() {
  float isRing = step(aRand, 0.0);
  float rnd = abs(aRand);
  float t = clamp((uMorph - rnd * 0.35) / 0.65, 0.0, 1.0);
  t = t * t * (3.0 - 2.0 * t);
  vec3 p = mix(aPosA, aPosB, t);
  float w = sin(clamp(uMorph, 0.0, 1.0) * PI) * uWarpAmp;
  float swirl = w * (1.1 + rnd * 2.4) * (1.0 - 0.85 * isRing);
  float cs = cos(swirl); float sn = sin(swirl);
  p.xz = mat2(cs, -sn, sn, cs) * p.xz;
  p += normalize(p + vec3(0.0001, 0.0, 0.0)) * (w * rnd * 0.5 * (1.0 - isRing));
  p.y += (sin(uTime * 0.9 + rnd * 6.2831) * 0.014 + sin(uTime * 0.6) * 0.02) * (1.0 - isRing);
  float cr = cos(uRotY); float sr = sin(uRotY);
  p.xz = mat2(cr, -sr, sr, cr) * p.xz;
  vY = p.y;
  vec3 mv = vec3(p.x, p.y - ${CAM_Y.toFixed(2)}, p.z - ${CAM_Z.toFixed(2)});
  gl_Position = uProj * vec4(mv, 1.0);
  float ws = (0.012 + rnd * 0.013) * (1.0 - 0.2 * isRing);
  gl_PointSize = max(ws * uPtScale / max(0.3, -mv.z), 1.0);
  vRand = rnd;
  vBoost = (1.0 + w * 0.8) * (1.0 + 0.55 * isRing);
}
`;

const FRAG = `
precision mediump float;
varying float vRand;
varying float vY;
varying float vBoost;
uniform vec3 uColA;
uniform vec3 uColB;
uniform highp float uTime;
uniform float uFade;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float core = smoothstep(0.25, 0.02, r2);
  float h = clamp(vY * 0.6 + 0.62, 0.0, 1.0);
  vec3 col = mix(uColA, uColB, h * 0.45 + vRand * 0.12);
  float scan = 0.8 + 0.2 * sin(vY * 30.0 - uTime * 4.5);
  float flick = 0.93 + 0.07 * sin(uTime * 40.0 + vRand * 95.0);
  float a = core * scan * flick * vBoost * uFade * 0.85;
  gl_FragColor = vec4(col * a, a);
}
`;

/* ---------------------------------------------------------- component ---- */

export function HoloSkills() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);
  const idxRef = useRef<HTMLSpanElement | null>(null);
  const nameRef = useRef<HTMLSpanElement | null>(null);
  const laneRef = useRef<HTMLSpanElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    wrap.style.display = ""; // recover if a previous mount hid us (HMR)

    const gl = canvas.getContext("webgl", {
      alpha: true, antialias: false, depth: false,
      premultipliedAlpha: true, powerPreference: "low-power",
    });
    if (!gl) {
      wrap.style.display = "none";
      return;
    }

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("HoloSkills shader:", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) { wrap.style.display = "none"; return; }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("HoloSkills link:", gl.getProgramInfoLog(prog));
      wrap.style.display = "none";
      return;
    }
    gl.useProgram(prog);

    const loc = {
      aPosA: gl.getAttribLocation(prog, "aPosA"),
      aPosB: gl.getAttribLocation(prog, "aPosB"),
      aRand: gl.getAttribLocation(prog, "aRand"),
      uProj: gl.getUniformLocation(prog, "uProj"),
      uMorph: gl.getUniformLocation(prog, "uMorph"),
      uTime: gl.getUniformLocation(prog, "uTime"),
      uRotY: gl.getUniformLocation(prog, "uRotY"),
      uPtScale: gl.getUniformLocation(prog, "uPtScale"),
      uWarpAmp: gl.getUniformLocation(prog, "uWarpAmp"),
      uColA: gl.getUniformLocation(prog, "uColA"),
      uColB: gl.getUniformLocation(prog, "uColB"),
      uFade: gl.getUniformLocation(prog, "uFade"),
    };

    const K = SKILLS.length;
    const shapes = SKILLS.map((skill, i) => buildShape(skill, 1000 + i * 97));

    const randArr = new Float32Array(N);
    {
      const rr = mulberry32(424242);
      for (let i = 0; i < N; i++) {
        const v = 0.002 + rr() * 0.997;
        randArr[i] = i < MODEL_N ? v : -v;
      }
    }

    const bufA = gl.createBuffer();
    const bufB = gl.createBuffer();
    const bufR = gl.createBuffer();
    const bindAttr = (buf: WebGLBuffer | null, attr: number, size: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(attr);
      gl.vertexAttribPointer(attr, size, gl.FLOAT, false, 0, 0);
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, bufR);
    gl.bufferData(gl.ARRAY_BUFFER, randArr, gl.STATIC_DRAW);
    const upload = (buf: WebGLBuffer | null, data: Float32Array) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    };
    upload(bufA, shapes[0]);
    upload(bufB, shapes[1 % K]);
    bindAttr(bufA, loc.aPosA, 3);
    bindAttr(bufB, loc.aPosB, 3);
    bindAttr(bufR, loc.aRand, 1);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const HOLD = reduced ? 5.4 : 3.4;
    const MORPH = reduced ? 1.0 : 1.5;
    const WARP_AMP = reduced ? 0.12 : 1.0;
    gl.uniform1f(loc.uWarpAmp, WARP_AMP);
    gl.uniform3f(loc.uColA, LIME[0], LIME[1], LIME[2]);

    const setProjection = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      const wpx = Math.max(1, Math.round(wrap.clientWidth * dpr));
      const hpx = Math.max(1, Math.round(wrap.clientHeight * dpr));
      if (canvas.width !== wpx || canvas.height !== hpx) {
        canvas.width = wpx;
        canvas.height = hpx;
      }
      gl.viewport(0, 0, wpx, hpx);
      const aspect = wpx / hpx;
      const f = 1 / Math.tan((FOV * Math.PI) / 360);
      const near = 0.1, far = 20;
      // column-major
      const m = new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);
      gl.uniformMatrix4fv(loc.uProj, false, m);
      gl.uniform1f(loc.uPtScale, hpx / (2 * Math.tan((FOV * Math.PI) / 360)));
    };
    setProjection();
    const ro = new ResizeObserver(setProjection);
    ro.observe(wrap);

    /* readout DOM */
    const setLabel = (i: number) => {
      const def = SKILLS[i];
      if (idxRef.current) idxRef.current.textContent = `${String(i + 1).padStart(2, "0")} / ${K}`;
      if (nameRef.current) nameRef.current.textContent = def.name;
      if (laneRef.current) {
        laneRef.current.textContent = `${LANE_GLYPH[def.lane]} ${def.lane}`;
        laneRef.current.setAttribute("data-lane", def.lane);
      }
      if (detailRef.current) detailRef.current.textContent = def.detail;
      const ro2 = readoutRef.current;
      if (ro2) {
        ro2.classList.remove("glitch");
        void ro2.offsetWidth; // restart the glitch animation
        ro2.classList.add("glitch");
      }
    };
    setLabel(0);

    /* animation state */
    let idx = 0;
    let phase: 0 | 1 = 0; // 0 = hold, 1 = morph
    let tPhase = 0;
    let labelSwapped = false;
    let rotY = 0.5;
    let time = 0;
    let fade = 0;
    let lastT: number | null = null;
    let running = true;
    let raf = 0;
    let disposed = false;

    const io = new IntersectionObserver((entries) => {
      running = entries[0]?.isIntersecting ?? true;
      if (running) lastT = null;
    });
    io.observe(wrap);

    const tintOf = (i: number) => LANE_TINT[SKILLS[i].lane];

    const frame = (now: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(frame);
      if (!running) { lastT = null; return; }
      if (lastT === null) lastT = now;
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      time += dt;
      tPhase += dt;
      fade = Math.min(1, fade + dt * 0.8);

      let m = 0;
      if (phase === 0 && tPhase >= HOLD) { phase = 1; tPhase = 0; }
      if (phase === 1) {
        m = Math.min(1, tPhase / MORPH);
        if (!labelSwapped && m >= 0.45) {
          labelSwapped = true;
          setLabel((idx + 1) % K);
        }
        if (m >= 1) {
          idx = (idx + 1) % K;
          upload(bufA, shapes[idx]);
          upload(bufB, shapes[(idx + 1) % K]);
          bindAttr(bufA, loc.aPosA, 3);
          bindAttr(bufB, loc.aPosB, 3);
          phase = 0;
          tPhase = 0;
          labelSwapped = false;
          m = 0;
        }
      }

      const warp = Math.sin(Math.min(m, 1) * Math.PI);
      rotY += dt * ((reduced ? 0.07 : 0.32) + warp * 1.3);

      const tA = tintOf(idx);
      const tB = tintOf((idx + 1) % K);
      const e = m * m * (3 - 2 * m);
      gl.uniform3f(
        loc.uColB,
        tA[0] + (tB[0] - tA[0]) * e,
        tA[1] + (tB[1] - tA[1]) * e,
        tA[2] + (tB[2] - tA[2]) * e,
      );
      gl.uniform1f(loc.uMorph, m);
      gl.uniform1f(loc.uTime, time);
      gl.uniform1f(loc.uRotY, rotY);
      gl.uniform1f(loc.uFade, fade * fade);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.POINTS, 0, N);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      // Do NOT loseContext() here: getContext() returns the same (dead)
      // context on StrictMode/HMR remount. Free resources instead.
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      gl.deleteBuffer(bufA);
      gl.deleteBuffer(bufB);
      gl.deleteBuffer(bufR);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <div className="hsk-wrap" ref={wrapRef} aria-hidden="true">
        <div className="hsk-glowbg" />
        <canvas className="hsk-canvas" ref={canvasRef} />
        <div className="hsk-sweep" />
        <span className="hsk-bk tl" /><span className="hsk-bk tr" />
        <span className="hsk-bk bl" /><span className="hsk-bk br" />
        <div className="hsk-status">HOLO.SIM // SKILL_REGISTRY</div>
        <div className="hsk-status hsk-status-r">LIVE_FEED</div>
        <div className="hsk-readout" ref={readoutRef}>
          <div className="hsk-r1">
            <span className="hsk-idx" ref={idxRef}>01 / 10</span>
            <span className="hsk-name" ref={nameRef}>CNC_MILLING</span>
            <span className="hsk-lane" data-lane="MACHINE" ref={laneRef}>▣ MACHINE</span>
          </div>
          <div className="hsk-detail" ref={detailRef}>3-axis gantry · subtractive</div>
        </div>
      </div>
    </>
  );
}

const CSS = `
.hsk-wrap{
  position:absolute;z-index:0;
  top:clamp(40px,6vh,84px);right:clamp(4px,2vw,44px);
  width:min(42vw,700px);height:min(80vh,840px);
  pointer-events:none;
  font-family:'JetBrains Mono',ui-monospace,monospace;
}
@media(max-width:1199px){.hsk-wrap{display:none}}
.hsk-canvas{
  position:absolute;inset:0;width:100%;height:100%;display:block;
  mix-blend-mode:screen;
  mask-image:radial-gradient(ellipse 80% 78% at 50% 47%,#000 60%,transparent 99%);
  -webkit-mask-image:radial-gradient(ellipse 80% 78% at 50% 47%,#000 60%,transparent 99%);
}
.hsk-glowbg{
  position:absolute;inset:6%;
  background:
    radial-gradient(ellipse 52% 44% at 50% 55%,rgba(198,242,78,.07),transparent 70%),
    radial-gradient(ellipse 36% 26% at 50% 82%,rgba(108,214,255,.05),transparent 70%);
}
.hsk-sweep{
  position:absolute;left:9%;right:9%;height:90px;top:-14%;
  background:linear-gradient(180deg,transparent,rgba(198,242,78,.055),transparent);
  animation:hskSweep 7.5s linear infinite;
}
@keyframes hskSweep{0%{top:-14%}100%{top:104%}}
.hsk-bk{position:absolute;width:20px;height:20px;border:0 solid rgba(198,242,78,.36)}
.hsk-bk.tl{top:2.5%;left:4.5%;border-top-width:1px;border-left-width:1px}
.hsk-bk.tr{top:2.5%;right:4.5%;border-top-width:1px;border-right-width:1px}
.hsk-bk.bl{bottom:2%;left:4.5%;border-bottom-width:1px;border-left-width:1px}
.hsk-bk.br{bottom:2%;right:4.5%;border-bottom-width:1px;border-right-width:1px}
.hsk-status{
  position:absolute;top:3.4%;left:7%;
  font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;
  color:rgba(139,148,166,.62);
}
.hsk-status-r{
  left:auto;right:7%;color:rgba(198,242,78,.72);
  display:flex;align-items:center;gap:6px;
}
.hsk-status-r::before{
  content:"";width:5px;height:5px;border-radius:50%;
  background:#c6f24e;box-shadow:0 0 8px #c6f24e;
  animation:hskPulse 1.6s infinite;
}
@keyframes hskPulse{0%,100%{opacity:1}50%{opacity:.25}}
.hsk-readout{
  position:absolute;left:50%;bottom:5%;transform:translateX(-50%);
  text-align:center;white-space:nowrap;
}
.hsk-r1{display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px}
.hsk-idx{color:#5b6475;letter-spacing:.1em}
.hsk-name{
  color:#c6f24e;font-weight:700;font-size:14.5px;letter-spacing:.16em;
  text-shadow:0 0 16px rgba(198,242,78,.45);
}
.hsk-lane{font-size:9.5px;padding:3px 9px;border:1px solid;border-radius:999px;letter-spacing:.14em}
.hsk-lane[data-lane="MACHINE"]{color:#6cd6ff;border-color:rgba(108,214,255,.35)}
.hsk-lane[data-lane="HUMAN"]{color:#ffb24d;border-color:rgba(255,178,77,.35)}
.hsk-lane[data-lane="ASSET"]{color:#c8a2ff;border-color:rgba(200,162,255,.35)}
.hsk-detail{
  margin-top:6px;font-size:10px;color:#5b6475;
  letter-spacing:.22em;text-transform:uppercase;
}
.hsk-readout.glitch .hsk-name{animation:hskGl .5s steps(2,end)}
.hsk-readout.glitch .hsk-detail{animation:hskGl .5s steps(2,end) .06s}
@keyframes hskGl{
  0%{opacity:0;transform:translateX(7px) skewX(-10deg);filter:blur(2px)}
  30%{opacity:1;transform:translateX(-3px) skewX(4deg)}
  45%{opacity:.35}
  60%{opacity:1;transform:translateX(2px)}
  75%{opacity:.6;filter:blur(1px)}
  100%{opacity:1;transform:none;filter:none}
}
@media (prefers-reduced-motion: reduce){
  .hsk-sweep{display:none}
  .hsk-status-r::before{animation:none}
  .hsk-readout.glitch .hsk-name,.hsk-readout.glitch .hsk-detail{animation:none}
}
`;
