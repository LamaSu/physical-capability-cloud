/**
 * Typed host-mediated MCP-App operation framework (R4 PR2).
 *
 * PR1 made manifest-authored raw `/api` writes INERT in host mode (a hosted
 * dashboard is untrusted content that must not be able to author an HTTP method,
 * path, header or arbitrary body from inside a host carrying ambient authority).
 * This module reintroduces writes the ONLY safe way: a small, default-DENY
 * catalog of TYPED operations. A dashboard names an `operation_id` + bounded
 * `arguments`; the SERVER — not the manifest — owns the tool name, the HTTP
 * semantics, argument validation, resource authorization, approval copy, and the
 * effect. The registry itself IS the D10 allowlist: an operation not registered
 * here cannot be invoked (there is no fall-through to the raw 256-tool proxy).
 *
 * Scope (re-audit #2 hardening, 2026-07-14): register ONLY the read-only
 * `capability.request_quote` (approval `none`). `job.cancel` (approval
 * `standard`, state-changing) is DEFINED + retained (exported below) but NOT
 * registered — its ownership check is sound only once VERIFIED operator identity
 * exists, and today `/api/auth/provision` issues a public wildcard key against a
 * caller-asserted operatorId (re-audit blocker 1). It re-registers when the
 * authority-model PR lands. The `financial` approval CLASS is defined and
 * unit-tested but NO financial operation is registered — escrow is deferred to a
 * dedicated money-path PR.
 *
 * Auth model (design: ai/research/pcc-genui-r4pr2-design.md §1/§3c): the host
 * connector carries the user's PCC bearer on the `/mcp` connection; the handler
 * derives the principal IN-PROCESS via resolveApiKeyFromToken (a local key-DB
 * hash lookup) and does resource-level authorization against THAT principal —
 * never against any actor/tenant/operator/owner id a manifest might supply.
 */

import { ContractBuilder } from "@pcc/contract-builder";
import type { CapabilityType } from "@pcc/spec";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getRepos } from "../db.js";
import { getJobFacade } from "../facades/index.js";
import { getCapabilityDescriptor } from "../services/ad-hoc-pricing.js";
import { REGISTERED_OPERATION_IDS } from "./operation-ids.js";

/** The dedicated typed-operation tool-name prefix. These tools are SEPARATE from
 *  the raw agent-package proxy tools; the dispatcher routes any `pcc.op.*` name
 *  here, so the raw proxy surface (and its confused-deputy risk) is untouched. */
export const TYPED_OP_TOOL_PREFIX = "pcc.op.";

/** Approval CLASSES. `financial` is defined for the framework; NO financial
 *  operation is registered in this PR (money paths ship in a separate PR). */
export type ApprovalClass = "none" | "standard" | "financial";

/** Principal derived IN-PROCESS from the forwarded PCC key. Its fields come from
 *  the validated key record — NEVER from tool arguments. */
export interface OpPrincipal {
  operatorId: string;
  apiKeyId: string;
}

/** Server-authored approval presentation — the ONLY source of approval copy
 *  (release criterion #4). A hostile manifest can never supply or alter this;
 *  amounts/destinations are computed from validated args + resolved state. */
export interface ApprovalDescription {
  approval: ApprovalClass;
  operationId: string;
  /** One plain-language, server-authored line describing the real effect. */
  summary: string;
  method?: string;
  destination?: string;
  amountUsd?: number | null;
  asset?: string | null;
  refId?: string | null;
}

/** Outcome of authorize(). A non-ok result maps to an MCP tool-level isError. */
export type AuthorizeResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

/** Outcome of invoke(). */
export type InvokeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; message: string };

/**
 * A registered typed operation. Everything a manifest is NOT allowed to author
 * (tool name, HTTP semantics, validation, authz, approval copy, the effect)
 * lives here, keyed by `operationId`.
 */
export interface DashboardOperationPolicy<
  A extends Record<string, unknown> = Record<string, unknown>,
