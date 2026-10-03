/**
 * N46 spend guard, unit level: configuration (fail closed), amounts, buckets,
 * the UTC day, alerts, and the faucet and relay windows. The route-level proof
 * that every gateway-paid path goes through it is gateway-spend-caps.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetGatewaySpendGuardForTests,
  admitFaucetDrip,
  admitGatewaySpend,
  gatewayPaymentsGate,
  admitRelay,
  checkGatewaySpend,
  GATEWAY_SPEND_REFUSED_PREFIX,
  GatewaySpendRefusedError,
  isTestnetNetwork,
  requestCaller,
} from "../services/gateway-spend-guard.js";

const ENV_KEYS = [
  "PCC_NETWORK",
  "PCC_GATEWAY_PAYS_ENABLED",
  "PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD",
  "PCC_GATEWAY_PAYS_MAX_PER_PRINCIPAL_DAY_USD",
  "PCC_GATEWAY_PAYS_MAX_PER_KEY_DAY_USD",
  "PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD",
  "PCC_FAUCET_MAX_PER_CALL",
  "PCC_FAUCET_MAX_PER_WALLET_DAY",
  "PCC_FAUCET_MAX_CALLS_PER_KEY_HOUR",
  "PCC_RELAY_MAX_PER_KEY_HOUR",
  "PCC_RELAY_MAX_GLOBAL_DAY",
] as const;
const saved: Record<string, string | undefined> = {};

let t = Date.UTC(2026, 8, 29, 12, 0, 0);
// The guard reads its clock ONCE per call (rule 3 on its ledger). Every read is
// counted, and a test may queue readings that are served BEFORE `t`, so that a
// single call straddles a UTC midnight.
let clockReads = 0;
let queuedReads: number[] = [];
const clock = () => {
  clockReads += 1;
  return queuedReads.length > 0 ? queuedReads.shift()! : t;
};
const usd = (n: number) => BigInt(Math.round(n * 1_000_000));
const spend = (principal: string, amount: number, apiKeyId?: string) =>
  admitGatewaySpend({ spender: { action: "commit", principal, apiKeyId }, amountMicro: usd(amount) });
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  t = Date.UTC(2026, 8, 29, 12, 0, 0);
  clockReads = 0;
  queuedReads = [];
  __resetGatewaySpendGuardForTests(clock);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  __resetGatewaySpendGuardForTests();
});

describe("configuration", () => {
  it("testnets are named as such; anything else, including an unknown network, is not a testnet", () => {
    for (const n of ["base-sepolia", "sepolia", "flow-evm-testnet", "localhost", " Base-Sepolia "]) {
      expect(isTestnetNetwork(n), n).toBe(true);
    }
    for (const n of ["base", "ethereum", "mainnet", "optimism", "", "basesep"]) {
      expect(isTestnetNetwork(n), n).toBe(false);
    }
  });

  it("[neg] the kill switch defaults OFF on a mainnet and ON on a testnet; an unreadable switch fails closed", () => {
    process.env.PCC_NETWORK = "base";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(1) })).toMatchObject({
      ok: false,
      status: 503,
      error: "gateway_pays_disabled",
    });
    process.env.PCC_GATEWAY_PAYS_ENABLED = "true";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(1) }).ok).toBe(true);
    process.env.PCC_NETWORK = "base-sepolia";
    for (const off of ["false", "0", "off", "OFF"]) {
      process.env.PCC_GATEWAY_PAYS_ENABLED = off;
      expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(1) })).toMatchObject({ status: 503, error: "gateway_pays_disabled" });
    }
    process.env.PCC_GATEWAY_PAYS_ENABLED = "maybe";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(1) })).toMatchObject({ status: 503, error: "gateway_pays_misconfigured" });
  });

  it("[neg] a mainnet that is switched on uses the smaller mainnet defaults ($10 per action)", () => {
    process.env.PCC_NETWORK = "base";
    process.env.PCC_GATEWAY_PAYS_ENABLED = "true";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(10) }).ok).toBe(true);
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(10.01) })).toMatchObject({ status: 402 });
  });

  it("[neg] a cap override must be a plain non-negative USD amount with at most 6 decimals; anything else fails closed", () => {
    for (const bad of ["abc", "-5", "1e3", "1.1234567", "0x10", "25 USD", "Infinity"]) {
      process.env.PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD = bad;
      expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: usd(1) }), bad).toMatchObject({
        status: 503,
        error: "gateway_pays_misconfigured",
      });
    }
    process.env.PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD = "0.000001";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: 1n }).ok).toBe(true);
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: 2n })).toMatchObject({ status: 402 });
    process.env.PCC_GATEWAY_PAYS_MAX_PER_ACTION_USD = "0";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: 1n })).toMatchObject({ status: 402 });
  });

  it("a misconfiguration alerts once per UTC day, not once per request", () => {
    process.env.PCC_GATEWAY_PAYS_ENABLED = "maybe";
    for (let i = 0; i < 3; i += 1) checkGatewaySpend({ spender: { action: "commit" }, amountMicro: usd(1) });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe("amounts and buckets", () => {
  it("[neg] a negative amount is refused", () => {
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "a" }, amountMicro: -1n })).toMatchObject({ status: 400 });
  });

  it("checking counts nothing; admitting counts at once", () => {
    for (let i = 0; i < 10; i += 1) checkGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(25) });
    for (let i = 0; i < 4; i += 1) expect(spend("p", 25).ok).toBe(true);
    expect(spend("p", 0.01)).toMatchObject({ status: 429, error: "gateway_pay_principal_daily_cap" });
  });

  it("[neg] a principal's bucket ignores case, width and surrounding spaces, so a respelled identity shares it", () => {
    // Four $25 spends under three spellings fill one $100 bucket.
    expect(spend("Alice@X.test", 25).ok).toBe(true);
    expect(spend("Alice@X.test", 25).ok).toBe(true);
    expect(spend("  alice@x.test ", 25).ok).toBe(true);
    expect(spend("ＡＬＩＣＥ@x.test", 25).ok).toBe(true);
    expect(spend("alice@x.test", 0.01)).toMatchObject({ status: 429, error: "gateway_pay_principal_daily_cap" });
  });

  it("[neg] a caller with no key is bucketed by principal, and an unknown caller shares the 'unknown' bucket", () => {
    for (let i = 0; i < 4; i += 1) expect(spend("", 25).ok).toBe(true);
    expect(spend("   ", 1)).toMatchObject({ status: 429 });
  });

  it("the daily totals are per UTC day: they reset at 00:00 UTC", () => {
    for (let i = 0; i < 4; i += 1) expect(spend("d", 25).ok).toBe(true);
    expect(spend("d", 1).ok).toBe(false);
    t = Date.UTC(2026, 8, 29, 23, 59, 59);
    expect(spend("d", 1).ok).toBe(false);
    t = Date.UTC(2026, 8, 30, 0, 0, 0);
    expect(spend("d", 25).ok).toBe(true);
  });

  it("[neg] the global breaker trips for everyone and alerts once per UTC day", () => {
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";
    expect(spend("g1", 25).ok).toBe(true);
    expect(spend("g2", 25).ok).toBe(true);
    expect(spend("g3", 1)).toMatchObject({ status: 503, error: "gateway_pays_daily_breaker" });
    expect(spend("g4", 1)).toMatchObject({ status: 503, error: "gateway_pays_daily_breaker" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    t = Date.UTC(2026, 8, 30, 1, 0, 0);
    expect(spend("g5", 25).ok).toBe(true);
    expect(spend("g6", 25).ok).toBe(true);
    expect(spend("g7", 1).ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("the refusal error carries the status and the code, and its message says it came before any chain call", () => {
    const refusal = spend("r", 26);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    const err = new GatewaySpendRefusedError(refusal);
    expect(err.status).toBe(402);
    expect(err.code).toBe("gateway_pay_over_action_cap");
    expect(err.message.startsWith(GATEWAY_SPEND_REFUSED_PREFIX)).toBe(true);
  });

  it("requestCaller reads only what apiGate set: a key's id and operatorId, or a SIWE session's userId", () => {
    expect(requestCaller({ apiKeyId: "k1", operatorId: "op@x.test", userId: "op@x.test" })).toEqual({ principal: "op@x.test", apiKeyId: "k1" });
    expect(requestCaller({ userId: "0xabc" })).toEqual({ principal: "0xabc", apiKeyId: undefined });
    expect(requestCaller({ body: { principal: "spoof" }, headers: { "x-operator": "spoof" } })).toEqual({ principal: undefined, apiKeyId: undefined });
  });
});

describe("faucet and relay throttles", () => {
  const drip = (wallet: string, amount: number, apiKeyId = "k") => admitFaucetDrip({ wallet, amount, spender: { apiKeyId } });

  it("[neg] a drip must be a whole number from 1 to 100", () => {
    for (const bad of [0, -1, 1.5, 101, Number.NaN]) expect(drip("0xw", bad), String(bad)).toMatchObject({ status: 400 });
    expect(drip("0xw", 100).ok).toBe(true);
  });

  it("[neg] a wallet's daily total ignores address case", () => {
    for (let i = 0; i < 5; i += 1) expect(drip("0xAbC", 100, `k${i}`).ok).toBe(true);
    expect(drip("0xabc", 1, "k9")).toMatchObject({ status: 429, error: "faucet_wallet_daily_cap" });
  });

  it("the per-caller hourly count is a sliding hour", () => {
    for (let i = 0; i < 5; i += 1) expect(drip(`0xw${i}`, 1).ok).toBe(true);
    expect(drip("0xw5", 1)).toMatchObject({ status: 429, error: "faucet_rate_limited" });
    t += 3_600_000;
    expect(drip("0xw6", 1).ok).toBe(true);
  });

  it("[neg] the faucet is off on a mainnet, and a bad faucet setting fails closed", () => {
    process.env.PCC_NETWORK = "base";
    expect(drip("0xw", 1)).toMatchObject({ status: 503, error: "faucet_disabled" });
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_FAUCET_MAX_PER_CALL = "lots";
    expect(drip("0xw", 1)).toMatchObject({ status: 503, error: "faucet_misconfigured" });
  });

  it("[neg] relays: a per-caller hourly count and a global daily breaker that alerts once", () => {
    process.env.PCC_RELAY_MAX_PER_KEY_HOUR = "2";
    process.env.PCC_RELAY_MAX_GLOBAL_DAY = "3";
    // Distinct callers each carry their own principal (a real API key always does).
    expect(admitRelay({ principal: "pa", apiKeyId: "a" }).ok).toBe(true);
    expect(admitRelay({ principal: "pa", apiKeyId: "a" }).ok).toBe(true);
    expect(admitRelay({ principal: "pa", apiKeyId: "a" })).toMatchObject({ status: 429, error: "relay_rate_limited" });
    expect(admitRelay({ principal: "pb", apiKeyId: "b" }).ok).toBe(true);
    expect(admitRelay({ principal: "pc", apiKeyId: "c" })).toMatchObject({ status: 503, error: "relay_daily_breaker" });
    expect(admitRelay({ principal: "pd", apiKeyId: "d" })).toMatchObject({ status: 503 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});


/**
 * astra pack 103: the four fail-open defects. Kill switch/config now gate the
 * faucet and relay too; a present-but-blank value fails closed; the hourly count
 * binds the principal as well as the key; a backward clock step is refused.
 */
