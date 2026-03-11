/**
 * Marketplace types — equipment taxonomy, market metrics, hosting spaces.
 *
 * These types power the equipment marketplace, demand/supply economics,
 * ROI projections, and physical space matching.
 */

import type { Id, Timestamp, Address, Amount, Currency, GeoLocation } from "./common.js";

// ── Equipment Taxonomy ──

/** Top-level equipment categories (extensible) */
export type EquipmentCategory =
  | "additive-manufacturing"
  | "subtractive-manufacturing"
  | "forming"
  | "assembly-joining"
  | "inspection-testing"
  | "bio-chemical"
  | "electronics"
  | "textiles"
  | "food-agriculture"
  | "artisanal-manual"
  | "logistics"
  | "energy"
  | (string & {});

/** Equipment class for market categorization */
export interface EquipmentClass {
  id: Id;
  name: string;
  category: EquipmentCategory;
  subcategory?: string;
  description: string;
  commonMaterials: string[];
  typicalTolerances: string[];
  typicalPriceRange: { min: Amount; max: Amount; currency: Currency };
  spaceRequirementsRange: {
    minFootprint: { width: number; depth: number; unit: "ft" | "m" };
    maxFootprint: { width: number; depth: number; unit: "ft" | "m" };
  };
}

// ── Market Metrics ──

/** Network-wide market snapshot */
export interface MarketSnapshot {
  equipmentClassId: Id;
  timestamp: Timestamp;
  networkMachineCount: number;
  averageUtilization: number;
  averageJobValue: Amount;
  demandLevel: "high" | "medium" | "low";
  trendDirection: "up" | "stable" | "down";
  trendPercent: number;
  queueDepthAverage: number;
}

/** ROI projection data point */
export interface ROIProjection {
  month: number;
  cumulativeRevenue: number;
  cumulativeCost: number;
  netPosition: number;
  utilization: number;
}

// ── Hosting Spaces ──

/** Hosting space listing */
export interface HostingSpace {
  id: Id;
  name: string;
  operatorAddress: Address;
  location: GeoLocation;
  address: string;
  dimensions: { width: number; depth: number; height: number; unit: "ft" | "m" };
  power: { voltage: number; amperage: number; phase: 1 | 3; circuitCount: number };
  amenities: string[];
  environmentalSystems: string[];
  safetyFeatures: string[];
  access: { schedule: "24/7" | "business-hours" | "scheduled"; loadingDock: boolean; forklift: boolean };
  /** Pricing phase: "free" during initial onboarding, "assessed" after sqft evaluation */
  pricingPhase: "free" | "assessed";
  /** Price per sqft/month — only set when pricingPhase is "assessed" */
  pricePerSqftMonth?: Amount;
  /** Total monthly price — computed from sqft when assessed, "0" when free */
  monthlyPrice: Amount;
  /** Total sqft occupied by equipment + clearance */
  sqft?: number;
  currency: Currency;
  availableSlots: number;
  totalSlots: number;
  rating: number;
  currentMachines?: Id[];
}

// ── Maintenance ──

/** Maintenance event */
export interface MaintenanceEvent {
  id: Id;
  machineId: Id;
  type: "scheduled" | "unscheduled" | "inspection";
  description: string;
  scheduledAt: Timestamp;
  completedAt?: Timestamp;
  status: "upcoming" | "in-progress" | "completed";
}
