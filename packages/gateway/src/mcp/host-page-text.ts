import { isProseClaim } from "@pcc/spec";
import { WITHHELD_PROSE } from "./dashboard-ir.js";

// PCC copy is code-owned, never part of an artifact or gallery entry. The
// gallery paints its own mirrored constants, parity-checked through its boot.
export const HOST_WITHHELD_PROSE: typeof WITHHELD_PROSE = WITHHELD_PROSE;
export const HOST_WITHHELD_TITLE = "PCC Dashboard — agent text withheld";

// Unicode Bidi_Control, including marks, embeddings, overrides and isolates.
// Logical-order claim checks cannot account for their displayed text order.
const BIDI_CONTROL = /\p{Bidi_Control}/u;

/** Check each field and the original pair, so fragments cannot form a claim
 * across host title/description sinks. Withhold the pair conservatively. */
export function classifyHostText(title: string, description?: string) {
  const bidiControl = BIDI_CONTROL.test(title) || BIDI_CONTROL.test(description ?? "");
  const titleClaim = isProseClaim(title);
  const descriptionClaim = description !== undefined && isProseClaim(description);
  const joinedClaim = isProseClaim([title, description ?? ""].join(" "));
  const withheld = bidiControl || titleClaim || descriptionClaim || joinedClaim;
  return {
    title: withheld ? undefined : title,
    description: withheld ? undefined : description,
    titleWithheld: withheld,
    descriptionWithheld: description !== undefined && withheld,
  };
}

export function hostDocumentTitle(fields: ReturnType<typeof classifyHostText>): string {
  return fields.titleWithheld ? HOST_WITHHELD_TITLE : `${fields.title} (agent-authored) - PCC`;
}
