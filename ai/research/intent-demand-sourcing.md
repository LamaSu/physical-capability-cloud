# Intent & Demand Sourcing — Ranking Which Connectors to Build First

**Status:** research + design (owner review)
**Author:** /go orchestrator (branch `feat/pcc-mcp-and-intent-research`)
**Date:** 2026-06-24
**Scope:** (A) external AI-conversation intent data — Aiso, Pogo, and accessible comparables — as a *cold-start* connector-demand signal; (B) a concrete design for instrumenting PCC's **own** unfulfilled-intent log (every decompose/order that fails to match a capability → a ranked connector request) as the *proprietary, compounding* demand signal.

---

## 0. TL;DR

PCC needs to know **which integration/connector (machine adapter, capability type, lab protocol) to build next.** Two complementary signal sources:

1. **External (buy now, cold-start):** **Aiso** (getaiso.com) is the one accessible, genuinely-AI-conversation-intent product of the two named targets — self-serve, **14-day no-CC trial**, public pricing (**$79/$239/mo**), and an **Apify API actor at $10/run** returning enriched conversations (intent, product/brand mentions, topic categories, **supply/demand orientation**, geo). **Pogo** is the wrong category (sales-gated consumer *purchase* data, no API, no public pricing) — skip. Best fallback: **Profound "Prompt Volumes"** (the category-reference demand dataset, Enterprise-gated ~$2–5k+/mo).

2. **Internal (the moat, compounding):** PCC already captures **`DemandEnvelope`** intents from its own API surface and ranks compositions by frequency in **`@pcc/demand-intel`**. The `DemandEnvelope` type already has a **`fulfillmentPath: "unfulfilled"`** slot — but **nothing sets it, nothing match-checks supply, and the ranking counts *all* demand rather than *unmet* demand.** Closing that three-line gap turns PCC's existing pipeline into a **ranked connector backlog**: every order/decompose that names a capability type with **zero supply** becomes a scored "build-this-connector" request, attached to real budget, urgency, region, and requester. This is bottom-of-funnel, first-party, zero-cost, real-time, and impossible for a competitor to replicate without running a capability marketplace.

**Recommendation:** seed connector ranking with Aiso ($10 Apify runs + trial) now; in parallel wire the unfulfilled-intent log (Part B) so the proprietary signal takes over as traffic grows. Combine both into one connector-priority score (Part C).

---

## Part A — External AI-Conversation Intent Data

> Full source notes, verbatim pricing, and the disambiguation trail: [`ai/research/research-notes/aiso-pogo-intel.md`](research-notes/aiso-pogo-intel.md).

### A.1 Aiso (getaiso.com) — **CONFIRMED, HIGH usefulness**

- **What it is:** an AI-search-optimization / "conversation intelligence" platform that analyzes real assistant conversations (ChatGPT, Perplexity, Claude, Gemini) to surface "what users are actively asking AI" — needs, pain points, **buying intent**, emerging topics. Company is real (Crunchbase profile exists; ~11–50 employees). Source: <https://www.getaiso.com/>, <https://www.getaiso.com/pricing>.
- **Access model:** **self-serve** dashboard **plus a programmatic surface via Apify** — the `aiso/aiso-conversations-intelligence` actor (same publisher), callable over Apify's REST API/SDK with **no sales call**. Source: <https://apify.com/aiso/aiso-conversations-intelligence>.
- **Free trial / sample:** **14-day free trial, full access, no credit card** (SaaS). Apify actor has no trial but is pay-per-result, cheap enough to sample one run. Source: getaiso.com.
- **Pricing (verbatim):** Starter **$79/mo** (1 user, **2,000 prompts/mo**), Growth **$239/mo** (5 users, **25,000 prompts/mo**), Enterprise **Custom** (25 users, 100,000 prompts/mo). Apify actor: **"Each successful analysis costs a flat $10 and returns 10–20 conversations. If no relevant conversations are found, no charge is applied."** Source: getaiso.com/pricing, apify.com listing.
- **Data shape (the part that matters):** one unit = a real AI conversation, enriched. Apify output fields include: `conversation text, summary, user intent (commercial/transactional/informational/productive), geographic location, mentioned products and brands, topic categories, demographics, B2B/B2C classification, and supply/demand orientation.`
- **Mapping to connector ranking:** **strong.** Query capability-type terms ("cnc milling", "pcb fab", "injection molding", "hplc"), bucket returned conversations by topic category + intent, and rank connector demand by conversation count weighted by commercial/transactional intent and supply/demand orientation. The $10/run × 10–20 convos granularity is ideal for **spot-ranking a connector hypothesis**; linear cost makes it less ideal for always-on high-volume tracking.
- **Open question (verify in trial):** whether the input can be an arbitrary **keyword/topic** vs. only a **website domain** — the Apify actor doc shows domain input; the SaaS "Conversation Explorer" implies topic queries. This determines whether we can query "cnc milling" directly or must proxy via representative domains.

