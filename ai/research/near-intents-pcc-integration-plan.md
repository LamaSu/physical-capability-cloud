# NEAR Intents × PCC: What to Absorb vs. What to Call

**Date:** 2026-03-19

---

## The Three Buckets

| Bucket | Meaning | Effort |
|--------|---------|--------|
| **ABSORB** | Write the pattern into PCC's codebase natively | Low-medium (days) |
| **BRIDGE** | Thin integration layer — PCC calls NEAR as external service | Medium (1-2 weeks) |
| **LEAVE** | NEAR infrastructure that can't/shouldn't be replicated | N/A |

---

## Bucket 1: ABSORB into PCC (write natively)

These are patterns and ideas from NEAR Intents that PCC should adopt as its own code — not by depending on NEAR, but by learning from the design.

### 1a. Multi-Wallet Signing Standards

**What NEAR has:** 8 signing standards (NEP-413, ERC-191, BIP-322, Ed25519, TIP-191, TON Connect, WebAuthn, SEP-53) — any wallet can sign intents.

**What PCC has:** `AgentWallet` (viem/EVM only) + `SolanaAgentWallet` (Solana only). Two separate classes, no unified interface.

**What to absorb:** A `UniversalSigner` interface that abstracts over signing backends.

```typescript
// packages/agent-runtime/src/universal-signer.ts
interface UniversalSigner {
  readonly chain: string;           // "evm", "solana", "near", "bitcoin"
  readonly address: Address;
  signMessage(message: Uint8Array): Promise<Signature>;
  signTypedData?(domain, types, value): Promise<Signature>;
  verify(message: Uint8Array, signature: Signature): Promise<boolean>;
}
```

**Effort:** ~1 day. Wrap existing `AgentWallet` and `SolanaAgentWallet` behind this interface. Add a NEAR signer later when bridging.

**Why absorb, not bridge:** This is a local abstraction — PCC agents need to sign things regardless of whether NEAR exists. The pattern is universal.

---

### 1b. Competing Solver/Quote Model for CapabilityRouter

**What NEAR has:** Open competition — multiple solvers race to fill orders in a 3-second window. Permissionless entry. Best price wins.

**What PCC has:** `CapabilityRouter` with deterministic scoring (0.3×price + 0.3×queue + 0.3×rep + 0.5×preferBonus). Single-pass — finds best match, doesn't run an auction.

**What to absorb:** A **quote request broadcast** pattern where multiple kernels can bid on a job, with a configurable time window.

```typescript
// Enhancement to packages/scheduler/src/router.ts
interface QuoteRequest {
  step: CWMStep;
  deadline: Timestamp;        // e.g., 30 seconds for standardized work
  maxResponses?: number;
}

interface KernelQuote {
  kernelId: Id;
  capability: Capability;
  quotedPrice: Amount;
  estimatedStart: Timestamp;
  estimatedDuration: number;  // ms
  expiresAt: Timestamp;
  signature: Signature;       // Kernel signs its quote
}

// CapabilityRouter.requestQuotes(req) → broadcasts to registered kernels
// Collects responses within deadline, returns sorted by score
```

**Effort:** ~2-3 days. Extend CapabilityRouter + add quote handler to KernelAgent. The MessageBus already supports broadcast — this is mostly a new intent type (`request_kernel_quote` / `kernel_quote_response`) and a timer.

**Why absorb:** PCC's routing problem is fundamentally different from NEAR's (constraint satisfaction, not just price). But the competitive bidding pattern improves price discovery for standardized capabilities where multiple kernels qualify. This doesn't need NEAR infrastructure at all.

---

### 1c. Internal Ledger for Micro-Settlements

**What NEAR has:** The Verifier contract is an internal ledger — swaps are just balance updates, no on-chain transfers until withdrawal. This makes settlement nearly free.

**What PCC has:** Every settlement hits the chain via `SettlementClient` → `MilestoneEscrow.sol`. Even with ERC-4337 batching (~50 per block), gas costs add up for high-frequency micro-operations.

