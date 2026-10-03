/**
 * Onboarding — the rules a cited source has to meet, shared by the research
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

/** The one contentHash format: `sha256:` + 64 lowercase hex. The zod schema, the
 *  secret scan's exemption and the generated JSON Schema all read this pattern. */
export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A digest of the cited text, `sha256:` + 64 lowercase hex, so the citation can be checked later.
 *  Shared, so a research finding's citation copies into an answer's source unchanged. */
export const contentHashSchema = z
  .string()
  .regex(CONTENT_HASH_PATTERN, "contentHash is sha256: followed by 64 lowercase hex digits");
