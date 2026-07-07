# PCC Escrow / Settlement Refund-and-Timeout Audit

AGENT_NAME: auditor-escrow-bravo
Date: 2026-06-22
Status: DONE

---

## HAS / LACKS Ledger (timeout-refund)

| Mechanism | HAS | LACKS |
|---|---|---|
| On-chain challenge window (`challengeWindowSeconds` per milestone) | ✅ per-milestone configurable delay before release | — |
| On-chain auto-refund-on-timeout | — | ❌ No deadline; no `reclaim`/`cancel`/`expire` fn in any version |
| Payer-initiated early reclaim | — | ❌ No function; payer can only dispute during challenge window |
| Arbiter-driven refund path (dispute resolution) | ✅ `resolveDispute(idx, true)` → refund to payer | — |
| V3 payer direct-approval (`approveAndRelease`) | ✅ V3 DRAFT only — payer bypasses oracle | — |
| Off-chain DB `deadline` column | ✅ present in `escrows` table — informational | ❌ no enforcement logic reads it |
| MPP session timeout | ✅ 30-min inactivity auto-close (off-chain, per-session client) | ❌ does NOT touch the on-chain escrow |

---

## Q1 — On-chain states + transitions

**V1 (`MilestoneEscrow.sol`) and V2 (`MilestoneEscrowV2.sol`) share the same `MilestoneStatus` enum** (`packages/contracts/src/MilestoneEscrow.sol:76-86`, same at `MilestoneEscrowV2.sol:94-104`, and V3 `MilestoneEscrowV3.sol:98-108`):

```
Unfunded (0) → Funded (1) → Locked (2) → Evidenced (3) → Attested (4)
  → Released (5)   [normal path: release() after challenge window]
  → Disputed (6)   [fileDispute() during challenge window]
  → Refunded (7)   [resolveDispute(idx, true): challenger won]
  → Slashed (8)    [resolveDispute(idx, false): operator bond slashed]
```

Transition map:
- `fund()` → all milestones `Unfunded` → `Funded` (`MilestoneEscrowV2.sol:762-767`)
- `depositBond()` → `Funded` → `Locked` (`MilestoneEscrowV2.sol:799`)
- `submitEvidence()` → `Locked` or (`Funded` with zero bond) → `Evidenced` (`MilestoneEscrowV2.sol:820`)
- `submitAttestation()` → `Evidenced` → `Attested`, sets `challengeWindowEnd` (`MilestoneEscrowV2.sol:902-904`)
- `release()` → `Attested` (+ `block.timestamp >= challengeWindowEnd`) → `Released` (`MilestoneEscrowV2.sol:946`)
- `fileDispute()` → `Attested` (+ within challenge window) → `Disputed` (`MilestoneEscrowV2.sol:1106`)
- `resolveDispute(idx, true)` → `Disputed` → **`Slashed`** (status) + refund to `payer` (`MilestoneEscrowV2.sol:1139,1143`)
- `resolveDispute(idx, false)` → `Disputed` → **`Released`** (status) + pay operator (`MilestoneEscrowV2.sol:1146,1150`)

**`EscrowSummaryDTO.status`** (`packages/gateway/src/facades/types.ts:320-330`) maps DB values; the DB schema (`packages/db/src/schema/settlement.ts:7`) uses: `"created" | "funded" | "active" | "completing" | "completed" | "disputed" | "refunded"`. These are off-chain labels that mirror, but are not guaranteed in sync with, the on-chain enum.

V3 adds a fourth path: `approveAndRelease(idx)` → `Evidenced` or `Attested` → `Released`, callable only by `payer` with no oracle and no fee (`MilestoneEscrowV3.sol:839-867`).

---

## Q2 — Auto-refund-on-timeout TODAY (THE question)

**DEFINITIVE ANSWER: There is NO auto-refund-on-timeout mechanism in any deployed contract (V1 or V2).**

Specific findings across all three versions:

- `MilestoneEscrow.sol` (V1): searched all 1045 lines — no `cancel`, `reclaim`, `expire`, or deadline-based function exists. The only refund path is `resolveDispute` with `_challengerWon = true`.
- `MilestoneEscrowV2.sol` (V2, DEPLOYED): searched all 1168 lines — same result. No deadline timestamp on the escrow. `challengeWindowEnd` exists only on `Milestone` structs; it gates `release()` (must be after) and `fileDispute()` (must be before). It does not gate any refund.
- `MilestoneEscrowV3.sol` (V3, DRAFT — not deployed): same. No auto-refund mechanism added.

