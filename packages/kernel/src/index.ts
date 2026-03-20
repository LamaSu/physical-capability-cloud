export { EvidenceEmitter } from "./evidence-emitter.js";
export { loadKernelConfig } from "./kernel-config.js";
export type { KernelConfig, DeviceConfig, DeviceRole, AdapterType } from "./kernel-config.js";
export {
  createMachineAdapter,
  createSensorAdapter,
  createCameraAdapter,
  createAdaptersFromConfig,
} from "./adapter-factory.js";
export type { AdapterSet } from "./adapter-factory.js";
export { JobRunner } from "./job-runner.js";
export type { JobConfig, JobResult } from "./job-runner.js";
export { buildServer } from "./server.js";
export { SensorPipeline, RingBuffer, lttbDownsample } from "./sensor-pipeline.js";
export type { PipelineConfig } from "./sensor-pipeline.js";
export { BatchTracker } from "./batch-tracker.js";
export { EncryptionService } from "./encryption-service.js";
export { LitEncryptionService } from "./lit-encryption-service.js";
export { RealLitEncryptionService } from "./lit-encryption-real.js";
export type {
  LitEncryptionServiceOptions,
  LitEncryptionResult,
  LitAuthSig,
  LitSessionSigs,
  UnifiedAccessControlCondition,
  AccessControlConditionOperator,
  AccessControlConditionChain,
} from "./lit-encryption-service.js";
// EvidenceStorageService uses Helia (ESM-only) — import from the subpath
// "@pcc/kernel/evidence-storage" when needed to avoid CJS barrel issues.
export type { ArchiveResult } from "./evidence-storage.js";
// Storacha (w3up) + factory — use dynamic import or subpath to avoid multiformats CJS clash:
//   import { StorachaStorageService } from "@pcc/kernel/storacha-storage"
//   import { createEvidenceStorage } from "@pcc/kernel/evidence-storage-factory"
export type { StorachaStorageOptions } from "./storacha-storage.js";
export type { IEvidenceStorageService } from "./evidence-storage-factory.js";
export { createLitEncryptionService, isRealLitEnabled } from "./lit-encryption-factory.js";
export type { AnyLitEncryptionService } from "./lit-encryption-factory.js";
export * from "./adapters/index.js";
