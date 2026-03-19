# PCCP Launch Playbook: Zero to 1,000 Machines
## 104-Week Week-by-Week Execution Plan

**Starting position**: Code is shipped. 18 packages, 832 tests, deployed on Railway free tier.
Zero cash. Zero machines on network. Zero paying customers.

---

## Ground Rules and Financial Model

### Revenue Model
- **Protocol fee**: 1–3% of every job that clears escrow on-chain
- **Verification fee**: $0.10–$0.50 per attestation bundle
- **SLA bond float**: protocol earns yield on locked collateral during challenge windows
- **Enterprise API**: $199–$999/month flat seat for MCP/agent integrations

### Cost Structure Assumptions
- Founders take $0 salary until Week 17 (post-first-raise)
- All infrastructure on free tiers until revenue or funding justifies upgrade
- Hardware at operator sites: operator-owned model (they buy, we subsidize 50% up to $500 via grant treasury in Year 1)
- TEE cluster deferred until Phase 3 (Week 37+)

### Funding Sources by Phase
| Phase | Source | Expected Amount |
|-------|---------|----------------|
| Phase 0 (Wk 1-4) | $0 cash, sweat equity | — |
| Phase 1a (Wk 5-8) | Hackathon prizes + grants | $5K–$50K |
| Phase 1b (Wk 9-16) | DePIN accelerator / angel | $50K–$200K |
| Phase 2 (Wk 17-36) | Pre-seed SAFE or YC | $500K–$1.5M |
| Phase 3 (Wk 37-60) | Seed round | $2M–$5M |
| Phase 4 (Wk 61-104) | Series A | $10M–$25M |

---

## PHASE 0: Pre-Capital (Weeks 1–4)
### Goal: Build proof that operators want this. Spend nothing.

---

### Week 1 — Documentation Blitz and First Contact
**What happens**
- Publish GitHub repo as public (MIT license on core protocol layer, BSL on agent runtime — "open core" model)
- Write operator-facing one-pager: "What PCCP does for your shop in plain English"
- Post on Hacker News: Show HN (Sunday night for maximum reach)
- Post on X/Twitter: 3-thread series explaining the protocol stack
- Cold-DM 20 makerspaces, job shops, and FabLab operators on LinkedIn
- Join Farcaster /depin channel and post intro

**Cost**: $0
**Cumulative spend**: $0
**Money from**: Sweat equity
**Milestones**: Repo public, 3 threads live, 20 outreach messages sent

---

### Week 2 — Apply to Everything Free
**What happens**
- Submit application to **Outlier Ventures DePIN Base Camp** (next cohort; $200K investment + 12 weeks mentorship)
  - Application is free; takes ~4 hours
- Submit to **YC Summer 2026 batch** (deadline ~May 4, 2026 — start application now)
  - Free; decision by ~June 5
- Submit to **NSF SBIR Phase I** concept pitch (manufacturing + IoT topic area)
  - Free to submit; $305K award if accepted
- Apply to **Solana Foundation grant** for open-source developer tooling
  - Amounts: $5K–$50K (microgrant to medium grant)
- Apply to **Filecoin/IPFS ecosystem fund** (PCC already uses Helia/IPFS for evidence storage)
  - Amounts: $10K–$50K

**Cost**: $0 (all applications free)
**Cumulative spend**: $0
**Money from**: Time only
**Milestones**: 5 applications submitted

---

### Week 3 — First Operator Pilot Agreements
**What happens**
- Follow up on 20 cold DMs — target 3 intro calls
- Offer pilot terms: "We connect your machine at zero cost to you. You share utilization data. We share 80% of any job revenue back to you for the first 6 months."
  - This is a better-than-market deal (most DePIN networks take 25–30% permanently)
- Draft a simple Letter of Intent (LOI) — one page, not a legal contract
  - Use Google Docs; zero legal cost at this stage
- Research: identify 3 community makerspaces within 50 miles (they have CNC, laser cutters, mills)
  - Contact MakerNexus, TechShop successors, local hackerspaces
  - These operators have lower utilization anxiety and higher experimentation tolerance
- Build demo video: screen-record the 18/18 vendor integration demo script passing
  - Upload to YouTube (unlisted) and embed in pitch deck

**Cost**: $0
**Cumulative spend**: $0
**Money from**: Sweat equity
**Milestones**: 3 intro calls booked, 1 LOI target identified

---

### Week 4 — Accelerator Prep and Community Seed
**What happens**
- Refine YC application with Week 3 operator feedback embedded ("we have 2 operators who signed LOIs")
- Create a Discord server: "PCCP Operators" — initial channels: #announcements, #integration-help, #show-your-machine
- Post on Reddit: r/MachineLearning (agent layer), r/ethdev (contracts), r/manufacturing (operator angle)
- Cold-email 5 angel investors who have invested in industrial tech or DePIN:
  - Target list: Multicoin Capital, Borderless Capital, Escape Velocity, Lattice Fund, 1kx
  - Ask for feedback, not money — "would you look at this for 20 minutes?"
- Finalize operator pilot agreement template (still no lawyer needed — use open-source YC SAFE template as reference; actual legal work deferred until funding)

**Cost**: $0
**Cumulative spend**: $0
**Money from**: Sweat equity
**Milestones**: Discord launched, YC app complete, 5 investor warm contacts made

---

## PHASE 1A: First Real Money (Weeks 5–8)
### Goal: Win a hackathon prize or small grant. $5K–$50K unlocks hardware pilots.

---

### Week 5 — Hackathon Circuit Starts
**What happens**
- Enter **Funding the Commons SF** (already targeted per memory context — Mar 14-15, 2026)
  - Prize pool varies; typical: $5K–$25K top prize
- Enter **ETHDenver** or **ETHGlobal** hackathon track (March–April 2026 cycle)
  - DePIN/RWA tracks: $5K–$50K prizes
- Enter **Solana Radar Hackathon** if open (recurring; $500K total pool across tracks)
- Prepare 3-minute demo: live on-chain job creation → escrow → attestation → settlement
  - Use the existing 18/18 demo script
- Talk to 3 judges beforehand at networking events — "warm the room"

**Cost**: Travel to SF for Funding the Commons if not local
  - If local: $0
  - If remote: $200–$500 flights + accommodation
**Budget assumption**: $300 from personal funds (pre-raise)
**Cumulative spend**: $300
**Money from**: Personal funds
**Milestones**: 2–3 hackathon submissions, 1 live demo presentation

---

