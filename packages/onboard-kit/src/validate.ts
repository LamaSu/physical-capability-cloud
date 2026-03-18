/**
 * Validator — verifies that an onboarding configuration is correct and complete.
 *
 * Checks:
 * 1. Capability types are valid PCC built-in types
 * 2. Pricing models have required fields
 * 3. Assurance tiers are valid (0-3)
 * 4. Adapters reference valid protocols
 * 5. Capabilities reference existing adapters
 * 6. Kernel config is complete
 * 7. Machine profiles match capability types
 */

import type { OnboardConfig } from "./types.js";

export interface ValidationCheck {
  name: string;
  passed: boolean;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  errors: ValidationCheck[];
  warnings: ValidationCheck[];
  summary: string;
}

export interface ValidationOptions {
  config: OnboardConfig;
  /** Skip adapter connection checks (default true) */
  skipConnectionTest?: boolean;
}

const VALID_CAPABILITY_TYPES = new Set([
  "cnc-3axis", "cnc-5axis", "fdm", "sla", "sls", "dmls",
  "lathe", "laser-cut", "waterjet", "edm-wire", "edm-sinker",
  "injection-mold", "sheet-metal-bend", "sheet-metal-punch",
  "welding-mig", "welding-tig", "welding-laser",
  "surface-grinding", "cylindrical-grinding", "polishing",
  "anodizing", "plating", "heat-treat",
  "cmm-inspection", "surface-profilometry", "xray-ct-inspection",
  "courier-pickup", "courier-delivery",
  "hplc", "gc-ms", "lc-ms", "pcr", "qpcr", "sequencing",
  "mass-spec", "spectrophotometer", "cell-culture", "bioreactor",
  "flow-cytometry", "centrifuge", "autoclave", "lyophilizer",
  "liquid-handler", "plate-reader", "microscopy", "balance",
]);

const VALID_CURRENCIES = new Set(["USDC", "ETH", "DAI", "SOL"]);
const VALID_PROTOCOLS = new Set(["http", "opcua", "modbus", "sila", "mqtt", "serial", "websocket", "custom"]);
const VALID_ADAPTER_TYPES = new Set(["machine", "sensor", "camera"]);

