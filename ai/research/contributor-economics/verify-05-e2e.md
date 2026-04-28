# E2E Verification: Full Onboarding Journey
**Validator**: val-e2e-echo
**Date**: 2026-04-28
**Persona**: integrator who wrote an OctoPrint adapter for PCC; wants to register, publish a 50bp-first-year / 20bp-after rate schedule, and verify it works.
**Method**: fresh-agent walk starting at `C:/Users/globa/pcc-contributor-economics/README.md`, follow links naturally, no edits/commits to project code.

---

## Step-by-step journey

### Step 0: Onboarding navigation

- Landed on `README.md`. The "Contributor Economics" block at line 11 was prominent and pointed me at three docs and a thesis:
  - `docs/CONTRIBUTOR_ECONOMICS.md` — quickstart
  - `docs/AGENT_INTEGRATION.md §12` — API reference
  - `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` — deploy
  - `docs/claros-layer4-amendment.md` — no-OEM thesis
- Followed CONTRIBUTOR_ECONOMICS.md first (the README directs me there as the 5-minute path).
- One-sentence answer: "to onboard, I read `docs/CONTRIBUTOR_ECONOMICS.md` for the conceptual map, then `docs/AGENT_INTEGRATION.md §12` for exact request shapes, then `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` if I want to also publish on-chain." That mental map was buildable in under 3 minutes.

### Step 1: Construct a valid RateSchedule

"50bp first year, 20bp after." Two `constant` segments: one with explicit `endTime`, the next picking up from there with `endTime: null`.

Wire body (what I would POST):

```json
{
  "publishedBy": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "schedule": {
    "version": 1,
    "segments": [
      { "kind": "constant", "startTime": 1745452800, "endTime": 1776988800, "bps": 50 },
      { "kind": "constant", "startTime": 1776988800, "endTime": null,       "bps": 20 }
    ],
    "notes": "Integrator share: 50bp first year, 20bp after."
  }
}
```

(t0 = 2026-04-24 ≈ 1745452800 unix; t0+365d = 1776988800.)

**scheduleHash computed** by walking `packages/spec/src/util/canonical.ts` + `packages/spec/src/types/rate-schedule.ts:computeScheduleHash` (sorts keys lex at every depth, only `{version, segments}` participate in hashing — `notes` and `publishedAt` are excluded):

```
canonical: {"segments":[{"bps":50,"endTime":1776988800,"kind":"constant","startTime":1745452800},{"bps":20,"endTime":null,"kind":"constant","startTime":1776988800}],"version":1}
scheduleHash: 0xb0fcd1ae281c022b71434fc10e1d8bd3a1c9e84c4a7df971539baa4ea4dc359e
```

**evaluateRateSchedule sanity-check** (re-implemented the cover/branch logic per the source):
- t0+30d (year 0)  → bps=50, segmentIndex=0 (constant)
- t1+1   (year 1+) → bps=20, segmentIndex=1
- t1+400d (year 2+) → bps=20, segmentIndex=1 (open-ended segment)
- t0-1   (before)  → bps=0,  segmentIndex=-1 (no cover)

All four match what the docs claim. `RateScheduleSchema` (rate-schedule.ts:147) accepts `segments: array().min(1)` so two segments is fine. `assertScheduleIsWellFormed` accepts non-overlap with `seg.startTime ≥ prevEnd`; the second segment's `startTime == prevEnd` is the boundary case and is accepted (the check is `<`, strictly less than, so equality passes).

### Step 2: Construct the publish-schedule HTTP request

Body shape per `CONTRIBUTOR_ECONOMICS.md:114-135` and `AGENT_INTEGRATION.md §12.2`:
`{publishedBy, schedule: {version, segments, notes?, scheduleHash?, publishedAt?}}`.

Cross-referenced against `packages/gateway/src/routes/contributors.ts:100-109`
(`PublishScheduleBodySchema`) — exact match. Server recomputes the hash and rejects mismatches; 400 on shape error.

