# Onboarding-chat secret purge and key rotation runbook

Status: procedure for the operator (WP-D D5; bus #2288, board N9). Written by
lane pcc-gateway (WP-D, goal `pcc-reconciliation`). **The operator executes
every step below. Nothing here is run against production from a lane or by an
agent.**

## What leaked, and why the code fix is not enough

Until WP-D, `POST /api/onboard/chat` ran agent-package tools and stored each
tool result verbatim in `onboard_chat_conversations.messages`. It also sent the
whole history back to the model provider on every turn and returned it from the
public `GET /api/onboard/chat/:id`. Conversation ids were
`cnv_<Date.now base36>_<6 Math.random chars>`, about 31 guessable bits.

The chat's `provision_api_key` tool calls `POST /api/auth/provision`, whose reply
holds:

- `api_key`: a live `pcc_live_…` (or `pcc_test_…`) key, repeated in
  `usage.header` and `usage.example`;
- `ed25519.private_key` (64 hex) and `ed25519.private_key_pkcs8_base64` (base64,
  begins `MC4CAQAwBQYDK2VwBCIEI`): the agent's signing key, when the gateway
  minted it;
- `operator_wallet.private_key` (`0x` + 64 hex): a custodial EVM wallet key,
  when on-chain identity writes are enabled.

So every secret minted through the chat before WP-D is stored in plaintext in
the database and in its backups. It was also sent to the model provider, and
anyone who guessed or saw a conversation id could read it through `GET`.

What WP-D changes: new rows are redacted before they are written, and the model
never sees a secret. Ids now carry 128 random bits, and any id in the old format
gets 404 from `GET` and from resume. New rows store a JSON envelope in the
`messages` column, `{"v":1,"owner":…,"messages":[…],"pendingActions":[…]}`.
`owner` is the sha256 fingerprint of the signed-in principal that owns the
conversation (null for an anonymous one), and `GET` and resume from any other
principal get 404. A row whose `messages` column is a bare array has no owner, so
it is not served either. **The code does not delete or rewrite old rows**, and it
cannot un-send what the model provider already received. That is why this
runbook exists, and why **every key found must be rotated**, whether or not the
rows are purged.

## Step 0: Preconditions

1. **Deploy WP-D first.** Then no new plaintext rows are written while you work,
   and old rows are already unreadable through the API.
2. **Find the database.** Production uses SQLite (WAL mode). The path is
   `DATABASE_URL` if set, else `$RAILWAY_VOLUME_MOUNT_PATH/pcc.db`, else
   `PCC_DB_PATH` (see `packages/gateway/src/db.ts`). Run the scripts below from
   `/app` in the production image, as the app user, so that
   `packages/db` resolves `better-sqlite3`. Do not create root-owned `-wal` or
   `-shm` files.
3. **Back up before any write (Steps 3 and 4).** The backup contains the same
   plaintext secrets. Keep it access-restricted and delete it at Step 6.

## Step 1: Count the affected rows (read-only)

This counts rows. It never prints a message body.

```bash
sqlite3 -readonly "$PCC_DB" <<'SQL'
.mode line
SELECT
  COUNT(*)                                                     AS rows_total,
  SUM(instr(messages, 'pcc_live_') > 0)                        AS rows_with_pcc_live,
  SUM(instr(messages, 'pcc_test_') > 0)                        AS rows_with_pcc_test,
  SUM(instr(messages, 'pcc_live_') > 0
      OR instr(messages, 'pcc_test_') > 0)                     AS rows_with_any_pcc_key,
  SUM(instr(messages, 'private_key') > 0)                      AS rows_with_private_key_field,
  SUM(NOT (length(id) = 26 AND substr(id, 1, 4) = 'cnv_'
           AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'))     AS legacy_id_rows
FROM onboard_chat_conversations;
SQL
```

`instr` is a literal substring test. `LIKE` would treat `_` as a wildcard. A row
that only mentions the prefix in prose, such as "keys start with pcc_live_",
also counts here. The Step 2 inventory matches whole keys only, so use its
numbers for decisions.

## Step 2: Inventory the exposed keys without printing them (read-only)

The script opens the database read-only and parses every row, including the tool
results serialized inside it. It hashes each `pcc_live_`/`pcc_test_` key it
finds with SHA-256 and looks the hash up in `api_keys.key_hash`. It prints only
key ids, owners, the 12-character display prefix, public keys, wallet
addresses and counts. **It never prints a key, a private key or a message.**

```bash
PCC_DB=/path/to/pcc.db node --input-type=module <<'JS'
// onboard-chat secret inventory: READ-ONLY; prints ids, counts and public halves only.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/packages/db/`);
const Database = require("better-sqlite3");
const db = new Database(process.env.PCC_DB, { readonly: true, fileMustExist: true });

