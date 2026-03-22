# Sovereign Wealth Fund (SWF)

A protocol-wide fund that accrues from every fee-generating transaction on PCC and distributes dividends to **all** network participants — operators, users, verifiers, couriers — weighted by their contribution.

## How It Works

### Accrual (Money In)

Every protocol fee triggers a 2% (200 bps) accrual into the fund:

| Source | When it fires | Example |
|--------|--------------|---------|
| Escrow release | Milestone settlement completes | Job #789 releases $2,500 → $50 accrues |
| Pool revenue | Investment pool distributes | Pool dist $1,200 → $24 accrues |
| Bounty payout | Bounty verified and paid | Bounty reward $5,000 → $100 accrues |
| Settlement | Batch settlement flushes | Settlement batch $10K → $200 accrues |
| Dispute slash | Slashed bond collected | Slash $500 → $10 accrues |

The accrual rate is configurable via governance proposals.

### Epochs (Distribution Cycles)

The fund operates on **weekly epochs**. Each epoch:

1. **Active** — Accruals accumulate into the epoch pool
2. **Calculating** — Contribution scores computed for all participants
3. **Distributing** — Dividend claims created per participant
4. **Completed** — Claims available for withdrawal

### Contribution Score (Who Gets What)

Each participant receives a weighted score every epoch:

| Dimension | Weight | What it measures |
|-----------|--------|-----------------|
| Job volume | 30% | Jobs completed, submitted, or verified |
| Reputation | 25% | ERC-8004 ReputationRegistry score (0-1000) |
| Uptime / Activity | 20% | Kernel uptime (operators) or activity frequency (users) |
| Tenure | 15% | Time on network (capped at 2 years) |
| Governance participation | 10% | Voted in proposals this epoch |

Scores are normalized across all participants. Your share = your score / total scores.

### Allocation Strategy (Where the Money Goes)

Each epoch's accrual is split according to the active allocation strategy:

| Bucket | Default % | Purpose |
|--------|-----------|---------|
| **Dividends** | 60% | Direct payouts to participants (pro-rata by score) |
| **Infrastructure** | 25% | Investment pools for new capability onboarding |
| **Grants** | 10% | Capability development for under-served areas |
| **Reserve** | 5% | Rainy day buffer |

These percentages are governable — any participant can propose changes.

## Governance

### Proposals

Any active participant with 30+ days tenure can propose a new allocation strategy:
- Proposal runs for 7 days
- Votes are weighted by contribution score (not 1-person-1-vote)
- 30% quorum required (30% of eligible participants must vote)
- Simple majority (yes weight > no weight) passes the proposal
- Passed proposals update the strategy for all future epochs

### Participant Registration

Participants are auto-enrolled on first network interaction:
- Kernel registration → role `operator`
- First job submission → role `user`
- First verification → role `verifier`

Roles: `operator`, `user`, `verifier`, `courier`, `arbiter`, `staker`, `curator`

## API Endpoints

```
GET  /api/swf/summary                         Fund balance, stats, current strategy
POST /api/swf/participants                     Register participant
GET  /api/swf/participants                     List participants (filter: role, status)
GET  /api/swf/participants/:id                 Participant dashboard
GET  /api/swf/epochs                           List epochs
GET  /api/swf/epochs/:epochId                  Epoch detail with scores
POST /api/swf/epochs                           Create epoch (admin)
POST /api/swf/epochs/:epochId/distribute       Trigger distribution
GET  /api/swf/accruals                         List accruals
POST /api/swf/claims                           Submit dividend claim
GET  /api/swf/claims/:claimId                  Claim status
GET  /api/swf/proposals                        List proposals
POST /api/swf/proposals                        Create proposal
GET  /api/swf/proposals/:id                    Proposal + vote tally
POST /api/swf/proposals/:id/vote               Cast vote
POST /api/swf/proposals/:id/execute            Tally + execute
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `pcc_swf_summary` | Fund balance, allocation strategy, participant count |
| `pcc_swf_participant_dashboard` | Participant's earnings, claims, voting history |
| `pcc_swf_list_proposals` | Active governance proposals with vote counts |

## A2A Intents

| Intent | Direction |
|--------|-----------|
| `swf_register_participant` | Agent → SWF |
| `swf_register_participant_result` | SWF → Agent |
| `swf_query_dividends` | Agent → SWF |
| `swf_dividends_result` | SWF → Agent |
| `swf_claim_dividends` | Agent → SWF |
| `swf_claim_result` | SWF → Agent |

## Architecture

```
packages/spec/src/types/swf.ts          ← Wire types (15 interfaces)
packages/payments/src/swf/              ← SWFService (in-memory mock)
  ├── types.ts                          ← Config, score weights
  ├── swf-service.ts                    ← Service class (350 lines)
  └── index.ts                          ← Re-exports
packages/db/src/schema/swf.ts           ← 7 Drizzle tables
packages/db/src/repositories/swf.ts     ← SWFRepository (CRUD)
packages/gateway/src/routes/swf.ts      ← 16 Fastify endpoints + integration helpers
apps/dashboard/src/pages/
  ├── SWFDashboardPage.tsx              ← Fund overview, accruals, claims, governance
  └── SWFGovernancePage.tsx             ← Proposal detail, strategy comparison, voting
```

### Integration Points

```
gateway/routes/settlement.ts  →  swfAccrue("settlement", jobId, amount)
gateway/routes/swf.ts         →  exports swfAccrue() + swfAutoRegister()
```

Other services (pool, bounty, escrow) can call `swfAccrue()` and `swfAutoRegister()` from `./swf.js` to hook into the fund.

## Database Tables

| Table | Purpose |
|-------|---------|
| `swf_participants` | Registered fund beneficiaries |
| `swf_epochs` | Distribution cycles |
| `swf_accruals` | Fee contributions to the fund |
| `swf_contribution_scores` | Per-participant per-epoch weighted scores |
| `swf_dividend_claims` | Claim records for payouts |
| `swf_proposals` | Governance proposals |
| `swf_votes` | Individual votes on proposals |

## Tests

84 tests covering all SWF service functionality:
- Participant management (register, dedup, suspend, withdraw, filters)
- Epoch lifecycle (create, list, active epoch)
- Accrual math (bps calculation, epoch accumulation)
- Contribution scores (normalization, weights, share sums to 1.0)
- Distribution (dividend pool math, claim creation, status transitions)
- Claims (submit, settle, fail, query)
- Governance (proposal validation, voting, quorum, tally, strategy execution)
- Summary & dashboard (aggregation, balance = accrued - distributed)

Run: `cd packages/payments && node_modules/.bin/vitest run src/__tests__/swf-service.test.ts`
