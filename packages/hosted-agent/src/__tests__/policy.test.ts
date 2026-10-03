import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { classify, DEFAULT_TOOL_POLICY, outputSpecFor, type FieldSpec, type OutputSpec } from "../policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(here, "../../../../apps/dashboard/public/agent-package.json");
const pkg = JSON.parse(readFileSync(PACKAGE, "utf8")) as {
  version: string;
  tools: Array<{ name: string; endpoint: { method: string; path: string } }>;
};
const spec = (t: (typeof pkg.tools)[number]) => ({ name: t.name, method: t.endpoint.method, path: t.endpoint.path });
const level = (name: string) => classify(spec(pkg.tools.find((t) => t.name === name)!));

/** Every field-shaped name a secret-field key is compared under (tools.ts'
 * own `isSecretField`: lower-cased, `_`/`-`/space stripped). A dedicated,
 * independently-maintained list -- NOT an import from tools.ts -- so this
 * test cannot be defeated by the same edit that would break both at once. */
const SECRET_FIELD_NAMES = new Set([
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "authtoken", "bearertoken",
  "apikey", "rawkey", "secret", "clientsecret", "secretkey", "secretaccesskey", "apisecret", "appsecret",
  "password", "passwd", "pwd", "passphrase", "privatekey", "mnemonic", "seed", "seedphrase", "bearer", "authorization",
]);
const looksSecret = (fieldName: string): boolean => SECRET_FIELD_NAMES.has(fieldName.toLowerCase().replace(/[_ -]/g, ""));

/** Every field PATH an OutputSpec can project to, walked recursively. */
function fieldPaths(outputSpec: OutputSpec, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [name, fieldSpec] of Object.entries(outputSpec)) {
    const path = prefix ? `${prefix}.${name}` : name;
    paths.push(path);
    paths.push(...fieldSpecPaths(fieldSpec, path));
  }
  return paths;
}
function fieldSpecPaths(fieldSpec: FieldSpec, path: string): string[] {
  if (fieldSpec.type === "object") return fieldPaths(fieldSpec.fields, path);
  if (fieldSpec.type === "array") return fieldSpecPaths(fieldSpec.items, `${path}[]`);
  return [];
}

