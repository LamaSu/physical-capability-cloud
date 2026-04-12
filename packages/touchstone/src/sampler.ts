/**
 * Bernoulli sampler — decides whether to inject a touchstone task and selects
 * which task from a library.
 */

import type { TouchstoneLibrary, TouchstoneTask } from "./types.js";

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Cumulative injection / detection statistics. */
export interface SamplerStats {
  /** Total calls to shouldInject(). */
  totalChecks: number;
  /** Number of times a touchstone was injected. */
  totalInjections: number;
  /** Observed injection rate (injections / checks). */
  observedRate: number;
  /** Number of touchstone results recorded. */
  totalResults: number;
  /** Number of touchstone passes. */
  passes: number;
  /** Number of touchstone failures. */
  failures: number;
}

// ---------------------------------------------------------------------------
// BernoulliSampler
// ---------------------------------------------------------------------------

export class BernoulliSampler {
  private readonly rate: number;
  private readonly deterministic: boolean;
  private readonly deterministicInterval: number;

  // Stats tracking
  private totalChecks = 0;
  private totalInjections = 0;
  private totalResults = 0;
  private passes = 0;
  private failures = 0;

  /**
   * @param rate Injection probability per task (0-1).  Default 0.15.
   * @param strategy `"bernoulli"` (random) or `"deterministic"` (every Nth).
   */
  constructor(rate = 0.15, strategy: "bernoulli" | "deterministic" = "bernoulli") {
    if (rate < 0 || rate > 1) {
      throw new RangeError(`Injection rate must be in [0, 1], got ${rate}`);
    }
    this.rate = rate;
    this.deterministic = strategy === "deterministic";
    // For deterministic mode: inject every Nth task where N = round(1/rate).
    // Guard against rate === 0 (never inject).
    this.deterministicInterval = rate > 0 ? Math.max(1, Math.round(1 / rate)) : Infinity;
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Returns `true` if a touchstone should be injected for this task.
   *
   * - **Bernoulli mode**: each call is an independent coin flip at `rate`.
   * - **Deterministic mode**: injects every Nth call (N = round(1/rate)).
   */
  shouldInject(): boolean {
    this.totalChecks++;

    let inject: boolean;
    if (this.deterministic) {
      inject = this.totalChecks % this.deterministicInterval === 0;
    } else {
      inject = Math.random() < this.rate;
    }

    if (inject) {
      this.totalInjections++;
    }
    return inject;
  }

  /**
   * Select a random task from the given library.
   * Throws if the library has no tasks.
   */
  selectTask(library: TouchstoneLibrary): TouchstoneTask {
    if (library.tasks.length === 0) {
      throw new Error(`Library "${library.name}" has no tasks to select from`);
    }
    const idx = Math.floor(Math.random() * library.tasks.length);
    return library.tasks[idx];
  }

  /**
   * Record a touchstone verification result (used for stats tracking).
   */
  recordResult(passed: boolean): void {
    this.totalResults++;
    if (passed) {
      this.passes++;
    } else {
      this.failures++;
    }
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Return cumulative injection / detection statistics. */
  getStats(): SamplerStats {
    return {
      totalChecks: this.totalChecks,
      totalInjections: this.totalInjections,
      observedRate: this.totalChecks > 0
        ? this.totalInjections / this.totalChecks
        : 0,
      totalResults: this.totalResults,
      passes: this.passes,
      failures: this.failures,
    };
  }
}
