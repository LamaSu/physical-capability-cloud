# Verification Report: README.md + 99-resume-here.md
**Validator**: val-resume-delta
**Date**: 2026-04-28
**Branch**: `feat/contributor-economics` @ `91cd842`
**Worktree**: `C:/Users/globa/pcc-contributor-economics`

---

## Pickup test

After ~10 minutes of reading README.md + `ai/research/contributor-economics/99-resume-here.md`:

This branch (`feat/contributor-economics`) adds a per-contributor on-chain royalty primitive — `RateScheduleRegistry` + `ContributorNFT` + `MilestoneEscrow.splitPayout` — so adapter authors, protocol authors, model authors, dataset contributors, verifiers, and insurers can publish a sealed rate schedule once and earn a share of every job that uses their work, with no OEM royalty class. The current state is "Wave 1-4 fully shipped, Wave 5 partial" — 32 forge tests + 700+ TS tests passing, 7 new MCP tools, 8 new REST endpoints, agent-package v2.8.0 (218 tools), but no end-to-end integration test on testnet, no external audit, and no mainnet deploy. The first thing a new contributor should do if they want to add value is read `docs/CONTRIBUTOR_ECONOMICS.md`, run `git log --oneline master..HEAD`, then pick up the e2e integration test (smallest scope, biggest confidence delta) — or push the branch to `lamasu` (it is unpushed) and open a PR.

The pickup was reasonably smooth. I did NOT need to re-read; one pass got me oriented. README's "Contributor Economics" section is short and effective; resume doc tells you exactly what to do next.

---

## Status table spot-check

I picked 8 random "DONE" claims from the resume's wave-by-wave status table and verified each against the actual tree.

| # | Claim | Verification | Verdict |
|---|---|---|---|
| 1 | Wave 3a: `RateSchedule`, `CompositionManifest`, `TrainingManifest`, `ContributorRole` enum in `@pcc/spec` | Files exist: `packages/spec/src/types/rate-schedule.ts`, `composition-manifest.ts`, `training-manifest.ts` | OK |
| 2 | Wave 3c: 32 forge tests | `RateScheduleRegistry.t.sol` = 11 tests, `ContributorNFT.t.sol` = 15 tests, `MilestoneEscrow.splitPayout.t.sol` = 14 tests; **total = 40** (not 32). The "32" claim is repeated in `docs/CONTRIBUTOR_ECONOMICS.md` line 3 and the README. | **DRIFT** — actual is 40, off by 8 |
| 3 | Wave 3b: 18+ tests for `ContributorRepository` | `packages/db/src/__tests__/contributor-db.test.ts` = 26 tests | OK ("18+" is technically truthful but stale) |
| 4 | Wave 3b: persistence in `@pcc/store` | **No `packages/store/` directory exists.** Repository lives in `packages/db/src/repositories/contributor.ts` and `packages/db/src/schema/contributor.ts` | **DRIFT** — wrong package name |
| 5 | Wave 4a: `/api/contributors/*` (8 endpoints), 23 route tests | `packages/gateway/src/routes/contributors.ts` defines exactly 8 routes; `packages/gateway/src/__tests__/contributors.test.ts` = 23 tests | OK |
| 6 | Wave 4b: 7 new MCP tools (`pcc_contributor_*`) | 2 tools have `pcc_contributor_*` prefix (register, list); 5 are named `pcc_schedule_*` and `pcc_training_manifest_*` (50–56). Total 7 — matches count. The "pcc_contributor_*" framing in the resume is misleading. | OK count, but **DRIFT** — naming pattern in resume mismatches code |
| 7 | Wave 4b: agent-package.json regenerated to v2.8.0 (218 tools) | `apps/dashboard/public/agent-package.json` is v2.8.0 with 218 tools | OK |
| 8 | Wave 4c: `claros-layer4-amendment.md` exists | `docs/claros-layer4-amendment.md` exists | OK |

