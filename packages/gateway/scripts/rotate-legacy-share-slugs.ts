/**
 * Rotate legacy weak share slugs → ≥96-bit + expiring aliases  (R4 PR4 / D13)
 * =============================================================================
 * ONE-TIME, IDEMPOTENT data migration. Scans the ui_artifacts store and rotates
 * every ACTIVE public|unlisted artifact whose slug was minted by the OLD scheme
 * (human prefix + 6 hex chars ≈ 24 bits) to a fresh ≥96-bit slug, writing an
 * EXPIRING HASHED alias (sha256(old-slug) → artifactId, ~30d TTL) so existing
 * shared links keep resolving for a bounded window before they lapse.
 *
 * Safe to re-run: a rotated artifact then carries a strong slug and is skipped,
 * and the alias insert is conflict-safe. Private/retired artifacts are never
 * enumerable share targets and are left untouched.
 *
 * Run it (against the gateway's live SQLite DB — set the SAME path the gateway
 * uses; DATABASE_URL / RAILWAY_VOLUME_MOUNT_PATH / PCC_DB_PATH all honoured):
 *
 *   # from the repo root
 *   PCC_DB_PATH=./data/pcc.sqlite pnpm --filter @pcc/gateway exec \
 *     tsx scripts/rotate-legacy-share-slugs.ts
 *
 *   # or on Railway, against the mounted volume
 *   DATABASE_URL=/data/pcc.db tsx packages/gateway/scripts/rotate-legacy-share-slugs.ts
 *
 * A custom TTL (ms) can be passed as the first CLI arg (default ~30 days).
 */

import { initStore, closeStore } from "../src/db.js";
import { rotateLegacyShareSlugs } from "../src/routes/artifacts.js";

function main(): void {
  const ttlArg = process.argv[2];
  const ttlMs = ttlArg ? Number(ttlArg) : undefined;
  if (ttlArg && (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0)) {
    console.error(`[rotate-slugs] invalid TTL arg "${ttlArg}" — expected a positive number of ms`);
    process.exit(1);
  }

  // seed:false — this is a maintenance pass over an existing DB, never a fresh
  // seed. initStore honours DATABASE_URL / RAILWAY_VOLUME_MOUNT_PATH / PCC_DB_PATH.
  initStore({ seed: false });
  try {
    const summary = rotateLegacyShareSlugs(ttlMs !== undefined ? { ttlMs } : {});
    console.log("[rotate-slugs] done:", JSON.stringify(summary, null, 2));
    console.log(
      `[rotate-slugs] scanned=${summary.scanned} rotated=${summary.rotated} ` +
        `aliasesWritten=${summary.aliasesWritten} skippedStrong=${summary.skippedStrong}`,
    );
  } finally {
    closeStore();
  }
}

main();
