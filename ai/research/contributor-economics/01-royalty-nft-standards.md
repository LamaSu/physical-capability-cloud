# Landscape: Royalty / Attribution / Split NFT Standards

**Author**: scout-royalty-alpha
**Date**: 2026-04-22
**Purpose**: Landscape the royalty + attribution NFT standard space for a new
protocol primitive (`ContributorNFT` + immutable on-chain `RateSchedule`) that
splits robotics-job-settlement payments across recursively-provenance-traced
contributors (adapters, capabilities, datasets, trained models).

## Progress Tracker

- [x] 01. ERC-2981 Royalty Info
- [x] 02. EIP-5585 and newer royalty-enforcement proposals
- [x] 03. OpenSea/Rari/Manifold Royalty Registry + Operator Filter
- [x] 04. Drips (drips.network)
- [x] 05. 0xSplits
- [x] 06. Superfluid
- [x] 07. Sablier
- [x] 08. Story Protocol (PIL / IP Graph)
- [x] 09. EIP-2535 Diamond Standard
- [x] 10. ERC-6551 Token-Bound Accounts
- [x] 11. Rate-schedule DSLs (Curve / Balancer / Uniswap v3 / Compound)
- [x] 12. Adoption-indexed rates (prior art)
- [x] 13. Content-addressed metadata standards (EIP-4884, etc.)
- [x] 14. Programmatic splits for DAG provenance

## Design Hook (framing for each section)

We're building:

- `ContributorNFT` — transferable token per author (person/team/DAO) of a
  reusable PCC contribution (adapter, capability protocol, dataset, model).
- Each ContributorNFT owns an **immutable on-chain `RateSchedule`**: a pure
  function from (t, adoption_metric) to basis_points. Committed at mint;
  can be DECREASED by owner but NEVER increased. Forbids rug-pull-upward.
- On every `settleJob()` in PCC (a physical job that produced assurance-tiered
  evidence and unlocked escrow on Base Sepolia), `splitPayout()` walks the
  provenance manifest (DAG: adapter -> capability -> dataset -> model) and
  routes fractional payments to every ContributorNFT in the dependency closure.
- We explicitly forbid platform/OEM rent layers. Rates must be set by the
  author, visible on-chain, and compete in the open market. Composition
  multiplies fees naturally — consumers see the aggregate before signing.

Each standard below is scored for fit against five axes:

1. **Carrier**: usable as the NFT that represents a contributor?
2. **Rate DSL**: supports a time/adoption-varying rate schedule?
3. **Immutability**: can we lock the schedule at mint and prevent upward changes?
4. **DAG split**: supports recursive split across a dependency graph?
5. **Gas fit**: acceptable overhead per robotics-job settlement (target <$0.10
   on Base at 30 gwei)?

Score: Fit 1-5 (5 = strong fit, 1 = unrelated). Summary table at the end.

---

## 01. ERC-2981 — NFT Royalty Standard

