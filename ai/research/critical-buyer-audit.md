# Critical Buyer-Side Audit — Physical Capability Cloud

**Auditor:** review-alpha
**Date:** 2026-04-24
**Persona:** Buyer / job-poster (someone who needs work done and wants to discover + hire an operator)
**Scope:** read-only audit of `physical-capability-cloud` (branch feat/agent-onboarder-v2, v2/v2.5)
**Live target probed:** https://capability.network (production, Railway)

---

## Executive summary

**The buyer flow does not exist as a coherent product surface today.** PCC has been built operator-first, with rich onboarding and operator-side automation. There is no buyer-side discovery UI for the canonical job-posting scenario ("I need 12 titanium aerospace brackets, ±0.001\" tolerance, by Tuesday"). The few endpoints that look buyer-facing return empty, broken, or operator-mocked data when probed live.

**Concretely, as of 2026-04-24:**

1. Live `/api/capabilities` returns **1** capability (the HP printer demo). Live `/api/capabilities/search?q=titanium` returns **0** items. No CNC, no aerospace, no titanium operator exists on-chain.
2. The advertised buyer endpoint `/api/capabilities/templates/match` referenced in the audit task does **not exist** — `WebFetch` returns `{"error":"not_found"}`. Its real cousin, `/api/capabilities/templates`, returns 10 unranked templates with no buyer-side ranking, no capacity check, no compound query support.
3. The dashboard's `MarketplacePage` is **100% mock data** (`mockEquipmentClasses`, `mockMarketSnapshots`, `mockGeoMarkers`, `mockPriceHistory`) — buyers never see real demand/supply.
4. The dashboard's `DiscoverPage` filters client-side over `useCapabilityTemplates()` (which returns the 10 templates) and is hard-coded to **lab capability types only** (`hplc`, `pcr`, `microscopy`, `mass-spec`, `sequencing`, `cell-culture`) — a buyer searching for `cnc-3axis` or `fdm` cannot filter by type at all.
5. There is **no buyer chat surface**. `/orchestrator` is operator template-onboarding chat. `/operator/[id]` is the per-operator quote page that already requires the buyer to know an operator session ID — there is no link from any "search for operator" UI to this page.
6. The MilestoneEscrow's only fund path goes through a **single shared gateway-owned EOA** (`0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B`, base-sepolia). All buyers fund from this address. There is no per-buyer wallet binding, no signature requirement on `/api/escrow/chain/:address/fund`, and no per-IP fund-rate-limit. That makes the gateway both a custodian and a single point of compromise.

**Top severity:** the buyer experience is conceptually a **dead end** — the discovery UI works in theory but has no operators to surface, the match endpoint is missing, and the fund pathway has architectural problems. Until v2.5 lands a real buyer chat (an "I need X" → ranked list → click-through to negotiate flow) **and** the discovery index has at least 5+ live operators across diverse capability types, no agent or human buyer will be able to drive a job to completion without going around the dashboard via direct API + handwritten kernel IDs.

---

## Buyer flow as documented vs as built

| Step | As documented (CLAUDE.md / agent-package) | As actually built |
|------|--------------------------------------------|--------------------|
| 1. Buyer types job spec | Implicit ("I need 12 titanium brackets…") | No UI surface accepts free-text job specs from a buyer; only `/orchestrator/[slug]/chat` exists, and that's for operator template onboarding |
| 2. Discovery match | `GET /api/capabilities/templates/match`, `pcc_dht_query`, `match_spaces` | `/api/capabilities/templates/match` is **404**. `/api/capabilities/search` works but indexed against 0–1 capabilities. `match_spaces` exists for hosting (not for jobs). |
| 3. Ranked operators returned | With `cvp_attestation_uri`, `x402_quote_url`, ERC-8004 reputation | None of these fields appear in `CapabilityDTO` — only `reputation` (0-1000), `queueDepth`, `available` |
| 4. Buyer picks operator → hits /jobs | `/jobs?op=...` query param shape | `/operator/[id]` page reachable only by direct URL; no list-of-operators UI links to it |
| 5. x402 negotiation | HTTP 402 → payment | Negotiation is `/api/negotiate/session` (positive-path 5-state machine). HTTP-402 is an env-flag in `x402-gate.ts` middleware on `/api/capabilities/search` ($0.001 per query) — but I could not find evidence of buyer-facing 402 challenge for `/api/jobs/submit`. |
| 6. Settlement on Base Sepolia | MilestoneEscrow + USDC | The escrow contracts work. But fund is gateway-EOA only. No per-buyer wallet flow. |
| 7. Reputation updated | ERC-8004 | `pcc_get_reputation` MCP tool exists but I saw no path from a completed buyer-job to a reputation write. |