### Week 6 — Accelerator Interview Prep
**What happens**
- Likely: DePIN Base Camp applications reviewed (submitted Week 2)
- If invited to interview: prep 10-minute pitch covering
  - Problem: $7.8T manufacturing sector, <1% verified on-chain
  - Solution: Shop Kernels as Availability Zones
  - Traction: X LOIs, working demo, 832 tests green
  - Ask: $200K for first 3 machine pilots and 6-month runway
- Deep-dive on operator onboarding cost model:
  - Hardware per machine site: Raspberry Pi CM5 (8GB/64GB) = ~$95 + industrial enclosure = ~$150 + OPC-UA gateway (Advantech ADAM-6717 class) = ~$400–$800 → **total $645–$1,045 per machine site**
  - Installation labor: 4–8 hours founder time, $0 cash in bootstrapped phase
  - Software: free (open-source stack)
- Sign first LOI with a makerspace operator

**Cost**: $0 (prep work only)
**Cumulative spend**: $300
**Money from**: Sweat equity
**Milestones**: 1 formal LOI signed, DePIN Base Camp interview outcome known

---

### Week 7 — First Hackathon Result
**What happens**
- Collect any hackathon prizes won in Week 5
  - **Conservative estimate**: $5,000 (participation/honorable mention tier)
  - **Target**: $15,000–$25,000 (top-3 finish in DePIN/RWA track)
- If won: immediately open a business bank account (Mercury — free, FDIC-insured, crypto-friendly)
  - File Delaware C-Corp via Clerky: **$350** (Clerky flat fee) + **$750** Delaware state fees = **$1,100 total**
  - This is the only legal spend until pre-seed closes
- Use prize money to buy first 2 machine kits:
  - Kit 1: Raspberry Pi CM5 8GB/64GB ($95) + CM5 IO board ($35) + industrial DIN-rail enclosure ($45) + 128GB industrial SD ($25) = **~$200 per edge node**
  - OPC-UA gateway for Kit 1: Softing uaGate SI or equivalent Modbus gateway = **$400–$600**
  - Total Kit 1 hardware: **~$700–$800**
- Deploy Kit 1 at pilot makerspace (founder drives there, no shipping cost)

**Cost**: $1,100 (legal) + $800 (hardware kit 1) = **$1,900** (from prize money)
**Cumulative spend**: $2,200 (incl. Week 5 travel)
**Hackathon prize income**: +$5,000–$25,000
**Net cash position**: +$2,800–$22,800
**Milestones**: Delaware C-Corp formed, first machine kit purchased, first physical deployment

---

### Week 8 — First Machine Online
**What happens**
- Install Kit 1 at pilot operator's CNC mill or laser cutter
  - Plug CM5 into local network via Ethernet
  - Configure OPC-UA gateway to talk to machine controller (Fanuc, Haas, or GRBL depending on machine)
  - Deploy `@pcc/kernel` on CM5: `npm install && node dist/server.js`
  - Register machine as Shop Kernel on Base Sepolia testnet (gas cost: ~$0.50 of test ETH from faucet)
- Run first live job through the full stack:
  - Browser → Dashboard → Contract Builder → Workflow → Escrow → Machine → Evidence → Attestation → Settlement
- Screen-record the entire flow: this is your fundraising proof of life
- Post on X: "First real machine job verified on-chain. CNC mill in [City]. Watch the whole flow."
- DM the recording to all 5 investor contacts from Week 4

**Cost**: $50 (gas for mainnet-adjacent testnet operations, misc hardware cables)
**Cumulative spend**: $2,250 (or less if large prize)
**Money from**: Hackathon prize
**Milestones**: MACHINE 1 ONLINE. First end-to-end on-chain job. Video proof published.

---

## PHASE 1B: Accelerator or Angel Bridge (Weeks 9–16)
### Goal: Close $50K–$200K. Get to 5 machines. Build the operator onboarding engine.

---

### Week 9 — Accelerator Decision Week
**What happens**
- DePIN Base Camp decision arrives (if applied Week 2, interviewed Week 6)
  - **If accepted**: $200K investment (up to), 12-week program starts, access to 400+ mentors, 180+ alumni
  - **If rejected**: pivot to angel round (see Week 10 path)
- If accepted: negotiate terms — standard Outlier Ventures Base Camp is equity-based SAFE, typically 5–8% for $200K
- Begin NSF SBIR Phase I full proposal (if concept pitch advanced)
  - Award: **$305,000** non-dilutive
  - Timeline: 6–9 months from submission to award
  - Key: frame PCCP as "verifiable manufacturing performance infrastructure for US industrial base"
- Apply to **Filecoin Foundation Dev Grants** (PCCP uses Helia/IPFS)
  - Large grants: up to $50K; requires open-source deliverables

**Cost**: $0
**Cumulative spend**: $2,250
**Expected new funding**: $50K–$200K (accelerator) OR zero (wait for angel)
**Milestones**: Funding path confirmed, NSF SBIR proposal drafted

---

### Week 10 — Second Machine + First Revenue Signal
**What happens**
- Deploy Kit 2 at second pilot operator (different machine type — target a mill to complement Week 8 laser/CNC)
- Hardware cost: same $700–$800 kit
- Run paid job on Machine 1:
  - Identify a buyer who needs 1 hour of laser cutting time
  - Price: $80/hour (below market; market is $150–$200/hour for quality laser time in urban makerspaces)
  - PCCP protocol fee: 2% = **$1.60** first real protocol revenue
  - This number is not meaningful in dollars. It is extremely meaningful as proof.
- Post "First $1.60 of protocol revenue on-chain" — the DePIN community celebrates these milestones
- Calculate unit economics:
  - If Machine 1 runs 40 hours/month at $80/hour = $3,200/month operator revenue
  - Protocol fee at 2% = $64/month per machine
  - 100 machines = $6,400/month protocol revenue
  - 1,000 machines = $64,000/month protocol revenue
  - This is the slide VCs need to see

**Cost**: $800 (Kit 2 hardware)
**Cumulative spend**: $3,050
**Revenue this week**: $1.60 (first on-chain protocol fee — symbolic but real)
**Money from**: Accelerator funding or prize reserve
**Milestones**: Machine 2 online, first real revenue event recorded on-chain

---

### Week 11 — Operator Onboarding Productization
**What happens**
- Write the "PCCP Operator Onboarding Runbook" — publicly available
  - Hardware BOM (Bill of Materials) for 5 machine types: CNC mill, laser cutter, 3D printer (FDM), injection mold machine, industrial robot arm
  - Software install steps: 3 commands (`git clone`, `npm install`, `pcc register`)
  - Video walkthrough: 15 minutes from unboxing to first verified job
- Goal: any competent technician should be able to onboard a machine in 2–4 hours without founder involvement
- This is the scaling unlock: you cannot be present at every machine installation
- Post the runbook on GitHub — community contributions welcome

