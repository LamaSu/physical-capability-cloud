import { eq, and, desc } from "drizzle-orm";
import {
  sensorChannelDescriptors,
  sensorAggregates,
  sensorAnomalies,
} from "../schema/index.js";
import type { StoreDB } from "../connection.js";

export class SensorRepository {
  constructor(private db: StoreDB) {}

  // ── Channels ──────────────────────────────────────────────────

  findAllChannels() {
    return this.db.select().from(sensorChannelDescriptors).all();
  }

  findChannelsByKernel(kernelId: string) {
    return this.db
      .select()
      .from(sensorChannelDescriptors)
      .where(eq(sensorChannelDescriptors.kernelId, kernelId))
      .all();
  }

  insertChannel(channel: typeof sensorChannelDescriptors.$inferInsert) {
    return this.db.insert(sensorChannelDescriptors).values(channel).returning().get();
  }

  findChannelByName(channel: string, kernelId: string) {
    return this.db
      .select()
      .from(sensorChannelDescriptors)
      .where(
        and(
          eq(sensorChannelDescriptors.channel, channel),
          eq(sensorChannelDescriptors.kernelId, kernelId),
        ),
      )
      .get();
  }

  // ── Aggregates ────────────────────────────────────────────────

  insertAggregate(agg: typeof sensorAggregates.$inferInsert) {
    return this.db.insert(sensorAggregates).values(agg).returning().get();
  }

  findAggregatesByChannel(
    channel: string,
    opts?: { kernelId?: string; jobId?: string; since?: string },
  ) {
    const conditions = [eq(sensorAggregates.channel, channel)];
    if (opts?.kernelId) conditions.push(eq(sensorAggregates.kernelId, opts.kernelId));
    if (opts?.jobId) conditions.push(eq(sensorAggregates.jobId, opts.jobId));

    const rows = this.db
      .select()
      .from(sensorAggregates)
      .where(conditions.length === 1 ? conditions[0] : and(...conditions))
      .all();

    if (opts?.since) {
      return rows.filter((r) => r.windowStart >= opts.since!);
    }
    return rows;
  }

  // ── Anomalies ─────────────────────────────────────────────────

  insertAnomaly(anomaly: typeof sensorAnomalies.$inferInsert) {
    return this.db.insert(sensorAnomalies).values(anomaly).returning().get();
  }

  findAnomalies(opts?: { kernelId?: string; severity?: string; limit?: number }) {
    const conditions: ReturnType<typeof eq>[] = [];
    if (opts?.kernelId) conditions.push(eq(sensorAnomalies.kernelId, opts.kernelId));
    if (opts?.severity) conditions.push(eq(sensorAnomalies.severity, opts.severity));

    let query = this.db
      .select()
      .from(sensorAnomalies)
      .orderBy(desc(sensorAnomalies.timestamp));

    if (conditions.length === 1) {
      query = query.where(conditions[0]) as typeof query;
    } else if (conditions.length > 1) {
      query = query.where(and(...conditions)) as typeof query;
    }

    if (opts?.limit) {
      return query.limit(opts.limit).all();
    }
    return query.all();
  }
}
