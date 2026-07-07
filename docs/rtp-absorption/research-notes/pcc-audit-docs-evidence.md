# PCC Evidence Model Audit — Transport Abstraction Research Notes

**Agent:** auditor-evidence
**Status:** DONE
**Date:** 2026-06-22

---

## Checklist

- [x] docs/ARCH.md — read in full
- [x] docs/WORKFLOW_RUNTIME.md — read in full
- [x] docs/AGENT_INTEGRATION.md — read (evidence/compliance sections in full; contributor-economics sections skimmed)
- [x] docs/EXTENDING_PCC.md — read in full
- [x] docs/STANDARDS.md — read in full
- [x] docs/CID_STORAGE.md — read in full (new branch work, relevant to transport)
- [x] packages/spec/src/types/evidence.ts — canonical evidence types
- [x] packages/spec/src/types/common.ts — Signature, SHA256, Timestamp, AssuranceTier
- [x] packages/spec/src/types/verifier.ts — VerificationAttestation, VerificationFinding
- [x] packages/spec/src/types/attestation.ts — AttestationSet, AttestationRole, Attestation (N-of-M)
- [x] packages/spec/src/util/canonical.ts — hashEvent, hashBundle, verifyBundleHash, verifyEventHash
- [x] packages/attestations/src/types.ts — EAS Attestation, OffChainAttestation, VerificationResult
- [x] packages/attestations/src/off-chain.ts — OffChainSigner, OffChainVerifier, computeOffChainUID
- [x] packages/attestations/src/schemas/pcc-tier-bridge.ts — EAS tier schema (bridgeMaintainer, tier, evidenceCID)
- [x] packages/verifier/src/evidence-verifier.ts — EvidenceVerifier.verify() full check pipeline
- [x] packages/verifier/src/workflow/assurance-score.ts — computeAssuranceScore()
- [x] packages/verifier/src/workflow/challenge-service.ts — ChallengeService (anti-replay)
- [x] packages/verifier/src/network/consensus-engine.ts — ConsensusEngine (Yuma, stake-weighted)
- [x] packages/kernel-sdk/src/job-handler.ts — createKernelHandler (bundle assembly + Ed25519 signing)
- [x] packages/kernel-sdk/src/manifest-builder.ts — DigitalKernelManifest builder
- [x] packages/gateway/src/services/cid-blob-storage.ts — CID blob storage service
- [x] packages/spec/src/types/kernel.ts — ShopKernel, KernelDevice, KernelHeartbeat
- [x] docs/WORKFLOW_RUNTIME.md §2.3 event log shape (ALCOA+ mapping)

---

## Q1: Evidence Bundle Shape (Canonical)

**Source:** `packages/spec/src/types/evidence.ts`

```typescript
interface EvidenceBundle {
  id: Id;                      // unique bundle ID
  jobId: Id;                   // which job this is for
  stepId: Id;                  // which step within the job
  kernelId: Id;                // which kernel produced it
  assuranceTier: AssuranceTier; // 0 | 1 | 2 | 3
  events: EvidenceEvent[];     // all events in this bundle
  bundleHash: SHA256;          // sha256:... of sorted event hashes
  kernelSignature: Signature;  // kernel's signature over bundleHash
  createdAt: Timestamp;        // ISO8601 when bundle was finalized
}
```

Each event:
```typescript
interface EvidenceEvent {
  id: Id;
  type: EvidenceEventType;           // gcode_received | execution_started | ... | capture_anchor_committed (50+ types)
  timestamp: Timestamp;              // ISO8601
  source: EvidenceSource;            // { deviceId, deviceType, kernelId, firmwareVersion? }
  payload: Record<string, unknown>;
  hash: SHA256;                      // sha256 of canonical(type + timestamp + source + payload)
}
```

`Signature` type (`packages/spec/src/types/common.ts`):
```typescript
interface Signature {
  signer: Address;       // 0x-prefixed Ethereum address
  algorithm: "secp256k1" | "ed25519";
  value: string;         // hex-encoded signature bytes
}
```

