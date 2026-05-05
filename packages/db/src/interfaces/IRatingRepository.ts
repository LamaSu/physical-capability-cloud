import type { operatorRatings } from "../schema/index.js";

export type RatingRow = typeof operatorRatings.$inferSelect;
export type RatingInsert = typeof operatorRatings.$inferInsert;

export interface RatingAggregate {
  avg: number;
  count: number;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
}

export interface IRatingRepository {
  insert(r: RatingInsert): RatingRow | undefined;
  findByOperator(operatorId: string, opts?: { limit?: number; offset?: number }): RatingRow[];
  findByJob(jobId: string): RatingRow | undefined;
  /**
   * Find a specific buyer's rating for a job. Lets the route layer detect
   * (and 409) on a duplicate-rating attempt by the same buyer.
   */
  findByJobAndBuyer(jobId: string, buyerId: string): RatingRow | undefined;
  aggregateForOperator(operatorId: string): RatingAggregate;
}
