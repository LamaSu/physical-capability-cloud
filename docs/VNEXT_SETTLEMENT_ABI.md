# V-next settlement ABI: the frozen contract for compilers

**Status: FROZEN.** This is the byte-level contract between the V-next settlement contracts (`VNextSettlementEscrow`, `VNextSettlementEscrowFactory`, `VNextSettlementLib`) and every off-chain compiler that builds a job for them: the composition compiler (`compileAcceptedPlan`), the economics compiler, wallets and agents.

**Frozen at:** `master` `ac86a404`. The V-next contracts have not changed since 2026-09-09.

**Owner:** the escrow lane.

**Enforced by:**

- `packages/contracts/test/VNextAbiFreeze.t.sol` (forge). It checks every value below against the real contracts, end to end.
- `packages/contracts/ts/__tests__/vnext-compiler.test.ts` (vitest). It checks the same values against the public TypeScript compiler in `@pcc/contracts/vnext`.

Both tests assert the *same literals*. An independent implementation computed those literals from this document alone, without reading the Solidity. So the contracts, the TS compiler and this document agree byte for byte.

**Use the compiler; do not re-encode.** `@pcc/contracts/vnext` exports:
- `compileVNextPolicy`: the whole of §3 in one call. It fails closed on every §5 rule.
- `buildUnitConfig` and `computeFee`: one unit, with the escrow's fee rule and exact conservation.
- The individual hashes of §3 and §4.
- The typed data for signing.
- The frozen ABI subset.
- `VNEXT_GOLDEN`.
A second encoder is a second chance to drift.

