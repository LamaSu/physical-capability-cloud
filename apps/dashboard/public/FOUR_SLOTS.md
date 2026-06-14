# The Four Slots — How a Capability Becomes an A2A-Callable Node

This is the operator-side conceptual map for the Physical Capability Cloud
substrate. Every machine, person, or autonomous asset that joins PCC fills
the same four primitive slots. Once they're filled, any agent on the
network — a user's Claude session, a ChatGPT custom GPT, a Codex loop, a
future model nobody has named yet — can discover, negotiate, escrow,
execute, verify, and settle against that capability over A2A.

The whole onboarding conversation between you (or your operator) and your
own LLM agent is about filling these four slots. None of them are PCC's
opinion. PCC stays neutral; each slot has a small stable typed surface
plus a free-form `describe` field for everything that doesn't fit the
typed shape.

```
┌────────────────────┐    ┌────────────────────┐
│ 1. CAPABILITY      │    │ 2. SERVICE LEVEL   │
│                    │    │                    │
│ what the node does │    │ how fast you must  │
│ and what params it │    │ respond / finish.  │
│ accepts.           │    │ (humans only;      │
│                    │    │ machines null)     │
│ → CSD              │    │ → capabilities.sla │
└────────────────────┘    └────────────────────┘

┌────────────────────┐    ┌────────────────────┐
│ 3. CHANNEL         │    │ 4. AVAILABILITY    │
│                    │    │                    │
│ how PCC pings you  │    │ when the capability│
│ when work lands.   │    │ is reachable.      │
│                    │    │                    │
│ → operator-channels│    │ → capabilities.    │
│                    │    │   availability     │
└────────────────────┘    └────────────────────┘
```

Plus one exposure surface that lets *other agents* discover and call you:

```
┌────────────────────────────────────────────────┐
│ 5. A2A SURFACE                                 │
│                                                │
│ /.well-known/agent-card.json + the existing    │
│ /a2a/tasks/send skills (pcc-author-integration,│
│ pcc-attach-channel, pcc-suggest-templates,     │
│ pcc-discover, pcc-quote, pcc-submit,           │
│ pcc-verify, pcc-settle).                       │
└────────────────────────────────────────────────┘
```

Filling all five with one A2A call is the design target. Today, **a single
`pcc-author-integration` invocation** can carry capability + SLA +
availability + channels[] inline — the operator goes from "I have a pizza
shop" to a live agent-card URL in one round-trip after the setup
conversation.

---

## Slot 1 — Capability

**What it answers**: *what does this node do, and what parameters does it
accept?*

**Backed by**: Capability StructureDefinitions (CSDs). FHIR-inspired,
inheritable via `baseDefinition`, versioned. Five base CSDs ship today
(FDM, SLA, CNC 3-axis, laser cut, 2D print); the top-50 catalog is seeded.
Anyone can register a new CSD via `POST /api/csd`; the registry talks back
during onboarding via the `pcc-suggest-templates` A2A skill.

**Inheritance is real**: a fork of `pcc://capabilities/fdm/v2` can override
just the materials list and inherit everything else.

**Reference**: `packages/spec/src/csd/` for the schema, `apps/dashboard/
public/whitepaper.md` §3 for the rationale.

---

## Slot 2 — Service Level (SLA) — humans only

**What it answers**: *how fast must this human-operated capability respond
to a new job, and how long do they have to finish?*

