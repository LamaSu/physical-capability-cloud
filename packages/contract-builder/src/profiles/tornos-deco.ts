/**
 * Machine profile for Tornos DECO — Swiss-type CAM-machine class.
 *
 * The DECO series is the historical reference for Swiss-type production:
 * 7-13mm bar capacity, kinematic configuration optimized for medical
 * implants and watch parts. Limits the cnc-swiss template envelope to
 * the smaller bar range and biases toward medical material grades.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §3.21
 *
 * Author: implementer-mike, 2026-05-23
 */

import type { MachineProfile } from "@pcc/spec";

export const tornosDecoProfile: MachineProfile = {
  id: "profile_tornos_deco",
  capabilityType: "cnc-swiss",
  machineName: "Tornos DECO",
  kernelId: "", // set when registered with a kernel
  paramOverrides: [
    {
      paramKey: "material",
      restrictTo: [
        "stainless-303",
        "stainless-304",
        "stainless-316",
        "stainless-316l",
        "stainless-17-4-ph",
        "brass-360",
        "titanium-grade-5",
        "peek",
      ],
    },
    {
      paramKey: "outerDiameterMm",
      overrideMax: 13,
    },
    {
      paramKey: "barStockDiameter",
      overrideMax: 13,
      overrideDefault: 8,
    },
    {
      paramKey: "lengthMm",
      overrideMax: 200,
    },
  ],
  pricingOverrides: {
    basePrice: "135.00",
    currency: "USDC",
  },
};