curl I would run (exactly — not actually run, since the gateway isn't up):

```bash
curl -X POST https://capability.network/api/contributors/schedules \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "publishedBy": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "schedule": {
          "version": 1,
          "segments": [
            {"kind":"constant","startTime":1745452800,"endTime":1776988800,"bps":50},
            {"kind":"constant","startTime":1776988800,"endTime":null,       "bps":20}
          ],
          "notes": "Integrator share: 50bp first year, 20bp after."
        }
      }'
```

Expected response: `{"scheduleHash":"0xb0fcd1ae281c022b71434fc10e1d8bd3a1c9e84c4a7df971539baa4ea4dc359e","alreadyPublished":false}`.

**Doc-vs-Zod**: `CONTRIBUTOR_ECONOMICS.md` example uses `"0xYourWallet"` as the publisher placeholder (line 127). That literal string would fail Zod's `AddressSchema = /^0x[a-fA-F0-9]{40}$/` validation (400). Cosmetic — the doc is meant to be a template — but a copy-paste user would hit a 400 before learning what shape is needed. Same in `AGENT_INTEGRATION.md §12.6` (`"0xMy...Address"`).

### Step 3: Construct the register-profile HTTP request

Body shape per `CONTRIBUTOR_ECONOMICS.md:140-148` (and called out explicitly: "RegisterProfileBodySchema accepts `{address, role, scheduleHash, ipId?, metadataUri?, contributorNftTokenId?}` — there is no `label` field today").

Cross-referenced against `packages/gateway/src/routes/contributors.ts:84-91` (`RegisterProfileBodySchema`) — exact match.

Role enum validation: gateway accepts `integrator` (line 57-70: explicit `z.enum([... 'integrator' ...])`). Confirmed.

curl:

```bash
curl -X POST https://capability.network/api/contributors \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        "role": "integrator",
        "scheduleHash": "0xb0fcd1ae281c022b71434fc10e1d8bd3a1c9e84c4a7df971539baa4ea4dc359e",
        "metadataUri": "ipfs://Qm.../octoprint-adapter-spec.json"
      }'
```

Expected 201 with `{profile: {id, address, role, scheduleHash, ipId, contributorNftTokenId, metadataUri, registeredAt}}` (route at line 165 returns `{profile}`, not just an id — AGENT_INTEGRATION.md §12.2 explicitly notes this).

### Step 4: On-chain mint

`packages/contracts/script/PublishSchedule.s.sol` and `packages/contracts/script/MintContributor.s.sol` both **exist** (verified via Glob).

Reading `MintContributor.s.sol`:
- Required env: `CONTRIBUTOR_NFT_ADDRESS`, `ROLE_TAG_HEX`, `SCHEDULE_HASH`, `METADATA_URI`, `DEPLOYER_PRIVATE_KEY`
- Optional: `MINT_TO` (defaults to broadcaster), `IP_ID` (defaults to 0)
- Docstring example computes role tag with `cast keccak "integrator"` → `0x7fca04c084f97ed662fee1aeb0c969285c1557298812941e9d0396b1dc9b7b25`.

I cross-checked this against `packages/contracts/ts/payouts.ts:74-84` (`ROLE_TAGS = { integrator: keccak256(stringToHex("integrator")), ... }`):

```
viem.keccak256(viem.stringToHex("integrator"))
= 0x7fca04c084f97ed662fee1aeb0c969285c1557298812941e9d0396b1dc9b7b25
```

`cast keccak "integrator"` produces the same value. Role-tag seam: VERIFIED.

`PublishSchedule.s.sol` requires `RATE_SCHEDULE_REGISTRY_ADDRESS`, `SCHEDULE_BYTES_HEX`, `EXPECTED_HASH`, `DEPLOYER_PRIVATE_KEY`. The script asserts `sha256(scheduleBytes) == expectedHash` matches what `RateScheduleRegistry.publish` does on-chain.

`docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md:25-40` documents env vars (`DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`, `RPC_URL`). Pre-deploy check on lines 42-52 expects 58 forge tests to pass on the contributor-economics paths — **I ran `forge test --match-path 'test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}*'` and confirmed: 58 passed (15 ContributorNFT + 14 splitPayout + 18 base + 11 registry).** Deploy doc claim verified.

### Step 5: Verify buildPayoutMap works

Read `packages/contracts/ts/payouts.ts` end-to-end. The function is **fully implemented** — no `throw "not implemented"` anywhere. The algorithm (lines 201-298):

1. No manifest → `{payouts: [], operatorResidualBps: 10000, breakdown: []}` (operator gets 100%).
2. For each `entry` in `manifest.entries`:
   - Resolve `RateSchedule` via `scheduleByHash.get(entry.rateScheduleHash)` then `scheduleByIpId.get(entry.ipId)` fallback.
   - `rawBps = evaluateRateSchedule(schedule, ctx).bps` (or 0 if no schedule/ctx).
   - `effectiveBps = round(rawBps * groupBps / 10000)` if `groupBps !== 10000`, else `rawBps`.
   - Push a Payout row when `effectiveBps > 0`.
   - All entries (including 0-bps) appear in the `breakdown` array for audit.
3. Sum check: throws `"buildPayoutMap: sum of bps (X) exceeds 10000 — manifest is over-allocated"` if sum > 10000.
4. `operatorResidualBps = 10000 - sum`.

**Mental trace for our integrator**: imagine a CompositionManifest with one entry — me, role `integrator`, `rateScheduleHash = 0xb0fcd1...`, `groupBps` absent. At settlement at t0+30d:
- `compositionRoleToTagKey("integrator") → "integrator"` (line 102).
- `roleTag = ROLE_TAGS.integrator = 0x7fca04c0...` (matches Step 4).
- Resolve schedule via `scheduleByHash.get("0xb0fcd1...")` → my schedule.
- `evaluateRateSchedule(schedule, {now: t0+30d, jobValueCents, jobsPerDay}) = {bps: 50, ...}`.
- `groupBps` undefined → `effectiveBps = 50`.
- One Payout row: `{recipient: 0xMyWallet, bps: 50n, roleTag: 0x7fca..., ipId: capabilityIpId}` (entry has no ipId in this trace, so falls back to capabilityIpId on line 257).
- Returns `payouts.length=1, operatorResidualBps=9950, breakdown.length=1`.

Operator gets 9950 / 10000 = 99.5% of the distributable. I (integrator) get 50 / 10000 = 0.5%.

### Step 6: Settlement chain

Walk a real job using my adapter, link by link:

| Step | What happens | Doc covers it | Code that implements it | Doc-vs-impl |
|------|--------------|---------------|-------------------------|-------------|
| 1 | Payer composes a `CompositionManifest` listing me as an `integrator` entry with my `rateScheduleHash` | CONTRIBUTOR_ECONOMICS.md "How to use it" Step 4 (mentions `buildPayoutMap` + ADR-11) | `packages/spec/src/types/composition-manifest.ts:CompositionManifestSchema` | accurate |
| 2 | Payer calls `buildPayoutMap({jobValue, capabilityIpId, compositionManifest, evaluationContext, scheduleByHash})` to produce a `Payout[]` | CONTRIBUTOR_ECONOMICS.md Step 4 + AGENT_INTEGRATION.md §12.6 step 5 | `packages/contracts/ts/payouts.ts:buildPayoutMap` (FULLY IMPLEMENTED) | accurate |
| 3 | Payer calls `MilestoneEscrow.setPayoutMap(milestoneIndex, payouts)` BEFORE `fund()`. Reverts if `payouts.length > 16` or any `bps > 5000` or duplicate `(recipient, roleTag)` pairs or `sum > 10000` | CONTRIBUTOR_ECONOMICS.md Step 4 + DEPLOY_CONTRIBUTOR_ECONOMICS.md "Common errors" row | `packages/contracts/src/MilestoneEscrow.sol:308 setPayoutMap` (line 316: MAX_PAYOUTS=16; line 326: dup check) | accurate |
| 4 | Job runs, evidence submitted, attested. (Out of scope of contributor-economics — covered by base PCC docs.) | n/a | n/a | n/a |
| 5 | Operator (or anyone) calls `release(milestoneIndex)` | (general) AGENT_INTEGRATION.md §3 escrow table | `packages/contracts/src/MilestoneEscrow.sol:456 release` | accurate |
| 6 | `release()` distributes: protocol fee → fee recipient; per-Payout amounts → each recipient (emits `SplitPayoutExecuted`); residual + bond → operator (emits `MilestoneReleased`) | CONTRIBUTOR_ECONOMICS.md "How it works" §3 third bullet | `MilestoneEscrow.sol:469 emit MilestoneReleased` + line 555 `emit SplitPayoutExecuted` | accurate |

**Settlement-chain verdict**: every link has both doc coverage and a corresponding implementation. The doc says "Operator gets `(distributable - sumDistributed) + bond`" and that matches the implementation (in `release` the residual goes to the operator; the bond is returned in the same tx).

---

## Gotcha checklist

| Gotcha | Status | Notes |
|---|---|---|
| No `@pcc/store` references in user-facing docs (real package is `@pcc/db`) | **FIXED** | `docs/CONTRIBUTOR_ECONOMICS.md` and `docs/AGENT_INTEGRATION.md` both reference `@pcc/db` / `packages/db/`. Only remaining `@pcc/store` mentions are in the prior verifiers' history files (`verify-01-quickstart.md`, `verify-04-resume.md`) and in a code comment at `packages/gateway/src/routes/contributors.ts:5` — none user-facing. |
| No `§14` references — should all be `§12` | **FIXED** | No `§14` matches anywhere except in the verify-* history files (where they're cited as the prior bug). README + CONTRIBUTOR_ECONOMICS + AGENT_INTEGRATION all use `§12`. |
| No `218 vs 219 tools` self-contradiction in README | **FIXED** | README says `218 tools` consistently (lines 27 and 60). |
| No `49 MCP tools` reference — should be `56` | **PARTIAL — REGRESSION ELSEWHERE** | README + AGENT_INTEGRATION use 56 (good). But `49 MCP tools` still appears in: `CLAUDE.md:848` ("**All 49 MCP tools**"), `AGENTS.md:31` ("`packages/mcp-server` 49 MCP tools over stdio"), `SUBMISSION_SUMMARY.md:15,51`, `.claude/commands/pcc-identity.md:59`, and a runtime string at `packages/gateway/src/routes/context-pack.ts:475` (which means /api/context-pack returns "49 MCP tools" to agents asking the gateway for orientation). The README links to CLAUDE.md as the "complete developer reference" so this drift is reachable from the front door. |
| No `32 forge tests` in places that mean total — actual is 58 (40 contributor-economics + 18 base) | **FIXED** | No `32 forge tests` matches in user-facing docs. README and CONTRIBUTOR_ECONOMICS both say "40 new Forge tests" / "58 total when the broader MilestoneEscrow base suite is included". `forge test` confirmed: 11+15+14+18 = 58. |
| `script/PublishSchedule.s.sol` and `script/MintContributor.s.sol` exist | **FIXED** | Both files present; both compile under `forge build`; both have full env-var docstrings. |
| `buildPayoutMap()` is implemented (no longer a throw) | **FIXED** | `packages/contracts/ts/payouts.ts:201-298` is the full implementation. Walks manifest entries, resolves schedules, applies groupBps, throws only when sum > 10000. No "not implemented" anywhere. |
| DEPLOY doc no longer claims gateway-on-chain wiring works | **FIXED** | `DEPLOY_CONTRIBUTOR_ECONOMICS.md:197-219` titled "Wiring into the gateway (future work)" — explicitly says routes are off-chain today, no `viem.readContract` exists, future env vars listed but described as "no-op until that work lands". |
| `CONTRIBUTOR_ECONOMICS.md` cheat sheet paths all resolve | **FIXED** | All 30 paths I tested resolve (full table run through `[ -e ]` — every single one OK). |

---

## Inter-doc seams found

These are the seams the per-doc validators couldn't see, because they each only read one doc.

### SEAM-1 [HIGH IMPACT — the load-bearing seam] — On-chain `RateScheduleRegistry.publish` cannot consume the schedule the gateway returned

The gateway computes `scheduleHash` as `sha256(canonicalize({version, segments}))` (per `computeScheduleHash` in `rate-schedule.ts:265-275`). `canonicalize` sorts object keys lexicographically — `segments` comes BEFORE `version` in the canonical bytes.

But `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md:135-145` (the "Smoke-publish a schedule" cast-send recipe) AND the docstring example in `packages/contracts/script/PublishSchedule.s.sol:46-49` both use:

```bash
SCHEDULE_BYTES='{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}'
SCHEDULE_HASH=$(printf '%s' "$SCHEDULE_BYTES" | shasum -a 256 | cut -d' ' -f1)
```

These are the literal user-typed bytes with `version` first. They hash to `0x127ee0b0762b69016b7b101783c09feb79e2d355b93950f409e154a4f71a48b0`. But the gateway-computed canonical hash for the same schedule is `0xe0e75ab2547d106ab6f3e211f0859cb85fe3f9bdb1b081dde24e20122d50f61a`. They differ.

I verified this end-to-end with Node:

```
canonical:  {"segments":[{"bps":40,"endTime":null,"kind":"constant","startTime":0}],"version":1}
hash:       0xe0e75ab2547d106ab6f3e211f0859cb85fe3f9bdb1b081dde24e20122d50f61a

literal:    {"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}
hash:       0x127ee0b0762b69016b7b101783c09feb79e2d355b93950f409e154a4f71a48b0
```

Failure mode: an integrator follows CONTRIBUTOR_ECONOMICS.md, gets `0xe0e75a...` from the gateway, then tries the deploy doc's smoke-publish recipe — the on-chain `publish()` succeeds with the LITERAL bytes under hash `0x127ee0...`, but their `ContributorNFT.mint(scheduleHash=0xe0e75a...)` reverts with "Schedule not registered" because the hash they're trying to mint against was never published. The doc claims this works via the line "the same algorithm (sha256 over canonical JSON of {version, segments}) used by the on-chain RateScheduleRegistry.publish()" (gateway routes file, line 314-317) but the deploy doc's example skips canonicalization.

The script's `IRateScheduleRegistry.publish(scheduleBytes, expectedHash)` requires the bytes to hash to the supplied expected hash — fine, but the example bytes ARE NOT canonical and so do NOT match the off-chain hash an integrator would have just received.

**Fix needed**: `DEPLOY_CONTRIBUTOR_ECONOMICS.md:131-145` and `PublishSchedule.s.sol:46-49` should either (a) show how to canonicalize first (e.g., a `node -e 'console.log(canonicalize({version:1, segments:[...]}))'` step) or (b) explicitly call out that the bytes shown are illustrative and the user must use the canonical bytes the gateway used to compute their hash. Currently both docs implicitly assume any JSON works, which is false.

This is the single most damaging seam an integrator could hit. The whole 5-step quickstart appears to compose, and individual docs each look right, but Step 4 (on-chain publish) is incompatible with Step 1 (off-chain publish) in its currently documented form.

### SEAM-2 [MEDIUM IMPACT] — `49 MCP tools` is reachable through CLAUDE.md / AGENTS.md / context-pack route

Front-door fix landed: README itself says 56. But the README directs users to `CLAUDE.md` ("complete developer reference") which still says "All 49 MCP tools" (line 848) and lists tools 1-49 only. AGENTS.md, SUBMISSION_SUMMARY.md, and `.claude/commands/pcc-identity.md` similarly still say 49. The runtime gateway route `packages/gateway/src/routes/context-pack.ts:475` is the worst — when an agent fetches `/api/context-pack` for live orientation, the response says "49 MCP tools", which contradicts the actual MCP tool count. Doc-vs-runtime drift, plus a doc-vs-doc drift between README/CLAUDE.md.

### SEAM-3 [LOW IMPACT — cosmetic] — Address placeholders fail Zod validation

`CONTRIBUTOR_ECONOMICS.md` Steps 1+2 use `"0xYourWallet"` literal as the publisher/registrant. The gateway's `AddressSchema = /^0x[a-fA-F0-9]{40}$/` rejects that string with HTTP 400 + "address must be 0x + 40 hex chars". A copy-paste-and-substitute user is fine. A copy-paste-as-is user gets a 400 with a useful error message. Same in `AGENT_INTEGRATION.md §12.6` (`"0xMy...Address"`). No fix urgently needed but a `<your-40-hex-wallet>` token would be friendlier than something that looks like it might be a sentinel value.

### SEAM-4 [LOW IMPACT] — Comment in route file still says `@pcc/store`

The user-facing docs were fixed for `@pcc/store → @pcc/db`, but the docstring at the top of `packages/gateway/src/routes/contributors.ts:5` still says "Surfaces the @pcc/store ContributorRepository". Not user-facing, but a future maintainer reading the route file would be confused. Worth a follow-up `chore(docs):`.

### SEAM-5 [LOW IMPACT] — `BASE_SEPOLIA_RPC` documented in two places, consistent values

`AGENT_INTEGRATION.md §12.6` mentions it, defaults to `https://sepolia.base.org`. `DEPLOY_CONTRIBUTOR_ECONOMICS.md:121` exports `BASE_SEPOLIA_RPC=https://sepolia.base.org`. Same default; no drift. Just noting that this seam works correctly.

---

## Friction scores (1-10)

- Could complete the full journey from docs alone: **6** — Steps 1-3 (off-chain) work cleanly. Step 4 (on-chain mint) fails as documented because of SEAM-1; an integrator copying the recipe would publish the wrong bytes on-chain and then the mint reverts. Recoverable but only after reading the spec source.
- Each doc handoff worked: **7** — README→CONTRIBUTOR_ECONOMICS→AGENT_INTEGRATION→DEPLOY all cross-link cleanly. Cheat-sheet paths all resolve. The on-chain canonicalization handoff between AGENT_INTEGRATION §12.6 and PublishSchedule.s.sol is broken (SEAM-1).
- Code matches docs: **8** — buildPayoutMap is real, scripts exist, role tag matches, gateway Zod matches doc body shapes, `forge test` produces 58 passes as claimed. The one mismatch is the SCHEDULE_BYTES example (canonicalization) and the lingering `49 MCP tools` strings in CLAUDE.md / AGENTS.md / context-pack.
- **Overall: 6.5**
- **Verdict: PARTIAL**

---

## Specific residual fixes (new bugs found that the per-doc validators missed)

1. **[SEAM-1, HIGH] Fix the on-chain publish recipe.**
   - File: `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md:135-145` ("Smoke-publish a schedule" block)
   - File: `packages/contracts/script/PublishSchedule.s.sol:46-49` (docstring example)
   - Fix: replace `SCHEDULE_BYTES='{"version":1,"segments":...}'` with a step that produces canonical bytes — e.g.:
     ```bash
     # Canonical bytes (sorted keys at every depth — must match @pcc/spec computeScheduleHash)
     SCHEDULE_BYTES=$(node -e 'const c=(v)=>{
       if(v===null||v===undefined)return"null";
       if(typeof v==="string")return JSON.stringify(v);
       if(typeof v==="number"||typeof v==="boolean")return String(v);
       if(Array.isArray(v))return"["+v.map(c).join(",")+"]";
       if(typeof v==="object"){const k=Object.keys(v).sort();return"{"+k.filter(x=>v[x]!==undefined).map(x=>JSON.stringify(x)+":"+c(v[x])).join(",")+"}"}
       return String(v);
     };console.log(c({version:1,segments:[{kind:"constant",startTime:0,endTime:null,bps:40}]}))')
     SCHEDULE_HASH=$(printf '%s' "$SCHEDULE_BYTES" | shasum -a 256 | cut -d' ' -f1)
     ```
   - Or alternatively expose a CLI: `node packages/spec/dist/util/canonicalize-schedule.js <schedule.json>` and have the doc reference that.
   - Without this fix, the headline integration story ("publish off-chain → mint on-chain → earn") does not work end-to-end as documented.

2. **[SEAM-2, MEDIUM] Sweep `49 MCP tools` strings.**
   - `CLAUDE.md:848` — change "**All 49 MCP tools**" to **All 56 MCP tools**, and add rows 50-56 (or link to AGENT_INTEGRATION §12).
   - `AGENTS.md:31` — `49 MCP tools over stdio` → `56 MCP tools over stdio`.
   - `SUBMISSION_SUMMARY.md:15,51` — same.
   - `.claude/commands/pcc-identity.md:59` — same.
   - `packages/gateway/src/routes/context-pack.ts:475` — runtime string returned to agents; update to 56.
   - Front door (README) is correct; the deeper docs and the runtime drift makes the agent see "49" the moment it asks the gateway anything.

3. **[SEAM-4, LOW] Fix the `@pcc/store` comment in routes file.**
   - `packages/gateway/src/routes/contributors.ts:5`: "Surfaces the @pcc/store ContributorRepository" → `@pcc/db`.

4. **[SEAM-3, COSMETIC] Friendlier address placeholders.**
   - `docs/CONTRIBUTOR_ECONOMICS.md:127, 144`: `0xYourWallet` → `0x<your-40-hex-wallet>` (or a clearly-fake-but-valid address like `0x0000...0001`) so a copy-paste user gets a sensible 400 message rather than something that looks half-typed.
   - `docs/AGENT_INTEGRATION.md §12.6`: same with `0xMy...Address`.

5. **[NEW NOTE] Whitepaper `219 tools, v2.6.0`.**
   - `apps/dashboard/public/whitepaper.md:1033` says "219 tools, v2.6.0". Branch is on v2.8.0 with 218 tools. Whitepaper is loaded by the dashboard; not in the README's contributor-economics path so a per-doc validator wouldn't catch it, but it's the same kind of stale-after-rename drift. Worth one find/replace pass.
