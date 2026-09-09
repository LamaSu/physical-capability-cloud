/**
 * GalaxySynBioCadKernel — a PCC *digital kernel* that exposes the Galaxy-SynBioCAD
 * tool suite. It is computational (retrosynthesis, FBA, enzyme selection, DNA
 * design), so it uses the kernel-sdk DigitalKernelManifest + createKernelHandler
 * path rather than the physical MachineAdapter path.
 *
 * Design: ONE catalog-driven executor. A job's input is `{ tool_id, params }`;
 * we validate params against the tool's generated JSON-Schema, then run it over
 * the injected GalaxyClient (real REST or mock). The full tool menu (with I/O
 * schemas) is the catalog — that's what agents choose from.
 */

import nacl from "tweetnacl";

import type {
  AgentRegistryId,
  DigitalKernelManifest,
  DigitalWorkflowStep,
  PrincipalKey,
} from "@pcc/spec";
import { buildManifest, createKernelHandler } from "@pcc/kernel-sdk";

import { getCatalog, listTools, PIPELINE_STAGES, requireTool } from "./catalog.js";
import { GalaxyRestClient } from "./galaxy-client.js";
import { MockGalaxyClient } from "./mock-galaxy-client.js";
import type { GalaxyClient, GalaxyToolSpec } from "./types.js";
import { validateParams } from "./validate.js";

export const GALAXY_SYNBIOCAD_CAPABILITY_TYPE = "synbio-metabolic-design";

export interface GalaxyAdapterOptions {
  /** Globally unique kernel id (default "galaxy-synbiocad"). */
  kernelId?: string;
  /** HTTPS endpoint where this kernel's job handler is served. Required by the manifest. */
  endpointURL: string;
  /** ERC-8004 agent id of the operator (reputation/attribution target). */
  builderAgentId: string;
  /** Optional support contact URI. */
  contactURI?: string;
  /** Highest assurance tier the kernel offers (default 1). */
  maxAssuranceTier?: 0 | 1 | 2 | 3;
  /** Inject a transport (tests / custom). Overrides mockMode + galaxyUrl. */
  client?: GalaxyClient;
  /** Use the deterministic MockGalaxyClient (no server). */
  mockMode?: boolean;
  /** Live Galaxy base URL (falls back to env GALAXY_URL). */
  galaxyUrl?: string;
  /** Live Galaxy API key (falls back to env GALAXY_API_KEY). */
  galaxyApiKey?: string;
  /** Optional pricing overrides. */
  pricing?: { baseUSD?: number; perStepUSD?: number };
}

/** The job input shape this kernel's execute() accepts. */
export interface GalaxyJobInput extends Record<string, unknown> {
  tool_id: string;
  params?: Record<string, unknown>;
  history_id?: string;
}

/**
 * Build the manifest's declarative DAG: one step per populated pipeline stage,
 * chained left-to-right. This describes the kernel's scope; individual tool
 * selection happens per-job via `execute({tool_id, ...})`.
 */
export function buildStageWorkflowSteps(): DigitalWorkflowStep[] {
  const stages = PIPELINE_STAGES.filter((s) => listTools({ stage: s }).length > 0);
  return stages.map((stage, i) => ({
    stepId: `stage:${stage}`,
    stepType: "api_call",
    description: `${stage} — ${listTools({ stage })
      .map((t) => t.id)
      .join(", ")}`,
    dependsOn: i === 0 ? [] : [`stage:${stages[i - 1]}`],
    constraints: { requiredEvidence: ["execution_trace", "output_hash"] },
  }));
}

/** Assemble the DigitalKernelManifest for the Galaxy-SynBioCAD kernel. */
export function buildGalaxySynBioCadManifest(opts: GalaxyAdapterOptions): DigitalKernelManifest {
  const cat = getCatalog();
  const steps = buildStageWorkflowSteps();
  return buildManifest({
    kernelId: opts.kernelId ?? "galaxy-synbiocad",
    name: "Galaxy-SynBioCAD",
    description:
      `Synthetic-biology & metabolic-engineering design suite (${cat.tool_count} tools across ` +
      `${steps.length} pipeline stages) over the Galaxy REST API. Retrosynthesis (RetroPath2.0, ` +
      `RetroRules, RP2paths), ranking (rpFBA, rpThermo, rpScore), enzyme selection (Selenzyme), ` +
      `genetic design (PartsGenie, OptDOE, SbmlToSbol), and DNA assembly (DNA Weaver, DNA-Bot, ` +
      `LCR Genie). Source: brsynth/galaxytools@${cat.commit}. Choose a tool from the catalog and ` +
      `call execute({tool_id, params}).`,
    builder: {
      agentId: opts.builderAgentId as AgentRegistryId,
      ...(opts.contactURI ? { contactURI: opts.contactURI } : {}),
    },
    capabilityType: GALAXY_SYNBIOCAD_CAPABILITY_TYPE,
    workflowSteps: steps,
    endpointURL: opts.endpointURL,
    maxAssuranceTier: opts.maxAssuranceTier ?? 1,
    ...(opts.pricing ? { pricing: opts.pricing } : {}),
  });
}

