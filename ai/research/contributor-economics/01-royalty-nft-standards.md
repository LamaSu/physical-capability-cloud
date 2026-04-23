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
- [ ] 10. ERC-6551 Token-Bound Accounts
- [ ] 11. Rate-schedule DSLs (Curve / Balancer / Uniswap v3 / Compound)
- [ ] 12. Adoption-indexed rates (prior art)
- [ ] 13. Content-addressed metadata standards (EIP-4884, etc.)
- [ ] 14. Programmatic splits for DAG provenance

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
