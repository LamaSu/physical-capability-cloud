# Oracle Architecture and Wiring Points for Digital-Verifier Primitives

**Research report — Digital Verifier Primitives**
**Date**: 2026-04-11
**Author**: Deep-research subagent
**Target**: PCC oracle cascade — wiring 6 new primitives (touchstone, workflowSteps, step_completeness, assuranceScore, workflowChallenge, ephemeralIdentity) into the existing oracle verification infrastructure

---

## 1. Existing Oracle Architecture

### 1.1 Block Diagram

The oracle system lives at `C:\Users\globa\physical-capability-cloud\packages\verifier\src\oracle\` and implements a three-tier cascade:

```
Evidence Bundle + Assurance Tier
         │
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    OracleVerificationBridge                          │
│                    (oracle-bridge.ts)                                │
│                                                                      │
│  for (oracle of [UMA, Chainlink, EigenLayer]) {                     │
│    if (!oracle.isAvailable()) continue;                              │
│    try { return oracle.submitForVerification(...) }                  │
│    catch { continue; }                                               │
│  }                                                                   │
│  return FAILURE (all_oracles_unavailable)                            │
└──────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  UMAOracleAdapter│  │ChainlinkOracle  │  │EigenLayerOracle │
│  (PRIMARY)       │  │Adapter (FALLBACK)│  │Adapter (STUB)   │
│  uma-adapter.ts  │  │chainlink-       │  │eigenlayer-      │
│                  │  │adapter.ts       │  │adapter.ts       │
│  Mock: local eval│  │Mock: local eval │  │Always unavail.  │
│  Live: OOv3 on   │  │Live: Functions  │  │unless .enable() │
│  Base Sepolia    │  │DON on Base Sep. │  │                 │
└────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘
         │                     │                      │
         └──────────┬──────────┘                      │
                    ▼                                  │
         ┌──────────────────┐                         │
         │ evaluateEvidence()│◄────────────────────────┘
         │ evidence-         │
         │ evaluator.ts      │
         │                   │
         │ Checks:           │
         │ 1. Hash integrity │
         │ 2. Tier compliance│
         │ 3. Event count    │
         │ 4. Sensor plausi- │
         │    bility         │
         │ 5. Timestamp order│
         └──────────────────┘
```

### 1.2 Cascade Logic

The cascade is a simple ordered loop — **UMA first, then Chainlink, then EigenLayer**. The order is hardcoded in `oracle-bridge.ts` line 55:

```typescript
this.oracles = [this.umaAdapter, this.chainlinkAdapter, this.eigenlayerAdapter];
```

Each oracle's `isAvailable()` gates entry. If available but `submitForVerification()` throws, the error is caught and the next oracle is tried. Only when all three fail does the bridge return a failure result with `oracle: "none"` and `defects: ["all_oracles_unavailable"]`.

The cascade is **not** a consensus mechanism. Only one oracle produces the result. There is no voting, no quorum, no multi-oracle agreement. The fallback exists purely for availability — if UMA's contract call fails or the wallet has no LINK, Chainlink takes over.

### 1.3 Evidence Evaluator: The Shared Core

All three adapters delegate to the same `evaluateEvidence()` function (at least in mock mode). This is the deterministic evaluation core extracted from the old `MockMiner`. It runs five checks:

1. **Hash integrity** — `bundle.bundleHash === bundleHash` argument check
2. **Tier compliance** — cross-references `DEFAULT_TIER_REQUIREMENTS` from `@pcc/spec` to verify the bundle contains the required event types and minimum event count for the declared tier
3. **Event count** — rejects empty bundles
4. **Sensor plausibility** — range checks on `power_profile_summary` (0 < avgWatts < 50000), `temperature_log` (-273.15 < temp < 5000)
5. **Timestamp ordering** — events must be in non-decreasing chronological order

The score is `1.0 - (defects.length * 0.2)`, floored at 0. A bundle passes if `score >= minScoreThreshold (default 0.6)` AND `tierCompliant === true`.

### 1.4 Two Oracle Systems

A critical finding: PCC actually has **two distinct oracle systems** that serve different roles:

1. **`OracleVerificationBridge`** (packages/verifier/src/oracle/) — The three-tier cascade described above. Used by the gateway at `POST /api/verification/subnet-submit` (in `zk-proofs.ts`). This is the on-chain-capable verification path.

2. **`verifyWithOracle()`** (packages/gateway/src/services/oracle-client.ts) — A separate HTTP client that calls the proprietary PCC Oracle running on Spark at `http://192.168.108.72:4100` (exposed publicly via Cloudflare tunnel at `https://refer-proxy-joint-cleaning.trycloudflare.com`). This oracle performs a different set of checks (`evidenceExists`, `hashMatches`, `tierMet`, `notReplay`, `identityValid`) and issues cryptographic attestations with signature + nonce. Used by the paid job flow at `PUT /api/jobs/:jobId/complete`.