/** Resolve the transport from options (explicit client > mock > real REST). */
export function resolveGalaxyClient(opts: GalaxyAdapterOptions): GalaxyClient {
  if (opts.client) return opts.client;
  if (opts.mockMode) return new MockGalaxyClient();
  const baseUrl = opts.galaxyUrl ?? process.env.GALAXY_URL;
  if (!baseUrl) {
    throw new Error(
      "GalaxySynBioCad: no transport — pass `client`, set `mockMode: true`, or provide " +
        "`galaxyUrl` / GALAXY_URL (+ `galaxyApiKey` / GALAXY_API_KEY).",
    );
  }
  return new GalaxyRestClient({
    baseUrl,
    apiKey: opts.galaxyApiKey ?? process.env.GALAXY_API_KEY,
  });
}

/**
 * The catalog-driven executor. Suitable as the `execute` for
 * `createKernelHandler`. Validates params against the tool's JSON-Schema before
 * running, and surfaces Galaxy errors as thrown errors (the handler records the
 * failure in the evidence bundle).
 */
export function createGalaxyExecute(client: GalaxyClient) {
  return async function execute(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const toolId = String(input.tool_id ?? input.toolId ?? "");
    if (!toolId) throw new Error("Galaxy execute: 'tool_id' is required in the job input");
    const params = (input.params as Record<string, unknown> | undefined) ?? {};
    const historyId = (input.history_id ?? input.historyId) as string | undefined;

    const tool = requireTool(toolId);
    const check = validateParams(tool, params);
    if (!check.valid) {
      throw new Error(
        `Galaxy execute: param validation failed for '${toolId}': ` +
          check.errors.map((e) => `${e.path} (${e.message})`).join("; "),
      );
    }

    const result = await client.runTool({ toolId, params, historyId });
    if (result.state === "error") {
      throw new Error(`Galaxy tool '${toolId}' errored: ${result.stderr ?? "see Galaxy job log"}`);
    }
    return {
      provider: "galaxy-synbiocad",
      tool_id: toolId,
      stage: tool.stage,
      state: result.state,
      jobId: result.jobId,
      historyId: result.historyId,
      outputs: result.outputs,
    };
  };
}

/** Convenience wrapper tying manifest + executor + handler together. */
export class GalaxySynBioCadKernel {
  readonly manifest: DigitalKernelManifest;
  readonly client: GalaxyClient;
  readonly execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

  constructor(private readonly opts: GalaxyAdapterOptions) {
    this.client = resolveGalaxyClient(opts);
    this.manifest = buildGalaxySynBioCadManifest(opts);
    this.execute = createGalaxyExecute(this.client);
  }

  /** The advertised tool menu (stable, non-deprecated) agents choose from. */
  capabilities(): GalaxyToolSpec[] {
    return listTools();
  }

  /** Wire a signed job handler using operator-owned principal keys. */
  createHandler(principal: { principalKey: PrincipalKey; principalPrivateKey: Uint8Array }) {
    return createKernelHandler({
      manifest: this.manifest,
      principalKey: principal.principalKey,
      principalPrivateKey: principal.principalPrivateKey,
      execute: this.execute,
    });
  }

  /**
   * Dev/test convenience: mint an ephemeral Ed25519 identity and return a
   * ready job handler. NOT for production settlement (the key is not registered
   * on-chain and is discarded when the process exits).
   */
  createEphemeralHandler() {
    const kp = nacl.sign.keyPair();
    const principalKey: PrincipalKey = {
      agentId: this.opts.builderAgentId as AgentRegistryId,
      walletAddress: "0x0000000000000000000000000000000000000000",
      publicKey: kp.publicKey,
    };
    return {
      handler: this.createHandler({ principalKey, principalPrivateKey: kp.secretKey }),
      publicKey: kp.publicKey,
    };
  }
}