---

## Scenarios

### 1. Happy-path discovery
**Buyer goal:** "I need 12 titanium brackets, ±0.001\" tolerance, delivery by Tuesday."
**System today:** No UI accepts this. The closest paths: `/discover` (filters lab-only types), `/marketplace` (mock data + click into mock equipment classes), `/operator/:id` (only if buyer already knows the ID).
**What breaks:** The buyer never reaches an operator. They bounce between three half-built buyer-shaped pages, none of which have a "find me a Ti CNC operator" CTA.
**Severity:** P0
**Fix:** Ship a single buyer chat at `/buy` (or repurpose `/orchestrator/buyer/chat`) that POSTs free-text to a new `/api/match` endpoint backed by the existing `CapabilityFacade.search` plus an LLM intent-extraction step. File: `apps/dashboard/src/pages/` + `packages/gateway/src/routes/match.ts` (new).

### 2. Multi-criteria match (material AND tolerance AND certification)
**Buyer goal:** Filter by Ti-6Al-4V + ±0.001\" + AS9100.
**System today:** `/api/capabilities/search?q=` is single-string FTS over `name`/`type`/`materials`. No compound-AND. `tolerances` and `certifications` are NOT in the search index. The `DiscoverPage` UI has a single text box plus 6 lab-only type filters. No tolerance or cert filter exists in either the API or the UI.
**Severity:** P0
**Fix:** Add `material`, `tolerance`, `certification`, `assuranceTier`, `location` fields to `/api/capabilities/search` query string. Add corresponding filter chips to `DiscoverPage`. Files: `packages/gateway/src/facades/capability.facade.ts`, `apps/dashboard/src/pages/DiscoverPage.tsx`.

### 3. No-match
**System today:** `/api/capabilities/search?q=nonsense` returns `{"items":[],"total":0}`. The dashboard `DiscoverPage` shows an `EmptyState` with action `"Register a Kernel"` (operator CTA, wrong audience for buyers). There is no "post a bounty," "subscribe to alert," or "request via DHT" path.
**Severity:** P1
**Fix:** When the buyer search returns zero matches, route them to `/api/bounty/*` to post a demand signal (existing endpoint), and to `/api/dht/announce` to broadcast a discovery query. Files: `apps/dashboard/src/pages/DiscoverPage.tsx` + new `BuyerEmptyState` component.

### 4. Stale data
**System today:** `KernelDTO` has `isStale = true` when heartbeat >5min while `status="online"`. `CapabilityDTO.kernelStatus` carries this. But `CapabilityFacade.search` does NOT filter stale entries by default. A buyer can match an operator whose kernel hasn't heartbeat in days. The DHT TTL is `3600s` (one hour) per `pcc-discovery.ts` — operators who never re-announce stay surfaced after their devices are offline.
**Severity:** P2
**Fix:** Default `CapabilityFacade.search` to `kernelStatus !== "stale" && kernelStatus !== "offline"`. Add an `?includeStale=true` opt-in. Files: `packages/gateway/src/facades/populators/capability.populator.ts`, `packages/gateway/src/facades/capability.facade.ts`.

