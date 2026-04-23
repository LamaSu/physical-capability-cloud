# Target State: splitPayout() Escrow Architecture

**Agent**: arch-splitpayout-bravo
**Date**: 2026-04-22
**System slug**: splitpayout-escrow
**Full ADR**: ai/research/contributor-economics/11-adr-splitpayout-contract.md

---

## Context Map

**Bounded contexts and relationships:**

```
[Payer / Gateway]           upstream
        |
        | setPayoutMap() + fund()
        v
[MilestoneEscrow]           owns: _payoutMap, Milestone[], Dispute[]
        |  \
        |   \── calls → [PCCProtocol]    (fee read + collectFee accounting)
        |
        | release() distributes to:
        v
[Payout Recipients]         downstream: operator, integrator, model-author,
                            dataset-contributor, verifier, treasury
```

**Anticorruption layer**: `buildPayoutMap()` (TypeScript) translates
CompositionManifest (LicensingEngine domain) into Solidity `Payout[]`
(escrow domain). Neither domain sees the other's internal types.

---

## Service Decomposition

| Component | Owns | API surface |
|---|---|---|
| `MilestoneEscrow.sol` | `_payoutMap`, `_payoutMapSet`, `maxPayouts` | `setPayoutMap()`, `getPayoutMap()`, modified `release()` |
| `packages/contracts/ts/payouts.ts` | payout computation logic | `buildPayoutMap(input): BuildPayoutMapResult` |
| `PCCProtocol.sol` | `protocolFeeBps`, `feeRecipient` | read-only from escrow; `collectFee()` accounting |
| `/api/escrow/fund` (gateway) | orchestration | accepts optional `compositionManifest`; calls setPayoutMap+fund |

---

## Event Flows

```
release(milestoneIndex)
  → [split path] SplitPayoutExecuted × N  (per recipient)
  → MilestoneReleased                       (existing)
  → [legacy path] MilestoneReleased only    (no change)
```

Each `SplitPayoutExecuted` carries: `milestoneIndex`, `recipient`, `roleTag`,
`ipId`, `token`, `amount` — sufficient for off-chain attribution indexing.

---

## API Specifications

**Solidity:**
```solidity
struct Payout { address recipient; uint256 bps; bytes32 roleTag; bytes32 ipId; }
event SplitPayoutExecuted(uint256 indexed milestoneIndex, address indexed recipient,
    bytes32 indexed roleTag, bytes32 ipId, address token, uint256 amount);
function setPayoutMap(uint256 milestoneIndex, Payout[] calldata payouts) external onlyPayer;
function getPayoutMap(uint256 milestoneIndex) external view returns (Payout[] memory);
```

**TypeScript:**
```typescript
function buildPayoutMap(input: BuildPayoutMapInput): BuildPayoutMapResult
// Input: milestoneIndex, jobValue, capabilityIpId, compositionManifest?, evaluationContext
// Output: payouts[], operatorResidualBps, breakdown[]
```

---

## Data Architecture

`_payoutMap`: `mapping(uint256 => Payout[])` — per-milestone, written once
(before fund()), immutable after. Gas cost for 16-payout map: ~120k write,
~60k read in release().

No off-chain DB table needed for the map itself — it is the source of truth.
The gateway may cache it for UI display but always reads from chain for settlement.

---

## Resilience Strategy

| Hop | Timeout | Retry | Circuit breaker |
|---|---|---|---|
| setPayoutMap() tx | 60s (user-facing) | 1 retry on gas underestimate | N/A (idempotent) |
| fund() tx | 60s | 1 retry | N/A |
| release() tx | 120s | 0 (nonReentrant; retry safe only after revert) | N/A |
| collectFee() callback | inline in release() | no retry — release() reverts on failure | Fallback: deploy with protocolRoot=0 |

Malicious recipient reverting on `token.transfer()` blocks the entire `release()`.
Mitigation: validate recipient addresses off-chain in `buildPayoutMap()` before
submitting `setPayoutMap()`. Arbiter can resolve via dispute if escrow is stuck.

---

## Observability Plan

- `SplitPayoutExecuted` events indexed by The Graph subgraph (existing PCC subgraph
  extended with new event handler).
- `roleTag` enables per-role revenue dashboards without additional on-chain state.
- `ipId` enables cross-referencing with Story Protocol royalty vault for attribution.
- SLO: `release()` tx confirmation within 30s on Base (target p95). Alert if >60s.

---

## Migration Sequencing

1. Deploy modified `MilestoneEscrow.sol` to Base Sepolia — backward compat,
   no existing escrow changes. (Wave 3, day 1)
2. Deploy updated `PCCProtocol` factory pointing to new escrow bytecode. (Wave 3, day 1)
3. `buildPayoutMap()` TypeScript + gateway `/api/escrow/fund` update. (Wave 3, day 2)
4. Dashboard split preview UI. (Wave 4)
5. Hand off execution sequencing to legacy-modernizer for migration of any
   existing Base Sepolia escrow contracts (none in production yet — clean slate).
