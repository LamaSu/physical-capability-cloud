# Contributor Economics — Research + Build Plan

**Branch**: `feat/contributor-economics` (worktree at `C:/Users/globa/pcc-contributor-economics`)
**Started**: 2026-04-23
**Base**: master @ 8550d5e

## User directive (summary from conversation)

- **OEM royalty is GONE** — no hardware-manufacturer rent class. OEMs earn only as
  Operators, Integrators, Innovators (protocol authors), or Model authors — same
  rules as everyone else. This is the load-bearing thesis that forces OEMs to
  compete on merit and adopt modular interfaces instead of vendor lock.
- **Every contributor layer sets its own rate** via an immutable public
  RateSchedule. Market discovers adoption. Protocol enforces no tiers, caps,
  or floors. People who over-price don't get adopted.
- **Rates are variable over time** (step, decay, adoption-indexed) and
  publicly committed as on-chain schedules. Honoring the schedule is reputation.
- **Dataset contributors (pilots) and Model authors** get first-class roles
  with recursive attribution: pilot mints DatasetNFT → trainer includes it
  in ModelNFT training manifest → each job that uses the model routes
  payment up the chain pro-rata by training-mix weight.
- **Multiple adapters per machine type is the default**. Forks are welcome.
  No first-registrar lock. Operators pick per-job.
- **Networks are sovereign.** Anyone can run a PCC-compatible network with
  their own treasury share (including zero). Contributors earn across networks.

## Discovered existing primitives (scope REDUCTION)

PCC already has most of the plumbing — this is an EXTENSION, not a rewrite:

- `LicensingEngine` (`packages/contracts/ts/licensing-engine.ts`) — derivative
  tree tracking, revenue decay through depth, `getRoyaltyDistribution()` walks
  the ancestor chain. Missing: time-varying RateSchedule, contributor roles
  beyond designer/operator/verifier/assembler/curator.
- `StoryRoyaltySplit` (`packages/spec/src/types/story.ts`) — 100-token percentage
  model with roles. Need to add: integrator, protocol-author, pilot,
  model-author, dataset-contributor. Need to switch to bps for precision.
- `StoryIPRegistration`, `StoryDerivativeLink` — already implement IP graph
  composition. Dataset/Model NFTs = IP Assets with role-specific metadata.
- `MilestoneEscrow.release()` (line 592) — single-destination protocol fee
  today. Needs `splitPayout()` that calls LicensingEngine for multi-destination
  routing, with the existing `tokenForMilestone()` selector.
- `/api/ip/*` routes + `pcc_ip_*` MCP tools + IP Dashboard UI — already shipped.
  New contributor roles plug in.
- Protocol economics currently has NO OEM concept — nothing to purge at the
  code level. Only docs + marketing + whitepaper positioning need review.

## 5-wave build plan

| Wave | Name | Tasks | Depends on |
|------|------|-------|-----------|
| 1 | Landscape research | 01-royalty-nft-standards, 02-rate-schedule-dsl, 03-dataset-model-provenance, 04-network-forkability | — |
| 2 | Architecture ADRs | adr-integration (LicensingEngine extension), adr-splitpayout, adr-roles, adr-rate-schedule-encoding, adr-dataset-model-ip, adr-network-primitive, adr-oem-purge-audit | Wave 1 for DSL decisions |
| 3 | Implementation | @pcc/spec types (RateSchedule, ContributorRole enum, TrainingManifest), LicensingEngine.distributeRoyaltiesWithSchedule(), MilestoneEscrow.splitPayout() extension, SDK bindings, postinstall adapter registration | Wave 2 |
| 4 | Integration + docs | agent-package.json additions, AGENT_INTEGRATION.md § on contributor tools, whitepaper § on no-OEM-rent stance, Claros Layer 4 spec amendment | Wave 3 |
| 5 | Tests | contract tests (Forge), unit tests (vitest), integration tests (full job-settles-through-splitPayout flow) | Paired with Wave 3 via test-writer sidecars |

## Work isolation

Worktree at `C:/Users/globa/pcc-contributor-economics` on branch
`feat/contributor-economics` — isolated from `feat/alerts-package` dirty state
in main repo. All commits here. Pushes go to `lamasu` remote.

## Non-goals this run

- Mainnet/Base deployment (testnet scaffolding only)
- Audited production contracts (Forge tests yes, external audit no)
- Full migration of all Story Protocol existing data to new role model (stub + migration plan doc)
- New dedicated L2/appchain (use existing Base deployment per current PCC)
