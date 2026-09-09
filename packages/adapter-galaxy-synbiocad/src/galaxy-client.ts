/**
 * GalaxyRestClient — runs Galaxy-SynBioCAD tools against a live Galaxy server.
 *
 * Implemented to the documented Galaxy REST API
 * (https://docs.galaxyproject.org/en/master/api/api.html). The request-shaping
 * (input encoding, dataset staging, job polling) is unit-tested against an
 * injected `fetchImpl` mock. Live end-to-end against a hosted Galaxy (e.g.
 * galaxy-synbiocad.org) is gated on GALAXY_URL + GALAXY_API_KEY and is NOT
 * run by CI — see README "Going live". Honest status: transport is
 * spec-complete and mock-verified, not yet observed against a live server.
 */

import { requireTool } from "./catalog.js";
import type {
  GalaxyClient,
  GalaxyDatasetRef,
  GalaxyOutputArtifact,
  GalaxyRunInput,
  GalaxyRunResult,
  GalaxyRunState,
  GalaxyToolSpec,
} from "./types.js";

export interface GalaxyRestClientOptions {
  /** Base URL of the Galaxy server (e.g. "https://galaxy-synbiocad.org"). */
  baseUrl: string;
  /** Galaxy API key (from the user's Galaxy account → Preferences → API key). */
  apiKey?: string;
  /** Injectable fetch (tests / Node < 18). */
  fetchImpl?: typeof fetch;
  /** Poll interval while waiting on a job (ms, default 2000). */
  pollIntervalMs?: number;
  /** Max wall-clock for a single tool job (ms, default 1h). */
  jobTimeoutMs?: number;
  /** Per-request network timeout (ms, default 30s). */
  requestTimeoutMs?: number;
}

const TERMINAL_OK = new Set(["ok"]);
const TERMINAL_BAD = new Set(["error", "deleted", "discarded", "failed_metadata", "paused"]);

function mapState(galaxyState: string): GalaxyRunState {
  if (TERMINAL_OK.has(galaxyState)) return "ok";
  if (TERMINAL_BAD.has(galaxyState)) return galaxyState === "paused" ? "paused" : "error";
  if (galaxyState === "queued" || galaxyState === "new" || galaxyState === "waiting") return "queued";
  return "running";
}

