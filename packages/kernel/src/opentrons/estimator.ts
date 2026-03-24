/**
 * Time & Cost Estimator — protocol-aware duration prediction.
 *
 * Combines three estimation strategies:
 * 1. Structural: count protocol operations × known per-op timings
 * 2. Historical: average duration of similar past protocols
 * 3. Queue-aware: wait time + execution time = total time to results
 *
 * Also estimates consumable usage (tips, reagent volume) so agents
 * can factor in whether the operator has enough stock.
 */

import type { ProtocolStep, ProtocolTemplate } from "@pcc/spec";
import type { PipetteInfo } from "./types.js";

// ── Per-Operation Timing Constants (ms) ─────────────────────────

/** Empirical timing data for Opentrons operations.
 *  Source: OT-2 average observed times at standard speed. */
const OP_TIMING: Record<string, number> = {
  aspirate:        3_000,   // position + aspirate + settle
  dispense:        2_500,   // position + dispense
  mix:             4_000,   // per repetition cycle (aspirate + dispense)
  transfer:        8_000,   // pick tip + aspirate + move + dispense + drop tip
  distribute:      6_000,   // aspirate once + dispense to N wells (base, +1.5s per dest)
  consolidate:     6_000,   // aspirate from N wells + dispense once (base, +1.5s per source)
  blow_out:        1_500,
  touch_tip:       1_000,
  air_gap:         1_000,
  drop_tip:        2_000,
  pick_up_tip:     2_500,
  thermocycler_set_temperature: 0,  // actual hold time is in params
  temperature_module_set:       0,  // ramp time depends on delta
  delay:           0,        // actual seconds in params
  pause:           0,        // operator-dependent, unpredictable
  comment:         0,
};

/** Time to ramp thermocycler by 1°C (ms) */
const THERMOCYCLER_RAMP_MS_PER_DEGREE = 500;

/** Time to ramp temperature module by 1°C (ms) */
const TEMP_MODULE_RAMP_MS_PER_DEGREE = 2_000;

/** Default ambient temperature for ramp calculations */
const AMBIENT_TEMP_C = 22;

// ── Estimation Result ─────────────────────────────────────────────

export interface TimeEstimate {
  /** Total estimated protocol execution time (ms) */
  executionMs: number;
  /** Breakdown by step */
  stepBreakdown: Array<{
    stepId: string;
    label: string;
    action: string;
    estimatedMs: number;
    /** Why this estimate (structural, historical, or fallback) */
    basis: "structural" | "historical" | "fallback";
  }>;
  /** Confidence: 0-1. Lower when using fallbacks, higher with historical data */
  confidence: number;
  /** Human-readable summary */
  summary: string;
}

export interface ConsumableEstimate {
  /** Total tip pick-ups (tip changes) */
  tipChanges: number;
  /** Tips needed per rack type */
  tipsByType: Record<string, number>;
  /** Total liquid volume aspirated (µL) */
  totalAspirateUl: number;
  /** Total liquid volume dispensed (µL) */
  totalDispenseUl: number;
  /** Distinct wells touched (source) */
  sourceWells: number;
  /** Distinct wells touched (destination) */
  destWells: number;
  /** Whether the protocol requires module warm-up */
  requiresModuleWarmup: boolean;
  /** Estimated reagent volumes by source slot */
  reagentBySlot: Record<string, number>;
}

export interface CostEstimate {
  /** Base cost */
  baseCost: number;
  /** Time-based cost */
  timeCost: number;
  /** Total */
  totalCost: number;
  /** Currency */
  currency: string;
  /** Breakdown */
  breakdown: Array<{ label: string; amount: number }>;
}

export interface FullEstimate {
  time: TimeEstimate;
  consumables: ConsumableEstimate;
  cost: CostEstimate;
  /** Queue-aware: total time including wait */
  queueWaitMs: number;
  /** Total time from submission to completion */
  totalTimeMs: number;
  /** When the job would start (ISO) */
  estimatedStart: string;
  /** When the job would complete (ISO) */
  estimatedCompletion: string;
}

// ── Estimator ─────────────────────────────────────────────────────

export class ProtocolEstimator {
  private history: JobHistoryEntry[] = [];

  /** Record a completed job for future estimation accuracy */
  recordCompletion(entry: JobHistoryEntry): void {
    this.history.push(entry);
    // Keep last 200 entries
    if (this.history.length > 200) {
      this.history = this.history.slice(-200);
    }
  }

