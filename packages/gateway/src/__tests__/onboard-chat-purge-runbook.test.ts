/**
 * astra pack 91b, F4: the purge runbook's inventory must see every credential family a
 * legacy chat transcript can hold.
 *
 * docs/security/ONBOARD_CHAT_SECRET_PURGE.md Step 2 inventories PCC keys and the two
 * provisioning private-key structures. But redeem_invite (POST /api/onboard/redeem)
 * returns an identity-service session `token` and a wallet `keys.mnemonic`, and the
 * pre-WP-D chat stored every tool result verbatim. A legacy transcript holding only a
 * redemption result therefore reported zero for every counter, and Step 5's "expect zero"
 * gave assurance it had not earned.
 *
 * The test runs THE SCRIPT IN THE DOC (extracted from the markdown, so the doc and the
 * test cannot drift) against a synthetic SQLite database. Every value below is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNBOOK = join(REPO_ROOT, "docs/security/ONBOARD_CHAT_SECRET_PURGE.md");

// The runbook runs from /app, where packages/db resolves better-sqlite3; so does this test.
const Database = createRequire(`${REPO_ROOT}/packages/db/`)("better-sqlite3");

/** The Step 2 script: the first `<<'JS'` heredoc after the "Step 2" heading. */
function inventoryScript(): string {
  const doc = readFileSync(RUNBOOK, "utf8");
  const step2 = doc.slice(doc.indexOf("## Step 2"));
  const m = /<<'JS'\n([\s\S]*?)\nJS\n```/.exec(step2);
  if (!m) throw new Error("the Step 2 inventory script was not found in the runbook");
  return m[1];
}

// Synthetic credentials of a redemption result (nothing here is a real token or seed phrase).
const SESSION_TOKEN = "gct_" + "S3ss10n".repeat(6);
const MNEMONIC = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const LEGACY_ID = "cnv_mfz3k2p1_a8b9c0"; // the guessable pre-WP-D id format

const legacyTranscript = (result: unknown) => [
  { role: "user", content: "redeem my invite" },
  { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "redeem_invite", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: JSON.stringify(result) }] },
];

describe("onboard-chat purge runbook inventory (astra pack 91b F4)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onboard-chat-purge-"));
    dbPath = join(dir, "pcc.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE onboard_chat_conversations (id TEXT PRIMARY KEY, messages TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE api_keys (id TEXT PRIMARY KEY, operator_id TEXT, key_prefix TEXT, created_at TEXT, revoked_at TEXT, key_hash TEXT, public_key TEXT);
    `);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const insertRow = (id: string, messages: unknown) => {
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

  const runInventory = (env: Record<string, string> = {}) => {
    const run = spawnSync(process.execPath, ["--input-type=module"], {
      input: inventoryScript(),
      cwd: REPO_ROOT,
      env: { ...process.env, PCC_DB: dbPath, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    let report: Record<string, unknown> = {};
    try {
      report = JSON.parse(run.stdout);
    } catch {
      /* the script printed no report */
    }
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, report };
  };

  it("[neg] a legacy transcript holding only a redemption result (token and keys.mnemonic) is not reported as clean", () => {
    insertRow(LEGACY_ID, legacyTranscript({ token: SESSION_TOKEN, keys: { mnemonic: MNEMONIC } }));
    const { status, stderr, report } = runInventory();
    expect(status, stderr).toBe(0);
    expect(report.rows).toBe(1);
    // Whatever the counters are called, a row that holds a live session token and a seed
    // phrase must show up in at least one affected-row counter.
    const affected = Object.entries(report).filter(([k, v]) => k.startsWith("rows_with_") && typeof v === "number" && v > 0);
    expect(affected, `every affected-row counter was zero: ${JSON.stringify(report)}`).not.toEqual([]);
  });
});
