import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp, packTools, scrub, scrubText, REDACTED, SCRUB_TEXT_LIMIT } from "../tools.js";
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
      // Q1-A round 2: opaque, non-JSON credential ASSIGNMENTS (no surrounding braces/quotes on the name).
      if (name === "opaque-assignment") return { content: [{ type: "text", text: "token=opaque-session-value-0123" }] };
      if (name === "opaque-assignment-spaced") return { content: [{ type: "text", text: "session token: opaque-session-value-0123" }] };
      if (name === "opaque-assignment-error") return { isError: true, content: [{ type: "text", text: "refused: token=opaque-session-value-0123" }] };
      // R1-b round 3: an Authorization header with an arbitrary (non-Basic/Bearer) scheme word.
      if (name === "opaque-authorization-scheme") return { content: [{ type: "text", text: "Authorization: Token opaqueA1secret" }] };
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

describe("opaque credentials in non-JSON text survive the scrubber (Q1-A round 2)", () => {
  it("`name=value` through connectMcp().callTool() is redacted, not just quoted JSON pairs", async () => {
    const t = await connectMcp(base, KEY);
    const out = await t.callTool("opaque-assignment", {});
    await t.close();
    expect(JSON.stringify(out)).not.toContain("opaque-session-value-0123");
    expect(JSON.stringify(out)).toContain(REDACTED);
  });

  it("a multi-word name (`session token: value`) is redacted the same way", async () => {
    const t = await connectMcp(base, KEY);
    const out = await t.callTool("opaque-assignment-spaced", {});
    await t.close();
    expect(JSON.stringify(out)).not.toContain("opaque-session-value-0123");
  });

  it("the error path (toolError) is scrubbed too", async () => {
    const t = await connectMcp(base, KEY);
    const err = await t.callTool("opaque-assignment-error", {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    await t.close();
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain("opaque-session-value-0123");
  });

  it.each([
    ["token", "token=opaque-value-0123456789"],
    ["access token", "access_token=opaque-value-0123456789"],
    ["refresh token", "refresh-token=opaque-value-0123456789"],
    ["id token", "id token=opaque-value-0123456789"],
    ["session token", "session_token=opaque-value-0123456789"],
    ["auth token", "auth-token=opaque-value-0123456789"],
    ["bearer token", "bearer token=opaque-value-0123456789"],
    ["api key", "api_key=opaque-value-0123456789"],
    ["raw key", "raw-key=opaque-value-0123456789"],
    ["secret", "secret=opaque-value-0123456789"],
    ["client secret", "client_secret=opaque-value-0123456789"],
    ["password", "password=opaque-value-0123456789"],
    ["passphrase", "passphrase=opaque-value-0123456789"],
    ["private key", "private-key=opaque-value-0123456789"],
    ["mnemonic", "mnemonic=opaque-value-0123456789"],
    ["seed", "seed=opaque-value-0123456789"],
    ["seed phrase", "seed phrase=opaque-value-0123456789"],
    ["bearer", "bearer=opaque-value-0123456789"],
    ["authorization", "authorization=opaque-value-0123456789"],
  ])("every SECRET_FIELDS name is covered in free text: %s", (_label, text) => {
    const out = scrubText(text);
    expect(out).not.toContain("opaque-value-0123456789");
    expect(out).toContain(REDACTED);
  });

  it("Authorization: Basic/Bearer both lose the credential, with the scheme word kept", () => {
    expect(scrubText("Authorization: Basic xyz")).toBe(`Authorization: Basic ${REDACTED}`);
    expect(scrubText("Authorization: Bearer xyz")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("a URL query parameter is covered by the same rule", () => {
    const out = scrubText("https://x.example/y?token=abcdefgh123&x=1");
    expect(out).not.toContain("abcdefgh123");
    expect(out).toContain("&x=1");
  });

  it("the name must not be preceded by a letter or digit: kept look-alikes", () => {
    for (const text of ["max_tokens=100", "tokenCount=3", "secretary: Bob"]) {
      expect(scrubText(text)).toBe(text);
    }
  });

  it("an unrelated qualifier word before a real name is not swallowed: `new token: value` still redacts value", () => {
    const out = scrubText("new token: opaque-value-0123456789");
    expect(out).not.toContain("opaque-value-0123456789");
    expect(out).toContain("new token");
  });

  it("several occurrences in one string are all redacted", () => {
    const out = scrubText("token=abc0123456789 and later password: def0123456789");
    expect(out).not.toContain("abc0123456789");
    expect(out).not.toContain("def0123456789");
  });

  it("a value in quotes keeps its quotes, redacted inside", () => {
    expect(scrubText('password = "letme-in-0123456"')).toBe(`password = "${REDACTED}"`);
    expect(scrubText("api_key='abcdefgh123456'")).toBe(`api_key='${REDACTED}'`);
  });
});

describe("R1 (round 3 lane review): the free-text scrubber still leaks", () => {
  // The lane's exact probe lines (spec-456-r3-addendum-lane-review.md). Each must lose its
  // opaque secret; several assert what must STAY visible too (scheme word, cookie shape).
  it("R1-b: any scheme word after Authorization/Proxy-Authorization stays visible; the credential after it does not", () => {
    expect(scrubText("Authorization: Token opaqueA1secret")).toBe("Authorization: Token [redacted]");
    expect(scrubText("Authorization: ApiKey opaqueA2secret")).toBe("Authorization: ApiKey [redacted]");
    expect(scrubText("Proxy-Authorization: Basic opaqueA3secret")).toBe("Proxy-Authorization: Basic [redacted]");
    // no scheme word at all: the lone token is the value, not a kept "scheme"
    expect(scrubText("Authorization: opaqueonlysecret0000")).toBe(`Authorization: ${REDACTED}`);
    // other names get NO scheme skipping: the first token is the whole value
    expect(scrubText("token: abc def")).toBe(`token: ${REDACTED} def`);
  });

  it("R1-a: an escaped-quoted JSON pair (backslash-quote on both key and value) is redacted, quoting style kept", () => {
    expect(scrubText('{\\"access_token\\":\\"opaqueB2secret\\"}')).toBe(`{\\"access_token\\":\\"${REDACTED}\\"}`);
    expect(scrubText('{\\"password\\": \\"opaqueB3secret\\"}')).toBe(`{\\"password\\": \\"${REDACTED}\\"}`);
  });

  it("R1-a: a single-quoted JSON-ish pair is redacted, quotes kept", () => {
    expect(scrubText("{'client_secret': 'opaqueK1secret'}")).toBe(`{'client_secret': '${REDACTED}'}`);
  });

  it("R1-c: URL userinfo loses its password, for any URL scheme", () => {
    expect(scrubText("fetch https://bob:opaqueC3secret@api.example.com/x failed")).toBe(`fetch https://bob:${REDACTED}@api.example.com/x failed`);
    expect(scrubText("wss://svc:opaqueC4secret@relay.example.com/ws")).toBe(`wss://svc:${REDACTED}@relay.example.com/ws`);
  });

  it("R1-d: Cookie and Set-Cookie header values lose every pair's value", () => {
    expect(scrubText("Cookie: sid=opaqueD4secret; theme=dark")).not.toContain("opaqueD4secret");
    expect(scrubText("Set-Cookie: session=opaqueD5secret; Path=/")).not.toContain("opaqueD5secret");
    // chosen design (spec explicitly allows this): every pair's VALUE is redacted, attribute
    // names stay readable. Simpler than selectively sparing non-secret attribute values.
    expect(scrubText("Cookie: sid=opaqueD4secret; theme=dark")).toBe(`Cookie: sid=${REDACTED}; theme=${REDACTED}`);
    expect(scrubText("Set-Cookie: session=opaqueD5secret; Path=/")).toBe(`Set-Cookie: session=${REDACTED}; Path=${REDACTED}`);
  });

  it("R1-f: a non-string (numeric) JSON value under a secret-named key is redacted", () => {
    expect(scrubText('{"token": 1234567890123456}')).toBe(`{"token": "${REDACTED}"}`);
  });

  it("R1-e: the new names are covered — passwd, pwd, secretkey, secretaccesskey, apisecret, appsecret", () => {
    expect(scrubText("passwd=opaqueJ1secret")).toBe(`passwd=${REDACTED}`);
    expect(scrubText("pwd: opaqueJ2secret")).toBe(`pwd: ${REDACTED}`);
    expect(scrubText("secretkey=opaqueJ3secret")).toBe(`secretkey=${REDACTED}`);
    expect(scrubText("secret_key=opaqueJ4secret")).toBe(`secret_key=${REDACTED}`);
    expect(scrubText("aws_secret_access_key=opaqueJ5secret")).toBe(`aws_secret_access_key=${REDACTED}`);
    expect(scrubText("api_secret: opaqueJ6secret")).toBe(`api_secret: ${REDACTED}`);
    expect(scrubText("app_secret: opaqueJ7secret")).toBe(`app_secret: ${REDACTED}`);
  });

  it("R1-e: session, sessionid and pass are deliberately NOT secret names", () => {
    expect(scrubText("sessionId: s-123")).toBe("sessionId: s-123");
    expect(scrubText("session_id=s-456")).toBe("session_id=s-456");
    expect(scrubText("pass: 5")).toBe("pass: 5");
  });

  it("R1: the kept look-alikes from the lane's list", () => {
    for (const text of ["max_tokens=100", "tokenCount=3", "secretary: Bob", "sessionId: s-123", '"tokens": 5', "pass: 5", "Path=/"]) {
      expect(scrubText(text)).toBe(text);
    }
  });

  it("R1: through connectMcp().callTool(), an Authorization header with an arbitrary scheme word loses only the credential", async () => {
    const t = await connectMcp(base, KEY);
    const out = await t.callTool("opaque-authorization-scheme", {});
    await t.close();
    expect(JSON.stringify(out)).not.toContain("opaqueA1secret");
    expect(JSON.stringify(out)).toContain("Token");
  });
});

describe("R6 (round 3 addendum 2): empty-username userinfo leaks", () => {
  it("R6: scheme://:password@host (the Redis form) redacts the password", () => {
    expect(scrubText("redis://:opaqueR1secret@localhost:6379")).toBe(`redis://:${REDACTED}@localhost:6379`);
  });

  it("R5: a password containing @ is covered too — userinfo is the text before the LAST @ in the authority", () => {
    expect(scrubText("https://user:p@ssopaqueR2secret@host.example/x")).toBe(`https://user:${REDACTED}@host.example/x`);
  });
});

describe("R7 (round 3 addendum 2, regression from 73d1fe20): quoted keys lost their generic coverage", () => {
  it.each([
    ['"', '"'],
    ["'", "'"],
    ['\\"', '\\"'],
  ])("a QUOTED key (%s...%s) is generic: isSecretField, not the enumerated alternation, decides", (o, c) => {
    expect(scrubText(`{${o}pass_phrase${c}:${o}opaqueP1secret${c}}`)).toBe(`{${o}pass_phrase${c}:${o}${REDACTED}${c}}`);
    expect(scrubText(`{${o}access__token${c}:${o}opaqueP2secret${c}}`)).toBe(`{${o}access__token${c}:${o}${REDACTED}${c}}`);
    expect(scrubText(`{${o}Pass-Word${c}:${o}opaqueP3secret${c}}`)).toBe(`{${o}Pass-Word${c}:${o}${REDACTED}${c}}`);
    expect(scrubText(`{${o}seed-phrase${c}:${o}opaqueP4secret${c}}`)).toBe(`{${o}seed-phrase${c}:${o}${REDACTED}${c}}`);
  });

  it("R7: BARE keys still use the enumerated names (free-text safety is unchanged)", () => {
    expect(scrubText("new token: opaque-value-0123456789")).not.toContain("opaque-value-0123456789");
    expect(scrubText("refused: token=opaque-session-value-0123")).toContain("refused:");
  });

  it("R7: the kept list still holds", () => {
    for (const text of ["max_tokens=100", "tokenCount=3", "secretary: Bob", "sessionId: s-123", '"tokens": 5', "pass: 5", "Path=/"]) {
      expect(scrubText(text)).toBe(text);
    }
  });
});

describe("R8 (round 3 addendum 2): an object or array value under a secret key is mangled and its contents survive", () => {
  it("R8: a nested object value is redacted whole, quoting kept consistent", () => {
    expect(scrubText('{"token": {"value": "opaqueN1secret"}}')).toBe('{"token": "[redacted]"}');
  });

  it("R8: a nested array value is redacted whole", () => {
    expect(scrubText('{"token": ["opaqueN2secret"]}')).toBe('{"token": "[redacted]"}');
  });

  it("R8: deep nesting (object inside array inside object) is fully consumed", () => {
    const out = scrubText('{"token": {"a": {"b": [1, {"c": "opaqueN3secret"}]}}}');
    expect(out).toBe('{"token": "[redacted]"}');
  });

  it("R8: a bracket inside a STRING inside the value does not confuse the depth counter", () => {
    const out = scrubText('{"token": {"note": "use { carefully }", "x": "opaqueN4secret"}}');
    expect(out).toBe('{"token": "[redacted]"}');
    expect(out).not.toContain("opaqueN4secret");
  });

  it("R8: an unterminated bracket span is redacted to the end of the (capped) text", () => {
    const out = scrubText('{"token": {"value": "opaqueN5secret"');
    expect(out).not.toContain("opaqueN5secret");
  });

  it("R8: the escaped-JSON form (backslash-quoted throughout) is also fully consumed", () => {
    const out = scrubText('{\\"token\\": {\\"value\\": \\"opaqueN6secret\\"}}');
    expect(out).not.toContain("opaqueN6secret");
  });

  it("R8: a non-secret key's bracket value is left alone, and a secret key nested inside it is still found", () => {
    const out = scrubText('{"meta": {"token": "opaqueX1secret"}}');
    expect(out).not.toContain("opaqueX1secret");
    expect(out).toContain('"meta": {');
  });

  it("R8: two adjacent secret-bracketed keys are each redacted independently", () => {
    expect(scrubText('{"token": {"a":1}, "secret": {"b":2}}')).toBe('{"token": "[redacted]", "secret": "[redacted]"}');
  });
});

describe("R9 (round 3 addendum 2, LOW): no double brackets", () => {
  it("R9: a value already redacted by an earlier pass (SECRET_STRINGS) is left as-is, not re-wrapped", () => {
    expect(scrubText("Authorization: Bearer abcdefghijklmnop1234")).toBe("Authorization: [redacted]");
    expect(scrubText("token: pcc_live_abcdefgh12345678 rest")).toBe("token: [redacted] rest");
  });
});

describe("F1 (round 4, 224a HIGH): an unterminated or cap-split quoted secret value survives", () => {
  it("F1-a: the reviewer's case — a double-quoted value cut by SCRUB_TEXT_LIMIT loses every 100-char run", () => {
    const secret = "s".repeat(SCRUB_TEXT_LIMIT);
    const out = scrubText(`token="${secret}"`);
    expect(out).not.toContain("s".repeat(100));
  });

  it("F1-a: the same in each quote style — single-quoted and escaped-double, cap-split", () => {
    expect(scrubText(`token='${"s".repeat(SCRUB_TEXT_LIMIT)}'`)).not.toContain("s".repeat(100));
    expect(scrubText(`token=\\"${"s".repeat(SCRUB_TEXT_LIMIT)}\\"`)).not.toContain("s".repeat(100));
  });

  it("F1-a: an unterminated value with NO cap involved (just a missing closing quote) is still redacted", () => {
    const out = scrubText('token="abcdefghij');
    expect(out).not.toContain("abcdefghij");
    expect(out).toContain(REDACTED);
  });

  it("F1-a: a value cut mid-escape (a trailing backslash) is still fully redacted", () => {
    expect(scrubText('token="abcdefghij\\')).not.toContain("abcdefghij");
  });

  it("F1-a: a properly closed value, or one followed by more text, is unaffected", () => {
    expect(scrubText('token="abc"')).toBe(`token="${REDACTED}"`);
    expect(scrubText('token="abc" rest')).toBe(`token="${REDACTED}" rest`);
  });

  it("F1-b: a cap-split PEM block (its END marker missing or cut off) is redacted to the end of the bounded input", () => {
    const out = scrubText(`-----BEGIN PRIVATE KEY-----${"s".repeat(SCRUB_TEXT_LIMIT)}`);
    expect(out).not.toContain("s".repeat(100));
  });

  it("F1-b: a normal, terminated PEM block is still redacted whole (no regression)", () => {
    expect(scrubText("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(REDACTED);
  });

  it("F1-c: a cap-split bracket value stays unterminated-safe (already true; pinned here at the cap)", () => {
    const out = scrubText(`{"token": {"value": "${"s".repeat(SCRUB_TEXT_LIMIT)}"`);
    expect(out).not.toContain("s".repeat(100));
  });

  it("F1: every case stays well under the timing bound at the cap", () => {
    const cases = [
      `token="${"s".repeat(SCRUB_TEXT_LIMIT)}`,
      `-----BEGIN PRIVATE KEY-----${"s".repeat(SCRUB_TEXT_LIMIT)}`,
      `{"token": {"a": "${"s".repeat(SCRUB_TEXT_LIMIT)}`,
    ];
    for (const input of cases) {
      const t0 = Date.now();
      scrubText(input);
      expect(Date.now() - t0).toBeLessThan(200);
    }
  });
});

describe("F2 (round 4, 224a HIGH): structured Authorization credentials keep their later components", () => {
  it("F2: the reviewer's Digest case — every component is redacted, not just the first", () => {
    expect(scrubText('Authorization: Digest username="alice", realm="pcc", response="opaqueA4secret"')).not.toContain("opaqueA4secret");
  });

  it("F2: AWS4-HMAC-SHA256 (comma-separated Credential/SignedHeaders/Signature)", () => {
    const out = scrubText(
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20230101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=opaqueA5secret",
    );
    expect(out).not.toContain("opaqueA5secret");
    expect(out).toContain("AWS4-HMAC-SHA256");
  });

  it("F2: Basic and Bearer give the SAME result as before (single-token schemes unaffected)", () => {
    expect(scrubText("Authorization: Basic xyz")).toBe(`Authorization: Basic ${REDACTED}`);
    expect(scrubText("Authorization: Bearer xyz")).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it("F2: redaction stops at the line end — a second line survives untouched", () => {
    expect(scrubText("Authorization: Bearer xyz\nGET /api/foo HTTP/1.1")).toBe(`Authorization: Bearer ${REDACTED}\nGET /api/foo HTTP/1.1`);
  });

  it("F2: Proxy-Authorization gets the same treatment", () => {
    expect(scrubText('Proxy-Authorization: Digest username="bob", response="opaqueA6secret"')).not.toContain("opaqueA6secret");
  });

  it("F2: an Authorization header as the VALUE of a quoted JSON pair is already fully redacted (the quoted-value path, not this one)", () => {
    const out = scrubText('{"authorization": "Digest username=\\"alice\\", response=\\"opaqueA7secret\\""}');
    expect(out).not.toContain("opaqueA7secret");
    expect(out).toBe('{"authorization": "[redacted]"}');
  });
});

describe("lane review (round 3): a credential in the URL username position, and escaped-key bracket quoting", () => {
  it("a token used as the URL username (no password) is redacted: the git-over-https form", () => {
    expect(scrubText("git clone https://ghp_opaqueU1secret@github.com/o/r.git failed")).toBe(
      `git clone https://${REDACTED}@github.com/o/r.git failed`,
    );
  });

  it("a URL with no userinfo is untouched", () => {
    expect(scrubText("see https://example.com/a?b=c and ssh://github.com:22/x")).toBe("see https://example.com/a?b=c and ssh://github.com:22/x");
  });

  it("an object value under a backslash-escaped key is replaced in the same escaped quoting", () => {
    expect(scrubText('{\\"token\\": {\\"value\\": \\"opaqueN3secret\\"}}')).toBe(`{\\"token\\": \\"${REDACTED}\\"}`);
  });
});

describe("R5 (round 3 addendum 2, availability): URL_USERINFO is linear, and scrubText caps its work", () => {
  it("R5: userinfo redaction is linear — the lane's adversarial shape finishes well under 200ms at every size", () => {
    for (const n of [5_000, 10_000, 20_000, 40_000, SCRUB_TEXT_LIMIT]) {
      const input = "a".repeat(Math.floor(n / 2)) + "://b:" + "c".repeat(Math.floor(n / 2));
      const t0 = Date.now();
      scrubText(input);
      const ms = Date.now() - t0;
      expect(ms, `n=${n} took ${ms}ms`).toBeLessThan(200);
    }
  });

  it("R5: every other pattern stays fast on its own adversarial shape, at the cap", () => {
    const cases: Array<[string, string]> = [
      ["unterminated PEM markers", "-----BEGIN PRIVATE KEY-----".repeat(Math.ceil(SCRUB_TEXT_LIMIT / 28))],
      ["unterminated bracket span", '"token": ' + "[".repeat(50_000) + "]".repeat(50_000)],
      ["many bare assignments", "token=x; ".repeat(30_000)],
      ["many quoted JSON pairs", '{"token": "a"}, '.repeat(15_000)],
      ["long Cookie header", "Cookie: " + "a=b; ".repeat(50_000)],
    ];
    for (const [label, input] of cases) {
      const t0 = Date.now();
      scrubText(input);
      const ms = Date.now() - t0;
      expect(ms, `${label} (${input.length} chars) took ${ms}ms`).toBeLessThan(200);
    }
  });

  it("R5: input over SCRUB_TEXT_LIMIT is cut, with a visible truncation marker, before any scrubbing", () => {
    const huge = "x".repeat(SCRUB_TEXT_LIMIT + 50_000);
    const out = scrubText(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("[truncated]");
    expect(out.startsWith("x".repeat(100))).toBe(true); // the kept prefix is untouched content
  });

  it("R5: a secret sitting exactly at the cap boundary is still redacted (the cap does not split it)", () => {
    const prefix = "x".repeat(SCRUB_TEXT_LIMIT - 10);
    const input = `${prefix}token=opaquecapboundarysecret0123`;
    const out = scrubText(input);
    // Either the secret was fully inside the kept prefix (redacted) or it was cut by
    // truncation — either way, the raw secret must never survive in the output.
    expect(out).not.toContain("opaquecapboundarysecret0123");
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
