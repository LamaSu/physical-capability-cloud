# Verification Report: docs/AGENT_INTEGRATION.md §12

**Validator**: val-api-bravo
**Date**: 2026-04-28
**Source doc**: `C:/Users/globa/pcc-contributor-economics/docs/AGENT_INTEGRATION.md` (lines 850-945)
**Code refs**:
- `C:/Users/globa/pcc-contributor-economics/packages/gateway/src/routes/contributors.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/mcp-server/src/index.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/story.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/rate-schedule.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/contracts/ts/payouts.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/contracts/script/`
- `C:/Users/globa/pcc-contributor-economics/apps/dashboard/public/agent-package.json`

---

## §12 endpoint enumeration (8 expected)

§12.2 promises 8 REST endpoints under `/api/contributors`. All 8 route handlers are registered in `contributors.ts`. The path strings and HTTP methods all match. The body input schemas line up with the documented bodies (modulo two minor extras on the publish endpoint). The **response shapes diverge from the doc on 4 of 8** endpoints.

| # | Method | Endpoint | In code? | Body matches? | Response matches? |
|---|--------|----------|----------|---------------|-------------------|
| 1 | POST   | `/api/contributors` | YES (`contributors.ts:134`) | YES — `RegisterProfileBodySchema` accepts `{address, role, scheduleHash, ipId?, metadataUri?, contributorNftTokenId?}` exactly as documented (`contributors.ts:84-91`) | **NO** — doc claims `Returns 201 with profileId`. Actual: `reply.code(201).send({ profile })` (`contributors.ts:165`). The full `profile` object is returned, and the field name is `profile`, not `profileId`. |
| 2 | GET    | `/api/contributors/:address` | YES (`contributors.ts:468`) | n/a (no body) | YES — `{ profiles }` (`contributors.ts:480`) matches doc claim `{profiles: ContributorProfile[]}`. |
| 3 | GET    | `/api/contributors/by-role/:role` | YES (`contributors.ts:178`) | n/a (no body) | **NO** — doc claims `{role, profiles}`. Actual returns only `{ profiles }` (`contributors.ts:191`). The `role` echo is missing. |
| 4 | POST   | `/api/contributors/schedules` | YES (`contributors.ts:302`) | PARTIAL — `PublishScheduleBodySchema` (`contributors.ts:100-109`) accepts `{publishedBy, schedule}` as documented, but the inner `schedule` shape additionally accepts optional `notes`, `scheduleHash`, `publishedAt` fields — none documented. (Server recomputes hash and rejects mismatches, so the extras are mostly harmless, but undocumented.) | YES — `{scheduleHash, alreadyPublished}` (`contributors.ts:343-372`) matches doc. |
| 5 | GET    | `/api/contributors/schedules/:scheduleHash` | YES (`contributors.ts:198`) | n/a | **NO** — doc claims top-level `{schedule, publishedBy, publishedAt}`. Actual: `{ schedule, publishedBy }` (`contributors.ts:236`). `publishedAt` is nested INSIDE `schedule`, not a top-level field. Also: the returned `schedule` includes `scheduleHash` (top-level) per the embedded `RateSchedule` type, which the doc never lists in the response. |
| 6 | POST   | `/api/contributors/schedules/:scheduleHash/evaluate` | YES (`contributors.ts:242`) | YES — `EvaluateScheduleBodySchema` accepts `{now, jobValueCents?, jobsPerDay?}` (`contributors.ts:111-115`) | **NO** — doc claims `{bps, segmentKind}`. Actual: `{scheduleHash, bps, segmentKind, segmentIndex}` (`contributors.ts:291-296`). Two extras (`scheduleHash`, `segmentIndex`) are returned but undocumented. |
| 7 | POST   | `/api/contributors/training-manifests` | YES (`contributors.ts:377`) | PARTIAL — `TrainingManifestBodySchema` accepts `{modelIpId, baseModelIpId?, datasetWeights, methodologyHash?}` (`contributors.ts:117-125`). Doc lists `{modelIpId, baseModelIpId?, datasetWeights}` and omits `methodologyHash`. | YES — `{modelIpId, manifestHash}` (`contributors.ts:421`) matches doc. |
| 8 | GET    | `/api/contributors/training-manifests/:modelIpId` | YES (`contributors.ts:432`) | n/a | **NO** — doc claims `{manifest, manifestHash, registeredAt}`. Actual: `{ manifest: {modelIpId, baseModelIpId, datasets, methodologyHash, manifestHash, createdAt} }` (`contributors.ts:451-460`). `manifestHash` is nested inside `manifest`, not top-level. Field is named `createdAt`, not `registeredAt`. |

