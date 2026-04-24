# Landscape: On-Chain Immutable Rate Schedule DSLs

**Agent**: scout-schedules-bravo
**Date**: 2026-04-22
**Mission**: Research how to express an immutable, publicly-committed rate curve on-chain
for a ContributorNFT + RateSchedule system where the schedule is published once and
the protocol honors it forever (until contributor ships a v2 under a new NFT).

## Progress Tracker

- [x] 1. Vesting contracts (OZ VestingWallet, Gnosis, Sablier Lockup)
- [x] 2. Streaming money (Superfluid, Sablier v2, Drips)
- [x] 3. Bonding curves (Balancer LBP, Uniswap v3 tick, Bancor)
- [x] 4. Rate limits / TWAMM (Uniswap v4 hooks)
- [x] 5. On-chain step functions (arrays, packed uints, LUTs)
- [x] 6. Piecewise linear encoding (ABDK, PRB Math, Solmate)
- [x] 7. Commit-reveal schemes (IPFS/Arweave + hash commit)
- [x] 8. DSLs for contracts (Chainlink Automation, Gelato, Superform)
- [x] 9. Contract upgradeability conflict (Solidstate, Clones, ERC-4906)
- [x] 10. Multi-signer schedule updates (governance)
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

## 3. Bonding Curves

### 3.1 Uniswap V3 TickMath (reference for cheap curve evaluation)

**Source**: https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol

This is the most gas-optimized curve library in production DeFi. It computes
`sqrt(1.0001 ^ tick) * 2^96` as a Q64.96 fixed-point number using a chain
of bit-level multiplications.

**Constants:**
- `MIN_TICK = -887272`
- `MAX_TICK = 887272`
- `MIN_SQRT_RATIO = 4295128739`
- `MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342`

**Implementation technique:** Square-and-multiply using precomputed hex
constants, one per power-of-two tick spacing. The Solidity-assembly
loop unrolls the bit decomposition of the tick. Gas is roughly constant
across the tick range — about **4-8k gas** for `getSqrtRatioAtTick` per
call, based on community benchmarks (Aperture Finance reports 6-30% savings
over baseline using inline assembly).

**Reverse function `getTickAtSqrtRatio`:** binary search over the MSB of
the ratio, then bit-by-bit refinement. More expensive than forward (~12k+
gas) but still cheap enough for routine use.

**Applicability to our rate schedule:**
- Direct: if we want "rate that exponentially decays with time", we can
  encode decay rate as a tick-like value and use TickMath-style evaluation.
- Inspiration: the square-and-multiply pattern with precomputed constants
  is THE trick for cheap on-chain curves. If we ship a "decay" template,
  we use this technique.

**Fit score 1-5: 4** for the technique, not for direct use.

### 3.2 Bancor Bonding Curve Formula

**Source**: https://github.com/relevant-community/bonding-curve/blob/master/contracts/BancorFormula.sol

**Core formula for purchase return:**
```
Return = supply * ((1 + deposit / reserve) ^ (weight / MAX_WEIGHT) - 1)
```
Where `MAX_WEIGHT = 1_000_000` (parts per million).

**Key math primitive:** `power(baseN, baseD, expN, expD)` — computes
`(baseN / baseD) ^ (expN / expD) * 2^precision` using Taylor-series log/exp
with precomputed tables.

**Gas cost:** roughly **8-25k gas** per `power()` call depending on how
many terms the Taylor series requires for the given precision.

**Applicability:** Bancor's `power()` is the most general fractional-exponent
function available on-chain. Far too expensive for per-job rate lookup
(we want <3k gas), but possible if we cache results or use it only for
one-time rate initialization.

**Fit score 1-5: 2.** Too expensive for per-job evaluation.

### 3.3 Balancer LBP (Liquidity Bootstrapping Pool)

**Source**: https://docs.balancer.fi/concepts/explore-available-balancer-pools/liquidity-bootstrapping-pool.html

