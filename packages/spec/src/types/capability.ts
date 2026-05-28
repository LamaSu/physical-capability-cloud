/**
 * Capability types — the unit of billing and routing.
 *
 * You don't buy "a Dell server in rack 3." You buy "5-axis CNC slot with
 * probing + Tier-1 evidence." Capabilities are what shops expose to the
 * control plane.
 */

import type {
  Id,
  AssuranceTier,
  Amount,
  Currency,
  GeoLocation,
  TimeWindow,
} from "./common.js";

/** Built-in manufacturing capability types */
export type BuiltinCapabilityType =
  | "cnc-3axis"
  | "cnc-5axis"
  | "fdm"
  | "sla"
  | "sls"
  | "mjf"
  | "lathe"
  | "laser-cut"
  | "waterjet"
  | "sheet-metal"
  | "injection-mold"
  | "courier-pickup"
  | "courier-delivery"
  | "inspection"
  | "assembly"
  | "custom"
  // Biotech / neurotech capability types
  | "hplc"
  | "mass-spec"
  | "pcr"
  | "sequencing"
  | "cell-culture"
  | "microscopy"
  | "2d-print"
  | "spectroscopy"
  | "centrifuge"
  | "lyophilizer"
  | "bioreactor"
  | "flow-cytometry"
  | "electrophysiology"
  | "imaging"
  | "sample-prep"
  | "compound-synthesis"
  | "assay"
  | "chromatography"
  | "liquid-handler"
  | "liquid-handling-prep"
  // Document services
  | "document-printing"
  | "large-format-printing"
  | "scanning"
  | "binding";

/** Open string union: autocompletes builtins but accepts any string for extensibility */
export type CapabilityType = BuiltinCapabilityType | (string & {});

/** Dimensional envelope a capability can handle */
export interface WorkEnvelope {
  x: number;
  y: number;
  z: number;
  unit: "mm" | "in";
}

/** Tolerance specifications */
export interface ToleranceSpec {
  linear?: string;     // e.g., "±0.05mm"
  surface?: string;    // e.g., "Ra 1.6"
  positional?: string; // e.g., "±0.1mm"
}

/** Pricing model for a capability — values are MAXIMUMS, agents bid under */
export interface PricingModel {
  currency: Currency;
  /** Maximum base cost per job — agents may bid lower */
  baseCost: Amount;
  /** Maximum cost per unit time (minutes) */
  perMinute?: Amount;
  /** Maximum cost per unit weight (grams) */
  perGram?: Amount;
  /** Maximum cost per unit volume (cm³) */
  perCm3?: Amount;
  /** Minimum charge (floor — bids cannot go below this) */
  minimum: Amount;
  /** Pricing mode: "fixed" = take-it-or-leave-it, "auction" = agents bid under max */
  mode?: "fixed" | "auction";
}

/** A weekly availability schedule */
export interface AvailabilitySchedule {
  /** Timezone, e.g., "America/New_York" */
  timezone: string;
  /** Available windows per day of week (0=Sunday) */
  windows: Record<number, TimeWindow[]>;
  /** Explicit blackout dates */
  blackouts?: string[];
}

/** A capability exposed by a Shop Kernel */
export interface Capability {
  id: Id;
  kernelId: Id;
  type: CapabilityType;
  /** Human-readable name, e.g., "Haas VF-2 3-axis" */
  name: string;
  description?: string;
  /** Materials this capability can work with */
  materials: string[];
  /** Tolerance specs */
  tolerances?: ToleranceSpec;
  /** Max work envelope */
  envelope?: WorkEnvelope;
  /** Which assurance tiers this capability supports */
  assuranceTiers: AssuranceTier[];
  /** Pricing */
  pricing: PricingModel;
  /** Availability schedule */
  availability: AvailabilitySchedule;
  /** Location for routing/courier purposes */
  location: GeoLocation;
  /** Current queue depth (number of pending jobs) */
  queueDepth: number;
  /** Tags for search/filtering */
  tags?: string[];
}

/** A reserved slot on a capability */
export interface CapabilitySlot {
  id: Id;
  capabilityId: Id;
  kernelId: Id;
  jobId: Id;
  window: TimeWindow;
  status: "reserved" | "active" | "completed" | "cancelled";
}
