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
        // >=0.1.1, or (until 0.1.1 is on PyPI) a commit pinned in full: never a bare or older version.
        expect(m[0], file).toMatch(/pcc-node\[(?:[^\]]*,\s*)?(?:crypto|all)(?:\s*,[^\]]*)?\](?:>=0\.1\.1| @ git\+https:\/\/github\.com\/LamaSu\/physical-capability-cloud@[0-9a-f]{40}#subdirectory=packages\/pcc-node)/);
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

  // P7: the node path (pcc-node: POST /api/operator/evidence, then job-status
  // completed) and pcc_job_complete (execution scopes) are two ways to finish a
  // job. After the first, the second answers 409 (paid-job-flow.ts claim guard).
  it("P7: names the node's two-call finish and says pcc_job_complete then answers 409", () => {
    const status = tool("operator_update_job_status").description;
    expect(status).toContain("/api/operator/evidence");
    expect(status).toContain("pcc_job_complete");
    expect(tool("pcc_job_complete").description).toContain("409");
    expect(tool("pcc_job_complete").description).toContain("execution scopes");
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

/**
 * Verdict 102f on #452: each check below failed at f282e9ef, the reviewed SHA.
 * The pack must not bless a fail-open evidence path, describe fields the
 * routes do not serve, accept reports the contract forbids, or name an install
 * that cannot be resolved; and its claims are bound to the code behind them.
 */
describe("verdict 102f: the pack's claims hold, and its schema enforces contract v1", () => {
  const full = pkg as unknown as {
    tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  };
  const tool = (name: string) => {
    const t = full.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  const DASHBOARD_SKILL = PACK.find(([file]) => file === "apps/dashboard/public/skills/pcc.md")![1];
  const GW = join(REPO, "packages/gateway/src");
  const source = (rel: string) => readFileSync(join(GW, rel), "utf8");
  const gatewaySources = (dir = GW): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "__tests__" ? [] : gatewaySources(join(dir, e.name)))
        : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);

  it("F1: the node finish counts evidence only when the receipt says stored: true for this job", () => {
    for (const name of ["operator_update_job_status", "operator_push_evidence"]) {
      const d = tool(name).description;
      expect(d, name).toMatch(/stored: ?true/);
      expect(d, name).toMatch(/stored: ?false/);
    }
  });

  it("F2: no copy tells an agent to read evidence from an offer, or a top-level offer status", () => {
    for (const [file, text] of PACK) {
      expect(text, file).not.toMatch(/evidence` field on the offer|offer's evidence field/);
      expect(text, file).not.toMatch(/until `status === "settled"`/);
    }
    expect(DASHBOARD_SKILL).toMatch(/offer\.status/);
  });

  describe("F3: pcc_report_attempt's schema enforces contract v1", () => {
    const UUID = "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90";
    const ok = {
      kind: "attempt", contract: 1, sessionId: UUID, seq: 4, phase: "register", outcome: "failed", durationMs: 41200,
      summary: "POST /api/kernels returned 400: missing evidence tier",
      logs: [{ step: 3, method: "POST", path: "/api/kernels", status: 400, note: "evidenceTier required" }],
      ids: { kernelId: null }, device: { make: "Opentrons", model: "OT-2", class: "lab_instrument" },
      harness: { name: "claude-code", version: "2.3.1", model: "claude-opus-5-5" },
      pack: { version: "2.20.0", digest: "sha256:" + "ab".repeat(32) },
      env: { os: "linux", python: "3.12.4", pccNode: "0.9.2" }, tokens: { in: null, out: null, source: "unknown" },
      proposal: { target: "runbook", path: "runbook.json#register", text: "Ask for the evidence tier during intake" },
      consent: { transcript: false },
    };
    async function status(body: unknown): Promise<number> {
      const { default: Fastify } = await import("fastify");
      const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
      app.post("/v", { schema: { body: tool("pcc_report_attempt").input_schema } }, async () => ({ ok: true }));
      const res = await app.inject({ method: "POST", url: "/v", payload: body as object });
      await app.close();
      return res.statusCode;
    }

    it("accepts the contract's own example", async () => {
      expect(await status(ok)).toBe(200);
      expect(await status({ ...ok, phase: "session", phases: [{ phase: "register", outcome: "failed" }] })).toBe(200);
    });

    // Each case changes one field of a report the reviewed schema also accepts, so it
    // fails for its own reason and not for the null id above.
    const base = { ...ok, ids: { kernelId: "kernel_bench" } };

    it("accepts the base report", async () => {
      expect(await status(base)).toBe(200);
    });

    it.each([
      ["a transcript", { ...base, transcript: "the whole conversation" }],
      ["a sessionId that is not a UUID v4", { ...base, sessionId: "attempt-42" }],
      ["negative tokens", { ...base, tokens: { in: -1, out: null, source: "self_reported" } }],
      ["a malformed id", { ...base, ids: { kernelId: "kernel 1; DROP" } }],
      ["a roll-up outside the session report", { ...base, phases: [{ phase: "register", outcome: "ok" }] }],
      ["an unknown nested field", { ...base, consent: { transcript: false, share: true } }],
      ["a digest that is not sha256:<64 hex>", { ...base, pack: { version: "2.20.0", digest: "sha256:abc" } }],
    ])("refuses %s", async (_label, body) => {
      expect(await status(body)).toBe(400);
    });
  });

  it("F4: every pcc-node install line is resolvable: a pinned commit backs >=0.1.1 until it is on PyPI", () => {
    let installs = 0;
    for (const [file, text] of [...PACK, ["CLAUDE.md", readFileSync(join(REPO, "CLAUDE.md"), "utf8")] as [string, string]]) {
      const lines = [...text.matchAll(/(?:python3? -m )?(?:uv )?pip3? install[^\n`\\]*pcc-node[^\n`\\]*/gi)].map((m) => m[0]);
      installs += lines.length;
      if (lines.some((l) => />=0\.1\.1/.test(l))) {
        expect(text, `${file}: a >=0.1.1 install needs the pinned-commit fallback`).toMatch(/pcc-node\[crypto\] @ git\+https:\/\/github\.com\/LamaSu\/physical-capability-cloud@[0-9a-f]{40}#subdirectory=packages\/pcc-node/);
      }
    }
    expect(installs).toBeGreaterThan(0); // never vacuous
  });

  it("F5: the route claims are bound to the code that serves them", () => {
    // N76: templateSessionRoutes serves `${prefix}/start`, registered under /api/onboard.
    expect(source("routes/template-session.ts")).toContain("`${prefix}/start`");
    expect(source("server.ts")).toMatch(/register\(templateSessionRoutes,\s*\{\s*routePrefix:\s*["']\/api\/onboard["']/);
    // N75: announceCapabilities stores nothing; if it ever writes, the pack must change.
    const facade = source("facades/kernel.facade.ts");
    const announce = facade.slice(facade.indexOf("async announceCapabilities"), facade.indexOf("\n  }\n", facade.indexOf("async announceCapabilities")));
    expect(announce.length).toBeGreaterThan(0);
    expect(announce).not.toMatch(/\.(insert|upsert|update)\(|repos\.\w+\.(create|save|set)/);
    // The oracle tools say the gateway answers 404: no gateway route serves /api/oracle.
    const files = gatewaySources();
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\.(get|post)\s*(?:<[\s\S]*?>)?\(\s*["'`]\/api\/oracle\//);
    }
    // create_capability names the route that stores a capability.
    expect(tool("create_capability").description.length).toBeGreaterThan(0);
    expect(source("routes/capabilities.ts")).toMatch(/\.post[\s\S]{0,120}["'`]\/api\/capabilities["'`]/);
  });

  it("F6: an @pcc package the pack tells agents to install is publishable", () => {
    const publishable = new Map<string, boolean>();
    for (const root of ["packages", "apps"]) {
      for (const entry of readdirSync(join(REPO, root), { withFileTypes: true })) {
        const pj = join(REPO, root, entry.name, "package.json");
        if (!entry.isDirectory() || !existsSync(pj)) continue;
        const meta = JSON.parse(readFileSync(pj, "utf8"));
        if (typeof meta.name === "string") publishable.set(meta.name, meta.private !== true);
      }
    }
    for (const [file, text] of PACK) {
      for (const m of text.matchAll(/(?:npm (?:i|install)|npx|pnpm (?:add|dlx)|yarn add)\s+(@pcc\/[a-z0-9-]+)/g)) {
        expect(publishable.get(m[1]), `${file}: ${m[0]}`).toBe(true);
      }
    }
  });

  it("F8: every copy leads with the operator thesis, says it is a public beta, and qualifies Base", () => {
    const thesis = "Turn abilities and inventions into trusted, economically callable capacity";
    for (const [file, text] of PACK) {
      expect(text, file).toContain(thesis);
      expect(text, file).toMatch(/[Pp]ublic beta/);
      for (const line of text.split(/\\n|\n/)) {
        if (/settle[^\n]*\bon-chain \(Base\)/.test(line)) expect(line, file).toMatch(/test network|Sepolia/);
      }
    }
  });

  it("F9: the retired polish script refuses when run, and importing it never exits the importer", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = join(REPO, "scripts/polish-agent-package-claude-max.mjs");
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/retired/);
    const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(script)}); console.log("still here")`], { encoding: "utf8" });
    expect(imported.status).toBe(0);
    expect(imported.stdout).toContain("still here");
    expect(readFileSync(script, "utf8")).not.toMatch(/^ \* Idempotent\./m);
  });

  it("0.1.1: nothing says the pcc-node daemon takes, processes or polls jobs", () => {
    for (const [file, text] of [...PACK, ["CLAUDE.md", readFileSync(join(REPO, "CLAUDE.md"), "utf8")] as [string, string]]) {
      for (const line of text.split(/\\n|\n/)) {
        if (/pcc-node|daemon/.test(line)) {
          expect(line, file).not.toMatch(/daemon that processes jobs|operator polling[^.\n]*pcc-node daemon|persistent operator polling[^.\n]*pcc-node/i);
        }
      }
    }
  });
});
