import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BudgetMeter } from "../budget.js";
import type { PinnedPack } from "../pack.js";
import { PackPinMismatch } from "../pack.js";
import { readConfig, ConfigError, PackFetchFailed, createAnthropicClient, buildServerOptions, formatStartupFailure } from "../main.js";

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

  it("P1 (round 5, 239): a gateway base URL carrying userinfo is refused -- credentials never enter at fetch time", () => {
    expect(refusal({ ...ENV, PCC_HOSTED_GATEWAY_BASE: "http://user:pcc_live_opaqueSecret@127.0.0.1:4310" })).toBe("PCC_HOSTED_GATEWAY_BASE");
    expect(refusal({ ...ENV, PCC_HOSTED_GATEWAY_BASE: "http://justauser@127.0.0.1:4310" })).toBe("PCC_HOSTED_GATEWAY_BASE");
    expect(readConfig({ ...ENV, PCC_HOSTED_GATEWAY_BASE: "http://127.0.0.1:4310" }).gatewayBase).toBe("http://127.0.0.1:4310");
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
    process.env.PCC_DB_PATH = ":memory:"; // portable: no host path (a CI runner has no /mnt/sparkbulk)
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

  // Round 7 (243 F2): a config error is logged as its closed variable and problem code, never as text.
  it("a config error logs its variable and closed problem code, never a message", () => {
    expect(JSON.parse(formatStartupFailure(new ConfigError("PCC_HOSTED_GATEWAY_BASE", "not-a-url")))).toEqual({
      event: "config-error",
      variable: "PCC_HOSTED_GATEWAY_BASE",
      problem: "not-a-url",
    });
  });

  it("a non-Error throw is logged as the closed generic line, not stringified and not thrown again", () => {
    expect(() => formatStartupFailure("plain string failure")).not.toThrow();
    expect(JSON.parse(formatStartupFailure("plain string failure"))).toEqual({ event: "startup-failed", error: "other" });
  });
});

