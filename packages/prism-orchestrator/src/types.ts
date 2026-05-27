/**
 * Pipeline-state types for the PRISM-style orchestrator.
 *
 * Five phases:
 *   1. ingest        — text/URL → structured StepDraft[]
 *   2. translate     — StepDraft[] → MadsciWorkflow
 *   3. attest        — MadsciWorkflow → SimAttestation
 *   4. escrow        — fund PCC escrow if attestation passes
 *   5. execute       — submit PCC job, await settlement
 */

import { z } from "zod";
import type { MadsciWorkflow } from "@pcc/adapter-madsci";
import type { SimAttestation } from "@pcc/kernel-omniverse-sim";

export type PipelinePhase =
  | "ingest"
  | "translate"
  | "attest"
  | "escrow"
  | "execute"
  | "settled"
  | "failed";

/**
 * The structured intermediate representation between Stage-1 (LLM plan)
 * and Stage-2 (MADSci translation). Matches PRISM's "Layer 2" description:
 * one step = one atomic robot action with reagents/volumes/labware.
 */
export const StepDraftSchema = z.object({
  /** Plain-language step name (e.g. "Add 50µL Master Mix to wells A1-A12"). */
  name: z.string().min(1),
  /** Instrument or robot the step targets (slug, must match a node in the lab). */
  instrument: z.string().min(1),
  /** Action name as advertised by the node (slug). */
  action: z.string().min(1),
  /** Reagent (if dispensing). */
  reagent: z.string().optional(),
  /** Volume in microliters (if applicable). */
  volumeUl: z.number().positive().optional(),
  /** Source labware location. */
  source: z.string().optional(),
  /** Target labware location. */
  target: z.string().optional(),
  /** Free-form notes / temperatures / programs. */
  notes: z.record(z.unknown()).optional(),
});

export type StepDraft = z.infer<typeof StepDraftSchema>;

export interface PipelineState {
  /** Where the pipeline is. */
  phase: PipelinePhase;
  /** Run identifier. */
  runId: string;
  /** Source procedure (verbatim text or fetched URL contents). */
  source: { text: string; url?: string };
  /** Structured steps after Stage 1. */
  steps?: StepDraft[];
  /** MADSci workflow after Stage 2. */
  workflow?: MadsciWorkflow;
  /** Sim attestation after Stage 3. */
  attestation?: SimAttestation;
  /** PCC escrow id + on-chain address after Stage 4. */
  escrow?: { id: string; address?: string };
  /** PCC job id + status after Stage 5. */
  pccJob?: { id: string; status: string };
  /** Last error if phase=failed. */
  error?: { phase: PipelinePhase; message: string };
}

export interface LlmPlannerInput {
  procedureText: string;
  /** Lab vocabulary the LLM should constrain to (instrument slugs available). */
  knownInstruments: string[];
  /** Optional system-prompt override. */
  systemPrompt?: string;
}

export interface LlmPlanner {
  plan(input: LlmPlannerInput): Promise<StepDraft[]>;
}

export interface PccClient {
  /** POST /api/jobs/submit. */
  submitJob(body: unknown): Promise<{ jobId: string; escrowId?: string }>;
  /** GET /api/jobs/:id. */
  getJob(jobId: string): Promise<{ id: string; status: string }>;
  /** POST /api/escrow/fund. */
  fundEscrow(body: unknown): Promise<{ escrowId: string; address?: string }>;
}
