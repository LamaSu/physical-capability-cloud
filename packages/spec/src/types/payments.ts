/**
 * Payment types — x402 for digital microservices, milestone escrow for physical work.
 *
 * x402 (Coinbase + Cloudflare) revives HTTP 402 "Payment Required" for instant
 * stablecoin payments over HTTP. Used for digital services: quote, route, simulate.
 *
 * Physical work payments use milestone escrow (see settlement.ts).
 */

import type { Amount, Currency, Address } from "./common.js";

// ============================================================
// x402 Protocol Types (v2)
// ============================================================

/** Information about a protected resource */
export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** Payment requirements for accessing a resource */
export interface X402PaymentRequirements {
  /** Payment scheme, e.g., "exact" */
  scheme: string;
  /** Chain in CAIP-2 format, e.g., "eip155:8453" (Base mainnet) */
  network: string;
  /** Amount in atomic token units (e.g., "100000" = $0.10 USDC) */
  amount: string;
  /** Token contract address */
  asset: string;
  /** Recipient wallet */
  payTo: string;
  /** Max time for payment completion */
  maxTimeoutSeconds: number;
  /** Scheme-specific data */
  extra?: Record<string, unknown>;
}

/** Server → Client: 402 response payload */
export interface X402PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** EIP-3009 TransferWithAuthorization parameters */
export interface X402EVMAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  /** 32-byte random nonce (hex) */
  nonce: string;
}

/** Client → Server: payment payload */
export interface X402PaymentPayload {
  x402Version: 2;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirements;
  payload: {
    signature: string;
    authorization: X402EVMAuthorization;
  };
  extensions?: Record<string, unknown>;
}

/** Server → Client: settlement result */
export interface X402SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: Address;
  /** Blockchain transaction hash */
  transaction: string;
  /** CAIP-2 network */
  network: string;
  extensions?: Record<string, unknown>;
}

/** Facilitator verify response */
export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: Address;
}

// ============================================================
// x402 Route Configuration (for our services)
// ============================================================

/** Configuration for an x402-protected endpoint */
export interface X402RouteConfig {
  /** Price in human-readable format, e.g., "$0.10" */
  price: string;
  /** Payment scheme */
  scheme: "exact";
  /** Network in CAIP-2 */
  network: string;
  /** Recipient address (our treasury or operator) */
  payTo: Address;
  /** Human-readable description */
  description: string;
}

/** x402-protected routes for our digital microservices */
export interface X402ServiceRoutes {
  /** Quote a CWM: how much will this workflow cost? */
  "POST /api/quote": X402RouteConfig;
  /** Simulate a workflow execution (dry run) */
  "POST /api/simulate": X402RouteConfig;
  /** Route optimization: find best shop assignments */
  "POST /api/route": X402RouteConfig;
  /** Capability search across all kernels */
  "GET /api/capabilities/search": X402RouteConfig;
}

// ============================================================
// ERC-8004 Integration Surface Types
// ============================================================

/** ERC-8004 metadata entry for agent registration */
export interface ERC8004MetadataEntry {
  metadataKey: string;
  metadataValue: string; // hex-encoded bytes
}

/** ERC-8004 Identity Registry: agent registration */
export interface ERC8004AgentRegistration {
  agentId: bigint;
  agentURI: string;
  owner: Address;
  metadata: ERC8004MetadataEntry[];
}

/** ERC-8004 Reputation Registry: feedback */
export interface ERC8004Feedback {
  agentId: bigint;
  value: bigint;       // int128 feedback value
  valueDecimals: number;
  tag1: string;        // Category tag, e.g., "manufacturing"
  tag2: string;        // Sub-tag, e.g., "cnc-3axis"
  endpoint: string;    // Which capability endpoint this feedback is for
  feedbackURI: string; // Off-chain details
  feedbackHash: string; // bytes32 hash of feedback content
}

/** ERC-8004 Validation Registry: validation request/response */
export interface ERC8004ValidationRequest {
  validatorAddress: Address;
  agentId: bigint;
  requestURI: string;
  requestHash: string; // bytes32
}