### A.2 Pogo (joinpogo.com) — **LOW usefulness, not near-term accessible**

- **What it is now:** repositioned from the 2022 "Honey for the real world" consumer-rewards app to **"Verified Consumer Research Powered by AI"** — B2B research over **verified purchase data** (credit/debit transactions, receipts, location), 3M+ users, $470B+ transaction volume, 150+ attributes/person, plus AI-moderated interviews/surveys. Source: <https://www.joinpogo.com/>, <https://techcrunch.com/2022/07/26/pogo-lands-millions-to-become-the-honey-for-the-real-world/>.
- **Access model:** **sales-gated** ("Book a Demo"); **no API, no export, no sample, no public pricing**. Its opt-in ChatGPT-chat-log slice is sold to "LLM developers / hedge funds" under private MSAs — a data *input*, not a self-serve intent feed. Source: <https://www.joinpogo.com/privacy-policy>.
- **Why it's the wrong tool:** it measures **what consumers BUY** (purchase intent), not **what agents/users ask AI to manufacture** (capability/prompt demand). Disambiguation closed: no separate AI-intent "Pogo" exists. The "ex-Plaid founders" premise was **not** corroborated (Pogo *uses* Plaid). **Skip** unless PCC wants consumer purchase-demand and is willing to do enterprise procurement.

### A.3 Accessible comparables (fallbacks)

| Vendor | What | Access | Free sample | Pricing (verbatim/approx) | PCC fit |
|---|---|---|---|---|---|
| **Aiso** | AI-convo intent → intent/products/topics/**supply-demand**/geo | Self-serve SaaS **+ Apify API** | **14-day, no CC**; Apify pay-per-run | $79 / $239 / Custom; **Apify $10/run → 10–20 convos** | **HIGH** |
| **Profound** | **"Prompt Volumes"** demand intel, 400M+ convos, 10 LLMs | Self-serve (low tiers) + Enterprise | No trial; demo | $99 / $399 / Custom (**~$2–5k+**; Prompt Volumes = **Enterprise-only**) | **MEDIUM** (best concept, gated; review flags data as possibly synthetic) |
| **Peec AI** | Budget AI-visibility tracker, 115+ langs | Self-serve | **7-day trial** | **€89/mo** | **MED-LOW** (visibility-led) |
| **Cairrot** | AI-visibility, unlimited API | Self-serve | — | **$99/mo** | **MED-LOW** (self-promotional review) |
| **Goodie AI** | Mid/enterprise AEO + optimization | Self-serve + sales | Not stated | Pro **$495/mo** | **LOW-MED** |

Sources: <https://cairrot.com/alternatives/profound-review-price-comparison-top-alternatives/>, <https://bermawy.com/blog/goodie-ai-vs-profound-vs-peec-reviews-of-leading-geo-platforms>, <https://contently.com/2026/04/29/top-10-tools-answer-engine-optimization-aeo-2026/>, <https://verve.com/blog/llm-intent-data-signals-targeting-advertising/>.