### 5. Fake / spam operator
**System today:** `/api/onboard/register` is **completely open** (no auth, per `pcc-discovery.ts` comment line 5). Registration body uses a hard-coded `walletAddress: "0x0000…0000"` if not provided — meaning anyone can spam fake registrations from any IP. The cold-start gate (`reputation-service.ts`) GIVES NEW OPERATORS A BONUS (+30/job for first 19 jobs, max +570) instead of restricting them. `applyColdStartGate` is opt-in (`ctx.applyColdStartGate=true`) and I see no callsite that enables it for buyer-facing discovery.
**Severity:** P0
**Fix:** Require API-key auth on `/api/onboard/register` (or per-IP rate-limit, currently only `/api/auth/provision` rate-limits at 5/hr). Default `applyColdStartGate=true` for buyer-facing populators. Add a sybil-resistance signal (require email-verified + at least 1 successful tier-0 test job before the operator appears in `/api/capabilities`). File: `packages/gateway/src/routes/onboard.ts`, `packages/gateway/src/facades/types.ts`.

### 6. Buyer pays, operator vanishes
**System today:** MilestoneEscrow has a `challengeWindow` and a `disputes` mapping, but the dispute flow requires **filing a bond in the same token** during the challenge window AND there is no `automatic refund on operator no-show` path. The `Dispute` struct refers to an `arbiter` role — the deploy script chooses this address, and there is no on-chain governance over arbiter selection. If the operator never submits an attestation, the funds are LOCKED until the arbiter intervenes off-chain.
**Severity:** P1
**Fix:** Add a `MilestoneEscrow.refundOnTimeout(uint256 milestoneIndex)` callable by the buyer when `block.timestamp > deadline + grace_period` AND no attestation submitted. File: `packages/contracts/src/MilestoneEscrow.sol` (new function + tests).

### 7. Operator delivers, buyer disputes
**System today:** `/api/escrow/chain/:address/dispute/:milestoneIndex` posts on-chain with a `challengerBond`. The `arbiter` (a single EOA configured at deploy) resolves. There is no UI for filing a dispute. There is no UI for tracking arbiter decisions. `EscrowSummaryDTO` returns `disputedCount` but no per-dispute detail. The arbiter is **off-chain trust**, not a multisig or a verifier-network.
**Severity:** P1
**Fix:** Build `/escrow/:id/dispute` UI in `EscrowPage.tsx`. Make the arbiter a Gnosis Safe or `VerifierRegistry`-governed multisig. File: `packages/contracts/src/MilestoneEscrow.sol` arbiter-set logic + `apps/dashboard/src/pages/EscrowPage.tsx`.

### 8. Buyer agent picks the wrong operator
**System today:** No feedback signal. The `reputation-service.ts` has scoring functions but no route exists for the buyer to rate a completed job. There IS `/api/templates/capabilities/:id/rate` for template ratings (1-5), but that rates the *template*, not the operator. Buyers cannot down-rank an operator who delivered substandard work.
**Severity:** P1
**Fix:** Add `POST /api/operators/:operatorId/feedback` with the buyer's signed attestation. Wire the score into `reputation-service.ts` updates. File: `packages/gateway/src/routes/feedback.ts` (extends existing).

### 9. Cost surprise
**System today:** Pricing is computed in `quote-logic.ts` (operator-side) and `pricing-rules.ts` (kernel-side). Gas, x402 facilitator fee, and the 2.35% protocol fee on the smart contract are NOT shown in any UI breakdown. The buyer sees `total: $X USDC` (e.g. on `OperatorA2APage` line 422) and clicks "Lock $X USDC" — the actual on-chain charge is X * 1.0235 + gas, paid by the gateway EOA, with no consent mechanism for the buyer.
**Severity:** P2
**Fix:** Add a `quote-breakdown` section showing `{base, protocolFee, estimatedGas, total}` before the lock-escrow CTA. File: `apps/dashboard/src/routes/operator/OperatorA2APage.tsx` line ~410.

### 10. Buyer agent hits stale cache
**System today:** `/api/capabilities/:id/button` sends `Cache-Control: public, max-age=60` (line 191 of `capabilities.ts`). The DHT announce TTL is `3600s`. There is no cache-busting key tied to capability mutation timestamps. A buyer agent fetching capabilities twice in 60 seconds sees stale `available`, `queueDepth`, `estimatedWaitMinutes`. Worse: edge-cached at Cloudflare in front of Railway.
**Severity:** P2
**Fix:** Replace `max-age=60` with `s-maxage=10, stale-while-revalidate=30`. Add `ETag` based on capability `updatedAt`. File: `packages/gateway/src/routes/capabilities.ts` line 191.

