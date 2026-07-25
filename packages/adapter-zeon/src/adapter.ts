/**
 * ZeonAdapter — bridges PCC to a Zeon Systems project.
 *
 * Why this is a *digital* kernel and not a `MachineAdapter`:
 *
 * `MachineAdapter` (see adapter-pylabrobot, hamilton-adapter) models a device you
 * can command — `execute({type: "start"})` kicks a run and evidence streams back.
 * Zeon cannot be commanded. Its cloud API is an authoring store with no execution
 * route of any kind, and a run is started by a human pressing Run in the Workflow
 * Editor, behind two preflight gates (a fresh wrist-camera frame and a pipette
 * home). Implementing `MachineAdapter.start` here would produce a method that
 * returns success while starting nothing — the worst possible failure mode for a
 * settlement layer, because PCC would bill and receipt work that never ran.
 *
 * So the honest decomposition is:
 *   - things PCC CAN do through Zeon's API  -> real capabilities below
 *   - starting a run                         -> `prepareRun()`, which returns a
 *                                               human-step descriptor and never
 *                                               claims execution
 *
 * If Zeon later ships `POST /sync/projects/{pid}/verify` (a stub today, and the
 * retired per-user gateway before it) or an execution route, `prepareRun` is the
 * single place that changes.
 */

import {
  ZeonSyncClient,
  ZeonSyncError,
  type ZeonIdentity,
  type ZeonMeshItem,
  type ZeonSyncConfig,
} from "./sync-client.js";

/** Labware a TEM-1 nitrocefin screen needs present in the loaded world. */
export const TEM1_REQUIRED_LABWARE = [
  "wellplate_96_flat",
  "wellplate_96_round",
  "tiprack",
  "reservoir",
] as const;

export interface ZeonAdapterConfig extends ZeonSyncConfig {
  /** Zeon project id (the cloud record's identity, not the display name). */
  projectId: string;
  /**
   * Base URL of the zeonkit bridge that serves the TEM-1 science endpoints
   * (`/analyze`, `/gfp-gate`, `/loop/next`). Optional — omit to disable the
   * analysis capabilities rather than have them fail at call time.
   */
  bridgeUrl?: string;
}

export interface HumanStep {
  kind: "human_step";
  /** Why a human is required, in terms an auditor can check. */
  reason: string;
  /** Ordered instructions for the operator. */
  instructions: string[];
  /** Where the operator performs it. */
  location: string;
  /** What must be true before they start. */
  preconditions: string[];
  /** How the caller learns it finished. */
  completionSignal: string;
}

export interface PreparedRun {
  projectId: string;
  workflowId: string;
  /** Files that were staged for the run, path -> byte length. */
  staged: Record<string, number>;
  /** Always present. A Zeon run cannot be started programmatically. */
  humanStep: HumanStep;
  /** Set when the adapter could not verify the workflow exists in the project. */
  warnings: string[];
}

export interface LabwareAvailability {
  available: string[];
  missing: string[];
  /** True when every entry in TEM1_REQUIRED_LABWARE resolved in the catalog. */
  ready: boolean;
  /** Catalog entries whose names merely resemble a requirement. */
  candidates: Record<string, string[]>;
}

export class ZeonAdapter {
  private readonly sync: ZeonSyncClient;
  private readonly projectId: string;
  private readonly bridgeUrl?: string;

  constructor(private readonly config: ZeonAdapterConfig) {
    if (!config.projectId) throw new Error("ZeonAdapter: projectId is required");
    this.sync = new ZeonSyncClient(config);
    this.projectId = config.projectId;
    this.bridgeUrl = config.bridgeUrl?.replace(/\/+$/, "");
  }

  /** Resolve the token to an identity. Cheapest possible liveness check. */
  async whoami(): Promise<ZeonIdentity> {
    return this.sync.me();
  }

  /**
   * Check whether the shared mesh catalog already contains the labware a TEM-1
   * screen needs.
   *
   * This matters operationally: mesh-database *writes* are admin-only and
   * server-enforced (non-admins get 403, and Zeon's own docs say to "go through
   * your Zeon contact"). So anything missing here is not something a team can add
   * themselves under time pressure — it has to be modelled locally as a project
   * object instead. Knowing which of those two paths you are on is worth a call.
   */
  async checkLabware(): Promise<LabwareAvailability> {
    const res = await this.sync.listMeshDatabase();
    const items: ZeonMeshItem[] = res.items ?? [];
    const names = items.map((i) => i.name).filter(Boolean);
    const lower = names.map((n) => n.toLowerCase());

    const available: string[] = [];
    const missing: string[] = [];
    const candidates: Record<string, string[]> = {};

    for (const want of TEM1_REQUIRED_LABWARE) {
      const w = want.toLowerCase();
      if (lower.includes(w)) {
        available.push(want);
        continue;
      }
      missing.push(want);
      // Surface near-matches rather than a bare "missing" — catalog naming
      // rarely matches a guess exactly, and the operator can judge.
      const tokens = w.split("_").filter((t) => t.length > 2);
      const near = names.filter((n) => {
        const nl = n.toLowerCase();
        return tokens.some((t) => nl.includes(t));
      });
      if (near.length) candidates[want] = near.slice(0, 8);
    }
    return { available, missing, ready: missing.length === 0, candidates };
  }

