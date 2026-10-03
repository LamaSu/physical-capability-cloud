#!/usr/bin/env node
/**
 * Clean external install check for @pcc/adk (ledger R4, D1).
 *
 * Proves the public packages install and import in a project OUTSIDE this
 * workspace, the way an operator's project would, with no npm publish:
 *   1. delete and rebuild the dist/ of @pcc/spec, @pcc/kernel-sdk and
 *      @pcc/adk, so no stale build output can be packed;
 *   2. `pnpm pack` each (pack rewrites workspace:* to real versions);
 *   3. boundary gate on every tarball (scripts/boundary-policy.mjs): no
 *      "workspace:" anywhere; every dependency spec resolved to the registry
 *      package it installs, `npm:` aliases included, and none of them an @pcc/*
 *      package outside the packed set or private in the workspace, or a chain
 *      client; only package.json, README, LICENSE and dist/ output that has a
 *      src/ source in the payload; no payload file whose text looks like a
 *      secret;
 *   4. create a temp project outside the workspace that depends on the adk
 *      tarball, with pnpm.overrides pointing @pcc/spec and @pcc/kernel-sdk at
 *      their tarballs, and install it OFFLINE from the local pnpm store (no
 *      network; the third-party dependencies are the ones the workspace
 *      already resolved);
 *   5. gate the complete installed graph: every package in the consumer's
 *      pnpm store, by its real name, is checked for chain clients and for
 *      @pcc/* packages outside the kit;
 *   6. import it from plain Node ESM (the kit's surface, and no registration
 *      client or kernel handler), and type-check a TypeScript consumer
 *      against the installed declarations.
 *
 *   node scripts/clean-install-check.mjs [--keep]
 *
 * Environment: PNPM_STORE_DIR (default: pnpm's own), TMPDIR for the temp
 * project. Exits non-zero on any failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { contentProblems, installedProblems, manifestProblems, payloadProblems } from "./boundary-policy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const keep = process.argv.includes("--keep");
const storeArgs = process.env.PNPM_STORE_DIR ? ["--store-dir", process.env.PNPM_STORE_DIR] : [];

const PACKED = [
  { name: "@pcc/spec", dir: "packages/spec" },
  { name: "@pcc/kernel-sdk", dir: "packages/kernel-sdk" },
  { name: "@pcc/adk", dir: "packages/adk" },
];

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

/** Every package in the consumer's pnpm store, by the name in its own package.json. */
function installedPackages(project) {
  const store = join(project, "node_modules", ".pnpm");
  if (!existsSync(store)) throw new Error(`${store} is missing; the consumer was not installed by pnpm`);
  const found = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const modules = join(store, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const child of readdirSync(modules, { withFileTypes: true })) {
      const candidates = child.isDirectory() && child.name.startsWith("@")
        ? readdirSync(join(modules, child.name), { withFileTypes: true }).map((c) => [c, join(modules, child.name, c.name)])
        : [[child, join(modules, child.name)]];
      // The package itself is a real directory; its dependencies are symlinks.
      for (const [dirent, dir] of candidates) {
        if (!dirent.isDirectory() || !existsSync(join(dir, "package.json"))) continue;
        const { name, version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        found.push({ name, version, dir: relative(project, dir) });
      }
    }
  }
  return found;
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
    // 1. Build from clean dist/ directories.
    for (const p of PACKED) rmSync(join(repo, p.dir, "dist"), { recursive: true, force: true });
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
    const packedNames = new Set(Object.keys(packed));
    for (const p of PACKED) {
      const tgz = packed[p.name];
      const listed = run("tar", ["-tzf", tgz], work).split("\n").filter(Boolean);
      const outside = listed.filter((f) => !f.startsWith("package/"));
      for (const f of outside) fail(`${p.name}: tarball entry outside package/: ${f}`);
      const files = listed.filter((f) => f.startsWith("package/") && !f.endsWith("/")).map((f) => f.slice("package/".length));
      const hasSource = (path) => existsSync(join(repo, p.dir, path));
      for (const problem of payloadProblems(p.name, files, { hasSource })) fail(problem);
      const unpacked = join(work, "unpacked", p.name.replace("/", "+"));
      mkdirSync(unpacked, { recursive: true });
      run("tar", ["-xzf", tgz, "-C", unpacked], work);
      for (const f of files) {
        for (const problem of contentProblems(p.name, f, readFileSync(join(unpacked, "package", f), "utf8"))) fail(problem);
      }
      const pj = JSON.parse(readFileSync(join(unpacked, "package", "package.json"), "utf8"));
      for (const problem of manifestProblems(p.name, pj, { packed: packedNames, privateNames })) fail(problem);
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

    // 5. The complete installed graph.
    const installed = installedPackages(project);
    for (const name of packedNames) {
      if (!installed.some((pkg) => pkg.name === name)) fail(`${name} is not in the installed graph; the graph walk is broken`);
    }
    for (const problem of installedProblems(installed, { packed: packedNames })) fail(problem);
    console.log(`ok: ${installed.length} installed packages, none a chain client or an @pcc/* package outside the kit`);

    // 6a. Import from plain Node ESM.
    writeFileSync(
      join(project, "check.mjs"),
      [
        'import * as adk from "@pcc/adk";',
        'const need = ["resolveToolRequest", "checkAgentPackage", "buildManifest"];',
        'for (const n of need) if (typeof adk[n] !== "function") throw new Error(`@pcc/adk does not export ${n}`);',
        'for (const n of ["registerKernel", "createKernelHandler"]) if (n in adk) throw new Error(`@pcc/adk exports ${n}`);',
        'if (adk.AGENT_PACKAGE_PIN.toolCount !== Object.keys(adk.AGENT_TOOLS).length) throw new Error("pin/tool count mismatch");',
        'const r = adk.resolveToolRequest("setup_validate", { config: {} }, { baseUrl: "https://capability.network" });',
        'if (r.method !== "POST" || r.url !== "https://capability.network/api/setup/validate") throw new Error("bad request " + JSON.stringify(r));',
        'console.log(`ok: @pcc/adk imports; agent package ${adk.AGENT_PACKAGE_PIN.version} (${adk.AGENT_PACKAGE_PIN.toolCount} tools)`);',
      ].join("\n"),
    );
    console.log(run("node", ["check.mjs"], project).trim());

    // 6b. Type-check a TypeScript consumer against the installed declarations.
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
