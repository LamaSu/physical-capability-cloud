# Agentic Funding & Coordination — Technical Design

> AI agents that hold budgets, allocate resources, manage treasuries, distribute grants,
> and govern the PCC network of physical manufacturing capabilities.

## 1. Problem Statement

PCC's agents (UserAgent, BrokerAgent, KernelAgent) currently have **no financial autonomy**:
- Agent wallets hold zero balance (mock transactions)
- No budget delegation or spending policies
- No collective funding mechanisms
- No autonomous resource allocation
- No governance participation

For PCC to function as a **DePIN** (Decentralized Physical Infrastructure Network), agents must:
- Hold and manage funds autonomously
- Make economically rational decisions about capability allocation
- Participate in network governance
- Fund new infrastructure (machines, spaces, operators)
- Coordinate without human intervention for routine decisions

## 2. Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│                  Agentic Funding Layer                      │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Agent    │  │ Treasury │  │ Quadratic│  │ DePIN    │  │
│  │ Wallets  │  │  DAO     │  │ Funding  │  │ Rewards  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │             │             │              │         │
│  ┌────▼─────────────▼─────────────▼──────────────▼─────┐  │
│  │            MilestoneEscrow + StreamingPayments        │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                │
│  ┌────────────────────────▼─────────────────────────────┐  │
│  │              A2A Intent Bus (24+ intents)             │  │
│  │  + FundingRequestIntent + TreasuryVoteIntent         │  │
│  │  + GrantProposalIntent  + RewardClaimIntent          │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

## 3. Agent Treasury System

### 3.1 Current State
- `packages/agent-runtime/src/wallet.ts` — `AgentWallet` wraps viem, single address, no spending policies
- `packages/agent-runtime/src/base-agent.ts` — `BaseAgent` has tool registry + intent handlers, no budget tracking
- `packages/a2a/src/types.ts` — 24+ intent types, includes `PaymentRequestIntent` but no funding intents

### 3.2 Design: Hierarchical Agent Treasuries

```
┌─────────────────────────────────────────┐
│          Network Treasury (DAO)          │
│  Multi-sig: 3-of-5 agent committee      │
│  Holds: protocol fees, slashing bonds   │
│                                         │
│  ┌─────────────┐  ┌─────────────┐      │
│  │ Broker Pool │  │ Verifier    │      │
│  │ (BrokerAgent)│  │ Pool        │      │
│  │ Budget: 10K │  │ Budget: 5K  │      │
│  └──────┬──────┘  └──────┬──────┘      │
│         │                │              │
│  ┌──────▼──────┐  ┌──────▼──────┐      │
│  │ Job Escrows │  │ Verify Fees │      │
│  │ (per-job)   │  │ (per-check) │      │
│  └─────────────┘  └─────────────┘      │
└─────────────────────────────────────────┘
```

### 3.3 Spending Policy Engine

```typescript
// packages/agent-runtime/src/spending-policy.ts

export interface SpendingPolicy {
  /** Max amount per single transaction */
  maxPerTransaction: bigint;

  /** Max total spend per time window */
  maxPerWindow: bigint;
  windowDuration: number;            // seconds

  /** Auto-approve thresholds by intent type */
  autoApprove: Record<string, bigint>;

  /** Require human approval above this */
  humanApprovalThreshold: bigint;

  /** Delegation chain — who can override */
  delegationChain: string[];         // DIDs or addresses
}

export const DEFAULT_BROKER_POLICY: SpendingPolicy = {
  maxPerTransaction: parseUnits("100", 6),     // 100 USDC
  maxPerWindow: parseUnits("1000", 6),         // 1000 USDC/day
  windowDuration: 86400,
  autoApprove: {
    "SubmitWorkflowIntent": parseUnits("50", 6),   // Auto-approve jobs < $50
    "PaymentRequestIntent": parseUnits("10", 6),   // Auto-approve payments < $10
    "VerificationFeeIntent": parseUnits("5", 6),   // Auto-approve verify fees < $5
  },
  humanApprovalThreshold: parseUnits("500", 6),
  delegationChain: [],
};
```

### 3.4 Agent Wallet v2 (Budget-Aware)

