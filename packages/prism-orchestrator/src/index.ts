/**
 * @pcc/prism-orchestrator — end-to-end PRISM-style pipeline on PCC.
 *
 * Pipeline:
 *   1. ingest   — web procedure → StepDraft[]            (LLM)
 *   2. translate — StepDraft[] → MadsciWorkflow
 *   3. attest    — MadsciWorkflow → SimAttestation       (sim kernel)
 *   4. escrow    — fund PCC escrow if attestation passes
 *   5. execute   — submit PCC job, return run state
 *
 * Public surface:
 *   PrismOrchestrator                 — runs all stages
 *   ingestProcedure(opts)             — Stage 1 in isolation
 *   translateStepsToMadsci(steps)     — Stage 2 in isolation
 *   attestStage(opts)                 — Stage 3 in isolation
 *   submitAndFund(opts)               — Stage 4 in isolation
 *   StepDraftSchema, REFERENCE_SYSTEM_PROMPT
 */

export { PrismOrchestrator } from "./orchestrator.js";
export type { OrchestratorOptions } from "./orchestrator.js";

export { ingestProcedure, IngestError, REFERENCE_SYSTEM_PROMPT } from "./stage1-ingest.js";
export type { IngestOptions } from "./stage1-ingest.js";

export { translateStepsToMadsci } from "./stage2-translate.js";
export type { TranslateOptions } from "./stage2-translate.js";

export { attestStage, AttestationError } from "./stage3-attest.js";
export type { AttestOptions } from "./stage3-attest.js";

export { submitAndFund } from "./stage4-pcc.js";
export type { PccStageOptions, PccStageResult } from "./stage4-pcc.js";

export { StepDraftSchema } from "./types.js";
export type {
  PipelinePhase,
  PipelineState,
  StepDraft,
  LlmPlanner,
  LlmPlannerInput,
  PccClient,
} from "./types.js";
