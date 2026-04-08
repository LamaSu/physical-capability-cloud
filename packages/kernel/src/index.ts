// Safety — governor, circuit breaker, and gateway (mandatory choke point)
// In production, always use getSafetyGateway(). Direct class construction is for unit tests only.
export {
  SafetyGovernor,
  CircuitBreaker,
  SafetyGateway,
  getSafetyGateway,
  initSafetyGateway,
  resetSafetyGateway,
} from "./safety/index.js";
export type {
  PhysicalCommand,
  CommandClass,
  OperationalEnvelope,
  GovernorVerdict,
  SafetyCheck,
  HardwareState,
  CircuitState,
  CircuitBreakerConfig,
  SafetyGatewayResult,
  SafetyGatewayConfig,
} from "./safety/index.js";

export { EvidenceEmitter } from "./evidence-emitter.js";
export { AnomalyDetector, type AnomalyReport, type AnomalyDetectorConfig } from "./anomaly-detector.js";
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
export { KernelKeyStore, kernelKeyStore } from "./key-store.js";
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
export { generateDecryptAction, executeDecryptAction } from "./lit-action-decrypt.js";
export type { DecryptActionParams, DecryptActionResult } from "./lit-action-decrypt.js";
export { PhotoCaptureService } from "./photo-capture-service.js";
export type { PhotoCaptureResult } from "./photo-capture-service.js";
export { GeminiComparisonService } from "./gemini-comparison-service.js";
export type { ComparisonResult } from "./gemini-comparison-service.js";
export {
  LocalComparisonService,
  computePHash,
  pHashDistance,
  pHashSimilarity,
  computeSSIM,
} from "./local-comparison-service.js";
export type { ImageData, LocalComparisonResult } from "./local-comparison-service.js";
export * from "./adapters/index.js";
export { KernelKeychain } from "./kernel-keychain.js";
export { LogCaptureService } from "./log-capture-service.js";
export type { LogEntry, LogChainVerification } from "./log-capture-service.js";
// Policy engine
export { evaluatePolicy, applyPricingRules, sanitizeText, scanGcode } from "./policy-engine.js";
export type { PolicyContext } from "./policy-engine.js";
// Opentrons operator stack
export {
  OpentronsMachineAdapter,
  DeviceQueue,
  ProtocolCompiler,
  OpentronOperator,
  ProtocolEstimator,
  OperatorHealthTracker,
} from "./opentrons/index.js";
export type {
  QueuedJob,
  QueueStatus,
  EnqueueResult,
  QueueEvent,
  CompiledProtocol,
  OperatorConfig,
  OperatorJob,
  OpentronAdapterConfig,
  OpentronRobotInfo,
  DeckLayout,
  LabwareDef,
  DeckSlot,
  PipetteInfo,
  PipetteMount,
  OpentronModule,
  ModuleType,
  OTProtocol,
  OTRun,
  OTCommand,
  LiquidHandlerCapability,
  LiquidAction,
  TimeEstimate,
  ConsumableEstimate,
  CostEstimate,
  FullEstimate,
  JobHistoryEntry,
  OperatorInfo,
  CompletionRecord,
} from "./opentrons/index.js";