**Cost**: $0
**Cumulative spend**: $3,050
**Money from**: Existing reserve
**Milestones**: Operator runbook published; onboarding time target: < 4 hours

---

### Week 12 — Third Machine + Community Expansion
**What happens**
- Deploy Kit 3 (third operator, or second machine at a highly active pilot site)
- Start a monthly "PCCP Operator Call" — 30-minute Zoom, open to anyone
  - Share: what jobs ran this month, what we learned about the stack, upcoming features
  - This builds community and generates word-of-mouth
- Submit application to **IoTeX MachineFi grants** (IoTeX is a DePIN-focused L1 with grant programs)
  - Typical range: $10K–$50K for ecosystem projects
- Submit to **peaq network grants** (ecosystem fund for connected physical assets)
  - Amounts: $5K–$25K for tooling and protocols
- Follow up on Solana Foundation application (submitted Week 2)

**Cost**: $800 (Kit 3 hardware)
**Cumulative spend**: $3,850
**Money from**: Accelerator/angel bridge
**Milestones**: Machine 3 online; first community call held; 3 grant applications in flight

---

### Week 13 — Investor Pipeline Build
**What happens**
- Build a target list of 30 investors for pre-seed:
  - **DePIN-focused VCs**: Multicoin Capital, Borderless Capital, Escape Velocity, Lattice Fund, 1kx, IoTeX Ventures, peaq Fund
  - **Industrial/Manufacturing VCs**: Alumni Ventures, In-Q-Tel (defense manufacturing angle), Andreessen a16z crypto (DePIN thesis)
  - **Angels**: ex-Helium, ex-Hivemapper, ex-Filecoin founders who know DePIN unit economics cold
- For each investor: find warm intro path via LinkedIn → founder network
- Begin sending "investor update" emails (even with no investor relationship yet):
  - Format: 3 machines online, $X.XX protocol revenue, 1 accelerator accepted, demo video link
  - Subject line: "PCCP: Verifiable Physical Capabilities — Week 13 Update"
- Seed investors in 2025–2026 want to see: revenue or demand-side traction, deployed network (not concept), team with hardware experience

**Cost**: $0
**Cumulative spend**: $3,850
**Money from**: Existing reserve
**Milestones**: 30-investor target list built; investor update #1 sent

---

### Week 14 — NSF SBIR Deep Work
**What happens**
- Complete NSF SBIR Phase I full proposal submission
  - Topic: "Advanced Manufacturing / Industrial Internet of Things"
  - Technical narrative: verifiable capability attestations as the missing trust layer for distributed manufacturing
  - Commercial potential: $7.8T manufacturing market, verifiable SLAs enable new insurance/finance products
  - Budget: up to $305K over 6–12 months
  - Required: US-incorporated entity (you have Delaware C-Corp from Week 7)
- Note: NSF SBIR was temporarily paused in 2025 due to congressional authorization lapse; check current status at seedfund.nsf.gov
- If NSF SBIR paused: redirect effort to **DoD SBIR** (ManTech office is active in manufacturing readiness topics) and **NIST MEP grants** (Manufacturing Extension Partnership — up to $300K for digital manufacturing tools)
- Continue accelerator program deliverables in parallel

**Cost**: $0 (proposal writing is founder time)
**Cumulative spend**: $3,850
**Money from**: Sweat equity
**Milestones**: NSF SBIR Phase I submitted (or DoD SBIR alternative)

---

### Week 15 — Fourth and Fifth Machine; Revenue Milestone
**What happens**
- Deploy Kits 4 and 5 — now at different geographic locations to demonstrate network geography
  - Target: at least 2 different cities by Week 16
  - This proves network, not single-site lab demo
- Hardware cost: $800 × 2 = $1,600
- Month-end revenue tally: 5 machines, assuming 20 hours/machine/month average utilization
  - 5 machines × 20 hours × $80/hour × 2% protocol fee = **$160/month**
  - Still small, but the unit economics are clean and provable
- Prepare pre-seed pitch deck (12–15 slides):
  - Cover, Problem, Solution, Product (with demo), Market ($7.8T manufacturing), Traction (5 machines, $160/month), Business Model, Team, Competition, Go-to-Market, Use of Funds, Ask

**Cost**: $1,600 (hardware Kits 4 and 5)
**Cumulative spend**: $5,450
**Monthly protocol revenue**: ~$160 (annualized ~$1,920)
**Money from**: Accelerator/grant bridge
**Milestones**: 5 MACHINES ONLINE. Revenue trajectory established. Pitch deck v1 complete.

---

### Week 16 — Pre-Seed Fundraise Kick-Off
**What happens**
- Begin outbound investor meetings (20 meetings target over 4 weeks, running into Phase 2)
- Warm intros via accelerator partner network (if in DePIN Base Camp: 400+ mentors, 180+ alumni)
- Share deck + demo recording in every first meeting
- Key metrics to lead with:
  - 5 machines across 3+ cities
  - $160/month protocol revenue (growing)
  - 832 tests green; 44+ dashboard routes; 18 integrated vendors
  - NSF SBIR Phase I in review ($305K non-dilutive)
  - First operator "this changed how I think about shop utilization" quote
- Target raise: **$750K on a post-money SAFE at $5M cap**
  - Why $5M cap: in line with DePIN seed valuations of $10M–$50M FDV, but discounted for pre-revenue stage
  - Why $750K: enough for 6–12 months of runway at lean burn (2 founders + hardware + cloud)

**Cost**: $0 (pitch meetings are free)
**Cumulative spend**: $5,450
**Money from**: In raise process
**Milestones**: Investor deck in market; 5 meetings booked in first week

---

## PHASE 2: First Real Money — Getting to 10 Machines (Weeks 17–36)
### Goal: Close pre-seed. Hire first person. Get to 10 machines. First enterprise LOI.

---

### Week 17 — Pre-Seed Closes (Target)
**What happens**
- Close $750K pre-seed SAFE ($5M post-money cap)
  - Realistic investor composition: 2–3 DePIN-focused angels or micro-VCs
  - DePIN seed valuations range $10M–$50M FDV; $5M cap is conservative and fundable with 5 real machines running
- Legal cost to close SAFE: **$2,000–$4,000** (startup attorney to review; use Clerky docs as base)
- Open Mercury business account (already done), move funds in
- Founders begin paying themselves: **$4,000/month each** (below market but sustainable)
  - This is deliberate: preserve runway for hardware and hiring
  - Engineers at industrial IoT startups earn $83K–$110K; founding salary of $48K/year is below market, justified by equity