### 11. Side-by-side comparison
**System today:** No comparison UI exists. The buyer would need to open multiple tabs of `/operator/[id]/...` since there is no list-view-with-checkbox.
**Severity:** P3
**Fix:** Add `/discover/compare?ids=a,b,c` route that fetches all selected capabilities and renders a comparison table. File: new `apps/dashboard/src/pages/CompareCapabilitiesPage.tsx`.

### 12. Custom negotiation (price/timeline)
**System today:** `/api/negotiate/session` is a 5-state machine that's actually well-built — but no buyer-facing UI exposes it. `NegotiationPage.tsx` is operator-side mock data (`MOCK_PROPOSALS`). The `/api/negotiate/session/:id/commit` endpoint is wired but reachable only via direct API call.
**Severity:** P1
**Fix:** Build a `BuyerNegotiationPage.tsx` that lets the buyer create a session, set custom params, request a counter-quote, and commit. File: new `apps/dashboard/src/pages/BuyerNegotiationPage.tsx` + `App.tsx` route.

### 13. Recurring jobs
**System today:** No "subscribe" or recurring contract. Each job is one-shot via `/api/jobs/submit`. No cron-based job submission, no template "run weekly" flag. Buyers wanting weekly batches must script the API themselves.
**Severity:** P3
**Fix:** Add `/api/jobs/recurring` with cron-string and parent-template-id. File: new `packages/gateway/src/routes/recurring-jobs.ts`.

### 14. Buyer is itself an agent
**System today:** Discovery API (`/api/capabilities/types`, `/api/capabilities`) is PUBLIC (no auth) — the agent doesn't need a key to list. But to actually submit a job, an agent needs `Authorization: Bearer pcc_live_...`. The provision endpoint is rate-limited (5/IP/hr). Per-key rate-limit defaults to 100 req. There is no cost-per-discovery-query — the x402 gate on `/api/capabilities/search` charges $0.001 USDC per query, which **doesn't appear to be enforced** when I probed (returns 200 with empty items, no 402).
**Severity:** P2
**Fix:** Confirm x402 enforcement is actually deployed. Document agent-rate-limit defaults in `agent-package.json.system_prompt`. File: `packages/gateway/src/middleware/x402-gate.ts` (verify), `apps/dashboard/public/agent-package.json` (document).

### 15. Privacy of job spec
**System today:** Job specs go to `/api/jobs/submit` in plaintext JSON. Discovery queries hit `/api/capabilities/search?q=titanium+aerospace` — that query string lands in the gateway's audit log (`audit-service.ts`). Lit Protocol encryption exists for *evidence bundles* (per CLAUDE.md `LIT_PROTOCOL_REAL` env), not for job specs. No "encrypted spec" path exists.
**Severity:** P1 (for B2B / confidential CAD use cases)
**Fix:** Add an `encryptedSpec: string` field to `/api/jobs/submit`, decrypted only by the matched operator's Lit-derived key. File: `packages/gateway/src/routes/jobs.ts`, `packages/spec/src/job.ts`.

### 16. Geographic constraint
**System today:** `KernelDTO` has `location: {lat, lng}`. The search API does NOT support `?near=lat,lng&radiusKm=N`. The DHT announce doesn't include geo. Buyers wanting EU-only operators must filter client-side after fetching everything.
**Severity:** P2
**Fix:** Add `?near=&radiusKm=&country=` to `/api/capabilities/search`. Add geographic constraint to DHT announce + DHT query schema. File: `packages/gateway/src/facades/capability.facade.ts`.

