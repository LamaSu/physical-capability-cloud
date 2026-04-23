# Landscape: On-Chain Immutable Rate Schedule DSLs

**Agent**: scout-schedules-bravo
**Date**: 2026-04-22
**Mission**: Research how to express an immutable, publicly-committed rate curve on-chain
for a ContributorNFT + RateSchedule system where the schedule is published once and
the protocol honors it forever (until contributor ships a v2 under a new NFT).

## Progress Tracker

- [x] 1. Vesting contracts (OZ VestingWallet, Gnosis, Sablier Lockup)
- [x] 2. Streaming money (Superfluid, Sablier v2, Drips)
- [ ] 3. Bonding curves (Balancer LBP, Uniswap v3 tick, Bancor)
- [ ] 4. Rate limits / TWAMM (Uniswap v4 hooks)
- [ ] 5. On-chain step functions (arrays, packed uints, LUTs)
- [ ] 6. Piecewise linear encoding (ABDK, PRB Math, Solmate)
- [ ] 7. Commit-reveal schemes (IPFS/Arweave + hash commit)
- [ ] 8. DSLs for contracts (Chainlink Automation, Gelato, Superform)
- [ ] 9. Contract upgradeability conflict (Solidstate, Clones, ERC-4906)
- [ ] 10. Multi-signer schedule updates (governance)
- [ ] 11. Off-chain schedule + on-chain commit
- [ ] 12. Hybrid declarative templates (enum + struct)
- [ ] 13. Enforcement at settlement
- [ ] 14. Adoption-indexed data sources (counter, TheGraph, Chainlink)
- [ ] 15. Gas benchmarking per encoding

## Research Requirements Recap

**Rate curve types we must support:**
- `80bp for first 6 months, 40bp months 7-18, 10bp thereafter` (time-step)
- `50bp flat forever` (constant)
- `min(30bp, max(5bp, 100 / sqrt(jobs_per_day)))` (adoption-indexed with clamps)
- `0bp for jobs under $10, 20bp above` (piecewise on value)
- `0bp always` (altruist)
- Combinations: `max(time-decay, adoption-floor)`

**Hard constraints:**
- Once published, CANNOT be mutated (ever)
- CHEAP to evaluate (settlement is per-job, gas matters)
- Inspectable: users see full future curve before committing

---

## 1. Vesting Contracts

### 1.1 OpenZeppelin VestingWallet (v5.x)

**Source**: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/finance/VestingWallet.sol

**Interface:**
```solidity
constructor(address beneficiary, uint64 startTimestamp, uint64 durationSeconds)
    payable Ownable(beneficiary);

function start() public view returns (uint256);           // uint64 in storage
function duration() public view returns (uint256);         // uint64 in storage
function end() public view returns (uint256);              // start + duration
function released() public view returns (uint256);
function released(address token) public view returns (uint256);
function releasable() public view returns (uint256);
function releasable(address token) public view returns (uint256);
function vestedAmount(uint64 timestamp) public view returns (uint256);
function vestedAmount(address token, uint64 timestamp) public view returns (uint256);
function release() public;
function release(address token) public;
receive() external payable;

// Internal hook (override for custom shape):
function _vestingSchedule(uint256 totalAllocation, uint64 timestamp)
    internal view virtual returns (uint256);
```

**Immutability mechanism:** `_start` and `_duration` are declared
`uint64 immutable`. Immutables are baked into the bytecode at construction
and cannot be written to ever — enforced by EVM, not by access control.

**Default schedule:** linear between `start` and `start + duration`:
```
vested(t) = (total * (t - start)) / duration
```

**Custom shapes:** override `_vestingSchedule(totalAllocation, timestamp)`. The
function is `view`, so it is evaluated cheaply per call with no storage writes.

**Gas:** reading two immutables + one arithmetic expression. Roughly 1.5k-3k
gas for the math path plus ~21k for the transaction overhead. Well under 10k
gas for the view alone. The storage writes only happen on `release()`.

**Expressiveness:**
- Default: linear with cliff at `start`, full at `end`.
- With override: any deterministic `f(totalAllocation, timestamp)`.
- Cannot express rate-per-job, value-conditional rates, or adoption-indexed
  without bolted-on state.