```typescript
// packages/agent-runtime/src/wallet.ts — extended

export class AgentWallet {
  private policy: SpendingPolicy;
  private windowSpend: bigint = 0n;
  private windowStart: number = Date.now();

  async executeWithBudget(
    intent: string,
    amount: bigint,
    txBuilder: () => Promise<TransactionRequest>
  ): Promise<TransactionReceipt | { requiresApproval: true; reason: string }> {

    // Check per-transaction limit
    if (amount > this.policy.maxPerTransaction) {
      return { requiresApproval: true, reason: `Exceeds per-tx limit (${amount} > ${this.policy.maxPerTransaction})` };
    }

    // Check window limit
    this.refreshWindow();
    if (this.windowSpend + amount > this.policy.maxPerWindow) {
      return { requiresApproval: true, reason: `Exceeds window limit` };
    }

    // Check auto-approve threshold
    const autoLimit = this.policy.autoApprove[intent] ?? 0n;
    if (amount > autoLimit && amount > 0n) {
      if (amount > this.policy.humanApprovalThreshold) {
        return { requiresApproval: true, reason: `Exceeds human approval threshold` };
      }
      // Between auto-approve and human threshold: agent committee vote
      const approved = await this.requestCommitteeApproval(intent, amount);
      if (!approved) return { requiresApproval: true, reason: `Committee rejected` };
    }

    // Execute
    const tx = await txBuilder();
    const receipt = await this.sendTransaction(tx);
    this.windowSpend += amount;
    return receipt;
  }
}
```

### 3.5 Integration Points

| File | Change |
|------|--------|
| `packages/agent-runtime/src/wallet.ts` | Add `SpendingPolicy`, `executeWithBudget()`, budget tracking |
| `packages/agent-runtime/src/base-agent.ts` | Add `treasuryAddress`, `spendingPolicy` to `BaseAgentConfig` |
| `packages/a2a/src/types.ts` | Add `RequestFundingIntent`, `ApproveFundingIntent`, `TreasuryVoteIntent` |
| `packages/agent-broker/src/broker-agent.ts` | Use `executeWithBudget()` for job submissions |
| `packages/agent-user/src/user-agent.ts` | Use `executeWithBudget()` for payment requests |

---

## 4. Quadratic Funding for Physical Infrastructure

### 4.1 Concept

Community members fund manufacturing capabilities they want, and a **matching pool** amplifies small contributions quadratically:

```
User A contributes $10 to "Prusa MK4 in Brooklyn"     → √10 = 3.16
User B contributes $5 to "Prusa MK4 in Brooklyn"      → √5  = 2.24
User C contributes $100 to "Haas VF-2 CNC in Oakland" → √100 = 10.0

Matching factor for Brooklyn printer: (3.16 + 2.24)² = 29.16
Matching factor for Oakland CNC:     (10.0)²         = 100.0

But Brooklyn printer gets MORE matching per dollar contributed
because it had MORE individual contributors (breadth > depth).
```

### 4.2 Smart Contract: QuadraticFunding.sol

```solidity
// packages/contracts/src/QuadraticFunding.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract QuadraticFunding {
    struct Round {
        uint256 matchingPool;
        uint256 startTime;
        uint256 endTime;
        bool finalized;
        mapping(bytes32 => Project) projects;
        bytes32[] projectIds;
    }

    struct Project {
        string capabilityType;      // "fdm_printing", "cnc_milling"
        string location;            // Geohash or city
        address operator;           // Who will operate the equipment
        uint256 totalContributed;
        uint256 matchedAmount;
        mapping(address => uint256) contributions;
        address[] contributors;
    }

    /// Calculate quadratic matching for a project
    function calculateMatch(bytes32 projectId, uint256 roundId) public view returns (uint256) {
        Project storage project = rounds[roundId].projects[projectId];
        uint256 sumOfSqrts = 0;

        for (uint256 i = 0; i < project.contributors.length; i++) {
            uint256 contribution = project.contributions[project.contributors[i]];
            sumOfSqrts += sqrt(contribution);
        }

        return (sumOfSqrts * sumOfSqrts) - project.totalContributed;
    }

    /// Contribute to a capability project
    function contribute(bytes32 projectId, uint256 roundId, uint256 amount) external {
        IERC20(usdc).transferFrom(msg.sender, address(this), amount);
        Project storage project = rounds[roundId].projects[projectId];

        if (project.contributions[msg.sender] == 0) {
            project.contributors.push(msg.sender);
        }
        project.contributions[msg.sender] += amount;
        project.totalContributed += amount;
    }

    /// Finalize round and distribute matching
    function finalize(uint256 roundId) external {
        Round storage round = rounds[roundId];
        require(block.timestamp > round.endTime, "Round not ended");
        require(!round.finalized, "Already finalized");

        uint256 totalMatch = 0;
        uint256[] memory matches = new uint256[](round.projectIds.length);

        for (uint256 i = 0; i < round.projectIds.length; i++) {
            matches[i] = calculateMatch(round.projectIds[i], roundId);
            totalMatch += matches[i];
        }

        // Distribute matching pool proportionally
        for (uint256 i = 0; i < round.projectIds.length; i++) {
            uint256 matchAmount = (round.matchingPool * matches[i]) / totalMatch;
            round.projects[round.projectIds[i]].matchedAmount = matchAmount;
            // Transfer to operator
            IERC20(usdc).transfer(
                round.projects[round.projectIds[i]].operator,
                round.projects[round.projectIds[i]].totalContributed + matchAmount
            );
        }

        round.finalized = true;
    }
}
```

