import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classify, DEFAULT_TOOL_POLICY } from "../policy.js";

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
    "provision_api_key", "list_api_keys", "pcc_generate_ui",
  ])("%s is never offered (device, impersonation, credential or absolute URL)", (name) => {
    expect(level(name)).toBe("never");
  });

  it.each([
    "pcc_submit_paid_job", "marketplace_place_order", "distribute_royalties", "create_kernel", "create_capability",
    "prove_registration", "activate_registration", "pcc_job_complete", "operator_push_evidence", "claim_bounty",
    "fund_escrow", "execute_composition", "revoke_api_key",
  ])("%s is L2 (money, work, authority)", (name) => {
    expect(level(name)).toBe("l2");
  });

  it.each(["setup_register_device", "setup_test_job", "onboard_machine", "pcc_onboard_session_start", "pcc_report"])(
    "%s is a confirmed write (the onboarding path)",
    (name) => {
      expect(level(name)).toBe("write");
    },
  );

  it("a GET is a read unless it is listed never", () => {
    expect(level("list_api_keys")).toBe("never");
    const get = pkg.tools.find((t) => t.endpoint.method === "GET" && !DEFAULT_TOOL_POLICY.never.has(t.name))!;
    expect(level(get.name)).toBe("read");
  });

  it("a listed write whose path looks like money is escalated to L2", () => {
    expect(classify({ name: "setup_validate", method: "POST", path: "/api/wallet/sweep" })).toBe("l2");
  });

  it("an unlisted non-GET tool, and any absolute-URL tool, is never offered", () => {
    expect(classify({ name: "brand_new_tool", method: "POST", path: "/api/new" })).toBe("never");
    expect(classify({ name: "list_things", method: "GET", path: "https://elsewhere.example/api" })).toBe("never");
  });
});
