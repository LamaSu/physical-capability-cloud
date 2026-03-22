/**
 * UnbrowseClient — HTTP client for the Unbrowse API.
 *
 * Provides AI agents with direct API access to any website via Unbrowse's
 * intent resolution, skill search, and skill execution endpoints.
 *
 * Architecture:
 *   Agent → UnbrowseClient → localhost:6969 → beta-api.unbrowse.ai (marketplace)
 *
 * Three-tier resolution:
 *   1. Marketplace search (semantic vector match, 50-200ms)
 *   2. Live capture (headless browser → reverse-engineer APIs, 5-30s)
 *   3. DOM fallback (structured data from rendered HTML)
 *
 * @see https://unbrowse.ai
 */

export interface UnbrowseClientConfig {
  /** Unbrowse server URL (default: http://localhost:6969) */
  serverUrl?: string;
  /**
   * Use gateway proxy mode. When true, routes requests through
   * PCC gateway at /api/unbrowse/* instead of direct Unbrowse API.
   * Auto-detected when serverUrl contains "/api/unbrowse".
   */
  gatewayMode?: boolean;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Whether to use dry_run for mutations by default (default: true) */
  dryRunByDefault?: boolean;
}

/** Result from intent resolution */
export interface UnbrowseResolveResult {
  skill_id?: string;
  /** The raw data returned by the resolved API call */
  data: unknown;
  /** How the result was obtained */
  source: "marketplace" | "capture" | "dom_fallback";
  /** Execution time in ms */
  duration_ms: number;
  /** The discovered API endpoint */
  endpoint?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  };
}

/** A skill in the Unbrowse marketplace */
export interface UnbrowseSkill {
  id: string;
  intent: string;
  domain: string;
  endpoint: {
    method: string;
    url: string;
  };
  /** Composite confidence score (0-1) */
  confidence: number;
  /** Metadata from the marketplace */
  metadata?: {
    domain?: string;
    reliability?: number;
    freshness?: number;
    verified?: boolean;
  };
}

/** Search results from the marketplace */
export interface UnbrowseSearchResult {
  results: UnbrowseSkill[];
  total: number;
  query: string;
}

/** Feedback for a skill execution */
export interface UnbrowseFeedback {
  skill_id: string;
  rating: 1 | 2 | 3 | 4 | 5;
  comment?: string;
}

export class UnbrowseClient {
  private readonly serverUrl: string;
  private readonly gatewayMode: boolean;
  private readonly timeout: number;
  private readonly dryRunByDefault: boolean;
  private available: boolean | null = null;

  constructor(config?: UnbrowseClientConfig) {
    const raw = (config?.serverUrl ?? process.env.UNBROWSE_URL ?? "http://localhost:6969").replace(/\/$/, "");
    this.gatewayMode = config?.gatewayMode ?? raw.includes("/api/unbrowse");
    // In gateway mode the base URL already includes /api/unbrowse
    this.serverUrl = raw;
    this.timeout = config?.timeout ?? 30_000;
    this.dryRunByDefault = config?.dryRunByDefault ?? true;
  }