Bonus checks:
- All 16 commit SHAs in the resume's "What just landed" block exist in `git log` and have matching subjects. PASS.
- Resume claims "53 commits ahead of master, head `c5de9be`". Actual is **61 commits**, head **`91cd842`**. The `c5de9be` commit IS in the tree but is no longer HEAD. Drift caused by 8 docs-only commits added after the resume was last updated (incl. the resume itself + README section + AGENT_INTEGRATION §12).

**Summary**: 6 of 8 spot-checks fully pass. Two confirmed drifts (test count = 40 not 32; package = `@pcc/db` not `@pcc/store`).

---

## Deferred list assessment

Resume lists 5 deferred items + a 6th in the body of `docs/CONTRIBUTOR_ECONOMICS.md`:

| Item | Rationale clear? | "v2 work" vs "we forgot"? | Pointers given? | Verdict |
|---|---|---|---|---|
| Cross-chain `ContributorNFT` portability | Yes — explicitly "should ship before mainnet" | Clearly v2 work | Yes — `04-network-forkability.md §10-12`. **Note**: §10-12 cover Shared Registries / Message-Passing / Treasury. The cross-chain NFT design space (LayerZero ONFT, CCIP, CCT) is actually in **§09**, not §10-12. The pointer is one section off. | Mostly OK, **section number wrong** |
| zkML training attestation | Yes — "v1 relies on hash-commit + reputational slashing" | Clearly v2 | Yes — `03-dataset-model-provenance.md` + `03-appendices.md` (both files exist) | OK |
| Production audit | Yes — "Do not deploy to chain handling real value without one" | Clearly v2 | Yes — names OpenZeppelin, Trail of Bits, Spearbit | OK |
| Mainnet deploy | Yes — gated on (a) audit, (b) ONFT, (c) Railway prod gate | Clearly v2 | Yes — `script/DeployContributorEconomics.s.sol` exists, `docs/DEPLOY.md` referenced | OK |
| Integration test (e2e) | Yes — "fund→evidence→attest→release-with-payout-map→verify N transfers + balances" | Could go either way; resume calls it "the largest gap" | Implementer-day estimate given but no specific file/test pointer. Could point to existing splitPayout test as starting scaffold. | **Weak pointer** |
| Dashboard UX polish | Yes — names 5 dashboard files already extended, says "publish my schedule wizard, browse-others gallery, evaluate-at-moment sandbox" still post-MVP | Clearly v2 | No specific file/component pointers for the 3 missing UX surfaces | **Weak pointers** |

Overall the deferred list is honest about scope and well-rationalized — no "we forgot about it" surprises. Two pointer issues (section number off-by-one for cross-chain; missing scaffold pointer for e2e + dashboard UX).

---

## Cross-doc consistency

I read `docs/CONTRIBUTOR_ECONOMICS.md`, `docs/AGENT_INTEGRATION.md`, `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`, `docs/claros-layer4-amendment.md`, ADR-10, ADR-11, ADR-12, and the README. Drift identified:

### Stale numbers (most common drift)

| Claim | README | CONTRIBUTOR_ECONOMICS.md | resume 99 | AGENT_INTEGRATION.md | Reality |
|---|---|---|---|---|---|
| Commits ahead | 53 (line 23) | 53 (line 3) | 53 (line 6) | — | **61** |
| Head SHA | — | `c5de9be` (line 5) | `c5de9be` (line 6) | — | `91cd842` |
| Forge test count | — | 32 (line 3) | 32 (line 36) | — | **40** (across the 3 contributor-economics test files) |
| Agent-package tool count | 218 (line 23) AND 219 (line 58) | — | 218 (line 33) | 218 (line 752) | **218** — README contradicts itself |
| MCP tool total | 49 (line 181) | — | — | 56 (line 685) | **56** — README out of date |
| Total agent tools (network claim) | 219 (line 123) | — | — | — | **218** in agent-package — drift |

### Wrong package name

- `docs/CONTRIBUTOR_ECONOMICS.md` lines 78, 90, 91, 246, 247, 251 reference `@pcc/store` / `packages/store/...`. **No such package exists.** Real location is `packages/db/`.
- The cheat sheet (line 251) references `packages/gateway/src/routes/__tests__/contributors.test.ts`. **No such directory.** Real location is `packages/gateway/src/__tests__/contributors.test.ts`.
- Resume line 30 also uses `@pcc/store`.

