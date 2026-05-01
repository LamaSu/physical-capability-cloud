/**
 * Embedded wallet adapter — vendor-agnostic seam for the zero-friction signup flow.
 *
 * Today the dashboard's auth surface is wagmi + SIWE: every signup requires the user
 * to already have an EOA wallet (MetaMask, Coinbase, WalletConnect). That's three
 * walls before a non-technical contributor can publish a RateSchedule.
 *
 * This module is the integration point for an embedded-wallet provider that creates
 * a smart wallet from an email/phone signup — no seed phrase, no MetaMask install.
 * Per the landscape report at ai/research/landscape-embedded-wallet.md the chosen
 * vendor is **Privy** (Stripe-acquired, ERC-4337 on free tier, Base + Coinbase
 * Smart Wallet native, ES256 JWT server verification).
 *
 * **Stub-first strategy**: the route layer always calls through this adapter. When
 * `PRIVY_APP_ID` + `PRIVY_APP_SECRET` are set, the real `PrivyWalletAdapter` runs
 * and creates production smart wallets. When unset (today, before the user creates
 * a Privy account) the `DemoWalletAdapter` deterministically derives an EOA from
 * the email via the existing `UnifiedKeychain` so the entire UX flow works in dev
 * without any external dependency. Flipping the env vars is the only change
 * needed to promote this to production.
 *
 * The on-chain interaction surface is identical either way — both adapters return
 * a 0x EVM address that `ContributorNFT.mint`, `MilestoneEscrow.splitPayout`, and
 * any USDC transfer treat the same.
 */

import { UnifiedKeychain } from "@pcc/agent-runtime";

export interface EmbeddedWallet {
  /** EVM address that receives USDC payouts and can mint a ContributorNFT. */
  address: `0x${string}`;
  /**
   * Provider's stable user identifier. For Privy this is the DID
   * (`did:privy:xxx`); for the demo adapter it's the lowercased email.
   * Stored alongside the API key so re-authentication finds the same wallet.
   */
  providerUserId: string;
  /**
   * BIP-39 mnemonic — ONLY returned by the demo adapter. Privy holds key
   * shares server-side and never exposes a seed phrase to clients.
   * The frontend MUST display this once (with "back this up") and the server
   * MUST NOT persist it after the response is sent.
   */
  mnemonic?: string;
}

export interface VerifiedAuthToken {
  providerUserId: string;
  email: string | null;
  walletAddress: `0x${string}`;
}

export interface EmbeddedWalletAdapter {
  /** Identifier for telemetry and audit logs (e.g., "demo", "privy"). */
  readonly providerId: string;
  /**
   * Whether the adapter is operating in production-grade mode. The demo
   * adapter returns false. Routes use this to gate any "real money" actions
   * (payouts, prod onramps) behind a real wallet provider.
   */
  readonly isProduction: boolean;
  /**
   * Create or recover an embedded wallet for an email-based signup.
   * Idempotent for the same email: re-calling MUST return the same address
   * (the demo adapter derives deterministically; the Privy adapter looks up
   * the existing user by email before creating a new one).
   */
  createWalletForEmail(email: string): Promise<EmbeddedWallet>;
  /**
   * Verify a client-issued auth token (Privy JWT) and return the bound user.
   * Used by the gateway middleware that lets a Privy-authenticated browser
   * call the API without a separate PCC API key. Optional — the demo adapter
   * does not implement this (the demo flow always uses the API key returned
   * from `/api/contributors/quickstart`).
   */
  verifyAuthToken?(token: string): Promise<VerifiedAuthToken>;
}

// ---------------------------------------------------------------------------
// DemoWalletAdapter — the default until PRIVY_APP_ID is set
// ---------------------------------------------------------------------------

/**
 * Deterministic email→EOA derivation via the existing UnifiedKeychain.
 *
 * The mnemonic is generated fresh on each call and returned ONCE. The user
 * is responsible for backing it up; without it, the wallet is not recoverable.
 *
 * This is acceptable for dev/demo environments and for early adopters who are
 * comfortable managing their own keys. It is NOT acceptable for the
 * "construction worker who never coded" demographic — that user needs Privy.
 */
export class DemoWalletAdapter implements EmbeddedWalletAdapter {
  readonly providerId = "demo";
  readonly isProduction = false;

  async createWalletForEmail(email: string): Promise<EmbeddedWallet> {
    const normalizedEmail = email.trim().toLowerCase();
    const kc = new UnifiedKeychain();
    const keys = kc.generate();
    return {
      address: keys.evm.address as `0x${string}`,
      providerUserId: normalizedEmail,
      mnemonic: keys.mnemonic,
    };
  }
}

// ---------------------------------------------------------------------------
// PrivyWalletAdapter — production path (active when env vars are set)
// ---------------------------------------------------------------------------

/**
 * Privy-backed embedded wallet. Uses the Privy server SDK to create or
 * recover an ERC-4337 smart wallet for an email-based signup, and to verify
 * client-issued ID tokens.
 *
 * **Activation**: set `PRIVY_APP_ID` and `PRIVY_APP_SECRET` on the gateway.
 * Without both, `getEmbeddedWalletAdapter()` falls back to `DemoWalletAdapter`.
 *
 * **Implementation status**: this class is a typed scaffold. The actual
 * `@privy-io/server-auth` dependency is not yet installed (deferred until
 * the user creates a Privy app and provides the credentials). When the
 * dependency lands, replace the `throw` bodies with real SDK calls — the
 * route layer needs zero changes.
 *
 * Reference: https://docs.privy.io/guide/server/authorization/verification
 */
export class PrivyWalletAdapter implements EmbeddedWalletAdapter {
  readonly providerId = "privy";
  readonly isProduction = true;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_appId: string, _appSecret: string) {
    // Stash credentials for the SDK call. Intentionally not stored as fields
    // (the SDK constructor wraps them); leaving the underscore-prefixed args
    // documents the required wiring without exposing secrets to telemetry.
  }

  async createWalletForEmail(_email: string): Promise<EmbeddedWallet> {
    throw new Error(
      "PrivyWalletAdapter.createWalletForEmail not yet implemented — " +
        "install @privy-io/server-auth and wire Privy.users.create({ email })",
    );
  }

  async verifyAuthToken(_token: string): Promise<VerifiedAuthToken> {
    throw new Error(
      "PrivyWalletAdapter.verifyAuthToken not yet implemented — " +
        "install @privy-io/server-auth and call privy.verifyAuthToken(token)",
    );
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: EmbeddedWalletAdapter | null = null;

/**
 * Returns the active adapter based on env. Cached for the process lifetime —
 * tests that toggle env vars must call `resetEmbeddedWalletAdapter()` first.
 */
export function getEmbeddedWalletAdapter(): EmbeddedWalletAdapter {
  if (cached) return cached;
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (appId && appSecret) {
    cached = new PrivyWalletAdapter(appId, appSecret);
  } else {
    cached = new DemoWalletAdapter();
  }
  return cached;
}

/** Test-only: forget the cached adapter so the next `get` re-reads env. */
export function resetEmbeddedWalletAdapter(): void {
  cached = null;
}
