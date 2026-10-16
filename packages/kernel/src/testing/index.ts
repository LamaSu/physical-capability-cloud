/** Opt-in testing surface; never registered by adapter-factory.ts. */
export { FakeDevice } from "./fake-device.js";
export type { FakeDeviceOptions, FakeDeviceStartOutcome } from "./fake-device.js";
export { SHIPPED_DEVICE_FAULTS, withDeviceFault } from "./faults.js";
export type { ShippedDeviceFault } from "./faults.js";
export { generateNegativeControls } from "./negative-controls.js";
export type { NegativeControl, NegativeControlOptions, NegativeControls } from "./negative-controls.js";
