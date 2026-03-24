/**
 * Execution Bundle — the sealed contract from user agent to operator.
 *
 * The user agent fills in exact parameters from the CapabilityCard schema
 * and sends back an ExecutionBundle. The operator validates it against
 * real hardware state, then either accepts (queues for execution) or
 * rejects with specific fixable errors.
 *
 * An ExecutionBundle is immutable once submitted — the operator runs
 * EXACTLY what's in it, no interpretation.
 */

import type { CapabilityCard, ParamSchema, DeckSlotState } from "./capability-card.js";
import type { PipetteInfo, DeckLayout, LabwareDef } from "./types.js";

// ── Execution Bundle ──────────────────────────────────────────────

export interface ExecutionBundle {
  /** Schema version — must match card's responseFormat */
  schemaVersion: "ExecutionBundle/1.0";

  /** Idempotency key — prevents double-execution */
  idempotencyKey: string;

  /** Reference to the CapabilityCard this was built from */
  cardRef: {
    kernelId: string;
    generatedAt: string;
  };

  /** Who is submitting this */
  submitter: {
    agentId: string;
    walletAddress: string;
  };

  /** Deck configuration — what labware to load where */
  deck: Array<{
    slot: string;
    labwareLoadName: string;
    labwareDisplayName: string;
  }>;

  /** Ordered list of steps to execute */
  steps: BundleStep[];

  /** Assurance tier requested */
  assuranceTier: number;

  /** Max price the user is willing to pay (from quote) */
  maxCost: {
    amount: string;
    currency: string;
  };

  /** Optional: protocol metadata */
  metadata?: {
    name?: string;
    description?: string;
    tags?: string[];
  };
}

export interface BundleStep {
  /** Step ID (unique within bundle) */
  id: string;
  /** Action name — must match an action in the CapabilityCard */
  action: string;
  /** Fully resolved parameters — every required param must be present */
  params: Record<string, unknown>;
  /** IDs of steps this depends on (for ordering) */
  dependsOn: string[];
  /** Human label */
  label?: string;
}

// ── Validation Result ─────────────────────────────────────────────

export interface BundleValidationResult {
  valid: boolean;
  /** Specific errors — each one is a fixable problem */
  errors: BundleValidationError[];
  /** Warnings — won't prevent execution but agent should know */
  warnings: string[];
  /** If valid: compiled protocol ready to run */
  compiledProtocolSource?: string;
  /** If valid: estimated execution time */
  estimatedDurationMs?: number;
  /** If valid: estimated cost */
  estimatedCost?: { amount: string; currency: string };
}

export interface BundleValidationError {
  /** Which part of the bundle has the error */
  location: "deck" | "step" | "param" | "constraint" | "card";
  /** Step ID or slot if applicable */
  ref?: string;
  /** What parameter is wrong */
  param?: string;
  /** Error code for programmatic handling */
  code: BundleErrorCode;
  /** Human-readable description */
  message: string;
  /** Suggested fix (for agent to auto-correct) */
  suggestion?: string;
}

export type BundleErrorCode =
  | "CARD_EXPIRED"
  | "CARD_MISMATCH"
  | "DUPLICATE_IDEMPOTENCY_KEY"
  | "UNKNOWN_ACTION"
  | "MISSING_REQUIRED_PARAM"
  | "PARAM_TYPE_MISMATCH"
  | "VOLUME_BELOW_MIN"
  | "VOLUME_ABOVE_MAX"
  | "INVALID_WELL"
  | "INVALID_SLOT"
  | "SLOT_EMPTY"
  | "LABWARE_NOT_AVAILABLE"
  | "PIPETTE_NOT_AVAILABLE"
  | "MODULE_NOT_AVAILABLE"
  | "TOO_MANY_STEPS"
  | "DURATION_EXCEEDS_MAX"
  | "COST_EXCEEDS_BUDGET"
  | "NO_TIP_RACK"
  | "INSUFFICIENT_TIPS"
  | "DECK_CONFLICT";

// ── Bundle Validator ──────────────────────────────────────────────

export class BundleValidator {
  private processedKeys = new Set<string>();

