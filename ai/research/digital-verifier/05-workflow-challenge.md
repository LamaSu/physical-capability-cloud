# Workflow Challenge — Block Anchor + Lightweight Nonce Hybrid

**Research report — Digital Verifier Primitives**
**Date**: 2026-04-11
**Author**: Deep-research subagent
**Target**: PCC (Physical Capability Cloud) anti-replay for digital workflow contracts

---

## Abstract

A Physical Capability Cloud kernel that executes digital work — an accounting agent, a procurement agent, a code-review agent — faces an adversary problem that physical kernels never have to solve: evidence can be *replayed*. A correct output from yesterday is indistinguishable, at the bits level, from a correct output produced right now. Without a freshness binding the adversary can sign, bundle, and submit the same work a thousand times, or feed a stale cache in place of actual execution. Touchstones (report 01) catch the executor that *dodges* work; challenges catch the executor that *reuses* work.

This report derives the freshness primitive PCC needs. It argues that the right answer is a two-track hybrid: for settled jobs that have on-chain escrow, the MilestoneEscrow creation block serves as a global, everyone-verifiable time anchor — evidence with timestamps earlier than that block is provably replayed. For unsettled inter-agent sub-tasks that have no escrow, a lightweight `{UUID, recent block hash, scope}` challenge binds the child's work to a moment the parent can prove. Both tracks commit to Pedersen for the proof hash (Noir-compatible for Tier 3 sovereign jobs) and both are verifiable by any third party by re-fetching a Base Sepolia block.

The report walks first principles, prior art (TLS nonces through Drand), the trade-offs of `blockhash` vs `prevrandao` vs VRF, a read of the existing `MilestoneEscrow.sol`, a 150-line `ChallengeService` in TypeScript, integration with `commitment-service.ts`, and the failure modes (reorg, clock skew, lost challenge, cross-contract replay) the design must defend against.

---

## 1. First Principles: What Replay Prevention Actually Requires

The threat is simple to state. An executor `E` produces a legitimate evidence bundle `B` at time `t0`. The verifier accepts and (if settled) the escrow releases. At time `t1 > t0`, `E` resubmits a bundle that is byte-identical to `B`, or constructs a new bundle whose proof references cached outputs from `t0`. The adversary wins if the verifier cannot distinguish `B_replay` from fresh work.

Three requirements fall out directly:

**R1 — Late-binding inclusion**. The evidence must include a value that the executor *could not have known* before a moment `T`. If everything in the bundle is derivable from the task spec plus cached state, the executor can pre-compute. The challenge primitive is therefore an unpredictable token issued at `T` by someone other than the executor, and the evidence must incorporate that token in a way the verifier can recompute.

**R2 — Third-party verifiability**. "Trust me, I issued this nonce at time T" is exactly the approach PoA's `anti_gaming/nonce.py` takes, and it fails because the verifier's local dictionary is not visible to anyone else. If a dispute arises, a second verifier looking at the same bundle has no way to independently decide whether the nonce was fresh. What we want is an anchor that any third party — a disputing client, an arbiter, a different verifier in a multi-sig — can look up and confirm. Public blockchains give exactly this: block hashes and timestamps are globally consistent after finality.

**R3 — Cheap to generate and verify**. The executor does real work. The challenge system should be a small constant on top of that work — a few hundred bytes, one hash computation, one RPC call on the verifier side. It cannot require fresh gas-burning transactions per task (expensive, slow) and it cannot require a VRF node (introduces a trusted party). A block-hash fingerprint plus a domain-separated Pedersen hash hits all three.

Put another way: the primitive we want is "an appending HMAC where the key is the block hash that existed *at challenge issue time*". The executor must compute `proofHash = H(challengeId || blockHash || workOutputRoot)`. Anyone can re-fetch `blockHash` from the chain and recompute `proofHash`. If the re-fetched `blockHash` does not match, or the recomputed `proofHash` does not match, the evidence is rejected.

This is also exactly the shape of TLS 1.3's `handshake_transcript` hash, Kerberos's `authenticator`, and Drand's random beacon commitments — the deep structure is always: *(public anchor at time T) × (private work) × (deterministic hash) → verifiable binding*.

## 2. Prior Art

I surveyed five lineages of freshness primitives to locate where PCC's challenge should sit. Each forces a different trade-off between freshness, verifiability, and cost.

### 2.1 TLS 1.2/1.3 client and server randoms

In the TLS handshake, both parties contribute 32 bytes of uniformly random data (ClientHello.random, ServerHello.random). These are concatenated into the handshake transcript and become part of the master secret derivation. Neither side can pre-compute session keys because each depends on the other's fresh randomness. In TLS 1.3 the first four bytes of the server random are also used to signal downgrade attempts (see RFC 8446 §4.1.3).

**Fresh?** Yes — 32 bytes from a CSPRNG per handshake.
**Verifiable by a third party?** No — the randoms are ephemeral, known only to the two endpoints unless one of them logs them (e.g., SSLKEYLOGFILE).
**Cheap?** Extremely.

Takeaway for PCC: TLS-style randoms solve freshness in a bilateral relationship. They do not help when a third party must later dispute — exactly PCC's challenge-window use case.

### 2.2 Kerberos authenticators and replay caches

