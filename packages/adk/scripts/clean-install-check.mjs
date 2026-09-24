#!/usr/bin/env node
/**
 * Clean external install check for @pcc/adk (ledger R4, D1).
 *
 * Proves the public packages install and import in a project OUTSIDE this
 * workspace, the way an operator's project would, with no npm publish:
 *   1. build @pcc/spec, @pcc/kernel-sdk and @pcc/adk;
 *   2. `pnpm pack` each (pack rewrites workspace:* to real versions);
 *   3. boundary gate on every tarball: no "workspace:" anywhere, no @pcc/*
 *      dependency outside the packed set or private in the workspace, no chain
 *      client, and no key or env file in the payload;
 *   4. create a temp project outside the workspace that depends on the adk
 *      tarball, with pnpm.overrides pointing @pcc/spec and @pcc/kernel-sdk at
 *      their tarballs, and install it OFFLINE from the local pnpm store (no
 *      network; the third-party dependencies are the ones the workspace
 *      already resolved);
 *   5. import it from plain Node ESM, and type-check a TypeScript consumer
 *      against the installed declarations.
 *
 *   node scripts/clean-install-check.mjs [--keep]
 *
 * Environment: PNPM_STORE_DIR (default: pnpm's own), TMPDIR for the temp
 * project. Exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const keep = process.argv.includes("--keep");
const storeArgs = process.env.PNPM_STORE_DIR ? ["--store-dir", process.env.PNPM_STORE_DIR] : [];

const PACKED = [
  { name: "@pcc/spec", dir: "packages/spec" },
  { name: "@pcc/kernel-sdk", dir: "packages/kernel-sdk" },
  { name: "@pcc/adk", dir: "packages/adk" },
];
/** Chain clients must never ride along in the public kit. */
const CHAIN_CLIENTS = ["viem", "ethers", "wagmi", "web3", "@wagmi/core", "@coinbase/wallet-sdk", "@coinbase/cdp-sdk"];
/** Files that must never be in a public tarball. */
const FORBIDDEN_FILE = /(^|\/)(\.env(\..*)?|pcc-keys\.json|[^/]*\.pem|id_(rsa|ed25519)[^/]*)$/;

const failures = [];
const fail = (msg) => failures.push(msg);

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

function workspacePrivateNames() {
  const names = new Set();
  for (const root of ["packages", "apps"]) {
    for (const entry of readdirSync(join(repo, root), { withFileTypes: true })) {
      const pj = join(repo, root, entry.name, "package.json");
      if (!entry.isDirectory() || !existsSync(pj)) continue;
      const p = JSON.parse(readFileSync(pj, "utf8"));
      if (p.private === true && p.name) names.add(p.name);
    }
  }
  return names;
}

