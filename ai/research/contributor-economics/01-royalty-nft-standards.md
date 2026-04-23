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
- [ ] 04. Drips (drips.network)
- [ ] 05. 0xSplits
- [ ] 06. Superfluid
- [ ] 07. Sablier
- [ ] 08. Story Protocol (PIL / IP Graph)
- [ ] 09. EIP-2535 Diamond Standard
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
