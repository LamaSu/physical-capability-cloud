/**
 * Contract Builder types — declarative parameter definitions for manufacturing capabilities.
 *
 * These types power a "car configurator" experience for manufacturing:
 * pick a process type, see every knob you can turn, with pricing impact shown per option.
 *
 * Layer 0 (this file):
 *   ParamDef      — discriminated union describing a single configurable parameter
 *   PricingImpact — how a selection affects the price
 *   ParamConstraint — cross-parameter dependency rules
 *
 * Layer 1:
 *   CapabilityTemplate — canonical parameter definitions for a capability type (e.g., FDM)
 *
 * Layer 2:
 *   MachineProfile — kernel-specific overrides (e.g., Prusa MK4 restricts materials to PLA/PETG/ABS/TPU)
 *
 * Layer 3 (output):
 *   ResolvedBuildOptions — fully resolved view model sent to users
 *   BuilderContract      — validated contract with pricing breakdown + CWM step
 */

import type { Amount, Id } from "./common.js";
import type { CapabilityType } from "./capability.js";

// ── Pricing Impact ────────────────────────────────────────────────

/** How a parameter selection affects the price */
export interface PricingImpact {
  /** flat = +$X, percent = +X%, per_unit = +$X per unit (e.g., per % infill), multiplier = price * X */
  mode: "flat" | "percent" | "per_unit" | "multiplier";
  value: Amount;
  /** Human-readable label, e.g., "+$10 for sanding" */
  label?: string;
}

// ── ParamDef (discriminated union) ────────────────────────────────

/** Common fields shared by all parameter definitions */
interface ParamDefBase {
  /** Unique key for this parameter (e.g., "material", "infill") */
  key: string;
  /** Human-readable label */
  label: string;
  /** Longer description/help text */
  description?: string;
  /** Whether this parameter must be set */
  required: boolean;
  /** Display order (lower = first) */
  order: number;
  /** Grouping for UI (e.g., "Material", "Print Settings", "Post-Processing") */
  group: string;
  /** Pricing impact when this param is set (for non-enum params) */
  pricingImpact?: PricingImpact;
  /** Conditional visibility: only show this param when another param matches */
  visibleWhen?: { param: string; equals: string | number | boolean };
}

/** An option within an enum parameter */
export interface EnumOption {
  value: string;
  label: string;
  description?: string;
  pricingImpact?: PricingImpact;
}

/** Enum parameter — user picks from a list of options */
export interface EnumParamDef extends ParamDefBase {
  type: "enum";
  options: EnumOption[];
  defaultValue?: string;
  /** Allow multiple selections (e.g., post-processing steps) */
  multi?: boolean;
}

/** Numeric parameter — user picks a number within a range */
export interface NumberParamDef extends ParamDefBase {
  type: "number";
  min: number;
  max: number;
  step: number;
  unit?: string;
  defaultValue?: number;
}

/** Boolean parameter — on/off toggle */
export interface BooleanParamDef extends ParamDefBase {
  type: "boolean";
  defaultValue?: boolean;
}

/** Free-text string parameter */
export interface StringParamDef extends ParamDefBase {
  type: "string";
  maxLength?: number;
  placeholder?: string;
  defaultValue?: string;
}

/** Discriminated union of all parameter definition types */
export type ParamDef = EnumParamDef | NumberParamDef | BooleanParamDef | StringParamDef;

// ── ParamConstraint ───────────────────────────────────────────────

/** A condition that triggers a constraint */
export interface ConstraintCondition {
  param: string;
  equals?: string | number | boolean;
  in?: (string | number)[];
  gt?: number;
  lt?: number;
}

/** An action to apply when the constraint condition is met */
export interface ConstraintAction {
  param: string;
  /** Restrict enum options to these values */
  restrictTo?: string[];
  /** Exclude these enum options */
  exclude?: string[];
  /** Override numeric min */
  setMin?: number;
  /** Override numeric max */
  setMax?: number;
}

/** Cross-parameter constraint: when condition is met, apply restrictions */
export interface ParamConstraint {
  when: ConstraintCondition;
  then: ConstraintAction[];
}

// ── CapabilityTemplate ────────────────────────────────────────────

