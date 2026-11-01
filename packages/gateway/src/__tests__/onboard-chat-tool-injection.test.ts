import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import ts from "typescript";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStore, closeStore } from "../db.js";
import { onboardChatRoutes, _resetAgentPackageCache, _resetAnthropicCache } from "../routes/onboard-chat.js";
import { calleeName, enclosingName, isRuntimeFile, listRepoFiles, parseSource, printNode, unwrap } from "./helpers/negative-proof-scan.js";

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic { messages = { create: sdk.create }; },
}));
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/audit-service.js", () => ({
  auditService: { log: vi.fn(), query: vi.fn().mockReturnValue([]), stats: vi.fn().mockReturnValue([]) },
}));
vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn(), getTimeline: vi.fn().mockReturnValue([]), getStats: vi.fn().mockReturnValue({}) },
}));

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const TIMEOUT = 60_000;
type Headers = Record<string, string | string[] | undefined>;
type Finding = { rule: string; file: string; enclosing: string; expression: string };

/** E4a-R1 is also exercised on planted header leakage without mutating the route. */
function credentialHeaders(headers: Headers): string[] {
  const forbidden = new Set(["authorization", "cookie", "x-api-key", "proxy-authorization", "x-forwarded-for"]);
  return Object.keys(headers).filter((key) => forbidden.has(key.toLowerCase()) || key.toLowerCase().startsWith("x-pcc-"));
}