**Kernel-SDK wire form** (`packages/kernel-sdk/src/job-handler.ts`):
The bundle is serialized/returned as JSON. The `kernelSignature.signer` is the first 20 bytes of the Ed25519 session pubkey hex, formatted as 0x address. The `kernelSignature.value` is the 64-byte Ed25519 signature over the UTF-8 bytes of `bundleHash` (the sha256:… string).

---

## Q2: Signing and Integrity — Full Pipeline

### Event hashing (`packages/spec/src/util/canonical.ts`)

- Input: `{type, timestamp, source, payload}` (NOT the id or hash field)
- Algorithm: `sha256(canonicalize({...}))`
- Canonicalize rules: keys lexicographically sorted at all depths; no whitespace; null included, undefined omitted
- Output format: `sha256:<64-hex>` (tagged string, `type SHA256 = \`sha256:${string}\``)

### Bundle hashing (`packages/spec/src/util/canonical.ts`)

```
bundleHash = sha256(canonicalize(events.map(e => e.hash).sort()))
```

Events are sorted by their hash string before canonicalizing. This makes the bundle hash order-independent (same events in any order → same bundleHash).

### Kernel signature (`packages/kernel-sdk/src/job-handler.ts`)

- The kernel mints a **fresh Ed25519 session keypair** per job
- Session keypair is authorized by the kernel's **principal private key** (Ed25519, 64 bytes, tweetnacl format)
- The session key body is signed by the principal: `nacl.sign.detached(canonicalize(sessionKeyBody), principalPrivateKey)`
- The bundle hash is then signed by the session key: `nacl.sign.detached(UTF8(bundleHash), sessionKeypair.secretKey)`
- The session public key is returned to the caller alongside the bundle

### ALCOA+ "Original" check

From `docs/AGENT_INTEGRATION.md §5`:
> **Original** — Bundle from kernel (signature present, not test-signed)

From `packages/verifier/src/evidence-verifier.ts` (implicit): The `EvidenceVerifier` currently checks bundle_hash_integrity, event_hash_integrity, tier requirements, and power-duration consistency. The "Original" principle is checked by the ALCOA+ layer (ComplianceFacade / assurance-score) via the `kernelSignature` field — a test-signed bundle would have `signFn = async (data) => ({signer: addr, algorithm: "secp256k1", value: \`test_sig_...\`})` (see `evidence-verifier.ts:61` — the TEST-ONLY default signFn produces `test_sig_...` prefix, which is distinguishable from a real secp256k1 signature).

The `@pcc/workflow` event log explicitly calls out this check (`docs/WORKFLOW_RUNTIME.md §2.3`):
> **Original** — `kernel_signature` slot (filled when the verification pipeline lands).

### EAS off-chain attestations (`packages/attestations/src/off-chain.ts`)

For tier-bridge attestations (separate from bundle signing):
- EIP-712 typed-data signatures (secp256k1)
- UID = `keccak256(abi.encodePacked(version, schema, recipient, attester_placeholder, time, expirationTime, revocable, refUID, data, salt, 0))` — deterministic from message content
- Version 2 includes a 32-byte random `salt` for per-attestation replay protection
- Verifier: re-derives UID, recovers signer via EIP-712 digest, checks expiry

The tier-bridge schema (`packages/attestations/src/schemas/pcc-tier-bridge.ts`):
```
"address bridgeMaintainer,uint8 tier,bytes32 evidenceCID"
```
Links a tier number (0..3) to an evidence CID. This is the on-chain anchor that connects the off-chain bundle to the EAS attestation record.

---

## Q3: Provenance Chain

Provenance in PCC has four layers:

### Layer 1: Attribution (ALCOA+ Attributable)
- Every `EvidenceEvent` carries `source.deviceId + source.kernelId`
- Every `EvidenceBundle` carries `kernelId`, `stepId`, `jobId`
- Every `KernelHeartbeat` carries a `kernelSignature` (`packages/spec/src/types/kernel.ts`)
- `ShopKernel` has a `publicKey` for signature verification and an optional `DIDString`

