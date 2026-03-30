/**
 * Deep Space Protocol Design System
 *
 * Mood: premium product launch — confident, inevitable, architectural
 * Not a hackathon project. The future that already exists.
 *
 * Primary accent:  warm amber/gold #f5a623  — trust, value, premium
 * Secondary accent: cool blue-white #94b8ff  — tech, precision, clarity
 * Highlight:       soft emerald #34d399     — success, growth, settlement
 * Warning/contrast: coral #f87171           — replaces garish hot pink
 * Background:      deep navy black #080b16  — not pure black, has depth
 */
export const COLORS = {
  bg: {
    deep: "#080b16",        // deep navy black
    primary: "#080b16",
    surface: "#0d1220",     // slightly lighter surface
    subtle: "#101828",      // subtle elevation
    border: "#1e2a42",      // blue-tinted border
  },
  fg: "#e8ecf4",            // blue-white text — easier on eyes than green
  accent1: "#f5a623",       // warm amber/gold — primary accent (was neon green)
  accent2: "#94b8ff",       // cool blue-white — secondary accent (was electric cyan)
  muted: "#4a5568",         // keep — good as muted
  discord: "#f87171",       // coral — replaces hot pink (#ff0066). Less garish, still signals danger.

  // Named semantic accents
  emerald: "#34d399",       // success, growth, settlement
  gold: "#f5a623",          // = accent1 (aliases for clarity)

  text: {
    primary: "#e8ecf4",     // = fg
    muted: "#4a5568",       // = muted
    bright: "#ffffff",
  },
} as const;

/**
 * Immersive force-derived values
 * Structure elevated: this feels architectural, not chaotic
 */
export const FORCES = {
  structure: 0.55,
  disruption: 0.35,
  density: 0.2,
  breath: 0.8,
  warmth: 0.75,
  edge: 0.3,
  stillness: 0.25,
  motion: 0.75,
  whisper: 0.5,
  shout: 0.3,
} as const;

export const GRADIENTS = {
  // Primary gradient — amber → blue-white
  accent: "linear-gradient(135deg, #f5a623, #94b8ff)",
  // Success gradient — emerald → amber
  discordGradient: "linear-gradient(135deg, #f87171, #f5a623)",
  // Holographic — full premium spectrum
  holographic:
    "linear-gradient(135deg, #f5a623 0%, #94b8ff 35%, #34d399 65%, #f5a623 100%)",
  // Surface glass — blue-tinted
  glass: "rgba(148, 184, 255, 0.04)",
  glassBorder: "rgba(148, 184, 255, 0.10)",
  glassBorderHover: "rgba(245, 166, 35, 0.25)",
  // Subtle bg gradient
  subtleGradient: "linear-gradient(180deg, #080b16 0%, #0d1220 100%)",
} as const;