**Model:** A weighted pool where token weights change linearly over a
bounded time window. Owner sets `startTime`, `endTime`, `startWeights`,
`endWeights`. The `_getNormalizedWeight(token)` function interpolates:
```
weight(t) = startWeight + (endWeight - startWeight) * (t - startTime) / (endTime - startTime)
```

**Immutability:** Partial. The LBP is a "smart pool" — the pool controller
can change parameters mid-flight (within limits). Not fully immutable. LBPs
are explicitly less trustless than shared pools.

**Fit for our rate schedule:** The **time-interpolated weight formula** is
directly applicable to our "rate decays linearly from A to B over T seconds"
template. Gas is trivial: two SLOADs + one division.

But we do NOT want the Balancer mutability model. We want: set the linear
ramp parameters once, NEVER change them.

**Fit score 1-5: 3.** Use the linear-interpolation formula, skip the
controller pattern.

---

## 4. TWAMM and Time-Weighted Execution

### 4.1 Uniswap V4 TWAMM Hook

**Source**: https://blog.uniswap.org/v4-twamm-hook
**Reference impl**: https://github.com/FrankieIsLost/TWAMM (original academic impl)

**Model:** Long-term orders are deposited into a hook. Each order has:
- `sellRate` (tokens sold per block) — encoded as uint256 with a scaling factor
- `expiration` (block or timestamp when order ends)
- `owner` address

At each block, the hook aggregates all active orders with the same
`expiration bucket` into a single OrderPool. The per-block settlement
computes the cumulative sale rate `R = sum(sellRate_i)` across all active
orders and produces an implicit constant-rate swap against the AMM pool.

**Key data structure (from the Frankie reference):**
```solidity
struct LongTermOrder {
    uint256 id;
    uint256 expirationBlock;
    uint256 saleRate;       // tokens per block, scaled
    address owner;
    uint256 sellTokenId;    // 0 or 1 in the pool
    uint256 saleRateEndingPerBlock;
}

struct OrderPool {
    uint256 currentSalesRate;
    uint256 rewardFactor;
    // earning factors at key expirations (sparse array / linked list)
    mapping(uint256 => uint256) salesRateEndingPerBlock;
    mapping(uint256 => uint256) rewardFactorAtBlock;
}
```

