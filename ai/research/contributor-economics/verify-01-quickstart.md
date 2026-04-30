# Verification Report: docs/CONTRIBUTOR_ECONOMICS.md
**Validator**: val-quickstart-alpha
**Date**: 2026-04-28
**HEAD when validating**: `91cd842` on `feat/contributor-economics` (doc claims `c5de9be` — already 3 commits stale)

---

## 5-minute summary (in my own words)

Anyone who contributed work to a PCC job — the adapter author, the pilot who recorded training data, the model trainer, the protocol author, the operator running the machine — can earn from that job forever. They do this by publishing a content-addressed `RateSchedule` (a sealed JSON of basis-points-over-time/value/adoption segments) once, minting a `ContributorNFT` that binds (role, scheduleHash, ipId) immutably, and getting attached to job composition manifests. At settlement, `MilestoneEscrow.splitPayout()` evaluates each contributor's schedule and pays everyone in one transaction. There is deliberately no OEM royalty class — hardware vendors participate as Operators, Integrators, Protocol Authors, or Model Authors on equal footing, and a contributor who stops contributing earns zero.

## Role lookup (from memory after one read)

5 of the 10 roles I can recall: `operator`, `verifier`, `integrator`, `protocol-author`, `model-author`. (I also remember `dataset-contributor`, `insurer`, and `network-treasury` were named, plus `curator` and `assembler` were the ones I had to think hardest about.)

For "I wrote the OctoPrint adapter for PCC and want to earn": **`integrator`**. The doc's role table makes this unambiguous — the description literally says "Wrote the machine adapter (OctoPrint, Bambu, ROS)" with the example "Author of `kernel-octoprint`". This was front-loaded clearly. ✓ NO friction.

## Quickstart playthrough

The doc presents 5 commands (numbered 0-5, so really 6 steps). Three of them are real curl commands, two are prose ("Compose the payout map…", "Run the job…").

