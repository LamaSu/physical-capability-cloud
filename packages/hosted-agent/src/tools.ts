/**
 * The hosted agent's tools are the pinned package's tools, called through the
 * gateway's MCP server AS THE USER.
 *
 * A signed-in session sends the user's own Bearer key to /mcp. A keyless
 * session sends no credential, to the read-only /mcp/apps. The key lives only
 * in this session's transport: it is never logged, never shown to the model,
 * and never put in a report. Every tool result is scrubbed of secret-shaped
 * values before the model sees it, because whatever the model sees can reach
 * the transcript.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GatedTool } from "./confirm.js";
import type { PinnedPack } from "./pack.js";

export interface ToolTransport {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** JSON field names whose values are secrets, whatever they contain. */
const SECRET_FIELD =
  /^(private_?key|secret|client_?secret|mnemonic|seed(_?phrase)?|api_?key|raw_?key|password|passphrase|access_?token|refresh_?token|bearer|authorization)$/i;

/** Secret-shaped strings. A bare 0x-prefixed 32-byte hex is NOT scrubbed:
 * transaction hashes and evidence digests have that shape, and the agent must
 * be able to show them. */
const SECRET_STRINGS: readonly RegExp[] = [
  /\bpcc_(live|test)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = "[redacted]";

export function scrubText(text: string): string {
  return SECRET_STRINGS.reduce((t, re) => t.replace(re, REDACTED), text);
}

export function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) ? REDACTED : scrub(v);
    }
    return out;
  }
  return value;
}

/** A tool result's text content, parsed as JSON when it is JSON, and scrubbed. */
export function scrubToolResult(result: { content?: unknown; isError?: unknown }): { isError: boolean; value: unknown } {
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts = parts
    .filter((p): p is { type: "text"; text: string } => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text")
    .map((p) => p.text);
  const values = texts.map((t) => {
    try {
      return scrub(JSON.parse(t));
    } catch {
      return scrubText(t);
    }
  });
  return { isError: result.isError === true, value: values.length === 1 ? values[0] : values };
}

/** Connect to the gateway's MCP server as the user: /mcp with their key, or /mcp/apps with none. */
export async function connectMcp(gatewayBase: string, credential: string | null): Promise<ToolTransport> {
  const url = new URL(credential === null ? "/mcp/apps" : "/mcp", gatewayBase);
  const headers: Record<string, string> = credential === null ? {} : { authorization: `Bearer ${credential}` };
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: "pcc-hosted-agent", version: "0.1.0" });
  await client.connect(transport);
  return {
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const { isError, value } = scrubToolResult(result as { content?: unknown; isError?: unknown });
      if (isError) throw new Error(typeof value === "string" ? value : JSON.stringify(value));
      return value;
    },
    close: () => client.close(),
  };
}

/** The pinned package's tools, each calling through the session's transport. */
export function packTools(pack: PinnedPack, transport: ToolTransport): GatedTool[] {
  return pack.tools.map(({ def, spec }) => ({
    def,
    spec,
    caller: (input: unknown) =>
      transport.callTool(def.name, input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}),
  }));
}
