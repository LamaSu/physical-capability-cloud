/**
 * On-chain event watcher.
 *
 * Wraps viem's watchContractEvent. For each configured ChainWatcher, we
 * subscribe to the listed events and dispatch each log as an Alert.
 *
 * Special rule: if a rule declares a whitelist, the caller (or other arg
 * named by whitelistArg) is lowercased and checked. A match keeps the
 * rule's onFire severity; a miss UPGRADES to "critical". The original
 * onFire is ignored in that case — this is the "unexpected caller on
 * release()" guarantee PCC escrow needs.
 *
 * viem is accessed via a small abstraction so tests can inject a fake
 * client that synthesizes events on demand.
 *
 * Author: implementer-alpha
 */

import type { Alert, Severity } from "./types.js";
import type { ChainEventRule, ChainWatcherConfig } from "./config.js";

/**
 * Minimal viem-compatible surface we depend on. Kept narrow so that (a)
 * tests don't need a real client and (b) viem version bumps don't cascade.
 */
export interface ViemLikeClient {
  watchContractEvent: (args: {
    address: `0x${string}`;
    abi: unknown[];
    eventName: string;
    onLogs: (logs: unknown[]) => void;
    onError?: (err: unknown) => void;
  }) => () => void;
}

/** How the watcher obtains a client for a given config. Overridable in tests. */
export type ChainClientFactory = (config: ChainWatcherConfig) => ViemLikeClient;

export interface ChainWatcherHandle {
  stop: () => void;
}

/**
 * Shape of a log passed to onLogs. Mirrors what viem produces: `args` is the
 * decoded event arguments as a record when viem can decode them.
 */
export interface DecodedLog {
  transactionHash?: string;
  blockNumber?: bigint | number;
  args?: Record<string, unknown>;
  eventName?: string;
}

export function evaluateRule(
  rule: ChainEventRule,
  log: DecodedLog,
): { severity: Severity; reason: "match" | "whitelist-miss" } {
  if (!rule.whitelist || rule.whitelist.length === 0) {
    return { severity: rule.onFire, reason: "match" };
  }
  const argName = rule.whitelistArg;
  const raw = log.args?.[argName];
  if (typeof raw !== "string") {
    // The whitelist is configured but the event doesn't carry the arg we
    // expected. Treat that as a miss — safer to over-alert than under-alert.
    return { severity: "critical", reason: "whitelist-miss" };
  }
  const actor = raw.toLowerCase();
  const allowed = rule.whitelist.map((a) => a.toLowerCase());
  if (allowed.includes(actor)) {
    return { severity: rule.onFire, reason: "match" };
  }
  return { severity: "critical", reason: "whitelist-miss" };
}

export function logToAlert(
  watcher: ChainWatcherConfig,
  rule: ChainEventRule,
  log: DecodedLog,
  severity: Severity,
  reason: "match" | "whitelist-miss",
): Alert {
  const titlePrefix = reason === "whitelist-miss" ? "UNEXPECTED CALLER" : "chain event";
  return {
    ts: new Date().toISOString(),
    source: "chain-watcher",
    severity,
    title: `${titlePrefix}: ${watcher.label} ${rule.name}`,
    body:
      reason === "whitelist-miss"
        ? `${rule.name} fired from a non-whitelisted address on ${watcher.label} (${watcher.chain}).`
        : `${rule.name} fired on ${watcher.label} (${watcher.chain}).`,
    context: {
      chain: watcher.chain,
      address: watcher.address,
      eventName: rule.name,
      txHash: log.transactionHash,
      blockNumber:
        typeof log.blockNumber === "bigint"
          ? log.blockNumber.toString()
          : log.blockNumber,
      args: log.args,
      reason,
    },
  };
}

export interface StartChainWatcherOptions {
  config: ChainWatcherConfig;
  clientFactory: ChainClientFactory;
  /** Called for every alert produced by this watcher. */
  onAlert: (alert: Alert) => void | Promise<void>;
  /** Called when viem reports a subscription error. */
  onError?: (err: unknown) => void;
}

export function startChainWatcher(opts: StartChainWatcherOptions): ChainWatcherHandle {
  const client = opts.clientFactory(opts.config);
  const unsubs: Array<() => void> = [];

  for (const rule of opts.config.events) {
    const unsub = client.watchContractEvent({
      address: opts.config.address as `0x${string}`,
      abi: opts.config.abi,
      eventName: rule.name,
      onLogs: (logs) => {
        for (const log of logs as DecodedLog[]) {
          const { severity, reason } = evaluateRule(rule, log);
          const alert = logToAlert(opts.config, rule, log, severity, reason);
          Promise.resolve(opts.onAlert(alert)).catch((e) => opts.onError?.(e));
        }
      },
      onError: (err) => opts.onError?.(err),
    });
    unsubs.push(unsub);
  }

  return {
    stop(): void {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // Ignore — stopping a watcher should never throw upstream.
        }
      }
    },
  };
}
