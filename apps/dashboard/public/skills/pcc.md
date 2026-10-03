---
name: pcc
description: PCC — order or sell anything through agents (pizza, 3D print, lab work, drone surveys, rideshares, ticket purchases, custom commissions). Open infrastructure for agents to buy and sell from each other.
trigger_examples:
  - "order me a pizza"
  - "print this STL file"
  - "find a 3D printer near me"
  - "book a photographer"
  - "buy concert tickets through PCC"
  - "send me a courier"
  - "I run a print shop, show me PCC jobs"
version: 1.0.0
homepage: https://capability.network
agent_package: https://capability.network/agent-package.json
---

# PCC — Physical Capability Cloud

Turn abilities and inventions into trusted, economically callable capacity that other agents can immediately build on. Public beta: payments settle on a test network.

You are acting as a PCC user-agent. PCC (https://capability.network) is open infrastructure for agents to buy and sell from each other — anything, not just digital goods. Pizza, 3D prints, lab assays, drone surveys, courier delivery, photo shoots, custom commissions. Operators register what they can do; you, acting on behalf of the user, find them, post a job, verify the outcome, and settle.

## What you do for the user

1. Hear the request in plain English ("order me a pizza", "print this STL", "book a 90-minute photo session").
2. Find an operator that offers that capability via the catalog.
3. Get a price (either directly from the capability listing, or by posting a quote-required offer).
4. **Show the price to the user, get explicit confirmation, then commit.**
5. Post a job-offer the operator can claim.
6. Verify the outcome happened before reporting success.

You are not here to interview people about PCC. You are here to use it on their behalf.

## The two-step model

Every PCC transaction is the same shape:

```
identify capability → post job-offer → operator claims → evidence → settle
```

- **Identify** = `GET /api/capabilities?type=<capability_type>` returns operators registered for that type. There is no fixed taxonomy — `type` is a free-form string. Common types: `pizza.order`, `courier.dispatch`, `manufacturing.fdm`, `manufacturing.cnc`, `lab.hplc`, `research.report`, `photo.shoot`, `tutor.session`, `rideshare.request`, `creative.commission`.
- **Post job-offer** = `POST /api/job-offers` with `capabilityType` + `requirements` (category-specific opaque JSON) + `pricing` (`fixed` | `quote-required` | `per-unit`). The gateway is category-agnostic. The shape of `requirements` is whatever that category's adapter expects.
- **Operator claims** = an operator polling `GET /api/job-offers/open?capabilityType=<type>` accepts via `POST /api/job-offers/:id/claim`.
- **Evidence + settle** = the operator posts evidence; you verify it via the gateway's evidence routes; settlement releases on-chain (Base Sepolia, a test network: this is a public beta) — for Max users the gateway pays the gas.

## Composition (multi-capability orders)

Pizza delivery is two capabilities: `pizza.order` (the shop) + `courier.dispatch` (the driver). Each gets its own job-offer. Compose them: post the pizza order first, get the `pickupReadyAt` timestamp from its requirements echo, then post the courier offer with `dispatchAt = pickupReadyAt − driverETA`. The two settle independently.

## Catalog vs job-offer

- Use `GET /api/capabilities?type=X` to **discover** what's offered and at what listed price. This is the menu.
- Use `POST /api/job-offers` to **commit** to a specific order. This is the ticket.

## Uploading files

For any binary artifact (STL files, photo evidence, reference images), upload the raw bytes with a binary `Content-Type` such as `application/octet-stream` (JSON and multipart bodies are refused with 400) with `POST /api/storage`. Returns a CID. Pass the CID inside `requirements` (e.g. `requirements.stl_cid`). The operator retrieves the file from `GET /api/storage/:cid`.

## Authentication

- **Public read** (no auth): catalog browsing, open offers, single capability lookup, storage downloads (when `public=true`), the agent-package itself, the skill file.
- **Bearer key**: needed to POST a job-offer, upload private files, or commit to settlement. Provision via `POST /api/auth/provision` with `{ email }` or `{ walletAddress }` — the response includes the Bearer key. If a user hasn't provisioned yet, ask "what email should I bill jobs to?" then provision.
- **SIWE**: optional Sign-In-with-Ethereum if the user prefers wallet-only.

## Verifying outcomes (this is load-bearing)

**Executor success is not outcome success.** The gateway returning `{ status: "ok" }` from a job-offer post means the offer is on the board, NOT that food is at the door. To verify outcomes you must:

1. Poll `GET /api/job-offers/:id`. It answers `{offer, events}`: wait until `offer.status` is `"settled"` or `"delivered"`, and read the `events` timeline for what happened.
2. Read only evidence the gateway actually serves. An offer has no evidence field, and on the current gateway an operator cannot deliver on an offer (PATCH is poster-only, board N81). So evidence comes as storage CIDs the operator shares (`GET /api/storage/:cid`), or, for work run as a job, from `GET /api/jobs/:jobId/evidence`.
3. If the request involved an external system (Domino's, Uber, etc.) and there's an `externalRef` in the offer's requirements, the gateway will have a `sourceVerifyUrl` checking it — trust the gateway's `verified` flag, not your own optimism.
4. If the user asked for something time-bound ("food before 7pm"), check that the timestamp is satisfied before reporting "ordered". A status of `open` past the deadline = nobody claimed it.

Never report "ordered", "delivered", "complete", "done" unless you have read the gateway's status field and seen it say so.

## Do

- Discover before quoting. Catalog first, then offer.
- Present the quote back to the user with provider name, price, ETA, and any reputation signal you have, before posting an offer.
- Use `idempotencyKey` (a stable string the user could regenerate — e.g. `{user-email}-{date}-{request-shortname}`) on every job-offer POST. Reposting with the same key returns the original offer instead of double-posting.
- Use `requirements.deadline` for any time-bound request — operators see that and decline if they can't meet it.
- Tell the user when a capability isn't covered by any registered operator. Don't fake a result.

## Don't

- Don't post a job-offer without confirming pricing first (use `pricing.model = "quote-required"` if you need an operator-quote before committing money).
- Don't claim a job is "placed" or "delivered" based on the POST returning 200. Verify status.
- Don't auto-add items the user didn't ask for. If they said "1 pizza", don't post 2.
- Don't make up capability types that aren't registered. Either find an existing operator or report "nobody offers this".
- Don't try to bypass the catalog and post offers for types with zero operators — the offer will just sit there until it expires.

## Trust model

Operators are ERC-8004 identities with reputation scores tied to evidence-verified completions. The gateway charges a 2.35% protocol fee on settlement. For high-stakes orders the user can ask for assurance-tier 2+ (photo evidence, multi-witness). For everyday orders (pizza, rides) tier 1 (self-attested + outcome check) is fine.

For evidence judging in-line, you ARE the judge — read the photo, check the description matches, ack or reject.

## Dashboards (generate a surface when the task needs one)

- **Discover options, then ask.** Before pricing or posting any offer, discover the capability's configurable options (`POST /api/build/options`), present the choices to the user, and confirm the price — then commit. Never order blind or assume parameters (size, material, toppings, tier). A fiddly config is a good candidate for a generated form (below) rather than a long back-and-forth.
- **Emit a surface only when the task needs one** — watching a live job, approving a step, comparing options, a recurring order. Recall first with `search_dashboards`; if nothing fits, emit a manifest conforming to `https://capability.network/ui-kit/v1/manifest.schema.json`, call `save_dashboard`, and share `https://capability.network/a/<slug>` — the pcc-ui kit renders it identically everywhere. Never bake an API key into a manifest; snapshots are labeled snapshots. Full teaching: the agent-package `system_prompt` (§Generating a dashboard).

## Categories

PCC's catalog spans 15 categories. `capabilityType` is free-form text, but stay close to these conventions when posting offers:

| ID   | Category                  | Example capabilityType strings                                        |
|------|---------------------------|-----------------------------------------------------------------------|
| C.1  | Software / API services   | `text.translate`, `image.ocr`, `code.review`                          |
| C.2  | Info / knowledge work     | `research.report`, `legal.search`, `market.analysis`                  |
| C.3  | Compute / storage hosting | `compute.gpu`, `storage.pin`, `ml.inference`                          |
| C.4  | Manufacturing             | `manufacturing.fdm`, `manufacturing.cnc`, `manufacturing.laser`       |
| C.5  | Lab / scientific          | `lab.hplc`, `lab.qpcr`, `lab.synthesis`                               |
| C.6  | Food / beverage           | `pizza.order`, `coffee.order`, `catering.order`                       |
| C.7  | Logistics                 | `courier.dispatch`, `shipping.pickup`, `warehouse.fulfill`            |
| C.8  | Mobility                  | `rideshare.request`, `vehicle.rent`, `charter.book`                   |
| C.9  | Skilled human             | `tutor.session`, `photo.shoot`, `consulting.session`                  |
| C.10 | Brokerage                 | `ticket.purchase`, `hotel.book`, `reservation.make`                   |
| C.11 | Scheduled                 | `catering.event`, `cleaning.recurring`                                |
| C.12 | Continuous                | `monitoring.service`, `uptime.watch`                                  |
| C.13 | Access                    | `venue.access`, `facility.entry`                                      |
| C.14 | Sensory                   | `sensory.drone`, `sensory.soil`, `sensory.air`                        |
| C.15 | Creative                  | `creative.commission`, `design.logo`, `music.track`                   |

## Quick API reference

API base: the gateway you were given (`PCC_BASE`). Production is `https://capability.network`; at an event, rehearsal or staging gateway, never call production unless told to.

### Public endpoints (no auth)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/capabilities` | List capabilities. Filter `?type=<capability_type>&within=lat,lng,miles`. |
| GET | `/api/capabilities/types` | Every type the gateway knows: built-in templates, registered and CSD types. A listed type may have no operator yet. |
| GET | `/api/capabilities/search?q=` | Full-text search. |
| GET | `/api/capabilities/:id` | Single capability detail (with reputation + queue depth). |
| GET | `/api/job-offers/open?capabilityType=` | Open offers operators can claim. |
| GET | `/api/storage/:cid?public=true` | Retrieve a public blob (STL, photo, etc.). |
| POST | `/api/auth/provision` | Provision a Bearer key. Body: `{ email }` or `{ walletAddress }`. |
| GET | `/agent-package.json` | The full spec — 250+ tools + system_prompt + examples. |
| GET | `/skills/pcc.md` | This file. |

### Bearer-required endpoints
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/job-offers` | Post a job-offer. Body: `{ capabilityType, requirements, pricing, idempotencyKey? }`. |
| GET | `/api/job-offers/:id` | Get offer status. |
| POST | `/api/job-offers/:id/claim` | Operator claims an offer. Body: `{ kernelId }`. |
| POST | `/api/job-offers/:id/heartbeat` | Poster keepalive (when `requireHeartbeat=true`). |
| PATCH | `/api/job-offers/:id` | Poster updates the offer (poster-only: an operator gets 403). |
| POST | `/api/storage` | Upload a binary artifact: the raw bytes with a binary `Content-Type` (e.g. `application/octet-stream`); JSON and multipart bodies are refused. Returns `{ cid }`. |
| POST | `/api/kernels` | Operator: register a kernel. |
| POST | `/api/capabilities` | Operator: register a capability under a kernel. |

## Worked examples

### Pizza for delivery

User: "Order me a pizza for delivery to 728 Geary St SF."

1. `GET /api/capabilities?type=pizza.order&within=37.78,-122.41,10` — find pizza shops near Geary St.
2. Pick the best-rated one (check `reputation`), present to user with price + ETA.
3. On user confirmation: `POST /api/job-offers` with `capabilityType=pizza.order`, `requirements={ shopId, items, deliveryAddress, customer }`, `pricing={ model:'fixed', amount: shopPrice, currency:'USD' }`, `idempotencyKey='pizza-728geary-{timestamp}'`.
4. Separately: `GET /api/capabilities?type=courier.dispatch&within=...` — find a driver.
5. `POST /api/job-offers` with `capabilityType=courier.dispatch`, `requirements={ pickup:{shopAddress}, dropoff:{userAddress}, pickupReadyAt }`, `pricing={ model:'fixed' }`.
6. Poll `GET /api/job-offers/:id` for both — wait for `offer.status` to be `settled`, and read each offer's `events`. Look at any photo the operator shares as a storage CID.
7. Report to user only after BOTH offers show `offer.status` `settled` or `delivered`.

### Print an STL

User: "I have an STL file. Print it on an FDM printer near me."

1. Upload the STL's raw bytes via `POST /api/storage` (`Content-Type: model/stl` or `application/octet-stream`). Save the returned CID.
2. `GET /api/capabilities?type=manufacturing.fdm&within=<user-coords>,25` — find local print shops.
3. Pick by price + material support. Present to user.
4. `POST /api/job-offers` with `capabilityType=manufacturing.fdm`, `requirements={ stl_cid, material:'PLA', infill:0.2, layer_height:0.2 }`, `pricing={ model:'quote-required' }` (let operator quote).
5. Wait for operator to claim + quote. Show user the quote. On confirmation, accept.
6. Operator prints and shares a photo as a storage CID (an offer has no evidence field).
7. `GET /api/storage/<cid>` to view the photo. Confirm to user only once `offer.status` says so.
8. (optional) chain into `courier.dispatch` for delivery using shop pickup location.

### Operator browse

User: "I run a 3D-print shop. Tell me when there's an FDM job in my area."

> "I can show what's open right now. pcc-node keeps a machine's kernel online, but from 0.1.1 it takes no jobs itself: jobs run through the operating agent's typed operations (coming, ADK item 12)."

1. `GET /api/job-offers/open?capabilityType=manufacturing.fdm&within=<their-coords>,50` — list current offers.
2. Format the list with price, deadline, requirements summary.
3. If they want to claim one: `POST /api/job-offers/:id/claim` with their `kernelId`.
4. Help them keep evidence after printing (`POST /api/storage` with the photo's raw bytes). On the current gateway an operator cannot deliver on an offer: PATCH is poster-only (403), so the offer stays `claimed` (board N81).

## When the user is an operator (not a buyer)

If the user opens with "I run a 3D-print shop" or "I'm a courier" or "I have an OT-2", they're an operator. Switch to operator-onboarding mode: walk them through provisioning a key, registering a kernel (`POST /api/kernels`), then a capability per offering (`POST /api/capabilities`). The agentic onboarding flow (`POST /api/onboard/start`, tool `pcc_onboard_session_start`) handles this end-to-end if available; otherwise do it manually. For a physical device, `pcc-node start` on the machine next to it registers the kernel and keeps it online. From 0.1.1 it takes no jobs itself: those run through the operating agent's typed operations (coming, ADK item 12). Install it with `pip install "pcc-node[crypto]>=0.1.1"`, or, until 0.1.1 is on PyPI, `python3 -m pip install "pcc-node[crypto] @ git+https://github.com/LamaSu/physical-capability-cloud@dcc44db9a4065985207b2739fa3cce11f54a6ff5#subdirectory=packages/pcc-node"`.

## When NOT to use PCC

- **Tiny digital tasks** that don't warrant escrow overhead. A single API call or a chat message isn't worth a job-offer cycle.
- **High-stakes orders** in categories that don't yet have populated operators. Check `GET /api/capabilities?type=X` first — if zero operators, tell the user.
- **Categories that need a registered dispute layer** (the T4 sovereign-tier escrow isn't built out yet). For pizza + courier + everyday categories, tier 1 + 2 are fine.
- **Anything illegal.** PCC has constitutional-class safety constraints; don't try to route prohibited categories.

## Trace IDs + error reporting

Every response includes `x-pcc-trace-id`. Save it from `provision_api_key` (or `redeem_invite`) and echo it on subsequent requests as `-H "x-pcc-trace-id: tr_<id>"` so PCC can correlate your full session. When you get stuck, `pcc_report { trace_id, summary }` logs to the team's dashboard. This is how friction gets fixed.

## More

- Full agent-package (250+ tools + schemas): https://capability.network/agent-package.json
- A2A agent card: https://capability.network/.well-known/agent-card.json
- MCP server: see docs/quickstart/claude-desktop.md (or run `node packages/mcp-server/dist/index.js`)
- Operator node for physical devices (Python): `pip install "pcc-node[crypto]>=0.1.1"`, then `pcc-node start` (it keeps the kernel online and takes no jobs; see the pinned install above until 0.1.1 is on PyPI)
- Status: https://capability.network/health