**Raise**: +$750,000
**Cost this week**: $3,000 (legal) + $8,000 (first month founder salaries × 2) = $11,000
**Cumulative spend**: $16,450
**Cash in bank**: ~$738,550
**Milestones**: PRE-SEED CLOSED. Founders on payroll.

---

### Week 18 — First Hire
**What happens**
- Hire "Founding Engineer #1" — focus: edge compute + industrial protocols
  - Salary: **$95,000/year** (~$7,917/month) — market rate per Carta H1 2025 data ($83K–$110K for industrial IoT)
  - Equity: **1.5%** on 4-year vest, 1-year cliff (standard first engineer package)
  - Location: remote-first; must be able to travel to pilot sites 2–3 days/month
  - Post on LinkedIn, Hacker News "Who's Hiring", and DePIN Discord
- This hire accelerates machine onboardings from 1/month (founder-limited) to 3–4/month
- Begin deploying Kits 6, 7, 8 in parallel with new engineer onboarding

**Hire cost per month**: $7,917 salary + ~$800 benefits (health insurance via Gusto) = **$8,717/month**
**Hardware Kits 6–8**: $800 × 3 = **$2,400**
**Cumulative spend**: $27,567
**Cash in bank**: ~$722,433
**Milestones**: First hire made; Kits 6–8 in deployment pipeline

---

### Week 19–20 — Infrastructure Upgrade (Paid Tier)
**What happens**
- Move off Railway free tier to Railway paid plan: **$20/month** (enough for gateway + dashboard at current scale)
- Add Alchemy or QuickNode RPC endpoint for Base mainnet: **$49/month** (growth plan)
  - Testnet: still free; mainnet calls need reliability
- Set up PagerDuty free tier for on-call alerting: $0 (free for < 5 users)
- Set up Sentry error tracking: **$26/month** (team plan)
- Total new recurring infra cost: **$95/month**
- Deploy Kits 6, 7, 8 — targeting Weeks 19–20

**Infrastructure cost**: $95/month
**Cumulative spend**: $28,000 (approx)
**Cash in bank**: ~$722,000
**Milestones**: Machines 6, 7, 8 ONLINE; production infra upgraded

---

### Weeks 21–24 — Operator Acquisition Engine
**What happens (each week)**
- Week 21: Deploy Kit 9; engineer handles Kit 10 deployment solo (validates runbook)
- Week 22: 10 MACHINES ONLINE — first major network milestone
  - Announce loudly: "10 machines, 3 states, [N] verified jobs completed on-chain"
  - Update investor list: send update #2
- Week 23: Begin enterprise BD outreach — target contract manufacturers (job shops), university fabrication labs, biotech equipment operators
  - Enterprise channel: $199–$999/month API seat → dramatically higher LTV than consumer DePIN
  - Cold email 30 contract manufacturers using LinkedIn Sales Navigator ($0 — use free trial)
- Week 24: First enterprise demo call (target: 1 signed enterprise LOI by end of Phase 2, Week 36)

**Hardware**: $800/kit × 2 more kits = $1,600 (reach 10 machines)
**BD costs**: $0 (founder time + free LinkedIn trial)
**Cumulative spend by Week 24**: ~$62,000
**Monthly protocol revenue at 10 machines**: 10 × 20 hrs × $80/hr × 2% = **$320/month**
**Milestones**: 10 MACHINES ONLINE. Enterprise BD launched.

---

### Weeks 25–28 — Tokenomics Design and Base Mainnet
**What happens**
- Design protocol token (do not launch yet — premature token launch destroys DePIN projects)
- Define: emission schedule, operator reward curve, staking for SLA bonds, governance
  - Key insight from 2025 DePIN market: investors reward projects at 10–25× revenue, not speculative tokenomics
  - Token launch triggers: >50 machines, >$10K/month protocol revenue, clear demand-side traction
- Deploy MilestoneEscrow and custom NFT program to **Base mainnet** (not just Sepolia)
  - Gas cost for contract deployment on Base mainnet (L2): estimated **$15–$50** total
  - Base mainnet provides real economic finality for enterprise-grade jobs
- Begin Series A prep: update pitch narrative from "we have 10 machines" to "we have a replicable operator onboarding engine"

**Gas for mainnet deployment**: ~$30
**Cumulative spend by Week 28**: ~$86,000
**Monthly burn**: ~$19,000 (2 founders + 1 engineer + infra)
**Milestones**: Base mainnet live; tokenomics whitepaper v1 drafted

---

### Weeks 29–32 — First Enterprise Customer
**What happens**
- Target: close first enterprise customer paying $499/month API seat
  - Use case: contract manufacturer wants to offer "verified job completion" to their downstream buyers
  - This eliminates the need for in-person audits (each audit costs the buyer $2,000–$5,000)
  - PCCP's $499/month replaces a $24,000–$60,000/year manual audit process → ROI is undeniable
- Close first enterprise LOI (legally binding pilot agreement, 3-month trial, $499/month)
  - Revenue: $499 × 3 months = **$1,497** from single enterprise account
- Present at **Fabricate 2026** or equivalent manufacturing trade show (booth cost: $500–$2,500)
  - Alternative: speak at a DePIN conference (free speaker pass)

**Conference/BD cost**: $1,500 (travel + booth or speaker expenses)
**Cumulative spend by Week 32**: ~$104,000
**Monthly recurring revenue**: $320 (protocol) + $499 (enterprise) = **$819/month MRR**
**Milestones**: First enterprise customer. MRR crosses $500/month.

---

### Weeks 33–36 — Seed Round Preparation
**What happens**
- Compile seed round data room:
  - 10 machines across 4+ states
  - $819/month MRR (growing ~20%/month)
  - 832 tests; mainnet deployed; enterprise customer
  - NSF SBIR in review ($305K potential)
  - Operator churn: 0 (all 10 original operators still active)
- Target seed raise: **$2M at $10M post-money cap**
  - Why $10M cap: DePIN seed valuations in 2025 range $10M–$50M; $10M is defensible with 10 real machines and enterprise revenue
  - Why $2M: covers 12–18 months to get to 100 machines (Phase 3 target)
- Begin investor outreach for seed (upgrade from angels to institutional: Multicoin, Borderless, Escape Velocity)

**Legal (data room prep)**: $500
**Cumulative spend by Week 36**: ~$132,000
**Cash remaining from pre-seed**: ~$618,000 (healthy runway into seed close)
**Milestones**: Seed deck v1 built. Data room ready. Investor meetings scheduled.

---

## PHASE 3: Network Growth (Weeks 37–60) — 10 to 100 Machines
### Goal: Close seed round. Hire 3 more people. Get to 100 machines. Series A prep.

---