The proprietary oracle is the one that gates settlement. Every `PUT /api/jobs/:jobId/complete` call goes through `verifyWithOracle()` before the escrow can release. If it returns `verified: false`, the endpoint returns 422.

These two systems need to be harmonized for the new primitives. The `OracleVerificationBridge` handles the on-chain verification path (UMA assertions, Chainlink DON scores), while the proprietary oracle handles the settlement-gating verification. Both need awareness of the new primitives, but at different layers.

### 1.5 Gateway Wiring

The `OracleVerificationBridge` is instantiated as a singleton in `zk-proofs.ts`:

```typescript
const subnetBridge = new OracleVerificationBridge(configFromEnv());
```

Configuration is driven entirely by environment variables: `CHAIN_ID`, `BASE_RPC_URL`, `UMA_OOV3_ADDRESS`, `UMA_BOND_TOKEN`, `CHAINLINK_ROUTER`, `CHAINLINK_DON_ID`, `CHAINLINK_SUB_ID`, `ORACLE_MOCK` (defaults to `true`).

The paid job flow uses `verifyWithOracle()` separately, configured by `PCC_ORACLE_URL` and `PCC_ORACLE_KEY`.

### 1.6 Live Oracle Status

The proprietary oracle at `https://refer-proxy-joint-cleaning.trycloudflare.com` is confirmed live:

```json
{"status":"ok","oracle":"0x3850F24ACd88F6729692e2d05F75d499F0a661f5","chainId":84532}
```

It runs as a systemd user unit on Spark (`pcc-oracle.service`), exposed through a cloudflared quick tunnel. The tunnel URL is ephemeral — it changes on cloudflared restart. This URL is hardcoded in `scripts/real-e2e.ts` line 34 and `scripts/real-e2e-verbose.ts` line 21.

### 1.7 Contract Layer

`MilestoneEscrow.sol` at `C:\Users\globa\physical-capability-cloud\packages\contracts\src\MilestoneEscrow.sol` defines the on-chain settlement flow:

```
fund → submitEvidence → submitAttestation → [challenge window] → release
```

The oracle does **not** write directly to `MilestoneEscrow.sol`. Instead, the gateway receives the oracle's attestation and can then call `submitAttestation()` on-chain with the attestation hash. The milestone status progression is: `Unfunded → Funded → Locked → Evidenced → Attested → Released` (or `Disputed → Refunded/Slashed`).

`ChainlinkEvidenceVerifier.sol` at `C:\Users\globa\physical-capability-cloud\packages\contracts\src\ChainlinkEvidenceVerifier.sol` is a separate on-chain consumer that submits evidence hashes to the Chainlink DON for off-chain JS evaluation, returning a 0-100 score.

---

## 2. Oracle Cascade Order and Primitive Placement

The existing cascade runs in a single pass: UMA → Chainlink → EigenLayer. The new primitives fit into a three-phase model around this cascade:

