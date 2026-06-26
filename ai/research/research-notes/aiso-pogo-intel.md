# AISO / Pogo Intel — AI-Conversation Intent Data Sources for PCC

**Agent:** researcher-alpha
**Date:** 2026-06-24
**Task:** Evaluate **Aiso** and **Pogo** as external demand-signal sources to help PCC (a manufacturing-capability marketplace) rank WHICH connectors/integrations to build first. Disambiguate naming. Surface analogues. Provide a vendor comparison table.

---

## Disambiguation Summary (early findings)

- **Aiso** → Strong match: **getaiso.com** ("Aiso — AI Search Optimization / Track ChatGPT Visibility"). It is an AI-search-optimization (AISO/AEO/GEO) platform with an explicit **"conversation intelligence"** module that surfaces "real user needs, pain points, and buying intent... based on what users are actively asking AI." There is ALSO an **"AISO Conversations Intelligence"** actor on Apify (apify.com/aiso/aiso-conversations-intelligence) — need to confirm whether same vendor. NOTE: "AISO" is also a generic acronym (AI Search Optimization), so some hits are category articles, not the company.
- **Pogo** → The consumer **rewards/data app** at **joinpogo.com** (a.k.a. "Honey for the real world"). Pays users for sharing location + purchase/financial data via Plaid. Founders per TechCrunch: **Dom Wong (CEO), Oskar Melking, Shikhar Mohan** — NOT described as ex-Plaid; backed by founders of Front, Rent the Runway, Honey; led by Josh Buckley. Earnings to users are tiny (~$0.30/mo example). NO evidence yet that Pogo sells aggregated AI-conversation/intent data externally; it appears to be B2C data-monetization, not a B2B intent-data API. Need to verify whether any aggregated-data product exists, and whether a *different* "Pogo" is an AI-intent product.

---

## Source Notes (raw)

### Search 1 — Pogo app / founders / data model
Source: https://techcrunch.com/2022/07/26/pogo-lands-millions-to-become-the-honey-for-the-real-world/
Source: https://www.joinpogo.com/privacy-policy
Source: https://www.sidehustlenation.com/pogo-app-review/
Source: https://thecollegeinvestor.com/46328/pogo-review/

- Pogo = consumer app, "Honey for the real world." Users opt in to get paid for data via "anonymous market research or personalized marketing from trusted brands." Shares location + purchase data.
- Uses **Plaid** to securely connect banking info.
- Raised **$14.8M** total: $12.3M seed (led by Josh Buckley) + $2.5M pre-seed. Backers incl. founders of Front, Rent the Runway, Honey.
- Founders: Dom Wong (CEO), Oskar Melking, Shikhar Mohan. (Query premise "ex-Plaid founders" NOT corroborated in results.)
- User earnings modest: ~2-20 points/purchase; example ~300 points/mo = ~$0.30/mo.
- Monetization direction = B2C (pays users) + sells anonymized market-research/marketing access to brands. No public B2B intent-data API surfaced yet.

### Search 2 — Aiso intent data
Source: https://www.getaiso.com/
Source: https://apify.com/aiso/aiso-conversations-intelligence

- getaiso.com = "AI Search Optimization platform — track ChatGPT visibility." Tracks/analyzes/improves brand visibility across ChatGPT, Perplexity, Claude, Gemini.
- Has **Conversation Intelligence**: "understand real user needs, pain points, and buying intent in their market through actual AI conversations"; "identify emerging trends and topics... based on what users are actively asking AI."
- "Discover and curate real AI conversations that reveal what people actually ask about products, services, and categories"; "see how prompts break into hidden sub-queries, where a brand appears, and how visibility changes over time."
- Apify listing "AISO Conversations Intelligence" suggests a scraper/actor surface — TBD if same company.

### Search 3 — AEO / answer-engine analytics vendors 2026 (broader landscape)
Source: https://contently.com/2026/04/29/top-10-tools-answer-engine-optimization-aeo-2026/
Source: https://scrunch.com/blog/best-answer-engine-optimization-aeo-generative-engine-optimization-geo-tools-2026
Source: https://salespeak.ai/aeo-news/aeo-hype-vs-data-2026