### 4.3 Dashboard Integration

New route: `/funding` — Quadratic Funding Dashboard

```
/funding                    → Active funding rounds, browse projects
/funding/round/:roundId     → Round detail (projects, contributions, matching)
/funding/project/:projectId → Project detail (capability, location, contributors)
/funding/contribute         → Contribute to a project
/funding/propose            → Propose a new capability project
```

### 4.4 Integration Points

| File | Change |
|------|--------|
| `packages/contracts/src/` | New `QuadraticFunding.sol` |
| `packages/spec/src/types/` | New `funding.ts` with `FundingRound`, `FundingProject`, `Contribution` types |
| `packages/gateway/src/routes/` | New `funding.ts` with 8 endpoints |
| `apps/dashboard/src/pages/` | New `FundingRoundPage.tsx`, `FundingProjectPage.tsx` |
| `apps/dashboard/src/stores/` | New `funding-store.ts` |
| `packages/a2a/src/types.ts` | Add `ProposeProjectIntent`, `ContributeIntent`, `MatchCalculationIntent` |

---

## 5. DePIN Reward Mechanics

### 5.1 Concept: Tokenized Capability Mining

Shop kernels **mine PCC tokens** by providing manufacturing capabilities to the network, similar to how Helium hotspots mine HNT:

```
Kernel provides capability → Completes verified job → Earns PCC tokens
                                      │
                                      ├── Base reward: job completion
                                      ├── Quality bonus: Tier 2/3 evidence
                                      ├── Availability bonus: 99%+ uptime
                                      └── Network bonus: underserved capability/region
```

### 5.2 Reward Distribution Contract

```solidity
// packages/contracts/src/PCCRewards.sol
contract PCCRewards {
    struct RewardEpoch {
        uint256 startBlock;
        uint256 endBlock;
        uint256 totalRewards;
        bool distributed;
    }

    struct KernelScore {
        uint256 jobsCompleted;
        uint256 evidenceTier;        // Average tier of evidence
        uint256 uptimePercent;       // Heartbeat-based
        uint256 uniqueCapabilities;  // Diversity bonus
        uint256 regionScarcity;      // Bonus for underserved areas
    }

    /// Calculate reward for a kernel in an epoch
    function calculateReward(
        address kernel,
        uint256 epochId
    ) public view returns (uint256) {
        KernelScore memory score = kernelScores[epochId][kernel];
        uint256 totalScore = getTotalNetworkScore(epochId);

        // Weighted score: jobs(40%) + quality(25%) + uptime(15%) + diversity(10%) + scarcity(10%)
        uint256 weightedScore =
            score.jobsCompleted * 40 +
            score.evidenceTier * 25 +
            score.uptimePercent * 15 +
            score.uniqueCapabilities * 10 +
            score.regionScarcity * 10;

        return (epochs[epochId].totalRewards * weightedScore) / (totalScore * 100);
    }
}
```

### 5.3 Integration Points

| File | Change |
|------|--------|
| `packages/contracts/src/` | New `PCCRewards.sol`, `PCCToken.sol` (ERC-20) |
| `packages/kernel/src/` | Add heartbeat emitter for uptime tracking |
| `packages/gateway/src/routes/` | New `rewards.ts` with epoch/claim endpoints |
| `apps/dashboard/src/pages/` | New `RewardsPage.tsx` (operator earnings, epoch history) |
| `packages/spec/src/types/` | New `rewards.ts` with `RewardEpoch`, `KernelScore`, `RewardClaim` |

---

## 6. Agent-to-Agent Economic Coordination

### 6.1 New A2A Intents for Funding

