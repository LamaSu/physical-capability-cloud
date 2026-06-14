import { randomUUID } from "node:crypto";
import type { CdpConfig, SpendPermission } from "./types.js";

export interface IssueSpendPermissionParams {
  /** Funded wallet that authorizes spend. */
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
 * Mock-first: an in-memory store. Real-mode registers the permission with the
 * Spend Permission Manager contract (approveWithSignature / SpendPermission struct).
 */
export class CdpSpendPermissionService {
  private readonly mock: boolean;
  private readonly store = new Map<string, SpendPermission>();

  constructor(cfg: CdpConfig = {}) {
    this.mock = cfg.mock ?? !cfg.apiKeyId;
  }

  get isMock(): boolean {
    return this.mock;
  }

  async issue(params: IssueSpendPermissionParams): Promise<SpendPermission> {
    const now = new Date();
    const expiresAt =
      params.expiresAt ?? new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();
    const perm: SpendPermission = {
      permissionId: "cdp_spendperm_" + randomUUID(),
      account: params.account,
      spender: params.spender,
      token: "USDC",
      allowance: String(Math.round(params.allowanceUSDC * USDC_DECIMALS)),
      allowanceUSDC: params.allowanceUSDC,
      periodSec: params.periodSec,
      start: now.toISOString(),
      expiresAt,
      revoked: false,
    };
    if (this.mock) {
      this.store.set(perm.permissionId, perm);
      return perm;
    }
    throw new Error("CDP_REAL_NOT_WIRED: register Spend Permission on-chain");
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
    throw new Error("CDP_REAL_NOT_WIRED: revoke Spend Permission on-chain");
  }

  async get(permissionId: string): Promise<SpendPermission | null> {
    if (this.mock) return this.store.get(permissionId) ?? null;
    throw new Error("CDP_REAL_NOT_WIRED: read Spend Permission");
  }

  async list(account: `0x${string}`): Promise<SpendPermission[]> {
    if (this.mock) {
      const a = account.toLowerCase();
      return [...this.store.values()].filter((p) => p.account.toLowerCase() === a);
    }
    throw new Error("CDP_REAL_NOT_WIRED: list Spend Permissions");
  }
}
