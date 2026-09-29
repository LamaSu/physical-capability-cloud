import { randomBytes, randomUUID } from "node:crypto";
import type { CdpConfig, CdpNetwork, SpendPermission } from "./types.js";
import { cdpCredentialsComplete } from "./mode.js";

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

/** Waits before each read-back of a just-created permission (it can take a moment to list). */
const READ_BACK_DELAYS_MS = [0, 750, 1500];
/** Bound on listSpendPermissions pages read for one account. */
const MAX_LIST_PAGES = 20;

// The errors below carry an HTTP statusCode, which the gateway's error handler honours,
// so a route that just awaits the service answers 400 / 404 / 502 with no mapping code.

/** A request the service refuses before anything is sent (HTTP 400). */
export class CdpSpendPermissionInputError extends RangeError {
  readonly code = "invalid_spend_permission";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "CdpSpendPermissionInputError";
  }
}

/**
 * revoke() of an id this process holds no record of (HTTP 404). Nothing is revoked, so
 * nothing is claimed. It used to answer revoked:true, which in real mode is every
 * permission issued before a restart (shell #3352, verifier-golf-2).
 */
export class CdpSpendPermissionNotFoundError extends Error {
  readonly code = "unknown_permission";
  readonly statusCode = 404;
  constructor(readonly permissionId: string) {
    super(
      "This gateway process holds no record of that spend permission (it may have been issued " +
        "before a restart), so nothing was revoked. If it exists on-chain, its allowance is still live.",
    );
    this.name = "CdpSpendPermissionNotFoundError";
  }
}

/**
 * A real-mode permission was submitted, but its on-chain hash could not be read back
 * (HTTP 502). No id is invented: the old code returned "0x"+UUID here, an id that named
 * nothing and could never be revoked (shell #3352, verifier-golf-2).
 */
export class CdpSpendPermissionUnconfirmedError extends Error {
  readonly code = "spend_permission_unconfirmed";
  readonly statusCode = 502;
  constructor(
    readonly account: `0x${string}`,
    readonly salt: string,
  ) {
    super(
      `A spend permission for ${account} was submitted, but its on-chain hash could not be read back ` +
        `(salt ${salt}). Nothing was cached. List the wallet's spend permissions to find it before ` +
        `relying on it or revoking it.`,
    );
    this.name = "CdpSpendPermissionUnconfirmedError";
  }
}

/**
 * list() could not read every page within MAX_LIST_PAGES (HTTP 502). A prefix is
 * never presented as the complete list (round 8, astra failclosed r2 new defect 4):
 * it could hide live allowances.
 */
export class CdpSpendPermissionListIncompleteError extends Error {
  readonly code = "spend_permission_list_incomplete";
  readonly statusCode = 502;
  constructor(readonly account: `0x${string}`) {
    super(`The spend permissions of ${account} span more than ${MAX_LIST_PAGES} pages, so no partial list is returned.`);
    this.name = "CdpSpendPermissionListIncompleteError";
  }
}

/** One entry of listSpendPermissions, parsed defensively. */
interface ListedPermission {
  permissionHash?: string;
  revoked?: boolean;
  createdAt?: string;
  permission?: {
    spender?: string;
    allowance?: string | bigint;
    period?: number;
    start?: number;
    end?: number;
    salt?: string | bigint;
  };
}

function saltOf(p: ListedPermission): bigint | undefined {
  const raw = p.permission?.salt;
  if (raw === undefined || raw === null) return undefined;
  try {
    return BigInt(raw);
  } catch {
    return undefined;
  }
}