**Changing anything here is a cross-lane re-pin.** It moves escrow addresses, invalidates every acceptance signature, and fails both suites. See [§9](#9-change-control).

---

## 0. Encoding conventions

- **Hash:** `keccak256` is Ethereum's Keccak-256 (the original Keccak padding). It is **not** NIST SHA3-256.
- **`abi.encode`:** standard Solidity ABI encoding (head/tail), never `abi.encodePacked`. The only packed preimages are the EIP-1167 creation code and the CREATE2 address (§3 step 3) and the EIP-712 digest (§3 step 8). All three are spelled out byte by byte.
  - Static words: `uint*` values are left-padded to 32 bytes. An `address` is 12 zero bytes followed by its 20 bytes. A `bytes32` is used as is.
  - **`abi.encode(x)` of a single dynamic value starts with the offset word `0x20`.** It is the encoding of a one-element parameter tuple. viem's `encodeAbiParameters([{ type }], [x])` produces the same bytes. Hashing the bare tuple-array encoding without that leading word gives a different root.
- **Addresses:** write them all-lowercase or as valid EIP-55 checksums. viem, and the TS compiler, refuse mixed case with a bad checksum.
- **Integers are exact and unsigned.** Use `bigint` in TypeScript. `milestoneIndex`, `g`, `f`, `n` and `reclaimAt` are `uint256`. A JS `number` silently corrupts values above 2^53, and the golden vector deliberately uses such a value.
- **Order is money-significant.** The order of the `UnitConfig[]` array is the funding order. It is hashed into `prePolicyRoot` and `unitsRoot`, so two orders of the same units are two different policies at two different addresses.

## 1. Constants

| Name | Definition |
|---|---|
| `SETTLEMENT_UNIT_DOMAIN` | `keccak256("PCC:vnext:settlement-unit:v1")` |
| `POLICY_SALT_DOMAIN` | `keccak256("PCC:vnext:policy-salt:v2")` |
| `POLICY_NONCE_DOMAIN` | `keccak256("PCC:vnext:policy-nonce:v1")` |
| `EVIDENCE_COMMITMENT_DOMAIN` | `keccak256("PCC:vnext:evidence-commitment:v1")` |
| `EIP712_DOMAIN_TYPEHASH` | `keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")` |
| `EIP712_NAME_HASH` | `keccak256("VNextSettlementEscrow")` |
| `EIP712_VERSION_HASH` | `keccak256("1")` |
| `JOB_POLICY_TYPEHASH` | `keccak256("JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,uint256 expiry,bytes32 acceptedPolicyDigest)")` |
| `POLICY_VERSION` | `2` (`uint256`) |
| `DOMAIN_VERSION_V1` | `1` (`uint8`) |
| `FEE_BASIS_GROSS` | `0` (`uint8`) |
| `ROUNDING_FLOOR` | `0` (`uint8`) |
| `FEE_DENOMINATOR` | `10000` |
| `MAX_FEE_BPS` | `1000` (10%) |
| `MIN_BONDABLE_GROSS` | `5` (the smallest legal `g`) |
| `MAX_SETTLEMENT_UNITS` | `16` |
| `MAX_PAYOUT_LEGS_PER_UNIT` | `16` |
| `MAX_TOTAL_LEGS_PER_JOB` | `256` (payout entries only) |
| `MIN_RECLAIM_DELAY` | `864000` s (10 days = challenge 2 d + appeal 5 d + backup 2 d + 1 d) |
| `MAX_RECLAIM_DELAY` | `31536000` s (365 days) |
| `MAX_SIGNATURE_BYTES` | `1024` |
| `MAX_CONFIG_BYTES` | `26372` (complete `fund()` calldata, selector included) |
| `EVIDENCE_PACKAGE_FORMAT_V1` | `1` (`uint8`) |

The string preimages are ASCII, hashed as raw bytes, with no length prefix and no terminator.

## 2. Structs

Field order and types are exact. The ABI tuple type is given for each.

**`PayoutEntry`**: `(address recipient, uint256 amount)`. Tuple type `(address,uint256)`.

**`UnitConfig`**: the funding input for one settlement unit. It is 13 fields, and its tuple type is `(uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])`.

| # | Field | Type | Rule |
|---|---|---|---|
| 1 | `milestoneIndex` | `uint256` | any; `(milestoneIndex, stepId)` must be unique within the job |
| 2 | `stepId` | `bytes32` | any |
| 3 | `requiredTier` | `uint8` | `<= 3` |
| 4 | `requestedTier` | `uint8` | `== requiredTier` |
| 5 | `g` | `uint256` | gross; `5 <= g <= 2^128 - 1` |
| 6 | `f` | `uint256` | fee; `== floor(g * feeBps / 10000)` |
| 7 | `n` | `uint256` | net; `== g - f`, `> 0` |
| 8 | `feeBps` | `uint16` | `<= 1000` |
| 9 | `feeRecipient` | `address` | `feeBps > 0`: an allowed recipient (§5). `feeBps == 0`: `f == 0` and `feeRecipient == 0x0` |
| 10 | `reclaimAt` | `uint256` | absolute unix time; `MIN_RECLAIM_DELAY <= reclaimAt - fundingTime <= MAX_RECLAIM_DELAY` |
| 11 | `compositionSchemaVersion` | `uint16` | any (0 = not composed); stored, never interpreted |
| 12 | `compositionRoot` | `bytes32` | any; stored, and equality-checked against the O5 echo at release |
| 13 | `payouts` | `PayoutEntry[]` | 1 to 16 legs; each `amount > 0`; each recipient allowed (§5); **`Σ amount == n` exactly** |

**`PolicyIdentity`**: what the CREATE2 salt commits to and what a clone is initialized with. Tuple type `(address,address,bytes32,bytes32,uint256,bytes32,bytes32)`.

| # | Field | Type |
|---|---|---|
| 1 | `payer` | `address` (nonzero) |
| 2 | `operator` | `address` (an allowed recipient, and `!= payer`) |
| 3 | `jobIdHash` | `bytes32` |
| 4 | `termsHash` | `bytes32` (the escrow stores it and never decodes it) |
| 5 | `policyNonce` | `uint256` |
| 6 | `prePolicyRoot` | `bytes32` (§3 step 1) |
| 7 | `acceptedPolicyDigest` | `bytes32` (the escrow stores it and never decodes it; zero is legal) |

**`PolicyAcceptance`**: `(uint256 expiry, bytes payerSignature, bytes operatorSignature)`. Tuple type `(uint256,bytes,bytes)`.

**`FeeSchedule`**: *derived on-chain at funding, never supplied.* It has 13 fields: `(uint8 domainVersion, uint256 chainId, address escrow, bytes32 settlementUnitId, uint8 feeBasis, uint256 g, uint256 f, uint256 n, uint16 feeBps, uint256 denominator, uint8 roundingRule, address feeRecipient, bytes32 feeSplitConfigHash)`.

## 3. The compile sequence

This is the only supported order. It is what breaks the circular dependency between the escrow's address and the unit ids. Inputs: `chainId`, `factory`, `implementation` (= `factory.implementation()`), the `PolicyIdentity` fields other than `prePolicyRoot`, `expiry`, and the ordered `UnitConfig[]`.

1. **`prePolicyRoot = keccak256(abi.encode(UnitConfig[] configs))`.** The ABI type is `(uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[]`. Note the leading `0x20` word (§0). This root does not depend on the escrow's address.
2. **`salt = keccak256(abi.encode(bytes32 POLICY_SALT_DOMAIN, address payer, address operator, bytes32 jobIdHash, bytes32 termsHash, uint256 policyNonce, bytes32 prePolicyRoot, bytes32 acceptedPolicyDigest))`.** Eight static words.
3. **`escrow`**: CREATE2 of an EIP-1167 minimal proxy:
   - `initCode` = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73` ‖ `implementation` (20 bytes) ‖ `0x5af43d82803e903d91602b57fd5bf3` (55 bytes in total)
   - `escrow` = the last 20 bytes of `keccak256(0xff ‖ factory (20 bytes) ‖ salt (32 bytes) ‖ keccak256(initCode))`
4. **`settlementUnitId_i = keccak256(abi.encode(bytes32 SETTLEMENT_UNIT_DOMAIN, uint256 chainId, address escrow, bytes32 jobIdHash, uint256 milestoneIndex_i, bytes32 stepId_i))`** for each unit. The ids must be pairwise distinct.
5. **`unitsRoot`**: `r = 0x00…00`, then for each unit in array order, `r = keccak256(abi.encode(bytes32 r, bytes32 settlementUnitId_i))`.
6. **`jobPolicyHash`** (the EIP-712 struct hash): `keccak256(abi.encode(bytes32 JOB_POLICY_TYPEHASH, uint256 chainId, address factory, address implementation, address escrow, uint256 2, address payer, address operator, bytes32 jobIdHash, bytes32 termsHash, uint256 policyNonce, bytes32 prePolicyRoot, bytes32 unitsRoot, uint256 expiry, bytes32 acceptedPolicyDigest))`. Fifteen static words.
7. **`domainSeparator = keccak256(abi.encode(bytes32 EIP712_DOMAIN_TYPEHASH, bytes32 EIP712_NAME_HASH, bytes32 EIP712_VERSION_HASH, uint256 chainId, address escrow))`.** `verifyingContract` is the *escrow clone*, not the factory.
8. **`digest = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ jobPolicyHash)`**, a 66-byte preimage. This is standard EIP-712 with the domain `{name: "VNextSettlementEscrow", version: "1", chainId, verifyingContract: escrow}` and primary type `JobPolicy`, so `hashTypedData` gives the same digest.
   - **The operator always signs it.**
   - **The payer signs it** unless the payer sends `fund()` itself.
   - An EOA signature is 65 bytes, `r ‖ s ‖ v`, with `v ∈ {27, 28}` and `s <= secp256k1n / 2`. A contract account validates through ERC-1271, with the clone as the caller.

Then, on-chain:

1. `factory.createEscrow(identity)` deploys the clone at `escrow`. Anyone may call it, and it is harmless to call it early.
2. The payer approves the escrow address for `Σ g` of the settlement token. The address is known before the clone exists.
3. `escrow.fund(configs, acceptance)`, sent by the payer or by any relayer, recomputes `prePolicyRoot` (and reverts `PolicyRootMismatch` if it differs), the unit ids, `unitsRoot` and the digest. It verifies both signatures, consumes the policy nonce, and pulls exactly `Σ g` from the payer.

**`policyKey = keccak256(abi.encode(bytes32 POLICY_NONCE_DOMAIN, address payer, address operator, bytes32 jobIdHash))`** is the scope of `policyNonceFloor` and `fundedEscrowOf`. Only one policy generation per job can ever be funded.

## 4. Values the escrow derives at funding

The escrow computes these itself. A compiler mirrors them to display, verify and index. Read them back with `feeScheduleHashOf(unitId)` and `unitTerms(unitId)`.

- **`feeScheduleHash_i = keccak256(abi.encode(uint8 1, uint256 chainId, address escrow, bytes32 settlementUnitId_i, uint8 0, uint256 g, uint256 f, uint256 n, uint16 feeBps, uint256 10000, uint8 0, address feeRecipient, bytes32 0x00…00))`.** Thirteen static words.
- **`payoutConfigHash_i = keccak256(abi.encode(bytes32 settlementUnitId_i, (address,uint256)[] payouts_i))`.** The head is `settlementUnitId_i` followed by the offset `0x40`. The tail is the length followed by the entries.
- **`claimId = keccak256(abi.encode(uint256 chainId, address escrow, bytes32 settlementUnitId, uint256 legIndex, uint8 claimClass))`.**
  - `claimClass`: `PRINCIPAL` 0, `FEE` 1, `REFUND` 2, `BOND` 3, `DELAY_COMP` 4, `BURN` 5.
  - `legIndex`: `PRINCIPAL` uses the payout entry's index `j`. The others use fixed values: `FEE` `2^256-1`, `REFUND` `2^256-2`, `BOND` `2^256-3`, `DELAY_COMP` `2^256-4`, `BURN` `2^256-5`.
- **`evidenceCommitment = keccak256(abi.encode(bytes32 EVIDENCE_COMMITMENT_DOMAIN, uint256 chainId, address escrow, bytes32 settlementUnitId, uint16 compositionSchemaVersion, uint8 packageFormat, bytes32 packageDigest))`.** Seven static words.
  - **`packageFormat` is always `1`** (`EVIDENCE_PACKAGE_FORMAT_V1`). It is the escrow's own commitment-layout label, and `submitEvidence` hardcodes it, so no caller chooses it. It is **not** the evidence package's format. A FinalMilestonePackageV2, whose body says `packageFormat: "2"`, is still committed with label `1`. The body's own format is inside `packageDigest`'s preimage, so the digest already binds it.
  - An off-chain mirror that uses the body's format produces a commitment the escrow never stores, and every release then reverts `EvidenceBundleMismatch`.

## 5. Funding rules

A compiler **must fail closed** on every one of these. Each is a `fund()` or `initialize()` revert, so a config that breaks one is a job that can never be funded.

- **Unit count:** `1 <= configs.length <= 16`. The total number of payout legs across the job is `<= 256`. That total can never be exceeded while the per-unit caps hold (16 × 16), but the escrow checks it anyway.
- **Per unit:**
  - Every `UnitConfig` rule in §2.
  - The fee is exactly `f = floor(g * feeBps / 10000)` and `n = g - f`, with no other rounding.
  - The payouts **conserve exactly**: `Σ payouts[j].amount == n`. Over-allocation and under-allocation both revert `PayoutSumMismatch`, including a difference of 1 base unit.
  - Unit ids are unique (`DuplicateUnit`).
- **Allowed recipient:** not `0x0`, not the escrow clone, not the settlement token, not the factory. This applies to every payout recipient, to the fee recipient when `feeBps > 0`, and to the operator. The payer and the operator *may* be payout recipients.
- **Parties:** the payer is nonzero, and `operator != payer`.
- **Acceptance:**
  - `block.timestamp <= expiry`.
  - Each signature is `<= 1024` bytes.
  - `policyNonce >= policyNonceFloor[policyKey]`.
  - No escrow has already been funded for `policyKey`.
- **Calldata:** the complete `fund()` calldata is `<= 26372` bytes. Any config inside the limits above, with signatures of at most 1024 bytes, fits by construction. `encodeFundCalldata` checks it anyway.

## 6. Unit states: settled vs refunded

`unitState(unitId)` returns one of the **nine** states 1–9.
- `0` (`AWAITING_FUNDING`) is the enum's zero value and is never returned: an unfunded or unknown unit id reverts `UnitNotFound()`, and `fund()` writes state 1 in the same transaction that makes the unit exist. **Treat an observed 0 as a read error.**

The money meaning of each state:

| # | State | Money meaning |
|---|---|---|
| 0 | `AWAITING_FUNDING` | never returned (see above) |
| 1 | `FUNDED_ACTIVE` | `G` is committed; no outcome yet |
| 2 | `PRIMARY_ASSERTED` | a primary verdict was accepted, and its challenge window opened at acceptance. The unit stays here after the window closes, until `finalize` or a challenge moves it |
| 3 | `CHALLENGED` | a bonded challenge is open, and the appeal window opened with it. The unit stays here until `finalize` or an escalation moves it; an open emergency caps the window |
| 4 | `BACKUP_PENDING` | the primary lane closed; the backup cohort may assert |
| 5 | `BACKUP_ASSERTED` | a backup verdict was accepted, and its challenge window opened at acceptance. The unit stays here until `finalize` or a challenge moves it |
| 6 | `RELEASE_ALLOCATED` | **release decided, payment not complete**: at least one *job* leg could not be pushed and is an outstanding claim; other legs may already be paid |
| 7 | `REFUND_ALLOCATED` | **refund decided, nothing refunded yet**: the single refund leg (all of `G`) is an outstanding claim |
| 8 | `SETTLED_RELEASED` | **released**: every principal leg has been paid, and the fee leg when `F > 0` |
| 9 | `SETTLED_REFUNDED` | **refunded**: `G` has been paid to the payer |

- States 1–5 are *live*: money is committed and nothing has been allocated yet.
- The first allocation takes the unit to 6 or 7 **exactly once**. Every later release or refund attempt on that unit is refused. Usually the revert is `NotActive()`, but `resolveEscalation` can revert `NoEmergency()` or `BadEscalationRole()` before its state check. Treat a unit in state 6–9 as "the outcome already happened", whoever caused it. Never treat a revert reason as that signal.
- When every leg pays in the allocating transaction, 6 or 7 becomes 8 or 9 in that same transaction. Otherwise `dischargeClaim` pays the outstanding claims, and the last one moves the unit to 8 or 9.
- *Allocated* is not *settled*: "decided" and "paid" are different states.
- Bond-family claims (`BOND`, `DELAY_COMP`, `BURN`) do not hold a unit in 6 or 7.
- "Paid" means paid to the claim's destination. The claim owner can rotate that destination (`rotateClaimDestination`).

**Outcome causes.** There are exactly ten paths to an allocation, and each one emits a distinguishing event.

| Outcome | Path | Event |
|---|---|---|
| release | `finalize` from 2 or 5 after the challenge window | `Finalized(unitId, true, 0)` (uncontested) |
| release | `finalize` from 3 after the appeal window (silence) | `Finalized(unitId, true, 1)` |
| release | `resolveEscalation`, appeal, upheld | `EscalationResolved(unitId, id, 1, true)` |
| release | `resolveEscalation`, emergency, upheld | `EscalationResolved(unitId, id, 2, true)` |
| release | `approveByBuyer` (tier 0 only, from 1, before `reclaimAt`) | `BuyerApproved(unitId, nonce)` |
| refund | `finalize` from 4 after the assertion cutoff | `Finalized(unitId, false, 2)` (backup, no release) |
| refund | `finalize` on emergency silence | `Finalized(unitId, false, 3)` |
| refund | `reclaimAfterDeadline` from 1 at or after `reclaimAt` | `Finalized(unitId, false, 4)` (deadline reclaim) |
| refund | `resolveEscalation`, appeal, overturned | `EscalationResolved(unitId, id, 1, false)` |
| refund | `resolveEscalation`, emergency, overturned | `EscalationResolved(unitId, id, 2, false)` |

Every release path also emits `ReleaseAllocated(unitId, claimCount)`, and every refund path emits `RefundAllocated(unitId, claimCount)`. The operator is paid nothing on any refund path. The TS exports are `VNextFinalizedReason` and `VNextEscalationRole`.

## 7. Type-level freeze: function selectors

A selector covers a function's name and its complete parameter types, nested struct tuples included. Pinning these freezes the input ABI.

| Contract | Signature |
|---|---|
| factory | `createEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))` |
| factory | `predictEscrow((address,address,bytes32,bytes32,uint256,bytes32,bytes32))` |
| factory | `saltOf((address,address,bytes32,bytes32,uint256,bytes32,bytes32))` |
| factory | `policyKey(address,address,bytes32)` |
| factory | `revokePolicy(address,address,bytes32,uint256)` |
| escrow | `fund((uint256,bytes32,uint8,uint8,uint256,uint256,uint256,uint16,address,uint256,uint16,bytes32,(address,uint256)[])[],(uint256,bytes,bytes))` |
| escrow | `policy()` |
| escrow | `unitState(bytes32)` |
| escrow | `unitCount()` |
| escrow | `unitIdAt(uint256)` |
| escrow | `unitTerms(bytes32)` |
| escrow | `feeScheduleHashOf(bytes32)` |
| escrow | `payoutAt(bytes32,uint256)` |
| escrow | `finalize(bytes32)` |
| escrow | `reclaimAfterDeadline(bytes32)` |
| escrow | `dischargeClaim(bytes32)` |

## 8. Golden vectors

### Inputs

| Input | Value |
|---|---|
| `chainId` | `8453` |
| factory deployer | `0x00000000000000000000000000000000000000D1`; the factory is its CREATE at nonce 0 |
| `implementation` | the factory's own CREATE at nonce 1 (its constructor deploys it) |
| `payer` | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` (well-known anvil test account 0) |
| `operator` | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (well-known anvil test account 1) |
| `jobIdHash` | `keccak256("pcc:vnext:golden:job")` |
| `termsHash` | `keccak256("pcc:vnext:golden:terms")` |
| `policyNonce` | `7` |
| `acceptedPolicyDigest` | `keccak256("pcc:vnext:golden:accepted-policy")` |
| `expiry` | `1900000000` |
| funding time | `1800000000` |

