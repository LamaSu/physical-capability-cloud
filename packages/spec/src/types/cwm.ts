/**
 * Capability Workflow Manifest (CWM) — a declarative description of a
 * multi-step manufacturing workflow.
 *
 * This is what a user submits to the control plane. The scheduler/planner
 * takes a CWM and produces an execution plan.
 */

import type {
  Id,
  SHA256,
  Amount,
  Currency,
  AssuranceTier,
  Timestamp,
  Address,
} from "./common.js";
import type { CapabilityType } from "./capability.js";

/** Parameters for a manufacturing step */
export interface StepParams {
  /** Material to use */
  material?: string;
  /** Infill percentage (3D printing) */
  infill?: number;
  /** Layer height in mm (3D printing) */
  layerHeight?: number;
  /** Tool specification (CNC) */
  toolSpec?: string;
  /** Feed rate (CNC/Lathe) */
  feedRate?: number;
  /** Spindle speed RPM (CNC/Lathe) */
  spindleSpeed?: number;
  /** Sheet thickness (laser/waterjet) */
  sheetThickness?: number;
  /** Quantity */
  quantity?: number;
  /** Any other capability-specific params */
  [key: string]: unknown;
}

/** Input file reference for a step */
export interface StepInput {
  /** Hash of the input file (G-code, STL, STEP, DXF, etc.) */
  fileHash: SHA256;
  /** MIME type */
  mimeType: string;
  /** Where to fetch the file (URL, IPFS CID, etc.) */
  storageRef: string;
  /** Original filename */
  filename?: string;
}

/** Courier/logistics parameters */
export interface CourierParams {
  /** Where to pick up from — references a step ID or explicit address */
  from: { stepId: Id } | { address: string; location: { lat: number; lng: number } };
  /** Where to deliver to */
  to: { stepId: Id } | { address: string; location: { lat: number; lng: number } };
  /** Package specs */
  packageWeight?: number;  // grams
  packageDimensions?: { x: number; y: number; z: number; unit: "mm" | "in" };
  /** Delivery urgency */
  priority?: "economy" | "standard" | "express";
  /** Special handling instructions */
  handling?: string;
}

/** A single step in a workflow */
export interface CWMStep {
  id: Id;
  /** The capability required */
  capability: CapabilityType;
  /** Parameters for this step */
  params: StepParams;
  /** Input file(s) */
  inputs?: StepInput[];
  /** Courier parameters (for courier steps) */
  courier?: CourierParams;
  /** Required assurance tier */
  assuranceTier: AssuranceTier;
  /** Steps that must complete before this one */
  dependsOn: Id[];
  /** Preferred kernel ID (optional — user may prefer a specific shop) */
  preferredKernel?: Id;
  /** Maximum acceptable price for this step */
  maxPrice?: Amount;
  /** Estimated duration in minutes (hint for scheduling) */
  estimatedDuration?: number;
}

/** Settlement configuration for the workflow */
export interface CWMSettlement {
  /** Currency for payment */
  currency: Currency;
  /** Maximum total budget */
  maxBudget: Amount;
  /** Escrow contract address (if pre-deployed) */
  escrowContract?: Address;
  /** Payer address */
  payer: Address;
}

/** The top-level Capability Workflow Manifest */
export interface CWM {
  /** Schema version */
  version: "1.0";
  /** Unique manifest ID */
  id: Id;
  /** Human-readable name */
  name?: string;
  /** Description of what this workflow produces */
  description?: string;
  /** The steps in this workflow */
  steps: CWMStep[];
  /** Settlement configuration */
  settlement: CWMSettlement;
  /** When this CWM was created */
  createdAt: Timestamp;
  /** Who submitted this CWM */
  submitter: Address;
  /** Deadline — all steps must complete by this time */
  deadline?: Timestamp;
  /** Tags for categorization */
  tags?: string[];
}

/** An execution plan produced by the scheduler from a CWM */
export interface ExecutionPlan {
  id: Id;
  cwmId: Id;
  /** Planned assignments: step → kernel + capability + time window */
  assignments: StepAssignment[];
  /** Total estimated cost */
  totalCost: Amount;
  /** Estimated completion time */
  estimatedCompletion: Timestamp;
  /** Created timestamp */
  createdAt: Timestamp;
}

/** Assignment of a step to a specific kernel and time slot */
export interface StepAssignment {
  stepId: Id;
  kernelId: Id;
  capabilityId: Id;
  scheduledWindow: { start: Timestamp; end: Timestamp };
  quotedPrice: Amount;
  assuranceTier: AssuranceTier;
}