> {
  operationId: string;
  /** The dedicated `pcc.op.<operationId>` MCP tool a host calls. */
  toolName: string;
  approval: ApprovalClass;
  /**
   * Whether invoking this operation CHANGES SERVER STATE. Drives the tools/list
   * exposure (typedOperationToolFor): a state-changing op is HIDDEN from the model
   * (`_meta.ui.visibility: ["app"]`) and annotated `readOnlyHint:false,
   * destructiveHint:true, openWorldHint:false` — it is reachable ONLY through the
   * host-mediated, user-approved MCP-App component, never model-callable. A
   * read-only op (a pure pricing calc) stays model-visible with `readOnlyHint:true,
   * destructiveHint:false`. So `job.cancel`, when re-registered later, is
   * automatically app-only + destructive without any tools/list change.
   */
  stateChanging: boolean;
  /** MCP tool description (shown in tools/list). */
  description: string;
  /** JSON Schema for the pcc.op.* tool's arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * Stripping projection: returns a FRESH, whitelisted object containing ONLY
   * the recognized fields, or null (fail closed). Any actor/tenant/operator/
   * owner id a manifest supplies is dropped here — it never reaches authz.
   */
  validateArguments(value: unknown): A | null;
  /** Resource-level authorization from the DERIVED principal (never args). */
  authorize(principal: OpPrincipal, args: A): Promise<AuthorizeResult>;
  /** Server-derived approval copy. */
  describeApproval(args: A): ApprovalDescription;
  /** Perform the effect with the derived principal. */
  invoke(principal: OpPrincipal, args: A): Promise<InvokeResult>;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Job statuses a cancel is permitted FROM. Terminal states (completed/failed/
 *  cancelled) are rejected — the state guard the REST route lacks. */
const CANCELLABLE_JOB_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "in_progress",
  "paused",
]);

/** One place that builds the server-authored approval copy, per class. Exported
 *  so the `financial` class is unit-testable WITHOUT registering a money op. */
export function buildApprovalDescription(input: {
  approval: ApprovalClass;
  operationId: string;
  summary: string;
  method?: string;
  destination?: string;
  amountUsd?: number | null;
  asset?: string | null;
  refId?: string | null;
}): ApprovalDescription {
  const desc: ApprovalDescription = {
    approval: input.approval,
    operationId: input.operationId,
    summary: input.summary,
  };
  if (input.method !== undefined) desc.method = input.method;
  if (input.destination !== undefined) desc.destination = input.destination;
  if (input.refId !== undefined) desc.refId = input.refId;
  // Amount/asset are meaningful only for financial ops; a hostile manifest can
  // never inject them because this is computed server-side from validated args.
  if (input.approval === "financial") {
    desc.amountUsd = input.amountUsd ?? null;
    desc.asset = input.asset ?? null;
  }
  return desc;
}

const builder = new ContractBuilder();

// ── Operation: capability.request_quote (approval: none) ─────────────────────

interface RequestQuoteArgs extends Record<string, unknown> {
  type: string;
  selections: Record<string, unknown>;
  profileId?: string;
  capabilityId?: string;
}

export const requestQuotePolicy: DashboardOperationPolicy<RequestQuoteArgs> = {
  operationId: "capability.request_quote",
  toolName: `${TYPED_OP_TOOL_PREFIX}capability.request_quote`,
  approval: "none",
  // Pure pricing calculation — no funds move, nothing is created. Model-visible.
  stateChanging: false,
  description:
    "Price a configured PCC capability (typed operation). Returns the itemized " +
    "quote for the given capability type + selections. Pure calculation — no " +
    "funds move and nothing is created. Maps to POST /api/build/price.",
  inputSchema: {
    type: "object",
    required: ["type", "selections"],
    additionalProperties: false,
    properties: {
      type: { type: "string", description: "Capability type, e.g. 'fdm'." },
      selections: { type: "object", description: "Parameter selections." },
      profileId: { type: "string" },
      capabilityId: { type: "string" },
    },
  },
  validateArguments(value): RequestQuoteArgs | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.type !== "string" || v.type.length === 0) return null;
    if (!v.selections || typeof v.selections !== "object" || Array.isArray(v.selections)) {
      return null;
    }
    // Fresh whitelisted object — nothing outside these keys survives. A manifest
    // that also sends operatorId/tenantId/etc. has those silently dropped here.
    const out: RequestQuoteArgs = {
      type: v.type,
      selections: v.selections as Record<string, unknown>,
    };
    if (typeof v.profileId === "string") out.profileId = v.profileId;
    if (typeof v.capabilityId === "string") out.capabilityId = v.capabilityId;
    return out;
  },
  async authorize(principal): Promise<AuthorizeResult> {
    // A pure, side-effect-free pricing calc: any AUTHENTICATED operator may
    // price. There is no resource ownership to check. Anonymous is already
    // rejected in the handler; assert principal presence here too (fail closed).
    if (!principal || !principal.operatorId) {
      return { ok: false, status: 401, message: "Authentication required" };
    }
    return { ok: true };
  },
  describeApproval(args): ApprovalDescription {
    return buildApprovalDescription({
      approval: "none",
      operationId: this.operationId,
      summary: `Price a ${args.type} configuration. No funds move and nothing is created.`,
      method: "POST",
      destination: "/api/build/price",
    });
  },
  async invoke(_principal, args): Promise<InvokeResult> {
    // Mirrors POST /api/build/price (routes/build.ts:166-214): template types
    // price via ContractBuilder; ad-hoc types via the capability row's linear
    // model. Pure calc — no side effects, no ownership. The pricing MATH stays
    // in ContractBuilder/PricingCalculator (not duplicated); only the
    // template-vs-adhoc branch mirrors the route.
    const desc = getCapabilityDescriptor(args.type, args.capabilityId);
    if (desc.kind === "missing") {
      return { ok: false, status: 404, message: desc.reason };
    }
    let pricing: unknown;
    if (desc.kind === "template") {
      pricing = builder.calculatePrice(
        args.type as CapabilityType,
        args.selections as Record<string, string | number | boolean | string[]>,
        args.profileId,
      );
    } else {
      const quantity = Number((args.selections as Record<string, unknown>).quantity ?? 1) || 1;
      const basePriceNum = parseFloat(desc.descriptor.basePrice);
      const totalPrice = basePriceNum * quantity;
      pricing = {
        basePrice: basePriceNum,
        totalPrice,
        breakdown: [
          {
            paramKey: "quantity",
            paramLabel: "Quantity",
            selectedValue: String(quantity),
            impact: { mode: "per_unit", value: desc.descriptor.basePrice },
            amount: (basePriceNum * (quantity - 1)).toFixed(2),
          },
        ],
        currency: desc.descriptor.currency,
      };
    }
    return { ok: true, data: { pricing } };
  },
};

