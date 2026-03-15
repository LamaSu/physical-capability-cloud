# PCCP Evidence Verification Subnet — Bittensor Subnet Specification

## Overview

The PCCP Evidence Verification Subnet is a Bittensor subnet that decentralizes quality assurance for physical capabilities. When a Shop Kernel (lab instrument, printer, robot arm, courier) completes a job, it produces an evidence bundle — sensor data, calibration records, QC photos, chain of custody signatures. This subnet's miners evaluate that evidence and validators reach consensus on whether the evidence meets the required assurance tier.

**The output**: A quality score (0.0-1.0) and tier compliance verdict for every evidence bundle submitted to the PCCP network. This score determines whether escrow milestones release funds to operators.

---

## 1. Benchmark: Target Output Quality Metric

**Metric**: Evidence Quality Score (EQS) — a composite score from 0.0 to 1.0.

Miners are scored on their ability to accurately assess evidence bundles across 5 dimensions:

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| **Completeness** | 25% | Does the bundle contain all required event types for its assurance tier? |
| **Integrity** | 25% | Do all hashes verify? Is the bundle signature valid? Are timestamps monotonic? |
| **Calibration** | 20% | Are instrument calibration records present, recent, and within spec? |
| **Anomaly Detection** | 15% | Did the miner correctly identify sensor anomalies, drift, or out-of-range values? |
| **Tier Compliance** | 15% | Does the evidence depth match the claimed assurance tier (T0-T3)? |

**Target**: Miners should achieve EQS > 0.85 to remain competitive. The network's aggregate EQS target is > 0.95 — meaning 95%+ of evidence bundles are correctly evaluated.

**Ground truth**: For bootstrapping, a subset of bundles are pre-labeled by PCCP operators with known quality scores. Validators use these as calibration anchors.

---

## 2. Evaluation Loop: How Validators Score Miners

### Flow

```
1. Evidence bundle submitted to subnet via BittensorSubnetBridge
2. Synapse created: { bundleHash, bundleData, requiredTier }
3. Dendrite forwards to N miners (default: 5)
4. Each miner returns: { qualityScore, tierCompliant, defects[], confidence }
5. Validator aggregates responses using Yuma Consensus
6. Consensus score + tier verdict returned to PCCP
7. Validator updates miner weights based on agreement with consensus
```

### Scoring Algorithm

```python
for each miner_response:
  # Agreement with consensus (higher = better)
  agreement = 1.0 - abs(miner.qualityScore - consensus.qualityScore)

  # Tier compliance accuracy (binary)
  tier_correct = 1.0 if miner.tierCompliant == consensus.tierCompliant else 0.0

  # Defect detection F1 score
  defect_f1 = f1_score(miner.defects, consensus.defects)

  # Confidence calibration (penalize overconfident wrong answers)
  calibration = 1.0 - abs(miner.confidence - agreement)

  # Final miner score for this round
  score = 0.4 * agreement + 0.25 * tier_correct + 0.2 * defect_f1 + 0.15 * calibration
```

### Cost and Scale

| Factor | Value |
|--------|-------|
| **Bundle size** | 1-50 KB (JSON with hashes, no raw sensor data) |
| **Evaluation time** | < 2 seconds per bundle per miner |
| **Miners per query** | 5 (configurable, min 3 for consensus) |
| **Validator cost** | Minimal — aggregation is arithmetic, not GPU |
| **Throughput** | ~1000 bundles/hour per validator at 5 miners each |
| **Storage** | Miners don't store bundles — evaluate and return score |

This subnet is CPU-bound, not GPU-bound. Evidence evaluation is rule-based analysis (hash verification, schema checking, statistical anomaly detection), not model inference. This makes it cheap to run and accessible to a wide miner base.

---

## 3. Miner Task: What Miners Actually Do

### Input (Synapse)

```typescript
interface EvidenceVerificationSynapse {
  bundleHash: SHA256;           // Content-addressed hash of the bundle
  bundleData: string;           // JSON-serialized evidence bundle
  requiredTier: 0 | 1 | 2 | 3; // Assurance tier to evaluate against
}
```