```typescript
// packages/a2a/src/types.ts — new intents

/** Agent requests funding from treasury for a specific purpose */
export interface RequestFundingIntent extends BaseIntent {
  type: "request_funding";
  recipientAgent: string;        // Agent DID or address
  amount: Amount;
  currency: Currency;
  purpose: "job_escrow" | "capability_investment" | "verification_bounty" | "infrastructure";
  justification: string;         // Human-readable reason
  deadline: string;              // ISO timestamp
  expectedROI?: string;          // "2.5x within 30 days"
}

/** Agent proposes a grant for new infrastructure */
export interface ProposeGrantIntent extends BaseIntent {
  type: "propose_grant";
  capabilityType: string;
  location: string;
  estimatedCost: Amount;
  operatorAddress: string;
  demandEvidence: string[];      // Links to job requests that couldn't be fulfilled
  matchingPoolContribution: Amount;
}

/** Treasury vote on a proposal */
export interface TreasuryVoteIntent extends BaseIntent {
  type: "treasury_vote";
  proposalId: string;
  vote: "approve" | "reject" | "abstain";
  voterWeight: number;           // Reputation-weighted
  reasoning: string;
}

/** Claim DePIN rewards for completed epoch */
export interface ClaimRewardsIntent extends BaseIntent {
  type: "claim_rewards";
  kernelId: string;
  epochId: number;
  claimedAmount: Amount;
  proof: string;                 // Merkle proof of eligibility
}

/** Agent delegates budget to sub-agent */
export interface DelegateBudgetIntent extends BaseIntent {
  type: "delegate_budget";
  fromAgent: string;
  toAgent: string;
  amount: Amount;
  scope: string[];               // Allowed intent types for spending
  expiry: string;                // ISO timestamp
}
```

### 6.2 BrokerAgent as Autonomous Fund Manager

The BrokerAgent becomes a **fund manager** that:
1. Receives job requests from UserAgents
2. Assesses available kernels and their costs
3. Allocates budget from the treasury to fund jobs
4. Routes surplus to quadratic funding for new capabilities

```typescript
// packages/agent-broker/src/funding-handler.ts

export class FundingHandler {
  async handleUnfulfilledDemand(intent: SubmitWorkflowIntent): Promise<void> {
    // 1. Check if any kernel can fulfill
    const available = await this.router.findCapable(intent.workflow);

    if (available.length === 0) {
      // 2. No capability available — propose infrastructure grant
      const grantIntent: ProposeGrantIntent = {
        type: "propose_grant",
        capabilityType: intent.workflow.steps[0].capabilityType,
        location: intent.preferredRegion ?? "any",
        estimatedCost: this.estimateEquipmentCost(intent.workflow),
        operatorAddress: "0x0000...",  // Open call
        demandEvidence: [intent.id],
        matchingPoolContribution: "100",  // Broker contributes $100 from treasury
      };

      await this.bus.publish(grantIntent);
      return;
    }

    // 3. Capability available — fund the job from treasury
    const cheapest = available.sort((a, b) => a.price - b.price)[0];
    await this.wallet.executeWithBudget(
      "SubmitWorkflowIntent",
      BigInt(cheapest.price),
      () => this.escrow.fundMilestone(cheapest.jobId, cheapest.price)
    );
  }
}
```

---

## 7. Governance: Shop Kernel DAO

### 7.1 Design: Token-Weighted Governance

```solidity
// packages/contracts/src/ShopKernelDAO.sol
contract ShopKernelDAO {
    struct Proposal {
        uint256 id;
        address proposer;
        string description;
        bytes calldata_;           // Encoded function call to execute
        uint256 forVotes;
        uint256 againstVotes;
        uint256 startBlock;
        uint256 endBlock;
        bool executed;
    }

    /// Voting power = reputation score + staked tokens + uptime bonus
    function getVotingPower(address kernel) public view returns (uint256) {
        uint256 reputation = reputationRegistry.getReputation(kernel);
        uint256 staked = pccToken.balanceOf(kernel);
        uint256 uptimeBonus = getUptimeBonus(kernel);
        return reputation + staked + uptimeBonus;
    }

    /// Proposals that can be governed:
    /// - Bond amounts per tier
    /// - Challenge window durations
    /// - Verification fee structures
    /// - New capability type registration
    /// - Slashing parameters
    /// - Treasury allocation ratios
}
```

### 7.2 Governable Parameters

| Parameter | Current Location | Current Value | Governance Target |
|-----------|-----------------|---------------|-------------------|
| Bond amounts | `spec/types/settlement.ts` `DEFAULT_BOND_CONFIGS` | Hardcoded per tier | On-chain, votable |
| Challenge windows | `spec/types/settlement.ts` | 24h-168h | On-chain, votable |
| Verification fees | `gateway/routes/zk-proofs.ts` | None (free) | Per-verification fee |
| Capability types | `spec/types/kernel.ts` `BuiltinCapabilityType` | Hardcoded enum | Registry, votable additions |
| Reward emissions | N/A | N/A | Epoch reward amount |
| Slashing rates | `contracts/MilestoneEscrow.sol` | 100% bond | Configurable % |
| Treasury allocation | N/A | N/A | % to rewards vs grants vs ops |

