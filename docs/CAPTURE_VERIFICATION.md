# Capture Verification Protocol (CVP) — Operator Guide

Complete guide to the Capture Verification Protocol for PCC operators and
integrators. CVP closes the sophistication gap in visual/sensor evidence
submitted to PCC jobs: every capture is classified (CC0–CC5), verified through
six gates (G1–G6), and — when eligible — anchored on-chain in
`CaptureClassRegistry`.

- **Authoritative design:** [`ai/research/capture-verification-protocol.md`](../ai/research/capture-verification-protocol.md)
- **Class quick reference:** [`docs/CAPTURE_CLASSES.md`](./CAPTURE_CLASSES.md)
- **Smoke test:** `scripts/smoke-cvp.sh`
- **Canonical types:** `packages/spec/src/types/capture.ts`

---

## Table of contents

1. [What CVP is](#1-what-cvp-is)
2. [Capture classes CC0–CC5](#2-capture-classes-cc0cc5)
3. [API endpoints](#3-api-endpoints)
4. [Operator flow](#4-operator-flow)
5. [UI flow](#5-ui-flow)
6. [Gate reference G1–G6](#6-gate-reference-g1g6)
7. [Platform attestations](#7-platform-attestations)
8. [On-chain anchoring](#8-on-chain-anchoring)
9. [Anti-spoof policy](#9-anti-spoof-policy)
10. [ALCOA+ mapping](#10-alcoa-mapping)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. What CVP is

PCC accepts operator-submitted photos, videos, and multi-sensor evidence and
stakes financial settlement on their authenticity (on-chain
`MilestoneEscrow`, 2.35 % protocol fee). The existing `PhotoCaptureService`
handles dumb-fraud — duplicate uploads, obvious EXIF backdating. It cannot
catch a motivated operator who points a real camera at a screen, re-hashes
a swapped frame, replays a prior capture, or forges IMU readings on a rooted
phone.

The Capture Verification Protocol defines **six capture classes (CC0–CC5),
orthogonal to the four assurance tiers (T0–T3).** Tier determines evidence
*breadth* (how many different event types you need); class determines
*per-frame authenticity*. A Tier-2 "Certified" job can be filled by a CC1
capture (browser + WebAuthn) or a CC4 (dedicated C2PA camera) — the system
honors the declared class only if the submitted evidence actually supports it,
and auto-downgrades silently when it does not.

Every CC1+ capture lands on-chain via `CaptureClassRegistry.sol` (Base
Sepolia). The on-chain footprint is ~80–100 k gas (~$0.000001 at current Base
Sepolia prices). The raw bytes, full manifest, and verifier attestations stay
in IPFS/Storacha, content-addressed by the on-chain hashes. CVP's airtight
claim is that *no path writes to `MilestoneEscrow` without first passing
through a CVP verdict* — every existing evidence route (`photo-verification`,
`evidence.ts`, `touchstone_dispatched`, `workflow_step_completed`) was
audited and wired through the new capture flow (design doc §11).

For the full rationale, attack matrix, and file-level implementation map,
read the design doc at
[`ai/research/capture-verification-protocol.md`](../ai/research/capture-verification-protocol.md).

---

## 2. Capture classes CC0–CC5

| Class | Multiplier | Hardware Example | Attestation Required | Detection Required | On-Chain Anchor |
|-------|-----------|------------------|----------------------|--------------------|-----------------|
| **CC0** | 0.70 | any device, operator self-attest | none | n/a | optional |
| **CC1** | 0.92 | any device, signed manifest | none | liveness (G4) | recommended |
| **CC2** | 0.96 | C2PA-capable camera | C2PA signature | liveness + EXIF | required |
| **CC3** | 1.00 | WebAuthn device | WebAuthn (packed) | liveness + consistency | required |
| **CC4** | 1.00 | iOS w/ AppAttest or Android w/ Play Integrity | Platform (G5) | G4 + G5 | required |
| **CC5** | 1.00 | DePIN camera + N-of-M verifier network | DePIN + consensus | G4 + G5 + G6 | required |

Typical use cases by class:

- **CC0** — legacy `/api/photo/upload` callers; T0/T1 jobs; first-time
  operators still configuring their stack.
- **CC1** — default for the operator PWA at `/operator/mobile`; recommended
  baseline for any new operator. WebAuthn + DeviceMotion + Geolocation +
  server-issued visual nonce.
- **CC2** — native PCC mobile app (ships separately from CVP Wave 1);
  binds CC1 evidence to Apple App Attest or Google Play Integrity.
- **CC3** — Truepic Lens, Numbers Capture, or Starling-Framework apps that
  sign bytes inside the Secure Enclave / StrongBox before userspace can see
  them.
- **CC4** — dedicated cameras (Leica M11-P, Sony A1, Nikon Z9, Canon R5 C,
  or Snapdragon Trusted Camera phones) that hold signing keys in silicon.
- **CC5** — DePIN devices already anchored on another chain (Hivemapper
  dashcams, DIMO vehicles, IoTeX W3bstream, DePHY).

See [`docs/CAPTURE_CLASSES.md`](./CAPTURE_CLASSES.md) for the decision tree
and a deeper class × tier compatibility matrix.

---

## 3. API endpoints

Four routes under `/api/capture/*`, all requiring `Authorization: Bearer $PCC_KEY`.
Handlers live in `packages/gateway/src/routes/capture.ts`.

### 3.1 `POST /api/capture/challenge` — issue a block-anchored nonce

**Body:**

```json
{
  "jobId": "job-abc-123",
  "declaredClass": "CC1",
  "requestedTtlSeconds": 120
}
```

`requestedTtlSeconds` is capped at 120 (hard maximum for capture nonces,
versus 600 for workflow challenges). `declaredClass` must be one of
`CC0`/`CC1`/`CC2`/`CC3`/`CC4`/`CC5`.

**Example:**

```bash
curl -sS -X POST "$GW/api/capture/challenge" \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jobId":"job-abc-123","declaredClass":"CC1"}'
```

**Response (200):**

```json
{
  "challengeId": "a7b8c9d0-...-uuid",
  "blockHash": "0x8e6f...",
  "workOutputRoot": "7a8b9c0d...",
  "nonce": "sha256 of (challengeId || blockHash || workOutputRoot)",
  "issuedAt": "2026-04-23T10:15:00.123Z",
  "expiresAt": "2026-04-23T10:17:00.123Z",
  "maxAgeSeconds": 120,
  "visualNonce": { "type": "qr", "payload": "...", "renderedAt": "..." },
  "blockNumber": 40562689,
  "chainId": 84532,
  "scope": "job-abc-123:CC1"
}
```

The `visualNonce.payload` must be rendered into the captured frame (QR code
in the bottom corner, color-pattern strip, or gesture prompt). `blockNumber`
+ `blockHash` pin the challenge to a specific Base Sepolia block so the
operator cannot pre-roll captures against a stale challenge.

### 3.2 `POST /api/capture/upload` — run verifier, persist verdict

**Body** (validated by `UploadBodySchema` + `CaptureManifestSchema` from
`@pcc/spec`):

```json
{
  "manifest": {
    "class": "CC1",
    "declaredAt": "2026-04-23T10:15:30.456Z",
    "deviceFingerprint": "fp-abc123...",
    "mediaHash": "sha256:<64 hex>",
    "sensorFusion": { "...": "..." },
    "webAuthnAssertion": { "...": "..." }
  },
  "captureBytesBase64": "<base64 of frame bytes>",
  "c2paManifestBase64": "<base64 of JUMBF block, optional>",
  "jobId": "job-abc-123",
  "operatorId": "op-1",
  "challengeId": "a7b8c9d0-...",
  "visualNonceEcho": "...",
  "submittedAt": 1745400930
}
```

`manifest.mediaHash` MUST equal `sha256(captureBytesBase64)` — the gateway
pre-checks this with a dedicated 400 response before running the verifier
(the verifier's G1 would catch it too, but the route short-circuits with a
specific error code).

**Example:**

```bash
CAPTURE_BYTES=$(head -c 65536 frame.jpg | base64 -w0)
CAPTURE_SHA=$(sha256sum frame.jpg | awk '{print $1}')

curl -sS -X POST "$GW/api/capture/upload" \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "manifest": {
    "class": "CC0",
    "declaredAt": "$(date -u +%FT%T.000Z)",
    "deviceFingerprint": "fp-001",
    "mediaHash": "sha256:$CAPTURE_SHA"
  },
  "captureBytesBase64": "$CAPTURE_BYTES",
  "jobId": "job-abc-123",
  "operatorId": "op-1"
}
EOF
```

**Response (200):**

```json
{
  "verdict": "PASS",
  "verifiedClass": "CC0",
  "declaredClass": "CC0",
  "gatesPassed": [1],
  "gatesFailed": [],
  "warnings": [],
  "anchorCandidate": false,
  "verdictId": "verdict-uuid",
  "captureHash": "0x<64 hex>",
  "manifestHash": "0x<64 hex>"
}
```

`verdict` is one of `PASS` / `PARTIAL` / `FAIL`. `verifiedClass` may be a
down-step from `declaredClass` if the detector's ceiling was lower. Error
responses include 400 (`invalid_body`, `invalid_bytes`, `hash_mismatch`) and
500 (`verifier_threw`, `persist_failed`).

### 3.3 `POST /api/capture/anchor` — submit PASS verdict on-chain

**Body:**

```json
{ "verdictId": "verdict-uuid" }
```

Anchoring is only valid for verdicts with `verdict === "PASS"` AND
`anchorCandidate === true`. The route dedupes — a second request for the
same verdict returns the prior `{ txHash, blockNumber, gasUsed, status:
"already_anchored" }`.

**Example:**

```bash
curl -sS -X POST "$GW/api/capture/anchor" \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"verdictId":"verdict-uuid"}'
```

**Response (200):**

```json
{
  "txHash": "0x<64 hex>",
  "blockNumber": 40562689,
  "gasUsed": "82341",
  "anchoredAt": "2026-04-23T10:15:35.000Z"
}
```

**Response (202) — deferred:**

If `CAPTURE_REGISTRY_ADDRESS` is not set in the gateway's environment (pre-
deployment staging), the endpoint returns **202 Accepted** without writing a
row:

```json
{
  "status": "deferred",
  "reason": "CaptureClassRegistry contract not deployed",
  "verdictId": "verdict-uuid"
}
```

This is a valid production path — the smoke script (`scripts/smoke-cvp.sh`)
treats a 202 as a pass. Re-run the anchor step after deployment.

Error responses: 400 (`verdict_not_pass`, `not_anchor_candidate`), 404
(`verdict_not_found`), 500 (`anchor_failed`).

### 3.4 `GET /api/capture/status/:verdictId` — combined verdict + anchor view

**Example:**

```bash
curl -sS -X GET "$GW/api/capture/status/$VERDICT_ID" \
  -H "Authorization: Bearer $PCC_KEY"
```

**Response (200):**

```json
{
  "verdictId": "verdict-uuid",
  "verdict": {
    "verdict": "PASS",
    "verifiedClass": "CC1",
    "declaredClass": "CC1",
    "gatesPassed": [1, 2, 3, 4],
    "gatesFailed": [],
    "warnings": [],
    "anchorCandidate": true,
    "captureHash": "0x<64 hex>",
    "manifestHash": "0x<64 hex>",
    "detectorEvidence": { "ceiling": "CC1", "evidence": [] }
  },
  "jobId": "job-abc-123",
  "operatorId": "op-1",
  "createdAt": "2026-04-23T10:15:30.987Z",
  "anchor": {
    "txHash": "0x<64 hex>",
    "blockNumber": 40562689,
    "gasUsed": "82341",
    "anchoredAt": "2026-04-23T10:15:35.000Z",
    "explorerUrl": "https://sepolia.basescan.org/tx/0x<64 hex>"
  }
}
```

If the verdict was never anchored (deferred, not a candidate, or anchor
pending), `anchor` is `null`.

---

## 4. Operator flow

Seven steps from challenge acquisition to on-chain proof.

1. **Acquire challenge.** `POST /api/capture/challenge` with `{jobId,
   declaredClass}`. Store the `challengeId`, `visualNonce`, `blockNumber`,
   `blockHash`, and `expiresAt` locally. You have ≤120 s.
2. **Capture.** Use `getUserMedia` (browser) or the platform camera API.
   The `visualNonce.payload` MUST appear in the captured frame — QR code
   in the corner, color strip, or gesture prompt depending on
   `visualNonce.type`.
3. **Compute manifest.** Hash the raw bytes with SHA-256, format as
   `sha256:<64 hex>`, and build the `CaptureManifest` per the declared class.
   CC1+ must include `sensorFusion` (IMU + geolocation + frame count).
   CC1 must also include `webAuthnAssertion` over `captureHash`.
4. **Upload.** `POST /api/capture/upload` with the manifest, base64 bytes,
   and echoed `challengeId` + `visualNonceEcho`. The verifier runs G1–G6
   and returns a verdict.
5. **Verify.** Inspect `verdict`, `verifiedClass`, `gatesPassed`,
   `warnings`. If `verdict === "PARTIAL"` the detector down-stepped your
   declared class by one (still anchored, but with the lower-class
   multiplier). If `verdict === "FAIL"`, see §11 Troubleshooting.
6. **Anchor.** If `anchorCandidate === true`, call `POST /api/capture/anchor`
   with the `verdictId`. Gateway oracle writes `CaptureClassRegistry.anchor(...)`.
   202 Accepted means the contract is not deployed yet — re-run later.
7. **Prove.** Share the `explorerUrl` from the status response as public
   proof. The on-chain `CaptureAnchored` event indexes by `captureHash`,
   `jobId`, and `submittedBy`. Anyone can cross-reference.

---

## 5. UI flow

The React component `CaptureFlow` at
`packages/ui/src/capture/CaptureFlow.tsx` wraps the six-step operator flow
above. It coordinates:

- `WebAuthnClient` (`packages/ui/src/capture/WebAuthnClient.ts`) — register
  + assert helpers
- `SensorFusion` (`packages/ui/src/capture/SensorFusion.ts`) — DeviceMotion
  + Geolocation plumbing
- `VisualNonceRenderer` (`packages/ui/src/capture/VisualNonceRenderer.tsx`) —
  overlays the QR / color / gesture nonce so the camera frame includes it
- `C2PAReader` (`packages/ui/src/capture/C2PAReader.ts`) — parses C2PA
  manifest from JPEG/HEIC when available
- `FaceLandmarker` (`packages/ui/src/capture/FaceLandmarker.ts`) — MediaPipe
  face landmarks for liveness cross-check (CC1+)

### Embedding

```tsx
import { CaptureFlow } from "@pcc/ui";

function OperatorJobPage({ jobId }: { jobId: string }) {
  return (
    <CaptureFlow
      jobId={jobId}
      declaredClass="CC1"
      gatewayBase="https://capability.network"
      apiKey={sessionApiKey}
      onVerdict={(result) => console.log("verdict", result)}
      onAnchor={(anchor) => console.log("anchor tx", anchor.txHash)}
    />
  );
}
```

The component consumes `@pcc/spec` types directly — the
`CaptureManifestSchema` is the single Zod source of truth for both the client
and the server. See `packages/ui/src/capture/index.ts` for the full public
surface.

---

## 6. Gate reference G1–G6

The `CaptureVerifier` (`packages/verifier/src/capture/verifier.ts`) runs six
gates in order. Mandatory gates by declared class (from `MANDATORY_GATES`):

| Declared | Mandatory |
|---|---|
| CC0 | G1 |
| CC1 | G1, G2, G3, G4 |
| CC2 | G1, G2, G3, G4, G5 |
| CC3 | G1, G2, G3, G4, G5 |
| CC4 | G1, G2, G3, G4, G5 |
| CC5 | G1, G2, G3, G4, G5, G6 |

### G1 — Structural

**Purpose:** `sha256(captureBytes)` equals `manifest.mediaHash`.
**Inputs:** `captureBytes`, `manifest.mediaHash`.
**Fails when:** hashes differ; `captureBytes` is empty.
**Downstream:** FAIL on any G1 miss. There is no class where G1 is optional.

### G2 — Signature

**Purpose:** per-class signature verification.
**Inputs:** the class-specific field of the manifest (`webAuthnAssertion`,
`platformAttestation`, `c2paManifest`, `camera`, `depin`) + adapter-provided
trust anchors.
**Fails when:**
- CC1: WebAuthn signature invalid, challenge mismatch, or `signCount` did
  not advance.
- CC2: platform attestation signature invalid, nonce mismatch, expired, or
  integrity = `failed`.
- CC3: C2PA signature invalid or `enclaveSigned === false`.
- CC4: neither C2PA hardware signer nor CameraAttestation verified;
  `firmwareAcceptable === false`.
- CC5: DePIN tx not found, or on-chain hash ≠ `mediaHash`.

CC0 has no signature and auto-passes G2.

### G3 — Freshness

**Purpose:** `ChallengeService.verifyCaptureNonce` passes — challenge
exists, within TTL (≤120 s), nonce matches the embedded visual payload.
**Inputs:** `CaptureNonceChallenge` (from the gateway's in-memory cache),
`visualNonceEcho`, `submittedAt`.
**Fails when:** no challenge supplied; TTL expired; visual echo mismatch;
`blockAnchor` is older than the challenge block.
**Downstream:** FAIL for CC1+. CC0 skips G3 entirely.

### G4 — Detection

**Purpose:** the 6-pass detector's ceiling class is ≥ declared class.
**Inputs:** manifest signals, C2PA bytes, visual nonce, detector adapters.
**Fails when:** detector finds zero positive evidence for the declared
class or above.
**Downstream:**
- One-step slip (declared CC3, ceiling CC2): verdict = **PARTIAL**,
  `verifiedClass = CC2`.
- Two-step slip (declared CC3, ceiling CC1): **FAIL** — this is treated as
  a tamper signal (§B G4 of the design doc).

### G5 — Attestation

**Purpose:** platform-level attestation confirms the signing device.
**Inputs:** `platformAttestation.token` parsed by Apple App Attest,
Apple DeviceCheck, or Google Play Integrity adapter.
**Fails when:** attestation signature invalid; `integrity === "failed"`;
the attestation's device key does not match the registered device under
the operator's principal key.
**Downstream:** Mandatory for CC2+. Below CC3 the verifier soft-skips (no
warning) when the field is absent.

### G6 — Consensus

**Purpose:** N-of-M verifier signatures form a valid Merkle root.
**Inputs:** array of `{verifierId, signature}` tuples + the
`VerifierRegistry` threshold (default ≥ 3 attesters for CC5).
**Fails when:** fewer than `attesterCountThreshold` valid attestations;
any signature invalid.
**Downstream:** Mandatory only for CC5 in this wave. CC3/CC4 soft-skip.
Wave 5 hardens CC3/CC4 with soft-penalty-on-fail.

Gate outputs feed the final verdict computation. See the verifier source at
`packages/verifier/src/capture/verifier.ts` for the exact logic.

---

## 7. Platform attestations

CVP consumes four external attestation systems. Each is wired into the
verifier via an adapter in `packages/verifier/src/capture/adapters/`.

### Apple App Attest — `appattest-checker-node`

Used by iOS native apps (CC2+). Generates a per-app device key pair inside
the Secure Enclave on first use. Subsequent assertions are over the
`captureHash` as nonce, preventing replay of a prior attestation on a new
capture. Required key fields in `manifest.platformAttestation`:
`{ source: "appattest", token, nonce, keyId, bundleId }`.

### Google Play Integrity — `@googleapis/playintegrity`

Used by Android native apps (CC2+). Returns a signed JWT with verdicts
across three tiers: `MEETS_STRONG_INTEGRITY` (full credit, non-rooted,
genuine firmware), `MEETS_DEVICE_INTEGRITY` (standard), `MEETS_VIRTUAL_INTEGRITY`
(emulator — CC2 caps at 0.85× multiplier and throws a yellow badge). Below
that the capture is rejected. Required fields: `{ source: "playintegrity",
token, nonce, bundleId }` (bundleId = Android package name).

### WebAuthn — `@simplewebauthn/server`

Used by the browser PWA (CC1). Platform authenticators only
(`transports: ["internal"]` — Touch ID, Windows Hello, platform biometric on
Android). The assertion covers `captureHash` as challenge. The
`WebAuthnVerifierAdapter` (`packages/verifier/src/capture/adapters/webauthn.ts`)
wraps `verifyAuthenticationResponse` from the library. Required fields on
`manifest.webAuthnAssertion`: `{ credentialId, signature, authenticatorData,
clientDataJSON, challenge, signCount }`.

### C2PA — `@contentauth/c2pa-node`

Used for CC2+ captures whose manifest is embedded in the image/video (JUMBF
block). The adapter parses the manifest, verifies the signing chain against
the trust anchors in `packages/verifier/trust-anchors/capture-roots.json`
(Truepic, Numbers, Starling) and `camera-roots.json` (Leica, Sony, Nikon,
Canon, Fujifilm, Qualcomm). Required: `c2paManifestBase64` on the upload
request body, containing the raw JUMBF block.

**When each is required per class:**

| Class | WebAuthn | Platform | C2PA | Camera | DePIN |
|---|---|---|---|---|---|
| CC0 | — | — | — | — | — |
| CC1 | **required** | — | — | — | — |
| CC2 | recommended | **required** | — | — | — |
| CC3 | — | required as sub-claim | **required** (enclave-signed) | — | — |
| CC4 | — | — | **required** (hardware-rooted) OR `CameraAttestation` | one of the two | — |
| CC5 | — | — | pass-through | pass-through | **required** |

All three library adapters have mock counterparts in the tests; runtime
wiring of the real libraries happens in the gateway factory at
`packages/gateway/src/capture/verifier-factory.ts`.

---

## 8. On-chain anchoring

The `CaptureClassRegistry.sol` contract (source:
`packages/contracts/src/CaptureClassRegistry.sol`) stores a `CaptureAnchor`
per confirmed capture. One-to-one with `captureHash` — the mapping also
serves as replay prevention.

### 8.1 When anchoring happens

The gateway calls `anchor(...)` inside `POST /api/capture/anchor` iff:

1. Verdict exists for `verdictId` (404 otherwise).
2. `verdict === "PASS"` (400 `verdict_not_pass` on PARTIAL/FAIL).
3. `anchorCandidate === true` (400 `not_anchor_candidate` when the verifier
   explicitly declined).
4. `CAPTURE_REGISTRY_ADDRESS` env var is set (else 202 `deferred`).
5. No prior anchor row exists for `verdictId` (else 200 +
   `status: "already_anchored"`).

Signature: only the `gatewayOracle` EOA can call `anchor(...)` — operators
never write directly. This prevents a rogue operator forging `verifiedClass`.

### 8.2 What goes on-chain (CaptureAnchor struct)

From `packages/contracts/src/CaptureClassRegistry.sol`:

```solidity
struct CaptureAnchor {
    bytes32 captureHash;      // SHA256 of original bytes
    bytes32 manifestHash;     // SHA256 of canonical manifest
    uint8 declaredClass;      // 0..5 = CC0..CC5
    uint8 verifiedClass;      // 0..5 = CC0..CC5 (after detection)
    address submittedBy;
    bytes32 jobId;            // PCC jobId (hashed)
    bytes32 challengeId;      // for CC1+
    uint32 blockAnchor;       // block at challenge time
    uint64 capturedAt;        // unix seconds
    bytes32 attestationsRoot; // Merkle root over N-of-M attestations (0 if none)
    uint16 attesterCount;
}
```

Emits `CaptureAnchored(captureHash, jobId, submittedBy, declaredClass,
verifiedClass)` indexed on all three addresses for cheap filtering.

### 8.3 Deployed registry

The contract is live on **Base Sepolia (chainId 84532)**:

- **Address:** `0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66`
- **Deployed at block:** `40562689`
- **Chain ID:** `84532`
- **Deployment record:** `packages/contracts/deployments/base-sepolia/CaptureClassRegistry.json`

Explorer: `https://sepolia.basescan.org/address/0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66`

Set `CAPTURE_REGISTRY_ADDRESS=0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66`
in the gateway's environment to unlock anchoring (absent → 202 deferred).

### 8.4 Reading from the registry

Two patterns:

1. **Direct read (viem / ethers):** call `getAnchor(captureHash)` or
   `anchors(captureHash)` against the contract. Returns the `CaptureAnchor`
   struct.
2. **Gateway status route:** `GET /api/capture/status/:verdictId` — returns
   the verdict plus, when present, the `anchor` subobject with `txHash`,
   `blockNumber`, `gasUsed`, and a pre-built `explorerUrl`.

The `VerifierRegistry` (second contract address stored in the deployment
file at `verifierRegistry: 0x5D84285C487B1dc631B55512D5423A12A48cd97A`) is
the only permitted caller of `updateAttestations(...)`. Stake-based
verifiers post their N-of-M Merkle root here for CC5 consensus.

---

## 9. Anti-spoof policy

Design doc §7 enumerates ten attack vectors (A1–A10). PCC's per-class
response summary:

| # | Attack | PCC response |
|---|---|---|
| **A1** | Point camera at screen | CC1+: parallax + moiré + multi-sensor self-consistency. CC5: network-level scene cross-check (a DePIN dashcam reports "I see road," not "I see screen"). Disclosed as unfixable below CC5. |
| **A2** | Replay a prior capture | Blocked CC1+: challenge nonce bound to fresh `blockHash`, `signCount` must advance, on-chain `exists[captureHash]` prevents re-anchoring. |
| **A3** | Swap image mid-upload | Blocked CC1+: `sessionKey` signature covers manifest including `mediaHash`. CC0: hash-mismatch detected unless the attacker re-hashes (which trivially fails all signature checks above). |
| **A4** | Rooted / jailbroken device | Blocked CC2+ via Play Integrity / App Attest failure. CC1 partially mitigated (WebAuthn biometric usually requires Secure Enclave even on rooted devices). |
| **A5** | Mock GPS / fake IMU | Blocked CC2+ at platform integrity layer. CC1: self-consistency check (IMU motion vector ∥ optical flow vector, cosine similarity > 0.7) catches most. GPS delta > 1 km = critical fail. |
| **A6** | Stolen operator credentials | CC1+: requires WebAuthn credential (biometric-gated). CC2+: requires device-bound attestation key. CC4: requires registered camera serial. CC5: requires linked DePIN account. |
| **A7** | Forged C2PA manifest | Blocked CC2+: trust-chain check fails against `capture-roots.json` / `camera-roots.json`. Detector auto-downgrades to CC0 with `downgradeReason`. |
| **A8** | Firmware CVE / TEE exploit | CC2+: Apple/Google firmware attestation required. CC4: camera firmware policy (Leica/Sony/Nikon min-firmware allowlist). CC5: consensus layer. Out of scope for CC0/CC1 (browser has no firmware claim). |
| **A9** | Collusion with verifier | Blocked CC5: requires >50 % of DePIN attesters, whitelist limited to networks with >1000 independent node operators (Hivemapper, DIMO both qualify). Below CC5 not applicable (no decentralized verifier set). |
| **A10** | Operator controls the sole DePIN attester | Blocked: PCC policy requires `attesterCount >= 3` and only whitelists DePIN sources with >1000 independent operators. Small DePIN networks are NOT eligible for CC5. |

Known unfixable: **point-camera-at-screen across all classes below CC5.**
This is physically unsolvable with current hardware — no camera can tell it
is not pointed at reality. PCC discloses this in operator onboarding and
focuses CVP on *everything around the capture* (who, when, where, with
what) to raise the attack cost past economic rationality for most jobs.

---

## 10. ALCOA+ mapping

Each gate contributes to the ALCOA+ principles the compliance facade
publishes per evidence bundle:

| Principle | Gate contribution (CC1+) | CC4/CC5 strengthening |
|---|---|---|
| **A**ttributable | G2 binds `sessionKey → principalKey → WebAuthn credential` | + platform/enclave/camera/network binding |
| **L**egible | G1 (hash verifiable) | unchanged |
| **C**ontemporaneous | G3 (block anchor + ≤120 s TTL) | unchanged |
| **O**riginal | G2 + detector's `anchorCandidate` flag | + platform / enclave / hardware / network signer |
| **A**ccurate | G4 detection self-consistency | + platform integrity / consensus |
| **+C**onsistent | G4 multi-sensor check | + cross-chain consensus at CC5 |
| **+C**omplete | G4 sensor-stream bundle | + DePIN multi-node coverage |
| **+C**redible | G5/G6 | verifier confidence ≥ 90 AND PASS rate ≥ 0.9 across job's captures |
| **+E**nduring | anchored hash (IPFS + on-chain) | + DePIN chain |
| **+A**vailable | gateway + Storacha | + DePIN mirrors |

### What's wired today (Wave 1)

`AssuranceScore.captureClass` is already an input to
`packages/verifier/src/workflow/assurance-score.ts`. The multiplier
(0.70/0.92/0.96/1.00) is applied on every bundle verification call and
propagates through the compliance facade's computed score.

### What's deferred (Wave 6a)

Full cross-facade wiring from the `captureVerdicts` table into the
`ComplianceReportDTO` ALCOA+ bits is in progress. The integration plan and
the sketch code for `computeAlcoaWithCapture` are documented at
[`ai/research/cvp-alcoa-integration.md`](../ai/research/cvp-alcoa-integration.md).

Expected tightening once wired:

- `accurate` = existing `tierCompliance.compliant` AND (no CC0 captures for
  tier 2+ jobs).
- `credible` = existing AND (PASS verdict rate ≥ 0.9 across the job's
  captures).
- `original` = existing `kernelSignature` check AND (all verdicts are
  `anchorCandidate === true` when `assuranceTier >= 2`).

---

## 11. Troubleshooting

The canonical exerciser is `scripts/smoke-cvp.sh`. Run it against any
gateway (default `http://localhost:3000`) with a valid bearer token:

```bash
GW=https://capability.network PCC_KEY=pcc_live_... bash scripts/smoke-cvp.sh
```

It exercises all four routes (challenge → upload → anchor → status), writes
a JSON report to `ai/supervisor/smoke-cvp-report.json`, and passes cleanly
when anchoring returns a 202 (contract not deployed — expected in staging).

Common failures and fixes:

### `400 hash_mismatch` on upload

Your `manifest.mediaHash` does not equal `sha256(captureBytesBase64)` after
base64 decode. Fix: recompute the hash over the *decoded* bytes, not the
base64 string. Use the `sha256:` prefix.

### `400 invalid_body` with Zod `details`

The request body failed `UploadBodySchema.safeParse`. Read `details.fieldErrors`
in the response — every field validator reports its own error with a
human-readable message. Common misses: `manifest.class` must be literal
`"CC0"` (not the integer 0), `manifest.declaredAt` must be RFC 3339 ISO
datetime, `mediaHash` must match the regex `^sha256:[a-f0-9]{64}$`.

### `verdict === "PARTIAL"` with one-step downgrade

The detector found evidence only for a class one step below your declared
class. This is accepted but anchored under the lower class — your final
assurance multiplier drops. Fix: either accept the downgrade, or re-capture
with the missing attestation (e.g. declared CC3 but no enclave sub-claim
→ install the Truepic app, then re-capture).

### `verdict === "FAIL"` with `warnings` listing a specific gate

Inspect `gatesFailed` and the `warnings` array. Example patterns:

- `"G3: expired"` → challenge TTL (120 s) ran out before upload. Re-
  acquire a challenge; start the capture flow within ~90 s.
- `"G2/CC1: WebAuthn challenge mismatch"` → `clientDataJSON.challenge`
  does not equal base64url of `captureHash`. Rebuild the manifest *after*
  hashing the bytes; pass the same value as the WebAuthn challenge.
- `"G2/CC4: camera firmware below policy"` → your camera's firmware at
  capture time is below the per-manufacturer allowlist. Update firmware,
  re-capture.
- `"detector ceiling CC1 is 2 steps below declared CC3"` → tamper signal.
  The detector found only CC1 evidence for a CC3 claim. Either you
  mis-declared, or the capture path was intercepted. Re-capture honestly
  at the ceiling class.

### `202 deferred` on anchor

Expected when the gateway's `CAPTURE_REGISTRY_ADDRESS` env var is not set.
Fix: set it to
`0xAaB3F94fdEDF02663A4817961A6f7C4f5A912A66` (Base Sepolia) and retry the
anchor call. The verdict row persists — a later call with the same
`verdictId` will anchor.

### `500 verifier_threw`

An adapter threw an unhandled exception (common cause: `@contentauth/c2pa-node`
native binary missing on the platform; `appattest-checker-node` Apple CA
bundle stale). Check the gateway logs for the adapter name and stack. The
factory in `packages/gateway/src/capture/verifier-factory.ts` documents the
runtime-wire points where each adapter is injected.

### `404 verdict_not_found` on anchor

Either the `verdictId` is wrong, or the gateway was restarted and the
verdict row is not persisted (the in-memory challenge cache does NOT
persist, but verdict rows DO — they go into the `captureVerdicts` SQLite
table). Double-check the `verdictId` spelling.

### Challenge cache exhaustion

The in-memory `challengeCache` evicts entries older than
`CAPTURE_NONCE_MAX_AGE_SECONDS * 10` (1200 s). In a multi-instance deploy
this moves to Redis. On single-instance Railway (supported since Wave 4),
the map is safe — captures expire in ≤120 s, the 10× safety margin keeps the
map bounded.

---

## See also

- [`docs/CAPTURE_CLASSES.md`](./CAPTURE_CLASSES.md) — class quick reference and
  decision tree
- [`ai/research/capture-verification-protocol.md`](../ai/research/capture-verification-protocol.md)
  — authoritative design (50+ pages)
- [`ai/research/cvp-alcoa-integration.md`](../ai/research/cvp-alcoa-integration.md)
  — full ComplianceFacade ALCOA+ wiring plan
- `scripts/smoke-cvp.sh` — end-to-end exerciser for the four `/api/capture/*`
  routes
- `packages/gateway/src/routes/capture.ts` — endpoint handlers
- `packages/verifier/src/capture/verifier.ts` — G1–G6 orchestrator
- `packages/ui/src/capture/CaptureFlow.tsx` — operator UI flow
- `packages/contracts/src/CaptureClassRegistry.sol` — on-chain registry
