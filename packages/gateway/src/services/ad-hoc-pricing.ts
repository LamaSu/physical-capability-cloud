/**
 * Ad-hoc capability pricing helper.
 *
 * Background: PCC ships 18 hardcoded CapabilityTemplate's in
 * @pcc/contract-builder (fdm, cnc, hplc, etc.). Operators can register
 * capabilities of ANY type via POST /api/capabilities — wood-fired-pizza,
 * local-courier-delivery, dog-walk, anything. Those "ad-hoc" capabilities
 * have NO template; before this helper, every quote/build/negotiate path
 * threw "No template registered for capability type: X" and surfaced as
 * a 500 to the buyer.
 *
 * Resolution:
 *   getCapabilityDescriptor(type, capabilityId?)
 *
 * Returns one of:
 *   - { kind: "template", template } when a built-in template exists
 *   - { kind: "ad-hoc",   descriptor } when the capability row exists
 *                                       on a kernel, with pricing derived
 *                                       from the row's pricingModel
 *   - { kind: "missing" } when neither is found — caller emits 4xx
 *
 * The ad-hoc descriptor exposes a ResolvedBuildOptions shape with one
 * generic-params group so the UI keeps rendering, and a basePrice from
 * the capability row's pricing.baseCost / pricing.currency. The quantity
 * param is the one universal lever buyers care about; everything else
 * (toppings, distance, anything specific) goes through free-text notes
 * the operator reads at confirmation time.
 */

import type {
  CapabilityTemplate,
  ResolvedBuildOptions,
  ResolvedParam,
  ResolvedParamGroup,
  ParamDef,
} from "@pcc/spec";
import { getTemplate } from "@pcc/contract-builder";
import { getRepos } from "../db.js";

export type CapabilityDescriptor =
  | { kind: "template"; template: CapabilityTemplate }
  | { kind: "ad-hoc"; descriptor: AdHocDescriptor }
  | { kind: "missing"; reason: string };

/** Ad-hoc descriptor — derived from a registered capability row. */
export interface AdHocDescriptor {
  capabilityType: string;
  capabilityId: string;
  kernelId: string;
  name: string;
  basePrice: string; // dollar-string, NOT bigint (so JSON.stringify is fine)
  currency: string;
  /** Pre-built ResolvedBuildOptions view model the routes can return as-is */
  resolved: ResolvedBuildOptions;
}

/**
 * Find a capability descriptor for `type`, optionally constrained to a
 * specific row by `capabilityId`. Order of resolution:
 *
 *   1. If a built-in template exists for `type` → return it.
 *   2. Else, look up the capability row:
 *        - `capabilityId` if provided
 *        - or first matching row by `type` if not
 *   3. If the row exists → return an ad-hoc descriptor derived from
 *      its pricingModel.
 *   4. Otherwise → return `missing`.
 *
 * Note we check the template registry FIRST because that's the fast,
 * memory-resident path for the 18 well-known types. The DB lookup only
 * happens for ad-hoc types, which are the long tail.
 */
export function getCapabilityDescriptor(
  type: string,
  capabilityId?: string,
): CapabilityDescriptor {
  const template = getTemplate(type as never);
  if (template) {
    return { kind: "template", template };
  }

  // Ad-hoc path. Try to find a capability row that describes this type.
  let row;
  try {
    const repos = getRepos();
    if (capabilityId) {
      row = repos.capabilities.findById(capabilityId);
      // If the caller specified a capabilityId, it must match the type.
      // (Otherwise pricing comes from a different capability than asked.)
      if (row && row.type !== type) {
        return {
          kind: "missing",
          reason: `Capability ${capabilityId} is type "${row.type}", not "${type}"`,
        };
      }
    }
    if (!row) {
      const rows = repos.capabilities.findByType(type);
      row = rows[0];
    }
  } catch {
    // Repos not initialised (e.g. in some isolated test contexts). Fall
    // through to "missing" so the route still emits a clean 4xx.
  }

  if (!row) {
    return {
      kind: "missing",
      reason: `No build template for type "${type}" and no registered capability of that type`,
    };
  }

  return {
    kind: "ad-hoc",
    descriptor: buildAdHocDescriptor(row),
  };
}

/** Synthesize a ResolvedBuildOptions view model from a capability row. */
function buildAdHocDescriptor(row: {
  id: string;
  kernelId: string;
  type: string;
  name: string;
  description: string | null;
  pricing: { currency: string; baseCost: string | number; minimum?: string | number };
}): AdHocDescriptor {
  // Pricing model on the row can be string OR number depending on whether it
  // came back from JSON.parse (numeric) or our seed (string). Coerce.
  const baseCostNum = Number(row.pricing.baseCost);
  const basePrice = Number.isFinite(baseCostNum) ? baseCostNum.toFixed(2) : "0.00";
  const currency = row.pricing.currency ?? "USDC";

  // Two generic params: quantity (universal lever) + notes (free-text the
  // operator reads at confirmation). Buyers can add capability-specific
  // detail in notes without us needing a template per cap type.
  const quantityParam: ParamDef = {
    type: "number",
    key: "quantity",
    label: "Quantity",
    description: `How many "${row.name}" units to order.`,
    required: true,
    order: 1,
    group: "Order",
    min: 1,
    max: 100,
    step: 1,
    defaultValue: 1,
  } as ParamDef;

  const notesParam: ParamDef = {
    type: "string",
    key: "notes",
    label: "Notes for operator",
    description:
      "Free-text instructions (toppings, address, special handling). " +
      "This capability is ad-hoc — there is no fixed parameter template.",
    required: false,
    order: 2,
    group: "Order",
    maxLength: 1000,
  } as ParamDef;

  const allParams: ResolvedParam[] = [
    { def: quantityParam, visible: true, restricted: false },
    { def: notesParam, visible: true, restricted: false },
  ];

  const groups: ResolvedParamGroup[] = [
    {
      name: "Order",
      params: allParams,
    },
  ];

  const resolved: ResolvedBuildOptions = {
    capabilityType: row.type as never,
    templateName: row.name,
    templateVersion: "ad-hoc",
    groups,
    allParams,
    basePrice,
    currency,
  };

  return {
    capabilityType: row.type,
    capabilityId: row.id,
    kernelId: row.kernelId,
    name: row.name,
    basePrice,
    currency,
    resolved,
  };
}

/**
 * Verify that a kernel actually offers the requested capability type.
 * Used by negotiate/session to catch wrong-kernel up-front instead of
 * letting the buyer get a quote on a kernel that won't accept the job.
 *
 * Returns null if the kernel offers the type, otherwise a string reason
 * the route can surface in a 4xx.
 */
export function checkKernelOffersCapability(
  kernelId: string,
  capabilityType: string,
): string | null {
  try {
    const repos = getRepos();
    const kernel = repos.kernels.findById(kernelId);
    if (!kernel) {
      return `Kernel ${kernelId} not found`;
    }
    const caps = repos.capabilities.findByKernel(kernelId);
    if (caps.length === 0) {
      return `Kernel ${kernelId} has no registered capabilities`;
    }
    const hasType = caps.some((c) => c.type === capabilityType);
    if (!hasType) {
      const offered = [...new Set(caps.map((c) => c.type))].join(", ");
      return `Kernel ${kernelId} does not offer capability "${capabilityType}" (offers: ${offered})`;
    }
    return null;
  } catch {
    // If repos are unavailable, fall through (don't block).
    return null;
  }
}