### Layer 2: Contemporaneity (ALCOA+ Contemporaneous)
- Events have ISO8601 `timestamp` from device source clock
- `@pcc/workflow` event table has both `occurred_at` (source clock) and `recorded_at` (gateway ingestion)
- Anti-replay: `WorkflowChallenge` binds execution to a block anchor (`blockNumber`, `blockHash`, `timestamp`, `maxAgeSeconds`)
- `ExecutionProof.proofHash = SHA256(challengeId + blockHash + workOutputRoot)` — proves work happened after block N
- `computedAtBlock` must be > `anchor.blockNumber` strictly

### Layer 3: Multi-verifier attestation aggregation

**`packages/spec/src/types/attestation.ts`** — `AttestationSet` type:
- Declares `roles[]` (N-of-M with optional `minScore`)
- `byRole: Record<roleId, Attestation[]>` — submitted attestations per role
- Each `Attestation`: `{jobId, attestationHash, attestor, score, comment, timestamp, signature}`
- `attestationHash = sha256(jobId + attestor + score + comment + timestamp)`
- `satisfied: boolean` — computed by evaluator

**`packages/verifier/src/network/consensus-engine.ts`** — Yuma Consensus:
- Stake-weighted median (outlier-resistant) across `VerificationResponse[]`
- Outliers (>2 sigma): alignment weight = 0, reputation penalty −5
- Non-responders: reputation penalty −20
- Tier compliance via stake-weighted vote with configurable threshold (default 2/3)
- `attestationHash = sha256(requestId + verdict + sorted_response_signatures)` (for human consensus)

**Aggregated attestation** (`docs/AGENT_INTEGRATION.md §1`):
- `POST /api/jobs/:jobId/attestations/aggregate` → `AggregatedAttestationDTO`
- `GET /api/compliance/evidence/:bundleId/tier-compliance` → `TierComplianceResult`

### Layer 4: Durable CID reference (ALCOA+ Enduring + Available)
- `@pcc/workflow` event table has `storage_cid` slot for IPFS pinning of the full event JSON
- `docs/CID_STORAGE.md` — CIDv1 (raw codec, sha-256 multihash, base32) as the content-address
- Same CID works across local/Helia/Storacha backends — deterministic from bytes
- EAS tier-bridge attestation's `evidenceCID` field (bytes32) anchors the bundle on-chain

---

## Q4: Transport MUST-preserve Invariants

A transport (MQTT, LoRa, relay, gateway relay, etc.) carrying an `EvidenceBundle` MUST preserve the following for the bundle to remain verifiable and tier-compliant at the receiver:

1. **Signature integrity over bundleHash**: `kernelSignature.value` must arrive bit-identical. The verifier re-computes `sha256(canonicalize(events.map(e=>e.hash).sort()))` and checks the Ed25519/secp256k1 signature over that hash string. Any bit flip in the signature or in any event byte invalidates the bundle.

2. **Event hash pre-images must be intact**: Each `event.hash = sha256(canonicalize({type, timestamp, source, payload}))`. The transport must deliver `type`, `timestamp`, `source`, and `payload` byte-identical. Truncation, encoding normalization (e.g. JSON re-formatting that changes key order), or lossy compression invalidates each event's hash.

3. **Canonicalization stability**: Wire encoding MUST be canonical JSON (keys sorted, no whitespace, null values included, undefined omitted) OR the receiver must be able to reconstruct canonical form from a lossless re-serialization. The hash input is always canonical JSON — a transport that normalizes JSON keys differently will produce a different hash.

4. **Ordering of events array**: The `bundleHash` is over `events.map(e=>e.hash).sort()` — the sort is hash-level, not event-level. So the `events[]` array order in the bundle does not matter FOR the hash, but the `events[]` content must be complete (no event may be dropped). Missing events cause both event-hash checks and tier requirement checks to fail.

5. **Completeness — no truncation**: The entire bundle (all events, all fields including `id`, `createdAt`, `kernelId`, `stepId`) must arrive. Fields missing from the bundle type cause:
   - ALCOA+ Attributable failure (source.deviceId/kernelId missing)
   - ALCOA+ Original failure (kernelSignature absent)
   - Tier requirement checks fail (event types missing)

