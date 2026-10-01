// OPERATOR-RUN migration (N1, Gate A): seal the plaintext custodial wallet keys at rest.
//
// Before N1, provisioning stored each operator wallet's private key as plaintext in
// api_keys.operator_wallet_private_key. N1 seals every NEW key at provision time (AES-256-GCM,
// "pcc-seal:v1:<kekId>:<iv>:<tag>:<ct>" in api_keys.operator_wallet_key_sealed). This script seals
// the rows that already exist: it moves each key into the sealed column and NULLs the plaintext.
//
//   node packages/gateway/scripts/seal-custodial-keys.mjs            # DRY RUN (the default): reports only
//   node packages/gateway/scripts/seal-custodial-keys.mjs --apply    # performs the writes
//
// A dry run performs the whole sealing path in memory (derive address, seal, unseal-verify), so a
// clean dry run means --apply will seal exactly those rows. It never writes.
//
// Run it from /app in the production image, with the production environment, AFTER the build that
// adds api_keys.operator_wallet_key_sealed has booted (migrate.ts adds the column; this script never
// changes the schema) and after every pre-N1 instance has stopped (an old build would keep writing
// plaintext keys; re-running afterwards is safe). Take a database backup first. It reads the same
// environment the gateway does:
//   DATABASE_URL | RAILWAY_VOLUME_MOUNT_PATH | PCC_DB_PATH   which database (same priority as src/db.ts)
//   PCC_CUSTODY_KEK       standard base64 of exactly 32 bytes
//   PCC_CUSTODY_KEK_ID    1-32 chars of A-Z a-z 0-9 _ -
//
// For each row that holds a plaintext key and NO sealed value:
//   1. the key must be 32-byte hex and viem must derive an address from it;
//   2. that address must equal operator_wallet_address (case-insensitive). A mismatch is reported
//      and the row is NOT sealed (the key does not belong to the wallet it is filed under: a human
//      must look);
//   3. seal, then unseal-verify: the blob must give back exactly the same key, for this row and address;
//   4. only then, in ONE transaction, set the sealed value AND NULL the plaintext. The UPDATE only
//      matches while the row still holds that very plaintext and no sealed value, so a concurrent
//      change is never overwritten.
// A row with BOTH a plaintext key and a sealed value is reported as a conflict and left alone: the
// script never destroys a plaintext key it has not itself verified a sealed copy of.
//
// Output: ONE JSON document on stdout holding counts and address fingerprints ONLY: "sha256:" plus
// the first 12 hex of sha256(lowercased 0x-address). Never a key, a full address, a row id or the KEK;
// any error text is scrubbed of long hex runs first.
//
// Exit: 0 clean (nothing mismatched or failed; a dry run would seal / a run sealed every candidate).
//       2 could not start: bad arguments, no valid KEK, no database / no api_keys table, or --apply
//         before the sealed column exists. Nothing was touched.
//       3 at least one row was NOT sealed: address mismatch, unusable key, or plaintext + sealed both
//         present. The rest were processed; those rows are untouched.
//       4 a failure while sealing or writing (verify failed, write failed, row changed underneath).
//         The row is left exactly as it was. Re-run after looking.
// Re-running is safe and idempotent: sealed rows are counted and skipped.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createDatabase, resolveCustodyKek, sealCustodialKey, unsealCustodialKey } from "@pcc/store";
import { privateKeyToAddress } from "viem/accounts";

export const EXIT = Object.freeze({ CLEAN: 0, USAGE: 2, NOT_SEALED: 3, FAILED: 4 });

const USAGE =
  "usage: node packages/gateway/scripts/seal-custodial-keys.mjs [--apply]\n" +
  "  (no flag)  DRY RUN: report what would be sealed, write nothing\n" +
  "  --apply    seal each plaintext key and NULL the plaintext, one transaction per row";

const HEX_KEY = /^(?:0x)?[0-9a-fA-F]{64}$/;

/** A condition the operator must fix before anything can run (exit 2). */
class ScriptError extends Error {}

/** Which database, by the SAME priority src/db.ts initStore uses. A gateway test pins the parity. */
export function resolveDbPath(env = process.env) {
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== null) {
    return { path: env.DATABASE_URL, source: "DATABASE_URL" };
  }
  if (env.RAILWAY_VOLUME_MOUNT_PATH) {
    return { path: `${env.RAILWAY_VOLUME_MOUNT_PATH}/pcc.db`, source: "RAILWAY_VOLUME_MOUNT_PATH" };
  }
  if (env.PCC_DB_PATH !== undefined && env.PCC_DB_PATH !== null) {
    return { path: env.PCC_DB_PATH, source: "PCC_DB_PATH" };
  }
  return { path: "./data/pcc.sqlite", source: "default" };
}

