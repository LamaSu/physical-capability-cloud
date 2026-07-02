/**
 * Tests for MockFDMAdapter.preflight() — the reference implementation of
 * the R3 resource-tracker gate on a MachineAdapter.
 *
 * Acceptance (ROBOTICS-BUILD-SPEC.md §R3): an under-resourced job is
 * refused at preflight() before escrow/execute(); a sufficient job
 * passes; tests green.
 */

import { describe, it, expect } from "vitest";
import { MockFDMAdapter } from "../mock-fdm.js";

const KERNEL_ID = "kernel-preflight-test";

describe("MockFDMAdapter.preflight() — refuse-to-start", () => {
  it("refuses an under-resourced job BEFORE execute()/escrow", async () => {
    const printer = new MockFDMAdapter("printer-1", KERNEL_ID, 1000, {
      filamentGrams: { available: 50 }, // only 50g on the spool
    });

    const result = await printer.preflight({
      jobId: "job-under",
      requirements: { filamentGrams: 200, buildVolumeMm3: 1000 }, // needs 200g
    });

    expect(result.ok).toBe(false);
    expect(result.refusal?.code).toBe("insufficient_resource");
    expect(result.reservationId).toBeUndefined();

    // Refusal must not have loaded/started the machine.
    expect(await printer.getStatus()).toBe("idle");
  });

  it("passes a sufficient job and returns a reservation token", async () => {
    const printer = new MockFDMAdapter("printer-2", KERNEL_ID, 1000, {
      filamentGrams: { available: 500 },
    });

    const result = await printer.preflight({
      jobId: "job-ok",
      requirements: { filamentGrams: 120, buildVolumeMm3: 1000 },
    });

    expect(result.ok).toBe(true);
    expect(result.reservationId).toBeTruthy();
    expect(result.refusal).toBeUndefined();
  });

  it("refuses a request outside the calibrated range (e.g. negative/absurd amount)", async () => {
    const printer = new MockFDMAdapter("printer-3", KERNEL_ID);

    const result = await printer.preflight({
      requirements: { filamentGrams: 999_999, buildVolumeMm3: 1000 },
    });

    expect(result.ok).toBe(false);
    expect(result.refusal?.code).toBe("out_of_calibrated_range");
  });

  it("commitReservation() permanently consumes capacity after a successful run", async () => {
    const printer = new MockFDMAdapter("printer-4", KERNEL_ID, 1000, {
      filamentGrams: { available: 500 },
    });

    const first = await printer.preflight({ requirements: { filamentGrams: 300, buildVolumeMm3: 1000 } });
    expect(first.ok).toBe(true);
    printer.commitReservation(first.reservationId!);

    // Only 200g left after commit — a second 300g job must now be refused.
    const second = await printer.preflight({ requirements: { filamentGrams: 300, buildVolumeMm3: 1000 } });
    expect(second.ok).toBe(false);
    expect(second.refusal?.code).toBe("insufficient_resource");
  });

  it("rollbackReservation() releases the hold without consuming capacity", async () => {
    const printer = new MockFDMAdapter("printer-5", KERNEL_ID, 1000, {
      filamentGrams: { available: 500 },
    });

    const first = await printer.preflight({ requirements: { filamentGrams: 300, buildVolumeMm3: 1000 } });
    expect(first.ok).toBe(true);
    printer.rollbackReservation(first.reservationId!);

    // Full capacity restored — a second 300g job now passes.
    const second = await printer.preflight({ requirements: { filamentGrams: 300, buildVolumeMm3: 1000 } });
    expect(second.ok).toBe(true);
  });

  it("adapters that never call preflight() are unaffected (method is optional on the interface)", async () => {
    const printer = new MockFDMAdapter("printer-6", KERNEL_ID, 50);
    // Exercise the pre-existing execute() path with zero preflight involvement.
    const loadResult = await printer.execute({ type: "load_gcode", payload: { gcodeHash: "abc123" } });
    expect(loadResult.success).toBe(true);
  });
});
