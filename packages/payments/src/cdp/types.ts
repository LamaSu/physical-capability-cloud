/**
 * Coinbase CDP funded-key on-ramp — shared types.
 *
 * CDP is several SDKs/surfaces, so this module splits into three clients:
 *   - CdpWalletClient            (server-wallet SDK: @coinbase/cdp-sdk)
 *   - CdpOnrampClient            (headless Onramp REST/session)
 *   - CdpSpendPermissionService  (Smart Wallet Spend Permissions)
 *
 * Custody invariant: the agent/operator NEVER receives a raw private key — only a
 * scoped, revocable, time-boxed Spend Permission.
 */

export type CdpNetwork = "base-sepolia" | "base";

export interface CdpConfig {
  /** CDP_API_KEY (key id). When absent, the client runs in mock mode. */
  apiKeyId?: string;
  /** CDP_API_SECRET. */
  apiSecret?: string;
  /** CDP_WALLET_SECRET (server-wallet signing material, held by CDP). */
  walletSecret?: string;
  /** Target chain. Default: base-sepolia. */
  network?: CdpNetwork;
  /** Force mock regardless of keys. Default: !apiKeyId. */
  mock?: boolean;
}

export interface CdpWallet {
  address: `0x${string}`;
  network: CdpNetwork;
  /** Smart account (ERC-4337) — gasless USDC on Base via the CDP paymaster. */
  smartAccount: boolean;
  createdAt: string;
}

export interface OnrampSession {
  sessionId: string;
  /** Hosted/embedded widget URL the human opens once to pay by card. */
  onrampUrl: string;
  destinationAddress: `0x${string}`;
  asset: "USDC";
  network: CdpNetwork;
  status: "created" | "pending" | "completed" | "failed";
  createdAt: string;
}

export interface SpendPermission {
  permissionId: string;
  /** The funded wallet that authorizes spend. */
  account: `0x${string}`;
  /** The scoped signer (agent/operator) allowed to spend within limits. */
  spender: `0x${string}`;
  token: "USDC";
  /** Allowance in the token's smallest unit (USDC = 6 decimals). */
  allowance: string;
  /** Human-readable USDC allowance. */
  allowanceUSDC: number;
  /** Rolling spend window in seconds. */
  periodSec: number;
  start: string;
  expiresAt: string;
  revoked: boolean;
}
