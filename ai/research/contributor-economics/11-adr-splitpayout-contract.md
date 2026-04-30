# ADR: splitPayout() — MilestoneEscrow Multi-Recipient Settlement

**Agent**: arch-splitpayout-bravo
**Date**: 2026-04-22
**Status**: PROPOSED
**Branch**: feat/contributor-economics
**Pairs with**: ADR from arch-integration-alpha (LicensingEngine extension)

---

## Section 1: Problem Statement

`MilestoneEscrow.release()` (current) routes 100% of the milestone amount to a
single operator address, minus a single flat `protocolFeeBps` to `feeRecipient`.

The contributor-economics requirement is that a single `release()` call must
route funds to N recipients based on a CompositionManifest — covering:
- Operator (ran the job)
- Integrator (adapter/driver author)
- Protocol-author (capability-definition author)
- Model-author (ML model used by the job)
- Dataset-contributors / pilots (training data sources)
- Verifier (attestation service)
- Treasury (protocol)

**Constraints that must be preserved:**
1. Backward compatibility: existing escrows with no manifest continue on the
   legacy single-fee path — zero code change for them.
2. Any token in `tokenForMilestone(milestoneIndex)` must work. The current
   contract uses a single `IERC20 public token`; multi-stablecoin selectors
   are planned for a parallel wave — the design must accommodate both.
3. `nonReentrant` modifier must be preserved across all payout paths.
4. The existing `require(token.transfer(...))` invariant rejects fee-on-transfer
   tokens (enforced implicitly: any token that silently deducts a fee causes
   the balance-check math to break and revert).
5. Per-recipient events must be emitted for observability.
6. Gas: each extra recipient adds approximately 22k gas (cold SLOAD + transfer).
   Worst-case 16 recipients must fit under Base's 30M block gas limit with
   margin; 16-recipient payout is approximately 450k gas — acceptable.

---

## Section 2: Three Design Options

### Option A: Full On-Chain Payout Map (recommended)

The payer calls `setPayoutMap(milestoneIndex, Payout[])` **after** `addMilestone()`
but **before** `fund()`. The map is stored in contract state. `release()` reads it.

```
Payout { recipient, bps, roleTag, ipId }
```

`release()` iterates the map, transfers each recipient their share, gives the
operator the residual (10000 - sum of bps, excluding protocol fee).

**Gas**: ~60k base + 22k/recipient. 5-recipient: ~170k. 16-recipient: ~450k.
**Flexibility**: unlimited role types, any EVM address, arbitrary ordering.
**Upgrade path**: new role types = new roleTag constants. No contract upgrade needed.
**Trust model**: fully trustless. Payer commits on-chain before funding. No off-chain
signature needed. Anyone can verify the split before funding.
**Simplicity**: highest; matches existing CEI + modifier patterns in the contract.

### Option B: Off-Chain Payout Map, Signed at Release

`release()` takes `Payout[] calldata payouts` and a verifier-quorum `bytes signature`
(EIP-712). The contract verifies the signature against the stored milestone data
before distributing.

**Gas**: same as A plus ~3k for ecrecover. Marginal difference.
**Flexibility**: map computed fresh at release time — can incorporate latest
contributor data.
**Upgrade path**: quorum key rotation requires a separate upgrade path.
**Trust model**: shifts trust to the verifier quorum; if quorum key is compromised,
attacker can redirect funds. This is materially worse than A.
**Simplicity**: lowest. Requires EIP-712 domain separator, struct hashing,
ecrecover, nonce management. Audit surface doubles.

### Option C: External Splitter (0xSplits / Drips)

The payer pre-creates a 0xSplits or Drips split contract, stores its address
on the milestone, and `release()` transfers the full amount to the splitter. The
splitter handles distribution.

**Gas**: ~40k for transfer to splitter; each pull from splitter is separate tx.
Cheaper if pulls are batched but distributions are not atomic. Recipients must
claim.
**Flexibility**: 0xSplits supports up to 500 recipients. Very flexible.
**Upgrade path**: payer just creates a new splitter for each escrow.
**Trust model**: adds a dependency on a third-party protocol (0xSplits/Drips).
If that protocol is paused or upgraded, PCC settlements can be bricked.
**Simplicity**: PCC contract is simpler; total system complexity is higher due
to external dependency.