**Unit 0**

| Field | Value |
|---|---|
| `milestoneIndex` | `0` |
| `stepId` | `keccak256("pcc:vnext:golden:step-a")` |
| tiers | `2` / `2` |
| `g` | `1000000003` |
| `feeBps` | `235` |
| `f` | `23500000` (floor; remainder 705) |
| `n` | `976500003` |
| `feeRecipient` | `0x4444444444444444444444444444444444444444` |
| `reclaimAt` | `1802592000` (funding + 30 days) |
| `compositionSchemaVersion` | `3` |
| `compositionRoot` | `keccak256("pcc:vnext:golden:composition-root")` |
| payouts | `0x1111111111111111111111111111111111111111` → `500000000`; `0x2222222222222222222222222222222222222222` → `300000000`; `0x3333333333333333333333333333333333333333` → `176500003` |

**Unit 1**

| Field | Value |
|---|---|
| `milestoneIndex` | `0x0102030405060708090a0b0c0d0e0f10` (above 2^53) |
| `stepId` | `keccak256("pcc:vnext:golden:step-b")` |
| tiers | `0` / `0` |
| `g` | `7` |
| `feeBps` | `0` |
| `f` | `0` |
| `n` | `7` |
| `feeRecipient` | `0x0000000000000000000000000000000000000000` |
| `reclaimAt` | `1831536000` (funding + 365 days: the upper edge, which is legal) |
| `compositionSchemaVersion` | `0` |
| `compositionRoot` | `0x00…00` |
| payouts | `0x1111111111111111111111111111111111111111` → `7` |

