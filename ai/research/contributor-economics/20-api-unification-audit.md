# /api/contributors/* vs /api/ip/* — Unification Audit

**Date**: 2026-04-27
**Branch**: `feat/contributor-economics`
**Author**: `impl-api-unify` agent
**Trigger**: User feedback — "we shipped contributor routes as parallel infrastructure to the existing IP routes; that's bullshit; either unify the backends or honestly mark the duplicates."
**Scope**: `/api/contributors/*` (8 endpoints) and MCP tools 50-56
  (`pcc_contributor_*`, `pcc_schedule_*`, `pcc_training_manifest_*`)
**Outcome**: Per-endpoint audit. Conclusion + per-row action below.

---

## TL;DR

After a row-by-row audit, **none of the 8 contributor routes or 7 contributor
MCP tools operationally duplicate any `/api/ip/*` route or `pcc_ip_*` tool**.

The parallelism the user called out is real — but at the **abstraction
layer**, not the operation layer. Both surfaces touch the same logical IP, but:

- `/api/ip/*` writes the **Story Protocol IP graph** via `repos.story.*`
  (`storyIpRegistrations`, `storyDerivativeLinks`, `storyRoyaltySplits`,
  `storyRevenueClaims`). This is the **percentage-split model** —
  `splits[]` summing to 100, written once per IP, anchored on Story
  Protocol's IPAsset / Royalty Vault.
- `/api/contributors/*` writes the **contributor-economics registries** via
  `repos.contributors.*` (`contributorProfiles`, `rateSchedules`,
  `trainingManifests`, `compositionManifests`). This is the
  **per-contributor curve model** — one row per `(address, role,
  scheduleHash)`, payouts driven by `RateSchedule.evaluateAt(now,
  jobValueCents, jobsPerDay)`.

The two are different on-chain pay rails (`distributeRoyaltyTokens` /
Story Royalty Vault vs `MilestoneEscrow.splitPayout` /
`buildPayoutMap`). They are **coordinated** (a contributor profile MAY
carry an `ipId` reference to a Story IP Asset) but they are **not
duplicates**.

**Action taken**:
- 0 routes deprecated (no operation duplicates exist)
- 0 MCP tools deprecated
- 1 audit doc added (this file) — captures the rationale so future
  agents don't re-litigate this and don't introduce duplication going forward
- 1 doc subsection added — `AGENT_INTEGRATION.md` §12.7 cross-links the
  audit conclusion + the v2 unification path that's already in
  `CONTRIBUTOR_ECONOMICS.md`

The user's stack-level critique stands: the **surfaces** are parallel and
v2 should converge them (mint each ContributorNFT as a Story IPAsset,
fold `CompositionManifest` entries into the Story derivative graph). But
that's a v2 schema migration, not a v1 deprecation header pass.

---

## Per-route audit

| # | Endpoint | Wave | Repository methods touched | Closest `/api/ip/*` analog | Action |
|---|----------|------|---------------------------|----------------------------|--------|
| 1 | `POST /api/contributors` | 4a | `repos.contributors.upsertProfile` (`contributorProfiles` table) | None — no `/api/ip/*` registers a per-(address, role, schedule) profile. `/api/ip/register-capability` registers an IP Asset, not a contributor identity. `/api/ip/distribute-royalties` writes a percentage map on a single `ipId`, not a profile. | **GENUINELY NEW — KEEP** |
| 2 | `GET /api/contributors/:address` | 4a | `repos.contributors.listProfilesByAddress` | None. `/api/ip/capability/:capabilityId` resolves IP by capability, not by contributor wallet. The story repo does have `findRoyaltySplitsByAddress` internally but no route surfaces it. | **GENUINELY NEW — KEEP** |
| 3 | `GET /api/contributors/by-role/:role` | 4a | `repos.contributors.listProfilesByRole` | None — `/api/ip/*` has no role-indexed query. | **GENUINELY NEW — KEEP** |
| 4 | `POST /api/contributors/schedules` | 4a | `repos.contributors.publishSchedule`, `repos.contributors.getSchedule` | None. `RateSchedule` is a contributor-economics primitive — content-addressed time-curve evaluator. `/api/ip/set-licensing-terms` sets `LicensingTerms` (different shape: revShare percent + standing offers) on a single `ipId`. They're conceptually adjacent but operationally distinct. | **GENUINELY NEW — KEEP** |
| 5 | `GET /api/contributors/schedules/:scheduleHash` | 4a | `repos.contributors.getSchedule` | None. `/api/ip/:ipId/licensing-terms` reads `LicensingTerms` keyed by `ipId`, not by content hash. | **GENUINELY NEW — KEEP** |
| 6 | `POST /api/contributors/schedules/:scheduleHash/evaluate` | 4a | `repos.contributors.getSchedule` (read-only evaluation) | None. `/api/ip/:ipId/royalty-distribution` calculates a per-IP distribution at a given amount; the contributor evaluator returns the curve's `bps` at a moment. Different inputs, different outputs. | **GENUINELY NEW — KEEP** |
| 7 | `POST /api/contributors/training-manifests` | 4a | `repos.contributors.setTrainingManifest` | None. `TrainingManifest` is the dataset→model attribution map — a contributor-economics-only concept. Story Protocol's derivative graph models capability→capability, not dataset→model. | **GENUINELY NEW — KEEP** |
| 8 | `GET /api/contributors/training-manifests/:modelIpId` | 4a | `repos.contributors.getTrainingManifest` | None. | **GENUINELY NEW — KEEP** |

---

## Per-MCP-tool audit

