# Receipt Anchoring — Migration & Rollout Runbook

**Status**: Phase-2 implementation ready (May 2026)
**Scope**: This document covers the dual-write window, SLO-gated cutover, and
rollback procedure for on-chain InvocationReceipt anchoring.

**Spec source**: [`ai/scoping/onchain-receipt-anchoring-2026-05-23.md`](../ai/scoping/onchain-receipt-anchoring-2026-05-23.md) §9.

---

## 1. Architecture recap

Three components ship together (this PR — `feat/onchain-receipt-anchoring`):

- **`ReceiptAnchorRegistry` contract** (`packages/contracts/src/ReceiptAnchorRegistry.sol`):
  Dedicated standalone, gateway-oracle-only writer, single + batch modes.
- **`@pcc/subgraph` package** (`packages/subgraph/`): TheGraph subgraph that
  indexes `AnchorEmitted`, `BatchAnchorEmitted`, `DisputeRaised` events.
- **`ReceiptAnchorClient`** (`packages/aggregator/src/receipt-anchor-client.ts`):
  TS wrapper that routes signed receipts to `anchorOne` (DCC3+) or
  `anchorBatch` (DCC0..DCC2) via a chain backend abstraction.

Plus the new `signAndAnchorReceipt()` helper in
`packages/aggregator/src/receipt-signer.ts` which signs + optionally anchors
in one call — backwards-compatible with existing `signReceipt` callers.

---

## 2. Phased rollout

### Phase 1 — Dual-write window, Day 0 to Day 14

**What runs**:
- `PCC_RECEIPT_ANCHOR_ENABLED=true` in gateway env.
- All new receipts get anchored.
- `anchorStatus` is informational only; response shape unchanged for callers
  who don't read it.
- DCC3+ receipts → `anchorOne` (sync tx, ~$0.025/receipt on Base mainnet).
- DCC0..DCC2 receipts → buffered, flushed every 10min or at 4096 leaves.

**What does NOT run**:
- No anchor SLO enforcement. If anchor times out, the receipt still returns.
- No backfill of pre-Phase-2 receipts (see §3).

**Smoke tests**:
- Submit a DCC3 call. Confirm `anchorStatus` advances `pending` → `anchored`
  within ~10s of the call.
- Submit 5 DCC1 calls. Wait 10min. Confirm batch flush, all 5 leaves
  appear under the same `anchorMerkleRoot`, and the per-leaf
  `anchorMerkleProof` reconstructs the root via `verifyInBatch`.

### Phase 2 — SLO-gated cutover for DCC3+, Day 14 to Day 30

**What changes**:
- Gateway starts enforcing the SLO for DCC3+ receipts only:
  - `anchorOne` p99 = 10 minutes from issuance to confirmation.
  - If the anchor doesn't confirm within SLO, the response returns
    `503 Retry-Later` with `anchorStatus: "failed"` in the body.
- DCC0..DCC2 remains best-effort. Anchor failures are logged but do not
  block.

**Operator action**: Monitor the dashboard `anchor_status` histogram. If
`failed` rate >0.1% for 4 consecutive hours, halt the cutover and
investigate before promoting to Phase 3.

### Phase 3 — Base mainnet promotion, Day 30

**Same deploy script, mainnet target**:
```bash
# In packages/contracts/
PCC_NETWORK=base DEPLOYER_PRIVATE_KEY=... RECEIPT_GATEWAY_ORACLE_ADDRESS=... \
  forge script script/DeployReceiptAnchorRegistry.s.sol:DeployReceiptAnchorRegistry \
  --rpc-url base --broadcast --verify -vvvv
```

Then update gateway env: `RECEIPT_ANCHOR_CONTRACT_ADDRESS=<base address>`,
and re-index the subgraph against `network: base`.

---

## 3. Backfill policy

**Recommendation: no mass backfill.** Per scoping §9.2, backfill anchoring
of pre-Phase-2 receipts would set their `anchoredAtBlock` to a current
block, breaking the audit semantic ("anchored at this block" no longer
means "called near this block").

**Opt-in per-receipt backfill** lives at
`POST /api/indexed-tools/receipts/:cid/backfill-anchor`. Implementation
deferred from this PR (lives in the gateway, not this branch).

---

## 4. Rollback

If the anchor worker proves buggy in production:

1. Set `PCC_RECEIPT_ANCHOR_ENABLED=false` in the gateway env. Restart.
2. `ReceiptAnchorClient.anchorReceipt()` becomes a no-op; new receipts get
   `anchorStatus: "disabled"` in the response.
3. Off-chain receipts continue to be signed and stored (unchanged
   pre-Phase-2 path).
