/** The real builder must reject every runtime input outside the reviewed IR graph. */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const reviewed = ["dashboard-ir.ts", "dashboard-ir-binder.ts", "dashboard-ir-renderer.ts", "dashboard-ir-browser-entry.ts"];

function fixture(mutate: (mcp: string) => void, mutateBuilder?: (script: string) => string) {
  const root = mkdtempSync(join(tmpdir(), "ir-kit-build-"));
  const gateway = join(root, "packages/gateway");
  const mcp = join(gateway, "src/mcp");
  const scripts = join(gateway, "scripts");
  mkdirSync(mcp, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  symlinkSync(join(gatewayRoot, "node_modules"), join(gateway, "node_modules"), "dir");
  for (const file of reviewed) copyFileSync(join(gatewayRoot, "src/mcp", file), join(mcp, file));
  const builder = readFileSync(join(gatewayRoot, "scripts/build-dashboard-ir-kit.mjs"), "utf8");
  writeFileSync(join(scripts, "build-dashboard-ir-kit.mjs"), mutateBuilder ? mutateBuilder(builder) : builder);
  mutate(mcp);
  const run = async (check = false) => {
    try {
      const output = await exec(process.execPath, [join(scripts, "build-dashboard-ir-kit.mjs"), ...(check ? ["--check"] : [])], {
        cwd: gateway, encoding: "utf8",
      });
      return { status: 0, ...output };
    } catch (error) {
      const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
      return { status: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? failed.message };
    }
  };
  return { root, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

function rendererImport(mcp: string, importText: string) {
  const file = join(mcp, "dashboard-ir-renderer.ts");
  writeFileSync(file, importText + "\n" + readFileSync(file, "utf8"));
}

describe("IR kit build reviewed input boundary", () => {
  it("builds and byte-checks the four reviewed modules", async () => {
    const f = fixture(() => {});
    try {
      expect((await f.run()).status).toBe(0);
      expect((await f.run(true)).status).toBe(0);
    } finally { f.close(); }
  });

  it("rejects a renderer runtime import from node_modules (B-3 / P4b)", async () => {
    const f = fixture((mcp) => rendererImport(mcp, 'import { v4 as unreviewedUuid } from "uuid"; export function probeP4b() { return unreviewedUuid(); }'));
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });


  it("counts node_modules inputs added without a reviewed import edge", async () => {
    const f = fixture(() => {}, (script) => script.replace(
      "  entryPoints: [entry],",
      '  entryPoints: [entry, resolve(gatewayRoot, "node_modules/uuid/dist/esm-browser/index.js")],\n  outdir: resolve(gatewayRoot, "probe-output"),',
    ));
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });

  it("rejects a different repository path with a reviewed basename", async () => {
    const f = fixture((mcp) => {
      const shadow = join(mcp, "../unreviewed");
      mkdirSync(shadow);
      copyFileSync(join(mcp, "dashboard-ir.ts"), join(shadow, "dashboard-ir.ts"));
      for (const name of reviewed.slice(1)) {
        const file = join(mcp, name);
        writeFileSync(file, readFileSync(file, "utf8").replaceAll('"./dashboard-ir.js"', '"../unreviewed/dashboard-ir.js"'));
      }
    });
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });


  it("rejects dynamic imports that have no esbuild metadata edge", async () => {
    const f = fixture((mcp) => rendererImport(mcp, 'const unreviewedDynamicPath = "https://example.invalid/unreviewed.js"; void import(unreviewedDynamicPath);'));
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });


  it("rejects erased type imports from an unreviewed package", async () => {
    const f = fixture((mcp) => rendererImport(mcp, 'import type { v4 as UnreviewedType } from "uuid";'));
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });

  it("requires the core @pcc/spec import to be explicitly type-only", async () => {
    const f = fixture((mcp) => {
      const file = join(mcp, "dashboard-ir.ts");
      writeFileSync(file, readFileSync(file, "utf8").replace('import type { BoundSourceClass, DashboardManifest, RenderSourceClass }', 'import { BoundSourceClass, DashboardManifest, RenderSourceClass }'));
    });
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });

  it("pins each file's reviewed metafile edges independently", async () => {
    const f = fixture((mcp) => rendererImport(mcp, 'import { httpStatusText as unreviewedEdge } from "./dashboard-ir-binder.js"; export function probeEdge() { return unreviewedEdge(200); }'),
      (script) => script.replace("for (const path of expected) verifyReviewedSourceImports(path);", "// This fixture independently exercises the metafile graph pin."));
    try {
      const result = await f.run();
      expect(result.status, JSON.stringify(result)).toBe(3);
      expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
    } finally { f.close(); }
  });
});

// N9: independently pin full paths even when source-import verification is bypassed
// by this test fixture, so a basename-only input mutant cannot hide behind another check.
it("r2f N9 checks full metafile input paths independently of source imports", async () => {
  const f = fixture((mcp) => {
    const shadow = join(mcp, "../unreviewed");
    mkdirSync(shadow);
    copyFileSync(join(mcp, "dashboard-ir.ts"), join(shadow, "dashboard-ir.ts"));
    for (const name of reviewed.slice(1)) {
      const file = join(mcp, name);
      writeFileSync(file, readFileSync(file, "utf8").replaceAll('"./dashboard-ir.js"', '"../unreviewed/dashboard-ir.js"'));
    }
  }, (script) => script
    .replace("for (const path of expected) verifyReviewedSourceImports(path);", "// This fixture independently exercises full metafile input paths.")
    .replace("for (const path of expected) {", "for (const path of []) {"));
  try {
    const result = await f.run();
    expect(result.status, JSON.stringify(result)).toBe(3);
    expect(existsSync(join(f.root, "apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"))).toBe(false);
  } finally { f.close(); }
});