/** Pure tree scan: loopback injection must never acquire authority from auth code. */
function scanLoopbackTrust(root: string, files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const loopbacks = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);
  const comparisons = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ]);
  const isIp = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text === "ip" || expr.name.text === "remoteAddress";
    return ts.isElementAccessExpression(expr) && !!expr.argumentExpression && ts.isStringLiteralLike(expr.argumentExpression)
      && ["ip", "remoteAddress"].includes(expr.argumentExpression.text);
  };
  const isLoopback = (node: ts.Expression): boolean => {
    const expr = unwrap(node);
    return ts.isStringLiteralLike(expr) && loopbacks.has(expr.text);
  };
  for (const file of files) {
    if (!isRuntimeFile(file) || !["packages/gateway/src/middleware/", "packages/gateway/src/auth/"].some((prefix) => file.startsWith(prefix))) continue;
    const source = readFileSync(join(root, file), "utf8");
    if (!source.includes("\\") && !["127.0.0.1", "::1", "localhost", "isLoopback", "isLocalRequest"].some((word) => source.includes(word))) continue;
    const ast = parseSource(file, source);
    const visit = (node: ts.Node): void => {
      if ((ts.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)
        && ((isIp(node.left) && isLoopback(node.right)) || (isLoopback(node.left) && isIp(node.right))))
        || (ts.isCallExpression(node) && ["isLoopback", "isLocalRequest"].includes(calleeName(node.expression) ?? ""))) {
        findings.push({ rule: "E4a-R2", file, enclosing: enclosingName(node), expression: printNode(node, ast) });
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return findings;
}

describe("E4a onboard-chat injection carries no credentials", () => {
  let app: FastifyInstance | undefined;
  beforeEach(() => {
    vi.stubEnv("PCC_DB_PATH", ":memory:");
    vi.stubEnv("DATABASE_URL", ":memory:");
    vi.stubEnv("ANTHROPIC_API_KEY", "fake-sdk-key-no-network");
    _resetAnthropicCache();
    _resetAgentPackageCache();
    sdk.create.mockReset();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    closeStore();
    _resetAnthropicCache();
    _resetAgentPackageCache();
    vi.unstubAllEnvs();
  });

  it.each([
    { toolName: "setup_detect", method: "GET", expectedKeys: ["content-type", "host", "user-agent"] },
    { toolName: "setup_generate_config", method: "POST", expectedKeys: ["content-length", "content-type", "host", "user-agent"] },
  ])("E4a-R1 $method tool injection preserves credential-looking input as data", async ({ toolName, method, expectedKeys }) => {
    const pkg = JSON.parse(readFileSync(join(REPO, "apps/dashboard/public/agent-package.json"), "utf8")) as {
      tools: { name: string; endpoint?: { method: string; path: string } }[];
    };
    const tool = pkg.tools.find((candidate) => candidate.name === toolName);
    expect(tool?.endpoint?.method).toBe(method);
    if (!tool?.endpoint) throw new Error(`Real tool ${toolName} has no endpoint`);
    const input = {
      authorization: "Bearer pcc_live_tool_input",
      headers: { authorization: "Bearer nested-input", "x-pcc-admin": "input-only" },
      cookie: "session=tool-input",
    };
    let secondRequest: { messages: { content: unknown }[] } | undefined;
    sdk.create
      .mockResolvedValueOnce({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tool_fake_1", name: toolName, input }] })
      .mockImplementationOnce(async (request) => {
        // Snapshot at the call: the route mutates its history again after this.
        secondRequest = structuredClone(request);
        return { stop_reason: "end_turn", content: [{ type: "text", text: "Finished without credentials." }] };
      });

    initStore({ seed: true });
    app = Fastify({ logger: false });
    const requests: { url: string; headers: Headers; ip: string }[] = [];
    app.addHook("onRequest", async (request) => {
      requests.push({ url: request.url, headers: { ...request.headers }, ip: request.ip });
    });
    // The existing onboard-chat test app mounts only chat routes. Stub these real
    // tools' declared endpoints to inspect their query/body without extra services.
    app.route({ method: method as "GET" | "POST", url: tool.endpoint.path, handler: async (request) => ({ query: request.query, body: request.body ?? null }) });
    await app.register(onboardChatRoutes);
    await app.ready();
    const response = await app.inject({
      method: "POST", url: "/api/onboard/chat",
      headers: {
        authorization: "Bearer pcc_live_fake_outer_key", cookie: "session=fake-outer-cookie",
        "x-api-key": "fake-outer-api-key", "x-forwarded-for": "198.51.100.7",
        "proxy-authorization": "Basic fake-proxy", "x-pcc-admin": "fake-outer-admin",
      },
      payload: { message: "Inspect setup with the chosen tool." },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(response.json().assistant).toBe("Finished without credentials.");
    expect(response.json().toolCalls).toHaveLength(1);
    expect(response.json().toolCalls[0].status).toBe(200);
    const injected = requests.filter((request) => request.url !== "/api/onboard/chat");
    expect(injected.length).toBeGreaterThan(0);
    expect(credentialHeaders(requests[0].headers)).toHaveLength(6);
    for (const request of injected) {
      expect(credentialHeaders(request.headers), "E4a-R1 credential leakage").toEqual([]);
      // Pin light-my-request's exact additions; do not silently widen the set.
      expect(Object.keys(request.headers).sort()).toEqual(expectedKeys);
      expect(request.ip).toBe("127.0.0.1");
      expect(request.headers["content-type"]).toBe("application/json");
    }
    const result = response.json().toolCalls[0].result;
    if (method === "GET") {
      const query = new URL(injected[0].url, "http://injection.invalid").searchParams;
      expect(query.get("authorization")).toBe(input.authorization);
      expect(query.get("cookie")).toBe(input.cookie);
      expect(JSON.parse(query.get("headers")!)).toStrictEqual(input.headers);
      expect(result.query.authorization).toBe(input.authorization);
      expect(result.body).toBeNull();
    } else {
      expect(result.body).toStrictEqual(input);
      expect(result.query).toStrictEqual({});
    }
    expect(secondRequest).toBeDefined();
    expect(secondRequest!.messages.some((message: { content: unknown }) => Array.isArray(message.content)
      && message.content.some((block: { type: string; tool_use_id?: string }) => block.type === "tool_result" && block.tool_use_id === "tool_fake_1"))).toBe(true);
  }, TIMEOUT);

  it("E4a-R1 positive control rejects credential headers; near miss keeps them in input", () => {
    for (const key of ["authorization", "cookie", "x-api-key", "proxy-authorization", "x-forwarded-for", "x-pcc-anything", "X-PCC-Admin"]) {
      expect(credentialHeaders({ [key]: "planted" }), `E4a-R1 ${key}`).toEqual([key]);
    }
    expect(credentialHeaders({ "content-type": "application/json", host: "localhost", "user-agent": "lightMyRequest" })).toEqual([]);
  }, TIMEOUT);

  it("E4a-R2 no gateway auth or middleware trusts loopback", () => {
    const files = listRepoFiles(REPO);
    for (const folder of ["middleware", "auth"]) {
      expect(files.filter((file) => isRuntimeFile(file) && file.startsWith(`packages/gateway/src/${folder}/`)).length, `E4a-R2 ${folder} scope is populated`).toBeGreaterThan(0);
    }
    expect(scanLoopbackTrust(REPO, files), "E4a-R2 file/enclosing/expression findings").toEqual([]);
  }, TIMEOUT);

  it("E4a-R2 positive controls catch both comparison orders and helper calls; near misses stay clean", () => {
    const root = mkdtempSync(join(tmpdir(), "pcc-loopback-proof-"));
    try {
      const file = "packages/gateway/src/auth/planted.ts";
      const near = "packages/gateway/src/middleware/near.ts";
      const excluded = "packages/gateway/src/auth/__tests__/loopback.test.ts";
      const sources = {
        [file]: `function authorize(req) {
          if (req.ip === "127.0.0.1") return true;
          if ("::1" == req.socket.remoteAddress) return true;
          if (req.ip !== "::ffff:127.0.0.1") return true;
          if ("localhost" != req.ip) return true;
          if ((req.ip as string) === "127.0.0.1") return true;
          if (isLoopback(req)) return true;
          return guards["isLocalRequest"](req);
        }`,
        [near]: `// req.ip === "127.0.0.1"; isLoopback(req)
          const text = 'isLocalRequest(req)';
          const cors = "http://localhost:5173";
          function isLoopback(req) { return false; }
          function check(req) { return req.hostname === "localhost" || req.ip === "198.51.100.8"; }`,
        [excluded]: `const trusted = req.ip === "127.0.0.1";`,
      };
      for (const [path, source] of Object.entries(sources)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), source);
      }
      const findings = scanLoopbackTrust(root, Object.keys(sources));
      expect(findings).toHaveLength(7);
      expect(findings.every((finding) => finding.rule === "E4a-R2" && finding.file === file && finding.enclosing === "authorize")).toBe(true);
      expect(scanLoopbackTrust(root, [near, excluded])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