### A.4 External pilot (1 week, ≤$200)

1. Pick the 10–15 capability types PCC most wants to validate (from `GET /api/capabilities/types`).
2. Run each through the Aiso Apify actor ($10/run) — and, where the input must be a domain, use 2–3 representative supplier domains per type.
3. Bucket returned conversations by `topic category` × `intent` × `supply/demand orientation`; score each type = Σ(commercial+transactional convos) × demand-orientation share.
4. Rank → a first external connector-demand list. Benchmark the top 5 against a Profound demo only if directionally useful.
5. Record raw output under `ai/research/research-notes/` so the internal signal (Part B) can later be calibrated against it.

---

## Part B — PCC's Own Unfulfilled-Intent Log (the proprietary signal)

### B.1 Thesis

External tools measure **asking** (someone typed a query into a chatbot) — top-of-funnel, no commitment, no budget, noisy. PCC can measure **buying attempts that hit a supply wall** — a user/agent submitted a real order, it was decomposed into capability types, and **PCC had no capability to fulfill one of them.** That is the single highest-intent demand signal possible: realized, willing-to-pay, supply-starved, and stamped with budget, urgency, region, and a requester hash — captured at the exact moment of unmet demand. It is first-party, free, real-time, and uncopyable without running a marketplace.

### B.2 What ALREADY exists (don't reinvent — extend)

PCC has a near-complete demand-intel pipeline on `master`:

| Piece | Where | What it does |
|---|---|---|
| **`DemandEnvelope`** type | `packages/spec/src/types/demand.ts:59` | Single captured intent (atomic or composite): `source`, `compositionSignature`, `capabilityTypes[]`, `summary`, `budgetBand`, `urgencyBand`, `geographicRegion`, `originAgentId`, `requesterIdHash`, and **`fulfillmentPath?: "auto" \| "concierge" \| "unfulfilled"`** (`demand.ts:51,82`). |
| **`computeCompositionSignature` / `budgetToBand`** | `demand.ts:139,159` | Deterministic sha256 over sorted capability types + dependency edges; coarse budget banding (no raw $ leakage). |
| **Capture point A — composite request** | `packages/gateway/src/routes/requests.ts:297` | `POST /api/requests` auto-decomposes NL → capability DAG, then emits `intent.composite_request` (`buildEnvelopeFromRequest:94`). |
| **Capture point B — atomic session** | `packages/gateway/src/routes/negotiation.ts:143` | `POST /api/negotiate/session` emits `intent.atomic_session`. |
| **Capture point C — synthetic query** + A2A | `nl-query.ts` / `a2a-tasks.ts` | `query_api_synthetic`, `a2a_tasks_send` sources (`IntentSource` enum, `demand.ts:41`). |
| **Event bus → analytics_events** | `services/event-bus.js` | `emitIntent()` publishes `intent.*` events (best-effort; never breaks the request). |
| **`DemandAggregator`** | `packages/demand-intel/src/aggregator.ts:112` | Folds `intent.*` rows through **CountMinSketch** (top-K compositions), **HyperLogLog** (unique requesters), **TDigest** (budget percentiles) → a windowed **`DemandSnapshot`**. |
| **Admin surface** | `packages/gateway/src/routes/admin-demand.ts:177` | Auth-gated (`PCC_DEMAND_ADMINS` allowlist) `GET /api/admin/demand/{composites,snapshot/:window,status,composite/:signature}`; snapshots persisted via `materializedViews`, hourly/daily cron. |

The "request decomposer" (`services/request-decomposer.ts`, via `requests.ts:269`) turns an order into a `capabilityDag` of `CapabilityNode`s — **each with a `capabilityType`** — and publishes them as bounties.

### B.3 The gap (exactly the task's framing)

Three facts, all verifiable in the code above:

