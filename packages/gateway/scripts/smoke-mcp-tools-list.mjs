#!/usr/bin/env node
/**
 * Post-deploy smoke check (board row N88): the gateway's hosted MCP server
 * must list tools.
 *
 * `initialize` answers 200 even when the MCP proxy is disabled, so a check that
 * stops there passes on a dead server. On 2026-09-29 prod did exactly that:
 * PCC_API_BASE_URL was unset, so every `tools/list` failed with -32600 and every
 * MCP client got 0 tools (the proxy fails closed by design, #271). This script
 * runs the whole handshake, `initialize`, `notifications/initialized` and then
 * `tools/list`, and fails unless `tools/list` returns at least one tool.
 *
 * Plain Node (18+) with no dependencies, so a deploy job can run it after a
 * sparse checkout without installing the workspace.
 *
 * Run:
 *   node packages/gateway/scripts/smoke-mcp-tools-list.mjs https://capability.network
 *   node packages/gateway/scripts/smoke-mcp-tools-list.mjs "$STAGING_URL" --attempts 1
 *
 * Args and env:
 *   <gateway-url>       the gateway origin (default: $PCC_GATEWAY_URL)
 *   --attempts N        tries before failing (default 6)
 *   --interval-ms N     wait between tries (default 10000)
 *
 * Exit 0 when `tools/list` returns tools; exit 1 otherwise, with the reason.
 */
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = "2025-06-18";
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/**
 * Parse a JSON-RPC reply sent either as JSON or as a Streamable-HTTP event stream
 * (`data: {...}` lines). Returns the message whose id matches, or the last one.
 */
export function parseJsonRpcBody(text, id) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const messages = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  if (messages.length === 0) throw new Error(`no JSON-RPC message in the reply: ${trimmed.slice(0, 200)}`);
  return messages.find((m) => m.id === id) ?? messages[messages.length - 1];
}

async function post(url, headers, message, timeoutMs) {
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Run the MCP handshake against `<base>/mcp` and check `tools/list`.
 * Resolves `{ ok: true, count }` or `{ ok: false, stage, reason }`; never throws.
 */
export async function checkMcpToolsList(base, { timeoutMs = 15000 } = {}) {
  let url;
  try {
    url = new URL("/mcp", base).toString();
  } catch {
    return { ok: false, stage: "config", reason: `not a URL: ${base}` };
  }
  try {
    const init = await post(
      url,
      HEADERS,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pcc-deploy-smoke", version: "1" },
        },
      },
      timeoutMs,
    );
    const initText = await init.text();
    if (!init.ok) return { ok: false, stage: "initialize", reason: `HTTP ${init.status}: ${initText.slice(0, 200)}` };
    const initReply = parseJsonRpcBody(initText, 1);
    if (initReply.error) {
      return { ok: false, stage: "initialize", reason: `${initReply.error.code}: ${initReply.error.message}` };
    }

    const session = init.headers.get("mcp-session-id");
    const headers = session ? { ...HEADERS, "mcp-session-id": session } : HEADERS;
    const initialized = await post(url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, timeoutMs);
    await initialized.text();

    const list = await post(url, headers, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, timeoutMs);
    const listText = await list.text();
    if (!list.ok) return { ok: false, stage: "tools/list", reason: `HTTP ${list.status}: ${listText.slice(0, 200)}` };
    const reply = parseJsonRpcBody(listText, 2);
    if (reply.error) return { ok: false, stage: "tools/list", reason: `${reply.error.code}: ${reply.error.message}` };
    const tools = reply.result?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      return { ok: false, stage: "tools/list", reason: "tools/list returned no tools" };
    }
    return { ok: true, count: tools.length };
  } catch (err) {
    return { ok: false, stage: "network", reason: err instanceof Error ? err.message : String(err) };
  }
}

function parseArgs(argv) {
  const opts = { base: process.env.PCC_GATEWAY_URL ?? "", attempts: 6, intervalMs: 10000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--attempts") opts.attempts = Number(argv[++i]);
    else if (arg === "--interval-ms") opts.intervalMs = Number(argv[++i]);
    else if (!arg.startsWith("--")) opts.base = arg;
  }
  return opts;
}

async function main() {
  const { base, attempts, intervalMs } = parseArgs(process.argv.slice(2));
  if (!base) {
    console.error("usage: smoke-mcp-tools-list.mjs <gateway-url> [--attempts N] [--interval-ms N]");
    process.exit(2);
  }
  let result;
  for (let i = 1; i <= Math.max(1, attempts); i++) {
    result = await checkMcpToolsList(base);
    if (result.ok) {
      console.log(`MCP smoke OK: ${new URL("/mcp", base)} lists ${result.count} tools`);
      return;
    }
    console.log(`attempt ${i}: ${result.stage}: ${result.reason}`);
    if (i < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const message = `MCP smoke FAILED at ${result.stage}: ${result.reason}`;
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
