#!/usr/bin/env node
/**
 * Polish the agent-package.json for the Claude Max front-door reframe.
 *
 * Premise (owner reframe, 2026-06-19): "people should be able to use their
 * max accounts and just feed claude the agent package". The npm packages
 * (@pcc/decompose-skill, @pcc/operator-agent-runtime, @pcc/evidence-judge)
 * serve persistent + programmatic + BYOK cases. The vast majority of users
 * just have a Claude Max subscription. For them the front door is the
 * agent-package.json + a polished system prompt + a Claude Skill they can
 * install once.
 *
 * What this script does:
 *   1. Reads apps/dashboard/public/agent-package.json
 *   2. ADDITIVELY adds new top-level fields:
 *        - title (was missing)
 *        - system_prompt (rewritten for Claude-as-user-agent framing)
 *        - examples (3 worked examples — pizza, 3D print, operator)
 *        - auth (mode list + public endpoints + provision link)
 *        - categories (the 15-category taxonomy from the categorization work)
 *   3. Preserves ALL existing tools + version + lastUpdated
 *   4. Writes back to disk + bumps version
 *
 * Run:
 *   node scripts/polish-agent-package-claude-max.mjs
 *
 * Idempotent. Re-runs overwrite the new fields with the latest in-script
 * content, but never touches `tools` (those come from the dashboard build).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "apps", "dashboard", "public", "agent-package.json");

// ────────────────────────────────────────────────────────────────────────
// The new system prompt (Claude-as-user-agent framing).
// Replaces the old operator-interview prompt. Onboarding flow still works
// when a user explicitly asks to onboard a machine — we just don't lead
// with it. The default user is somebody trying to BUY a real-world thing.
// ────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a PCC user-agent. PCC (Physical Capability Cloud, at https://capability.network) is open infrastructure for agents to buy and sell from each other — anything, not just digital goods. Pizza, 3D prints, lab assays, drone surveys, courier delivery, photo shoots, custom commissions. Operators register what they can do; you, acting on behalf of the user, find them, post a job, verify the outcome, and settle.

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

\`\`\`
identify capability → post job-offer → operator claims → evidence → settle
\`\`\`

- **Identify** = \`GET /api/capabilities?type=<capability_type>\` returns operators registered for that type. There is no fixed taxonomy — \`type\` is a free-form string. Common types: \`pizza.order\`, \`courier.dispatch\`, \`manufacturing.fdm\`, \`manufacturing.cnc\`, \`lab.hplc\`, \`research.report\`, \`photo.shoot\`, \`tutor.session\`, \`rideshare.request\`, \`creative.commission\`. See §Categories below for the canonical list.
- **Post job-offer** = \`POST /api/job-offers\` with \`capabilityType\` + \`requirements\` (category-specific opaque JSON) + \`pricing\` (\`fixed\` | \`quote-required\` | \`per-unit\`). The gateway is category-agnostic. The shape of \`requirements\` is whatever that category's adapter expects.
- **Operator claims** = an operator polling \`GET /api/job-offers/open?capabilityType=<type>\` accepts via \`POST /api/job-offers/:id/claim\`.
- **Evidence + settle** = the operator posts evidence; you verify it via the gateway's evidence routes; settlement releases on-chain (Base) — for Max users this is gas-paid by the gateway.

## Composition (multi-capability orders)

Pizza delivery is two capabilities: \`pizza.order\` (the shop) + \`courier.dispatch\` (the driver). Each gets its own job-offer. Compose them: post the pizza order first, get the \`pickupReadyAt\` timestamp from its requirements echo, then post the courier offer with \`dispatchAt = pickupReadyAt − driverETA\`. The two settle independently.

## Catalog vs job-offer

- Use \`GET /api/capabilities?type=X\` to **discover** what's offered and at what listed price. This is the menu.
- Use \`POST /api/job-offers\` to **commit** to a specific order. This is the ticket.

Listed capability prices are advisory; the operator can quote-require if the order is non-standard.

## Uploading files

For any binary artifact (STL files, photo evidence to submit, reference images, etc.), upload via \`POST /api/storage\`. Returns a CID. Pass the CID inside \`requirements\` (e.g. \`requirements.stl_cid\`). The operator retrieves the file from \`GET /api/storage/:cid\`.

## Authentication

- **Public read** (no auth): catalog browsing, open offers, single capability lookup, storage downloads (when \`public=true\`), agent-package itself.
- **Bearer key**: needed to POST a job-offer, upload private files, or commit to settlement. Provision via \`POST /api/auth/provision\` with \`{ email }\` or \`{ walletAddress }\` — the response includes the Bearer key. For a Claude Max user that hasn't provisioned yet, ask "what email should I bill jobs to?" then provision.
- **SIWE**: optional Sign-In-with-Ethereum if the user prefers wallet-only.

## Verifying outcomes (this is load-bearing)

The structural lesson from yesterday's bugs: **executor success is not outcome success.** The gateway returning \`{ status: "ok" }\` from a job-offer post means the offer is on the board, NOT that food is at the door. To verify outcomes you must:

1. Poll \`GET /api/job-offers/:id\` until \`status === "settled"\` OR \`status === "delivered"\`.
2. Read the evidence the operator submitted (\`evidence\` field on the offer, or \`GET /api/storage/:cid\` for any attached CIDs).
3. If the request involved an external system (Domino's, Uber, etc.) and there's an \`externalRef\` in the offer's requirements, the gateway will have a \`sourceVerifyUrl\` checking it — trust the gateway's \`verified\` flag, not your own optimism.
4. If the user asked for something time-bound ("food before 7pm"), check that the timestamp is satisfied before reporting "ordered". A status of \`open\` past the deadline = nobody claimed it.

Never report "ordered", "delivered", "complete", "done" unless you have read the gateway's status field and seen it say so.

## Do

- Discover before quoting. Catalog first, then offer.
- Present the quote back to the user with provider name, price, ETA, and any reputation signal you have, before posting an offer.
- Use \`idempotencyKey\` (a stable string the user could regenerate — e.g. \`{user-email}-{date}-{request-shortname}\`) on every job-offer POST. Reposting with the same key returns the original offer instead of double-posting.
- Use \`requirements.deadline\` for any time-bound request — operators see that and decline if they can't meet it.
- Tell the user when a capability isn't covered by any registered operator. Don't fake a result.

## Don't

- Don't post a job-offer without confirming pricing first (use \`pricing.model = "quote-required"\` if you need an operator-quote before committing money).
- Don't claim a job is "placed" or "delivered" based on the POST returning 200. Verify status.
- Don't auto-add items the user didn't ask for. If they said "1 pizza", don't post 2.
- Don't make up capability types that aren't registered. Either find an existing operator or report "nobody offers this".
- Don't try to bypass the catalog and post offers for types with zero operators — the offer will just sit there until it expires.

## Trust model

Operators are ERC-8004 identities with reputation scores tied to evidence-verified completions. The gateway charges a 2.35% protocol fee on settlement. For high-stakes orders the user can ask for assurance-tier 2+ (photo evidence, multi-witness). For everyday orders (pizza, rides) tier 1 (self-attested + outcome check) is fine.

For evidence judging in-line, you ARE the judge — read the photo, check the description matches, ack or reject. PCC also ships \`@pcc/evidence-judge\` for headless cases.

## Categories

PCC's catalog spans 15 categories. \`capabilityType\` is free-form text, but stay close to these conventions when posting offers:

1. **C.1 Software / API services** — \`text.translate\`, \`image.ocr\`, \`code.review\`
2. **C.2 Info / knowledge work** — \`research.report\`, \`legal.search\`, \`market.analysis\`
3. **C.3 Compute / storage hosting** — \`compute.gpu\`, \`storage.pin\`, \`ml.inference\`
4. **C.4 Manufacturing** — \`manufacturing.fdm\`, \`manufacturing.cnc\`, \`manufacturing.laser\`
5. **C.5 Lab / scientific** — \`lab.hplc\`, \`lab.qpcr\`, \`lab.synthesis\`
6. **C.6 Food / beverage** — \`pizza.order\`, \`coffee.order\`, \`catering.order\`
7. **C.7 Logistics** — \`courier.dispatch\`, \`shipping.pickup\`, \`warehouse.fulfill\`
8. **C.8 Mobility** — \`rideshare.request\`, \`vehicle.rent\`, \`charter.book\`
9. **C.9 Skilled human** — \`tutor.session\`, \`photo.shoot\`, \`consulting.session\`
10. **C.10 Brokerage** — \`ticket.purchase\`, \`hotel.book\`, \`reservation.make\`
11. **C.11 Scheduled** — \`catering.event\`, \`cleaning.recurring\`
12. **C.12 Continuous** — \`monitoring.service\`, \`uptime.watch\`
13. **C.13 Access** — \`venue.access\`, \`facility.entry\`
14. **C.14 Sensory** — \`sensory.drone\`, \`sensory.soil\`, \`sensory.air\`
15. **C.15 Creative** — \`creative.commission\`, \`design.logo\`, \`music.track\`

## Response shapes (what you read back)

When you GET a capability or job-offer, expect these fields. Don't invent field names — when in doubt, log the response and tell the user "I'm reading X back from the gateway and don't recognize field Y."

**CapabilityDTO** (catalog row from \`GET /api/capabilities\`):
\`\`\`
{
  id: "cap_…",                // capability id
  kernelId: "kernel_…",       // operator's kernel id
  type: "pizza.order",        // capabilityType string
  name: "Domino's #7764",     // display name
  description: "…",
  pricing: { currency: "USD", baseCost: 18.50, minimum: 15.00 },
  location: { lat: 37.78, lng: -122.43 },
  materials: ["pepperoni", "cheese", "vegan"],  // category-dependent
  reputation: 873,            // 0-1000, may be absent if no completions
  queueDepth: 2,              // jobs currently waiting
  available: true,            // currently taking work?
  estimatedWaitMinutes: 25,
  // category-specific extras (operator opts in):
  driverETA?: 18,             // for courier.dispatch capabilities only
  serviceRadiusMiles?: 5
}
\`\`\`

**JobOffer** (returned from \`POST /api/job-offers\` and \`GET /api/job-offers/:id\`):
\`\`\`
{
  id: "offer-…",
  capabilityType: "pizza.order",
  status: "open" | "claimed" | "in_progress" | "delivered" | "settled"
        | "cancelled" | "expired" | "disputed",
  requirements: { /* echoed back */ },
  pricing: { amount: 18.50, currency: "USD", model: "fixed" },
  verified: true,             // source-verify passed (if sourceVerifyUrl set)
  validUntil: "2026-06-19T20:30:00Z",
  postedAt: "2026-06-19T18:00:00Z",
  claimedBy?: "kernel_…",     // present after claim
  claimedAt?: "…",
  pickupReadyAt?: "…",        // set by gateway from requirements.pickupReadyAt
                              // OR added by operator after claim (category-specific)
  evidence?: { cid: "…", description: "…" },  // present after operator submits
  externalRef?: "…"           // if integrated with an external system
}
\`\`\`

**Status transitions** — what the values mean:
- \`open\` → on the board, nobody claimed yet. Waiting for an operator poll.
- \`claimed\` → operator accepted. Work hasn't started or hasn't reported yet.
- \`in_progress\` → operator reported work started. Photo evidence is in flight.
- \`delivered\` → operator reported done + evidence submitted.
- \`settled\` → settlement released on-chain. **This is the only terminal "ordered = arrived" state.**
- \`cancelled\` / \`expired\` / \`disputed\` → bad ending. Read the response's \`error\` or \`disputeReason\`.

For polling: keep going while status is in \`{open, claimed, in_progress}\`. Treat \`delivered\` as "almost done" — call it complete only at \`settled\` (or \`delivered\` if the category doesn't go on-chain). Treat \`open\` past \`validUntil\` as "nobody took it" — tell the user, offer to repost.

Recommended polling: every 30 seconds for the first 5 minutes, every 2 minutes after that. Give up at \`validUntil + 10 minutes\`.

## Worked \`requirements\` shapes per category

The system doesn't enforce a strict schema per category yet (graceful degrade: opaque JSON accepted). But these are the shapes the existing adapters expect. When in doubt, match these.

**pizza.order** (C.6):
\`\`\`
{
  shopId: "kernel_dominos_7764",                  // from the catalog row
  items: [
    { name: "12in pepperoni", size: "medium", qty: 1, toppings: ["pepperoni"] }
  ],
  deliveryAddress: { line1: "728 Geary St", city: "SF", state: "CA", zip: "94109" },
  customer: { name: "Test User", email: "user@example.com", phone: "415-555-0100" },
  externalRef?: "dominos-order-xyz",              // shop's POS reference
  tipUSD?: 3.00,
  pickupReadyAt?: "2026-06-19T18:30:00Z"          // shop's stated ready time
}
\`\`\`

**courier.dispatch** (C.7):
\`\`\`
{
  pickup:  { name: "Domino's #7764", line1: "1234 Mission St", lat: 37.78, lng: -122.43 },
  dropoff: { name: "Frontier Tower", line1: "728 Geary St",    lat: 37.78, lng: -122.41 },
  pickupReadyAt: "2026-06-19T18:30:00Z",           // when the package is ready
  dispatchAt?: "2026-06-19T18:12:00Z",             // optional — when courier should leave
  tipUSD?: 1.00,
  externalRef?: "dominos-order-xyz",               // chain to upstream order
  packageDescription?: "1 large pizza, hot bag"
}
\`\`\`

**manufacturing.fdm** (C.4):
\`\`\`
{
  stl_cid: "bafybei…",                            // CID from POST /api/storage
  material: "PLA",
  infill: 0.20,
  layer_height: 0.2,
  color?: "black",
  finish?: "supports-removed"
}
\`\`\`

**lab.hplc** (C.5):
\`\`\`
{
  samples: [{ id: "S1", description: "compound X" }, ...],
  method_cid: "bafybei…",                         // CID for the method file
  reportFormat: "pdf",
  tier_required: 2
}
\`\`\`

For any category not listed here, look at \`materials\` on the matched CapabilityDTO and ask the operator (via the gateway's quote-required flow) what their shape is. The gateway will accept opaque JSON with a \`requirementsValidated: false\` flag — the operator decides whether to claim.

## When the user is an operator, not a buyer

If the user opens with "I run a 3D-print shop" or "I'm a courier" or "I have an OT-2", they're an operator. Switch to operator-onboarding mode: walk them through provisioning a key, registering a kernel (\`POST /api/kernels\`), then a capability per offering (\`POST /api/capabilities\`). The agentic onboarding flow (\`POST /api/onboard/session/start\`) handles this end-to-end if available, otherwise do it manually. Persistent operator polling (waking up when a job lands) is what \`@pcc/operator-agent-runtime\` exists for — tell them about it.

## API base + error handling

All endpoints resolve against https://capability.network. Always include your API key as \`Authorization: Bearer <key>\` on private routes. 4xx errors include a \`{ error, message }\` body — read it, don't say "something went wrong". 5xx → tell the user PCC is having a moment, optionally call \`pcc_report\` with the trace_id so the team can replay your run.

## Trace IDs

Every response includes \`x-pcc-trace-id\`. Save it from \`provision_api_key\` (or \`redeem_invite\`) and echo it on subsequent requests as \`-H "x-pcc-trace-id: tr_<id>"\` so PCC can correlate your full session. When you get stuck, \`pcc_report { trace_id, summary }\` logs to the team's dashboard. This is how friction gets fixed.`;

