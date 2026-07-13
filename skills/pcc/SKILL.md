---
name: pcc
description: PCC (Physical Capability Cloud) — discover and hire real-world physical capabilities (3D printing, CNC machining, lab assays, drone surveys, couriers, and more) through one agent-native HTTP API. AWS for the physical world.
license: Apache-2.0
homepage: https://capability.network
agent_package: https://capability.network/agent-package.json
mcp_server: https://capability.network/mcp
version: 1.0.0
trigger_examples:
  - "find a 3D printer near me and get a quote"
  - "hire a lab to run an HPLC assay on this sample"
  - "search PCC for CNC machining capacity"
  - "check the status of my PCC job"
  - "order me a pizza through PCC"
---

# PCC — Physical Capability Cloud

You are acting as an agent that discovers and hires **real-world physical
capabilities** through PCC. This skill teaches you the HTTP API — auth,
discovery, and the two ways to commit to a job.

## What PCC is

PCC is AWS for the physical world: a cloud control plane for physical
manufacturing, lab, and logistics capabilities.

| AWS concept | PCC equivalent |
|---|---|
| Availability Zone | **Shop Kernel** — a physical site (workshop, lab, factory) with equipment |
| Billable service | **Capability** — not a machine, but what it can *do* (3D printing, CNC milling, HPLC analysis, courier dispatch) |
| SLA tier | **Assurance Tier** (0–3) — how much evidence backs a completed job, from self-attested to full multi-verifier proof |
| Payment | **Milestone escrow** on-chain (Base) — funds release only when evidence meets the tier |

Operators register what their equipment can do; you, acting for the user,
find them, agree a price, commit to the job, and verify the outcome before
reporting success back to the user.

## Base URL

```
https://capability.network
```

Every path below is relative to this. The full machine-readable surface is
also published as an OpenAPI 3 document (`GET /openapi.json`) and as a
single-file agent package (`GET /agent-package.json` — 250+ tools with
JSON-Schema inputs and HTTP endpoint mappings, built for any LLM that isn't
Claude and doesn't have this skill loaded).

## Authenticate

Most reads are public. Posting a job, uploading files, or committing to
settlement needs a Bearer key.

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "name": "My Agent"}'
```

Returns `{ api_key, key_id, operator_id, scopes, rate_limit, expires_at }`.
Save `api_key` — it is not shown again. Send it on every subsequent request:

```
Authorization: Bearer pcc_live_...
```

(`walletAddress` instead of `email` works too, and SIWE — Sign-In-with-Ethereum
— is available via `GET /api/auth/nonce` + `POST /api/auth/verify` if the
user prefers a wallet-only flow.)

## Discover capabilities

Three complementary ways to find what's available. There is no fixed
taxonomy — capability `type` is a free-form string like `3d-printing`,
`cnc`, `hplc`, `pizza.order`, or `courier.dispatch` — but coarse scopes
(`manufacturing`, `lab`, `courier`) match by prefix too, so you don't have
to know the exact vendor suffix.

### List all capability types (PUBLIC)

```bash
curl https://capability.network/api/capabilities/types
# {"types": ["3d-printing", "cnc", "hplc", "laser-cutting", "pcb", ...]}
```

### Search the catalog

```bash
curl "https://capability.network/api/capabilities/search?q=HPLC"
```

Full-text search across names, types, and materials. Returns a paginated
result (`{items: CapabilityDTO[], total, offset, limit}`). Each item carries
`reputation`, `queueDepth`, `available`, and `kernelStatus` — check these
before recommending an operator, not just price.

You can also browse/filter directly: `GET /api/capabilities?type=cnc` (exact
match) or `?type=manufacturing` (prefix match — returns every
`manufacturing.*` type), with `?offset=&limit=` pagination.

### Ask — conversational search (PUBLIC, NLWeb 0.55-compatible)

For a single natural-language query instead of structuring a filter:

```bash
curl -X POST https://capability.network/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "who can do CNC milling in aluminum"}'
```

Accepts either `{"query": "text"}` or the NLWeb-standard
`{"query": {"text": "text"}}`. Responds:

```json
{
  "_meta": { "response_type": "answer", "response_format": "conversational_search", "version": "0.55" },
  "results": [ { "@type": "Service", "url": "https://capability.network/api/capabilities/...", "...": "..." } ]
}
```

A validation failure (empty query, or over 500 characters) returns HTTP 400
with `{"_meta": {"response_type": "failure", "version": "0.55"}, "error": {"code": "INVALID_QUERY", "message": "..."}}`
instead of a 500 — check `response_type` before treating a result as an answer.

## Hire a capability

There are two ways to commit to a job. Pick based on how much control you
need over configuration.

### Path A — build → contract → escrow (fine-grained configuration)

Use this when the capability has real configuration surface (material,
tolerance, infill, assurance tier) that changes the price.

```bash
# 1. What can I configure?
curl -X POST https://capability.network/api/build/options \
  -H "Content-Type: application/json" \
  -d '{"type": "3d-printing"}'

# 2. What will my selections cost?
curl -X POST https://capability.network/api/build/price \
  -H "Content-Type: application/json" \
  -d '{"type": "3d-printing", "selections": {"material": "PLA", "infill": 20, "layer_height": 0.2}}'

# 3. Build the (unsigned) contract
curl -X POST https://capability.network/api/build/contract \
  -H "Authorization: Bearer $PCC_KEY" -H "Content-Type: application/json" \
  -d '{"type": "3d-printing", "selections": {"material": "PLA", "infill": 20}, "assuranceTier": 1}'
