# Outreach Drafts — Contributor Economics Launch

**Date**: 2026-04-29
**Status**: drafts — personalize before sending
**Context**: PCC's contributor-economics layer just shipped (PR #7 on `LamaSu/physical-capability-cloud`). These drafts target the highest-leverage early conversations: 1 protocol partnership (OpenClaw), 4 platform partners (Bambu / Prusa / Formlabs / Universal Robots), 1 deepening relationship (Opentrons), and a community-channel announcement template.

---

## Notes for the sender (read once before sending)

- **Replace TODOs**: each draft has placeholders (`<your-name>`, `<your-handle>`, `<their-name>`). Don't send unedited.
- **Tone calibration**: peer-to-peer, no hype, single ask. PCC docs already make the protocol case — these emails should land in 30 seconds and leave one decision.
- **Choose the channel deliberately**: email for partner orgs (Bambu / Prusa / Formlabs / UR / Opentrons biz dev), DM for protocol peers (Vincent Koc on whatever platform — Twitter/X, Telegram, Farcaster — wherever the relationship started).
- **One ask per email**. Two asks = no answer.
- **Cross-link three docs max**: `ADAPTER_BOUNTIES.md`, `OPENCLAW_INTEGRATION.md`, `CONTRIBUTOR_ECONOMICS.md`. The recipient doesn't have time for more.
- **Don't BCC anyone on partner outreach**. If you need a paper trail, log internally — not in the email.

---

## 1. Vincent Koc / OpenClaw

**Channel**: whichever DM channel he replied on last. Twitter/X most likely. If you've never spoken, intro through Liya Du (TiDB) or another AGI House judge first.

**Subject**: PCC × OpenClaw — physical-execution layer for your agents

```
Hey Vincent,

Quick one — we just shipped the on-chain contributor-economics layer for
PCC (https://github.com/LamaSu/physical-capability-cloud/pull/7). The
short version: agents schedule physical jobs (3D print, CNC mill, run
HPLC), milestone escrow on Base, evidence verification, settlement.
218-tool agent package, 56 MCP tools.

Here's why I'm writing: we want PCC to be the physical-execution layer
that OpenClaw schedules call into. We wrote up a 3-tier integration path
(REST in 5 min → MCP in 15 min → native composition where OpenClaw
schedule authors mint a ContributorNFT and earn per-job royalties on
the physical jobs their schedules orchestrate):

  https://github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/OPENCLAW_INTEGRATION.md

The Tier 3 royalty path is the part I'd love your read on — durable
OpenClaw schedules become long-tail income for their authors, which
seems aligned with your platform's value prop.

30 min architectural call this or next week to pressure-test the
integration shape? Either of us can bring 1-2 engineers if useful.

— <your-name>
   <your-handle>
   PCC Network: https://discord.gg/CRFvvUgeV4
```

**Why this works**: Specific (3-tier integration, royalty story), single ask (30 min call), respects his time (agent he already understands ↔ extends with physical capability). The royalty hook is the unique angle — most platform integrations are "use our thing"; this one is "your authors earn from ours."

---

## 2. Bambu Labs (printer firmware / Bambu Cloud API)

**Channel**: developer-relations email or Bambu Lab Maker Forum DM. Try `developers@bambulab.com` first; fall back to community manager via the Maker Lab forum.

**Subject**: $5,000 + lifetime royalty for an open-source Bambu adapter on PCC

```
Hi Bambu Labs team,

I'm <your-name> from PCC (Physical Capability Cloud, https://capability.network)
— a protocol that lets agents discover, price, and orchestrate physical
manufacturing through smart-contract escrow on Base. We just shipped a
contributor-economics layer that pays adapter authors per-job royalties
for as long as people use their adapter.

We're putting $5,000 USDC + a 250bp lifetime royalty schedule on the
table for the first open-source adapter that wraps Bambu Cloud API +
Bambu MQTT (LAN mode) into PCC's standard kernel adapter interface.

Two ways to engage:

1. Build it yourselves. The bounty + 250bp royalty go directly to a
   wallet you control, indefinitely (the royalty is on-chain via an
   immutable RateSchedule — not a platform-mediated rev-share, not
   subject to TOS changes).

2. Bless someone else who builds it. We'd just love a public statement
   that you support an open-source adapter existing for your platform
   — that lifts both communities.

Full bounty mechanics + the integration spec:
  https://github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/ADAPTER_BOUNTIES.md

Whichever path, I'd be happy to schedule 30 min next week to walk through
the kernel adapter contract + show you a working OctoPrint integration
as a reference.

— <your-name>
   <your-handle>
   PCC Network: https://discord.gg/CRFvvUgeV4
```

**Why this works**: Two clear options (build it / bless it), both low-effort for them. The "lifetime royalty on Base" framing positions this as economic upside, not a cost center. The fall-back ("just bless an external author") removes the risk of "we don't have engineering bandwidth."

---

## 3. Prusa Research (PrusaLink / Prusa Cloud)