### 17. Compliance constraint (ITAR / FAR / HIPAA / AS9100)
**System today:** `CapabilityDTO.tags` and `MachineRegistration.operator.certifications` exist but are unstructured strings. No formal taxonomy. No filter in `/api/capabilities/search`. The `OperatorA2APage` shows certifications as visual pills (line 311) but doesn't gate quoting on them. A buyer requiring AS9100 cannot enforce that filter.
**Severity:** P1 (regulated industries: aerospace, medical, pharma)
**Fix:** Add `compliance: string[]` (typed enum: `"ITAR"|"FAR"|"HIPAA"|"AS9100"|"ISO13485"|"ISO9001"|...`) to `CapabilityDTO`. Allow `?compliance=AS9100` in search. Validate on operator registration. File: `packages/spec/src/capability.ts`, `packages/gateway/src/routes/onboard.ts`.

### 18. Reputation manipulation / Sybil
**System today:** ERC-8004 reputation scores are referenced in `reputation-service.ts` but I see no on-chain anchor. Reputation is computed off-chain from job completion records. Cold-start bonus gives new operators +30/job for first 19 — a sybil attacker can spin up 100 fake operators, run their own buyer agents to "complete jobs" against them, accumulate 19 cold-start bonuses each = 19*30*100 = 57K reputation points across a fake network. Detection signal: same IP, same wallet pattern, same source. None appear monitored.
**Severity:** P0
**Fix:** Anchor reputation on-chain (e.g. EAS attestations on Base) tied to the buyer's wallet so that attacker-buyers must spend gas+USDC to fake job completion. Add IP-based + wallet-graph anomaly detection to the reputation service. File: `packages/gateway/src/services/reputation-service.ts`.

### 19. Edge cases on input
**System today:**
- **Empty input on `/api/capabilities/search?q=`:** returns `{capabilities: []}` (handled, line 109 of `capabilities.ts`).
- **Random text:** FTS5 search runs, returns 0 — fine.
- **SQL injection:** facades use parameterized queries via Drizzle ORM — likely safe but not explicitly audited for buyer-facing endpoints.
- **Huge payload on `/api/jobs/submit`:** I saw no `bodyLimit` setting per route. Fastify default is 1MB. A buyer dropping a 50MB CAD file as `params.cad_data` would 413 — fine. But there's no STL file upload path (yet).
- **NoSQL injection / prototype pollution:** request body is `as DisputeInput` etc — TypeScript casts are not runtime guards. Requests with `__proto__` payloads go straight into facade methods.
**Severity:** P1
**Fix:** Add Zod validation at every gateway route entry. File: every route file under `packages/gateway/src/routes/`.

---

## Cross-cutting friction inventory

**Click count from "I have a job" to "I have a quote" — for a human buyer:**
1. Land on https://capability.network → see landing page (operator-focused CTA: "Register your equipment").
2. Try `/discover` → search "CNC titanium" → 0 results, lab-only filters useless.
3. Try `/marketplace` → see mock data, click "FDM 3D Printer" tile → land on mock detail page.
4. Realize buyer flow doesn't exist → leave or go to `/agent-package`.
5. Read `agent-package.json` → understand the protocol → write a curl script.
6. `POST /api/auth/provision` (rate-limited 5/hr).
7. `GET /api/capabilities/search?q=cnc` → empty.
8. `GET /api/capabilities/types` → 10 types.
9. `GET /api/kernels` → 1 kernel (HP printer).
10. Give up.

**Total: 10 steps. Zero quote.** The dashboard is not a viable buyer surface today.

**For an agent buyer:**
- Tool budget: discovery alone burns ~5 calls (templates, search, kernels, by-type, agent-package).
- Timeout: no streaming/SSE for long-running discovery (no `/sse/stream/discovery`).
- Retry semantics: agent-package doesn't say. Per-key rate limit = 100/sec default.
- Mobile: dashboard is responsive (Tailwind breakpoints) but `OperatorA2APage` uses a 60vh chat height that breaks on small viewports.

**For an LLM agent buyer at the agent-package level:**
- 219 tools listed but only 5 directly buyer-relevant (`search_capabilities`, `pcc_dht_query`, `match_spaces`, `pcc_calculate_price`, `pcc_build_contract`).
- The buyer-flow narrative in `agent-package.json.system_prompt` mentions "Capabilities & Discovery" + "DHT & P2P Discovery" but does NOT include a worked example of "given my job spec, find me an operator" (only worked example is for operator self-onboarding).

