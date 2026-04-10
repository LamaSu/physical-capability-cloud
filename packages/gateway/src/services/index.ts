/**
 * Services barrel — re-exports all gateway service modules.
 *
 * Only the two new auction/pricing services are barrel-exported here.
 * Existing services maintain their individual import paths to avoid
 * circular dependency risk during the incremental migration.
 */

export {
  CombinatorialAuction,
  combinatorialAuction,
  type AuctionBid,
  type AuctionResult,
} from "./combinatorial-auction.js";

export {
  SurgePricingService,
  surgePricingService,
  DEFAULT_SURGE_CONFIG,
  type SurgeConfig,
} from "./surge-pricing.js";