**Immutability:** Orders are immutable once placed. The hook has no "update"
method — only `withdrawProceeds` and `cancel` (cancel just zeroes the
sell rate going forward, doesn't edit the historical record).

**Fit for our requirement:** **direct.** TWAMM's "rate per block, immutable
once placed, sparse storage of rate changes at expiration boundaries" is
structurally identical to what we want for "contributor rate per job with
step changes at time boundaries". The step encoding is the same.

**Fit score 1-5: 4** for the step-function storage pattern. 5 for the
"rate cannot be updated" invariant.

### 4.2 Uniswap V4 Dynamic Fees (via hooks)

**Source**: https://docs.uniswap.org/contracts/v4/concepts/dynamic-fees

V4 pools can have dynamic fees set via a hook on every swap. The hook is
called before each swap and returns the fee. This is literally the pattern
"pool fee as a function of time/volume/liquidity". The schedule is encoded
in whatever logic the hook implements — fully free-form Solidity.

**Gas cost:** the hook call itself is ~2k-5k gas overhead per swap. The
fee computation cost depends on what the hook does.

**Applicability:** V4 hooks are the closest thing to a "declarative fee
schedule at protocol level". But hooks are mutable code — if we want
immutable per-contributor rate, we still need to put the schedule in
an immutable data structure (mapping + no setter). We don't need to
implement a V4 hook; we need to implement the pattern.

**Fit score 1-5: 3** for architectural inspiration.

### 4.3 Rate Limits for Governance (Compound Comet, Morpho)

Brief note: governance-controlled rate-limit patterns in Compound Comet
use `IInterestRateModel` — a separate contract that returns interest as a
function of utilization. Governance can swap the IRM address. This is the
**anti-pattern** for us: we want immutable schedule per contributor, no
swap path.

But one useful idea: **separate the schedule as an interface**. An
`IRateSchedule.evaluate(job) view returns (uint16 bp)` interface lets the
protocol consume rate logic from multiple sources. If each contributor's
schedule lives in its own immutable contract address, the protocol
queries that address and gets a rate back. The contract is the immutable
artifact, the interface is the standard.

---

## 5. On-chain Step Functions (Encoding Tradeoffs)

A step function `f(t)` returns one of N constant values depending on which
time bucket `t` falls in. This is the most common rate-schedule shape in
real legal contracts (90%+ of actual contributor economics is "Y bp for
first X months, Z bp after"). Cheap to store, cheap to evaluate.

### 5.1 Array of structs

```solidity
struct Step {
    uint40 boundary;   // boundary timestamp
    uint16 bpRate;     // basis points (max 65535 = 655.35%)
}
Step[] public schedule;  // N steps, each 7 bytes → 1 slot fits ~4
```

**Gas evaluation (linear scan for N steps):**
- Cold SLOAD: 2,100 gas
- Warm SLOAD: 100 gas
- For N=3 array: ceil(3 * 7 / 32) = 1 cold SLOAD + ... ≈ **2,300 gas**
- For N=10: 3 cold SLOADs ≈ **6,500 gas**
- For N=20: 5 cold SLOADs ≈ **10,700 gas**

**Binary search for N>8:** O(log N) SLOADs but overhead of the search
itself costs more than linear for small N. Crossover is around N=10.

### 5.2 Packed into a single storage slot

For up to 7 boundaries + 7 rates in 256 bits:
```solidity
// Layout: [r0][r1][...][r6][b0][b1][...][b6] — 16 bits each
uint256 public packedSchedule;
```
- 7 × uint16 rates (112 bits) + 7 × uint16 boundaries (112 bits) = 224 bits
- 32 bits spare for "steps count" + active flag

**Gas evaluation:** ONE SLOAD (2,100 cold or 100 warm) + bit-shift unpacking
(~100-200 gas). Total **~2,300 gas cold, ~300 gas warm**.

This is the **cheapest possible** encoding for a step function with up to 7
steps. Storage cost to WRITE is just 22,100 gas (new slot), vs 22,100 × N
for an array.

**Tradeoff:** Limited to 7 steps at 16-bit boundaries. If boundaries are
timestamps (40 bits), you could fit 4 boundaries + 4 rates = 4 steps per slot.

### 5.3 Mapping with binary search over stored boundaries

```solidity
mapping(uint256 tokenId => Step[]) private schedules;
```

Cost per evaluation: O(log N) SLOADs ≈ 2-5 warm SLOADs for N=10 = **~1k gas
warm**. But first access is cold (2,100).

This is what Sablier LockupTranched uses. Good for larger N (up to ~50)
where packed encoding breaks.

### 5.4 Precomputed lookup table (LUT) with uint256 bitmap

For "rate is X before time T, else Y" (2-step only), you need one bit per
step, one uint256 for all boundaries up to 256 distinct boundaries:
```solidity
uint256 public rateABitmap;    // bit i set if step i uses rate A
uint256 public rateAValue;     // the A value
uint256 public rateBValue;
```

Too inflexible for our needs. Mentioned only for completeness.

### 5.5 Recommendation for our system

Use the **packed-single-slot encoding (5.2)** for up to 7 steps, and
fall back to a storage array (5.1) when 8+ needed. The simplest practical
approach is:

```solidity
struct StepSchedule {
    uint8 stepCount;           // 0-7
    uint16[7] rates;            // bp
    uint40[7] boundaries;       // unix ts; 0 = "until stepCount end"
}
mapping(uint256 tokenId => StepSchedule) internal _stepSchedules;
```

Total storage: 8 + 112 + 280 = 400 bits ≈ 2 slots per schedule. Evaluation:
2 cold SLOADs = 4,200 gas, or 2 warm SLOADs = 200 gas.

**This already beats Sablier Tranched for our 1-3 step case.**

### 5.6 Deployment-cost consideration

Each cold SLOAD costs the SETTLEMENT caller, not the contributor. So the
choice is: "do we optimize for cheap minting (one struct write = 22,100 gas)
or cheap evaluation (one SLOAD = 2,100 gas per job)?"

Rate schedules are written ONCE per contributor but read MANY times (once
per job that uses the adapter). Evaluation cost dominates by 2-4 orders of
magnitude. **Optimize for read.**

---

## 6. Piecewise Linear Encoding + Fixed-Point Math Libraries

For curves that aren't step functions (time-decay, adoption-indexed),
we need some form of interpolation and/or nonlinear math. Here are the
libraries available, with gas benchmarks.

### 6.1 PRBMath (Paul R. Berg) — current standard

**Source**: https://github.com/PaulRBerg/prb-math
**License**: MIT
**Version**: v4.x (current)

**Two types:**
- `UD60x18` (unsigned 60.18 fixed-point, MIT)
- `SD59x18` (signed, slightly slower for abs/neg)

**Gas benchmarks (from README, UD60x18):**

| Operation | Min gas | Max gas | Avg gas | Notes                         |
|-----------|---------|---------|---------|-------------------------------|
| pow       | 64      | 10,637  | 6,635   | variable — Taylor terms        |
| exp       | 1,874   | 2,742   | 2,244   | e^x                            |
| exp2      | 1,784   | 2,652   | 2,156   | 2^x                            |
| ln        | 419     | 6,902   | 3,814   | natural log                    |
| log2      | 330     | 6,825   | 3,426   | log base 2                     |
| sqrt      | 114     | 846     | 710     | Babylonian                     |
| inv       | 40      | 40      | 40      | 1/x                            |
| mul       | 219     | 275     | 247     | fixed-point multiply            |
| div       | 205     | 205     | 205     | fixed-point divide              |

Note: these are **inclusive of storage/call overhead** — pure arithmetic
is even cheaper if inlined.

**Used by:** Sablier v2, many DeFi protocols. This is the modern default.

### 6.2 ABDK Math 64.64 — older but still used

**Source**: https://github.com/abdk-consulting/abdk-libraries-solidity
**License**: BSD-4-Clause

**Format**: 64.64 bit signed fixed-point stored in int128.

**Gas comparison (from krushiraj.github.io benchmark):**

| Operation | ABDK 64.64 | PRBMath UD60x18 |
|-----------|------------|-----------------|
| mul       | 1,058      | 877             |
| pow       | 2,302      | 2,723           |

PRBMath wins on exp/log/inv, ABDK wins on mul/div/powu/sqrt (per RareSkills
and PRBMath's own docs). Difference is small — roughly 10-20% on most ops.

**When to prefer ABDK:** if you need 128-bit precision (rare for our bp
rates). For 16-bit bp rates, both are massive overkill.

### 6.3 Solmate / Solady FixedPointMathLib — minimalist WAD math

**Source**: https://github.com/transmissions11/solmate/blob/main/src/utils/FixedPointMathLib.sol
**Solady variant**: https://github.com/Vectorized/solady/blob/main/src/utils/FixedPointMathLib.sol

**Format**: WAD = 1e18. Unsigned only (Solmate). Solady adds expWad/lnWad.

**Signatures:**
- `mulWadDown(x, y)`, `mulWadUp`, `divWadDown`, `divWadUp`
- `rpow(x, n, scalar)` — integer-power
- `sqrt(x)` — Babylonian
- Solady adds: `expWad(x)`, `lnWad(x)`, `powWad(x, y)` (via exp(ln(x)*y))

**Gas cost** (Solady, from benchmarks):
- `mulWad`: ~80-150 gas (pure assembly)
- `sqrt`: ~400-800 gas
- `expWad`: ~2,000-3,500 gas (less precise than PRBMath exp)
- `lnWad`: ~2,500-4,500 gas

**Key advantage:** Solady is written almost entirely in inline assembly,
shaving 10-30% off PRBMath for the same ops. The library is MIT.

**When to prefer:** if you want small binary size and you only need mul/div/
sqrt/exp. For our adoption-indexed rate (sqrt of job count), Solady's sqrt
at ~700 gas is the right pick.

### 6.4 Piecewise Linear (PWL) approximation

For any smooth curve f(t), approximate with N breakpoints (ti, yi) and
linearly interpolate between them:
```
f(t) = yi + (y(i+1) - yi) * (t - ti) / (t(i+1) - ti)   for t in [ti, t(i+1)]
```

This is how most complex curves get compiled to on-chain form when
evaluation must be cheap.

**Gas cost:**
- Find segment: O(log N) SLOADs ≈ 2-3 warm SLOADs for N=7 = **~300 gas**
- Interpolate: 1 mul + 1 div + 1 add = **~500 gas**
- Total: **~800-1200 gas** per evaluation for N=7 breakpoints.

**Tradeoff:** worse fidelity than true nonlinear eval, but 3-10x cheaper
than calling pow() or exp(). For a "smooth decay from 80bp to 10bp over
18 months", 7 breakpoints at 2-month intervals give ~1% max relative error.

**Design choice for us:** since our bp rates are already coarse (1-2 digit
integer precision), PWL approximation is fine. A "smooth time-decay" template
can ship as 7 breakpoints, linearly interpolated.

### 6.5 Academic note: optimal breakpoint placement

Literature (arXiv:2407.21081) shows optimal PWL for a known nonlinear
target uses Chebyshev-node spacing: breakpoints concentrated where curvature
is highest. For our use case, the Contributor UI precomputes the breakpoints
from the contributor's specified curve type (e.g., "exponential decay with
half-life 6 months") and stores those breakpoints on-chain. No math happens
at evaluation time.

This means we can SHIP any smooth curve the UI can precompute, as long as
the on-chain form is breakpoints + linear interpolation. The math runs
off-chain at mint time; on-chain, only the cheap PWL lookup runs.

---

## 7. Commit-Reveal Schemes / Off-Chain Schedule + On-Chain Hash

### 7.1 IPFS CID + on-chain hash commit

**Model:**
1. Contributor computes their full rate schedule off-chain (JSON file).
2. Uploads JSON to IPFS, gets CID (content-addressed SHA-256 hash).
3. Mints ContributorNFT with `scheduleCID` + `scheduleHash` stored in
   immutable fields of the NFT.
4. Settlement fetches the JSON from IPFS (optionally verifies hash) and
   evaluates the schedule off-chain.

**Pros:**
- Schedule can be arbitrarily complex — full Turing-complete off-chain
  evaluator if you want.
- Inspectable by anyone with the CID — open data.
- On-chain storage is minimal (~46 bytes for a CIDv1).
- Content-addressed = **immutable by the laws of hashing**. If the bytes
  change, the CID changes, and the NFT's commitment is invalid.

**Cons:**
- Settlement **cannot complete on-chain alone**. It requires an off-chain
  evaluator to fetch the CID, compute the rate, and submit a signed rate
  attestation. This is a trust model question.
- IPFS persistence is not guaranteed unless pinned. If the CID becomes
  unreachable, the schedule is effectively lost. (Fix: pin on Arweave or
  Storacha for permanence.)
- Multi-hop evaluation = more latency + gas.

**Gas cost:** on-chain = just 1 SLOAD for the CID + 1 SLOAD for hash = ~4k
gas. Off-chain evaluator cost is separate (API call + signature verify = ~10k gas
to verify the signed attestation on-chain).

**Applicability:** this is the right pattern if we want to support **arbitrary**
schedule logic (e.g., "rate depends on external oracle data we haven't
anticipated yet"). For our 5-template system, overkill — we don't need a
Turing-complete DSL off-chain.

**Fit score 1-5: 3 as fallback for rare custom cases.** NOT the primary mechanism.

### 7.2 Arweave / Storacha permanence

Arweave pays miners once up-front for permanent storage. Storacha (formerly
Web3.Storage) uses Filecoin for long-term pinning. Both provide cryptographic
permanence beyond what IPFS alone offers.

**For our system:** if we do go with off-chain schedule + hash commit, we
pin to Storacha (PCC already uses it for evidence bundles — same path).
Commit Arweave tx ID on-chain if we want to be extra paranoid about
century-scale persistence.

### 7.3 Commit-reveal is NOT what we want here

Traditional commit-reveal is for hiding a value then proving it later
(auctions, RNG). We don't need to hide the schedule — we WANT it public.
The pattern we want is just "hash commit for integrity". No reveal phase.

---

## 8. Domain-Specific Languages for On-Chain Logic

### 8.1 Chainlink Automation — triggers, not DSL

**Source**: https://docs.chain.link/chainlink-automation

**Model:** Your contract implements `AutomationCompatibleInterface`:
```solidity
function checkUpkeep(bytes calldata) external view returns (bool upkeepNeeded, bytes memory performData);
function performUpkeep(bytes calldata performData) external;
```

Automation nodes poll `checkUpkeep` off-chain. When it returns true, they
call `performUpkeep`. Conditional logic lives in Solidity, not a DSL — the
"DSL" is just "any view function returns bool".

**Fit for our rate schedule:** NOT applicable. We don't need triggered
execution — settlement is called by the escrow contract when a job is released.
No off-chain polling required.

**Fit score 1-5: 1.**

### 8.2 Gelato Web3 Functions — TypeScript on IPFS

**Source**: https://docs.gelato.cloud/

**Model:** TypeScript function stored on IPFS, run by Gelato executors.
Returns `canExec` + `execData`. Logic is arbitrary off-chain code with
access to on-chain state via providers.

**Fit for our rate schedule:** also not applicable. Gelato is a decentralized
trigger network; we have a predictable on-chain call path.

**One useful concept:** the TypeScript-on-IPFS approach could be useful
for **off-chain schedule evaluators** as a fallback for custom schedules.
But adds a whole new dependency vs our 5-template on-chain approach.

**Fit score 1-5: 1.**

### 8.3 Superform (DeFi aggregator) — template-per-strategy

Superform has a "Form" abstraction: each DeFi protocol has a standardized
wrapper contract. Users call a Form, and it adapts to the underlying protocol.
Superform is unrelated to rate schedules — I couldn't find a "schedule DSL"
in it despite the name sounding promising.

**Fit score 1-5: 1.**

### 8.4 Actus Financial Contracts — declarative financial contract DSL

**Source**: https://www.actusfrf.org/

ACTUS is a taxonomy of 32 financial contract types with a formal DSL for
expressing cash flow patterns. Originally from IBM research. Subset has
been implemented as Solidity libraries.

**Relevance:** ACTUS formalizes exactly the kind of "flow schedule" we care
about — it has standard types for principal + interest schedules, step-rate,
bond amortization, etc.

**For our system:** ACTUS is a **vocabulary**, not a code library. Reading
the ACTUS taxonomy helps us validate that our 5-template set covers the
common cases (it does — our templates are a subset of ACTUS Plain Vanilla
contracts + bond amortization patterns).

**Fit score 1-5: 3** for vocabulary / design validation.

### 8.5 Marlowe (Cardano) — actually is a contract DSL

Cardano's Marlowe is a Turing-incomplete DSL for financial contracts with
formal semantics. Not applicable to Ethereum, but worth citing as the
canonical example of a financial-contract DSL done right.

**Takeaway:** Marlowe proves that you can express 90%+ of financial
contract logic in a non-Turing-complete, analyzable DSL. Our enum + struct
template approach is in the same spirit: limited expressiveness, full
analyzability.

---

## 9. Contract Upgradeability and Immutability-by-Construction

### 9.1 The proxy problem

If our RateSchedule contract lives behind a proxy (UUPS, Transparent Proxy,
Beacon), it is NOT immutable. Someone with the admin key can replace the
implementation. That's the entire point of proxies.

**For our system: proxies are an anti-pattern.** Direct bytecode immutability
is the only way to provide credible "rate cannot change".

### 9.2 EIP-1167 Minimal Proxy (Clones)

**Source**: https://eips.ethereum.org/EIPS/eip-1167
**OZ implementation**: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/proxy/Clones.sol

**Model:** Every clone is a 45-byte bytecode stub that DELEGATECALL-forwards
to a shared implementation. The implementation address is hardcoded in the
clone's bytecode — it CANNOT be changed.

**Properties:**
- Clone creation code: 55 bytes (45 bytes runtime + 10 bytes constructor)
- Gas to deploy: ~32,000-45,000 (vs 200k-2M for a full contract)
- Via CREATE2: deterministic address from salt + implementation
- **Immutable:** no admin, no upgrade path

**Use case for us:** if we want each contributor's RateSchedule to live at
its own address (like each Sablier stream NFT has its own... wait, no,
Sablier streams share a contract). EIP-1167 clones are appropriate when
the per-instance state is significant and lives in storage of the clone.

For our case, each contributor's schedule is small (2-3 storage slots). We
DON'T need a clone per contributor. A single mapping in one immutable
contract suffices. Clones would add 32k gas per contributor for zero
benefit.

**Fit score 1-5: 2.** The pattern is well-understood but overkill for our
data size. However, if we want each schedule to be INDEPENDENTLY
DEPLOYED (e.g., for governance-minimal branding or L2 compatibility), clones
are the right tool.

### 9.3 ERC-4906 (metadata update event)

**Source**: https://eips.ethereum.org/EIPS/eip-4906

**Full spec:**
```solidity
event MetadataUpdate(uint256 _tokenId);
event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
```

Purely a signaling extension. No requirement that metadata actually
changes. The EIP explicitly says implementers SHOULD NOT emit on mint/burn,
only on intentional metadata change.

**For our system:** we can emit `MetadataUpdate` on the rare case where a
rate schedule has a URI pointing to IPFS-hosted documentation and that
document gets re-pinned or cached. But the SCHEDULE ITSELF never mutates,
so we'd almost never emit this. Clean to implement, no functional impact.

**Fit score 1-5: 2** — optional but standard-compliant.

### 9.4 Immutable-by-construction pattern summary

For our ContributorNFT + RateSchedule:
1. Single non-upgradeable `ContributorNFT` contract deployed once.
2. `mapping(uint256 tokenId => Schedule)` stores each contributor's
   schedule.
3. The **only** write path to the mapping is inside `mintContributor()`.
4. No `setSchedule`, no `update`, no proxy.
5. To "update", contributor mints a new tokenId (v2) which the protocol
   may choose to honor separately.

This gives contract-level immutability (not bytecode-level) but it's
equivalent from a trust standpoint: anyone can read the contract source
and verify no mutation path exists.

### 9.5 Solidstate, Diamond / EIP-2535 — hard no

Solidstate and the Diamond pattern are designed for UPGRADEABLE modular
contracts. Both assume a governance/admin. Explicit anti-pattern for our
immutability requirement.

---

## 10. Multi-Signer Schedule Updates (Governance) — Intentionally Avoided

Compound Comet, Aave, and Morpho all use governance-controlled interest rate
model swaps. Pattern:
1. Governance proposal to change the IRM address.
2. After timelock, execute.
3. Rates change on next interaction.

**Why we reject this pattern:** the user directive explicitly says "MARKET
sorts rates, no governance". Contributors compete on published-and-frozen
rates. A governance process that can alter a contributor's rate post-mint
destroys the entire mechanism:
- Market signal becomes noise (why trust a frozen rate if gov can thaw it?)
- Contributors are forced to monitor governance, which is overhead.
- The whole point of "mint an NFT to publish a commitment" is lost.

**Mentioned here only to flag for review:** any PR that adds a setter,
emergency pause, or governance hook to the RateSchedule storage mapping
is a protocol-level regression. Reject at code review.

**One acceptable compromise** (NOT recommended for v1, but possible later):
a **versioned migration path** where a new `ContributorNFT_v2` contract can
be deployed with different rate logic, and existing holders can opt-in to
migrate (burn old NFT, mint new). This is NOT a governance override — it's
a fork the holder chooses.

---

## Checkpoint: Sections 7-10 complete. Committing.

