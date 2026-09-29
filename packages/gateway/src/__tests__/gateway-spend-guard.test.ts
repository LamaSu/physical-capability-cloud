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
const clock = () => t;
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
    expect(admitRelay({ apiKeyId: "a" }).ok).toBe(true);
    expect(admitRelay({ apiKeyId: "a" }).ok).toBe(true);
    expect(admitRelay({ apiKeyId: "a" })).toMatchObject({ status: 429, error: "relay_rate_limited" });
    expect(admitRelay({ apiKeyId: "b" }).ok).toBe(true);
    expect(admitRelay({ apiKeyId: "c" })).toMatchObject({ status: 503, error: "relay_daily_breaker" });
    expect(admitRelay({ apiKeyId: "d" })).toMatchObject({ status: 503 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