describe("pack 103 fail-closed fixes", () => {
  it("[neg] F1: the kill switch stops the faucet and the relay", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_GATEWAY_PAYS_ENABLED = "false";
    expect(admitFaucetDrip({ wallet: "0xw", amount: 1, spender: { apiKeyId: "k" } })).toMatchObject({ status: 503, error: "gateway_pays_disabled" });
    process.env.PCC_PGTR_FORWARDER_ADDRESS = "0x1"; process.env.PCC_PGTR_RELAYER_KEY = "0x2";
    expect(admitRelay({ principal: "p", apiKeyId: "k" })).toMatchObject({ status: 503, error: "gateway_pays_disabled" });
  });

  it("[neg] F2: a present-but-blank config fails closed, it does not restore the default", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = " ";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(1) })).toMatchObject({ status: 503, error: "gateway_pays_misconfigured" });
    delete process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD;
    process.env.PCC_GATEWAY_PAYS_ENABLED = " ";
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(1) })).toMatchObject({ status: 503, error: "gateway_pays_misconfigured" });
    delete process.env.PCC_GATEWAY_PAYS_ENABLED;
    process.env.PCC_RELAY_MAX_PER_KEY_HOUR = " ";
    process.env.PCC_PGTR_FORWARDER_ADDRESS = "0x1"; process.env.PCC_PGTR_RELAYER_KEY = "0x2";
    expect(admitRelay({ principal: "p", apiKeyId: "k" })).toMatchObject({ status: 503, error: "relay_misconfigured" });
  });

  it("[neg] F3: one principal cannot multiply the faucet hourly count by rotating keys", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_FAUCET_MAX_CALLS_PER_KEY_HOUR = "5";
    for (let i = 0; i < 5; i += 1) {
      expect(admitFaucetDrip({ wallet: `0xw${i}`, amount: 1, spender: { principal: "victim", apiKeyId: `k${i}` } }).ok, `call ${i}`).toBe(true);
    }
    // A sixth call, same principal, a SIXTH key: refused on the principal bucket.
    expect(admitFaucetDrip({ wallet: "0xw6", amount: 1, spender: { principal: "victim", apiKeyId: "k6" } })).toMatchObject({ status: 429, error: "faucet_rate_limited" });
  });

  // astra pack 103b Q4: the relay's counterpart of the faucet test above. The relay
  // has the same two-bucket rule, but only the faucet's was ever tested with one
  // principal and many keys (every relay test gives each key its own principal, so
  // either bucket alone refuses them and the principal bucket is never isolated).
  it("[neg] F3: one principal cannot multiply the relay hourly count by rotating keys", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_RELAY_MAX_PER_KEY_HOUR = "5";
    for (let i = 0; i < 5; i += 1) {
      expect(admitRelay({ principal: "victim", apiKeyId: `k${i}` }).ok, `relay ${i}`).toBe(true);
    }
    // A sixth relay, same principal, a SIXTH key: refused on the principal bucket.
    expect(admitRelay({ principal: "victim", apiKeyId: "k6" })).toMatchObject({ status: 429, error: "relay_rate_limited" });
    // The bucket is the principal's own: another principal is not throttled by it.
    expect(admitRelay({ principal: "bystander", apiKeyId: "k7" }).ok).toBe(true);
  });

  it("gatewayPaymentsGate: ok on an enabled testnet, refuses when disabled/misconfigured/regressed, and counts nothing", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    expect(gatewayPaymentsGate().ok).toBe(true);
    // It must NOT consume any allowance (deferred funding was already admitted at creation).
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";
    for (let i = 0; i < 100; i += 1) expect(gatewayPaymentsGate().ok).toBe(true);
    expect(admitGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(25) }).ok).toBe(true);
    delete process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD;
    process.env.PCC_GATEWAY_PAYS_ENABLED = "false";
    expect(gatewayPaymentsGate()).toMatchObject({ status: 503, error: "gateway_pays_disabled" });
    process.env.PCC_GATEWAY_PAYS_ENABLED = " ";
    expect(gatewayPaymentsGate()).toMatchObject({ status: 503, error: "gateway_pays_misconfigured" });
    delete process.env.PCC_GATEWAY_PAYS_ENABLED;

    // astra pack 103b Q4: the clock really goes backward. An ADMISSION on the next
    // day moves the clock's high-water mark to D+1 (the gate itself never does);
    // the clock then returns to D, and the gate must refuse while enabled and valid.
    t += 86_400_000;
    expect(admitGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(1) }).ok).toBe(true);
    t -= 86_400_000;
    expect(gatewayPaymentsGate()).toMatchObject({ status: 503, error: "gateway_pays_clock_regressed" });
    // It recovers once the clock has caught up with the furthest day seen.
    t += 86_400_000;
    expect(gatewayPaymentsGate().ok).toBe(true);
  });

  it("[neg] F4: a backward clock step across a UTC day is refused (no allowance replenish)", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";
    t = Date.UTC(2026, 8, 30, 12, 0, 0);
    expect(admitGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(25) }).ok).toBe(true);
    t = Date.UTC(2026, 8, 31, 12, 0, 0); // forward a day
    expect(admitGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(25) }).ok).toBe(true);
    t = Date.UTC(2026, 8, 30, 12, 0, 0); // clock goes BACKWARD
    expect(admitGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(25) })).toMatchObject({ status: 503, error: "gateway_pays_clock_regressed" });
  });
});