// ── Operation: job.cancel (approval: standard) ───────────────────────────────

interface JobCancelArgs extends Record<string, unknown> {
  jobId: string;
}

export const jobCancelPolicy: DashboardOperationPolicy<JobCancelArgs> = {
  operationId: "job.cancel",
  toolName: `${TYPED_OP_TOOL_PREFIX}job.cancel`,
  approval: "standard",
  // Mutates a job's status → state-changing. Retained but NOT registered (see the
  // registry note below); when re-registered it is auto app-only + destructive.
  stateChanging: true,
  description:
    "Cancel one of YOUR PCC jobs (typed operation). The target status is fixed " +
    "to 'cancelled' by the server; the caller supplies only the jobId. The " +
    "server verifies you operate the job's kernel and that the job is in a " +
    "cancellable (non-terminal) state. Maps to PATCH /api/jobs/:jobId/status.",
  inputSchema: {
    type: "object",
    required: ["jobId"],
    additionalProperties: false,
    properties: {
      jobId: { type: "string", description: "The job to cancel." },
    },
  },
  validateArguments(value): JobCancelArgs | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.jobId !== "string" || v.jobId.length === 0) return null;
    // ONLY jobId survives. Notably `status` is NOT read from arguments — it is
    // FIXED to "cancelled" by invoke(), so a manifest cannot drive an arbitrary
    // status transition, and any operatorId/tenantId in args is dropped.
    return { jobId: v.jobId };
  },
  async authorize(principal, args): Promise<AuthorizeResult> {
    if (!principal || !principal.operatorId) {
      return { ok: false, status: 401, message: "Authentication required" };
    }
    const repos = getRepos();
    const job = repos.jobs.findById(args.jobId);
    if (!job) return { ok: false, status: 404, message: "Job not found" };

    // State guard the REST route lacks: only cancel a non-terminal job.
    if (!CANCELLABLE_JOB_STATUSES.has(job.status)) {
      return {
        ok: false,
        status: 409,
        message: `Cannot cancel a job in status "${job.status}"`,
      };
    }

    // Ownership. NOTE (verified against the drizzle schema, not inferred): the
    // REST route (routes/jobs.ts:90-95) compares `job.submittedBy` and
    // `kernel.operatorId` — columns that DO NOT EXIST on the jobs / shop_kernels
    // tables — and skips the whole check for an anonymous caller. This typed op
    // enforces the owner check the route INTENDED: the job's kernel must be
    // operated by the derived principal (`shop_kernels.operatorAddress ===
    // principal.operatorId`), and the principal is MANDATORY (no anon skip). A
    // forward-compatible `job.submittedBy` match is honored too, in case a
    // future migration adds that column.
    let owns = false;
    const submittedBy = (job as { submittedBy?: unknown }).submittedBy;
    if (typeof submittedBy === "string" && submittedBy === principal.operatorId) {
      owns = true;
    }
    if (!owns && job.kernelId) {
      const kernel = repos.kernels.findById(job.kernelId);
      if (kernel && kernel.operatorAddress === principal.operatorId) owns = true;
    }
    if (!owns) {
      return { ok: false, status: 403, message: "You can only cancel your own jobs" };
    }
    return { ok: true };
  },
  describeApproval(args): ApprovalDescription {
    return buildApprovalDescription({
      approval: "standard",
      operationId: this.operationId,
      summary: `Cancel job ${args.jobId}. This stops the job; no funds move.`,
      method: "PATCH",
      destination: `/api/jobs/${args.jobId}/status → cancelled`,
      refId: args.jobId,
    });
  },
  async invoke(_principal, args): Promise<InvokeResult> {
    // status is FIXED to "cancelled" — never manifest-supplied.
    const result = await getJobFacade().updateStatus(args.jobId, "cancelled");
    if (!result.success) {
      return { ok: false, status: result.error.httpStatus, message: result.error.message };
    }
    return { ok: true, data: { job: result.data as unknown as Record<string, unknown> } };
  },
};