If a physical job hangs forever:
- The milestone stays in `Locked` (operator deposited bond) or `Funded` (no bond) — forever.
- The payer **cannot reclaim** without either (a) the operator submitting fraudulent evidence and losing a dispute, or (b) both parties agreeing off-chain and the arbiter manually calling `resolveDispute(idx, true)` — which requires a prior `fileDispute()` call during a challenge window that never opened.
- If no evidence is ever submitted → no challenge window ever opens → `fileDispute()` cannot be called (`require(m.status == MilestoneStatus.Attested, "Cannot dispute")` at `MilestoneEscrowV2.sol:1088`) → **funds are permanently locked**.

The off-chain DB has a `deadline` column (`packages/db/src/schema/settlement.ts:13`) and seed data shows values like `"2026-03-20T00:00:00Z"` (`packages/db/src/seed/escrow.ts:21`), but there is no gateway service, cron job, or event listener that reads `deadline` and triggers any on-chain action. It is a metadata field only.

---

## Q3 — `challengeWindowEnd`: where set, duration, gating

**Where set**: `submitAttestation()` sets `m.challengeWindowEnd = block.timestamp + m.challengeWindowSeconds` at:
- V1: `MilestoneEscrow.sol:738`
- V2: `MilestoneEscrowV2.sol:902`
- V3: `MilestoneEscrowV3.sol:755`

**Duration**: `challengeWindowSeconds` is a **per-milestone parameter** set by the payer at `addMilestone()` time (`MilestoneEscrowV2.sol:556`). There is no protocol-level default or minimum. The value is set to whatever the payer specified and stored on the `Milestone` struct. Seed data shows 1-hour windows (`packages/db/src/seed/escrow.ts:72-74`).

**Gating**:
- `release()` requires `block.timestamp >= m.challengeWindowEnd` → window must have CLOSED (`MilestoneEscrowV2.sol:943`)
- `fileDispute()` requires `block.timestamp < m.challengeWindowEnd` → window must still be OPEN (`MilestoneEscrowV2.sol:1089`)

`EscrowSummaryDTO.challengeWindowEnd` is surfaced as `Timestamp` (`packages/gateway/src/facades/types.ts:329`) from the DB milestone column (`packages/db/src/schema/settlement.ts:26`).

---

## Q4 — Dispute: how filed, who resolves, outcome paths

**How filed**: On-chain via `fileDispute(milestoneIndex, challengerBond, challengerEvidenceHash, reason)` — callable by anyone (no role restriction beyond `_effectiveSender()`) during the challenge window. Requires depositing a `challengerBond > 0` in the same token as the milestone (`MilestoneEscrowV2.sol:1080-1108`).

Off-chain: gateway route `POST /api/escrow/chain/:address/dispute/:milestoneIndex` wraps this via the `fileDisputeActivity` workflow activity (`packages/gateway/src/routes/escrow.ts:334-359`).

**Who resolves**: Only the `arbiter` address set at escrow initialization can call `resolveDispute(milestoneIndex, _challengerWon)` (`MilestoneEscrowV2.sol:1113`, `onlyArbiter` modifier at line 329). The arbiter is set immutably per-escrow in `initialize()`. There is no on-chain governance to change the arbiter post-deployment.

**Outcome paths** (both in V1 and V2 at `MilestoneEscrowV2.sol:1138-1153`):
1. `_challengerWon = true` → `m.status = Slashed` (8); milestone amount → `payer`; `challengerBond + operatorBond` → challenger. Operator bond is slashed.
2. `_challengerWon = false` → `m.status = Released` (5); `milestoneAmount + operatorBond + challengerBond` → operator. Challenger bond is slashed.

No split outcome (e.g. partial refund) is implemented.

---

## Q5 — MPP session timeout: the closest RTP analog

`MppSessionManager` in `packages/payments/src/mpp-session.ts` wraps mppx session-based payment channels. Key behavior:

