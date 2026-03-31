/**
 * Typography — 4 voices (no Editorial per war room critique)
 *
 * SIZE FLOOR: 36px. Nothing below 36px anywhere.
 * Max 8 words per line. Max 5 elements per frame.
 * Hold every text element minimum 3 seconds (90 frames).
 */
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";

const { fontFamily: sg } = loadSpaceGrotesk("normal", { weights: ["400","700"], subsets: ["latin"] });
const { fontFamily: inter } = loadInter("normal", { weights: ["400","600"], subsets: ["latin"] });
const { fontFamily: sm } = loadSpaceMono("normal", { weights: ["400","700"], subsets: ["latin"] });
const { fontFamily: dm } = loadDMSans("normal", { weights: ["300","400"], subsets: ["latin"] });

export const F = {
  monument:  sg,    // titles, hero — uppercase, bold, tight
  swiss:     inter, // labels, captions — systematic
  brutalist: sm,    // data, terminal, code — raw mono
  express:   dm,    // body descriptions — light, readable
} as const;

/** Size scale — 5 levels only, no overlaps */
export const SIZE = {
  hero:    140,  // scene 1 + 8 logo only
  title:    96,  // scene headlines
  subtitle: 64,  // section labels
  body:     44,  // descriptions (max 8 words/line)
  data:     80,  // metric counters
  label:    36,  // smallest allowed — captions, tags
} as const;