export function validate(options: ValidationOptions): ValidationResult {
  const { config } = options;
  const checks: ValidationCheck[] = [];

  // ── Kernel config ───────────────────────────────────────────────

  checks.push(checkRequired("kernel.kernelId", config.kernel.kernelId));
  checks.push(checkRequired("kernel.name", config.kernel.name));
  checks.push(checkRange("kernel.location.lat", config.kernel.location.lat, -90, 90));
  checks.push(checkRange("kernel.location.lng", config.kernel.location.lng, -180, 180));
  checks.push(checkRequired("kernel.gatewayUrl", config.kernel.gatewayUrl));

  if (config.kernel.kernelId && !config.kernel.kernelId.startsWith("kernel_")) {
    checks.push({
      name: "kernel.kernelId format",
      passed: false,
      message: `Kernel ID should start with "kernel_" (got "${config.kernel.kernelId}")`,
      severity: "warning",
    });
  } else {
    checks.push({
      name: "kernel.kernelId format",
      passed: true,
      message: "Kernel ID follows naming convention",
      severity: "info",
    });
  }

  // ── Adapters ────────────────────────────────────────────────────

  if (config.adapters.length === 0) {
    checks.push({
      name: "adapters.count",
      passed: false,
      message: "At least one adapter is required",
      severity: "error",
    });
  }

  const adapterIds = new Set<string>();
  for (const adapter of config.adapters) {
    const prefix = `adapter[${adapter.adapterId}]`;

    checks.push(checkRequired(`${prefix}.adapterId`, adapter.adapterId));
    checks.push(checkRequired(`${prefix}.className`, adapter.className));

    if (!VALID_ADAPTER_TYPES.has(adapter.adapterType)) {
      checks.push({
        name: `${prefix}.adapterType`,
        passed: false,
        message: `Invalid adapter type "${adapter.adapterType}". Must be: ${[...VALID_ADAPTER_TYPES].join(", ")}`,
        severity: "error",
      });
    }

    if (!VALID_PROTOCOLS.has(adapter.protocol)) {
      checks.push({
        name: `${prefix}.protocol`,
        passed: false,
        message: `Invalid protocol "${adapter.protocol}". Must be: ${[...VALID_PROTOCOLS].join(", ")}`,
        severity: "error",
      });
    }

    checks.push(checkRequired(`${prefix}.connectionString`, adapter.connectionString));

    if (adapterIds.has(adapter.adapterId)) {
      checks.push({
        name: `${prefix}.uniqueId`,
        passed: false,
        message: `Duplicate adapter ID "${adapter.adapterId}"`,
        severity: "error",
      });
    }
    adapterIds.add(adapter.adapterId);

    // Check HTTP endpoints for HTTP adapters
    if (adapter.protocol === "http" && adapter.adapterType === "machine") {
      const hasStatus = adapter.endpoints?.some(e => e.purpose === "status");
      const hasStart = adapter.endpoints?.some(e => e.purpose === "start");
      if (!hasStatus) {
        checks.push({
          name: `${prefix}.endpoints.status`,
          passed: false,
          message: "HTTP machine adapter should have a 'status' endpoint",
          severity: "warning",
        });
      }
      if (!hasStart) {
        checks.push({
          name: `${prefix}.endpoints.start`,
          passed: false,
          message: "HTTP machine adapter should have a 'start' endpoint",
          severity: "warning",
        });
      }
    }
  }

  // ── Capabilities ────────────────────────────────────────────────

  if (config.capabilities.length === 0) {
    checks.push({
      name: "capabilities.count",
      passed: false,
      message: "At least one capability is required",
      severity: "error",
    });
  }

  const hasMachineAdapter = config.adapters.some(a => a.adapterType === "machine");
  const hasSensorAdapter = config.adapters.some(a => a.adapterType === "sensor");
  const hasCameraAdapter = config.adapters.some(a => a.adapterType === "camera");

  for (const cap of config.capabilities) {
    const prefix = `capability[${cap.type}]`;

    if (!VALID_CAPABILITY_TYPES.has(cap.type)) {
      checks.push({
        name: `${prefix}.type`,
        passed: false,
        message: `Unknown capability type "${cap.type}". See AGENT_INSTRUCTIONS.md for valid types.`,
        severity: "error",
      });
    } else {
      checks.push({
        name: `${prefix}.type`,
        passed: true,
        message: `Valid capability type: ${cap.type}`,
        severity: "info",
      });
    }

    checks.push(checkRequired(`${prefix}.name`, cap.name));

    if (cap.materials.length === 0) {
      checks.push({
        name: `${prefix}.materials`,
        passed: false,
        message: "At least one material should be listed",
        severity: "warning",
      });
    }

    // Validate pricing
    if (!VALID_CURRENCIES.has(cap.pricing.currency)) {
      checks.push({
        name: `${prefix}.pricing.currency`,
        passed: false,
        message: `Invalid currency "${cap.pricing.currency}". Must be: ${[...VALID_CURRENCIES].join(", ")}`,
        severity: "error",
      });
    }

    const baseCost = parseFloat(cap.pricing.baseCost);
    const minimum = parseFloat(cap.pricing.minimum);
    if (isNaN(baseCost) || baseCost < 0) {
      checks.push({
        name: `${prefix}.pricing.baseCost`,
        passed: false,
        message: `baseCost must be a non-negative number (got "${cap.pricing.baseCost}")`,
        severity: "error",
      });
    }
    if (isNaN(minimum) || minimum < 0) {
      checks.push({
        name: `${prefix}.pricing.minimum`,
        passed: false,
        message: `minimum must be a non-negative number (got "${cap.pricing.minimum}")`,
        severity: "error",
      });
    }

    // Validate assurance tiers
    for (const tier of cap.assuranceTiers) {
      if (![0, 1, 2, 3].includes(tier)) {
        checks.push({
          name: `${prefix}.assuranceTiers`,
          passed: false,
          message: `Invalid assurance tier ${tier}. Must be 0, 1, 2, or 3.`,
          severity: "error",
        });
      }
    }

    // Tier requirements
    if (cap.assuranceTiers.includes(1 as any) && !hasSensorAdapter) {
      checks.push({
        name: `${prefix}.tier1.sensors`,
        passed: false,
        message: "Assurance Tier 1 requires at least one sensor adapter",
        severity: "warning",
      });
    }

    if (cap.assuranceTiers.includes(2 as any) && !hasCameraAdapter) {
      checks.push({
        name: `${prefix}.tier2.camera`,
        passed: false,
        message: "Assurance Tier 2 requires a camera adapter",
        severity: "warning",
      });
    }

    // Check adapter reference
    if (!adapterIds.has(cap.adapterId)) {
      checks.push({
        name: `${prefix}.adapterId`,
        passed: false,
        message: `Capability references adapter "${cap.adapterId}" which does not exist`,
        severity: "error",
      });
    }
  }

  // ── Profiles ────────────────────────────────────────────────────

  if (config.profiles) {
    for (const profile of config.profiles) {
      const prefix = `profile[${profile.profileId}]`;

      if (!VALID_CAPABILITY_TYPES.has(profile.capabilityType)) {
        checks.push({
          name: `${prefix}.capabilityType`,
          passed: false,
          message: `Profile references unknown capability type "${profile.capabilityType}"`,
          severity: "error",
        });
      }

      if (!adapterIds.has(profile.adapterId)) {
        checks.push({
          name: `${prefix}.adapterId`,
          passed: false,
          message: `Profile references adapter "${profile.adapterId}" which does not exist`,
          severity: "error",
        });
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────

  const errors = checks.filter(c => !c.passed && c.severity === "error");
  const warnings = checks.filter(c => !c.passed && c.severity === "warning");
  const valid = errors.length === 0;

  const summary = [
    `Validation ${valid ? "PASSED" : "FAILED"}`,
    `  ${checks.filter(c => c.passed).length} checks passed`,
    `  ${errors.length} errors`,
    `  ${warnings.length} warnings`,
    ...(errors.length > 0 ? ["", "Errors:"] : []),
    ...errors.map(e => `  ✗ ${e.name}: ${e.message}`),
    ...(warnings.length > 0 ? ["", "Warnings:"] : []),
    ...warnings.map(w => `  ⚠ ${w.name}: ${w.message}`),
  ].join("\n");

  return { valid, checks, errors, warnings, summary };
}

// ── Helper functions ──────────────────────────────────────────────

function checkRequired(name: string, value: unknown): ValidationCheck {
  const passed = value !== undefined && value !== null && value !== "";
  return {
    name,
    passed,
    message: passed ? `${name} is set` : `${name} is required`,
    severity: passed ? "info" : "error",
  };
}

function checkRange(name: string, value: number, min: number, max: number): ValidationCheck {
  const passed = typeof value === "number" && value >= min && value <= max;
  return {
    name,
    passed,
    message: passed
      ? `${name} is in range [${min}, ${max}]`
      : `${name} must be between ${min} and ${max} (got ${value})`,
    severity: passed ? "info" : "error",
  };
}
