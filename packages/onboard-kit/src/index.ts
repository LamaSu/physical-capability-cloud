/**
 * @pcc/onboard-kit — Complete onboarding SDK for the Physical Capability Cloud Platform.
 *
 * Hand this package to a team's AI agent. It contains everything needed to:
 * 1. Wrap device API endpoints into PCC adapters
 * 2. Define capabilities (what the equipment can do)
 * 3. Configure a Shop Kernel (runtime for the physical site)
 * 4. Create a Kernel Agent (network-facing identity)
 * 5. Register machine profiles for the contract builder
 * 6. Connect to the A2A network and accept jobs
 * 7. Collect cryptographic evidence and submit for settlement
 *
 * See AGENT_INSTRUCTIONS.md for the complete guide.
 */

export { scaffold, type ScaffoldOptions, type ScaffoldResult } from "./scaffolder.js";
export { validate, type ValidationOptions, type ValidationResult, type ValidationCheck } from "./validate.js";
export {
  type AdapterManifest,
  type DeviceEndpoint,
  type CapabilityDefinition,
  type KernelConfig,
  type OnboardConfig,
} from "./types.js";
export { GenericHttpAdapter } from "./templates/generic-http-adapter.js";
export { GenericSensorAdapter } from "./templates/generic-sensor-adapter.js";
export { GenericCameraAdapter } from "./templates/generic-camera-adapter.js";
export { quickStart } from "./quick-start.js";
