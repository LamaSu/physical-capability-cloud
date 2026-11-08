/**
 * Regenerates the committed device-intake JSON Schema and the printable HTML
 * intake form from INTAKE_FIELDS — the single source of truth in
 * ../src/onboarding/intake/fields.ts.
 *
 * Run with: npx tsx packages/spec/scripts/build-onboarding-docs.mts
 *
 * Writes:
 *   - packages/spec/src/onboarding/intake/device-intake.schema.json
 *   - docs/onboarding/intake/form.html
 *
 * `onboarding-intake.test.ts` regenerates both IN-MEMORY (calling the same
 * `buildIntakeJsonSchema()` / `buildFormHtml()` this script calls) and
 * compares them against these committed files byte-for-byte — after editing
 * fields.ts / json-schema.ts / form-html.ts, re-run this script and commit
 * the diff, or that test fails on purpose.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildFormHtml, buildIntakeJsonSchema, INTAKE_FIELDS } from "../src/onboarding/intake/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SPEC_ROOT = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(SPEC_ROOT, "..", "..");

export const SCHEMA_OUT_PATH = join(SPEC_ROOT, "src/onboarding/intake/device-intake.schema.json");
export const FORM_OUT_PATH = join(REPO_ROOT, "docs/onboarding/intake/form.html");

async function main(): Promise<void> {
  const schema = buildIntakeJsonSchema();
  await mkdir(dirname(SCHEMA_OUT_PATH), { recursive: true });
  await writeFile(SCHEMA_OUT_PATH, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

  const html = buildFormHtml(INTAKE_FIELDS);
  await mkdir(dirname(FORM_OUT_PATH), { recursive: true });
  await writeFile(FORM_OUT_PATH, html, "utf8");

  console.log(`wrote ${SCHEMA_OUT_PATH}`);
  console.log(`wrote ${FORM_OUT_PATH}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