const KEY_RE = /pcc_(?:live|test)_[0-9a-f]{64}(?![0-9a-f])/g; // the minted format
const NEW_ID_RE = /^cnv_[A-Za-z0-9_-]{22}$/;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const keyHashes = new Map(); // sha256(key) -> number of rows it appears in
const edPublicKeys = new Set(); // Ed25519 public keys whose private half was stored
const wallets = new Set(); // operator wallets whose private key was stored
const live = (x) => typeof x === "string" && x !== "" && !x.includes("[REDACTED]");
let rows = 0, legacyRows = 0, rowsWithKeys = 0, rowsWithPrivateKeys = 0;

function visit(v, found) {
  if (typeof v === "string") {
    for (const m of v.match(KEY_RE) ?? []) found.keys.add(m);
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { visit(JSON.parse(v), found); } catch { /* not JSON */ }
    }
    return;
  }
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) visit(x, found); return; }
  const ed = v.ed25519;
  if (ed && typeof ed === "object" && (live(ed.private_key) || live(ed.private_key_pkcs8_base64))) {
    found.priv = true;
    if (typeof ed.public_key === "string") edPublicKeys.add(ed.public_key);
  }
  const w = v.operator_wallet;
  if (w && typeof w === "object" && live(w.private_key)) {
    found.priv = true;
    if (typeof w.address === "string") wallets.add(w.address);
  }
  for (const x of Object.values(v)) visit(x, found);
}

for (const row of db.prepare("SELECT id, messages FROM onboard_chat_conversations").iterate()) {
  rows += 1;
  if (!NEW_ID_RE.test(row.id)) legacyRows += 1;
  const found = { keys: new Set(), priv: false };
  let parsed;
  try { parsed = JSON.parse(row.messages); } catch { parsed = row.messages; }
  visit(parsed, found);
  if (found.keys.size) rowsWithKeys += 1;
  if (found.priv) rowsWithPrivateKeys += 1;
  for (const k of found.keys) {
    const hash = sha256(k);
    keyHashes.set(hash, (keyHashes.get(hash) ?? 0) + 1);
  }
}

const byHash = db.prepare(
  "SELECT id, operator_id, key_prefix, created_at, revoked_at FROM api_keys WHERE key_hash = ?",
);
const byPublicKey = db.prepare("SELECT id FROM api_keys WHERE lower(public_key) = lower(?)");
const apiKeys = [];
let notInApiKeys = 0;
for (const [hash, chatRows] of keyHashes) {
  const k = byHash.get(hash);
  if (!k) { notInApiKeys += 1; continue; }
  apiKeys.push({
    key_id: k.id, operator_id: k.operator_id, key_prefix: k.key_prefix,
    created_at: k.created_at, already_revoked: k.revoked_at !== null, chat_rows: chatRows,
  });
}

