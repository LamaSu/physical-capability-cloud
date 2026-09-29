import { describe, it, expect } from "vitest";
import { readConfig, ConfigError } from "../main.js";

const ENV: NodeJS.ProcessEnv = {
  PCC_HOSTED_GATEWAY_BASE: "http://127.0.0.1:4310",
  PCC_HOSTED_PACK_VERSION: "2.19.2",
  PCC_HOSTED_PACK_SHA256: "c".repeat(64),
  PCC_HOSTED_MODEL: "claude-sonnet-5",
  PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK: "3",
  PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK: "15",
  PCC_HOSTED_CAP_SESSION_USD: "2",
  PCC_HOSTED_CAP_USER_DAY_USD: "5",
  PCC_HOSTED_CAP_MONTH_USD: "200",
  PCC_HOSTED_SPEND_DB: "/mnt/sparkbulk/tmp/hosted-spend.db",
};

function refusal(env: NodeJS.ProcessEnv): string | null {
  try {
    readConfig(env);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).variable;
  }
}

describe("the hosted agent's configuration", () => {
  it("reads a complete environment; L2 is off and the host is loopback by default", () => {
    const cfg = readConfig(ENV);
    expect(cfg.packUrl).toBe("http://127.0.0.1:4310/agent-package.json");
    expect(cfg.price).toEqual({ input: 3_000, output: 15_000 });
    expect(cfg.caps).toEqual({ perSession: 2_000_000_000, perUserDay: 5_000_000_000, perMonth: 200_000_000_000 });
    expect(cfg.l2Enabled).toBe(false);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(4420);
  });

  it.each([
    "PCC_HOSTED_GATEWAY_BASE",
    "PCC_HOSTED_PACK_VERSION",
    "PCC_HOSTED_PACK_SHA256",
    "PCC_HOSTED_MODEL",
    "PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK",
    "PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK",
    "PCC_HOSTED_CAP_SESSION_USD",
    "PCC_HOSTED_CAP_USER_DAY_USD",
    "PCC_HOSTED_CAP_MONTH_USD",
    "PCC_HOSTED_SPEND_DB",
  ])("it refuses to start without %s", (name) => {
    expect(refusal({ ...ENV, [name]: undefined })).toBe(name);
    expect(refusal({ ...ENV, [name]: "  " })).toBe(name);
  });

  it("dollar amounts are exact decimals, never floats", () => {
    expect(readConfig({ ...ENV, PCC_HOSTED_CAP_SESSION_USD: "0.50" }).caps.perSession).toBe(500_000_000);
    expect(readConfig({ ...ENV, PCC_HOSTED_CAP_SESSION_USD: "0.000000001" }).caps.perSession).toBe(1);
    for (const bad of ["-1", "1e3", "1.0000000001", "0x10", "two", "1,5"]) {
      expect(refusal({ ...ENV, PCC_HOSTED_CAP_SESSION_USD: bad })).toBe("PCC_HOSTED_CAP_SESSION_USD");
    }
  });

  it("a price must be a whole number of nano-USD per token", () => {
    expect(readConfig({ ...ENV, PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK: "0.25" }).price.input).toBe(250);
    expect(refusal({ ...ENV, PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK: "0.0001" })).toBe("PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK");
  });

  it("L2 is on only for exactly '1'; the pin, URL and port are validated", () => {
    expect(readConfig({ ...ENV, PCC_HOSTED_L2: "1" }).l2Enabled).toBe(true);
    expect(readConfig({ ...ENV, PCC_HOSTED_L2: "0" }).l2Enabled).toBe(false);
    expect(refusal({ ...ENV, PCC_HOSTED_L2: "yes" })).toBe("PCC_HOSTED_L2");
    expect(refusal({ ...ENV, PCC_HOSTED_PACK_SHA256: "C".repeat(64) })).toBe("PCC_HOSTED_PACK_SHA256");
    expect(refusal({ ...ENV, PCC_HOSTED_GATEWAY_BASE: "not a url" })).toBe("PCC_HOSTED_GATEWAY_BASE");
    expect(refusal({ ...ENV, PCC_HOSTED_PORT: "70000" })).toBe("PCC_HOSTED_PORT");
  });
});
