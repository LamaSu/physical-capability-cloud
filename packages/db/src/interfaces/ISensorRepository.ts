import type { sensorChannelDescriptors, sensorAggregates, sensorAnomalies } from "../schema/index.js";

export type ChannelRow = typeof sensorChannelDescriptors.$inferSelect;
export type ChannelInsert = typeof sensorChannelDescriptors.$inferInsert;
export type AggregateRow = typeof sensorAggregates.$inferSelect;
export type AggregateInsert = typeof sensorAggregates.$inferInsert;
export type AnomalyRow = typeof sensorAnomalies.$inferSelect;
export type AnomalyInsert = typeof sensorAnomalies.$inferInsert;

export interface ISensorRepository {
  // Channels
  findAllChannels(): ChannelRow[];
  findChannelsByKernel(kernelId: string): ChannelRow[];
  insertChannel(channel: ChannelInsert): ChannelRow | undefined;
  findChannelByName(channel: string, kernelId: string): ChannelRow | undefined;
  // Aggregates
  insertAggregate(agg: AggregateInsert): AggregateRow | undefined;
  findAggregatesByChannel(
    channel: string,
    opts?: { kernelId?: string; jobId?: string; since?: string },
  ): AggregateRow[];
  // Anomalies
  insertAnomaly(anomaly: AnomalyInsert): AnomalyRow | undefined;
  findAnomalies(opts?: { kernelId?: string; severity?: string; limit?: number }): AnomalyRow[];
}
