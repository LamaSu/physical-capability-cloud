# PCC Market Research — Belief Moat
*Research started: 2026-04-07*

## Status: COMPLETE
*Last updated: 2026-04-07*

---

## 1. Global Manufacturing Services Market

### 1.1 Contract Manufacturing

**Key figures (cross-referenced across research firms):**
- Market size 2024: ~$731 billion (360iResearch) to $686 billion (BCC Research, 2025 figure)
- Projected 2030: $968.7 billion (BCC Research) to $1,087 billion (360iResearch)
- CAGR: 5.98%–8.33% depending on scope/methodology
- Mordor Intelligence: $724B in 2025, growing to $967B by 2030 at 5.98% CAGR

**Sources:** assemblymag.com, prnewswire.com (BCC Research), mordorintelligence.com, 360iresearch.com

### 1.2 CNC Machining Services

**Key figures:**
- Services market (broad): ~$80 billion in 2024, projected $120B by 2033 (CAGR ~5.5%)
- Services market (narrower/online): $1.64B in 2024, expected $3.29B by 2033
- Alternative estimate: $7.28B in 2024 → $10.79B by 2033 at 4.47% CAGR
- CNC machine *equipment* market: $101B in 2025, projected $252B by 2034 at 11.1% CAGR
- Regional split (2023): Asia Pacific 55.5%, Europe 31.8%, rest of world ~13%

**Note:** Wide variance because some reports include machine sales, others only machining-as-a-service. The $66–80B range for services is most cited.

**Sources:** businessresearchinsights.com, verifiedmarketreports.com, grandviewresearch.com

### 1.3 3D Printing / Additive Manufacturing Services

**Key figures:**
- Grand View Research: $20.37B in 2023 → $88.28B by 2030 at 23.3% CAGR
- Markets and Markets: $15.39B in 2024 → $35.79B by 2030 at 17.2% CAGR
- Arizton (services + materials only): $8.60B in 2024 → $16.82B by 2030 at 11.83% CAGR
- Precedence Research: $134.58B by 2034 (broadest definition)
- **Consensus range for services segment:** ~$8–20B in 2024, growing 17–23% CAGR

**Key verticals driving growth:** Healthcare, aerospace & defense, automotive

**Sources:** grandviewresearch.com, marketsandmarkets.com, arizton.com, precedenceresearch.com

### 1.4 Lab Testing / Analytical Services

**Key figures:**
- Clinical laboratory services (broad): $274B in 2024 (Fortune Business Insights); $235B alternate estimate
- Lab testing services (industrial + clinical): $84.16B in 2024 (Cognitive Market Research)
- Healthcare analytical testing services: $17.09B in 2025 (Precedence Research — narrower scope)
- Analytical lab services (purely analytical instruments/services): $317M in 2024 (very narrow scope)
- North America dominates: ~40% of global revenue

**Note for PCC context:** The relevant segment is *industrial/materials analytical testing* — contract labs doing materials characterization, quality assurance, failure analysis. This is a subset of the $84B figure.

**Sources:** cognitivemarketresearch.com, fortunebusinessinsights.com, grandviewresearch.com, precedenceresearch.com

### 1.5 Market Fragmentation

**Key findings:**
- US manufacturing is "highly fragmented — no company holds >5% market share" (IBISWorld)
- Number of US manufacturing companies declined ~25% since 1997 but remains in the hundreds of thousands
- SMEs (< 500 employees) account for the vast majority of manufacturing establishments
- NIST MEP estimates ~250,000+ small/medium manufacturers in the US alone
- RealClearPolicy: small businesses are the backbone of US manufacturing

**Global picture:** The fragmentation is even more pronounced globally — estimates of 1–3 million small CNC shops, machine shops, and fab facilities across China, Southeast Asia, Europe.

**Implication for PCC:** This extreme fragmentation is WHY a discovery/protocol layer has value. No single player dominates. There is no "AWS" of physical manufacturing — yet.

**Sources:** ibisworld.com, nist.gov/mep, score.org, sba.gov

---

## 2. Cloud Infrastructure Market (the analogy)

### 2.1 Big Three Revenue (2024)