```
╔══════════════════════════════════════════════════════════════════════╗
║                        PRE-ORACLE PHASE                             ║
║  Runs BEFORE any oracle adapter is called.                          ║
║  Failures here zero the evidence — it never reaches the cascade.    ║
║                                                                      ║
║  1. ephemeralIdentity — verify sessionKey derivation chain           ║
║     └─ Check: sessionKey → parentRegistration → principalKey         ║
║     └─ If invalid: reject immediately (no oracle cost spent)         ║
║                                                                      ║
║  2. touchstone — check if this bundle contains a touchstone task     ║
║     └─ If touchstone answer is WRONG: zero the evidence score,       ║
║        mark defect "touchstone_failure", skip oracle entirely        ║
║     └─ If touchstone answer is correct (or no touchstone): proceed   ║
║                                                                      ║
║  3. workflowChallenge — verify block anchor freshness                ║
║     └─ Re-fetch blockHash from Base Sepolia RPC                      ║
║     └─ Recompute proofHash = H(challengeId || blockHash || output)   ║
║     └─ If mismatch: reject as replay                                 ║
╚══════════════════════════════════════════════════════════════════════╝
                              │
                              ▼
╔══════════════════════════════════════════════════════════════════════╗
║                     IN-ORACLE PHASE (cascade)                        ║
║  The existing UMA → Chainlink → EigenLayer cascade.                  ║
║  evaluateEvidence() is extended with new checks.                     ║
║                                                                      ║
║  4. step_completeness — every declared workflow step has output       ║
║     └─ Added as check #6 in evaluateEvidence()                       ║
║     └─ Requires workflowSteps from the contract to be passed in      ║
║                                                                      ║
║  5. assuranceScore — composite scalar (0.0-1.0) rolled up from       ║
║     all checks: touchstone pass rate, step completeness,             ║
║     hash integrity, tier compliance, challenge freshness             ║
║     └─ Replaces the current defect-count scoring in evaluateEvidence║
║     └─ Surfaced in OracleVerificationResult as new field             ║
║                                                                      ║
║  6. workflowSteps — contract-aware validation                        ║
║     └─ evaluateEvidence() receives optional contract parameter       ║
║     └─ Cross-references declared steps against evidence events       ║
╚══════════════════════════════════════════════════════════════════════╝
                              │
                              ▼
╔══════════════════════════════════════════════════════════════════════╗
║                      POST-ORACLE PHASE                               ║
║  After oracle verdict is returned.                                   ║
║                                                                      ║
║  7. Reputation propagation                                           ║
║     └─ assuranceScore feeds into ERC-8004 ReputationFeedback         ║
║     └─ ephemeralIdentity: reputation accrues to principalKey,        ║
║        not sessionKey                                                ║
║     └─ touchstone failures trigger severe reputation penalties        ║
║                                                                      ║
║  8. Attestation storage                                              ║
║     └─ Oracle attestation includes assuranceScore + challengeProof   ║
║     └─ Stored for on-chain submission to MilestoneEscrow             ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## 3. Primitive-by-Primitive Wiring Analysis

### 3.1 Touchstone (R01)

**Where**: Pre-oracle phase.

**Rationale**: Touchstone verification must run before the oracle cascade because a touchstone failure is a fundamental trust violation — the kernel did not execute the work. Spending gas on a UMA assertion or LINK on a Chainlink DON call for evidence that a touchstone already proved fraudulent is wasteful. The touchstone check should be the cheapest possible gate.

**Wiring mechanics**:

The `OracleVerificationBridge.submitForVerification()` method currently takes `(bundleHash, bundleData, requiredTier)`. For touchstone support, it needs access to the touchstone library to determine if a task in the bundle was a touchstone and whether the answer was correct. Two options:

1. **Option A (recommended)**: Add a pre-check hook in `oracle-bridge.ts` that receives the parsed bundle and runs touchstone verification before entering the `for (const oracle of this.oracles)` loop. If the touchstone check fails, return immediately with `passed: false, defects: ["touchstone_failure"], oracle: "pre-check"`.

2. **Option B**: Push touchstone checking into `evaluateEvidence()`. This is simpler but means the check runs inside the cascade, not before it.

For Tier 3 jobs, touchstone results should also be committed on-chain via the oracle. The touchstone pass/fail status and injection rate should be included in the `OracleVerificationResult.details` metadata so that the attestation submitted to `MilestoneEscrow.submitAttestation()` carries this data.

**Impact on proprietary oracle**: The Spark oracle at `oracle-client.ts` needs a new check field: `touchstoneValid: boolean` added to `OracleResponse.result.checks`. The oracle service itself needs to import the touchstone library and run verification.

### 3.2 workflowSteps (R02)

**Where**: Contract layer input, consumed in-oracle.

**Rationale**: The workflow steps live in the `BuilderContract` / `contractTerms`. They define what the executor was supposed to do. The oracle needs this contract alongside the evidence bundle to verify that the executor actually completed every declared step.

**Wiring mechanics**:

The core API change is to `OracleVerificationBridge.submitForVerification()`:

```typescript
// Current signature:
submitForVerification(bundleHash: string, bundleData: string, requiredTier: number)

// Extended signature:
submitForVerification(
  bundleHash: string,
  bundleData: string,
  requiredTier: number,
  options?: {
    workflowContract?: WorkflowContract;     // from contract-builder
    touchstoneResults?: TouchstoneResult[];   // from touchstone verifier
    challengeAnchor?: ChallengeAnchor;        // from challenge service
    sessionKeyChain?: SessionKeyChain;        // from ephemeral identity
  }
)
```

The `options` parameter is entirely optional for backward compatibility. Old callers that pass only three arguments continue to work. The `VerificationOracle` interface gets the same extension on its `submitForVerification` method.

The `workflowContract` is passed down to `evaluateEvidence()` which gains a new check: for each step declared in the contract, verify that the evidence bundle contains at least one event with a matching `stepId` and a valid output schema.

**Impact on gateway**: `POST /api/verification/subnet-submit` gains an optional `workflowContract` field in its request body. `PUT /api/jobs/:jobId/complete` already has access to the session's `contractTerms` and can pass them to `verifyWithOracle()`.

### 3.3 step_completeness (R03)

**Where**: In-oracle, via `evaluateEvidence()`.

**Rationale**: Step completeness is a check that every declared workflow step produced schema-valid output. It is a natural extension of the existing tier compliance check (#2 in `evaluateEvidence()`).

**Wiring mechanics**:

Add check #6 to `evaluateEvidence()`:

```typescript
// After existing checks 1-5:

