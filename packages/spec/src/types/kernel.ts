/**
 * Shop Kernel types — the boundary of trust for a physical site.
 *
 * A Shop Kernel is an AWS Outpost. Internally it orchestrates machines,
 * robots, humans, sensors, and custody. Externally it exposes standardized
 * capability endpoints + produces signed evidence bundles.
 */

import type {
  Id,
  Address,
  GeoLocation,
  Timestamp,
  Signature,
  AssuranceTier,
} from "./common.js";
import type { Capability } from "./capability.js";

/** Shop Kernel identity and metadata */
export interface ShopKernel {
  id: Id;
  /** Human-readable name */
  name: string;
  /** Operator's on-chain address */
  operatorAddress: Address;
  /** Physical location */
  location: GeoLocation;
  /** Physical address for courier pickup */
  physicalAddress: string;
  /** Capabilities this kernel exposes */
  capabilities: Capability[];
  /** Maximum assurance tier this kernel supports */
  maxAssuranceTier: AssuranceTier;
  /** Kernel's public key for signature verification */
  publicKey: string;
  /** Reputation score (0-1000) */
  reputation: number;
  /** Total jobs completed */
  totalJobsCompleted: number;
  /** Current status */
  status: "online" | "offline" | "maintenance" | "suspended";
  /** Registered timestamp */
  registeredAt: Timestamp;
  /** Last heartbeat */
  lastHeartbeat: Timestamp;
  /** Software version */
  version: string;
}

/** A device registered within a kernel */
export interface KernelDevice {
  id: Id;
  kernelId: Id;
  /** Type of device */
  type: "machine" | "sensor" | "camera" | "robot" | "tee";
  /** Specific device model */
  model: string;
  /** Device firmware/software */
  firmware: string;
  /** Device status */
  status: "idle" | "busy" | "error" | "offline" | "maintenance";
  /** Capabilities this device contributes to */
  contributesToCapabilities: Id[];
  /** Last status update */
  lastUpdated: Timestamp;
}

/** A job as seen by the kernel */
export interface KernelJob {
  id: Id;
  stepId: Id;
  cwmId: Id;
  capabilityId: Id;
  /** Current status */
  status: "queued" | "preparing" | "executing" | "collecting_evidence" |
          "awaiting_pickup" | "completed" | "failed" | "cancelled";
  /** Assigned devices */
  assignedDevices: Id[];
  /** Start time */
  startedAt?: Timestamp;
  /** Completion time */
  completedAt?: Timestamp;
  /** Progress (0-100) */
  progress: number;
  /** Evidence bundle ID once finalized */
  evidenceBundleId?: Id;
}

/** Custody event — tracking physical item handoffs */
export interface CustodyEvent {
  id: Id;
  jobId: Id;
  type: "item_created" | "item_sealed" | "pickup_ready" |
        "courier_arrived" | "handoff_to_courier" |
        "in_transit" | "courier_arrived_destination" |
        "handoff_to_recipient" | "recipient_confirmed";
  timestamp: Timestamp;
  /** Who/what is involved */
  actor: {
    type: "kernel" | "courier" | "user" | "robot";
    id: Id;
  };
  /** Location at time of event */
  location?: GeoLocation;
  /** Photo proof hash */
  photoHash?: string;
  /** Signature from the actor */
  signature?: Signature;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Heartbeat from a kernel to the control plane */
export interface KernelHeartbeat {
  kernelId: Id;
  timestamp: Timestamp;
  status: ShopKernel["status"];
  /** Active job count */
  activeJobs: number;
  /** Queue depth per capability */
  queueDepths: Record<Id, number>;
  /** Device statuses */
  deviceStatuses: Record<Id, KernelDevice["status"]>;
  /** Signature proving this came from the kernel */
  signature: Signature;
}
