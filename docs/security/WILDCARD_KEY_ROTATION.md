# Wildcard API key rotation and revocation runbook

Status: procedure for the operator (MUST-CLOSE 9). Written by lane pcc-gateway
(WP-A, goal `pcc-reconciliation`). **The operator executes every step below.
Nothing here is run against production from a lane or by an agent.**

## Read this first

**This code does NOT make old wildcard keys disappear.** Keys minted before
self-service provisioning was narrowed still carry `scopes: ["*"]`. At the time
of writing that is every live production key (80 of 80). After the WP-A change
ships, those keys:

- **lose money authority.** A money write (POST/PUT/PATCH/DELETE under
  `/api/escrow/`, `/api/fiat-ramp/`, `/api/settlement/`, fiat-ramp setup routes
  excepted) needs an explicit `settlement` or `admin` scope. A DELETE needs
  `admin`.
- **lose admin authority.** Any method on `/api/admin/**` needs an explicit
  `admin` scope. A SIWE session with no API key is refused there too.
- **keep everything else** until they are **revoked**. That includes rule-table
  requirements such as money-path READ rules. Existing integrations keep working
  on every non-money, non-admin route.

Revoking them is an operator decision. Some of them back live integrations, so
this runbook covers inventory, classification, notification, re-issuance,
revocation, verification and rollback. No new key can be minted with `"*"` any
more: `provisionApiKey` throws.

Code references: `packages/gateway/src/middleware/scope-checker.ts` (migration
note), `packages/gateway/src/auth/api-key-auth.ts` (`assertMintableScopes`),
`packages/gateway/src/routes/admin-key-audit.ts`,
`packages/gateway/src/auth/admin-key.ts`.

## What changes for people who operate PCC

| Surface | Before | After WP-A |
|---|---|---|
| Money writes | any `"*"` key | explicit `settlement` (DELETE: `admin`) key only |
| `/api/admin/**` | any `"*"` key, or a SIWE session | explicit `admin` key only; sessions refused |
| `GET /api/admin/keys/wildcard-audit` | `PCC_KEY_ADMINS` identity allowlist | explicit `admin` key **and** `X-Admin-Key: $PCC_ADMIN_KEY` |
| `GET /api/admin/waitlist`, `/api/admin/beta-apply` | any key or session, plus `X-Admin-Token` | explicit `admin` key plus `X-Admin-Token` |
| `GET /api/admin/feedback` | `X-Admin-Token` only (public in api-gate) | unchanged |
| Self-service `POST /api/auth/provision {email}` for an email on an admin allowlist | 201, a key the allowlist trusts | 403 `identity_reserved` |

The allowlists that `identity_reserved` protects are listed in
`packages/gateway/src/auth/reserved-identities.ts`: `PCC_KEY_ADMINS`,
`AUDIT_ADMINS`, `PCC_DEMAND_ADMINS`, `PCC_AGGREGATOR_ADMINS`,
`PCC_TOOL_INDEX_ADMINS`, `PCC_OBSERVABILITY_ADMINS`, `PCC_SETTLEMENT_OPERATORS`
and `BROKER_OPERATORS`. The same refusal applies to
`POST /api/contributors/quickstart`.

## Step 0: Preconditions (before the deploy that carries WP-A)

1. **Set `PCC_ADMIN_KEY`** in the production environment. Use at least 32
   random bytes, for example `openssl rand -hex 32`. If it is unset or blank,
   the wildcard-audit endpoint fails closed with 503 `admin_key_unconfigured`
   unless `NODE_ENV` is exactly `test` or `development`. Confirm that
   production runs with `NODE_ENV=production`.
2. **Hold an explicit `admin` key.** After the deploy, no wildcard key can reach
   `/api/admin/**`, and no self-service path grants `admin`. Pick one of these
   and do it deliberately:
   - **(a) Narrow a key you already hold.** Change your own wildcard key to an
     explicit admin key. `admin` appears in every default scope rule, so this
     loses nothing there. If the governance table has rows, check that each one
     includes `admin`:
     `SELECT method, route_pattern, required_scopes FROM endpoint_scopes;`
     ```sql
     -- operator's own key only; take a backup first (Step 5)
     UPDATE api_keys SET scopes = '["admin"]'
      WHERE id = '<your key id>' AND revoked_at IS NULL;
     ```
   - **(b) Mint a new one out-of-band.** Run this from the production runtime
     with the built gateway. It prints the raw key once, so run it where the
     output is not logged:
     ```js
     // node --input-type=module, cwd = /app in the production image (the
     // Dockerfile's WORKDIR; the gateway runs packages/gateway/dist/server.js),
     // with the production environment so it opens the production DB
     const { initStore } = await import("./packages/gateway/dist/db.js");
     initStore({ seed: false });
     const { provisionApiKey } = await import("./packages/gateway/dist/auth/api-key-auth.js");
     const r = provisionApiKey({ operatorId: "<ops identity>", name: "ops admin <date>",
                                 scopes: ["admin"], expiresInDays: 30 });
     console.log(r.record.id, r.rawKey);
     ```
     An operator can hold at most 5 non-revoked keys; expired keys count toward
     the cap. Prefer a short expiry for admin keys.