**Revenue figures:**
- AWS: ~$100B annual run rate in 2024 (Q1 2024: $25B); market share ~31%
- Azure: ~$25B/quarter in 2024; market share ~25%
- GCP: market share ~10–11%
- Combined Big Three: ~66% of total cloud infrastructure spend
- Total cloud infrastructure market Q1 2024: ~$80–90B per quarter → ~$330–360B annual run rate

**CAGR:** Cloud market growing ~20–25% YoY driven by AI/ML workloads

**Sources:** holori.com (cloud market share 2024), statista.com, msspalert.com

### 2.2 API/Programmatic vs Human-Negotiated Split

**Key findings:**
- Specific "% of cloud spend that is programmatic/API-driven vs. human-negotiated" data not directly available in public research
- However: 94% of enterprise organizations have workloads in cloud; 49% of enterprise workloads are in public cloud
- Average enterprise uses 1,295 cloud services and 364 SaaS apps — virtually all accessed via APIs
- Cloud's core value proposition IS programmatic access: "public clouds are founded on the notion of self-service and automation, so APIs are critical to how they operate" (Google Cloud docs)
- **Inference:** The transition from "call a salesperson" (pre-cloud compute) to "call an API" (AWS EC2) is the exact analog PCC proposes for manufacturing

**Sources:** statista.com (enterprise cloud workloads), faddom.com, spacelift.io, g2.com

### 2.3 How Cloud Changed Compute Economics (The Direct Analogy)

**Before EC2 (pre-2006):**
- Enterprises bought physical servers: 6–12 week procurement, 6-figure capital expense
- Fixed capacity regardless of actual load — idle servers burning cash
- Startups couldn't compete; enterprise infrastructure required enterprise capital

**After EC2 (2006+):**
- Launch date: March 2006 — "compute power for $0.10/hour, storage at $0.15/GB/month, no upfront investment"
- SmugMug: reduced storage costs by ~$400,000/year by switching to S3
- New York Times: converted scanned archive (would have been "too expensive") for "a couple hundred dollars"
- AWS reduced prices 107 times between 2006 and 2021 (passing scale economies back to customers)
- API-first: any developer could provision enterprise-grade compute with an API call

**AWS 2024 scale:**
- Annual revenue: ~$100B (25% market share)
- Mission accomplished: startups can now scale globally without a single physical server

**The manufacturing analog (what PCC proposes):**
| Cloud compute (2006) | Physical manufacturing (2026 without PCC) |
|---|---|
| Buy server → 6-week lead | Quote a CNC job → 2–14 day quote cycle |
| 6-figure capital minimum | Minimum order quantities, setup fees |
| Can't provision via API | No machine-readable capability catalog |
| AWS launches → API-first compute | PCC → API-first physical capability |
| Spot instances → dynamic pricing | Meteora DLMM pools → dynamic capability pricing |
| EC2 instances → abstracted hardware | Shop Kernels → abstracted equipment |
| AWS IAM → access control | PCC Execution Scopes → capability access control |

**Sources:** geekwire.com (AWS at 20), aws.amazon.com/economics, itbrew.com, medium.com (EC2 history)

---

## 3. AI Agent Economy

### 3.1 Market Size and Projections

**Key figures:**
- 2024 baseline: $5.1B (AI agents market, Grand View Research via PR Newswire)
- 2025 estimate: $7.63B–$7.84B
- 2030 projection: $50.31B at 45.8% CAGR (Grand View Research)
- 2032 projection: $93.20B (agentic AI specifically, Markets and Markets)
- 2033 projection: $182.97B at 49.6% CAGR (Demand Sage)
- 2035 projection: $127.86B for autonomous agents specifically (Precedence Research)
- Autonomous agents sub-market: $4.35B in 2025 → $127.86B by 2035 at 40.22% CAGR

**Consensus:** AI agent market growing ~44–46% CAGR, from ~$5B today to $50–180B by 2030–2033 depending on definition

**Sources:** marketsandmarkets.com, grandviewresearch.com, precedenceresearch.com, demandsage.com

### 3.2 Agent Counts and Tool-Calling Adoption

**Enterprise adoption (2024–2025):**
- 79% of organizations have implemented AI agents at some level
- 96% of IT leaders plan to expand AI agent implementations in 2025
- 85% of enterprises expected to use AI agents in some capacity by 2025
- Only 23% are scaling agents across production workflows (majority still in pilot/limited use)
- By 2028: 33% of enterprise software apps will have built-in agentic capabilities (up from <1% in 2024)