**Subtotal**: 8/8 endpoints exist; **4 have response-shape divergences and 1 has an undocumented body field**.

---

## §12 MCP tool enumeration (7 expected)

§12.3 lists tools 50-56. All 7 are registered in `packages/mcp-server/src/index.ts` and call the matching gateway route. The advertised input parameters track the Fastify route bodies almost exactly. **One description claim is misleading**: `pcc_contributor_register` is described as "DB + optional on-chain `ContributorNFT` mint", but the implementation only `pccFetch`es the REST endpoint — there is no on-chain mint path inside the tool.

| # | Tool | Registered? | Input schema matches doc? | Notes |
|---|------|-------------|---------------------------|-------|
| 50 | `pcc_contributor_register` | YES (`mcp-server/src/index.ts:1296-1347`) | YES — accepts the same 6 fields as the REST body (with `designer` legacy alias added) | **Doc-vs-code mismatch**: doc says "DB + optional on-chain `ContributorNFT` mint". Code only POSTs to `/api/contributors`; there is **no mint code-path** (`AGENT_INTEGRATION.md:879`). |
| 51 | `pcc_contributor_list` | YES (`index.ts:1351-1361`) | YES — single `address` param | Match. |
| 52 | `pcc_schedule_publish` | YES (`index.ts:1365-1395`) | YES — `{publishedBy, schedule}` | Match. Inner `schedule.segments` is typed `z.array(z.record(z.unknown()))` (loose); validation happens server-side. |
| 53 | `pcc_schedule_get` | YES (`index.ts:1399-1413`) | YES — single `scheduleHash` param | Match. |
| 54 | `pcc_schedule_evaluate` | YES (`index.ts:1417-1452`) | YES — `{scheduleHash, now, jobValueCents?, jobsPerDay?}` | Match. |
| 55 | `pcc_training_manifest_set` | YES (`index.ts:1456-1496`) | YES — `{modelIpId, baseModelIpId?, datasetWeights, methodologyHash?}` | The `methodologyHash` field is exposed on the MCP tool but not mentioned in the §12.2 REST table — internal consistency issue. |
| 56 | `pcc_training_manifest_get` | YES (`index.ts:1500-1512`) | YES — single `modelIpId` param | Match. |

**Subtotal**: 7/7 tools registered. 1 has a misleading description; 1 has a parameter not surfaced in the §12.2 REST docs.

---

## Role taxonomy verification

§12.4 lists 10 roles + states "no OEM royalty class". `packages/spec/src/types/story.ts:49-70` defines `ContributorRole` as a union with **11 members**: the 10 documented ones + a deprecated `designer` (kept for legacy decode).

| # | Doc role | In `ContributorRole` union? |
|---|----------|----------------------------|
| 1 | `operator` | YES (`story.ts:51`) |
| 2 | `verifier` | YES (`story.ts:53`) |
| 3 | `insurer` | YES (`story.ts:54`) |
| 4 | `integrator` | YES (`story.ts:56`) |
| 5 | `protocol-author` | YES (`story.ts:57`) |
| 6 | `model-author` | YES (`story.ts:58`) |
| 7 | `dataset-contributor` | YES (`story.ts:59`) |
| 8 | `curator` | YES (`story.ts:61`) |
| 9 | `assembler` | YES (`story.ts:62`) |
| 10 | `network-treasury` | YES (`story.ts:64`) |

All 10 documented roles are present. The doc does not mention the deprecated `designer` member, but it's a legacy decoder — not a new role. Acceptable omission in user-facing docs IF a footnote/cross-link is added (today there is none in §12.4).

`packages/contracts/ts/payouts.ts:65-76` exposes a `ROLE_TAGS` object with keccak256 hashes for **the same 10 strings** (no `designer`). On-chain ROLE_TAGS therefore tracks the doc, not the legacy alias. **Pass.**