**Backed by**: `capabilities.sla` JSON column (PR #98). Shape:

```json
{
  "acceptanceWindowSec": 60,
  "completionDeadlineSec": 1800,
  "presence": "available | busy | offline",
  "mode": "on-demand | scheduled | recurring",
  "onTimeout": "<operator-authored handler>",
  "onDeadlineMiss": "<operator-authored handler>"
}
```

**For machines**: leave it `null`. Machines accept work whenever they're
not busy; their availability slot covers when "not busy" is true.

**Use case**: a same-day courier registered as a human capability would
say *"accept within 90s, deliver within 1h."* PCC's compose engine bakes
that SLA into the matching so a buyer who needs <60s acceptance only sees
operators who meet it.

---

## Slot 3 — Channel — how PCC pings you

**What it answers**: *when a job lands, how does PCC notify the operator?*

**Backed by**: `operator-channels` substrate (PR #112). An operator can
attach 0..N channels — each is a small typed envelope:

```json
{
  "label": "Counter receipt printer",
  "transport": "webhook | email | sms | voice | push | mqtt | file | manual",
  "direction": "out | in-out | in",
  "endpoint": { "url": "http://10.0.0.5:9100/print" },
  "credentialRef": "vault://...",
  "describe": "POST plain text ticket; printer auto-formats from raw body",
  "replyContract": "I'll POST {jobId, status: 'accepted' | 'declined'} to your reply URL within 90s"
}
```

**Specificity lives in the `describe` field**, not in adapter code. The
operator's onboarding agent (the LLM the operator is talking to during
setup) writes the `describe` from the setup conversation. PCC the
substrate never has to ship a per-vendor adapter for Toast or Square or
the operator's grandmother's printer. New backend types appear by
**conversation**, not code change.

**Routes**: `POST /api/operators/:slug/channels`, `GET`, `PATCH`,
`DELETE`, `POST .../channels/test` (synthetic dispatch for verifying the
wire end-to-end before any real job lands). Also addressable via A2A
skill `pcc-attach-channel`.

---

## Slot 4 — Availability — when you're reachable

**What it answers**: *when is this capability free to take a job?*

**Backed by**: `capabilities.availability` JSON column. Recommended typed
shape (PR #113-equivalent — registry talks back substrate):

```json
{
  "mode": "always | windows | cron | manual-claim | delegate-to-agent",
  "windows": [
    { "start": "11:00", "end": "22:00", "daysOfWeek": [1,2,3,4,5,6,0] }
  ],
  "cron": "0 9-17 * * 1-5",
  "timezone": "America/Los_Angeles",
  "agentEndpoint": "https://my-shop.com/availability-agent",
  "describe": "Open 11am-10pm daily, closed Christmas. For weekends or rush jobs ping the owner; usually says yes for +20% rush fee."
}
```

**`describe` carries the long tail**. The operator's agent writes it from
the setup conversation: *"the lab is open 9-5 weekdays except Wednesday
afternoons when the autoclave runs."* PCC doesn't parse it; the compose
engine hands it to negotiating agents who use it to decide which
operators to short-list.

**`delegate-to-agent` is the escape hatch**: if the operator's setup is
truly weird, point at an agent endpoint that answers "are you free at T?"
queries on demand.

---

## Slot 5 — A2A Surface

**What it answers**: *how do other agents discover and call this node?*

**Backed by**: `/.well-known/agent-card.json` plus 8 skills exposed
through `POST /a2a/tasks/send`:

| Skill | Direction | What it does |
|---|---|---|
| `pcc-author-integration` | in | one-shot operator onboarding: kernel + capability + SLA + availability + channels + agent-card URL |
| `pcc-attach-channel` | in | add notification channel(s) to an existing operator |
| `pcc-suggest-templates` | out | registry talks back during onboarding — given a description, returns candidate CSD templates with usage attribution |
| `pcc-discover` | out | search capabilities by type / kernel / query |
| `pcc-quote` | out | get a typed price quote for a contract draft |
| `pcc-submit` | in | submit + commit a job in one shot |
| `pcc-verify` | out | fetch evidence for a job |
| `pcc-settle` | in | release a milestone payment after the challenge window |

Plus the substrate also speaks **OpenAPI 3.0.3** at
`https://capability.network/openapi.json` (700+ paths) and a generic
**agent-package.json** (248 tools, v2.13) at
`https://capability.network/agent-package.json`. Any client picks the
surface it understands; the network underneath is the same.

---

## The four-slot conversation — what onboarding actually looks like

The operator opens their own LLM agent (Claude / ChatGPT / Codex /
Gemini / their tool-use loop of choice), pastes the
[agent prompt template](https://capability.network/pizza-llm-agent-prompt.md)
or equivalent, and tells the agent what they have:

> "I want to onboard my pizza shop."

The agent has the substrate conversation:

```
agent → user:   "What's the shop called and where is it?"
user   → agent: "Tony's Pizza, 415 Valencia in SF."

agent → user:   "Are you the operator (you take the orders), or is this
                an automated machine?"
user   → agent: "I'm the operator."   ←  Slot 2 SLA will be set.

agent → user:   "What hours do you take orders?"
user   → agent: "11am to 10pm every day, closed Christmas."   ←  Slot 4.

agent → user:   "How long after an order comes in do you want to confirm
                it, and how long to finish?"
user   → agent: "60 seconds to confirm, 30 minutes total."   ←  Slot 2.

agent → user:   "When a new order arrives, how do you want me to tell you?
                Do you have a receipt printer, a tablet, a phone you check?"
user   → agent: "I have a Square tablet at the counter. It already prints
                receipts when DoorDash sends one. If I gave you a URL it
                POSTs to, could you send orders there too?"   ←  Slot 3.

agent → user:   "Yes. What URL?"
user   → agent: "http://my-tablet.local:9100/order"

agent → user:   "What capability category? Pizza? Hot food prep?"
user   → agent: "Pizza. Wood-fired Neapolitan, sometimes thin-crust."   ←  Slot 1.

[agent fetches /api/csd/suggest?q=pizza&limit=5 — registry talks back]

agent → user:   "I see one called 'pcc://capabilities/make-pizza/v1' that's
                already been adopted 47 times — want that one, or roll a
                new CSD?"
user   → agent: "That one's fine."
```

The agent now has all four slots. It calls `pcc-author-integration` ONCE:

```json
POST /a2a/tasks/send
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tasks/send",
  "params": {
    "skill": "pcc-author-integration",
    "params": {
      "lane": "human",
      "name": "Tony's Pizza",
      "type": "make-pizza",
      "location": { "lat": 37.7548, "lng": -122.4218 },
      "operatorSlug": "tonys-pizza",
      "operatorAddress": "0x...",
      "pricing": { "currency": "USDC", "baseCost": 14 },
      "sla": {
        "acceptanceWindowSec": 60,
        "completionDeadlineSec": 1800,
        "presence": "available",
        "mode": "on-demand"
      },
      "availability": {
        "mode": "windows",
        "windows": [
          { "start": "11:00", "end": "22:00", "daysOfWeek": [0,1,2,3,4,5,6] }
        ],
        "timezone": "America/Los_Angeles",
        "describe": "Open 11am-10pm daily; closed Christmas only"
      },
      "channels": [
        {
          "label": "Counter Square tablet",
          "transport": "webhook",
          "direction": "in-out",
          "endpoint": { "url": "http://my-tablet.local:9100/order" },
          "describe": "POST plain JSON: {jobId, items, total_usd, deadline_iso}; tablet POSTs back {jobId, status: accepted | declined} within 60s"
        }
      ]
    }
  }
}
```

Response:

```json
{
  "result": {
    "state": "COMPLETED",
    "artifacts": [{
      "type": "pcc.author_integration",
      "data": {
        "kernelId": "...",
        "operatorSlug": "tonys-pizza",
        "agentCardUrl": "https://capability.network/api/kernels/<id>/agent-card.json",
        "channelsAttached": 1,
        "availability": { "mode": "windows", "..." },
        "proveNext": "POST /api/onboard/registrations/:id/prove { evidence: photo + GPS } to activate at Tier 1"
      }
    }]
  }
}
```

Tony's shop is now a live A2A-callable node on PCC. Any user agent that
asks PCC "find me a pizza shop in SF, accept within 60s, budget $20" can
discover Tony's, negotiate, lock escrow, dispatch the order, and settle
on evidence (the photo Tony's PWA captures of the boxed pizza) — without
PCC ever knowing Tony's grandmother's tablet was at the other end of the
wire.

---

## Same pattern, anything

The four slots are capability-agnostic. The same conversation onboards:

| Operator | Slot 1 Capability | Slot 2 SLA | Slot 3 Channel | Slot 4 Availability |
|---|---|---|---|---|
| Pizza shop | make-pizza CSD | 60s accept / 30m finish | webhook to tablet | windows 11am-10pm |
| Opentrons OT-2 | liquid-handling CSD | null (machine) | mqtt topic to lab broker | always |
| Same-day SF courier | courier-route CSD | 90s accept / 1h finish | sms to operator E.164 | manual-claim |
| CNC mill | cnc-3axis CSD | null (machine) | webhook to OctoPrint adapter | windows 8am-6pm Mon-Fri |
| HPLC instrument | hplc CSD | null (machine) | sila adapter | delegate-to-agent (lab scheduler) |
| Solo screen-printer | screen-print CSD | 12h accept / 5d finish | email | manual-claim |
| Mobile dog groomer | dog-groom CSD | 4h accept / 24h finish | voice (Vapi callback) | cron 9am-7pm Tue-Sat |
| Wedding officiant | officiate CSD | 1d accept / 30d finish | sms + email | windows weekends |

Each row is a different vertical. The substrate doesn't change. The
operator's agent fills the slots from a conversation. The user's agent
discovers the node through standard A2A resolution. **No verticalized
SaaS in the middle.** That's the point of the substrate.

---

## What's deliberately NOT a slot

These exist in PCC but aren't part of operator onboarding:

- **Identity** (ERC-8004 + W3C DID + on-chain reputation) — system-level,
  not operator-authored.
- **Settlement** (MilestoneEscrow + EAS attestations + Story Protocol IP
  royalties) — enforcement layer, automatic from the four slots.
- **Evidence** (IPFS/Storacha CIDs + ALCOA+ verification + Bittensor
  scoring) — runtime, emitted by jobs not declared by operators.
- **Discovery** (DHT + capability graph search + agent-package.json) —
  network-level, derived from registered capabilities.

These are all real PCC primitives; they're just not what the operator
fills in during onboarding. They're the load-bearing infrastructure
*around* the four slots.

---

## Where to look

- Slot 1 — CSDs: `packages/spec/src/csd/`, `packages/gateway/src/routes/csd.ts`, `https://capability.network/api/csd`
- Slot 2 — SLA: `packages/db/src/schema/capabilities.ts` `sla` column, PR #98
- Slot 3 — Channel: `packages/gateway/src/routes/operator-channels.ts`, PR #112
- Slot 4 — Availability: `packages/db/src/schema/capabilities.ts` `availability` column + typed shape via PR #113
- Slot 5 — A2A: `packages/gateway/src/routes/a2a-tasks.ts`, `packages/gateway/src/routes/well-known.ts`, `https://capability.network/.well-known/agent-card.json`

Whitepaper: `apps/dashboard/public/whitepaper.md` (rewrite PR #114) §17.

This doc: `C:\Users\globa\pcc-onboard-ui\docs\FOUR_SLOTS.md` (and mirrored at
`https://capability.network/FOUR_SLOTS.md` once deployed).
