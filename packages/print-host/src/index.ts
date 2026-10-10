export { FakeMachineAdapter } from "./testing/fake-machine-adapter.js";
export type { FakeStartOutcome } from "./testing/fake-machine-adapter.js";
export { readSecretFile, SecretFileError } from "./secret-file.js";
export type { SecretFileOptions, SecretFileErrorCode } from "./secret-file.js";
export { DeviceKey, OperatorKey, KeyFileError, loadDeviceKey, loadOperatorKey } from "./keys.js";
export type { KeyLoadOptions, KeyFileErrorCode } from "./keys.js";
export { generateHostKeys, KeyGenerationError } from "./keygen.js";
export type {
  GenerateHostKeysOptions, GeneratedHostKeys, KeyGenerationErrorCode,
  HostPublicIdentity as GeneratedHostPublicIdentity,
} from "./keygen.js";
export { loadHostConfig, checkHostConfig, HostConfigError } from "./config.js";
export type { HostConfig, HostConfigOptions, HostConfigErrorCode, HostPublicIdentity } from "./config.js";
export { main } from "./cli.js";
export type { CliIo } from "./cli.js";
