import type { EvidenceEvent } from "@pcc/spec";
import type { MachineAdapter, MachineCommand } from "../adapters/types.js";
import type { FakeDevice } from "./fake-device.js";

export const SHIPPED_DEVICE_FAULTS = [
  "emitAfterQuiesce", "quiesceEarly", "foreignDeviceJob", "unboundTerminal",
  "noDeviceJobId", "busyWithoutFlag", "cancelOtherJob", "stopInsteadOfCancel",
  "emitAfterDispose",
  "doubleTerminal", "payloadJobId", "noCancelJob", "acceptsUndeclared",
] as const;

export type ShippedDeviceFault = typeof SHIPPED_DEVICE_FAULTS[number];
type DeviceEvent = Omit<EvidenceEvent, "id" | "hash">;

/**
 * Deliberate contract violations for conformance self-tests, wrapping the
 * always-tagged FakeDevice. Quiescence follows adapters/types.ts:8-23;
 * device-job ownership follows printer-job.ts:21-31. Every emitted, replayed,
 * duplicated and post-dispose event retains both fabrication tags.
 */
export function withDeviceFault(device: FakeDevice, fault: ShippedDeviceFault): MachineAdapter {
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
    if (fault === "payloadJobId") event.payload.jobId = boundId;

    publish(event);
    if (fault === "doubleTerminal" && terminal && !changedEvent) {
      changedEvent = true;
      publish(event);
    }
    if (terminal) activeId = undefined;
  });

  const adapter: MachineAdapter = {
    id: device.id,
    type: device.type,
    source: device.source,
    getStatus: () => device.getStatus(),
    getProgress: () => device.getProgress(),
    onEvidence: (listener) => { listeners.add(listener); },
    async execute(command: MachineCommand) {
      const result = await device.execute(command);
      if (fault === "acceptsUndeclared" && result.message === `undeclared command: ${command.type}`) {
        return { ...result, success: true };
      }
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
  if (fault === "noCancelJob") delete adapter.cancelJob;
  return adapter;
}
