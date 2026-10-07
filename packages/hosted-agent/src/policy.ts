/**
 * Which agent-package tools the hosted agent is offered, and how.
 *
 * P2 (round 5, 239): the arms race on NAME LISTS (round 2's Q2, round 4's
 * B1/B2, round 5 v1's Q2) kept finding new unowned device/operator reads --
 * "a list keeps missing instances." The steward's ruling (#5957) replaces
 * every fallback classifier with a single property: an explicit
 * TOOL_ALLOWLIST is the ONLY way a tool is offered. Unlisted means `never`,
 * full stop -- no unlisted GET becomes a confirmed write, no pattern-derived
 * level. The allowlist starts with PUBLIC READS ONLY (no write, no L2): each
 * entry was reviewed against its gateway handler and carries a `reason` and
 * an `output` projection (P1, see below). Adding a tool is a REVIEW, not a
 * list edit that hopes nothing was missed.
 */
export type ToolLevel = "read" | "write" | "l2" | "never";

/**
 * P1 (round 5, 239): the model and the user see a tool's result only through
 * a TYPED, ALLOW-LISTED projection -- free-text scrubbing (tools.ts'
 * `scrubText`) is defense in depth, never the boundary itself. A field not
 * named here, or present with the wrong type, is DROPPED, not redacted:
 * there is nothing to redact once the shape itself is the fence. A
 * secret-named key (tools.ts' SECRET_FIELDS) can never appear in a spec --
 * policy.test.ts pins that as a standing check on every entry below.
 */
export type FieldSpec =
  | { readonly type: "string"; readonly maxLength: number }
  | { readonly type: "number" }
  | { readonly type: "boolean" }
  | { readonly type: "array"; readonly items: FieldSpec; readonly maxItems: number }
  | { readonly type: "object"; readonly fields: OutputSpec };

export type OutputSpec = Readonly<Record<string, FieldSpec>>;

export interface AllowlistEntry {
  readonly level: "read" | "write" | "l2";
  readonly output: OutputSpec;
  readonly reason: string;
}

export interface ToolPolicy {
  readonly allowlist: ReadonlyMap<string, AllowlistEntry>;
  readonly never: ReadonlySet<string>;
}

/**
 * The initial allowlist: PUBLIC READS ONLY. Write and L2 tools come back one
 * by one, each with its own review -- none is allowlisted this round.
 *
 * Candidates reviewed and REJECTED (read the gateway handler, found
 * tenant-specific data beyond a public discovery listing -- "otherwise it is
 * never too"):
 *   - `list_kernels` (GET /api/kernels) and `get_kernel` (GET
 *     /api/kernels/{kernelId}): packages/gateway/src/facades/populators/
 *     kernel.populator.ts `populateKernelDTO` (shared by BOTH endpoints)
 *     unconditionally returns `operatorAddress` (the operator's wallet
 *     address) and `location`/`physicalAddress` (real geo-coordinates / a
 *     street address) for EVERY kernel, to any caller, with no ownership
 *     check. That is tenant-specific data, not a public discovery profile --
 *     NEVER this round, pending a redacted public-view endpoint.
 *   - `get_kernel_devices`, `get_kernel_jobs`, `list_jobs`, `get_job`:
 *     excluded by the spec itself (any kernel's or any job's data by
 *     caller-chosen id, no gateway ownership check -- board row N85).
 */
