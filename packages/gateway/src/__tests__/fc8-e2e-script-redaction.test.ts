/**
 * FC-8 round 2 (astra pack 61b, CRITICAL — DO-NOT-SHIP verdict at 4de265ce,
 * reproduced unchanged at 85c9d5bf): pack 61's redaction fix (commit 185016cb)
 * routed the e2e/smoke scripts' HTTP Body/Response logging through
 * safeLogJson, but missed several OTHER print sites in the same four scripts
 * that still interpolate a raw gateway/oracle value or a raw caught
 * exception:
 *
 *   - real-e2e-verbose.ts:383  the oracle's raw response TEXT (never parsed,
 *     never redacted) — the headline finding; astra's own repro: stub
 *     /verify to return {"headers":{"x-oracle-key":"synthetic-oracle-canary"}}.
 *   - real-e2e-verbose.ts:472  litProvision.error (raw server error text)
 *   - real-e2e-verbose.ts:619  e.shortMessage || e.message (raw exception)
 *   - real-e2e.ts:401          printResult.jobId ?? printResult.error (raw)
 *   - real-e2e.ts:406          e.message ?? e (raw exception)
 *   - hp-full-chain-e2e.ts:351 the WHOLE caught error object via console.error
 *   - smoke-digital-verifier.sh: no `set +x` anywhere, so an inherited
 *     `bash -x` / exported SHELLOPTS=xtrace prints PCC_ORACLE_KEY the moment
 *     it is read (line 23) and again at every later expansion.
 *   - smoke-digital-verifier.sh:295  the oracle's raw `reason` free-text field
 *   - smoke-digital-verifier.sh:376  the entire raw /api/auth/validate body
 *
 * These four scripts call live chain/gateway/oracle services from a
 * top-level `main()` (the three .ts files) or entirely over the network
 * (the .sh), and the TS scripts call `process.exit(1)` at module scope when
 * required env vars are unset — so none of the four can be safely
 * `import`-ed or executed in-process inside a test (the pack 61b brief
 * itself: "these scripts call live services, so they were NOT executed").
 * Per the operator's fallback for exactly this situation, this file pins
 * each call site's SOURCE TEXT instead (the same technique already used by
 * no-committed-keys.test.ts to guard these same four scripts against a
 * regressed key literal): it fails the moment any of the nine sites above
 * regresses to its old, raw form, and it fails right now at 85c9d5bf because
 * none of the fixes exist yet.
 *
 * Companion behavioral tests for the new helpers themselves live in
 * fc8-redact-log-helpers.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function readScript(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("FC-8 round 2 (astra pack 61b) — real-e2e-verbose.ts call sites", () => {
  const src = () => readScript("scripts/real-e2e-verbose.ts");

  it("no longer prints the raw oracle response text (was :383)", () => {
    expect(src()).not.toMatch(/oracleText\.slice\(/);
    // Round 3 (astra pack 61b census closure) superseded whole-body
    // redaction with field-level validation: only a validated boolean
    // summary of the parsed oracle response, never the body/object itself.
    expect(src()).toMatch(/safeLogBool\(oracleParsed\?\.verified\)/);
  });

  it("no longer prints litProvision.error (was :472)", () => {
    expect(src()).not.toMatch(/litProvision\.error/);
  });

  it("top-level catch prints only a bounded error name, not .message (was :619)", () => {
    expect(src()).not.toMatch(/e\.shortMessage \|\| e\.message/);
    expect(src()).toMatch(/safeLogErrorName\(e\)/);
  });

  it("imports the new helpers it now calls", () => {
    // FC-8 round 4: real-e2e-verbose.ts no longer imports safeLogResponseText
    // (the oracle body is now a validated boolean summary, not a
    // parse-then-redact of the whole response — see the :383 guard above);
    // safeLogId is the import that has stayed across every round.
    expect(src()).toMatch(
      /import \{[^}]*safeLogId[^}]*\} from "\.\.\/packages\/gateway\/src\/util\/redact-log\.js"/,
    );
  });
});

describe("FC-8 round 2 (astra pack 61b) — real-e2e.ts call sites", () => {
  const src = () => readScript("scripts/real-e2e.ts");

  it("no longer prints printResult.error (was :401)", () => {
    expect(src()).not.toMatch(/printResult\??\.jobId \?\? printResult\??\.error/);
    // Round 3 added optional chaining (printResult?.jobId) alongside the
    // dependency-injection refactor; the validated-id call stays the same.
    expect(src()).toMatch(/safeLogId\(printResult\??\.jobId\)/);
  });

  it("top-level catch prints only a bounded error name, not .message (was :406)", () => {
    expect(src()).not.toMatch(/console\.error\("FATAL:", e\.message \?\? e\)/);
    expect(src()).toMatch(/safeLogErrorName\(e\)/);
  });
});

describe("FC-8 round 2 (astra pack 61b) — hp-full-chain-e2e.ts call sites", () => {
  const src = () => readScript("scripts/hp-full-chain-e2e.ts");

  it("top-level catch prints only a bounded error name, not the whole error object (was :351)", () => {
    expect(src()).not.toMatch(/console\.error\("FAIL:", e\)/);
    expect(src()).toMatch(/safeLogErrorName\(e\)/);
  });
});

describe("FC-8 round 2 (astra pack 61b) — smoke-digital-verifier.sh", () => {
  const src = () => readScript("scripts/smoke-digital-verifier.sh");

  it("disables inherited xtrace before the oracle credential is ever read", () => {
    // FC-8 round 4 (finding 4): the script no longer reads PCC_ORACLE_KEY
    // (a secret value) from the environment at all — only
    // PCC_ORACLE_KEY_FILE (a path) — and `set +x` moved to the absolute
    // first statement, before even `set -euo pipefail`. See this test's
    // sibling coverage in fc8-round4-smoke-digital-verifier-launcher.test.ts
    // for the dynamic PS4 proof.
    const text = src();
    const setMinusXIdx = text.indexOf("\nset +x");
    const fileCheckIdx = text.indexOf('PCC_ORACLE_KEY_FILE:-');
    // The exact real assignment, not the threat-model comment's example
    // (which mentions the same `cat` pattern, minus `2>/dev/null`, earlier).
    const readIdx = text.indexOf('ORACLE_KEY="$(cat "$PCC_ORACLE_KEY_FILE")"');
    expect(fileCheckIdx).toBeGreaterThan(-1); // sanity: the script still gates on this
    expect(readIdx).toBeGreaterThan(-1); // sanity: the script still reads the file
    expect(text).not.toMatch(/PCC_ORACLE_KEY:-/); // the direct-value env var is gone
    expect(setMinusXIdx).toBeGreaterThan(-1);
    expect(setMinusXIdx).toBeLessThan(fileCheckIdx);
    expect(setMinusXIdx).toBeLessThan(readIdx);
  });

  it("no longer prints the oracle's raw free-text reason (was :295)", () => {
    expect(src()).not.toMatch(/reason=\$REASON/);
  });

  it("no longer prints the entire raw /api/auth/validate response body (was :376)", () => {
    expect(src()).not.toMatch(/API key validation returned: \$VALIDATE_RESP/);
  });
});
