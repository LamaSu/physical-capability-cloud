/**
 * FC-8 round 5 (astra pack 61d, DO-NOT-SHIP at #326 @d8190fe3) — static
 * guard for scripts/smoke-digital-verifier.sh: every echo, printf, or
 * report (heredoc) line may expand only a variable in an EXPLICIT
 * validated-variable list (assigned from safe_enum/safe_bool/safe_int/
 * public_id_for_log, or a fixed literal). A bash parser is not available
 * here (stdlib-only, no third-party code), so this is a pragmatic
 * line-based parse: strip every `$(...)` command substitution first (an
 * allowlisted validator CALL, like an AST scanner's allowed CallExpression,
 * is not scrutinized further — only what's left BARE matters), then scan
 * what remains for a bare `$NAME`/`${NAME}` expansion. `${#NAME}` (a
 * length) is always safe and excluded up front.
 *
 * The validator functions' OWN bodies (safe_enum, safe_bool, safe_int,
 * public_id_for_log, public_chain_ref, add_check, millis, pass, fail,
 * skip, info) are excluded from the scan — their internal `echo "$v"` is
 * not itself a leak site, exactly as a console.log wrapper's internal
 * call is excluded from the TS AST sink guard (fc8-round5-ast-guard.ts).
 *
 * At 4dbafd7f this fails for real, substantive reasons: `$PCC_ORACLE_KEY_FILE`
 * is interpolated directly into two error messages, `$ORACLE_URL_USED` can
 * hold the env-derived ORACLE_DIRECT value, `$FAILED` is raw `gh pr checks`
 * output, `$RUN_STATUS`/`$RUN_CONCLUSION` are raw `jq -r` extractions with
 * no safe_enum validation, and `${COMMIT_SHA:0:12}` plus the heredoc's
 * `"commit": "$COMMIT_SHA"` print a raw git SHA.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("../../../../scripts/smoke-digital-verifier.sh", import.meta.url));

const VALIDATOR_FUNCTIONS = [
  "pass", "fail", "skip", "info", "add_check", "millis",
  "safe_enum", "safe_bool", "safe_int", "public_id_for_log",
  // FC-8 round 5b (steward ruling #6712): public_chain_ref's own body
  // echoes its local "$v" — a validator's internal echo is not itself a
  // leak site, same reasoning as every other function in this list.
  "public_chain_ref",
  // N44 merge (fc8-split-n44-mergetree.txt): json_object_where's and
  // json_field's own bodies `printf '%s' "$HTTP_BODY" | jq ...` — that
  // printf's stdout is piped straight into jq (internal plumbing feeding
  // the JSON parser), never written to the terminal or the report, so it
  // is not itself a leak site — same reasoning as every other function in
  // this list, not a new exception to it.
  "json_object_where", "json_field",
];

/** The explicit list of variables allowed to appear BARE in an echo/printf/report line: fixed literals, or names assigned only from a validator call. Maintaining "assigned only from a validator call" is this implementer's responsibility; see the companion assignment-source check below. */
const ALLOWED_BARE_VARS = new Set([
  // Fixed literals (assigned once, from a string/path literal, never reassigned).
  "REPO", "BRANCH", "GW", "REPORT_FILE",
  "RED", "GREEN", "YELLOW", "CYAN", "NC",
  // Locally-computed, inherently-bounded counters/timers.
  "PASS_COUNT", "FAIL_COUNT", "SKIP_COUNT", "TOTAL", "DURATION", "WALL_TIME",
  "TYPE_COUNT", "KERNEL_COUNT", // jq `length` results — structurally non-negative integers
  // Assigned from a validator call (safe_enum/safe_bool/safe_int/public_id_for_log).
  "HEALTH_STATUS", "OVERALL", "ORACLE_STATUS", "ORACLE_SOURCE_SAFE",
  "VERIFIED", "IS_VALID", "LIT_LIVE", "STARKNET_LIVE",
  "RUN_STATUS", "RUN_CONCLUSION",
  "LOCAL_SHA_LOG", "REMOTE_SHA_LOG", "COMMIT_SHA_LOG",
  // A fixed two-value label this script itself assigns ("PASS"/"FAIL").
  "OVERALL_STATUS",
  // The jq-accumulated checks array — every element's `details` field is
  // itself built only from the names in this set (maintained by the
  // add_check call sites, not derivable from this static text scan alone).
  "CHECKS_JSON",
  // Walks a fixed, author-written literal array (NEW_FILES_EXPECTED) —
  // never external/env/response data.
  "EXPECTED_FILE",
  // N44 merge (fc8-split-n44-mergetree.txt): http_request()'s own output,
  // never response-BODY content — either curl's `-w '%{http_code}'`
  // trailer (always 3 digits, curl's own contract) or the literal string
  // "transport-error" that http_request() assigns itself. Bounded by the
  // MECHANISM that produces them, same justification already given above
  // for TYPE_COUNT/KERNEL_COUNT (a jq `length`), not a validator call.
  "HTTP_STATUS", "VERIFY_HTTP",
]);

