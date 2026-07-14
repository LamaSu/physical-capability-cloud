import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error — JS audit tool, no d.ts
import { PUBLIC_PREFIXES, PUBLIC_EXACT } from "../../../../scripts/audit/route-policy-inventory.mjs";

/**
 * Inventory drift guard (audit P0, lane d749deff; review finding #7).
 *
 * The inventory copies api-gate's public-route definitions. If api-gate.ts adds a
 * public prefix and the copy is not updated, runtime would expose a route publicly
 * while CI still treats it as private+scoped. This asserts the snapshot EQUALS the
 * live api-gate.ts source — so any change to the public lists fails CI until the
 * snapshot is re-synced (much stronger than the old `policed_by_default === 11`).
 */
const API_GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "middleware", "api-gate.ts");

/** Extract a `const NAME = [ "..." , ... ]` string-array from source, minus comments. */
function extractArray(src: string, name: string): string[] {
  const noComments = src.replace(/\/\/[^\n]*/g, "");
  const m = noComments.match(new RegExp(`(?:export )?const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`${name} not found in api-gate.ts`);
  return [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]);
}

describe("inventory drift guard — api-gate public snapshot == source (finding #7)", () => {
  const src = readFileSync(API_GATE, "utf8");

  it("PUBLIC_PREFIXES snapshot matches api-gate.ts (a new public prefix fails CI)", () => {
    expect([...PUBLIC_PREFIXES].sort()).toEqual(extractArray(src, "PUBLIC_PREFIXES").sort());
  });

  it("PUBLIC_EXACT snapshot matches api-gate.ts", () => {
    expect([...PUBLIC_EXACT].sort()).toEqual(extractArray(src, "PUBLIC_EXACT").sort());
  });
});