---

## Segment DSL example verification

§12.5 example:
```typescript
const schedule = {
  version: 1,
  segments: [
    { kind: "constant", startTime: 0, endTime: 15552000, bps: 80 },
    { kind: "constant", startTime: 15552000, endTime: 47174400, bps: 40 },
    { kind: "constant", startTime: 47174400, endTime: null, bps: 10 },
  ],
};
```

Per `packages/spec/src/types/rate-schedule.ts`:

- Each segment matches `ConstantSegmentSchema` (`kind`, `startTime`, `endTime`, `bps`) — `rate-schedule.ts:45-50`. **Pass.**
- The discriminated union accepts `kind: "constant"` segments — `rate-schedule.ts:120-127`. **Pass.**
- However, the doc labels this as a `RateSchedule`, but `RateScheduleSchema` (`rate-schedule.ts:147-153`) **also requires** `scheduleHash: string` (regex `^0x[a-f0-9]{64}$`) and `publishedAt: string`. The example omits both. So:
  - Posting this object to `POST /api/contributors/schedules` works (the endpoint uses `PublishScheduleBodySchema`, where `scheduleHash` and `publishedAt` are optional and the server fills them in).
  - Calling `evaluateRateSchedule(schedule, ctx)` directly with this object would type-error in TypeScript (missing `scheduleHash`, `publishedAt`).

**Verdict: passes for the wire-format use-case (the obvious reading), would type-error for direct evaluator use.** A small note in §12.5 — "this is the wire-format body for `POST /api/contributors/schedules`; the server fills in `scheduleHash` and `publishedAt`" — would resolve the ambiguity.

The doc also says "Six segment kinds are supported: constant, step, linear-decay, exponential-decay, adoption-indexed, piecewise-value." `RateSegmentKindSchema` (`rate-schedule.ts:32-39`) lists exactly those six. **Pass.**

---

## E2E shell walkthrough verification (§12.6)

The 5-step walkthrough has **two unresolvable references** and **one not-yet-implemented gateway claim**.

| Step | Verdict | Notes |
|------|---------|-------|
| 1. `curl POST /api/contributors/schedules` | **PASS** | Endpoint exists. Inline JSON body matches `PublishScheduleBodySchema`. Sample response `{"scheduleHash":"0xabc...","alreadyPublished":false}` is correct. The body itself is missing the `notes` field, but that is optional. |
| 2. `forge script script/PublishSchedule.s.sol --broadcast` | **BROKEN** | **`PublishSchedule.s.sol` does not exist** in `packages/contracts/script/`. Existing scripts: `Deploy.s.sol`, `DeployContributorEconomics.s.sol`, `DeployLocal.s.sol`, `DeployProtocol.s.sol`. The doc references a forge script that has never been written. Also references undocumented env var `BASE_SEPOLIA_RPC` (not in §11 env-var table). |
| 3. `curl POST /api/contributors` | **PASS (with body caveat)** | Endpoint exists. Sample body is missing `Content-Type: application/json` header (other §12 examples include it; minor inconsistency). The role `"integrator"` is valid (`story.ts:56`). |
| 4. `forge script script/MintContributor.s.sol --broadcast` | **BROKEN** | **`MintContributor.s.sol` does not exist** in `packages/contracts/script/`. Same problem as Step 2. The walkthrough cross-links to `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` but that doc also has no mention of `MintContributor` (verified by grep). |
| 5. "When a job uses your adapter, the payer's `buildPayoutMap()` automatically evaluates your schedule and includes you in the on-chain `Payout[]` passed to `MilestoneEscrow.setPayoutMap()`." | **NOT IMPLEMENTED** | `packages/contracts/ts/payouts.ts:123-129`: `buildPayoutMap()` is a stub that **throws** `"buildPayoutMap: not implemented — Wave 3c (LicensingEngine extension)"`. The doc presents this as live functionality. `MilestoneEscrow.setPayoutMap` and `splitPayout` DO exist (`MilestoneEscrow.sol:308`, `MilestoneEscrow.sol:508`), but the upstream JS helper that builds the `Payout[]` is not done, so a fresh agent following the walkthrough hits a runtime exception in the very last "earn on every job" step. |

