/**
 * Live agent-package.json loader.
 *
 * We fetch `<gateway>/agent-package.json` once at session start, so the
 * tools list + system_prompt the CLI runs with stay in lockstep with
 * production. The same file backs the gateway's dashboard chat (#159) and
 * any other LLM that consumes PCC's public 219-tool surface.
 *
 * No caching across sessions on disk — the gateway evolves quickly enough
 * that a stale local copy is worse than a 200 ms refresh.
 */

export interface AgentPackageTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  endpoint?: { method: string; path: string };
}

export interface AgentPackage {
  system_prompt: string;
  tools: AgentPackageTool[];
  toolCount?: number;
  /** Version of the agent-package shape, surfaced by the gateway. */
  version?: string;
}

export class AgentPackageError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentPackageError";
  }
}

/**
 * Fetch the agent package from the gateway. Throws AgentPackageError on any
 * failure (network, non-2xx, malformed JSON, missing system_prompt).
 *
 * @param gatewayUrl Base URL of the gateway (no trailing slash needed).
 * @param fetchFn Override the global fetch (test injection).
 * @param signal Optional AbortSignal so the caller can time out.
 */
export async function fetchAgentPackage(
  gatewayUrl: string,
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<AgentPackage> {
  const base = gatewayUrl.replace(/\/+$/, "");
  const url = `${base}/agent-package.json`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    throw new AgentPackageError(`Failed to reach ${url}: ${(err as Error).message}`, err);
  }
  if (!res.ok) {
    throw new AgentPackageError(
      `Gateway returned ${res.status} ${res.statusText} for ${url}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new AgentPackageError(`Gateway returned non-JSON body for ${url}`, err);
  }
  if (!isValidAgentPackage(body)) {
    throw new AgentPackageError(
      `Gateway response from ${url} is missing system_prompt or tools[]`,
    );
  }
  return body;
}

function isValidAgentPackage(value: unknown): value is AgentPackage {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.system_prompt === "string" &&
    v.system_prompt.length > 0 &&
    Array.isArray(v.tools)
  );
}