  /** Estimate execution time for a protocol template */
  estimateTime(
    template: ProtocolTemplate,
    params: Record<string, string | number | boolean>,
  ): TimeEstimate {
    // Try historical first
    const historical = this.findHistoricalMatch(template);
    if (historical) {
      return {
        executionMs: historical.avgDurationMs,
        stepBreakdown: template.steps.map((s) => ({
          stepId: s.id,
          label: s.label,
          action: s.action,
          estimatedMs: Math.round(historical.avgDurationMs / template.steps.length),
          basis: "historical" as const,
        })),
        confidence: Math.min(0.95, 0.5 + historical.sampleCount * 0.1),
        summary: `Based on ${historical.sampleCount} previous runs (avg ${Math.round(historical.avgDurationMs / 60_000)}min)`,
      };
    }

    // Structural estimation from step analysis
    let totalMs = 0;
    let unknownSteps = 0;
    const resolvedParams = { ...template.defaultValues, ...params };
    const breakdown: TimeEstimate["stepBreakdown"] = [];

    for (const step of template.steps) {
      const stepMs = this.estimateStepMs(step, resolvedParams);
      if (stepMs === 0 && step.action !== "comment") unknownSteps++;
      totalMs += stepMs;
      breakdown.push({
        stepId: step.id,
        label: step.label,
        action: step.action,
        estimatedMs: stepMs,
        basis: OP_TIMING[step.action] !== undefined ? "structural" : "fallback",
      });
    }

    // If many steps were unknown, use template's own estimate with low confidence
    if (unknownSteps > template.steps.length * 0.5) {
      totalMs = template.estimatedTotalDurationMs || totalMs;
    }

    // Add 10% buffer for deck movements between steps
    totalMs = Math.round(totalMs * 1.1);

    const confidence = unknownSteps === 0 ? 0.8 : Math.max(0.3, 0.8 - unknownSteps * 0.1);

    return {
      executionMs: totalMs,
      stepBreakdown: breakdown,
      confidence,
      summary: `Structural estimate: ${Math.round(totalMs / 60_000)}min (${template.steps.length} steps, confidence ${Math.round(confidence * 100)}%)`,
    };
  }

  /** Estimate consumable usage for a protocol */
  estimateConsumables(
    template: ProtocolTemplate,
    params: Record<string, string | number | boolean>,
  ): ConsumableEstimate {
    const resolved = { ...template.defaultValues, ...params };
    let tipChanges = 0;
    let totalAspirateUl = 0;
    let totalDispenseUl = 0;
    const sourceWells = new Set<string>();
    const destWells = new Set<string>();
    let requiresModuleWarmup = false;
    const reagentBySlot: Record<string, number> = {};

    for (const step of template.steps) {
      const p = this.resolveStepParams(step, resolved);

      switch (step.action) {
        case "aspirate":
          totalAspirateUl += (p.volume as number) ?? 0;
          sourceWells.add(`${p.slot}:${p.well}`);
          reagentBySlot[String(p.slot ?? "?")] = (reagentBySlot[String(p.slot ?? "?")] ?? 0) + ((p.volume as number) ?? 0);
          break;

        case "dispense":
          totalDispenseUl += (p.volume as number) ?? 0;
          destWells.add(`${p.slot}:${p.well}`);
          break;

        case "transfer":
          tipChanges += (p.newTip === "always" || p.newTip === undefined) ? 1 : 0;
          totalAspirateUl += (p.volume as number) ?? 0;
          totalDispenseUl += (p.volume as number) ?? 0;
          sourceWells.add(`${p.sourceSlot}:${p.sourceWell}`);
          destWells.add(`${p.destSlot}:${p.destWell}`);
          reagentBySlot[String(p.sourceSlot ?? "?")] = (reagentBySlot[String(p.sourceSlot ?? "?")] ?? 0) + ((p.volume as number) ?? 0);
          break;

        case "distribute": {
          tipChanges++;
          const vol = (p.volume as number) ?? 0;
          const dests = Array.isArray(p.destWells) ? p.destWells.length : 1;
          totalAspirateUl += vol * dests;
          totalDispenseUl += vol * dests;
          sourceWells.add(`${p.sourceSlot}:${p.sourceWell}`);
          reagentBySlot[String(p.sourceSlot ?? "?")] = (reagentBySlot[String(p.sourceSlot ?? "?")] ?? 0) + vol * dests;
          break;
        }

        case "consolidate": {
          tipChanges++;
          const vol = (p.volume as number) ?? 0;
          const sources = Array.isArray(p.sourceWells) ? p.sourceWells.length : 1;
          totalAspirateUl += vol * sources;
          totalDispenseUl += vol * sources;
          destWells.add(`${p.destSlot}:${p.destWell}`);
          break;
        }

        case "mix":
          // Mix reuses same tip typically
          totalAspirateUl += ((p.volume as number) ?? 0) * ((p.repetitions as number) ?? 3);
          totalDispenseUl += ((p.volume as number) ?? 0) * ((p.repetitions as number) ?? 3);
          break;

        case "pick_up_tip":
          tipChanges++;
          break;

        case "thermocycler_set_temperature":
        case "temperature_module_set":
          requiresModuleWarmup = true;
          break;
      }
    }

    return {
      tipChanges,
      tipsByType: { "standard": tipChanges }, // simplified; real impl would check pipette type
      totalAspirateUl,
      totalDispenseUl,
      sourceWells: sourceWells.size,
      destWells: destWells.size,
      requiresModuleWarmup,
      reagentBySlot,
    };
  }

