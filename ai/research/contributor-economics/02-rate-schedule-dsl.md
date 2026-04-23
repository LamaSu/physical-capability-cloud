# Landscape: On-Chain Immutable Rate Schedule DSLs

**Agent**: scout-schedules-bravo
**Date**: 2026-04-22
**Mission**: Research how to express an immutable, publicly-committed rate curve on-chain
for a ContributorNFT + RateSchedule system where the schedule is published once and
the protocol honors it forever (until contributor ships a v2 under a new NFT).

## Progress Tracker

- [ ] 1. Vesting contracts (OZ VestingWallet, Gnosis, Sablier Lockup)
- [ ] 2. Streaming money (Superfluid, Sablier v2, Drips)
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