**Channel**: `developers@prusa3d.com` or Discord — Josef has historically been responsive to open-source-aligned outreach.

**Subject**: $5,000 + lifetime royalty for a Prusa adapter on PCC (open-source)

```
Hi Prusa team,

PCC (Physical Capability Cloud, https://capability.network) is a protocol
for verifiable physical manufacturing — agents submit jobs, machines run
them, smart-contract escrow on Base settles. We pay adapter authors per-job
royalties indefinitely.

We're putting $5,000 USDC + a 250bp lifetime royalty on the first
open-source adapter that wraps PrusaLink + Prusa Cloud API into PCC's
standard kernel adapter interface (Apache-2.0).

Prusa's open-source posture (PrusaSlicer, PrusaLink firmware) makes you
the most natural early partner — adapter authors don't need to fight
license terms or scrape an undocumented cloud.

Full mechanics + the integration spec:
  https://github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/ADAPTER_BOUNTIES.md

If you want to build it in-house, the bounty + royalty go to your wallet
directly. If you prefer a community author, we'll list Prusa as
"co-maintainer" in the adapter index.

30 min to walk through the kernel adapter contract whenever's convenient?

— <your-name>
   <your-handle>
   PCC Network: https://discord.gg/CRFvvUgeV4
```

**Why this works**: Leans on Prusa's open-source posture (real, documented), specific platform names (PrusaLink + Prusa Cloud API), keeps the "co-maintainer" listing as a small carrot.

---

## 4. Formlabs (Formlabs Cloud API)

**Channel**: `developers@formlabs.com` or via Formlabs Web API documentation contact.

**Subject**: $5,000 + lifetime royalty for a Formlabs adapter on PCC

```
Hi Formlabs team,

PCC (https://capability.network) is a protocol for verifiable physical
manufacturing — agents submit print jobs, smart-contract escrow on Base
settles, evidence is anchored on-chain. We pay open-source adapter authors
per-job royalties indefinitely via an immutable RateSchedule.

We're offering $5,000 USDC + 250bp lifetime royalty for the first
open-source Formlabs Cloud API adapter (Apache-2.0). SLA-grade resin
printing fits PCC's "production tier" buyer profile (medical, aerospace,
custom orthodontics, etc.) where evidence + on-chain settlement matter.

Two ways to engage:

1. Your team builds it — bounty + royalty go to your wallet.
2. You point us at a community developer who has API access already, we
   work with them, and you get a quote in our adapter index.

Bounty mechanics: https://github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/ADAPTER_BOUNTIES.md

The integration is ~250 lines of TypeScript wrapping the Formlabs Web API
in PCC's kernel adapter interface. Happy to scope the work in a 30-min
call.

— <your-name>
   <your-handle>
   PCC Network: https://discord.gg/CRFvvUgeV4
```

**Why this works**: Identifies the verticals where Formlabs already wins (medical/aerospace) and frames PCC as a demand channel for those verticals. Concrete LOC estimate ("~250 lines") signals you've thought about the implementation.

---

## 5. Universal Robots (URCap / UR+ ecosystem)

**Channel**: UR+ partner program → `urplus@universal-robots.com` or via the existing UR+ developer portal.

**Subject**: PCC × UR+ — verifiable cobot job marketplace, adapter bounty + royalty

```
Hi UR+ team,

PCC (Physical Capability Cloud, https://capability.network) is a protocol
that turns physical capabilities into agent-orderable services with
on-chain evidence + escrow settlement on Base. We pay adapter authors
per-job royalties indefinitely.

We'd like a UR adapter in the UR+ store. We're offering $5,000 USDC +
a 250bp lifetime royalty schedule for the first open-source URCap that
exposes UR cobots as PCC kernels (motion programming, force-torque
inspection, pick-and-place workflows). The adapter author owns the
ContributorNFT; royalties accrue per-job, forever.

The economic story for UR users: a cobot listed on PCC becomes
discoverable to any agent in the network, jobs are escrow-funded
(no AR risk), evidence is verifiable. Cobots that today sit at <50%
utilization become bookable capacity.

Bounty mechanics + integration spec:
  https://github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/ADAPTER_BOUNTIES.md

Two questions:
1. Could a UR-internal team take this on, or should we recruit through
   the URCap developer community?
2. Would UR+ list the adapter in the marketplace once it ships?

— <your-name>
   <your-handle>
   PCC Network: https://discord.gg/CRFvvUgeV4
```

**Why this works**: Names the cobot underutilization problem (real, often quoted), frames PCC as the demand-aggregation layer (UR doesn't compete here — they're upstream of it). Two questions = pickable, not overwhelming.

---

## 6. Opentrons (already integrated; deepen the relationship)

**Channel**: existing Opentrons biz-dev or developer-experience contact (you have one from the OT-2 integration).

**Subject**: PCC × Opentrons — case study + Tier 2 ContributorNFT for the adapter

