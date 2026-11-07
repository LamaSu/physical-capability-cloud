import type { EvidenceEvent } from "@pcc/spec";
import type { MachineAdapter, MachineCommand } from "../../adapters/types.js";
import type { FakeDevice } from "../../testing/fake-device.js";

export const DEVICE_FAULTS = [
  "emitAfterQuiesce", "quiesceEarly", "foreignDeviceJob", "unboundTerminal",
  "noDeviceJobId", "busyWithoutFlag", "cancelOtherJob", "stopInsteadOfCancel",
  "emitAfterDispose", "untagged",
] as const;

export type DeviceFault = typeof DEVICE_FAULTS[number];
type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;

/**
 * Deliberately violate one MachineAdapter contract for conformance tests.
 *
 * This belongs under __tests__: in particular, `untagged` contradicts
 * spec/evidence/is-fabricated.ts's independent fabrication signals and must
 * never be part of the shipped @pcc/kernel/testing surface. Quiesce faults
 * target adapters/types.ts:8-23; identity faults target printer-job.ts:35-66.
 */
export function withFault(device: FakeDevice, fault: DeviceFault): MachineAdapter {
  const listeners = new Set<(event: DeviceEvent) => void>();
  let activeId: string | number | undefined;
  let lastEvent: DeviceEvent | undefined;
  let changedEvent = false;
  let changedResult = false;
  let replayedQuiesce = false;
  let replayedDispose = false;
  let disposed = false;

  const publish = (event: DeviceEvent): void => {
    for (const listener of listeners) listener(structuredClone(event));
  };

  device.onEvidence((incoming) => {
    const event = structuredClone(incoming);
    lastEvent = structuredClone(incoming);
    const boundId = incoming.payload[device.bindingKey];
    if (typeof boundId === "string" || typeof boundId === "number") activeId = boundId;
    const terminal = event.type === device.completedType || event.type === device.failedType ||
      event.type === "execution_completed" || event.type === "execution_failed";

    if (fault === "foreignDeviceJob" && !changedEvent && boundId !== undefined) {
      event.payload[device.bindingKey] = typeof boundId === "number"
        ? (boundId === 1 ? 2 : 1)
        : `${String(boundId)}-foreign`;
      changedEvent = true;
    }
    if (fault === "unboundTerminal" && !changedEvent && terminal) {
      delete event.payload[device.bindingKey];
      changedEvent = true;
    }
    if (fault === "untagged") {
      delete event.source.simulated;
      delete event.payload.mock;
    }

    publish(event);
    if (terminal) activeId = undefined;
  });

  return {
    id: device.id,
    type: device.type,
    source: device.source,
    getStatus: () => device.getStatus(),
    getProgress: () => device.getProgress(),
    onEvidence: (listener) => { listeners.add(listener); },
    async execute(command: MachineCommand) {
      const result = await device.execute(command);
      if (command.type === "start" && result.success) {
        const id = result.data?.jobId;
        if (typeof id === "string" || typeof id === "number") activeId = id;
        if (fault === "noDeviceJobId" && !changedResult) {
          const data = { ...result.data };
          delete data.jobId;
          delete data[device.bindingKey];
          changedResult = true;
          return { ...result, data };
        }
      }
      if (fault === "busyWithoutFlag" && result.busy && !changedResult) {
        const copy = { ...result, data: { ...result.data } };
        delete copy.busy;
        delete copy.data.busy;
        changedResult = true;
        return copy;
      }
      return result;
    },
    async cancelJob(id) {
      if (fault === "stopInsteadOfCancel") {
        await device.execute({ type: "stop" });
        return;
      }
      // Substituting the job id preserves the device's report/deadline/refusal
      // behavior; only cancellation ownership is changed.
      await device.cancelJob(fault === "cancelOtherJob" && activeId !== undefined ? activeId : id);
    },
    async quiesceEvidence() {
      if (fault === "quiesceEarly") return;
      await device.quiesceEvidence();
      if (fault === "emitAfterQuiesce" && lastEvent && !replayedQuiesce) {
        replayedQuiesce = true;
        const replay = structuredClone(lastEvent);
        setImmediate(() => { if (!disposed) publish(replay); });
      }
    },
    async dispose() {
      disposed = true;
      // A start need not emit any evidence. Preserve its identity so the
      // disposal fault still produces one bound, honestly tagged event.
      const fallback: DeviceEvent | undefined = activeId === undefined ? undefined : {
        type: device.progressType,
        timestamp: "2026-10-09T00:00:00.000Z",
        source: { ...structuredClone(device.source), simulated: true },
        payload: { [device.bindingKey]: activeId, mock: true },
      };
      const candidate = lastEvent?.payload[device.bindingKey] === activeId
        ? lastEvent
        : (fallback ?? lastEvent);
      await device.dispose();
      if (fault === "emitAfterDispose" && candidate && !replayedDispose) {
        replayedDispose = true;
        const replay = structuredClone(candidate);
        setImmediate(() => publish(replay));
      }
      if (fault !== "emitAfterDispose") listeners.clear();
    },
  };
}