  /** Estimate cost for a protocol */
  estimateCost(
    executionMs: number,
    pricing: { baseCost: string; perMinute: string; minimum: string; currency: string },
  ): CostEstimate {
    const base = parseFloat(pricing.baseCost);
    const perMin = parseFloat(pricing.perMinute);
    const minutes = executionMs / 60_000;
    const timeCost = perMin * minutes;
    const total = Math.max(parseFloat(pricing.minimum), base + timeCost);

    return {
      baseCost: base,
      timeCost,
      totalCost: total,
      currency: pricing.currency,
      breakdown: [
        { label: "Base cost", amount: base },
        { label: `Runtime (${Math.round(minutes)}min × ${pricing.currency} ${perMin}/min)`, amount: timeCost },
        ...(total > base + timeCost ? [{ label: "Minimum charge applied", amount: total - base - timeCost }] : []),
      ],
    };
  }

  /** Build a full estimate including queue wait */
  estimateFull(
    template: ProtocolTemplate,
    params: Record<string, string | number | boolean>,
    pricing: { baseCost: string; perMinute: string; minimum: string; currency: string },
    queueWaitMs: number,
  ): FullEstimate {
    const time = this.estimateTime(template, params);
    const consumables = this.estimateConsumables(template, params);
    const cost = this.estimateCost(time.executionMs, pricing);
    const totalTimeMs = queueWaitMs + time.executionMs;

    return {
      time,
      consumables,
      cost,
      queueWaitMs,
      totalTimeMs,
      estimatedStart: new Date(Date.now() + queueWaitMs).toISOString(),
      estimatedCompletion: new Date(Date.now() + totalTimeMs).toISOString(),
    };
  }

  // ── Private ───────────────────────────────────────────────────

  private estimateStepMs(
    step: ProtocolStep,
    params: Record<string, string | number | boolean>,
  ): number {
    const p = this.resolveStepParams(step, params);
    const baseTime = OP_TIMING[step.action] ?? step.estimatedDurationMs ?? 5000;

    switch (step.action) {
      case "mix":
        return baseTime * ((p.repetitions as number) ?? 3);

      case "distribute": {
        const dests = Array.isArray(p.destWells) ? p.destWells.length : 1;
        return baseTime + dests * 1_500;
      }

      case "consolidate": {
        const sources = Array.isArray(p.sourceWells) ? p.sourceWells.length : 1;
        return baseTime + sources * 1_500;
      }

      case "delay":
        return ((p.seconds as number) ?? 0) * 1_000;

      case "pause":
        // Can't predict operator pause time; use 0 and flag it
        return 0;

      case "thermocycler_set_temperature": {
        const target = (p.temperature as number) ?? 95;
        const holdSec = (p.holdTimeSeconds as number) ?? 0;
        const rampMs = Math.abs(target - AMBIENT_TEMP_C) * THERMOCYCLER_RAMP_MS_PER_DEGREE;
        return rampMs + holdSec * 1_000;
      }

      case "temperature_module_set": {
        const target = (p.temperature as number) ?? 4;
        const rampMs = Math.abs(target - AMBIENT_TEMP_C) * TEMP_MODULE_RAMP_MS_PER_DEGREE;
        return rampMs;
      }

      default:
        return baseTime;
    }
  }

  private resolveStepParams(
    step: ProtocolStep,
    params: Record<string, string | number | boolean>,
  ): Record<string, unknown> {
    const p = { ...step.params };
    if (step.parameterBindings) {
      for (const binding of step.parameterBindings) {
        if (params[binding.protocolParamKey] !== undefined) {
          p[binding.stepParamKey] = params[binding.protocolParamKey];
        }
      }
    }
    return p;
  }

  private findHistoricalMatch(
    template: ProtocolTemplate,
  ): { avgDurationMs: number; sampleCount: number } | null {
    // Match by template ID first
    const byId = this.history.filter((h) => h.templateId === template.id);
    if (byId.length >= 3) {
      const avg = byId.reduce((s, h) => s + h.actualDurationMs, 0) / byId.length;
      return { avgDurationMs: avg, sampleCount: byId.length };
    }

    // Match by similar step count + action profile
    const actionProfile = template.steps.map((s) => s.action).sort().join(",");
    const bySimilar = this.history.filter((h) => h.actionProfile === actionProfile);
    if (bySimilar.length >= 3) {
      const avg = bySimilar.reduce((s, h) => s + h.actualDurationMs, 0) / bySimilar.length;
      return { avgDurationMs: avg, sampleCount: bySimilar.length };
    }

    return null;
  }
}

// ── Job History Entry ─────────────────────────────────────────────

export interface JobHistoryEntry {
  jobId: string;
  templateId: string;
  actionProfile: string;
  stepCount: number;
  actualDurationMs: number;
  estimatedDurationMs: number;
  completedAt: string;
  success: boolean;
}
