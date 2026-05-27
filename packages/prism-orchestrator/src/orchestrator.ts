/**
 * The orchestrator — runs all four stages and accumulates PipelineState.
 *
 * On any stage error, the orchestrator returns a state with phase=failed
 * and an error envelope. No exceptions escape the run() boundary so the
 * caller can render progress UIs without try/catch around the whole call.
 */

import { ingestProcedure } from "./stage1-ingest.js";
import { translateStepsToMadsci } from "./stage2-translate.js";
import { attestStage, AttestationError } from "./stage3-attest.js";
import { submitAndFund } from "./stage4-pcc.js";
import type {
  LlmPlanner,
  PccClient,
  PipelinePhase,
  PipelineState,
} from "./types.js";

export interface OrchestratorOptions {
  /** LLM planner for Stage 1. */
  planner: LlmPlanner;
  /** Lab vocabulary — instrument slugs the planner is allowed to use. */
  knownInstruments: string[];
  /** PCC gateway client. */
  pcc: PccClient;
  /** Sim kernel signing key (Ed25519, hex). */
  simSecretKeyHex: string;
  /** Workflow naming. */
  workflowName: string;
  workflowDescription?: string;
  /** PCC binding. */
  kernelId: string;
  capabilityId: string;
  assuranceTier?: 0 | 1 | 2 | 3;
  fundAmountUSDC: string;
  /** Optional run identifier — defaults to ISO timestamp slug. */
  runId?: string;
}

export class PrismOrchestrator {
  constructor(private readonly opts: OrchestratorOptions) {}

  async run(source: { text: string; url?: string }): Promise<PipelineState> {
    const runId =
      this.opts.runId ?? `prism-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    let state: PipelineState = { phase: "ingest", runId, source };

    try {
      // Stage 1
      const steps = await ingestProcedure({
        planner: this.opts.planner,
        procedureText: source.text,
        knownInstruments: this.opts.knownInstruments,
      });
      state = { ...state, phase: "translate", steps };

      // Stage 2
      const workflow = translateStepsToMadsci(steps, {
        workflowName: this.opts.workflowName,
        description: this.opts.workflowDescription,
        metadata: { runId, sourceUrl: source.url },
      });
      state = { ...state, phase: "attest", workflow };

      // Stage 3
      const attestation = await attestStage({
        workflow,
        secretKeyHex: this.opts.simSecretKeyHex,
      });
      state = { ...state, phase: "escrow", attestation };

      // Stage 4
      const pccResult = await submitAndFund({
        pcc: this.opts.pcc,
        workflow,
        attestation,
        kernelId: this.opts.kernelId,
        capabilityId: this.opts.capabilityId,
        assuranceTier: this.opts.assuranceTier,
        fundAmountUSDC: this.opts.fundAmountUSDC,
      });
      state = {
        ...state,
        phase: "execute",
        escrow: { id: pccResult.escrowId, address: pccResult.escrowAddress },
        pccJob: { id: pccResult.pccJobId, status: "submitted" },
      };

      // Stage 5 (poll) — single shot. Caller may continue polling.
      const job = await this.opts.pcc.getJob(pccResult.pccJobId);
      state = {
        ...state,
        phase: job.status === "completed" ? "settled" : "execute",
        pccJob: { id: job.id, status: job.status },
      };

      return state;
    } catch (e) {
      const phase: PipelinePhase = state.phase ?? "ingest";
      const message =
        e instanceof AttestationError
          ? `attestation rejected: ${e.message}`
          : (e as Error).message;
      return {
        ...state,
        phase: "failed",
        error: { phase, message },
        ...(e instanceof AttestationError && e.attestation
          ? { attestation: e.attestation }
          : {}),
      };
    }
  }
}
