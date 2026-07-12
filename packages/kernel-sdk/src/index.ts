/**
 * @pcc/kernel-sdk — SDK for building third-party digital kernels on PCC.
 *
 * Public surface:
 *   - buildManifest(input)               — helper to assemble a DigitalKernelManifest
 *   - createKernelHandler(opts)          — Fastify-compatible job handler
 *   - registerKernel(gatewayUrl, m, o)   — client to POST a manifest (+ optional #235 signing proof)
 *   - buildEd25519RegistrationProof(...) — build the #235 signing proof from a principal key
 *   - verifyBundleSignature(b, pk)       — verify a kernel-signed EvidenceBundle
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
  RegisteredSigner,
  SigningRegistrationResult,
} from "./register.js";

export { buildEd25519RegistrationProof, signingProofMessage } from "./signing-proof.js";
export type { Ed25519RegistrationProof } from "./signing-proof.js";