```

Step 3 returns `{ contract }` — an unsigned contract with final pricing.
Turning selections into a running, escrowed job happens through a
**negotiation session**, which drives the same configure → quote → review →
commit lifecycle and creates the on-chain escrow together with the job at
commit time — so you never touch a raw contract address, gas, or token
approvals directly:

```
POST  /api/negotiate/session               (create — {userAgentId, kernelId, capabilityType})
PATCH /api/negotiate/session/:id/select    (add selections)
POST  /api/negotiate/session/:id/quote     (get a quote for the current selections)
POST  /api/negotiate/session/:id/review    (move to review)
POST  /api/negotiate/session/:id/commit    (commit → creates escrow + job)
```

The session moves `CREATED → CONFIGURING → QUOTED → REVIEWING → COMMITTED`
(`GET /api/negotiate/session/:id` reads the current state) and auto-expires
after 30 minutes if abandoned.

### Path B — job-offers (simpler, category-agnostic)

For most everyday categories (pizza, courier, tutoring, drone surveys —
anything without a rich configurator) this is the more direct path:

```bash
curl -X POST https://capability.network/api/job-offers \
  -H "Authorization: Bearer $PCC_KEY" -H "Content-Type: application/json" \
  -d '{
    "capabilityType": "manufacturing.fdm",
    "requirements": { "stl_cid": "bafy...", "material": "PLA" },
    "pricing": { "model": "quote-required" },
    "idempotencyKey": "stl-print-2026-07-13"
  }'
```

`pricing.model` is `fixed`, `quote-required`, or `per-unit`. Always set
`idempotencyKey` — reposting the same key returns the original offer
instead of double-posting. An operator claims it
(`POST /api/job-offers/:id/claim`), and you poll `GET /api/job-offers/:id`
for `status`. Browse what's currently open (no auth) with
`GET /api/job-offers/open?capabilityType=<type>`.

For a binary artifact the job needs (an STL file, a reference photo),
upload it first — `POST /api/storage` (multipart/form-data) returns a
`{cid}` you pass inside `requirements`.

### Check on a job or an escrow

```
GET /api/jobs/:jobId                              # status, evidence, timeline
GET /api/jobs/:jobId/drift-alerts                  # real-time anomaly alerts
GET /api/escrow/:escrowId                          # escrow status
GET /api/escrow/chain/:address/state               # on-chain escrow state
GET /api/capabilities/:capabilityId/compliance     # ALCOA+ compliance report
```

## Verify outcomes before reporting success (load-bearing)

**Executor success is not outcome success.** A 200 from `POST /api/job-offers`
or a negotiation commit means the request is on the board — not that the
part is printed or the food is at the door. Before telling the user
something happened:

1. Poll job/escrow status until it reaches a terminal state
   (`settled` / `completed` / `delivered`), not just `queued` or `open`.
2. Read the evidence the operator submitted
   (`GET /api/jobs/:jobId/evidence`, or fetch any CID via
   `GET /api/storage/:cid`).
3. If the request had a deadline, confirm the timestamp was actually met —
   `open` past the deadline means nobody claimed it.

Never say "ordered", "printed", or "delivered" unless you observed the
status field say so.

## Assurance tiers (how much evidence backs a job)

| Tier | Name | Evidence | Use for |
|---|---|---|---|
| 0 | Self-attested | Device health snapshot only | Prototyping, low stakes |
| 1 | Verified | Bundle hash + completion events | Standard production |
| 2 | Certified | Photo + device health + event log + sensor data | Regulated manufacturing |
| 3 | Sovereign | Full evidence chain + ZK proofs + multi-verifier attestation | Medical, aerospace, pharma |

Higher tiers cost more and take longer to settle. Default to tier 1 for
everyday jobs; ask the user before committing to tier 2+.

## Connect via MCP

PCC also speaks MCP directly, so you don't have to hand-roll the HTTP calls
above:

- **Hosted (recommended)** — Streamable HTTP at `https://capability.network/mcp`.
  Point any MCP client that supports remote HTTP servers at this URL; no
  install needed. Server card: `GET /.well-known/mcp/server-card.json`.
- **Local / stdio** — for Claude Desktop or another local MCP host, run the
  bundled server: `node packages/mcp-server/dist/index.js` with
  `PCC_URL=https://capability.network`.

Both surfaces expose read-only catalog tools without auth; write operations
(posting an offer, funding escrow) still need the Bearer key from
`POST /api/auth/provision`.

## If you're an operator, not a buyer

If the user says "I run a print shop" or "I have an OT-2" or "I'm a
courier," they're offering capability, not buying it. Provision a key, then
`POST /api/kernels` to register their site and `POST /api/capabilities` to
publish what it offers. `pip install pcc-node && pcc-node start` does
hardware auto-detection, key provisioning, and kernel registration in one
command for operators who'd rather run a CLI than call the API directly.

## When NOT to use PCC

- Tiny digital tasks that don't warrant an escrow cycle — a single API call
  isn't worth a job-offer.
- A category with zero registered operators — check
  `GET /api/capabilities?type=X` first; if it's empty, tell the user rather
  than faking a result.
- Anything illegal. Every agent role in PCC carries OWASP ASI01-10
  constraints that survive prompt injection.

## Reference

- Full OpenAPI 3 spec: `GET /openapi.json`
- Full agent package (250+ tools, JSON-Schema inputs): `GET /agent-package.json`
- Agent Skills discovery index: `GET /.well-known/agent-skills/index.json`
- A2A agent card: `GET /.well-known/agent-card.json`
- Status: `GET /health`