### Recommendation: Option A

Option A is the correct choice for PCC for four reasons:

1. **Trustless**: the payer commits the split on-chain before funding. Any party
   can verify the split by reading `getPayoutMap()` before signing off on the job.
   Option B introduces an off-chain trust assumption; Option C introduces
   third-party protocol risk.

2. **Atomic settlement**: all recipients receive funds in a single `release()` tx.
   Option C requires each recipient to pull from the splitter in a separate tx
   (higher friction, higher total gas, non-atomic).

3. **Matches existing design language**: the contract already stores per-milestone
   state (`Milestone struct`, `disputes` mapping). A `_payoutMap` mapping is
   consistent with this pattern.

4. **No external dependency**: Option C is attractive for its simplicity, but
   adding a dependency on 0xSplits/Drips violates the "no third-party risk in the
   settlement critical path" principle that the existing standalone-mode design
   already enforces via `protocolRoot == address(0)` fallback.

---

## Section 3: Detailed Design — Option A

### New Solidity Interface

```solidity
// ── New struct (add to MilestoneEscrow.sol) ──────────────────────────────

/// @notice A single payment destination in a multi-recipient payout map.
struct Payout {
    address recipient;  // EOA or contract receiving the payment
    uint256 bps;        // Basis points of milestone.amount (out of 10000)
    bytes32 roleTag;    // keccak256 of role name: "integrator", "model-author", etc.
    bytes32 ipId;       // Story Protocol IP Asset ID for audit (bytes32(0) if N/A)
}

// ── New state (add to MilestoneEscrow.sol) ────────────────────────────────

/// @notice Per-milestone payout map. Set by payer before fund().
mapping(uint256 => Payout[]) private _payoutMap;

/// @notice True if a payout map has been set for a milestone.
mapping(uint256 => bool) private _payoutMapSet;

/// @notice Maximum number of payouts per milestone. Admin-tunable (default 16).
uint256 public maxPayouts = 16;

// ── New event ─────────────────────────────────────────────────────────────

event SplitPayoutExecuted(
    uint256 indexed milestoneIndex,
    address indexed recipient,
    bytes32 indexed roleTag,
    bytes32 ipId,
    address token,
    uint256 amount
);

// ── New functions ─────────────────────────────────────────────────────────

/**
 * @notice Set the payout map for a milestone. Must be called before fund().
 * @dev Replaces any prior map (idempotent until funded).
 * @param milestoneIndex Index of the milestone.
 * @param payouts Array of Payout structs. Must satisfy validation rules.
 */
function setPayoutMap(
    uint256 milestoneIndex,
    Payout[] calldata payouts
) external onlyPayer milestoneExists(milestoneIndex);

/**
 * @notice Read the payout map for a milestone.
 * @param milestoneIndex Index of the milestone.
 * @return payouts The stored payout array (empty if unset).
 */
function getPayoutMap(
    uint256 milestoneIndex
) external view returns (Payout[] memory);
```

### Modified `release()` — Full Pseudocode (all invariants enforced)