6. **Timestamp window preservation (contemporaneity)**: `event.timestamp` values must arrive unchanged. The verifier checks that execution_started.timestamp < execution_completed.timestamp (positive duration). The ComplianceFacade checks timestamps within the execution window for ALCOA+ Contemporaneous. A transport that reformats timestamps (e.g. UTC → local, precision truncation) will invalidate these checks.

7. **Anti-replay binding (challenge freshness)**: If the bundle was produced under a `WorkflowChallenge`, the `ExecutionProof` must also be transported alongside the bundle. `proof.proofHash = SHA256(challengeId + blockHash + workOutputRoot)` must arrive intact. The challenge has `maxAgeSeconds` (default 600s) — the proof must arrive within this window of the challenge's block timestamp.

8. **Session key provenance for signature verification**: The receiver needs the kernel's session public key (`kernelSessionPublicKey` from `KernelJobResponse`) to call `verifyBundleSignature(bundle, sessionPublicKey)`. This does not need to be in the bundle itself, but the transport path must convey it (e.g., as metadata alongside the bundle, or registered in the kernel manifest).

9. **No re-signing in transit**: Relay nodes MUST NOT re-sign the bundle with their own key. The `kernelSignature` represents a specific kernel's identity. Re-signing replaces provenance and breaks ALCOA+ Original. Relays may wrap the bundle in a transport envelope with their own signature, but the inner `EvidenceBundle.kernelSignature` must be passed through unchanged.

10. **CID reference durability**: For ALCOA+ Enduring/Available, the `storage_cid` / EAS `evidenceCID` link must resolve. A transport that delivers a bundle referencing a CID but routes to a backend where the CID doesn't exist fails the Enduring/Available checks. CID format is CIDv1 (raw codec, sha-256, base32) — same CID works across backends.

11. **Replay protection**: The `OffChainAttestation` EAS mechanism includes a 32-byte random `salt` (Version 2) in the UID derivation, preventing replay of a prior attestation. For bundle transport, replay protection is the responsibility of the receiving gateway (idempotency key on the submission endpoint, or deduplication by `bundle.id`).

---

## Q5: Extension Points (EXTENDING_PCC.md + STANDARDS.md)

**Sanctioned extension paths:**

1. **Adapter interface** (`docs/EXTENDING_PCC.md §Path 1`):
   - Implement `Adapter` from `@pcc/kernel`: `{start, submitJob, getJobStatus, getEvidence, stop}`
   - Self-register via `registerAdapter("namespace", AdapterClass)` at module load
   - Tier 1: basic 5-method interface
   - Tier 2: add `subscribeToJobEvents` (streaming)
   - Tier 3: add `signEvidence` with a maintainer key registered via EAS

2. **Capability templates** — JSON-LD with WoT TD semantics (`docs/STANDARDS.md`):
   - Must include `@context`, `id`, `inputs`, `outputs`, `evidence`, `pricing`
   - Aligned with W3C WoT Thing Description

3. **Bridge directory** — Phase 1: PR to `apps/dashboard/public/bridges.json` with `namespace`, `displayName`, `maintainerDid`, `tier`, `capabilities[]`

4. **Kernel-SDK** (`packages/kernel-sdk`):
   - `buildManifest(input: ManifestBuilderInput)` → `DigitalKernelManifest`
   - `createKernelHandler({manifest, principalKey, principalPrivateKey, execute})` → async handler
   - Handler assembles evidence events, signs bundle with Ed25519 session key
   - Session key policy: `maxTTLSeconds`, `allowedActions: ["evidence_submit", "workflow_step_complete"]`

5. **EAS attestations** (`packages/attestations`):
   - `OffChainSigner.attest(params)` → signed `OffChainAttestation`
   - Schema registration via `computeSchemaUID`
   - Tier-bridge schema: `"address bridgeMaintainer,uint8 tier,bytes32 evidenceCID"`

6. **Workflow runtime** (`packages/workflow`, `docs/WORKFLOW_RUNTIME.md`):
   - `Activity.define(...)` — wrap risky calls (evidence upload, on-chain tx) with idempotency
   - `Workflow` subclass — durable multi-step execution
   - `DataPort<T>` + `CidHandoff` — durable CID handoff between steps

