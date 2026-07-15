import { randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, SpendPermission } from "./types.js";
import type { UserOwnedWalletRegistry } from "./custody.js";

export interface IssueSpendPermissionParams {
  /** Funded smart account that authorizes spend. */
  account: `0x${string}`;
  /** Scoped signer (agent/operator) allowed to spend within the limits. */
  spender: `0x${string}`;
  allowanceUSDC: number;
  periodSec: number;
  /** ISO timestamp; default now + 30 days. */
  expiresAt?: string;
}

const USDC_DECIMALS = 1_000_000; // 6 dp

/**
 * CdpSpendPermissionService — issues a SCOPED, REVOCABLE spend authority.
 *
 * Custody invariant: the spender never gets a raw key. It gets a capped, time-boxed,
 * owner-revocable allowance (Coinbase Smart Wallet Spend Permissions). Same one-card
 * UX, zero blast radius.
 *
 * Mock/real switch is presence-of-creds. Real-mode calls cdp.evm.createSpendPermission /
 * revokeSpendPermission / listSpendPermissions. The `store` doubles as the mock backing
 * AND a real-mode id->{account} cache so revoke(id) can resolve the owning account +
 * permission hash (it holds NO key material).
 */
export class CdpSpendPermissionService {
  private readonly mock: boolean;
  private readonly cfg: CdpConfig;
  private readonly network: CdpNetwork;
  private readonly store = new Map<string, SpendPermission>();
  private readonly userOwned?: UserOwnedWalletRegistry;
  private cdpClient: import("@coinbase/cdp-sdk").CdpClient | undefined;

  constructor(
    cfg: CdpConfig = {},
    deps: { userOwnedRegistry?: UserOwnedWalletRegistry } = {},
  ) {
    this.cfg = cfg;
    this.mock = cfg.mock ?? !cfg.apiKeyId;
    this.network = cfg.network ?? "base-sepolia";
    // Optional shared registry. When present, issuing a permission FROM a user-owned account is
    // refused (a spend permission is signed by the account owner, which PCC is not). When absent,
    // behavior is unchanged — fully backward-compatible.
    this.userOwned = deps.userOwnedRegistry;
  }

  get isMock(): boolean {
    return this.mock;
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

  async issue(params: IssueSpendPermissionParams): Promise<SpendPermission> {
    // A spend permission is SIGNED by the account owner. PCC cannot sign for a user-owned
    // participant wallet, so refuse rather than emit a cryptic SDK error or silently substitute
    // a server signer. (No-op when no shared registry is wired.)
    this.userOwned?.assertNotUserOwned(params.account, "issue a spend permission");
    const now = new Date();
    const expiresAt =
      params.expiresAt ?? new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();
    const allowance = String(Math.round(params.allowanceUSDC * USDC_DECIMALS));

    if (this.mock) {
      const perm: SpendPermission = {
        permissionId: "cdp_spendperm_" + randomUUID(),
        account: params.account,
        spender: params.spender,
        token: "USDC",
        allowance,
        allowanceUSDC: params.allowanceUSDC,
        periodSec: params.periodSec,
        start: now.toISOString(),
        expiresAt,
        revoked: false,
      };
      this.store.set(perm.permissionId, perm);
      return perm;
    }

    const cdp = await this.cdp();
    await cdp.evm.createSpendPermission({
      spendPermission: {
        account: params.account,
        spender: params.spender,
        token: "usdc",
        allowance: BigInt(allowance),
        period: params.periodSec,
      },
      network: this.network,
    });
    // createSpendPermission returns a UserOperation; the revoke handle is the on-chain
    // permission hash, which we read back from the list. Defensive parse (smoke-validated).
    const permissionId = (await this.latestPermissionHash(params.account)) ?? "0x" + randomUUID().replace(/-/g, "");
    const perm: SpendPermission = {
      permissionId,
      account: params.account,
      spender: params.spender,
      token: "USDC",
      allowance,
      allowanceUSDC: params.allowanceUSDC,
      periodSec: params.periodSec,
      start: now.toISOString(),
      expiresAt,
      revoked: false,
    };
    this.store.set(permissionId, perm); // id->{account,hash} cache for revoke; no keys
    return perm;
  }

  async revoke(permissionId: string): Promise<{ permissionId: string; revoked: true }> {
    if (this.mock) {
      const p = this.store.get(permissionId);
      if (p) {
        p.revoked = true;
        this.store.set(permissionId, p);
      }
      return { permissionId, revoked: true };
    }
    const cdp = await this.cdp();
    const cached = this.store.get(permissionId);
    if (cached) {
      await cdp.evm.revokeSpendPermission({
        address: cached.account,
        permissionHash: permissionId as `0x${string}`,
        network: this.network,
      });
      cached.revoked = true;
      this.store.set(permissionId, cached);
    }
    return { permissionId, revoked: true };
  }

  async get(permissionId: string): Promise<SpendPermission | null> {
    return this.store.get(permissionId) ?? null;
  }

  async list(account: `0x${string}`): Promise<SpendPermission[]> {
    if (this.mock) {
      const a = account.toLowerCase();
      return [...this.store.values()].filter((p) => p.account.toLowerCase() === a);
    }
    const cdp = await this.cdp();
    const res = (await cdp.evm.listSpendPermissions({ address: account })) as unknown as {
      spendPermissions?: Array<{
        permissionHash?: string;
        permission?: { spender?: string; allowance?: string | bigint; period?: number };
      }>;
    };
    const out: SpendPermission[] = [];
    for (const p of res.spendPermissions ?? []) {
      const id = p.permissionHash ?? "0x";
      const allowanceUnit = String(p.permission?.allowance ?? "0");
      out.push({
        permissionId: id,
        account,
        spender: (p.permission?.spender ?? "0x") as `0x${string}`,
        token: "USDC",
        allowance: allowanceUnit,
        allowanceUSDC: Number(allowanceUnit) / USDC_DECIMALS,
        periodSec: p.permission?.period ?? 0,
        start: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        revoked: false,
      });
      // refresh the revoke cache
      const prev = this.store.get(id);
      if (!prev) {
        this.store.set(id, out[out.length - 1]!);
      }
    }
    return out;
  }

  /** Read back the most recent permission hash for an account (real mode). */
  private async latestPermissionHash(account: `0x${string}`): Promise<string | undefined> {
    try {
      const cdp = await this.cdp();
      const res = (await cdp.evm.listSpendPermissions({ address: account })) as unknown as {
        spendPermissions?: Array<{ permissionHash?: string }>;
      };
      const arr = res.spendPermissions ?? [];
      return arr[arr.length - 1]?.permissionHash;
    } catch {
      return undefined;
    }
  }
}
