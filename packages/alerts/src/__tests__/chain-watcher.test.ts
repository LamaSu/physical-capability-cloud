/**
 * Tests for chain-watcher: whitelist matching, severity upgrade, log->alert mapping.
 *
 * Author: implementer-alpha
 */

import { describe, it, expect, vi } from "vitest";
import {
  startChainWatcher,
  evaluateRule,
  logToAlert,
  type ViemLikeClient,
  type DecodedLog,
} from "../chain-watcher.js";
import type { Alert } from "../types.js";
import type { ChainEventRule, ChainWatcherConfig } from "../config.js";

function makeConfig(): ChainWatcherConfig {
  return {
    label: "escrow",
    chain: "base-sepolia",
    rpcUrl: "https://sepolia.base.org",
    address: "0x10059efeeab1ddf013489e9597a3aec4480d95e1",
    abi: [],
    events: [],
  };
}

describe("evaluateRule", () => {
  it("returns onFire severity when no whitelist", () => {
    const rule: ChainEventRule = {
      name: "Released",
      onFire: "info",
      whitelistArg: "caller",
    };
    const result = evaluateRule(rule, { args: { caller: "0xabc" } });
    expect(result.severity).toBe("info");
    expect(result.reason).toBe("match");
  });

  it("keeps onFire severity when caller is in whitelist (case-insensitive)", () => {
    const rule: ChainEventRule = {
      name: "Released",
      onFire: "info",
      whitelist: ["0xABC123"],
      whitelistArg: "caller",
    };
    const result = evaluateRule(rule, { args: { caller: "0xabc123" } });
    expect(result.severity).toBe("info");
    expect(result.reason).toBe("match");
  });

  it("UPGRADES to critical when caller is NOT in whitelist", () => {
    const rule: ChainEventRule = {
      name: "Released",
      onFire: "info",
      whitelist: ["0xabc"],
      whitelistArg: "caller",
    };
    const result = evaluateRule(rule, { args: { caller: "0xdef" } });
    expect(result.severity).toBe("critical");
    expect(result.reason).toBe("whitelist-miss");
  });

  it("treats missing caller arg as critical when whitelist configured", () => {
    const rule: ChainEventRule = {
      name: "Released",
      onFire: "info",
      whitelist: ["0xabc"],
      whitelistArg: "caller",
    };
    const result = evaluateRule(rule, { args: {} });
    expect(result.severity).toBe("critical");
    expect(result.reason).toBe("whitelist-miss");
  });

  it("respects custom whitelistArg", () => {
    const rule: ChainEventRule = {
      name: "Transfer",
      onFire: "warning",
      whitelist: ["0xaaa"],
      whitelistArg: "from",
    };
    const miss = evaluateRule(rule, { args: { from: "0xbbb" } });
    expect(miss.severity).toBe("critical");
    const match = evaluateRule(rule, { args: { from: "0xaaa" } });
    expect(match.severity).toBe("warning");
  });
});

describe("logToAlert", () => {
  it("stringifies bigint block numbers", () => {
    const cfg = makeConfig();
    const rule: ChainEventRule = { name: "Released", onFire: "info", whitelistArg: "caller" };
    const log: DecodedLog = {
      transactionHash: "0xdead",
      blockNumber: 123456789n,
      args: { caller: "0xabc", amount: 500n },
    };
    const alert = logToAlert(cfg, rule, log, "info", "match");
    expect(alert.source).toBe("chain-watcher");
    expect(alert.context?.blockNumber).toBe("123456789");
    expect(alert.context?.txHash).toBe("0xdead");
    expect(alert.title).toContain("chain event");
  });

  it("flags whitelist misses in the title", () => {
    const cfg = makeConfig();
    const rule: ChainEventRule = {
      name: "Released",
      onFire: "info",
      whitelist: ["0xabc"],
      whitelistArg: "caller",
    };
    const alert = logToAlert(
      cfg,
      rule,
      { args: { caller: "0xdef" } },
      "critical",
      "whitelist-miss",
    );
    expect(alert.title).toContain("UNEXPECTED CALLER");
    expect(alert.severity).toBe("critical");
  });
});

describe("startChainWatcher", () => {
  it("subscribes to each configured event and dispatches alerts", async () => {
    const received: Alert[] = [];
    const onLogsByEvent = new Map<string, (logs: unknown[]) => void>();
    const unsub = vi.fn();
    const client: ViemLikeClient = {
      watchContractEvent: (args) => {
        onLogsByEvent.set(args.eventName, args.onLogs);
        return unsub;
      },
    };

    const cfg: ChainWatcherConfig = {
      ...makeConfig(),
      events: [
        { name: "Released", onFire: "info", whitelistArg: "caller" },
        { name: "Disputed", onFire: "warning", whitelistArg: "caller" },
      ],
    };

    const handle = startChainWatcher({
      config: cfg,
      clientFactory: () => client,
      onAlert: (a) => {
        received.push(a);
      },
    });

    // Inject a Released event.
    onLogsByEvent.get("Released")!([
      { transactionHash: "0x1", blockNumber: 1n, args: { caller: "0xabc" } },
    ]);
    // Inject a Disputed event.
    onLogsByEvent.get("Disputed")!([
      { transactionHash: "0x2", blockNumber: 2n, args: { caller: "0xfff" } },
    ]);
    // Flush microtasks.
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(2);
    expect(received[0]!.severity).toBe("info");
    expect(received[0]!.context?.eventName).toBe("Released");
    expect(received[1]!.severity).toBe("warning");

    handle.stop();
    expect(unsub).toHaveBeenCalledTimes(2);
  });

  it("upgrades to critical on whitelist miss end-to-end", async () => {
    const received: Alert[] = [];
    let onLogs: ((logs: unknown[]) => void) | null = null;
    const client: ViemLikeClient = {
      watchContractEvent: (args) => {
        onLogs = args.onLogs;
        return () => {};
      },
    };

    const cfg: ChainWatcherConfig = {
      ...makeConfig(),
      events: [
        {
          name: "Released",
          onFire: "info",
          whitelist: ["0xOracleAddress"],
          whitelistArg: "caller",
        },
      ],
    };

    startChainWatcher({
      config: cfg,
      clientFactory: () => client,
      onAlert: (a) => received.push(a),
    });

    onLogs!([{ transactionHash: "0xbad", blockNumber: 99n, args: { caller: "0xATTACKER" } }]);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    expect(received[0]!.severity).toBe("critical");
    expect(received[0]!.title).toContain("UNEXPECTED CALLER");
  });
});
