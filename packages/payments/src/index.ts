// x402 (DEPRECATED -- kept for fallback; use MPP for new integrations)
export { X402Middleware, type X402Config, type RoutePaymentMap } from "./x402-middleware.js";
export { X402Client, type X402ClientConfig } from "./x402-client.js";
// MPP (Machine-Payable Protocol via mppx)
export { MppMiddleware, type MppMiddlewareConfig, type MppChargeResult } from "./mpp-middleware.js";
export { MppClient, type MppClientConfig } from "./mpp-client.js";
export { MppSessionManager, type MppSessionManagerConfig } from "./mpp-session.js";
export {
  DLMMClient,
  type DLMMClientConfig,
  CapabilityPoolManager,
  type CapabilityPoolManagerConfig,
  type PriceBin,
  type DLMMPoolConfig,
  type LiquidityPosition,
  type SwapQuote,
  type PoolStats,
  type SwapEvent,
  type CreatePoolParams,
  type AddLiquidityParams,
  type RemoveLiquidityParams,
} from "./meteora/index.js";
export {
  AlkahestEscrowBridge,
  type AlkahestObligation,
  type AlkahestBridgeConfig,
  type PCCEvidenceDemand,
  type PCCEvidenceResult,
} from "./alkahest/index.js";
export {
  NativeEscrowService,
  AttestationService,
  type EscrowObligation,
  type EscrowDispute,
  type DemandSpec,
  type FulfillmentProof,
  type EscrowConfig,
  type ObligationStatus,
  type Attestation,
} from "./native-escrow/index.js";
export {
  BountyService,
  type DemandSignal,
  type CapabilityBounty,
  type BountyHunter,
  type BountyRequirements,
} from "./bounty/index.js";
export {
  PoolService,
  type InvestmentPool,
  type PoolStake,
  type PoolDistribution,
  type PoolConfig,
  type PoolStatus,
  type StakerEarnings,
} from "./pool/index.js";
// PGTR (ERC-8194 Payment-Gated Transaction Relay)
export { PGTRClient, type PGTRClientConfig } from "./pgtr-client.js";
// Sovereign Wealth Fund
export {
  SWFService,
  SWF_SCORE_WEIGHTS,
  DEFAULT_ALLOCATION,
  DEFAULT_SWF_CONFIG,
  type SWFConfig,
  type ParticipantEpochInput,
} from "./swf/index.js";
