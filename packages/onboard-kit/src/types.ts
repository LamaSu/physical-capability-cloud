/**
 * Configuration types for the onboard-kit.
 */

import type { BuiltinCapabilityType, PricingModel, AssuranceTier } from "@pcc/spec";

/** Describes one API endpoint on the device */
export interface DeviceEndpoint {
  /** HTTP method */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** URL path relative to base (e.g., "/api/status") */
  path: string;
  /** What this endpoint does */
  purpose: "status" | "start" | "stop" | "pause" | "resume" | "progress" | "load_program" | "sensor_reading" | "capture_image" | "inspect" | "custom";
  /** Description for documentation */
  description: string;
  /** Expected request body shape (for POST/PUT) */
  requestBody?: Record<string, unknown>;
  /** Expected response shape */
  responseShape?: Record<string, unknown>;
  /** Auth header or query param */
  auth?: {
    type: "header" | "query" | "bearer";
    key: string;
    envVar: string;
  };
}

/** Describes a device adapter to be generated */
export interface AdapterManifest {
  /** Unique adapter ID within this kernel */
  adapterId: string;
  /** Adapter class name (PascalCase) */
  className: string;
  /** Which adapter interface to implement */
  adapterType: "machine" | "sensor" | "camera";
  /** Device protocol */
  protocol: "http" | "opcua" | "modbus" | "sila" | "mqtt" | "serial" | "websocket" | "custom";
  /** Base URL or connection string for the device */
  connectionString: string;
  /** PCC device type for EvidenceSource */
  deviceType: "controller" | "sensor" | "camera" | "robot" | "tee";
  /** Firmware/adapter version string */
  firmwareVersion: string;
  /** Endpoints (for HTTP protocol) */
  endpoints?: DeviceEndpoint[];
  /** OPC-UA node map (for opcua protocol) */
  nodeMap?: Array<{
    nodeId: string;
    name: string;
    dataType: "number" | "boolean" | "string";
    unit?: string;
    direction: "read" | "write" | "readwrite";
  }>;
  /** Modbus register map (for modbus protocol) */
  registerMap?: Array<{
    channel: string;
    label: string;
    address: number;
    registerType: "holding" | "input" | "coil" | "discrete";
    dataType: "uint16" | "int16" | "uint32" | "int32" | "float32" | "float64";
    unit: string;
    scale?: number;
    offset?: number;
  }>;
  /** Polling interval in ms */
  pollIntervalMs?: number;
  /** Whether to generate mock mode */
  generateMockMode?: boolean;
}

/** Describes a capability to advertise */
export interface CapabilityDefinition {
  /** Capability type from the 44 built-in types */
  type: BuiltinCapabilityType;
  /** Human-readable name */
  name: string;
  /** Description of what this capability does */
  description?: string;
  /** Accepted input materials */
  materials: string[];
  /** Tolerances the equipment can achieve */
  tolerances?: {
    linear?: string;
    surface?: string;
    positional?: string;
  };
  /** Maximum part/sample dimensions */
  workEnvelope?: {
    x: number;
    y: number;
    z: number;
    unit: "mm" | "inch";
  };
  /** Assurance tiers this equipment supports */
  assuranceTiers: AssuranceTier[];
  /** Pricing model */
  pricing: PricingModel;
  /** Which adapter handles this capability */
  adapterId: string;
}

/** Kernel configuration */
export interface KernelConfig {
  /** Unique kernel ID (must be unique across the PCC network) */
  kernelId: string;
  /** Human-readable name for this shop/lab */
  name: string;
  /** Physical location */
  location: { lat: number; lng: number };
  /** Operator wallet private key env var name */
  walletPrivateKeyEnvVar: string;
  /** Gateway URL to connect to */
  gatewayUrl: string;
  /** Port for the kernel's own HTTP server */
  httpPort: number;
}

/** Complete onboarding configuration */
export interface OnboardConfig {
  /** Kernel configuration */
  kernel: KernelConfig;
  /** Device adapters to create */
  adapters: AdapterManifest[];
  /** Capabilities to advertise */
  capabilities: CapabilityDefinition[];
  /** Machine profiles for the contract builder */
  profiles?: Array<{
    profileId: string;
    profileName: string;
    capabilityType: BuiltinCapabilityType;
    adapterId: string;
    paramOverrides?: Record<string, unknown>;
    pricingOverrides?: Partial<PricingModel>;
  }>;
}
