import { randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, CdpWallet } from "./types.js";
import {
  UserOwnedWalletRegistry,
  type UserOwnedWalletRecord,
  validateAddressShape,
  assertServerManaged,
  assertServerSignable as assertWalletServerSignable,
  assertNoOwnerRotation as assertWalletNoOwnerRotation,
} from "./custody.js";

export interface RegisterUserOwnedWalletParams {
  /** The externally-created (client-side) user-owned wallet address. Stored as-is; no key. */
  address: string;
  /** Optional non-secret reference to the user's auth identity (embedded-wallet user id, etc.). */
  authProviderRef?: string;
}

/**
 * CdpWalletClient — creates/reads CDP smart wallets (self-custodial, server-managed).
 * Smart accounts on Base get gasless USDC via the CDP paymaster.
 *
 * Mock/real switch is presence-of-creds: `mock = cfg.mock ?? !cfg.apiKeyId`. With no
 * apiKeyId it returns deterministic fakes (gateway/tests/settlement work offline); with
 * creds it calls the real @coinbase/cdp-sdk. The SDK is imported lazily so mock-only
 * consumers don't need it loaded.
 */
export class CdpWalletClient {
  private readonly network: CdpNetwork;
  private readonly mock: boolean;
  private readonly cfg: CdpConfig;
  private readonly userOwned: UserOwnedWalletRegistry;
  private cdpClient: import("@coinbase/cdp-sdk").CdpClient | undefined;

  constructor(
    cfg: CdpConfig = {},
    deps: { userOwnedRegistry?: UserOwnedWalletRegistry } = {},
  ) {
    this.cfg = cfg;
    this.network = cfg.network ?? "base-sepolia";
    this.mock = cfg.mock ?? !cfg.apiKeyId;
    // Own a registry by default; accept a shared one so CdpSpendPermissionService (and other
    // signing paths) see the same user-owned set and can never substitute a server signer.
    this.userOwned = deps.userOwnedRegistry ?? new UserOwnedWalletRegistry();
  }

  get isMock(): boolean {
    return this.mock;
  }

  /** The user-owned registry. Pass it to CdpSpendPermissionService (or any signing path) so a
   *  server-managed signer can never be substituted for a user-owned participant wallet. */
  get userOwnedRegistry(): UserOwnedWalletRegistry {
    return this.userOwned;
  }

  private async cdp(): Promise<import("@coinbase/cdp-sdk").CdpClient> {
    if (!this.cdpClient) {
      const { CdpClient } = await import("@coinbase/cdp-sdk");
      this.cdpClient = new CdpClient({
        apiKeyId: this.cfg.apiKeyId,
        apiKeySecret: this.cfg.apiKeySecret,
        walletSecret: this.cfg.walletSecret,
      });
    }
    return this.cdpClient;
  }