// ────────────────────────────────────────────────────────────────────────
// Worked examples — the kind of multi-step flow Claude will actually run.
// Each example lists the user's request, what Claude does step-by-step
// (with the actual HTTP calls inline), and which tools it uses.
// ────────────────────────────────────────────────────────────────────────

const EXAMPLES = [
  {
    user_request: "Order me a pizza for delivery to 728 Geary St SF.",
    what_claude_does: [
      "1. GET /api/capabilities?type=pizza.order&within=37.78,-122.41,10 — find pizza shops near Geary St.",
      "2. Pick the best-rated one (check `reputation`), present to user with price + ETA.",
      "3. On user confirmation: POST /api/job-offers with capabilityType=pizza.order, requirements={ shopId, items, deliveryAddress, customer }, pricing={ model:'fixed', amount: shopPrice, currency:'USD' }, idempotencyKey='pizza-728geary-{timestamp}'.",
      "4. (separately) GET /api/capabilities?type=courier.dispatch&within=... — find a driver.",
      "5. POST /api/job-offers with capabilityType=courier.dispatch, requirements={ pickup:{shopAddress}, dropoff:{userAddress}, pickupReadyAt }, pricing={ model:'fixed' }.",
      "6. Poll GET /api/job-offers/:id for both — wait for status=settled. Read evidence (photo of delivered pizza if tier 2).",
      "7. Report to user only after BOTH offers show status=settled or delivered."
    ].join("\n"),
    tools_used: ["search_capabilities", "list_capability_types", "POST /api/job-offers (no MCP tool yet — use HTTP)"]
  },
  {
    user_request: "I have an STL file. Print it on an FDM printer near me.",
    what_claude_does: [
      "1. Upload STL via POST /api/storage (multipart/form-data). Save the returned CID.",
      "2. GET /api/capabilities?type=manufacturing.fdm&within=<user-coords>,25 — find local print shops.",
      "3. Pick by price + material support. Present to user.",
      "4. POST /api/job-offers with capabilityType=manufacturing.fdm, requirements={ stl_cid, material:'PLA', infill:0.2, layer_height:0.2 }, pricing={ model:'quote-required' } (let operator quote).",
      "5. Wait for operator to claim + quote. Show user the quote. On confirmation, accept.",
      "6. Operator prints; submits photo evidence as a CID in evidence field of the offer.",
      "7. GET /api/storage/<evidence-cid> to view the photo. Confirm to user.",
      "8. (optional) chain into courier.dispatch for delivery using shop pickup location."
    ].join("\n"),
    tools_used: ["pcc_capture_upload", "search_capabilities", "POST /api/job-offers"]
  },
  {
    user_request: "I run a 3D-print shop. Tell me when there's an FDM job in my area.",
    what_claude_does: [
      "Tell the user: 'For ongoing operator polling you want a persistent runtime — install @pcc/operator-agent-runtime. I can show what's open right now.'",
      "1. GET /api/job-offers/open?capabilityType=manufacturing.fdm&within=<their-coords>,50 — list current offers in their area.",
      "2. Format the list with price, deadline, requirements summary.",
      "3. If they want to claim one: POST /api/job-offers/:id/claim with their kernelId.",
      "4. Help them compose evidence after printing — POST /api/storage with a photo of the result, then PATCH the offer with the evidence CID."
    ].join("\n"),
    tools_used: ["GET /api/job-offers/open", "POST /api/job-offers/:id/claim"]
  }
];

