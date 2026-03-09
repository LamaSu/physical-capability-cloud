/**
 * Machine profile for Haas VF-2 — a popular vertical CNC mill.
 *
 * Restricts the CNC 3-axis template to common shop materials.
 * The VF-2 has a 30"x16"x20" work envelope, 8100 RPM spindle.
 */

import type { MachineProfile } from "@pcc/spec";

export const haasVf2Profile: MachineProfile = {
  id: "profile_haas_vf2",
  capabilityType: "cnc-3axis",
  machineName: "Haas VF-2",
  kernelId: "", // set when registered with a kernel
  paramOverrides: [
    {
      paramKey: "material",
      restrictTo: ["aluminum-6061", "aluminum-7075", "steel-1018", "brass", "delrin", "nylon-6"],
    },
    {
      paramKey: "quantity",
      overrideMax: 100,
    },
  ],
  pricingOverrides: {
    basePrice: "85.00",
    currency: "USDC",
  },
};
