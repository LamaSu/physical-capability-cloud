/**
 * Which agent-package tools the hosted agent is offered, and how (operator
 * item 100, question 3; this table is the proposal). Keyed by tool NAME in the
 * pinned package, and reviewed against agent-package 2.19.1.
 *
 *   read  — a GET/HEAD listed in PASSIVE_READS (reviewed to write nothing on the
 *           full /mcp surface); runs at once.
 *   write — listed in WRITE, or any other GET/HEAD; each call waits for the
 *           user's confirmation. A GET proves the verb, not the absence of a
 *           side effect, so a GET that is not reviewed is confirmed like a write.
 *   l2    — money, accepting work, price, payout, authority; offered only
 *           when the L2 flag is on, and confirmed like a write.
 *   never — not offered, whatever the flag: device actuation or impersonation
 *           (the hosted agent never drives a device, so nothing that submits a
 *           job to one), credentials passing through the model or provisioned
 *           by a tool, and requests to absolute URLs.
 * An unlisted non-GET tool is NEVER offered, so a new package version adds
 * nothing until its tools are reviewed here. A WRITE tool whose path looks like
 * money or safety is escalated to l2 as a second net.
 */
export type ToolLevel = "read" | "write" | "l2" | "never";

export interface ToolPolicy {
  /** GET tools reviewed to write nothing on the full /mcp surface. */
  readonly passiveReads: ReadonlySet<string>;
  readonly write: ReadonlySet<string>;
  readonly l2: ReadonlySet<string>;
  readonly never: ReadonlySet<string>;
  readonly l2PathPatterns: readonly RegExp[];
}

/**
 * GET tools that write nothing on the FULL /mcp surface, so they run without a
 * confirmation. This is the gateway's own reviewed /mcp/apps allowlist
 * (READONLY_APP_PROXY_TOOLS, packages/gateway/src/mcp/http-mcp-server.ts) MINUS
 * every entry that is passive only because the gateway sets the
 * `x-pcc-mcp-readonly` header on /mcp/apps, which a signed-in session does not
 * use. That is get_dashboard: on /mcp its handler bumps loadCount and updatedAt.
 *
 * Adding a name here REQUIRES an individual effect review on the full path (no
 * counter or timestamp write, no lazy insert, no lease, queue or trigger, no
 * token use, no external or on-chain read). policy.test.ts pins this exact set.
 */
const PASSIVE_READS_LIST = [
  "search_dashboards", //   GET /api/artifacts
  "list_kernels", //        GET /api/kernels
  "get_kernel", //          GET /api/kernels/{kernelId}
  "get_kernel_devices", //  GET /api/kernels/{kernelId}/devices
  "get_kernel_jobs", //     GET /api/kernels/{kernelId}/jobs
  "list_jobs", //           GET /api/jobs
  "get_job", //             GET /api/jobs/{jobId}
  "list_capability_types", // GET /api/capabilities/types
  "search_capabilities", //   GET /api/capabilities/templates
] as const;

export const PASSIVE_READS: ReadonlySet<string> = new Set(PASSIVE_READS_LIST);

/** The onboarding path and harmless writes. */
const WRITE = [
  "setup_generate_config", "setup_validate", "setup_register_device",
  "get_build_options", "build_contract", "calculate_roi", "match_spaces", "get_shipment_quote", "near_quote",
  "onboard_machine", "analyze_machine_docs",
  "pcc_onboard_session_start", "pcc_onboard_session_scrape", "pcc_onboard_session_ingest_docs", "pcc_onboard_session_build_agent",
  "pcc_orchestrator_match_capabilities", "pcc_dht_query",
  "create_protocol", "update_protocol", "fork_protocol", "validate_protocol",
  "pcc_trilobio_build_config", "pcc_trilobio_validate_options", "pcc_trilobio_validate_script",
  "propose_composition", "submit_demand",
  "submit_feedback", "pcc_report", "report_anomaly", "report_protocol_failure", "resolve_anomaly", "emit_telemetry",
  "send_diagnostics", "send_support_message", "reply_to_support_thread",
  "attach_operator_channel", "update_operator_channel", "test_operator_channels",
  "pcc_contributor_register", "pcc_schedule_publish", "pcc_schedule_evaluate", "pcc_training_manifest_set",
  "save_dashboard", "fork_dashboard", "update_dashboard", "archive_evidence",
] as const;

