/**
 * @pcc/kernel-sdk — SDK for building third-party digital kernels on PCC.
 *
 * Public surface:
 *   - buildManifest(input)              — helper to assemble a DigitalKernelManifest
 *   - createKernelHandler(opts)         — Fastify-compatible job handler
 *   - registerKernel(gatewayUrl, m)     — client to POST a manifest for verification
 *   - verifyBundleSignature(b, pk)      — verify a kernel-signed EvidenceBundle
 *   - composeMilestoneReceipt(...)      — kernel-side receipt composer (Week 2)
 *   - signReceipt / verifyReceipt       — re-exports from @pcc/transparency-log
 *   - verifyServerReceipt(...)          — verify a gateway-signed receipt
 *   - aggregateSignatures(...)          — multi-signer receipt bundle
 *   - verifyMultiSignedReceipt(...)     — verify a multi-signer bundle
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

// ── Centralized substrate receipts (Week 2) ───────────────────────────
export {
  composeMilestoneReceipt,
  verifyServerReceipt,
  aggregateSignatures,
  verifyMultiSignedReceipt,
  signReceipt,
  verifyReceipt,
  canonicalize,
  payloadDigest,
  ReceiptPayloadSchema,
  SignedReceiptSchema,
  ReceiptSignatureSchema,
  MultiSignedReceiptSchema,
} from "./receipts.js";
export type {
  ReceiptPayload,
  SignedReceipt,
  SettlementMode,
  MilestoneInput,
  EvidenceInput,
  SignersInput,
  VerifyServerReceiptResult,
  ReceiptSignature,
  MultiSignedReceipt,
} from "./receipts.js";