- **Profound** — key differentiator = **"Prompt Volumes"**: reveals how many users are asking specific queries across AI platforms → "turning visibility data into demand intelligence." (This is the closest analogue to what PCC wants: query-demand volume.)
- Scrunch — most complete AEO/GEO tool (4.6/5 G2); multi-LLM monitoring + auditing + optimization + AI content delivery.
- Visiblie — tracks up to 8 AI models, daily multi-region, Looker integration.
- Also named: Adobe LLM Optimizer, AthenaHQ, Bluefish, Peec AI, Profound, Semrush AI Visibility Toolkit, HubSpot AEO (CRM-tied intent signals).

### Search 4 — Profound / Goodie / Peec pricing
Source: https://bermawy.com/blog/goodie-ai-vs-profound-vs-peec-reviews-of-leading-geo-platforms
Source: https://cairrot.com/alternatives/profound-review-price-comparison-top-alternatives/
Source: https://discoveredlabs.com/blog/profound-vs-peec-vs-otterly-which-ai-visibility-platform-should-you-buy

- **Profound**: "$499/mo for Lite; enterprise custom." Another source: "$99 Starter (ChatGPT-only demo); real tracking from $399/mo (Growth); full LLM coverage = custom Enterprise." (Figures vary by source/date — flag as approximate.) Covers 10 engines.
- **Goodie AI**: Pro plan **$495/month**. Positioned mid-market/enterprise, strong "action layer," broad model coverage.
- **Peec AI**: starts **€89/mo**, **7-day free trial**. Budget option for agencies/SMB.

---
(Continued below — fetching product pages next.)

---

## DEEP-DIVE FINDINGS (product pages fetched)

### AISO (getaiso.com) — CONFIRMED MATCH, HIGH CONFIDENCE
Source: https://www.getaiso.com/
Source: https://apify.com/aiso/aiso-conversations-intelligence

**What it is:** An AI-search-optimization platform that analyzes real AI-assistant conversations (ChatGPT, Perplexity, Claude, Gemini) to track brand visibility AND surface what users are actually asking. Three core workflows: Conversation Explorer, Fan-outs & GPT Trends, AI Mention Tracker. No founder/funding info on the public page.

**Access model:** Dashboard-first ("export a client-ready report in one click"). CRUCIALLY there is also a **programmatic surface via Apify** — the `aiso/aiso-conversations-intelligence` actor (publisher = getaiso.com, confirmed same entity). Apify actors are callable via REST API + SDK, so this is effectively an **API/data-export path** without a sales call.

**Free trial / sample:**
- Website: **"14-day free trial," "full access for 14 days," "no credit card required."** Also "analyze in 60 seconds, no credit card required" (freemium entry).
- Apify actor: **No free trial**, but pay-per-result (cheap enough to sample one run).

**Pricing:**
- Website: **No public pricing** — call-booking/"contact us" implied. (Report as "not public" for the SaaS tier.)
- Apify actor (VERBATIM): **"Each successful analysis costs a flat $10 and returns 10–20 conversations. If no relevant conversations are found, no charge is applied."** Supports Apify Store subscription-tier discounts.

**Data shape (the important part for PCC):** A unit = a real AI conversation, enriched. Apify actor output fields:
`conversation text, summary, user intent (commercial/transactional/informational/productive), geographic location, mentioned products and brands, topic categories, demographic data (gender, age group), B2B/B2C classification, and supply/demand orientation.`
Website-side units add: intent classification (Comparison/Research/How-to), brand mention status (Recommended/Mentioned/Absent), visibility %, sentiment, average ranking position, "last seen" temporal tracking.
Input to the actor = a single **website domain** (e.g. "dior.com").

**Mapping to "rank which connectors to build":** Strong. You can query a domain/topic (e.g. "3d printing", "cnc machining", "PCB fab") and get back categorized conversations with **intent + supply/demand orientation + product/brand mentions + topic categories**. Aggregating conversation counts per capability-type keyword → a demand ranking. The $10/run, 10-20 convos granularity is good for spot-sampling a connector hypothesis; less ideal for continuous high-volume trend tracking (cost scales linearly).
CAVEAT: the actor takes a *domain* as input, not an arbitrary keyword — need to confirm whether topic/keyword queries are supported (the website "Conversation Explorer" implies keyword/topic queries exist in the SaaS product). Flag as open question.