// 6. Step completeness (when workflow contract is provided)
if (workflowContract?.steps) {
  defects.push(...checkStepCompleteness(bundle, workflowContract.steps));
}
```

The `checkStepCompleteness()` function:
- Iterates over `workflowContract.steps`
- For each step, finds the evidence event(s) with matching `stepId`
- If no matching event exists: `defect: "step_missing:{stepId}"`
- If the event's output fails schema validation against the step's declared `outputSchema`: `defect: "step_output_invalid:{stepId}"`
- If a step declares dependencies and those dependencies' events have timestamps after this step's events: `defect: "step_order_violation:{stepId}"`

The existing `evaluateEvidence()` signature changes from `(bundleHash, bundleData, requiredTier)` to `(bundleHash, bundleData, requiredTier, workflowContract?)`. The function remains a pure function — no side effects, no network calls.

### 3.4 assuranceScore (R04)

**Where**: Rollup in `evaluateEvidence()`, surfaced through oracle result types.

**Rationale**: The current scoring model (`1.0 - defects.length * 0.2`) is crude. An assurance score is a weighted composite that captures multiple dimensions of evidence quality.

**Wiring mechanics**:

1. **`EvaluationResult` type** (evidence-evaluator.ts) gets a new field:
   ```typescript
   export interface EvaluationResult {
     score: number;           // existing — overall pass/fail score
     tierCompliant: boolean;  // existing
     defects: string[];       // existing
     assuranceScore: number;  // NEW — weighted composite 0.0-1.0
     assuranceBreakdown?: {   // NEW — per-dimension scores
       hashIntegrity: number;
       tierCompliance: number;
       sensorPlausibility: number;
       timestampOrdering: number;
       stepCompleteness?: number;
       touchstonePassRate?: number;
       challengeFreshness?: number;
     };
   }
   ```

2. **`OracleVerificationResult` type** (types.ts) gets the same field:
   ```typescript
   export interface OracleVerificationResult {
     // ... existing fields ...
     assuranceScore?: number;           // NEW
     assuranceBreakdown?: Record<string, number>;  // NEW
   }
   ```

3. **Backward-compatible `VerificationResult`** (types.ts) maps `assuranceScore` alongside `consensusScore`:
   ```typescript
   export interface VerificationResult {
     // ... existing fields ...
     assuranceScore?: number;  // NEW — direct pass-through
   }
   ```

4. **Scoring formula**: Each dimension is scored 0.0-1.0 independently. The composite is a weighted sum:
   - Hash integrity: weight 0.25 (binary — 1.0 or 0.0)
   - Tier compliance: weight 0.20
   - Sensor plausibility: weight 0.10
   - Timestamp ordering: weight 0.10 (binary)
   - Step completeness: weight 0.15 (ratio of completed steps)
   - Touchstone pass rate: weight 0.10 (rolling average)
   - Challenge freshness: weight 0.10 (binary)
   
   Weights are configurable via the `OracleConfig` or a new `ScoringConfig`.

5. **UMA integration**: The assurance score can be encoded into the UMA assertion claim text so disputants can reference it. The claim text changes from `PCC Evidence: bundleHash=... tier=...` to include `assuranceScore=0.85`.

6. **Chainlink integration**: The Chainlink DON JS source can be extended to return the assurance score as part of its uint256 response. The current 0-100 integer maps naturally to a 0.00-1.00 float.

### 3.5 workflowChallenge (R05)

**Where**: Pre-oracle phase for verification; contract layer for issuance.

**Rationale**: The challenge anchor binds evidence to a specific moment in time. Verification requires re-fetching a block hash from Base Sepolia, which requires RPC access. This should happen before the oracle cascade because replay detection is a prerequisite for trusting any evidence at all.

**Wiring mechanics**:

1. **Pre-oracle check in `oracle-bridge.ts`**: Before the cascade loop, if `options.challengeAnchor` is provided:
   - Extract `blockNumber` and `expectedBlockHash` from the anchor
   - Call `publicClient.getBlock({ blockNumber })` to re-fetch the block hash
   - Compare: if `fetchedBlockHash !== expectedBlockHash`, reject with `defect: "challenge_block_mismatch"`
   - Verify `proofHash = H(challengeId || blockHash || workOutputRoot)` matches the evidence bundle's declared proof hash
   - If verification fails: `defect: "challenge_proof_invalid"` — reject without entering cascade

2. **RPC access**: The `OracleVerificationBridge` already has `rpcUrl` in its config. The pre-oracle challenge check uses this same RPC to fetch block data. No new configuration needed.

3. **Reorg protection**: If the block number is within the last 64 blocks (Base L2 finality window), the check should warn but not hard-fail. Add a `recentBlockWarning` flag to the result metadata.

4. **Impact on the proprietary oracle**: The Spark oracle needs a new check: `challengeFresh: boolean` added to `OracleResponse.result.checks`. The oracle service itself needs RPC access to verify block hashes. It already has `chainId: 84532` and can use its existing viem client.

### 3.6 ephemeralIdentity (R06)

**Where**: Pre-oracle phase.

**Rationale**: Session key verification is a signature chain check — it validates that the signer of the evidence bundle holds a session key derived from a registered principal key. This is pure cryptography, no oracle cost, and should run first.

**Wiring mechanics**:

1. **Pre-oracle check in `oracle-bridge.ts`**: If `options.sessionKeyChain` is provided:
   - Verify the session key's derivation signature against the parent key
   - Verify the parent key is registered in the principal key registry (this may require an on-chain read or a local cache)
   - Verify the evidence bundle's `kernelSignature` was produced by the session key
   - If any step fails: reject with `defect: "session_key_chain_invalid"`

2. **Oracle adapters never see session keys**: The adapters see attestations signed by principal keys. The session-key-to-principal-key resolution happens in the pre-oracle phase. The oracle result's metadata may include `principalKey` for reputation routing, but never the session key itself.

3. **Reputation propagation**: After the oracle returns a verdict, reputation feedback flows to the ERC-8004 `ReputationRegistry` keyed by the **principal key**, not the session key. This happens in the post-oracle phase and is wired in the gateway, not in the oracle bridge itself.

4. **Impact on `EvidenceVerifier`**: The `EvidenceVerifier.verify()` method at `C:\Users\globa\physical-capability-cloud\packages\verifier\src\evidence-verifier.ts` gains a new check between steps 2 and 3:
   ```typescript
   // 2.5. Verify session key chain (if provided)
   if (sessionKeyChain) {
     const chainValid = verifySessionKeyDerivation(sessionKeyChain);
     findings.push({
       check: "session_key_chain",
       passed: chainValid,
       details: chainValid ? "Session key chain valid" : "Session key derivation failed",
       severity: chainValid ? undefined : "critical",
     });
   }
   ```

---

## 4. End-to-End Oracle Verification Path (Annotated)

```
Client submits evidence → Gateway (PUT /api/jobs/:jobId/complete)
  │
  │  [paid-job-flow.ts builds evidence bundle, hashes, stores]
  │
  ├─ Gateway calls verifyWithOracle(request)  ← PROPRIETARY ORACLE PATH
  │    │
  │    │  oracle-client.ts sends POST to Spark oracle
  │    │
  │    │  ═══ NEW: Pre-oracle checks run inside Spark oracle ═══
  │    │  [1] ephemeralIdentity — verify sessionKeyChain          ← R06
  │    │  [2] touchstone — check known-answer task results        ← R01
  │    │  [3] workflowChallenge — verify block anchor freshness   ← R05
  │    │
  │    │  ═══ Existing checks (inside Spark oracle) ═══
  │    │  [4] evidenceExists — bundle has content
  │    │  [5] hashMatches — hash integrity
  │    │  [6] tierMet — tier compliance
  │    │  [7] notReplay — dedup check
  │    │  [8] identityValid — kernel identity bound to escrow
  │    │
  │    │  ═══ NEW: Extended checks ═══
  │    │  [9]  step_completeness — all workflow steps have output  ← R03
  │    │  [10] assuranceScore — weighted composite rollup          ← R04
  │    │  [11] workflowSteps — contract vs evidence cross-check   ← R02
  │    │
  │    │  Returns OracleResponse { result, attestation }
  │    │
  │    ▼
  │  If !verified → 422 (oracle_verification_failed)
  │  If verified → continue to settlement
  │
  ├─ Gateway optionally calls subnetBridge.submitForVerification()
  │    ← ON-CHAIN ORACLE PATH (for Tier 1-3 jobs)
  │    │
  │    │  ═══ NEW: Pre-oracle hooks in oracle-bridge.ts ═══
  │    │  [1] ephemeralIdentity check                             ← R06
  │    │  [2] touchstone check                                    ← R01
  │    │  [3] workflowChallenge block hash verification           ← R05
  │    │
  │    │  ═══ Existing cascade ═══
  │    │  [4] UMA assertTruthWithDefaults → liveness window
  │    │      (evaluateEvidence() now includes step_completeness) ← R03
  │    │  [5] Chainlink DON score (includes assuranceScore)       ← R04
  │    │  [6] EigenLayer AVS (stub)
  │    │
  │    ▼
  │  Returns OracleVerificationResult { ..., assuranceScore }
  │
  ├─ Gateway stores attestation + assuranceScore
  │  ├─ Evidence bundle stored in DB
  │  ├─ IPFS archive via Storacha (best-effort)
  │  ├─ ZK commitment + Starknet anchor (best-effort)
  │  └─ Alkahest escrow lock → fulfill → collect
  │
  ├─ ═══ NEW: Post-oracle reputation propagation ═══
  │  ├─ Emit ERC-8004 ReputationFeedback keyed by principalKey   ← R06
  │  ├─ assuranceScore feeds reputation delta                     ← R04
  │  └─ touchstone failure triggers severe penalty (-50 rep)      ← R01
  │
  └─ Settlement: mock auto-settle or real challenge window
