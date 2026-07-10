/**
 * SiLA 2 types for PCCP integration.
 *
 * SiLA 2 (Standardization in Lab Automation) is an HTTP/2 + Protocol Buffers
 * standard for lab instrument control. These types bridge SiLA 2 concepts
 * to the PCCP evidence pipeline.
 *
 * Supported instrument families: Hamilton STAR, Tecan Fluent, Beckman Biomek,
 * Thermo Fisher, and any SiLA 2-compliant device.
 */

/** SiLA 2 device types */
export type SiLADeviceType =
  | "liquid_handler"
  | "plate_reader"
  | "washer"
  | "incubator"
  | "centrifuge"
  | "generic";

/** SiLA 2 device status */
export type SiLADeviceStatus =
  | "idle"
  | "busy"
  | "error"
  | "offline"
  | "maintenance";

/** A SiLA 2-connected device */
export interface SiLADevice {
  id: string;
  name: string;
  type: SiLADeviceType;
  silaServerUrl: string;
  features: string[];
  status: SiLADeviceStatus;
  firmwareVersion?: string;
  serialNumber?: string;
}

/** A command sent to a SiLA 2 device */
export interface SiLACommand {
  featureId: string;
  commandId: string;
  parameters: Map<string, unknown>;
  timestamp: string;
}

/** Response status from a SiLA 2 command */
export type SiLAResponseStatus = "ok" | "error" | "running";

/** Response from a SiLA 2 command */
export interface SiLAResponse {
  commandId: string;
  status: SiLAResponseStatus;
  returnValues: Record<string, unknown>;
  duration_ms: number;
  errors: string[];
}

/** An observable property from a SiLA 2 device */
export interface SiLAObservableProperty {
  propertyId: string;
  value: unknown;
  timestamp: string;
  unit: string;
}

/** Liquid handling event types */
export type LiquidHandlingEventType =
  | "aspirate"
  | "dispense"
  | "mix"
  | "transport";

/** A single liquid handling event with full traceability */
export interface LiquidHandlingEvent {
  type: LiquidHandlingEventType;
  channel: number;
  volume_uL: number;
  pressure_kPa: number;
  well: string;
  tipType: string;
  timestamp: string;
}

/** Plate format for assays */
export type PlateFormat = 96 | 384 | 1536;

/** Configuration for running an assay */
export interface AssayRunConfig {
  assayName: string;
  protocolId: string;
  plateFormat: PlateFormat;
  sampleCount: number;
  replicates: number;
  qcCriteria: {
    maxCV: number;
    minR2: number;
    minZPrime: number;
  };
}

/** QC metrics for an assay result */
export interface QCMetrics {
  cv_percent: number;
  r_squared: number;
  z_prime: number;
}

/** Result of a completed assay run */
export interface AssayResult {
  runId: string;
  assayName: string;
  plateData: Record<string, number>;
  qcMetrics: QCMetrics;
  passedQC: boolean;
  completedAt: string;
  totalEvents: number;
  errors: string[];
}

/** Lab capability types exposed through PCCP */
export type LabCapabilityType =
  | "elisa_plate_setup"
  | "serial_dilution"
  | "pcr_stamping"
  | "cherry_picking"
  | "sample_normalization"
  | "cell_culture_passaging"
  | "compound_reformatting"
  | "hit_picking";

/** Compliance standard identifiers */
export type ComplianceStandard =
  | "GLP"
  | "GMP"
  | "21_CFR_Part_11"
  | "ISO_17025"
  | "ISO_15189";

/** A PCCP capability backed by a SiLA 2 instrument */
export interface LabCapability {
  capabilityType: LabCapabilityType;
  instrument: string;
  volumeRange: { min_uL: number; max_uL: number };
  precision_cv: number;
  plateFormats: PlateFormat[];
  compliance: ComplianceStandard[];
  /**
   * True when this capability descriptor comes from a mock/simulated adapter
   * rather than a live instrument query. Compliance claims on a simulated
   * entry describe what the SIMULATION advertises, not a verified instrument.
   */
  simulated?: boolean;
}
