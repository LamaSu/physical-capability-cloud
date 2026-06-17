# Buyer-request → ad-hoc listing matching (P0 "payout wall")

Branch: `fix/driver-matching` · Layer: matching/routing only (the negotiate/build
quote path is the sibling lane `fix/driver-order-path`).

## The bug

Buyer-side matching did not route buyer requests to ad-hoc capability listings
(e.g. `rideshare-driver` on `kernel_mqg3ehqy_vumx`, `wood-fired-pizza`). An
operator could onboard and be **discoverable** (they show up in
`GET /api/capabilities/by-type/:type`) but was **unreachable**: no buyer request
ever resolved to their listing, so no escrow was funded and the operator was
never paid. End-to-end blocker for "user orders → operator gets paid".

### Root cause

The only buyer-request entry point, `POST /api/requests`, decomposes a
natural-language request into a capability DAG using **5 hardcoded composite
templates** (`robotics_build`, `lab_analysis`, `synthesis`, `print_deliver`,
`custom_product`) in `services/request-decomposer.ts`. `detectTemplate()` keyword
matches and falls back to `custom_product`. None of those templates ever emit a
node whose `capabilityType` equals an ad-hoc listing's type, and the route never
looked up an actual capability row. So the request→listing matching was
effectively a **fixed allow-list** (the template set) and ad-hoc types fell
through to a generic fabrication DAG that no ad-hoc operator can claim.

`POST /api/requests/.../publish` only mints `bountyId` strings on nodes, and
`/assign` is manual — there was **no code anywhere** that resolved a buyer
request to a registered listing.

## The fix (this lane)

Matching now keys off the **capability's own `type` string + pricing model**
(the capability row), not a fixed allow-list. All changes are confined to
`@pcc/gateway`.

- **`services/request-matcher.ts` (new)** — `matchListings(type, { capabilityId?, kernelId? })`.
  Looks up capability rows by `type` (`repos.capabilities.findByType`), prices
  each from its own `pricing.baseCost`, returns best-first `RoutedListing[]`
  (most-available → cheapest → stable id) or an empty list + reason. No
  allow-list: ad-hoc types match exactly like built-in ones.
- **`services/request-decomposer.ts`** — added `decomposeDirectMatch(req, listing, qty)`
  (pure; listing passed in, no DB). Produces a **single direct-match node** whose
  `capabilityType` = the listing type, `estimatedCost` = `basePrice * qty` (from
  the listing's pricing model), and carries `kernelId` + `capabilityId`
  (`RoutedCapabilityNode`) so a downstream step can settle against that operator.
- **`routes/requests.ts`** —
  - `POST /api/requests` accepts optional `capabilityType` (+ `capabilityId`,
    `kernelId`, `quantity`). When present, routes directly to the matching
    listing; when absent, the existing NL template path is unchanged. No match →
    clean `404 no_matching_listing` (not a 500).
  - `POST /api/requests/match` (new, read-only) — resolve a type to its listings
    without creating a request. The routing primitive an ordering agent uses to
    confirm an operator is reachable and at what price.

### Acceptance — met

`src/__tests__/request-matching.test.ts` (12 tests, green):
- A buyer request for `rideshare-driver` / `wood-fired-pizza` routes to the
  matching ad-hoc listing (node carries kernelId + capabilityId + type, priced
  from the pricing model).
- A built-in type (`fdm`) matches the same way — proves no allow-list.
- The routed target funds an escrow (mock settlement) bound to the operator's
  kernel/capability at the listing's price.
- NL composite requests (no `capabilityType`) still decompose unchanged.

## Tests run (scoped — Spark was down, built only the two required deps)

Built `@pcc/spec` + `@pcc/store` (plain `tsc`, their `dist/` was absent in the
worktree; no full turbo build). Then:

```
pnpm --filter @pcc/gateway exec vitest run src/__tests__/request-matching.test.ts   # 12 passed
pnpm --filter @pcc/gateway exec vitest run src/__tests__/requests.test.ts            # 44 passed (no regression)
```

## Remaining gaps / handoffs (NOT fixed here)

1. **Order-path ad-hoc pricing (sibling lane).** `routes/paid-job-flow.ts`
   `POST /api/jobs/submit-from-discovery` computes its quote via
   `getTemplate(capabilityType)` and falls back to a hardcoded `basePrice = 10`
   for ad-hoc types (paid-job-flow.ts ~L558) — it ignores the listing's pricing
   model. So an escrow funded through that specific fast-track is mispriced for
   ad-hoc caps. This is the quote/escrow path owned by `fix/driver-order-path`;
   it should use `getCapabilityDescriptor()` (as `routes/build.ts` does) so the
   listing's `pricing.baseCost` flows into the escrow amount. **The matching
   layer surfaces the correct price (`RoutedListing.basePrice`); the order path
   must consume it.**

2. **NL inference of ad-hoc types.** Direct routing requires the buyer/agent to
   pass `capabilityType` (which an ordering agent naturally knows). A free-text
   request like "I want a pizza" with no `capabilityType` still falls to the
   `custom_product` template. Inferring a registered ad-hoc type from free text
   (e.g. fuzzy-match description against registered `type`/`name`) is a possible
   follow-up but was kept out of scope to avoid brittle NL heuristics.

3. **`/api/requests/:id/decompose` re-decompose.** Re-running decompose on a
   direct-match request would re-template it (lose the routing), since that
   endpoint always uses the NL path. Low impact; left as-is.

4. **Publish/assign auto-wiring.** `publish` still mints bounty ids and `assign`
   is manual. A direct-match node already carries `kernelId`/`capabilityId`, so
   the matched operator is known — but auto-assigning the node to that operator
   (or auto-creating a negotiate session) is not wired. In the roleplay, escrow
   funding goes through the order path (negotiate/commit or fast-track) using the
   matched `kernelId` + `capabilityType`.

5. **`@pcc/onboard-kit` allow-list (adjacent).** `packages/onboard-kit/src/validate.ts`
   has a `VALID_CAPABILITY_TYPES` set used to validate onboarding configs. It
   does not block discovery (operators are already discoverable), but it is an
   allow-list that would reject ad-hoc types onboarded via that validation path.
   Not in the buyer-matching layer; flagged for the onboarding owner.