Evidence commitment input for unit 0: `packageDigest = keccak256("pcc:vnext:golden:evidence-package")`, format `1`, schema version `3`.

### Outputs

These values were computed by an independent clean-room implementation: pure Python standard library, with its own Keccak-256 and ABI encoder, that read only this document. The same literals are asserted against the real contracts (`VNextAbiFreeze.t.sol`) and against the TS compiler (`vnext-compiler.test.ts`). Compilers can import them as `VNEXT_GOLDEN` from `@pcc/contracts/vnext`.

| Output | Value |
|---|---|
| factory | `0xc5806EA76348d369460284F39E7b65027e6052Ba` |
| implementation | `0x0448F3d8EFEaEc835E18bccA58539233BAE5a5A6` |
| `keccak256(initCode)` | `0xba9d6c77ac1a8f5e64b35d8b87228496f1fad0bb189e9688ed7252857b4f0b1a` |
| `f0` / `n0` | `23500000` / `976500003` |
| `f1` / `n1` | `0` / `7` |
| `abi.encode(configs)` length | 1280 bytes |
| `prePolicyRoot` | `0xc715f1c1249e4fb6e7b8bd64593b1eb84f4161d3b601b5a8bfb965de70871222` |
| `salt` | `0x2d1c6150450f10c652a7e59f26f0dd3ad0e39606e1fd071beabbf6f71353a425` |
| `escrow` | `0x4c3c893eF98D67C55f88E7c6F491bb63606d4682` |
| `settlementUnitId` 0 | `0x89fdc0545fa70c1557b4773ec4be1ad099c3eba97f62c1b505fa52e2562738a1` |
| `settlementUnitId` 1 | `0x8baa29d524fcaa98cb7820ebd653bf3c656720069988de57e6ecec49460d4510` |
| `unitsRoot` | `0x59cab750ff6458bb2f54033aa684ab5f8af18671019b73c3ecf2871f4d34d54a` |
| `jobPolicyHash` | `0x9a76ae0d585f1ca8162005f051704b26d7077e5aff6c22b9406c00bda0976b47` |
| `domainSeparator` | `0xb9653bb57f2627de01133194170d328d16d728b81a7a17c2490d861a4af57880` |
| `digest` | `0x70396a1657b195306d333213cb89663fbab819ef9982557a30250e335dd65156` |
| `policyKey` | `0xdbe1329b76f15734ac713883218519118d309989e4405d840ae804ba2615d969` |
| `feeScheduleHash` 0 | `0x258438ded8181cd3430f8ba0afa19e0416f01386c42fe5628a31655f64882d7c` |
| `feeScheduleHash` 1 | `0x197076bc51efdb4e475f7aedc50c0b7927847df52094fb8548a726fa1540b5b7` |
| `payoutConfigHash` 0 | `0x76a1ace900e1466f058778acc04080011182e02cc61097cb95185c1d02e243a4` |
| `payoutConfigHash` 1 | `0xe1c96f82e4d08d43719bda865e8f5dd015c2c05393d9193962cc287ea54c3110` |
| `claimId` unit 0, principal legs 0 / 1 / 2 | `0x8def2fb8a9c7ad07664aa4cc582436792ed218afb571c1a3688cec5e0b7ee872` / `0x65bb6d604a0cad95371fd60eae5c70513de5c5480a106f847fa2df6dde196ad8` / `0x172fd16edc971a0a44ee3b241973222669ae81021f6ba8de34a16c72d0c3d96d` |
| `claimId` unit 0, fee / refund | `0xeb8b9fc5b6cc1c0556eb0debfe023150e82eafc69a1a65d673c4ba2b7e367964` / `0x4d69ba3166cfe5f97567528fd7a604b8e4eba4d4edba822cf48dea9d0cc1ea67` |
| `claimId` unit 1, principal 0 / refund | `0xe27061a0182573bd4bd244ef44c7451791a976e2eb3c2a6f6921e5e7571f0e2c` / `0xa5511656bf6c0c6e96186853618a271f366397bd195c067f79105cdad6a949e9` |
| `evidenceCommitment` unit 0 | `0x0c21605cc29c989f04c14b696ca7196fdc208c6483ebf77321ab6cc13b605439` |