/** Money, accepting or completing work, price, payout, evidence and authority. */
const L2 = [
  "calculate_price", "release_milestone", "file_escrow_dispute", "deposit_bond",
  "submit_evidence_hash", "submit_attestation", "protocol_create_escrow",
  "pay_ip_royalty", "claim_ip_revenue", "distribute_royalties", "register_capability_ip", "register_job_evidence_ip", "raise_ip_dispute",
  "claim_bounty", "verify_bounty", "stake_in_pool", "claim_pool", "create_investment_pool", "close_pool", "convert_bounty_to_pool",
  "approve_registration", "reject_registration", "activate_registration", "prove_registration",
  "create_kernel", "create_capability", "pcc_dht_announce",
  "marketplace_create_listing", "marketplace_update_listing", "marketplace_delete_listing", "marketplace_place_order",
  "pcc_submit_paid_job", "pcc_job_complete", "update_job_status", "operator_update_job_status", "operator_push_evidence",
  "pcc_submit_request", "pcc_decompose_request", "pcc_publish_request", "pcc_assign_node_operator",
  "pcc_update_node_status", "pcc_update_request", "pcc_cancel_request", "execute_composition", "create_shipment",
  "mint_certificate", "near_intent", "lit_decrypt", "grant_evidence_access", "archive_encrypted_bundle", "revoke_api_key",
  "pcc_capture_challenge", "pcc_capture_upload", "pcc_capture_anchor", "commit_evidence", "verify_evidence_zk",
  "submit_for_human_verification", "respond_to_verification", "dispute_verification", "pcc_oracle_verify",
  "publish_protocol", "create_protocol_run", "record_episode", "advance_automation",
] as const;

/** Never offered. */
const NEVER = [
  // device actuation: runs or relays commands on hardware (setup_test_job submits a job the gateway's runner executes on the device)
  "pcc_relay_tool_call", "pcc_relay_generic_tool_call", "pcc_create_scope", "pcc_revoke_scope", "pcc_chat_send",
  "start_protocol_run", "pause_protocol_run", "resume_protocol_run", "cancel_protocol_run", "setup_test_job",
  // device impersonation: calls only the device's own runtime makes
  "kernel_heartbeat", "kernel_announce_capabilities", "operator_heartbeat",
  // credentials through the model, or provisioned by a tool: a key or session token in a tool result lands in the transcript
  // (redeem_invite takes a password and answers with a session token and new wallet material)
  "provision_api_key", "list_api_keys", "redeem_invite",
  // requests to an absolute URL
  "pcc_generate_ui",
  // names LLMAgent reserves (validateToolNames: delete_*, fund_*, ...); the loop will not run with them
  "delete_operator_channel", "fund_escrow",
] as const;

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  passiveReads: PASSIVE_READS,
  write: new Set(WRITE),
  l2: new Set(L2),
  never: new Set(NEVER),
  l2PathPatterns: [
    /\/claim\b/i, /\/accept\b/i, /emergency/i, /\/policy\b/i, /\/approv/i, /\/reject\b/i, /payout/i, /pric(e|ing)/i,
    /wallet/i, /\/fund/i, /transfer/i, /withdraw/i, /escrow/i, /settle/i, /\/pay\b|\/pay\//i, /stake|slash/i,
  ],
};

/** A tool's endpoint, from the pinned agent package. */
export interface ToolSpec {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

export function classify(spec: ToolSpec, policy: ToolPolicy = DEFAULT_TOOL_POLICY): ToolLevel {
  if (policy.never.has(spec.name)) return "never";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec.path)) return "never";
  const method = spec.method.toUpperCase();
  const readVerb = method === "GET" || method === "HEAD";
  // A reviewed passive read runs at once. Any other GET is held like a write: the verb is not the effect.
  if (readVerb && policy.passiveReads.has(spec.name)) return "read";
  if (policy.l2.has(spec.name)) return "l2";
  if (readVerb) return "write";
  if (policy.write.has(spec.name)) {
    return policy.l2PathPatterns.some((re) => re.test(spec.path)) ? "l2" : "write";
  }
  return "never";
}
