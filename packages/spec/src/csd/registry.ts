/**
 * CSD Registry — loads, validates, stores, and resolves Capability StructureDefinitions.
 *
 * Three operations:
 *   register(csd)           — validate + store in memory
 *   get(url)                — lookup by canonical URI
 *   resolve(url)            — lookup + apply baseDefinition inheritance
 */

import { type CSD, CsdSchema } from "./schema.js";

// JSON imports resolved at build time via TypeScript's resolveJsonModule
import fdmCsd from "../csds/fdm.csd.json" with { type: "json" };
import slaCsd from "../csds/sla.csd.json" with { type: "json" };
import cnc3axisCsd from "../csds/cnc-3axis.csd.json" with { type: "json" };
import laserCutCsd from "../csds/laser-cut.csd.json" with { type: "json" };
import print2dCsd from "../csds/2d-print.csd.json" with { type: "json" };

export class CsdRegistry {
  private csds: Map<string, CSD> = new Map();

  /**
   * Validate a CSD document and store it in the registry.
   * Throws if the document does not conform to the CSD schema.
   */
  register(csd: CSD): void {
    const result = CsdSchema.safeParse(csd);
    if (!result.success) {
      const messages = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      throw new Error(`Invalid CSD "${(csd as Record<string, unknown>).url ?? "unknown"}": ${messages}`);
    }
    this.csds.set(result.data.url, result.data);
  }

  /**
   * Look up a CSD by its canonical URI.
   * Returns undefined if not found.
   */
  get(url: string): CSD | undefined {
    return this.csds.get(url);
  }

  /**
   * Return all registered CSDs.
   */
  list(): CSD[] {
    return Array.from(this.csds.values());
  }

  /**
   * Return CSDs filtered by structural kind.
   */
  findByKind(kind: CSD["kind"]): CSD[] {
    return this.list().filter((c) => c.kind === kind);
  }

  /**
   * Validate an unknown document against the CSD schema.
   * Returns { valid: boolean; errors: string[] }.
   */
  validate(csd: unknown): { valid: boolean; errors: string[] } {
    const result = CsdSchema.safeParse(csd);
    if (result.success) {
      return { valid: true, errors: [] };
    }
    const errors = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
    return { valid: false, errors };
  }

  /**
   * Resolve a CSD by URI, merging in fields from its baseDefinition chain.
   *
   * Inheritance rules (profile overrides base):
   *   - parameters: profile params replace base params with same key; new keys are appended
   *   - constraints: profile constraints replace base constraints with same key; new keys are appended
   *   - pricing: profile pricing overrides base pricing entirely (shallow merge)
   *   - name, description, status, version: profile wins
   *   - discovery, adapter, evidence: profile wins if present
   *
   * Throws if the URL is not registered or if the baseDefinition chain cannot be resolved.
   */
  resolve(url: string): CSD {
    const csd = this.get(url);
    if (!csd) {
      throw new Error(`CSD not found: "${url}"`);
    }

    if (!csd.baseDefinition) {
      // Base type — return as-is
      return csd;
    }

    // Recursively resolve the parent
    const parent = this.resolve(csd.baseDefinition);

    // Merge parameters: parent params, overridden by profile params with the same key
    const parentParamMap = new Map(parent.parameters.map((p) => [p.key, p]));
    const mergedParams = [...parent.parameters];
    for (const param of csd.parameters) {
      if (parentParamMap.has(param.key)) {
        const idx = mergedParams.findIndex((p) => p.key === param.key);
        mergedParams[idx] = param;
      } else {
        mergedParams.push(param);
      }
    }

    // Merge constraints: parent constraints overridden by profile constraints with the same key
    const parentConstraintMap = new Map(parent.constraints.map((c) => [c.key, c]));
    const mergedConstraints = [...parent.constraints];
    for (const constraint of csd.constraints) {
      if (parentConstraintMap.has(constraint.key)) {
        const idx = mergedConstraints.findIndex((c) => c.key === constraint.key);
        mergedConstraints[idx] = constraint;
      } else {
        mergedConstraints.push(constraint);
      }
    }

    const resolved: CSD = {
      // Start from parent
      ...parent,
      // Profile-level overrides
      ...csd,
      // Merged collections
      parameters: mergedParams,
      constraints: mergedConstraints,
      // evidence: profile wins if present, else inherit from parent
      evidence: csd.evidence ?? parent.evidence,
      // discovery: profile wins if present, else inherit from parent
      discovery: csd.discovery ?? parent.discovery,
      // adapter: profile wins if present, else inherit from parent
      adapter: csd.adapter ?? parent.adapter,
      // invariants: profile invariants appended after parent invariants
      invariants: [...(parent.invariants ?? []), ...(csd.invariants ?? [])],
    };

    return resolved;
  }

  /**
   * Return the number of registered CSDs.
   */
  get size(): number {
    return this.csds.size;
  }
}

/**
 * Create a CsdRegistry pre-loaded with all built-in CSDs.
 *
 * Built-in CSDs:
 *   pcc://capabilities/fdm/v2
 *   pcc://capabilities/sla/v2
 *   pcc://capabilities/cnc-3axis/v2
 *   pcc://capabilities/laser-cut/v2
 *   pcc://capabilities/2d-print/v1
 */
export function loadBuiltinCsds(): CsdRegistry {
  const registry = new CsdRegistry();

  const builtins = [fdmCsd, slaCsd, cnc3axisCsd, laserCutCsd, print2dCsd];
  for (const raw of builtins) {
    // Use validate first to get a clear error message, then register
    const result = CsdSchema.safeParse(raw);
    if (!result.success) {
      const url = (raw as Record<string, unknown>).url ?? "unknown";
      const messages = result.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      throw new Error(`Built-in CSD "${url}" failed schema validation: ${messages}`);
    }
    registry.register(result.data);
  }

  return registry;
}