### Week 37 — Seed Round Closes (Target)
**What happens**
- Close **$2M seed round** on post-money SAFE at $10M cap
  - Investor composition: 1 lead VC (DePIN-focused) + 2–3 follows
  - Legal cost to close: **$8,000–$15,000** (priced round attorney fees if converting to equity; SAFE is cheaper)
- If NSF SBIR Phase I awarded by now: **+$305,000 non-dilutive** — keep 100% equity
  - Total cash in scenario: $2M + $305K = $2.305M

**New funds**: +$2,000,000
**Legal**: $10,000
**Cumulative spend**: $142,000
**Cash in bank**: ~$2,176,000 (seed) + any remaining pre-seed
**Milestones**: SEED CLOSED. War chest for 100 machines.

---

### Weeks 38–40 — Hiring Wave 1
**What happens**
- Hire **Engineer #2** (specialization: smart contracts + blockchain integration)
  - Salary: $105,000/year; equity: 0.8% on 4-year vest
  - Monthly cost: $8,750 + $900 benefits = $9,650/month
- Hire **Operator Success Manager** (non-technical; manages operator relationships and onboarding)
  - Salary: $65,000/year; equity: 0.4% on 4-year vest
  - Monthly cost: $5,417 + $700 benefits = $6,117/month
- Hire **BD/Partnerships Lead** (connects PCCP to enterprise buyers and large operator fleets)
  - Salary: $90,000/year + 0.5% commission on ARR; equity: 0.6%
  - Monthly cost: $7,500 + $800 benefits = $8,300/month (base)

**New monthly burn after hiring**: founders $8K + Eng1 $8.7K + Eng2 $9.65K + OpSuccess $6.1K + BD $8.3K + infra $500 = **~$41,250/month**
**Annual burn rate**: ~$495,000
**Runway at $2M**: ~4.8 months — too short. This is why the NSF SBIR and/or early revenue matters.
**Note**: At 50 machines generating $160/month protocol revenue + 2 enterprise accounts at $499/month = ~$8,800/month by Week 45, extending runway meaningfully.
**Cumulative spend by Week 40**: ~$202,000
**Milestones**: Team of 6. Operator Success role created (key for scaling machine onboardings).

---

### Weeks 41–48 — Machine Onboarding Acceleration
**What happens**
- With Operator Success Manager: target 4–6 new machine onboardings per week
- Weeks 41–44: Machines 11–30 (20 machines added over 4 weeks)
- Weeks 45–48: Machines 31–50 (20 more machines)
- Hardware subsidy program:
  - PCCP pays 50% of hardware cost (up to $500) for each new operator joining
  - Incentivizes adoption without giving away machines outright
  - Cost per subsidized machine: $400–$500
  - 40 machines × $450 average subsidy = **$18,000** from PCCP treasury
- Marketing: LinkedIn content strategy (2 posts/week from founders), 1 case study published per month
- Attend 1 manufacturing trade show or DePIN event per month: budget **$1,000–$2,000/month**

**Hardware subsidy cost**: $18,000 (Weeks 41–48)
**Marketing/events**: $6,000 (Weeks 41–48)
**Monthly protocol revenue at 50 machines**: 50 × 25 hrs × $90/hr × 2% = **$2,250/month**
**Enterprise accounts by Week 48**: target 5 × $499/month = $2,495/month
**Total MRR at Week 48**: **~$4,745/month**
**Cumulative spend by Week 48**: ~$380,000
**Cash remaining**: ~$1,825,000

---

### Weeks 49–52 — TEE Cluster Phase 1
**What happens**
- Begin planning private verification network infrastructure upgrade (move from software TEE simulation to hardware TEE)
- **TEE Cluster Phase 1 specification**: 3 AMD EPYC servers
  - Server spec: AMD EPYC 9004 series (Genoa, SEV-SNP capable)
  - Hardware cost per server: $8,000–$15,000 (EPYC 9354P entry point ~$1,570 CPU + $3,000–$5,000 for 256GB RAM + chassis + drives)
  - Realistic 3-node cluster: **$30,000–$45,000 hardware**
  - Colocation cost: 3 servers × $200/month (1U each, based on $100–$300/U/month market rate) = **$600/month**
  - Alternative: rent EPYC SEV-SNP cloud VMs from Google Cloud Confidential Compute or Azure Confidential VMs
    - Azure DCsv3 instance (SEV-SNP): ~$500–$1,200/month per node × 3 = $1,500–$3,600/month
    - Advantage: no upfront hardware cost; disadvantage: higher recurring cost
- **Decision**: use cloud confidential VMs for Phase 1 (lower upfront, faster to deploy)
  - Go with 3 × Azure Confidential VM DCasv5 (~$600/month each): **$1,800/month**

**TEE cluster cloud cost**: $1,800/month starting Week 52
**Cumulative spend by Week 52**: ~$450,000
**Cash remaining**: ~$1,755,000

---

### Weeks 53–56 — 50 to 75 Machines
**What happens**
- Accelerate with BD Lead now fully ramped:
  - Target: 3–5 machines/week cadence (BD identifies operators, Operator Success onboards them)
- Weeks 53–56: Machines 51–75 added
- Hardware subsidy: 25 machines × $450 = $11,250
- First revenue share distribution to operators (morale builder):
  - Design "operator dashboard" showing: jobs run, revenue earned, protocol fee deducted
  - 80% of protocol fee flows back to operator in Phase 1 (per original pilot deal)
  - At $2,250/month protocol revenue, operators collectively receive $1,800/month
  - Individual operator with 1 machine earning 50 hours/month at $90/hour: $90 × 2% × 80% = $1.44/hour back
  - Not material yet — but it's on-chain, transparent, and builds trust
- Begin ISO 17025 exploration for enterprise customers in calibration/pharma space
  - Get a quote: $6,000–$12,000 for small-lab accreditation (6–12 month timeline)
  - Decision: not yet. Flag for Week 72.

**Hardware subsidy**: $11,250 (Weeks 53–56)
**Monthly MRR at 75 machines**: 75 × 25 hrs × $90/hr × 2% = $3,375 protocol + 8 enterprise × $499 = $3,992 enterprise = **$7,367/month MRR**
**Cumulative spend by Week 56**: ~$533,000
**Cash remaining**: ~$1,672,000

---

