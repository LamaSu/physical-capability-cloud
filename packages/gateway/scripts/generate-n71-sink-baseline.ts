/**
 * N71 round 7 sink-scanner baseline generator.
 *
 * SHRINK-ONLY: when n71-sink-baseline.json already exists, the file this script
 * writes is the INTERSECTION of the existing baseline and the violations the
 * scanner currently finds (outside N71's own 12-file scope) — a row drops out
 * once its violation is fixed, and NO row this script did not already know about
 * can ever be added. A genuinely NEW violation never becomes a passing test by
 * running this script: the only way to make n71-sink-scanner.test.ts pass again
 * after a new violation appears is to fix the underlying code. The very first
 * run, with no baseline file yet, bootstraps from the full current set (every
 * pre-existing violation elsewhere in the gateway package, as of round 7).
 *
 * Run it:
 *   pnpm --dir packages/gateway exec tsx scripts/generate-n71-sink-baseline.ts
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
  type Violation,
} from "../src/__tests__/n71-sink-scanner-engine.js";

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
    .map((v) => ({ file: v.file, sink: "<unresolved-callee>", argText: v.argText }));
  const combined = [...otherViolations, ...otherUnresolved];

  const { removed, bootstrapped } = regenerateBaseline(combined);

  console.log(`[generate-n71-sink-baseline] Program build: ${scanner.buildMs.toFixed(1)}ms; scan: ${result.scanMs.toFixed(1)}ms`);
  console.log(`[generate-n71-sink-baseline] ${bootstrapped ? "Bootstrapped" : "Regenerated"} ${BASELINE_PATH}`);
  console.log(`[generate-n71-sink-baseline] ${combined.length} current violation(s) outside N71's scope.`);
  if (!bootstrapped) {
    console.log(`[generate-n71-sink-baseline] Shrunk by ${removed} row(s) that no longer occur.`);
  }
}

main();