```

---

## 5. Live Oracle Endpoint Details

**URL**: `https://refer-proxy-joint-cleaning.trycloudflare.com`
**Status**: LIVE (health check confirmed)
**Oracle address**: `0x3850F24ACd88F6729692e2d05F75d499F0a661f5`
**Chain**: Base Sepolia (84532)
**Service**: Node.js app running at `/home/ryangeorge/pcc-oracle/dist/server.js` on Spark
**Persistence**: systemd user unit (`pcc-oracle.service`), enabled with linger
**Tunnel**: cloudflared quick tunnel (ephemeral URL, changes on restart)
**Port**: 4100 (internal)

**Endpoints**:
- `GET /health` — returns `{status, oracle, chainId}`
- `POST /verify` — accepts `OracleVerifyRequest`, returns `OracleResponse`

**Verification checks** (from oracle-client.ts mock and tunnel diagnostic output):
1. `evidenceExists` — bundle has content
2. `hashMatches` — hash integrity
3. `tierMet` — tier compliance check
4. `notReplay` — deduplication
5. `identityValid` — kernel identity bound to escrow

**Config references in repo**:
- `scripts/real-e2e.ts:34` — `const ORACLE_URL = "https://refer-proxy-joint-cleaning.trycloudflare.com"`
- `scripts/real-e2e-verbose.ts:21` — same
- `packages/gateway/src/services/oracle-client.ts:10` — defaults to `http://192.168.108.72:4100` (internal Spark IP)