### Section reference broken

- README line 28: `docs/AGENT_INTEGRATION.md §14` — actual section is **§12**.
- `docs/CONTRIBUTOR_ECONOMICS.md` lines 161, 241: also `§14`. Three instances of the same broken §14 reference.

### ADR conflict the resume claims is resolved — isn't, in the text

- Resume line 132: "Both ADR conflicts ... were resolved during the build. The reconciliation amendment to `10-adr-licensing-engine-extension.md` is in tree at commit `4ffaf09`."
- CONTRIBUTOR_ECONOMICS.md line 235: ADR-10 link annotated "with §0 reconciliation amendment".
- **Reality**: I grepped ADR-10 for `amendment`, `reconciliation`, `§0`. **Zero hits.** ADR-10 still starts at Section 1 with the splitPayout row claiming "Option B (off-chain compute + on-chain verification/execution)". ADR-11 picks **Option A**. The actual code clearly implements Option A on-chain. So the *implementation* is consistent (Option A wins), but the *ADR text* is not — ADR-10 row 7 is stale and contradicts ADR-11 + the code. Either commit `4ffaf09` did not actually amend ADR-10, or the amendment is in a sibling file and the docs reference is wrong.

### Date inconsistency (minor)

- Resume header says "Updated: 2026-04-24". CONTRIBUTOR_ECONOMICS.md line 5 says "Branch HEAD when this doc was written: c5de9be (April 24, 2026)". Both fine. But the "53 commits" claim matches the snapshot at that date, not today (8 docs-only commits since).

---

## README integration

The README's new "Contributor Economics" section (lines 11–34):

- **Summary accuracy**: Captures the thesis well in one paragraph (no OEM royalty, mint-once, splitPayout). PASS.
- **Internal consistency with docs**: Repeats "53 commits, 32 new Forge tests, 700+ TS tests passing, 7 new MCP tools, 8 new REST endpoints under `/api/contributors/*`, agent-package v2.8.0 (218 tools)." — five of these need updates: 61 commits, 40 forge tests on the new files (or be more specific about which tests count), MCP tools is fine, REST endpoints fine, package version fine.
- **Cross-link to AGENT_INTEGRATION.md §14**: BROKEN — should be §12.
- **Cross-link to CONTRIBUTOR_ECONOMICS.md**: works (file exists).
- **Cross-link to DEPLOY_CONTRIBUTOR_ECONOMICS.md**: works.
- **Cross-link to claros-layer4-amendment.md**: works.
- **"What's new" entry** (line 34): Repeats the "53 commits, 700+ tests" line. Same drift.
- **Self-contradiction within README**: Line 25 says "218 tools", line 58 says "219 tools", line 123 says "219 agent tools", line 181 says "49 MCP tools over stdio" (it's 56). The 218 vs 219 discrepancy is the same drift the AGENT_INTEGRATION.md line 752 calls out: "re-numbered in v2.8.0 — was 219 before contributor-economics consolidation". README needs to commit to one number — actual file is **218**.

Verdict: **content accurate, numbers stale, one wrong section number, one self-contradiction**.

---

## Onboarding flow

If I were a new dev assigned to this branch, the optimal 30-minute path:

1. **`README.md`** (5 min) — what is PCC, what's the new branch's purpose, where the docs live.
2. **`ai/research/contributor-economics/99-resume-here.md`** (5 min) — what's done, what's pending, suggested next step.
3. **`docs/CONTRIBUTOR_ECONOMICS.md`** (10 min) — the actual user-facing concept doc with role taxonomy, 3-layer architecture, 5-command path, segment grammar, cheat sheet.
4. **`docs/AGENT_INTEGRATION.md` §12** (5 min) — REST + MCP API surface for the new endpoints. (Resume says §14 → broken, frustrating.)
5. **`packages/contracts/test/MilestoneEscrow.splitPayout.t.sol`** (5 min) — test reading the splitPayout invariants is the fastest way to internalize the on-chain mechanism.

After 30 min the dev should be able to: explain the no-OEM thesis; walk through the 5-command path; locate the 3 contracts, the DB schema, the gateway routes, the MCP tools, the deploy script.

The path is reasonably clear from README + 99-resume-here.md. The two friction points: (a) §14 → §12 broken cross-link wastes 30–60 seconds while the dev figures out the right section, (b) `@pcc/store` references in the cheat sheet send the dev to a directory that doesn't exist (~2 minutes lost figuring out it's `@pcc/db`).

