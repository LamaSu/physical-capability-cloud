/**
 * Typed client for the Zeon Systems sync service.
 *
 * Endpoint list extracted from the installed `zeon==1.2.2` CLI
 * (`zeon/sync/client.py`) rather than from documentation, because Zeon publishes
 * no OpenAPI spec and `api.zeonsystems.app` is an AWS API Gateway that returns
 * 403 `MissingAuthenticationTokenException` to unauthenticated probes.
 *
 * The service is a content-addressed git-over-HTTP store: blobs -> trees ->
 * commits -> refs, plus a shared mesh-database catalog and an identity endpoint.
 *
 * IMPORTANT — there is no execution endpoint. The full surface is enumerated in
 * ZEON_ROUTES below; grepping the CLI package for `/runs`, `/execute`,
 * `/simulate`, or `/jobs` returns nothing. Zeon runs are started from the
 * Workflow Editor UI by an operator. Anything in PCC that needs a Zeon run
 * executed must model that as a human step, not an API call. See
 * `ZeonAdapter.prepareRun`.
 */

const DEFAULT_SYNC_URL = "https://zeonsystems.app/sync";

/** Every route the official client exposes, for reference and for tests. */
export const ZEON_ROUTES = {
  listProjects: { method: "GET", path: "/projects" },
  createProject: { method: "POST", path: "/projects" },
  getProject: { method: "GET", path: "/projects/{pid}" },
  patchProject: { method: "PATCH", path: "/projects/{pid}" },
  archiveProject: { method: "DELETE", path: "/projects/{pid}" },
  listRefs: { method: "GET", path: "/projects/{pid}/refs" },
  getRef: { method: "GET", path: "/projects/{pid}/refs/{ref}" },
  updateRef: { method: "PUT", path: "/projects/{pid}/refs/{ref}" },
  getCommit: { method: "GET", path: "/projects/{pid}/commits/{sha}" },
  postCommit: { method: "POST", path: "/projects/{pid}/commits" },
  getTree: { method: "GET", path: "/projects/{pid}/trees/{sha}" },
  postTree: { method: "POST", path: "/projects/{pid}/trees" },
  getBlob: { method: "GET", path: "/projects/{pid}/blobs/{sha}" },
  postBlob: { method: "POST", path: "/projects/{pid}/blobs" },
  log: { method: "GET", path: "/projects/{pid}/log" },
  diff: { method: "GET", path: "/projects/{pid}/diff" },
  snapshot: { method: "GET", path: "/projects/{pid}/snapshot" },
  listMesh: { method: "GET", path: "/mesh-database" },
  getMeshItem: { method: "GET", path: "/mesh-database/{name}" },
  getMeshBlob: { method: "GET", path: "/mesh-database/{name}/blobs/{file}" },
  me: { method: "GET", path: "/me" },
  healthz: { method: "GET", path: "/healthz" },
} as const;

export class ZeonSyncError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly code?: string,
  ) {
    super(`Zeon sync ${status}: ${detail}`);
    this.name = "ZeonSyncError";
  }
}

export interface ZeonSyncConfig {
  /** Base sync URL. Defaults to https://zeonsystems.app/sync */
  baseUrl?: string;
  /**
   * A `zat_`-prefixed Zeon API token.
   *
   * Note the blast radius before wiring this into anything shared: Zeon tokens
   * have NO scopes. A token grants everything the owning user can do across
   * every project they can see, and a leaked token cannot be narrowed — only
   * revoked. Treat it as a full credential, never as a read-only key.
   */
  apiToken: string;
  /** Per-request timeout in ms. Default 30_000. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ZeonProject {
  project_id: string;
  name: string;
  description?: string;
  archived_at?: string | null;
  [k: string]: unknown;
}

export interface ZeonMeshItem {
  name: string;
  tags?: string[];
  file_count?: number;
  visibility?: string;
  [k: string]: unknown;
}

export interface ZeonIdentity {
  user_id: string;
  email: string;
  org_id: string;
  [k: string]: unknown;
}

/** Minimal, dependency-free client over the sync REST surface. */
export class ZeonSyncClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(config: ZeonSyncConfig) {
    if (!config.apiToken) {
      throw new Error("ZeonSyncClient: apiToken is required");
    }
    if (!config.apiToken.startsWith("zat_")) {
      // Fail loudly rather than sending a malformed credential and reading a 403
      // as "the service is down".
      throw new Error(
        `ZeonSyncClient: apiToken must be a zat_-prefixed Zeon API token ` +
          `(got a ${config.apiToken.length}-char value starting "` +
          `${config.apiToken.slice(0, 4)}")`,
      );
    }
    this.baseUrl = (config.baseUrl ?? DEFAULT_SYNC_URL).replace(/\/+$/, "");
    this.token = config.apiToken;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.doFetch = config.fetchImpl ?? fetch;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new ZeonSyncError(
        0,
        ctrl.signal.aborted ? `request timed out after ${this.timeoutMs}ms` : reason,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      let code: string | undefined;
      try {
        const parsed = JSON.parse(text) as { detail?: string; code?: string };
        if (parsed && typeof parsed === "object") {
          detail = parsed.detail ?? text;
          code = parsed.code;
        }
      } catch {
        /* non-JSON error body — keep the raw text */
      }
      throw new ZeonSyncError(res.status, detail, code);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** GET /healthz — no auth semantics assumed, but the token is still sent. */
  healthz(): Promise<{ status?: string }> {
    return this.request("GET", "/healthz");
  }

  /** GET /me — resolves the token to user_id / email / org_id. */
  me(): Promise<ZeonIdentity> {
    return this.request("GET", "/me");
  }

  listProjects(includeArchived = false): Promise<{ projects?: ZeonProject[] }> {
    return this.request("GET", "/projects", {
      query: includeArchived ? { include_archived: "1" } : undefined,
    });
  }

  getProject(projectId: string): Promise<ZeonProject> {
    return this.request("GET", `/projects/${encodeURIComponent(projectId)}`);
  }

  /** GET /projects/{pid}/snapshot — the full tree at a ref. */
  snapshot(
    projectId: string,
    ref = "refs/heads/main",
  ): Promise<{ files?: Record<string, unknown>; sha?: string }> {
    return this.request("GET", `/projects/${encodeURIComponent(projectId)}/snapshot`, {
      query: { ref },
    });
  }

  log(projectId: string, limit = 50): Promise<{ commits?: unknown[] }> {
    return this.request("GET", `/projects/${encodeURIComponent(projectId)}/log`, {
      query: { limit },
    });
  }

  listMeshDatabase(tag?: string): Promise<{ items?: ZeonMeshItem[] }> {
    return this.request("GET", "/mesh-database", { query: tag ? { tag } : undefined });
  }

  getMeshItem(name: string): Promise<ZeonMeshItem> {
    return this.request("GET", `/mesh-database/${encodeURIComponent(name)}`);
  }
}