/**
 * astra pack 103b, F4 (HIGH): the clock's high-water mark protected only the
 * ADMISSION path, but a PREFLIGHT (checkGatewaySpend) also pruned the day ledger,
 * so a preflight at another day erased counted spending without moving the mark.
 */
describe("pack 103b F4: a preflight must not erase counted spending", () => {
  it("[neg] F4: a preflight at the NEXT UTC day, then back to day D, must not replenish D's allowance (astra's repro, verbatim)", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";

    expect(spend("p", 25).ok).toBe(true);
    expect(spend("p", 25).ok).toBe(true);
    expect(spend("p", 1).ok).toBe(false);

    t += 86_400_000;
    expect(checkGatewaySpend({
      spender: { action: "commit", principal: "p" },
      amountMicro: usd(1),
    }).ok).toBe(true);

    t -= 86_400_000;
    expect(spend("p", 1).ok).toBe(false); // astra: "currently returns true" on ee6e36bc; now refused, D's $50 is still counted.
  });

  it("[neg] F4: a preflight at the PREVIOUS UTC day, then back to day D, must not replenish D's allowance (the backward counterpart)", () => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";

    expect(spend("p", 25).ok).toBe(true);
    expect(spend("p", 25).ok).toBe(true);
    expect(spend("p", 1).ok).toBe(false);

    t -= 86_400_000;
    // A day BEFORE the furthest day an admission saw is a regressed clock: the preflight refuses it, read-only.
    expect(checkGatewaySpend({ spender: { action: "commit", principal: "p" }, amountMicro: usd(1) })).toMatchObject({
      status: 503,
      error: "gateway_pays_clock_regressed",
    });

    t += 86_400_000;
    // Refused for the right reason: D's $50 is still counted (the breaker), not a poisoned clock mark.
    expect(spend("p", 1)).toMatchObject({ status: 503, error: "gateway_pays_daily_breaker" });
  });
});

