/**
 * Session liveness gate — shared by every state-advancing / commit path on the
 * negotiationSessions state machine.
 *
 * TWO live commit paths write the SAME `sess-` table:
 *   - the negotiation route  (POST /api/negotiate/session/:id/{quote,review,commit})
 *   - the A2A adapter         (POST /a2a/tasks/send, skills pcc-quote / pcc-submit)
 *
 * Both MUST apply identical liveness rules, or one becomes a side-door that mints
 * escrow for a dead deal (N1). Keeping the rule in one place is what stops the two
 * paths from drifting — do not fork this logic into either route.
 *
 * A session may only advance while it is inside its TTL and not in a terminal
 * state. Mirrors the self-healing expiry write in GET /session/:id: when the TTL
 * has passed we persist status="expired" so the session stops being resurrectable.
 *
 * Returns a {status, body} violation to send back (HTTP routes send it directly;
 * the A2A adapter converts it to a thrown error), or null when the session is live
 * and may advance.
 */
import { schema, eq } from "@pcc/store";
import type { getStore } from "../db.js";

const { negotiationSessions } = schema;

export function assertSessionLive(
  db: ReturnType<typeof getStore>["db"],
  row: typeof negotiationSessions.$inferSelect,
): { status: number; body: { error: string } } | null {
  if (row.status === "committed") {
    return { status: 409, body: { error: "Session already committed" } };
  }
  if (row.status === "cancelled" || row.status === "expired") {
    return { status: 410, body: { error: `Session ${row.status}` } };
  }
  if (new Date(row.expiresAt) < new Date()) {
    // Self-heal: persist expiry so the session can't be advanced later.
    db.update(negotiationSessions)
      .set({ status: "expired" })
      .where(eq(negotiationSessions.id, row.id))
      .run();
    return { status: 410, body: { error: "Session expired" } };
  }
  return null;
}