---

## Cross-link integrity

I checked every Markdown link / file path in README.md and 99-resume-here.md (and the cheat sheet in CONTRIBUTOR_ECONOMICS.md while I was at it):

| Link | Status |
|---|---|
| README → `docs/CONTRIBUTOR_ECONOMICS.md` | OK |
| README → `docs/AGENT_INTEGRATION.md §14` | **BROKEN** — section is §12 |
| README → `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` | OK |
| README → `docs/claros-layer4-amendment.md` | OK |
| README → `docs/SPONSOR_INTEGRATIONS.md` | OK |
| README → `HACKATHON_SUBMISSION.md` | OK |
| README → `BOUNTY_SUBMISSIONS.md` | OK |
| README → `apps/dashboard/public/whitepaper.md` | OK |
| README → `CLAUDE.md` | OK |
| 99-resume → `00-plan.md` | OK |
| 99-resume → `04-network-forkability.md §10-12` | File OK; section pointer **slightly off** (cross-chain NFT material is in §09, not §10–12) |
| 99-resume → `03-dataset-model-provenance.md` | OK |
| 99-resume → `03-appendices.md` | OK |
| 99-resume → `script/DeployContributorEconomics.s.sol` | OK (`packages/contracts/script/DeployContributorEconomics.s.sol`) |
| 99-resume → `docs/DEPLOY.md` | OK |
| 99-resume → ADR-10 §0 reconciliation amendment | **BROKEN** — no such §0 in ADR-10. Either commit `4ffaf09` is mis-described or the amendment is in a sibling file |
| CONTRIBUTOR_ECONOMICS.md → `packages/store/src/schema/contributor.ts` | **BROKEN** — actual `packages/db/src/schema/contributor.ts` |
| CONTRIBUTOR_ECONOMICS.md → `packages/store/src/repos/contributor-repository.ts` | **BROKEN** — actual `packages/db/src/repositories/contributor.ts` |
| CONTRIBUTOR_ECONOMICS.md → `packages/store/src/__tests__/` | **BROKEN** |
| CONTRIBUTOR_ECONOMICS.md → `packages/gateway/src/routes/__tests__/contributors.test.ts` | **BROKEN** — actual `packages/gateway/src/__tests__/contributors.test.ts` |

**Summary**: 5 broken file/path links and 1 broken section reference (used 3× in different files). README itself is mostly clean — only the §14 reference is broken. The bulk of broken links are in `docs/CONTRIBUTOR_ECONOMICS.md` (because the cheat sheet uses the wrong package name).

---

## Friction scores (1–10)

- Could pick up branch in 30 min: **8** — README + resume doc + CONTRIBUTOR_ECONOMICS.md is a clean reading path; broken links cost ~2 min total
- Status accurate vs reality: **6** — resume claims 53 commits / 32 forge tests / `@pcc/store`; reality is 61 / 40 / `@pcc/db`. The shape of "what's done" is correct; the headline numbers are stale; the package name is wrong throughout
- Cross-doc consistent: **5** — README, CONTRIBUTOR_ECONOMICS, resume, and AGENT_INTEGRATION drift on commit count, forge test count, package name, tool counts, and §14/§12 section number. Implementation is consistent; the docs are not
- **Overall**: **6.5** — productive within 30 minutes; would lose maybe 5 minutes total to drift; would lose more if attempting to follow specific file pointers in the cheat sheet

---

## Specific fixes I'd recommend

In rough priority order (cheapest + highest-impact first):

1. **Fix the §14 → §12 cross-reference.** 3 instances total: `README.md` line 28, `docs/CONTRIBUTOR_ECONOMICS.md` lines 161 + 241. One global find/replace.

