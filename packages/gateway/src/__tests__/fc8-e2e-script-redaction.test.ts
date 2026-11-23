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
import { findCallSites, unreviewedCallSites } from "./support/fc8-round5-ast-guard.js";

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

describe("FC-8 round 5 (astra pack 61d) — AST-based call-site allowlist (finding 3's residual)", () => {
  // The round-4 guard below used a regex, `/safeLogId\(([^()]*)\)/g`, to pull
  // each call's argument text. `[^()]*` excludes BOTH parens from the
  // argument class, so it can never match a call whose argument itself
  // contains a nested call: for `safeLogId(String(status))`, the class
  // consumes "String" and then must stop — the next character is "(",
  // which the class forbids — so the engine needs a literal ")" right
  // there to complete the match, but the next character is "(" instead.
  // No amount of backtracking within `[^()]*` finds a position where the
  // next character is ")": every shorter match still leaves a non-")"
  // character immediately after. The regex therefore finds NO match at
  // that call site AT ALL — it is invisible to the allowlist check, not
  // merely mis-recorded. This is the verdict's cheapest reproduction of
  // finding 3 (the astra round-4 review, :26).
  it("[scanner self-test] demonstrates the regex blind spot the AST scanner closes", () => {
    const probe = `const x = safeLogId(String(status));`;

    // The OLD mechanism, reconstructed here only to prove the contrast —
    // production code no longer contains this regex anywhere.
    const oldRegexFound: string[] = [];
    const re = /safeLogId\(([^()]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(probe))) oldRegexFound.push(m[1].trim());
    expect(oldRegexFound, "the old regex should find nothing at this call site").toEqual([]);

    // The NEW AST-based scanner has no such blind spot: a CallExpression's
    // arguments are structured nodes, nested calls included.
    const found = findCallSites(probe, ["safeLogId"]);
    expect(found).toEqual([{ fn: "safeLogId", argText: "String(status)" }]);
  });

  // Mutation testing round 4 found a real gap: the generic canary test
  // (fc8-round4-*.test.ts) cannot catch safeLogId being reintroduced on a
  // banned non-ID field (status/mode/network/type/fee/route/amount) —
  // fingerprinting hides the misuse exactly as well as it hides correct
  // use, because a 12-hex fingerprint of a canary is just as absent from
  // the output as a fingerprint of a real id would be. For a LOW-cardinality
  // field (e.g. a 2-3 value mode/network enum) this is worse than it looks:
  // the fingerprint's one-wayness is only as strong as the search space an
  // attacker must brute-force, and a handful of candidate plaintexts
  // inverts trivially. So finding 3's rule ("safeLogId may NOT be used on
  // non-ID fields") needs its OWN guard, independent of the leak test: an
  // explicit allowlist of every argument expression safeLogId/safeLogHex/
  // publicIdForLog is called with, per script, so any NEW call site
  // (banned or merely unreviewed) fails loudly instead of fingerprinting
  // its way past the canary test. Round 5 extends the SAME guard to
  // safeLogHex (round 4 had none — attestationStruct.signature at
  // hp-full-chain-e2e.ts:321 is a dependency SIGNATURE, not an identifier,
  // and must never appear on this allowlist) and to the new publicIdForLog.
  function checkAllowlist(script: string, fn: string, allowed: readonly string[], requireNonEmpty = true) {
    const found = findCallSites(readScript(script), [fn]);
    if (requireNonEmpty) expect(found.length, `sanity: ${fn} should still be used in ${script}`).toBeGreaterThan(0);
    const bad = unreviewedCallSites(found, new Set(allowed));
    expect(bad, bad.join("\n")).toEqual([]);
  }

  it("real-e2e-verbose.ts: every safeLogId call site is a known, reviewed identifier field", () => {
    checkAllowlist("scripts/real-e2e-verbose.ts", "safeLogId", [
      "jobResult?.jobId",
      "evidence.jobId",
      "attestationStruct.jobId",
      "archiveResult?.cid",
      "archiveResult?.metadataCid",
      "zkCommit?.commitment?.id",
      "proofId",
      "quoteId",
      "intentId",
    ]);
  });

  it("hp-full-chain-e2e.ts: every safeLogId call site is a known, reviewed identifier field", () => {
    checkAllowlist("scripts/hp-full-chain-e2e.ts", "safeLogId", ["scopeIdRaw", "toolCallId", "evidence.printResult"]);
  });

  it("real-e2e.ts: every safeLogId call site is a known, reviewed identifier field", () => {
    checkAllowlist("scripts/real-e2e.ts", "safeLogId", ["jobResult?.jobId", "printResult?.jobId"]);
  });

  // FC-8 round 5: safeLogHex gets the SAME allowlist treatment. The
  // allowlist is intentionally EMPTY in every script — the fix migrates
  // every genuine chain-hash field to publicIdForLog and replaces the one
  // non-identifier use (a dependency signature) with presence-only
  // logging — so this is a pure regression guard: if safeLogHex is ever
  // called again in these scripts, it fails loudly for review rather than
  // silently fingerprinting its way past the canary test.
  it("hp-full-chain-e2e.ts: safeLogHex is never called on a non-identifier field (attestationStruct.signature must not be allowlisted)", () => {
    checkAllowlist("scripts/hp-full-chain-e2e.ts", "safeLogHex", [], false);
  });

  it("real-e2e-verbose.ts: safeLogHex has no unreviewed call site", () => {
    checkAllowlist("scripts/real-e2e-verbose.ts", "safeLogHex", [], false);
  });

  it("real-e2e.ts: safeLogHex has no unreviewed call site", () => {
    checkAllowlist("scripts/real-e2e.ts", "safeLogHex", [], false);
  });

  // FC-8 round 5: publicIdForLog is the single function for every PUBLIC
  // chain/git identifier. FC-8 round 5b (steward ruling #6712) narrowed
  // its actual USE in these three scripts: a genuine tx hash / address /
  // event topic now goes through the new, separate publicChainRef (its
  // own allowlist, below) — publicIdForLog remains here ONLY for a
  // locally-computed content hash/commitment (cwmId, stepId, evidenceHash,
  // the attestation nonce, a ZK commitment hash), which is not itself "a
  // tx hash, an address, or an event topic" under the ruling's own
  // wording, so it stays fingerprinted rather than verbatim. The sanity
  // floor (`requireNonEmpty`) is deliberate: each script still calls
  // publicIdForLog at least once.
  it("real-e2e-verbose.ts: every publicIdForLog call site is a known, reviewed content hash/commitment (never a tx hash/address/topic — those are publicChainRef's job now)", () => {
    checkAllowlist("scripts/real-e2e-verbose.ts", "publicIdForLog", [
      'cwmId, "hash"',
      'stepId, "hash"',
      'evidenceHash, "hash"',
      'attestationStruct.evidenceHash, "hash"',
      'attestationStruct.nonce, "hash"',
      'zkCommit?.commitment?.commitmentHash, "hash"',
    ]);
  });

  it("real-e2e.ts: every publicIdForLog call site is a known, reviewed content hash/commitment", () => {
    checkAllowlist("scripts/real-e2e.ts", "publicIdForLog", [
      'evidenceHash, "hash"',
    ]);
  });

  it("hp-full-chain-e2e.ts: every publicIdForLog call site is a known, reviewed content hash/commitment, OR an address/tx-hash deliberately kept fingerprinted because it sits inside a THIRD-PARTY (printer) body (printText/finalText)", () => {
    checkAllowlist("scripts/hp-full-chain-e2e.ts", "publicIdForLog", [
      'cwmId, "hash"',
      'evidence.cwmId, "hash"',
      'evidenceHash, "hash"',
      'verifyBody.evidenceHash, "hash"',
      'attestationStruct.evidenceHash, "hash"',
      // printText (third-party body) — see hp-full-chain-e2e.ts's round-5b
      // doc comment: the ruling's "never in third-party bodies" clause
      // applies even to a value that is allowlisted for publicChainRef
      // two lines away on stdout.
      'USDC, "address"',
      'ESCROW, "address"',
      'account.address, "address"',
      // finalText (third-party body) — same reasoning, including the
      // genuine tx hashes it lists.
      'usdc.hash, "hash"',
      'createResult.hash, "hash"',
      'releaseResult.hash, "hash"',
    ]);
  });

  // FC-8 round 5b (steward ruling #6712): publicChainRef is the new,
  // single function for every PUBLIC chain value that is allowed
  // VERBATIM — a tx hash, an address, or an event topic — on stdout/in the
  // report. The sanity floor (`requireNonEmpty`) is deliberate: at the
  // round-5b starting commit this function does not exist yet and these
  // scripts call it zero times, so this assertion fails until the fix
  // lands. hp-full-chain-e2e.ts's printText/finalText deliberately have NO
  // publicChainRef call site at all (see fc8-round5-ast-sink-guard.test.ts
  // for the complementary guard that proves none sneaks in there).
  it("real-e2e-verbose.ts: every publicChainRef call site is a known, reviewed tx hash/address/topic", () => {
    checkAllowlist("scripts/real-e2e-verbose.ts", "publicChainRef", [
      'hash, "tx"',
      'lg.topics[0], "topic"',
      'lg.address, "address"',
      'addr, "address"',
      'account.address, "address"',
      'USDC, "address"',
      'ESCROW, "address"',
      'evidence.escrow, "address"',
      'evidence.protocolRoot, "address"',
      'evidence.operator, "address"',
      'attestationStruct.escrowAddress, "address"',
      'starknetTxHash, "tx"',
      'intentStatus?.txHash ?? intentStatus?.intent?.txHash, "tx"',
    ]);
  });

  it("real-e2e.ts: every publicChainRef call site is a known, reviewed tx hash/address", () => {
    checkAllowlist("scripts/real-e2e.ts", "publicChainRef", [
      'account.address, "address"',
      'USDC, "address"',
      'usdcDeployTx, "tx"',
      'PROTOCOL, "address"',
      'protocolDeployTx, "tx"',
      'createEscrowTx, "tx"',
      'ESCROW, "address"',
      'mintTx, "tx"',
      'addMsTx, "tx"',
      'approveTx, "tx"',
      'fundTx, "tx"',
      'evTx, "tx"',
      'oracleResult.transactionHash, "tx"',
      'attTx, "tx"',
      'relTx, "tx"',
    ]);
  });

  it("hp-full-chain-e2e.ts: every publicChainRef call site is a known, reviewed tx hash/address — none inside printText/finalText", () => {
    checkAllowlist("scripts/hp-full-chain-e2e.ts", "publicChainRef", [
      'hash, "tx"',
      'receipt.contractAddress, "address"',
      'account.address, "address"',
      'PROTOCOL, "address"',
      'USDC, "address"',
      'ESCROW, "address"',
      'evidence.escrow, "address"',
      'evidence.operator, "address"',
      'verifyBody.escrowAddress, "address"',
      'usdc.hash, "tx"',
      'createResult.hash, "tx"',
      'releaseResult.hash, "tx"',
    ]);
  });
});
