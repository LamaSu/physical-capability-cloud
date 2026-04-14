/**
 * @pcc/kernel-sdk — SDK for building third-party digital kernels on PCC.
 *
 * Public surface:
 *   - buildManifest(input)           — helper to assemble a DigitalKernelManifest
 *   - createKernelHandler(opts)      — Fastify-compatible job handler
 *   - registerKernel(gatewayUrl, m)  — client to POST a manifest for verification
 *   - verifyBundleSignature(b, pk)   — verify a kernel-signed EvidenceBundle
 */

export { buildManifest } from "./manifest-builder.js";
export type { ManifestBuilderInput } from "./manifest-builder.js";

export {
  createKernelHandler,
  verifyBundleSignature,
  KernelAuthError,
  toHex,
  fromHex,
} from "./job-handler.js";
export type {
  CreateKernelHandlerOptions,
  KernelJobRequest,
  KernelJobResponse,
} from "./job-handler.js";

export { registerKernel, KernelRegistrationError } from "./register.js";
export type {
  RegisterKernelOptions,
  RegisterKernelResponse,
} from "./register.js";
