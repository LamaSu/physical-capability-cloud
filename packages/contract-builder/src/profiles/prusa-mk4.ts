/**
 * Machine profile for Prusa MK4 — a popular desktop FDM printer.
 *
 * Restricts the FDM template to what this specific machine supports:
 * - Materials: PLA, PETG, ABS, TPU (no nylon, PC, ASA, CF-nylon without hardened nozzle)
 * - Colors: all standard colors
 * - Layer heights: all supported
 * - Build volume limits quantity to reasonable batches
 */

import type { MachineProfile } from "@pcc/spec";

export const prusaMk4Profile: MachineProfile = {
  id: "profile_prusa_mk4",
  capabilityType: "fdm",
  machineName: "Prusa MK4",
  kernelId: "", // set when registered with a kernel
  paramOverrides: [
    {
      paramKey: "material",
      restrictTo: ["pla", "petg", "abs", "tpu"],
    },
    {
      paramKey: "color",
      restrictTo: ["black", "white", "gray", "red", "blue", "green", "orange", "natural"],
    },
    {
      paramKey: "infill",
      overrideMax: 100,
    },
    {
      paramKey: "quantity",
      overrideMax: 50,
    },
  ],
  pricingOverrides: {
    basePrice: "12.00",
    currency: "USDC",
  },
};
