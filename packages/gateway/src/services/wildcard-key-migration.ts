import { sql, type Store } from "@pcc/store";
import { parseStoredScopes, SELF_SERVICE_KEY_SCOPES } from "../auth/key-scopes.js";

export const SELF_SERVICE_METADATA_PREDICATE = "json_valid(metadata) AND json_type(metadata) = 'object' AND json_extract(metadata, '$.source') = 'landing-page'";

export interface WildcardKeyMigrationCounts {
  narrowed: number;
  revoked: number;
  alreadyRevoked: number;
  kept: number;
}

/** Narrowing, explicit revocations and verification commit together or all roll back. */
export function runWildcardKeyMigration(
  store: Store,
  targetScopes: readonly string[],
  revokeIds: readonly string[],
  clock: () => string,
  keepIds: readonly string[] = [],
): WildcardKeyMigrationCounts {
  return store.db.transaction((tx) => {
    // CASE guards JSON evaluation; the predicate is evaluated only for valid metadata.
    const selfServiceRows = sql`SELECT id, scopes FROM api_keys
      WHERE revoked_at IS NULL AND CASE WHEN json_valid(metadata)
        THEN ${sql.raw(SELF_SERVICE_METADATA_PREDICATE)} ELSE 0 END`;
    const wildcardRows = tx.all<{ id: string; scopes: unknown }>(selfServiceRows)
      .filter((row) => parseStoredScopes(row.scopes).includes("*"));
    const ids = [...new Set(revokeIds)];
    const kept = new Set(keepIds);
    const conflicting = ids.filter((id) => kept.has(id)).length;
    const verifiedKept = wildcardRows.filter((row) => kept.has(row.id)).length;
    if (conflicting !== 0 || verifiedKept !== kept.size) {
      throw Object.assign(new Error("wildcard key migration verification failed"), {
        counts: { listed: ids.length, kept: kept.size, conflicting, verifiedKept },
      });
    }
    const candidates = wildcardRows.filter((row) => !kept.has(row.id));
    const scopes = JSON.stringify([...targetScopes]);
    const now = clock();
    let narrowed = 0;
    let revoked = 0;
    let alreadyRevoked = 0;

    for (const row of candidates) {
      narrowed += tx.run(sql`UPDATE api_keys SET scopes = ${scopes}
        WHERE id = ${row.id} AND revoked_at IS NULL`).changes;
    }
    for (const id of ids) {
      const row = tx.get<{ revoked_at: string | null }>(sql`SELECT revoked_at FROM api_keys WHERE id = ${id}`);
      if (row && row.revoked_at !== null) {
        alreadyRevoked++;
      } else {
        revoked += tx.run(sql`UPDATE api_keys SET revoked_at = ${now}
          WHERE id = ${id} AND revoked_at IS NULL`).changes;
      }
    }

    const remaining = tx.all<{ id: string; scopes: unknown }>(selfServiceRows)
      .filter((row) => parseStoredScopes(row.scopes).includes("*"));
    const verifiedNarrowed = candidates.filter((row) =>
      tx.get<{ scopes: string }>(sql`SELECT scopes FROM api_keys WHERE id = ${row.id}`)?.scopes === scopes,
    ).length;
    const verifiedRevoked = ids.filter((id) => {
      const row = tx.get<{ revoked_at: string | null }>(sql`SELECT revoked_at FROM api_keys WHERE id = ${id}`);
      return row !== undefined && row.revoked_at !== null;
    }).length;
    if (remaining.length !== kept.size || remaining.some((row) => !kept.has(row.id)) || narrowed !== candidates.length || verifiedNarrowed !== candidates.length || verifiedRevoked !== ids.length) {
      throw Object.assign(new Error("wildcard key migration verification failed"), {
        counts: { candidates: candidates.length, narrowed, remaining: remaining.length, verifiedNarrowed, listed: ids.length, verifiedRevoked, revoked, alreadyRevoked, kept: kept.size, verifiedKept },
      });
    }
    return { narrowed, revoked, alreadyRevoked, kept: kept.size };
  });
}

/** Only the exact apply gate permits writes or honours the explicit id lists. */
export function applyWildcardKeyMigrationFromEnv(store: Store): WildcardKeyMigrationCounts | undefined {
  if (process.env.PCC_WILDCARD_KEY_MIGRATION !== "apply") return;
  const ids = [...new Set((process.env.PCC_REVOKE_API_KEY_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  const keepIds = [...new Set((process.env.PCC_WILDCARD_KEY_KEEP_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  const counts = runWildcardKeyMigration(store, SELF_SERVICE_KEY_SCOPES, ids, () => new Date().toISOString(), keepIds);
  console.log(`[wildcard-key-migration] narrowed ${counts.narrowed}, revoked ${counts.revoked}, already revoked ${counts.alreadyRevoked}, kept ${counts.kept}`);
  return counts;
}