/** Canonical parameter template for a capability type (e.g., FDM, CNC, SLA) */
export interface CapabilityTemplate {
  /** Which capability type this template describes */
  capabilityType: CapabilityType;
  /** Template version */
  version: string;
  /** Human-readable name */
  name: string;
  /** Description of this process */
  description?: string;
  /** All configurable parameters */
  params: ParamDef[];
  /** Cross-parameter constraints */
  constraints?: ParamConstraint[];
  /** Base pricing hints (before options) */
  basePricingHints?: {
    basePrice: Amount;
    currency: string;
    perUnitLabel?: string;
  };
}

// ── MachineProfile ────────────────────────────────────────────────

/** Override for a specific parameter on a specific machine */
export interface ParamOverride {
  /** Which parameter to override */
  paramKey: string;
  /** Restrict enum options to these values */
  restrictTo?: string[];
  /** Exclude these enum options */
  exclude?: string[];
  /** Override numeric min */
  overrideMin?: number;
  /** Override numeric max */
  overrideMax?: number;
  /** Override default value */
  overrideDefault?: string | number | boolean;
}

/** Machine-specific profile that constrains a CapabilityTemplate */
export interface MachineProfile {
  id: Id;
  /** Which template this profile applies to */
  capabilityType: CapabilityType;
  /** Machine name (e.g., "Prusa MK4", "Haas VF-2") */
  machineName: string;
  /** Which kernel runs this machine */
  kernelId: Id;
  /** Parameter-level overrides */
  paramOverrides: ParamOverride[];
  /** Additional machine-specific parameters not in the base template */
  additionalParams?: ParamDef[];
  /** Machine-specific pricing overrides */
  pricingOverrides?: {
    basePrice?: Amount;
    currency?: string;
  };
}

// ── ResolvedBuildOptions (view model) ─────────────────────────────

/** A fully resolved parameter ready for display to the user */
export interface ResolvedParam {
  /** The parameter definition (possibly modified by profile/constraints) */
  def: ParamDef;
  /** Whether this param is currently visible (based on visibleWhen + current selections) */
  visible: boolean;
  /** Whether this param is currently restricted by a constraint */
  restricted: boolean;
  /** Computed pricing impact based on current selections */
  currentPricingImpact?: PricingImpact;
}

/** A group of resolved parameters */
export interface ResolvedParamGroup {
  name: string;
  params: ResolvedParam[];
}

/** The full resolved "view model" sent to users — everything they need to render a configurator */
export interface ResolvedBuildOptions {
  capabilityType: CapabilityType;
  templateName: string;
  templateVersion: string;
  /** Parameters organized by group */
  groups: ResolvedParamGroup[];
  /** Flat list of all params (same data, ungrouped) */
  allParams: ResolvedParam[];
  /** Base price before options */
  basePrice: Amount;
  currency: string;
  /** Machine info if a specific profile was applied */
  machineInfo?: {
    profileId: Id;
    machineName: string;
    kernelId: Id;
  };
}

// ── BuilderContract (output) ──────────────────────────────────────

/** A single line item in the price breakdown */
export interface PriceBreakdownItem {
  paramKey: string;
  paramLabel: string;
  selectedValue: string;
  impact: PricingImpact;
  /** Computed dollar amount for this line item */
  amount: Amount;
}

/** A validation error in the contract */
export interface ContractValidationError {
  paramKey: string;
  message: string;
}

/** The output of the contract builder — a validated, priced contract */
export interface BuilderContract {
  /** User's selections */
  selections: Record<string, string | number | boolean | string[]>;
  /** Total price after all options */
  totalPrice: Amount;
  /** Itemized breakdown */
  priceBreakdown: PriceBreakdownItem[];
  /** The CWM step generated from this contract */
  cwmStep: {
    capability: CapabilityType;
    params: Record<string, unknown>;
    assuranceTier: number;
  };
  /** Validation errors (empty if valid) */
  validationErrors: ContractValidationError[];
  /** Whether the contract is valid and ready to submit */
  isValid: boolean;
  /** Template + profile info */
  templateName: string;
  machineInfo?: {
    profileId: Id;
    machineName: string;
    kernelId: Id;
  };
}
