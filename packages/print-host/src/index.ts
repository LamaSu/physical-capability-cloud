export { FakeMachineAdapter } from "./testing/fake-machine-adapter.js";
export type { FakeStartOutcome } from "./testing/fake-machine-adapter.js";
export { readSecretFile, SecretFileError } from "./secret-file.js";
export type { SecretFileOptions, SecretFileErrorCode } from "./secret-file.js";
export { DeviceKey, KeyFileError, OperatorSigningError, loadDeviceKey, loadOperatorKey } from "./keys.js";
export type {
  OperatorKey, KeyLoadOptions, OperatorKeyLoadOptions, KeyFileErrorCode, D1Input, OperatorChainId,
  HostTerms, JobPolicyAcceptanceInput,
  OperatorSigningErrorCode, SubmitEvidenceTxInput,
} from "./keys.js";
export { generateHostKeys, KeyGenerationError } from "./keygen.js";
export type {
  GenerateHostKeysOptions, GeneratedHostKeys, KeyGenerationErrorCode,
  HostPublicIdentity as GeneratedHostPublicIdentity,
} from "./keygen.js";
export { loadHostConfig, checkHostConfig, HostConfigError } from "./config.js";
export type { HostConfig, HostConfigOptions, HostConfigErrorCode, HostPublicIdentity } from "./config.js";
export type { CliIo } from "./cli.js";
export { createGatewayClient, GatewayClientError } from "./gateway-client.js";
export type {
  GatewayClient, GatewayClientConfig, GatewayClientErrorCode, GwCode, GwSubCode, GwResult,
  EStopDecision, EmergencyStopReader, RelayEvidenceBundle, PollJobsValue,
  HeartbeatValue, InProgressValue, RelayEvidenceReceipt,
} from "./gateway-client.js";