---

## 6. Testing the Oracle Cascade After Changes

### 6.1 Existing Test Suite

The oracle has a comprehensive test file at `C:\Users\globa\physical-capability-cloud\packages\verifier\src\__tests__\oracle.test.ts` with the following test groups:

- `evaluateEvidence` — pure function tests for the evidence evaluator
- `UMAOracleAdapter (mock mode)` — mock submission, scoring, defect detection
- `ChainlinkOracleAdapter (mock mode)` — same pattern
- `EigenLayerOracleAdapter (stub)` — always-unavailable behavior
- `OracleVerificationBridge cascade` — cascade fallback when UMA is disabled
- `OracleVerificationBridge: all oracles fail` — complete failure path

### 6.2 Testing Strategy for New Primitives

**Unit tests** (add to `oracle.test.ts` or new test files per primitive):

1. `evaluateEvidence with workflowContract` — verify step_completeness checks fire when contract is provided, and are skipped when contract is absent (backward compat)
2. `evaluateEvidence assuranceScore` — verify the weighted composite produces correct values for known inputs
3. `OracleVerificationBridge pre-oracle hooks` — verify touchstone, challenge, and ephemeralIdentity checks run before the cascade
4. `OracleVerificationBridge backward compat` — verify old `submitForVerification(hash, data, tier)` calls still work without the options parameter

**Integration tests** (mock RPC):

5. `workflowChallenge block verification` — mock a viem `publicClient.getBlock()` to return a known block hash, verify the challenge check passes/fails correctly
6. `Full cascade with all primitives` — construct a bundle with touchstone results, workflow contract, challenge anchor, and session key chain; verify the entire pipeline produces correct results

**Live endpoint test**:

7. `curl against tunnel` — the fastest smoke test after changes:
   ```bash
   curl -X POST https://refer-proxy-joint-cleaning.trycloudflare.com/verify \
     -H "Content-Type: application/json" \
     -H "x-oracle-key: $PCC_ORACLE_KEY" \
     -d '{"escrowAddress":"0x...","jobId":"test","kernelId":"k1","evidenceHash":"sha256:abc","assuranceTier":0,"chainId":84532}'
   ```

**Spark-run full test suite**:

```bash
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/verifier test"
```

---

## 7. Backward Compatibility

All new primitives are designed as **optional extensions**. The existing API contract must not break.

### 7.1 API Surface Guarantees

1. **`submitForVerification(bundleHash, bundleData, requiredTier)`** — The three-argument form continues to work. The `options` parameter defaults to `undefined`, which means no pre-oracle checks run, no step completeness is checked, and the existing scoring formula applies.

2. **`evaluateEvidence(bundleHash, bundleData, requiredTier)`** — The three-argument form continues to work. When `workflowContract` is not provided, step completeness and step order checks are skipped. The `assuranceScore` field is always populated (it just uses the existing defect-based formula when no breakdown components are available).

3. **`OracleVerificationResult`** — New fields (`assuranceScore`, `assuranceBreakdown`) are optional (`?`). Existing consumers that destructure the result continue to work.

4. **`VerificationResult`** (backward-compat shape) — The new `assuranceScore` field is optional. The existing `consensusScore` field is preserved and continues to map from `OracleVerificationResult.score`.

5. **`OracleVerifyRequest`** (oracle-client.ts) — New optional fields can be added without breaking the proprietary oracle. The oracle ignores unknown fields in the POST body.

6. **Gateway routes** — No route signatures change. New fields are added to request/response bodies as optional properties.

### 7.2 Migration Path

