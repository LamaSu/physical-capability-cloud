// Mock adapters
export { MockFDMAdapter } from "./mock-fdm.js";
export { MockPowerMonitorAdapter } from "./mock-power-monitor.js";
export { MockCameraAdapter } from "./mock-camera.js";
export { MockChromatograph } from "./mock-chromatograph.js";

// Real camera adapter (uses PhotoCaptureService + GeminiComparisonService)
export { PhotoCameraAdapter } from "./photo-camera-adapter.js";

// Real device adapters (with built-in mock mode)
export { OctoPrintAdapter, type OctoPrintConfig } from "./octoprint-adapter.js";
export { ModbusSensorAdapter, type ModbusConfig, type ModbusRegisterDef } from "./modbus-sensor-adapter.js";
export { OPCUAAdapter, type OPCUAConfig, type OPCUANodeDef } from "./opcua-adapter.js";

// PyLabRobot adapter — bridges to any PLR-supported lab instrument
// (OT-2, Flex, Hamilton STAR/Vantage, Tecan EVO, plate readers,
// thermocyclers, centrifuges, heater-shakers) via a long-running Python
// sidecar over JSON-RPC 2.0 stdio.
export {
  PyLabRobotAdapter,
  type PyLabRobotConfig,
  type PlrBackend,
  SidecarClient,
  SidecarError,
  type SidecarClientConfig,
  EvidenceCollector,
  type CameraHook,
  type SensorHook,
  RPC_ERROR_CODES,
  RPC_METHODS,
} from "./pylabrobot.js";

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

// IPP (Internet Printing Protocol) adapter for standard 2D printers
export { IppAdapter, type IppAdapterConfig, type IppCapabilities } from "./ipp-adapter.js";
export { discoverIppPrinters, generatePrinterCsd, type DiscoveredPrinter } from "./ipp-discovery.js";

// PrinterLogAdapter — hash-chained printer log evidence sensor
export { PrinterLogAdapter } from "./printer-log-adapter.js";
export type { PrinterLogAdapterConfig, LogProvider } from "./printer-log-adapter.js";

// Interfaces
export type { MachineAdapter, SensorAdapter, CameraAdapter, MachineCommand, MachineCommandResult } from "./types.js";
export type { UniversalSensorAdapter } from "./universal-sensor-adapter.js";
export { isUniversalSensor } from "./universal-sensor-adapter.js";