describe("R4 (round 3, check only): pack.ts fetch errors carry no upstream text", () => {
  it("fetchBytes' HTTP failure carries only the numeric status (round 7: not even the configured URL) — never statusText, the body, or a redirect location", async () => {
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
      expect(err!.message).toBe("the pack fetch answered 502");
      expect((err as unknown as { status: unknown }).status).toBe(502);
      expect(err!.message).not.toContain("pcc_live_SyntheticUpstreamStatusText0009");
      expect(err!.message).not.toContain("pcc_live_SyntheticUpstreamBody0011");
      expect(err!.message).not.toContain("attacker.example");
      // Round 7 (243 F2): the startup line carries the status as a closed field, never a message.
      expect(JSON.parse(formatStartupFailure(err))).toEqual({ event: "pack-fetch-failed", status: 502 });
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

/**
 * Round 7 (243 F2, HIGH): the startup-failure line is TOTAL and CLOSED. main().catch hands every
 * startup rejection to formatStartupFailure: a config error, a pack fetch or pin failure, the spend
 * database, the listener. None of their text is logged. Each becomes an event plus closed fields: the
 * variable and a problem code, the pin field, an HTTP status, or an operational error code.
 */
describe("round 7: every startup failure line is total and closed", () => {
  const MARK = "StartupFixture243";
  const VARIABLES = [
    "PCC_HOSTED_GATEWAY_BASE",
    "PCC_HOSTED_PACK_SHA256",
    "PCC_HOSTED_PORT",
    "PCC_HOSTED_L2",
    "PCC_HOSTED_TRUSTED_PROXY_HOPS",
    "PCC_HOSTED_PACK_VERSION",
    "PCC_HOSTED_MODEL",
    "PCC_HOSTED_PRICE_INPUT_USD_PER_MTOK",
    "PCC_HOSTED_PRICE_OUTPUT_USD_PER_MTOK",
    "PCC_HOSTED_CAP_SESSION_USD",
    "PCC_HOSTED_CAP_USER_DAY_USD",
    "PCC_HOSTED_CAP_MONTH_USD",
    "PCC_HOSTED_SPEND_DB",
  ];
  const PROBLEMS = ["required", "not-a-url", "userinfo", "not-sha256-hex", "not-a-port", "not-a-flag", "not-an-integer", "too-many-hops", "not-a-decimal", "too-large", "too-many-decimals"];
  const CATEGORIES = ["ConfigError", "PackMismatch", "PackPinMismatch", "BudgetStop", "TimeoutError", "AbortError", "TypeError", "Error", "other"];
  const CODES = [
    "EADDRINUSE",
    "EADDRNOTAVAIL",
    "EACCES",
    "EPERM",
    "ENOENT",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "SQLITE_CANTOPEN",
    "SQLITE_READONLY",
    "SQLITE_CORRUPT",
    "SQLITE_NOTADB",
    "SQLITE_BUSY",
    "SQLITE_FULL",
    "SQLITE_PERM",
  ];
  function expectClosedStartupLine(line: string): Record<string, unknown> {
    expect(line).not.toContain(MARK);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "event") expect(["startup-failed", "config-error", "pack-pin-mismatch", "pack-fetch-failed"]).toContain(value);
      else if (key === "error") expect(CATEGORIES).toContain(value);
      else if (key === "field") expect(["pin", "sha256", "encoding", "version", "shape"]).toContain(value);
      else if (key === "variable") expect(VARIABLES).toContain(value);
      else if (key === "problem") expect(PROBLEMS).toContain(value);
      else if (key === "status") expect(Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599).toBe(true);
      else if (key === "code" || key === "cause") expect(CODES).toContain(value);
      else expect.unreachable(`a startup line carries a key outside the closed set: ${key}`);
    }
    return parsed;
  }
  const boom = (): never => {
    throw new Error(`pcc_live_${MARK}`);
  };

  it("a plain Error's message never reaches the line", () => {
    expect(expectClosedStartupLine(formatStartupFailure(new Error(`pcc_live_${MARK}`)))).toEqual({ event: "startup-failed", error: "Error" });
  });

  it("a thrown string is closed too", () => {
    expect(expectClosedStartupLine(formatStartupFailure(`pcc_live_${MARK}`))).toEqual({ event: "startup-failed", error: "other" });
  });

  it.each([
    [
      "an Error whose message getter throws",
      () => {
        const e = new Error("x");
        Object.defineProperty(e, "message", { get: boom });
        return e;
      },
    ],
    ["a Proxy whose getPrototypeOf trap throws", () => new Proxy(new Error("x"), { getPrototypeOf: boom })],
    [
      "a revoked Proxy",
      () => {
        const r = Proxy.revocable({}, {});
        r.revoke();
        return r.proxy;
      },
    ],
    ["a ConfigError claimant with a secret in every field", () => new Proxy(Object.create(ConfigError.prototype) as object, { get: () => `pcc_live_${MARK}` })],
    ["a PackPinMismatch claimant with a secret in every field", () => new Proxy(Object.create(PackPinMismatch.prototype) as object, { get: () => `pcc_live_${MARK}` })],
    ["a PackFetchFailed claimant with a secret in every field", () => new Proxy(Object.create(PackFetchFailed.prototype) as object, { get: () => `pcc_live_${MARK}` })],
    ["an Error whose code is a secret", () => Object.assign(new Error("x"), { code: `pcc_live_${MARK}` })],
    ["an Error whose cause's code is a secret", () => new Error("x", { cause: { code: `pcc_live_${MARK}` } })],
    [
      "an Error whose code getter throws",
      () => {
        const e = new Error("x");
        Object.defineProperty(e, "code", { get: boom });
        return e;
      },
    ],
  ])("a hostile value (%s) never throws out of the formatter, and its line is closed", (_label, make) => {
    const value = make();
    let line = "";
    expect(() => {
      line = formatStartupFailure(value);
    }).not.toThrow();
    expectClosedStartupLine(line);
  });

  it("a pack fetch that fails logs its status, never the URL (an operator's pack URL may carry a token)", async () => {
    const http = await import("node:http");
    const { fetchBytes } = await import("../main.js");
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as { port: number }).port;
      const err = await fetchBytes(`http://127.0.0.1:${port}/agent-package.json?token=pcc_live_${MARK}`).then(
        () => null,
        (e: unknown) => e,
      );
      expect(expectClosedStartupLine(formatStartupFailure(err))).toEqual({ event: "pack-fetch-failed", status: 404 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("a misplaced secret in a config value is never echoed, by the error or by the line", async () => {
    const { main } = await import("../main.js");
    const err = await main({ ...ENV, PCC_HOSTED_CAP_SESSION_USD: `pcc_live_${MARK}` }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain(MARK);
    expect(expectClosedStartupLine(formatStartupFailure(err))).toEqual({ event: "config-error", variable: "PCC_HOSTED_CAP_SESSION_USD", problem: "not-a-decimal" });
  });

  it("a spend database that cannot open, and a port already in use, log a closed category and operational code", async () => {
    // Paths under the OS temp directory, which exists on every machine and CI runner.
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    // better-sqlite3 refuses a missing directory itself, with a plain TypeError and no code.
    let dirErr: unknown = null;
    try {
      new Database(join(tmpdir(), `no-such-dir-243-${process.pid}`, "spend.db"));
    } catch (e) {
      dirErr = e;
    }
    expect(expectClosedStartupLine(formatStartupFailure(dirErr))).toEqual({ event: "startup-failed", error: "TypeError" });
    // SQLite's own refusal carries its code.
    let dbErr: unknown = null;
    try {
      new Database(join(tmpdir(), `no-such-file-243-${process.pid}.db`), { fileMustExist: true });
    } catch (e) {
      dbErr = e;
    }
    expect(expectClosedStartupLine(formatStartupFailure(dbErr))).toEqual({ event: "startup-failed", error: "Error", code: "SQLITE_CANTOPEN" });

    const net = await import("node:net");
    const first = net.createServer();
    await new Promise<void>((r) => first.listen(0, "127.0.0.1", r));
    try {
      const port = (first.address() as { port: number }).port;
      const second = net.createServer();
      const listenErr = await new Promise<unknown>((r) => {
        second.once("error", r);
        second.listen(port, "127.0.0.1");
      });
      expect(expectClosedStartupLine(formatStartupFailure(listenErr))).toEqual({ event: "startup-failed", error: "Error", code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((r) => first.close(() => r()));
    }
  });

  it("243 F1 (the report sink's logger): the sink never rejects, even when its logger throws", async () => {
    const { attemptSink } = await import("../main.js");
    const sink = attemptSink("http://127.0.0.1:9", () => {
      throw Object.assign(new Error(`pcc_live_${MARK}`), { statusCode: 400 });
    });
    await expect(sink({ kind: "attempt", contract: 1, sessionId: "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90", seq: 0 } as never)).resolves.toBeUndefined();
  });
});

/**
 * Round 8 (246 MEDIUM): the attempt sink logs a closed projection of the report, never the report itself.
 * The report carries operator config the log has no need for (the model string, the pack version), so a
 * credential pasted into PCC_HOSTED_MODEL must not reach the log. The sink is also total: a report that
 * cannot be serialized (a throwing toJSON, a cycle, a bigint) never makes it reject.
 */
describe("round 8: the attempt sink's log line is closed, and the sink is total", () => {
  const MARK = "AttemptFixture246";
  const BASE = {
    kind: "attempt",
    contract: 1,
    sessionId: "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90",
    seq: 3,
    phase: "session",
    outcome: "failed",
    durationMs: 1234,
    summary: "session: failed",
    harness: { name: "pcc-hosted", version: "0.1.0", model: "claude-sonnet-5" },
    pack: { version: "2.19.1", digest: `sha256:${"b".repeat(64)}` },
    tokens: { in: 10, out: 5, source: "metered" },
    consent: { transcript: false },
  };
  const OUTCOMES = ["ok", "budget_stop", "failed"];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  function expectClosedAttemptLine(line: string): Record<string, unknown> {
    expect(line).not.toContain(MARK);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === "event") expect(["attempt-report", "attempt-report-not-accepted"]).toContain(value);
      else if (key === "outcome") expect(OUTCOMES).toContain(value);
      else if (key === "phase") expect(value).toBe("session");
      else if (key === "seq" || key === "tokensIn" || key === "tokensOut") expect(Number.isSafeInteger(value) && (value as number) >= 0).toBe(true);
      else if (key === "durationMs") expect(Number.isSafeInteger(value)).toBe(true);
      else if (key === "sessionId") expect(value).toMatch(UUID);
      else expect.unreachable(`an attempt line carries a key outside the closed set: ${key}`);
    }
    return parsed;
  }
  async function linesFor(report: unknown): Promise<string[]> {
    const { attemptSink } = await import("../main.js");
    const lines: string[] = [];
    // Port 9 refuses at once: the send fails, which is "not accepted", never thrown onward.
    await expect(attemptSink("http://127.0.0.1:9", (l) => lines.push(l))(report as never)).resolves.toBeUndefined();
    return lines;
  }

  it("246's reproduction: a credential pasted into the model string never reaches the log", async () => {
    const lines = await linesFor({ ...BASE, harness: { ...BASE.harness, model: `pcc_live_${MARK}` }, pack: { ...BASE.pack, version: `pcc_live_${MARK}` } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expectClosedAttemptLine(line);
    expect(JSON.parse(lines[0]!)).toEqual({ event: "attempt-report", outcome: "failed", phase: "session", seq: 3, durationMs: 1234, tokensIn: 10, tokensOut: 5, sessionId: BASE.sessionId });
  });

  it.each([
    ["a throwing toJSON", () => ({ ...BASE, toJSON: () => { throw new Error(`pcc_live_${MARK}`); } })],
    [
      "a cycle",
      () => {
        const r: Record<string, unknown> = { ...BASE };
        r.self = r;
        return r;
      },
    ],
    ["a bigint", () => ({ ...BASE, tokens: { in: 10n, out: 5, source: "metered" } })],
    ["a Proxy whose get trap throws", () => new Proxy({}, { get: () => { throw new Error(`pcc_live_${MARK}`); } })],
    [
      "values outside the closed sets",
      () => ({ ...BASE, sessionId: `pcc_live_${MARK}`, outcome: `pcc_live_${MARK}`, phase: `pcc_live_${MARK}`, seq: -1, durationMs: `pcc_live_${MARK}`, tokens: { in: 1.5, out: "5", source: "metered" } }),
    ],
  ])("246's reproduction: a report with %s never makes the sink reject, and its line is closed", async (_label, make) => {
    const lines = await linesFor(make());
    for (const line of lines) expectClosedAttemptLine(line);
  });
});
