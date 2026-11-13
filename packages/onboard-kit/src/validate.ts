/**
 * Validator — checks onboarding config shape and local consistency.
 */

import { COMMITTED_PROGRAM_REGISTRY, EVIDENCE_DEVICE_TYPES, isValidKernelId, registeredQuotePrice } from "@pcc/spec";
import type { CapabilityDefinition, OnboardConfig } from "./types.js";
import { scaffoldRuleProblems } from "./scaffold-rules.js";
import { checkConfigShape } from "./config-shape.js";
import { getKnownCapabilityTypes } from "./known-types.js";

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
}

const VALID_PROTOCOLS = new Set(["http", "opcua", "modbus", "sila", "mqtt", "serial", "websocket", "custom"]);
const VALID_ADAPTER_TYPES = new Set(["machine", "sensor", "camera"]);
const WELL_FORMED_TYPE = /^[a-z0-9]+([.-][a-z0-9]+)*$/;

export function validate(options: ValidationOptions): ValidationResult {
  const { config } = options;
  const checks: ValidationCheck[] = checkConfigShape(config);
  if (checks.length > 0) return resultFor(config, checks);

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

  if (config.kernel.kernelId !== "" && !isValidKernelId(config.kernel.kernelId)) {
    checks.push({
      name: "kernel.kernelId", passed: false, severity: "error",
      message: `${JSON.stringify(config.kernel.kernelId)} cannot be named in a funded deal: use 1 to 128 printable ASCII characters, no spaces, not starting with eip155: or ed25519:`,
    });
  }

  if (typeof config.kernel.gatewayUrl === "string") {
    let url: URL | undefined;
    try { url = new URL(config.kernel.gatewayUrl); } catch { /* Report without exposing credentials. */ }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      checks.push({
        name: "kernel.gatewayUrl", passed: false, severity: "warning",
        message: "not an http or https URL",
      });
    } else if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      checks.push({
        name: "kernel.gatewayUrl", passed: false, severity: "warning",
        message: `plain http to ${url.hostname}; operator sessions accept plain http only on loopback`,
      });
    }
  }

  if (!Number.isInteger(config.kernel.httpPort) || config.kernel.httpPort < 1 || config.kernel.httpPort > 65535) {
    checks.push({
      name: "kernel.httpPort", passed: false, severity: "error",
      message: `${String(config.kernel.httpPort)} is not a port (1-65535)`,
    });
  }

  if (typeof config.kernel.walletPrivateKeyEnvVar === "string" && config.kernel.walletPrivateKeyEnvVar !== "") {
    checks.push({
      name: "kernel.walletPrivateKeyEnvVar", passed: false, severity: "warning",
      message: `the scaffolded agent never reads the variable named in walletPrivateKeyEnvVar; KernelAgent takes no wallet setting, so its wallet is a new random key each start`,
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
    const prefix = `adapter[${text(adapter.adapterId)}]`;

    checks.push(checkRequired(`${prefix}.adapterId`, adapter.adapterId));
    checks.push(checkRequired(`${prefix}.className`, adapter.className));

    if (adapter.adapterType === "machine") {
      const classes = [...new Set(config.capabilities
        .filter(cap => cap.adapterId === adapter.adapterId)
        .map(cap => cap.type))];
      checks.push({
        name: `${prefix}.capabilityClass`,
        passed: classes.length === 1,
        message: classes.length === 0
          ? `Adapter "${text(adapter.adapterId)}": add exactly one capability class for it`
          : classes.length > 1
            ? `Adapter "${text(adapter.adapterId)}" has several capability classes: ${classes.join(", ")}; add exactly one capability class for it`
            : `Adapter "${text(adapter.adapterId)}" has capability class ${classes[0]}`,
        severity: "error",
      });
    }

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

    if (adapter.adapterType === "machine" && !(EVIDENCE_DEVICE_TYPES as readonly string[]).includes(adapter.deviceType)) {
      checks.push({
        name: `${prefix}.deviceType`, passed: false, severity: "warning",
        message: `${JSON.stringify(adapter.deviceType)} is not an evidence device type in @pcc/spec (for example controller, power_monitor, robot_arm); schema-checking verifiers refuse its events`,
      });
    }
    if (adapter.adapterType === "sensor") {
      checks.push({
        name: `${prefix}.deviceType`, passed: false, severity: "warning",
        message: `the generated sensor adapter writes deviceType "sensor" whatever this field says, and "sensor" is not an evidence device type in @pcc/spec; schema-checking verifiers refuse its events until you change it in the generated adapter (for example to power_monitor)`,
      });
    }
    if (adapter.adapterType === "machine" && adapter.protocol !== "http") {
      checks.push({
        name: `${prefix}.protocol`, passed: false, severity: "warning",
        message: `the scaffold writes an HTTP adapter for every machine adapter; write the ${adapter.protocol} transport yourself`,
      });
    }

    checks.push(checkRequired(`${prefix}.connectionString`, adapter.connectionString));

    if (adapterIds.has(adapter.adapterId)) {
      checks.push({
        name: `${prefix}.uniqueId`,
        passed: false,
        message: `Duplicate adapter ID "${text(adapter.adapterId)}"`,
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
    const prefix = `capability[${text(cap.type)}]`;
    checks.push(...typeChecks(cap.type, `${prefix}.type`));

    checks.push(checkRequired(`${prefix}.name`, cap.name));

    if (cap.materials.length === 0) {
      checks.push({
        name: `${prefix}.materials`,
        passed: false,
        message: "At least one material should be listed",
        severity: "warning",
      });
    }

    checks.push(...pricingChecks(cap, prefix));

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

    const missingTiers = [...new Set(cap.assuranceTiers.filter(tier => tier > 0))]
      .sort((a, b) => a - b)
      .filter(tier => !COMMITTED_PROGRAM_REGISTRY.some(entry => entry.csd === cap.type && entry.tier === `tier${tier}`));
    if (missingTiers.length > 0) {
      const tiers = missingTiers.join(", ");
      checks.push({
        name: `${prefix}.fundableTiers`, passed: false, severity: "warning",
        message: missingTiers.length === 1
          ? `tier ${tiers} has no committed program for ${cap.type} in this kit, so a buyer can't fund this capability at tier ${tiers}`
          : `tiers ${tiers} have no committed program for ${cap.type} in this kit, so a buyer can't fund this capability at tiers ${tiers}`,
      });
    }

    // Only the FDM default ladder supplies these hints; other CSD ladders decide.
    if (cap.type === "fdm" && cap.assuranceTiers.includes(1 as any) && !hasSensorAdapter) {
      checks.push({
        name: `${prefix}.tier1.sensors`,
        passed: false,
        message: "The FDM default ladder's Assurance Tier 1 requires at least one sensor adapter",
        severity: "warning",
      });
    }

    if (cap.type === "fdm" && cap.assuranceTiers.includes(2 as any) && !hasCameraAdapter) {
      checks.push({
        name: `${prefix}.tier2.camera`,
        passed: false,
        message: "The FDM default ladder's Assurance Tier 2 requires a camera adapter",
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

  const typeCounts = new Map<string, number>();
  for (const cap of config.capabilities) typeCounts.set(cap.type, (typeCounts.get(cap.type) ?? 0) + 1);
  for (const [type, count] of typeCounts) {
    if (count > 1) checks.push({
      name: `capability[${text(type)}]`, passed: false, severity: "error",
      message: `more than one capability of type ${type} on one kernel; the gateway's quote refuses an ambiguous type (capability_ambiguous)`,
    });
  }

  // ── Profiles ────────────────────────────────────────────────────

  if (config.profiles) {
    for (const profile of config.profiles) {
      const prefix = `profile[${text(profile.profileId)}]`;
      checks.push(...typeChecks(profile.capabilityType, `${prefix}.capabilityType`, true));

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

  return resultFor(config, checks);
}

function resultFor(config: OnboardConfig, checks: ValidationCheck[]): ValidationResult {
  for (const { name, message } of scaffoldRuleProblems(config)) {
    checks.push({ name, passed: false, message, severity: "error" });
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

function text(value: unknown): string {
  // JSON objects can have a non-callable toString property.
  try { return String(value); } catch { return JSON.stringify(value); }
}

function typeChecks(type: string, name: string, profile = false): ValidationCheck[] {
  if (type === "") return [{
    name, passed: false, severity: "error",
    message: profile ? "capabilityType is required" : "type is required (the gateway answers 400 when kernelId or type is missing)",
  }];
  if (getKnownCapabilityTypes().has(type)) return profile ? [] : [{
    name, passed: true, severity: "info", message: `${type} has a template or CSD in this kit`,
  }];
  const hint = suggestType(type);
  const suggestion = hint ? ` (did you mean ${hint}?)` : "";
  const checks: ValidationCheck[] = [{
    name, passed: false, severity: "warning",
    message: profile
      ? `${type} has no template or CSD in this kit${suggestion}`
      : `${type} has no template or CSD in this kit, so buyers can't price it with the contract builder${suggestion}; the gateway accepts any type`,
  }];
  if (!WELL_FORMED_TYPE.test(type)) checks.push({
    name, passed: false, severity: "warning",
    message: `${JSON.stringify(type)} is not a slug (lowercase letters and digits joined by single "-" or "."); the gateway accepts any type`,
  });
  return checks;
}

function suggestType(type: string): string | undefined {
  const lower = type.toLowerCase();
  let nearest: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of [...getKnownCapabilityTypes()].sort()) {
    const known = candidate.toLowerCase();
    const distance = levenshtein(lower, known);
    if ((distance <= 2 || lower.startsWith(known) || known.startsWith(lower)) && distance < bestDistance) {
      nearest = candidate;
      bestDistance = distance;
    }
  }
  return nearest;
}

function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1)));
    }
    row = next;
  }
  return row[b.length]!;
}

function pricingChecks(cap: CapabilityDefinition, prefix: string): ValidationCheck[] {
  const price = registeredQuotePrice(cap.pricing);
  if (!price.ok) {
    let name = `${prefix}.pricing`;
    let message: string;
    switch (price.reason) {
      case "unsupported-currency":
        name += ".currency";
        message = `Invalid currency ${JSON.stringify(price.currency)}: the gateway quotes only USDC, with no conversion (capability_price_unsupported_currency)`;
        break;
      case "invalid-currency":
        name += ".currency";
        message = `Invalid currency ${JSON.stringify(cap.pricing.currency)}: the gateway's discovery quote refuses it (capability_price_undeclared: invalid-currency)`;
        break;
      case "no-pricing":
        message = "no usable pricing; the gateway's discovery quote refuses it (capability_price_undeclared: no-pricing)";
        break;
      case "invalid-price":
        name += ".baseCost";
        message = `${JSON.stringify(cap.pricing.baseCost)} is not an amount with at most two decimals; the gateway's discovery quote refuses it (capability_price_undeclared: invalid-price)`;
        break;
      case "zero-price":
        name += ".baseCost";
        message = `${JSON.stringify(cap.pricing.baseCost)} is zero; the gateway's discovery quote refuses a zero price (capability_price_undeclared: zero-price)`;
        break;
      case "invalid-minimum":
        name += ".minimum";
        message = `${JSON.stringify(cap.pricing.minimum)} is not an amount with at most two decimals; the gateway's discovery quote refuses it (capability_price_undeclared: invalid-minimum)`;
        break;
      case "invalid-usage":
        message = "a usage rate (perMinute, perGram, perCm3) is not an amount with at most six decimals; the gateway's discovery quote refuses it (capability_price_undeclared: invalid-usage)";
        break;
    }
    return [{ name, message, passed: false, severity: "error" }];
  }
  const checks: ValidationCheck[] = [];
  if (Object.keys(price.usage).length > 0) checks.push({
    name: `${prefix}.pricing`, passed: false, severity: "warning",
    message: "a non-zero usage rate is set; the gateway's discovery quote discloses it without charging it, and the plan path refuses it",
  });
  if (price.minimumCents !== null && price.cents < price.minimumCents) checks.push({
    name: `${prefix}.pricing`, passed: false, severity: "warning",
    message: `baseCost ${JSON.stringify(cap.pricing.baseCost)} is below minimum ${JSON.stringify(cap.pricing.minimum)}; the discovery quote charges the minimum, and the plan path refuses a baseCost below the minimum`,
  });
  return checks;
}

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
