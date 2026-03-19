// Mock adapters
export { MockFDMAdapter } from "./mock-fdm.js";
export { MockPowerMonitorAdapter } from "./mock-power-monitor.js";
export { MockCameraAdapter } from "./mock-camera.js";
export { MockChromatograph } from "./mock-chromatograph.js";

// Real device adapters (with built-in mock mode)
export { OctoPrintAdapter, type OctoPrintConfig } from "./octoprint-adapter.js";
export { ModbusSensorAdapter, type ModbusConfig, type ModbusRegisterDef } from "./modbus-sensor-adapter.js";
export { OPCUAAdapter, type OPCUAConfig, type OPCUANodeDef } from "./opcua-adapter.js";

// SiLA 2 lab instrument adapter
export { SiLAAdapter, type SiLAAdapterConfig } from "./sila/index.js";
export type {
  SiLADevice,
  SiLADeviceType,
  SiLADeviceStatus,
  SiLACommand,
  SiLAResponse,
  SiLAResponseStatus,
  SiLAObservableProperty,
  LiquidHandlingEvent,
  LiquidHandlingEventType,
  AssayRunConfig,
  AssayResult,
  QCMetrics,
  LabCapability,
  LabCapabilityType,
  PlateFormat,
  ComplianceStandard,
} from "./sila/index.js";

// Interfaces
export type { MachineAdapter, SensorAdapter, CameraAdapter, MachineCommand, MachineCommandResult } from "./types.js";
export type { UniversalSensorAdapter } from "./universal-sensor-adapter.js";
export { isUniversalSensor } from "./universal-sensor-adapter.js";