3. **Warn money integrations before the deploy.** From the moment the deploy
   lands, a wildcard key that moves money gets 403. Do Steps 1 to 4 for money
   integrations first.

## Step 1: Inventory

### 1a. The endpoint

```bash
curl -sS https://capability.network/api/admin/keys/wildcard-audit \
  -H "Authorization: Bearer $PCC_EXPLICIT_ADMIN_KEY" \
  -H "X-Admin-Key: $PCC_ADMIN_KEY"
```

The endpoint returns `total_active_keys`, `wildcard_count`, `narrow_scoped_count`,
and for each wildcard key: `key_id`, `operator_id`, `key_prefix`, `name`,
`created_at` and `last_used_at`. It never returns a hash, a raw key or wallet
material. "Active" means not revoked. **Expired keys are included.** Use 1b to
tell expired keys apart.

### 1b. Read-only SQL

Production uses SQLite. Its path is `$RAILWAY_VOLUME_MOUNT_PATH/pcc.db`, or
`DATABASE_URL` or `PCC_DB_PATH` if either is set (see
`packages/gateway/src/db.ts`). Work on a **copy** where you can, and always open
the database read-only:

```bash
sqlite3 -readonly /path/to/pcc.db <<'SQL'
.headers on
.mode column
SELECT id, operator_id, key_prefix, name, created_at, last_used_at,
       expires_at, usage_count,
       CASE WHEN expires_at IS NOT NULL
                 AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')
            THEN 'expired' ELSE 'usable' END AS state
  FROM api_keys
 WHERE revoked_at IS NULL
   AND scopes LIKE '%"*"%'
 ORDER BY (last_used_at IS NULL), last_used_at DESC;
SQL
```

- **Never run `SELECT *` on `api_keys`.** Each row holds `key_hash` and, for
  some rows, `operator_wallet_private_key`. Select named columns only, and do
  not paste results with those columns anywhere.
- `LIKE '%"*"%'` matches the JSON token `"*"` in the `scopes` text column. It
  does not match scopes such as `operator.*`. It deliberately avoids
  `json_each`, which aborts the whole query on a malformed row. Malformed rows
  already grant nothing, because `getCallerScopes` fails closed.
- Timestamps are ISO-8601 UTC strings written by the gateway
  (`new Date().toISOString()`), so string comparison with
  `strftime('%Y-%m-%dT%H:%M:%fZ','now')` is correct.

Save the output, including key IDs, as the **campaign list**. Steps 5 and 7 use
it.

## Step 2: Classify

Put every key from the campaign list into exactly one class:

| Class | How to recognise it | Default action |
|---|---|---|
| **Test / verification** | `operator_id` on a test domain (`@example.com`, `@example.org`, `*.test`), for example `composition-verify@example.com`; `name` says test/demo/verify; created by a known test run | revoke; no notice |
| **Expired** | `state = 'expired'` in 1b | revoke for hygiene; no notice. It cannot authenticate |
| **Dormant** | `last_used_at` is NULL or older than the cut-off you choose (for example 30 days) | notify once, then revoke after the notice window |
| **Live integration** | recent `last_used_at` | notify, re-issue (Step 4), confirm cut-over, then revoke |

The following read-only query suggests a class. A human confirms each row:

```sql
SELECT id, operator_id, name, last_used_at,
  CASE
    WHEN operator_id LIKE '%@example.com' OR operator_id LIKE '%@example.org'
      OR operator_id LIKE '%.test' OR lower(coalesce(name,'')) GLOB '*test*'
      THEN 'test'
    WHEN expires_at IS NOT NULL
      AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'expired'
    WHEN last_used_at IS NULL
      OR last_used_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') THEN 'dormant'
    ELSE 'live'
  END AS suggested_class
  FROM api_keys
 WHERE revoked_at IS NULL AND scopes LIKE '%"*"%'
 ORDER BY suggested_class, last_used_at DESC;
```

## Step 3: Notify

For dormant and live keys, contact the holder. `operator_id` is the email or
the wallet address the key was minted for. Tell them:

- which key: the `key_prefix` (12 characters) and `created_at`. Never send the
  whole key;
