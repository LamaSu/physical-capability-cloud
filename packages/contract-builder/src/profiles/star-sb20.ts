/**
 * Machine profile for Star SB-20 — sliding-headstock Swiss class.
 *
 * The Star SB-20R series is widely deployed for sub-20mm electronics
 * connectors, medical screws, and dental implants. 20mm bar capacity,
 * 8-station gang turret + back-working tool post standard. Often
 * configured for unattended overnight runs with multi-bar loaders.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §3.21
 *
 * Author: implementer-mike, 2026-05-23
 */

import type { MachineProfile } from "@pcc/spec";

export const starSb20Profile: MachineProfile = {
  id: "profile_star_sb20",
  capabilityType: "cnc-swiss",
  machineName: "Star SB-20",
  kernelId: "", // set when registered with a kernel
  paramOverrides: [
    {
      paramKey: "outerDiameterMm",
      overrideMax: 20,
    },
    {
      paramKey: "barStockDiameter",
      overrideMax: 20,
      overrideDefault: 12,
    },
    {
      paramKey: "lengthMm",
      overrideMax: 250,
    },
    {
      paramKey: "barFeeder",
      restrictTo: ["single-bar", "multi-bar-loader"],
      overrideDefault: "multi-bar-loader",
    },
  ],
  pricingOverrides: {
    basePrice: "110.00",
    currency: "USDC",
  },
};