```solidity
function release(uint256 milestoneIndex)
    external
    nonReentrant
    milestoneExists(milestoneIndex)
{
    Milestone storage m = milestones[milestoneIndex];

    // ── Checks ───────────────────────────────────────────────────────────
    require(m.status == MilestoneStatus.Attested, "Not attested");
    require(block.timestamp >= m.challengeWindowEnd, "Challenge window open");

    // ── Effects (CEI: state mutation before any external call) ────────────
    m.status = MilestoneStatus.Released;

    // Cache immutable values; m is now Released so reentrancy can't exploit
    address operator   = m.operator;
    uint256 amount     = m.amount;
    uint256 bond       = m.operatorBond;
    address tok        = address(token); // single-token; multi-stablecoin wave will pass token per milestone

    emit MilestoneReleased(milestoneIndex, operator, amount);

    // ── Interactions ──────────────────────────────────────────────────────

    if (_payoutMapSet[milestoneIndex]) {
        // ── Split payout path ────────────────────────────────────────────

        Payout[] storage payouts = _payoutMap[milestoneIndex];
        uint256 totalBpsPaid;

        // Protocol fee is deducted first (if protocolRoot set), then the
        // remainder is distributed proportionally to the payout map.
        uint256 protocolFee;
        if (protocolRoot != address(0)) {
            IPCCProtocol root = IPCCProtocol(protocolRoot);
            uint256 feeBps = root.protocolFeeBps();
            protocolFee = (amount * feeBps) / 10000;
            require(token.transfer(root.feeRecipient(), protocolFee), "Protocol fee transfer failed");
            root.collectFee(tok, protocolFee);
        }

        uint256 distributable = amount - protocolFee;

        for (uint256 i = 0; i < payouts.length; i++) {
            Payout memory p = payouts[i];
            uint256 recipientAmount = (distributable * p.bps) / 10000;
            if (recipientAmount == 0) {
                // bps=0 is valid (zero-royalty attribution); skip transfer
                emit SplitPayoutExecuted(milestoneIndex, p.recipient, p.roleTag, p.ipId, tok, 0);
                continue;
            }
            require(token.transfer(p.recipient, recipientAmount), "Split transfer failed");
            emit SplitPayoutExecuted(milestoneIndex, p.recipient, p.roleTag, p.ipId, tok, recipientAmount);
            totalBpsPaid += p.bps;
        }

        // Operator residual: (10000 - totalBpsPaid) / 10000 of distributable
        // plus bond always returned in full
        uint256 residualBps = 10000 - totalBpsPaid;
        uint256 operatorAmount = (distributable * residualBps) / 10000 + bond;
        if (operatorAmount > 0) {
            require(token.transfer(operator, operatorAmount), "Operator residual transfer failed");
            emit SplitPayoutExecuted(
                milestoneIndex, operator,
                keccak256("operator"), bytes32(0), tok, operatorAmount
            );
        }

    } else {
        // ── Legacy single-fee path (unchanged) ───────────────────────────
        if (protocolRoot != address(0)) {
            IPCCProtocol root = IPCCProtocol(protocolRoot);
            uint256 feeBps = root.protocolFeeBps();
            uint256 fee = (amount * feeBps) / 10000;
            address recipient = root.feeRecipient();
            require(token.transfer(recipient, fee), "Fee transfer failed");
            uint256 operatorPayout = amount - fee + bond;
            require(token.transfer(operator, operatorPayout), "Transfer failed");
            root.collectFee(address(token), fee);
        } else {
            require(token.transfer(operator, amount + bond), "Transfer failed");
        }
    }
}
```

**CEI compliance**: `m.status = Released` occurs before all external calls. The
`nonReentrant` modifier raises `_locked` to 2 for the duration. A malicious
recipient that calls `release()` again hits the reentrancy guard first, and even
if it somehow bypassed it, status is already `Released` so the `require(Attested)`
check reverts.

**Bond**: always returned to operator in full, regardless of split path.
Bond is added to the operator residual in the split path and to the operator
payment in the legacy path.

---

## Section 4: Validation Rules for `setPayoutMap()`

```solidity
function setPayoutMap(uint256 milestoneIndex, Payout[] calldata payouts)
    external
    onlyPayer
    milestoneExists(milestoneIndex)
{
    // Rule 1: Map can only be set before funding
    require(
        milestones[milestoneIndex].status == MilestoneStatus.Unfunded,
        "Payout map: milestone already funded"
    );

    // Rule 2: Max payouts cap (gas safety)
    require(payouts.length <= maxPayouts, "Payout map: too many payouts");

    uint256 totalBps;
    for (uint256 i = 0; i < payouts.length; i++) {
        // Rule 3: No zero-address recipients
        require(payouts[i].recipient != address(0), "Payout map: zero recipient");

        // Rule 4: Per-payout bps sanity floor (no one captures >50%)
        require(payouts[i].bps <= 5000, "Payout map: single payout exceeds 50%");

        // Rule 5: No duplicate (recipient, roleTag) pairs
        for (uint256 j = i + 1; j < payouts.length; j++) {
            require(
                !(payouts[j].recipient == payouts[i].recipient &&
                  payouts[j].roleTag   == payouts[i].roleTag),
                "Payout map: duplicate recipient+role"
            );
        }

        totalBps += payouts[i].bps;
    }

    // Rule 6: Sum of bps must leave room for operator residual
    // (operator residual = 10000 - totalBps >= 0)
    require(totalBps <= 10000, "Payout map: bps sum exceeds 10000");

    // Clear any prior map and store new one
    delete _payoutMap[milestoneIndex];
    for (uint256 i = 0; i < payouts.length; i++) {
        _payoutMap[milestoneIndex].push(payouts[i]);
    }
    _payoutMapSet[milestoneIndex] = true;
}
```