Clients can adopt primitives incrementally:
- **Phase 1**: Add `assuranceScore` to result types. No behavioral change — existing scoring populates it.
- **Phase 2**: Wire `workflowSteps` + `step_completeness`. Only fires when a workflow contract is provided.
- **Phase 3**: Wire `touchstone` pre-check. Only fires when touchstone results are in the bundle.
- **Phase 4**: Wire `workflowChallenge`. Only fires when a challenge anchor is provided.
- **Phase 5**: Wire `ephemeralIdentity`. Only fires when a session key chain is provided.

---

## 8. Concrete Oracle Wiring Plan

### File-by-file changes, ordered by dependency:

---

**File 1: `packages/verifier/src/oracle/types.ts`**
**Primitives**: assuranceScore (R04), workflowSteps (R02), workflowChallenge (R05), ephemeralIdentity (R06)

Changes:
1. Add `assuranceScore?: number` to `OracleVerificationResult`
2. Add `assuranceBreakdown?: Record<string, number>` to `OracleVerificationResult`
3. Add `assuranceScore?: number` to backward-compat `VerificationResult`
4. Add `VerificationOptions` interface:
   ```typescript
   export interface VerificationOptions {
     workflowContract?: {
       steps: Array<{
         stepId: string;
         inputSchema?: Record<string, unknown>;
         outputSchema?: Record<string, unknown>;
         dependsOn?: string[];
       }>;
     };
     touchstoneResults?: Array<{
       taskId: string;
       passed: boolean;
       expectedAnswer: unknown;
       actualAnswer: unknown;
     }>;
     challengeAnchor?: {
       challengeId: string;
       blockNumber: number;
       blockHash: string;
       proofHash: string;
       issuedAt: string;
     };
     sessionKeyChain?: {
       sessionKey: string;
       parentKey: string;
       derivationSignature: string;
       parentRegistrationProof?: string;
     };
   }
   ```
5. Extend `VerificationOracle` interface: add optional `options?: VerificationOptions` parameter to `submitForVerification`

---

**File 2: `packages/verifier/src/oracle/evidence-evaluator.ts`**
**Primitives**: step_completeness (R03), assuranceScore (R04), workflowSteps (R02)