### Task

Given an evidence bundle and a required assurance tier, the miner must:

1. **Parse** the bundle and verify it's well-formed JSON matching the EvidenceBundle schema
2. **Verify hashes** — each event's `eventHash` must match `SHA256(canonical(event))`, and `bundleHash` must match `SHA256(canonical(events))`
3. **Check completeness** — does the bundle contain the required event types for the claimed tier?
   - Tier 0: `execution_started` + `execution_completed` (minimum)
   - Tier 1: Tier 0 + `power_profile_summary` + at least one sensor event
   - Tier 2: Tier 1 + `calibration_record` + `cv_inspection_result`
   - Tier 3: Tier 2 + `camera_snapshot` (continuous) + external verifier attestation
4. **Detect anomalies** — flag suspicious patterns:
   - Timestamps out of order
   - Identical consecutive sensor readings (flatline)
   - Power profile inconsistent with claimed operation (e.g., 0W during "execution")
   - Missing chain of custody for multi-hop workflows
5. **Score** — return quality score (0.0-1.0), tier compliance (bool), detected defects (string[]), and confidence (0.0-1.0)

### Output

```typescript
interface EvidenceVerificationResponse {
  qualityScore: number;         // 0.0-1.0 composite quality
  tierCompliant: boolean;       // Does evidence meet the required tier?
  defects: string[];            // Detected issues: ["missing_calibration", "flatline_sensor", ...]
  confidence: number;           // 0.0-1.0 how confident the miner is
  evaluationTimeMs: number;     // How long the evaluation took
}
```

### Implementation Reference

See `packages/verifier/src/bittensor/mock-miner.ts` for the reference implementation. The MockMiner implements quality tiers (excellent/good/mediocre/poor) that simulate the range of miner competence the network should expect.

---

## 4. Incentive Design

### Why Scoring Rewards Genuine Quality

1. **Consensus-based truth**: No single miner can manipulate the score. Yuma Consensus requires agreement across multiple independent evaluators. A miner that consistently disagrees with consensus gets lower weights.

2. **Calibration anchoring**: A subset of bundles have known ground-truth scores (pre-labeled by operators). Miners that deviate from ground truth on calibration bundles lose weight rapidly.

3. **Confidence penalty**: Miners must report confidence. Overconfident wrong answers are penalized more than uncertain wrong answers. This prevents "always report 1.0" attacks.

4. **Defect detection reward**: Finding real defects that other miners miss is rewarded (first-discoverer bonus). This incentivizes thorough evaluation over rubber-stamping.

### Attack Vectors and Defenses

| Attack | Defense |
|--------|---------|
| **Always approve (rubber stamp)** | Calibration bundles with known defects catch this. Miner weight drops to 0. |
| **Copy other miners** | Synapse responses are encrypted until aggregation. No peeking. |
| **Sybil (many low-quality miners)** | Yuma Consensus weights by stake + historical accuracy. New miners start with low weight. |
| **Collusion** | Requires >50% of stake to collude. With diverse global miners, this is economically infeasible. |
| **Denial of service** | Timeouts enforced. Non-responsive miners get 0 score for the round. |
| **Data poisoning (fake bundles)** | Bundles are content-addressed (SHA-256). Tampering changes the hash and is immediately detectable. |

---

## 5. Market Demand: Who Pays and Why

### Primary Customer: PCCP Network Participants

Every PCCP workflow involves evidence verification. The demand is structural — no evidence verification means no escrow release means no payment to operators. The subnet is not optional; it's the trust layer.

| Actor | Why They Pay | Payment Mechanism |
|-------|-------------|-------------------|
| **Workflow submitters** | Need assurance that operators actually did the work | Verification fee included in escrow |
| **Operators** | Need their evidence verified to get paid | Bond posted, returned on verification |
| **Dispute challengers** | Need independent evidence evaluation | Challenge bond covers verification cost |

### Market Size

