import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BudgetMeter } from "../budget.js";
import type { PinnedPack } from "../pack.js";
import { PackPinMismatch } from "../pack.js";
import { readConfig, ConfigError, createAnthropicClient, buildServerOptions, formatStartupFailure } from "../main.js";

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
  PCC_HOSTED_TRUSTED_PROXY_HOPS: "0",
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
    expect(cfg.trustedProxyHops).toBe(0);
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
    "PCC_HOSTED_TRUSTED_PROXY_HOPS",
  ])("it refuses to start without %s", (name) => {
    expect(refusal({ ...ENV, [name]: undefined })).toBe(name);
    expect(refusal({ ...ENV, [name]: "  " })).toBe(name);
  });

  it("R2 (round 3): PCC_HOSTED_TRUSTED_PROXY_HOPS is a non-negative integer, at most 8", () => {
    expect(readConfig({ ...ENV, PCC_HOSTED_TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
    expect(readConfig({ ...ENV, PCC_HOSTED_TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops).toBe(1);
    expect(readConfig({ ...ENV, PCC_HOSTED_TRUSTED_PROXY_HOPS: "8" }).trustedProxyHops).toBe(8);
    for (const bad of ["-1", "9", "1.5", "two", "0x1", ""]) {
      expect(refusal({ ...ENV, PCC_HOSTED_TRUSTED_PROXY_HOPS: bad })).toBe("PCC_HOSTED_TRUSTED_PROXY_HOPS");
    }
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
    const sink = attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l));
    await sink(report);
    expect(seen).toEqual([{ url: "/api/feedback", auth: undefined, body: report }]);
    // Q6 round 2: a 201 with no sessionId echo (this fixture's "{}") is not accepted.
    expect(lines.some((l) => l.includes("attempt-report-not-accepted"))).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    await sink(report); // nothing listens now — a thrown fetch is "not accepted" too, never thrown onward
    expect(lines.filter((l) => l.includes("attempt-report-not-accepted"))).toHaveLength(1); // logged once per sink (process), not per call
  });
});

describe("the attempt sink only claims delivery when the receiver echoes the report's sessionId (Q6 round 2)", () => {
  // A real AttemptReport shape (session.ts), so the gateway's real route sees exactly
  // what the hosted agent sends. Report construction itself is unchanged by this fix.
  const REPORT = {
    kind: "attempt",
    contract: 1,
    sessionId: "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90",
    seq: 0,
    phase: "session",
    outcome: "ok",
    durationMs: 1234,
    summary: "session: ok",
    harness: { name: "pcc-hosted", version: "0.1.0", model: "claude-test" },
    pack: { version: "2.19.2", digest: `sha256:${"a".repeat(64)}` },
    tokens: { in: 10, out: 5, source: "metered" },
    consent: { transcript: false },
  } as never;

  it("Q6: through master's REAL feedbackRoutes, the report is NOT accepted (rewritten to kind:\"feedback\"; no sessionId echo)", async () => {
    // First choice per spec: the workspace import (`@pcc/gateway`) does not re-export
    // feedbackRoutes from its package entry point (checked directly: only createGateway,
    // db, sse, session, chain-client, escrow-client and agent-bridge symbols are exported).
    // Fallback per spec: the route module through a relative import. Verified importable
    // (hosted-agent's vitest.config.ts aliases every @pcc/* specifier straight to source,
    // the same aliasing packages/gateway/vitest.config.ts uses, so feedback.ts's own
    // `@pcc/store` import resolves without a prior build) — if this ever stops resolving,
    // this test fails loudly with a module-not-found error, which IS "stop and report".
    process.env.PCC_DB_PATH = "/mnt/sparkbulk/tmp/hosted-agent-q6-feedback/pcc.sqlite";
    const { feedbackRoutes } = await import("../../../gateway/src/routes/feedback.js");
    const { attemptSink } = await import("../main.js");
    const Fastify = (await import("fastify")).default;
    const app = Fastify({ logger: false });
    await app.register(feedbackRoutes);
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const port = (app.server.address() as { port: number }).port;
      const lines: string[] = [];
      await attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l))(REPORT);
      expect(lines.some((l) => l.includes("attempt-report-not-accepted"))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("Q6: a receiver that echoes sessionId (the shape of #458's answer) IS accepted — no attempt-report-not-accepted log", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.statusCode = 201;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "attempt", sessionId: REPORT.sessionId }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { attemptSink } = await import("../main.js");
      const port = (server.address() as { port: number }).port;
      const lines: string[] = [];
      await attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l))(REPORT);
      expect(lines.some((l) => l.includes("attempt-report-not-accepted"))).toBe(false);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("Q6: a 2xx whose sessionId does not match the report's is NOT accepted", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ kind: "attempt", sessionId: "some-other-session-id" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { attemptSink } = await import("../main.js");
      const port = (server.address() as { port: number }).port;
      const lines: string[] = [];
      await attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l))(REPORT);
      expect(lines.some((l) => l.includes("attempt-report-not-accepted"))).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("Q6: the not-accepted log carries no content — never the receiver's status, body or URL", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.statusCode = 403;
      res.end("forbidden: pcc_live_SyntheticCredential0007");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { attemptSink } = await import("../main.js");
      const port = (server.address() as { port: number }).port;
      const lines: string[] = [];
      await attemptSink(`http://127.0.0.1:${port}`, (l) => lines.push(l))(REPORT);
      const line = lines.find((l) => l.includes("attempt-report-not-accepted"))!;
      expect(JSON.parse(line)).toEqual({ event: "attempt-report-not-accepted" });
      expect(line).not.toContain("pcc_live_");
      expect(line).not.toContain("403");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
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

describe("a startup failure never logs an upstream-served pack field verbatim (Q1-B round 2)", () => {
  it("a PackPinMismatch on the served pack's own `version` field logs only the mismatch field, never the string", () => {
    // loadPinnedPack's "version" PackPinMismatch echoes `doc.version` — the
    // UPSTREAM-SERVED pack's own self-reported field — in its message. The
    // served pack sits at the same trust boundary as the MCP handshake's
    // serverInfo.version (Q1-B's original finding): a compromised or
    // misconfigured gateway can put anything there.
    const err = new PackPinMismatch("version", "served pcc_live_SyntheticPackVersion0005, pinned 2.19.2");
    const line = formatStartupFailure(err);
    expect(line).not.toContain("pcc_live_");
    expect(line).not.toContain("served pcc_live_SyntheticPackVersion0005");
    expect(JSON.parse(line)).toEqual({ event: "pack-pin-mismatch", field: "version" });
  });

  it("every PackPinMismatch field is covered, never the message", () => {
    for (const field of ["pin", "sha256", "encoding", "version", "shape"] as const) {
      const line = formatStartupFailure(new PackPinMismatch(field, "detail with pcc_live_SyntheticCredential0006"));
      expect(line).not.toContain("pcc_live_");
      expect(JSON.parse(line)).toEqual({ event: "pack-pin-mismatch", field });
    }
  });

  it("any other startup error still logs its message (operator-set config, never upstream- or caller-derived)", () => {
    const line = formatStartupFailure(new ConfigError("PCC_HOSTED_GATEWAY_BASE", "is not a URL"));
    expect(line).toContain("PCC_HOSTED_GATEWAY_BASE");
    expect(line).toContain("is not a URL");
  });

  it("a non-Error throw is stringified, not thrown again", () => {
    expect(() => formatStartupFailure("plain string failure")).not.toThrow();
    expect(formatStartupFailure("plain string failure")).toContain("plain string failure");
  });
});

describe("R4 (round 3, check only): pack.ts fetch errors carry no upstream text", () => {
  it("fetchBytes' HTTP-failure message holds only the operator's own URL and a numeric status — never statusText, the body, or a redirect location", async () => {
    const http = await import("node:http");
    const { fetchBytes } = await import("../main.js");
    const server = http.createServer((req, res) => {
      res.statusCode = 502;
      // A malicious/compromised upstream controls ALL of these.
      res.statusMessage = "pcc_live_SyntheticUpstreamStatusText0009";
      res.setHeader("location", "https://attacker.example/pcc_live_SyntheticRedirect0010");
      res.end("pcc_live_SyntheticUpstreamBody0011");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/agent-package.json`;
      const err = await fetchBytes(url).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toBe(`the pack at ${url} answered 502`);
      expect(err!.message).not.toContain("pcc_live_SyntheticUpstreamStatusText0009");
      expect(err!.message).not.toContain("pcc_live_SyntheticUpstreamBody0011");
      expect(err!.message).not.toContain("attacker.example");
      // formatStartupFailure passes a plain Error's message through (it is not a
      // PackPinMismatch); confirmed here that doing so is still safe for THIS message.
      expect(formatStartupFailure(err)).toBe(err!.message);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("every PackPinMismatch case — including ones built from the served pack's own bytes (sha256) or JSON (version, a tool name) — already gets category-only treatment", async () => {
    const { PackPinMismatch } = await import("../pack.js");
    for (const field of ["pin", "sha256", "encoding", "version", "shape"] as const) {
      const err = new PackPinMismatch(field, `detail embedding a served value: pcc_live_SyntheticServedValue0012 (${field})`);
      const line = formatStartupFailure(err);
      expect(line).not.toContain("pcc_live_SyntheticServedValue0012");
      expect(JSON.parse(line)).toEqual({ event: "pack-pin-mismatch", field });
    }
  });
});
