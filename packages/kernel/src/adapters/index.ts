// Mock adapters
export { MockFDMAdapter } from "./mock-fdm.js";
export { MockPowerMonitorAdapter } from "./mock-power-monitor.js";
export { MockCameraAdapter } from "./mock-camera.js";
export { MockChromatograph } from "./mock-chromatograph.js";

// Real device adapters (with built-in mock mode)
export { OctoPrintAdapter, type OctoPrintConfig } from "./octoprint-adapter.js";
export { ModbusSensorAdapter, type ModbusConfig, type ModbusRegisterDef } from "./modbus-sensor-adapter.js";
export { OPCUAAdapter, type OPCUAConfig, type OPCUANodeDef } from "./opcua-adapter.js";

// Interfaces
export type { MachineAdapter, SensorAdapter, CameraAdapter, MachineCommand, MachineCommandResult } from "./types.js";
export type { UniversalSensorAdapter } from "./universal-sensor-adapter.js";
export { isUniversalSensor } from "./universal-sensor-adapter.js";