function main() {
  const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "adk-clean-install-"));
  const rel = relative(repo, work);
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    throw new Error(`temp project ${work} is inside the workspace ${repo}; set TMPDIR elsewhere`);
  }
  const tarballs = join(work, "tarballs");
  const project = join(work, "consumer");
  console.log(`work dir: ${work}`);

  try {
    // 1. Build.
    run("pnpm", ["--filter", "@pcc/spec", "--filter", "@pcc/kernel-sdk", "--filter", "@pcc/adk", "--workspace-concurrency=1", "build"], repo);

    // 2. Pack.
    const packed = {};
    for (const p of PACKED) {
      const out = run("pnpm", ["pack", "--pack-destination", tarballs], join(repo, p.dir)).trim().split("\n");
      const file = out.reverse().find((l) => l.trim().endsWith(".tgz"));
      if (!file) throw new Error(`pnpm pack printed no tarball for ${p.name}`);
      packed[p.name] = isAbsolute(file.trim()) ? file.trim() : join(tarballs, file.trim());
    }

    // 3. Boundary gate.
    const privateNames = workspacePrivateNames();
    for (const [name, tgz] of Object.entries(packed)) {
      const files = run("tar", ["-tzf", tgz], work).split("\n").filter(Boolean);
      for (const f of files) if (FORBIDDEN_FILE.test(f)) fail(`${name}: forbidden file in tarball: ${f}`);
      const pj = JSON.parse(run("tar", ["-xzOf", tgz, "package/package.json"], work));
      const raw = JSON.stringify(pj);
      if (raw.includes("workspace:")) fail(`${name}: packed package.json still contains "workspace:"`);
      const deps = { ...(pj.dependencies || {}), ...(pj.peerDependencies || {}), ...(pj.optionalDependencies || {}) };
      for (const dep of Object.keys(deps)) {
        if (dep.startsWith("@pcc/") && !(dep in packed)) fail(`${name}: depends on ${dep}, which is not part of the public kit`);
        if (dep.startsWith("@pcc/") && privateNames.has(dep) && dep !== "@pcc/adk") fail(`${name}: depends on private ${dep}`);
        if (CHAIN_CLIENTS.includes(dep)) fail(`${name}: depends on chain client ${dep}`);
      }
    }
    if (failures.length > 0) return;

    // 4. A consumer project outside the workspace, installed offline.
    run("mkdir", ["-p", project], work);
    const consumer = {
      name: "adk-clean-install-consumer",
      private: true,
      type: "module",
      dependencies: { "@pcc/adk": `file:${packed["@pcc/adk"]}` },
      pnpm: {
        overrides: {
          "@pcc/spec": `file:${packed["@pcc/spec"]}`,
          "@pcc/kernel-sdk": `file:${packed["@pcc/kernel-sdk"]}`,
        },
      },
    };
    writeFileSync(join(project, "package.json"), JSON.stringify(consumer, null, 2));
    run("pnpm", ["install", "--offline", "--ignore-workspace", ...storeArgs], project);
    for (const name of Object.keys(packed)) {
      const installed = join(project, "node_modules", ...name.split("/"), "package.json");
      if (!existsSync(installed)) {
        // Transitive @pcc packages live under .pnpm; find them through adk's own node_modules.
        continue;
      }
      if (readFileSync(installed, "utf8").includes("workspace:")) fail(`installed ${name} still says "workspace:"`);
    }
    if (readFileSync(join(project, "package.json"), "utf8").includes("workspace:")) fail("consumer package.json contains workspace:");

    // 5a. Import from plain Node ESM.
    writeFileSync(
      join(project, "check.mjs"),
      [
        'import * as adk from "@pcc/adk";',
        'const need = ["resolveToolRequest", "checkAgentPackage", "buildManifest", "registerKernel", "verifyBundleSignature"];',
        'for (const n of need) if (typeof adk[n] !== "function") throw new Error(`@pcc/adk does not export ${n}`);',
        'if (adk.AGENT_PACKAGE_PIN.toolCount !== Object.keys(adk.AGENT_TOOLS).length) throw new Error("pin/tool count mismatch");',
        'const r = adk.resolveToolRequest("setup_validate", { config: {} }, { baseUrl: "https://capability.network" });',
        'if (r.method !== "POST" || r.url !== "https://capability.network/api/setup/validate") throw new Error("bad request " + JSON.stringify(r));',
        'console.log(`ok: @pcc/adk imports; agent package ${adk.AGENT_PACKAGE_PIN.version} (${adk.AGENT_PACKAGE_PIN.toolCount} tools)`);',
      ].join("\n"),
    );
    console.log(run("node", ["check.mjs"], project).trim());

    // 5b. Type-check a TypeScript consumer against the installed declarations.
    writeFileSync(
      join(project, "check.ts"),
      [
        'import { resolveToolRequest, AGENT_PACKAGE_PIN, type ToolRequest, type AgentToolName } from "@pcc/adk";',
        'const name: AgentToolName = "setup_validate";',
        'const req: ToolRequest = resolveToolRequest(name, { config: {} }, { baseUrl: "https://capability.network" });',
        'const v: string = AGENT_PACKAGE_PIN.version;',
        "export { req, v };",
      ].join("\n"),
    );
    const tsc = join(repo, "node_modules", ".bin", "tsc");
    run(tsc, ["--noEmit", "--strict", "--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "false", "check.ts"], project);
    console.log("ok: a TypeScript consumer type-checks against the installed declarations");
  } catch (e) {
    fail(e && e.stderr ? `${e.message}\n${String(e.stderr).slice(0, 4000)}` : String(e));
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
    else console.log(`kept: ${work}`);
  }
}

main();
if (failures.length > 0) {
  console.error("clean-install check FAILED:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("clean-install check passed");
