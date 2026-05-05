import { eq, desc, and } from "drizzle-orm";
import { operatorRatings } from "../schema/index.js";
import type { StoreDB } from "../connection.js";
import type {
  IRatingRepository,
  RatingInsert,
  RatingRow,
  RatingAggregate,
} from "../interfaces/IRatingRepository.js";

export class RatingRepository implements IRatingRepository {
  constructor(private db: StoreDB) {}

  insert(r: RatingInsert): RatingRow | undefined {
    return this.db.insert(operatorRatings).values(r).returning().get();
  }

  findByOperator(
    operatorId: string,
    opts?: { limit?: number; offset?: number },
  ): RatingRow[] {
    const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100);
    const offset = Math.max(opts?.offset ?? 0, 0);
    return this.db
      .select()
      .from(operatorRatings)
      .where(eq(operatorRatings.operatorId, operatorId))
      .orderBy(desc(operatorRatings.createdAt))
      .limit(limit)
      .offset(offset)
      .all();
  }

  /**
   * One rating per (job, buyer) — the route layer enforces ownership and
   * idempotency at the API level. This findByJob lets the route check for
   * an existing rating to update vs insert.
   */
  findByJob(jobId: string): RatingRow | undefined {
    return this.db
      .select()
      .from(operatorRatings)
      .where(eq(operatorRatings.jobId, jobId))
      .get();
  }

  /**
   * Find a specific buyer's rating for a job (for idempotent upsert from
   * the route layer). Two buyers cannot rate the same job because only the
   * job's actual buyer passes the ownership check upstream.
   */
  findByJobAndBuyer(jobId: string, buyerId: string): RatingRow | undefined {
    return this.db
      .select()
      .from(operatorRatings)
      .where(and(eq(operatorRatings.jobId, jobId), eq(operatorRatings.buyerId, buyerId)))
      .get();
  }

  aggregateForOperator(operatorId: string): RatingAggregate {
    const rows = this.db
      .select()
      .from(operatorRatings)
      .where(eq(operatorRatings.operatorId, operatorId))
      .all();
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as const;
    const dist: Record<1 | 2 | 3 | 4 | 5, number> = { ...distribution };
    let sum = 0;
    for (const r of rows) {
      const score = r.rating as 1 | 2 | 3 | 4 | 5;
      if (score >= 1 && score <= 5) {
        dist[score] += 1;
        sum += score;
      }
    }
    const count = rows.length;
    const avg = count === 0 ? 0 : Math.round((sum / count) * 100) / 100;
    return { avg, count, distribution: dist };
  }
}