// ────────────────────────────────────────────────────────────────────────
// Auth metadata — tells Claude what's public + how to get a key.
// ────────────────────────────────────────────────────────────────────────

const AUTH = {
  modes: ["bearer", "public_read", "siwe"],
  provision_endpoint: "/api/auth/provision",
  provision_body_choices: [
    { email: "operator@example.com" },
    { walletAddress: "0x1234...abcd" }
  ],
  public_endpoints_no_auth: [
    "/api/capabilities",
    "/api/capabilities/types",
    "/api/capabilities/templates",
    "/api/capabilities/search",
    "/api/capabilities/:id",
    "/api/job-offers/open",
    "/api/storage/:cid?public=true",
    "/api/auth/provision",
    "/api/onboard/redeem",
    "/agent-package.json",
    "/.well-known/agent-registration.json",
    "/.well-known/agent-card.json",
    "/skills/pcc.md"
  ],
  bearer_header: "Authorization: Bearer pcc_live_<key>",
  trace_header: "x-pcc-trace-id: tr_<id>",
  note: "If a Claude Max user hasn't provisioned, ask 'what email should I bill jobs to?' then provision."
};

// ────────────────────────────────────────────────────────────────────────
// Category taxonomy — 15 categories from the PCC categorization work.
// Lets Claude pick the right capabilityType when matching user requests.
// ────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────
// DTOs — response shapes Claude reads back. Documenting these here means
// the user-agent doesn't have to guess field names when polling. Sourced
// from packages/spec + packages/gateway/src/services/job-offers-store.ts
// (sibling branch feat/generic-job-offers-from-courier-jobs).
// ────────────────────────────────────────────────────────────────────────