| # | Tool | Wraps endpoint | Operationally similar `pcc_ip_*` tool? | Action |
|---|------|----------------|----------------------------------------|--------|
| 50 | `pcc_contributor_register` | `POST /api/contributors` | `pcc_ip_set_splits` writes a percentage-split *map*. `pcc_contributor_register` writes a single profile row pointing at a RateSchedule. Not a duplicate. | **GENUINELY NEW — KEEP** |
| 51 | `pcc_contributor_list` | `GET /api/contributors/:address` | None. | **GENUINELY NEW — KEEP** |
| 52 | `pcc_schedule_publish` | `POST /api/contributors/schedules` | None. | **GENUINELY NEW — KEEP** |
| 53 | `pcc_schedule_get` | `GET /api/contributors/schedules/:hash` | None. | **GENUINELY NEW — KEEP** |
| 54 | `pcc_schedule_evaluate` | `POST /api/contributors/schedules/:hash/evaluate` | None. `pcc_ip_revenue_snapshot` returns vault balance, not curve evaluation. | **GENUINELY NEW — KEEP** |
| 55 | `pcc_training_manifest_set` | `POST /api/contributors/training-manifests` | None. | **GENUINELY NEW — KEEP** |
| 56 | `pcc_training_manifest_get` | `GET /api/contributors/training-manifests/:modelIpId` | None. | **GENUINELY NEW — KEEP** |

---

## Why no deprecations were added

The brief asked for `Deprecation: true` + `Sunset:` headers on routes
that **duplicate** an existing `/api/ip/*` analog. After mapping all 8
routes, **0 are duplicates**. Adding deprecation headers to non-duplicate
routes would be:

1. **Misleading** — clients would assume there's a canonical
   `/api/ip/*` replacement that doesn't exist.
2. **Self-fulfilling** — a "Sunset: 2030" header on a route that has no
   replacement creates a forced deprecation problem in 2030 with no
   plan.
3. **Honesty-violating** — the user's complaint was "you claimed
   extension, you built duplication." Adding fake deprecation headers
   would compound the original error: claiming we deprecated something
   when in fact we just slapped headers on legitimate distinct
   endpoints.

The honest answer is: **the parallelism is real at the abstraction
layer but not at the operation layer**. Document that fact (this file +
§12.7), and let v2 do the genuine schema unification.

---

## v2 unification path (carried over from `CONTRIBUTOR_ECONOMICS.md`)

Already documented in
`C:\Users\globa\pcc-contributor-economics\docs\CONTRIBUTOR_ECONOMICS.md`
"Relationship to Story Protocol — honest scoping". The plan is:

1. **Mint each `ContributorNFT` as a Story Protocol `IPAsset`** at
   registration time. The `ipId` field on `contributorProfiles` becomes
   non-null and the row points at the same Story IP that `pcc_ip_*`
   tools manage.
2. **Map `CompositionManifest` entries to Story Protocol derivative
   registrations** so a single graph traversal covers both contributor
   splits and IP licensing decay.
3. **At that point**, fold `pcc_contributor_*` tools into extended
   `pcc_ip_*` shapes:
   - `pcc_ip_set_rate_schedule` (replaces `pcc_schedule_publish` +
     `pcc_contributor_register` for the schedule-binding step)
   - `pcc_ip_link_training_data` (replaces `pcc_training_manifest_set`)
   - `pcc_ip_evaluate_payout` (replaces `pcc_schedule_evaluate` and
     `/api/ip/:ipId/royalty-distribution`)

When v2 lands, **that** is when deprecation headers go on the
`/api/contributors/*` routes — pointing at the unified `/api/ip/*`
replacements. Until then, both surfaces are first-class.

---

## What the user actually saw

The user's reaction "this is bullshit" was correct as a **surface-area
critique**: we shipped two route prefixes and two MCP tool families
that *look* parallel. The fact that they cleanly map to two distinct
on-chain pay rails (`Royalty Vault` vs `splitPayout`) is not visible from
the API table — it requires reading the contracts.

The fix for the "looks parallel" complaint without doing the v2
schema migration is documentation: §12.7 of `AGENT_INTEGRATION.md`
will now make the relationship explicit so future readers understand
why the surfaces are separate AND why they should not introduce
operational duplicates between them.

---

## Backward-compatibility guarantee

No breaking changes. All 8 routes and 7 MCP tools remain operational
with identical request/response shapes. The 23 existing route tests in
`packages/gateway/src/__tests__/contributors.test.ts` continue to pass.

---

## Cross-references

- `C:\Users\globa\pcc-contributor-economics\docs\CONTRIBUTOR_ECONOMICS.md` — "Relationship to Story Protocol — honest scoping" section
- `C:\Users\globa\pcc-contributor-economics\docs\AGENT_INTEGRATION.md` — §12 (Contributor Economics) + new §12.7
- `C:\Users\globa\pcc-contributor-economics\packages\gateway\src\routes\ip.ts` — canonical `/api/ip/*`
- `C:\Users\globa\pcc-contributor-economics\packages\gateway\src\routes\contributors.ts` — `/api/contributors/*`
- `C:\Users\globa\pcc-contributor-economics\packages\db\src\repositories\story.ts` — `repos.story` (Story Protocol IP graph)
- `C:\Users\globa\pcc-contributor-economics\packages\db\src\repositories\contributor.ts` — `repos.contributors` (contributor-economics)
- `C:\Users\globa\pcc-contributor-economics\packages\mcp-server\src\index.ts` — tools 35-39 (`pcc_ip_*`) and 50-56 (`pcc_contributor_*` / `pcc_schedule_*` / `pcc_training_manifest_*`)