| # | Command | Syntactically complete? | Target exists? | Copy-paste-runnable? |
|---|---|---|---|---|
| 0 | `POST /api/auth/provision` with `{email, name}` | yes | YES — `packages/gateway/src/routes/provision.ts:20` | YES — body shape matches schema, returns `api_key` field ✓ |
| 1 | `POST /api/contributors/schedules` with `{version, segments, notes}` | yes (well-formed JSON) | YES — `contributors.ts:302` | **NO — 400 error.** Endpoint requires `{publishedBy: "0x...", schedule: {version, segments, notes}}` per `PublishScheduleBodySchema` (line 100). Doc submits a flat body with no `publishedBy` and `schedule` fields hoisted. Will fail validation. Response shape `{scheduleHash, alreadyPublished}` so the `jq -r .scheduleHash` part is correct IF you fix the body. |
| 2 | `POST /api/contributors` with `{address, role, label, scheduleHash}` | yes | YES — `contributors.ts:134` | **NO — partial fail.** `RegisterProfileBodySchema` (line 84) accepts `address, role, scheduleHash, ipId, metadataUri, contributorNftTokenId`. **`label` is NOT a permitted field.** Strict zod parsing will not include it but the doc implies label is meaningful. ContributorNFT is also never minted by this call (despite the doc's framing about minting being the source of identity). |
| 3 | `POST /api/contributors/schedules/$HASH/evaluate` with `{now, jobValueCents, jobsPerDay}` | yes | YES — `contributors.ts` (POST handler near line 200s, route advertised in module header) | YES — body shape matches `EvaluateScheduleBodySchema` exactly. ✓ |
| 4 | "Compose the payout map and call setPayoutMap()" + the dashboard "Composition Builder" tab + `packages/contracts/ts/payouts.ts:buildPayoutMap()` | not a command — prose. Points to two artifacts. | **NO and NO.** `Composition Builder` and `SplitEditor` dashboard tabs do **not exist** in `packages/ui` (grep returns zero matches). `buildPayoutMap()` exists at `packages/contracts/ts/payouts.ts:123` but **it's a stub that throws** "not implemented — Wave 3c (LicensingEngine extension)". | **HARD FAIL.** Step 4 cannot be completed without writing your own payout-map composer + your own UI, neither of which exist. The doc's 5-min path stops dead here. |
| 5 | "Operator runs the job; settlement automatically calls splitPayout via release()" | not a command — prose | depends on step 4 | depends on step 4 |

**Bottom line**: 3 of 5 commands have at least one defect. The flow is broken: step 1 fails with 400 due to wrong body shape, step 2 silently drops `label`, step 4's primary tooling doesn't exist or throws.

## Cross-link check

I followed every Markdown-style cross-reference + every `C:/Users/globa/...` absolute path the doc cites.

| Reference | Verdict |
|---|---|
| `docs/claros-layer4-amendment.md` | ✓ EXISTS |
| `docs/AGENT_INTEGRATION.md` | ✓ EXISTS but **§14 referenced does NOT exist**. AGENT_INTEGRATION goes only to §13. The Contributor Economics section is actually **§12**. The line 161 claim "see `docs/AGENT_INTEGRATION.md` §14" is **broken**. |
| `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` | ✓ EXISTS |
| `ai/research/contributor-economics/00-plan.md` | ✓ EXISTS |
| `01-royalty-nft-standards.md` | ✓ EXISTS |
| `02-rate-schedule-dsl.md` | ✓ EXISTS |
| `03-dataset-model-provenance.md` | ✓ EXISTS |
| `03-appendices.md` | ✓ EXISTS |
| `04-network-forkability.md` | ✓ EXISTS |
| `10-adr-licensing-engine-extension.md` | ✓ EXISTS |
| `11-adr-splitpayout-contract.md` | ✓ EXISTS |
| `12-adr-role-taxonomy-and-no-oem.md` | ✓ EXISTS |
| `99-resume-here.md` | ✓ EXISTS |
| `packages/contracts/src/RateScheduleRegistry.sol` | ✓ EXISTS |
| `packages/contracts/src/ContributorNFT.sol` | ✓ EXISTS |
| `packages/contracts/src/MilestoneEscrow.sol` | ✓ EXISTS, but the doc's "lines 580-700 (the splitPayout flow)" is **wrong**. The file is only 662 lines total. The splitPayout distribution path lives ~508-end-of-file. Off by ~70 lines on each end. |
| `packages/contracts/script/DeployContributorEconomics.s.sol` | ✓ EXISTS |
| `packages/spec/src/types/rate-schedule.ts` | ✓ EXISTS |
| `packages/spec/src/types/composition-manifest.ts` | ✓ EXISTS |
| `packages/spec/src/types/training-manifest.ts` | ✓ EXISTS |
| `packages/store/src/schema/contributor.ts` | **✗ DOES NOT EXIST.** Real path: `packages/db/src/schema/contributor.ts`. Package is `@pcc/db`, not `@pcc/store`. |
| `packages/store/src/repos/contributor-repository.ts` | **✗ DOES NOT EXIST.** Real path: `packages/db/src/repositories/contributor.ts` (note: `repositories` not `repos`, and filename is `contributor.ts` not `contributor-repository.ts`). |
| `packages/gateway/src/routes/contributors.ts` | ✓ EXISTS |
| `packages/mcp-server/src/index.ts` | ✓ EXISTS |
| `packages/contracts/test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow.splitPayout}.t.sol` | ✓ ALL THREE EXIST (verified individually). |
| `packages/spec/src/__tests__/` | ✓ EXISTS |
| `packages/store/src/__tests__/` | **✗ DOES NOT EXIST.** Real path: `packages/db/src/__tests__/` (where `contributor-db.test.ts` lives). |
| `packages/gateway/src/routes/__tests__/contributors.test.ts` | **✗ DOES NOT EXIST.** Real path: `packages/gateway/src/__tests__/contributors.test.ts` (no `routes/` segment). |
| `packages/contracts/ts/payouts.ts:buildPayoutMap()` | ✓ file/symbol exist, but symbol **throws Error("not implemented")** — the doc calls this out nowhere. |

**Broken-link summary**: 5 file paths wrong (`store` → `db` package rename appears un-propagated to the doc), 1 broken section anchor (`§14` should be `§12`), 1 wrong line range, 1 silent stub passed off as usable code. Every claim about the `@pcc/store` package is wrong because there is no `@pcc/store` package.

## Where-each-thing-lives sheet check

The "Where each thing lives" table at line 230 has 21 rows. Above table covers all of them. Of those:

- **17 rows correct** (docs, ADRs, contracts, deploy script, spec types, gateway route).
- **4 rows wrong** (DB schema, DB repo, store tests dir, gateway tests path).

## Confusion log

Counting things that took me >10 seconds to make sense of as a fresh reader:

1. **Step 4 ("Compose the payout map") is prose, not a command.** The header promises "5 commands" and the doc itself says "5-minute path", but two of the five steps have no executable shell. I had to figure out from context that step 4 means "go use a UI we don't ship and a function that throws". I would have given up in 30s.
2. **`integrator` typical bps band is `0-100 bps` while the example schedule uses 40 bps but `setPayoutMap` (per ADR-11) caps at 50% per recipient.** The relationship between the two numbers (basis-points-of-milestone vs share-of-total-distributable) is not explained. After re-reading I think they refer to different things, but the doc never disambiguates "bps of milestone amount" vs "bps of distributable after fee".
3. **`SCHEDULE_HASH=$(curl ... | jq -r .scheduleHash)` — is `scheduleHash` returned even when the schedule was already published?** The route returns `{scheduleHash, alreadyPublished: true|false}`. Yes it works in both cases. The doc doesn't mention idempotency at all so I had to read the code to convince myself.
4. **"There is no OEM role… by design"** is repeated 4 times across the doc. Once would have been enough; the redundancy reads like the author talking themselves into it. The first paragraph already covers it.
5. **`exists()` on `RateScheduleRegistry` is described as "O(1) and is what `ContributorNFT` calls at mint time"** — but the 5-command quickstart never mints a `ContributorNFT`. Step 2 calls `POST /api/contributors` which writes a DB row, not a token. The relationship between the off-chain profile row and the on-chain ContributorNFT is opaque.
6. **`evaluateRateSchedule(schedule, ctx)` is mentioned in §1 but never re-mentioned in the quickstart.** Step 3's `/evaluate` endpoint is presumably calling it server-side; that's worth one sentence to nail down.
7. **"v1 is hash-commit + reputational slashing for `model-author` and `dataset-contributor`"** — the word "slashing" appears once and isn't defined or cross-linked. Stake? Reputation? On-chain? Off-chain? Unanswered.
8. **"32 forge tests + 700+ TS tests pass"** is repeated three times. Useful once, noise twice.
9. **`docs/AGENT_INTEGRATION.md` §14** — broken cross-ref noted above. As a fresh reader expecting to find "the full REST + MCP surface" at §14, I scrolled to §13 and gave up.
10. **"7 MCP tools added in v2.8.0"** — couldn't find them. Search of `packages/mcp-server/src/index.ts` for `contributor_` returns 2 tool definitions: `pcc_contributor_register` and `pcc_contributor_list`. Either the count is wrong or the tools live elsewhere.

## What I cannot do from this doc alone

These actions a contributor would plausibly want, that the front-door doc does NOT cover:

- **Mint a `ContributorNFT` on-chain.** Doc describes the contract but gives no flow ("call `mint(...)` on the deployed contract at `0x...`"). The dashboard tab claimed for this doesn't exist.
- **Verify deployed contract addresses.** No `deployments/` table, no Etherscan link, no chain-id+address pair. (`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` would presumably cover this — fair to defer.)
- **Compute `scheduleHash` locally before submitting.** Doc says the algorithm is `sha256(canonicalJSON({version, segments}))` but doesn't point to a CLI or `npx ...` to do it. Useful for offline review.
- **Update / supersede a published schedule.** Doc says "v2 = mint a new token" but doesn't show the deprecation flow for an old `scheduleHash`.
- **Withdraw / dispute / claim accumulated splitPayout.** Doc focuses on *publishing* and *attaching*; the *receiving funds* path is hand-waved as "every recipient gets paid in one tx".
- **Build the actual payout map.** Step 4 says "use `buildPayoutMap()`" — that throws. **There is no path forward from this doc.** A new agent hits a wall.
- **Run a real test against deployed testnet.** No Anvil/Forge command, no Base Sepolia faucet pointer.

I'd need:
- `docs/AGENT_INTEGRATION.md` for full REST surface (cross-linked, fair)
- `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` for contract addresses (cross-linked, fair)
- *Something* for "how to compose a payout map manually until Wave 3c" — this should be in this doc

## Friction scores (1-10)

- **Onboarding in 5 minutes**: **3/10**. I can read it in 5 minutes. I cannot *act on it* in 5 minutes. The 5-command quickstart fails at step 1 (wrong body shape) and stops at step 4 (stub throws).
- **Commands copy-pasteable**: **4/10**. Step 0 works. Step 3 works. Step 1 needs a body rewrite. Step 2 silently drops `label`. Steps 4-5 aren't copy-pasteable at all.
- **Cross-references work**: **6/10**. 17 of ~22 absolute paths resolve. 5 paths reference a renamed package (`store` → `db`). One section anchor (§14) is broken.
- **Front-loaded info**: **7/10**. The "in one paragraph" + role table at the top is excellent. The repeat of the no-OEM thesis 4 times is anti-front-loading. The fact that step 4 is a stub belongs above the quickstart, not absent.
- **Overall**: **5/10**.

A 30-minute-budget agent dropped here would burn budget hitting 400s, then waste more on the missing `buildPayoutMap`. The doc is a great *narrative* but not a great *runbook*.

## Specific fixes I'd recommend

1. **Line 121** (`POST /api/contributors/schedules` curl): wrap the body in `{publishedBy: "0xYourWallet", schedule: {version, segments, notes}}`. Currently posts a flat body that fails zod validation.
2. **Line 133-141** (`POST /api/contributors` curl): drop the `label` field — it's not in `RegisterProfileBodySchema`. If `label` *should* be supported, add it to the schema. If it's just a comment, remove it from the example so readers don't think it's part of the API.
3. **Line 161**: change `docs/AGENT_INTEGRATION.md §14` → `§12 Contributor Economics`. AGENT_INTEGRATION only has 13 sections.
4. **Line 152** ("packages/contracts/ts/payouts.ts:buildPayoutMap()"): add a one-liner warning: "currently a stub that throws — Wave 3c LicensingEngine work will implement; for the gap-fill you must hand-build the `Payout[]` array yourself. See ADR-11 §3 for the shape." Without this, every fresh agent following the quickstart hits a runtime error.
5. **Lines 90, 91, 246, 247, 251**: `packages/store/...` → `packages/db/...`. Package is `@pcc/db`, not `@pcc/store`.  Specifically:
   - `packages/store/src/schema/contributor.ts` → `packages/db/src/schema/contributor.ts`
   - `packages/store/src/repos/contributor-repository.ts` → `packages/db/src/repositories/contributor.ts`
   - `packages/store/src/__tests__/` → `packages/db/src/__tests__/` (and the test file is `contributor-db.test.ts`, not bare-named)
6. **Line 251**: `packages/gateway/src/routes/__tests__/contributors.test.ts` → `packages/gateway/src/__tests__/contributors.test.ts` (no `routes/` segment).
7. **Line 104** ("MilestoneEscrow.sol lines 580-700"): file is 662 lines total. The splitPayout *distribution* path is roughly lines 508-650. Either pin to actual range or drop the line numbers — they'll bit-rot.
8. **Line 161** ("7 MCP tools added in v2.8.0"): only 2 contributor MCP tools exist (`pcc_contributor_register`, `pcc_contributor_list`). Either ship the missing 5 or change the count to match reality.
9. **Line 260** ("`Composition Builder` and `SplitEditor` tabs were extended"): no such tabs exist in `packages/ui`. Either ship them or change to "no UI yet — use API directly".
10. **Add a "What's stub vs ready" callout near the quickstart.** Currently the doc reads as if all 5 steps are ready; in fact step 4 is hand-wave + throw. A reader needs to know what's pavement and what's marsh BEFORE they invest 30 minutes.
11. **Front-matter — drop one of the 4 repeats of "no OEM by design".** The first paragraph + the boxed "> Why no OEM role?" callout at line 46 cover it. The second mention at line 25 ("there is no `oem`...") is redundant. The §"What this is NOT" reprise at line 262 is the 4th. One should go.
12. **Line 5** (`Branch HEAD when this doc was written: c5de9be (April 24, 2026)`): HEAD is now `91cd842`. Either auto-update via release-please or drop the pin.

---

## Resume note for next validator

The doc is structurally sound but suffers from **stale-after-rename**: `@pcc/store` → `@pcc/db` happened, doc didn't follow. Plus the `buildPayoutMap` stub is the load-bearing failure point — the entire "5-command quickstart" reads as ready but stops dead at step 4. Fix that one path and the doc goes from 5/10 to 7-8/10.
