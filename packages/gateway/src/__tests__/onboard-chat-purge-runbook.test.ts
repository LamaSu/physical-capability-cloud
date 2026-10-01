/**
 * astra pack 91b, F4: the purge runbook's inventory must see every credential family a
 * legacy chat transcript can hold, and verification must fail while one is unresolved.
 *
 * docs/security/ONBOARD_CHAT_SECRET_PURGE.md Step 2 inventories PCC keys and the two
 * provisioning private-key structures. But redeem_invite (POST /api/onboard/redeem)
 * returns an identity-service session `token` and a wallet `keys.mnemonic`, and the
 * pre-WP-D chat stored every tool result verbatim. A legacy transcript holding only a
 * redemption result therefore reported zero for every counter, and Step 5's "expect zero"
 * gave assurance it had not earned.
 *
 * The test runs THE SCRIPT IN THE DOC (extracted from the markdown, so the doc and the
 * test cannot drift) against a synthetic SQLite database, the way the runbook does:
 * saved to a file, run from the repo root. Every value below is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REVEAL_RULES } from "../routes/onboard-chat.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNBOOK = join(REPO_ROOT, "docs/security/ONBOARD_CHAT_SECRET_PURGE.md");

// The runbook runs from /app, where packages/db resolves better-sqlite3; so does this test.
const Database = createRequire(`${REPO_ROOT}/packages/db/`)("better-sqlite3");

/** The Step 2 script: the first heredoc after the "Step 2" heading. */
function inventoryScript(): string {
  const doc = readFileSync(RUNBOOK, "utf8");
  const step2 = doc.slice(doc.indexOf("## Step 2"));
  const m = /<<'JS'[^\n]*\n([\s\S]*?)\nJS\n/.exec(step2);
  if (!m) throw new Error("the Step 2 inventory script was not found in the runbook");
  return m[1];
}

// Synthetic credentials of a redemption result (nothing here is a real token or seed phrase).
const SESSION_TOKEN = "gct_" + "S3ss10n".repeat(6);
const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const PASSWORD = "Synthetic-Passw0rd!";
const USER_ID = "usr_synthetic_0001";
const EVM_ADDRESS = "0x" + "dead".repeat(10);
const PCC_KEY = "pcc_live_" + "ab".repeat(32);
const LEGACY_ID = "cnv_mfz3k2p1_a8b9c0"; // the guessable pre-WP-D id format

const toolResultRow = (result: unknown, stringify = true) => [
  { role: "user", content: "redeem my invite" },
  { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "redeem_invite", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: stringify ? JSON.stringify(result) : result }] },
];