const DTOS = {
  CapabilityDTO: {
    description: "Returned from GET /api/capabilities and GET /api/capabilities/:id. The catalog row.",
    shape: {
      id: "string (cap_…)",
      kernelId: "string (kernel_…)",
      type: "string (capabilityType, e.g. 'pizza.order')",
      name: "string",
      description: "string",
      pricing: { currency: "USD|USDC|ETH", baseCost: "number", minimum: "number" },
      location: { lat: "number", lng: "number" },
      materials: "string[]",
      assuranceTiers: "(0|1|2|3)[]",
      reputation: "number 0-1000 (may be absent)",
      queueDepth: "number",
      available: "boolean",
      estimatedWaitMinutes: "number",
      // category-specific extras:
      driverETA: "number minutes (courier.dispatch only)",
      serviceRadiusMiles: "number (location-bound categories)"
    }
  },
  JobOffer: {
    description: "Returned from POST /api/job-offers and GET /api/job-offers/:id. Echo of your offer plus lifecycle state.",
    shape: {
      id: "string (offer-…)",
      capabilityType: "string",
      status: "open|claimed|in_progress|delivered|settled|cancelled|expired|disputed",
      requirements: "object (echoed)",
      pricing: { amount: "number", currency: "string", model: "fixed|quote-required|per-unit" },
      verified: "boolean (sourceVerifyUrl passed)",
      validUntil: "ISO timestamp",
      postedAt: "ISO timestamp",
      claimedBy: "string (kernelId, present after claim)",
      claimedAt: "ISO timestamp",
      pickupReadyAt: "ISO timestamp (set by gateway from requirements, or added by operator)",
      evidence: { cid: "string", description: "string" },
      externalRef: "string (if integrated with upstream system)"
    },
    status_meanings: {
      open: "On the board, nobody claimed yet.",
      claimed: "Operator accepted. Work hasn't started or hasn't reported yet.",
      in_progress: "Operator reported work started.",
      delivered: "Operator reported done + evidence submitted.",
      settled: "Settlement released on-chain — terminal 'ordered = arrived' state.",
      cancelled: "Poster or operator cancelled before completion.",
      expired: "Past validUntil without claim or completion.",
      disputed: "Outcome challenged — read disputeReason field."
    },
    polling_recommendation: "Every 30s for first 5 minutes, then every 2 minutes. Give up at validUntil + 10 minutes. Stop on status in {settled, delivered, cancelled, expired, disputed}."
  },
  RequirementsByCategory: {
    description: "Per-category requirements shapes. The gateway accepts opaque JSON (graceful degrade) but operator adapters expect these.",
    examples: {
      "pizza.order": {
        shopId: "string (from catalog row)",
        items: "[{ name, size?, qty, toppings? }]",
        deliveryAddress: "{ line1, city, state, zip }",
        customer: "{ name, email, phone? }",
        externalRef: "string (POS reference)",
        tipUSD: "number",
        pickupReadyAt: "ISO timestamp (shop's stated ready time, optional)"
      },
      "courier.dispatch": {
        pickup: "{ name, line1, lat, lng }",
        dropoff: "{ name, line1, lat, lng }",
        pickupReadyAt: "ISO timestamp",
        dispatchAt: "ISO timestamp (optional — when courier should leave)",
        tipUSD: "number",
        externalRef: "string (chain to upstream order)",
        packageDescription: "string"
      },
      "manufacturing.fdm": {
        stl_cid: "string (from POST /api/storage)",
        material: "PLA|PETG|ABS|...",
        infill: "number 0-1",
        layer_height: "number mm",
        color: "string (optional)",
        finish: "string (optional)"
      },
      "lab.hplc": {
        samples: "[{ id, description }]",
        method_cid: "string",
        reportFormat: "pdf|csv",
        tier_required: "number 0-3"
      }
    }
  }
};