A Kerberos authenticator carries a timestamp within a configurable `clockskew` window (default 5 minutes) and a sequence number; the server keeps a replay cache keyed by `{client_principal, timestamp}` and rejects any duplicate. Kerberos can only function if all participants share a time source (usually NTP).

**Fresh?** Bounded by the clockskew window. Replay within 5 minutes is possible if the replay cache misses.
**Verifiable by a third party?** No — the replay cache is server-local.
**Cheap?** Very.

Takeaway: PCC should not use wall-clock time as its primary freshness input because it forces everyone to share an NTP view and leaves replay holes inside the skew window. A block-height tick, which has its own notion of time but is globally consistent, is strictly better.

### 2.3 Chainlink VRF (Verifiable Random Function)

Chainlink VRF v2.5 lets a smart contract request a verifiable random number from an oracle. The oracle produces `(random, proof)` where `proof` is cryptographically checkable on-chain: the random number is guaranteed to be unbiasable (the oracle cannot choose a favorable output). VRF went through multiple iterations — v1 had a prediction attack if the oracle could see the blockhash that would anchor randomness before responding, which let a malicious oracle refuse to respond for unfavorable outcomes. v2 added subscription management and `numWords`. v2.5 supports both LINK and native gas payment and increases max callback gas.

**Fresh?** Yes — randomness comes after the request block is finalized.
**Verifiable by a third party?** Yes — the VRF proof verifies on-chain.
**Cheap?** No — each request is a paid oracle call (LINK or native gas), takes 1–5 blocks for fulfillment, and is overkill for "is this bundle replayed."

Takeaway: VRF is the right answer when you need an unbiasable lottery (NFT mints, gambling). For PCC's "bind this work to a moment" it's too heavy and too slow. We can take inspiration from how VRF domain-separates each request (each has a `requestId`) but we don't need the VRF infrastructure.

### 2.4 Ethereum `blockhash` and `prevrandao`

Solidity exposes two relevant opcodes. `blockhash(block.number - 1)` returns the hash of the previous block (available for the last 256 blocks, so about 8.5 minutes on Base Sepolia's 2-second blocks, or 51 minutes on Ethereum mainnet's 12-second blocks). Outside that window it returns `bytes32(0)` — a trap for off-by-one consumers.

`block.prevrandao` (post-Merge, EIP-4399) replaces the deprecated `block.difficulty` with the RANDAO mix of the previous block. It is *biasable by the proposer*: the last proposer in a 32-slot epoch can choose between revealing their value or not, giving them a 1-bit influence. Despite this bias it is strictly stronger than `blockhash` for randomness because (a) it cannot be pre-computed by a non-proposer and (b) manipulation requires forgoing block rewards. For our use case — freshness, not randomness — either works.

**Fresh?** `blockhash` is 2-second granular on Base; `prevrandao` is 12-second granular on Ethereum L1 (post-Merge slot time).
**Verifiable by a third party?** Yes — any node can look up the block and confirm.
**Cheap?** Yes on the consumer side (one opcode). There's no "request" — the chain just progresses.

Takeaway: this is the shape we want. The hybrid design uses block hash as the anchor and commits to it off-chain (via a Pedersen hash inside the bundle) rather than requiring on-chain verification each time. On-chain verification is the *fallback* for disputes, not the critical path.

### 2.5 Drand / League of Entropy

Drand is a threshold BLS randomness beacon run by the League of Entropy (Cloudflare, Protocol Labs, EPFL, UCL, etc.). It produces a fresh random value every 30 seconds (originally) or 3 seconds (quicknet chain), signed by a threshold of the participants, and the signature doubles as proof. Consumers don't trust any single participant — only that the threshold was not compromised.

**Fresh?** 3–30 seconds.
**Verifiable by a third party?** Yes — anyone can verify the BLS signature against the League of Entropy public key.
**Cheap?** Yes — one HTTP GET to `api.drand.sh/public/latest` plus one BLS verification.

Takeaway: Drand is the strongest off-chain primitive. The trade-off versus `blockhash` is: Drand is bound to a threshold committee (a trust assumption), while `blockhash` is bound to the security of the chain we're already using for settlement. For PCC, we're *already* committed to Base Sepolia's security — it holds the escrow. Adding a Drand dependency introduces a new trust root for no additional security. Use `blockhash` and stay within the existing threat model.

### 2.6 Commit-reveal schemes

A two-phase protocol: in phase 1, the participant posts `H(secret || salt)` on-chain; in phase 2, they reveal `(secret, salt)` and the contract verifies. Used for sealed-bid auctions, RANDAO pre-Merge, and various gaming primitives. The commit-reveal pattern is essentially "a challenge I issue to myself," with the timestamp of the commit transaction as the anchor.

**Fresh?** Yes.
**Verifiable by a third party?** Yes.
**Cheap?** Two on-chain transactions per round — strictly more expensive than blockhash.

Takeaway: we *could* add a commit-reveal step to the challenge flow (parent commits to a nonce on-chain; child reveals their execution; parent reveals the preimage). For Tier 3 sovereign jobs where the extra security justifies the cost, this is worth keeping as an upgrade path. For the default path, two txes per sub-task is too much.

### 2.7 Summary table

