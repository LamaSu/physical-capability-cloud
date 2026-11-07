/**
 * N71 round 7 sink-scanner baseline generator.
 *
 * DEFAULT SHRINK-ONLY: when n71-sink-baseline.json already exists, the file this script
 * writes is the INTERSECTION of the existing baseline and the violations the
 * scanner currently finds (outside N71's own 12-file scope) — a row drops out
 * once its violation is fixed, and NO row this script did not already know about
 * can be added by the default mode. A genuinely NEW violation never becomes a
 * passing test by the default command: fix a real leak; only reviewed non-leaks
 * from a merge qualify for the explicit mode documented below. The very first
 * run, with no baseline file yet, bootstraps from the full current set (every
 * pre-existing violation elsewhere in the gateway package, as of round 7).
 *
 * Run it:
 *   pnpm --dir packages/gateway exec tsx scripts/generate-n71-sink-baseline.ts
 *
 * A merge may introduce reviewed false positives from upstream. The explicit
 * --reviewed-additions <json> mode accepts only exact, currently NEW rows outside
 * N71's scope, each with classification "not_a_leak" and a review reason. The
 * default remains shrink-only; scanner rules and test assertions never change.
 *
 * Then run the test suite to confirm it's in sync:
 *   pnpm --dir packages/gateway exec vitest run src/__tests__/n71-sink-scanner.test.ts
 */
import {
  getScanner,
  scanWholePackage,
  regenerateBaseline,
  N71_SCOPE_FILES,
  BASELINE_PATH,
  loadBaseline,
  validateReviewedAdditions,
  type Violation,
} from "../src/__tests__/n71-sink-scanner-engine.js";
import { readFileSync, writeFileSync } from "node:fs";

function reviewedAdditions(current: Violation[]): Violation[] {
  const args = process.argv.slice(2);
  if (args.length === 0) return [];
  if (args.length !== 2 || args[0] !== "--reviewed-additions") {
    throw new Error("Usage: generate-n71-sink-baseline.ts [--reviewed-additions <json>]");
  }
  const entries: unknown = JSON.parse(readFileSync(args[1], "utf8"));
  return validateReviewedAdditions(entries, current, loadBaseline());
}

function main(): void {
  const scanner = getScanner();
  const result = scanWholePackage(scanner);

  const n71Violations = result.violations.filter((v) => N71_SCOPE_FILES.includes(v.file));
  const n71Unresolved = result.unresolvedCallees.filter((v) => N71_SCOPE_FILES.includes(v.file));
  if (n71Violations.length > 0 || n71Unresolved.length > 0) {
    console.error(
      `REFUSING to generate: N71's own scope has ${n71Violations.length} violation(s) and ` +
        `${n71Unresolved.length} unresolved callee(s). N71 files must be at ZERO before the ` +
        `baseline (for everything ELSE) can be regenerated. Fix the code, not the baseline.`,
    );
    for (const v of [...n71Violations, ...n71Unresolved]) console.error(`  ${v.file} [${v.sink}] ${v.argText}`);
    process.exitCode = 1;
    return;
  }

  const otherViolations: Violation[] = result.violations.filter((v) => !N71_SCOPE_FILES.includes(v.file));
  const otherUnresolved: Violation[] = result.unresolvedCallees
    .filter((v) => !N71_SCOPE_FILES.includes(v.file))
    .map((v) => ({ ...v, sink: "<unresolved-callee>" }));
  const combined = [...otherViolations, ...otherUnresolved];

  // Validate the review before making any baseline changes.
  const additions = reviewedAdditions(combined);
  const { baseline, removed, bootstrapped } = regenerateBaseline(combined);
  for (const row of additions) {
    const sinks = baseline[row.file] ??= {};
    const args = sinks[row.sink] ??= [];
    args.push({ argText: row.argText, fingerprint: row.fingerprint });
    args.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.argText.localeCompare(b.argText));
  }
  if (additions.length > 0) {
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf8");
    console.log(`[generate-n71-sink-baseline] Added ${additions.length} explicitly reviewed non-leak row(s).`);
  }

  console.log(`[generate-n71-sink-baseline] Program build: ${scanner.buildMs.toFixed(1)}ms; scan: ${result.scanMs.toFixed(1)}ms`);
  console.log(`[generate-n71-sink-baseline] ${bootstrapped ? "Bootstrapped" : "Regenerated"} ${BASELINE_PATH}`);
  console.log(`[generate-n71-sink-baseline] ${combined.length} current violation(s) outside N71's scope.`);
  if (!bootstrapped) {
    console.log(`[generate-n71-sink-baseline] Shrunk by ${removed} row(s) that no longer occur.`);
  }
}

main();