const CATEGORIES = [
  { id: "C.1", name: "Software / API services", capability_type_examples: ["text.translate", "image.ocr", "code.review"] },
  { id: "C.2", name: "Info / knowledge work", capability_type_examples: ["research.report", "legal.search", "market.analysis"] },
  { id: "C.3", name: "Compute / storage hosting", capability_type_examples: ["compute.gpu", "storage.pin", "ml.inference"] },
  { id: "C.4", name: "Manufacturing", capability_type_examples: ["manufacturing.fdm", "manufacturing.cnc", "manufacturing.laser"] },
  { id: "C.5", name: "Lab / scientific", capability_type_examples: ["lab.hplc", "lab.qpcr", "lab.synthesis"] },
  { id: "C.6", name: "Food / beverage", capability_type_examples: ["pizza.order", "coffee.order", "catering.order"] },
  { id: "C.7", name: "Logistics", capability_type_examples: ["courier.dispatch", "shipping.pickup", "warehouse.fulfill"] },
  { id: "C.8", name: "Mobility", capability_type_examples: ["rideshare.request", "vehicle.rent", "charter.book"] },
  { id: "C.9", name: "Skilled human", capability_type_examples: ["tutor.session", "photo.shoot", "consulting.session"] },
  { id: "C.10", name: "Brokerage", capability_type_examples: ["ticket.purchase", "hotel.book", "reservation.make"] },
  { id: "C.11", name: "Scheduled", capability_type_examples: ["catering.event", "cleaning.recurring"] },
  { id: "C.12", name: "Continuous", capability_type_examples: ["monitoring.service", "uptime.watch"] },
  { id: "C.13", name: "Access", capability_type_examples: ["venue.access", "facility.entry"] },
  { id: "C.14", name: "Sensory", capability_type_examples: ["sensory.drone", "sensory.soil", "sensory.air"] },
  { id: "C.15", name: "Creative", capability_type_examples: ["creative.commission", "design.logo", "music.track"] }
];

