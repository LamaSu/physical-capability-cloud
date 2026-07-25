/**
 * PCC digital-kernel manifest for the Zeon TEM-1 screen.
 *
 * The workflow DAG below is the honest decomposition of a closed-loop screen. Note
 * what is and is not a step: `expression_gate`, `analyze_plate`, and `design_round_2`
 * are real digital operations this kernel performs. Executing the robot is NOT a
 * step, because Zeon exposes no execution API — it is surfaced through
 * `ZeonAdapter.prepareRun()` as a human step so PCC never receipts work that a
 * machine did not do.
 *
 * That asymmetry is the whole reason this integration is worth building: Zeon has
 * bench execution and no settlement layer; PCC has settlement and no bench. Wiring
 * them without lying about which side did what is the deliverable.
 */

import { buildManifest } from "@pcc/kernel-sdk";
import type { DigitalKernelManifest } from "@pcc/spec";
import type { DigitalWorkflowStep } from "@pcc/spec";

export const ZEON_TEM1_KERNEL_ID = "zeon.tem1-screen";
export const ZEON_TEM1_CAPABILITY = "lab-screen-decision";

/** The digital half of a closed-loop inhibitor screen. */
export const TEM1_WORKFLOW_STEPS: DigitalWorkflowStep[] = [
  {
    stepId: "expression_gate",
    stepType: "validate",
    description:
      "Compare mean sfGFP fluorescence in sample wells against the no-template " +
      "control and return pass/fail. Fails closed when no negative-control wells " +
      "are supplied, because fold-over-negative is undefined without a baseline.",
    dependsOn: [],
    inputSchema: {
      type: "object",
      required: ["readings", "samples", "negatives"],
      properties: {
        readings: { type: "object", description: "well id -> fluorescence" },
        samples: { type: "array", items: { type: "string" } },
        negatives: { type: "array", items: { type: "string" } },
        positives: { type: "array", items: { type: "string" } },
        min_fold: { type: "number", default: 3.0 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["passed", "fold_over_negative"],
      properties: {
        passed: { type: "boolean" },
        fold_over_negative: { type: "number" },
        notes: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    stepId: "analyze_plate",
    stepType: "transform",
    description:
      "Fit per-well initial rates from a kinetic A490 trace, compute plate QC " +
      "(Z-prime, control %CV, and whether the positive-inhibitor control actually " +
      "inhibited), score percent inhibition against vehicle and no-enzyme controls, " +
      "and flag assay artifacts. Initial-rate windows are capped by absorbance " +
      "change rather than r-squared, because r-squared is insensitive to gentle " +
      "curvature and an over-long window depresses v_max, biasing every score toward " +
      "zero.",
    dependsOn: ["expression_gate"],
    inputSchema: {
      type: "object",
      required: ["traces"],
      properties: {
        traces: { type: "object", description: "well id -> {times_s, values}" },
        platemap: { type: "object", description: "schema pcc.tem1.platemap/v1" },
        hit_threshold_pct: { type: "number", default: 50 },
      },
    },
    outputSchema: {
      type: "object",
      required: ["qc", "scores"],
      properties: {
        schema: { type: "string", const: "pcc.tem1.results/v1" },
        qc: { type: "object" },
        scores: { type: "array", items: { type: "object" } },
        hits: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    stepId: "design_round_2",
    stepType: "transform",
    description:
      "Turn round-1 results into a round-2 plate map: dose-response curves for " +
      "confirmed hits (exploit) plus single-concentration retests of the next tier " +
      "(explore), with the selection rationale recorded in provenance. Refuses when " +
      "round-1 QC failed, since every selection would inherit a broken scale.",
    dependsOn: ["analyze_plate"],
    inputSchema: {
      type: "object",
      required: ["results"],
      properties: {
        results: { type: "object", description: "schema pcc.tem1.results/v1" },
        threshold: { type: "number", default: 50 },
        max_curves: { type: "integer", default: 8 },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        platemap: { type: "object", description: "schema pcc.tem1.platemap/v1" },
        n_curves: { type: "integer" },
        n_explore: { type: "integer" },
      },
    },
  },
];

export interface ZeonManifestInput {
  /** HTTPS endpoint serving the kernel job handler. */
  endpointURL: string;
  /** ERC-8004 agent id of the builder. */
  builderAgentId: string;
  contactURI?: string;
  /** Per-job base fee in USD. Defaults to 0 (free tier). */
  baseUSD?: number;
  perStepUSD?: number;
  /**
   * Assurance tier. Capped at 1 on purpose: the physical half of this workflow is
   * executed by a human at a UI and attested by run artifacts, not by an
   * instrumented machine under the kernel's control. Claiming a higher tier would
   * assert evidence quality the integration cannot produce.
   */
  maxAssuranceTier?: 0 | 1;
}

export function buildZeonTem1Manifest(input: ZeonManifestInput): DigitalKernelManifest {
  if (!input.endpointURL?.startsWith("https://")) {
    throw new Error(
      `buildZeonTem1Manifest: endpointURL must be HTTPS (got ${input.endpointURL})`,
    );
  }
  return buildManifest({
    kernelId: ZEON_TEM1_KERNEL_ID,
    name: "Zeon TEM-1 β-lactamase inhibitor screen",
    description:
      "Closed-loop decision layer for a TEM-1 nitrocefin inhibition screen running " +
      "on Zeon Systems robotics. Performs the expression go/no-go, kinetic plate " +
      "analysis with QC, and round-2 plate design. Robot execution is a human step: " +
      "the Zeon cloud exposes no execution API and real-hardware runs are gated on " +
      "UI preflight checks, so this kernel never reports machine work it did not do.",
    builder: {
      agentId: input.builderAgentId,
      ...(input.contactURI ? { contactURI: input.contactURI } : {}),
    },
    capabilityType: ZEON_TEM1_CAPABILITY,
    workflowSteps: TEM1_WORKFLOW_STEPS,
    endpointURL: input.endpointURL,
    maxAssuranceTier: input.maxAssuranceTier ?? 1,
    pricing: {
      currency: "USDC",
      baseUSD: input.baseUSD ?? 0,
      ...(input.perStepUSD !== undefined ? { perStepUSD: input.perStepUSD } : {}),
    },
  } as Parameters<typeof buildManifest>[0]);
}