- **Contract research organizations (CROs)**: $82B market (2025). Every assay, every synthesis, every analysis produces evidence that needs independent QA.
- **Manufacturing QA**: $15B market. ISO/GLP compliance requires documented, verified evidence chains.
- **Supply chain verification**: $5B market. Chain of custody for pharmaceuticals, biologics, specialty chemicals.
- **DePIN networks**: Growing ecosystem of physical infrastructure networks that need off-chain work verification.

### Revenue Model

```
Per-verification fee: ~$0.01-0.10 (scales with tier complexity)
Volume at scale: 10,000+ verifications/day
Daily subnet revenue: $100-1,000/day
Miner earnings: Proportional to weight × stake
```

The fee is embedded in PCCP escrow milestones — users don't pay it separately. It's deducted from the operator's payment as a "verification tax" (typically 1-2% of milestone value).

---

## 6. Sovereignty Test

**Question**: Does this subnet survive if any single cloud provider, company, or API disappears?

### Yes. Here's why:

| Dependency | If It Disappears | Subnet Survives? |
|-----------|-----------------|-----------------|
| **AWS/GCP/Azure** | Miners and validators run on any hardware. No cloud lock-in. | Yes |
| **PCCP (the company)** | The subnet, smart contracts, and evidence format are open source. Anyone can submit bundles. | Yes |
| **Bittensor (the network)** | The evidence verification logic is standalone. Can run as independent validators. | Yes (degraded — loses incentive layer) |
| **IPFS** | Evidence bundles are content-addressed but can be stored anywhere. Hash verification works without IPFS. | Yes |
| **Lit Protocol** | Encryption is AES-256-GCM locally. Lit adds access control but isn't required for verification. | Yes |
| **Base/Solana** | Settlement can move to any EVM chain. Evidence verification is chain-agnostic. | Yes |
| **A specific miner** | Other miners fill the gap. Yuma Consensus adapts weights. | Yes |
| **A specific validator** | Other validators continue. No single validator is critical. | Yes |

### Key Sovereignty Properties

1. **No API keys required**: The evidence verification task is self-contained. Miners need no external API access — just the bundle data and the schema spec.

2. **Open evidence format**: The `EvidenceBundle` schema is open source and versioned. Any party can build a compliant miner.

3. **Deterministic verification**: Hash checking, schema validation, and tier compliance are deterministic. Two honest miners will always agree on these dimensions.

4. **No proprietary models**: Unlike ML-based subnets, this subnet uses rule-based evaluation. No proprietary model weights needed.

5. **Portable stake**: Miner and validator stakes are on Bittensor. If PCCP disappears, the subnet can serve other evidence verification use cases (supply chain, audit trails, compliance records).

---

## Implementation Status

| Component | Status | Location |
|-----------|--------|----------|
| MockMiner (quality tiers) | Implemented + tested | `packages/verifier/src/bittensor/mock-miner.ts` |
| MockValidator (Yuma Consensus) | Implemented + tested | `packages/verifier/src/bittensor/mock-validator.ts` |
| BittensorSubnetBridge | Implemented + tested | `packages/verifier/src/bittensor/subnet-bridge.ts` |
| Synapse types | Implemented | `packages/verifier/src/bittensor/types.ts` |
| Evidence verification logic | Implemented + tested | `packages/verifier/src/evidence-verifier.ts` |
| Bittensor tests | 22 passing | `packages/verifier/src/__tests__/bittensor.test.ts` |
| Testnet deployment | Ready (needs TAO for registration) | — |

### Running the Implementation

```bash
# Run Bittensor subnet tests
cd packages/verifier && pnpm test

# Run sovereign e2e (includes Bittensor Phase 8)
npx tsx scripts/sovereign-e2e-simulation.ts

# Run hackathon demo (includes Bittensor verification)
npx tsx scripts/hackathon-demo.ts
```

---

## Team

**Ryan George** — Builder, Frontier Tower SF

## Links

- **GitHub**: https://github.com/global-mysterysnailrevolution/physical-capability-cloud
- **Live Dashboard**: https://pcc-gateway-production.up.railway.app
- **Demo**: `npx tsx scripts/hackathon-demo.ts` (2.5 seconds, full pipeline)