**What to absorb:** An **internal balance ledger** in the gateway for high-frequency, low-value operations (x402 micropayments, sensor data access fees, small capability queries). Only settle on-chain periodically or when users withdraw.

```typescript
// packages/gateway/src/ledger/internal-ledger.ts
class InternalLedger {
  private balances: Map<Address, Map<TokenId, bigint>>;

  deposit(address, token, amount): void;     // On-chain deposit detected
  transfer(from, to, token, amount): void;   // Internal transfer (free)
  withdraw(address, token, amount): void;    // Triggers on-chain withdrawal
  getBalance(address, token): bigint;

  // Batch settlement: flush accumulated transfers to chain
  async flushToChain(threshold: bigint): Promise<string>;
}
```

**Effort:** ~3-4 days. New service in `@pcc/payments`. Wire into x402 middleware so micropayments settle internally, with periodic on-chain reconciliation.

**Why absorb:** This is a performance optimization pattern. PCC already has the x402 and escrow infrastructure — the internal ledger just reduces chain hits. No dependency on NEAR needed.

---

### 1d. Simulation/Dry-Run Endpoint

**What NEAR has:** `simulate_intents` — validates a full MultiPayload without modifying state. Returns what would happen, fees, and current salt. Critical for devs.

**What PCC has:** No equivalent. To test a workflow, you submit it for real.

**What to absorb:** A `POST /api/simulate` endpoint that runs a CWM through WorkflowCompiler + CapabilityRouter without creating actual jobs.

```typescript
// packages/gateway/src/routes/simulate.ts
POST /api/simulate/workflow
  Body: { cwm: CWM }
  Returns: {
    valid: boolean;
    executionPlan: ExecutionPlan;    // DAG with assigned kernels
    estimatedCost: Amount;
    estimatedDuration: number;
    routingDetails: RouteMatch[];
    warnings: string[];              // "Step 3: only 1 kernel available"
    tierRequirements: TierEvidenceRequirements[];
  }
```

**Effort:** ~1 day. WorkflowCompiler already does the heavy lifting — this just wraps it in a read-only endpoint.

**Why absorb:** Pure local feature. Every production system needs dry-run capability.

---

### 1e. Deadline/Expiry on All Signed Messages

**What NEAR has:** Every intent has a `deadline` field (ISO timestamp). Expired intents are rejected. Nonces include a rotating salt to prevent replay.

**What PCC has:** A2A messages have no built-in expiry. Quotes don't expire. Old messages could theoretically be replayed.

**What to absorb:** Add `deadline` and `nonce` fields to the A2A message envelope.

```typescript
// Enhancement to packages/a2a/src/types.ts
interface A2AMessage {
  // ... existing fields ...
  deadline?: Timestamp;    // Message rejected after this time
  nonce?: string;          // Unique per-message, prevents replay
  signature?: Signature;   // Optional: agent signs the message
}
```

**Effort:** ~1 day. Schema update + validation in MessageBus.send().

**Why absorb:** Basic protocol hygiene. Should have been there from day one.

---

## Bucket 2: BRIDGE to NEAR (thin integration layer)

These are NEAR Intents capabilities that PCC should consume as a service, via a thin adapter — not replicate.

### 2a. Cross-Chain Payment Ingress (the big one)

**What NEAR has:** 1Click Swap API — user deposits any token on any of 31+ chains → auto-converts to target token. SDKs in TypeScript, Go, Rust.

**What PCC needs:** Users can only pay in USDC on Base today. This limits adoption to users who already have USDC on Base.

**Integration:** A `NearIntentsPaymentAdapter` that lets users fund escrow from ANY chain/token.

