/** Additional lifecycle edges for the generic fake. */
import { describe, expect, it } from "vitest";
import type { EvidenceEvent } from "@pcc/spec";
import { FakeDevice, type FakeDeviceOptions } from "../testing/fake-device.js";

type Emitted = Omit<EvidenceEvent, "id" | "hash">;

describe("FakeDevice lifecycle edges", () => {
  it.each([
    "preset", "bindingKey", "type", "deviceType", "startedType", "progressType",
    "completedType", "failedType", "declaredCommands", "startedEvent",
    "cancelBehavior", "cancelEventOrder", "cancelConfirmMs", "clock",
  ])("rejects explicit null option %s instead of using its default", (key) => {
    expect(() => new FakeDevice("null-options", "kernel", { [key]: null } as FakeDeviceOptions)).toThrow();
  });

  it("does not retain nested caller payloads across events", async () => {
    const device = new FakeDevice("nested-copy", "kernel");
    const payload = { samples: [{ value: 7 }] };
    const events: Emitted[] = [];
    device.onEvidence((event) => {
      events.push(structuredClone(event));
      if (Array.isArray(event.payload.samples)) {
        (event.payload.samples as { value: number }[])[0].value = 99;
      }
    });
    try {
      device.scriptStart({ outcome: "accept", deviceJobId: "nested-job" });
      await device.execute({ type: "start" });
      device.progress(1, payload);
      expect(payload.samples[0].value).toBe(7);
      device.progress(2, payload);
      expect(events.map((event) => event.payload.samples)).toEqual([[{ value: 7 }], [{ value: 7 }]]);
      device.complete();
    } finally { await device.dispose(); }
  });

  it("drops a deferred started callback after that job ends, even when the next job reuses its id", async () => {
    const device = new FakeDevice("reused-id", "kernel", { startedEvent: "after-start" });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    try {
      device.scriptStart({ outcome: "accept", deviceJobId: "reused" });
      const first = device.execute({ type: "start" });
      device.complete();
      device.scriptStart({ outcome: "accept", deviceJobId: "reused" });
      const second = device.execute({ type: "start" });
      await Promise.all([first, second]);
      expect(events.map((event) => event.type)).toEqual(["execution_completed", "execution_started"]);
      device.complete();
    } finally { await device.dispose(); }
  });

  it.each(["execution_completed", "execution_failed"] as const)("keeps native %s terminal when custom roles are configured", async (type) => {
    const device = new FakeDevice("native-terminal", "kernel", {
      completedType: "batch_session_completed", failedType: "sensor_anomaly_detected",
    });
    const events: Emitted[] = [];
    device.onEvidence((event) => events.push(event));
    try {
      device.scriptStart({ outcome: "accept", deviceJobId: "native-job" });
      await device.execute({ type: "start" });
      device.emit(type);
      await device.quiesceEvidence();
      expect(await device.getStatus()).toBe("idle");
      expect(() => device.progress(1)).toThrow();
      expect(events[0].payload.deviceJobId).toBe("native-job");
      if (type === "execution_failed") expect(events[0].payload.origin).toBe("device");
    } finally { await device.dispose(); }
  });
});