**Market size cross-reference:**
- Agentic AI: $5.25B in 2024 → $199B by 2034 (38x, Gartner-adjacent)
- Enterprise-focused: $2.58B in 2024 → $24.50B by 2030 at 46.2% CAGR

**ROI data:**
- Average enterprise AI agent ROI: 171% (US enterprises: 192%)
- AI-enabled workflow profit contribution: 2.4% (2022) → 3.6% (2023) → 7.7% (2024)

**Tool-calling / MCP adoption:**
- OpenAI introduced function calling: June 2023
- Anthropic added tool use to Claude API: 2023
- Anthropic launched MCP (Model Context Protocol): November 2024 — open standard for agent-to-tool connectivity
- OpenAI adopted MCP: March 2025; Google also adopted 2025
- MCP is now the de facto standard for agent tool interoperability across all major AI families
- Tool-use reliability scores (Q1 2026): Anthropic 8.4, Google 7.9, OpenAI 6.3

**Agent-to-agent transaction data (2025 — real payments):**
- AI agents completed 140 million payments over 9 months in 2025, avg $0.31/transaction
- Monthly adjusted stablecoin volume: $1.25 trillion (Sept 2025)
- Stablecoin volume in first 7 months of 2025: $4 trillion+
- Stablecoin market: $300B+ in supply (Tether + USDC = 87%)
- Blockchain settlement: <500ms processing — suitable for autonomous agent operations
- McKinsey projects agentic commerce at $3–5 trillion opportunity by 2030