**Why bps=0 is allowed**: a contributor may want attribution on-chain (the
`SplitPayoutExecuted` event with `amount=0`) for reputation/transparency without
claiming any monetary share. This is intentional.

**Why not post-fund adjustment**: immutability of the payout map per-milestone
is load-bearing for UX predictability. An operator accepted the job knowing the
split. Changing it post-fund would be a unilateral payer action against a locked
agreement. The correct path is dispute → refund → new escrow.

---

## Section 5: Gas Analysis

| Scenario | Approx Gas |
|---|---|
| Legacy path (no map), no protocol fee | ~45k |
| Legacy path + protocol fee | ~75k |
| Split path, 1 recipient | ~95k |
| Split path, 3 recipients | ~135k |
| Split path, 5 recipients (typical) | ~175k |
| Split path, 10 recipients | ~285k |
| Split path, 16 recipients (max) | ~450k |

Base L2 at 30 gwei: 450k gas ≈ $0.04 (at $2000/ETH). Well inside the
`<$0.10` target from scout research.

The inner duplicate-check loop in `setPayoutMap()` is O(N^2) but only runs at
setup time, not at settlement time. For N=16: 120 comparisons — acceptable.

`maxPayouts` is a public mutable param (governor-controlled in PCCProtocol, or
`onlyPayer` in standalone mode — TBD in implementation wave). Default 16.

---

## Section 6: Migration and Backward Compatibility

Existing deployed escrows: zero change. The `_payoutMapSet` mapping defaults to
`false` for all keys that have never been written; `release()` falls through to
the legacy path.

**New escrow lifecycle with split payout:**
```
addMilestone() → setPayoutMap() → fund() → [operator bond + evidence + attestation] → release()
```

`setPayoutMap()` checks `status == Unfunded`, so it must be called in the window
between `addMilestone()` and `fund()`. The gateway's `/api/escrow/fund` handler
(Wave 3) will optionally call `setPayoutMap()` before `fund()` in a single
batched tx when a CompositionManifest is present.

**Multi-stablecoin readiness**: the current contract has a single `IERC20 public
token`. The `SplitPayoutExecuted` event includes `address token` so it is
structurally ready for a per-milestone token future. When multi-stablecoin
selectors land (`tokenForMilestone(idx)` accessor), `release()` replaces
`address(token)` with that call — the payout map logic is unchanged.

---

## Section 7: Test Plan

New test file: `packages/contracts/test/MilestoneEscrow.splitPayout.t.sol`

Follow the existing pattern: `MockUSDC`, `vm.prank`, `vm.warp`, `vm.expectRevert`.

```
1.  test_setPayoutMap_storesCorrectly()
      — set 3-recipient map; getPayoutMap() returns identical struct array

2.  test_setPayoutMap_revertsWhenSumExceeds10000()
      — payouts with bps [6000, 5000]; expect "bps sum exceeds 10000"

3.  test_setPayoutMap_revertsWhenDuplicateRecipientRole()
      — two payouts with same (recipient, roleTag); expect "duplicate recipient+role"

4.  test_setPayoutMap_revertsWhenMaxPayoutsExceeded()
      — 17-element array; expect "too many payouts"

5.  test_setPayoutMap_revertsWhenMilestoneAlreadyFunded()
      — call setPayoutMap() after fund(); expect "milestone already funded"

6.  test_release_distributesAcrossRecipients()
      — 3-recipient map [2000, 1500, 500]; verify each address received
        correct token balance after release()

7.  test_release_operatorGetsResidual()
      — map totals 4000 bps; operator should receive 60% of distributable
        + full bond returned

8.  test_release_fallbackToLegacyWhenNoMap()
      — release() on milestone with no payout map; operator gets amount - fee
        (matches existing test_fullFlow_noBond exactly)

9.  test_release_worksWithMultiStablecoin()
      — deploy with a second MockERC20; set payout map; confirm each
        recipient receives the correct token (prep for multi-stablecoin wave)

10. test_release_emitsSplitPayoutExecutedPerRecipient()
      — vm.expectEmit for each expected SplitPayoutExecuted event in the loop

11. test_release_rejectsFeeOnTransferTokenForAllRecipients()
      — deploy MockFeeOnTransferToken; all transfers silently deduct 1%;
        require() in release() reverts — no recipient receives partial funds

12. test_release_reentrancyProtection()
      — deploy MaliciousRecipient that calls release() in its receive();
        expect "Reentrant call" on second entry

13. fuzz_release_randomManifests(uint8 n, uint16[16] bpsArr, address[16] recips)
      — n in [1,16]; sum bpsArr[0..n-1] clamped to <=10000; verify total
        token outflow == amount (no rounding dust left in contract)

14. fuzz_release_weirdTokenSemantics(uint8 returnBehavior)
      — MockTokenWithWeirdReturn: returnBehavior 0=false, 1=nothing, 2=true;
        behaviors 0 and 1 should revert, behavior 2 should succeed
```

