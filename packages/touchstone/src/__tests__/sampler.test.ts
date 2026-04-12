import { describe, it, expect } from "vitest";
import { BernoulliSampler } from "../sampler.js";
import { accountingLibrary } from "../library/accounting.js";
import { procurementLibrary } from "../library/procurement.js";

describe("BernoulliSampler", () => {
  // --------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------

  it("throws on invalid injection rate (negative)", () => {
    expect(() => new BernoulliSampler(-0.1)).toThrow(RangeError);
  });

  it("throws on invalid injection rate (> 1)", () => {
    expect(() => new BernoulliSampler(1.5)).toThrow(RangeError);
  });

  it("accepts edge rates 0 and 1", () => {
    expect(() => new BernoulliSampler(0)).not.toThrow();
    expect(() => new BernoulliSampler(1)).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // Bernoulli mode — statistical injection rate
  // --------------------------------------------------------------------------

  it("injects at approximately the configured rate (15%) over 2000 trials", () => {
    const sampler = new BernoulliSampler(0.15, "bernoulli");
    let injections = 0;
    const trials = 2000;

    for (let i = 0; i < trials; i++) {
      if (sampler.shouldInject()) injections++;
    }

    const observedRate = injections / trials;
    // Allow +/- 5% tolerance from target rate
    expect(observedRate).toBeGreaterThan(0.10);
    expect(observedRate).toBeLessThan(0.20);
  });

  it("never injects at rate 0", () => {
    const sampler = new BernoulliSampler(0, "bernoulli");
    let injections = 0;

    for (let i = 0; i < 500; i++) {
      if (sampler.shouldInject()) injections++;
    }

    expect(injections).toBe(0);
  });

  it("always injects at rate 1", () => {
    const sampler = new BernoulliSampler(1, "bernoulli");
    let injections = 0;
    const trials = 100;

    for (let i = 0; i < trials; i++) {
      if (sampler.shouldInject()) injections++;
    }

    expect(injections).toBe(trials);
  });

  // --------------------------------------------------------------------------
  // Deterministic mode
  // --------------------------------------------------------------------------

  it("injects every Nth task in deterministic mode (rate 0.2 => every 5th)", () => {
    const sampler = new BernoulliSampler(0.2, "deterministic");
    const results: boolean[] = [];

    for (let i = 0; i < 20; i++) {
      results.push(sampler.shouldInject());
    }

    // With rate 0.2, interval = round(1/0.2) = 5
    // Injections at indices 4, 9, 14, 19 (5th, 10th, 15th, 20th call)
    expect(results[4]).toBe(true);
    expect(results[9]).toBe(true);
    expect(results[14]).toBe(true);
    expect(results[19]).toBe(true);

    // Non-injection positions
    expect(results[0]).toBe(false);
    expect(results[1]).toBe(false);
    expect(results[2]).toBe(false);
    expect(results[3]).toBe(false);
  });

  it("deterministic mode injects at the correct total count", () => {
    const sampler = new BernoulliSampler(0.1, "deterministic");
    let injections = 0;

    // rate 0.1 => interval = 10, so 100 tasks => 10 injections
    for (let i = 0; i < 100; i++) {
      if (sampler.shouldInject()) injections++;
    }

    expect(injections).toBe(10);
  });

  // --------------------------------------------------------------------------
  // Stats tracking
  // --------------------------------------------------------------------------

  it("tracks injection statistics correctly", () => {
    const sampler = new BernoulliSampler(1.0, "bernoulli");

    sampler.shouldInject();
    sampler.shouldInject();
    sampler.shouldInject();

    const stats = sampler.getStats();
    expect(stats.totalChecks).toBe(3);
    expect(stats.totalInjections).toBe(3);
    expect(stats.observedRate).toBeCloseTo(1.0);
  });

  it("tracks pass/fail results", () => {
    const sampler = new BernoulliSampler(0.5);

    sampler.recordResult(true);
    sampler.recordResult(true);
    sampler.recordResult(false);

    const stats = sampler.getStats();
    expect(stats.totalResults).toBe(3);
    expect(stats.passes).toBe(2);
    expect(stats.failures).toBe(1);
  });

  it("returns zero observedRate before any checks", () => {
    const sampler = new BernoulliSampler(0.15);
    const stats = sampler.getStats();
    expect(stats.observedRate).toBe(0);
    expect(stats.totalChecks).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Task selection
  // --------------------------------------------------------------------------

  it("selects a task from the accounting library", () => {
    const sampler = new BernoulliSampler(0.15);
    const task = sampler.selectTask(accountingLibrary);

    expect(task).toBeDefined();
    expect(task.taskId).toBeTruthy();
    expect(task.scope).toBe("accounting");
    expect(accountingLibrary.tasks).toContain(task);
  });

  it("selects a task from the procurement library", () => {
    const sampler = new BernoulliSampler(0.15);
    const task = sampler.selectTask(procurementLibrary);

    expect(task).toBeDefined();
    expect(task.taskId).toBeTruthy();
    expect(task.scope).toBe("procurement");
    expect(procurementLibrary.tasks).toContain(task);
  });

  it("throws when selecting from an empty library", () => {
    const sampler = new BernoulliSampler(0.15);
    const emptyLib = {
      id: "empty",
      name: "Empty",
      taskType: "test",
      tasks: [],
      description: "An empty library for testing.",
    };

    expect(() => sampler.selectTask(emptyLib)).toThrow(/no tasks/i);
  });
});
