/**
 * MPP Session Manager -- manages Tempo payment sessions.
 *
 * Provides a high-level API for session-based payments where a client
 * opens a payment channel with an upfront deposit, streams interactions
 * within the session (each deducting from the channel), and eventually
 * settles and closes.
 *
 * This wraps mppx client's session method for PCC-specific usage:
 * - Environment-driven configuration
 * - Session timeout handling
 * - Integration with PCC agent wallets
 *
 * Usage:
 *   import { MppSessionManager } from "@pcc/payments";
 *   const session = MppSessionManager.create({ account, deposit: "10" });
 *   await session.open();
 *   const res = await session.fetch("/api/capabilities/route", { method: "POST", body });
 *   await session.close();
 */

import { Mppx, session } from "mppx/client";
import type { MppSessionConfig } from "@pcc/spec";

export interface MppSessionManagerConfig extends MppSessionConfig {
  /**
   * Viem account for signing transactions and vouchers.
   * Can be a local account address string or account object.
   */
  account: `0x${string}` | { address: `0x${string}` };
  /**
   * Optional custom fetch function.
   */
  fetchFn?: typeof globalThis.fetch;
}

/**
 * PCC wrapper for mppx session-based payments.
 *
 * Uses mppx/client with the session() method which handles:
 * - Channel open with upfront deposit
 * - Cumulative voucher signing per request
 * - Channel close and settlement
 *
 * This class adds:
 * - Timeout-based auto-close
 * - PCC-specific configuration defaults
 * - Simplified lifecycle API
 */
export class MppSessionManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mppx types are deeply generic
  private mppx: any;
  private timeoutMs: number;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private _closed = false;
  private _opened = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private constructor(mppx: any, timeoutMs: number) {
    this.mppx = mppx;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Create a session manager instance.
   */
  static create(config: MppSessionManagerConfig): MppSessionManager {
    const account = typeof config.account === "string"
      ? config.account
      : config.account.address;

    // Create mppx client with the session method (Method.Client).
    // The session method handles channel lifecycle automatically when deposit is set.
    const mppx = Mppx.create({
      methods: [
        session({
          account,
          deposit: config.deposit,
          decimals: config.decimals ?? 6,
          escrowContract: config.escrowContract,
        }),
      ],
      fetch: config.fetchFn,
      polyfill: false,
    });

    const timeoutMs = config.timeoutMs ?? 30 * 60 * 1000; // 30 min default

    return new MppSessionManager(mppx, timeoutMs);
  }

  /**
   * Start the session. The first fetch() call will trigger channel open
   * with the configured deposit amount.
   */
  async open(): Promise<void> {
    if (this._closed) {
      throw new Error("Session already closed");
    }
    this._opened = true;
    this.startTimeout();
  }

  /**
   * Fetch a resource within this session.
   * Each request deducts from the channel's deposit via cumulative vouchers.
   * The first fetch after open() triggers channel creation on-chain.
   */
  async fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this._closed) {
      throw new Error("Session is closed");
    }
    if (!this._opened) {
      throw new Error("Session not opened -- call open() first");
    }

    this.resetTimeout();
    return this.mppx.fetch(url, init);
  }

  /**
   * Close the session. This is a soft close -- the underlying channel
   * close happens automatically when mppx detects no more activity.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.clearTimeout();
    // mppx handles channel close when the client is garbage collected
    // or when the server-side session timeout fires
  }

  /** Whether open() has been called */
  get opened(): boolean {
    return this._opened;
  }

  /** Whether this session has been closed */
  get closed(): boolean {
    return this._closed;
  }

  // -- Timeout management --

  private startTimeout(): void {
    if (this.timeoutMs <= 0) return;
    this.timeoutHandle = setTimeout(() => {
      this.close().catch(() => {
        // Silent close on timeout -- best effort
      });
    }, this.timeoutMs);
  }

  private resetTimeout(): void {
    this.clearTimeout();
    this.startTimeout();
  }

  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      globalThis.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
