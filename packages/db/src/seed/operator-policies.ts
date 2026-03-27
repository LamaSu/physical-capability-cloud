import type { StoreDB } from "../connection.js";
import { operatorPolicies } from "../schema/index.js";
import { DEFAULT_OPERATOR_POLICY } from "@pcc/spec";

/**
 * Seeds default operator policies for all kernels.
 * Each kernel gets the safe default (manual approval, weekday 9-5).
 * NanoClaw gets a customized policy for lab operation.
 */
export function seedOperatorPolicies(db: StoreDB): void {
  const now = new Date().toISOString();

  const kernelIds = [
    "kernel-nyc",
    "kernel-sf",
    "kernel-la",
    "kernel-biolab-01",
    "kernel-neurolab",
    "kernel-bioanalytica",
    "kernel-frontier-4f",
    "kernel-nanoclaw",
  ];

  const policies = kernelIds.map((kernelId) => {
    // NanoClaw gets a lab-optimized policy
    if (kernelId === "kernel-nanoclaw") {
      return {
        kernelId,
        policy: ({
          ...DEFAULT_OPERATOR_POLICY,
          approvalMode: "policy" as const,
          allowedCapabilityTypes: ["liquid-handler"],
          allowedMaterials: ["aqueous", "organic", "biological", "chemical"],
          maxDurationMs: 2 * 60 * 60_000, // 2 hours for liquid handling
          maxJobsPerHour: 3,
          maxJobsPerDay: 15,
          maxCostPerDay: "200.00",
          pricingRules: [
            ...DEFAULT_OPERATOR_POLICY.pricingRules,
            {
              id: "bio-markup",
              type: "material_markup" as const,
              label: "Biological samples: +10% (contamination protocol)",
              enabled: true,
              condition: { material: "biological" },
              impact: { mode: "percent" as const, value: "10" },
            },
          ],
        }) as unknown as Record<string, unknown>,
        updatedAt: now,
        updatedBy: "system",
      };
    }

    // All other kernels get the safe default
    return {
      kernelId,
      policy: DEFAULT_OPERATOR_POLICY as unknown as Record<string, unknown>,
      updatedAt: now,
      updatedBy: "system",
    };
  });

  db.insert(operatorPolicies).values(policies as any).run();
}