### POGO (joinpogo.com) — financial/behavioral data app, B2B data product EXISTS but MSA-gated
Source: https://techcrunch.com/2022/07/26/pogo-lands-millions-to-become-the-honey-for-the-real-world/
Source: https://www.joinpogo.com/privacy-policy

**What it is:** Consumer rewards app ("Honey for the real world") that pays users for opting into sharing their data. NOT an AI-conversation-intent product by design — it is a **personal-data monetization** play. Founders: Dom Wong (CEO), Oskar Melking, Shikhar Mohan. (Premise "ex-Plaid founders" NOT corroborated; Pogo *uses* Plaid for bank linking. Backers: founders of Front, Rent the Runway, Honey; seed led by Josh Buckley; $14.8M total raised as of 2022.)

**Does it sell aggregated/intent data? YES — and it now includes AI chat logs:**
- "create anonymous, aggregated or de-identified data" and "share it with third parties for our lawful business purposes."
- Data Dividends program: "we will also send anonymized data and insights to Participating Businesses for market research purposes (e.g., consumer preferences, investment research, model training)."
- **Participating Businesses** = "marketing/advertising partners, analytics and research providers, **LLM developers**, social networks, brands, retailers, agencies, **hedge funds and investment managers**."
- **Chat Logs (opt-in):** "we will collect your chat logs with large language models (LLMs) (e.g., ChatGPT)." So Pogo DOES collect AI-conversation data — but as one input among many (financial, location, SKU-level purchase, browsing).

**Access model:** **No public/self-serve API.** B2B access is via private contract: "If you access Pogo's products or services pursuant to a business-to-business agreement with Pogo (such as a Master Services Agreement, Data Services Agreement...)." → **sales-call / enterprise-contract gated**, opaque. No public pricing, no free tier for data buyers, no developer surface.

**Data shape:** Person-level financial + location + SKU-level purchase + browsing + (opt-in) LLM chat logs, sold as anonymized/aggregated market-research insights. This is **consumer-spend / purchase-intent** data, not "what people ask AI to make/manufacture." The AI-chat-log slice is new but not the core product and not separable via self-serve.

**Pricing:** **Not public.** Data-buyer pricing is bespoke under MSA/DSA. Do not invent figures.

### PROFOUND — strongest analogue for "AI query demand volume"
Source: https://cairrot.com/alternatives/profound-review-price-comparison-top-alternatives/

**Pricing (VERBATIM from review):**
- **Starter: $99/month** — ChatGPT only, up to 50 prompts, 7-day history, no API/content/competitive intel.
- **Growth: $399/month** — ChatGPT + Perplexity + AI Overviews, up to 6 content gens/mo, competitive benchmarking, no Claude/Gemini/Grok/DeepSeek, no full API.
- **Enterprise: Custom** — full 10+ LLM coverage, **10,000 daily API calls**, **Prompt Volumes data access**, dedicated onboarding. Review's estimate: "$2,000–5,000+/month."
- **No free trial** on any tier; sales demos on request.

**Prompt Volumes feature:** Profound's proprietary dataset measuring query activity across **"400M+ real user conversations"** from double-opt-in consumer panels, with demographic breakdowns (region/age/income). Review skeptically calls it **"synthetic data" rather than verified query volumes** — flag this caveat. **Gated behind Enterprise only.**

**Competitor pricing the review mentions:**
- Cairrot Pro: **$99/mo** (5 LLMs, GA4 integration, unlimited API) — note: Cairrot authored the review, so self-promotional.
- Peec AI: **$89/mo** (115+ languages).
- Gumshoe AI: usage-based (no fixed rate).

---

## CONFIRMING FINDINGS (round 2)

### AISO — public pricing CONFIRMED (self-serve), company size confirmed
Source: https://www.getaiso.com/pricing
Source: https://www.crunchbase.com/organization/aiso-4d6e (Crunchbase profile EXISTS; page 403'd to fetch — founders/funding NOT publicly captured here)
Source: search snippet — "11-50 employees"

