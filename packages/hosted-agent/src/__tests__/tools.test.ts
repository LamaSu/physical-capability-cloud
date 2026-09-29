import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMcp, packTools, scrub, scrubText, REDACTED } from "../tools.js";
import type { PinnedPack } from "../pack.js";

const KEY = "pcc_live_ThisIsTheUsersKey123";
const seen: Array<{ path: string; auth: string | undefined }> = [];
let base = "";
let httpServer: http.Server;

beforeAll(async () => {
  httpServer = http.createServer(async (req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const server = new Server({ name: "test-gateway", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
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
    const transport = { callTool: async (n: string, a: Record<string, unknown>) => (calls.push([n, a]), "ok"), close: async () => {} };
    const pack: PinnedPack = {
      version: "1",
      sha256: "0".repeat(64),
      systemPrompt: "p",
      tools: [{ def: { name: "list_open_jobs", description: "", input_schema: { type: "object" } }, spec: { name: "list_open_jobs", method: "GET", path: "/api/job-offers/open" } }],
    };
    const [tool] = packTools(pack, transport);
    await tool!.caller({ capabilityType: "fdm" });
    await tool!.caller("not an object");
    expect(calls).toEqual([
      ["list_open_jobs", { capabilityType: "fdm" }],
      ["list_open_jobs", {}],
    ]);
  });
});