/** Strip anything that looks like a key, an address or a hex KEK from text that is about to be printed. */
export function scrub(text) {
  return String(text).replace(/(?:0x)?[0-9a-fA-F]{40,}/g, "[redacted]");
}

/** "sha256:" + first 12 hex of sha256(lowercased address): identifies a wallet without naming it. */
export function addressFingerprint(address) {
  if (typeof address !== "string" || address.length === 0) return "none";
  return `sha256:${createHash("sha256").update(address.toLowerCase(), "utf8").digest("hex").slice(0, 12)}`;
}

const present = (v) => typeof v === "string" && v.trim().length > 0;

export function exitCodeFor(counts) {
  if (counts.failed > 0) return EXIT.FAILED;
  if (counts.addressMismatch + counts.malformedKey + counts.conflict > 0) return EXIT.NOT_SEALED;
  return EXIT.CLEAN;
}

/**
 * The whole job against an open better-sqlite3 handle. Returns the report; prints nothing.
 * `seal`, `unseal` and `deriveAddress` are injectable so tests can force a failure.
 */
export function sealCustodialKeysInDb({
  client,
  apply,
  kek,
  deriveAddress = (key) => privateKeyToAddress(key),
  seal = sealCustodialKey,
  unseal = unsealCustodialKey,
  source = "unknown",
}) {
  const columns = new Set(client.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name));
  if (columns.size === 0) throw new ScriptError("the database has no api_keys table");
  const plainColumn = columns.has("operator_wallet_private_key");
  const sealedColumn = columns.has("operator_wallet_key_sealed");
  if (apply && !sealedColumn) {
    throw new ScriptError(
      "api_keys.operator_wallet_key_sealed does not exist yet: deploy the build that adds it, then re-run",
    );
  }

  const scanned = client.prepare("SELECT count(*) AS n FROM api_keys").get().n;
  const plainExpr = plainColumn ? "operator_wallet_private_key" : "NULL";
  const sealedExpr = sealedColumn ? "operator_wallet_key_sealed" : "NULL";
  const rows = client
    .prepare(
      `SELECT id, operator_wallet_address AS address, ${plainExpr} AS plaintext, ${sealedExpr} AS sealed
         FROM api_keys
        WHERE (${plainExpr} IS NOT NULL AND length(trim(${plainExpr})) > 0)
           OR (${sealedExpr} IS NOT NULL AND length(trim(${sealedExpr})) > 0)
        ORDER BY id`,
    )
    .all();

  const counts = {
    plaintextRows: 0,
    alreadySealed: 0,
    wouldSeal: 0,
    sealed: 0,
    addressMismatch: 0,
    malformedKey: 0,
    conflict: 0,
    failed: 0,
  };
  const entries = [];

  // One UPDATE, one transaction (immediate: take the write lock up front, so a busy gateway
  // cannot make the upgrade fail halfway). The WHERE is a compare-and-swap on the state we read.
  const update = apply && plainColumn
    ? client.prepare(
        `UPDATE api_keys
            SET operator_wallet_key_sealed = ?, operator_wallet_private_key = NULL
          WHERE id = ?
            AND operator_wallet_private_key = ?
            AND (operator_wallet_key_sealed IS NULL OR trim(operator_wallet_key_sealed) = '')`,
      )
    : null;
  const writeSealed = update ? client.transaction((blob, id, plaintext) => update.run(blob, id, plaintext).changes) : null;

  for (const row of rows) {
    if (!present(row.plaintext)) {
      counts.alreadySealed += 1; // sealed value only: nothing to do
      continue;
    }
    counts.plaintextRows += 1;
    const entry = { address: addressFingerprint(row.address) };
    entries.push(entry);

    if (present(row.sealed)) {
      counts.conflict += 1;
      entry.outcome = "conflict";
      entry.reason = "plaintext and sealed value both present; left untouched";
      continue;
    }

    // 1. a usable key, and the address it derives
    let derived = null;
    if (HEX_KEY.test(row.plaintext)) {
      try {
        derived = deriveAddress(row.plaintext.startsWith("0x") ? row.plaintext : `0x${row.plaintext}`);
      } catch {
        derived = null;
      }
    }
    if (typeof derived !== "string") {
      counts.malformedKey += 1;
      entry.outcome = "malformed_key";
      entry.reason = "not a usable 32-byte hex private key";
      continue;
    }

    // 2. it must be the key of the wallet the row is filed under
    if (typeof row.address !== "string" || row.address.toLowerCase() !== derived.toLowerCase()) {
      counts.addressMismatch += 1;
      entry.outcome = "address_mismatch";
      entry.reason = present(row.address)
        ? "the key derives a different address than operator_wallet_address"
        : "no operator_wallet_address recorded to check the key against";
      entry.keyAddress = addressFingerprint(derived);
      continue;
    }

    // 3. seal, then unseal-verify, BEFORE anything is written
    const ctx = { rowId: row.id, address: row.address };
    let blob;
    try {
      blob = seal(row.plaintext, ctx, kek);
    } catch {
      counts.failed += 1;
      entry.outcome = "failed";
      entry.reason = "seal_failed";
      continue;
    }
    let verified = false;
    try {
      verified = unseal(blob, ctx, kek) === row.plaintext;
    } catch {
      verified = false;
    }
    if (!verified) {
      counts.failed += 1;
      entry.outcome = "failed";
      entry.reason = "verify_failed: the sealed blob did not unseal to the same key; row left untouched";
      continue;
    }

    // 4. write (apply only)
    if (!apply) {
      counts.wouldSeal += 1;
      entry.outcome = "would_seal";
      continue;
    }
    let changes = 0;
    try {
      changes = writeSealed.immediate(blob, row.id, row.plaintext);
    } catch {
      counts.failed += 1;
      entry.outcome = "failed";
      entry.reason = "write_failed; row left untouched";
      continue;
    }
    if (changes !== 1) {
      counts.failed += 1;
      entry.outcome = "failed";
      entry.reason = "row_changed: the row was modified while the script ran; left untouched, re-run";
      continue;
    }
    counts.sealed += 1;
    entry.outcome = "sealed";
  }

  const exit = exitCodeFor(counts);
  return {
    mode: apply ? "apply" : "dry-run",
    database: { source },
    kekId: kek.id,
    sealedColumnPresent: sealedColumn,
    scanned,
    counts,
    rows: entries,
    clean: exit === EXIT.CLEAN,
    exit,
  };
}