4. Queued receipts in the buffer that haven't flushed yet are LOST (in-memory).
   Per scoping §9.3, the long-term fix is a DB-backed queue
   (`anchor_status='pending'` rows act as the queue source-of-truth) — that
   lives in the gateway integration (deferred from this PR).
5. Investigate, fix, re-enable.

---

## 5. Cost expectations

At expected steady-state traffic (per scoping §4.7):

| Phase | Daily volume | Strategy | Daily cost | Monthly |
|---|---|---|---|---|
| Phase 2 launch | 1k-10k/day | all single | $25-$250 | $750-$7500 |
| Phase 2 month 2 | 10k-50k/day | 10% single, 90% batch | $25-$125 | $750-$3750 |
| Steady state | 100k-1M/day | 5% single, 95% batch | $125-$1250 | $3.75k-$37.5k |

Anchor txs are gateway expenses (not per-call billable). The aggregator's
existing `pccFeeBps` continues to collect on the per-call fee — anchoring
is a fixed overhead on top.

---

## 6. SLO target table

Per scoping §9.4, the aggregator team commits to:

| SLO | Target | Action if missed |
|---|---|---|
| `anchorOne` p99 latency | 10 min from issuance to anchored | Page on-call |
| `anchorBatch` p99 latency | 60 min (batch fill + 5 confirmations) | Investigate batch tuning |
| Anchor success rate (single) | ≥99.9% | Page if <99% sustained 1h |
| Anchor success rate (batch) | ≥99.5% | Page if <99% sustained 1h |
| Amortized cost/receipt | ≤$0.005 | Reassess batch tuning if sustained >24h |

---

## 7. Verification flow (consumer side)

A third-party consumer with an off-chain InvocationReceipt JSON verifies as
follows:

1. Compute `cidHash = sha256(canonicalReceiptJSON)`. Must equal
   `receipt.receiptCID` (strip `sha256:` prefix).
2. Verify `receipt.pccSignature` against `cidHash` using PCC's published
   gateway public key (`https://capability.network/.well-known/pcc-keys.json`).
3. On-chain proof. Two paths:
   - **Single-anchored** (DCC3+): Call `registry.exists(cidHash)` →
     `true`, AND read `registry.anchors(cidHash)` and confirm `dccClass`,
     `receiptTimestamp`, `toolCID` match the receipt body.
   - **Batch-anchored** (DCC0..DCC2): Get `anchor_merkle_root` and
     `anchor_proof` from the receipt metadata or subgraph. Call
     `registry.verifyInBatch(cidHash, root, proof)` → `true`.
4. For DCC2+: also verify `upstreamSignature` against the upstream's
   published key.
5. For DCC3+: verify Sigstore Rekor inclusion proof (off-chain).

If step 3 returns false, the receipt is either forged or PCC failed to
anchor it. Do not trust.

---

## 8. Deferred items (NOT in this PR)

Items in scope per the original scoping doc but deferred to follow-up PRs:

- **DB schema additions** (`packages/db/src/schema/invocation-receipts.ts`,
  `packages/db/src/migrations/0010_receipt_anchors.sql`) — see scoping §8.2,
  §8.3. Deferred to a "db schema for receipt anchoring" PR alongside the
  receipt-row-level integration in the gateway.
- **InvocationReceipt body additions** (`anchorStatus`, `anchorTxHash`, etc.
  — scoping §8.1). Deferred to the same DB PR — these fields are useless
  without the DB layer populating them.
- **viem-backed `ChainBackend` implementation**. This PR ships the
  abstraction. A follow-up wires up viem with the deployed address from
  `chain-config.ts`.
- **Storacha-backed `BatchManifestStorage` implementation**. Same — the
  abstraction is here; the Storacha wrapper lives in a follow-up.
- **Gateway routes** (`indexed-tools.ts` `anchorStatus` polling + the
  `/backfill-anchor` admin endpoint — scoping §10.2 task 8).

---

## 9. Open Questions resolved by this PR

- **Q: Should the anchor worker run in the gateway process or a sidecar?**
  Per scoping §11.2: sidecar (singleton, separate Railway service).
  This PR's `ReceiptAnchorClient.start()` /`stop()` are designed for either
  topology — a single-instance sidecar can host an enabled client; gateway
  instances can host a disabled client. Operator chooses.
- **Q: Same gateway oracle key as CaptureClassRegistry?** Per scoping
  §11.3: no, separate keys. Deploy script uses
  `RECEIPT_GATEWAY_ORACLE_ADDRESS` (not the existing
  `GATEWAY_ORACLE_ADDRESS`).
- **Q: Per-(caller, tool) nonces?** Optional defense-in-depth, exposed via
  the `sequence` parameter on `anchorOne` (0 to skip). The TS client passes
  `0n` by default; the gateway can opt in by populating the sequence
  parameter from its own per-caller state.