console.log(JSON.stringify({
  rows,
  legacy_id_rows: legacyRows,
  rows_with_pcc_keys: rowsWithKeys,
  rows_with_private_keys: rowsWithPrivateKeys,
  distinct_pcc_keys: keyHashes.size,
  pcc_keys_not_in_api_keys: notInApiKeys,
  api_keys_to_revoke: apiKeys,
  ed25519_keys_exposed: [...edPublicKeys].map((pk) => ({ public_key: pk, api_key_ids: byPublicKey.all(pk).map((r) => r.id) })),
  operator_wallets_exposed: [...wallets],
}, null, 2));
JS
```

Keep the output. Step 3 works from it, and Step 5 compares against it.

## Step 3: Rotate every key found

Purging rows does not undo the exposure. These values were sent to the model
provider and could be read through `GET` before WP-D. Rotate all of them.

1. **API keys** (`api_keys_to_revoke` where `already_revoked` is false). Revoke
   them. This is a write, so back up first:
   ```sql
   UPDATE api_keys SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id IN ('<key_id>', '<key_id>') AND revoked_at IS NULL;
   SELECT changes();  -- expect: the number of listed ids not already revoked
   ```
   Then tell each owner (`operator_id`, an email or wallet) to provision a new
   key. A revoked key also retires its Ed25519 public key:
   `POST /api/agents/:id/verify` treats a revoked key as unknown.
2. **Ed25519 signing keys** (`ed25519_keys_exposed`). Revoking the listed
   `api_key_ids` in 1 retires them. An entry with no `api_key_ids` belongs to a
   key that is already gone, so there is nothing left to revoke.
3. **Operator wallets** (`operator_wallets_exposed`). Treat each one as
   compromised: its private key was stored and sent in plaintext. Moving any
   funds, setting a new ERC-8004 `agentWallet`, and replacing the
   `api_keys.operator_wallet_*` columns are operator decisions outside this code.
4. **`pcc_keys_not_in_api_keys` greater than 0.** Those keys were minted
   somewhere else, for example staging or a test database, or their rows were
   deleted. Run Step 2 against that environment's database, or treat them as
   unknown and leaked.
5. **Logs.** Before WP-D the model saw these keys, so it could have put one in a
   tool call's query string, and query strings reach access logs. Search the
   gateway logs, read-only, for `pcc_live_` and `pcc_test_`, and rotate any key
   you find there too.

## Step 4: Purge the stored plaintext (write)

Back up first. Pick one option.

**Option A (recommended): delete the legacy rows.** A legacy id can no longer be
read or resumed through the API, so deleting these rows loses nothing a user can
reach. Rows with new-format ids were written by the redacting code.

```bash
sqlite3 "$PCC_DB" <<'SQL'
PRAGMA secure_delete = ON;   -- overwrite deleted content instead of leaving it in free pages
BEGIN;
DELETE FROM onboard_chat_conversations
 WHERE NOT (length(id) = 26 AND substr(id, 1, 4) = 'cnv_'
            AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*');
SELECT changes();            -- expect: legacy_id_rows from Step 2
COMMIT;
PRAGMA wal_checkpoint(TRUNCATE);
SQL
```

`wal_checkpoint` prints `busy|log|checkpointed`. If `busy` is 1, the running
gateway held a read lock, so re-run `PRAGMA wal_checkpoint(TRUNCATE);` later.
Until it succeeds, the old pages can still sit in the `-wal` file. `VACUUM`
rewrites the whole file and takes an exclusive lock. If you want it, run it in a
maintenance window.

**Option B: redact in place, keeping the history.** This uses the gateway's own
redaction from the built image (`packages/gateway/dist/redaction.js`, which is
the same code the chat now runs). In an envelope row it redacts only the
`messages` array: the `owner` fingerprint is 64 hex characters, which is exactly
a shape the redaction removes, and removing it would orphan the conversation.

```bash
PCC_DB=/path/to/pcc.db node --input-type=module <<'JS'
// WRITE: redacts every stored conversation in place. Back up first.
import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/packages/db/`);
const Database = require("better-sqlite3");
const { redactSecretsDeep } = await import(`${process.cwd()}/packages/gateway/dist/redaction.js`);
const db = new Database(process.env.PCC_DB, { fileMustExist: true });
db.pragma("secure_delete = ON");
const rows = db.prepare("SELECT id, messages FROM onboard_chat_conversations").all();
const update = db.prepare("UPDATE onboard_chat_conversations SET messages = ? WHERE id = ?");
let changed = 0;
db.transaction(() => {
  for (const r of rows) {
    let out;
    try {
      const parsed = JSON.parse(r.messages);
      const isEnvelope = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && parsed.v === 1;
      out = JSON.stringify(isEnvelope ? { ...parsed, messages: redactSecretsDeep(parsed.messages) } : redactSecretsDeep(parsed));
    } catch { out = redactSecretsDeep(r.messages); }
    if (out !== r.messages) { update.run(out, r.id); changed += 1; }
  }
})();
db.pragma("wal_checkpoint(TRUNCATE)");
console.log(JSON.stringify({ rows: rows.length, changed }));
JS
```

## Step 5: Verify

1. Re-run Step 2. Expect `rows_with_pcc_keys: 0` and `rows_with_private_keys: 0`.
   With Option A, also expect `legacy_id_rows: 0`.
2. Confirm every revocation from Step 3:
   `SELECT id, revoked_at FROM api_keys WHERE id IN (...);` Every listed id
   should have a `revoked_at`.
3. `GET /api/onboard/chat/<any legacy id>` returns 404. The WP-D tests pin this
   too.

## Step 6: Backups and rollback

- Delete the Step 0 backup, and any volume snapshot taken before Step 4, once
  Step 5 passes. Otherwise restrict and expire them under your retention policy.
  After Step 3 the API keys in them no longer authenticate. The wallet private
  keys stay dangerous until those wallets are emptied.
- Rollback for Step 4: restore the table from the backup. That brings the
  plaintext back, so do it only if something else broke.
- Rollback for Step 3: `UPDATE api_keys SET revoked_at = NULL WHERE id = '<key_id>';`.
  Do this only for an id you revoked by mistake. The key is still exposed.

## Dashboard follow-ups (shell lane, not this runbook)

- The `POST /api/onboard/chat` reply can carry `revealedSecrets` once, as
  `[{ tool, path, value, boundTo? }]`. `boundTo` names whose credential it is
  (the minted key's `operator_id`); show it next to the key. Only credentials the chat's own call just minted
  are revealed (`provision_api_key` and `redeem_invite`, named fields only). The
  dashboard has to show those values to the user once and never store them.
  Otherwise a key minted in chat is unrecoverable, and the user has to
  provision again.
- For a signed-in user, every tool call other than a GET is held, not run. An
  ANONYMOUS chat holds every non-GET call too, except the pure computations
  (templates/match, graph-search, marketplace/roi, identify-device), and always
  holds credential minting. The reply carries each held call in `pendingActions`
  (`[{ actionId, tool, method, target, args, summary, bindsTo?, expiresAt }]`).
  `bindsTo` is the email or wallet a new credential would be bound to; show it
  before the confirm button. The owner view keeps digests (a 64-hex hash) so the
  person can check them, and removes secrets. `GET /api/onboard/chat/:id` lists
  the open ones to their owner, or for an anonymous conversation, to whoever
  holds its id.
  It runs only when the same user sends
  `POST /api/onboard/chat { conversationId, confirmActionId }` within 10 minutes,
  once. The reply to that request carries `confirmedAction` and the call in
  `toolCalls`. Until the dashboard renders `pendingActions` with a confirm
  button, a signed-in dashboard user cannot complete any write through chat.
- The chat page footer prints the first 12 characters of the conversation id.
  The id is now the only credential for the conversation.
- A signed-in user who continues an anonymous conversation gets a FORK they own.
  The reply carries a new `conversationId` and `forkedFrom: <the anonymous id>`,
  and the dashboard must switch to the new id. The anonymous conversation is
  never claimed.
- Quotas: at most 12 open holds per conversation, 20 per principal and 60 per
  client address, then 429 `too_many_held_actions_for_you`; 503 only when the
  whole process is full. A full conversation (`doneReason: "history_full"`) takes
  no more turns: start a new one.

## Deployment constraint: held actions live in one process's memory

The real arguments of a held action are never persisted, because they may carry
a secret. They sit in the memory of the gateway process that held them. So:
- run the onboarding chat on ONE instance, or route each conversation to the
  same instance (sticky routing). On any other instance a confirmation returns
  410 `action_unavailable`;
- a restart or redeploy drops every open hold. Confirmations then return 410,
  and nothing is listed as open. The user asks again;
- known residual (round-4 L4): if two requests on the same conversation overlap,
  the slower one's save can overwrite messages the faster one wrote. A consumed
  action is never offered or run again, but a turn's messages can be lost.
