# Handoff: Items #11 + #12 from cross-review-00-synthesis.md

**Author**: orchestrator on `feat/contributor-economics`
**Date**: 2026-04-29
**Audience**: whichever agent picks up integration work after PR #7 merges (likely the orchestrator on `feat/agent-onboarder-v2` or a future docs/governance pass)

PR #7 closed every CRITICAL/HIGH/MEDIUM-LOW item from `cross-review-00-synthesis.md` *except* these two, because they touch sibling-branch territory we deliberately avoided. Both are small (~20 LOC each), well-scoped, and ready to land as soon as someone owns the merge surface.

---

## Item #11 — `arch/open-core-split` ADR-0001 paragraph

### What's needed

A paragraph in `arch/open-core-split:docs/adr/0001-open-core-split.md` placing the contributor-economics primitives on the **Apache 2.0 / open-core** side. ADR-0001 already enumerates which packages are open vs. proprietary; it pre-dates the contributor-economics layer and has no statement about it. Without this, future contributors don't know whether `RateScheduleRegistry` / `ContributorNFT` / `splitPayout` / `LicensingEngine` extensions / `CanonicalRegistry` / `RoleTags` / `@pcc/spec/payouts` fall under the open-core boundary.

### What to confirm before adding

Glance at the latest `arch/open-core-split:docs/adr/0001-open-core-split.md` Follow-ups list. The version I read on 2026-04-29 had 7 follow-ups; the canonical place to insert this is a NEW `## Contributor Economics layer (added 2026-04)` section right BEFORE `## References` (i.e., after the existing "Follow-ups" list, treating CE as a confirmed-Apache-2.0 carve-out that didn't exist when the ADR was first written).

### Exact text to insert

````markdown
## Contributor Economics layer (added 2026-04)

The `feat/contributor-economics` branch (PR #7) introduced a per-job royalty
layer that lets adapter authors / protocol authors / model authors / dataset
contributors / verifiers / insurers earn from every settled job. All primitives
ship under **Apache 2.0**, on the open-core side of the boundary defined above.
None of them depend on the proprietary `LamaSu/pcc-oracle` consensus oracle.

Apache-2.0 components added by this layer:

- **Solidity** (`packages/contracts/src/`):
  `RateScheduleRegistry.sol`, `ContributorNFT.sol`, `CanonicalRegistry.sol`
  (extracted shared library), `RoleTags.sol` (codegen-generated from
  `@pcc/spec/payouts`), `MilestoneEscrow.splitPayout` extension.
- **TypeScript** (`packages/spec/src/`, `packages/contracts/ts/`,
  `packages/db/src/`, `packages/gateway/src/routes/`):
  `rate-schedule.ts` (segment DSL incl. `capture-class-indexed`),
  `composition-manifest.ts`, `training-manifest.ts`, `@pcc/spec/payouts.ts`
  (single-source `ROLE_TAGS`), `LicensingEngine` `getRoyaltyDistributionRich`
  extension, `ContributorRepository`, `/api/contributors/*` routes (8),
  7 new MCP tools (50-56).

External imports added: `@noble/hashes` (for sha256-canonical hashing in
`@pcc/spec/payouts`). MIT-licensed, transitively MIT-only — no copyleft
contagion.

ERC standards inherited (informational): ERC-721 (Apache 2.0 / MIT-style
compatible — referenced via OpenZeppelin), ERC-2981 (informational royalty
standard, no license implications).

The 10-role `ContributorRole` enum **does not include** an `oem` or
`hardware-vendor` role by design. See `docs/claros-layer4-amendment.md` for
the no-OEM thesis. This is a protocol-design decision, not a licensing one,
but it's worth noting here because it eliminates one class of "is the OEM
royalty class proprietary?" question that the ADR's open-core boundary
discussion would otherwise have to answer.

The proprietary `pcc-oracle` (`LamaSu/pcc-oracle`) is **not** invoked by any
of the contributor-economics surface. Settlement attestation still flows
through the oracle when present (i.e., when `protocolRoot` is set on
`MilestoneEscrow`), but `splitPayout` distribution itself is purely on-chain
arithmetic against the sealed payout map. The oracle remains the
`PROTOCOL_FEE_BPS = 235` collector and attestor; nothing in the new layer
requires its participation beyond that pre-existing role.
````

### How to land it

1. Check out `arch/open-core-split` (or whatever branch is the canonical home of ADR-0001 by the time someone picks this up).
2. Insert the paragraph above as a new section between the "Follow-ups" list and "References".
3. Commit message: `docs(adr-0001): add Contributor Economics layer on the Apache-2.0 side`
4. Open a follow-up PR or fold into whatever the next ADR-0001 update is.

This change is purely additive prose — no risk of conflict with our merge.

---

## Item #12 — `endpoint_scopes` rows for the 8 new contributor REST routes

### What's needed

The `endpoint_scopes` table (in `packages/db/src/schema/governance.ts`, on
master via `erp-patterns/foundation`) maps `(method, routePattern)` →
`requiredScopes[]` so the gateway middleware can enforce per-endpoint
authorization. We added 8 routes under `/api/contributors/*` and didn't
seed scope rows for them. Today they fall through to whatever the gateway's
default policy is — we should make the requirement explicit.

### Table shape (verified on `lamasu/master`)

```typescript
export const endpointScopes = sqliteTable("endpoint_scopes", {
  id: text("id").primaryKey(),
  method: text("method").notNull(),         // GET | POST | PUT | DELETE | PATCH
  routePattern: text("route_pattern").notNull(),
  requiredScopes: text("required_scopes", { mode: "json" }).notNull().$type<string[]>(),
  description: text("description"),
});
```

### The 8 rows to seed

Add these to whichever seed file owns governance data on master (probably
`packages/db/src/seed/governance.ts` — verify by grepping for an existing
`endpointScopes.values(...)` insert pattern):

```typescript
// Contributor Economics — 8 routes added 2026-04 (PR #7)
{
  id: "scope:contributors:register",
  method: "POST",
  routePattern: "/api/contributors",
  requiredScopes: ["contributor:write"],
  description: "Register a contributor profile (DB persistence; on-chain mint is separate).",
},
{
  id: "scope:contributors:list-by-address",
  method: "GET",
  routePattern: "/api/contributors/:address",
  requiredScopes: ["contributor:read"],
  description: "List all profiles for a wallet address.",
},
{
  id: "scope:contributors:list-by-role",
  method: "GET",
  routePattern: "/api/contributors/by-role/:role",
  requiredScopes: ["contributor:read"],
  description: "List all addresses holding a specific ContributorRole.",
},
{
  id: "scope:schedules:publish",
  method: "POST",
  routePattern: "/api/contributors/schedules",
  requiredScopes: ["schedule:publish"],
  description: "Publish a sealed RateSchedule (sha256-content-addressed, idempotent).",
},
{
  id: "scope:schedules:get",
  method: "GET",
  routePattern: "/api/contributors/schedules/:scheduleHash",
  requiredScopes: ["schedule:read"],
  description: "Fetch a published RateSchedule by its content hash.",
},
{
  id: "scope:schedules:evaluate",
  method: "POST",
  routePattern: "/api/contributors/schedules/:scheduleHash/evaluate",
  requiredScopes: ["schedule:read"],
  description: "Evaluate a RateSchedule at a given (now, jobValueCents?, jobsPerDay?, captureClass?) context.",
},
{
  id: "scope:training-manifests:set",
  method: "POST",
  routePattern: "/api/contributors/training-manifests",
  requiredScopes: ["training-manifest:write"],
  description: "Set/replace a Model IP's TrainingManifest (dataset weight map for recursive payout).",
},
{
  id: "scope:training-manifests:get",
  method: "GET",
  routePattern: "/api/contributors/training-manifests/:modelIpId",
  requiredScopes: ["training-manifest:read"],
  description: "Fetch a Model IP's TrainingManifest.",
},
```

### Scope name conventions used

| Scope | Implies |
|-------|---------|
| `contributor:read` | Read profile data; safe for any authenticated reader. |
| `contributor:write` | Create/update profile; should be gated to the wallet itself or an authorized agent. |
| `schedule:publish` | Publish a new RateSchedule; idempotent on duplicate hash, so this is effectively read-after-publish-once for repeated calls — gate it loosely. |
| `schedule:read` | Includes `evaluate` since evaluation is read-only against published data. |
| `training-manifest:write` | Set a model's training manifest; gate to the `model-author` who owns the model IP. |
| `training-manifest:read` | Read-only. |

### How to land it

1. Find the existing `endpointScopes` seed file on master (probably
   `packages/db/src/seed/governance.ts` per the master tree). If a different
   file owns this seed, follow the existing pattern there.
2. Append the 8 entries above to whatever array/insert call already exists.
3. If a migration is needed (the table is already on master, so likely no
   schema change — just a seed update), run the project's migration script.
4. Commit message: `feat(db): seed endpoint_scopes for /api/contributors/* routes (8 entries)`

The change is purely additive (new rows, no schema change), zero risk of
conflicting with anything in PR #7.

### Stretch (if scope inventory is being audited anyway)

While you're in the file, the 7 new MCP tools (50-56) could also be added
to whatever MCP-tool scope registry exists, mapped to the same scopes as
their REST counterparts. Look for a parallel table like `mcp_tool_scopes`
or similar; if it exists, the mapping is 1:1 with the table above.

---

## Why these two were deferred from PR #7

Both touch files we don't own directly (one lives on `arch/open-core-split`
documenting a decision predating us; one lives on master in a governance
table that was added by the `erp-patterns/foundation` lineage). The cross-review
flagged that landing them in PR #7 would have required:

- For #11: opening a separate PR against `arch/open-core-split`, racing
  with whatever's pending there
- For #12: a master-side migration that's orthogonal to feat/contributor-economics
  and would distract from the merge story

Neither item is gated on PR #7 merging. Both can land independently, in
whatever order is convenient.

---

## Cross-links

- **PR #7**: https://github.com/LamaSu/physical-capability-cloud/pull/7
- **Synthesis we're closing**: `ai/research/contributor-economics/cross-review-00-synthesis.md`
- **The 7 REST routes**: `packages/gateway/src/routes/contributors.ts` (in PR #7)
- **The 7 MCP tools**: `packages/mcp-server/src/index.ts` lines 1288-1514 (in PR #7)
- **Counter-handoff** from the parallel agent: `ai/research/contributor-economics/cross-review-99-handoff-from-agent-onboarder-v2.md`

If you need a quick contact path, ping in the PCC Network Discord
(https://discord.gg/CRFvvUgeV4) — the `#contributor-economics` channel
or whatever channel ends up tracking this work.
