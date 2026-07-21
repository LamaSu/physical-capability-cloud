/**
 * Deterministic, no-server implementation of GalaxyClient.
 *
 * Mock-first (mirrors the PLR/kernel convention): tests + `mockMode` never
 * touch a live Galaxy. Outputs are derived from the tool's declared outputs in
 * the catalog, so the shape of a mock run matches a real one.
 */

import { requireTool } from "./catalog.js";
import type {
  GalaxyClient,
  GalaxyOutputArtifact,
  GalaxyRunInput,
  GalaxyRunResult,
} from "./types.js";

/** Tiny stable string hash (djb2) — deterministic ids without Math.random. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export interface MockGalaxyClientOptions {
  /** Tool ids that should return an error result (to exercise failure paths). */
  failToolIds?: string[];
  /** Report unhealthy (default healthy). */
  unhealthy?: boolean;
}

export class MockGalaxyClient implements GalaxyClient {
  private runs = 0;
  constructor(private readonly opts: MockGalaxyClientOptions = {}) {}

  async health(): Promise<boolean> {
    return !this.opts.unhealthy;
  }

  async runTool(input: GalaxyRunInput): Promise<GalaxyRunResult> {
    const tool = requireTool(input.toolId);
    this.runs += 1;
    const key = hash(`${input.toolId}:${JSON.stringify(input.params ?? {})}:${this.runs}`);
    const historyId = input.historyId ?? `mock-hist-${key}`;

    if (this.opts.failToolIds?.includes(input.toolId)) {
      return {
        toolId: input.toolId,
        state: "error",
        jobId: `mock-job-${key}`,
        historyId,
        outputs: {},
        stderr: `mock failure for ${input.toolId}`,
      };
    }

    const outputs: Record<string, GalaxyOutputArtifact> = {};
    for (const o of tool.outputs) {
      const dsId = `mock-ds-${hash(o.name + key)}`;
      outputs[o.name] = {
        name: o.name,
        datasetId: dsId,
        ext: o.format,
        downloadUrl: `mock://datasets/${dsId}`,
        content: JSON.stringify({
          mock: true,
          tool: tool.id,
          output: o.name,
          format: o.format ?? null,
          params: input.params ?? {},
        }),
      };
    }

    return {
      toolId: input.toolId,
      state: "ok",
      jobId: `mock-job-${key}`,
      historyId,
      outputs,
      stdout: `mock run of ${tool.id} ok`,
    };
  }

  async fetchOutput(artifact: GalaxyOutputArtifact): Promise<string> {
    return artifact.content ?? "";
  }
}