```typescript
// packages/payments/src/near-intents/payment-adapter.ts
import { OneClickSDK } from '@defuse-protocol/one-click-sdk-typescript';

class NearIntentsPaymentAdapter {
  private sdk: OneClickSDK;

  /**
   * User wants to fund a PCC escrow with BTC, SOL, ETH, etc.
   * 1. Get a quote from NEAR Intents (any token → USDC on Base)
   * 2. Return deposit address to user
   * 3. Monitor deposit → NEAR auto-converts → USDC arrives in PCC treasury
   * 4. PCC internal ledger credits the user
   * 5. User can now fund escrow from internal balance
   */
  async createFundingIntent(params: {
    sourceToken: string;         // "BTC", "SOL", "ETH", etc.
    sourceChain: string;         // "bitcoin", "solana", "ethereum"
    targetAmount: bigint;        // USDC amount needed for escrow
  }): Promise<{
    depositAddress: string;      // User sends source token here
    expectedAmount: string;      // How much to send
    expiresAt: Timestamp;
    monitorUrl: string;          // Status polling endpoint
  }>;

  async checkFundingStatus(depositTxHash: string): Promise<
    'pending' | 'converting' | 'settled' | 'failed'
  >;
}
```

**Where it plugs in:**
- `AgentWallet.fundEscrow()` gets a new path: if user's source isn't USDC-on-Base, route through NearIntentsPaymentAdapter first
- Gateway gets `POST /api/payments/cross-chain/quote` and `POST /api/payments/cross-chain/deposit` routes
- Dashboard's escrow page gets a "Pay with any token" button that shows the deposit address + QR code

**Effort:** ~1 week. The 1Click SDK does the heavy lifting. PCC side is: adapter class, 2 gateway routes, 1 dashboard component, wire into AgentWallet.

**Why bridge, not absorb:** Replicating 31-chain MPC signatures + solver liquidity pool is impossible. Use NEAR's infrastructure; just wrap it.

**Dependencies:** `@defuse-protocol/one-click-sdk-typescript` (npm), NEAR Intents Partner Portal API key (for 50/50 rev share and no surcharge).

---

### 2b. Cross-Chain Operator Payouts

**What NEAR has:** `ft_withdraw` intent → Chain Signatures sign a native transaction on any destination chain.

**What PCC needs:** Kernel operators currently receive USDC on Base. An operator in the Solana ecosystem has to bridge manually.

**Integration:** When a milestone releases, offer operators a choice: receive on Base (instant) or convert to preferred chain/token via NEAR Intents.

```typescript
// Enhancement to SettlementClient
async releaseMilestone(milestoneIndex: number, opts?: {
  payoutChain?: string;    // "solana", "ethereum", "bitcoin", etc.
  payoutToken?: string;    // "SOL", "ETH", "BTC", etc.
  payoutAddress?: string;  // Destination address on target chain
}): Promise<string> {
  // 1. Release from MilestoneEscrow → USDC to PCC treasury
  // 2. If cross-chain requested: send USDC to NEAR Intents deposit
  // 3. NEAR converts and delivers to operator's address on target chain
}
```

**Effort:** ~3-4 days. Reuses the same NearIntentsPaymentAdapter, just in reverse.

**Why bridge:** Same reason — can't replicate 31-chain withdrawal infrastructure.

---

### 2c. NEAR AI Agent Market Registration

**What NEAR has:** Agent Market (Feb 2026) — natural-language task posting, agent bidding, escrow, AI dispute resolution. Supports "physical services" as a task type.

**What PCC could do:** Register PCC capabilities in the NEAR Agent Market so that NEAR users can discover and commission physical manufacturing through natural language.

