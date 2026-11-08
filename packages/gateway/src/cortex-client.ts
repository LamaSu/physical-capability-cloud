/**
 * Mitosis Cortex client — durable, cited memory for cross-session facts.
 *
 * Cortex is Mitosis's memory-graph product: write a fact once via `remember`,
 * retrieve it later via `ask`, and every retrieval carries a citation
 * (`universal_id` + a deep link into the graph) proving what was actually
 * stored and when. PCC's use case: let an operator/negotiation agent durably
 * record what it quoted or committed to, and later prove it — independent of
 * any one negotiation session's 30-minute TTL.
 *
 * cortex_* tools are the ONLY way to reach Cortex programmatically — Mitosis's
 * public REST API only covers pricing/status/skills/search/jobs, not memory
 * read/write. See https://mitosislabs.ai/cortex/llms.txt.
 *
 * Auth: a static `mi_` API key (from the Mitosis dashboard) sent as a bearer
 * token over the MCP Streamable HTTP transport — not the interactive OAuth
 * browser flow, which has no place in a backend service.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MITOSIS_MCP_URL = process.env.MITOSIS_MCP_URL ?? "https://mitosislabs.ai/api/mcp";
const MITOSIS_API_KEY = process.env.MITOSIS_API_KEY;

export class CortexUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CortexUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface CortexRememberResult {
  status: string;
  universal_id: string;
  retrievable_at: string;
}

export interface CortexAskMatch {
  universal_id: string;
  score: number;
  title: string;
  preview: string;
}

export interface CortexAskResult {
  results: CortexAskMatch[];
  cited_graph_url: string;
  took_ms: number;
}

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  if (!MITOSIS_API_KEY) {
    return Promise.reject(new CortexUnavailableError("MITOSIS_API_KEY is not configured"));
  }
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new Client({ name: "pcc-gateway", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL(MITOSIS_MCP_URL), {
        requestInit: { headers: { Authorization: `Bearer ${MITOSIS_API_KEY}` } },
      });
      await client.connect(transport);
      return client;
    })().catch((err: unknown) => {
      clientPromise = null; // allow retry on next call rather than caching a dead connection
      throw new CortexUnavailableError("Failed to connect to Mitosis Cortex", err);
    });
  }
  return clientPromise;
}

async function callCortexTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new CortexUnavailableError(`Cortex tool ${name} returned an error result`);
  }
  const content = "content" in result && Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text",
  );
  if (!textBlock) {
    throw new CortexUnavailableError(`Cortex tool ${name} returned no text content`);
  }
  return JSON.parse(textBlock.text) as T;
}

/** Persist a fact durably, with a citable universal_id for later proof. */
export async function cortexRemember(input: {
  text: string;
  kind?: string;
  confidence?: number;
  sourceUniversalIds?: string[];
}): Promise<CortexRememberResult> {
  return callCortexTool<CortexRememberResult>("cortex_remember", {
    text: input.text,
    kind: input.kind,
    confidence: input.confidence,
    source_universal_ids: input.sourceUniversalIds,
  });
}

/** Ask Cortex a question; every result carries a citable universal_id + graph URL. */
export async function cortexAsk(question: string, opts?: { limit?: number }): Promise<CortexAskResult> {
  return callCortexTool<CortexAskResult>("cortex_ask", { question, limit: opts?.limit });
}

/**
 * Best-effort variant: never throws, logs and returns null on any failure.
 * Use this at call sites on the money path — a memory-write failure must
 * never block or fail a negotiation/settlement action.
 */
export async function cortexRememberBestEffort(
  input: Parameters<typeof cortexRemember>[0],
): Promise<CortexRememberResult | null> {
  try {
    return await cortexRemember(input);
  } catch (err) {
    console.warn("[cortex-client] cortexRemember failed (non-fatal):", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function closeCortexClient(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  await client?.close();
}