**The payment rails are being built — but for digital transactions only. Physical capability settlement (PCC's escrow model) is the missing piece.**

**Implication:** MCP exists for digital tools. PCC proposes MCP-equivalent for PHYSICAL capabilities. The timing is ideal — MCP is converging just as physical-agent gap becomes apparent.

**Sources:** masterofcode.com, datagrid.com, landbase.com, arcade.dev, mindstudio.ai, wikipedia.org (MCP), nevermined.ai, pymnts.com, bcg.com, thepaypers.com

### 3.3 The Physical Gap — Documented Evidence

**Agent economy is here, but physical access is the missing layer:**
- "In 2025, artificial intelligence shifted from assisting to acting — with agentic AI systems that can plan multistep work, call tools and APIs, and execute transactions" (PYMNTS.com)
- "Autonomous LLM agents are bumping into the walls of a payments system built for the last century, hitting hurdles like authentication pop-ups, CAPTCHAs, and blocked transactions" (theaiinnovator.com)
- "A critical limitation remains: Agents cannot interact with the physical world" — the Agentic Commerce Protocol only replaces UI-bound checkout with API-native purchase flows (dev.to)
- "The industry has moved quickly to solve how agents pay, but has not yet solved the harder question of how to govern autonomous economic actors at scale" (theaiinnovator.com)

**Competing digital payment rails (but NO physical capability layer):**
- OpenAI + Stripe: Shared Payment Token (scoped, time-sensitive) for digital purchases
- Virtuals Protocol: smart contracts for transparent agent-to-agent interaction
- Exe Protocol: completing Anthropic's token economy
- **Gap:** ALL of these solve digital/financial transactions. NONE solve "agent needs a CNC part machined."

**IIoT/Digital Thread context (adjacent market):**
- Digital Thread Market: $11.76B in 2024 → $52.69B by 2032 at 20.64% CAGR
- Industrial IoT: $119–483B in 2024 (varies by scope) — machines are being connected
- Cloud-based IIoT fastest growing: 20.99% CAGR
- ABB, Capgemini, Microsoft, Rockwell, Schneider, Siemens: joint initiative in 2024 for IIoT interoperability
- **But:** IIoT connects machines to operators, not agents. PCC is the missing agent-access layer on top.

**Sources:** pymnts.com, theaiinnovator.com, dev.to, medium.com, finance.yahoo.com (SNS Insider), grandviewresearch.com, technavio.com

---

## 4. DePIN (Decentralized Physical Infrastructure Networks)

### 4.1 Market Cap and Scale

**Key figures:**
- Total DePIN market cap: $32B+ (Nov 2024), $50B+ (early 2025), ~$19.2B (Sept 2025 — post-correction)
- 270% YoY growth from Sept 2024 ($5.2B) to Sept 2025 ($19.2B)
- 1,170+ active DePIN projects as of Feb 2025 (up from 650 in 2023)
- 5.7 million devices deployed across 196 countries
- **Projection:** $3.5 trillion by 2028 (widely cited but speculative)

**Largest projects (by market cap, Nov 2024):**
- ICP (Internet Computer): $4.3B+
- Theta Network (THETA): $1.5B+
- Bittensor (TAO): $1–3B+
- Render (RENDER): $1–3B+
- Filecoin (FIL): $1–3B+
- Helium (HNT): wireless network, Solana-based
- Grass: bandwidth marketplace

**Leading blockchain:** Solana (hosts Helium, Render, Grass)

### 4.2 Token Incentive Structures — What Works vs. Doesn't

**Structural failures identified:**

1. **Supply-side-only incentives:** Most DePINs bootstrap supply with tokens but fail to generate real demand. Without usage, node operators earn rewards only from inflation — an unsustainable Ponzi dynamic.

2. **Cold start problem:** Need nodes to attract users; need users to justify nodes. Without a demand anchor, token price drives participation — and falls apart when price drops.

3. **Cheat behavior:** Helium experienced falsified node locations, clustered deployments, mutual attestations — gaming the incentive system.

4. **Death spiral:** When token price falls, operators exit, service quality drops, users leave — self-reinforcing collapse.

**What works (Helium's lesson):**

- Helium pivoted from pure supply-side (hotspot mining) to demand-side (Helium Mobile — partnership with US carrier, 120,000 mobile users by end 2024)
- HIP 138 (proposed 2024): returned to single-token model, reduced complexity, tied emissions to network performance
- Lesson: token incentives are a bootstrap mechanism only; long-term sustainability requires REAL demand from real users paying real prices

**Sources:** frontiersin.org (DePIN tokenomics paper), medium.com (Helium case study), dwf-labs.com, chaincatcher.com

### 4.3 How PCC Differs from DePIN

- DePIN typical model: token speculation drives device deployment (e.g., Helium hotspots deployed for HNT rewards)
- PCC model: capability-level access, NOT token speculation — focus is on utility (jobs get done) not token price
- DePIN often suffers "build it and hope demand comes" problem — supply before demand
- PCC has a demand-pull model: AI agents need physical work done; PCC routes to providers
- PCC uses crypto (escrow, settlement) as infrastructure, not as the value proposition itself

**Updated DePIN data (Feb 2025):**
- 1,561 DePIN projects worldwide
- Total market cap: $30B (Feb 2025)
- AI-related DePINs dominate by market cap: 48% of total DePIN market cap
- WEF estimate: DePIN market currently $30–50B, could reach $3.5 trillion by 2028
- Leading chains: Solana (Helium, Render, Grass), Ethereum

**Sources:** grayscale.com (DePIN report), messari.io (Q1 2025 DePIN), blockeden.xyz, nadcab.com, europeanbusinessmagazine.com (2024 DePIN report)

---

## 5. Manufacturing Marketplaces (Incumbents)

### 5.1 Xometry (XMTR — publicly traded)

**2024 financials (full year):**
- Total revenue: $545M (+18% YoY)
- Marketplace revenue: $486M (+23% YoY)
- Supplier services revenue: $59.6M (-13% YoY)
- Gross margin: 34.5% (record high, up from ~32% prior year)
- Active buyers: 68,000+ (+23% YoY)
- Active suppliers: 4,375 (+28% YoY)
- EBITDA: still negative (-$9.7M adjusted), but improving ($17.8M better than prior year)

**Business model:** AI-powered marketplace connecting buyers to suppliers. Takes 30–40% margin on jobs.

**Xometry S-1 / early data (Bowery Capital teardown):**
- S-1 TAM claim: $260B global spend across 6 verticals (aerospace, healthcare, auto, consumer goods, industrial, robotics)
- 2020 revenues: $141M GMV; effective take rate ~20% → net revenue ~$33M
- 92% CAGR from 2018–2020 ($38M → $141M GMV)
- 95% of revenue from existing buyers (wallet expansion)
- Market characterized as "fragmented, opaque, and relatively offline" (Xometry's own language)
- By 2024: $545M revenue, 35.7% gross margin → significant take rate improvement from S-1 era

**On-demand/custom manufacturing market (the specific PCC sub-market):**
- Custom parts on-demand: $4.60B in 2024 → $11.66B by 2032
- On-demand manufacturing services (broader): $5.97B in 2024 → $24.79B by 2034 at 15.3% CAGR
- Key players: Xometry, Protolabs, Fictiv, Jabil, Stratasys Direct, Zetwerk

**Sources:** investors.xometry.com (Q4/FY2024 earnings), globenewswire.com, voxelmatters.com, bowerycap.com (S-1 teardown), intelmarketresearch.com, statifacts.com

### 5.2 Protolabs / Hubs

**2024 financials:**
- Total revenue: $500.9M (flat, -0.6% YoY)
- Gross profit: $223.2M; gross margin: 44.6%
- 3D printing segment: $83.8M (-0.6% YoY)
- Protolabs Network (formerly Hubs, their marketplace): $100.4M (+21.6% YoY) — the growth engine

**Business model:** Hybrid — own factories (injection molding, CNC) + outsourced network (Hubs). Higher margins (~44%) because they own the equipment.

**Sources:** investors.protolabs.com, ifun3d.com, voxelmatters.com

### 5.3 Fictiv

- Private company; no public financials
- Estimated revenue: $50–100M range (based on funding rounds and headcount)
- Series D funded; focus on hardware prototyping supply chain
- Business model: curated supplier network, similar to Xometry but more premium/hardware-startup focused
- Known margins: 30–50% typical for digital manufacturing marketplaces

**Sources:** owler.com, jiga.io, rapiddirect.com

### 5.4 Shapeways

- Went public via SPAC (2021), subsequently struggled, filed Chapter 11 bankruptcy (2023)
- Post-bankruptcy: acquired assets, pivoted to software/platform model
- Key lesson: pure marketplace for 3D printing at consumer scale failed; enterprise/B2B model required

### 5.5 Why They Are Platforms, Not Protocols

- **Platforms** (Xometry, Protolabs): centralized orchestration, proprietary APIs, human sales teams, 30–45% take rates, closed ecosystems
- **Protocols** (what PCC is): open standard, agent-native, any agent can call any registered capability, take rate approaches zero (or is just gas/settlement)
- Xometry's 23% marketplace growth at 34.5% margin shows the market exists — but the value capture model is ripe for disruption
- Key pain points reported by buyers: slow quoting (days not seconds), minimum order quantities, no programmatic access, can't be called by AI agents
- Key pain points for suppliers: high platform fees, buyer discovery costs, locked into proprietary systems

**Documented buyer pain points (from comparison sites + Practical Machinist forum):**
- "After you submit designs, you just sit and wait — near-zero control or visibility on the process" (oshcut.com)
- "Getting a line to the factory floor is next to impossible" (oshcut.com)
- "Prices are astronomically high" for sheet metal (rapiddirect.com)
- Lead times unpredictable, frequently extend into weeks even for simple parts
- Cannot select specific suppliers for repeat orders — opaque matching algorithm
- DFM feedback delayed or absent — file goes in, quote comes out, no dialogue
- **The protocol answer:** PCC exposes the capability directly; agents can query capability parameters, get instant quotes, place jobs, and monitor status via SSE streams — no human intermediary

**Xometry take rate detail:**
- Xometry is principal in every transaction (manufacturer of record)
- Revenue = GMV (not just a fee); gross margin = their cut
- Target long-term marketplace margin: 30–35%
- Current actual marketplace margin: 35.7% (2024)
- Supplier side: free to join, no subscription fees — Xometry makes margin on the buyer side
- This model is inherently non-composable: agents cannot call Xometry's API and get a live quote + instant job placement
- Practical Machinist forum: suppliers complain Xometry underprices jobs, creates race-to-bottom, takes 35–50% of what buyer pays

**Sources:** unconventionalvalue.com, bowerycap.com, nerdoutonbusiness.com, investors.xometry.com

---

## 6. Synthesis — The Belief Moat Case

### 6.1 Market Size Summary (Real Numbers)

| Market | 2024 Size | 2030 Projection | CAGR |
|--------|-----------|----------------|------|
| Contract manufacturing (global) | $731B | $968–1,087B | 6–8% |
| CNC machining services | $66–80B | $120B | 5.5% |
| 3D printing / additive mfg | $15–20B | $36–88B | 17–23% |
| Lab testing services (industrial) | ~$84B | — | — |
| On-demand custom parts (PCC direct) | $4.6–6B | $12–25B | 15–20% |
| AI agents market | $5.1B | $50–183B | 44–46% |
| Industrial IoT | $119–483B | $286–1,693B | 8–23% |
| Digital Thread | $11.8B | $52.7B | 20.6% |
| DePIN total market cap | $30–50B | $3.5T (WEF est.) | — |
| Cloud infrastructure | ~$330–360B/yr | — | 20–25% |

**PCC's TAM (conservative):** The on-demand custom manufacturing market ($5.97B in 2024) is the immediate SAM. The full contract manufacturing market ($731B) is the theoretical TAM with protocol-level disruption. Xometry alone claims $260B as its addressable market (6 verticals).

### 6.2 The Convergence Window (Why Now)

Three curves are converging in 2025–2026:

1. **AI agents are proliferating** — 79% enterprise adoption, 140M agent payments in 2025, MCP standardized across OpenAI/Anthropic/Google
2. **Manufacturing is still pre-API** — $731B market, no company >5% share, described as "fragmented, opaque, offline"
3. **Payment rails are ready** — Stablecoin volume $4T in 7 months of 2025, <500ms settlement, USDC/USDT stable

The window: agents CAN transact → agents WANT to make physical things → NO standard protocol exists → PCC fills the gap.

### 6.3 The Competition Reality

| Incumbent | Revenue | Take Rate | Agent-Native? | Open Protocol? |
|-----------|---------|-----------|--------------|----------------|
| Xometry | $545M (2024) | 35.7% | No | No |
| Protolabs | $500.9M (2024) | 44.6% | No | No |
| Fictiv | ~$50–100M | 30–50% | No | No |
| Shapeways | Bankrupt (2023) | — | No | No |

None of the incumbents are agent-native. None offer open protocols. All take 30–45% margin that PCC can route around. The marketplace model is proven (Xometry 23% GMV growth) — the protocol model is the inevitable successor.

### 6.4 The DePIN Lesson Applied

Helium is the cautionary tale: supply-side token incentives without demand = death spiral. PCC avoids this by:
- Starting with DEMAND (AI agents that need physical work done)
- Using crypto as settlement infrastructure, not as the value proposition
- Protocol-level access (PCC fees = protocol gas, not platform rent)
- Real work at real prices generating real revenue — not token inflation

### 6.5 The AWS Framing (Pitch-Ready)

- AWS in 2006: "compute for $0.10/hour, provision via API, no minimums"
- PCC in 2026: "CNC machining for $X/hour, commission via API, any quantity"
- AWS reduced prices 107x as scale improved → PCC will compress 35% marketplace margins to protocol minimums
- AWS TAM (2024): $330B/yr → Manufacturing TAM: $731B → PCC's ceiling is larger than AWS's realized market
- The analogy is tight: Shop Kernels = Availability Zones, Capabilities = billable units, Assurance Tiers = SLAs, Execution Scopes = IAM

### 6.6 Key Data Points for Investor Pitch

1. **$731B** — Global contract manufacturing market (2024), no dominant player, <5% share each
2. **~250,000** — Small/medium manufacturers in US alone, with millions globally (the supply side)
3. **79%** — Enterprise AI agent adoption; MCP standardized across all major AI providers (the demand side)
4. **140M** — Agent payments completed in 9 months of 2025 @ avg $0.31 (proving agents transact)
5. **35.7%** — Xometry's take rate; PCC protocol fee will be 1–5% (the margin compression thesis)
6. **$5.97B → $24.79B** — On-demand manufacturing market growing 15.3% CAGR (the immediate TAM)
7. **$0.10/hr** — What AWS charged in 2006; what happened to server prices since (the historical analog)
8. **0** — Number of open protocols for AI-agent access to physical manufacturing capabilities (the gap)

---

## Raw Search Results

(All raw data incorporated into sections above — no unprocessed remainder)
