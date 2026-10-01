/**
 * The hosted agent's tools are the pinned package's tools, called through the
 * gateway's MCP server AS THE USER.
 *
 * A signed-in session sends the user's own Bearer key to /mcp. A keyless
 * session sends no credential, to the read-only /mcp/apps. The key lives only
 * in this session's transport: it is never logged, never shown to the model,
 * and never put in a report. Every tool result, and every tool ERROR, is
 * scrubbed of secret-shaped values before the model sees it, because whatever
 * the model sees can reach the transcript. A raw transport error never leaves
 * this module: what is thrown is a fresh, scrubbed, bounded Error.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GatedTool } from "./confirm.js";
import type { PinnedPack } from "./pack.js";

export interface ToolTransport {
  /** The version the server announced when the session was opened. The gateway
   * reports `<pack version>+sha256.<hex of the exact pack bytes>`, which is how
   * a session proves it runs the pinned pack. Undefined when it announced none. */
  serverVersion(): string | undefined;
  /** The tool names the connected surface serves (/mcp/apps serves a read-only subset). */
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** JSON field names whose values are secrets, whatever they contain. A name is
 * compared in lower case with `_` and `-` removed, so token, accessToken,
 * access_token and access-token are one name. Only WHOLE names match:
 * max_tokens, tokenCount and secretary are kept. */
const SECRET_FIELDS: ReadonlySet<string> = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "authtoken", "bearertoken",
  "apikey", "rawkey", "secret", "clientsecret", "password", "passphrase", "privatekey",
  "mnemonic", "seed", "seedphrase", "bearer", "authorization",
]);

const isSecretField = (name: string): boolean => SECRET_FIELDS.has(name.toLowerCase().replace(/[_-]/g, ""));

/** Secret-shaped strings. A bare 0x-prefixed 32-byte hex is NOT scrubbed:
 * transaction hashes and evidence digests have that shape, and the agent must
 * be able to show them. */
const SECRET_STRINGS: readonly RegExp[] = [
  /\bpcc_(live|test)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // A bare JWT (header.payload.signature), wherever it sits: a session token has this shape.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
];

export const REDACTED = "[redacted]";

/** A `"name": "value"` pair inside text that is not itself JSON, an error body
 * after a prefix for example. Only the value of a secret-named field is redacted. */
const JSON_STRING_PAIR = /("([A-Za-z0-9_-]{1,64})"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

export function scrubText(text: string): string {
  const shapes = SECRET_STRINGS.reduce((t, re) => t.replace(re, REDACTED), text);
  return shapes.replace(JSON_STRING_PAIR, (whole, head: string, name: string) => (isSecretField(name) ? `${head}"${REDACTED}"` : whole));
}

export function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretField(k) ? REDACTED : scrub(v);
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

/** The most of a tool's error message the model is shown: enough to act on, never a whole response body. */
export const TOOL_ERROR_LIMIT = 2_000;

/**
 * A tool failure as the model may see it: the message scrubbed with the same
 * rules as a tool result, then bounded. It is a FRESH Error: no `cause`, none
 * of the transport's own fields, so nothing raw reaches LLMAgent.
 */
export function toolError(err: unknown): Error {
  const message =
    typeof err === "string"
      ? err
      : err !== null && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "the tool call failed";
  // Cap the work first, scrub, then cap what is shown: a secret the first cap cut in two is dropped by the last.
  const scrubbed = scrubText(message.slice(0, 20_000));
  return new Error(scrubbed.length > TOOL_ERROR_LIMIT ? `${scrubbed.slice(0, TOOL_ERROR_LIMIT)}…` : scrubbed);
}

/** Run a transport step; whatever it throws leaves as a scrubbed, bounded Error. */
async function sanitized<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw toolError(err);
  }
}

/** Connect to the gateway's MCP server as the user: /mcp with their key, or /mcp/apps with none. */
export async function connectMcp(gatewayBase: string, credential: string | null): Promise<ToolTransport> {
  const url = new URL(credential === null ? "/mcp/apps" : "/mcp", gatewayBase);
  const headers: Record<string, string> = credential === null ? {} : { authorization: `Bearer ${credential}` };
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  const client = new Client({ name: "pcc-hosted-agent", version: "0.1.0" });
  await sanitized(() => client.connect(transport));
  return {
    serverVersion: () => client.getServerVersion()?.version,
    listTools: () =>
      sanitized(async () => {
        const names: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          names.push(...page.tools.map((t) => t.name));
          cursor = page.nextCursor;
        } while (cursor);
        return names;
      }),
    callTool: (name, args) =>
      sanitized(async () => {
        const result = await client.callTool({ name, arguments: args });
        const { isError, value } = scrubToolResult(result as { content?: unknown; isError?: unknown });
        if (isError) throw new Error(typeof value === "string" ? value : JSON.stringify(value));
        return value;
      }),
    close: () => client.close(),
  };
}

/** The pinned package's tools that the connected surface serves, each calling
 * through the session's transport. Whatever the transport returns or throws is
 * scrubbed here as well, so a transport that does not scrub (an injected one)
 * still cannot put a secret in front of the model or the confirming user. */
export function packTools(pack: PinnedPack, transport: ToolTransport, served: ReadonlySet<string>): GatedTool[] {
  return pack.tools.filter(({ def }) => served.has(def.name)).map(({ def, spec }) => ({
    def,
    spec,
    caller: async (input: unknown) => {
      try {
        return scrub(await transport.callTool(def.name, input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}));
      } catch (err) {
        throw toolError(err);
      }
    },
  }));
}
