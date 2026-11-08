/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — Step 2's
 * broader AST test: in each of the three e2e scripts, every console.*
 * call or stdout/stderr write (including the script's own local L()/log()
 * wrapper, which is how nearly every print site actually reaches
 * console.log) must build its arguments ONLY from string literals and
 * calls to the allowlisted safeLog-prefixed or publicIdForLog functions. Every
 * template-literal hole must itself be such a call (or trace, through a
 * simple same-file `const NAME = EXPR`, back to one).
 *
 * This is a MECHANICAL, blanket rule — stronger than "no canary leaked
 * today" (fc8-round5-real-e2e*.test.ts / fc8-round5-hp-full-chain.test.ts):
 * it catches a future regression even for a field no current canary
 * fixture happens to touch. At 4dbafd7f this fails with dozens of
 * violations in every script — every raw `${account.address}`,
 * `${receipt.blockNumber}`, `${ORACLE_VERIFIER}`, `${reportPath}`, every
 * JSON.stringify'd evidence/attestation dump, is a violation, not just the
 * specific ones the verdict happened to name.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findUnsafeSinkArgs, findPublicChainRefOutsideSinks } from "./support/fc8-round5-ast-guard.js";

const ALLOWED_FNS = [
  "safeLogId", "safeLogHex", "safeLogInt", "safeLogBool", "safeLogEnum",
  "safeLogContentType", "safeLogErrorName", "safeLogDecimal", "publicIdForLog",
  "envPresence", "nowIso",
  // FC-8 round 5b (steward ruling #6712): a shape-valid chain value may now
  // print verbatim in a stdout/stderr/report sink. findUnsafeSinkArgs
  // (above) only proves a SINK ARGUMENT is literal-or-allowlisted-call;
  // findPublicChainRefOutsideSinks (below) is the complementary guard that
  // proves every publicChainRef CALL is actually reached from inside one.
  "publicChainRef",
];

function readScript(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)), "utf8");
}

function violationsOf(script: string, localSinkFns: string[]): string[] {
  const violations = findUnsafeSinkArgs(readScript(script), { allowedFns: ALLOWED_FNS, localSinkFns });
  return violations.map((v) => `line ${v.line}: ${v.text}`);
}

describe("FC-8 round 5 — AST sink guard: every console/stdout/stderr argument is literal-or-allowlisted-call", () => {
  it("scripts/real-e2e-verbose.ts: no unsafe sink argument", () => {
    expect(violationsOf("scripts/real-e2e-verbose.ts", ["L"])).toEqual([]);
  });

  it("scripts/real-e2e.ts: no unsafe sink argument", () => {
    expect(violationsOf("scripts/real-e2e.ts", ["log"])).toEqual([]);
  });

  it("scripts/hp-full-chain-e2e.ts: no unsafe sink argument", () => {
    expect(violationsOf("scripts/hp-full-chain-e2e.ts", ["L"])).toEqual([]);
  });
});

describe("FC-8 round 5b (steward ruling #6712) — publicChainRef is forbidden outside a stdout/stderr/report sink", () => {
  function chainRefViolationsOfSource(source: string, localSinkFns: string[]): string[] {
    return findPublicChainRefOutsideSinks(source, localSinkFns).map((v) => `line ${v.line}: ${v.text}`);
  }

  function chainRefViolationsOf(script: string, localSinkFns: string[]): string[] {
    return chainRefViolationsOfSource(readScript(script), localSinkFns);
  }

  // [scanner self-test / required probe] — proves the guard actually
  // FLAGS a publicChainRef call sitting inside a third-party-body-building
  // expression (the printer's text builders, and any other call that
  // isn't a recognized sink), independent of whether today's production
  // code happens to contain the mistake. Mirrors fc8-e2e-script-redaction
  // .test.ts's "[scanner self-test]" pattern for the round-5 call-site guard.
  it("[scanner self-test] flags publicChainRef used inside a printer-body builder (a const array never passed to a sink)", () => {
    const probe = `
      function L(s) { console.log(s); }
      const printText = [
        "header",
        \`Escrow: \${publicChainRef(ESCROW, "address")}\`,
      ].join("\\n");
      gwFetch("POST", "/relay/tool-call", { args: { text: printText } });
    `;
    expect(chainRefViolationsOfSource(probe, ["L"]).length).toBeGreaterThan(0);
  });

  it("[scanner self-test] flags publicChainRef passed directly as a gwFetch/gw request-body argument", () => {
    const probe = `
      function L(s) { console.log(s); }
      gw("POST", "/api/evidence/archive", "POST /api/evidence/archive", {
        note: \`escrow=\${publicChainRef(ESCROW, "address")}\`,
      });
    `;
    expect(chainRefViolationsOfSource(probe, ["L"]).length).toBeGreaterThan(0);
  });

  it("[scanner self-test] does NOT flag publicChainRef used directly inside a sink call (the legitimate pattern every real call site in this codebase uses)", () => {
    const probe = `
      function L(s) { console.log(s); }
      L(\`Hash: \${publicChainRef(hash, "tx")}\`);
    `;
    expect(chainRefViolationsOfSource(probe, ["L"])).toEqual([]);
  });

  it("[scanner self-test] does NOT flag a direct console.log/process.stdout.write use either", () => {
    expect(chainRefViolationsOfSource(`console.log(\`Addr: \${publicChainRef(addr, "address")}\`);`, [])).toEqual([]);
    expect(chainRefViolationsOfSource(`process.stdout.write(\`Addr: \${publicChainRef(addr, "address")}\`);`, [])).toEqual([]);
  });

  // Production sanity: every ACTUAL publicChainRef call site in the three
  // scripts is reached from inside L()/log() — none sit inside
  // printText/finalText or any gw()/gwFetch() argument.
  it("scripts/real-e2e-verbose.ts: every publicChainRef call is inside a sink", () => {
    expect(chainRefViolationsOf("scripts/real-e2e-verbose.ts", ["L"])).toEqual([]);
  });

  it("scripts/real-e2e.ts: every publicChainRef call is inside a sink", () => {
    expect(chainRefViolationsOf("scripts/real-e2e.ts", ["log"])).toEqual([]);
  });

  it("scripts/hp-full-chain-e2e.ts: every publicChainRef call is inside a sink (printText/finalText deliberately still use publicIdForLog, never publicChainRef)", () => {
    expect(chainRefViolationsOf("scripts/hp-full-chain-e2e.ts", ["L"])).toEqual([]);
  });
});