**Public pricing tiers (VERBATIM):**
- **Starter — $79/month** — 1 user, **2,000 prompts/mo**, Conversation Explorer + Mention Tracker + Fan-outs & GPT Trends + basic reporting + email support. 14-day free trial, no CC. **Self-serve "Start free trial."**
- **Growth — $239/month** — up to 5 users, **25,000 prompts/mo**, + Crawlability Audit, Schema Generator, Content Engine, Weekly Recap Mailer, priority support. 14-day free trial, no CC. Self-serve.
- **Enterprise — Custom** — up to 25 users, **100,000 prompts/mo**, + Client Deliverable Builder, Alerts & Monitoring, custom integrations, dedicated success manager. "Contact us / Book a call."
- Plus a **proof-of-value pilot**: "lower upfront fee and a success fee on qualified leads."

**Net:** Aiso is the MOST accessible option in this report — self-serve checkout, public per-prompt-tier pricing, 14-day no-CC trial, AND a $10-per-run Apify API path. Company is real (Crunchbase + 11-50 staff). Founder/funding specifics not publicly confirmed (Crunchbase gated).

### POGO — REPOSITIONED to B2B "Verified Consumer Research Powered by AI"
Source: https://www.joinpogo.com/ (current homepage)

**Important pivot:** The 2022 "Honey for the real world" consumer-rewards app is NOW marketed as **"Verified Consumer Research Powered by AI"** — a B2B research platform. (Same company; the consumer app is the data-collection layer feeding the B2B product.)

**What it is now:** AI-powered consumer-research platform combining **verified purchase data** (credit/debit transactions, receipts, location visits) with AI-moderated video interviews + quant surveys. **3M+ U.S. users, $470B+ transaction volume, 150+ behavioral/demographic/psychographic attributes per person.** You "find buyers, lapsers, users or competitive shoppers using real purchase data instead of self-reported screeners," then launch interviews/surveys to verified buyers; an AI researcher synthesizes results within hours.

**Access model:** **Sales-gated.** "Book a Demo" CTAs throughout. **No API, no data export, no programmatic access** mentioned. No free trial / freemium / sample.

**Pricing:** **NOT public.** No pricing page, no tiers, no ranges. (Do not invent.)

**Data shape:** Person-level verified purchase + behavioral/demographic/psychographic records; qualitative interview + survey responses. Aggregate features exist ("Category & Market Trends," "Audience Intelligence") but homepage shows **no evidence of category-level manufacturing demand queries or product-demand forecasting**, and nothing queryable about "what people ask AI to make." The earlier privacy-policy slice (opt-in ChatGPT chat logs sold to "LLM developers / hedge funds") is a data INPUT, not a self-serve intent product.

**Disambiguation closed:** No *separate* "Pogo" exists as an AI-conversation-intent product. The only relevant Pogo is joinpogo.com (consumer-spend research). It is purchase-intent data, NOT AI-prompt/LLM-demand data, and it is enterprise-sales-gated.

### Broader category note (verified)
- **Profound** = the canonical "AI prompt demand volume" vendor ("Prompt Volumes," 400M+ conversations) but gated to Enterprise (~$2-5k+/mo); review flags data as possibly "synthetic."
- **Verve** publishes on "LLM intent data signals for advertising" — confirms an emerging category of LLM-conversation intent data for targeting. Source: https://verve.com/blog/llm-intent-data-signals-targeting-advertising/
- Mid-market AI-visibility tools with public, cheap, self-serve pricing: **Peec AI (€89/mo, 7-day trial)**, **Cairrot ($99/mo, unlimited API)**, **Goodie AI ($495/mo Pro)**, **Profound Starter $99 / Growth $399**.

---

## Summary for orchestrator

### Comparison table