---

## Critical findings (severity-ranked)

### [P0] No buyer discovery UI surface
**Symptom:** Buyer cannot search for operators. `/discover` is lab-only, `/marketplace` is mock-only, `/operator/[id]` requires knowing the ID.
**Root cause:** v2.5 reframe shipped operator-onboarding chat (`/orchestrator/[slug]/chat`) but no buyer-equivalent.
**Repair:** Add `/buy` route + `BuyerChatPage.tsx` mirroring the `OrchestratorChatPage` pattern but POSTing to a new `/api/match` endpoint that wraps `CapabilityFacade.search` plus LLM intent extraction. Files: `apps/dashboard/src/pages/BuyerChatPage.tsx` (new), `apps/dashboard/src/App.tsx` (add route), `packages/gateway/src/routes/match.ts` (new).
**Effort:** 1-week (with intent-extraction LLM prompt + ranking).

### [P0] `/api/capabilities/templates/match` is 404
**Symptom:** The architecture documentation references this endpoint as the buyer match path. It returns `{"error":"not_found"}` live.
**Root cause:** Endpoint never implemented; only `/api/capabilities/templates` (list) and `/api/capabilities/search?q=` (FTS) exist.
**Repair:** Implement `POST /api/capabilities/templates/match` with body `{description: string, materials?: string[], tolerances?: ToleranceSpec, certifications?: string[], deliveryDeadline?: string, location?: {near, radiusKm}}` returning `{matches: CapabilityDTO[], confidence: number, explanation: string}`. File: `packages/gateway/src/routes/match.ts` (new).
**Effort:** 1-week (includes LLM ranker + spec-Zod schema + fixture-test of "12 titanium brackets" → ranked list).

### [P0] Discovery index has 1 capability live
**Symptom:** No operators on PCC except the HP printer demo. Buyer queries return empty.
**Root cause:** Operator onboarding works (v2.5 wave 1.3 `agent-onboarder-v2`), but no real operators have onboarded. Marketing/seeding gap, not a code gap.
**Repair:** Run a seed-operator campaign. Onboard 5+ shops across diverse capability types (CNC, FDM, laser, document printing, lab) with at least 1 successful tier-0 test job each. Use `pcc-node` CLI from `docs/AGENT_INTEGRATION.md` §13.
**Effort:** 1-day per operator + outreach.

### [P0] Open `/api/onboard/register` enables sybil farming
**Symptom:** Anyone can register fake operator profiles unauthenticated, claim arbitrary capabilities and certifications, gain cold-start reputation bonuses up to 570 points.
**Root cause:** `/api/onboard/register` is the canonical "they exist on PCC" record per `pcc-discovery.ts:60`, with no auth gate.
**Repair:** Require `Authorization: Bearer pcc_live_*` on `/api/onboard/register`. Add per-IP rate limit (1/hr matching `/api/auth/provision`). Add wallet-uniqueness check. Default `applyColdStartGate=true` for buyer-facing populators. File: `packages/gateway/src/routes/onboard.ts`, `packages/gateway/src/middleware/security-hardening.ts`.
**Effort:** 1-day.

### [P0] MilestoneEscrow funded from shared gateway EOA
**Symptom:** All "buyer" escrow funds come from `0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B` (the gateway). Buyers don't sign their own funding txs. The gateway is a custodian. If its private key is compromised, all in-flight escrows are drained.
**Root cause:** `OperatorA2APage` calls `POST /api/escrow/fund` server-side with `{sessionId, amount}` — the gateway then signs+broadcasts. There's no SIWE flow tying the funding tx to the buyer's wallet.
**Repair:** Move funding to client-side wallet (wagmi `useWriteContract`). Gateway role becomes "build calldata + estimate gas" only. File: `apps/dashboard/src/routes/operator/OperatorA2APage.tsx` line 247 — replace `fetch /api/escrow/fund` with `wagmi.useWriteContract({address: escrowAddr, abi: MilestoneEscrowAbi, functionName: 'fund'})`. Also: rotate the gateway EOA's keys, since they've been live since deploy.
**Effort:** 1-week (includes wallet-connect UX + gas estimation + retry/cancel UX).