  /**
   * Validate an ExecutionBundle against a CapabilityCard and real hardware state.
   * Returns specific, fixable errors — not vague rejections.
   */
  validate(
    bundle: ExecutionBundle,
    card: CapabilityCard,
    pipettes: PipetteInfo[],
  ): BundleValidationResult {
    const errors: BundleValidationError[] = [];
    const warnings: string[] = [];

    // 1. Card validity
    if (bundle.cardRef.kernelId !== card.operator.kernelId) {
      errors.push({
        location: "card", code: "CARD_MISMATCH",
        message: `Bundle targets kernel '${bundle.cardRef.kernelId}' but this is '${card.operator.kernelId}'`,
      });
    }

    const cardAge = Date.now() - new Date(card.generatedAt).getTime();
    if (cardAge > card.validForMs) {
      errors.push({
        location: "card", code: "CARD_EXPIRED",
        message: `Capability card expired ${Math.round((cardAge - card.validForMs) / 60_000)}min ago. Request a fresh card.`,
        suggestion: "Re-send discover_capabilities to get a fresh CapabilityCard",
      });
    }

    // 2. Idempotency
    if (this.processedKeys.has(bundle.idempotencyKey)) {
      errors.push({
        location: "constraint", code: "DUPLICATE_IDEMPOTENCY_KEY",
        message: `Bundle with key '${bundle.idempotencyKey}' was already submitted`,
        suggestion: "Generate a new idempotencyKey (UUID)",
      });
    }

    // 3. Step count
    if (bundle.steps.length > card.constraints.maxSteps) {
      errors.push({
        location: "constraint", code: "TOO_MANY_STEPS",
        message: `Bundle has ${bundle.steps.length} steps, max is ${card.constraints.maxSteps}`,
        suggestion: `Split into multiple bundles of ≤${card.constraints.maxSteps} steps`,
      });
    }

    // 4. Deck validation
    const deckLabware = new Map<string, string>();
    for (const entry of bundle.deck) {
      const slotState = card.deck.slots.find((s) => s.slot === entry.slot);
      if (!slotState) {
        errors.push({
          location: "deck", ref: entry.slot, code: "INVALID_SLOT",
          message: `Slot '${entry.slot}' does not exist on this robot`,
        });
        continue;
      }
      if (!slotState.configurable && slotState.currentLabware !== entry.labwareLoadName) {
        errors.push({
          location: "deck", ref: entry.slot, code: "DECK_CONFLICT",
          message: `Slot '${entry.slot}' is not configurable (has ${slotState.currentLabware ?? "module"})`,
          suggestion: `Use a different slot, or use labware '${slotState.currentLabware}'`,
        });
      }
      const labwareDef = card.deck.availableLabware.find((l) => l.loadName === entry.labwareLoadName);
      if (!labwareDef) {
        errors.push({
          location: "deck", ref: entry.slot, code: "LABWARE_NOT_AVAILABLE",
          message: `Labware '${entry.labwareLoadName}' is not in the operator's library`,
          suggestion: `Available: ${card.deck.availableLabware.map((l) => l.loadName).join(", ")}`,
        });
      }
      deckLabware.set(entry.slot, entry.labwareLoadName);
    }

    // Check for at least one tip rack
    const hasTipRack = bundle.deck.some((d) =>
      card.deck.availableLabware.find((l) => l.loadName === d.labwareLoadName && l.category === "tiprack"),
    );
    const needsTips = bundle.steps.some((s) =>
      ["transfer", "distribute", "consolidate", "aspirate", "dispense"].includes(s.action),
    );
    if (needsTips && !hasTipRack) {
      errors.push({
        location: "deck", code: "NO_TIP_RACK",
        message: "Protocol needs tips but no tip rack is loaded on the deck",
        suggestion: "Add a tip rack to an empty slot (e.g. opentrons_96_tiprack_300ul)",
      });
    }

    // 5. Step-by-step validation
    const actionMap = new Map(card.actions.map((a) => [a.action, a]));

    for (const step of bundle.steps) {
      const schema = actionMap.get(step.action);
      if (!schema) {
        errors.push({
          location: "step", ref: step.id, code: "UNKNOWN_ACTION",
          message: `Unknown action '${step.action}'`,
          suggestion: `Available: ${card.actions.map((a) => a.action).join(", ")}`,
        });
        continue;
      }

      // Validate each parameter
      for (const paramSchema of schema.params) {
        const value = step.params[paramSchema.key];

        // Required check
        if (paramSchema.required && (value === undefined || value === null || value === "")) {
          errors.push({
            location: "param", ref: step.id, param: paramSchema.key,
            code: "MISSING_REQUIRED_PARAM",
            message: `Step '${step.id}': missing required param '${paramSchema.key}'`,
            suggestion: paramSchema.defaultValue !== undefined
              ? `Use default: ${JSON.stringify(paramSchema.defaultValue)}`
              : `Provide a value of type ${paramSchema.type}`,
          });
          continue;
        }

        if (value === undefined) continue; // optional, not provided

        // Volume range check
        if (paramSchema.type === "number" && typeof value === "number") {
          if (paramSchema.min !== undefined && value < paramSchema.min) {
            errors.push({
              location: "param", ref: step.id, param: paramSchema.key,
              code: "VOLUME_BELOW_MIN",
              message: `Step '${step.id}': ${paramSchema.key}=${value} is below minimum ${paramSchema.min}`,
              suggestion: `Use at least ${paramSchema.min} ${paramSchema.unit ?? ""}`,
            });
          }
          if (paramSchema.max !== undefined && value > paramSchema.max) {
            errors.push({
              location: "param", ref: step.id, param: paramSchema.key,
              code: "VOLUME_ABOVE_MAX",
              message: `Step '${step.id}': ${paramSchema.key}=${value} exceeds maximum ${paramSchema.max}`,
              suggestion: `Use at most ${paramSchema.max} ${paramSchema.unit ?? ""}. For larger volumes, use multiple steps.`,
            });
          }
        }

        // Well format check
        if (paramSchema.type === "well" && typeof value === "string") {
          const pattern = new RegExp(card.constraints.wellPattern);
          if (!pattern.test(value)) {
            errors.push({
              location: "param", ref: step.id, param: paramSchema.key,
              code: "INVALID_WELL",
              message: `Step '${step.id}': well '${value}' doesn't match pattern ${card.constraints.wellPattern}`,
              suggestion: "Use format like A1, B3, H12 (rows A-H, columns 1-12)",
            });
          }
        }

        // Slot reference check
        if ((paramSchema.type === "slot" || paramSchema.key.includes("Slot") || paramSchema.key.includes("slot")) && value !== undefined) {
          const slotStr = String(value);
          if (!deckLabware.has(slotStr)) {
            errors.push({
              location: "param", ref: step.id, param: paramSchema.key,
              code: "SLOT_EMPTY",
              message: `Step '${step.id}': references slot '${slotStr}' which has no labware loaded in the deck config`,
              suggestion: `Add labware to slot ${slotStr} in the deck array, or use a slot that has labware: ${[...deckLabware.keys()].join(", ")}`,
            });
          }
        }

        // Enum check
        if (paramSchema.type === "enum" && paramSchema.options) {
          const validValues = paramSchema.options.map((o) => o.value);
          if (!validValues.includes(String(value))) {
            errors.push({
              location: "param", ref: step.id, param: paramSchema.key,
              code: "PARAM_TYPE_MISMATCH",
              message: `Step '${step.id}': '${paramSchema.key}' value '${value}' not in allowed values`,
              suggestion: `Allowed: ${validValues.join(", ")}`,
            });
          }
        }

        // Pipette availability check
        if (paramSchema.key === "pipette" && typeof value === "string") {
          const hasPipette = pipettes.some((p) => p.mount === value);
          if (!hasPipette) {
            errors.push({
              location: "param", ref: step.id, param: "pipette",
              code: "PIPETTE_NOT_AVAILABLE",
              message: `Step '${step.id}': pipette mount '${value}' not installed`,
              suggestion: `Available mounts: ${pipettes.map((p) => p.mount).join(", ")}`,
            });
          }
        }
      }
    }

    // 6. If no errors, mark idempotency key as processed
    if (errors.length === 0) {
      this.processedKeys.add(bundle.idempotencyKey);
      // Trim old keys (keep last 1000)
      if (this.processedKeys.size > 1000) {
        const keys = [...this.processedKeys];
        this.processedKeys = new Set(keys.slice(-500));
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /** Reset processed keys (for testing) */
  reset(): void {
    this.processedKeys.clear();
  }
}
