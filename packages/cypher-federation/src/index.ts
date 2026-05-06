/**
 * @pcc/cypher-federation — public surface.
 */

export type {
  CypherCredentials,
  CypherFederationService,
  CypherInstance,
  CypherOrder,
  CypherOrderPriority,
  CypherOrderUpdate,
  CypherPricing,
  CypherPricingModel,
  CypherProvider,
  CypherServiceStats,
  CypherSourceInstance,
  CypherTurnaround,
  FederationManifest,
  FederationStatus,
  PccA2aIntent,
  PccCapabilitySummary,
  PccSettlementEvent,
} from "./types.js";

export {
  FederationApiError,
  FederationAuthError,
  FederationPeer,
} from "./peer.js";
export type { FederationPeerOptions } from "./peer.js";

export {
  buildPccFederationManifest,
  fetchPccCapabilities,
} from "./manifest.js";
export type { BuildManifestOptions } from "./manifest.js";

export {
  cypherServiceToPccCapability,
  pccCapabilityToCypherService,
} from "./mapper.js";
export type { InstanceContext } from "./mapper.js";

export { OrderTranslator } from "./translator.js";
export type { OrderTranslatorOptions, TranslateContext } from "./translator.js";

export {
  createPeerEndpoint,
  mountStandalone,
} from "./endpoint.js";
export type {
  CreatePeerEndpointOptions,
  GatewayClient,
  PeerEndpoint,
} from "./endpoint.js";