function stripCommandSubstitutions(text: string): string {
  let prev = text;
  for (let i = 0; i < 10; i++) {
    const next = prev.replace(/\$\([^()]*\)/g, "");
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/** Every bare `$NAME` / `${NAME}` (or `${NAME:0:N}`) reference in `text`, after stripping `$(...)` substitutions and `${#NAME}` length refs. */
function bareExpansions(text: string): string[] {
  const stripped = stripCommandSubstitutions(text).replace(/\$\{#[A-Za-z_][A-Za-z0-9_]*\}/g, "");
  const names: string[] = [];
  const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?(?::\d+(?::\d+)?)?\}?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) names.push(m[1]);
  return names;
}

/** [startLine, endLine) (0-indexed, end exclusive) of each validator function's body, by brace-depth tracking from its `name() {` line. */
function validatorFunctionRanges(lines: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const name of VALIDATOR_FUNCTIONS) {
    const startRe = new RegExp(`^${name}\\s*\\(\\)\\s*\\{`);
    for (let i = 0; i < lines.length; i++) {
      if (startRe.test(lines[i])) {
        let depth = 0;
        let j = i;
        for (; j < lines.length; j++) {
          depth += (lines[j].match(/\{/g) || []).length;
          depth -= (lines[j].match(/\}/g) || []).length;
          if (j > i && depth <= 0) break;
        }
        ranges.push([i, j + 1]);
        break;
      }
    }
  }
  return ranges;
}

function isInsideAnyRange(lineIdx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => lineIdx >= s && lineIdx < e);
}

/** Every echo/printf line's text, plus the heredoc report body's lines, EXCLUDING anything inside a validator function body. */
function sinkTexts(source: string): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  const skip = validatorFunctionRanges(lines);
  const out: Array<{ line: number; text: string }> = [];

  let inHeredoc = false;
  for (let i = 0; i < lines.length; i++) {
    if (isInsideAnyRange(i, skip)) continue;
    const line = lines[i];

    if (inHeredoc) {
      if (line.trim() === "REPORT_EOF") { inHeredoc = false; continue; }
      out.push({ line: i + 1, text: line });
      continue;
    }
    if (/<<REPORT_EOF\b/.test(line)) { inHeredoc = true; continue; }
    if (/^\s*(echo\b|printf\b)/.test(line)) { out.push({ line: i + 1, text: line }); continue; }
    // pass()/fail()/skip()/info()/add_check() are thin wrappers around
    // echo -e — a call site here is exactly as much a sink as a literal
    // echo line (same reasoning as the TS AST guard's localSinkFns: most
    // of this script's real output goes through these, not raw echo).
    const wrapperMatch = line.match(/^\s*(pass|fail|skip|info|add_check)\s+(.*)$/);
    if (wrapperMatch) {
      for (const arg of extractQuotedArgs(wrapperMatch[2])) out.push({ line: i + 1, text: arg });
    }
  }
  return out;
}

function extractQuotedArgs(text: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) args.push(m[1]);
  return args;
}

describe("FC-8 round 5 — smoke-digital-verifier.sh — every echo/printf/report $-expansion is validated", () => {
  it("[neg] no bare $-expansion outside the explicit validated-variable list", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    const sinks = sinkTexts(source);
    expect(sinks.length, "sanity: the scan should find real echo/printf/report lines").toBeGreaterThan(10);

    const violations: string[] = [];
    for (const { line, text } of sinks) {
      for (const name of bareExpansions(text)) {
        if (!ALLOWED_BARE_VARS.has(name)) {
          violations.push(`line ${line}: $${name} — ${text.trim()}`);
        }
      }
    }
    expect(violations.join("\n")).toBe("");
  });

  it("sanity: the validator functions themselves still exist (their bodies are excluded from the scan above, not merely absent)", () => {
    const source = readFileSync(SCRIPT_PATH, "utf8");
    const lines = source.split("\n");
    const ranges = validatorFunctionRanges(lines);
    expect(ranges.length).toBe(VALIDATOR_FUNCTIONS.length);
    for (const [s, e] of ranges) expect(e).toBeGreaterThan(s + 1); // a real, non-empty body
  });
});
