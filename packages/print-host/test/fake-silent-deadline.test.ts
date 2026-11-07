import { expect, it, vi } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";

it("repeated silent cancels retain the first deadline", async () => {
  // This file's isolated module registry keeps the fake scheduler out of GAP-7.
  vi.resetModules();
  vi.useFakeTimers();
  let adapter: import("../src/testing/fake-machine-adapter.js").FakeMachineAdapter | undefined;
  try {
    const { FakeMachineAdapter: ScheduledFake } = await import("../src/testing/fake-machine-adapter.js");
    adapter = new ScheduledFake(
      "n144-printer-first-cancel-deadline", "n144-print-host-first-cancel-deadline",
      { cancelBehavior: "silent", cancelConfirmMs: 100 },
    );
    adapter.scriptStart({ outcome: "success", jobId: 125 });
    await adapter.execute({ type: "start" });
    const events: Array<Omit<EvidenceEvent, "id" | "hash">> = [];
    adapter.onEvidence((event) => events.push(event));
    await adapter.cancelJob(125);
    await vi.advanceTimersByTimeAsync(60);
    await adapter.cancelJob(125);
    await vi.advanceTimersByTimeAsync(39);
    expect(events, "the first cancel deadline has not yet elapsed").toHaveLength(0);
    expect(await adapter.getStatus()).toBe("busy");
    await vi.advanceTimersByTimeAsync(1);
    expect(events, "a later cancel must not extend the first cancel deadline").toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "execution_failed", payload: { ippJobId: 125, reason: "cancel-unconfirmed", origin: "device" },
    });
    expect(await adapter.getStatus()).toBe("idle");
    await vi.advanceTimersByTimeAsync(60);
    expect(events, "the later cancel must not schedule a second report").toHaveLength(1);
    expect(adapter.cancels).toEqual([125, 125]);
  } finally {
    try {
      await adapter?.dispose();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  }
});
