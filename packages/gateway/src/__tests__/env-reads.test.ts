import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, lstatSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { scanEnvReadText, COMPUTED_READS, ENV_READS_FILE, readEnvReads } from "../services/env-reads.js";
import { classifyEnv } from "../services/posture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
function walk(path: string): string[] {
  if (lstatSync(path).isSymbolicLink()) return [];
  if (lstatSync(path).isDirectory()) return readdirSync(path).filter((name) => !["node_modules", "__tests__"].includes(name)).flatMap((name) => walk(join(path, name)));
  return /\.ts$/.test(path) && !/\.(test|spec)\./.test(path) ? [path] : [];
}
const sourceFiles = () => readdirSync(join(root, "packages"), { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => {
  try { return walk(join(root, "packages", e.name, "src")); } catch { return []; }
});
describe("env-read scanner", () => {
  it.each([
    ["process dot", "process.env.SYN_A", ["SYN_A"]],
    ["double bracket", 'process.env["SYN_A"]', ["SYN_A"]],
    ["single bracket", "process.env['SYN_A']", ["SYN_A"]],
    ["backtick bracket", "process.env[`SYN_A`]", ["SYN_A"]],
    ["injected dot", "env.SYN_A", ["SYN_A"]],
    ["member env", "opts.env.SYN_A", ["SYN_A"]],
    ["injected double bracket", 'env["SYN_A"]', ["SYN_A"]],
    ["injected single bracket", "opts.env['SYN_A']", ["SYN_A"]],
    ["injected backtick", "env[`SYN_A`]", ["SYN_A"]],
    ["process destructure", "const { SYN_A, SYN_B: b, SYN_C = 1 } = process.env", ["SYN_A", "SYN_B", "SYN_C"]],
    ["env destructure", "const { SYN_A, SYN_B: b, SYN_C = 1 } = env", ["SYN_A", "SYN_B", "SYN_C"]],
    ["comments count", "// env.SYN_COMMENT\n/* process.env.SYN_BLOCK */", ["SYN_COMMENT", "SYN_BLOCK"]],
    ["env method", "env.get('SYN_A')", []],
    ["longer identifier", "myenv.X; myprocess.envlower.SYN_A; $env.SYN_B", []],
    ["computed template", "process.env[`SYN_${key}`]; env[`SYN_${key}`]", []],
    ["lowercase injected", "env.lower; env.Mixed; env['lower']", []],
  ])("S1 %s", (_label, text, names) => expect([...scanEnvReadText(text as string)].sort()).toEqual([...(names as string[])].sort()));

  it("S2 real-tree: process, env and bracket reads across packages", () => {
    const names = new Set(sourceFiles().flatMap((file) => [...scanEnvReadText(readFileSync(file, "utf8"))]));
    for (const name of ["PCC_ADMIN_KEY", "PCC_RELAY_GATE", "ZERODEV_PROJECT_ID", "STORAGE_MAX_UPLOAD_MB"]) expect(names.has(name), name).toBe(true);
    // Pin env.NAME independently: another process.env reference must not mask its loss.
    expect(scanEnvReadText(readFileSync(join(root, "packages/gateway/src/middleware/relay-admin-gate.ts"), "utf8")).has("PCC_RELAY_GATE")).toBe(true);
  });
  it("S3 drift: every computed gateway read is pinned by file and expression and covered", () => {
    const expected: Record<string, { names: string[]; prefixes: string[] }> = {
      "mcp/mcp-api-base.ts:process.env[MCP_API_BASE_ENV]": { names: ["PCC_API_BASE_URL"], prefixes: [] },
      "mcp/mcp-app-view.ts:process.env[MCP_APP_DOMAIN_ENV]": { names: ["PCC_MCP_APP_DOMAIN"], prefixes: [] },
      "mcp/mcp-app-view.ts:process.env[envVarOverride]": { names: ["PCC_UI_KIT_PATH", "PCC_IR_KIT_PATH", "PCC_DASHBOARD_SCHEMA_PATH", "PCC_DOC_AGENT_GUIDE_PATH", "PCC_DOC_QUICKSTART_PATH"], prefixes: [] },
      "routes/operator-channels.ts:process.env[CHANNEL_CREDENTIALS_ENV]": { names: ["PCC_CHANNEL_CREDENTIALS"], prefixes: [] },
      "routes/operator-channels.ts:process.env[`PCC_VAULT_${vaultKeyFor(ref)}`]": { names: [], prefixes: ["PCC_VAULT_"] },
      "routes/setup.ts:process.env[v.name]": { names: ["PCC_NETWORK", "PCC_GATEWAY_PRIVATE_KEY", "ESCROW_CONTRACT_ADDRESS", "ENTRY_POINT_ADDRESS", "KERNEL_FACTORY_ADDRESS", "PAYMASTER_ADDRESS", "PORT", "NODE_ENV", "PCC_DB_PATH", "KERNEL_CONFIG", "KERNEL_CONFIG_FILE", "KERNEL_ID", "EVIDENCE_STORAGE", "STORACHA_PROOF", "STORACHA_SPACE_DID", "LIT_PROTOCOL_REAL", "STARKNET_ACCOUNT_ADDRESS", "STARKNET_PRIVATE_KEY", "STARKNET_NETWORK", "X402_ENABLED", "X402_FACILITATOR_URL", "SERVE_DASHBOARD"], prefixes: [] },
      "services/wallet-faucet/client.ts:env[name]": { names: ["CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"], prefixes: [] },
      "services/wallet-faucet/client.ts:process.env[name]": { names: ["CDP_API_KEY_ID", "CDP_API_KEY_NAME", "CDP_API_KEY_SECRET", "CDP_WALLET_SECRET"], prefixes: [] },
    };
    const gatewaySrc = join(root, "packages/gateway/src");
    const found: string[] = [];
    for (const file of walk(gatewaySrc)) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if (ts.isElementAccessExpression(node)) {
          const target = node.expression;
          const isEnv = ts.isIdentifier(target) && target.text === "env" || ts.isPropertyAccessExpression(target) && target.name.text === "env";
          if (isEnv && !ts.isStringLiteral(node.argumentExpression) && !ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) found.push(`${relative(gatewaySrc, file)}:${node.getText(source)}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(found.sort()).toEqual(Object.keys(expected).sort());
    for (const coverage of Object.values(expected)) {
      for (const name of coverage.names) expect(COMPUTED_READS.names.includes(name), name).toBe(true);
      for (const prefix of coverage.prefixes) expect(COMPUTED_READS.prefixes.includes(prefix), prefix).toBe(true);
    }
  });
  it("S4 Dockerfile: each ENV name is public, platform or read in source", () => {
    const names = new Set(sourceFiles().flatMap((file) => [...scanEnvReadText(readFileSync(file, "utf8"))]));
    const docker = readFileSync(join(root, "Dockerfile"), "utf8").replace(/\\\r?\n/g, " ");
    for (const line of docker.split("\n").filter((l) => /^ENV\s/.test(l))) {
      const body = line.replace(/^ENV\s+/, "");
      const setNames = body.includes("=") ? [...body.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map((m) => m[1]) : [body.split(/\s/)[0]];
      for (const name of setNames) expect(["public", "platform"].includes(classifyEnv(name, { [name]: "synthetic" }, null).class) || names.has(name), name).toBe(true);
    }
  });
});

describe("env-read loader", () => {
  it("L1: fixed path; a good file returns sets", () => {
    expect(ENV_READS_FILE).toBe("/app/ENV_READS.json");
    let requested = "";
    expect(readEnvReads((path) => { requested = path; return JSON.stringify({ spec: "pcc.env-reads/v1", names: ["SYN_A", "SYN_B"], prefixes: ["SYN_"] }); })).toEqual({ names: new Set(["SYN_A", "SYN_B"]), prefixes: ["SYN_"] });
    expect(requested).toBe(ENV_READS_FILE);
  });
  it.each([null, "{", "null", "[]", '{}', '{"spec":"wrong","names":[],"prefixes":[]}', '{"spec":"pcc.env-reads/v1","names":[],"prefixes":[],"extra":1}', '{"spec":"pcc.env-reads/v1","names":[1],"prefixes":[]}', '{"spec":"pcc.env-reads/v1","names":[],"prefixes":[null]}', '{"spec":"pcc.env-reads/v1","names":["bad-name"],"prefixes":[]}'])("L2: missing/malformed/wrong shape %s", (raw) => expect(readEnvReads(() => raw)).toBeNull());
  it("L3: reader throw is swallowed without text", () => expect(readEnvReads(() => { throw new Error("synthetic-secret"); })).toBeNull());
});

// Written, not test-run: this sandbox also rejects spawnSync(node) with EPERM
// (empty pipes), in addition to the git/sh restriction in the brief. Build the
// CLI first and enable these cells in the lane's unrestricted tree.
describe.skip("CLI subprocess (written, not test-run in sandbox)", () => {
  it("CLI1: shape/sorting, multiple roots, exclusions and no symlink following", () => {
    const dir = mkdtempSync(join(tmpdir(), "n237-env-reads-"));
    try {
      for (const part of ["one/node_modules", "one/__tests__", "two", "outside"]) mkdirSync(join(dir, part), { recursive: true });
      writeFileSync(join(dir, "one/a.js"), "process.env.SYN_Z; env.SYN_A");
      writeFileSync(join(dir, "two/b.mjs"), "process.env.SYN_B");
      writeFileSync(join(dir, "two/c.cjs"), "env.SYN_C");
      for (const path of ["one/a.test.js", "one/a.spec.mjs", "one/a.js.map", "one/a.ts", "one/node_modules/a.js", "one/__tests__/a.js", "outside/a.js"]) writeFileSync(join(dir, path), "process.env.SYN_SKIPPED");
      symlinkSync(join(dir, "outside"), join(dir, "one/link"), "dir");
      const result = spawnSync(process.execPath, [join(root, "packages/gateway/dist/env-reads-cli.js"), join(dir, "one"), join(dir, "two")], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ spec: "pcc.env-reads/v1", names: [...new Set(["SYN_A", "SYN_B", "SYN_C", "SYN_Z", ...COMPUTED_READS.names])].sort(), prefixes: [...new Set(COMPUTED_READS.prefixes)].sort() });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("CLI2: empty tree exits 1 with one safe line", () => {
    const dir = mkdtempSync(join(tmpdir(), "n237-empty-"));
    try {
      const result = spawnSync(process.execPath, [join(root, "packages/gateway/dist/env-reads-cli.js"), dir], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/^[^\n]+\n$/);
      expect(result.stderr).not.toContain(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