describe("onboard-chat purge runbook inventory (astra pack 91b F4)", () => {
  let dir: string;
  let dbPath: string;
  let scriptPath: string;
  let n: number;

  beforeEach(() => {
    n = 0;
    dir = mkdtempSync(join(tmpdir(), "onboard-chat-purge-"));
    dbPath = join(dir, "pcc.db");
    scriptPath = join(dir, "onboard-chat-inventory.mjs");
    writeFileSync(scriptPath, inventoryScript());
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE onboard_chat_conversations (id TEXT PRIMARY KEY, messages TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, operator_id TEXT, key_prefix TEXT, created_at TEXT, revoked_at TEXT, key_hash TEXT, public_key TEXT);
    `);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const insertRow = (messages: unknown, id = `${LEGACY_ID}${(n += 1)}`) => {
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO onboard_chat_conversations (id, messages, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      id,
      JSON.stringify(messages),
      now,
      now,
    );
    db.close();
  };

  type Report = Record<string, unknown> & {
    credential_families: Array<{ family: string; rows: number; remediation: string }>;
    verification?: { status: string; failures: string[] };
  };

  const runInventory = (env: Record<string, string> = {}) => {
    const run = spawnSync(process.execPath, [scriptPath], {
      cwd: REPO_ROOT,
      env: { ...process.env, PCC_DB: dbPath, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    let report = {} as Report;
    try {
      report = JSON.parse(run.stdout);
    } catch {
      /* the script printed no report */
    }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, report };
  };

  const family = (report: Report, name: string) => report.credential_families.find((f) => f.family === name);
  const affected = (report: Report) => Object.entries(report).filter(([k, v]) => k.startsWith("rows_with_") && typeof v === "number" && v > 0);

  it("[neg] a legacy transcript holding only a redemption result (token and keys.mnemonic) is not reported as clean", () => {
    insertRow(toolResultRow({ token: SESSION_TOKEN, keys: { mnemonic: MNEMONIC } }), LEGACY_ID);
    const { status, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report.rows).toBe(1);
    expect(report.legacy_id_rows).toBe(1);
    // Whatever the counters are called, a row that holds a live session token and a seed
    // phrase must show up in at least one affected-row counter.
    expect(affected(report), `every affected-row counter was zero: ${JSON.stringify(report)}`).not.toEqual([]);
  });

  it("counts the redemption token and the seed phrase as their own families, and prints neither", () => {
    insertRow(toolResultRow({ success: true, token: SESSION_TOKEN, user_id: USER_ID, keys: { mnemonic: MNEMONIC, evm: { address: EVM_ADDRESS } } }));
    const { status, stdout, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report.rows_with_redemption_tokens).toBe(1);
    expect(report.rows_with_wallet_mnemonics).toBe(1);
    expect(report.rows_with_pcc_keys).toBe(0);
    expect(report.rows_with_private_keys).toBe(0);
    expect(family(report, "redemption_tokens")).toMatchObject({ rows: 1, remediation: "Step 3 item 6" });
    expect(family(report, "wallet_mnemonics")).toMatchObject({ rows: 1, remediation: "Step 3 item 7" });
    // The public halves and ids that remediation needs are listed.
    expect(report.identity_service_accounts_exposed).toEqual([USER_ID]);
    expect(report.mnemonic_wallets_exposed).toEqual([EVM_ADDRESS]);
    // No credential is ever printed.
    for (const secret of [SESSION_TOKEN, MNEMONIC, "abandon ability", "S3ss10n"]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });

  it.each([
    ["the result as a parsed object (not a JSON string)", () => toolResultRow({ success: true, token: SESSION_TOKEN }, false), "rows_with_redemption_tokens"],
    ["a token with only the account id beside it", () => toolResultRow({ token: SESSION_TOKEN, user_id: USER_ID }), "rows_with_redemption_tokens"],
    ["a seed phrase alone", () => toolResultRow({ keys: { mnemonic: MNEMONIC } }), "rows_with_wallet_mnemonics"],
    ["a seed phrase outside a redemption result", () => toolResultRow({ wallet: { mnemonic: MNEMONIC } }), "rows_with_wallet_mnemonics"],
    [
      "a password passed to the tool (a tool_use input)",
      () => [{ role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "redeem_invite", input: { inviteCode: "INV-1", email: "a@b.co", password: PASSWORD } }] }],
      "rows_with_passwords",
    ],
  ])("counts %s", (_label, row, counter) => {
    insertRow(row());
    const { status, stdout, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report[counter], JSON.stringify(report)).toBe(1);
    expect(stdout).not.toContain(PASSWORD);
    expect(stdout).not.toContain(SESSION_TOKEN);
  });

  it.each([
    ["a token and no seed phrase", () => toolResultRow({ success: true, token: SESSION_TOKEN, user_id: USER_ID })],
    ["a seed phrase and no token", () => toolResultRow({ success: true, user_id: USER_ID, keys: { mnemonic: MNEMONIC } })],
  ])("lists the identity-service account of %s, so Step 3 item 6 knows whose sessions to end", (_label, row) => {
    insertRow(row());
    const { status, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report.identity_service_accounts_exposed).toEqual([USER_ID]);
  });

  it("[neg] does not call a row exposed for a `token` field that is not a redemption token, or for values the redacting code already removed", () => {
    // A token-named field in an unrelated result (an ERC-20 address), and rows written by the WP-D code.
    insertRow(toolResultRow({ token: "0x" + "ab12".repeat(10), symbol: "USDC" }));
    insertRow(toolResultRow({ success: true, token: "[REDACTED]", keys: { mnemonic: "[REDACTED]" } }));
    insertRow({ v: 1, owner: null, messages: [{ role: "user", content: [{ type: "tool_use", id: "t", name: "redeem_invite", input: { password: "[REDACTED]" } }] }], pendingActions: [] }, "cnv_" + "A".repeat(22));
    const { status, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report.rows).toBe(3);
    expect(affected(report), JSON.stringify(report)).toEqual([]);
  });

  it("the existing families are still inventoried: a PCC key and a provisioning private key", () => {
    insertRow(toolResultRow({ api_key: PCC_KEY, ed25519: { public_key: "ab".repeat(32), private_key: "cd".repeat(32) }, operator_wallet: { address: EVM_ADDRESS, private_key: "0x" + "ef".repeat(32) } }));
    const { status, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report.rows_with_pcc_keys).toBe(1);
    expect(report.rows_with_private_keys).toBe(1);
    expect(report.operator_wallets_exposed).toEqual([EVM_ADDRESS]);
    expect(family(report, "pcc_api_keys")?.rows).toBe(1);
    expect(family(report, "private_keys")?.rows).toBe(1);
  });

  // ── Step 5: unresolved credential families are an explicit verification FAILURE ───────

  const ALL = "pcc_api_keys,private_keys,redemption_tokens,wallet_mnemonics,passwords";
  const writeStep2Report = () => {
    const step2 = runInventory();
    expect(step2.status, step2.stderr).toBe(0);
    const path = join(dir, "step2.json");
    writeFileSync(path, step2.stdout);
    return path;
  };

  it("[neg] verify mode fails (exit 1, FAIL) while a family is still stored, and names each one", () => {
    insertRow(toolResultRow({ success: true, token: SESSION_TOKEN, keys: { mnemonic: MNEMONIC } }));
    const step2 = writeStep2Report();
    const { status, stderr, report } = runInventory({ PCC_VERIFY: "1", PCC_STEP2_REPORT: step2, PCC_RESOLVED: ALL });
    expect(status).toBe(1);
    expect(report.verification?.status).toBe("FAIL");
    expect(stderr).toContain("VERIFICATION FAILED");
    expect(stderr).toContain("redemption_tokens: 1 row(s) still hold live credentials");
    expect(stderr).toContain("wallet_mnemonics: 1 row(s) still hold live credentials");
    expect(stderr).not.toContain(SESSION_TOKEN);
  });

  it("[neg] verify mode fails for a family Step 2 found that is not recorded as remediated, even after the rows are gone", () => {
    insertRow(toolResultRow({ success: true, token: SESSION_TOKEN, keys: { mnemonic: MNEMONIC } }));
    const step2 = writeStep2Report();
    // Step 4: the legacy rows are deleted (Option A).
    const db = new Database(dbPath);
    db.exec("DELETE FROM onboard_chat_conversations");
    db.close();

    const unresolved = runInventory({ PCC_VERIFY: "1", PCC_STEP2_REPORT: step2, PCC_RESOLVED: "pcc_api_keys,private_keys" });
    expect(unresolved.status).toBe(1);
    expect(unresolved.report.verification?.status).toBe("FAIL");
    expect(unresolved.stderr).toContain("redemption_tokens: exposed in the Step 2 report and not recorded as remediated");
    expect(unresolved.stderr).toContain("wallet_mnemonics: exposed in the Step 2 report and not recorded as remediated");
    expect(unresolved.stderr).not.toContain("pcc_api_keys:"); // never exposed, nothing to record

    // Recorded as remediated, with nothing stored: it passes.
    const resolved = runInventory({ PCC_VERIFY: "1", PCC_STEP2_REPORT: step2, PCC_RESOLVED: ALL });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.report.verification).toEqual({ status: "PASS", failures: [] });
    expect(affected(resolved.report)).toEqual([]);
  });

  it("[neg] verify mode fails without a readable Step 2 report, and for a report from before the new families", () => {
    insertRow(toolResultRow({ api_key: "[REDACTED]" }, true));
    const none = runInventory({ PCC_VERIFY: "1", PCC_RESOLVED: ALL });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("no readable Step 2 report");

    // What the script before this fix printed: zero everywhere, and no credential_families.
    const oldReport = join(dir, "step2-old.json");
    writeFileSync(oldReport, JSON.stringify({ rows: 1, rows_with_pcc_keys: 0, rows_with_private_keys: 0 }));
    const old = runInventory({ PCC_VERIFY: "1", PCC_STEP2_REPORT: oldReport, PCC_RESOLVED: ALL });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("redemption_tokens: the Step 2 report predates this family");
    expect(old.stderr).toContain("wallet_mnemonics: the Step 2 report predates this family");
  });

  it("verify mode passes on a clean database whose Step 2 report was clean", () => {
    insertRow(toolResultRow({ success: true, token: "[REDACTED]", keys: { mnemonic: "[REDACTED]" } }));
    const step2 = writeStep2Report();
    const { status, stderr, report } = runInventory({ PCC_VERIFY: "1", PCC_STEP2_REPORT: step2 });
    expect(status, stderr).toBe(0);
    expect(report.verification).toEqual({ status: "PASS", failures: [] });
  });

  it("inventory mode (no PCC_VERIFY) never fails on what it finds: it reports", () => {
    insertRow(toolResultRow({ success: true, token: SESSION_TOKEN, keys: { mnemonic: MNEMONIC } }));
    const { status, report } = runInventory();
    expect(status).toBe(0);
    expect(report.verification).toBeUndefined();
  });

  // ── Drift guard: every credential the chat can mint is inventoried ──────────────

  // A realistic envelope for each credential-minting tool's result. A tool added to
  // REVEAL_RULES without a family in the runbook's inventory fails here, not in a review.
  const ENVELOPE: Record<string, Record<string, unknown>> = {
    provision_api_key: {},
    redeem_invite: { success: true, user_id: USER_ID },
  };
  const VALUE_FOR: Record<string, string> = {
    api_key: PCC_KEY,
    private_key: "cd".repeat(32),
    private_key_pkcs8_base64: "MC4CAQAwBQYDK2VwBCIEI" + "A".repeat(44),
    token: SESSION_TOKEN,
    mnemonic: MNEMONIC,
  };
  const concreteNames = (last: string) => (last === "private_key*" ? ["private_key", "private_key_pkcs8_base64"] : [last]);

  const cases = REVEAL_RULES.flatMap((rule) =>
    rule.fields.flatMap((path) =>
      concreteNames(path[path.length - 1]).map((name) => [rule.tool, [...path.slice(0, -1), name].join(".")] as const),
    ),
  );

  it.each(cases)("[neg] a legacy transcript holding %s's field %s is reported by the inventory (every credential the chat can mint)", (tool, dotted) => {
    const envelope = ENVELOPE[tool];
    if (envelope === undefined) throw new Error(`${tool} mints credentials but has no family in the runbook's inventory: add one, and an envelope here`);
    const path = dotted.split(".");
    const result: Record<string, unknown> = { ...envelope };
    let at = result;
    for (const seg of path.slice(0, -1)) at = (at[seg] = {}) as Record<string, unknown>;
    const name = path[path.length - 1];
    const value = VALUE_FOR[name];
    if (value === undefined) throw new Error(`no synthetic value for ${name}`);
    at[name] = name === "private_key" && path[0] === "operator_wallet" ? "0x" + value : value;
    if (path[0] === "ed25519") at.public_key = "ab".repeat(32);
    insertRow(toolResultRow(result));
    const { status, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(affected(report), `${tool}.${dotted} was stored and reported as clean: ${JSON.stringify(report)}`).not.toEqual([]);
  });

  it("the drift guard is not vacuous: it enumerates the credential fields the chat reveals", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6); // api_key, two Ed25519 keys, the wallet key, token, mnemonic
  });
});