**No existing plugin/registry pattern** for transports specifically. The closest analog is the adapter `registerAdapter()` call — the transport abstraction should mirror this pattern.

---

## Q6: HAS vs LACKS for "carry signed evidence over arbitrary transport"

### HAS (what's already in place)

- **Canonical JSON serialization** — deterministic, any language can recompute hashes
- **Content-addressed bundle hash** — order-independent (sorted event hashes)
- **Kernel identity layer** — Ed25519 principal key + per-job session key (kernel-sdk)
- **EAS off-chain attestations** — EIP-712 typed-data, transport-agnostic signed messages with replay protection (salt)
- **CIDv1 storage reference** — content-addressed, backend-agnostic
- **Anti-replay challenge** — block-anchored `WorkflowChallenge` + `ExecutionProof`
- **ALCOA+ 10-principle framework** — explicit compliance checklist per bundle
- **Multi-verifier aggregation** — `ConsensusEngine` (Yuma), `AttestationSet` (N-of-M)
- **Tier requirements** — `DEFAULT_TIER_REQUIREMENTS[]` mapping tier → required event types

### LACKS (gaps the transport abstraction must fill)

- **No transport framing format** — bundles are returned as JS objects / HTTP JSON responses. There is no standard wire envelope for carrying a bundle over MQTT, LoRa, or a relay. Needed: a transport envelope schema (e.g. `{envelope_version, bundle, session_pubkey, challenge_proof?, relay_hops?}`).
- **No relay attestation chain** — if a bundle passes through an intermediary relay (e.g. LoRa gateway → MQTT broker → PCC gateway), there is no mechanism to attest relay integrity without modifying `kernelSignature`. Needed: optional relay signature chain in the envelope.
- **No session pubkey distribution** — `verifyBundleSignature(bundle, sessionPublicKey)` requires the session public key, but it's not part of `EvidenceBundle`. It's returned out-of-band in `KernelJobResponse.kernelSessionPublicKey`. A transport must carry this alongside the bundle, or it must be fetched from the kernel manifest.
- **No fragmentation/reassembly protocol** — LoRa max payload is ~250 bytes; a bundle with 5 events is typically >2KB. Needed: chunking + CID-based reassembly (put chunks in blob storage, deliver CID over the constrained transport).
- **No transport-layer idempotency** — the gateway's blob storage has `idempotent: true` re-upload detection, but if a transport re-delivers the same bundle twice, the gateway's evidence submission endpoint does not explicitly deduplicate by `bundle.id`. Needed: dedup gate at the submission endpoint, or the transport envelope carries a nonce.
- **No timestamp offset correction** — the contemporaneity check uses event timestamps from the device clock. A constrained kernel (e.g. LoRa node) may have clock drift. The transport MUST carry device timestamps but the verifier needs a policy for acceptable clock skew.
- **No storage_cid in bundle itself** — the ALCOA+ Enduring check requires the bundle to be stored on IPFS/Storacha, but the `storage_cid` lives in the `@pcc/workflow` event table, not in the `EvidenceBundle` type. For a transport to convey "this bundle is durably stored", either the CID must be added to the bundle type, or the receiving gateway must upload on receipt and confirm.

---

## Summary Table: ALCOA+ Principle → Transport Requirement

| Principle | Transport requirement |
|-----------|----------------------|
| Attributable | Carry source.deviceId + source.kernelId intact (no field stripping) |
| Legible | Deliver canonical JSON (no lossy re-serialization) |
| Contemporaneous | Deliver event timestamps unchanged; carry clock-offset metadata if device lacks NTP |
| Original | Do NOT re-sign; pass kernelSignature through; carry session pubkey for verification |
| Accurate | Deliver all event hashes intact; deliver all events (no dropping) |
| +Consistent | Carry all events; no duplicate delivery that could produce false drift alerts |
| +Complete | Carry all required event types for the tier; no truncation |
| +Credible | Carry ExecutionProof alongside bundle if challenge was used |
| +Enduring | Gateway must upload to IPFS/Storacha on receipt; CID must resolve |
| +Available | CID must be resolvable via gateway after transport delivers bundle |