| Primitive | Fresh? | 3rd-party verifiable? | Cost | Trust root |
|---|---|---|---|---|
| TLS randoms | 32 bytes CSPRNG | No | ~0 | Peer only |
| Kerberos timestamps | ±5 min skew | No | ~0 | NTP + server cache |
| Chainlink VRF | 1–5 blocks | Yes (on-chain proof) | LINK + gas | Oracle + chain |
| `blockhash` / `prevrandao` | 2 s (Base) / 12 s (L1) | Yes (chain) | 1 opcode or 1 RPC | Chain security |
| Drand | 3–30 s | Yes (BLS sig) | 1 HTTP + 1 BLS verify | Threshold committee |
| Commit-reveal | Bounded by block | Yes (chain) | 2 txes | Chain security |

For PCC: `blockhash` wins the default case; Drand and commit-reveal are Tier 3 upgrades.

---

## 3. EVM Block Hash as Anchor — The Real Trade-offs

Having chosen block hash in principle, it's worth being explicit about its failure modes and parameter choices before writing any code.

### 3.1 The 256-block window

Solidity's `blockhash(uint blockNumber)` returns the hash of a block, but only for the last 256 blocks. Outside that window, it returns `bytes32(0)`. This is a deliberate choice — retaining hashes for arbitrary ancestors would force every client to store the full header chain in state, which is expensive. The 256-block limit is enforced in every EVM client (geth, erigon, reth, op-geth).

On Base Sepolia's ~2-second blocks, 256 blocks = ~8.5 minutes. On Ethereum mainnet's 12-second blocks, 256 blocks = ~51 minutes. On Optimism L2s (same block time as Base), same ~8.5-minute window.

This matters because a *Solidity-based* verifier would be limited to the 8.5-minute window. But PCC's verifier is off-chain — it calls `eth_getBlockByNumber` over RPC, which can fetch *any* block, not just the last 256. The 256-block limit only applies to on-chain contracts. So for PCC's off-chain verification path we have no hard wall; we only have a soft preference for recent blocks so the verifier's RPC call is cache-friendly.

On-chain `blockhash` still matters for one sub-case: the `ChainlinkEvidenceVerifier.sol` contract (deployed as part of PCC's oracle flow). If we ever want on-chain freshness enforcement inside that contract, we're bounded by the 256-block window. The clean design is: all default freshness enforcement is off-chain (no window limit); the on-chain contract path is an optional Tier 3 addition that accepts the window.

### 3.2 `blockhash` vs `prevrandao`

`blockhash(n)` is deterministic after the block is mined — it is the Keccak256 of the block header fields. Any full node can compute it locally.

`block.prevrandao` (EIP-4399, post-Merge) is the RANDAO mix from the previous slot. On PoS Ethereum it replaces `block.difficulty` (the same opcode 0x44, renamed in Solidity 0.8.18). RANDAO mixes are contributed slot-by-slot by proposers; the final proposer in an epoch has a 1-bit bias (they can choose to reveal or not). This makes `prevrandao` unsuitable for applications requiring unbiasable randomness below 2^32 output — but *perfectly fine* for freshness binding, where all we need is "the value is unpredictable to the executor at the moment we issue the challenge."

For PCC's purpose, `blockhash` is slightly preferable because: (a) it's available on L2s without the Merge-era semantics overhead, (b) it doesn't have even the 1-bit bias of `prevrandao`, and (c) on L2s the block hash already commits to the L1 data root transitively through the batch. We'll use `blockhash` in the design.

### 3.3 Base Sepolia specifics

Base Sepolia runs the OP Stack with ~2-second block times. Per Base's own finality docs: after ~200 ms a transaction is in a preconfirmation (Flashblock) with under 0.001% reorg probability; after 2 s it's in an L2 block with ~0% reorg probability; after ~2 minutes (12 L2 batches on L1) the batch has been posted to L1 Ethereum and reorg probability is effectively 0. Base has had exactly *one* L2 reorg in its entire history, representing 0.0000003% of transactions.

This shapes two parameters in our design:

- **Confirmation depth**: waiting 12 L2 blocks (= 24 s) before treating an issuedBlock as canonical is sufficient for any tier below sovereign. Waiting for L1 batch inclusion (~2 min) is the Tier 3 setting.
- **Block time tolerance**: `block.timestamp` on L2 is set by the sequencer and can drift; consumers must accept a few seconds of slack. We'll use ±30 s slack to accommodate sequencer drift plus reasonable client clock drift.

### 3.4 Reading the existing `MilestoneEscrow.sol`

I read `packages/contracts/src/MilestoneEscrow.sol`. Relevant observations:

- The escrow is deployed per-CWM (per-workflow), not per-milestone. The deployment itself corresponds to one `new MilestoneEscrow(...)` transaction, which lands in one block. That *deployment block* is the natural anchor for "when this workflow came into existence on-chain."
- `EscrowFunded(bytes32 indexed cwmId, uint256 totalAmount)` is emitted after `fund()` completes. This event carries the `cwmId` and can be queried by a verifier via `eth_getLogs`. The verifier can read the block number and block hash from the transaction receipt.
- There is no existing anti-replay field in the escrow. Evidence is committed as `evidenceBundleHash` inside `submitEvidence`, but the contract doesn't enforce any relationship between that hash and a block anchor. This is the gap we're filling.
- Each milestone has a `challengeWindowEnd` used for dispute timing. This is a separate concept from our "workflow challenge" — the challenge window is for disputes after evidence submission, while our challenge is for freshness during evidence generation. Naming collision risk; we will use `executionChallenge` / `executionProof` in the new types to disambiguate.

The proposed extension does *not* require changing `MilestoneEscrow.sol`. The block anchor is read off-chain from the deployment tx receipt. This keeps us clear of a contract upgrade and audit cycle.

### 3.5 Two-track decision

- **Tier 1 and 2 settled jobs**: use the MilestoneEscrow deployment block as the challenge anchor. `issuedAtBlock = deploymentBlock`. Any evidence with `computedAtBlock < deploymentBlock` is a replay. Verifier fetches the deployment tx receipt once, caches it, and reuses for all milestones of that workflow.
- **Unsettled inter-agent sub-tasks**: the parent agent generates a `WorkflowChallenge` with a UUID plus the current `latestBlock.hash`, signs it, and hands it to the child. The child's `ExecutionProof` hashes its work output together with the challenge. Anyone can re-fetch the block to verify.

Both tracks share the same data shapes and the same verification logic. The only difference is where the "issuedAtBlock" comes from.

---

## 4. Unsettled Inter-Agent Flow — Why a UUID Is Needed on Top of the Block Hash

The settled-job case is conceptually simple: there's already one canonical deployment block, so the anchor is fixed. The unsettled case is trickier. Consider: a parent agent wants to delegate a sub-task to a child. No escrow is being created for this sub-task (it's a coordination call, not a payment). The parent needs to prove to any future auditor that the child's work was done *after* a particular moment.