  /** Check if the Unbrowse server is reachable */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const res = await this.fetch("/health", { method: "GET" });
      this.available = res.ok;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  /**
   * Resolve an intent — the main entry point.
   * Unbrowse will search marketplace, capture if needed, and return data.
   */
  async resolve(intent: string, url: string, opts?: {
    params?: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<UnbrowseResolveResult> {
    const start = Date.now();
    const res = await this.fetch("/v1/intent/resolve", {
      method: "POST",
      body: JSON.stringify({
        intent,
        params: { url, ...opts?.params },
        context: { url },
        dry_run: opts?.dryRun ?? this.dryRunByDefault,
      }),
    });

    if (!res.ok) {
      throw new UnbrowseError(`Intent resolution failed: ${res.status} ${res.statusText}`, res.status);
    }

    const data = await res.json();
    return {
      skill_id: data.skill_id,
      data: data.data ?? data.result ?? data,
      source: data.source ?? "marketplace",
      duration_ms: Date.now() - start,
      endpoint: data.endpoint,
    };
  }

  /**
   * Search the Unbrowse marketplace for skills matching an intent.
   * Returns ranked results by composite score (embedding similarity + reliability + freshness).
   */
  async search(query: string, opts?: {
    k?: number;
    domain?: string;
  }): Promise<UnbrowseSearchResult> {
    const res = await this.fetch("/v1/search", {
      method: "POST",
      body: JSON.stringify({
        intent: query,
        k: opts?.k ?? 10,
        ...(opts?.domain ? { domain: opts.domain } : {}),
      }),
    });

    if (!res.ok) {
      throw new UnbrowseError(`Search failed: ${res.status}`, res.status);
    }

    const data = await res.json();
    return {
      results: data.results ?? [],
      total: data.total ?? data.results?.length ?? 0,
      query,
    };
  }

  /**
   * Execute a specific skill by ID.
   */
  async executeSkill(skillId: string, params?: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetch(`/v1/skills/${skillId}/execute`, {
      method: "POST",
      body: JSON.stringify({ params: params ?? {} }),
    });

    if (!res.ok) {
      throw new UnbrowseError(`Skill execution failed: ${res.status}`, res.status);
    }

    return res.json();
  }

  /**
   * Report feedback on a skill execution (improves marketplace quality).
   */
  async feedback(fb: UnbrowseFeedback): Promise<void> {
    await this.fetch("/v1/feedback", {
      method: "POST",
      body: JSON.stringify(fb),
    });
  }

  /**
   * Search for external capabilities not in the PCC network.
   * Convenience method that searches Unbrowse for manufacturing/supplier skills.
   */
  async searchExternalCapabilities(query: string): Promise<Array<{
    source: string;
    domain: string;
    intent: string;
    confidence: number;
    skillId: string;
  }>> {
    const result = await this.search(query, { k: 20 });
    return result.results.map((r) => ({
      source: "unbrowse",
      domain: r.metadata?.domain ?? r.domain,
      intent: r.intent,
      confidence: r.confidence,
      skillId: r.id,
    }));
  }

  /**
   * Resolve a supplier query — fetch real data from an external vendor site.
   * Used by BrokerAgent for market-aware routing.
   */
  async resolveSupplierQuery(supplierUrl: string, query: string): Promise<{
    data: unknown;
    source: string;
    durationMs: number;
  }> {
    const result = await this.resolve(query, supplierUrl, { dryRun: true });
    return {
      data: result.data,
      source: result.source,
      durationMs: result.duration_ms,
    };
  }

  // ── Internal ──────────────────────────────────────────────────

  /**
   * Map direct Unbrowse paths to gateway proxy paths.
   *
   * Direct:  /health              → /health
   *          /v1/search           → /v1/search
   *          /v1/intent/resolve   → /v1/intent/resolve
   *          /v1/skills/:id/execute → /v1/skills/:id/execute
   *          /v1/feedback         → /v1/feedback
   *
   * Gateway: /health              → /api/unbrowse/health
   *          /v1/search           → /api/unbrowse/search
   *          /v1/intent/resolve   → /api/unbrowse/resolve
   *          /v1/skills/:id/execute → /api/unbrowse/execute/:id
   *          /v1/feedback         → /api/unbrowse/feedback
   */
  private mapPath(path: string): string {
    if (!this.gatewayMode) return path;

    // Gateway mode: the serverUrl already ends with /api/unbrowse
    // so we just need to map the path suffix
    if (path === "/health") return "/health";
    if (path === "/v1/search") return "/search";
    if (path === "/v1/intent/resolve") return "/resolve";
    if (path === "/v1/feedback") return "/feedback";

    // /v1/skills/:id/execute → /execute/:id
    const skillExec = path.match(/^\/v1\/skills\/([^/]+)\/execute$/);
    if (skillExec) return `/execute/${skillExec[1]}`;

    // Fallback: pass through
    return path;
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const mappedPath = this.mapPath(path);

    try {
      return await globalThis.fetch(`${this.serverUrl}${mappedPath}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export class UnbrowseError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "UnbrowseError";
  }
}