  /**
   * Create a SERVER-MANAGED CDP smart wallet (fresh CDP owner EOA + ERC-4337 smart
   * account). PCC (via the Wallet Secret) controls the owner key, so this is NOT a
   * user-controlled wallet — the param type forbids minting "user-owned" here (that
   * requires the embedded/user-auth flow, P1). "server-test-only" is Base Sepolia +
   * faucet ONLY; "treasury" is deliberately PCC-controlled and may run on mainnet.
   */
  async createWallet(
    opts: { custodyMode?: "server-test-only" | "treasury" } = {},
  ): Promise<CdpWallet> {
    const custodyMode = opts.custodyMode ?? "server-test-only";
    // Never mint a user-owned wallet here — server-managed creation controls the owner key.
    // (Runtime guard for untyped JS callers; the param type already forbids "user-owned".)
    assertServerManaged(custodyMode);
    // A server-managed wallet can never be genuinely user-owned. "server-test-only" must
    // stay on Base Sepolia — refuse to mint one on mainnet, where a participant wallet has
    // to be user-owned (embedded flow) and a PCC-controlled wallet has to be "treasury".
    if (custodyMode === "server-test-only" && this.network !== "base-sepolia") {
      throw new Error(
        `Refusing to create a server-test-only wallet on ${this.network}: server-managed ` +
          `wallets are Base Sepolia only. A mainnet participant wallet must be user-owned ` +
          `(embedded/user-auth flow); a PCC-controlled mainnet wallet must be "treasury".`,
      );
    }
    if (this.mock) {
      return {
        address: mockAddress(),
        network: this.network,
        smartAccount: true,
        custodyMode,
        createdAt: new Date().toISOString(),
      };
    }
    const cdp = await this.cdp();
    const owner = await cdp.evm.createAccount();
    // enableSpendPermissions adds the SpendPermissionManager as a second owner, so the
    // wallet can later grant scoped, revocable spend permissions — the lane's custody model.
    const smart = await cdp.evm.createSmartAccount({ owner, enableSpendPermissions: true });
    return {
      address: smart.address as `0x${string}`,
      network: this.network,
      smartAccount: true,
      custodyMode,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Record an externally-created (CLIENT-SIDE — CDP embedded/user-auth or passkey) wallet the
   * END USER controls, by ADDRESS ONLY. This is the ONLY production path to a "user-owned"
   * participant wallet: createWallet() cannot mint one (it would control the owner key, making
   * the wallet NOT user-owned). PCC holds no owner key/secret for the address and — by the
   * custody guards — can never sign, rotate, or server-substitute for it; it may only read the
   * balance and receive onramped USDC. The returned CdpWallet and the stored record have NO key
   * field, so attaching signing material here is structurally impossible.
   *
   * Async for surface parity with createWallet()/getBalance() and to allow a future real-mode
   * check (e.g. confirming the address is a deployed/known smart account) without a breaking change.
   */
  async registerUserOwnedWallet(params: RegisterUserOwnedWalletParams): Promise<CdpWallet> {
    const address = validateAddressShape(params.address);
    const createdAt = new Date().toISOString();
    const record: UserOwnedWalletRecord = {
      address,
      network: this.network,
      ...(params.authProviderRef !== undefined ? { authProviderRef: params.authProviderRef } : {}),
      createdAt,
    };
    this.userOwned.register(record);
    return {
      address,
      network: this.network,
      // CDP embedded/user-auth and passkey participant wallets are ERC-4337 smart accounts; the
      // human funding path (sponsored user-op calling MilestoneEscrow.fund) requires a smart account.
      smartAccount: true,
      custodyMode: "user-owned",
      ...(params.authProviderRef !== undefined ? { authProviderRef: params.authProviderRef } : {}),
      createdAt,
    };
  }

  /**
   * The server-signing choke point. Throws CustodyViolationError if the target is a user-owned
   * wallet — either by its object custody type (CdpWallet) or because its address is registered
   * as user-owned. Every server-side signing attempt must route through here first. Reads and
   * receives are not signing and never call this.
   */
  assertCanSign(target: CdpWallet | `0x${string}`, op = "sign"): void {
    if (typeof target === "string") {
      this.userOwned.assertNotUserOwned(target, op);
      return;
    }
    assertWalletServerSignable(target, op);
    this.userOwned.assertNotUserOwned(target.address, op); // belt-and-suspenders on the address
  }

  /**
   * Throws for a user-owned wallet — PCC holds no owner key, so there is no rotation path. No
   * rotation method exists on this client; this guard refuses any future one for a user-owned target.
   */
  assertNoOwnerRotation(target: CdpWallet | `0x${string}`, op = "rotate the owner of"): void {
    if (typeof target === "string") {
      this.userOwned.assertNotUserOwned(target, op);
      return;
    }
    assertWalletNoOwnerRotation(target, op);
    this.userOwned.assertNotUserOwned(target.address, op);
  }

  /** Is this address a registered user-owned participant wallet? */
  isUserOwned(address: string): boolean {
    return this.userOwned.has(address);
  }

  /** The user-owned record for an address (address + network + non-secret authProviderRef), or undefined. */
  getUserOwnedWallet(address: string): UserOwnedWalletRecord | undefined {
    return this.userOwned.get(address);
  }

  /** All registered user-owned wallet records. Holds no keys. */
  listUserOwnedWallets(): UserOwnedWalletRecord[] {
    return this.userOwned.list();
  }

  /** USDC balance for an address on the configured network. */
  async getBalance(
    address: `0x${string}`,
  ): Promise<{ address: `0x${string}`; usdc: number; network: CdpNetwork }> {
    if (this.mock) {
      return { address, usdc: 0, network: this.network };
    }
    const cdp = await this.cdp();
    // Result-shape parsing is defensive (validated by the live smoke); the CALL is typed.
    const res = (await cdp.evm.listTokenBalances({
      address,
      network: this.network,
    })) as unknown as {
      balances?: Array<{
        token?: { symbol?: string; decimals?: number };
        amount?: { amount?: bigint };
      }>;
    };
    let usdc = 0;
    for (const b of res.balances ?? []) {
      if ((b.token?.symbol ?? "").toUpperCase() === "USDC") {
        const decimals = b.token?.decimals ?? 6;
        usdc = Number(b.amount?.amount ?? 0n) / 10 ** decimals;
      }
    }
    return { address, usdc, network: this.network };
  }

  /**
   * Faucet testnet funds (base-sepolia only). Lets the entire flow be proven on testnet
   * with no card and no real money. No-op-shaped on mainnet (the API rejects it there).
   */
  async requestFaucet(
    address: `0x${string}`,
    token: "usdc" | "eth" = "usdc",
  ): Promise<{ transactionHash: string }> {
    if (this.mock) {
      return { transactionHash: "0x" + "f".repeat(64) };
    }
    const cdp = await this.cdp();
    const res = (await cdp.evm.requestFaucet({
      address,
      network: this.network as "base-sepolia",
      token,
    })) as unknown as { transactionHash: string };
    return { transactionHash: res.transactionHash };
  }
}

/** Deterministic-shape mock EVM address (20 bytes). */
function mockAddress(): `0x${string}` {
  const hex = (randomUUID() + randomUUID()).replace(/-/g, "");
  return ("0x" + hex.slice(0, 40)) as `0x${string}`;
}