1. **No capture point ever sets `fulfillmentPath`.** `buildEnvelopeFromRequest` (`requests.ts:115`) and negotiation point B (`negotiation.ts:151`) construct the envelope **without** `fulfillmentPath`. The `"unfulfilled"` enum value exists (`demand.ts:51,193`) and is threaded through `@pcc/intent-collector` (`client.ts:384`) and referenced by `@pcc/agent-broker` (`funding-handler.ts:17` — "unfulfilled requests in a recent window"), but **nothing computes it.**
2. **No supply/match check at decompose time.** `decomposeRequest()` maps NL → capability types regardless of whether *any kernel offers that type*. An order for "anodizing" gets a DAG node and a bounty even if PCC has zero anodizing capability. The unmet node is never flagged as unmet.
3. **The ranking counts *all* demand, not *unmet* demand.** `DemandAggregator.fold` (`aggregator.ts:240`) increments the CountMinSketch for **every** composition; the admin surface returns "top compositions" — popularity, not *gaps*. A composition PCC already fulfills outranks a starved one.

So the unfulfilled-intent log is **not a new subsystem** — it is the existing pipeline plus a supply check, a field that already exists, and a second ranking lens.

### B.4 Design — three surgical additions

```
                    ┌─────────────────────────────────────────────────────────┐
  order / decompose │  POST /api/requests ─► decomposeRequest ─► capabilityDag │
  negotiate / a2a   │  POST /api/negotiate/session ─► capabilityType           │
                    └───────────────┬─────────────────────────────────────────┘
                                    │  (NEW) per type: matchSupply(type, tier, budget, region)
                                    ▼
                    ┌─────────────────────────────────────────────────────────┐
   (1) matcher      │  MatchResult { matched, reason?, supplyCount }            │
                    └───────────────┬─────────────────────────────────────────┘
                                    │  if any unmatched ⇒ fulfillmentPath="unfulfilled"
                                    ▼
   (2) envelope     DemandEnvelope { …, fulfillmentPath, unmet:[{type,reason,supplyCount}] }
                                    │  emitIntent() ► event bus ► analytics_events  (unchanged path)
                                    ▼
   (3) ranking      DemandAggregator + UNFULFILLED lens (CMS/HLL/TDigest keyed by capabilityType)
                                    │
                                    ▼
                    GET /api/admin/demand/unfulfilled  ►  ranked ConnectorRequest[]  (the backlog)
```

**(1) Capability matcher** — new `packages/gateway/src/services/capability-matcher.ts` (or a method on `CapabilityFacade`). For a `capabilityType` (+ optional `assuranceTier`, `budgetBand`, `region`):

```ts
type UnmetReason =
  | "no_capability_type"   // no template/CSD registered for this type at all
  | "no_kernel_offering"   // type known, but zero capability instances offer it
  | "no_capacity"          // instances exist but all offline / queue-full / stale
  | "tier_too_high"        // no offering kernel meets the requested assurance tier
  | "price_exceeds_budget" // cheapest quote > request budget band
  | "region_unavailable";  // offerings exist but none serve the requested region

interface MatchResult { matched: boolean; reason?: UnmetReason; supplyCount: number; }
```

Implementation reuses existing reads (no new infra): `CapabilityFacade.listByType(type)` / `GET /api/capabilities/by-type/:type`, kernel status, queue depth. Pure read; cache per type for the request's lifetime.

**(2) Set `fulfillmentPath` + `unmet[]` at every capture point.** Additive, optional, fully back-compat:

```ts
// demand.ts — extend DemandEnvelope (all optional ⇒ existing rows still validate)
interface UnmetCapability { capabilityType: string; reason: UnmetReason; supplyCount: number; }
// DemandEnvelope gains:  unmet?: UnmetCapability[];
```

At capture: run the matcher over each `capabilityType`; if **any** is unmatched, set `fulfillmentPath = "unfulfilled"` and `unmet = [...]`; else `"auto"`. Wrap in the same best-effort try/catch already used for `emitIntent` (`requests.ts:128`) — capture must never break the order. (Later, a settlement hook can upgrade `"auto"`→`"concierge"`/back-fill actual outcomes; the matcher gives the *capture-time* prediction, which is what connector planning needs.)