---

## 8. Multi-Chain Settlement

### 8.1 Current State
- `packages/contracts/src/MilestoneEscrow.sol` — Base Sepolia only
- `packages/payments/src/x402-middleware.ts` — USDC on Base Sepolia
- `packages/spec/src/types/common.ts` — `Currency = "USDC" | "ETH" | "DAI"`

### 8.2 Design: Solana + Base Dual Settlement

For the hackathon, add **Solana** as an alternative settlement chain:

```typescript
// packages/spec/src/types/common.ts — extended
export type Chain = "base-sepolia" | "base" | "solana-devnet" | "solana";
export type Currency = "USDC" | "ETH" | "DAI" | "SOL" | "USDC.solana";

// packages/payments/src/solana-client.ts
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferInstruction } from "@solana/spl-token";

export class SolanaSettlement {
  private connection: Connection;

  async fundEscrow(jobId: string, amount: number, buyer: PublicKey): Promise<string> {
    // Create escrow PDA (Program Derived Address)
    const [escrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), Buffer.from(jobId)],
      PROGRAM_ID
    );

    // Transfer USDC to escrow PDA
    const tx = new Transaction().add(
      createTransferInstruction(
        buyerTokenAccount,
        escrowPDA,
        buyer,
        amount * 1e6  // USDC has 6 decimals
      )
    );

    return await this.connection.sendTransaction(tx, [buyerKeypair]);
  }

  async releaseEscrow(jobId: string, amount: number, recipient: PublicKey): Promise<string> {
    // Release from escrow PDA to recipient — requires evidence verification
  }
}
```

### 8.3 Integration Points

| File | Change |
|------|--------|
| `packages/spec/src/types/common.ts` | Add `Chain` type, extend `Currency` |
| `packages/spec/src/types/settlement.ts` | Add `chain: Chain` to `EscrowConfig` |
| `packages/payments/src/` | New `solana-client.ts` for SPL token escrow |
| `packages/agent-runtime/src/wallet.ts` | Add Solana keypair support alongside viem |
| `packages/gateway/src/routes/escrow.ts` | Add chain parameter to escrow endpoints |

---

## 9. Implementation Priority (Hackathon-Scoped)

### Must-Have (Demo-Ready in 48h)
1. **Spending policies** on AgentWallet — auto-approve below threshold, budget tracking
2. **New A2A intents**: RequestFundingIntent, TreasuryVoteIntent, DelegateBudgetIntent
3. **BrokerAgent funding handler** — detect unmet demand, propose infrastructure grants
4. **Dashboard**: Agent treasury view, spending history, active proposals

### Nice-to-Have (If Time Permits)
5. **QuadraticFunding.sol** deployed on Base Sepolia testnet
6. **PCCRewards.sol** with basic epoch rewards
7. **Solana USDC escrow** as alternative settlement chain
8. **Funding round dashboard** with contribution UI

### Post-Hackathon
9. Full ShopKernelDAO governance
10. Multi-chain settlement (Optimism, Polygon, Solana mainnet)
11. Streaming payments via Sablier integration
12. Cross-chain atomic swaps for agent treasuries

---

## 10. Token Economics (Draft)

### PCC Token Utility
| Use | Mechanism |
|-----|-----------|
| **Staking** | Kernels stake PCC to join network, slashed for bad behavior |
| **Governance** | Vote weight = staked PCC + reputation score |
| **Payment** | Alternative payment for manufacturing jobs |
| **Rewards** | Earned by kernels for completing verified jobs |
| **Quadratic Matching** | Matching pool funded by protocol fees in PCC |

### Fee Structure
| Fee | Source | Destination |
|-----|--------|-------------|
| 2% job fee | Every completed job | Network treasury |
| 0.5% escrow fee | Escrow creation | Reward pool |
| 1% verification fee | Tier 2/3 verification | Verifier rewards |
| Slashing | Failed obligations | Burn (deflationary) |

### Distribution
| Allocation | % |
|-----------|---|
| Kernel rewards | 40% |
| Verifier rewards | 20% |
| Quadratic matching pool | 15% |
| Treasury (ops/dev) | 15% |
| Community grants | 10% |