### Weeks 57–60 — 100 Machines and Series A Prep
**What happens**
- Weeks 57–60: Machines 76–100 added
- Hardware subsidy: 25 × $450 = $11,250
- **100 MACHINES ONLINE** — Series A trigger milestone
- Monthly protocol revenue at 100 machines: 100 × 25 hrs × $90/hr × 2% = **$4,500/month**
- Enterprise accounts: target 12 × $499/month = $5,988/month
- **Total MRR at 100 machines**: ~**$10,488/month** ($125,856 ARR)
- Series A narrative:
  - 100 machines across [X] states and [Y] machine types
  - $125K ARR, growing 35%/month
  - Verifiable physical capability attestations: the missing trust layer for distributed manufacturing
  - Ask: **$10M–$15M Series A at $40M–$60M post-money cap**
    - Why: DePIN Series A rounds in 2025 average $5M–$30M (DoubleZero raised $28M at $400M); $10M is conservative
- Hire #5: **Full-Stack Engineer** (dashboard and API surface)
  - Salary: $120,000/year; equity: 0.5%

**Hardware subsidy (Wk 57–60)**: $11,250
**Series A legal prep**: $2,000
**Cumulative spend by Week 60**: ~$610,000
**Cash remaining**: ~$1,595,000 (healthy runway for Series A process)
**Milestones**: 100 MACHINES. $125K ARR. Series A deck built.

---

## PHASE 4: Scale (Weeks 61–104) — 100 to 1,000 Machines
### Goal: Close Series A. Build full team. Enter first regulated vertical. Token launch.

---

### Week 61 — Series A Process Begins
**What happens**
- Begin 6–8 week Series A fundraise process
- Target investors: Multicoin Capital, a16z crypto, Pantera, Paradigm, Coinbase Ventures, and industrial crossover VCs (Breakthrough Energy if climate-manufacturing angle, In-Q-Tel if defense-manufacturing angle)
- Prepare Series A data room:
  - 100 machines, $125K ARR, 0% operator churn in first 12 months
  - Full TEE verification infrastructure live
  - Enterprise customer roster (anonymized)
  - Full financial model (5-year projection)
  - Cap table (founders + 5 employees + YC/accelerator/angels)

**Legal (data room / diligence)**: $5,000
**Cumulative spend by Week 61**: ~$615,000
**Cash in bank**: ~$1,590,000

---

### Weeks 62–68 — Series A Closes
**What happens**
- Close **$12M Series A** at $45M post-money cap
  - This is within the $10M–$25M DePIN Series A range observed in 2025–2026
  - DoubleZero precedent: $28M at $400M FDV shows market appetite for infrastructure