- what already changed: money writes and `/api/admin/**` are refused for this
  key;
- what happens next: the key will be revoked on `<date>`;
- what to do: obtain an explicitly scoped key (Step 4) and switch to it before
  that date.

Keep a record of who was told what, and when.

## Step 4: Re-issue with explicit, narrow scopes

Issue the narrowest set that covers what the holder actually does:

| Holder needs | How they get it |
|---|---|
| onboarding: kernels, evidence, negotiate, build | self-service `POST /api/auth/provision` gives `["operator"]` |
| funds movement | the operator adds their **wallet** to `PCC_SETTLEMENT_OPERATORS`. The holder proves the wallet with SIWE (`GET /api/auth/nonce`, then sign, then `POST /api/auth/verify`) and provisions with that session, which gives `["operator","settlement"]` |
| contributor flows | `POST /api/contributors/quickstart` gives the four contributor scopes |
| admin | out-of-band only: Step 0, option (a) or (b). Nobody self-provisions `admin` |

Identities on an admin allowlist get `403 identity_reserved` on the email paths
by design. Their keys are issued out-of-band. If their allowlist entry is a
wallet, they can use SIWE instead.

## Step 5: Revoke

Take a backup first. Revocation is reversible only if you keep the campaign
list (Step 7).

```bash
sqlite3 /path/to/pcc.db ".backup '/path/to/pcc.db.pre-wildcard-revocation.$(date -u +%Y%m%dT%H%M%SZ)'"
```

There are two ways to revoke:

- **By the holder.** `DELETE /api/auth/keys/:keyId`, authenticated with a key or
  SIWE session of the **same** `operator_id` (the route only lets owners revoke).
- **By the operator, as a DB action.** Revoke exactly the IDs you confirmed, in
  one transaction, and only rows that are still wildcard and still active:
  ```sql
  BEGIN;
  UPDATE api_keys
     SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE id IN ('<id-1>', '<id-2>')
     AND revoked_at IS NULL
     AND scopes LIKE '%"*"%';
  SELECT changes();        -- must equal the number of IDs listed
  COMMIT;                  -- or ROLLBACK if it does not
  ```

Revocation takes effect on the next request. Every request resolves its key
with `findActiveByHash`, which filters `revoked_at IS NULL`. There is no key
cache to wait out.

## Step 6: Verify

```sql
-- 1. No usable wildcard key remains, except any you deliberately kept.
SELECT count(*) AS usable_wildcard_keys
  FROM api_keys
 WHERE revoked_at IS NULL
   AND scopes LIKE '%"*"%'
   AND (expires_at IS NULL OR expires_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 2. Every campaign ID is revoked.
SELECT id, revoked_at FROM api_keys WHERE id IN ('<id-1>', '<id-2>');
```

Then check that `GET /api/admin/keys/wildcard-audit` (Step 1a) reports
`wildcard_count` 0, or only the keys you kept. Spot-check one revoked key: any
authenticated `/api/*` call with it returns 401 `api_key_required`. Spot-check
one re-issued key on the route its holder needs.

## Step 7: Rollback

There are two independent levers. Use the smaller one.

- **Un-revoke keys revoked by mistake.** This is a data change, scoped to the
  campaign list:
  ```sql
  BEGIN;
  UPDATE api_keys SET revoked_at = NULL
   WHERE id IN ('<id revoked by mistake>')
     AND revoked_at >= '<campaign start, ISO-8601>';
  SELECT changes();
  COMMIT;
  ```
  An un-revoked wildcard key still has **no** money or admin authority under
  the WP-A code. For that authority, issue an explicit key (Step 4). Do not
  un-revoke a wildcard key for it.
  If the database is damaged, restore the Step 5 backup. That also undoes
  anything written after the backup was taken, so treat it as the last resort.
- **Roll back the code change.** Retag the prior image to `:prod`, as described
  in `docs/DEPLOY.md` (section "Rollback"). This restores wildcard money and
  admin authority for **every** remaining wildcard key. It re-opens
  MUST-CLOSE 7, so do it only as a short, deliberate emergency measure with a
  re-deploy planned.

## Checklist

- [ ] `PCC_ADMIN_KEY` set in production (>= 32 random bytes); `NODE_ENV=production`
- [ ] explicit `admin` key held by the operator (Step 0)
- [ ] money integrations warned and re-issued before the deploy
- [ ] inventory saved as the campaign list (Step 1)
- [ ] every key classified (Step 2); notices sent and logged (Step 3)
- [ ] replacement keys issued, with narrow scopes (Step 4)
- [ ] backup taken; revocations applied by ID (Step 5)
- [ ] verification queries and spot-checks pass (Step 6)
