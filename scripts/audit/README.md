# Route-policy coverage (audit P0 — unblocks gateway default-deny)

Lane `d749deff`. Companion to `9de363c7`'s scope-checker work on `fix/audit-p0`.

## Why this exists
`fix/audit-p0` flips the scope-checker's unmatched-route default from **allow** to
**deny** (the correct fix for C-01/C-02 auth-fails-open). But the gateway has 624
`/api/*` routes and only **11** carry a scope policy — so a blind flip 403s ~557
routes and bricks the API. This tool measures that gap and gates it so default-deny
can ship safely (in report-only mode first, then enforce once the gap is zero).

## Files
- `route-policy-inventory.mjs` — enumerates every `/api/*` route (static parse of
  `packages/gateway/src/routes/`), classifies each as **public** (api-gate) /
  **policed** (a scope rule matches) / **unpoliced-private** (the gap). Snapshots
  api-gate's public rules + scope-checker's `DEFAULT_SCOPE_REQUIREMENTS` (it does
  NOT import/edit those owned files; the snapshot is drift-checked by the test).
  Run: `node scripts/audit/route-policy-inventory.mjs` (add `--json` / `--out <f>`).
- `route-policy-baseline.json` — the RATCHET baseline: known unpoliced mutating
  routes. **May only shrink.**
- `packages/gateway/src/__tests__/route-policy-coverage.test.ts` — the CI gate:
  fails on any NEW unpoliced mutating route; asserts the gap only shrinks; anchors
  the 11-policed snapshot; asserts no money-path route is public.

## Current state (2026-07-13, off `lamasu/master`)
| bucket | count |
|---|---|
| total `/api/*` routes | 624 |
| public (api-gate) | 56 |
| **policed (scope rule)** | **11** |
| **unpoliced private MUTATING** | **263** ← drive to 0 |
| unpoliced private read (GET) | 294 |

(Corroborates the ChatGPT review's "11 matched / most unmatched"; my count is higher
because it includes every registered method.)

## Drive-to-zero (how default-deny becomes safe)
1. Add a scope policy for a route (via `9de363c7`'s scope-checker/governance table).
2. The route moves to `policed` and drops off the baseline; regenerate the baseline
   (`node -e` importing `buildInventory`, write the shrunk mutating set).
3. When `unpoliced_private_mutating` reaches 0, `SCOPE_ENFORCEMENT_MODE` can flip
   from report-only to enforce with no legitimate route bricked.

## Boundary
This lane owns these NEW files only. It does NOT touch `scope-checker.ts` /
`api-gate.ts` / `provision.ts` / `storage.ts` / `PCCForwarder.sol` (owned by
`9de363c7` on `fix/audit-p0`). PRs onto that branch; merge coordinated via coord.