2. **Fix the `@pcc/store` → `@pcc/db` references in `docs/CONTRIBUTOR_ECONOMICS.md`.** Lines 78 (header), 90, 91, 246, 247, 251. Update paths:
   - `packages/store/src/schema/contributor.ts` → `packages/db/src/schema/contributor.ts`
   - `packages/store/src/repos/contributor-repository.ts` → `packages/db/src/repositories/contributor.ts`
   - `packages/store/src/__tests__/` → `packages/db/src/__tests__/contributor-db.test.ts`
   - `packages/gateway/src/routes/__tests__/contributors.test.ts` → `packages/gateway/src/__tests__/contributors.test.ts`
   - Also fix the "53 commits" header (line 3) → "61 commits" (or move to a section that won't bit-rot, e.g. "Shipped on `feat/contributor-economics`. See `99-resume-here.md` for current commit count").
   - Resume line 30: `Wave 3b: persistence (\`@pcc/store\`)` → `(\`@pcc/db\`)`.

3. **Decide between 32 and 40 for forge test count, fix everywhere.** Three contributor-economics-specific test files contain 11 + 15 + 14 = 40 forge test functions. If the "32" was counted differently (excluding the 14 splitPayout tests, since splitPayout extends an existing contract not a new one), say so explicitly: "32 new forge tests on 2 new contracts + 14 splitPayout extension tests".
   - README line 23, resume line 36, CONTRIBUTOR_ECONOMICS.md line 3, line 263.

4. **Decide between 218 and 219 for total tool count, fix README.** README line 58 says 219, line 123 says 219, line 25 says 218. Agent-package shows 218. AGENT_INTEGRATION.md line 752 explicitly notes the re-numbering ("was 219 before contributor-economics consolidation"). Pick 218 and update README to match.

5. **Decide between 49 and 56 for MCP tool count, fix README + CLAUDE.md.** README line 181 says "49 MCP tools"; CLAUDE.md line 848 says "All 49 MCP tools"; AGENT_INTEGRATION.md line 685 says "All 56 MCP tools". Actual is 56 (50–56 are contributor-economics).

6. **Either add the §0 reconciliation amendment to ADR-10 or remove the claim that one exists.** If commit `4ffaf09` actually contains the reconciliation, it should appear at the top of `10-adr-licensing-engine-extension.md` and explicitly resolve the "Option A vs Option B" stance. Today ADR-10 row 7 still says Option B; ADR-11 picks Option A; the code implements Option A. Either:
   - (a) prepend a `## §0 Reconciliation Amendment (2026-04-23)` section to ADR-10 saying "Section 1 row 7 is superseded by ADR-11 § Recommendation: Option A. The on-chain payout map is the canonical implementation."
   - (b) or remove the resume's claim that ADR-10 has a §0 amendment, and the CONTRIBUTOR_ECONOMICS.md "with §0 reconciliation amendment" annotation.

7. **Update the resume's "61 commits, head `91cd842`" once docs are stable.** The resume bit-rots quickly because every doc commit changes its own claims. Suggest replacing the static count with `git log --oneline master..HEAD | wc -l` instructions, OR adding a `--last-updated` shell oneliner footer that the next agent runs.

8. **Fix the §10–12 cross-chain pointer in resume + CONTRIBUTOR_ECONOMICS.md.** The cross-chain NFT material in `04-network-forkability.md` is in **§09 (Cross-chain NFT ownership: LayerZero ONFT, Wormhole, CCIP, CCT)**. Update both files to point to `04-network-forkability.md §09`.

9. **(Optional)** Add a "scaffold pointer" for the integration test deferred item — name `MilestoneEscrow.splitPayout.t.sol` as the starting harness, plus the existing route tests in `packages/gateway/src/__tests__/contributors.test.ts`. Cuts ~30 min off whoever picks it up.

10. **(Optional)** README line 23 / 34 has the same one-line summary in two places; consider deduping or letting one of them go stale freely.

None of these block productive work. Items 1, 2, and 6 are the highest-friction fixes; items 3–5 are number-hygiene; items 7–10 are polish.