**(3) Unfulfilled ranking lens + endpoint.** In `@pcc/demand-intel`, add a parallel fold that **only** ingests envelopes with `fulfillmentPath === "unfulfilled"`, keyed by **individual `capabilityType`** (not just the composite signature) so a starved atomic type surfaces even inside many different composites. Reuse the existing sketches:

- CountMinSketch → demand count per unmet `capabilityType`
- HyperLogLog → distinct requesters per type (dedupes one whale spamming)
- TDigest → budget distribution per type
- side maps → reason histogram, region top-N, urgency mix, first/last seen, example summaries

Expose a new auth-gated route beside the others (`admin-demand.ts`): `GET /api/admin/demand/unfulfilled` (alias `/connectors`) returning the **ranked connector backlog**:

```jsonc
{
  "connectors": [
    {
      "capabilityType": "anodizing",
      "demandCount": 41,
      "distinctRequesters": 12,           // HLL — real breadth, not one spammer
      "budget": { "p50": 800, "sumBandMidpoints": 36500 },
      "reasons": { "no_kernel_offering": 33, "no_capability_type": 8 },
      "regionsTopN": [{ "region": "US-CA", "count": 14 }],
      "urgencyMix": { "standard": 20, "rush": 15, "emergency": 6 },
      "firstSeen": "2026-06-01T…", "lastSeen": "2026-06-24T…",
      "exampleSummaries": ["Anodize 200 aluminum brackets, type II black …"],
      "score": 87.4
    }
  ],
  "window": "day", "computedAt": "…"
}
```

**(4) Score (transparent, tunable).** Rank the backlog by realized, willing-to-pay, broad, fresh demand:

```
score(type) =  w1·log1p(demandCount)
             + w2·log1p(distinctRequesters)
             + w3·normalize(budgetSum)
             + w4·recencyDecay(lastSeen)
             + w5·urgencyBoost(rush+emergency share)
             + w6·gapSeverity(no_capability_type > no_kernel_offering > no_capacity)
```

Start `w = [1.0, 1.5, 1.0, 0.8, 0.5, 0.7]` (distinct-requester breadth weighted above raw count to resist gaming). Tune against fulfilled-vs-built outcomes over time. `distinctRequesters` and `gapSeverity` are the anti-gaming and prioritization levers; expose weights as env/config so BD can re-rank without a deploy.

### B.5 Why it's the moat (and how it relates to the funnel-tracker)