The constants of §1 and the selectors of §7 are pinned in the same files (`VNEXT_GOLDEN.constants`, `VNEXT_GOLDEN.selectors`).

### Self-check anchors

These are independent of this document's golden inputs. A compiler should reproduce them before it trusts its own keccak and ABI encoder.

| Anchor | Value |
|---|---|
| `keccak256("")` | `0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |
| `POLICY_SALT_DOMAIN` | `0x9c545f70e44ba4292821022010c5750f92d0a3f2cbf06099ed1eaec2ba2ec8ef` |
| `EIP712_DOMAIN_TYPEHASH` | `0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f` |
| `EIP712_VERSION_HASH` | `0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |
| evidence commitment for the older gate-1 inputs | `0xba4753b572b0d79518e05c88932d213125d0634a2c2fbbd7e74d7d52578eb7aa` |

The gate-1 inputs for the last anchor are: `chainId 8453`; escrow `0x00000000000000000000000000000000000e5c0f` (`address(0xE5C0F)`); `jobIdHash = keccak256("golden-job")`; `milestoneIndex 3`; `stepId = keccak256("golden-step")`; schema version `1`; format `1`; `packageDigest = keccak256("golden-evidence-package")`. It is pinned in `VNextSettlementEscrow.t.sol` and was computed with `cast`.

## 9. Change control

Any change to §1–§7 does all of the following:

- moves every predicted escrow address
- invalidates every acceptance signature
- fails `VNextAbiFreeze.t.sol` and `vnext-compiler.test.ts`

That is intended. A change requires:

1. Changing the Solidity.
2. Recomputing the golden outputs **with an implementation other than the contracts** (not by copying `forge` output back into the test).
3. Updating both pinned literal sets.
4. Bumping the affected domain tag (`:vN`) so an old builder fails loudly rather than subtly.
5. Posting the re-pin on the coordination bus to the composition, economics, oracle, evidence and VCR lanes before merge.