function parseArgs(argv) {
  let apply = false;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--help" || arg === "-h") return { help: true };
    else return { error: `unknown argument: ${scrub(arg).slice(0, 40)}` };
  }
  return { apply };
}

function defaultOpenDb(target) {
  // better-sqlite3 silently CREATES a missing file: never let a typo'd path look like an empty database.
  if (target.path !== ":memory:" && !existsSync(target.path)) {
    throw new ScriptError("the database file does not exist (check DATABASE_URL / RAILWAY_VOLUME_MOUNT_PATH / PCC_DB_PATH)");
  }
  const { sqlite } = createDatabase(target.path);
  return { client: sqlite, close: () => sqlite.close() };
}

/** The CLI. Returns the exit code; the invoker sets process.exitCode (so stdout always flushes). */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  out = (s) => process.stdout.write(`${s}\n`),
  err = (s) => process.stderr.write(`${s}\n`),
  openDb = defaultOpenDb,
  deps = {},
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    out(USAGE);
    return EXIT.CLEAN;
  }
  if (args.error) {
    err(`seal-custodial-keys: ${args.error}\n${USAGE}`);
    return EXIT.USAGE;
  }

  const resolved = resolveCustodyKek(env);
  if (!resolved.ok) {
    err(`seal-custodial-keys: no valid custody KEK (${resolved.problems.join("; ")}); nothing was touched`);
    return EXIT.USAGE;
  }

  const target = resolveDbPath(env);
  let handle;
  try {
    handle = openDb(target);
  } catch (e) {
    err(`seal-custodial-keys: cannot open the database: ${scrub(e instanceof Error ? e.message : e)}`);
    return EXIT.USAGE;
  }

  try {
    const report = sealCustodialKeysInDb({
      client: handle.client,
      apply: args.apply,
      kek: resolved.kek,
      source: target.source,
      ...deps,
    });
    out(JSON.stringify(report, null, 2));
    if (!args.apply) err("seal-custodial-keys: DRY RUN, nothing was written. Re-run with --apply to seal.");
    return report.exit;
  } catch (e) {
    err(`seal-custodial-keys: ${scrub(e instanceof Error ? e.message : e)}`);
    return e instanceof ScriptError ? EXIT.USAGE : EXIT.FAILED;
  } finally {
    try {
      handle.close();
    } catch {
      // nothing left to do
    }
  }
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`seal-custodial-keys: ${scrub(e instanceof Error ? e.message : e)}\n`);
      process.exitCode = EXIT.FAILED;
    },
  );
}
