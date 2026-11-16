/** The frozen serving window supplies the scope's post-activation TTL. */
import { getStore } from "../db.js";
import { schema, eq, and } from "@pcc/store";
import { scopeExpiryMs } from "./scope-expiry.js";

export function servedPrepareTtlMs(scopeId: string): number | null {
  try {
    const row = getStore().db.select().from(schema.fundingPrepares)
      .where(and(eq(schema.fundingPrepares.scopeId, scopeId), eq(schema.fundingPrepares.state, "served"))).get();
    if (!row) return null;
    const ttl = row.reconcileUntil * 1000 - scopeExpiryMs(row.scopeExpiresAt);
    return Number.isSafeInteger(ttl) && ttl > 0 ? ttl : null;
  } catch { return null; }
}
