import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp, packTools, scrub, scrubText, REDACTED } from "../tools.js";
import type { PinnedPack } from "../pack.js";

const KEY = "pcc_live_ThisIsTheUsersKey123";
const seen: Array<{ path: string; auth: string | undefined }> = [];
let base = "";
let httpServer: http.Server;
/** The version the fixture gateway reports in its initialize handshake. */
let fixtureVersion = "1";

beforeAll(async () => {
  httpServer = http.createServer(async (req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    if (body?.method === "initialize" && req.headers.authorization === "Bearer pcc_live_RejectedAtHandshake1") {
      res.statusCode = 403;
      res.setHeader("content-type", "text/plain");
      res.end(`forbidden for ${req.headers.authorization}`);
      return;
    }
    if (body?.method === "tools/call" && body.params?.name === "http-error") {
      // A gateway-side HTTP failure whose body echoes the caller's credential.
      res.statusCode = 502;
      res.setHeader("content-type", "text/plain");
      res.end(`upstream rejected ${req.headers.authorization ?? "(no credential)"}`);
      return;
    }
    const server = new Server({ name: "test-gateway", version: fixtureVersion }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (req.headers.authorization === "Bearer pcc_live_ListingFails0001") {
        throw new McpError(ErrorCode.InternalError, "listing refused for pcc_live_ListingFails0001");
      }
      return { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const name = r.params.name;
      if (name === "leaky") {
        const payload = {
          apiKey: "pcc_live_abcdefgh1234",
          note: "use Bearer abcdefgh12345678 next time",
          tx: "0x" + "a".repeat(64),
          nested: { privateKey: "0xdead", list: ["sk-ant-abcdefgh99", "fine"] },
        };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
      if (name === "fails") return { isError: true, content: [{ type: "text", text: "refused for pcc_live_zzzzzzzz9999" }] };
      if (name === "token-result") return { content: [{ type: "text", text: JSON.stringify({ registered: true, token: "eyJhbGciOiJIUzI1NiJ9.synthetic.signature" }) }] };
      if (name === "error-with-json-body") return { isError: true, content: [{ type: "text", text: 'PCC API request failed with HTTP 400: {\n  "error": "bad request",\n  "token": "opaque-session-value-0123"\n}' }] };
      if (name === "rpc-error") throw new McpError(ErrorCode.InternalError, "rejected pcc_live_abcdefgh12345678");
      if (name === "long-error") return { isError: true, content: [{ type: "text", text: `pcc_live_zzzzzzzz9999 ${"x".repeat(20_000)}` }] };
      return { content: [{ type: "text", text: JSON.stringify({ tool: name, echoed: r.params.arguments ?? null }) }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("the agent calls the gateway as the user", () => {
  it("a signed-in session uses /mcp with the user's own key on every request", async () => {
    seen.length = 0;
    const t = await connectMcp(base, KEY);
    expect(await t.callTool("echo", { a: 1 })).toEqual({ tool: "echo", echoed: { a: 1 } });
    await t.close();
    const posts = seen.filter((s) => s.path.startsWith("/mcp"));
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((s) => s.path === "/mcp" && s.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it("listTools reports the surface's tools", async () => {
    const t = await connectMcp(base, null);
    expect(await t.listTools()).toEqual(["echo"]);
    await t.close();
  });

  it("a keyless session uses the read-only /mcp/apps and sends no credential", async () => {
    seen.length = 0;
    const t = await connectMcp(base, null);
    await t.callTool("echo", {});
    await t.close();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.path === "/mcp/apps" && s.auth === undefined)).toBe(true);
  });
});

describe("what the model sees is scrubbed", () => {
  it("secret fields and secret-shaped strings are redacted; hashes are kept", async () => {
    const t = await connectMcp(base, KEY);
    const out = (await t.callTool("leaky", {})) as Record<string, unknown>;
    await t.close();
    expect(out).toEqual({
      apiKey: REDACTED,
      note: `use ${REDACTED} next time`,
      tx: "0x" + "a".repeat(64),
      nested: { privateKey: REDACTED, list: [REDACTED, "fine"] },
    });
    expect(JSON.stringify(out)).not.toMatch(/pcc_live_|sk-ant-|Bearer\s/);
  });

  it("a tool error is thrown for the loop to report, scrubbed", async () => {
    const t = await connectMcp(base, KEY);
    await expect(t.callTool("fails", {})).rejects.toThrow(`refused for ${REDACTED}`);
    await t.close();
  });

  it("scrub covers PEM blocks, arrays and plain text", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----";
    expect(scrubText(`k=${pem};`)).toBe(`k=${REDACTED};`);
    expect(scrub(["Bearer abcdefghijkl", { Authorization: "x", mnemonic: "a b c", ok: 1 }])).toEqual([
      REDACTED,
      { Authorization: REDACTED, mnemonic: REDACTED, ok: 1 },
    ]);
  });
});

describe("pack tools", () => {
  it("each pinned tool calls the transport under its own name, with an object input", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const transport = { listTools: async () => ["list_open_jobs"], callTool: async (n: string, a: Record<string, unknown>) => (calls.push([n, a]), "ok"), close: async () => {} };
    const pack: PinnedPack = {
      version: "1",
      sha256: "0".repeat(64),
      systemPrompt: "p",
      tools: [{ def: { name: "list_open_jobs", description: "", input_schema: { type: "object" } }, spec: { name: "list_open_jobs", method: "GET", path: "/api/job-offers/open" } }],
    };
    expect(packTools(pack, transport, new Set())).toEqual([]);
    const [tool] = packTools(pack, transport, new Set(["list_open_jobs"]));
    await tool!.caller({ capabilityType: "fdm" });
    await tool!.caller("not an object");
    expect(calls).toEqual([
      ["list_open_jobs", { capabilityType: "fdm" }],
      ["list_open_jobs", {}],
    ]);
  });
});

describe("a failing tool call never carries a secret to the model (Q1-A)", () => {
  it("Q1-A: a JSON-RPC error from the gateway is thrown scrubbed, through the real MCP client", async () => {
    const t = await connectMcp(base, KEY);
    const err = await t.callTool("rpc-error", {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await t.close();
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("rejected");
    expect(err!.message).toContain(REDACTED);
    expect(err!.message).not.toContain("pcc_live_");
  });

  it("Q1-A: an HTTP failure that echoes the caller's credential is thrown scrubbed", async () => {
    const t = await connectMcp(base, KEY);
    const err = await t.callTool("http-error", {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await t.close();
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("upstream rejected");
    expect(err!.message).not.toContain(KEY);
    expect(err!.message).not.toContain("pcc_live_");
  });

  it("Q1-A: a handshake the gateway refuses, and a tool listing it refuses, are thrown scrubbed too", async () => {
    const handshake = await connectMcp(base, "pcc_live_RejectedAtHandshake1").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(handshake).toBeInstanceOf(Error);
    expect(handshake!.message).toContain("forbidden");
    expect(handshake!.message).not.toContain("pcc_live_");

    const t = await connectMcp(base, "pcc_live_ListingFails0001");
    const listing = await t.listTools().then(
      () => null,
      (e: unknown) => e as Error,
    );
    await t.close();
    expect(listing).toBeInstanceOf(Error);
    expect(listing!.message).toContain("listing refused");
    expect(listing!.message).not.toContain("pcc_live_");
  });

  it("Q1-A: what is thrown is bounded, and does not chain to the raw error", async () => {
    const t = await connectMcp(base, KEY);
    const err = await t.callTool("long-error", {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await t.close();
    expect(err!.message.length).toBeLessThanOrEqual(2_001);
    expect(err!.message).not.toContain("pcc_live_");
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  const pack = (name: string): PinnedPack => ({
    version: "1",
    sha256: "0".repeat(64),
    systemPrompt: "p",
    tools: [{ def: { name, description: "", input_schema: { type: "object" } }, spec: { name, method: "GET", path: "/api/x" } }],
  });
  const throwing = (e: unknown) => ({
    serverVersion: () => undefined,
    listTools: async () => ["list_jobs"],
    callTool: async () => {
      throw e;
    },
    close: async () => {},
  });

  it("Q1-A: whatever an injected transport throws is scrubbed and bounded before it can reach the model", async () => {
    const raw = new Error(`rejected pcc_live_abcdefgh12345678 ${"y".repeat(10_000)}`);
    const [tool] = packTools(pack("list_jobs"), throwing(raw), new Set(["list_jobs"]));
    const err = await tool!.caller({}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBe(raw);
    expect(err!.message).toContain("rejected");
    expect(err!.message).not.toContain("pcc_live_");
    expect(err!.message.length).toBeLessThanOrEqual(2_001);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("Q1-A: a thrown value that is not an Error is scrubbed too", async () => {
    const [tool] = packTools(pack("list_jobs"), throwing("rejected pcc_live_abcdefgh12345678"), new Set(["list_jobs"]));
    await expect(tool!.caller({})).rejects.toThrow(`rejected ${REDACTED}`);
    const [other] = packTools(pack("list_jobs"), throwing({ secret: "pcc_live_abcdefgh12345678" }), new Set(["list_jobs"]));
    const err = await other!.caller({}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("pcc_live_");
  });

  it("Q1-A: a result an injected transport returns is scrubbed before it can reach the model", async () => {
    const transport = {
      serverVersion: () => undefined,
      listTools: async () => ["list_jobs"],
      callTool: async () => ({ ok: true, apiKey: "pcc_live_abcdefgh12345678", note: "Bearer abcdefgh12345678" }),
      close: async () => {},
    };
    const [tool] = packTools(pack("list_jobs"), transport, new Set(["list_jobs"]));
    expect(await tool!.caller({})).toEqual({ ok: true, apiKey: REDACTED, note: REDACTED });
  });
});

describe("the scrubber redacts credential fields and bare tokens (Q3-B)", () => {
  const FIELDS = ["token", "accessToken", "refreshToken", "apiKey", "secret", "password", "privateKey"];

  it.each(FIELDS)("Q3-B: the value of a JSON field named %s is redacted, in any letter case", (name) => {
    for (const key of [name, name.toUpperCase(), name.toLowerCase(), name[0]!.toUpperCase() + name.slice(1)]) {
      expect(scrub({ [key]: "synthetic-value-0123456789", keep: 1 })).toEqual({ [key]: REDACTED, keep: 1 });
    }
  });

  it.each([
    "id_token", "idToken", "session-token", "sessionToken", "auth_token", "bearer_token", "api-key", "api_key",
    "client_secret", "clientSecret", "private_key", "access-token", "access_token", "refresh_token", "raw_key",
    "passphrase", "mnemonic", "seed", "seed_phrase", "Authorization", "bearer",
  ])("a credential field is redacted in any spelling: %s", (name) => {
    expect(scrub({ [name]: "synthetic-value-0123456789" })).toEqual({ [name]: REDACTED });
  });

  it("Q3-B: a field's value is redacted whatever its type, and at any depth", () => {
    expect(scrub({ token: { nested: "a" }, list: [{ apiKey: 7 }], deep: { a: { b: { password: ["p"] } } }, ok: "fine" })).toEqual({
      token: REDACTED,
      list: [{ apiKey: REDACTED }],
      deep: { a: { b: { password: REDACTED } } },
      ok: "fine",
    });
  });

  it("Q3-B: a token field in a tool result is redacted on the MCP client's result path", async () => {
    const t = await connectMcp(base, KEY);
    const out = await t.callTool("token-result", {});
    await t.close();
    expect(out).toEqual({ registered: true, token: REDACTED });
  });

  it("Q3-B: the value of a credential field is redacted inside text that is not itself JSON, such as an error body", async () => {
    expect(scrubText('HTTP 400: {"token":"opaque-session-value-0123","ok":"fine"}')).toBe(`HTTP 400: {"token":"${REDACTED}","ok":"fine"}`);
    expect(scrubText('{\n  "refresh_token" :  "a\\"b",\n  "name": "kept"\n}')).toBe(`{\n  "refresh_token" :  "${REDACTED}",\n  "name": "kept"\n}`);
    expect(scrubText('{"max_tokens":"5","tokenCount":"3"}')).toBe('{"max_tokens":"5","tokenCount":"3"}');
    const t = await connectMcp(base, KEY);
    const err = await t.callTool("error-with-json-body", {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await t.close();
    expect(err!.message).toContain("bad request");
    expect(err!.message).not.toContain("opaque-session-value-0123");
  });

  it("Q3-B: a bare JWT-shaped string is redacted wherever it appears", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.synthetic.signature";
    expect(scrubText(`session ${jwt} issued`)).toBe(`session ${REDACTED} issued`);
    expect(scrub({ note: `use ${jwt}`, list: [jwt, "fine"], other: jwt })).toEqual({ note: `use ${REDACTED}`, list: [REDACTED, "fine"], other: REDACTED });
    // a JWT whose signature part is empty (alg none) is still a JWT
    expect(scrubText("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.")).toBe(REDACTED);
  });

  it("Q3-B: names and strings that only look similar are kept", () => {
    expect(scrub({ max_tokens: 5, tokenCount: 3, tokens: ["a"], secretary: "kept", kind: "token" })).toEqual({
      max_tokens: 5,
      tokenCount: 3,
      tokens: ["a"],
      secretary: "kept",
      kind: "token",
    });
    expect(scrubText("eyJhbGciOiJIUzI1NiJ9")).toBe("eyJhbGciOiJIUzI1NiJ9"); // no dots: not a JWT
    expect(scrubText("eyJhbGciOiJIUzI1NiJ9.payload")).toBe("eyJhbGciOiJIUzI1NiJ9.payload"); // two parts only
  });
});

describe("the gateway names the pack it runs (Q5-A)", () => {
  it("Q5-A: connectMcp reports the version the server announced in its handshake", async () => {
    fixtureVersion = `2.19.1+sha256.${"a".repeat(64)}`;
    try {
      const t = await connectMcp(base, KEY);
      expect(t.serverVersion()).toBe(`2.19.1+sha256.${"a".repeat(64)}`);
      await t.close();
    } finally {
      fixtureVersion = "1";
    }
  });
});