// ── Registry (default-DENY) ──────────────────────────────────────────────────

const REGISTRY = new Map<string, DashboardOperationPolicy>();

function register(policy: DashboardOperationPolicy<never>): void {
  // Cast: each policy is parameterized by its own validated-arg shape; the
  // registry stores them under the base record type. Argument flow stays
  // type-safe INSIDE each policy (validate → authorize → describe → invoke).
  REGISTRY.set(policy.operationId, policy as unknown as DashboardOperationPolicy);
}

register(requestQuotePolicy as unknown as DashboardOperationPolicy<never>);
// job.cancel is intentionally NOT registered (re-audit #2 blocker 1). `/api/auth/
// provision` is public and issues a wildcard key against a caller-asserted
// operatorId, so an attacker could provision a key claiming a victim's operatorId
// and job.cancel would authorize on `kernel.operatorAddress === principal.operatorId`.
// The policy code is retained (exported jobCancelPolicy) so it re-registers as-is
// once verified identity + scopes exist. Until then the ONLY registered typed op is
// the read-only capability.request_quote, which has no ownership dependency.
// The `financial` approval class is DEFINED above and exercised by unit tests via
// buildApprovalDescription, but NO financial operation is registered here — money
// paths (escrow release/dispute) ship in a separate, independently-reviewed PR.

// Drift guard: the live registry MUST match the dependency-free canonical id list
// (operation-ids.ts) that the MCP-App view injects as the client-side allowlist.
// If they ever diverge, a hosted view could offer an operation the server does not
// implement (or hide one it does) — fail fast at module load instead.
(() => {
  const registered = [...REGISTRY.keys()].sort();
  const canonical = [...REGISTERED_OPERATION_IDS].sort();
  const same =
    registered.length === canonical.length &&
    registered.every((id, i) => id === canonical[i]);
  if (!same) {
    throw new Error(
      `operation-policy registry {${registered.join(", ")}} disagrees with ` +
        `REGISTERED_OPERATION_IDS {${canonical.join(", ")}} — keep operation-ids.ts in sync.`,
    );
  }
})();

/** Look up a registered operation by its `operation_id`. Default-DENY: an
 *  unregistered id returns null. */
export function getOperationPolicy(operationId: string): DashboardOperationPolicy | null {
  return REGISTRY.get(operationId) ?? null;
}

/** Look up a registered operation by its `pcc.op.*` tool name. Default-DENY. */
export function getOperationPolicyByToolName(toolName: string): DashboardOperationPolicy | null {
  for (const policy of REGISTRY.values()) {
    if (policy.toolName === toolName) return policy;
  }
  return null;
}

/** The registered operation ids (the client-side allowlist the MCP-App boot
 *  script injects so a hosted view only offers registered operations). */
export function registeredOperationIds(): string[] {
  return [...REGISTRY.keys()];
}

/**
 * The MCP `Tool` for one typed operation, with visibility + annotations DRIVEN by
 * `policy.stateChanging` (re-audit #2 blocker 2):
 *   - state-changing → `_meta.ui.visibility: ["app"]` (hidden from the model —
 *     invoked ONLY through the host-mediated, user-approved MCP-App component) plus
 *     `annotations: { readOnlyHint:false, destructiveHint:true, openWorldHint:false }`.
 *   - read-only → model-visible (no `_meta.ui.visibility`), `readOnlyHint:true,
 *     destructiveHint:false, openWorldHint:false`.
 * Exported so both shapes are unit-testable even while `job.cancel` is unregistered.
 */
export function typedOperationToolFor(policy: DashboardOperationPolicy): Tool {
  const tool: Tool = {
    name: policy.toolName,
    description: policy.description,
    inputSchema: policy.inputSchema as unknown as Tool["inputSchema"],
    annotations: {
      readOnlyHint: !policy.stateChanging,
      destructiveHint: policy.stateChanging,
      openWorldHint: false,
    },
  };
  if (policy.stateChanging) {
    // Hide a state-changing op from the MODEL: the host surfaces it only inside the
    // approved MCP-App component, never as a directly model-callable tool.
    tool._meta = { ui: { visibility: ["app"] } };
  }
  return tool;
}

/** The MCP `Tool` definitions for the registered typed operations, advertised on
 *  tools/list ALONGSIDE (never replacing) the raw proxy tools. */
export function typedOperationTools(): Tool[] {
  return [...REGISTRY.values()].map(typedOperationToolFor);
}
