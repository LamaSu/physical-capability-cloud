import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classify, DEFAULT_TOOL_POLICY, PASSIVE_READS } from "../policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, "../../../../apps/dashboard/public/agent-package.json");
const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as {
  version: string;
  tools: Array<{ name: string; endpoint: { method: string; path: string } }>;
};
const spec = (t: (typeof pkg.tools)[number]) => ({ name: t.name, method: t.endpoint.method, path: t.endpoint.path });
const level = (name: string) => classify(spec(pkg.tools.find((t) => t.name === name)!));

describe("the policy table against the served agent package", () => {
  it("every non-GET tool is classified explicitly (a new package version must be reviewed here)", () => {
    const listed = new Set([...DEFAULT_TOOL_POLICY.write, ...DEFAULT_TOOL_POLICY.l2, ...DEFAULT_TOOL_POLICY.never]);
    const unlisted = pkg.tools
      .filter((t) => !["GET", "HEAD"].includes(t.endpoint.method.toUpperCase()))
      .map((t) => t.name)
      .filter((n) => !listed.has(n));
    expect(unlisted, `unreviewed non-GET tools in agent-package ${pkg.version}`).toEqual([]);
  });

  it("every listed name exists in the package (no stale entries)", () => {
    const names = new Set(pkg.tools.map((t) => t.name));
    const stale = [...DEFAULT_TOOL_POLICY.write, ...DEFAULT_TOOL_POLICY.l2, ...DEFAULT_TOOL_POLICY.never].filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  });

  it("no name is in two lists", () => {
    const all = [...DEFAULT_TOOL_POLICY.write, ...DEFAULT_TOOL_POLICY.l2, ...DEFAULT_TOOL_POLICY.never];
    expect(all.length).toBe(new Set(all).size);
  });

  it.each([
    "pcc_relay_tool_call", "pcc_relay_generic_tool_call", "pcc_create_scope", "pcc_chat_send", "start_protocol_run",
    "cancel_protocol_run", "kernel_heartbeat", "kernel_announce_capabilities", "operator_heartbeat",
    "provision_api_key", "list_api_keys", "pcc_generate_ui", "delete_operator_channel", "fund_escrow",
    "setup_test_job", "redeem_invite", "execute_composition", "pcc_submit_paid_job",
  ])("%s is never offered (device, impersonation, credential, absolute URL, or a name LLMAgent reserves)", (name) => {
    expect(level(name)).toBe("never");
  });

  it("Q3-A: setup_test_job is never: it submits a job that the gateway's runner executes on a device", () => {
    expect(level("setup_test_job")).toBe("never");
    expect(DEFAULT_TOOL_POLICY.write.has("setup_test_job")).toBe(false);
  });

  it("Q3-B: redeem_invite is never: its answer carries a session token and new wallet material", () => {
    expect(level("redeem_invite")).toBe("never");
    expect(DEFAULT_TOOL_POLICY.write.has("redeem_invite")).toBe(false);
  });

  it("Q2 round 2: execute_composition is never: its production implementation submits every step as a real job via JobFacade.submit (packages/gateway/src/routes/compose.ts createProductionBinding)", () => {
    expect(level("execute_composition")).toBe("never");
    expect(DEFAULT_TOOL_POLICY.l2.has("execute_composition")).toBe(false);
  });

  it("Q2 round 2: pcc_submit_paid_job is never: its handler commits a job to a kernelId and opens an active execution scope on it (packages/gateway/src/routes/paid-job-flow.ts createJobFromSession, repos.jobs.insert + executionScopes insert with status 'active')", () => {
    expect(level("pcc_submit_paid_job")).toBe("never");
    expect(DEFAULT_TOOL_POLICY.l2.has("pcc_submit_paid_job")).toBe(false);
  });

  it.each([
    "marketplace_place_order", "distribute_royalties", "create_kernel", "create_capability",
    "prove_registration", "activate_registration", "pcc_job_complete", "claim_bounty",
    "release_milestone", "revoke_api_key",
  ])("%s is L2 (money, work, authority)", (name) => {
    expect(level(name)).toBe("l2");
  });

  // B1 (round 4, 224b, CRITICAL) + B2 (HIGH): the property is "the hosted agent
  // NEVER acts as a device or operator node" -- every /api/operator/* tool
  // (whatever its method: a GET there is just as much the operator's own
  // channel as a POST) plus update_job_status, which its own description
  // marks as "used by kernels to report job progress", not the brain. These
  // let the agent impersonate the operator's relay client or a device's own
  // kernel reporting its OWN status/evidence/heartbeat/jobs -- a class astra
  // named at operator_poll_jobs (was: confirmed-write), operator_push_evidence
  // and operator_update_job_status (were: l2); the full audit of agent-package
  // 2.19.1 found eight more of the same shape, unlisted or in WRITE.
  it.each([
    "operator_poll_jobs", // GET /api/operator/jobs (B1 CRITICAL: was unlisted -> confirmed-write)
    "operator_push_evidence", // POST /api/operator/evidence (B2 HIGH: was l2)
    "operator_update_job_status", // POST /api/operator/job-status (B2 HIGH: was l2)
    "update_job_status", // PATCH /api/jobs/{jobId}/status (was l2: "used by kernels to report job progress")
    "get_operator_machines", // GET /api/operator/machines (was unlisted -> confirmed-write)
    "get_operator_earnings", // GET /api/operator/earnings (was unlisted -> confirmed-write)
    "get_operator_certs", // GET /api/operator/certifications (was unlisted -> confirmed-write)
    "send_diagnostics", // POST /api/operator/diagnostics (was write)
    "send_support_message", // POST /api/operator/support (was write)
    "check_support_replies", // GET /api/operator/support/mine (was unlisted -> confirmed-write)
    "reply_to_support_thread", // POST /api/operator/support/{threadId}/reply (was write)
  ])("%s is never offered: the hosted agent never acts as a device or operator node", (name) => {
    expect(level(name)).toBe("never");
  });

  it("B1: operator_poll_jobs is never, and is not left in write/l2 as a second listing", () => {
    expect(level("operator_poll_jobs")).toBe("never");
    expect(DEFAULT_TOOL_POLICY.write.has("operator_poll_jobs")).toBe(false);
    expect(DEFAULT_TOOL_POLICY.l2.has("operator_poll_jobs")).toBe(false);
  });

  it("B2: operator_push_evidence and operator_update_job_status are never, not l2", () => {
    expect(level("operator_push_evidence")).toBe("never");
    expect(level("operator_update_job_status")).toBe("never");
    expect(DEFAULT_TOOL_POLICY.l2.has("operator_push_evidence")).toBe(false);
    expect(DEFAULT_TOOL_POLICY.l2.has("operator_update_job_status")).toBe(false);
  });

  // The device relay's reads are never too (lane review of round 4): the hosted agent never creates a
  // relay call, so it has no legitimate relay id to poll, and GET /api/ot2/tool-result/:id has no
  // ownership check. pcc_relay_tool_call, pcc_relay_generic_tool_call, kernel_heartbeat and
  // operator_heartbeat were already never.
  it("the device relay's reads (pcc_get_tool_result, pcc_get_tool_manifest) are never offered", () => {
    expect(level("pcc_get_tool_result")).toBe("never");
    expect(level("pcc_get_tool_manifest")).toBe("never");
  });

  it.each(["setup_register_device", "onboard_machine", "pcc_onboard_session_start", "pcc_report"])(
    "%s is a confirmed write (the onboarding path)",
    (name) => {
      expect(level(name)).toBe("write");
    },
  );

  it("Q3-C: get_dashboard is held like a write: on the full /mcp surface it bumps loadCount and updatedAt", () => {
    expect(level("get_dashboard")).toBe("write");
    expect(PASSIVE_READS.has("get_dashboard")).toBe(false);
  });

  it("Q3-C: the passive reads are exactly the reviewed set; adding one needs an individual effect review", () => {
    expect([...PASSIVE_READS].sort()).toEqual([
      "get_job",
      "get_kernel",
      "get_kernel_devices",
      "get_kernel_jobs",
      "list_capability_types",
      "list_jobs",
      "list_kernels",
      "search_capabilities",
      "search_dashboards",
    ]);
  });

  it("Q3-C: every passive read is a GET tool of the pinned package, and runs directly", () => {
    for (const name of PASSIVE_READS) {
      const tool = pkg.tools.find((t) => t.name === name);
      expect(tool, `${name} must exist in agent-package ${pkg.version}`).toBeDefined();
      expect(tool!.endpoint.method.toUpperCase()).toBe("GET");
      expect(level(name)).toBe("read");
    }
  });

  it("Q3-C: every other GET is held for confirmation like a write (or never); none runs directly", () => {
    const gets = pkg.tools.filter((t) => ["GET", "HEAD"].includes(t.endpoint.method.toUpperCase()));
    expect(gets.length).toBeGreaterThan(100);
    for (const t of gets) {
      if (PASSIVE_READS.has(t.name)) continue;
      expect(level(t.name), t.name).toBe(DEFAULT_TOOL_POLICY.never.has(t.name) ? "never" : "write");
    }
  });

  it("Q3-C: a listed passive read whose pinned endpoint is no longer a GET is not a read; an absolute URL stays never", () => {
    expect(classify({ name: "list_jobs", method: "POST", path: "/api/jobs" })).not.toBe("read");
    expect(classify({ name: "list_jobs", method: "GET", path: "https://elsewhere.example/api/jobs" })).toBe("never");
  });

  it("Q3-C: a GET that is listed never stays never", () => {
    expect(level("list_api_keys")).toBe("never");
  });

  it("a listed write whose path looks like money is escalated to L2", () => {
    expect(classify({ name: "setup_validate", method: "POST", path: "/api/wallet/sweep" })).toBe("l2");
  });

  it("an unlisted non-GET tool, and any absolute-URL tool, is never offered", () => {
    expect(classify({ name: "brand_new_tool", method: "POST", path: "/api/new" })).toBe("never");
    expect(classify({ name: "list_things", method: "GET", path: "https://elsewhere.example/api" })).toBe("never");
  });
});

describe("the policy and LLMAgent's reserved names", () => {
  it("every tool the policy can offer (read, write or L2) is a name LLMAgent accepts", async () => {
    const { validateToolNames } = await import("@pcc/agent-runtime");
    const offerable = pkg.tools.filter((t) => classify(spec(t)) !== "never");
    for (const t of offerable) {
      expect(() => validateToolNames([{ name: t.name, description: "", input_schema: { type: "object" } }]), t.name).not.toThrow();
    }
  });
});