function isoFromUnixSeconds(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  const d = new Date(v * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

/**
 * CdpSpendPermissionService — issues a SCOPED, REVOCABLE spend authority.
 *
 * Custody invariant: the spender never gets a raw key. It gets a capped, time-boxed,
 * owner-revocable allowance (Coinbase Smart Wallet Spend Permissions). Same one-card
 * UX, zero blast radius.
 *
 * Mock/real switch: the full credential tuple (cdpCredentialsComplete), and mock results
 * say `mock: true`. Real mode calls cdp.evm.createSpendPermission /
 * revokeSpendPermission / listSpendPermissions. The `store` doubles as the mock backing
 * AND a real-mode id->{account} cache so revoke(id) can resolve the owning account +
 * permission hash (it holds NO key material).
 *
 * Honesty rules (WP-A round 5, shell #3352):
 * - issue() puts a fresh random salt in the permission and reads back the entry with
 *   THAT salt. It used to take the account's last permission, which could be an older
 *   one: revoking that id then left the new allowance live. It passes expiresAt as the
 *   on-chain end, so the permission really is time-boxed as reported.
 * - revoke() of an id this process does not know revokes nothing and throws
 *   CdpSpendPermissionNotFoundError (404). It used to answer revoked:true, which in real
 *   mode is every permission issued before a restart.
 */
export class CdpSpendPermissionService {
  private readonly mock: boolean;
  private readonly cfg: CdpConfig;
  private readonly network: CdpNetwork;
  private readonly store = new Map<string, SpendPermission>();
  private cdpClient: import("@coinbase/cdp-sdk").CdpClient | undefined;

  constructor(cfg: CdpConfig = {}) {
    this.cfg = cfg;
    // cfg.mock can force MOCK, never REAL: without the full tuple the client is mock
    // whatever cfg.mock says (round 8, astra failclosed r2 FC-6).
    this.mock = cfg.mock === true || !cdpCredentialsComplete(cfg);
    this.network = cfg.network ?? "base-sepolia";
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
    const now = new Date();
    const expiresAt =
      params.expiresAt ?? new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();
    const end = new Date(expiresAt);
    if (!Number.isFinite(end.getTime()) || end.getTime() <= now.getTime()) {
      throw new CdpSpendPermissionInputError("expiresAt must be a future ISO-8601 timestamp");
    }
    if (typeof params.allowanceUSDC !== "number" || !Number.isFinite(params.allowanceUSDC) || params.allowanceUSDC <= 0) {
      throw new CdpSpendPermissionInputError("allowanceUSDC must be a positive number");
    }
    if (!Number.isInteger(params.periodSec) || params.periodSec <= 0) {
      throw new CdpSpendPermissionInputError("periodSec must be a positive whole number of seconds");
    }
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
        mock: true,
      };
      this.store.set(perm.permissionId, perm);
      return perm;
    }

    const cdp = await this.cdp();
    // The salt makes THIS permission identifiable when it is read back below.
    const salt = BigInt("0x" + randomBytes(16).toString("hex"));
    await cdp.evm.createSpendPermission({
      spendPermission: {
        account: params.account,
        spender: params.spender,
        token: "usdc",
        allowance: BigInt(allowance),
        period: params.periodSec,
        start: now,
        end,
        salt,
      },
      network: this.network,
    });
    // createSpendPermission returns a UserOperation; the revoke handle is the on-chain
    // permission hash, read back from the list by salt. Defensive parse (smoke-validated).
    const permissionId = await this.readBackPermissionHash(params.account, salt);
    if (!permissionId) {
      throw new CdpSpendPermissionUnconfirmedError(params.account, salt.toString());
    }
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

  async revoke(permissionId: string): Promise<{ permissionId: string; revoked: true; mock?: true }> {
    const known = this.store.get(permissionId);
    if (!known) throw new CdpSpendPermissionNotFoundError(permissionId);
    if (this.mock) {
      known.revoked = true;
      return { permissionId, revoked: true, mock: true };
    }
    const cdp = await this.cdp();
    await cdp.evm.revokeSpendPermission({
      address: known.account,
      permissionHash: permissionId as `0x${string}`,
      network: this.network,
    });
    known.revoked = true;
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
    const listed = await this.listAll(account);
    if (!listed.complete) throw new CdpSpendPermissionListIncompleteError(account);
    const out: SpendPermission[] = [];
    for (const p of listed.entries) {
      // An entry with no hash can be neither identified nor revoked (it used to become id "0x").
      if (!p.permissionHash) continue;
      const id = p.permissionHash;
      const allowanceUnit = String(p.permission?.allowance ?? "0");
      out.push({
        permissionId: id,
        account,
        spender: (p.permission?.spender ?? "0x") as `0x${string}`,
        token: "USDC",
        allowance: allowanceUnit,
        allowanceUSDC: Number(allowanceUnit) / USDC_DECIMALS,
        periodSec: p.permission?.period ?? 0,
        // The chain's own window, not "now" (unknown stays empty rather than invented).
        start: isoFromUnixSeconds(p.permission?.start) ?? p.createdAt ?? "",
        expiresAt: isoFromUnixSeconds(p.permission?.end) ?? "",
        revoked: p.revoked === true,
      });
      // refresh the revoke cache
      const prev = this.store.get(id);
      if (!prev) {
        this.store.set(id, out[out.length - 1]!);
      }
    }
    return out;
  }

  /**
   * Every listed permission of an account, following pagination (bounded). `complete`
   * is false when MAX_LIST_PAGES pages were read and the SDK still named a next page:
   * callers must not treat that prefix as the whole list.
   */
  private async listAll(account: `0x${string}`): Promise<{ entries: ListedPermission[]; complete: boolean }> {
    const cdp = await this.cdp();
    const entries: ListedPermission[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = (await cdp.evm.listSpendPermissions({ address: account, pageToken })) as unknown as {
        spendPermissions?: ListedPermission[];
        nextPageToken?: string;
      };
      entries.push(...(res.spendPermissions ?? []));
      if (!res.nextPageToken) return { entries, complete: true };
      pageToken = res.nextPageToken;
    }
    return { entries, complete: false };
  }

  /** The hash of the permission carrying `salt` (real mode), or undefined if it never lists. */
  private async readBackPermissionHash(
    account: `0x${string}`,
    salt: bigint,
  ): Promise<string | undefined> {
    for (const delay of READ_BACK_DELAYS_MS) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      let listed: ListedPermission[];
      try {
        // An incomplete listing may still contain the new entry; if it does not, the
        // permission counts as unconfirmed (no id is ever guessed).
        listed = (await this.listAll(account)).entries;
      } catch {
        continue;
      }
      const hit = listed.find((p) => typeof p.permissionHash === "string" && saltOf(p) === salt);
      if (hit?.permissionHash) return hit.permissionHash;
    }
    return undefined;
  }
}
