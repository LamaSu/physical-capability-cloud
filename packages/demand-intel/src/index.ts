/**
 * @pcc/demand-intel — internal demand intelligence
 *
 * Sketches + aggregator over PCC's captured intent events. This package is
 * NOT a public oracle: snapshots are unsigned, never published, never
 * cross-chain. PCC consumes its own intelligence to allocate capacity and
 * surface composite-intent niches worth specialized fulfillment.
 */

export { HyperLogLog } from "./sketches/hyperloglog.js";
export type { HLLSerialized } from "./sketches/hyperloglog.js";

export { TDigest } from "./sketches/tdigest.js";
export type { TDigestSerialized } from "./sketches/tdigest.js";

export { CountMinSketch } from "./sketches/count-min-sketch.js";
export type { CMSSerialized, TopKEntry } from "./sketches/count-min-sketch.js";

export { DemandAggregator } from "./aggregator.js";
export type { AggregatorState, IngestSummary } from "./aggregator.js";