### [P1] Discovery search has no compound queries
**Symptom:** Buyer cannot filter by material AND tolerance AND certification. Only single-string FTS.
**Root cause:** `/api/capabilities/search?q=` is single-arg.
**Repair:** Extend to `?q=&material=&tolerance=&certification=&assuranceTier=&compliance=&near=&radiusKm=`. Add Zod schema. File: `packages/gateway/src/facades/capability.facade.ts`, `packages/gateway/src/routes/capabilities.ts`.
**Effort:** 1-day.

### [P1] No dispute UI for buyers
**Symptom:** `/api/escrow/chain/:address/dispute/:milestoneIndex` works on-chain, but no UI. Buyer must hand-craft the curl.
**Root cause:** `EscrowPage.tsx` shows escrow list/state but no dispute action.
**Repair:** Add "File Dispute" button with form (challengerBond, evidenceHash, reason). Surface during challenge window. File: `apps/dashboard/src/pages/EscrowPage.tsx`, new `DisputeFilingDialog.tsx`.
**Effort:** 1-week (includes evidence-hash upload UX + arbiter notification).

### [P1] No timeout-refund on operator no-show
**Symptom:** If operator never submits attestation, escrow funds are stuck until arbiter intervention.
**Root cause:** `MilestoneEscrow.sol` only releases on `block.timestamp >= challengeWindowEnd` AFTER an attestation. No path for "operator never attested → buyer refund."
**Repair:** Add `refundOnTimeout(milestoneIndex)` callable when `block.timestamp > deadline + grace_period && status == InProgress`. File: `packages/contracts/src/MilestoneEscrow.sol`.
**Effort:** 1-week (contract change + audit + redeploy + test fixtures + facade update).

### [P1] No buyer-side feedback / rating
**Symptom:** Buyer cannot rate an operator after job completion. Reputation purely comes from internal scoring.
**Root cause:** `/api/templates/capabilities/:id/rate` rates templates not operators. No `/api/operators/:id/rate` exists.
**Repair:** Add `POST /api/operators/:operatorId/feedback {jobId, score, comment}`. Wire into `reputation-service.ts`. File: `packages/gateway/src/routes/feedback.ts` (extends), `packages/gateway/src/services/reputation-service.ts`.
**Effort:** 1-day.

### [P1] Compliance / ITAR / AS9100 not filterable
**Symptom:** Buyer needing aerospace-certified shop cannot filter. Cert strings are unstructured.
**Root cause:** No typed enum, no search filter.
**Repair:** Typed `compliance: string[]` enum, search filter, registration validation. File: `packages/spec/src/capability.ts`, `packages/gateway/src/routes/onboard.ts`, `packages/gateway/src/routes/capabilities.ts`.
**Effort:** 1-week.

### [P1] x402 enforcement on discovery unverified
**Symptom:** `agent-package.json` advertises `$0.001 per query` x402 gate on `/api/capabilities/search` but live probe returned 200 with no 402 challenge.
**Root cause:** Possibly env-flag-gated or unconfigured in production.
**Repair:** Verify `x402-gate.ts` middleware is registered for production. Document the gate behavior in agent-package. File: `packages/gateway/src/middleware/x402-gate.ts`, `apps/dashboard/public/agent-package.json`.
**Effort:** 1-day.

### [P1] No structured intent extraction in agent flow
**Symptom:** Buyer agent receives 219 tool definitions but no worked example of "free-text spec → ranked operators." Burns tool calls trial-and-erroring search queries.
**Root cause:** `agent-package.json.system_prompt` describes operator-side onboarding flow only.
**Repair:** Add buyer-side workflow narrative: "Given a free-text job spec: 1) Extract material, qty, tolerance, deadline, certifications. 2) Call `/api/capabilities/templates/match` (when shipped). 3) For each match, call `/api/escrow/quote`. 4) Present ranked list." File: `apps/dashboard/public/agent-package.json` `system_prompt` field.
**Effort:** trivial.

