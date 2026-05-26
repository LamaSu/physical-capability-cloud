/**
 * Machine profile for Citizen Cincom — Swiss-type production class.
 *
 * The Cincom L20 / M32 series are the most-deployed Swiss machines in
 * North America for medical-device and electronics-connector production.
 * 20-32mm bar capacity, live tooling + sub-spindle standard on
 * higher-end models. Full Swiss material catalog.
 *
 * Source: ai/research/manufacturing-capability-catalog-2026-05-23.md §3.21
 *
 * Author: implementer-mike, 2026-05-23
 */

import type { MachineProfile } from "@pcc/spec";

export const citizenCincomProfile: MachineProfile = {
  id: "profile_citizen_cincom",
  capabilityType: "cnc-swiss",
  machineName: "Citizen Cincom L20/M32",
  kernelId: "", // set when registered with a kernel
  paramOverrides: [
    {
      paramKey: "outerDiameterMm",
      overrideMax: 32,
    },
    {
      paramKey: "barStockDiameter",
      overrideMax: 32,
      overrideDefault: 20,
    },
    {
      paramKey: "lengthMm",
      overrideMax: 300,
    },
    {
      paramKey: "quantity",
      overrideMax: 100000,
    },
  ],
  pricingOverrides: {
    basePrice: "120.00",
    currency: "USDC",
  },
};
