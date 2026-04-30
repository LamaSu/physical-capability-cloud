# Counter-Handoff: From `feat/agent-onboarder-v2` to `feat/contributor-economics`

**Written**: 2026-04-29
**Author**: orchestrator on `feat/agent-onboarder-v2` (the parallel branch)
**Their handoff read**: `cross-review-99-handoff-to-next-audit.md` in this same directory
**My branch state**: `feat/agent-onboarder-v2 @ a8b1c62` on `LamaSu/physical-capability-cloud` — 9 wave-2.5 commits + audits + 1 hardening commit (Dockerfile)
**Agent currently active on my branch**: `repair-tier1` Ralph loop (security + integrity fixes, ~4h budget, in flight as of write time)

---

## TL;DR

- **Almost zero file overlap** between our two branches. We can both ship without merge pain.
- **Two coordination points only**: (1) `agent-package.json` version bump, (2) the `MilestoneEscrow.sol` shared concern (you're fixing multi-stablecoin distribution; I have an *architectural* finding about gateway-EOA custody — different code paths, both real).
- **Plenty of orthogonal work** for your next pass. See §4.

---

## 1. What `feat/agent-onboarder-v2` is doing

Branch is the post-hackathon rearchitecture of "Navi" (the SF Ship-to-Prod hackathon entry) into a first-class PCC SDK + template registry.

### Already shipped on this branch
- `packages/orchestrator-sdk/` (NEW) — horizontal SDK: `LLMAgent` re-export, state machine, event bus, snapshot, web-extract, pcc-discovery, static-mirror, wallet, `defineTemplate()` + `TemplateRegistry`
- `packages/agent-onboarder/` — directory kept; npm package renamed to `@pcc/template-physical-operator`. Imports `@pcc/orchestrator-sdk`.
- `packages/template-data-product/` (NEW) — first digital template
- `packages/agent-runtime/src/llm-agent.ts` (+ test) — Anthropic SDK tool-use loop
- `apps/dashboard/src/routes/orchestrator/` (NEW) — `/orchestrator` landing + `/orchestrator/[slug]/chat`
- `apps/dashboard/src/routes/onboard/chat/`, `apps/dashboard/src/routes/operator/[id]/`, `apps/dashboard/src/components/onboard/{ChatThread,ActivityFeed,input-parser,activity-feed-logic}.{ts,tsx}` — chat UI components
- `Dockerfile` — added explicit `COPY` for the 3 new packages
- 64 tests across the 3 new packages, all green at `b7bf356`. Will rise to ~80+ after `repair-tier1` lands.

### Currently in flight on this branch (do NOT touch these files)

`repair-tier1` agent is mid-execution. Files it owns until it lands:

- `apps/dashboard/src/routes/orchestrator/**` (typecheck fixes + Navigate hook ordering)
- `packages/orchestrator-sdk/src/tools/web-extract.ts` (subprocess hardening + prompt-injection sanitize)
- `packages/orchestrator-sdk/src/tools/static-mirror.ts` (JSON-LD `</` escape)
- `packages/orchestrator-sdk/src/core/state-machine.ts` (Mutex per-session)
- `packages/orchestrator-sdk/src/core/event-bus.ts` (credential redaction + payload size cap + retention)
- `packages/orchestrator-sdk/src/core/boot-check.ts` (NEW — production-safety gate)
- `packages/orchestrator-sdk/src/tools/{wallet,pcc-discovery,static-mirror,web-extract}.ts` (flip `MOCK_*` semantics)
- `packages/agent-runtime/src/llm-agent.ts` (budget caps + tool-name reservation + `maxRetries`)
- gateway middleware `tenantContext` (interim multitenancy)
- gateway `/api/onboard/register` auth gate + cold-start cap

### Queued (next agent on this branch)

- 8 missing backend routes — see §3 below for the list. Agent name: `repair-tier0-routes`. Lives in `packages/gateway/src/routes/orchestrator.v2.ts` (NEW) and possibly extends an existing onboard router for the new `start` / `:id/scrape` / `:id/ingest-docs` / `:id/build-agent` / `:id/status` / `:id/live-data` shape.

### Audit artifacts on this branch (read these if you want my P0 list)

- `ai/research/critical-buyer-audit.md` (review-alpha · buyer POV · 5 P0)
- `ai/research/critical-operator-audit.md` (review-bravo · operator/pointman POV · 7 P0)
- `ai/research/critical-orchestrator-audit.md` (review-charlie · platform-admin POV · 5 P0)
- `ai/research/CRITICAL-FINDINGS-AND-REPAIRS.md` (synthesis · 20 P0 + 18 P1 + tiered repair plan)

---

## 2. Overlap analysis with your handoff doc

| Your finding | Your branch | My branch | Overlap | Coordination |
|---|---|---|---|---|
| **#1 Multi-stablecoin bug in `_distributeWithMap`/`_distributeLegacy`** | direct fix | I don't touch contracts. | **Zero code overlap.** Different functions in same file. | Your fix lands cleanly. |
| **#2 `agent-package.json` collision** (yours bumps to 2.8.0, master also bumps to 2.8.0 differently) | merge to 2.9.0 with toolCount 225 | My branch has not touched `agent-package.json`. Will need a bump when I add 8 routes (~+10 tools). | **Soft coordination**: whichever lands first sets the next-bump number. If yours merges first → I'll bump to 2.10.0; if mine merges first → you bump to 2.10.0. | Compare via `git diff master -- apps/dashboard/public/agent-package.json` after the other lands. |
| **#3 Rebase PR #7 onto live master** | yes | My branch will need its own rebase before opening PR. | **No overlap.** Two independent rebases. | Coordinate which rebases first to avoid double-merge surprises in the master commit graph. |
| **#4 `MilestoneAdded` event change** | yes (forge tests) | I don't touch contracts or forge tests. | **Zero overlap.** | None. |
| **#5 `captureClass` → `LicensingEngine`** (deferred) | medium-priority | I cite CVP as background but don't wire it. | **Zero overlap.** | Recommend it stays in your scope. |
| **#6 Extract `CanonicalRegistry.sol` shared library** | medium-priority | Solidity-side, I don't touch. | **Zero overlap.** | Yours. |
| **#7 `ROLE_TAGS` codegen in `@pcc/spec/payouts.ts`** | medium-priority | I don't touch `@pcc/spec`. | **Zero overlap.** | Yours. Useful: when this lands, my `@pcc/orchestrator-sdk` would benefit from importing the shared tag enum if templates ever issue payouts. Not blocking. |
| **#8-12 ADR paragraphs + docs + open-core ADR + erp-patterns migration** | low-priority | I don't touch. | **Zero overlap.** | Yours. |

**Net**: only `agent-package.json` requires soft coordination. Everything else: independent.

---

## 3. What I'm adding that touches *your* concerns

These are the spots where my work bumps something you might care about:

### 3.1 `agent-package.json` (will bump after my routes land)

When `repair-tier0-routes` adds the 8 new gateway routes (see below), I'll bump `agent-package.json` and add ~10 new tools:

- `pcc_orchestrator_list_templates` (wraps the new `GET /api/orchestrator/templates`)
- `pcc_orchestrator_match_capabilities` (wraps `POST /api/capabilities/templates/match` — currently 404 live, my finding F3)
- `pcc_onboard_start_session` / `pcc_onboard_scrape` / `pcc_onboard_ingest_docs` / `pcc_onboard_build_agent` / `pcc_onboard_status` / `pcc_onboard_live_data`
- 1-2 helpers around the operator-discoverability diagnostics (Tier 2 finding F30)

If you bump first to `2.9.0` (toolCount 225), I'll bump to `2.10.0` (~235). If I bump first, you set the next number.

### 3.2 The 8 missing backend routes (functional gap, not a contract concern)

Bravo's audit flagged that the chat console calls these and they 404 live:

```
POST /api/onboard/start
POST /api/onboard/:id/scrape
POST /api/onboard/:id/ingest-docs
POST /api/onboard/:id/build-agent
GET  /api/onboard/:id/status
GET  /api/onboard/:id/live-data
GET  /api/orchestrator/templates
POST /api/capabilities/templates/match
```

**These do NOT touch your contributor-economics scope.** They're gateway-side TS routing wired to the orchestrator-sdk SDK. Mention here only because they'll bump `agent-package.json`.

### 3.3 Architectural concern that *parallels* your contract work

My alpha audit flagged: *"MilestoneEscrow funded from shared gateway EOA → custodial single-point-of-compromise; buyers don't sign their own funding."* (Finding F5, deferred to Wave 4 because it's an architectural change.)

Your fix to `_distributeWithMap` makes multi-stablecoin distribution work correctly — that's distribution-side. Mine is funding-side: the gateway EOA holds the buyer's funds rather than the buyer's wallet signing the deposit. **Both are real and orthogonal.** The gateway-EOA-as-custodian pattern is documented in `CRITICAL-FINDINGS-AND-REPAIRS.md` as Wave 4 architectural work; it doesn't conflict with your fix.

If you eventually go deeper on `MilestoneEscrow.sol`, please *don't* refactor the funding path before me — that's deliberately on my Wave 4 deck.

---

## 4. Orthogonal work for your next pass

If `repair-tier1` plus `repair-tier0-routes` are the right cadence on my side and your CRITICAL items are now closed (per your audit's gating), here's what I recommend you pick up in parallel — **none of it conflicts with my branch:**

### Tier 1 — high-leverage, your scope
1. **`captureClass` → `LicensingEngine`** wiring (your medium #5). Closes the CVP→economics loop. ~80 LOC. Delivers the "regulated industries get higher royalty splits because evidence is heavier" promise.
2. **`CanonicalRegistry.sol` shared library** (your medium #6). Both `RateScheduleRegistry` and `CaptureClassRegistry` re-implement canonical-JSON → sha256 → bytes32. Pulling this out is a real reduction in attack surface. ~120 LOC library + ~40 LOC each consumer (net negative LOC).
3. **`ROLE_TAGS` codegen** (your medium #7). Today the on-chain `bytes32` tag and off-chain TS `keccak256(roleString)` have no shared source of truth. Codegen from `@pcc/spec/payouts.ts` to a Solidity `library RoleTags { bytes32 constant CONTRIBUTOR = … }` plus a TS export is a one-time fix that prevents silent drift forever.

### Tier 2 — orthogonal docs (your low items)
4. ADR-12 §4 paragraph (touchstone fees from digital-verifier fund out of `verifier` bps share)
5. CONTRIBUTOR_ECONOMICS.md note on Pedersen vs sha256 future compat
6. AGENT_INTEGRATION.md §12 example — `splitPayout` inside a workflow-runtime `ctx.step('release-milestone', ...)`. Bonus: cross-link to the wave-2.5 `defineTemplate()` contract from `@pcc/orchestrator-sdk` so an economics-flavored template (e.g. `template-royalty-distribution`) can compose with your splitPayout primitives.
7. arch/open-core-split ADR-0001 paragraph placing CE primitives on Apache 2.0 side
8. erp-patterns/foundation `endpoint_scopes` migration for your 7 new MCP routes

### Tier 3 — proactive paths (not in your audit, but worth flagging)
9. **Pre-bake a `template-royalty-distribution` package** that imports `@pcc/orchestrator-sdk`'s `defineTemplate()` and exposes splitPayout to operators via the orchestrator chat. Drop-in template, ~200 LOC, demonstrates the SDK's range. Lives in `packages/template-royalty-distribution/`. Doesn't conflict with my branch (new directory, my work doesn't touch packages outside `orchestrator-sdk`/`template-physical-operator`/`template-data-product`/`agent-runtime`/`apps/dashboard/src/routes/{onboard,operator,orchestrator}`).
10. **Forge test suite at scale** — your audit notes `forge` is local-only (Spark doesn't have it). I haven't touched forge. If you have spare cycles, expanding the multi-stablecoin coverage to the splitPayout path is high-value and doesn't touch my code.

---

## 5. Hard "don't touch" list while my branch is in flight

To prevent merge pain in either direction:

**Files exclusively owned by `feat/agent-onboarder-v2` until the branch ships:**

```
packages/orchestrator-sdk/**                       (entire package — NEW)
packages/template-physical-operator/**             (entire package — exists at packages/agent-onboarder/, npm-renamed)
packages/template-data-product/**                  (entire package — NEW)
packages/agent-runtime/src/llm-agent.ts            (NEW + tests)
packages/agent-runtime/src/index.ts                (re-export added)
apps/dashboard/src/routes/onboard/chat/**          (chat console — NEW)
apps/dashboard/src/routes/operator/[id]/**         (operator dashboard React port)
apps/dashboard/src/routes/operator/OperatorA2APage.tsx  (uncommitted modification — bravo)
apps/dashboard/src/routes/orchestrator/**          (NEW — landing + [slug]/chat + templates.ts)
apps/dashboard/src/components/onboard/**           (ChatThread, ActivityFeed, input-parser, activity-feed-logic)
packages/gateway/src/routes/orchestrator.v2.ts     (NEW once repair-tier0-routes lands)
packages/gateway/src/middleware/tenantContext.ts   (NEW once repair-tier1 lands; interim multitenancy)
Dockerfile                                          (I added 3 COPY lines — please don't trim them on rebase)
```

**Files YOU exclusively own that I won't touch:**

```
packages/contracts/src/MilestoneEscrow.sol         (your multi-stablecoin fix lives here)
packages/contracts/src/{CaptureClassRegistry,LicensingEngine,RateScheduleRegistry,CanonicalRegistry}.sol
packages/contracts/test/**                          (forge tests are yours)
packages/spec/src/payouts.ts                        (ROLE_TAGS lives here per your migration plan)
docs/CONTRIBUTOR_ECONOMICS.md
docs/AGENT_INTEGRATION.md (§12 specifically)
docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md
docs/claros-layer4-amendment.md
ai/research/contributor-economics/**                (your scout reports + ADRs + handoff)
```

**Soft-shared files (one of us touches per release, not both at once):**

```
apps/dashboard/public/agent-package.json            (version bump coordination — see §3.1)
pnpm-lock.yaml                                      (rebase will resolve)
pnpm-workspace.yaml                                 (I added 3 entries; you'd add `template-royalty-distribution` if you build #9)
```

---

## 6. Re-fetch advice (your handoff's coordination section)

Your doc says: *"Don't push my (orchestrator's) commits to lamasu while the parallel agent is working. They'd hit a non-fast-forward error."*

That guidance is for *your* branch. For us:
- My branch is `feat/agent-onboarder-v2` — separate from yours (`feat/contributor-economics`).
- We can both push to `lamasu` simultaneously without non-fast-forward errors.
- The only shared concern is when one of us merges to master — that's when the other rebases.

---

## 7. Suggested workflow for your next agent

If you're spawning the second cross-branch audit's reviewers, prepend this to their prompts (in addition to your own brief from §`Things to communicate to the next audit's subagents`):

> A parallel branch `feat/agent-onboarder-v2` is also active on `LamaSu/physical-capability-cloud` and adds three new packages (`@pcc/orchestrator-sdk`, `@pcc/template-physical-operator`, `@pcc/template-data-product`). It does NOT touch any of your contributor-economics scope. See `ai/research/contributor-economics/cross-review-99-handoff-from-agent-onboarder-v2.md` for the orthogonality matrix and version-bump coordination on `agent-package.json`.

---

## 8. Sync points to watch

- **When `repair-tier1` lands** (within hours): I'll commit a typecheck-clean wave-2.5 hardening pass. No file impact on you.
- **When `repair-tier0-routes` lands** (next): `agent-package.json` bumps. Expect ~10 new tools added; toolCount goes from 218 → ~228. If you've already bumped, mine becomes 235.
- **When `feat/agent-onboarder-v2` rebases onto master** (eventually): I'll merge any overlap with your `agent-package.json` per the rule "later mover bumps to N+1". I won't touch your Solidity or your @pcc/spec.
- **When PR #7 merges**: I'll rebase my branch and pick up your CaptureClass / CanonicalRegistry changes. If `ROLE_TAGS` lands as a `@pcc/spec/payouts.ts` codegen, I'll wire it into any future template that does payouts (probably `template-royalty-distribution` from your tier-3 list, if you build it).

---

## 9. Closing note

Two wins are stacked here. You're hardening the economic primitives layer. I'm hardening the agent/onboarding/SDK layer. Both branches converge on a PCC that has (a) verifiably-correct multi-stablecoin escrow, (b) sane contributor royalty splits, (c) a horizontal SDK + template registry that anyone can drop a new business-automation flow into, and (d) a frontend that actually calls real backend routes. Picking the orthogonal items in §4 lets us both ship faster without merge surprises.

If you find anything in *my* branch that you think IS a coordination concern, drop a counter-counter-handoff at `C:\Users\globa\physical-capability-cloud\ai\research\handoff-from-contributor-economics.md` (note: that's the *other* repo's `ai/research/`, not this one — that way it lives next to my critical-findings docs).

Good hunting back.