---

## Section 8: Security Considerations

**Reentrancy**: double-guarded. `nonReentrant` raises `_locked = 2`; CEI
ensures `m.status = Released` before any `token.transfer()`. A malicious
recipient re-entering `release()` hits the reentrancy guard. Even without it,
the Attested-status check would fail. Defense in depth.

**Front-running `setPayoutMap()`**: only `onlyPayer` can set the map. The payer
funds the escrow in the same session, so front-running their own call is not an
attack vector. Operators can inspect `getPayoutMap()` before accepting a job
(before `depositBond()`).

**Malicious recipient contract**: `require(token.transfer(p.recipient, amt))`
uses the `IERC20.transfer()` return value. If a recipient is a contract that
reverts on receipt of the token, the entire `release()` fails. This is the
correct behavior — the payer should not set a non-receivable address in the map.
A governance escape hatch (arbiter override) can be added in v2 if this becomes
a live problem.

**Capturing 100% via bps overflow**: Solidity 0.8.x checked arithmetic prevents
overflow in `totalBps += payouts[i].bps`. The `totalBps <= 10000` check then
catches any attempt to sum to more than 100%.

**Zero-value payouts (bps=0)**: allowed. The recipient receives 0 tokens. The
`SplitPayoutExecuted` event is still emitted, providing attribution. This cannot
be used as a griefing vector because only the `onlyPayer` can set the map.

**Integer dust**: `(distributable * p.bps) / 10000` truncates. Rounding dust
accumulates in the operator residual (the last payout to operator uses the
explicit residual formula rather than another multiplication, so no dust leaks).

**Stale payout map if protocol adds new roles**: each payout map is per-milestone
and immutable after fund(). New protocol roles require a new escrow. This is
correct — it is an invariant, not a bug.

---

## Section 9: Interface with LicensingEngine (TypeScript)

The TypeScript service layer in Wave 3 bridges the off-chain CompositionManifest
to the on-chain `Payout[]`.

```typescript
// packages/contracts/ts/payouts.ts

export interface Payout {
    recipient:  string;   // checksummed EVM address
    bps:        number;   // 0..5000
    roleTag:    string;   // keccak256 hex of role name, e.g. keccak256("integrator")
    ipId:       string;   // Story Protocol IP Asset ID hex, or bytes32(0)
}

export interface BuildPayoutMapInput {
    milestoneIndex:      number;
    jobValue:            bigint;          // milestone.amount in token units
    capabilityIpId:      string;          // Story IP Asset of the capability being executed
    compositionManifest?: CompositionManifest;
    evaluationContext: {
        now:           number;            // unix timestamp
        jobsPerDay:    number;            // adoption metric for RateSchedule
        networkId:     string;            // for treasury address lookup
    };
}

export interface BuildPayoutMapResult {
    payouts:            Payout[];
    operatorResidualBps: number;          // 10000 - sum(payouts[].bps)
    breakdown: {
        recipient:     string;
        role:          string;
        bpsRequested:  number;            // raw from RateSchedule
        bpsApplied:    number;            // after 5000 cap + sum normalization
        amount:        bigint;            // (jobValue * bpsApplied) / 10000
    }[];
}

/**
 * Walk the CompositionManifest DAG, evaluate each contributor's RateSchedule
 * at the given evaluationContext, and produce a Payout[] ready for on-chain
 * setPayoutMap(). Normalizes if sum > 10000 (proportional trim).
 */
export function buildPayoutMap(input: BuildPayoutMapInput): BuildPayoutMapResult;
```

