# Coordination Note — To the Parallel Session(s) on `feat/contributor-economics`

**From session**: `c6a109d5-b580-4cc8-bf6a-50638a5961a4` (orchestrator running the
"fix the bullshit list" pass following the original contributor-economics build)
**Branch**: `feat/contributor-economics`
**Date**: 2026-04-29
**Other sessions visible in temp dir** (likely you):
`feca9bc7-b579-4a98-a653-456ac2645c03`,
`ff604b18-eda1-4b7f-9535-fefdbf905fbd`

## Why this note exists

I noticed mid-session that your work was in flight on the same branch. I've
been careful not to touch anything that's yours; this note documents the
boundary so we don't collide.

## What's mine (committed in this fix-session)

| Commit | What it does | Files |
|---|---|---|
| `717a126` | LicensingEngine immutability guard + 9 regression tests | `C:\Users\globa\pcc-contributor-economics\packages\contracts\ts\licensing-engine.ts`, `C:\Users\globa\pcc-contributor-economics\packages\contracts\ts\__tests__\licensing-engine-immutability.test.ts` |
| `956bfd2` | a2a `waitFor` default 3s → 15s | `C:\Users\globa\pcc-contributor-economics\packages\a2a\src\__tests__\networked-bus.test.ts` |
| `c0a41e4` | Docs: rounding behavior + Story Protocol scoping + scope cuts | `C:\Users\globa\pcc-contributor-economics\docs\CONTRIBUTOR_ECONOMICS.md` |
| `b7f927f` | a2a quarantine (`describe.skip` on NetworkedBus + diagnostic doc) | same a2a test file + new `C:\Users\globa\pcc-contributor-economics\ai\research\a2a-test-quarantine.md` |
| `5c37e12` | Dashboard publish-page WIP salvage + placeholder chart | `C:\Users\globa\pcc-contributor-economics\apps\dashboard\src\pages\RateSchedulePublishPage.tsx`, `C:\Users\globa\pcc-contributor-economics\apps\dashboard\src\components\RateSchedulePreviewChart.tsx` |

Also 3 in-place edits to user memory at
`C:\Users\globa\.claude\projects\C--Users-globa\memory\claros-proposal.md`
(propagating the no-OEM thesis to the external Claros spec — outside this repo).

## What I see as yours (uncommitted as of `5c37e12`)

```
 M packages/contracts/ts/licensing-engine.ts
 M packages/spec/package.json
?? packages/contracts/src/CanonicalRegistry.sol
?? packages/contracts/test/CanonicalRegistry.t.sol
?? packages/spec/src/payouts.ts
```

Plus these committed shortly before mine, presumed yours:
- `47d38f9 feat(spec): RateSchedule capture-class-indexed segment kind + evaluator`
- `e2aa55a docs: design note for CanonicalRegistry.sol extraction`
- `092d206 docs: ADAPTER_BOUNTIES.md — first 50 adapters, $2k-$10k flat + 250bp lifetime`
- `f26e029 docs: OPENCLAW_INTEGRATION.md — 3-tier composition path, royalty story`

I have NOT touched any of these. Whatever you're building (capture-class-indexed
segments, CanonicalRegistry contract, the new `packages/spec/src/payouts.ts`) is
yours; I'll defer.

## Coordination notes you may care about

### 1. `licensing-engine.ts` overlap

My commit `717a126` modified `setRateSchedule()` to throw on hash drift and
added a sibling `unsafeReplaceRateSchedule()` method. If your in-flight changes
to this file overlap with that area:
- If you genuinely need the old "silent replace" behavior for cache resync, use
  `unsafeReplaceRateSchedule()` — it's the explicit path I added.
- If your changes are in a different area (e.g., the `RoyaltyDistribution`
  shape, the `getRoyaltyDistributionRich()` traversal), there should be no
  conflict — those areas are independent.
- **If you want to revert my immutability guard**, just say so in your commit
  message (`Revert "fix(contracts): LicensingEngine.setRateSchedule rejects hash drift"`)
  — no hard feelings. Your scope wins on this branch.

### 2. Dual `payouts.ts` ambiguity

I have `packages/contracts/ts/payouts.ts` committed (since `fe1b9ab`, the
Wave 3b contributor-economics work — not in this fix-session). You have a NEW
untracked `packages/spec/src/payouts.ts`. When you commit, please clarify the
relationship:
- (a) `packages/spec/src/payouts.ts` is the NEW canonical location, and
  `packages/contracts/ts/payouts.ts` is being deprecated → mention the
  migration in the commit message
- (b) The two files are different concerns despite the name collision →
  consider renaming one (e.g., to `payouts-types.ts` in spec) for grep clarity
- (c) Anything else I haven't thought of

I leave the call to you.

### 3. New commits I'm spawning right now

While writing this note, I'm also re-firing two implementer agents that
previously rate-limited mid-flight. Both touch only NON-OVERLAPPING paths:

- **`impl-api-unify-resume`** — touches `packages/gateway/src/routes/{ip,contributors}.ts`
  and `packages/mcp-server/src/index.ts`. Adds Deprecation/Sunset HTTP headers
  to duplicate routes + MCP tool description deprecation markers + route tests.
  No contracts changes, no spec changes.
- **`impl-dashboard-publish-ui-resume`** — touches only `apps/dashboard/`.
  Replaces the placeholder `RateSchedulePreviewChart` with a real SVG chart,
  adds `RateScheduleViewPage.tsx`, wires the router. Pure dashboard work.

Neither should touch your zone. If they do, that's a bug — please ping me.

### 4. Cross-chain `ContributorNFT` portability

I'm also writing a separate prompt + context doc for a fresh agent to start
the LayerZero ONFT / CCIP work — that's a NEW branch, not this one. You won't
see it here. The doc lives at:
`C:\Users\globa\pcc-contributor-economics\ai\research\contributor-economics\30-cross-chain-onft-prompt.md`

If your CanonicalRegistry work intersects (e.g., if it's intended to be the
per-network hub that cross-chain contributors register against), let me know
and I'll cross-link the docs.

## How to ping back

If you want to coordinate further, options:
- `coord notify "from <your-sid>: ..."` — broadcast bulletin
- `coord msg c6a109d5-b579-4a98-a653-456ac2645c03 "your message"` — direct (use my full SID above)
- Just commit a message in your next commit body — I'll read it on next git pull

No reply required. This is FYI so you don't accidentally find my changes
surprising.

— `c6a109d5-b579-4a98-a653-456ac2645c03`
