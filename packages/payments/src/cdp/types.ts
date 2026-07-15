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
  /** CDP_API_KEY_ID (key id). When absent, the client runs in mock mode. */
  apiKeyId?: string;
  /** CDP_API_KEY_SECRET (the Ed25519 secret shown once at key creation). */
  apiKeySecret?: string;
  /** CDP_WALLET_SECRET (server-wallet signing material, held by CDP's TEE). */
  walletSecret?: string;
  /** Target chain. Default: base-sepolia. */
  network?: CdpNetwork;
  /** Coinbase Onramp App ID (CDP_ONRAMP_APP_ID) for building the hosted onramp URL. */
  onrampAppId?: string;
  /** Force mock regardless of keys. Default: !apiKeyId. */
  mock?: boolean;
}

/**
 * Custody classification — makes "who controls the signing key" explicit and
 * un-mislabelable (audit H-12 / user-controlled-wallet foundation, Option A):
 *   - "user-owned":       the END USER controls signing (CDP embedded / user-auth wallet,
 *                         or an external passkey-owned smart account). PCC holds NO owner
 *                         key and CANNOT sign arbitrary transactions. The ONLY production
 *                         participant (operator/requester) wallet. Created via the
 *                         embedded/user-auth flow, NOT the server-managed createWallet().
 *   - "server-test-only": a server-managed (API-key + Wallet-Secret) wallet — PCC can sign
 *                         arbitrarily, so it is NOT user-controlled. Permitted ONLY on Base
 *                         Sepolia with faucet funds; must never be a mainnet participant
 *                         wallet and must never be surfaced to a user as "your wallet".
 *   - "treasury":         a deliberately PCC-controlled wallet (protocol treasury, gas
 *                         sponsorship, faucet automation, protocol-owned contracts). Server-
 *                         managed by design; never the default operator/requester wallet.
 */
export type WalletCustodyMode = "user-owned" | "server-test-only" | "treasury";

export interface CdpWallet {
  address: `0x${string}`;
  network: CdpNetwork;
  /** Smart account (ERC-4337) — gasless USDC on Base via the CDP paymaster. */
  smartAccount: boolean;
  /** Who controls the signing key. The server-managed createWallet() only mints
   *  "server-test-only" (Base Sepolia) or "treasury"; "user-owned" requires the
   *  embedded/user-auth flow (P1). */
  custodyMode: WalletCustodyMode;
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