**Immutability guarantee:** compile-time (immutable keyword). The parameter
set is frozen in bytecode. To change, the beneficiary must deploy a new
contract. (This is exactly the pattern we want for ContributorNFT v2.)

**Fit score 1-5: 3.** The immutable-params pattern and the view-function
evaluator are both directly applicable. But VestingWallet expresses total
amount vesting over time, not a rate curve. We'd borrow the pattern, not
the contract.

**Notes:** ERC-6372 clock support was proposed (#6389) but VestingWallet
still uses raw timestamps. Fine for our case because we'll use per-job
settlement time, not voting periods.

### 1.2 Sablier V2 Lockup

**Source**: https://github.com/sablier-labs/lockup
**Docs**: https://docs.sablier.com/reference/lockup/contracts/contract.SablierLockup

Sablier V2 is the canonical reference for on-chain curves. **Streams are
ERC-721 NFTs. Contracts are immutable and non-upgradeable.**

**Three curve families:**

#### 1.2.1 LockupLinear
Constant rate with optional cliff. The streamed amount at time t is:
```
f(t) = (total * (t - start)) / (end - start)   if t >= cliff, else 0
```

Fit for our "flat forever" rate curve, but expressed as total-over-duration
rather than per-job bp. Still a useful reference because the immutability
pattern is identical to OZ VestingWallet.

#### 1.2.2 LockupDynamic — segmented non-linear
Each segment has three fields:

| Field     | Type     | Meaning                              |
|-----------|----------|--------------------------------------|
| amount    | uint128  | Tokens unlocked in this segment      |
| exponent  | UD2x18   | Power that shapes the curve          |
| timestamp | uint40   | Unix timestamp at segment end        |

**Formula** (from docs.sablier.com/concepts/lockup/segments):
```
f(x) = x^exp * csa + sum(esa)
where:
  x   = elapsed_in_segment / total_in_segment
  exp = current segment exponent
  csa = current segment amount
  esa = amounts of all completed prior segments
```

Example: quadratic segment (exp=2) of 1000 tokens, at 50% elapsed:
`0.5^2 * 1000 = 250 tokens`.

This is computed on-chain using PRBMath's UD60x18 `pow()` function. Sablier
pays the gas cost of fractional exponentiation per view call.

#### 1.2.3 LockupTranched — discrete step unlocks
Struct `LockupTranched.TrancheWithDuration`:
```solidity
struct Tranche { uint128 amount; uint40 timestamp; }
```
At each timestamp, the amount unlocks in a single step. No interpolation.

**Gas cost** to *create* a LockupTranched stream for one year: ~511,476 gas
on mainnet (includes NFT mint + array storage + token transferFrom). This
is creation cost, not evaluation. Evaluation is a binary search over an
array of tranches: O(log n) SLOADs.

**Gas pitfall:** 1095 tranches (3-year daily unlock) runs into block gas
limits during creation and costs large amounts per evaluation. Sablier docs
explicitly warn against this.

**Fit for our system:**
- **LockupLinear**: directly applicable for "50bp flat forever" — we just
  need the `f(x) = constant` shape, not the total-over-time meaning.
- **LockupDynamic**: powerful but expensive. Each segment evaluation does a
  PRBMath pow() which is 2-5k gas. For a 3-step contributor curve this is
  fine. For high-frequency settlement, each extra segment is real money.
- **LockupTranched**: perfect fit for "80bp for 6mo, 40bp for next 12mo,
  10bp after" — three tranches, each with its bp rate stored as amount.
  O(log 3) = 2 SLOADs per evaluation. Very cheap.

**Immutability guarantee:** Sablier contracts are non-upgradeable. Stream
parameters are written once at create and never modified. Segments live in
storage arrays indexed by streamId, locked via contract-level immutability.
(Creation is dynamic — the *contract* is immutable, each *stream* has fixed
params post-creation.)

**Fit score 1-5: 5 for LockupTranched as step-function reference**, 4 for
LockupDynamic as non-linear reference. We can use the segment+exponent
encoding directly for "time-decay" curves if we want a smooth taper.

**Key insight for our design:** storing schedule parameters in a storage
array indexed by NFT tokenId is cheaper than deploying a per-NFT contract.
But we lose the EVM-level immutability guarantee — we need contract logic
to enforce "no setter exists for this array slot once written". This is
easy: the write path is inside `mintContributor()` and there is no other
write path.

### 1.3 Gnosis Token Vesting (zodiac / safe-ecosystem)

Gnosis uses a Safe module pattern: vesting logic lives in a Zodiac module
attached to a Safe. Not immutable by default — governance can swap modules.
Explicit **anti-pattern** for our use case. We want immutable-by-construction,
not governed. Mentioned here only to flag: if someone tries to adapt a Zodiac
module for our ContributorNFT, reject.

---

## 2. Streaming Money Protocols

### 2.1 Superfluid (Constant Flow Agreement)

**Source**: https://docs.superfluid.finance/

**Model:** Accounts have net flow rates (tokens per second). Flows sum
to a single per-second delta on the super-token balance.

**Flow NFTs**: CFAv1 issues an NFT representing each active flow. Metadata:
- `token` (super-token address)
- `flowRate` (int96, tokens per second)
- `sender` / `receiver`
- `startDate`

**Interface (CFAv1Forwarder):**
```solidity
function createFlow(ISuperToken token, address sender, address receiver,
                   int96 flowRate, bytes userData) external returns (bool);
function updateFlow(ISuperToken, address sender, address receiver,
                    int96 flowRate, bytes userData) external returns (bool);
function deleteFlow(...) external returns (bool);
function getFlowrate(ISuperToken, address sender, address receiver)
    external view returns (int96);
```

**Immutability:** Flows are NOT immutable — `updateFlow` changes the rate.
The PROTOCOL is immutable and non-upgradeable, but the *flow rate* is
mutable by the sender.

**Fit for our requirement:** **poor**. We need "contributor sets rate ONCE,
cannot change". Superfluid deliberately supports rate updates as a feature.
We'd have to either:
(a) Use Superfluid with a wrapper that disallows updateFlow (loses the point
    of Superfluid),
(b) Take only the int96 flow-rate encoding as inspiration.

**Fit score 1-5: 2.** The flow-rate-per-second encoding is interesting
(int96 is enough for any reasonable rate, tightly packed). But the model
doesn't match our immutability requirement.

**One useful technique to borrow:** Superfluid stores flow rate as int96
in a packed struct. For a per-job bp rate, we could use uint16 (max 65535 bp
= 655%), which packs 16 rates into one storage slot. Cheap.

### 2.2 Sablier v2 Flow (new in April 2024)

**Source**: https://github.com/sablier-labs/flow

Sablier Flow is open-ended streaming (no end date). It's essentially
Sablier's answer to Superfluid, but with a different mutability model:
- `pause()` / `resume()` flows
- Adjustable rate per second
- NFT-based

Same mutability issue as Superfluid. **Fit score 1-5: 2.**

### 2.3 Drips Protocol

**Source**: https://github.com/drips-network/contracts
**Docs**: https://docs.drips.network/

**Model:** An account can "drip" tokens to N receivers with split
percentages. Receivers can split further. Protocol-level immutable
parameters: `cycleSecs >= 1`, `minAmtPerSec = 1 token/cycle`.

**Key quote from docs:** "Drip Lists and Streams can be mutable and owned
by Smart Contract logic." So Drips supports both mutable and immutable
streams depending on who owns the NFT. If the NFT owner is a contract
with no setter, the stream is effectively immutable.

**Fit for our system:** The "wrap the NFT in an immutable contract" pattern
is something we could borrow. But we already have a simpler design: store
params directly in a mapping indexed by tokenId inside an immutable contract
with no setter for that mapping. Drips adds indirection we don't need.

**Fit score 1-5: 2.**

**Useful concept to borrow:** Drips' `cycleSecs` as a coarse-grained time
unit. If we're worried about spam writes to on-chain counters for
adoption-indexed rates, cycle-based accounting (one update per epoch) is a
well-known pattern.

---

## Checkpoint: Sections 1-2 complete. Committing.