**Verdict: walkthrough is misleading on Steps 2, 4, and 5.** Steps 1 and 3 work end-to-end against the running gateway; Steps 2, 4, 5 promise functionality that does not yet exist. The §12 doc gives no caveat about Wave 3c being incomplete.

Also: the example uses `$PCC_KEY` and `0xMy...Address` consistently as placeholders, which is good. But §12.1 talks about `MilestoneEscrow.splitPayout()` "evaluating every attached contributor's schedule…and routing the on-chain Payout array directly to each contributor's wallet — no manual reconciliation, no off-chain bookkeeping." This is also Wave 3c work — the contract has the storage and event scaffolding, but the off-chain `buildPayoutMap()` that produces the `Payout[]` does not yet work.

---

## Tool-count consistency

| Claim | Doc says | Actual |
|-------|----------|--------|
| MCP tool count | "MCP Server (56 Tools)" — `AGENT_INTEGRATION.md:12, 668` | **56** — `grep -c '^server.tool('` on `packages/mcp-server/src/index.ts` returns 56. **Pass.** |
| Agent package tool count (header line) | "Agent Package (218 Tools)" — `AGENT_INTEGRATION.md:13, 750` | **218** — `apps/dashboard/public/agent-package.json` has `"toolCount": 218`. `grep -c '"endpoint":' = 218`. **Pass.** |

Note: a separate `grep -c '"name":'` returns 219, but that count includes the package's top-level `"name": "Physical Capability Cloud"` field (`agent-package.json:3`) plus 218 tool entries. The 218 figure is correct.

---

## Cross-link integrity

§12 cross-references the following paths:

| Reference | Target exists? | Notes |
|-----------|----------------|-------|
| `docs/claros-layer4-amendment.md` (§12.4) | YES — `docs/claros-layer4-amendment.md` | OK |
| `ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md` (§12.4) | YES | OK |
| `packages/spec/src/types/rate-schedule.ts` (§12.5) | YES | OK; the file is the canonical DSL definition. |
| `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` (§12.6) | YES — file exists | But it does not contain `PublishSchedule` or `MintContributor` references (grep returned no matches), so it cannot stand in for the broken forge-script claims. |
| `docs/CONTRIBUTOR_ECONOMICS.md` (§12.6) | YES — file exists | OK as a cross-link; not verified in depth. |
| `script/PublishSchedule.s.sol` (§12.6) | **NO** — not in `packages/contracts/script/` | **Broken**. |
| `script/MintContributor.s.sol` (§12.6) | **NO** — not in `packages/contracts/script/` | **Broken**. |
| §7 cross-link from §12.3 ("see §7") | The cross-link wording is fine, but §7 is titled "MCP Server (56 Tools)" and lists tools 1-49; tools 50-56 are listed in §7 separately at `AGENT_INTEGRATION.md:735+`. Verified §7 does have the 50-56 entries. | OK |

**Verdict**: 5/7 explicit cross-links resolve. The 2 forge-script paths are broken.

---

## Friction scores (1-10, higher = better)

- **Endpoint table accurate**: 6 — All 8 routes exist and use the documented methods/paths/bodies, but **4 of 8 response shapes diverge** from the doc; one body has an undocumented optional field. A fresh agent debugging a response payload would lose 15-30 minutes per discrepancy. Critical data (e.g., `manifestHash` is nested in `manifest`, not top-level) silently breaks any code that pulls fields via documented top-level keys.
- **MCP tool table accurate**: 7 — All 7 tools exist and the input schemas match. The misleading "DB + optional on-chain mint" description on `pcc_contributor_register` would lure an agent into expecting a mint flag that doesn't exist; the surfaced `methodologyHash` parameter is a tractable internal-consistency issue.
- **Could I write a working integration off this doc alone**: 4 — The off-chain happy path (publish → register → evaluate) is doable. The on-chain claims (forge scripts, `buildPayoutMap`) lead to dead ends. A fresh agent would write a script that fails at Step 2 (script not found), then fails again at the `buildPayoutMap()` runtime exception. Without the §12 walkthrough explicitly flagging Wave 3c as incomplete, the doc reads as if the entire pipeline is shipped.
- **Overall**: **5** — Foundation is real; the off-chain primitives (REST + MCP + spec + role taxonomy) are coherent and documented well. But the §12.6 walkthrough — the *one* end-to-end recipe a fresh agent will copy — promises forge scripts that don't exist and a `buildPayoutMap()` that throws. That's the worst possible place for documentation drift.