| Vendor | What it is | Access model | Free sample? | Pricing (verbatim) | PCC usefulness |
|---|---|---|---|---|---|
| **Aiso (getaiso.com)** | AI-conversation intelligence: real ChatGPT/Perplexity/Claude/Gemini prompts → intent, products/brands, topics, **supply/demand orientation**, B2B/B2C, geo, demographics | **Self-serve SaaS + Apify API** | **Yes** — 14-day trial (no CC); Apify pay-per-run | Starter **$79/mo** (2k prompts), Growth **$239/mo** (25k prompts), Enterprise **Custom** (100k prompts). Apify actor: **"$10 flat / 10–20 conversations, no charge if none found"** | **HIGH** — directly maps AI-prompt demand to product/topic categories; cheapest + most accessible; can spot-rank a connector hypothesis via $10 Apify runs |
| **Pogo (joinpogo.com)** | B2B verified-consumer-research: real purchase/transaction + behavioral data (3M users, $470B vol, 150+ attrs/person) + AI interviews/surveys | **Sales-gated**, no API/export | **No** — "Book a Demo" only | **Not public** (enterprise MSA/DSA) | **LOW** — purchase-intent (what people BUY), not AI-prompt demand (what people ask AI to make); no self-serve, no API, opaque pricing → not a near-term ranking signal |
| **Profound** | AI-visibility + **Prompt Volumes** demand intelligence across 10 LLMs (400M+ convos) | Self-serve (low tiers) + Enterprise | No trial; demo on request | Starter **$99/mo**, Growth **$399/mo**, Enterprise **Custom (~$2-5k+/mo)**; Prompt Volumes = **Enterprise-only** | **MEDIUM** — best "query demand volume" concept, but the demand-ranking data is locked behind Enterprise; entry tiers are visibility-only. Review flags Prompt Volumes as possibly synthetic |
| **Peec AI** | Budget AI-visibility tracker, 115+ languages | Self-serve SaaS | **7-day free trial** | **€89/mo** | **MEDIUM-LOW** — cheap + accessible but visibility-focused; weaker raw demand-signal/export story than Aiso |
| **Goodie AI** | Mid-market/enterprise AEO/GEO with optimization "action layer" | Self-serve + sales | Not stated | Pro **$495/mo** | **LOW-MEDIUM** — broad coverage but optimization-led, pricier, demand-signal export unclear |

### Bottom line (3 bullets)

- **Aiso is the only one of the two named targets that is both a genuine AI-conversation-intent product AND immediately accessible.** It has public self-serve pricing ($79/$239/mo), a no-credit-card 14-day trial, and — decisively — an **Apify API actor at $10 per run returning 10–20 enriched conversations** (intent, products/brands, topic categories, **supply/demand orientation**, geo, demographics). PCC can pilot it this week: query a handful of capability-type domains/keywords, bucket conversations by topic, and rank connector demand. Open question to verify in trial: whether the input can be an arbitrary **keyword/topic** (e.g. "cnc milling") vs. only a **domain** — the Apify actor doc shows domain input; the SaaS "Conversation Explorer" implies topic queries.
- **Pogo is the wrong tool for this job and is not near-term accessible.** It pivoted from a consumer-rewards app to a B2B verified-**purchase**-research platform (what consumers BUY, via transactions/receipts), not "what people ask AI to manufacture." It is fully sales-gated (Book-a-Demo only), exposes no API or sample, and publishes no pricing. Its opt-in ChatGPT-chat-log slice is an internal data input sold to LLM developers/hedge funds under private MSAs — not a self-serve intent feed. **Skip for now**; revisit only if PCC wants consumer purchase-demand (not capability/prompt demand) and is willing to do enterprise procurement.
- **Best fallback if Aiso underdelivers: Profound's Prompt Volumes** is the category's reference "AI query demand volume" dataset, but it's Enterprise-gated (~$2-5k+/mo) and possibly synthetic. For a cheap self-serve comparison run, **Peec AI (€89/mo, 7-day trial)** or **Cairrot ($99/mo, unlimited API)** are accessible, though visibility-led rather than demand-ranking-led. **Recommendation: start with Aiso's $10 Apify runs + 14-day trial; benchmark against a Profound Enterprise demo only if the signal proves directionally useful for connector prioritization.**

---

**STATUS: DONE.** Both named targets disambiguated and deep-dived with public sources; Aiso fully priced + API path found; Pogo's current B2B pivot captured (sales-gated, no API, no public pricing); 5-vendor comparison table + bottom-line provided. Only gap: Aiso founders/funding (Crunchbase profile exists but 403'd to fetch) and confirmation of keyword-vs-domain input granularity (verifiable in the free trial) — both flagged as open questions, neither blocks the ranking-signal decision.