This is the clean handoff point between the LicensingEngine's off-chain royalty
tree walk (arch-integration-alpha's domain) and the on-chain splitPayout
execution (this ADR's domain). The function is stateless and pure — it takes
inputs and returns a Solidity-ready `Payout[]` with no network calls.

The gateway's `/api/escrow/fund` handler calls `buildPayoutMap()`, then submits
two sequential transactions:
1. `setPayoutMap(milestoneIndex, payouts)` — store the map
2. `fund()` — lock funds (status moves to Funded; map is now immutable)

---

## Section 10: Rollout

**Phase 1**: Deploy modified `MilestoneEscrow.sol` to Base Sepolia. New escrows
from `PCCProtocol.createEscrow()` get split-payout capability. Existing on-chain
escrows are unaffected (no state migration needed; their `_payoutMapSet` is
implicitly false).

**Phase 2**: Update `/api/escrow/fund` in the gateway to accept an optional
`compositionManifest` field. When present, call `buildPayoutMap()` → submit
`setPayoutMap()` tx → submit `fund()` tx. When absent, proceed with current
single-fund flow.

**Phase 3**: Dashboard UI. After a payer selects a capability, the UI queries
`getPayoutMap()` (or previews via `buildPayoutMap()` before confirming) and
renders a breakdown: "Your $X payment will route $A to operator, $B to model
author, $C to dataset contributors..."

**Phase 4**: Existing escrows continue on the legacy path indefinitely. The
`protocolFeeBps` single-fee path is never deprecated — it is the default for
standalone deployments and escrows without a manifest.

**Phase 5** (long tail, not in this sprint): Once ≥80% of new escrow volume
uses split payout, add a `splitPayoutOnly` deployment flag to `PCCProtocol` that
makes setPayoutMap mandatory for new escrows. Not before.

---

## Conflicts with arch-integration-alpha

This ADR and the LicensingEngine ADR (arch-integration-alpha) touch a shared
boundary: the `buildPayoutMap()` TypeScript function. Specific coordination
points:

1. **Input type `CompositionManifest`**: arch-integration-alpha owns this type
   definition (it comes from the extended LicensingEngine). This ADR consumes
   it. If the manifest schema changes, `BuildPayoutMapInput` must be updated
   simultaneously.

2. **Role tag constants**: both ADRs need to agree on the canonical set of
   `keccak256` role name strings. Suggested canonical list:
   ```typescript
   export const ROLE_TAGS = {
     OPERATOR:    keccak256("operator"),
     INTEGRATOR:  keccak256("integrator"),
     PROTOCOL_AUTHOR: keccak256("protocol-author"),
     MODEL_AUTHOR:    keccak256("model-author"),
     DATASET_CONTRIBUTOR: keccak256("dataset-contributor"),
     VERIFIER:    keccak256("verifier"),
     TREASURY:    keccak256("treasury"),
   } as const;
   ```
   This list should live in a shared `packages/spec` types file, not in either
   ADR's implementation. Both agents should defer to spec for this.

3. **Protocol fee ordering**: this ADR deducts the protocol fee first, then
   distributes the remainder across the payout map. The LicensingEngine must
   produce bps values that sum to ≤10000 **of the post-protocol-fee amount**,
   not the gross milestone amount. arch-integration-alpha's `buildPayoutMap()`
   call site must pass `jobValue = milestoneAmount - protocolFee` or accept
   that the bps calculation is on gross and the protocol fee is additive on top.
   **Decision needed before Wave 3 implementation**: gross or net basis?
   This ADR assumes **gross** (deduct protocol fee first, distribute remainder)
   for simplicity and auditability — the protocol always gets its share first.

4. **`operatorResidualBps`**: in this ADR, the operator gets `10000 - totalBps`
   of distributable. The LicensingEngine must not include an "operator" entry in
   the payout map (it is implicit). Alternatively, if the LicensingEngine includes
   operator explicitly, `setPayoutMap()` must allow bps=0 for operator (it
   currently does — operator residual is computed from what's left, not from the
   map). Document this convention explicitly in `buildPayoutMap()` JSDoc.
