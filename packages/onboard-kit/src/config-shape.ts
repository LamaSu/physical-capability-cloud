import { z } from "zod";
import type { ValidationCheck } from "./validate.js";

const pricing = z.object({
  currency: z.string(),
  baseCost: z.string(),
  minimum: z.string(),
  perMinute: z.string().optional(),
  perGram: z.string().optional(),
  perCm3: z.string().optional(),
  mode: z.string().optional(),
});

// These six fields belong to scaffoldRuleProblems, including its coercion rules.
const scaffoldField = z.unknown().optional();
const configShape = z.object({
  kernel: z.object({
    kernelId: z.string(),
    name: z.string(),
    location: z.object({ lat: z.number(), lng: z.number() }),
    httpPort: z.number(),
    walletPrivateKeyEnvVar: scaffoldField,
    gatewayUrl: scaffoldField,
  }),
  adapters: z.array(z.object({
    adapterId: scaffoldField,
    className: scaffoldField,
    connectionString: scaffoldField,
    pollIntervalMs: scaffoldField,
    adapterType: z.string(),
    protocol: z.string(),
    deviceType: z.string(),
    firmwareVersion: z.string(),
    endpoints: z.array(z.object({
      method: z.string(),
      path: z.string(),
      purpose: z.string(),
      description: z.string(),
      requestBody: z.record(z.unknown()).optional(),
      responseShape: z.record(z.unknown()).optional(),
      auth: z.object({ type: z.string(), key: z.string(), envVar: z.string() }).optional(),
    })).optional(),
    nodeMap: z.array(z.object({
      nodeId: z.string(), name: z.string(), dataType: z.string(), direction: z.string(),
      unit: z.string().optional(),
    })).optional(),
    registerMap: z.array(z.object({
      channel: z.string(), label: z.string(), registerType: z.string(), dataType: z.string(),
      unit: z.string(), address: z.number(), scale: z.number().optional(), offset: z.number().optional(),
    })).optional(),
    generateMockMode: z.boolean().optional(),
  })),
  capabilities: z.array(z.object({
    type: z.string(),
    name: z.string(),
    adapterId: z.string(),
    description: z.string().optional(),
    materials: z.array(z.string()),
    tolerances: z.object({
      linear: z.string().optional(), surface: z.string().optional(), positional: z.string().optional(),
    }).optional(),
    workEnvelope: z.object({ x: z.number(), y: z.number(), z: z.number(), unit: z.string() }).optional(),
    assuranceTiers: z.array(z.number()),
    pricing,
  })),
  profiles: z.array(z.object({
    profileId: z.string(), profileName: z.string(), capabilityType: z.string(), adapterId: z.string(),
    paramOverrides: z.record(z.unknown()).optional(),
    pricingOverrides: pricing.partial().optional(),
  })).optional(),
});

function text(value: unknown): string {
  // JSON objects can have a non-callable toString property.
  try { return String(value); } catch { return JSON.stringify(value); }
}

function issueName(config: unknown, path: (string | number)[]): string {
  if (path.length === 0) return "config";
  const [root, index, ...rest] = path;
  const lists = {
    adapters: ["adapter", "adapterId"],
    capabilities: ["capability", "type"],
    profiles: ["profile", "profileId"],
  } as const;
  let name = String(root);
  let tail = path.slice(1);
  if (root === "adapters" || root === "capabilities" || root === "profiles") {
    if (typeof index === "number") {
      const list = (config as Record<string, unknown>)[root];
      const element = Array.isArray(list) ? list[index] : undefined;
      if (element !== null && typeof element === "object" && !Array.isArray(element)) {
        const [singular, key] = lists[root];
        name = `${singular}[${text(element[key])}]`;
      } else {
        name = `${root}[${index}]`;
      }
      tail = rest;
    }
  }
  return name + tail.map(segment => typeof segment === "number" ? `[${segment}]` : `.${segment}`).join("");
}

/** Check types before rules access the original object; parsed output is never used. */
export function checkConfigShape(config: unknown): ValidationCheck[] {
  const result = configShape.safeParse(config);
  if (result.success) return [];
  return result.error.issues.map(issue => ({
    name: issueName(config, issue.path),
    passed: false,
    message: issue.code === "invalid_type" && issue.received === "undefined" ? "required" : issue.message,
    severity: "error",
  }));
}
