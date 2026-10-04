/**
 * Deterministic build of the Phase-B browser kit from the AUDITED TypeScript modules.
 *
 *   node scripts/build-dashboard-ir-kit.mjs            # build:ir-kit  → write the bundle
 *   node scripts/build-dashboard-ir-kit.mjs --check    # check:ir-kit  → byte-compare committed vs fresh
 *
 * The committed apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js is the reviewed = shipped
 * artifact. CI + the Docker build run --check and fail on any drift, giving:
 *   audited TS → deterministic build → committed artifact → byte-equivalence gate → shipped bytes.
 * The bundle is unminified so the diff (and any audit) reads cleanly.
 */
import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayRoot = resolve(here, "..");
const entry = resolve(gatewayRoot, "src/mcp/dashboard-ir-browser-entry.ts");
const outfile = resolve(gatewayRoot, "../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js");
const BANNER = "/* GENERATED from packages/gateway/src/mcp/dashboard-ir-browser-entry.ts by\n   scripts/build-dashboard-ir-kit.mjs — DO NOT EDIT. Regenerate with `pnpm build:ir-kit`. */";

// The generated bundle must NEVER contain a host-call / bridge / write surface.
// Behavioral tests are authoritative; this static scan is defense-in-depth.
const FORBIDDEN = ["__PCC_HOST_BRIDGE__", "__PCC_HOST_OPERATIONS__", "tools/call", "registerComponent"];

const BUILD = {
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2022"],
  minify: false,
  sourcemap: false,
  legalComments: "none",
  banner: { js: BANNER },
  metafile: true,
  write: false,
  absWorkingDir: gatewayRoot, // pin cwd so relative-path rendering/resolution is deterministic
};

const check = process.argv.includes("--check");
const result = await esbuild.build(BUILD);
const out = result.outputFiles[0];
const bytes = Buffer.from(out.contents); // RAW bytes — the shipped artifact, not a decoded string
const text = out.text;

for (const id of FORBIDDEN) {
  if (text.includes(id)) { console.error(`FAIL: forbidden identifier "${id}" present in the generated bundle.`); process.exit(2); }
}
// Enforce the exact input allowlist from the metafile: only the entry + the 3 audited modules.
const inputs = Object.keys(result.metafile.inputs).filter((p) => !p.includes("node_modules")).sort();
const expected = ["dashboard-ir-binder.ts", "dashboard-ir-browser-entry.ts", "dashboard-ir-renderer.ts", "dashboard-ir.ts"];
const got = inputs.map((p) => p.split(/[\\/]/).pop());
if (JSON.stringify(got) !== JSON.stringify(expected)) { console.error(`FAIL: unexpected bundle inputs — expected ${expected.join(",")}, got ${got.join(",")}`); process.exit(3); }

if (check) {
  let committed;
  try { committed = readFileSync(outfile); }
  catch { console.error(`FAIL check:ir-kit — committed bundle missing at ${outfile}. Run \`pnpm build:ir-kit\` and commit it.`); process.exit(1); }
  if (!committed.equals(bytes)) { console.error("FAIL check:ir-kit — committed pcc-ir-kit.js differs (byte-compare) from a fresh build of the audited TS. Run `pnpm build:ir-kit` and commit the result."); process.exit(1); }
  console.log(`OK check:ir-kit — committed bundle is byte-identical to a fresh build (${bytes.length} bytes).`);
} else {
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, bytes);
  console.log(`OK build:ir-kit — wrote ${outfile} (${bytes.length} bytes). Forbidden scan + 4-file input allowlist clean.`);
}