**Integration:** A `NearAgentMarketBridge` that:
1. Monitors NEAR Agent Market for tasks matching PCC capability types
2. Translates natural-language task descriptions → PCC `CWM` format (using BrokerAgent's NLP)
3. Bids on matching tasks with PCC pricing
4. If accepted: creates a PCC job, executes, delivers evidence
5. Claims payment on NEAR Agent Market upon completion

```typescript
// packages/agent-broker/src/near-market-bridge.ts
class NearAgentMarketBridge {
  async pollTasks(): Promise<NearTask[]>;
  async translateToCWM(task: NearTask): Promise<CWM>;
  async bidOnTask(taskId: string, price: Amount): Promise<void>;
  async reportCompletion(taskId: string, evidence: EvidenceBundle): Promise<void>;
}
```

**Effort:** ~2 weeks. Requires NEAR AI Agent Market API access (not fully documented yet), NLP translation layer, and a monitoring loop.

**Why bridge:** This is demand-side acquisition — tapping into NEAR's user base to find manufacturing customers. PCC provides the supply; NEAR provides the marketplace.

**Risk:** NEAR Agent Market is brand new (Feb 2026) and the API may not be stable. This is a medium-term integration, not immediate.

---

### 2d. Multi-Chain Evidence Anchoring

**What NEAR has:** Chain Signatures can sign transactions on any chain. Currently PCC anchors commitments on Starknet only.

**What PCC could do:** Let users choose where to anchor their evidence commitments — Ethereum, Starknet, Solana, Bitcoin (OP_RETURN), etc.

```typescript
// Enhancement to packages/verifier/src/commitment-service.ts
async anchorCommitment(commitment: EvidenceCommitment, opts: {
  chain: 'starknet' | 'ethereum' | 'solana' | 'bitcoin' | 'near';
}): Promise<{ txHash: string; chain: string }> {
  if (opts.chain === 'starknet') return this.starknetAnchor(commitment);
  if (opts.chain === 'near') return this.nearAnchor(commitment);
  // For others: use NEAR Chain Signatures to sign a tx on target chain
  return this.nearCrossChainAnchor(commitment, opts.chain);
}
```

**Effort:** ~1 week. Depends on NEAR Chain Signatures API, which is well-documented.

**Why bridge:** Can't replicate MPC infrastructure. But the anchoring call is simple.

---

## Bucket 3: LEAVE on NEAR (don't touch)

These are NEAR Intents capabilities that are either impossible to replicate, irrelevant to PCC, or would be actively harmful to internalize.

| Capability | Why leave it |
|-----------|-------------|
| **Chain Signatures (MPC network)** | Requires validator network, threshold cryptography, distributed key management. This IS NEAR's infrastructure. |
| **Solver liquidity pool** | $1.8B volume, pre-funded solvers managing inventory across 31 chains. Can't bootstrap. |
| **Confidential Intents (TEE private shard)** | Requires NEAR's Nightshade 3.0 sharding + TEE bridge. PCC's encryption+ZK approach is better for its use case anyway (per-field granularity). |
| **NEAR token economics (buy-and-burn)** | Irrelevant to PCC. PCC has its own DePIN rewards + cNFT model. |
| **Solver Bus infrastructure** | The relay server + solver connections. PCC's MessageBus serves a different purpose (typed agent intents, not price quotes). |
| **1M TPS throughput** | PCC's bottleneck is physical machines, not chain throughput. Even 10 TPS is fine. |
| **NEP-245 multi-token standard** | NEAR-specific. PCC uses ERC-20 (USDC) and its own type system. |

---

## Integration Architecture Diagram

```
                    ┌─────────────────────────────────────┐
                    │           NEAR Protocol              │
                    │  ┌─────────────┐ ┌───────────────┐  │
                    │  │  Intents    │ │ AI Agent      │  │
                    │  │  Verifier   │ │ Market        │  │
                    │  │ (31 chains) │ │ (task bids)   │  │
                    │  └──────┬──────┘ └───────┬───────┘  │
                    │         │                 │          │
                    │  ┌──────┴──────┐ ┌───────┴───────┐  │
                    │  │ 1Click API  │ │ Agent Market  │  │
                    │  │ (swap/fund) │ │ API           │  │
                    │  └──────┬──────┘ └───────┬───────┘  │
                    └─────────┼────────────────┼──────────┘
                              │                │
              ════════════════╪════════════════╪══════ BRIDGE LAYER
                              │                │
                    ┌─────────┼────────────────┼──────────┐
                    │    PCC  │                │          │
                    │  ┌──────┴──────┐ ┌───────┴───────┐  │
                    │  │ NearIntents │ │ NearMarket    │  │
                    │  │ Payment     │ │ Bridge        │  │
                    │  │ Adapter     │ │ (broker ext)  │  │
                    │  └──────┬──────┘ └───────┬───────┘  │
                    │         │                │          │
                    │  ┌──────┴────────────────┴───────┐  │
                    │  │        Internal Ledger         │  │
                    │  │   (absorbed from NEAR pattern) │  │
                    │  └──────┬────────────────┬───────┘  │
                    │         │                │          │
                    │  ┌──────┴──────┐ ┌───────┴───────┐  │
                    │  │ Milestone   │ │ x402          │  │
                    │  │ Escrow      │ │ Middleware     │  │
                    │  │ (Base EVM)  │ │ (micro-pay)   │  │
                    │  └─────────────┘ └───────────────┘  │
                    └─────────────────────────────────────┘
```

---

## Priority Order

| # | Item | Bucket | Effort | Impact | Priority |
|---|------|--------|--------|--------|----------|
| 1 | Cross-chain payment ingress | BRIDGE | 1 week | **Critical** — unlocks users on 30+ chains | P0 |
| 2 | Simulation/dry-run endpoint | ABSORB | 1 day | **High** — essential for DX | P0 |
| 3 | Deadline/nonce on A2A messages | ABSORB | 1 day | **High** — protocol hygiene | P1 |
| 4 | Competing quote model | ABSORB | 2-3 days | **Medium** — improves price discovery | P1 |
| 5 | Internal ledger for micropayments | ABSORB | 3-4 days | **Medium** — reduces gas costs | P1 |
| 6 | UniversalSigner interface | ABSORB | 1 day | **Medium** — cleaner wallet abstraction | P2 |
| 7 | Cross-chain operator payouts | BRIDGE | 3-4 days | **Medium** — operator convenience | P2 |
| 8 | Multi-chain evidence anchoring | BRIDGE | 1 week | **Low-medium** — Starknet suffices for now | P3 |
| 9 | NEAR Agent Market registration | BRIDGE | 2 weeks | **Speculative** — API not stable yet | P3 |

**Total ABSORB effort:** ~8-10 days (items 2-6, can be parallelized)
**Total BRIDGE effort:** ~3-4 weeks (items 1, 7-9, sequential due to shared adapter)

---

## What This Changes in PCC's Package Map

```
MODIFIED:
  @pcc/spec           — Add deadline/nonce to A2AMessage, UniversalSigner type
  @pcc/a2a            — Message validation with expiry
  @pcc/scheduler      — Quote request broadcast + collection
  @pcc/agent-runtime  — UniversalSigner adapter over AgentWallet/SolanaAgentWallet
  @pcc/agent-kernel   — Quote response handler
  @pcc/payments       — Internal ledger + NearIntentsPaymentAdapter
  @pcc/gateway        — /api/simulate/*, /api/payments/cross-chain/*
  @pcc/dashboard      — "Pay with any token" component on escrow page

NEW (small):
  @pcc/payments/src/near-intents/     — NearIntentsPaymentAdapter
  @pcc/payments/src/ledger/           — InternalLedger
  @pcc/gateway/src/routes/simulate.ts — Simulation endpoint

NEW DEPS:
  @defuse-protocol/one-click-sdk-typescript  — 1Click Swap API client
```

---

## The Split, Summarized

**PCC owns:** Physical world (capabilities, evidence, workflows, sensors, machines, assurance tiers, disputes, ZK proofs, encryption, agent orchestration, dashboard).

**NEAR owns:** Financial plumbing (cross-chain value movement, solver liquidity, chain signatures, confidential transactions, token economics).

**The bridge:** A thin adapter (~500 lines) in `@pcc/payments` that speaks NEAR's 1Click API. PCC users see "Pay with BTC/SOL/ETH/anything" → NEAR converts → USDC arrives in PCC's internal ledger → escrow funded. Operators see "Receive payout on Solana/Ethereum/Bitcoin" → NEAR converts and delivers.

PCC absorbs the *patterns* (competing quotes, internal ledger, simulation, message expiry). PCC delegates the *infrastructure* (31-chain liquidity, MPC signatures, agent marketplace demand).