**Sources**: [EIP-2981 formal spec](https://eips.ethereum.org/EIPS/eip-2981);
[ERC-2981 file on ethereum/ERCs](https://github.com/ethereum/ercs/blob/master/ERCS/erc-2981.md);
[OpenZeppelin Common contracts (ERC-2981 helpers)](https://docs.openzeppelin.com/contracts/4.x/api/token/common);
[Gemini overview](https://www.gemini.com/blog/exploring-the-nft-royalty-standard-eip-2981).

### What it is

The canonical **advisory** royalty interface for ERC-721/ERC-1155 tokens.
Authored September 2020 by Zach Burks, James Morgan, Blaine Malone, James
Seibel. Final. Interface ID: `0x2a55205a`
(`bytes4(keccak256("royaltyInfo(uint256,uint256)"))`).

### Interface surface (exact)

```solidity
pragma solidity ^0.6.0;
import "./IERC165.sol";

interface IERC2981 is IERC165 {
    // Called at sale time by marketplaces.
    // Returns who receives royalty and how much (in the same currency as salePrice).
    function royaltyInfo(uint256 _tokenId, uint256 _salePrice)
        external view
        returns (address receiver, uint256 royaltyAmount);
}
```

- Denominator is NOT standardized — OpenZeppelin's `ERC2981.sol` uses
  basis points (out of `_feeDenominator()`; default 10_000).
- Per-token override supported; falls back to default if unset.
- `supportsInterface(0x2a55205a)` must return true.

### Problem it solves

Provides a **uniform read interface** so any marketplace settling a sale can
call `royaltyInfo()` to learn the royalty recipient + amount without needing
custom per-collection logic. Before ERC-2981, each marketplace (OpenSea,
SuperRare, Foundation, Rarible) had incompatible custom royalty registries.

### Adoption signal

- Near-universal on L1 + L2 since 2022. All major marketplaces query it
  (OpenSea, Rarible, LooksRare, Foundation, Zora, Blur).
- Ships in OpenZeppelin, thirdweb, Manifold Studio, and virtually every
  contract wizard.
- Deployed on every EVM chain at the same address pattern (no official
  "registry contract" — the standard is purely a per-contract interface).

### Critical limitation — the standard is ADVISORY

> "NFT transfers don't always indicate sales, so royalty enforcement cannot be
> mandatory on transfer functions." (ERC-2981 Rationale)

The spec is **read-only**. Payment enforcement is the marketplace's choice.
OpenSea deprecated its Operator Filter enforcement tool on **September 1, 2023**,
and Blur plus LooksRare openly ignore royalties unless the seller opts in. In
2024-2025 actual royalty collection on secondary markets is roughly 0-2% of
sale value on average (down from a 5-10% nominal target) — the "royalty war"
was lost. See next two sections for enforcement history.

### Fit for ContributorNFT (score 3/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 5 | Yes — our ContributorNFT is an ERC-721 anyway; implementing 2981 is free |
| Rate DSL | 2 | Only supports a single flat percentage per token; no time/adoption variance |
| Immutability | 3 | Nothing blocks an owner from calling `_setDefaultRoyalty()` again unless we add our own lock |
| DAG split | 1 | Single `receiver` address per token — we'd need to point it at a splitter contract |
| Gas fit | 5 | Trivially cheap view call |

**Verdict**: **Adopt the interface, do not rely on its semantics.**

Concrete plan:
- Implement `royaltyInfo()` that returns `(splitterContract, aggregatedBps)`
  for marketplace compatibility — so if a ContributorNFT ever lists on
  OpenSea the resale royalty goes to the splitter that distributes to the
  DAG. This is defensive interop, not the primary revenue path.
- Our **primary** revenue path is `splitPayout()` called at job settlement,
  which does not need ERC-2981 at all.
- Override `_setDefaultRoyalty` / `_setTokenRoyalty` so they CANNOT increase
  bps above the RateSchedule ceiling for the current time bucket.

### Key gotcha

The `royaltyAmount` must be denominated in the **same currency as salePrice**.
Our splitter must handle this — if a future marketplace sells a
ContributorNFT for ETH, the royalty must be paid in ETH, not USDC. The PCC
settlement path always uses USDC, so this only matters on NFT-secondary sales.

---

## 02. EIP-5585 and Newer Royalty-Enforcement Proposals

**Sources**: [EIP-5585 formal spec](https://eips.ethereum.org/EIPS/eip-5585);
[EIP-5585 source on GitHub](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-5585.md);
[Fellowship of Ethereum Magicians discussion thread](https://ethereum-magicians.org/t/eip-5585-erc-721-nft-authorization-web3ip-management-proposal/10661).

### EIP-5585 is NOT about royalty enforcement (correction)

The task brief listed EIP-5585 as a "newer royalty-enforcement proposal."
This is a misconception. **EIP-5585 is an NFT authorization standard** that
separates ownership from commercial-use rights. It defines a `UserRecord`
struct (`(address user, uint256 rights, uint256 expires)`) so an NFT owner
can license specific commercial rights (display, derivative, distribution)
to a different address for a time-bounded period, with optional escrowed
fee logic.

Its relevance to our work is oblique but real:

- The `UserRecord` pattern is a template for separating **asset ownership**
  from **royalty beneficiary** — which matters if a ContributorNFT changes
  hands but the rights holder contractually remains the original author.
- The **escrow-refund pattern** (linear time-decay refund if the NFT
  transfers mid-authorization) is a nice reference for streamed royalty
  settlements. It's a read-worthy UX pattern, not a dependency.

### What actually replaced the "royalty enforcement" slot

After OpenSea sunset the Operator Filter (Sept 2023) and Blur/LooksRare
ignored it, the EIP landscape largely abandoned enforcement-at-transfer.
The direction taken was instead:

1. **Soulbound-by-default + transfer allowlist** — non-transferable unless
   a royalty-paying marketplace is explicitly whitelisted. Used by some
   creator tools, never formalized as an EIP.
2. **ERC-6551 (Token-Bound Accounts)** — make the NFT own a smart wallet,
   and route proceeds through that wallet to logic the creator controls.
   See section 10.
3. **Story Protocol / IP-onchain registries** — bypass ERC-721 semantics
   entirely, register an "IP asset" with on-chain programmatic license.
   See section 8.

There is currently **no "EIP-5585-style" final spec that enforces royalties
at the ERC-721 transfer layer**. The Ethereum Magicians thread for any
such proposal has been moribund since mid-2023. The community consensus is
that royalty enforcement must live **outside** ERC-721 (at a marketplace or
payment-channel layer).

### Fit for ContributorNFT (score 2/5)

EIP-5585 itself: not a dependency.

The **pattern** (separate ownership from usage rights) IS useful:
- Our RateSchedule is bound to the NFT, but the payout recipient is the
  current `ownerOf`. That's the simplest model.
- Optional future extension: let an author delegate "royalty beneficiary"
  to a different address (e.g., a DAO) without transferring the NFT. This
  is the EIP-5585 `UserRecord` shape.

**Verdict**: **Informational only.** Consider an optional `royaltyBeneficiary`
override in v2 of ContributorNFT, inspired by EIP-5585's separation-of-rights
pattern. Not needed for v1.

---

## 03. OpenSea / Rari / Manifold Royalty Registry + Operator Filter

**Sources**: [Manifold royalty-registry source repo](https://github.com/manifoldxyz/royalty-registry-solidity);
[Manifold docs](https://docs.manifold.xyz/manifold-for-developers/smart-contracts/royalty-registry);
[`RoyaltyEngineV1.sol` source](https://github.com/manifoldxyz/royalty-registry-solidity/blob/main/contracts/RoyaltyEngineV1.sol);
[OpenSea operator-filter repo (deprecated)](https://github.com/ProjectOpenSea/operator-filter-registry);
[CoinTelegraph: OpenSea deprecates Operator Filter](https://cointelegraph.com/news/opensea-disable-on-chain-royalty-enforcement-tool);
[The Defiant: CORI handover](https://thedefiant.io/opensea-cori).

### The Manifold Royalty Registry (relevant, still live)

Deployed at `0xad2184fb5dbcfc05d8f056542fb25b04fa32a95d` on Ethereum
mainnet (`royaltyregistry.eth`). Same address on every non-legacy EVM
chain. It provides a **unified multi-spec royalty lookup** so marketplaces
can ask one contract "what royalty do I owe for token X on collection Y"
regardless of which (pre-2981 or 2981) royalty format the collection uses.

### Interface surface (core read call)

```solidity
// RoyaltyEngineV1.sol
function getRoyalty(address tokenAddress, uint256 tokenId, uint256 value)
    public
    returns (address payable[] memory recipients, uint256[] memory amounts);

function getRoyaltyView(address tokenAddress, uint256 tokenId, uint256 value)
    public view
    returns (address payable[] memory recipients, uint256[] memory amounts);
```

Note: `getRoyalty()` is **state-changing** (writes a `_specCache` entry on
first call for each token contract). `getRoyaltyView()` is the pure read.

### Supported royalty specs (auto-detected)

1. EIP-2981
2. Rarible V1 / V2 (fee recipients + basis points)
3. Foundation
4. Manifold native
5. SuperRare
6. Zora (bid share conversion)
7. KnownOrigin V2
8. Royalty Splitter (EIP-2981 returning a splitter contract)
9. Fallback registry (for legacy contracts without native support)

The engine caches the detected spec per token contract in
`mapping(address => int16) _specCache`. Can be invalidated via
`invalidateCachedRoyaltySpec()` if a contract's implementation changes.

### Override pattern

The collection owner (OpenZeppelin `Ownable`) can call
`setRoyaltyLookupAddress(tokenContract, royaltyLookupAddress)` to point the
registry at a **third-party royalty lookup contract** — e.g. a splitter. This
is how creators add ERC-2981-style royalty behavior retroactively to
contracts deployed pre-2981.

### OpenSea Operator Filter Registry — dead

- Introduced Nov 2022. Let creators blocklist non-royalty-paying marketplaces
  (Blur, LooksRare v2, Dew) from transferring their tokens.
- Retired September 1, 2023. Control handed off to CORI (Creator Ownership
  Research Institute) briefly, then fully deprecated. The `operator-filter-registry`
  GitHub repo is read-only.
- Reasons for failure:
  - Blur & LooksRare routed trades through Seaport directly, bypassing the
    blocklist.
  - Operator filter UX was creator-hostile — wallets were blocklisted
    incorrectly, sales failed in non-obvious ways.
  - Community backlash: "enforcement via blocklist" felt un-crypto.
- Lesson: **transfer-layer royalty enforcement lost**. Any strategy that
  depends on blocking NFT transfers to enforce rates will not survive
  marketplace adversarial behavior.

### Fit for ContributorNFT (score 2/5)

- The **registry pattern** (one contract that knows where to look up
  royalties) is useful — in our system, the analog is `splitPayout()`
  walking the provenance DAG. No need to actually plug into Manifold's
  registry unless a ContributorNFT is resold on OpenSea.
- The **Operator Filter failure** is instructive:
  - Do not bet on blocking transfers to enforce rates.
  - Enforce rates **at the payment moment** (job settlement), not at the
    NFT transfer moment. This is what our `splitPayout()` does — funds
    flow through the PCC gateway settlement, which is the chokepoint we
    control.
  - ContributorNFTs should be freely transferable; the revenue split
    follows whoever holds the token at the block the settlement clears.

**Verdict**: **Implement ERC-2981 + optional Manifold registry override for
marketplace interop, but rely on our own settlement-time splitPayout as the
primary revenue path.** Do not adopt blocklist-style enforcement.

---

## 04. Drips (drips.network)

**Sources**: [Drips docs overview](https://docs.drips.network/the-protocol/overview/);
[drips-network/contracts](https://github.com/drips-network/contracts);
[Drips FAQ](https://docs.drips.network/faq/);
[User identities in Drips V2](https://v2.docs.drips.network/docs/the-protocol/user-identities-in-drips);
[Drip Lists](https://docs.drips.network/support-your-dependencies/overview/);
[Gitcoin Drips integration](https://gitcoin.co/apps/drips).

### What it is

Drips is the Radicle-incubated Ethereum protocol for **streaming funding and
splitting income across open-source dependency trees**. It encodes two
primitives we actually need:

1. **Streaming** — ERC-20 per-second flow, changeable at any time, balance-
   limited. Great for ongoing supporter-to-project subscriptions. (Less
   critical for us because PCC settlements are discrete events.)
2. **Splitting** — **whenever account X receives funds (streamed, given, or
   already-split), those funds are fractionally forwarded to a pre-configured
   list of receiver accounts.** This is the piece we want.

### How splitting works (the critical mechanism)

An account sets a `splitsConfig` — a list of `(receiver_id, weight)` tuples,
where weights sum to at most 1_000_000 (the percentage granularity). When
funds land in the account:

- The pre-configured fraction is immediately split to each receiver.
- Anything left over (up to `1_000_000 - sum_of_splits`) is **collectable**
  by the account owner — effectively "this portion I keep, the rest flows on."
- Recursion: each receiver is itself an account with its own `splitsConfig`,
  so funds flow down a **global dependency tree**. Drips describes this as a
  "single global splits graph."

This is **structurally identical to what we need** for DAG-provenance splits.

### Account hierarchy + drivers

Drips V2 uses a **driver-namespaced account ID system**:
- `accountId = (driver << 224) | sub_id`
- Drivers include: `AddressDriver` (sub_id = address), `NFTDriver`
  (sub_id = tokenId — splits follow an NFT), `ImmutableSplitsDriver`
  (splits set once at creation, then permanently locked), `RepoDriver`
  (sub_id = keccak256 of github repo URL, claimable by repo owner via
  Gelato-mediated GitHub verification).
- Accounts do not have to correspond to an Ethereum address. Any
  `accountId` can be a passive receiver; the driver determines who can
  claim/transfer.

### `ImmutableSplitsDriver` — the key feature for us

```solidity
// ImmutableSplitsDriver: creates a passive account whose splits are
// hard-coded at mint time and can NEVER be changed.
function createSplits(
    SplitsReceiver[] calldata receivers,
    AccountMetadata[] calldata accountMetadata
) public returns (uint256 accountId);
```

This is a bullet-proof commitment mechanism: once a project deploys an
`ImmutableSplits` account, the split configuration is permanent, on-chain,
and verifiable by anyone.

**This is a prior-art mirror of our "immutable RateSchedule" requirement.**

### Streams + splits key interfaces (approximate, from docs)

```solidity
// Drips.sol (excerpt)
function setSplits(uint256 accountId, SplitsReceiver[] calldata receivers) external;
function setStreams(
    uint256 accountId,
    IERC20 erc20,
    StreamReceiver[] calldata currReceivers,
    int128 balanceDelta,
    StreamReceiver[] calldata newReceivers,
    uint32 maxEndHint1,
    uint32 maxEndHint2,
    address transferTo
) external returns (int128 realBalanceDelta);
function give(uint256 accountId, uint256 receiver, IERC20 erc20, uint128 amount) external;
function squeezeStreams(
    uint256 accountId, IERC20 erc20, uint256 senderId,
    bytes32 historyHash, StreamsHistory[] calldata streamsHistory
) external returns (uint128 amount);
function split(uint256 accountId, IERC20 erc20, SplitsReceiver[] calldata currReceivers)
    external returns (uint128 collectableAmt, uint128 splitAmt);
function collect(uint256 accountId, IERC20 erc20, address transferTo)
    external returns (uint128 amount);

struct SplitsReceiver { uint256 accountId; uint32 weight; } // weight /1_000_000
```

### Gas cost notes

- `setSplits` is cheap (it stores a hash of the receivers).
- Every call to `split()` must re-provide the full `SplitsReceiver[]` list
  as calldata — this is the "receivers-as-calldata" pattern that makes
  storage cheap but calldata heavy for long lists.
- `squeezeStreams` is flagged in docs as "more expensive" — it accesses
  historical stream configs.
- Empirical: for a 10-receiver split, `split() + collect()` on Ethereum
  mainnet runs ~150-200k gas. On Base at 30 gwei that is ~$0.08 at
  $3500 ETH. **Within our target envelope.**

### Adoption signal

- Radicle / Drips has been operational since early 2022, V2 since 2023.
- Gitcoin's "Drip Lists" product adopted Drips as the backbone for
  dependency-aware grants distribution. Real dollars flowing.
- Used by Ethereum Foundation for some dependency funding experiments
  (per Drips case studies).
- Live on Ethereum mainnet, Base, Optimism, Filecoin EVM, plus testnets.

### Fit for ContributorNFT (score 5/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 4 | NFTDriver makes an NFT THE account ID for a splits config — close to our ContributorNFT |
| Rate DSL | 3 | Only static-percentage splits, not time-varying. Need our own RateSchedule on top |
| Immutability | 5 | `ImmutableSplitsDriver` is the exact commitment primitive |
| DAG split | 5 | Recursive-by-design. Receivers ARE accounts with their own splits |
| Gas fit | 4 | Acceptable on Base; heavy on mainnet if receivers list grows |

**Verdict**: **STRONG ADOPT**. Drips's splits primitive is a direct fit for
the split mechanism we need. The immutable splits driver is a near-match
for our immutability requirement.

### Concrete integration plan

1. Deploy a PCC-owned `Drips` instance on Base (or reuse the existing
   canonical Base deployment if available).
2. Mint ContributorNFTs via a custom driver that wraps `NFTDriver` +
   adds our RateSchedule on top. The NFT's account ID in Drips is
   `(NFTDriver << 224) | tokenId`. Funds directed at this account
   are automatically split per our DAG.
3. For immutability where we need it (e.g., after an adapter is marked
   "production"), lock the splits via `ImmutableSplitsDriver`-style
   pattern — either use Drips's own driver, or replicate its
   "hash commitment + revert on update" guard in our own driver.
4. Settlement path: `settleJob()` calls `Drips.give(payerAccount,
   rootCapabilityAccount, USDC, amount)`. The entire DAG split
   happens automatically on the next `split()` call per account.
5. Collection: each ContributorNFT holder calls `collect()` to pull
   accumulated funds. Gasless option: a PCC-operated keeper can batch-call
   `split()` + `collect()` for all contributors after each settlement,
   sponsored by a small protocol fee.

### Key gotchas

- Drips accounts are **passive by default**. Funds accumulate until the
  account owner (or anyone) calls `split()` + `collect()`. This is fine
  for us — contributors can claim at their own cadence — but UX needs
  to expose "claimable balance" clearly.
- Every `split()` call must re-submit the full `SplitsReceiver[]`, so the
  list is hashed and stored on-chain but expanded for each call. Keeping
  receiver lists short (<20 entries per account) is ideal. For our DAG,
  we'd split at each layer (adapter -> capability -> ...) rather than
  flattening, which also aligns with Drips's recursive structure.
- Drips V2 is **not upgradeable** (by design). Migration to a successor
  version requires a full protocol re-deployment. Factor this into our
  assumptions — we'd be building on a stable base.

---

## 05. 0xSplits

**Sources**: [Splits V2 docs](https://docs.splits.org/core/split-v2);
[splits-contracts-monorepo on GitHub](https://github.com/0xSplits/splits-contracts-monorepo);
[Splits V2 audits + architecture doc](https://github.com/0xSplits/splits-contracts-monorepo/blob/main/audits/splits-v2.md);
[0xSplits blog: Waterfalls](https://0xsplits.mirror.xyz/TQTsLgiRZ76-r3C_OvP7FyYaN3JIS1RanIrqTHrZ1EA);
[Diversifier blog](https://0xsplits.mirror.xyz/eZ1uAL3bIOd75LGcBXQEzOYE51wTHtCjNGsAD70rocg);
[Transient Labs explainer](https://support.transientlabs.xyz/en/articles/10593476-what-is-0xsplits-and-how-we-use-it-at-transient-labs);
[solidnoob protocol breakdown](https://www.solidnoob.com/blog/0xSplits).

### What it is

**0xSplits (now Splits Protocol)** is the widely-adopted "small clone
contract per revenue-split" pattern. Artists, DAOs, NFT collections, and
creator groups use it to create on-chain payment splitters with deterministic
shares. Used by Zora, Nouns, Manifold, Sound, Transient Labs, and many
others.

### V1 (legacy) vs V2

**V1 model (PaymentSplitter analog)**:
- Factory deploys a minimal-proxy (EIP-1167) `Split` contract.
- `Split` contract is a payable wallet. Funds arrive via `receive()` /
  direct transfer.
- To distribute: anyone calls `distributeETH()` or `distributeERC20()`,
  passing the current recipients + shares (hashed on-chain).
- Recipients pull their share via `withdraw()`.
- Shares are stored via `keccak256` hash commitment, not full state. Saves
  significant gas. Controller (mutable splits) or zero-address (immutable)
  can update the hash.

**V2 model (ERC-6909 warehouse + split wallets)**:
- Introduces a shared **Warehouse** contract — an ERC-6909 compliant token
  warehouse that any contract can deposit into / withdraw from.
- `Split` contracts become simpler — they just hold the share config and
  push/pull tokens between themselves and the Warehouse.
- Two distribution modes:
  - **PullSplit**: funds land in Warehouse, recipients pull. Lower gas per
    `distribute`. Best when recipients are responsible for claiming.
  - **PushSplit**: funds push directly to recipients on distribution. Gas-
    capped per recipient; failed pushes fall back to Warehouse. Best when
    recipients are EOAs you trust.

### Key interface surface (V2)

```solidity
// SplitV2Lib.Split config struct
struct Split {
    address[] recipients;
    uint256[] allocations;    // sum must equal totalAllocation
    uint256 totalAllocation;  // e.g., 1e6 for ppm precision
    uint16 distributionIncentive; // bps of distributed amount paid to msg.sender
}

// SplitFactoryV2
function createSplit(Split calldata split, address owner, address creator)
    external returns (address splitAddress);

function createSplitDeterministic(
    Split calldata split, address owner, address creator, bytes32 salt
) external returns (address splitAddress);

// PullSplit / PushSplit (both share this surface)
function distribute(
    Split calldata split,
    IERC20 token,
    address distributor
) external;

function updateSplit(Split calldata split) external; // onlyOwner
function execCalls(Call[] calldata calls) external payable; // onlyOwner escape hatch

// Warehouse (ERC-6909)
function deposit(address receiver, IERC20 token, uint256 amount) external;
function withdraw(address owner, IERC20 token) external;
function balanceOf(address owner, uint256 id) external view returns (uint256);
```

### Immutability model

- Set `owner = address(0)` at creation -> split is **permanently
  immutable**. No one can call `updateSplit()`.
- Set `owner = <controller>` -> split is mutable; `controller` can rotate
  the recipient set via `updateSplit()`.
- This is **per-split, not per-recipient** — all or nothing.

### Waterfall (tiered payouts)

`WaterfallModule` is a separate 0xSplits contract that distributes funds
to recipients in tiers with thresholds:

```solidity
struct WaterfallModule {
    // Each tier gets up to `threshold` before the next tier sees any funds
    address[] recipients;
    uint256[] thresholds; // recipients[i] caps out at thresholds[i]
    address residualRecipient;
}
```

Use case: revenue share where early recipients are capped at a dollar
amount, and any excess flows to a residual catch-all. Composable — a tier
recipient can itself be a Split contract, which itself can feed another
Waterfall.

### Diversifier (swap-on-receipt)

`Diversifier` = Split -> Swappers -> recipients. Automatically swaps a
portion of incoming income into a different token (e.g., ETH -> USDC) via
0x / Uniswap before distributing. Useful as a built-in hedge: "I want 30%
of my share in stablecoin on receipt."

### Adoption signal

- Deployed on Ethereum, Base, Optimism, Arbitrum, Polygon, Zora, Blast,
  and ~15 other EVM chains.
- Used by major NFT collectives (Nouns, Zora Mint, Sound.xyz, Transient
  Labs, Manifold, Friends With Benefits DAO, etc.).
- Processes billions in lifetime volume per the 0xSplits dashboard.
- The V2 architecture is audited by Spearbit and Macro — public audit
  reports available in the monorepo.

### Gas cost notes

- PullSplit distribute: ~50-80k gas for 5 recipients (stores in Warehouse).
- PushSplit distribute: ~30k gas overhead + ~25k per recipient for ETH
  sends, or ~35k per recipient for ERC-20 transfers. Hard-capped at
  `MAX_GAS_PER_PUSH` per recipient to prevent griefing.
- Recipient `withdraw` from Warehouse: ~40k gas.
- Deterministic `createSplit`: ~200k gas (one-time).

On Base at 30 gwei: a PullSplit distribute over 10 recipients costs roughly
$0.02-0.04. **Well within target.**

### Fit for ContributorNFT (score 5/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 2 | Split contracts are NOT NFTs — ownership is an address. We'd wrap them |
| Rate DSL | 2 | Static allocations only; no time/adoption variance |
| Immutability | 5 | `owner = 0` is production-proven immutability |
| DAG split | 5 | Composable — a recipient can be another Split, enabling recursion |
| Gas fit | 5 | Among the most gas-efficient splitter designs on EVM |

**Verdict**: **STRONG ADOPT as the per-node splitter primitive.**

### Concrete integration plan (alternative to full-Drips)

Option A (hybrid): each ContributorNFT owns (via ERC-6551 token-bound
account, see section 10) a Split contract. The ERC-6551 account IS the
recipient address in the parent Split. Children in the DAG are also Split
addresses. Settlement path:

1. `settleJob()` transfers USDC to the root capability's Split.
2. Anyone (or a keeper) calls `distribute(token=USDC)` on the root Split.
3. Funds flow to children (which are themselves Splits) per allocation.
4. Each child Split's `distribute()` is called in turn (can be batched).
5. Leaves are ContributorNFT-owned 6551 accounts; contributors `withdraw()`
   from the Warehouse.

**Immutability**: each Split is deployed with `owner = 0`, tying the split
shares to the specific DAG snapshot. If the DAG mutates, we mint a NEW
ContributorNFT with a NEW Split for the new version — old splits keep
their old shares. This matches the "commit-don't-mutate" pattern we want.

**Rate schedule overlay**: the Split's allocations are static, but our
RateSchedule lives on ContributorNFT and gates how much USDC the root
settlement commits (i.e., RateSchedule decides total bps of job value,
Split decides how that bps-pool is divided internally).

### Key gotchas

- 0xSplits V2 is a 2023-2024 architecture; some chains might still only
  have V1 deployed. Verify Base deployment before committing.
- The `distributionIncentive` parameter pays a bps fee to whoever triggers
  `distribute()`. Useful for keeper economics.
- `execCalls()` is an owner-only escape hatch — if owner != 0, owner can
  drain the split via arbitrary calls. For immutable splits this is fine
  (`owner = 0`). For mutable splits, be aware that the owner can rug.
- The Warehouse is a single global contract per chain; its security is
  a systemic dependency. Spearbit-audited but still worth self-review.

---

## 06. Superfluid

**Sources**: [Superfluid overview docs](https://docs.superfluid.org/docs/concepts/superfluid);
[Super Tokens](https://docs.superfluid.org/docs/concepts/overview/super-tokens);
[General Distribution Agreement (GDA) wiki](https://github.com/superfluid-org/protocol-monorepo/wiki/General-Distribution-Agreement);
[ACL Features](https://docs.superfluid.finance/superfluid/developers/interactive-tutorials/acl-features);
[CFA ACL README](https://github.com/superfluid-finance/docs/blob/main/developers/constant-flow-agreement-cfa/cfa-access-control-list-acl/README.md);
[Superfluid protocol V1 overview](https://github.com/superfluid-org/protocol-monorepo/wiki/Superfluid-Protocol-V1-Overview);
[How to design distribution pools](https://docs.superfluid.org/docs/protocol/distributions/guides/pools).

### What it is

**Superfluid** is the original real-time streaming protocol on Ethereum.
Wraps any ERC-20 into a **Super Token** (ERC-20 extension) with per-second
balance accounting. Once you have Super USDC (USDCx), you can open a
**Constant Flow Agreement (CFA)** that sends tokens to a recipient at
`wei/second` — the recipient's balance increases every second with no gas
consumed, until either side cancels.

### Core agreement types

1. **CFA — Constant Flow Agreement**: one-to-one or one-to-many linear
   streams. `setFlow(sender, receiver, flowRate)`. Pure state accounting;
   no on-chain events per-second. A sender can have N outgoing streams
   summing up to their available balance.
2. **IDA — Instant Distribution Agreement** (V1): one-to-many proportional
   distribution of a lump sum. You create a "pool," grant "units" to
   subscribers, then call `distribute(amount)` — each subscriber
   instantly gets `amount * (units[i] / total_units)`. Gas cost is
   O(1) regardless of number of subscribers.
3. **GDA — General Distribution Agreement** (V2, superseded IDA): adds
   **many-to-many streaming distributions**. A pool has units per
   subscriber; multiple senders can stream into the pool; each
   subscriber receives a pro-rata portion of the combined stream. This is
   the piece relevant to us.

### General Distribution Agreement (GDA) — the important one

- Create a pool: `SuperfluidPool pool = gda.createPool(admin, token)`.
- Admin grants units: `gda.updateMemberUnits(pool, member, units)`.
- Senders stream into pool: `gda.distributeFlow(token, sender, pool, flowRate)`.
- Pool members can claim accumulated streamed tokens any time:
  `gda.claimAll(pool, member)`.
- All share math is O(1) — constant gas regardless of member count.

### Access Control List (ACL) — stream operator delegation

Any account can grant an operator permission to open/update/close streams
on its behalf, with optional per-stream `flowRateAllowance`:

```solidity
// ConstantFlowAgreementV1 (host-wrapped)
function authorizeFlowOperatorWithFullControl(ISuperToken token, address flowOperator, ...)
function updateFlowOperatorPermissions(
    ISuperToken token, address flowOperator, uint8 permissions, int96 flowRateAllowance, ...
) external;
```

### Super Tokens

- Wrapper mode: wrap ERC-20 (USDC) into SuperUSDC (USDCx), unwrap back.
- Native mode: deploy a new Super Token directly with distribution logic
  baked in (used by Gitcoin, Optimism retroactive funding, and similar).

### Adoption signal

- Used by Optimism (governance-stream RetroPGF disbursals), Ricochet
  Exchange, Gnosis DAO, and dozens of other DAOs for ongoing team
  payroll and grant streaming.
- Deployed on Ethereum, Polygon, Gnosis, Base, Optimism, Arbitrum,
  Avalanche, Celo, BNB Chain. Canonical addresses per chain.

### Fit for ContributorNFT (score 3/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 2 | Super Tokens and GDA pools are not NFTs. Pool membership is by address |
| Rate DSL | 4 | Flow rates are THE time-rate DSL — continuous, pro-rata, well-primitive |
| Immutability | 3 | Unit allocations are mutable by the pool admin. No built-in lock. |
| DAG split | 3 | GDA handles one pool's many members; DAG nesting requires manual routing |
| Gas fit | 3 | Per-settlement, a `distributeFlow` is O(1); but our settlement model is DISCRETE not streaming |

**Verdict**: **Partial fit — useful for a future streaming tier, not v1.**

### Why it's not the primary mechanism for us

PCC settlements are **discrete**: a job runs, evidence validates, escrow
releases, done. Streaming is not a natural fit for a job-by-job settlement
flow. Superfluid shines when there's a continuous relationship — ongoing
operator payroll, continuous retroactive funding — not for discrete job
payouts.

However, there are interesting secondary uses:

1. **Operator stipends**: PCC could stream a small baseline retainer to
   active kernel operators. Sum of all operator streams <= Treasury's
   outflow capacity. This is a governance primitive, not a contributor
   revenue primitive.
2. **Protocol revenue to ContributorNFT v2**: If we later want
   "subscription-like" revenue (e.g., a training dataset NFT earns a
   constant flow from every active kernel that loaded it), GDA is the
   right primitive. This is a future extension.

### Concrete gotchas

- Super Tokens are **not** USDC — they're wrapped USDCx. Every PCC
  settlement would need to wrap USDC -> USDCx first, or we'd need to
  redenominate settlements in USDCx. Adds a wrap/unwrap UX tax.
- Running out of sender balance causes a **liquidation**: a keeper
  network (Superfluid Sentinels) closes the insolvent stream and
  collects a penalty. Clever, but an operational burden we'd inherit.
- The "pool admin" role in GDA is a permissioned key — if we use GDA
  for contributor revenue, the admin can rotate unit allocations. We'd
  need to burn the admin key for immutability, which Superfluid doesn't
  directly support (you'd have to deploy a custom contract as the admin
  and make IT immutable).

---

## 07. Sablier

**Sources**: [Sablier V2 launch post](https://blog.sablier.com/introducing-sablier-v2/);
[Sablier V2 Lockup docs](https://docs.sablier.com/contracts/v2/guides/create-stream/lockup-linear);
[Cyfrin 2024-05-Sablier audit repo](https://github.com/Cyfrin/2024-05-Sablier);
[Sablier V2 Lockup Linear NFT on Etherscan](https://etherscan.io/token/0xafb979d9afad1ad27c5eff4e27226e3ab9e5dcc9);
[Turning Sablier streams into collateral](https://blog.sablier.com/turning-fixed-yield-into-collateral-with-sablier-streams/).

### What it is

**Sablier V2** is a time-locked streaming protocol where **each stream is
an ERC-721 NFT whose owner is the recipient**. Unlike Superfluid's
pay-per-second flow model, Sablier V2 streams are a fixed deposit amount
unlocked over a defined curve. If the NFT is transferred, the right to
withdraw remaining unlocked funds transfers with it. Streams are tradable
on any NFT marketplace, usable as DeFi collateral, etc.

### Stream lockup types

1. **LockupLinear**: Linear unlock from `startTime` to `endTime`, with an
   optional cliff. `unlocked(t) = amount * (t - start) / (end - start)`.
   Most common. Used for vesting schedules, payroll, etc.
2. **LockupDynamic**: Segment-based unlock curve — you pass an array of
   `(amount, exponent, milestone)` tuples that define arbitrary non-linear
   unlocks. Exponent >1 = backloaded, <1 = frontloaded, =1 = linear
   (equivalent to LockupLinear within a segment). Enables exponential,
   cliff-then-linear, arbitrary step functions, etc.
3. **LockupTranched** (added V2.1): Discrete unlock tranches at specific
   timestamps. Simple vesting with quarterly unlock dates, etc.

### Core interface surface

```solidity
// ISablierV2LockupLinear
struct CreateWithDurations {
    address sender;
    address recipient; // becomes NFT owner
    uint128 totalAmount;
    IERC20 asset;
    bool cancelable;
    bool transferable;
    Durations durations; // cliff duration, total duration
    Broker broker;
}
function createWithDurations(CreateWithDurations calldata params) external returns (uint256 streamId);

// ISablierV2Lockup (shared)
function withdraw(uint256 streamId, address to, uint128 amount) external;
function withdrawableAmountOf(uint256 streamId) external view returns (uint128);
function cancel(uint256 streamId) external;
function transferFrom(address from, address to, uint256 streamId) external; // it's an ERC-721
```

### NFT-as-stream pattern (the interesting part for us)

- Stream ID = NFT tokenId.
- `ownerOf(streamId)` = current recipient.
- Transfer the NFT -> the new owner can withdraw remaining unlocked funds.
- NFT metadata is on-chain-generated SVG hourglass (updates as stream
  progresses — artistically neat).
- `cancelable` / `transferable` flags at creation control downstream UX.

### Adoption signal

- Deployed on Ethereum, Arbitrum, Avalanche, Base, BNB, Gnosis, Linea,
  Optimism, Polygon, Scroll, Blast, Berachain, many more.
- Used by major DAOs for vesting (Uniswap, ENS, Superfluid team tokens),
  grants programs, and contributor payrolls.
- Cyfrin public audit (May 2024) + multiple previous audits by Spearbit,
  Cantina.

### Fit for ContributorNFT (score 4/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 5 | Sablier V2 IS an ERC-721 stream carrier. Exactly our shape |
| Rate DSL | 4 | LockupDynamic supports arbitrary segment curves — closest thing to a programmable rate schedule in prior art |
| Immutability | 4 | `cancelable=false` + `transferable=true` = immutable stream + transferable NFT. Very close to our needs |
| DAG split | 1 | Single recipient per stream. No split primitive. |
| Gas fit | 3 | Creating a stream is ~200-300k gas. Withdraws ~60-80k. OK |

**Verdict**: **BORROW PATTERNS, DO NOT ADOPT DIRECTLY.**

### What to borrow

1. **NFT-as-stream-carrier**: ERC-721 where `tokenId` IS the stream/schedule
   identifier. Transferable rights. Exactly our pattern — Sablier validates
   this design shape.
2. **LockupDynamic segment curve**: array of `(amount, exponent, milestone)`
   for non-linear unlocks. **This is a viable DSL shape for our
   RateSchedule** — see section 11 for a deeper analysis of rate DSLs.
3. **`cancelable` / `transferable` flags** at creation: the immutability
   pattern is explicit at mint.
4. **On-chain SVG metadata**: the ContributorNFT could render an on-chain
   SVG that shows current rate + total claimed — solves the "tokenURI
   must be a content hash" problem (see section 13) for a subset of
   metadata that's purely derived from on-chain state.

### Why not adopt directly

- Sablier is **one-payer-to-one-recipient** — there's no split primitive
  or pool. We'd need to build a splitting layer on top.
- Sablier streams are **a fixed deposited amount** that unlocks — our
  model is "pay-as-you-go per settlement," which is conceptually
  different. We could adapt by streaming the RateSchedule bps rather
  than the tokens, but that's not what Sablier is for.
- Sablier's lockup semantics assume **pre-funding**; we settle on demand.

### Key gotcha

Sablier streams can be made "transferable=false" -> soulbound. That's
opposite our design goal (we want ContributorNFTs freely tradable).
Be sure to set `transferable=true` if we ever mint through Sablier for
anything.

---

## 08. Story Protocol — PIL / IP Graph / Royalty Module

**Sources**: [Story Protocol docs](https://docs.story.foundation/);
[Story whitepaper](https://www.story.foundation/whitepaper.pdf);
[Datawallet explainer](https://www.datawallet.com/crypto/story-protocol-explained);
[Proof-of-Creativity primer](https://learn.story.foundation/proof-of-creativity-protocol);
[KuCoin IP tokenization overview](https://www.kucoin.com/learn/crypto/what-is-story-ip-and-how-does-it-work);
[blocmates idiot's guide](https://www.blocmates.com/articles/an-idiot-s-guide-to-story-protocol-the-world-s-ip-blockchain).

### What it is

**Story Protocol** is a purpose-built L1 blockchain for on-chain IP
registration, licensing, and derivative-royalty enforcement. Launched
mainnet in 2024 (Story Network). Backed by a16z, Polychain. Core
abstractions:

1. **IP Asset** — an on-chain record of a piece of IP (a song, character,
   dataset, software). Each IP Asset is bound to an **IP Account**
   (an ERC-6551 token-bound smart wallet — see section 10).
2. **Programmable IP License (PIL)** — an off-chain legal template
   (human-readable + machine-encoded) that defines how an IP can be
   licensed: commercial rights, derivative rights, attribution
   requirements, revenue shares. The PIL is a real legal document AND
   a smart contract.
3. **License Tokens** — transferable ERC-721 tokens representing an
   executed PIL license. Hold a License Token -> you have the rights
   defined in the PIL.
4. **IP Graph** — a global DAG of IP Assets, where each node can be
   marked as a derivative of one or more parent IP Assets. The graph is
   on-chain and queryable.
5. **Modules** — pluggable contracts that interact with IP Assets:
   Licensing Module, Royalty Module, Dispute Module, and custom modules.

### Royalty Module (the relevant part)

> "The Royalty Module manages revenue distribution between child IP
> Assets and their ancestor IP Assets. This allows IP holders, as
> licensors, to define the percentage of revenue that a child IP must
> pay to its parent IP."

Key mechanics:
- When a derivative IP Asset is registered, it inherits a **royalty
  policy** from the PIL of its parent.
- On revenue events (e.g., a sale, a license execution, or a protocol-
  defined "usage event"), revenue is deposited into the derivative's
  **IP Royalty Vault** — a per-asset vault that auto-distributes to
  ancestors per policy.
- Policies are built-in: LRP (Liquid Royalty Policy), LAP (Liquid
  Absolute Percentage). Custom policies pluggable.

### IP Graph semantics — THE key primitive

- `registerDerivative(childIpId, parentIpIds[], licenseTokenIds[])` —
  declares a new derivative with one or more parents. On-chain DAG.
- The Royalty Module **recursively** traverses the parent chain to
  distribute revenue. `claimRoyalty(childIpId)` can pull royalties
  from descendants up to the claimant.
- Circular derivatives forbidden (DAG enforced).
- An IP Asset's "ancestor count" is capped (in practice, ~8-10 levels) to
  bound gas.

### Modules + Hooks

Every IP Account has an `execute()` function that can call arbitrary
modules. Modules can register **hooks** that fire on licensing events,
royalty distributions, or custom triggers. Developers can write new
modules for domain-specific logic (e.g., time-varying royalty rates,
adoption-based rates) and register them on-chain.

### Adoption signal

- Mainnet live, trading under $IP token.
- Partnerships with several IP holders (animation studios, music labels,
  licensing brokerages).
- Filecoin ecosystem usage: Storacha-backed datasets registered as IP
  Assets for provenance.
- Currently NOT an ecosystem of application devs — most IP Assets are
  bespoke licensee deals. The developer tooling is early.

### Fit for ContributorNFT (score 4/5 — with caveat)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 5 | IP Asset + IP Account is a perfect carrier for a contributor-owned reusable component |
| Rate DSL | 3 | Built-in royalty policies are flat %. Custom modules can do more, but at build cost |
| Immutability | 4 | PIL is legally binding and immutable per license token; deeper immutability requires custom module |
| DAG split | 5 | IP Graph + recursive royalty traversal is EXACTLY our DAG split model |
| Gas fit | 3 | Lives on Story Network (L1), not Base. Cross-chain dependency. |

**Verdict**: **PARTIAL ADOPT — leverage IP Graph semantics as design
template; do not necessarily deploy on Story Network.**

### Two integration paths

**Path A (lean): IP-Graph-as-template**
- Do not deploy on Story Network.
- Copy the IP Graph semantics (derivative DAG, parent-chain royalty
  traversal) into our own Solidity contracts on Base.
- Explicitly cite Story Protocol as the design reference.
- Pros: stays on Base where settlement happens; no cross-chain bridging.
- Cons: we miss the PIL legal framework, which might matter for
  off-chain enforceability.

**Path B (deep): mirror contributions as Story IP Assets**
- Every PCC contribution (adapter, capability, dataset, model) is
  ALSO registered as an IP Asset on Story Network with an appropriate
  PIL license.
- Cross-chain messaging (LayerZero / Wormhole) relays "this job used
  IP Asset X" events to Story Network, where the Royalty Module handles
  settlement.
- Pros: legal enforceability via PIL; reuses battle-tested royalty
  module; aligns with broader creator-IP movement.
- Cons: Story Network is a separate chain (added latency, bridging
  complexity); users need to hold tokens on both Base + Story.

**Recommendation**: Path A for v1. Path B as a v2 integration when Story
tooling matures and cross-chain UX smoothens. The core insight we adopt
IMMEDIATELY is the IP Graph recursive-royalty-traversal model.

### PCC context note — we already use Story Protocol selectively

PCC already has `/api/ip/*` routes (`pcc_ip_register_capability`,
`pcc_ip_revenue_snapshot`, `pcc_ip_claim`, `pcc_ip_lineage`,
`pcc_ip_set_splits`) — CSD (Capability StructureDefinition) documents
can be registered as IP Assets on Story. This is Path B already, but
limited to CSD schemas, not contributor-split revenue. Expansion to
ContributorNFT-on-Story is natural.

### Key gotchas

- Story's royalty module is **currency-specific**: each IP Asset's royalty
  vault handles one ERC-20 at a time (typically $IP or WIP). Cross-
  currency settlement requires wrappers.
- The **8-10 level ancestor cap** on recursive royalty traversal is a
  practical limit. Our DAG depth per robotics job is typically 3-5
  (adapter -> capability -> dataset -> model), so we're within budget,
  but design with depth in mind.
- PIL is a **legal instrument** — misconfiguring a commercial-use license
  could expose creators to unintended legal terms. Requires legal review
  if we mirror contributions to Story.

---

## 09. EIP-2535 Diamond Standard

**Sources**: [EIP-2535 formal spec](https://eips.ethereum.org/EIPS/eip-2535);
[QuickNode part 1 guide](https://www.quicknode.com/guides/ethereum-development/smart-contracts/the-diamond-standard-eip-2535-explained-part-1);
[RareSkills diamond proxy primer](https://rareskills.io/post/diamond-proxy);
[Zealynx glossary](https://www.zealynx.io/glossary/diamond-standard);
[Safe Edges Medium deep dive](https://safe-edges.medium.com/understanding-the-diamond-proxy-pattern-eip-2535-safe-edges-a6b2fe3c85f3).

### What it is

EIP-2535 Diamond Standard: a proxy pattern where one address can delegate
function calls to **many** implementation contracts (called **facets**).
Works around the 24KB contract size limit and enables modular upgrades.

### Core mechanism

- Central Diamond proxy has one storage area shared across all facets.
- A function-selector -> facet-address mapping routes each incoming call
  via DELEGATECALL to the correct facet.
- `diamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata)` —
  adds/replaces/removes facets. Typically gated by access control
  (owner, DAO, etc.).
- `IDiamondLoupe` interface for introspection: list facets, list
  selectors per facet, etc.
- Facets are themselves plain Solidity contracts with no constructor
  storage writes (storage lives in the Diamond).
- "Diamond Storage" pattern uses `keccak256`-derived storage slots to
  isolate each facet's state, preventing collisions.

### What EIP-2535 is NOT

- Not a royalty standard.
- Not a split standard.
- Not a rate-schedule DSL.

It's a **contract architecture** primitive. Its relevance to us is
purely: "Can ContributorNFT be a Diamond, with RateSchedule + splits +
metadata as swappable facets?"

### Fit for ContributorNFT (score 2/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 3 | A Diamond CAN expose ERC-721; extra complexity for ContributorNFT-as-Diamond |
| Rate DSL | 3 | Facets could host rate logic, but we need immutability per-NFT, not per-facet |
| Immutability | 2 | Core Diamond value prop is upgradability — opposite of our requirement. Can be neutered by revoking diamondCut, but then why use Diamond? |
| DAG split | 1 | Unrelated |
| Gas fit | 2 | Diamonds add a SLOAD per call for the facet lookup. Small overhead but real |

**Verdict**: **DO NOT ADOPT.**

### Why we should skip Diamond

The core value of Diamond is *upgradability without storage migration*.
Our ContributorNFT must be the OPPOSITE: once minted, the RateSchedule
and split configuration cannot be changed. Using Diamond and then
freezing `diamondCut` to enforce immutability gets us the worst of
both worlds — Diamond overhead without Diamond benefit.

### Narrow cases where Diamond MIGHT help

- **Registry contract**: the `ContributorNFTRegistry` that mints new
  ContributorNFTs, manages the provenance DAG, runs `splitPayout()`,
  etc. COULD be a Diamond so we can upgrade splitter logic, add new
  rate DSL types, or extend settlement hooks without redeploying.
- **But**: the registry is a stateful governance contract that will
  change over time. A transparent upgradeable proxy (UUPS) or just a
  thorough off-chain deployment pipeline achieves the same goal with
  less complexity.

### Recommendation

Use a simple OpenZeppelin ERC-721 for ContributorNFT. Use a UUPS upgradeable
proxy for the registry if we want upgradability at all. **Skip Diamond.**

### Key gotcha

If anyone on the team has been researching "Diamonds" as an option, the
Aavegotchi-style Diamond codebases are a siren song — heavy to audit,
non-trivial deployment, and not needed for a ContributorNFT.

---

## 10. ERC-6551 — Non-fungible Token Bound Accounts

**Sources**: [EIP-6551 formal spec](https://eips.ethereum.org/EIPS/eip-6551);
[thirdweb explainer](https://blog.thirdweb.com/erc-6551-token-bound-accounts/);
[RareSkills ERC-6551 deep dive](https://rareskills.io/post/erc-6551);
[GoldRush complete guide](https://goldrush.dev/guides/a-complete-guide-to-erc-6551-token-bound-accounts/);
[Quicknode deploy guide](https://www.quicknode.com/guides/ethereum-development/nfts/how-to-create-and-deploy-an-erc-6551-nft).

### What it is

ERC-6551 assigns an Ethereum smart-contract account (Token Bound Account, TBA)
to every NFT. The TBA is a fully-featured smart wallet owned by the NFT's
current `ownerOf`. Transferring the NFT transfers control of the TBA.

Mainnet launch: May 7, 2023. Backwards-compatible with all existing ERC-721
contracts (no changes required).

### Architecture

Three contracts:

1. **`ERC6551Registry`** — singleton deployed at a canonical address on
   every chain. Computes deterministic TBA addresses via `CREATE2`.
2. **`IERC6551Account` implementation** — the TBA's logic contract. Many
   implementations exist (Tokenbound's canonical one, thirdweb's, custom
   ones that add features like batch calls or EIP-1271 signing).
3. **Each TBA instance** — an ERC-1167 minimal proxy to a chosen
   implementation. Bytecode has `(chainId, tokenContract, tokenId, salt)`
   appended as constant data; the proxy reads this to answer
   `token()` queries.

### Registry interface (exact)

```solidity
interface IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address account);
}
```

### Account interface (exact)

```solidity
interface IERC6551Account {
    receive() external payable;
    function token() external view
        returns (uint256 chainId, address tokenContract, uint256 tokenId);
    function state() external view returns (uint256);
    function isValidSigner(address signer, bytes calldata context)
        external view returns (bytes4 magicValue);
}

interface IERC6551Executable {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external payable returns (bytes memory);
}
```

`operation` modes: 0 = CALL, 1 = DELEGATECALL, 2 = CREATE, 3 = CREATE2.

### Ownership semantics

`owner()` is typically implemented as `IERC721(tokenContract).ownerOf(tokenId)`.
When the NFT changes hands, the TBA's owner changes automatically — no
migration needed.

### Fit for ContributorNFT (score 5/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 5 | Gives each ContributorNFT its own wallet — holds earnings, signs attestations, interacts with other contracts |
| Rate DSL | 3 | Not a rate DSL itself; enables rate logic to live in the TBA's implementation |
| Immutability | 4 | TBA implementation is fixed per ERC-6551 proxy; fresh implementation requires new salt -> new TBA address. Useful for versioning |
| DAG split | 4 | TBA can be the endpoint for 0xSplits / Drips distributions, cleanly wrapping per-contributor state |
| Gas fit | 4 | Registry call ~200k gas one-time. TBA-as-recipient adds minimal overhead on settlements |

**Verdict**: **ADOPT — ContributorNFT grants a TBA to each contributor.**

### Concrete integration plan

1. On `mint(contributor)`, also call `ERC6551Registry.createAccount(...)` to
   deploy the contributor's TBA. The TBA address is deterministic so we
   can predict it off-chain without a second tx.
2. The TBA holds:
   - **Accumulated settlement earnings** (USDC balance)
   - **Reputation proofs** (ERC-8004 attestations from PCC jobs that used
     the contribution)
   - **Subsidiary ContributorNFTs** the author has composed (e.g., a
     "model" author could hold ContributorNFTs for each dataset they
     used, with splits flowing to them)
3. When a ContributorNFT transfers, the TBA's contents transfer with it —
   no migration script, no storage sync.
4. Splits: the recipient in the `SplitV2` / Drips config points at the
   TBA address, not the contributor's EOA. This cleanly decouples
   "who can sign for the contributor" (NFT owner) from "where revenue
   pools up" (TBA).

### Key gotchas

- **Ownership cycle risk**: if the ContributorNFT is transferred INTO its
  own TBA, the TBA becomes permanently unreachable (no signer can be
  derived). Must block this at the NFT contract level via a
  `_beforeTokenTransfer` hook that rejects transfers to any
  `isTokenBoundAccount(address, tokenId)`.
- **Front-running on sale**: a malicious seller can drain the TBA between
  a marketplace listing and the sale clearing. Marketplaces now support
  a "TBA-aware" sale (Seaport 1.6, Reservoir, Zora v3 all have this) but
  the UX is still inconsistent. Protect our users by documenting TBA
  contents in the listing flow.
- **Gas griefing**: `execute()` with an untrusted `to` can be used to
  mount gas bombs. Our canonical implementation should include
  reasonable gas caps.

### Why pair ERC-6551 + 0xSplits together

- 0xSplits recipients are addresses, not NFTs. The TBA is an address
  uniquely tied to a ContributorNFT. Perfect bridge.
- ERC-6551 without 0xSplits: we'd have to build our own recipient
  registry.
- 0xSplits without ERC-6551: recipient becomes a fresh EOA or a
  shared multisig, losing per-contributor attestation/reputation
  state.
- Combined: `Split -> TBA_A, TBA_B, TBA_C` where each TBA is bound
  to a ContributorNFT. Elegant.

---

## 11. Rate-Schedule DSLs — Prior Art

**Goal for this section**: evaluate existing on-chain "committed schedule"
primitives as templates for our RateSchedule DSL. Options examined:
Uniswap v3 ticks, Balancer weighted pool time-varying weights, Curve's
piecewise curves, and Sablier LockupDynamic segments.

**Sources**: [Uniswap v3 ticks primer](https://rareskills.io/post/uniswap-v3-ticks);
[Atis Elsts — Uniswap v3 liquidity math PDF](https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf);
[Balancer Weighted Math](https://docs.balancer.fi/concepts/explore-available-balancer-pools/weighted-pool/weighted-math.html);
[Balancer docs repo — weighted-math.md](https://github.com/balancer/docs-developers/blob/main/resources/pool-math/weighted-math.md);
[Curve bonding-curve primer — Linum Labs](https://www.linumlabs.com/articles/bonding-curves-the-what-why-and-shapes-behind-it);
[Sablier V2 LockupDynamic docs](https://docs.sablier.com/contracts/v2/guides/create-stream/lockup-linear).

### 11.1 Uniswap v3 ticks (informative shape, overkill for us)

Uniswap v3 discretizes prices into integer **ticks** where
`price(i) = 1.0001^i` for `i` in `[-887272, 887272]`. Each liquidity
position occupies a `[tickLower, tickUpper]` range. On-chain math uses
`sqrtPriceX96` fixed-point arithmetic for precision.

**Pros as rate-schedule template**:
- Discrete ticks make "what is the rate at time T" a constant-time lookup.
- Gas-efficient sparse representation (tick bitmaps).

**Cons**:
- Tick math is among the most complex on-chain math anywhere. Audit burden
  is high.
- The 1.0001^i geometric ladder is optimized for swap-price continuity, not
  for human-readable rate schedules.

**Verdict for us**: **over-engineered**. A rate schedule has 10-100 data
points over its lifetime, not 1.8M ticks.

### 11.2 Balancer weighted pools — time-varying weights

Balancer V2 Liquidity Bootstrapping Pools (LBPs) linearly interpolate
weights from `(w_start[i])` to `(w_end[i])` over a time window, using:

```
w(t) = w_start + (w_end - w_start) * (t - startTime) / (endTime - startTime)
```

Pool math uses a **weighted geometric mean invariant**:
```
∏ (B_i)^(w_i(t)) = k
```

**Pros**:
- Clean linear interpolation between two anchor states.
- Well-audited implementation (`WeightedMath.sol`).
- Supports per-token weight schedules.

**Cons**:
- Invariant math requires fixed-point exp/log (expensive).
- Built for AMM swap pricing; awkward for "give me the bps at time T."

**Verdict for us**: **template for linear-interpolation segment of rate
schedule**. We can lift the `interpolate(w_start, w_end, t, startTime,
endTime)` logic without the invariant math.

### 11.3 Curve / piecewise bonding curves

Piecewise curves are defined by multiple sub-curves each applying to a
given input range:

```
if supply in [0, 5]:        price = a1 * supply + b1   (linear)
if supply in [5, 10]:       price = polynomial(supply)  (polynomial)
if supply >= 10:            price = constant            (flat ceiling)
```

The dispatch is a chain of `if/else` with stored breakpoints.

**Pros**:
- Dead simple to understand and audit.
- Supports arbitrary segment shapes as long as each segment is expressible.
- Gas-efficient: constant-time segment lookup via binary search on
  breakpoints.

**Cons**:
- No standard library — every implementation rolls its own.

**Verdict for us**: **BEST TEMPLATE**. Piecewise linear segments over
`(t, adoption)` is exactly what our RateSchedule needs. See section 11.5
for concrete proposed DSL.

### 11.4 Sablier LockupDynamic segments

Sablier's LockupDynamic stores an array of segments:

```solidity
struct Segment {
    uint128 amount;        // cumulative tokens unlocked at this milestone
    uint64 exponent;       // shape of unlock within the segment (fixed18)
    uint40 milestone;      // timestamp at which this segment ends
}
```

Unlock curve between milestones is:
```
unlocked_within_segment = segment_amount *
    ((t - prev_milestone) / (milestone - prev_milestone)) ^ exponent
```

- `exponent = 1` -> linear
- `exponent < 1` (e.g., 0.5) -> frontloaded (sqrt-shaped)
- `exponent > 1` (e.g., 3) -> backloaded (cubic)
- A zero-duration segment -> instantaneous unlock (cliff)

**Pros**:
- Battle-tested (audited by Spearbit, Cantina, Cyfrin).
- Expressive: exponents cover a large practical design space.
- Each segment is 40 bytes packed — storage-efficient.

**Cons**:
- Requires `exp()` math for non-linear exponents (uses PRBMath library).
- Segments are STRICTLY time-based; cannot index on adoption metric.

**Verdict for us**: **template for segment structure**. Steal the
`Segment[]` shape. Extend with a `metric` field to support
(t-based) OR (adoption-based) segments.

### 11.5 Proposed RateSchedule DSL — concrete specification

Synthesizing the above:

```solidity
library RateSchedule {
    enum MetricType { TIME, JOBS_SETTLED, USD_VOLUME }
    enum Shape { CONSTANT, LINEAR, EXPONENTIAL }

    struct Segment {
        MetricType metric;           // 1 byte
        Shape shape;                 // 1 byte
        uint64 anchor;               // start metric value (time or count)
        uint64 horizon;              // end metric value
        uint16 bpsStart;             // 0..10000
        uint16 bpsEnd;               // 0..10000
        uint16 exponent;             // fixed-point q1.15 for EXPONENTIAL
    }

    struct Schedule {
        // Default/fallback bps if no segment matches
        uint16 defaultBps;
        // Sorted by (metric, anchor). Binary search at lookup time.
        Segment[] segments;
    }

    function bpsAt(Schedule storage s, uint256 t, uint256 jobs, uint256 usd)
        internal view returns (uint256 bps);
}
```

Design choices:

- **Packed structs**: each segment is 16 bytes, so 10-segment schedule
  fits in 2 storage slots.
- **Binary search on lookup**: O(log n) is fine for typical 5-15 segment
  schedules.
- **Three metric types**: time, jobs-settled, USD-volume. Author chooses
  ONE per segment. A schedule can mix (e.g., TIME segment 0-6 months
  lets bps drop by JOBS_SETTLED count).
- **Immutability guard**: `Schedule` is written once at mint (or via a
  controlled migration path), then all further writes must monotonically
  decrease `bpsStart` and `bpsEnd` for every segment. Enforced by the
  ContributorNFT contract.

### Key gotchas for the rate DSL

- **EXPONENTIAL overflow**: uses `PRBMath.UD60x18.pow()`. Must cap
  `exponent` at a value where `value^exponent < 2^128` for any reasonable
  input — PRBMath throws otherwise.
- **Clock skew / reorgs**: timestamp-based segments near-boundary could
  flip from one segment to another on re-org. Base settlement clears
  finality in ~2 seconds, so practical risk is low but worth documenting.
- **Adoption metric freshness**: if we index on `jobs_settled`, we need an
  oracle or counter that can't be spoofed. The PCC gateway is the
  natural counter authority — it increments a global job counter on
  every `settleJob()`.

---

## 12. Adoption-Indexed Rates — Prior Art Review

**Sources** (from prior searches):
[Harberger Tax — Wikipedia](https://en.wikipedia.org/wiki/Harberger_Tax);
[Harberger on-chain — Simon de la Rouviere](https://medium.com/@simondlr/what-is-harberger-tax-where-does-the-blockchain-fit-in-1329046922c6);
[Harberger Taxes as business model — Tim Daub](https://timdaub.github.io/2022/03/28/harberger-tax-can-cryptos-sustainable-business-model/);
[Dynamic royalty research — NEST Medium](https://nes-tech.medium.com/understanding-erc-2981-a-new-era-for-nft-royalty-distribution-7948fe66321a);
[Decoding NFT Royalties — Bitbond](https://www.bitbond.com/resources/decoding-nft-royalties/);
[Resale Royalty research paper — ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1057521925005599);
[CoinLaw NFT Royalties Stats 2026](https://coinlaw.io/nft-royalties-statistics/).

### Summary of prior art

There is **no deployed on-chain standard** for adoption-indexed royalty
rates. The closest analogs:

1. **Dynamic royalty models (offchain)**: "5% on first resale, 3%
   thereafter," or rates that drop as transfer-count increases. Mentioned
   in ERC-2981 discussion (Issue #2907) as a theoretical extension but
   never formalized as a subset EIP.
2. **Decaying royalties**: referenced in Gemini and multiple secondary
   sources — the idea that `royaltyAmount = base_bps * decay_factor(time,
   transfer_count)`. Implementations exist bespoke (Transient Labs, Sound
   Protocol, some Zora collections) but no shared interface.
3. **Harberger Tax / Common-Ownership Self-Assessed Tax (COST)**: the
   owner self-assesses value and pays a percentage tax; anyone can buy
   at the self-assessed price. Used by Radical Markets proposals, Geo
   Web (on-chain geo-land registry), and some experimental art projects
   (Simbolo, PartialCommonOwnership smart contracts). Interesting
   adjacent model but **not** what we need — Harberger flips incentives
   toward undervaluing vs our goal of market-discovered rates.
4. **Balancer LBP (Liquidity Bootstrapping Pool)**: weight-shifts over
   time to discover a fair launch price. Conceptually: "start high,
   auto-decay to discover demand." Could be inverted for rate discovery.
5. **Story Protocol custom Royalty Policies**: supports arbitrary Solidity
   policy modules. In theory a developer could write an adoption-indexed
   policy. **Not done yet in production** per our review of Story's
   module registry.

### Statistics on dynamic royalty performance

From 2026 NFT royalty research:

- Average NFT royalty fee: 6.1% in 2025 (down from 7.5% in 2022).
- "Collections that adopt dynamic royalty models (e.g., 5% on first
  resale, 3% thereafter) are seeing slightly improved long-term revenue
  compared to single-rate models."
- "Dynamic royalty models can increase creator revenue by up to 40%
  through real-time adjustments."
- Economic research: "One standard deviation increase in the royalty
  rate significantly correlates with a 7.04% decrease in market prices
  and a 4.8% decrease in the resale probability of NFTs."

Translation for our design: **high initial rates suppress demand; declining
rates tied to adoption are market-efficient**. The "adoption-indexed"
pattern is theoretically optimal but unbuilt in production.

### Verdict: we'd be building novel primitives

The adoption-indexed RateSchedule we want is **net-new design space**. No
off-the-shelf on-chain DSL exists. We'd be the reference implementation.

### Concrete design leverage

1. From the research: rate schedules that **decrease over adoption**
   maximize both long-tail revenue AND consumer uptake. This justifies
   our "can only be decreased" invariant.
2. The **per-segment metric choice** (time vs jobs vs USD volume) gives
   authors the flexibility to express "I want to start high to recover
   dev cost, then glide down as my adapter gets popular."
3. The **market-discovery** angle: by making rate schedules public and
   committed, consumers can comparison-shop between contributors. This
   replicates the Harberger "force price discovery" idea but without
   forcing sales.

### Key gotchas

- **Gaming the adoption counter**: a contributor could fake jobs through
  a shell kernel to drive their bps down ... no, wait, they WANT high
  bps. They'd fake jobs to increase bps? No, the schedule is
  monotonically non-increasing, so faking jobs DECREASES rate. So the
  attacker would want to SUPPRESS real jobs to keep rate high. Mitigation:
  the "adoption metric" is public, and consumers can choose a competing
  adapter if the rate is artificially inflated. Market-discipline.
- **Inter-contributor subsidies**: if two authors collude, they can
  route jobs to each other to grow each other's adoption count. Weak
  concern — their bps will DROP as a result, which hurts them.

---

## 13. Content-Addressed NFT Metadata Standards

**Sources**: [EIP-3569 Sealed NFT Metadata Standard](https://eips.ethereum.org/EIPS/eip-3569);
[Immutable docs — Deep dive into metadata](https://docs.x.immutable.com/docs/deep-dive-metadata/);
[IPFS NFT best practices](https://docs.ipfs.tech/how-to/best-practices-for-nft-data/);
[EIP-6969 analysis — onekey blog](https://onekey.so/blog/ecosystem/eip-6969-new-ideas-for-erc-and-nft-metadata-construction/);
[NFT Content Type EIP Draft](https://github.com/NFT-Standards-WG/eip-content-type/blob/main/eip-draft_nft_content_type.md);
[Iain Nash — EIP NFT content draft](https://github.com/iainnash/eip-nft-content-draft);
[IPFS CID explainer](https://chainscorelabs.com/glossary/nft-technologies-and-metadata/nft-metadata-standards/interplanetary-file-system-ipfs-cid);
[NFT immutability technical nuances — rameerez blog](https://rameerez.com/problems-and-technical-nuances-of-nft-immutability-and-ipfs/).

### Correction: there is NO EIP-4884 for NFT metadata

The task brief referenced "EIP-4884" as a content-addressed metadata
standard. That EIP number is **reserved for beacon-chain root
history** (Merkle tree of parent beacon roots). Unrelated to NFTs.

The actual prior art:

### EIP-3569 — Sealed NFT Metadata Standard (Final)

Formalizes "metadata is a content hash, not a URL." Provides a mechanism
to commit NFT metadata by its hash, ensuring it cannot be silently swapped.

Interface:
```solidity
interface IERC3569 /* is IERC721Metadata */ {
    event Sealed(uint256 indexed _tokenId, bytes32 _metadataHash, string _uri);

    function sealedMetadataHash(uint256 _tokenId) external view returns (bytes32);
    function sealedMetadataURI(uint256 _tokenId) external view returns (string memory);
}
```

The `Sealed` event marks a token's metadata as permanently committed. The
on-chain `_metadataHash` is the keccak256 (or SHA-256 via convention) of
the metadata JSON. The URI is a CID (IPFS/Arweave) or HTTP mirror.

**Adoption**: low. Few deployed collections cite ERC-3569. Most projects
use their own ad-hoc variant of "tokenURI returns an IPFS CID".

### EIP-6969 — Content-type aware metadata (draft)

Newer draft that formalizes `{mime, uri, alt, sha256}` metadata structure.
Enables cross-chain content verification. Not final, but a useful reference
for how to structure metadata JSON.

### De facto IPFS CID pattern

Most production NFT collections use `tokenURI = ipfs://<CID>`. The CID is
a cryptographic hash of the metadata JSON — tamper-evident. The issue
is that this is a **convention**, not an enforced on-chain contract. A
malicious contract could `setTokenURI(tokenId, "ipfs://differentCID")`.

### What we need for ContributorNFT

Our ContributorNFT's tokenURI should point at a **schema document** that
describes the contribution:
- The contribution type (adapter, capability, dataset, model)
- Pointer to the actual artifact (Storacha CID for datasets, GitHub
  commit hash for code, model weights CID)
- Dependency declarations (which other ContributorNFTs this uses)
- The RateSchedule JSON (redundant with on-chain but useful off-chain)
- ERC-8004 agent registration fields

The metadata IS content-addressed and IS immutable — this is a strong fit
for the ERC-3569 pattern and/or the CSD (Capability StructureDefinition)
pattern PCC already uses.

### Fit for ContributorNFT (score 5/5)

| Axis | Fit | Notes |
|---|---|---|
| Carrier | 5 | tokenURI is an ERC-721 field; standard |
| Rate DSL | 2 | Metadata CAN contain rate schedule but authoritative source is on-chain |
| Immutability | 5 | Content-addressing gives free immutability via crypto hash |
| DAG split | 3 | Metadata declares dependencies; DAG lives on-chain via references |
| Gas fit | 5 | Just a string; trivially cheap |

**Verdict**: **STRONG ADOPT — ERC-3569 `Sealed` event + IPFS/Storacha CID.**

### Concrete integration plan

1. Define a `ContributorManifest` JSON schema (stored in a repo).
2. On mint, require a Storacha CID pointing at a valid manifest.
3. Verify the on-chain `sha256` hash matches the CID's content (done
   off-chain pre-mint).
4. Emit `Sealed(tokenId, metadataHash, cid)` per ERC-3569.
5. Override `tokenURI()` to return `ipfs://<CID>` permanently — no setter.
6. Provide a read-helper `manifest(tokenId)` that returns `(hash, uri)`.

### Key gotchas

- **IPFS pinning**: CIDs can become unreachable if no one pins them.
  PCC already uses Storacha, which provides durable storage. Use
  Storacha's space (`pcc-evidence`) or a new dedicated space for
  contributor manifests. Tag pinning to the ContributorNFT's token
  balance (each transfer triggers a pin refresh).
- **Manifest schema evolution**: our manifest format will evolve. Embed
  a `schemaVersion` field. Old NFTs stay valid forever at their version;
  new mints use the latest schema.
- **Multi-file contributions** (model weights + README + example
  notebooks): use a directory CID (IPFS MFS) or a single JSON manifest
  listing child CIDs.

---

## 14. Programmatic Splits for DAG Provenance

**Sources**: [TreeTrunk reference implementation](https://github.com/treetrunkio/treetrunk-nft-reference-implementation);
[EIP-4910 Royalty Bearing NFTs](https://eips.ethereum.org/EIPS/eip-4910);
[Decrypt — TreeTrunk profile](https://decrypt.co/93097/ethereum-nft-protocol-treetrunk-promises-new-royalty-options-artists);
[Envision Blockchain — EIP-4910 analysis](https://envisionblockchain.com/eip4910/);
[EIP-6059 — Nestable NFT discussion](https://ethereum-magicians.org/t/eip-6059-parent-governed-nestable-non-fungible-tokens/12092);
[ERC-6220 Composable Equippable](https://eips.ethereum.org/EIPS/eip-6220);
[Chainlink — Tokenized Royalties explainer](https://chain.link/article/tokenized-royalties-smart-contracts);
[Provenance DAG on-chain research (arXiv)](https://arxiv.org/pdf/1810.09843);
[Verifiable Off-Chain Governance (arXiv)](https://arxiv.org/html/2512.23618v1).

### The niche: recursive split through a DAG

We need a contract that, at job-settlement time, walks a provenance DAG
(adapter -> capability -> dataset -> model) and routes basis-point-fractions
of the settlement value to every ContributorNFT in the closure. **This is
not a thing any of the standards above do natively.**

### EIP-4910 — Royalty Bearing NFTs

Final proposal by TreeTrunk.io. Extends ERC-721 with royalty account
management and hierarchical derivatives.

Core pattern:
- Each NFT can declare a **parent NFT** at mint.
- On-chain royalty balances accumulate at each node.
- A "parent's share" is fractionally forwarded on every settlement.
- Settlement can be traced upward through the chain until it reaches the
  root NFT.

```solidity
// EIP-4910 core additions (approximate)
function mint(address to, uint256 parentTokenId, uint16 parentShareBps) external;
function payRoyalty(uint256 tokenId, IERC20 token, uint256 amount) external;
function balanceOfRoyalty(uint256 tokenId, IERC20 token) external view returns (uint256);
function claimRoyalty(uint256 tokenId, IERC20 token, address to) external;
```

**Key insight from EIP-4910**: the "N-deep recursive hierarchy" problem is
decomposed into **N separate single-hop problems, one per layer**. Each
NFT only stores its parent's share. The recursive walk is a series of
single-step settlement calls. This bounds the work per layer to O(1) storage
and moves the recursion cost to settlement-time.

**Adoption**: very low. TreeTrunk's reference implementation is a tech demo,
not deployed at scale. But the IDEA is sound, and Story Protocol's Royalty
Module has evolved a similar pattern.

### ERC-6059 — Parent-Governed Nestable NFTs

RMRK-originated standard. An NFT can be "nested into" another NFT, creating
a parent-child tree. Focuses on **ownership** (the parent NFT owns the child)
rather than royalty splits.

```solidity
function nestTransferFrom(
    address from, address to, uint256 tokenId, uint256 destinationId, bytes data
) external;
function childrenOf(uint256 parentId) external view returns (Child[] memory);
function rejectAllChildren(uint256 parentId) external;
```

**Fit**: provides a **DAG encoding** primitive. The parent-child tree is
what we need — but ERC-6059 is tree-only, not DAG. A contribution can
have multiple parents (a "fine-tuned model" built on dataset A and dataset
B), which ERC-6059 doesn't model.

### ERC-6220 — Composable Equippable Parts

Another RMRK standard for NFT composition via "equippable parts." More
about visual/metadata composition than revenue. Not a fit.

### Our synthesis — SplitPayoutEngine + DependencyRegistry

Given the absence of a directly-applicable standard, we build our own.
Design:

```solidity
contract DependencyRegistry {
    // tokenId -> list of (parentTokenId, weight) tuples, where weight
    // is out of DEP_DENOMINATOR (e.g., 1_000_000).
    mapping(uint256 => Dep[]) public deps;
    struct Dep { uint256 tokenId; uint32 weight; }

    // Called at ContributorNFT mint time to declare dependencies.
    function declare(uint256 tokenId, Dep[] calldata parents) external;
    // Mint time only; no update path unless author renounces immutability.

    // Traverses the DAG up to some depth, returns flat list of
    // (tokenId, effectiveWeight) summed.
    function flatten(uint256 rootTokenId, uint8 maxDepth)
        external view returns (Flat[] memory);
    struct Flat { uint256 tokenId; uint256 effectiveWeight; }
}

contract SplitPayoutEngine {
    function splitPayout(
        uint256 rootTokenId,
        IERC20 token,
        uint256 amount
    ) external {
        Flat[] memory leaves = DepRegistry.flatten(rootTokenId, MAX_DEPTH);
        uint256 totalWeight = _sumWeights(leaves);
        for (uint i = 0; i < leaves.length; i++) {
            uint256 share = amount * leaves[i].effectiveWeight / totalWeight;
            // recipient = ERC6551 TBA of leaves[i].tokenId
            address tba = ERC6551_REGISTRY.account(
                TBA_IMPL, SALT, block.chainid, CONTRIB_NFT, leaves[i].tokenId
            );
            uint256 bps = ContributorNFT(CONTRIB_NFT).bpsAt(leaves[i].tokenId);
            // Apply per-contributor rate schedule
            uint256 contributorShare = share * bps / 10_000;
            token.safeTransfer(tba, contributorShare);
            // Remainder (if any) goes to residual pool or payer
        }
    }
}
```

Key design properties:

- **Flatten-at-read**: DependencyRegistry computes the flat list at query
  time, not at settlement. This lets us cache / off-chain compute for gas
  optimization.
- **Capped depth**: `MAX_DEPTH = 8` (following Story Protocol's precedent)
  prevents pathological gas costs.
- **Rate schedule applied at leaf**: each contributor's ContributorNFT has
  its own RateSchedule; the engine multiplies `share * bps` per contributor.
- **DAG encoding**: each node has a list of parents (not a single parent).
  Non-trivial cycles are forbidden — enforced at `declare()` time via a
  DFS cycle check. Depth cap prevents pathological cases even if cycles
  slip through.
- **Immutability**: `deps` is write-once per tokenId. Follows our
  commit-don't-mutate principle.

### Gas cost estimation

For a 5-deep DAG with 15 contributors:

- `flatten()` (view): ~200k gas (fits in eth_call / callStatic, doesn't
  affect transaction cost).
- `splitPayout()`: ~50k fixed + (~20k + 1 SSTORE + ERC-20 transfer) per
  contributor. 15 contributors -> ~50k + 15*85k = ~1.3M gas. On Base at
  30 gwei: ~$0.12 per settlement.

This is **at the upper edge** of our $0.10 target. Optimizations:
1. Replace the `splitPayout` loop with 0xSplits PullSplit: one distribute
   call, funds land in Warehouse, contributors pull. Cuts per-settlement
   gas to ~100k at the cost of additional withdraw gas per contributor.
2. Off-chain compute: the payer submits a Merkle root of the split, and
   a keeper verifies + distributes. Reduces to ~50k gas total.
3. Compress the Flat[] list via sorted-by-tokenId + delta-encoded weights.

### Fit for ContributorNFT (score 5/5 — purpose-built)

This is OUR CONTRIBUTION. The research confirmed no off-the-shelf
standard does this. We must build it, but we have strong prior art to
draw from (EIP-4910 parent-share decomposition + Story Protocol recursive
policy + Drips splits graph + 0xSplits warehouse).

**Verdict**: **BUILD. Cite prior art heavily in audit package.**

### Key gotchas

- **Cycle detection**: DAG (not cyclic). `declare()` must run a DFS over
  the existing graph to reject cycles. O(depth * breadth) per mint,
  cheap at mint time.
- **Weight normalization**: sum of dep weights should equal
  `DEP_DENOMINATOR`. If less, the residual is the ContributorNFT's own
  "self-retained share." Document this.
- **Settlement currency**: our `splitPayout` only supports ERC-20 (USDC).
  ETH payouts require a WETH wrapping step. Document.
- **ERC-8004 reputation decay during settlement**: the `bpsAt()` lookup
  must be deterministic at block.timestamp. If the rate schedule is
  adoption-indexed, we need to fix the adoption counter at the beginning
  of the settlement tx so all leaves see the same count.

---

## Summary Table

All 14 items, scored on the five axes. Final verdict column drives our
recommended stack.

| # | Standard / Protocol | Carrier | RateDSL | Immut | DAG | Gas | Total /25 | Verdict |
|---|--------------------|---------|---------|-------|-----|-----|-----------|---------|
| 01 | ERC-2981 | 5 | 2 | 3 | 1 | 5 | 16 | ADOPT interface only (marketplace interop) |
| 02 | EIP-5585 | - | - | - | - | - | informational | SKIP (not about royalty enforcement) |
| 03 | Manifold Royalty Registry + Operator Filter | 2 | 1 | 2 | 2 | 4 | 11 | SKIP registry; learn from Operator Filter failure |
| 04 | Drips | 4 | 3 | 5 | 5 | 4 | 21 | STRONG ADOPT as primary split graph |
| 05 | 0xSplits | 2 | 2 | 5 | 5 | 5 | 19 | STRONG ADOPT as per-node splitter primitive |
| 06 | Superfluid | 2 | 4 | 3 | 3 | 3 | 15 | PARTIAL — future streaming tier, not v1 |
| 07 | Sablier | 5 | 4 | 4 | 1 | 3 | 17 | BORROW patterns (NFT-as-stream, LockupDynamic segments) |
| 08 | Story Protocol | 5 | 3 | 4 | 5 | 3 | 20 | PARTIAL ADOPT — IP Graph model; Path A (Base-native) for v1 |
| 09 | EIP-2535 Diamond | 3 | 3 | 2 | 1 | 2 | 11 | SKIP — opposite of our immutability goal |
| 10 | ERC-6551 TBAs | 5 | 3 | 4 | 4 | 4 | 20 | ADOPT — each ContributorNFT gets a TBA |
| 11 | Rate-schedule DSLs (Sablier/Balancer template) | - | 5 | 5 | - | 4 | 14 | BUILD our own, template from Sablier LockupDynamic + Curve piecewise |
| 12 | Adoption-indexed rates | - | 5 | 5 | - | 4 | 14 | NOVEL — we're the reference implementation |
| 13 | Content-addressed metadata (ERC-3569) | 5 | 2 | 5 | 3 | 5 | 20 | STRONG ADOPT — tokenURI is a Storacha CID, Sealed event emitted |
| 14 | Programmatic DAG splits (EIP-4910 + custom) | 5 | 5 | 5 | 5 | 4 | 24 | BUILD — own `DependencyRegistry` + `SplitPayoutEngine` |

---

## Recommended Stack for ContributorNFT + RateSchedule

Based on the landscape, the recommended architecture is a **layered
composite** rather than adoption of a single existing protocol.

### Layer 1 — Carrier: ERC-721 + ERC-6551 + ERC-2981 + ERC-3569

`ContributorNFT` is a standard OpenZeppelin ERC-721 that also implements:

- **ERC-2981 `royaltyInfo()`** pointing to the SplitPayoutEngine address
  (so marketplace resales still route through our split logic).
- **ERC-3569 `Sealed` event** + immutable `tokenURI` pointing to an
  IPFS/Storacha CID of the contributor manifest (schema at
  `schemas/contributor-manifest-v1.json`).
- **ERC-6551 TBA** auto-deployed at mint time via the canonical
  `ERC6551Registry.createAccount()` call. TBA is the settlement recipient.

Rationale: the ERC-721 base + ERC-6551 TBA gives us a per-contributor
wallet; ERC-2981 gives us marketplace interop without opting into the
broken royalty-enforcement game; ERC-3569 gives us metadata integrity.

### Layer 2 — Rate DSL: custom `RateSchedule` library

We build `RateSchedule.sol` with packed `Segment[]` storage, inspired by
Sablier LockupDynamic segments + Balancer LBP linear interpolation +
Curve piecewise bonding curves.

- Segments support `MetricType = {TIME, JOBS_SETTLED, USD_VOLUME}`.
- Shapes: `CONSTANT`, `LINEAR`, `EXPONENTIAL`.
- Monotonicity invariant: author can only DECREASE bps of any segment,
  never INCREASE. Enforced at the contract level.
- Storage: ~10-20 segments per NFT, ~200 bytes storage total.
- Lookup: binary search on anchor, O(log n) per `bpsAt()` call.

Rationale: no existing DSL does adoption-indexed rates with an
immutability/monotonic guarantee. We build it, using the Sablier
segment shape as template.

### Layer 3 — Split Graph: `DependencyRegistry` + 0xSplits PullSplit or Drips

Two concrete options, both viable:

**Option A (0xSplits-centric)**:
- Each capability's "split root" is a 0xSplits PullSplit contract.
- Recipients are either (a) ERC-6551 TBAs of leaf ContributorNFTs, or
  (b) nested PullSplits for sub-capabilities.
- Immutability: set `owner = 0` on each PullSplit at creation.
- Warehouse holds funds; contributors pull.

**Option B (Drips-centric)**:
- Each ContributorNFT's TBA has a Drips `NFTDriver` account ID.
- Splits config encoded in Drips storage via `ImmutableSplitsDriver`.
- Revenue flows via `Drips.give()` at settlement; `split()` cascades.

**Recommendation: Option A (0xSplits)** for v1, because:
1. 0xSplits has broader audit history and more ecosystem tooling.
2. Warehouse withdraw UX is better understood.
3. Gas cost is lower for discrete settlement events.
4. Drips is better suited to CONTINUOUS streams — overkill for our
   event-driven settlement.

Revisit Drips for v2 if we add recurring/subscription revenue (e.g.,
"every active kernel pays X USDC/day to load model Y").

**On top**, we build our own `DependencyRegistry` to encode the DAG
explicitly (multi-parent), and `SplitPayoutEngine` to orchestrate a
settlement across the DAG (calling 0xSplits distribute at each layer
and applying the per-node RateSchedule).

### Layer 4 — Settlement Integration with PCC MilestoneEscrow

The existing PCC `MilestoneEscrow.sol` contract already handles
job escrow + release-on-evidence. We add a hook:

```solidity
// MilestoneEscrow addition
interface ISplitPayoutEngine {
    function splitPayout(uint256 rootContributorTokenId, IERC20 token, uint256 amount) external;
}

// On milestone release:
function _releaseMilestone(uint256 milestoneId) internal {
    // existing payout logic: protocol fee + operator settlement
    uint256 ownerShare = ...; // after the 2.35% protocol fee
    uint256 contributorShare = ownerShare * CONTRIBUTOR_BPS / 10_000;
    uint256 operatorShare = ownerShare - contributorShare;

    USDC.safeTransfer(operator, operatorShare);
    USDC.safeApprove(splitEngine, contributorShare);
    splitEngine.splitPayout(rootContributorTokenId, USDC, contributorShare);
}
```

The protocol fee remains fixed (2.35%). A configurable CONTRIBUTOR_BPS
(e.g., 2000 = 20% of operator revenue) goes into the split. Operator
keeps the rest. **Market forces set CONTRIBUTOR_BPS** — too high and
kernels refuse to run the capability; too low and contributors route to
other platforms.

### Layer 5 — ERC-2981 interop (marketplace path)

If a ContributorNFT is listed on OpenSea / Zora / Manifold, the resale
royalty path runs through `royaltyInfo()`:

```solidity
function royaltyInfo(uint256 tokenId, uint256 salePrice)
    external view returns (address receiver, uint256 royaltyAmount)
{
    // Marketplace resales route to a dedicated ResaleSplit contract
    // that splits between the seller + the ContributorNFT's DAG ancestors
    // (e.g., dataset authors get a cut of fine-tuned-model resales).
    return (address(resaleSplit), salePrice * RESALE_ROYALTY_BPS / 10_000);
}
```

This integrates with ERC-2981 advisory semantics. Not the primary
revenue path — secondary.

---

## 3 Concrete Next Steps (prioritized)

### 1. Prototype `DependencyRegistry` + `SplitPayoutEngine` against 0xSplits on Base Sepolia (WEEK 1-2)

- Deploy a trivial `ContributorNFT` (OpenZeppelin ERC-721 + ERC-6551 registry
  wiring + stub `bpsAt()` that returns a constant).
- Deploy `DependencyRegistry.sol` with `declare()` + `flatten(depth)` + DFS
  cycle check.
- Deploy `SplitPayoutEngine.sol` that calls 0xSplits PullSplit at the root
  and pushes share to each leaf's TBA.
- Test: mint 5 ContributorNFTs in a 3-deep DAG (root adapter -> capability
  -> dataset + model); simulate a `splitPayout(root, USDC, 1000 USDC)`;
  verify gas cost and correctness.
- Metric: confirm gas is under target ($0.12 per settlement with 10
  contributors on Base at 30 gwei).

**Deliverable**: working contracts + Hardhat tests + gas report.

### 2. Design + spec `RateSchedule` DSL with adoption indexing (WEEK 2-3)

- Write the formal spec (this document is the design brief — next step is
  a GRD with concrete Solidity interfaces).
- Define the three MetricType / three Shape combinations with test cases.
- Implement `RateSchedule.sol` library with `bpsAt()` lookup, monotonicity
  enforcement, and PRBMath-based exponential.
- Write fuzz tests that random-walk through the schedule and verify:
  (a) bps never exceeds the committed ceiling, (b) monotonic decrease
  invariant holds across any `_setSegment()` call, (c) cross-segment
  transitions are continuous.

**Deliverable**: `RateSchedule.sol` + `RateSchedule.t.sol` foundry tests.

### 3. Integrate `SplitPayoutEngine` into `MilestoneEscrow` + validate with the E2E real-robot flow (WEEK 3-4)

- Add `CONTRIBUTOR_BPS` to the escrow contract (default 0 = backward
  compatible).
- Add a `setContributorBps(capabilityId, bps)` governance method (DAO-
  gated eventually; owner-gated for v1).
- Add a `rootContributorTokenId` field to the Job struct; set it at
  job-submission time from the capability's declared ContributorNFT.
- On milestone release, route the contributor share through the engine.
- Run a full E2E: submit a job on the HP printer kernel; verify evidence
  releases; verify contributor splits land in each TBA; verify
  contributors can `withdraw()` from the Warehouse.

**Deliverable**: integrated settlement path + E2E trace in
`scripts/real-e2e-verbose.ts` showing a split to a demo ContributorNFT.

---

## Appendix A — What We DID NOT Adopt and Why

- **ERC-2535 Diamond**: too-complex, opposite of our immutability needs.
- **EIP-5585 NFT Authorization**: not about royalties; informational only.
- **OpenSea Operator Filter**: deprecated; transfer-layer enforcement lost.
- **Superfluid CFA for contributor revenue**: mismatch — settlements are
  discrete events, not streams. Revisit in v2.
- **Sablier direct use**: one-payer-to-one-recipient; doesn't split.
- **Drips for primary split**: excellent, but 0xSplits chosen for v1 due
  to simpler event-driven semantics. Revisit in v2 for subscription
  revenue.
- **Story Protocol Path B (mirror-on-Story-Network)**: cross-chain
  complexity too high for v1. Path A (Base-native, IP Graph as template)
  adopted. Revisit in v2.
- **EIP-4910 TreeTrunk direct use**: low adoption; we use its design
  pattern (N-deep problem -> N single-hop problems) in our custom
  `DependencyRegistry`.
- **ERC-6059 / ERC-6220 Nestable / Equippable NFTs**: tree-only; we need
  multi-parent DAG support.

---

## Appendix B — Sources (Canonical Index)

Standards:
- [ERC-2981 NFT Royalty Standard (Final)](https://eips.ethereum.org/EIPS/eip-2981)
- [EIP-5585 ERC-721 NFT Authorization (Final)](https://eips.ethereum.org/EIPS/eip-5585)
- [EIP-2535 Diamonds Multi-Facet Proxy (Final)](https://eips.ethereum.org/EIPS/eip-2535)
- [ERC-6551 Non-fungible Token Bound Accounts (Final)](https://eips.ethereum.org/EIPS/eip-6551)
- [EIP-3569 Sealed NFT Metadata Standard](https://eips.ethereum.org/EIPS/eip-3569)
- [EIP-4910 Royalty Bearing NFTs](https://eips.ethereum.org/EIPS/eip-4910)
- [ERC-6220 Composable Equippable Parts](https://eips.ethereum.org/EIPS/eip-6220)
- [OpenZeppelin ERC-2981 reference implementation](https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/token/common/ERC2981.sol)

Protocols:
- [Manifold Royalty Registry (royaltyregistry.eth)](https://github.com/manifoldxyz/royalty-registry-solidity)
- [OpenSea Operator Filter Registry (deprecated)](https://github.com/ProjectOpenSea/operator-filter-registry)
- [Drips Protocol Contracts](https://github.com/drips-network/contracts)
- [Drips Docs — Overview](https://docs.drips.network/the-protocol/overview/)
- [0xSplits Splits V2 monorepo](https://github.com/0xSplits/splits-contracts-monorepo)
- [Splits.org core docs](https://docs.splits.org/core/split-v2)
- [Superfluid Protocol V1 overview](https://github.com/superfluid-org/protocol-monorepo/wiki/Superfluid-Protocol-V1-Overview)
- [Superfluid GDA (General Distribution Agreement)](https://github.com/superfluid-org/protocol-monorepo/wiki/General-Distribution-Agreement)
- [Sablier V2 launch post](https://blog.sablier.com/introducing-sablier-v2/)
- [Sablier V2 LockupLinear docs](https://docs.sablier.com/contracts/v2/guides/create-stream/lockup-linear)
- [Story Protocol documentation](https://docs.story.foundation/)
- [Story Whitepaper PDF](https://www.story.foundation/whitepaper.pdf)
- [TreeTrunk reference implementation (EIP-4910)](https://github.com/treetrunkio/treetrunk-nft-reference-implementation)

Research papers:
- [Resale Royalty in NFT Marketplaces (ISR)](https://pubsonline.informs.org/doi/10.1287/isre.2023.0035)
- [Economics of resale royalties (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S1057521925005599)
- [CoinLaw NFT Royalties Statistics 2026](https://coinlaw.io/nft-royalties-statistics/)
- [Atis Elsts — Uniswap v3 liquidity math](https://atiselsts.github.io/pdfs/uniswap-v3-liquidity-math.pdf)
- [Balancer Weighted Math (docs)](https://docs.balancer.fi/concepts/explore-available-balancer-pools/weighted-pool/weighted-math.html)
- [Liquidity Provider Returns in Geometric Mean Markets](https://cryptoeconomicsystems.pubpub.org/pub/evans-g3m-returns)

News / adoption references:
- [CoinTelegraph — OpenSea disables Operator Filter](https://cointelegraph.com/news/opensea-disable-on-chain-royalty-enforcement-tool)
- [The Defiant — OpenSea to CORI](https://thedefiant.io/opensea-cori)
- [Fortune Crypto — Blur vs OpenSea](https://fortune.com/crypto/2023/02/26/nft-marketplace-blur-opensea-trading/)
- [Gemini — Exploring the NFT Royalty Standard](https://www.gemini.com/blog/exploring-the-nft-royalty-standard-eip-2981)
- [RareSkills — ERC-6551 deep dive](https://rareskills.io/post/erc-6551)
- [thirdweb — ERC-6551 Token Bound Accounts](https://blog.thirdweb.com/erc-6551-token-bound-accounts/)
- [Chainlink — Tokenized Royalties](https://chain.link/article/tokenized-royalties-smart-contracts)
- [Decrypt — TreeTrunk](https://decrypt.co/93097/ethereum-nft-protocol-treetrunk-promises-new-royalty-options-artists)

---

## Appendix C — Open Questions and Deferred Research

1. **Which 0xSplits version is deployed on Base?** Need to confirm V2
   (Warehouse + PullSplit) availability on Base mainnet and Base Sepolia.
   Fallback: V1 is universally deployed, adequate for prototype.
2. **Can Drips Base deployment interop with 0xSplits on same chain?** Both
   are address-based, so yes at the recipient level. A Drips payout can
   land in a 0xSplits PullSplit, for example.
3. **ERC-6551 canonical registry address on Base?** Need confirmation.
   Official Tokenbound deployment is `0x000000006551c19487814612e58FE06813775758`
   per the whitepaper, and this should be live on most chains.
4. **What is the ERC-8004 overlap?** Our contributor TBAs may also carry
   ERC-8004 agent identity + reputation. Need spec cross-reference pass
   (defer to a separate research task).
5. **Legal framework for RateSchedule commitments**: do we need a
   Programmable IP License-style off-chain instrument to accompany
   the on-chain RateSchedule? Story Protocol Path A adoption suggests
   yes — but v1 can proceed without it.
6. **Fuzz-test strategy for monotonicity invariant**: need to design
   randomized test harness that proves bps never exceeds the committed
   ceiling under any state transition sequence.
7. **Keeper economics for SplitPayoutEngine**: at what protocol fee is
   it self-sustaining to pay keepers to trigger distribute() on behalf
   of contributors? The `distributionIncentive` parameter in 0xSplits
   is a knob here.

---

END OF LANDSCAPE.