  /**
   * Verify a workflow exists in the project's current snapshot.
   *
   * Returns the set of workflow ids found, so a caller can fail early rather than
   * staging a run against a workflow name that was renamed or never pushed.
   */
  async listWorkflows(ref = "refs/heads/main"): Promise<string[]> {
    const snap = await this.sync.snapshot(this.projectId, ref);
    const files = snap.files ?? {};
    return Object.keys(files)
      .filter((p) => /^workflows\/[a-z0-9_]+\.json$/.test(p))
      .map((p) => p.replace(/^workflows\//, "").replace(/\.json$/, ""))
      .sort();
  }

  /**
   * Stage a run and return the human step required to actually execute it.
   *
   * Deliberately named `prepareRun`, not `startRun`. It does not start anything
   * and must never be presented to a settlement path as execution.
   */
  async prepareRun(input: {
    workflowId: string;
    /** Files to stage, path -> contents (e.g. inputs/screen_plate.json). */
    files?: Record<string, string>;
    /** Set true to skip the workflow-existence check (offline / pre-push). */
    skipVerify?: boolean;
  }): Promise<PreparedRun> {
    const warnings: string[] = [];

    if (!input.skipVerify) {
      try {
        const found = await this.listWorkflows();
        if (found.length && !found.includes(input.workflowId)) {
          warnings.push(
            `workflow "${input.workflowId}" is not in the project snapshot ` +
              `(found: ${found.join(", ") || "none"}). Push it with \`zeon sync\` first.`,
          );
        }
      } catch (e) {
        const msg = e instanceof ZeonSyncError ? e.message : String(e);
        warnings.push(`could not verify the workflow exists: ${msg}`);
      }
    }

    const staged: Record<string, number> = {};
    for (const [path, contents] of Object.entries(input.files ?? {})) {
      staged[path] = Buffer.byteLength(contents, "utf8");
      // A single blob over 16 MB is dropped from Zeon's data push with a warning
      // rather than failing it, so a silently-missing artifact is possible.
      if (staged[path] > 16 * 1024 * 1024) {
        warnings.push(
          `${path} is ${(staged[path] / 1e6).toFixed(1)} MB; Zeon silently skips ` +
            `files over 16 MB when pushing run data`,
        );
      }
    }

    return {
      projectId: this.projectId,
      workflowId: input.workflowId,
      staged,
      warnings,
      humanStep: {
        kind: "human_step",
        reason:
          "The Zeon cloud API has no execution route. Runs are started from the " +
          "Workflow Editor, and a real-hardware run is additionally gated on two " +
          "preflight checks the UI performs (a fresh frame from each wrist camera, " +
          "and a pipette home). No API can satisfy those.",
        location: "Zeon Workflow Editor, http://localhost:3000 on the lab machine",
        preconditions: [
          "the workspace is clear of people and obstacles, with a physical e-stop in reach",
          "the physical scene matches the world about to be loaded (nothing in the UI checks this)",
          "each arm is fitted with the endpoint the software believes it has — use `wellplate` for plate work",
          "for a screen slot: the sfGFP expression gate has passed",
        ],
        instructions: [
          `open the project and select workflow "${input.workflowId}"`,
          "pick the World in the top bar",
          "set the execution-world dropdown to Simulation first and validate",
          "only then switch it to Real Hardware",
          "fill the Inputs tab from the staged files",
          "press Run and name the run so it can be found later",
        ],
        completionSignal:
          "the run reaches a terminal state and Zeon pushes data/ to the cloud; " +
          "pull it with `zeon sync` and read data/api/<run>/ and data/logs/<run>/",
      },
    };
  }

  /** POST to the zeonkit bridge. Throws when no bridgeUrl was configured. */
  private async bridge<T>(path: string, body: unknown): Promise<T> {
    if (!this.bridgeUrl) {
      throw new Error(
        `ZeonAdapter: no bridgeUrl configured, so ${path} is unavailable. ` +
          `Start the zeonkit bridge and pass bridgeUrl.`,
      );
    }
    const res = await (this.config.fetchImpl ?? fetch)(this.bridgeUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* keep raw */
      }
      throw new Error(`zeonkit bridge ${res.status} on ${path}: ${detail}`);
    }
    return JSON.parse(text) as T;
  }

  /** Score a kinetic A490 plate: initial rates, Z', percent inhibition, hits. */
  analyzePlate(input: {
    traces: Record<string, { times_s: number[]; values: number[] }>;
    platemap?: unknown;
    plate_id?: string;
    round_index?: number;
    hit_threshold_pct?: number;
  }): Promise<unknown> {
    return this.bridge("/analyze", input);
  }

  /** The sfGFP expression go/no-go that gates a screen slot. */
  checkExpressionGate(input: {
    readings: Record<string, number>;
    samples: string[];
    negatives: string[];
    positives?: string[];
    min_fold?: number;
  }): Promise<unknown> {
    return this.bridge("/gfp-gate", input);
  }

  /** Turn round-1 results into a round-2 plate map, with selection provenance. */
  designNextRound(input: {
    results: unknown;
    threshold?: number;
    max_curves?: number;
    force?: boolean;
  }): Promise<unknown> {
    return this.bridge("/loop/next", input);
  }
}