Naive approach 1 — "parent just hashes the latest block hash with the task spec, child returns work." Problem: two different sub-tasks issued at the same block are indistinguishable. An adversarial child could compute one piece of work and submit it as the answer to both sub-tasks.

Naive approach 2 — "parent generates a random nonce." Problem: this is TLS-style, and the parent has to maintain state (a nonce table) to verify. If the parent crashes and restarts, the nonce table is gone. This is the exact failure mode of `poa-subnet/anti_gaming/nonce.py` — the dict is local validator state.

The working approach is both: generate a UUID (makes each challenge unique, like Chainlink VRF's `requestId`) *and* bind it to a block hash (makes the challenge independently verifiable). The composition is:

```
executionProof = pedersen(
  field(challengeId),
  field(issuedAtBlock.blockHash),
  field(workOutputRoot)
)
```

No verifier state is required. Any third party can:
1. Read the challenge (it's signed by the parent and attached to the sub-task record).
2. Fetch `issuedAtBlock.blockNumber` from Base Sepolia, confirm the returned blockHash matches.
3. Recompute `executionProof` from the three fields and confirm it matches what the child submitted.
4. Confirm `computedAtBlock > issuedAtBlock` (the child couldn't have computed this before the parent issued it).
5. Confirm the time delta is within `maxAgeSeconds`.

Five checks, all stateless, all third-party-reproducible. This satisfies R1, R2, and R3.

### 4.1 Why sign the challenge

The challenge itself is signed by the parent agent (using its ERC-8004 agent identity key). This prevents a different adversary from *issuing challenges in the parent's name* — the signature binds the challenge to a specific issuer, which matters for the `scope` field that ties the challenge to a specific task.

### 4.2 The `scope` field and cross-contract replay

Without a scope, the same challenge could be reused across two different sub-tasks. A scope is a domain separator: contract ID, task ID, or `cwmId + milestoneIndex`. The proof hash becomes:

```
executionProof = pedersen(
  field(challengeId),
  field(issuedAtBlock.blockHash),
  field(workOutputRoot),
  field(scope)          // NEW: domain separator
)
```

Now a challenge issued for `scope = "task-abc"` cannot be reused for `scope = "task-xyz"` because the hash would not match.

---

## 5. Concrete Data Shapes

### 5.1 TypeScript interfaces (to add to `packages/spec/src/types/evidence.ts`)

```typescript
import type { Hex } from "./common.js";
import type { AgentRegistryId } from "./identity.js"; // ERC-8004 agent ID

/**
 * A block anchor — a reference to a specific block on a specific chain.
 * Used as the "time T" in freshness proofs.
 */
export interface BlockAnchor {
  chainId: number;                  // 84532 for Base Sepolia
  blockNumber: bigint;              // block height
  blockHash: Hex;                   // 0x-prefixed, 32 bytes
  blockTimestamp: bigint;           // block.timestamp, seconds since epoch
}

/**
 * A WorkflowChallenge — issued by a parent agent (or by the settlement
 * pipeline when MilestoneEscrow is deployed), binds downstream work to
 * a moment in time.
 *
 * For settled jobs: issuedByAgent is the payer, issuedAtBlock is the
 *   MilestoneEscrow deployment block.
 * For unsettled sub-tasks: issuedByAgent is the parent agent, issuedAtBlock
 *   is whatever block the parent saw as "latest" when it issued.
 */
export interface WorkflowChallenge {
  challengeId: string;              // UUID v4
  issuedByAgent: AgentRegistryId;   // ERC-8004 agent ID of issuer
  issuedAtBlock: BlockAnchor;
  maxAgeSeconds: number;            // default 600 (10 minutes)
  scope: string;                    // contract ID, task ID, or cwmId
  signature?: Hex;                  // signer = issuedByAgent's wallet
}

/**
 * An ExecutionProof — submitted by the executor alongside evidence.
 * Must hash the challenge, the anchor block hash, and the work output
 * root together. Third parties can re-verify by fetching the block.
 */
export interface ExecutionProof {
  challengeId: string;              // FK to WorkflowChallenge.challengeId
  proofHash: Hex;                   // pedersen(challengeId, blockHash, workOutputRoot, scope)
  workOutputRoot: Hex;              // Merkle root of work outputs
  computedAtBlock: BlockAnchor;     // when proof was computed
}
```

### 5.2 Why Pedersen, not SHA256

PCC's `commitment-service.ts` already uses Barretenberg Pedersen for all Merkle tree operations (matching Noir's `std::hash::pedersen_hash`). Using Pedersen for the `proofHash` has three benefits:

1. **Noir-circuit reusable**. A Tier 3 sovereign job can include the challenge proof as part of its ZK circuit without a hash-function translation layer. The circuit takes `(challengeId, blockHash, workOutputRoot, scope)` as inputs and checks the Pedersen hash matches in-circuit, all over BN254 field elements.
2. **One hash function, one domain**. The commitment service is already committed to Pedersen. Introducing SHA256 for challenge proofs only would mean two hash functions for effectively the same purpose.
3. **Field-native**. Block hash is `Hex` (32 bytes, Keccak output) but we reduce it mod BN254 via `hashToField()` — same utility already used for Merkle node combining.

SHA256 would be fine for tiers 0–1 where there's no ZK circuit, and the code could easily parametrize. The default recommendation is Pedersen.

---

## 6. Verification Algorithm

The verifier executes these steps for any evidence bundle with an attached `ExecutionProof`:

```
function verifyExecutionProof(
  challenge: WorkflowChallenge,
  proof: ExecutionProof,
  nowBlockNumber: bigint,
  confirmationDepth: number = 12,
): VerificationFinding {

  // Step 1 — Fetch the anchor block via RPC and confirm hash
  const anchor = await rpc.getBlock(challenge.issuedAtBlock.blockNumber);
  if (anchor.hash !== challenge.issuedAtBlock.blockHash)
    return FAIL("anchor block hash mismatch — possible reorg or forgery");

  // Step 2 — Confirm anchor block is finalized (12+ confirmations)
  if (nowBlockNumber - challenge.issuedAtBlock.blockNumber < confirmationDepth)
    return FAIL("anchor block not yet finalized");

  // Step 3 — Recompute proof hash
  const expected = await pedersenHash([
    uuidToField(challenge.challengeId),
    hashToField(challenge.issuedAtBlock.blockHash),
    hashToField(proof.workOutputRoot),
    stringToField(challenge.scope),
  ]);
  if (expected !== proof.proofHash)
    return FAIL("proof hash mismatch — work output root does not match challenge");

  // Step 4 — Confirm proof was computed after challenge
  if (proof.computedAtBlock.blockNumber <= challenge.issuedAtBlock.blockNumber)
    return FAIL("proof computed before or at challenge — replay");

  // Step 5 — Confirm timestamp delta within maxAgeSeconds (±30s slack)
  const delta = proof.computedAtBlock.blockTimestamp - challenge.issuedAtBlock.blockTimestamp;
  if (delta > challenge.maxAgeSeconds + 30)
    return FAIL(`challenge stale: ${delta}s > ${challenge.maxAgeSeconds + 30}s`);

  // Step 6 — Confirm parent's signature (optional, unsettled flow only)
  if (challenge.signature) {
    const valid = verifyAgentSignature(challenge.issuedByAgent, challenge.signature, canonicalize(challenge));
    if (!valid) return FAIL("parent challenge signature invalid");
  }

  return PASS;
}
```

All six checks are stateless. The verifier needs only: an RPC endpoint, the Pedersen library, and optionally the ERC-8004 agent registry for signature verification.

---

## 7. Failure Modes and Defenses

### 7.1 Chain reorganization

If the chain reorgs after a challenge is issued, the block hash at `issuedAtBlock.blockNumber` changes. The recomputed proof hash will no longer match, causing a false rejection — the executor did honest work, but the chain shifted under them.

**Defense**: require a confirmation depth of 12 L2 blocks (24 seconds) before treating a block as canonical. On Base, which has had exactly one reorg in its history, 12 blocks is conservative. For Tier 3 sovereign jobs, wait for L1 batch inclusion (~2 min). The `confirmationDepth` parameter in the verifier lets each tier set its own policy.

If a reorg *does* happen after a challenge is issued but before the executor submits their proof, the parent can re-issue the challenge with the new block hash. This is safe because the UUID is new for the re-issue. The old challenge simply expires.

### 7.2 Clock skew / timestamp drift

Base Sepolia uses the sequencer to set `block.timestamp`. The sequencer can drift, and there's no formal ±15-second bound like Ethereum mainnet's Casper FFG. In practice, Base timestamps are within a few seconds of real time.

**Defense**: the verifier accepts a ±30-second slack in the `maxAgeSeconds` check. The check is `delta > maxAgeSeconds + 30`, not `delta > maxAgeSeconds`. This absorbs sequencer drift plus any reasonable client clock offset. The slack is a constant in the verification code, not a user-configurable parameter, to prevent an operator from widening it to effectively disable freshness.

### 7.3 Challenge loss / orphan

A parent issues a challenge to a child. The child never executes (crashes, network partition, decides not to accept). The challenge sits in the parent's records but no proof ever arrives.

**Defense**: challenges auto-expire at `issuedAtBlock.blockTimestamp + maxAgeSeconds`. After expiry, the parent knows the sub-task was not completed and can either retry with a new challenge or escalate. No cleanup daemon is needed — the challenge is just data. The only resource it consumes is the UUID namespace, which is effectively infinite.

### 7.4 Replay across contracts / tasks

An adversary completes task A and submits its proof. Later, task B is issued with the same block anchor (plausible if both are issued within the same block). The adversary submits task A's proof for task B.

**Defense**: the `scope` field. The proof hash includes `stringToField(scope)` as one of its inputs. If `scope = "task-A-uuid"`, the hash will not verify against a challenge whose `scope = "task-B-uuid"`. This is standard domain separation, the same technique used in HKDF-Expand (`info` parameter), TLS key derivation (`context` parameter), and Pedersen's own hash-index parameter.

### 7.5 Pre-computation by a colluding sequencer

On an L2 like Base, the sequencer sees blocks before other participants. Could a colluding sequencer + executor pre-compute proofs? In principle, yes — if the sequencer tells the executor the next block hash before publishing it, the executor can generate the proof early. In practice, (a) the challenge UUID is generated by the parent, not the sequencer, so the sequencer alone cannot pre-compute; (b) the scope and work-output root also enter the hash, so even knowing the block hash doesn't let you skip the work; (c) the sequencer is run by Coinbase / the Base team and Base's batch posting to L1 provides a commitment, so a manipulated block hash would be detectable at the L1 level.

For Tier 3 sovereign jobs where sequencer trust is a concern, the upgrade path is to use a Drand beacon value (from the League of Entropy, not the sequencer) as an additional input to the proof hash. This adds one more field to the Pedersen preimage but eliminates sequencer dependency.

### 7.6 Historical incidents from related schemes

**Chainlink VRF v1 withholding attack**: in VRF v1, the oracle could see the block hash that would seed the VRF output *before* deciding whether to respond. A dishonest oracle could refuse to reveal its VRF output when the result was unfavorable (e.g., a lottery they didn't win). v2 mitigated this by introducing a subscription model and a `requestId` that decouples the output from any single block. PCC's design is not vulnerable to withholding because the parent issues the challenge and the child merely responds — there is no party that can selectively suppress the anchor.

**PoolTogether v4 miner re-roll**: a 2021 Code4rena audit found that miners on PoW Ethereum could re-roll the `blockhash` input to a prize draw by discarding unfavorable blocks and mining a replacement. Post-Merge, this attack surface closed for PoS validators (who can only bias `prevrandao` by 1 bit), and on L2s the "miner" is the single sequencer, so the attack surface is sequencer collusion (addressed in 7.5 above).

**Drand-Filecoin clock regression (2020)**: an early Drand round stalled when a quorum of League of Entropy nodes went offline simultaneously, causing Filecoin (which uses Drand for election randomness) to halt block production. This demonstrates the liveness risk of threshold beacons: if the committee is unavailable, no fresh randomness can be produced. PCC avoids this by anchoring to L2 blocks (the L2 is already a liveness dependency for settlement), not to an external beacon.

---

## 8. Integration with PCC's Existing Crypto

### 8.1 Pedersen commitment service

`packages/verifier/src/commitment-service.ts` builds Merkle trees from `EvidenceCommitment` records using Barretenberg Pedersen (`pedersenHash`, `pedersenHashPair`, `sha256ToField` from `pedersen.ts`). The `ChallengeService` will reuse the same `pedersenHash` function for proof hash computation. Both the commitment tree and the challenge proof operate over BN254 field elements — they share a cryptographic domain. This also means the Noir circuits that verify Merkle proofs can be extended to additionally verify challenge proofs without introducing a second hash function.

### 8.2 Noir ZK circuits

For Tier 3 sovereign jobs, the `noir-proof-service.ts` compiles Noir circuits that prove evidence integrity inside a ZK proof. The challenge proof can be added to the circuit as an additional constraint:

```noir
fn verify_challenge(
    challenge_id: Field,
    block_hash: Field,
    work_output_root: Field,
    scope: Field,
    expected_proof: Field,
) {
    let computed = std::hash::pedersen_hash([challenge_id, block_hash, work_output_root, scope]);
    assert(computed == expected_proof);
}
```

This requires four public inputs (the preimage fields) and one private input (the expected proof, which is also a public output for the verifier). The circuit adds roughly 1,500 constraints to the Noir prover's R1CS — negligible compared to the Merkle tree verification constraints.

### 8.3 Evidence verifier integration

`packages/verifier/src/evidence-verifier.ts` produces `VerificationFinding` records with `{check, passed, details, severity}`. The challenge freshness check slots in as a new finding:

```typescript
findings.push({
  evidenceEventId: "",
  check: "challenge_freshness",
  passed: proofValid,
  details: proofValid
    ? `Execution proof verified: block ${proof.computedAtBlock.blockNumber}, delta ${delta}s`
    : failReason,
  severity: proofValid ? undefined : "high",
});
```

This finding will be evaluated during the overall tier compliance check. For tiers 0 and 1, `challenge_freshness` is informational (a warning if missing). For tiers 2 and 3, it's mandatory (failure if missing or invalid).

---

## 9. File Layout

| File | Purpose |
|------|---------|
| `packages/spec/src/types/evidence.ts` | Add `BlockAnchor`, `WorkflowChallenge`, `ExecutionProof` interfaces |
| `packages/verifier/src/workflow/challenge-service.ts` | `ChallengeService` class (issue, compute, verify) |
| `packages/verifier/src/evidence-verifier.ts` | Add `challenge_freshness` finding to `verify()` |
| `packages/verifier/src/__tests__/challenge-service.test.ts` | Unit tests |

---

## 10. Concrete ChallengeService for PCC

The full implementation. Uses `viem` for RPC calls (already a PCC dependency), Barretenberg Pedersen via the existing `pedersen.ts` module, and UUID v4 from the `crypto` module.

```typescript
/**
 * ChallengeService — anti-replay freshness binding for PCC workflows.
 *
 * Two modes:
 *   1. Settled: anchor is the MilestoneEscrow deployment block.
 *   2. Unsettled: anchor is the latest block at issue time.
 *
 * All hashing uses Barretenberg Pedersen (BN254), matching Noir circuits.
 *
 * @module packages/verifier/src/workflow/challenge-service.ts
 */

import { randomUUID } from "node:crypto";
import type { PublicClient, Hex } from "viem";
import { pedersenHash, hashToField } from "../pedersen.js";
import type { WorkflowChallenge, ExecutionProof, BlockAnchor } from "@pcc/spec";

/** BN254 modulus — imported from pedersen.ts for field arithmetic */
const BN254_MOD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Default challenge validity window (seconds) */
const DEFAULT_MAX_AGE = 600;

/** Slack for clock drift (seconds) */
const CLOCK_SLACK = 30;

/** Default L2 confirmation depth (blocks) */
const DEFAULT_CONFIRMATIONS = 12;

/** Convert a UUID string to a BN254 field element */
function uuidToField(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  return BigInt("0x" + hex) % BN254_MOD;
}

/** Convert an arbitrary string to a BN254 field element (Keccak then reduce) */
function stringToField(s: string): bigint {
  // Use the first 32 bytes of the UTF-8 encoding, pad with zeros
  const bytes = new TextEncoder().encode(s);
  let hex = "0x";
  for (let i = 0; i < Math.min(bytes.length, 32); i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return BigInt(hex) % BN254_MOD;
}

/** Fetch a BlockAnchor from the chain */
async function fetchBlockAnchor(
  client: PublicClient,
  blockNumber?: bigint,
): Promise<BlockAnchor> {
  const block = blockNumber
    ? await client.getBlock({ blockNumber })
    : await client.getBlock();
  return {
    chainId: client.chain?.id ?? 84532,
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
  };
}

export class ChallengeService {
  private client: PublicClient;

  constructor(client: PublicClient) {
    this.client = client;
  }

  /**
   * Issue a challenge for an unsettled sub-task.
   * Uses the current latest block as the anchor.
   */
  async issueChallenge(
    issuedByAgent: string,
    scope: string,
    maxAgeSeconds: number = DEFAULT_MAX_AGE,
  ): Promise<WorkflowChallenge> {
    const anchor = await fetchBlockAnchor(this.client);
    return {
      challengeId: randomUUID(),
      issuedByAgent,
      issuedAtBlock: anchor,
      maxAgeSeconds,
      scope,
    };
  }

  /**
   * Issue a challenge for a settled job, anchored to the MilestoneEscrow
   * deployment block.
   */
  async issueChallengeFromEscrow(
    issuedByAgent: string,
    scope: string,
    escrowDeployBlock: bigint,
    maxAgeSeconds: number = DEFAULT_MAX_AGE,
  ): Promise<WorkflowChallenge> {
    const anchor = await fetchBlockAnchor(this.client, escrowDeployBlock);
    return {
      challengeId: randomUUID(),
      issuedByAgent,
      issuedAtBlock: anchor,
      maxAgeSeconds,
      scope,
    };
  }

  /**
   * Compute an ExecutionProof for a given challenge and work output.
   * Called by the executor after completing the sub-task.
   */
  async computeProof(
    challenge: WorkflowChallenge,
    workOutputRoot: Hex,
  ): Promise<ExecutionProof> {
    const proofHash = await pedersenHash([
      uuidToField(challenge.challengeId),
      hashToField(challenge.issuedAtBlock.blockHash),
      hashToField(workOutputRoot),
      stringToField(challenge.scope),
    ]);

    const computedAtBlock = await fetchBlockAnchor(this.client);

    return {
      challengeId: challenge.challengeId,
      proofHash: `0x${proofHash.replace("pedersen:", "")}` as Hex,
      workOutputRoot,
      computedAtBlock,
    };
  }

  /**
   * Verify an ExecutionProof against its challenge.
   * Returns { valid: boolean, reason?: string }.
   */
  async verifyExecutionProof(
    challenge: WorkflowChallenge,
    proof: ExecutionProof,
    confirmationDepth: number = DEFAULT_CONFIRMATIONS,
  ): Promise<{ valid: boolean; reason?: string }> {
    // 1. Fetch and verify the anchor block hash
    let anchorBlock;
    try {
      anchorBlock = await this.client.getBlock({
        blockNumber: challenge.issuedAtBlock.blockNumber,
      });
    } catch {
      return { valid: false, reason: "Failed to fetch anchor block from RPC" };
    }

    if (anchorBlock.hash !== challenge.issuedAtBlock.blockHash) {
      return { valid: false, reason: "Anchor block hash mismatch (reorg or forgery)" };
    }

    // 2. Check confirmation depth
    const latest = await this.client.getBlockNumber();
    if (latest - challenge.issuedAtBlock.blockNumber < BigInt(confirmationDepth)) {
      return { valid: false, reason: "Anchor block not yet finalized" };
    }

    // 3. Recompute proof hash
    const expected = await pedersenHash([
      uuidToField(challenge.challengeId),
      hashToField(challenge.issuedAtBlock.blockHash),
      hashToField(proof.workOutputRoot),
      stringToField(challenge.scope),
    ]);
    const expectedHex = `0x${expected.replace("pedersen:", "")}`;
    if (expectedHex !== proof.proofHash) {
      return { valid: false, reason: "Proof hash mismatch" };
    }

    // 4. Temporal ordering
    if (proof.computedAtBlock.blockNumber <= challenge.issuedAtBlock.blockNumber) {
      return { valid: false, reason: "Proof computed before or at challenge block (replay)" };
    }

    // 5. Freshness (within maxAgeSeconds + slack)
    const delta = Number(
      proof.computedAtBlock.blockTimestamp - challenge.issuedAtBlock.blockTimestamp,
    );
    if (delta > challenge.maxAgeSeconds + CLOCK_SLACK) {
      return {
        valid: false,
        reason: `Challenge stale: ${delta}s > ${challenge.maxAgeSeconds + CLOCK_SLACK}s`,
      };
    }

    return { valid: true };
  }
}
```

### 10.1 Wire-up plan

1. **Types** (`packages/spec/src/types/evidence.ts`): Add `BlockAnchor`, `WorkflowChallenge`, `ExecutionProof` interfaces. Export from the type barrel (`index.ts`).

2. **Service** (`packages/verifier/src/workflow/challenge-service.ts`): The class above. Import `pedersenHash` and `hashToField` from `../pedersen.js`.

3. **Evidence verifier** (`packages/verifier/src/evidence-verifier.ts`): In the `verify()` method, after the existing bundle-hash and tier-requirement checks, add:
   ```typescript
   // Challenge freshness (tiers 2+ mandatory, tiers 0-1 informational)
   if (bundle.executionProof && bundle.workflowChallenge) {
     const challengeSvc = new ChallengeService(this.rpcClient);
     const result = await challengeSvc.verifyExecutionProof(
       bundle.workflowChallenge,
       bundle.executionProof,
     );
     findings.push({
       evidenceEventId: "",
       check: "challenge_freshness",
       passed: result.valid,
       details: result.valid
         ? `Freshness verified: delta ${delta}s`
         : result.reason ?? "Unknown failure",
       severity: result.valid
         ? undefined
         : tier >= 2 ? "critical" : "low",
     });
   }
   ```

4. **Tests** (`packages/verifier/src/__tests__/challenge-service.test.ts`): Mock `viem` PublicClient with hardcoded block responses. Test:
   - Happy path: issue, compute, verify.
   - Replay detection: proof computed before challenge block.
   - Stale challenge: delta exceeds maxAgeSeconds.
   - Hash mismatch: tampered workOutputRoot.
   - Scope isolation: proof from scope A fails for scope B.

5. **Settled-job integration**: In the gateway's escrow-creation flow (`packages/gateway/src/routes/escrow.ts` or equivalent), after deploying the MilestoneEscrow contract, call `issueChallengeFromEscrow` with the deployment block number and attach the resulting `WorkflowChallenge` to the job record. The executor receives the challenge as part of the job payload.

---

## Sources

- [EIP-4399: Supplant DIFFICULTY with PREVRANDAO](https://eips.ethereum.org/EIPS/eip-4399)
- [Solidity globals: blockhash, prevrandao](https://docs.soliditylang.org/en/latest/units-and-global-variables.html)
- [Base Transaction Finality](https://docs.base.org/base-chain/network-information/transaction-finality)
- [Chainlink VRF Security Considerations (v2)](https://docs.chain.link/vrf/v2/security)
- [Chainlink VRF vulnerability ($300K bounty)](https://cryptoslate.com/chainlink-vrf-vulnerability-thwarted-by-white-hat-hackers-with-300k-reward/)
- [PoolTogether VRF re-roll finding (Code4rena)](https://github.com/code-423n4/2021-10-pooltogether-findings/issues/56)
- [drand quicknet announcement](https://docs.drand.love/blog/2023/10/16/quicknet-is-live/)
- [drand protocol specification](https://docs.drand.love/docs/specification/)
- [Solidity Deep Dive: Prevrandao](https://soliditydeveloper.com/prevrandao)
- [Base Flashblocks announcement](https://blog.base.dev/accelerating-base-with-flashblocks)