```
Hi <their-name>,

The OT-2 adapter has been live on PCC for a while now. We just shipped
a contributor-economics layer (PR #7 on LamaSu/physical-capability-cloud)
that retroactively credits the adapter author with a `ContributorNFT` +
a per-job royalty schedule. For OT-2, that means whoever maintains our
Python adapter starts earning 250bp on every settled OT-2 job through
PCC, with the royalty payable directly on Base.

Two requests:

1. Confirm who Opentrons would like to credit as the adapter author
   (Opentrons engineering team? a specific external maintainer?
   PCC core team if you'd rather it stay internal to us?). We mint the
   ContributorNFT to whatever wallet you specify.

2. We'd love to publish a 1-page case study together — Opentrons + PCC,
   "what verifiable on-chain settlement looks like for a real lab-automation
   workload." This is the kind of artifact that helps both of our
   communities understand the value prop concretely.

Full economics:
  https://github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/CONTRIBUTOR_ECONOMICS.md

— <your-name>
   <your-handle>
```

**Why this works**: Acknowledges existing relationship, makes it economically tangible (250bp on existing volume), one of the asks is a co-marketing artifact (mutual benefit), the other is "who do we send the money to" (a problem they want solved, not work for them).

---

## 7. Community-channel announcement (Discord / Twitter / Farcaster)

**Use after the bounty doc + OpenClaw doc are visible publicly.** This is the broadcast that turns docs into recruiting.

### Discord (#announcements channel)

```
🛠️  Contributor Economics is live on PCC

We just shipped the on-chain royalty layer that pays adapter authors,
protocol authors, AI model trainers, and pilots a fraction of every job
that uses their work — forever, via an immutable RateSchedule on Base.

  • $2,000–$10,000 USDC + 250bp lifetime royalty for the first 50
    priority adapters (OctoPrint, Bambu, Prusa, Formlabs, Hamilton STAR,
    Tecan EVO, ROS-2 generic, OPC-UA gateway, and more)
  • 10-role taxonomy, 7 new MCP tools, 8 REST endpoints, full forge
    test suite passing
  • No OEM royalty class — by design

🪙 Bounty board (claim one):
   github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/ADAPTER_BOUNTIES.md

📖 5-min quickstart:
   github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/CONTRIBUTOR_ECONOMICS.md

💬 #contributor-economics channel for questions / claiming
```

### Twitter/X thread (5 tweets, optional thread structure)

```
1/  Shipped: PCC's on-chain contributor-economics layer.

   Adapter authors, protocol authors, model trainers, dataset
   pilots — all earn per-job royalties indefinitely, sealed at
   mint via an immutable RateSchedule on @base.

2/  We're paying $2k–$10k + 250bp lifetime royalty for the first
   50 priority machine-type adapters.

   List: OctoPrint, Bambu, Prusa, Formlabs, Hamilton STAR, Tecan,
   Universal Robots URCap, generic ROS-2, OPC-UA, and more.

   ↓ all 50 with mechanics
   [link to ADAPTER_BOUNTIES.md]

3/  No OEM royalty class. By design.

   OEMs participate as Operators, Integrators, Protocol Authors, or
   Model Authors on equal terms with everyone else. Encoding lifetime
   per-job hardware royalties on-chain would recreate the rent
   structure PCC exists to displace.

   The full thesis: [link to claros-layer4-amendment.md]

4/  10-role enum (operator, verifier, insurer, integrator,
   protocol-author, model-author, dataset-contributor, curator,
   assembler, network-treasury). Market sets every rate. Operators
   pick which adapters to credit per-job.

   183 forge tests + 380+ TS tests passing on PR #7.

5/  Want to build an adapter? Pick from the 50 in the bounty list,
   comment to claim, ship it, mint your ContributorNFT, get paid.

   Discord: discord.gg/CRFvvUgeV4
   PR + docs: github.com/LamaSu/physical-capability-cloud/pull/7
```

### Farcaster (single cast, ~320 chars)

```
Live: per-job royalties for adapter authors / protocol authors /
model trainers / pilots on PCC. $2k-$10k + 250bp lifetime, sealed
at mint on @base. No OEM royalty class — by design.

50 priority adapters open: github.com/LamaSu/physical-capability-cloud/blob/feat/contributor-economics/docs/ADAPTER_BOUNTIES.md
```

---

## Sequencing

If you can only do a few of these in week one:

1. **Vincent Koc / OpenClaw** first — protocol-to-protocol, one conversation can unlock the integration that compounds across many users.
2. **Opentrons** — existing relationship, low-friction, generates a case study you can use in subsequent outreach.
3. **Discord + Twitter announcement** — converts the docs from "exists" to "people know about it." Gates everything below.
4. **Prusa + Bambu** in parallel — high overlap audience, high-volume printer market.
5. **Formlabs** — different vertical (regulated), pace-set independently.
6. **Universal Robots** — longest sales cycle, start the conversation but don't expect a fast yes.

Don't send all 6 partner emails on the same day. Stagger 2-3 per week so you can iterate on the pitch based on what comes back from the first round. The bounty mechanics are stable; the framing language can sharpen.
