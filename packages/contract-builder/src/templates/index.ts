/**
 * Template registry — register and retrieve capability templates.
 */

import type { CapabilityTemplate, CapabilityType } from "@pcc/spec";
import { fdmTemplate } from "./fdm.js";
import { slaTemplate } from "./sla.js";
import { cnc3AxisTemplate } from "./cnc-3axis.js";
import { laserCutTemplate } from "./laser-cut.js";

const registry = new Map<CapabilityType, CapabilityTemplate>();

/** Register a capability template */
export function registerTemplate(template: CapabilityTemplate): void {
  registry.set(template.capabilityType, template);
}

/** Get a template by capability type */
export function getTemplate(type: CapabilityType): CapabilityTemplate | undefined {
  return registry.get(type);
}

/** Get all registered templates */
export function getAllTemplates(): CapabilityTemplate[] {
  return [...registry.values()];
}

/** Get all registered capability types */
export function getRegisteredTypes(): CapabilityType[] {
  return [...registry.keys()];
}

// Register built-in templates
registerTemplate(fdmTemplate);
registerTemplate(slaTemplate);
registerTemplate(cnc3AxisTemplate);
registerTemplate(laserCutTemplate);
