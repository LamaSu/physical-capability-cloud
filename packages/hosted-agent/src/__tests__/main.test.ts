import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BudgetMeter } from "../budget.js";
import type { PinnedPack } from "../pack.js";
import { readConfig, ConfigError, createAnthropicClient, buildServerOptions } from "../main.js";

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

describe("the attempt sink", () => {
  it("POSTs the report to the public /api/feedback with no credential; a failure never throws", async () => {
    const http = await import("node:http");
    const { attemptSink } = await import("../main.js");
    const seen: Array<{ url: string; auth: string | undefined; body: unknown }> = [];
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.statusCode = 201;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const lines: string[] = [];
    const report = { kind: "attempt", contract: 1, sessionId: "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90", seq: 0 } as never;
    await attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l))(report);
    expect(seen).toEqual([{ url: "/api/feedback", auth: undefined, body: report }]);
    await new Promise<void>((r) => server.close(() => r()));
    await attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l))(report); // nothing listens now
    expect(lines.some((l) => l.includes("attemptNotSent"))).toBe(true);
  });
});

describe("the model client spends only what was reserved (Q4-B)", () => {
  const PACK: PinnedPack = { version: "2.19.2", sha256: "c".repeat(64), systemPrompt: "P", tools: [] };
  const meter = () => new BudgetMeter(new Database(":memory:"), { perSession: 1, perUserDay: 1, perMonth: 1 }, () => new Date(), () => false);

  it("Q4-B: the Anthropic client is built with maxRetries 0: an SDK retry is a second billed attempt behind one reservation", () => {
    expect((createAnthropicClient() as unknown as { maxRetries: number }).maxRetries).toBe(0);
  });

  it("Q4-A: the service resolves a signed-in key through the gateway's /api/agent/me", async () => {
    const http = await import("node:http");
    const seen: Array<{ url: string | undefined; auth: string | undefined }> = [];
    const gateway = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, identity: { operator: "operator-7" } }));
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
    const port = (gateway.address() as { port: number }).port;
    try {
      const cfg = readConfig({ ...ENV, PCC_HOSTED_GATEWAY_BASE: `http://127.0.0.1:${port}` });
      const opts = buildServerOptions(cfg, PACK, meter(), () => undefined);
      expect(await opts.resolvePrincipal("pcc_live_SyntheticKey0001")).toEqual({ operatorId: "operator-7" });
      expect(seen).toEqual([{ url: "/api/agent/me", auth: "Bearer pcc_live_SyntheticKey0001" }]);
    } finally {
      gateway.closeAllConnections();
      await new Promise<void>((r) => gateway.close(() => r()));
    }
  });

  it("Q4-B: the service's sessions use that client", () => {
    const opts = buildServerOptions(readConfig(ENV), PACK, meter(), () => undefined);
    expect((opts.deps.anthropic as unknown as { maxRetries: number }).maxRetries).toBe(0);
  });
});