- **Default timeout**: 30 minutes idle (`packages/payments/src/mpp-session.ts:87`): `const timeoutMs = config.timeoutMs ?? 30 * 60 * 1000`
- **Mechanism**: `startTimeout()` at line 146 sets a `setTimeout` that calls `this.close()` after `timeoutMs` of inactivity. Each `fetch()` call resets the timer via `resetTimeout()` (line 116-118).
- **Effect of close**: `close()` at line 125 sets `_closed = true` and calls `clearTimeout()`. The comment says "mppx handles channel close when the client is garbage collected or when the server-side session timeout fires" — it is a **soft close on the client side**, not an on-chain transaction.
- **Does NOT touch the on-chain escrow**: The MPP channel is a payment channel layer (via `mppx` library's `session()` method); it is separate from the `MilestoneEscrow` contract. When the MPP session closes, the `MilestoneEscrow` status is unchanged.
- **Config param**: `MppSessionManagerConfig.timeoutMs` allows override per session. Zero or negative value skips the timeout entirely (line 145: `if (this.timeoutMs <= 0) return`).

This is the **nearest analog to RTP's `timeout_seconds`**: it caps per-session channel lifetime off-chain. It is the design pattern to reference for a new "auto-refund-on-timeout" mechanism — but it would need an on-chain counterpart (or an off-chain arbiter relay) to actually unlock escrowed funds.

---

## Q6 — V2 → V3 delta relevant to timeout/refund

**V1 → V2 delta** (relevant only):
- V2 replaces the `authorizedVerifiers` EOA allowlist with EAS on-chain attestation (`MilestoneEscrowV2.sol:11-59`). No timeout/refund change.
- V2 adds `requiredTier`, `jobIdHash`, `verifierAttestationUid` to `Milestone` struct. No timeout/refund change.
- V2 adds EIP-1167 clone factory (`PCCProtocolV2`). No timeout/refund change.
- **No new refund path. No deadline. No timeout.**

**V2 → V3 delta** (relevant only):
- V3 adds `attestedFeeBps` + `attestedFeeRecipient` decoded from EAS attestation payload (`MilestoneEscrowV3.sol:113-134`). Fee-from-attestation, not from root.
- V3 adds **`approveAndRelease(uint256 idx)`** (`MilestoneEscrowV3.sol:839-867`): payer can directly release a milestone in `Evidenced` or `Attested` state without oracle. This is a trust shortcut, NOT an auto-refund. No challenge window, no fee, full payment to operator.
- V3 is DRAFT — `NOT DEPLOYED` (`MilestoneEscrowV3.sol:13`). Live contract is V2.
- **No auto-refund path added in V3 either.**

**Which contract to target for a new "auto-refund-on-timeout"**:
- V2 is deployed and live. Any new timeout/refund mechanism should be designed for **V4** (next iteration), because:
  - V2's `escrowImplementation` is baked into `PCCProtocolV2` and cannot be swapped.
  - V3 is DRAFT and not yet deployed — it could be the vehicle if the draft is extended before deployment.
  - Realistically: add a `reclaimAfterDeadline(uint256 milestoneIndex)` function gated by `onlyPayer` + `block.timestamp > deadline` where `deadline` is a new per-escrow or per-milestone field set at initialization. The existing `MilestoneStatus.Refunded` (value 7) and `MilestoneRefunded` event are already defined and waiting for this path.

---

## Protocol Fee (2.35%)

Set at `PCCProtocolV2.sol:209`: `protocolFeeBps = _initialFeeBps` (235 bps = 2.35%). Bounded `[FEE_BPS_MIN=10, FEE_BPS_MAX=500]` (`PCCProtocolV2.sol:54-55`). Governor can adjust via `setProtocolFeeBps()`. The fee recipient is immutable (`feeRecipient` is `immutable` at `PCCProtocolV2.sol:61`). In V3, fee bps is read from the EAS attestation payload instead (capped at `MAX_FEE_BPS = 1000`, 10% ceiling, `MilestoneEscrowV3.sol:230`).

---

## Key file:line citations

| Claim | File:Line |
|---|---|
| `MilestoneStatus` enum (V1=V2=V3) | `MilestoneEscrowV2.sol:94-104` |
| `Milestone.challengeWindowEnd` field | `MilestoneEscrowV2.sol:124` |
| `challengeWindowEnd` set in `submitAttestation` | `MilestoneEscrowV2.sol:902` |
| `release()` gate: challenge window closed | `MilestoneEscrowV2.sol:943` |
| `fileDispute()` gate: challenge window open | `MilestoneEscrowV2.sol:1089` |
| `resolveDispute()` → refund to payer | `MilestoneEscrowV2.sol:1143` |
| `resolveDispute()` → release to operator | `MilestoneEscrowV2.sol:1150` |
| `MilestoneStatus.Refunded` defined | `MilestoneEscrowV2.sol:103` |
| `MilestoneRefunded` event defined (unused) | `MilestoneEscrowV2.sol:265` |
| Off-chain DB `deadline` column | `packages/db/src/schema/settlement.ts:13` |
| `deadline` = informational only (no enforcement) | `packages/db/src/seed/escrow.ts:21` |
| MPP session `timeoutMs` default 30 min | `packages/payments/src/mpp-session.ts:87` |
| MPP `startTimeout()` → soft close only | `packages/payments/src/mpp-session.ts:145-152` |
| V3 `approveAndRelease()` (payer direct, no refund) | `MilestoneEscrowV3.sol:839` |
| V3 DRAFT — not deployed | `MilestoneEscrowV3.sol:13` |
| Protocol fee 235 bps | `PCCProtocolV2.sol:209` |
| Fee bounds [10, 500] | `PCCProtocolV2.sol:54-55` |
| V3 MAX_FEE_BPS = 1000 | `MilestoneEscrowV3.sol:230` |
