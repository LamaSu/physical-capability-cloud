## Landscape Report: DePIN Sovereign Wealth Fund / Protocol Dividend Distribution

### Existing Solutions Found

| # | Solution | Solves Problem? | Maintained? | Recommendation |
|---|----------|----------------|-------------|----------------|
| 1 | OpenZeppelin Governor + TimelockController | Partially — governance only, no accrual/dividend | Yes (active) | Skip — overkill, Solidity-only |
| 2 | Superfluid (streaming payments) | Partially — streaming distributions, no weighted scoring | Yes (active) | Skip — different paradigm (continuous streams vs epoch dividends) |
| 3 | Sablier v2 (token distribution) | Partially — batch distributions, no governance/scoring | Yes (active) | Skip — no contribution scoring, no fund management |
| 4 | MolochDAO v3 / DAOhaus | Partially — treasury + governance | Yes | Skip — full DAO framework, massive dependency, wrong architecture |
| 5 | Helium HIP-based subDAO rewards | Partially — epoch rewards for DePIN | Yes (Helium) | Skip — Helium-specific, not portable |

### Recommended Path
- [ ] ADOPT: none
- [ ] EXTEND: none
- [x] BUILD: PCC needs a sovereign wealth fund tightly integrated with its existing InvestmentPool, RewardEpoch, and escrow primitives

### Build Justification
No existing solution combines: (1) protocol-wide fee accrual from multiple sources, (2) weighted contribution scoring across heterogeneous participant roles, (3) lightweight governance for allocation strategy, AND (4) integration with PCC's specific escrow/pool/bounty architecture. The existing primitives (PoolService, RewardEngine, TreasuryBalance) provide the foundation — the SWF layers on top of them with minimal new infrastructure.