export interface ERC8004ValidationResponse {
  requestHash: string;
  response: number;      // uint8 (0-255 scale)
  responseURI: string;
  responseHash: string;
  tag: string;
}

// ============================================================
// Courier Payment Types
// ============================================================

/** Payment for courier services */
export interface CourierPayment {
  /** Courier service used */
  service: "uber_direct" | "roadie" | "goshare" | "lalamove" | "manual";
  /** External delivery ID from courier API */
  externalDeliveryId: string;
  /** Amount paid for delivery */
  amount: Amount;
  currency: Currency;
  /** Whether this is escrowed or direct */
  paymentMethod: "escrowed" | "direct";
}

// ============================================================
// MPP (Machine-Payable Protocol) Types — mppx integration
// ============================================================

/** MPP server configuration for Mppx.create() */
export interface MppConfig {
  /** HMAC secret key for challenge IDs (env: MPP_SECRET_KEY) */
  secretKey: string;
  /** Server realm, e.g. hostname (env: MPP_REALM) */
  realm?: string;
  /** Tempo recipient address (env: TEMPO_RECIPIENT) */
  recipient: Address;
  /** ERC-20 token contract address for payment currency */
  currency: Address;
  /** Whether to use testnet mode */
  testnet?: boolean;
}

/** MPP route configuration — mirrors X402RouteConfig for feature-flag switching */
export interface MppRouteConfig {
  /** Price in atomic token units (e.g. "10000" for $0.01 USDC) */
  amount: string;
  /** Human-readable description */
  description: string;
  /** Optional external ID for correlation */
  externalId?: string;
}

/** Route pattern -> MPP payment config */
export type MppRouteMap = Record<string, MppRouteConfig>;

/** MPP session configuration */
export interface MppSessionConfig {
  /** Initial deposit in human-readable units (e.g. "10" for 10 USDC) */
  deposit: string;
  /** Maximum deposit cap in human-readable units */
  maxDeposit?: string;
  /** Token decimals (default: 6 for USDC) */
  decimals?: number;
  /** Escrow contract address */
  escrowContract?: Address;
  /** Session timeout in milliseconds */
  timeoutMs?: number;
}

/** MPP payment method — which mppx method was used */
export type MppPaymentMethod = "tempo/charge" | "tempo/session";

/** MPP payment stats for monitoring */
export interface MppPaymentStats {
  totalRequests: number;
  paidRequests: number;
  challengedRequests: number;
  totalRevenue: string;
  activeSessions: number;
  recentPayments: Array<{
    path: string;
    method: MppPaymentMethod;
    amount: string;
    timestamp: string;
  }>;
}

// ============================================================
// PGTR (ERC-8194) Payment-Gated Transaction Relay Types
// ============================================================

/** Request to relay a payment-gated transaction through the PCCForwarder */
export interface PGTRRelayRequest {
  /** The address authorizing the USDC payment (EIP-3009 `from`) */
  payer: Address;
  /** USDC amount in atomic units (6 decimals) */
  amount: string;
  /** EIP-3009 nonce (32 bytes hex) */
  nonce: string;
  /** Unix timestamp after which this relay request expires */
  expiry: number;
  /** Target contract address to call */
  target: Address;
  /** 4-byte function selector (hex) */
  selector: string;
  /** ABI-encoded call data for the target function */
  callData: string;
  /** EIP-3009 signature v component */
  v: number;
  /** EIP-3009 signature r component (32 bytes hex) */
  r: string;
  /** EIP-3009 signature s component (32 bytes hex) */
  s: string;
}

/** Result of a successful PGTR relay */
export interface PGTRRelayResult {
  /** Transaction hash of the on-chain relay call */
  txHash: string;
  /** The payer whose payment was processed */
  payer: Address;
  /** The target contract that was called */
  target: Address;
  /** USDC amount transferred (atomic units) */
  amount: string;
}

/** Configuration for the PGTR relay system */
export interface PGTRConfig {
  /** Address of the deployed PCCForwarder contract */
  forwarderAddress: Address;
  /** Private key of the authorized relayer (hex, optional -- server-side only) */
  relayerKey?: string;
  /** Whether PGTR relay is enabled */
  enabled: boolean;
}
