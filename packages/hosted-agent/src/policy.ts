/**
 * Which agent-package tools the hosted agent is offered, and how (operator
 * item 100, question 3; this table is the proposal). Keyed by tool NAME in the
 * pinned package, and reviewed against agent-package 2.19.1.
 *
 *   read  — every GET/HEAD not listed in NEVER; runs at once.
 *   write — listed in WRITE; each call waits for the user's confirmation.
 *   l2    — money, accepting work, price, payout, authority; offered only
 *           when the L2 flag is on, and confirmed like a write.
 *   never — not offered, whatever the flag: device actuation or impersonation
 *           (the hosted agent never drives a device), credentials passing
 *           through the model, and requests to absolute URLs.
 * An unlisted non-GET tool is NEVER offered, so a new package version adds
 * nothing until its tools are reviewed here. A WRITE tool whose path looks like
 * money or safety is escalated to l2 as a second net.
 */
export type ToolLevel = "read" | "write" | "l2" | "never";

export interface ToolPolicy {
  readonly write: ReadonlySet<string>;
  readonly l2: ReadonlySet<string>;
  readonly never: ReadonlySet<string>;
  readonly l2PathPatterns: readonly RegExp[];
}

/** The onboarding path and harmless writes. */
const WRITE = [
  "setup_generate_config", "setup_validate", "setup_register_device", "setup_test_job",
  "get_build_options", "build_contract", "calculate_roi", "match_spaces", "get_shipment_quote", "near_quote",
  "onboard_machine", "analyze_machine_docs", "redeem_invite",
  "pcc_onboard_session_start", "pcc_onboard_session_scrape", "pcc_onboard_session_ingest_docs", "pcc_onboard_session_build_agent",
  "pcc_orchestrator_match_capabilities", "pcc_dht_query",
  "create_protocol", "update_protocol", "fork_protocol", "validate_protocol",
  "pcc_trilobio_build_config", "pcc_trilobio_validate_options", "pcc_trilobio_validate_script",
  "propose_composition", "submit_demand",
  "submit_feedback", "pcc_report", "report_anomaly", "report_protocol_failure", "resolve_anomaly", "emit_telemetry",
  "send_diagnostics", "send_support_message", "reply_to_support_thread",
  "attach_operator_channel", "update_operator_channel", "delete_operator_channel", "test_operator_channels",
  "pcc_contributor_register", "pcc_schedule_publish", "pcc_schedule_evaluate", "pcc_training_manifest_set",
  "save_dashboard", "fork_dashboard", "update_dashboard", "archive_evidence",
] as const;

/** Money, accepting or completing work, price, payout, evidence and authority. */
const L2 = [
  "calculate_price", "fund_escrow", "release_milestone", "file_escrow_dispute", "deposit_bond",
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
  // device actuation: runs or relays commands on hardware
  "pcc_relay_tool_call", "pcc_relay_generic_tool_call", "pcc_create_scope", "pcc_revoke_scope", "pcc_chat_send",
  "start_protocol_run", "pause_protocol_run", "resume_protocol_run", "cancel_protocol_run",
  // device impersonation: calls only the device's own runtime makes
  "kernel_heartbeat", "kernel_announce_capabilities", "operator_heartbeat",
  // credentials through the model: a key in a tool result lands in the transcript
  "provision_api_key", "list_api_keys",
  // requests to an absolute URL
  "pcc_generate_ui",
] as const;

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
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
  if (method === "GET" || method === "HEAD") return "read";
  if (policy.l2.has(spec.name)) return "l2";
  if (policy.write.has(spec.name)) {
    return policy.l2PathPatterns.some((re) => re.test(spec.path)) ? "l2" : "write";
  }
  return "never";
}