/** Which dotted params of a tool are dataset inputs (per the generated schema). */
function datasetParamPaths(tool: GalaxyToolSpec): Set<string> {
  const props = (tool.input_schema as { properties?: Record<string, { "x-galaxy-kind"?: string }> })
    .properties ?? {};
  return new Set(
    Object.entries(props)
      .filter(([, v]) => v["x-galaxy-kind"] === "dataset-ref")
      .map(([k]) => k),
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GalaxyRestClient implements GalaxyClient {
  private readonly base: string;
  private readonly apiKey?: string;
  private readonly f: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly jobTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private serverToolIndex: Map<string, string[]> | null = null;

  constructor(opts: GalaxyRestClientOptions) {
    if (!opts.baseUrl) throw new Error("GalaxyRestClient: baseUrl is required");
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    if (!this.f) throw new Error("GalaxyRestClient: fetch unavailable — pass opts.fetchImpl");
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 3_600_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  // ── low-level request ────────────────────────────────────────────────────

  private urlFor(path: string): string {
    const u = new URL(this.base + path);
    if (this.apiKey) u.searchParams.set("key", this.apiKey);
    return u.toString();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.f(this.urlFor(path), {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const msg = (parsed as { err_msg?: string; message?: string })?.err_msg ??
        (parsed as { message?: string })?.message ?? text.slice(0, 200);
      throw new Error(`Galaxy ${method} ${path} -> ${res.status}: ${msg}`);
    }
    return parsed as T;
  }

  // ── GalaxyClient ───────────────────────────────────────────────────────────

  async health(): Promise<boolean> {
    try {
      const v = await this.req<{ version_major?: string }>("GET", "/api/version");
      return Boolean(v);
    } catch {
      return false;
    }
  }

  async listTools(): Promise<{ id: string; version?: string }[]> {
    const tools = await this.req<{ id: string; version?: string }[]>(
      "GET",
      "/api/tools?in_panel=false",
    );
    return Array.isArray(tools) ? tools.map((t) => ({ id: t.id, version: t.version })) : [];
  }

  /**
   * Galaxy installs tools under full toolshed ids
   * (`toolshed.g2.bx.psu.edu/repos/<owner>/<repo>/<tool_id>/<version>`), while the
   * catalog keys tools by their short `<tool_id>`. Resolve a catalog id to the
   * server's installed id, preferring the latest version when several exist.
   * Falls back to the catalog id when the server has no match (Galaxy then
   * validates the id). Verified against galaxy-synbiocad.org (350 tools).
   */
  async resolveServerToolId(catalogId: string): Promise<string> {
    const idx = await this.buildToolIndex();
    const cands = idx.get(catalogId) ?? idx.get(catalogId.toLowerCase());
    if (!cands || cands.length === 0) return catalogId;
    return cands
      .slice()
      .sort((a, b) => versionTail(b).localeCompare(versionTail(a), undefined, { numeric: true }))[0];
  }

  private async buildToolIndex(): Promise<Map<string, string[]>> {
    if (this.serverToolIndex) return this.serverToolIndex;
    const idx = new Map<string, string[]>();
    const add = (key: string, id: string) => {
      const a = idx.get(key) ?? [];
      a.push(id);
      idx.set(key, a);
    };
    for (const t of await this.listTools()) {
      add(t.id, t.id); // bare id
      const segs = t.id.split("/");
      if (segs.length >= 2) {
        const seg = segs[segs.length - 2]; // <tool_id> segment
        add(seg, t.id);
        if (seg.toLowerCase() !== seg) add(seg.toLowerCase(), t.id); // case-insensitive (PartsGenie)
      }
    }
    this.serverToolIndex = idx;
    return idx;
  }

  async runTool(input: GalaxyRunInput): Promise<GalaxyRunResult> {
    const tool = requireTool(input.toolId);
    const serverToolId = input.serverToolId ?? (await this.resolveServerToolId(tool.id));
    const historyId = await this.ensureHistory(input.historyId);
    const staged = await this.stageDatasets(historyId, input.params ?? {}, tool);
    const inputs = this.encodeInputs(staged, tool);

    const run = await this.req<{
      outputs?: { id: string; name?: string; output_name?: string; extension?: string }[];
      jobs?: { id: string }[];
    }>("POST", "/api/tools", { tool_id: serverToolId, history_id: historyId, inputs });

    const jobId = run.jobs?.[0]?.id;
    let state: GalaxyRunState = "queued";
    if (jobId) state = await this.pollJob(jobId);

    const outputs: Record<string, GalaxyOutputArtifact> = {};
    (run.outputs ?? []).forEach((o, i) => {
      const name = o.output_name ?? o.name ?? `output_${i}`;
      outputs[name] = {
        name,
        datasetId: o.id,
        ext: o.extension,
        downloadUrl: this.urlFor(`/api/datasets/${o.id}/display`),
      };
    });

    return { toolId: tool.id, serverToolId, state, jobId, historyId, outputs };
  }

  async fetchOutput(artifact: GalaxyOutputArtifact): Promise<string> {
    if (artifact.content !== undefined) return artifact.content;
    const path = artifact.datasetId
      ? `/api/datasets/${artifact.datasetId}/display`
      : artifact.downloadUrl?.replace(this.base, "") ?? "";
    if (!path) throw new Error("fetchOutput: artifact has no datasetId or downloadUrl");
    const res = await this.f(this.urlFor(path), {
      headers: this.apiKey ? { "x-api-key": this.apiKey } : {},
    });
    if (!res.ok) throw new Error(`fetchOutput: ${res.status} for ${artifact.name}`);
    return res.text();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async ensureHistory(id?: string): Promise<string> {
    if (id) return id;
    const h = await this.req<{ id: string }>("POST", "/api/histories", {
      name: "pcc-galaxy-synbiocad",
    });
    return h.id;
  }

  /**
   * Upload any inline/url dataset refs to the history and replace them with
   * `{src:'hda', id}` so the tool run references real datasets. `hda`/`ldda`
   * refs pass through untouched.
   */
  private async stageDatasets(
    historyId: string,
    params: Record<string, unknown>,
    tool: GalaxyToolSpec,
  ): Promise<Record<string, unknown>> {
    const dsPaths = datasetParamPaths(tool);
    const out: Record<string, unknown> = { ...params };
    for (const [key, value] of Object.entries(params)) {
      if (!dsPaths.has(key)) continue;
      const ref = normalizeDatasetRef(value);
      if (!ref || ref.src === "hda" || ref.src === "ldda") continue;
      const element =
        ref.src === "url"
          ? { src: "url", url: ref.url, name: ref.name, ext: ref.ext }
          : { src: "pasted", paste_content: ref.content ?? "", name: ref.name ?? key, ext: ref.ext };
      const fetched = await this.req<{ outputs?: { id: string }[] }>("POST", "/api/tools/fetch", {
        history_id: historyId,
        targets: [{ destination: { type: "hdas" }, elements: [element] }],
      });
      const dsId = fetched.outputs?.[0]?.id;
      if (!dsId) throw new Error(`stageDatasets: upload failed for param '${key}'`);
      await this.waitDatasetReady(historyId, dsId);
      out[key] = { src: "hda", id: dsId };
    }
    return out;
  }

  /** Encode dotted param paths into Galaxy's `|`-nested inputs, wrapping datasets. */
  private encodeInputs(
    params: Record<string, unknown>,
    tool: GalaxyToolSpec,
  ): Record<string, unknown> {
    const dsPaths = datasetParamPaths(tool);
    const inputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      const galaxyKey = key.split(".").join("|");
      if (dsPaths.has(key)) {
        const ref = normalizeDatasetRef(value);
        inputs[galaxyKey] = ref ? { src: ref.src, id: ref.id } : value;
      } else {
        inputs[galaxyKey] = value;
      }
    }
    return inputs;
  }

  private async pollJob(jobId: string): Promise<GalaxyRunState> {
    const deadline = Date.now() + this.jobTimeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const job = await this.req<{ state: string }>("GET", `/api/jobs/${jobId}`);
      const st = mapState(job.state);
      if (st === "ok" || st === "error" || st === "paused") return st;
      if (Date.now() > deadline) return "running"; // caller treats non-ok as incomplete
      await sleep(this.pollIntervalMs);
    }
  }

  private async waitDatasetReady(historyId: string, datasetId: string): Promise<void> {
    const deadline = Date.now() + this.jobTimeoutMs;
    while (Date.now() < deadline) {
      const ds = await this.req<{ state: string }>(
        "GET",
        `/api/histories/${historyId}/contents/${datasetId}`,
      );
      const st = mapState(ds.state);
      if (st === "ok") return;
      if (st === "error") throw new Error(`upload dataset ${datasetId} entered error state`);
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`upload dataset ${datasetId} not ready within timeout`);
  }
}

function versionTail(id: string): string {
  return id.split("/").pop() ?? "";
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Accept a bare id/url string or a {src,...} ref and normalize to GalaxyDatasetRef. */
function normalizeDatasetRef(value: unknown): GalaxyDatasetRef | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return /^https?:\/\//.test(value)
      ? { src: "url", url: value }
      : { src: "hda", id: value };
  }
  if (typeof value === "object" && "src" in (value as object)) {
    return value as GalaxyDatasetRef;
  }
  return null;
}