- **vs Aiso/Profound:** they sell *aggregate asking*; the unfulfilled log is *first-party buying attempts with attached budget/urgency/region/requester*, captured at the supply wall. Zero marginal cost, real-time, and structurally uncopyable.
- **vs the onboarding funnel-tracker** (a sibling lane's service, `provision→discover→build→fund→submit→settle`, `agent.funnel` audit events — present on branch `feat/rtp-canonicalization-and-timeout`, not yet on `master`): that tracks drop-off **inside a fulfillable path**. The unfulfilled log captures demand that **never enters the funnel** because supply is absent. They are complementary: funnel-tracker optimizes conversion of *served* demand; the unfulfilled log tells PCC *what new supply to add*. (Flag: coordinate with that lane if both land — both hook the request/negotiate paths.)
- **Compounding:** every order makes the signal sharper at no cost. External sources seed cold-start; the unfulfilled log takes over and keeps widening PCC's lead.

### B.6 Rollout (flagged, best-effort, additive)

1. **Phase 1 — capture (low risk):** add the matcher + set `fulfillmentPath`/`unmet[]` at capture points A/B/C/a2a, behind a `PCC_UNMET_CAPTURE_ENABLED` flag (mirrors the funnel-tracker's flag-gated pattern). Pure additive fields; best-effort; no behavior change to orders.
2. **Phase 2 — rank (low risk):** add the unfulfilled fold + `GET /api/admin/demand/unfulfilled`, auth-gated by the existing `PCC_DEMAND_ADMINS` allowlist. Reuses sketches + `materializedViews` persistence.
3. **Phase 3 — close the loop:** surface the backlog on the operator/BD dashboard; optionally auto-open a "connector request" bounty (`POST /api/requests/:id/publish` already publishes nodes as bounties) or notify when an unmet type crosses a demand threshold; calibrate weights against built-connector outcomes; fold the Aiso external score in as a cold-start prior (Part C).

**Acceptance:** an order naming an unsupported capability type produces an `intent.*` event with `fulfillmentPath:"unfulfilled"` and a populated `unmet[]`; that type appears in `GET /api/admin/demand/unfulfilled` ranked by `score`, with `distinctRequesters` ≥ 1 and a correct reason histogram.

---

## Part C — Synthesis: one connector-priority score

Run both tracks and blend:

```
priority(type) =  α · internalScore(type)        // Part B — realized unmet demand (trusted, compounding)
                + β · externalScore(type)        // Part A — Aiso/Profound asking volume (cold-start prior)
```

- **Cold-start (low internal volume):** weight external (β > α) — Aiso tells you where to point before you have your own data.
- **Warm (sufficient internal volume):** flip to α ≫ β — your own unmet-demand backlog is strictly higher-intent than any external feed; external becomes a sanity check / discovery of demand that never reaches PCC at all.
- Persist both sub-scores so the blend ratio is a tunable config, not a rebuild.

---

## Sources

**External (Part A):**
- Aiso: <https://www.getaiso.com/> · <https://www.getaiso.com/pricing> · Apify actor <https://apify.com/aiso/aiso-conversations-intelligence>
- Pogo: <https://www.joinpogo.com/> · <https://www.joinpogo.com/privacy-policy> · <https://techcrunch.com/2022/07/26/pogo-lands-millions-to-become-the-honey-for-the-real-world/>
- Profound / comparables: <https://cairrot.com/alternatives/profound-review-price-comparison-top-alternatives/> · <https://bermawy.com/blog/goodie-ai-vs-profound-vs-peec-reviews-of-leading-geo-platforms> · <https://contently.com/2026/04/29/top-10-tools-answer-engine-optimization-aeo-2026/> · <https://verve.com/blog/llm-intent-data-signals-targeting-advertising/>
- Raw research notes (full disambiguation + verbatim pricing): [`ai/research/research-notes/aiso-pogo-intel.md`](research-notes/aiso-pogo-intel.md)

**Internal (Part B) — code map (branch `feat/pcc-mcp-and-intent-research`, off `master`):**
- `packages/spec/src/types/demand.ts` — `DemandEnvelope` (`:59`), `FulfillmentPath`/`unfulfilled` (`:51`), `fulfillmentPath` field (`:82`), `computeCompositionSignature` (`:139`), `budgetToBand` (`:159`), `DemandSnapshot` (`:113`)
- `packages/demand-intel/src/aggregator.ts` — `DemandAggregator` (`:112`), `fold` counts all compositions (`:240`), `INTENT_EVENT_TYPES` (`:29`)
- `packages/gateway/src/routes/requests.ts` — capture point A (`:297`), `buildEnvelopeFromRequest` omits `fulfillmentPath` (`:115`), `decomposeRequest` (`:269`)
- `packages/gateway/src/routes/negotiation.ts` — capture point B `intent.atomic_session` (`:143`)
- `packages/gateway/src/routes/admin-demand.ts` — auth-gated demand admin routes (`:177`), `PCC_DEMAND_ADMINS` gate (`:36`)
- `packages/intent-collector/src/client.ts` — `fulfillmentPath` passthrough (`:384`); `packages/agent-broker/src/funding-handler.ts` — "unfulfilled requests" counter (`:17`)
- Sibling lane (NOT on master): `packages/gateway/src/services/funnel-tracker.ts` on `feat/rtp-canonicalization-and-timeout` — onboarding funnel, complementary to this design.
