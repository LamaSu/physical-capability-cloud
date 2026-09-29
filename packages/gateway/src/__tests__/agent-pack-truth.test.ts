/**
 * The agent pack tells agents only true things (ADK track item 2; board N75, N76).
 *
 * The pack is apps/dashboard/public/agent-package.json plus the pcc skill in its
 * three copies. Every check here failed on master ac86a404:
 *   - the onboarding route `POST /api/onboard/session/start` does not exist
 *     (template-session serves `POST /api/onboard/start`);
 *   - three advertised packages do not exist anywhere
 *     (@pcc/operator-agent-runtime, @pcc/decompose-skill, @pcc/evidence-judge);
 *   - the dashboard skill said 249 tools, and metadata.tool_count said 254,
 *     while the package holds 253;
 *   - kernel_announce_capabilities claimed to register capabilities, but the
 *     route acknowledges and stores nothing;
 *   - `pip install pcc-node` resolves to nothing while 0.1.0 is yanked, and
 *     without the crypto extra a node cannot sign evidence at all.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const PKG_PATH = join(REPO, "apps/dashboard/public/agent-package.json");
const SKILLS = ["apps/dashboard/public/skills/pcc.md", "skills/pcc/SKILL.md", ".claude/skills/pcc/SKILL.md"];

const pkgText = readFileSync(PKG_PATH, "utf8");
const pkg = JSON.parse(pkgText) as {
  toolCount: number;
  tools: Array<{ name: string; description: string; endpoint: { method: string; path: string } }>;
};
const PACK: Array<[string, string]> = [
  ["agent-package.json", pkgText],
  ...SKILLS.map((p): [string, string] => [p, readFileSync(join(REPO, p), "utf8")]),
];

/** Every package name defined in this repo, private or not. */
function repoPackages(): Set<string> {
  const names = new Set<string>();
  for (const root of ["packages", "apps"]) {
    for (const entry of readdirSync(join(REPO, root), { withFileTypes: true })) {
      const pj = join(REPO, root, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(pj)) continue;
      const name = JSON.parse(readFileSync(pj, "utf8")).name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

describe("the agent pack tells agents only true things", () => {
  it("names the onboarding route that exists (N76)", () => {
    for (const [file, text] of PACK) {
      expect(text.includes("/api/onboard/session/start"), file).toBe(false);
    }
    const start = pkg.tools.find((t) => t.name === "pcc_onboard_session_start");
    expect(start?.endpoint).toEqual({ method: "POST", path: "/api/onboard/start" });
  });

  it("names only packages that exist in this repo", () => {
    const known = repoPackages();
    for (const [file, text] of PACK) {
      const named = new Set(text.match(/@pcc\/[a-z0-9-]+/g) ?? []);
      const missing = [...named].filter((n) => !known.has(n));
      expect(missing, file).toEqual([]);
    }
  });

  it("states tool counts the package can back", () => {
    expect(pkg.toolCount).toBe(pkg.tools.length);
    // metadata.tool_count said 254 on master while the package held 253 tools.
    const meta = (pkg as { metadata?: { tool_count?: number } }).metadata;
    if (meta?.tool_count !== undefined) expect(meta.tool_count).toBe(pkg.tools.length);
    for (const [file, text] of PACK) {
      for (const m of text.matchAll(/\b(\d{2,4})(\+?) tools\b/g)) {
        const n = Number(m[1]);
        if (m[2] === "+") expect(n, `${file}: "${m[0]}"`).toBeLessThanOrEqual(pkg.tools.length);
        else expect(n, `${file}: "${m[0]}"`).toBe(pkg.tools.length);
      }
    }
  });

  it("does not sell kernel_announce_capabilities as registration (N75)", () => {
    const announce = pkg.tools.find((t) => t.name === "kernel_announce_capabilities");
    expect(announce).toBeDefined();
    expect(announce!.description).not.toMatch(/register/i);
    expect(announce!.description).toMatch(/stores nothing/i);
    expect(announce!.description).toContain("create_capability");
  });

  // 0.1.0 is yanked, so >=0.1.1. And without pynacl (the crypto extra) the node
  // cannot sign evidence or register a signing key: log_capture.py and
  // register.py fail closed, so a plain install can never reach a verified run.
  it("installs a pcc-node that exists and can sign: pcc-node[crypto]>=0.1.1", () => {
    for (const [file, text] of PACK) {
      for (const m of text.matchAll(/pip3? install [^\n`]*pcc-node[^\n`]*/g)) {
        expect(m[0], file).toMatch(/pcc-node\[(?:[^\]]*,\s*)?(?:crypto|all)(?:\s*,[^\]]*)?\]>=0\.1\.1/);
      }
    }
  });
});

/**
 * Dress rehearsal R0 (refvertical, returns/pcc-refvertical-work/rehearsal/
 * R0-findings.md): a fresh agent onboarded a simulated instrument from this
 * pack against a gateway built from master. Each check below is a place where
 * the pack disagreed with that gateway. Each was re-verified in the code
 * before the pack changed (returns/pcc-adk-work/r0-pack-triage.md).
 */
describe("rehearsal R0: the pack matches the gateway it describes", () => {
  const full = pkg as unknown as {
    system_prompt: string;
    quickstart: unknown;
    dtos: { JobOffer: { shape: Record<string, unknown> } };
    tools: Array<{ name: string; description: string; input_schema: { required?: string[]; properties?: Record<string, any> } }>;
  };
  const sp = full.system_prompt;
  const tool = (name: string) => {
    const t = full.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };

  it("P1: resolves against the gateway it was given, with production only the default", () => {
    expect(sp).not.toContain("All endpoints resolve against https://capability.network.");
    expect(sp).toContain("PCC_BASE");
    const quick = JSON.stringify(full.quickstart);
    expect(quick).not.toContain("const PCC_BASE = pkg.api_base;");
    expect(quick.match(/process\.env\.PCC_BASE/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("P4: does not sell /api/capabilities/types as an authoritative list of operators' types", () => {
    expect(sp).not.toContain("the complete, live list of every registered capability type");
    expect(sp).not.toContain("returns the complete set of registered types");
    expect(sp).toMatch(/may have no operator/);
  });

  it("P5: onboard_machine documents the operator it records", () => {
    const t = tool("onboard_machine");
    expect(t.input_schema.properties?.operator?.properties?.walletAddress).toBeDefined();
    expect(t.description).toContain("0x0000000000000000000000000000000000000000");
  });

  it("P6: JobOffer names the fields the offer routes return", () => {
    const shape = full.dtos.JobOffer.shape;
    expect(shape.claimedByKernelId).toBeDefined();
    expect(shape.claimedBy).toBeUndefined();
    expect(shape.posterDid).toBeDefined();
    expect(shape.requireHeartbeat).toBeDefined();
  });

  it("P7: finish a job with pcc_job_complete, never by setting completed first", () => {
    expect(tool("operator_update_job_status").description).toContain("pcc_job_complete");
    expect(tool("pcc_job_complete").description).toContain("409");
  });

  it("P8: does not claim settlement flows through oracle routes the gateway does not serve", () => {
    for (const name of ["pcc_oracle_status", "pcc_oracle_verify"]) {
      const d = tool(name).description;
      expect(d).not.toMatch(/critical path|required for all escrow settlements/i);
      expect(d).toContain("404");
    }
  });

  it("G8: register-device requires exactly what POST /api/setup/register-device requires", () => {
    // setup.ts: if (!kernelId || !deviceId || !type || !adapterType) -> 400 missing_required_fields
    expect([...(tool("setup_register_device").input_schema.required ?? [])].sort()).toEqual(
      ["adapterType", "deviceId", "kernelId", "type"],
    );
  });

  it("P1 (skills and examples): calls go to PCC_BASE, never a hard-coded production API URL", () => {
    for (const [file, text] of PACK) {
      expect(text, file).not.toMatch(/curl[^\n]*https:\/\/capability\.network\/(?:api|ask)\b/);
    }
  });

  it("G9 (everywhere): a storage line that mentions multipart says it is refused", () => {
    for (const [file, text] of PACK) {
      for (const line of text.split(/\\n|\n/)) {
        if (line.includes("/api/storage") && /multipart/i.test(line)) expect(line, file).toMatch(/refused/);
      }
    }
  });

  it("G5/N81: an operator is never told to PATCH an offer with evidence", () => {
    for (const [file, text] of PACK) {
      for (const line of text.split(/\\n|\n/)) {
        if (/PATCH/.test(line) && /evidence/i.test(line)) expect(line, file).toMatch(/poster-only|403/);
      }
    }
  });

  it("G9: storage uploads are the raw bytes, not a JSON body", () => {
    expect(sp).toMatch(/POST \/api\/storage[^\n]*application\/octet-stream/);
    expect(sp).toMatch(/JSON body is refused/);
  });
});

/**
 * Item 2b: the pack reports whole onboarding attempts in painpoints' contract v1
 * (returns/pcc-painpoints-work/item3-attempt-reporting-contract-v1.md): every
 * phase, success or failure, and a session roll-up. The lists below are the
 * contract's; if they change, the contract version changes first.
 */
describe("item 2b: attempt reporting follows painpoints' contract v1", () => {
  const PHASES = ["prerequisites", "identify", "intake", "research", "build", "register", "verify", "operate", "publish", "session"];
  const OUTCOMES = ["ok", "failed", "blocked", "skipped", "budget_stop", "abandoned", "in_progress"];
  const full = pkg as unknown as {
    system_prompt: string;
    attempt_reporting?: { contract: number; endpoint: { method: string; path: string }; phases: string[] };
    tools: Array<{ name: string; endpoint: { method: string; path: string }; input_schema: { required?: string[]; properties: Record<string, any> } }>;
  };
  const report = full.tools.find((t) => t.name === "pcc_report_attempt");

  it("ships a typed pcc_report_attempt tool on POST /api/feedback", () => {
    expect(report).toBeDefined();
    expect(report!.endpoint).toEqual({ method: "POST", path: "/api/feedback" });
    const p = report!.input_schema.properties;
    expect(p.kind.enum).toEqual(["attempt"]);
    expect(p.contract.enum).toEqual([1]);
    expect(p.phase.enum).toEqual(PHASES);
    expect(p.outcome.enum).toEqual(OUTCOMES);
    expect(p.proposal.properties.target.enum).toEqual(["runbook", "agent-package", "docs", "code", "process", "other"]);
    expect(p.tokens.properties.source.enum).toEqual(["self_reported", "harness", "metered", "unknown"]);
  });

  it("requires what today's server needs, and never carries a transcript", () => {
    expect([...(report!.input_schema.required ?? [])].sort()).toEqual(["kind", "outcome", "phase", "seq", "sessionId", "summary"]);
    expect(report!.input_schema.properties.transcript).toBeUndefined();
    expect(report!.input_schema.properties.consent.properties.transcript.enum).toEqual([false]);
  });

  it("describes the contract at the top level and in the operator path", () => {
    expect(full.attempt_reporting?.contract).toBe(1);
    expect(full.attempt_reporting?.endpoint).toEqual({ method: "POST", path: "/api/feedback" });
    expect(full.attempt_reporting?.phases).toEqual(PHASES);
    expect(full.system_prompt).toContain("pcc_report_attempt");
  });
});