---

## Specific fixes I'd recommend

1. **`AGENT_INTEGRATION.md:864`** — change `Returns 201 with profileId.` to `Returns 201 with {profile: ContributorProfile}.` The route returns the full profile, not just an id.

2. **`AGENT_INTEGRATION.md:866`** — change `Returns {role, profiles: ContributorProfile[]}.` to `Returns {profiles: ContributorProfile[]}.` The current code does not echo the role.

3. **`AGENT_INTEGRATION.md:868`** — change `Returns {schedule, publishedBy, publishedAt}.` to `Returns {schedule, publishedBy}` (where `publishedAt` lives inside `schedule`).

4. **`AGENT_INTEGRATION.md:869`** — change `Returns {bps, segmentKind}.` to `Returns {scheduleHash, bps, segmentKind, segmentIndex}.` Document the two extras the route already returns.

5. **`AGENT_INTEGRATION.md:870`** — add `methodologyHash?: 0x64hex` to the documented body and call out that it's an optional reproducibility hash. Currently only the MCP tool surfaces it.

6. **`AGENT_INTEGRATION.md:871`** — change `Returns {manifest, manifestHash, registeredAt}.` to `Returns {manifest: {modelIpId, baseModelIpId, datasets, methodologyHash, manifestHash, createdAt}}.` Note the field is `createdAt`, not `registeredAt`, and `manifestHash` is nested.

7. **`AGENT_INTEGRATION.md:879`** — change `pcc_contributor_register` description from `Register a contributor profile (DB + optional on-chain ContributorNFT mint)` to `Register a contributor profile (DB-only; on-chain ContributorNFT mint is a separate forge step — see §12.6).` Remove the implication that the MCP tool can mint.

8. **`AGENT_INTEGRATION.md:912`** — append to the §12.5 paragraph: `Note: when posted to POST /api/contributors/schedules the scheduleHash and publishedAt fields are computed/filled by the server. Direct calls to evaluateRateSchedule() require both fields to be present locally.` This resolves the type-vs-wire-format ambiguity.

9. **`AGENT_INTEGRATION.md:927-929`** — replace the `forge script script/PublishSchedule.s.sol` block with either (a) a pointer to the correct script name, or (b) an explicit "TODO Wave 3c: forge script not yet shipped" callout. The current text references a file that does not exist.

10. **`AGENT_INTEGRATION.md:936-937`** — same fix for `MintContributor.s.sol`. Either ship the script or label the step as forthcoming.

11. **`AGENT_INTEGRATION.md:939-942`** — add a callout: `Note: the buildPayoutMap() helper in @pcc/contracts is currently a stub that throws "not implemented — Wave 3c (LicensingEngine extension)". Until the LicensingEngine ships, payers must manually populate the Payout[] array passed to MilestoneEscrow.setPayoutMap().` This prevents agents from copying the walkthrough wholesale and hitting a runtime exception.

12. **`AGENT_INTEGRATION.md:893`** — add a brief footnote about the deprecated `designer` role member: `Note: the spec also retains a deprecated 'designer' alias for legacy decode (see ADR-12 §2.2). Do not register new profiles with this role.` This avoids surprise when an agent inspects the type union.

13. **`AGENT_INTEGRATION.md:929, 937`** — `BASE_SEPOLIA_RPC` is used in the §12.6 examples but absent from the §11 environment-variable table (`AGENT_INTEGRATION.md:836` area). Add it to the env-var table or use `$PCC_NETWORK`-derived RPC discovery.

---

## Verdict

**PARTIAL** — §12 is structurally honest about the off-chain primitives (8 endpoints, 7 MCP tools, 10-role taxonomy, 6-segment DSL all exist and are wired), but the §12.6 end-to-end walkthrough materially misrepresents on-chain state (two missing forge scripts, `buildPayoutMap()` is a not-yet-implemented stub). Response-shape divergences on 4/8 endpoints add minor but real friction. A fresh agent could publish + evaluate a RateSchedule today, but cannot complete the documented "earn on every job" flow.