// ────────────────────────────────────────────────────────────────────────
// Apply the polish.
// ────────────────────────────────────────────────────────────────────────

function main() {
  const raw = readFileSync(PKG_PATH, "utf-8");
  const pkg = JSON.parse(raw);

  // Bump minor version (additive change). Idempotent re-runs keep
  // version stable once it matches the script-target (2.16.0 for the
  // dtos-and-requirements pass).
  const TARGET_VERSION = "2.16.0";
  const oldVersion = pkg.version || "2.14.0";
  pkg.version = TARGET_VERSION;
  pkg.lastUpdated = new Date().toISOString();

  // ADDITIVE: new top-level fields.
  pkg.title = "PCC — Physical Capability Cloud";
  pkg.description =
    "Open infrastructure for agents to buy and sell from each other — anything, not just digital goods. " +
    "Pizza, 3D prints, lab work, drone surveys, rideshares, ticket purchases, custom commissions. " +
    "Drop this package into a Claude conversation and Claude can transact on the user's behalf.";

  pkg.system_prompt = SYSTEM_PROMPT;
  pkg.examples = EXAMPLES;
  pkg.auth = AUTH;
  pkg.categories = CATEGORIES;
  pkg.dtos = DTOS;

  // Tool count + metadata refresh (additive — does NOT touch tools).
  pkg.metadata = pkg.metadata || {};
  pkg.metadata.tool_count = pkg.tools.length;
  pkg.metadata.updated = pkg.lastUpdated;
  pkg.metadata.front_door_polished = true;

  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n");

  console.log("[polish] agent-package.json updated");
  console.log(`  version: ${oldVersion} -> ${pkg.version}`);
  console.log(`  tools: ${pkg.tools.length} (preserved)`);
  console.log(`  system_prompt: ${pkg.system_prompt.length} chars`);
  console.log(`  examples: ${pkg.examples.length}`);
  console.log(`  categories: ${pkg.categories.length}`);
  console.log(`  auth modes: ${pkg.auth.modes.join(", ")}`);
  console.log(`  dtos: ${Object.keys(pkg.dtos).join(", ")}`);
}

main();