Changes:
1. Extend `evaluateEvidence()` signature: add optional fourth parameter `workflowContract?`
2. Add `checkStepCompleteness(bundle, steps)` function (new check #6)
3. Replace crude `1.0 - defects.length * 0.2` scoring with `computeAssuranceScore()` that produces both `score` and `assuranceScore` fields
4. Add `assuranceScore` and optional `assuranceBreakdown` to `EvaluationResult`
5. Keep existing three-argument call working (workflowContract defaults to undefined, step_completeness is skipped, assuranceScore falls back to defect-based formula)

---

**File 3: `packages/verifier/src/oracle/oracle-bridge.ts`**
**Primitives**: touchstone (R01), workflowChallenge (R05), ephemeralIdentity (R06), all pass-through

Changes:
1. Extend `submitForVerification()` signature: add optional `options?: VerificationOptions`
2. Add pre-oracle phase before the `for (const oracle of this.oracles)` loop:
   - `verifyEphemeralIdentity(options.sessionKeyChain)` — if provided and invalid, return immediate failure
   - `verifyTouchstone(options.touchstoneResults)` — if any touchstone failed, return immediate failure with `defects: ["touchstone_failure"]`
   - `verifyChallengeAnchor(options.challengeAnchor, this.config.rpcUrl)` — if provided and block hash mismatch, return immediate failure with `defects: ["challenge_replay_detected"]`
3. Pass `options.workflowContract` through to each oracle's `submitForVerification()` call
4. Extend `toVerificationResult()` to map `assuranceScore`

---

**File 4: `packages/verifier/src/oracle/uma-adapter.ts`**
**Primitives**: assuranceScore (R04), workflowSteps (R02) pass-through

Changes:
1. Extend `submitForVerification()` signature to accept optional `options?: VerificationOptions`
2. In `submitMock()`: pass `options?.workflowContract` to `evaluateEvidence()`
3. In `submitLive()`: same, and include `assuranceScore` in the UMA claim text
4. Populate `result.assuranceScore` and `result.assuranceBreakdown` from `evaluation`

---

**File 5: `packages/verifier/src/oracle/chainlink-adapter.ts`**
**Primitives**: assuranceScore (R04), workflowSteps (R02) pass-through

Changes:
1. Extend `submitForVerification()` signature to accept optional `options?: VerificationOptions`
2. In `submitMock()`: pass `options?.workflowContract` to `evaluateEvidence()`
3. In `submitLive()`: same, and encode `assuranceScore` alongside the DON score
4. Populate `result.assuranceScore` from `evaluation`
5. Update `CHAINLINK_DON_SOURCE` JS to accept an optional assuranceScore hint parameter

---

**File 6: `packages/verifier/src/oracle/eigenlayer-adapter.ts`**
**Primitives**: assuranceScore (R04), workflowSteps (R02) pass-through

Changes:
1. Extend `submitForVerification()` signature to accept optional `options?: VerificationOptions`
2. Pass `options?.workflowContract` to `evaluateEvidence()`
3. Populate `result.assuranceScore` from `evaluation`

---

**File 7: `packages/verifier/src/oracle/index.ts`**
**Primitives**: all (export new types)

Changes:
1. Export `VerificationOptions` type from `types.js`

---

**File 8: `packages/verifier/src/evidence-verifier.ts`**
**Primitives**: ephemeralIdentity (R06), step_completeness (R03)

Changes:
1. Add optional `sessionKeyChain` parameter to `verify()` method
2. Add check 2.5: session key chain verification (between event hash check and tier check)
3. Add check 5: step completeness (when workflow contract is available via a new optional parameter)
4. These checks produce additional `VerificationFinding` entries in the attestation

---

**File 9: `packages/gateway/src/routes/zk-proofs.ts`**
**Primitives**: all (gateway wiring)

Changes:
1. Extend `POST /api/verification/subnet-submit` request body:
   ```typescript
   Body: {
     bundleHash: string;
     bundleData: string;
     requiredTier: number;
     // NEW optional fields:
     workflowContract?: VerificationOptions["workflowContract"];
     touchstoneResults?: VerificationOptions["touchstoneResults"];
     challengeAnchor?: VerificationOptions["challengeAnchor"];
     sessionKeyChain?: VerificationOptions["sessionKeyChain"];
   }
   ```
2. Construct `VerificationOptions` from the request body and pass to `subnetBridge.submitForVerification()`
3. Include `assuranceScore` in the response

---

**File 10: `packages/gateway/src/services/oracle-client.ts`**
**Primitives**: all (proprietary oracle client)

Changes:
1. Extend `OracleVerifyRequest` with optional fields:
   ```typescript
   workflowContract?: object;
   touchstoneResults?: object[];
   challengeAnchor?: object;
   sessionKeyChain?: object;
   ```
2. Extend `OracleResponse.result.checks` with new boolean fields:
   ```typescript
   checks: {
     evidenceExists: boolean;
     hashMatches: boolean;
     tierMet: boolean;
     notReplay: boolean;
     identityValid: boolean;
     // NEW:
     touchstoneValid?: boolean;
     challengeFresh?: boolean;
     sessionKeyValid?: boolean;
     stepsComplete?: boolean;
   }
   ```
3. Add `assuranceScore?: number` to `OracleResponse.result`
4. Update `mockVerification()` to populate the new fields with default `true` values

---

**File 11: `packages/gateway/src/routes/paid-job-flow.ts`**
**Primitives**: all (settlement path)

Changes:
1. In `PUT /api/jobs/:jobId/complete`: before calling `verifyWithOracle()`, construct the extended request with any available workflow contract, touchstone results, and challenge anchor from the session/job context
2. Include `assuranceScore` in the settlement response
3. Pass `assuranceScore` to reputation propagation (post-oracle)

---

**File 12: `packages/verifier/src/__tests__/oracle.test.ts`**
**Primitives**: all (tests)

Changes:
1. Add test group: `evaluateEvidence with workflowContract` — test step_completeness
2. Add test group: `evaluateEvidence assuranceScore` — test weighted scoring
3. Add test group: `OracleVerificationBridge pre-oracle checks` — test touchstone, challenge, ephemeralIdentity gates
4. Add test group: `backward compatibility` — verify three-argument calls still work
5. Add test: `assuranceScore is always populated` — verify the field exists in all results

---

**File 13: `packages/gateway/src/routes/tmp-tasks.ts`**
**Primitives**: assuranceScore (R04) pass-through

Changes:
1. The TMP (Temporary Manufacturing Protocol) validator bridge also uses `OracleVerificationBridge`. Update its `validatorBridge` calls if they invoke `submitForVerification()` to pass the new options when available.

---

### Dependency order for implementation:

```
types.ts                    ← define VerificationOptions + extend result types
    ↓
evidence-evaluator.ts       ← extend evaluateEvidence() + add step_completeness + assuranceScore
    ↓
[uma|chainlink|eigenlayer]-adapter.ts  ← pass-through options + populate assuranceScore
    ↓
oracle-bridge.ts            ← add pre-oracle hooks + wire options to adapters
    ↓
evidence-verifier.ts        ← add sessionKeyChain + stepCompleteness checks
    ↓
index.ts                    ← export new types
    ↓
oracle-client.ts            ← extend proprietary oracle request/response
    ↓
zk-proofs.ts                ← extend subnet-submit route
    ↓
paid-job-flow.ts            ← wire new fields into settlement path
    ↓
oracle.test.ts              ← add tests for all new behavior
```

Total: 13 files changed, 0 new files created (all changes are extensions to existing files). All new fields are optional. All existing callers continue to work without modification.
