# Frictionless user journey — "Your agent can print and mail a real letter"

**For:** the Runtype-hosted PCC experience (Persona chat widget + operator copilot).
**Grounded in:** the LIVE print-and-mail loop on `capability.network` (deployed 2026-08-27).
Every step below names the real endpoint it rides, so this is buildable, not aspirational.

---

## The promise, in one line

> Drop a PDF into a chat. Say who it goes to. A real letter gets printed, mailed,
> and **proven delivered** — and you only pay when the delivery scan lands.

No wallet. No crypto words. No account setup. No "which printer." The user
experiences a concierge; the market runs underneath.

---

## The journey (what the user sees ‖ what runs underneath)

### 1. Land — zero setup
**User sees:** a Runtype Persona chat on the page. Opening line:
*"I can print and mail documents for you — a real letter, tracked and delivered.
Drop a PDF and tell me where it goes."*
**Underneath:** the widget is a Runtype client-token embed. No login wall. Identity
is minted invisibly on first intent (passkey or email), never surfaced as a step.

### 2. Ask — natural language, one message
**User:** *"Mail this to my landlord as a certified letter."* (drag-drops `lease-notice.pdf`)
**Underneath:** the agent calls the **public** discovery surface — no credential on
the page —
`POST /a2a/tasks/send { skill: "discover_capability", params:{ query:"mail" }}`
which returns the live legs `document-printing`, `courier.confirm`, `mail.drop`,
`mail.track`. (Verified public today: this returns results with **no bearer**.)

### 3. Plan — priced from real capabilities, shown as plain English
**User sees:**
> Here's the plan — **$11**, delivered in ~3 days:
> • Print your document
> • Fold, stuff, and seal with a mailing label
> • Drop into USPS
> • Delivery proof (scan + signature)
>
> *You only pay when it's proven delivered.* [Confirm] [Change recipient]

**Underneath:** `POST /api/requests` → the agentic decomposer breaks the goal into the
four plan legs, each **matched** to a registered capability and priced from it
(`document-printing` $2 + `courier.confirm` $3 + `mail.drop` $5 + `mail.track` $1 =
**$11**, not a made-up number). Each matched node carries a `matchedCapabilityDigest`
so the commitment binds to *this* deal, not a mutable id.

### 4. Choose trust level — the two-operator proof, as a toggle
**User sees (optional, one line):**
> Delivered by: **● Fastest (Lob API)**  ○ Independently verified (human + USPS scan)

**Underneath:** the same `document.print-and-mail` contract routes to either operator.
Lob's `mailed`/`delivered` are **operator self-report** (lower assurance tier);
the human leg closes on an **independent USPS acceptance scan** (tier 3). The demo's
honesty is a *feature the user can choose*, not fine print.

### 5. Pay — one tap, no crypto
**User sees:** *Apple Pay / card sheet → $11.* Done.
**Underneath:** fiat on-ramp (`/api/fiat-ramp/onramp/session`, Stripe) funds USDC into
a scoped escrow. The user never sees "USDC," "escrow," or a key. The agent holds a
**least-privilege operator scope** (funding/release/dispute only) — it can move *this*
job's money and nothing else.

### 6. Watch it happen — evidence as status, not a spinner
**User sees a live thread:**
> ✓ Printed — 2:14 pm
> ✓ Sealed & labeled — photo captured
> ✓ Accepted into USPS mail stream — ZIP 94103, 2:41 pm
> ✓ Delivered — signature captured, 3 days later