- Legal cost to close: **$50,000–$80,000** (priced round, full set of Series A docs — term sheet, SPA, investors' rights agreement)
- Key: Series A investors expect to see at least $50K–$500K ARR with enterprise pipeline; you have $125K ARR

**New funds**: +$12,000,000
**Legal (close)**: $65,000
**Cumulative spend by Week 68**: ~$730,000 pre-Series A, plus $65,000 = ~$795,000
**Cash in bank**: ~$12,800,000 (Series A + remaining pre-Series A funds)
**Milestones**: SERIES A CLOSED. $12M to deploy.

---

### Weeks 69–72 — Hiring Wave 2 (Full Team Build)
**What happens**
- Target team by Week 80: 18–22 people
- Key hires in Weeks 69–72:
  - **VP of Engineering**: $180,000/year + 0.5% equity
  - **VP of Business Development**: $160,000/year + $60K OTE variable + 0.3% equity
  - **Head of Operator Success**: $120,000/year + 0.25% equity
  - **DevRel Engineer**: $130,000/year + 0.3% equity (community, docs, open-source)
  - **2 × Protocol Engineers** (TEE + ZK): $140,000/year each + 0.2% equity each
  - **1 × Compliance/Legal Counsel** (in-house): $150,000/year + 0.15% equity

- Total new monthly salary burden: ~$98,000/month new hires
- Benefits and employer taxes (~15% on top): ~$14,700/month
- **Total monthly burn after full hiring wave**: ~$160,000/month ($1.92M/year)

**Hiring costs**: $5,000 per hire (recruiting/LinkedIn Premium) × 8 = $40,000
**Monthly burn**: $160,000
**Cumulative spend by Week 72**: ~$1,275,000
**Cash remaining**: ~$11,530,000

---

### Weeks 73–76 — TEE Cluster Phase 2 (Hardware TEE)
**What happens**
- Move from cloud confidential VMs to owned hardware TEE cluster
- **Full TEE Cluster (7 nodes)**:
  - 7 × AMD EPYC 9004 servers (SEV-SNP capable)
  - Hardware cost: $12,000/server × 7 = **$84,000**
  - Memory (7 × 256GB ECC DDR5): ~$3,500/server = $24,500
  - Storage (7 × 2TB NVMe): ~$500/server = $3,500
  - Chassis/networking: $15,000
  - **Total hardware**: ~$127,000
- Colocation: 7U at Equinix DC in key manufacturing region (Chicago or Dallas)
  - Cost: 7U × $200/U/month = **$1,400/month** (vs $1,800/month cloud — cheaper AND owned)
  - Cross-connect fees: ~$200/month
  - **Total colo cost**: $1,600/month
- Cancel Azure Confidential VM spend: save $1,800/month

**One-time hardware cost**: $127,000
**Net monthly infra savings**: $200/month (cloud → owned)
**Cumulative spend by Week 76**: ~$1,660,000

---

### Weeks 77–84 — Machine Onboarding Sprint to 500
**What happens**
- With full Operator Success team (4 people including manager): target 15–20 machine onboardings per week
- Weeks 77–84: Machines 101–500 (400 machines added over 8 weeks — ambitious but achievable with team)
- To hit this: use channel partners
  - Partner with 3 industrial equipment dealers/distributors who sell machines to shops
  - They recommend PCCP at point of sale: "this machine comes with optional verified connectivity"
  - Revenue share: dealer gets $50/machine successfully connected + $50/year maintenance
- Hardware subsidy program (revised at Series A scale):
  - Subsidy reduced to 25% of hardware cost (market validates this)
  - 400 machines × $200 average subsidy = **$80,000**
- Marketing: trade show presence 2 events/quarter at $5,000–$15,000 each
  - Budget: $40,000/year on events starting Week 80

**Hardware subsidies (Wk 77–84)**: $80,000
**Channel partner setup**: $5,000 (legal agreements + marketing materials)
**Cumulative spend by Week 84**: ~$1,920,000

---

### Weeks 77–84 Revenue Trajectory
At 300 machines (midpoint of sprint):
- Protocol fee: 300 × 30 hrs × $100/hr × 2% = **$18,000/month**
- Enterprise accounts: 30 × $499/month = **$14,970/month**
- **MRR: ~$33,000/month** ($396K ARR)

At 500 machines (end of sprint, Week 84):
- Protocol fee: 500 × 30 hrs × $100/hr × 2% = **$30,000/month**
- Enterprise accounts: 50 × $499/month = **$24,950/month**
- **MRR: ~$55,000/month** ($660K ARR)

---

### Weeks 85–88 — First Regulated Vertical Entry
**What happens**
- Target vertical: **pharmaceutical biotech contract manufacturing** (CMOs)
  - CMOs need verifiable equipment qualification records (GMP requirement)
  - PCCP's on-chain attestations = electronic batch records with tamper-proof audit trail
  - GMP compliance market: $46,000/year maintenance cost for small firm — PCCP reduces this
- Begin **GMP compliance consulting engagement** to understand regulatory pathway:
  - FDA 21 CFR Part 11 (electronic records): PCCP's on-chain attestations are strong candidates for compliance
  - Cost: $10,000–$15,000 for regulatory consultant to assess fit
- Start **ISO 17025 accreditation process** for first calibration-lab operator
  - Cost: $8,000–$12,000, 6–12 months
  - Unlocks: PCCP-attested calibration certificates accepted by regulated customers
- Enterprise deal target: 1 CMO at **$2,500/month** enterprise seat (vs $499/month for general manufacturing)

**Compliance consulting**: $12,000
**ISO 17025 deposit**: $4,000 (process begins)
**Cumulative spend by Week 88**: ~$2,110,000
**Cash remaining**: ~$10,695,000

---

### Weeks 89–96 — Token Launch Planning
**What happens**
- 500+ machines online, $660K ARR — token launch now makes economic sense
- Token launch decision criteria (all must be met):
  - [x] >500 machines on network
  - [x] >$500K ARR
  - [x] Clear operator reward mechanics validated in practice
  - [ ] Legal opinion on token classification (utility token vs security)
  - [ ] Exchange listing agreements (at least 2 tier-2 exchanges)
- Engage **crypto securities attorney**: $30,000–$50,000 for token legal opinion (Howey test analysis, Reg D/S exemptions, utility token structure)
- Token design:
  - Total supply: 1 billion tokens
  - Distribution: 40% operator rewards (vested over 4 years), 20% team (4-year vest), 15% investors (2-year vest), 15% ecosystem fund, 10% treasury
  - Utility: staking for SLA bond collateral, governance voting, fee discounts
- Exchange listing costs: $50,000–$500,000 (tier-2); target Gate.io or KuCoin range
  - Realistic budget: $100,000 for exchange listing + market maker
- Prepare for international expansion: EU manufacturing sector

**Token legal**: $40,000
**Exchange + market maker**: $100,000
**Cumulative spend by Week 96**: ~$2,365,000

---

### Weeks 97–100 — Token Launch
**What happens**
- Token generation event (TGE) — target Week 98
- Launch with full operator reward distribution live from day 1 (not "coming soon")
  - Day 1 operators receive retroactive token rewards for all jobs run before TGE
  - This is the Helium model: retroactive rewards drive operator loyalty
- Expected TGE raise (via public sale or SAFTs): **$5M–$20M** depending on market conditions
  - DePIN FDV at launch: $100M–$400M is reasonable at 500+ machines + $660K ARR (2025 DePIN projects at $760M average FDV)
  - Seed investors' $2M at $10M cap → tokens at $100M FDV = 10× paper return
- Token launch marketing: $200,000 (influencer campaign, exchange promotions, Binance listing effort)

**Token launch marketing**: $200,000
**TGE proceeds**: +$5,000,000–$20,000,000 (treated conservatively as $5M in financial model)
**Cumulative spend by Week 100**: ~$2,600,000
**Total treasury (Series A + TGE + revenue)**: ~$15,000,000+

---

### Weeks 101–104 — 1,000 Machines and International
**What happens**
- Weeks 101–104: Push from 500 to 1,000 machines
  - Acceleration lever: token rewards make operator onboarding self-motivating
  - International: target 3–5 pilot machines in Germany (Mittelstand manufacturing cluster)
  - Legal entity for EU: **€2,500–€5,000** to form a German GmbH or Irish Ltd (EU pass-porting)
- 1,000 machines revenue:
  - Protocol fee: 1,000 × 35 hrs × $110/hr × 2% = **$77,000/month**
  - Enterprise seats: 100 × $499/month = **$49,900/month**
  - Total MRR: **$126,900/month** ($1.52M ARR)
- Raise Series B or continue on token treasury

**EU entity formation**: $5,000
**International pilot hardware + travel**: $15,000
**Cumulative spend by Week 104**: ~$2,650,000 (seed + Series A deployment)
**MRR at 1,000 machines**: **$126,900/month**
**ARR at Week 104**: **$1.52M**
**Cash position**: ~$12,350,000 (Series A balance) + $5M+ TGE = **~$17M war chest**

---

## Summary Tables

### Financial Timeline

| Phase | Weeks | Machines | Monthly Spend | Monthly Revenue | Cash In | Net Cash Position |
|-------|-------|----------|---------------|-----------------|---------|-------------------|
| Phase 0 | 1–4 | 0 | $0 | $0 | $0 | $0 |
| Phase 1A | 5–8 | 1–3 | ~$2K | ~$2 | $5K–$25K hackathon | ~$20K |
| Phase 1B | 9–16 | 3–5 | ~$5K | $160 | $50K–$200K accel | ~$200K |
| Phase 2 | 17–36 | 5–10 | ~$19K→$41K | $320→$819 | $750K pre-seed | ~$620K |
| Phase 3 | 37–60 | 10–100 | ~$41K→$75K | $819→$10.5K | $2M seed | ~$1.6M |
| Phase 4 | 61–104 | 100–1000 | ~$100K→$160K | $10.5K→$127K | $12M Series A + $5M TGE | ~$17M |

### Funding Sources and Amounts

| Source | When | Amount | Dilutive? | Notes |
|--------|------|--------|-----------|-------|
| Hackathon prizes | Wk 5–7 | $5K–$25K | No | ETHGlobal, Funding the Commons |
| DePIN Base Camp | Wk 9 | Up to $200K | ~6–8% SAFE | Outlier Ventures + 1kx + peaq |
| Solana Foundation grant | Wk 2–12 | $5K–$50K | No | Open-source tooling |
| Filecoin/IPFS grant | Wk 9 | $10K–$50K | No | IPFS/Helia usage |
| NSF SBIR Phase I | Wk 14–24 | $305K | No | 6–9 month process |
| Pre-seed SAFE | Wk 16–17 | $750K | ~12–15% | $5M post-money cap |
| Seed round | Wk 33–37 | $2M | ~16–20% | $10M post-money cap |
| Series A | Wk 61–68 | $12M | ~22–25% | $45M post-money cap |
| Token TGE | Wk 97–100 | $5M–$20M | Dilutes treasury | 10% public sale |

### Hardware Cost Reference

| Component | Cost (USD) | Source/Notes |
|-----------|-----------|--------------|
| Raspberry Pi CM5 (8GB/64GB) | $95 + DDR4 increase | raspberrypi.com |
| CM5 IO Board | $35 | Official carrier board |
| Industrial DIN-rail enclosure | $45–$80 | Generic industrial |
| Industrial NVMe (128GB) | $25 | Samsung 980 Pro class |
| OPC-UA gateway (Advantech/Softing) | $400–$800 | Modbus/OPC-UA bridge |
| Cables, connectors, misc | $30 | Per site |
| **Total per machine site** | **$630–$1,035** | Mid-estimate: $800 |
| Founder time for installation | 4–8 hours | First 10 machines |
| With Operator Success runbook | 2–4 hours | Machines 11+ |

### TEE Verification Cluster Costs

| Phase | Configuration | Hardware Cost | Monthly Infra | Notes |
|-------|--------------|--------------|---------------|-------|
| Phase 1 (Wk 52–72) | 3 × Azure Confidential VMs | $0 | $1,800/month | DCasv5 SEV-SNP instances |
| Phase 2 (Wk 73+) | 7 × AMD EPYC owned servers | $127,000 | $1,600/month colo | Equinix Chicago/Dallas |

### Team Hiring Timeline and Costs

| Role | When | Salary/Year | Equity | Monthly Cost |
|------|------|-------------|--------|--------------|
| Founder 1 | Wk 17 | $48K | ~35% | $4,000 |
| Founder 2 | Wk 17 | $48K | ~35% | $4,000 |
| Engineer #1 (edge/IIoT) | Wk 18 | $95K | 1.5% | $8,717 |
| Engineer #2 (contracts/chain) | Wk 38 | $105K | 0.8% | $9,650 |
| Operator Success Manager | Wk 38 | $65K | 0.4% | $6,117 |
| BD/Partnerships Lead | Wk 38 | $90K + commission | 0.6% | $8,300 |
| Full-Stack Engineer #3 | Wk 60 | $120K | 0.5% | $11,000 |
| VP Engineering | Wk 69 | $180K | 0.5% | $16,500 |
| VP Business Development | Wk 69 | $160K + $60K OTE | 0.3% | $14,667 |
| Head Operator Success | Wk 70 | $120K | 0.25% | $11,000 |
| DevRel Engineer | Wk 70 | $130K | 0.3% | $11,917 |
| Protocol Engineer × 2 | Wk 71 | $140K each | 0.2% each | $12,833 each |
| Compliance Counsel | Wk 72 | $150K | 0.15% | $13,750 |

### Key Milestones

| Week | Milestone |
|------|-----------|
| 1 | Repo public, first operator outreach |
| 7 | Delaware C-Corp formed, first machine hardware purchased |
| 8 | Machine 1 online, first end-to-end on-chain job |
| 10 | First protocol revenue (any dollar amount on-chain) |
| 15 | 5 machines online, pitch deck built |
| 16 | Pre-seed fundraise in market |
| 17 | Pre-seed closed ($750K) |
| 22 | 10 machines online |
| 24 | First enterprise demo |
| 30 | First enterprise customer ($499/month) |
| 37 | Seed closed ($2M) |
| 48 | 50 machines, $4,745/month MRR |
| 52 | TEE cluster live (cloud phase) |
| 57–60 | 100 machines, $10,488/month MRR |
| 60 | Series A deck in market |
| 68 | Series A closed ($12M) |
| 76 | Hardware TEE cluster live (7 nodes, owned) |
| 84 | 500 machines, $55,000/month MRR |
| 85 | First regulated vertical (pharma CMO) entered |
| 98 | Token TGE |
| 104 | 1,000 machines, $126,900/month MRR, international presence |

---

## Risk Register and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Operators don't convert after LOI | HIGH initially | HIGH | Offer hardware subsidy + 80% revenue share in Year 1; reduce friction to zero |
| NSF SBIR paused or rejected | MEDIUM | MEDIUM | Parallel applications to DoD SBIR, NIST MEP, Solana/Filecoin grants |
| OPC-UA gateway incompatibility with legacy machines | HIGH | MEDIUM | Build compatibility matrix; start with newest machines (Haas, Fanuc); avoid >15-year-old controllers in Phase 1 |
| Pre-seed investors want more traction | MEDIUM | HIGH | Milestone-gate the ask: don't raise pre-seed until 5 machines online and first enterprise demo scheduled |
| Burn rate too high in Phase 3 | MEDIUM | HIGH | Delay Engineer #2 hire by 4 weeks if MRR growth is below 15%/month |
| Token launch regulatory risk | MEDIUM | HIGH | Do not launch token until Series A closed and legal opinion in hand; utility-first framing |
| YC rejection | HIGH (98% rejection rate) | LOW | YC is upside, not plan. Plan A is DePIN Base Camp + angel + NSF path |
| TEE hardware delays | LOW | MEDIUM | Azure Confidential VMs bridge the gap with no lead time |

---

## The Zero-Dollar Thesis

The first 16 weeks require zero external capital if:
1. The demo script runs and is recorded (it is)
2. One makerspace is within driving distance of a founder (almost certainly true)
3. The hackathon circuit yields at least $5K in prizes (one top-3 DePIN finish is sufficient)
4. Grant applications are submitted in parallel (5 applications, $0 cost, potential $200K+)

The central insight is that PCCP's moat is not hardware — it is the protocol. Every machine brought onto the network increases the protocol's value. Every protocol fee is on-chain and auditable. This transparency is the pitch to operators ("you can see exactly what you earn") and to investors ("you can see exactly what the network earns").

The hardware cost is real but manageable: $800 per machine site is the target. At 1,000 machines, the total hardware subsidy investment is $800,000 — less than one month of burn at Series A stage. The protocol revenue at 1,000 machines covers hardware subsidy costs in under 7 months.

The flywheel: operators join for free (or subsidized) → machines run verified jobs → protocol fees accumulate on-chain → token rewards attract more operators → more machines → more fees → stronger token → more operators.

Helium ran this playbook for physical wireless infrastructure. PCCP runs it for physical manufacturing capability. The underlying math is the same.

---

*Playbook compiled March 2026. Hardware pricing from Raspberry Pi official (raspberrypi.com), colocation pricing from ServerMania/Brightlio, NSF SBIR from seedfund.nsf.gov, DePIN accelerator from Outlier Ventures, DePIN fundraising ranges from InnMind/Messari 2025 data, YC deal terms from ycombinator.com, legal formation from Clerky.*
