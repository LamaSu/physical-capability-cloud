import { eq, inArray } from "drizzle-orm";
import { csdUsage } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type { ICsdUsageRepository, CsdUsage } from "../interfaces/ICsdUsageRepository.js";

/**
 * Maximum number of recent adopters to retain per CSD. Matches the cap that
 * the in-memory implementation in @pcc/spec uses, so observable behavior is
 * identical regardless of backend.
 */
const RECENT_ADOPTERS_CAP = 50;

/**
 * Zero shape returned for CSDs that have never been recorded.
 * Cloned per call so callers can mutate without affecting cached state.
 */
function zeroUsage(): CsdUsage {
  return { count: 0, recentAdopters: [], lastUsedAt: null };
}

/**
 * SQLite-backed CsdUsageRepository — drop-in replacement for the in-memory
 * CsdUsageRepository in @pcc/spec.
 *
 * The gateway wires this into loadBuiltinCsds() when PCC_CSD_PERSIST=true,
 * so per-CSD adoption counters survive process restart. Behavior matches the
 * in-memory implementation exactly:
 *   - get(url) → zero shape for never-recorded CSDs
 *   - record(url, agentId) → increments count, stamps lastUsedAt,
 *     deduplicates the adopter list with newest-at-end, caps at 50
 *   - getMany(urls) → one bulk SELECT, avoids N round-trips
 */
export class CsdUsageRepository implements ICsdUsageRepository {
  constructor(private db: StoreDB) {}

  get(url: string): CsdUsage {
    const row = this.db.select().from(csdUsage).where(eq(csdUsage.url, url)).get();
    if (!row) return zeroUsage();
    return {
      count: row.count,
      recentAdopters: row.recentAdopters ?? [],
      lastUsedAt: row.lastUsedAt ?? null,
    };
  }

  record(url: string, byAgentId: string): void {
    const now = new Date().toISOString();
    // Read current row (or zero) so we can apply the dedup + cap rule
    // identically to the in-memory implementation. better-sqlite3 is
    // synchronous, so read-modify-write inside one statement-scope is fine
    // for our gateway-level concurrency profile (no parallel writes from
    // separate processes to the same row).
    const row = this.db.select().from(csdUsage).where(eq(csdUsage.url, url)).get();
    if (!row) {
      this.db
        .insert(csdUsage)
        .values({
          url,
          count: 1,
          recentAdopters: [byAgentId],
          lastUsedAt: now,
        })
        .run();
      return;
    }
    const adopters = [...(row.recentAdopters ?? [])];
    const idx = adopters.indexOf(byAgentId);
    if (idx >= 0) adopters.splice(idx, 1);
    adopters.push(byAgentId);
    if (adopters.length > RECENT_ADOPTERS_CAP) adopters.shift();
    this.db
      .update(csdUsage)
      .set({
        count: row.count + 1,
        recentAdopters: adopters,
        lastUsedAt: now,
      })
      .where(eq(csdUsage.url, url))
      .run();
  }

  getMany(urls: readonly string[]): Map<string, CsdUsage> {
    const out = new Map<string, CsdUsage>();
    if (urls.length === 0) return out;
    const rows = this.db
      .select()
      .from(csdUsage)
      .where(inArray(csdUsage.url, urls as string[]))
      .all();
    for (const row of rows) {
      out.set(row.url, {
        count: row.count,
        recentAdopters: row.recentAdopters ?? [],
        lastUsedAt: row.lastUsedAt ?? null,
      });
    }
    // Fill in zero entries for never-recorded URLs so callers can rely on a
    // complete map (suggest()/popular() expect every requested URL present).
    for (const u of urls) {
      if (!out.has(u)) out.set(u, zeroUsage());
    }
    return out;
  }
}