**Underneath:** each ✓ is a signed evidence event — the print job event (kernel
ed25519), the handoff photo (executor key), the carrier acceptance scan (USPS, a
third party the operator can't author). Streamed via `GET /sse/stream/job/:id`.

### 7. Settle — money follows proof
**User sees:** *"Delivered & verified. Receipt →"*
**Underneath:** escrow releases **only** when the composite evidence bundle
(print event + carrier scan, one signed `bundleHash`) passes the oracle's
event-present verdict. No scan, no release. The receipt is a real attestation, not
"we say we mailed it."

---

## The friction we remove — and how

| Usual friction | Removed by |
|---|---|
| "Create an account" | invisible identity on first intent (passkey/email) |
| "Connect a wallet / buy crypto" | fiat on-ramp behind one card tap; USDC never surfaced |
| "Manage an API key" | agent holds a **scoped** operator credential; user never sees one |
| "Which printer / carrier?" | the market matches and prices it; user picks *trust*, not vendor |
| "Did it actually get mailed?" | delivery is a **carrier scan**, shown as status; pay-on-proof |
| "Is this letter legally mailed?" | tier-3 independent USPS scan option, one toggle |

The through-line: **the user expresses intent and trust preference; everything else —
discovery, pricing, routing, payment, evidence, settlement — is the agent's job.**

---

## What is LIVE vs what to build — VERIFIED against prod + master, 2026-08-27

Each row was checked, not assumed: prod endpoint probe (401/400 = routed & built,
404 = absent) and master source. The frictionless wrapper is **mostly already built** —
the remaining work is largely *wiring existing backend into the Runtype front end*, not
building the backend.

### LIVE — backing mechanism already exists on prod

| Journey step | Mechanism, verified |
|---|---|
| 2–3 Ask / discover (no key) | `POST /a2a/tasks/send` discover — **public, curl-verified live** |
| 3 Priced plan | the 4 registered legs (`document-printing` $2, `courier.confirm` $3, `mail.drop` $5, `mail.track` $1) — **live in the registry, findable by search** |
| 3 Decompose → matched → digest → committable | merged + promoted today (PRs #302–#306) — **on prod** |
| 1 Invisible identity | **`/api/onboard/passkey/register-challenge` → 401 (built)** — real WebAuthn via `@simplewebauthn/server`, durable challenge store |
| 2 Natural-language entry | **`/api/onboard/chat` → 400 (built)** — conversational onboarding |
| 5 One-tap pay | **`/api/fiat-ramp/onramp/session` + Coinbase/Yellowcard** — full fiat on-ramp, built |
| 5 Agent holds a scoped, revocable key (user never sees it) | **`/api/fiat-ramp/cdp/spend-permission` → 401 (built)** — Coinbase CDP issues a *scoped, revocable* spend key. This is the "no key shown, agent can only spend this job" property, already mechanized. |
| 6 Evidence-as-status | **`/sse/stream/job/:jobId`** — real-time job event stream, built |
| 7 Settle on proof | composite evidence bundle + oracle event-present verdict — merged today |

### TO BUILD — genuinely not there yet

1. **The Persona widget itself** — the Runtype client-token embed on the page, wired to
   the PCC actions. This is the *front-end* piece; the backend it calls is live.
   (`generate_persona_embed_code`.) The PCC operator copilot already exists as a Runtype
   agent — this connects it to the print-and-mail flow.
2. **The plain-English planner turn** — map the decompose JSON to the step-3 card (hide
   node ids; show legs + total + ETA). Presentation glue over a live endpoint.
3. **The trust toggle UI** — surface Lob (self-report tier) vs human (independent USPS
   scan, tier 3) as the step-4 choice. The tiers exist in the contract; the *choice* is UI.
4. **Item-5 API-scope hardening** — `provision.ts` still mints a `["*"]` API key on
   master (verified). NARROW: this is the *API-endpoint* scope, not the money scope —
   *spending* is already scoped + revocable via CDP above. So a leaked agent key today
   can call more endpoints than it should, but cannot spend beyond its granted permission.
   The operator-gate work (SIWE + allowlist + least-privilege) closes the API-scope half.

**Net:** 6 of the 9 backing mechanisms are live; the remaining build is 3 pieces of
Runtype front-end wiring + 1 backend security hardening (item-5) that does not block the
demo, only tightens it.

---

## Why this is the demo that lands

It is the only version of "an agent that does things in the world" where the *proof*
is the product. Anyone can call an API and say it mailed a letter. This shows the
letter **being accepted into the USPS stream by a scan the operator did not author**,
and releases money only against that scan — expressed to the user as a calm concierge
thread, not a blockchain. Frictionless on top; verifiable underneath.
