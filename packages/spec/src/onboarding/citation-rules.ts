/**
 * Onboarding — the two rules a cited source has to meet, shared by the research
 * library's `ResearchCitationSchema` and the intake record's
 * `IntakeSourceSchema` (a research finding's citation ends up as an answer's
 * source, so the two must not disagree).
 *
 * Both only REFUSE; neither changes the value it validates.
 */

import { z } from "zod";

/** Text with at least one non-whitespace character (after `trim`). Blank text
 *  is refused; the value is never trimmed or otherwise transformed. */
export const nonBlankText = z.string().refine((text) => text.trim().length > 0, { message: "must not be blank" });

function isHttpsWithoutCredentials(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** A URL (as `new URL` parses it) whose scheme is `https:` and that embeds no
 *  user name or password. Anything else — http, ftp, javascript:, data:, file:,
 *  text that is not a URL — is refused. */
export const httpsUrl = z.string().refine(isHttpsWithoutCredentials, {
  message: "must be an https URL without credentials",
});
