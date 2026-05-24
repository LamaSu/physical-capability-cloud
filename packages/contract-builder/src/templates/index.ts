/**
 * Template registry — register and retrieve capability templates.
 */

import type { CapabilityTemplate, CapabilityType } from "@pcc/spec";
import { fdmTemplate } from "./fdm.js";
import { slaTemplate } from "./sla.js";
import { cnc3AxisTemplate } from "./cnc-3axis.js";
import { laserCutTemplate } from "./laser-cut.js";
import { liquidHandlerTemplate } from "./liquid-handler.js";
import { liquidHandlingPrepTemplate } from "./liquid-handling-prep.js";
import { documentPrintingTemplate } from "./document-printing.js";
import { accountingReconcileTemplate } from "./digital/accounting-reconcile.js";
import { procurementRfqTemplate } from "./digital/procurement-rfq.js";
import { legalReviewTemplate } from "./digital/legal-review.js";
import { dataExtractionTemplate } from "./digital/data-extraction.js";
import { injectionMoldingTemplate } from "./injection-molding.js";
import { sheetMetalTemplate } from "./sheet-metal.js";
import { cncTurningTemplate } from "./cnc-turning.js";
import { cncSwissTemplate } from "./cnc-swiss.js";

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
registerTemplate(liquidHandlerTemplate);
registerTemplate(liquidHandlingPrepTemplate);
registerTemplate(documentPrintingTemplate);
registerTemplate(accountingReconcileTemplate);
registerTemplate(procurementRfqTemplate);
registerTemplate(legalReviewTemplate);
registerTemplate(dataExtractionTemplate);
registerTemplate(injectionMoldingTemplate);
registerTemplate(sheetMetalTemplate);
registerTemplate(cncTurningTemplate);
registerTemplate(cncSwissTemplate);
