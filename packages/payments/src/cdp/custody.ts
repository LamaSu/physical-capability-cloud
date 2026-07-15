/**
 * Custody guards for the noncustodial human onramp (audit F1 / H-12).
 *
 * The load-bearing guarantee of the human MVP is: a participant wallet is "user-owned"
 * (the END USER controls the signing key), and PCC is provably UNABLE to sign, rotate, or
 * server-substitute for it. PCC may READ its balance and RECEIVE onramped USDC to the
 * address — it just can never act AS the wallet.
 *
 * These are pure guards + an in-memory address registry. No key material lives here — the
 * types below have no field for a private key/seed/mnemonic/wallet-secret, so it is
 * structurally impossible to attach one.
 */

import type { CdpNetwork, WalletCustodyMode } from "./types.js";

/**
 * Thrown whenever PCC is asked to sign, rotate, or server-substitute for a wallet the end
 * user controls. It is NEVER thrown for a legitimate server-managed
 * ("server-test-only"/"treasury") op, and never for a read (balance) or receive (onramp).
 */
export class CustodyViolationError extends Error {
  readonly code = "CUSTODY_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "CustodyViolationError";
  }
}

/** Strict 20-byte hex EVM address shape. viem isn't a dependency here and this path only
 *  ever stores the address (never a key), so shape is the guarantee we need — not checksum. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

export function isAddressShape(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS_SHAPE.test(value);
}

/** Validate + narrow an EVM address shape, or throw. Does NOT verify checksum or on-chain
 *  existence (a client-side/CDP concern) — the custody guarantee does not depend on that. */
export function validateAddressShape(value: unknown): `0x${string}` {
  if (!isAddressShape(value)) {
    throw new CustodyViolationError(
      `Invalid EVM address shape: expected "0x" + 40 hex chars, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function isUserOwned(w: { custodyMode: WalletCustodyMode }): boolean {
  return w.custodyMode === "user-owned";
}

/**
 * Server-signing choke point. PCC signs with its Wallet Secret; it holds NO owner key for a
 * "user-owned" wallet, so every server-side signing/authority op MUST route through here and
 * refuse. Reads and receives do not call this.
 */
export function assertServerSignable(
  w: { custodyMode: WalletCustodyMode; address?: string },
  op = "sign",
): void {
  if (isUserOwned(w)) {
    throw new CustodyViolationError(
      `Refusing to ${op} as user-owned wallet${w.address ? " " + w.address : ""}: PCC holds no ` +
        `owner key for it. Signing must happen client-side in the user's CDP embedded/user-auth wallet.`,
    );
  }
}

/**
 * Owner rotation is impossible for a user-owned wallet — PCC holds no owner key, so there is
 * nothing to rotate. No rotation method exists in this package; this guard makes any future
 * rotation path refuse a user-owned target rather than silently do the wrong thing.
 */
export function assertNoOwnerRotation(
  w: { custodyMode: WalletCustodyMode; address?: string },
  op = "rotate the owner of",
): void {
  if (isUserOwned(w)) {
    throw new CustodyViolationError(
      `No owner-rotation path exists for user-owned wallet${w.address ? " " + w.address : ""}: ` +
        `PCC cannot ${op} an owner key it does not hold.`,
    );
  }
}

/** `createWallet()` must only ever mint a server-managed wallet. Runtime defense-in-depth for
 *  untyped (JS) callers, on top of the compile-time param type that already forbids user-owned. */
export function assertServerManaged(custodyMode: WalletCustodyMode): void {
  if (custodyMode === "user-owned") {
    throw new CustodyViolationError(
      `createWallet cannot mint a user-owned wallet: server-managed creation controls the owner ` +
        `key, which would make the wallet NOT user-owned. Register an externally-created ` +
        `(client-side) user-owned wallet via registerUserOwnedWallet(address) instead.`,
    );
  }
}

/**
 * A record of an externally-created (client-side) user-owned wallet. The backend knows the
 * wallet by ADDRESS ONLY. This shape has NO field for a private key, seed, mnemonic, or wallet
 * secret — storing signing material here is structurally impossible.
 */
export interface UserOwnedWalletRecord {
  readonly address: `0x${string}`;
  readonly network: CdpNetwork;
  /** Non-secret reference to the user's auth identity (e.g. CDP embedded-wallet user id).
   *  This is an identifier, NOT signing material. Optional. */
  readonly authProviderRef?: string;
  readonly createdAt: string;
}

/**
 * In-memory registry of user-owned wallet addresses. Its one job: let any address-keyed
 * signing path answer "is this a user-owned participant wallet?" so a server-managed signer can
 * never be silently substituted for one. Holds no keys. Share one instance across the wallet
 * client and the spend-permission service to make the guard cross-client.
 */
export class UserOwnedWalletRegistry {
  private readonly byAddress = new Map<string, UserOwnedWalletRecord>();

  /** Idempotent for an identical (address, authProviderRef) pair; a conflicting authProviderRef
   *  for an already-registered address is refused (someone is confusing two owners). */
  register(record: UserOwnedWalletRecord): UserOwnedWalletRecord {
    const key = record.address.toLowerCase();
    const existing = this.byAddress.get(key);
    if (existing) {
      if (existing.authProviderRef !== record.authProviderRef) {
        throw new CustodyViolationError(
          `Address ${record.address} is already registered as user-owned with a different auth ` +
            `reference; refusing to overwrite.`,
        );
      }
      return existing;
    }
    this.byAddress.set(key, record);
    return record;
  }

  has(address: string): boolean {
    return this.byAddress.has(address.toLowerCase());
  }

  get(address: string): UserOwnedWalletRecord | undefined {
    return this.byAddress.get(address.toLowerCase());
  }

  list(): UserOwnedWalletRecord[] {
    return [...this.byAddress.values()];
  }

  /** Substitution guard: refuse to route a registered user-owned address into a server-signing
   *  path. This is what makes "a user-owned reference cannot resolve to a server signer" true. */
  assertNotUserOwned(address: string, op = "server-sign"): void {
    if (this.has(address)) {
      throw new CustodyViolationError(
        `Refusing to ${op} for ${address}: it is a registered user-owned participant wallet. A ` +
          `server-managed signer must never be substituted for a user-owned wallet.`,
      );
    }
  }
}