/**
 * astra pack 103b, F4: the three rules the fix rests on (the comment on maxDaySeen
 * in the guard states them). One test per rule and per path, so a regression names
 * the rule it broke:
 *   1. only an ADMISSION changes the ledger or the clock's high-water mark, and it
 *      validates its day BEFORE it prunes;
 *   2. a PREFLIGHT (checkGatewaySpend, gatewayPaymentsGate) is read-only;
 *   3. every entry point reads the clock ONCE and uses that one instant throughout.
 */
describe("pack 103b F4: the rules behind the fix", () => {
  const DAY = 86_400_000;
  const lateD = Date.UTC(2026, 8, 29, 23, 59, 59, 999); // the last millisecond of the harness's day D
  const earlyNext = Date.UTC(2026, 8, 30, 0, 0, 0, 0); // the first millisecond of day D+1
  const check = (principal = "p", amount = 1) =>
    checkGatewaySpend({ spender: { action: "commit", principal }, amountMicro: usd(amount) });
  /** How many times the guard read its clock while `fn` ran. */
  const clockReadsDuring = (fn: () => unknown): number => {
    const before = clockReads;
    fn();
    return clockReads - before;
  };

  it("[neg] rule 1: an admission refused for a regressed clock must not have pruned first (validate, then prune)", () => {
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";
    expect(spend("p", 25).ok).toBe(true);
    expect(spend("p", 25).ok).toBe(true);
    t -= DAY; // a regressed clock: day D-1 after day D
    expect(spend("p", 1)).toMatchObject({ status: 503, error: "gateway_pays_clock_regressed" });
    t += DAY; // back on D: the $50 counted there must still be counted
    expect(spend("p", 1)).toMatchObject({ status: 503, error: "gateway_pays_daily_breaker" });
  });

  it("[neg] rule 2: a preflight at another day does not move the clock's high-water mark", () => {
    for (let i = 0; i < 3; i += 1) expect(spend("p", 25).ok).toBe(true); // day D: $75 counted
    t += DAY;
    expect(check("p", 25).ok).toBe(true); // a forward preflight, on day D+1
    t -= DAY;
    // No ADMISSION has seen D+1, so D has not regressed: this is admitted, not refused as a regressed clock...
    expect(spend("p", 25).ok).toBe(true); // $100, the principal's whole day
    // ...and D's earlier $75 is still counted.
    expect(spend("p", 1)).toMatchObject({ status: 429, error: "gateway_pay_principal_daily_cap" });
  });

  it("[neg] rule 2: the gate does not move the clock's high-water mark either", () => {
    for (let i = 0; i < 3; i += 1) expect(spend("p", 25).ok).toBe(true); // day D: $75 counted
    t += DAY;
    expect(gatewayPaymentsGate().ok).toBe(true); // the gate, on day D+1
    t -= DAY;
    expect(gatewayPaymentsGate().ok).toBe(true); // no admission saw D+1: D has not regressed
    expect(spend("p", 25).ok).toBe(true); // admitted, not refused as a regressed clock
    expect(spend("p", 1)).toMatchObject({ status: 429, error: "gateway_pay_principal_daily_cap" });
  });

  it("[neg] rule 3: every admission and preflight reads the clock exactly once, whatever it decides", () => {
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";
    process.env.PCC_RELAY_MAX_GLOBAL_DAY = "1";
    const calls: Array<[string, () => unknown]> = [
      ["spend: admitted", () => spend("p", 25)],
      ["spend: admitted again", () => spend("p", 25)],
      ["spend: refused over the per-action cap", () => spend("p", 26)],
      ["spend: refused by the global breaker (raises its alert)", () => spend("p", 1)],
      ["preflight", () => check()],
      ["gate", () => gatewayPaymentsGate()],
      ["faucet: admitted", () => admitFaucetDrip({ wallet: "0xw", amount: 1, spender: { principal: "pf", apiKeyId: "kf" } })],
      ["faucet: refused, amount out of range", () => admitFaucetDrip({ wallet: "0xw", amount: 0, spender: { principal: "pf", apiKeyId: "kf" } })],
      ["relay: admitted", () => admitRelay({ principal: "pr", apiKeyId: "kr" })],
      ["relay: refused by the global breaker (raises its alert)", () => admitRelay({ principal: "pr", apiKeyId: "kr" })],
    ];
    for (const [label, call] of calls) expect(clockReadsDuring(call), label).toBe(1);
  });

  it("[neg] rule 3: a misconfiguration alert does not read the clock again", () => {
    process.env.PCC_GATEWAY_PAYS_ENABLED = "maybe";
    const calls: Array<[string, () => unknown]> = [
      ["spend", () => spend("p", 1)],
      ["preflight", () => check()],
      ["gate", () => gatewayPaymentsGate()],
      ["faucet", () => admitFaucetDrip({ wallet: "0xw", amount: 1, spender: { apiKeyId: "k" } })],
      ["relay", () => admitRelay({ principal: "p", apiKeyId: "k" })],
    ];
    for (const [label, call] of calls) {
      expect(clockReadsDuring(call), label).toBe(1);
      expect(call(), label).toMatchObject({ status: 503, error: "gateway_pays_misconfigured" });
    }
  });

  it("[neg] rule 3: a UTC midnight crossed inside an admission cannot split its check from its record", () => {
    process.env.PCC_GATEWAY_PAYS_MAX_GLOBAL_DAY_USD = "50";
    // The next call's FIRST clock read is the last millisecond of day D; every later
    // read in that call is the first millisecond of day D+1.
    const straddle = () => {
      t = earlyNext;
      queuedReads = [lateD];
    };
    t = lateD;
    expect(spend("p", 25).ok).toBe(true);
    // Checked on D ($25 + $25 fits $50) and recorded under D. A second read would
    // check it on D+1 or record it under D+1.
    straddle();
    expect(spend("p", 25).ok).toBe(true);
    // D is full. A straddling call is still judged on D, not admitted on D+1's empty ledger...
    straddle();
    expect(spend("p", 1)).toMatchObject({ status: 503, error: "gateway_pays_daily_breaker" });
    // ...and neither pruned D nor moved the mark past it: D's $50 still count.
    t = lateD;
    expect(spend("p", 1)).toMatchObject({ status: 503, error: "gateway_pays_daily_breaker" });
  });

  it("[neg] rule 3: a UTC midnight crossed inside a faucet drip cannot split its check from its record", () => {
    t = earlyNext;
    queuedReads = [lateD];
    // Checked and recorded on day D (wallet 0xw: 100 of its 500).
    expect(admitFaucetDrip({ wallet: "0xw", amount: 100, spender: { principal: "p0", apiKeyId: "k0" } }).ok).toBe(true);
    t = lateD;
    for (let i = 1; i < 5; i += 1) {
      expect(admitFaucetDrip({ wallet: "0xw", amount: 100, spender: { principal: `p${i}`, apiKeyId: `k${i}` } }).ok, `drip ${i}`).toBe(true);
    }
    // Day D's wallet total is 500, the straddling drip included: one more is refused.
    expect(admitFaucetDrip({ wallet: "0xw", amount: 1, spender: { principal: "p9", apiKeyId: "k9" } })).toMatchObject({
      status: 429,
      error: "faucet_wallet_daily_cap",
    });
  });

  it("[neg] rule 1: the faucet and the relay refuse a regressed day, as the spend admission does", () => {
    process.env.PCC_RELAY_MAX_GLOBAL_DAY = "1";
    // Day D: wallet 0xw takes its whole 500, and the relay's one daily slot is used.
    for (let i = 0; i < 5; i += 1) {
      expect(admitFaucetDrip({ wallet: "0xw", amount: 100, spender: { principal: `p${i}`, apiKeyId: `k${i}` } }).ok).toBe(true);
    }
    expect(admitRelay({ principal: "pr", apiKeyId: "kr" }).ok).toBe(true);
    // Day D+1: both admit, which moves the clock's high-water mark to D+1.
    t += DAY;
    expect(admitFaucetDrip({ wallet: "0xz", amount: 1, spender: { principal: "pz", apiKeyId: "kz" } }).ok).toBe(true);
    expect(admitRelay({ principal: "pr2", apiKeyId: "kr2" }).ok).toBe(true);
    // Back on D: refused as a regressed clock, not merely by D's caps (still full).
    t -= DAY;
    expect(admitFaucetDrip({ wallet: "0xw", amount: 1, spender: { principal: "pq", apiKeyId: "kq" } })).toMatchObject({
      status: 503,
      error: "gateway_pays_clock_regressed",
    });
    expect(admitRelay({ principal: "pr3", apiKeyId: "kr3" })).toMatchObject({ status: 503, error: "gateway_pays_clock_regressed" });
  });
});

