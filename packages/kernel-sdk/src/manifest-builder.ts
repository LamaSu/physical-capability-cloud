/**
 * Helper for building DigitalKernelManifest objects with sensible defaults.
 *
 * Third-party builders can use `buildManifest({...})` to fill out only the
 * parts that matter to them; the SDK stamps sensible defaults for
 * manifestVersion, sessionKeyPolicy, pricing, and status. The output is
 * structurally valid, but remote verification (endpoint reachability,
 * touchstone smoke test) still happens on register.
 */

import type {
  DigitalKernelManifest,
  KernelPricing,
  SessionKeyPolicy,
} from "@pcc/spec";

/**
 * Partial-friendly input type for buildManifest. `manifestVersion`, `status`,
 * and `sessionKeyPolicy` can be omitted; the builder will supply defaults.
 */
export type ManifestBuilderInput = Omit<
  DigitalKernelManifest,
  "manifestVersion" | "status" | "pricing" | "sessionKeyPolicy"
> & {
  pricing?: Partial<KernelPricing>;
  sessionKeyPolicy?: Partial<SessionKeyPolicy>;
};

// Default sessionKey policy is conservative: 1h TTL, and the two action types
// a digital kernel actually needs to sign evidence (evidence_submit +
// workflow_step_complete).
const DEFAULT_POLICY: SessionKeyPolicy = {
  maxTTLSeconds: 3600,
  allowedActions: ["evidence_submit", "workflow_step_complete"],
};

// Default pricing: free tier (baseUSD=0, no per-step). Builders typically
// override this.
const DEFAULT_PRICING: KernelPricing = {
  currency: "USDC",
  baseUSD: 0,
};

/**
 * Build a DigitalKernelManifest with sensible defaults.
 *
 * Throws a descriptive error for structurally invalid inputs that would
 * otherwise be caught by the gateway, so builders see the problem locally.
 */
export function buildManifest(input: ManifestBuilderInput): DigitalKernelManifest {
  // Structural guardrails mirror what the gateway enforces.
  if (!input.kernelId || typeof input.kernelId !== "string") {
    throw new Error("buildManifest: kernelId is required (non-empty string)");
  }
  if (!input.name || typeof input.name !== "string") {
    throw new Error("buildManifest: name is required (non-empty string)");
  }
  if (!input.builder?.agentId) {
    throw new Error("buildManifest: builder.agentId is required");
  }
  if (!input.endpointURL || !input.endpointURL.startsWith("https://")) {
    throw new Error(
      "buildManifest: endpointURL must be an HTTPS URL (got: " +
        (input.endpointURL ?? "undefined") +
        ")",
    );
  }
  if (!Array.isArray(input.workflowSteps) || input.workflowSteps.length === 0) {
    throw new Error("buildManifest: workflowSteps must have at least one step");
  }
  if (
    typeof input.maxAssuranceTier !== "number" ||
    input.maxAssuranceTier < 0 ||
    input.maxAssuranceTier > 3
  ) {
    throw new Error("buildManifest: maxAssuranceTier must be 0, 1, 2, or 3");
  }

  return {
    manifestVersion: "1.0.0",
    kernelId: input.kernelId,
    name: input.name,
    description: input.description ?? "",
    builder: input.builder,
    capabilityType: input.capabilityType,
    workflowSteps: input.workflowSteps,
    pricing: {
      currency: "USDC",
      baseUSD: input.pricing?.baseUSD ?? DEFAULT_PRICING.baseUSD,
      ...(input.pricing?.perStepUSD !== undefined
        ? { perStepUSD: input.pricing.perStepUSD }
        : {}),
    },
    maxAssuranceTier: input.maxAssuranceTier,
    touchstoneLibraryId: input.touchstoneLibraryId,
    endpointURL: input.endpointURL,
    sessionKeyPolicy: {
      maxTTLSeconds:
        input.sessionKeyPolicy?.maxTTLSeconds ?? DEFAULT_POLICY.maxTTLSeconds,
      allowedActions:
        input.sessionKeyPolicy?.allowedActions ?? DEFAULT_POLICY.allowedActions,
    },
    status: "pending",
  };
}