describe("P2 (round 5, 239): TOOL_ALLOWLIST is the ONLY way a tool is offered", () => {
  it("every tool in the pinned pack is either allowlisted or never -- no fallback classifies anything else", () => {
    for (const t of pkg.tools) {
      const allowed = DEFAULT_TOOL_POLICY.allowlist.has(t.name);
      const explicitlyNever = DEFAULT_TOOL_POLICY.never.has(t.name);
      if (!allowed) {
        expect(level(t.name), `${t.name} (${t.endpoint.method} ${t.endpoint.path})`).toBe("never");
      }
      if (explicitlyNever) {
        expect(allowed, `${t.name} is in both the explicit never set AND the allowlist`).toBe(false);
      }
    }
  });

  it("every listed allowlist name exists in the pinned package (no stale entries)", () => {
    const names = new Set(pkg.tools.map((t) => t.name));
    const stale = [...DEFAULT_TOOL_POLICY.allowlist.keys()].filter((n) => !names.has(n));
    expect(stale).toEqual([]);
  });

  it("a synthetic unlisted GET, and a synthetic unlisted POST, are never -- no unlisted GET becomes a confirmed write", () => {
    expect(classify({ name: "brand_new_read", method: "GET", path: "/api/new-read" })).toBe("never");
    expect(classify({ name: "brand_new_write", method: "POST", path: "/api/new-write" })).toBe("never");
  });

  it("a synthetic tool under a device/operator namespace, or taking a device id, is STILL never even if a caller invents a matching name", () => {
    // P2 does not special-case these paths anymore (that was v1, superseded) --
    // it is never because nothing unlisted is ever anything but never.
    expect(classify({ name: "pcc_new_device_thing", method: "GET", path: "/api/ot2/new-thing" })).toBe("never");
    expect(classify({ name: "new_machine_read", method: "GET", path: "/api/machines/x", })).toBe("never");
  });

  it("an absolute-URL path is never, even for an allowlisted name (belt and braces)", () => {
    const [anyAllowed] = [...DEFAULT_TOOL_POLICY.allowlist.keys()];
    expect(classify({ name: anyAllowed!, method: "GET", path: "https://elsewhere.example/api" })).toBe("never");
  });

  it("every allowlist entry has a non-empty reason and a non-empty OutputSpec", () => {
    for (const [name, entry] of DEFAULT_TOOL_POLICY.allowlist) {
      expect(entry.reason.length, `${name}'s reason`).toBeGreaterThan(20);
      expect(Object.keys(entry.output).length, `${name}'s output spec`).toBeGreaterThan(0);
    }
  });

  it("P1: no allowlist entry's OutputSpec projects a secret-named field, at any depth", () => {
    for (const [name, entry] of DEFAULT_TOOL_POLICY.allowlist) {
      for (const path of fieldPaths(entry.output)) {
        const leaf = path.split(".").pop()!.replace(/\[\]$/, "");
        expect(looksSecret(leaf), `${name}'s output spec has a secret-shaped field at "${path}"`).toBe(false);
      }
    }
  });

  it("NO write or L2 tool is allowlisted this round -- the initial allowlist is public reads only", () => {
    for (const [name, entry] of DEFAULT_TOOL_POLICY.allowlist) {
      expect(entry.level, name).toBe("read");
    }
  });

  it("this round's allowlist is exactly the 3 reviewed-public reads", () => {
    expect([...DEFAULT_TOOL_POLICY.allowlist.keys()].sort()).toEqual(["list_capability_types", "search_capabilities", "search_dashboards"]);
  });

  it("outputSpecFor returns undefined for an unlisted tool, and the real spec for an allowlisted one", () => {
    expect(outputSpecFor("not_a_real_tool")).toBeUndefined();
    expect(outputSpecFor("list_capability_types")).toBeDefined();
  });
});

describe("239 Q2: astra's 3 reproductions (unowned device/operator reads)", () => {
  it.each(["pcc_camera_latest", "pcc_chat_history", "get_operator_dashboard"])("%s is never offered", (name) => {
    expect(level(name)).toBe("never");
    expect(DEFAULT_TOOL_POLICY.allowlist.has(name)).toBe(false);
  });
});

describe("candidates reviewed and rejected (read the gateway handler, found tenant-specific data)", () => {
  it.each(["list_kernels", "get_kernel", "get_kernel_devices", "get_kernel_jobs", "list_jobs", "get_job"])(
    "%s is never offered: its handler returns more than a public discovery profile (operatorAddress/location/physicalAddress, or any kernel/job by caller-chosen id)",
    (name) => {
      expect(level(name)).toBe("never");
      expect(DEFAULT_TOOL_POLICY.allowlist.has(name)).toBe(false);
    },
  );
});

describe("historical never entries (prior rounds), kept as the explicit belt-and-braces guard", () => {
  it.each([
    "pcc_relay_tool_call", "pcc_relay_generic_tool_call", "pcc_create_scope", "pcc_chat_send",
    "setup_test_job", "redeem_invite", "execute_composition", "pcc_submit_paid_job",
    "kernel_heartbeat", "operator_heartbeat", "operator_poll_jobs", "operator_push_evidence",
    "provision_api_key", "list_api_keys", "pcc_generate_ui", "delete_operator_channel", "fund_escrow",
  ])("%s is never offered", (name) => {
    expect(level(name)).toBe("never");
  });
});

describe("the policy and LLMAgent's reserved names", () => {
  it("every tool the policy can offer (only `read` this round) is a name LLMAgent accepts", async () => {
    const { validateToolNames } = await import("@pcc/agent-runtime");
    const offerable = pkg.tools.filter((t) => classify(spec(t)) !== "never");
    expect(offerable.length).toBeGreaterThan(0);
    for (const t of offerable) {
      expect(() => validateToolNames([{ name: t.name, description: "", input_schema: { type: "object" } }]), t.name).not.toThrow();
    }
  });
});
