/**
 * Controlled Chaos — Five Typographic Voices
 *
 * Monument (Space Grotesk): Architectural display, impact
 * Editorial (Playfair Display): Elegant, literary, refined
 * Swiss (Inter): Systematic, clean, informational
 * Brutalist (Space Mono): Raw, mechanical, unapologetic
 * Expressive (DM Sans): Versatile, personality-driven
 */
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadDMSans } from "@remotion/google-fonts/DMSans";

const { fontFamily: spaceGrotesk } = loadSpaceGrotesk("normal", {
  weights: ["300", "400", "700"],
  subsets: ["latin"],
});
const { fontFamily: inter } = loadInter("normal", {
  weights: ["400", "600", "700"],
  subsets: ["latin"],
});
const { fontFamily: spaceMono } = loadSpaceMono("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
const { fontFamily: playfairDisplay } = loadPlayfairDisplay("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
});
const { fontFamily: dmSans } = loadDMSans("normal", {
  weights: ["100", "300", "400", "700"],
  subsets: ["latin"],
});

export const FONTS = {
  // CC Voice names
  monument: spaceGrotesk,       // display, architectural
  editorial: playfairDisplay,   // elegant, literary
  swiss: inter,                 // systematic, clean
  brutalist: spaceMono,         // raw, mechanical
  expressive: dmSans,           // versatile, personality

  // Backward-compat aliases
  display: spaceGrotesk,
  body: inter,
  mono: spaceMono,
} as const;
