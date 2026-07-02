/**
 * Calibrated capacity model.
 *
 * The PyLabRobot poka-yoke pattern's first gate is a calibrated
 * height<->volume model that refuses an aspirate/dispense outside the
 * physically-known-good range for the labware — independent of how much
 * liquid is actually left in the well. This module generalizes that to
 * any named resource with a known [min, max] physical range: battery
 * capacity, payload mass, build volume, reachability envelope, etc.
 *
 * A request outside calibrated bounds is a *modeling* refusal (the
 * machine was never characterized to handle this amount) — distinct from
 * an *availability* refusal (the machine could handle it, but not enough
 * is left right now), which is ResourceTracker's job.
 */

import { OutOfCalibratedRangeError, UnknownResourceError } from "./errors.js";

export interface ResourceBounds {
  /** Smallest amount considered reliably deliverable/measurable. Must be >= 0. */
  min: number;
  /** Largest amount the resource can physically hold or deliver. */
  max: number;
  /** Unit label for diagnostics only (e.g. "g", "mm3", "mL"). Not enforced. */
  unit?: string;
}

export class CapacityModel {
  private readonly bounds: ReadonlyMap<string, ResourceBounds>;

  constructor(bounds: Record<string, ResourceBounds>) {
    const entries = Object.entries(bounds);
    for (const [resource, b] of entries) {
      if (!Number.isFinite(b.min) || !Number.isFinite(b.max)) {
        throw new Error(`CapacityModel: "${resource}" bounds must be finite numbers`);
      }
      if (b.min < 0) {
        throw new Error(`CapacityModel: "${resource}" min (${b.min}) must be >= 0`);
      }
      if (b.max < b.min) {
        throw new Error(`CapacityModel: "${resource}" max (${b.max}) is less than min (${b.min})`);
      }
    }
    this.bounds = new Map(entries);
  }

  /** All resource names this model has calibration data for. */
  resources(): string[] {
    return [...this.bounds.keys()];
  }

  /** Throws UnknownResourceError if `resource` was never calibrated. */
  boundsFor(resource: string): ResourceBounds {
    const b = this.bounds.get(resource);
    if (!b) throw new UnknownResourceError(resource);
    return b;
  }

  /**
   * Throws OutOfCalibratedRangeError (or UnknownResourceError) if `amount`
   * is not a physically-plausible request for `resource`. Returns void on
   * success — call-then-continue, not a boolean the caller might ignore.
   */
  assertInRange(resource: string, amount: number): void {
    const bounds = this.boundsFor(resource);
    if (!Number.isFinite(amount) || amount < bounds.min || amount > bounds.max) {
      throw new OutOfCalibratedRangeError(resource, amount, bounds);
    }
  }
}