// astra pack 103c, NEW HIGH: a later admission's prune dropped the previous UTC day's hourly records, and a
// clock rollback WITHIN the later day (which the day-level high-water mark cannot see) then evaluated an hour
// that should have contained them: the relay's and the faucet's gateway-funded hourly throttles reset.
describe("hourly throttles survive an intra-day clock rollback after a prune (astra pack 103c)", () => {
  const D_2350 = Date.UTC(2026, 8, 29, 23, 50, 0);
  const D1_0101 = Date.UTC(2026, 8, 30, 1, 1, 0);
  const D1_0010 = Date.UTC(2026, 8, 30, 0, 10, 0);
  beforeEach(() => {
    process.env.PCC_NETWORK = "base-sepolia";
    process.env.PCC_GATEWAY_PAYS_ENABLED = "true";
  });

  it("[neg] astra's reproduction (relay): five relays at D 23:50, a prune at D+1 01:01, then D+1 00:10 must still refuse the sixth", () => {
    process.env.PCC_RELAY_MAX_PER_KEY_HOUR = "5";
    process.env.PCC_RELAY_MAX_GLOBAL_DAY = "200";
    t = D_2350;
    for (let i = 0; i < 5; i++) expect(admitRelay({ principal: "p", apiKeyId: "kp" }).ok, `relay ${i}`).toBe(true);
    expect(admitRelay({ principal: "p", apiKeyId: "kp" })).toMatchObject({ status: 429, error: "relay_rate_limited" }); // control: the hour is full
    t = D1_0101;
    expect(admitRelay({ principal: "q", apiKeyId: "kq" }).ok).toBe(true); // another caller's admission prunes
    t = D1_0010; // back WITHIN D+1: the day-level mark sees no regression
    expect(admitRelay({ principal: "p", apiKeyId: "kp" })).toMatchObject({ status: 429, error: "relay_rate_limited" });
  });

  it("[neg] the same through the faucet: five drips at D 23:50, a prune at D+1 01:01, then D+1 00:10 must still refuse the sixth", () => {
    process.env.PCC_FAUCET_MAX_CALLS_PER_KEY_HOUR = "5";
    t = D_2350;
    for (let i = 0; i < 5; i++) {
      expect(admitFaucetDrip({ wallet: `0xwp${i}`, amount: 1, spender: { apiKeyId: "kp" } }).ok, `drip ${i}`).toBe(true);
    }
    expect(admitFaucetDrip({ wallet: "0xwp5", amount: 1, spender: { apiKeyId: "kp" } })).toMatchObject({ status: 429, error: "faucet_rate_limited" });
    t = D1_0101;
    expect(admitFaucetDrip({ wallet: "0xwq", amount: 1, spender: { apiKeyId: "kq" } }).ok).toBe(true);
    t = D1_0010;
    expect(admitFaucetDrip({ wallet: "0xwp6", amount: 1, spender: { apiKeyId: "kp" } })).toMatchObject({ status: 429, error: "faucet_rate_limited" });
  });

  it("rule 3 (relay, astra pack 103c Q3): a UTC midnight crossed inside a relay admission cannot split its check from its record", () => {
    process.env.PCC_RELAY_MAX_GLOBAL_DAY = "1";
    const lateD = Date.UTC(2026, 8, 29, 23, 59, 59, 999);
    const earlyNext = Date.UTC(2026, 8, 30, 0, 0, 0, 0);
    t = lateD;
    expect(admitRelay({ principal: "pa", apiKeyId: "ka" }).ok).toBe(true); // D's only global slot
    // The next call's FIRST clock read is D's last millisecond; any later read would be D+1.
    t = earlyNext;
    queuedReads = [lateD];
    expect(admitRelay({ principal: "pb", apiKeyId: "kb" })).toMatchObject({ status: 503, error: "relay_daily_breaker" });
    // Checked AND refused on D: nothing was recorded under D+1, whose one slot is still free.
    expect(admitRelay({ principal: "pc", apiKeyId: "kc" }).ok).toBe(true);
    expect(admitRelay({ principal: "pd", apiKeyId: "kd" })).toMatchObject({ status: 503, error: "relay_daily_breaker" });
  });
});