### [P1] Body-validation gap (Zod missing on routes)
**Symptom:** Many routes use `as DisputeInput` TypeScript casts without Zod runtime validation. Risk: prototype pollution, type confusion.
**Root cause:** Migration from in-memory mocks to facades didn't standardize input validation.
**Repair:** Add Zod schemas to every route entry. Pattern: `const Body = z.object({...}); const parsed = Body.safeParse(req.body);`. File: every `packages/gateway/src/routes/*.ts`.
**Effort:** 1-week (sweeping refactor across ~58 route files).

### [P2] Cache control + DHT TTL too long
**Symptom:** Buyer agents see stale operator availability for up to 60s edge / 1 hour DHT.
**Root cause:** `Cache-Control: public, max-age=60` on `/api/capabilities/:id/button`. DHT TTL hardcoded to 3600s.
**Repair:** `s-maxage=10, stale-while-revalidate=30` + ETag. DHT TTL → 300s with auto-renewal on heartbeat. Files: `packages/gateway/src/routes/capabilities.ts`, `packages/orchestrator-sdk/src/tools/pcc-discovery.ts`.
**Effort:** 1-day.

### [P2] Geographic / timezone constraint missing
**Symptom:** Cannot filter "EU-only operators" or "operators in same timezone for same-day delivery."
**Root cause:** No `?near=` / `?country=` / `?timezone=` on search.
**Repair:** Extend search facade. Add geo-index to capability table. Files: same as P1 #1.
**Effort:** 1-week.

### [P2] Mock data leaks visibly into production
**Symptom:** `MarketplacePage` renders `mockEquipmentClasses`, `mockGeoMarkers`, `mockPriceHistory` in production. Buyer sees fake demand/supply numbers.
**Root cause:** `apps/dashboard/src/api/mock-onboarding-data.ts` is imported directly into the page.
**Repair:** Replace mock imports with `useMarketSnapshot()` hook backed by `/api/marketplace/snapshots` (route exists at `packages/gateway/src/routes/marketplace.ts` but uses internal mocks). Backfill from real `kernels`/`capabilities` aggregations. File: `apps/dashboard/src/pages/MarketplacePage.tsx` lines 11-13.
**Effort:** 1-week.

### [P2] DiscoverPage capability types hardcoded to lab
**Symptom:** Buyer searching for `cnc-3axis` cannot click a filter chip; only `hplc/pcr/microscopy/mass-spec/sequencing/cell-culture` are shown.
**Root cause:** `apps/dashboard/src/pages/DiscoverPage.tsx:12` hardcodes `capabilityTypes`.
**Repair:** Fetch from `/api/capabilities/types` (returns the canonical 10 types) and group by category. File: same line.
**Effort:** trivial.

### [P3] No comparison view
**Symptom:** Buyer cannot compare 2-3 operators side-by-side.
**Repair:** New `/discover/compare?ids=` page.
**Effort:** 1-day.

### [P3] No recurring jobs
**Symptom:** Each job is one-shot.
**Repair:** `POST /api/jobs/recurring` with cron-string.
**Effort:** 1-week.

---

## Open questions for the author

1. Is the v2.5 `feat/agent-onboarder-v2` branch supposed to ship a buyer-side surface? The migration plan I see (`docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md`) only describes operator-side. Confirm scope.
2. Was `/api/capabilities/templates/match` ever shipped in v1 (the frozen `shiptoprod-agent`)? If so, port. If not, confirm I should design the schema from scratch.
3. Should the gateway-EOA escrow funding pattern stay (gateway as custodian) or move to user-wallet signing? This is the architectural fork.
4. Are there v2 plans for arbiter governance (multisig, verifier-network) or does the single-arbiter EOA model continue?
5. Per CLAUDE.md the agent package is "219 tools v2.8.0" — should buyer-side flows get top-billing in `system_prompt` or stay co-equal with operator flows?