const TOOL_ALLOWLIST: ReadonlyMap<string, AllowlistEntry> = new Map<string, AllowlistEntry>([
  [
    "list_capability_types",
    {
      level: "read",
      reason:
        'GET /api/capabilities/types. packages/gateway/src/routes/capabilities.ts: the route\'s own OpenAPI description says "PUBLIC — no auth required"; ' +
        "it returns only the deduped, sorted union of capability TYPE NAMES (e.g. \"3d-printing\", \"cnc\") -- no kernel, operator or job is named anywhere in the shape.",
      output: { types: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 1000 } },
    },
  ],
  [
    "search_capabilities",
    {
      level: "read",
      reason:
        "GET /api/capabilities/templates. packages/gateway/src/routes/capabilities.ts: returns the STRUCTURAL template for each registered capability " +
        "type (name, version, description, param count, group names, base price) -- catalog metadata about capability TYPES, never a specific kernel, operator or job.",
      output: {
        templates: {
          type: "array",
          maxItems: 500,
          items: {
            type: "object",
            fields: {
              capabilityType: { type: "string", maxLength: 100 },
              name: { type: "string", maxLength: 200 },
              version: { type: "string", maxLength: 50 },
              description: { type: "string", maxLength: 2000 },
              paramCount: { type: "number" },
              groups: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 50 },
              basePrice: { type: "number" },
              currency: { type: "string", maxLength: 10 },
            },
          },
        },
      },
    },
  ],
  [
    "search_dashboards",
    {
      level: "read",
      reason:
        "GET /api/artifacts. packages/gateway/src/routes/artifacts.ts' OWN handler filters to `status===\"active\" && visibility===\"public\"` before " +
        "returning anything -- the owner's deliberate choice to publish, the same gate a public listing uses; the manifest schema (packages/spec) forbids " +
        "any API-key/Bearer/JWT-shaped substring at save time. The `owner` field on the stored record is deliberately NOT in this projection (unneeded, " +
        "and the whole point of P1: the shape is the fence, not a judgment call about whether an owner id counts as sensitive).",
      output: {
        entries: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            fields: {
              id: { type: "string", maxLength: 100 },
              slug: { type: "string", maxLength: 100 },
              name: { type: "string", maxLength: 200 },
              description: { type: "string", maxLength: 2000 },
              capabilityTypes: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 50 },
              createdAt: { type: "string", maxLength: 50 },
            },
          },
        },
        total: { type: "number" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    },
  ],
]);

/**
 * Explicit NEVER names, kept as an extra guard (belt and braces) even though
 * anything absent from TOOL_ALLOWLIST is already `never` by construction.
 * Unchanged from round 4 -- documents WHY specific tools are excluded, for a
 * reader who has not re-derived it from the allowlist's own absence.
 */
const NEVER = [
  // device actuation: runs or relays commands on hardware
  "pcc_relay_tool_call", "pcc_relay_generic_tool_call", "pcc_create_scope", "pcc_revoke_scope", "pcc_chat_send",
  "start_protocol_run", "pause_protocol_run", "resume_protocol_run", "cancel_protocol_run", "setup_test_job",
  "execute_composition", "pcc_submit_paid_job",
  // device impersonation: calls only the device's own runtime makes
  "kernel_heartbeat", "kernel_announce_capabilities", "operator_heartbeat",
  "operator_poll_jobs", "operator_push_evidence", "operator_update_job_status", "update_job_status",
  "get_operator_machines", "get_operator_earnings", "get_operator_certs",
  "send_diagnostics", "send_support_message", "check_support_replies", "reply_to_support_thread",
  "pcc_get_tool_result", "pcc_get_tool_manifest",
  "get_operator_dashboard", "pcc_camera_latest", "pcc_chat_history", // 239 Q2
  // credentials through the model, or provisioned by a tool
  "provision_api_key", "list_api_keys", "redeem_invite",
  // requests to an absolute URL
  "pcc_generate_ui",
  // names LLMAgent reserves (validateToolNames: delete_*, fund_*, ...)
  "delete_operator_channel", "fund_escrow",
] as const;

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  allowlist: TOOL_ALLOWLIST,
  never: new Set(NEVER),
};

/** A tool's endpoint, from the pinned agent package. */
export interface ToolSpec {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

/**
 * P2: the allowlist is the ONLY way in. An absolute-URL path and the
 * explicit NEVER set are extra guards checked first; everything else is
 * `never` unless TOOL_ALLOWLIST names it, in which case its level is exactly
 * what the allowlist says -- never derived from the HTTP method or path.
 */
export function classify(spec: ToolSpec, policy: ToolPolicy = DEFAULT_TOOL_POLICY): ToolLevel {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec.path)) return "never";
  if (policy.never.has(spec.name)) return "never";
  const entry = policy.allowlist.get(spec.name);
  return entry ? entry.level : "never";
}

/** The typed projection for an allowlisted tool, or undefined when the tool
 * is not (or no longer) allowlisted -- the caller (tools.ts' packTools) must
 * treat `undefined` as "project to nothing", never as "pass the raw value". */
export function outputSpecFor(name: string, policy: ToolPolicy = DEFAULT_TOOL_POLICY): OutputSpec | undefined {
  return policy.allowlist.get(name)?.output;
}
