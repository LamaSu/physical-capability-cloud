# Capture Verification Protocol (CVP) for PCC

**Author:** /go orchestrator (session 2026-04-21)
**Branch:** `capture-verification-protocol` (off `master`)
**Status:** Phase 1 — design complete, ready for wheel-scout + Wave 1
**Target:** Every capture path that can end up on-chain in PCC, with user opt-in, auto-detection, and verification protocol per route. Airtight.

---

## 0. Problem statement

PCC accepts visual/sensor evidence from operators and stakes financial settlement on its authenticity (Base Sepolia escrow via `MilestoneEscrow`, 2.35% protocol fee). Today, evidence goes through `/api/photo/upload` with `PhotoCaptureService` (image hash + EXIF + anti-spoof heuristic) — good enough to detect *dumb* fraud (re-uploading a stock photo), not good enough to detect a sophisticated operator who:

1. Points a real camera at a screen showing a pre-baked "completed job" render.
2. Swaps the frame between EXIF strip and upload.
3. Replays evidence from a prior completed job.
4. Forges sensor readings via rooted Android + mock GPS/IMU.
5. Uses a genuine camera on a pre-prepared scene (easiest attack, hardest to detect).

The Capture Verification Protocol (CVP) defines **six tiers of capture authenticity (CC0–CC5)**, orthogonal to the existing assurance tiers 0–3. Each tier has a unique trust model, verification procedure, and set of anti-spoof affordances. Operators declare their class per capture. The system **auto-detects** whether the declared class is actually supported by the submitted evidence and downgrades silently on mismatch. All capture claims plus a small set of verification attestations land on-chain via `CaptureClassRegistry.sol`. Confirmed class feeds into `computeAssuranceScore`.

"Air tight" means: **no capture path exists that writes to `MilestoneEscrow` without passing through CVP**. Every existing evidence write site (`photo-verification.ts`, `evidence.ts`, digital workflow `touchstone_dispatched`, `workflow_step_completed`) is audited in §11 and wired through the new capture flow.

**Scope:** photographic / video / multi-sensor captures originating from an operator device (phone, laptop webcam, dedicated camera, DePIN hardware). *Out of scope:* machine-generated telemetry (G-code, power profile, chromatograph output) — that already flows through `EvidenceBundle` with `SessionKey` signatures and is authenticated by possession of the kernel private key, not by capture physics. Operator-submitted camera photos are the weak spot CVP closes.

---

## 1. Taxonomy — Capture Classes CC0..CC5

The six classes are **orthogonal** to PCC's existing `assuranceTier: 0|1|2|3`. A Tier 2 job (Certified, requires photo + device health + events) can be fulfilled by a CC1 capture (browser-signed) or a CC4 capture (C2PA Sony A1) — tier determines *evidence breadth*, class determines *per-frame authenticity*. The final assurance score is a function of both.

```
                 AssuranceTier (evidence breadth)
                 T0        T1        T2        T3
CaptureClass  +--------+--------+--------+--------+
CC0 Unsigned  | allow  | allow  | reject | reject |  <- downgraded to T0-eq if submitted at T2+
CC1 Browser   | allow  | allow  | allow  | warn   |
CC2 Platform  | allow  | allow  | allow  | allow  |
CC3 Enclave   | allow  | allow  | allow  | allow  |
CC4 TrustCam  | allow  | allow  | allow  | allow  |
CC5 DePIN     | allow  | allow  | allow  | allow+ |  <- bonus for multi-attester DePIN
              +--------+--------+--------+--------+
```

`reject` = capture is refused at `/api/capture/upload`. `warn` = accepted but `assurance-score` applies a soft penalty multiplier (0.85) and operator sees a yellow badge. `allow+` = consensusBonus eligible beyond the usual 0.05 cap (DePIN already has on-chain attestations).

---

### CC0 — Unsigned Capture

**Definition:** Raw bytes submitted with no cryptographic provenance beyond the gateway TLS session and the operator's bearer token. This is what `/api/photo/upload` currently accepts.

**Trust model:** "Some authenticated operator at some point sent us these bytes." Attestation depth = bearer-token holder only. Image hash is deterministic but not *bound* to anything.

**Spoof resistance:** None against motivated operators. Point-camera-at-screen, upload-saved-jpeg, swap-during-pipeline all succeed.

**User opt-in paths:**
- Default class when operator submits via existing `/api/photo/upload` without any class declaration.
- Explicit `{captureClass: "CC0"}` in the upload body.
- Operator policy setting `defaultCaptureClass: "CC0"` under `/api/operator/policy`.

**Auto-detection — when is CC0 the ceiling?**
- No C2PA manifest present in image/video.
- No platform attestation token (`DeviceCheck`, `Play Integrity`, `App Attest`) in upload metadata.
- No WebAuthn assertion in upload metadata.
- No operator `SessionKey` signature attached with `"capture_submit"` scope.
- EXIF is present but unsigned, or absent.

Detector outputs `{detectedClass: "CC0", ceiling: "CC0", signals: []}`.

**What goes on-chain:**
- `captureHash` (SHA256 of original bytes, content-addressed via IPFS CID)
- `claimedClass = CC0`
- `submittedBy` (operator wallet)
- `jobId` (if linked to a settled job)
- Timestamp + block anchor
- *No verifier attestations* — nothing to verify beyond bytes-equals-hash.

**Verification protocol:**
1. SHA256 of bytes must match `captureHash`.
2. `submittedBy` must be an authorized operator for `jobId` (via `/api/auth` session lookup).
3. `createdAt` must be within job execution window (if `jobId` present).
4. EXIF present → `exifTimestamp` must be within `[jobStart, jobEnd + 600s]` (reject if clearly backdated, otherwise note as "self-reported").
5. Anti-spoof heuristic from current `PhotoCaptureService` (pHash against prior uploads, basic screen-shot detection) runs as `capture_liveness_result` event. Failure → finding severity `warning`, not `critical` (CC0 can't promise liveness).

**PCC integration:**
- Existing `POST /api/photo/upload` path. No changes to the happy path; CC0 is the new explicit default.
- `ComplianceFacade.checkTierCompliance` rejects CC0 for tier >=2. That rejection is the sole gate keeping CC0 evidence out of regulated-grade jobs.

**File-level implementation list:**
- `packages/spec/src/types/capture.ts` — add `CaptureClass = "CC0" | "CC1" | ...`
- `packages/verifier/src/capture/detector.ts` — default-CC0 branch
- `packages/verifier/src/capture/verifier.ts` — CC0 validator (bytes + EXIF + ownership)
- `packages/gateway/src/routes/photo-verification.ts` — accept `captureClass` field, default to `"CC0"`

---

### CC1 — Browser Operator-Signed Capture

**Definition:** Capture performed in a web browser (the operator PWA at `/operator/mobile`) using `getUserMedia` for the camera, `DeviceMotion`/`DeviceOrientation` for IMU, `navigator.geolocation` for GPS, `WebAuthn` for operator identity, and a per-frame nonce displayed in-scene. The captured frame + a sensor-fusion blob are signed by the operator's `SessionKey` (scope `"capture_submit"`), covered by a `WebAuthn` assertion over the same payload, and bound to a `WorkflowChallenge` issued seconds earlier.

**Trust model:** "A particular operator's browser session, holding WebAuthn credentials, captured this frame at this real-world block time, with sensor readings that are self-consistent, and embedded a freshness nonce we chose." Attestation depth: `operator wallet → principalKey → sessionKey → specific WebAuthn credential → specific frame bytes`. Nothing about silicon — purely browser-layer defenses.

**Spoof resistance:**
- **Point-at-screen:** partially resisted. The in-scene nonce (QR or color-pattern) plus parallax liveness (move camera, sensor readings must match IMU and camera motion vectors) force the attacker to screen-mirror in real time + physically tilt the screen in sync. Feasible but meaningful friction.
- **Replay:** resisted. `WorkflowChallenge.challengeId` and `blockHash` are fresh per capture; bound into the signature.
- **Stolen WebAuthn credential:** WebAuthn typically requires platform authenticator (Touch ID / Windows Hello / phone biometric). Not zero-effort to steal but not cryptographically unforgeable in the way a TEE is.
- **Mock GPS / fake IMU:** detectable if operator uses a *rooted* device with mock-location enabled. Browser APIs can't assert "IMU is real," but the verifier checks *self-consistency* (camera motion ≠ IMU motion → reject).

**User opt-in paths:**
- Operator visits `/operator/mobile` → taps "Capture Evidence" → first-capture flow registers WebAuthn credential + attaches it to `principalKey`. All subsequent captures use the registered credential.
- Operator policy `defaultCaptureClass: "CC1"` enabled in UI.
- Explicit per-capture `captureClass: "CC1"` in upload body.

**Auto-detection — when is CC1 the ceiling?**
Detector looks for, in the upload envelope:
- `captureManifest.sessionSignature` (64-byte Ed25519 over canonical manifest)
- `captureManifest.webAuthnAssertion` (clientDataJSON + authenticatorData + signature)
- `captureManifest.sensorFusion` (multi-sensor blob: camera frame hash, IMU timeseries hash, GPS, nonce)
- `captureManifest.challengeId` matching a server-issued `WorkflowChallenge` still within `maxAgeSeconds`
- Absence of C2PA manifest, DeviceCheck / Play Integrity tokens, secure-enclave attestation (if any of these are present, class should be higher).

Detector outputs `{detectedClass: "CC1", ceiling: "CC1", signals: ["webauthn", "session-signature", "multi-sensor", "nonce-ok"]}`.

**What goes on-chain:**
- `captureHash` (of original frame bytes)
- `manifestHash` (of canonical `CaptureManifest` JSON)
- `claimedClass = CC1`
- `challengeId` (for cross-reference to the block anchor the operator bound)
- `sessionKeyId` (links to principalKey via existing SessionKey struct — off-chain)
- `submittedBy` (operator wallet)
- `blockAnchor` (block number + hash at challenge issuance)
- Optional: `verifierAttestations[]` (N-of-M human attestations under `VerifierRegistry`, off-chain but committed via Merkle root)

Raw bytes + manifest stay in IPFS/Storacha. On-chain footprint is ~300 bytes per capture (~0.001 USD at Base Sepolia gas).

**Verification protocol:**
Run in order; any failure produces a `VerificationFinding` and may hard-fail the capture.

1. **Bytes match:** `SHA256(frame.bytes) == captureHash`. Critical finding on fail.
2. **Manifest integrity:** `SHA256(canonical(captureManifest)) == manifestHash`. Critical finding on fail.
3. **Session signature:** `Ed25519Verify(captureManifest, sessionSignature, sessionKey.publicKey) == true`. Critical.
4. **Session proof chain:** run `verifySessionSignedEvent` on the session; verify `parentSignature` over `sessionKey` struct. Critical.
5. **Session scope:** `sessionKey.scope.allowedActions` includes `"capture_submit"`. Critical.
6. **WebAuthn assertion:** verify `clientDataJSON.challenge` = base64url of `captureHash`; verify signature per WebAuthn spec against registered credential public key. Warning severity (WebAuthn adds credential binding but device can still be compromised).
7. **Challenge freshness:** run `ChallengeService.verifyCaptureNonce` — `challengeId` exists, `blockAnchor` within `maxAgeSeconds`, `computedAtBlock > anchor.blockNumber`. Critical.
8. **In-scene nonce present:** run image CV pass looking for the challenge's `visualNonce` (QR or color-pattern) within the frame. Warning — CV can false-negative.
9. **Multi-sensor self-consistency:** IMU motion vector ∥ camera optical flow vector (cosine similarity >0.7 over the capture window). GPS within operator's declared work location radius. Warning if vectors disagree; critical if GPS delta > 1km.
10. **Parallax liveness:** require ≥3 frames with detectable depth-of-field change (computed from focal-blur variance across frames). Warning if static.
11. **Replay check:** `captureHash` not seen in `CaptureClassRegistry` already. Critical on duplicate.
12. **Operator binding:** `SessionKey.parentAgentId` matches an operator on the `jobId`'s kernel. Critical on mismatch.

All findings roll up into `VerificationFinding[]` consumed by `computeAssuranceScore` (critical failure → hard zero).

**PCC integration:**
- New route `POST /api/capture/upload` accepting multipart (frame + manifest) or JSON-base64.
- New route `POST /api/capture/challenge` → returns a `CaptureNonceChallenge` (block-anchored, with `visualNonce` for in-scene embedding).
- New operator UI component `apps/dashboard/src/components/CaptureFlow.tsx` running the 3-step flow (arm → bind nonce → capture).
- `SessionAction` enum gains `"capture_submit"`.
- `EvidenceEventType` gains `capture_class_declared`, `capture_nonce_issued`, `capture_signature_verified`, `capture_liveness_result`, `capture_multi_sensor_fusion`.

**File-level implementation list:**
- `packages/spec/src/types/capture.ts` — CC1 types (CaptureManifest, CaptureNonceChallenge, SensorFusionBlob)
- `packages/spec/src/identity/ephemeral.ts` — SessionAction += "capture_submit"
- `packages/spec/src/types/evidence.ts` — 5 new EvidenceEventType values
- `packages/verifier/src/workflow/challenge-service.ts` — add `issueCaptureNonce`, `verifyCaptureNonce` (extends existing WorkflowChallenge)
- `packages/verifier/src/capture/detector.ts` — CC1 detection pass
- `packages/verifier/src/capture/verifier.ts` — 12-step CC1 verifier
- `packages/verifier/src/capture/liveness.ts` — parallax/moiré/optical-flow checks
- `packages/gateway/src/routes/capture.ts` — `/api/capture/*` routes
- `packages/gateway/src/app.ts` — register capture routes
- `apps/dashboard/src/components/CaptureFlow.tsx` — operator UI
- `apps/dashboard/src/hooks/useWebAuthn.ts` — WebAuthn register + assert helpers
- `apps/dashboard/src/hooks/useSensorFusion.ts` — DeviceMotion + getUserMedia + Geolocation plumbing
- Tests: `packages/verifier/src/capture/*.test.ts` (detector, verifier, liveness)

---

### CC2 — Platform Attestation-Bound Capture

**Definition:** Capture from a native mobile app (iOS or Android) bound to the platform's hardware-backed attestation service. iOS: `DeviceCheck` + `App Attest`. Android: `Play Integrity API` (`DEVICE_INTEGRITY`, `MEETS_STRONG_INTEGRITY`, `MEETS_VIRTUAL_INTEGRITY`). The capture flow is similar to CC1 but adds a platform attestation token that binds the signature to a real, non-rooted, OEM-integrity device.

**Trust model:** CC1 + Apple/Google attesting that the capturing device is a genuine, unmodified platform device. Attestation depth extends to silicon (iOS Secure Enclave / Android TEE) but only indirectly — we trust the platform's attestation server, not the capture process itself.

**Spoof resistance:**
- **Rooted/jailbroken device:** blocked (attestation returns `DEVICE_INTEGRITY=false` or App Attest fails).
- **Point-at-screen:** same weakness as CC1. Platform attestation doesn't verify what the camera is pointed at.
- **Replay:** resisted (same nonce-binding as CC1).
- **Platform attestation forgery:** requires Apple/Google private keys. Not realistic.

**User opt-in paths:**
- Operator installs PCC native app (future deliverable — ships separately from CVP wave 1).
- Operator registers their device via `/api/capture/platform-attest` — one-time exchange, stores device-attestation public key bound to `principalKey`.
- Platform capture manifests include a fresh `platformAttestationToken` per capture.

**Auto-detection — when is CC2 the ceiling?**
Detector looks for:
- Native app user-agent (`X-PCC-Native-Client: ios/1.0` or `android/1.0`).
- `captureManifest.platformAttestation.type ∈ {"app-attest", "play-integrity", "device-check"}`.
- `captureManifest.platformAttestation.token` (Apple JWT or Google signed token).
- Absence of C2PA, Truepic, enclave-direct, or DePIN signatures (which would indicate CC3+).

**What goes on-chain:**
- Everything from CC1 plus:
- `platformAttestationType` (enum: `app-attest | play-integrity | device-check`)
- `platformAttestationDigest` (SHA256 of the platform token, not the token itself — token is long-lived enough we don't want it on-chain)
- `platformAttestationResult` (enum: `strong | standard | virtual | failed`)

**Verification protocol:**
Extends CC1 protocol with:

13. **Platform attestation token validity:** fetch and validate signature against Apple/Google public key (cached + refreshed every 24h). Critical on fail.
14. **Platform integrity result:** accept `MEETS_STRONG_INTEGRITY` for full credit; `MEETS_DEVICE_INTEGRITY` for standard credit; `MEETS_VIRTUAL_INTEGRITY` → warning + soft penalty (0.85 multiplier); anything weaker → reject.
15. **Attestation-bound key:** the App Attest / Play Integrity assertion must cover the `captureHash` as nonce. Prevents replay of an attestation from a prior capture. Critical.
16. **Device binding:** the attestation's device key must match the registered device under the operator's `principalKey`. Critical.

**PCC integration:**
- Route `POST /api/capture/platform-attest` (device registration, one-time per device).
- Route `POST /api/capture/upload` handles CC2 when token fields present.
- `PlatformAttestationAdapter` abstract base in `packages/verifier/src/capture/adapters/platform.ts`.

**File-level implementation list (this wave = stubs, next wave = native app):**
- `packages/verifier/src/capture/adapters/platform.ts` — abstract base + iOS/Android concrete stubs
- `packages/verifier/src/capture/adapters/apple-attestation.ts` — DeviceCheck + App Attest JWT verifier
- `packages/verifier/src/capture/adapters/google-integrity.ts` — Play Integrity token verifier
- `packages/spec/src/types/capture.ts` — PlatformAttestationType enum
- `packages/gateway/src/routes/capture.ts` — `/api/capture/platform-attest` endpoint
- Tests with mocked platform keys

**Native app (deferred):** `apps/native` — React Native or SwiftUI+Kotlin. Out of scope for this CVP build; we ship the server-side adapter + registration endpoint so a native app can integrate later with zero server changes.

---

### CC3 — Secure Enclave Capture

**Definition:** Capture signed directly inside a secure enclave (iOS Secure Enclave, Android StrongBox, Titan M2) *before* the OS userspace can touch the bytes. The enclave holds a device-bound private key, signs over the capture bytes + metadata, and exports the signature. Providers: **Truepic Lens SDK** (their proprietary signing inside SE/StrongBox), **Numbers Protocol Capture SDK** (similar), **Starling Framework** (open-source, C2PA-compliant enclave signing).

**Trust model:** "This frame was signed by a specific enclave instance using a key that has never left hardware." Attestation depth extends to *silicon key material*, and the enclave attestation certifies the capture pipeline (camera HAL → enclave → signature) was not intercepted.

**Spoof resistance:**
- **Point-at-screen:** **still not prevented**. The enclave signs whatever bytes the camera sensor produces. If the sensor sees a screen, the enclave happily signs that.
- **Tampered capture pipeline:** blocked if attestation is over the full sensor → enclave path (Truepic claims this; Android `CameraX` + StrongBox does NOT by default).
- **Replay:** blocked by enclave-generated nonce.
- **Key extraction:** requires physical attack on silicon. Not realistic.
- **Firmware CVEs in TEE:** historically real (QSEE, TrustZone bugs). Mitigate by requiring recent firmware attestation.

**User opt-in paths:**
- Operator installs a Truepic-SDK-integrated app OR the Numbers Capture app OR a Starling-Framework-compliant app.
- On first capture, the SDK registers the enclave-generated public key with PCC via `/api/capture/enclave-register`. One-time per device.
- Existing Truepic / Numbers / Starling users' captures flow in transparently — we just verify the manifest.

**Auto-detection — when is CC3 the ceiling?**
Detector looks for, in priority order:
1. **Truepic manifest:** C2PA with `truepic.com` signing certificate. Signature over `claim_generator="com.truepic"` with device-attestation embedded.
2. **Numbers Capture manifest:** C2PA with `numbersprotocol.io` signing certificate OR Numbers' Starling-based signature.
3. **Starling Framework signature:** Open enclave-based C2PA manifest with attested capture claim.

If any found → class is CC3 or higher (need to discriminate from CC4). Discriminator: CC3 is *app-level* enclave capture (phone camera via SDK). CC4 is *dedicated hardware camera* (Sony A1, Leica M11-P). Trust the SDK's `hardware_type` hint.

**What goes on-chain:**
- Everything from CC2 plus:
- `enclaveProvider` (`truepic | numbers | starling | other`)
- `enclaveManifestHash` (SHA256 of C2PA manifest)
- `enclaveCertFingerprint` (SHA256 of signing cert — trust anchor reference)
- `enclaveFirmwareVersion` (string, e.g., `"iOS 17.4"`)

**Verification protocol:**
Extends CC2 with:

17. **C2PA manifest parse:** use `c2pa-node` library — manifest integrity + claim generator + signature. Critical on parse failure.
18. **Trust chain:** signing cert chains to Truepic / Numbers / Starling root in our trust store. Critical on untrusted root.
19. **Enclave attestation embedded:** Truepic manifest contains Apple/Google platform attestation as sub-claim. Verify that sub-claim per CC2 steps 13–16. Critical.
20. **Hardware claim:** manifest's `hardware_type` matches registered device (prevents swapping a signed manifest between devices owned by same operator). Warning.
21. **Capture-to-sign latency:** if provider reports it (Truepic exposes `capture_timestamp` + `sign_timestamp`), enforce <5 seconds. Warning if longer (could indicate tampering window).

**PCC integration:**
- Route `POST /api/capture/enclave-register` (one-time per device).
- Upload route handles CC3 when enclave manifest present.
- Trust store JSON at `packages/verifier/trust-anchors/capture-roots.json` (Truepic cert, Numbers cert, Starling cert).
- Dependency add: `c2pa-node` via pnpm (**MUST pass `/vet`**).

**File-level implementation list:**
- `packages/verifier/src/capture/adapters/truepic.ts`
- `packages/verifier/src/capture/adapters/numbers.ts`
- `packages/verifier/src/capture/adapters/starling.ts`
- `packages/verifier/src/capture/adapters/c2pa-base.ts` — shared C2PA parsing
- `packages/verifier/trust-anchors/capture-roots.json`
- `packages/gateway/src/routes/capture.ts` — `/api/capture/enclave-register`
- Tests with fixture C2PA manifests (captured from Truepic demo app)

---

### CC4 — Trusted Camera (Dedicated Hardware)

**Definition:** Capture from a camera device that itself holds signing keys in hardware and signs images on-sensor. C2PA-compliant cameras: **Leica M11-P**, **Sony A1 / A7 IV / A9 III** (firmware ≥ Content Authenticity Initiative firmware), **Nikon Z9** (firmware ≥ v3), **Canon R5 C** (with CAI firmware), **Fujifilm GFX100 II** (roadmap). Also: **Qualcomm Snapdragon 8 Gen 3 Trusted Camera** in certain flagship Android phones (Samsung S24 Ultra, etc.).

**Trust model:** "This image was signed by THIS SPECIFIC CAMERA BODY before any userspace software touched it." Silicon-level capture claim. Each camera has a certificate chained to the manufacturer (Leica, Sony, Nikon, Canon, Qualcomm).

**Spoof resistance:**
- **Point-at-screen:** *signed by the sensor as a valid capture*. The hardware doesn't know if it's looking at reality. Same unfixable problem as CC3. Anti-moiré heuristics help (and are visible in flagship DSLR captures).
- **Tampered firmware:** requires flashing unsigned firmware — high-skill, detectable via capture-time firmware version attestation if CAI enforced.
- **Stolen camera body:** operator ID is not bound to camera by default — a thief could use the camera and sign captures. Mitigation: PCC requires operator registers the camera serial number under their `principalKey`.
- **Replay / swap:** signature is over image bytes + timestamp + serial. Any byte change invalidates.

**User opt-in paths:**
- Operator has a supported camera → registers it via `/api/capture/camera-register` with `{manufacturer, model, serial, attestationKey}`. SDK-specific extractor tools (Leica's, Sony's) pull the attestation key from camera into PCC.
- Captures uploaded as standard JPEG/HEIC with C2PA manifest preserved.
- No per-capture operator action — the operator just transfers the card / tethered-shoots.

**Auto-detection — when is CC4 the ceiling?**
- C2PA manifest present with `claim_generator` matching `leica|sony|nikon|canon|fujifilm` root certs in our trust store.
- `hardware_type` in manifest matches registered camera.
- Absence of `truepic|numbers|starling` sub-claims (those would flag CC3).

**What goes on-chain:**
- Everything from CC3 plus:
- `cameraManufacturer`
- `cameraModel`
- `cameraSerialHash` (SHA256 of serial — raw serial kept off-chain for privacy)
- `captureTimestamp` from C2PA manifest

**Verification protocol:**
Extends CC3 with:

22. **C2PA trust chain anchors to manufacturer root:** Leica / Sony / Nikon / etc. roots loaded in trust store. Critical.
23. **Camera serial registered:** `SHA256(serial)` must match the hash registered under operator's `principalKey`. Critical on mismatch.
24. **Firmware version acceptable:** camera firmware at capture time ≥ minimum known-good version in our policy (per-manufacturer allowlist). Warning on below-min (still signed, but older firmware has known attestation gaps).
25. **Capture timestamp vs job window:** `captureTimestamp` within `[jobStart - 300s, jobEnd + 300s]`. Critical on outside window.

**Note on operator binding for CC4:**
CC4 signatures are by the *camera*, not the *operator*. We add an operator binding via a secondary `SessionKey` signature over `{captureHash, jobId, operatorWallet}`. This doesn't strengthen capture authenticity but *does* establish chain of custody. Captures without the secondary operator signature are downgraded to "CC4-unbound" (still trustworthy as pixels, not attributable to a specific operator).

**PCC integration:**
- Route `POST /api/capture/camera-register`.
- Trust store includes manufacturer roots: `packages/verifier/trust-anchors/camera-roots.json`.
- Existing upload route handles CC4 when manufacturer cert detected.

**File-level implementation list:**
- `packages/verifier/src/capture/adapters/c2pa-hardware.ts` — dispatches by manufacturer
- `packages/verifier/src/capture/adapters/leica.ts`
- `packages/verifier/src/capture/adapters/sony.ts`
- `packages/verifier/src/capture/adapters/nikon.ts`
- `packages/verifier/src/capture/adapters/canon.ts`
- `packages/verifier/src/capture/adapters/snapdragon-trusted-camera.ts`
- `packages/verifier/trust-anchors/camera-roots.json`
- Tests with fixture images (public CAI examples available from Leica + Sony press materials)

---

### CC5 — DePIN Hardware Capture

**Definition:** Capture from a device that is part of a decentralized physical infrastructure network (DePIN) where the hardware itself participates in an on-chain attestation network. Examples:
- **Hivemapper** dashcam (maps streets, signs road imagery on-device, posts to Hivemapper chain).
- **DIMO** vehicle telemetry (signed sensor data from connected cars).
- **IoTeX** W3bstream (ioT device attestation → on-chain verification).
- **DePHY** decentralized device IDs.
- **Helium** for network-connectivity proofs (less about image capture, more ambient).

**Trust model:** "This capture is already *on another chain* with multi-party attestation, and PCC is recognizing a cross-chain proof." Attestation depth: a full DePIN consensus — usually dozens of independent observers.

**Spoof resistance:**
- All CC4 resistance plus
- **Cross-chain multi-attester consensus:** a Hivemapper image has already passed Hivemapper's consensus layer before we see it. Spoofing requires compromising the DePIN network, not just one device.
- **Cross-chain replay:** anchor on DePIN chain prevents replay inside PCC.

**User opt-in paths:**
- Operator connects their DIMO / Hivemapper / IoTeX account via OAuth-style flow at `/api/capture/depin-connect`.
- Post-connection, PCC can pull captures directly from the DePIN chain + referenced IPFS content, tagged with the job.
- Per-job linking: operator specifies `{depinSource: "hivemapper", depinCaptureId: "0x..."}` during evidence submission.

**Auto-detection — when is CC5 the ceiling?**
- Upload includes `depinSource` + `depinCaptureId` fields.
- Detector fetches DePIN chain state (via the DePIN's RPC / subgraph) and verifies `depinCaptureId` exists with signed manifest.
- Absence = fall through to CC4 or lower based on other signals.

**What goes on-chain (in PCC's `CaptureClassRegistry`):**
- Everything from CC4 plus:
- `depinSource` (enum: `hivemapper | dimo | iotex | dephy | other`)
- `depinChainId` (EVM chain id or non-EVM identifier)
- `depinCaptureId` (on-DePIN-chain reference)
- `depinAttesterCount` (how many DePIN nodes attested)
- `depinProofDigest` (SHA256 of the DePIN proof we fetched)

**Verification protocol:**
Extends CC4 with:

26. **DePIN chain query:** RPC call to DePIN network, confirm `depinCaptureId` exists. Critical on missing.
27. **Attester count threshold:** >= 3 DePIN attesters (configurable per source). Warning on below-threshold.
28. **Cross-chain hash binding:** the content hash on DePIN chain matches `captureHash` on PCC. Critical on mismatch.
29. **DePIN timestamp vs job window:** same window as CC4. Critical on outside.
30. **Consensus bonus:** if all checks pass with >=5 attesters, `computeAssuranceScore.consensusAgreement` set to `1.0` (allows full +0.05 bonus + unlock `allow+` rating).

**PCC integration:**
- Route `POST /api/capture/depin-connect` (OAuth-style; per DePIN provider).
- Route `POST /api/capture/depin-pull` (actively fetch a DePIN capture by ID, bind to PCC job).
- DePIN RPC clients: `packages/verifier/src/capture/adapters/depin/*` with per-provider module.

**File-level implementation list:**
- `packages/verifier/src/capture/adapters/depin/base.ts` — abstract DePIN adapter interface
- `packages/verifier/src/capture/adapters/depin/hivemapper.ts`
- `packages/verifier/src/capture/adapters/depin/dimo.ts`
- `packages/verifier/src/capture/adapters/depin/iotex.ts`
- `packages/verifier/src/capture/adapters/depin/dephy.ts` (stub, roadmap)
- `packages/gateway/src/routes/capture.ts` — `/api/capture/depin-*` endpoints
- Tests with fixture on-chain responses (mock)

---

## 2. Orthogonality with AssuranceTier

Existing `assuranceTier` stays as-is in terms of **which evidence event types are required** (see `DEFAULT_TIER_REQUIREMENTS` in `packages/spec/src/types/evidence.ts`). CVP adds an *authenticity* dimension that feeds `computeAssuranceScore`.

### Matrix: class × tier acceptance

| | T0 Self | T1 Verified | T2 Certified | T3 Sovereign |
|---|---|---|---|---|
| CC0 | allow (no change) | allow (no change) | **reject** | **reject** |
| CC1 | allow | allow | allow | allow with warning badge (`captureClass_below_tier_expectation`) |
| CC2 | allow | allow | allow | allow |
| CC3 | allow | allow | allow | allow |
| CC4 | allow | allow | allow | allow |
| CC5 | allow | allow | allow | allow + consensus bonus |

### assurance-score.ts extension

Add `captureClass: CaptureClass` to `AssuranceScoreInput`. New multiplier:

```
CAPTURE_CLASS_MULTIPLIER = {
  CC0: 0.70,   // no signature = significant penalty
  CC1: 0.92,   // browser-signed = small penalty
  CC2: 0.96,   // platform-attested = tiny penalty
  CC3: 1.00,   // enclave-signed = neutral
  CC4: 1.00,   // trusted camera = neutral
  CC5: 1.00,   // DePIN = neutral, also eligible for consensusBonus >0.05
}
```

Formula update:
```
final = clamp(0, 1, base * driftMultiplier * touchstoneMultiplier * captureClassMultiplier) + consensusBonus
```

**Why multiplicative, not gated:** a tier-2 job with a CC0 capture plus 3 other strong evidence types may still be acceptable; the protocol doesn't hard-reject, it *penalizes*. The tier-rejection column (above) handles the regulatory-grade gate.

### New VerificationFinding check names

Appended to whatever the existing verifier emits:
- `capture_class_declared` (always, informational)
- `capture_bytes_match` (critical)
- `capture_manifest_integrity` (critical)
- `capture_session_signature_valid` (critical — CC1+)
- `capture_webauthn_valid` (warning — CC1+)
- `capture_challenge_fresh` (critical — CC1+)
- `capture_in_scene_nonce_present` (warning — CC1+)
- `capture_multi_sensor_consistent` (warning — CC1+)
- `capture_parallax_liveness` (warning — CC1+)
- `capture_not_replayed` (critical)
- `capture_operator_bound` (critical)
- `capture_platform_attestation_valid` (critical — CC2+)
- `capture_platform_integrity_strong` (warning — CC2+)
- `capture_c2pa_manifest_valid` (critical — CC3+)
- `capture_c2pa_trust_chain` (critical — CC3+)
- `capture_camera_registered` (critical — CC4+)
- `capture_camera_firmware_acceptable` (warning — CC4+)
- `capture_depin_exists_on_chain` (critical — CC5)
- `capture_depin_attester_count_sufficient` (warning — CC5)

---

## 3. Cryptographic primitives extension

### 3.1 `ChallengeService` — new capture-nonce methods

Extend existing `ChallengeService` (does NOT replace block-anchor challenges — they co-exist):

```typescript
export interface CaptureNonceChallenge {
  challengeId: string;           // UUID
  scope: string;                 // jobId or capabilityId
  issuedBy: string;
  visualNonce: string;           // QR-encodable string OR RGB color pattern
  visualNonceKind: "qr" | "color-pattern" | "gesture";
  anchor: BlockAnchor;
  maxAgeSeconds: number;         // default 120s for captures (tighter than workflow 600s)
  captureClass: CaptureClass;    // which class this challenge is targeted at
}

class ChallengeService {
  // Existing methods unchanged

  async issueCaptureNonce(params: {
    issuedBy: string;
    scope: string;
    captureClass: CaptureClass;
    blockNumber: bigint;
    blockHash: string;
    blockTimestamp: bigint;
    visualNonceKind?: "qr" | "color-pattern" | "gesture";
    maxAgeSeconds?: number;
    chainId?: number;
  }): Promise<CaptureNonceChallenge> { ... }

  verifyCaptureNonce(params: {
    challenge: CaptureNonceChallenge;
    submittedNonce: string;        // what the upload claims to have embedded
    embeddedNonceDetected: boolean; // did our CV pass find it in the frame
    currentBlockTimestamp: bigint;
    captureSubmittedAtBlock: bigint;
  }): { valid: boolean; failures: string[] } { ... }
}
```

`visualNonce` generation: 128-bit random, base32-encoded (26 chars), QR-paintable to ~4cm @ 300dpi. For color-pattern mode, map the 128 bits to a 4×4 RGB grid (3 bits per channel). For gesture mode, emit a sequence like `"tilt-left, tilt-right, hold"` bound to the nonce bits.

### 3.2 `SessionAction` extension

`packages/spec/src/identity/ephemeral.ts`:
```typescript
export type SessionAction =
  | "evidence_submit"
  | "workflow_step_complete"
  | "touchstone_response"
  | "attestation_sign"
  | "heartbeat"
  | "quote_respond"
  | "capture_submit";            // NEW
```

`DEFAULT_SESSION_KEY_CONFIG` unchanged (default actions don't auto-include capture_submit — must be explicit in `allowedActions`, forcing operators to opt in per-session).

### 3.3 `EvidenceEventType` extension

`packages/spec/src/types/evidence.ts`:
```typescript
  // Capture verification protocol events (CVP)
  | "capture_class_declared"
  | "capture_nonce_issued"
  | "capture_submitted"
  | "capture_signature_verified"
  | "capture_liveness_result"
  | "capture_multi_sensor_fusion"
  | "capture_anchor_committed"
```

### 3.4 New `CaptureManifest` type

```typescript
export interface CaptureManifest {
  manifestVersion: "1";
  captureHash: SHA256;            // of original bytes
  capturedAt: Timestamp;
  capturedBy: {
    operatorWallet: `0x${string}`;
    sessionKeyId: string;
    principalAgentId: string;
  };
  scope: { jobId?: string; capabilityId?: string };
  challengeId: string;
  blockAnchor: BlockAnchor;
  declaredClass: CaptureClass;

  // CC1+ optional
  sensorFusion?: {
    imuHash: SHA256;              // of IMU timeseries blob
    gpsLat: number;
    gpsLng: number;
    gpsAccuracyMeters: number;
    gpsTimestamp: Timestamp;
    frameCount: number;
    focalBlurVariance: number;     // for liveness
  };
  webAuthnAssertion?: {
    clientDataJSON: string;        // base64url
    authenticatorData: string;     // base64url
    signature: string;             // base64url
    credentialId: string;
  };

  // CC2+ optional
  platformAttestation?: {
    type: "app-attest" | "play-integrity" | "device-check";
    token: string;                 // JWT or signed blob
    devicePublicKeyHash: SHA256;
  };

  // CC3+ optional — C2PA manifest attachment
  c2paManifest?: {
    rawManifest: string;           // base64 encoded C2PA JUMBF block
    signingCertFingerprint: SHA256;
    claimGenerator: string;        // e.g. "com.truepic"
  };

  // CC4+ optional — camera info
  camera?: {
    manufacturer: string;
    model: string;
    serialHash: SHA256;
    firmwareVersion: string;
  };

  // CC5+ optional — DePIN
  depin?: {
    source: "hivemapper" | "dimo" | "iotex" | "dephy" | "other";
    chainId: number | string;
    captureId: string;
    attesterCount: number;
    proofDigest: SHA256;
  };
}
```

All CVP captures produce and submit this manifest; non-applicable fields are omitted. `SHA256(canonical(manifest))` = `manifestHash`.

### 3.5 `assurance-score.ts` input extension

```typescript
export interface AssuranceScoreInput {
  findings: VerificationFinding[];
  alcoaPrinciples?: Record<string, boolean>;
  driftAlerts?: DriftAlert[];
  touchstoneResult?: { passed: boolean };
  consensusAgreement?: number;
  captureClass?: CaptureClass;      // NEW
}
```

Formula change (inserted between touchstone and consensus bonus):
```typescript
// Capture class multiplier
let captureClassMultiplier = 1.0;
if (captureClass) {
  captureClassMultiplier = CAPTURE_CLASS_MULTIPLIERS[captureClass];
}
const raw = (base * driftMultiplier * touchstoneMultiplier * captureClassMultiplier) + consensusBonus;
```

Existing tests still pass (undefined `captureClass` → multiplier = 1.0 = no change).

---

## 4. Detection architecture

`packages/verifier/src/capture/detector.ts`:

```typescript
export interface DetectionResult {
  declaredClass: CaptureClass;       // what the upload said
  detectedClass: CaptureClass;       // what we found evidence for
  ceiling: CaptureClass;             // highest class the evidence supports
  finalClass: CaptureClass;          // min(declared, ceiling)
  signals: string[];
  downgradeReason?: string;
  detectorRunMs: number;
}

export class CaptureDetector {
  async detect(upload: CaptureUpload): Promise<DetectionResult>;
}
```

Detection passes, run top-down and short-circuit on first positive:

1. **Pass 1 — DePIN link:** `depin.source` field present → try CC5.
2. **Pass 2 — C2PA hardware cert:** parse C2PA manifest; if signing cert chains to Leica/Sony/Nikon/Canon/Qualcomm roots → CC4.
3. **Pass 3 — C2PA enclave cert:** cert chains to Truepic/Numbers/Starling roots → CC3.
4. **Pass 4 — Platform attestation token:** present + verifiable → CC2.
5. **Pass 5 — Session signature + multi-sensor + WebAuthn + nonce:** all present → CC1.
6. **Pass 6 — Default:** CC0.

`ceiling` = first pass that returned positive. If user declared CC4 but ceiling = CC1, `finalClass = CC1` and `downgradeReason = "Declared CC4 but no C2PA manifest detected; falling back to CC1 evidence."`

### 4.1 Upgrade path (declared lower than ceiling)

Operators can declare lower than their device supports (conservative). Example: submit a Leica M11-P JPEG (C2PA-signed) with `captureClass: CC2`. We detect CC4 ceiling, honor the declared CC2, and log `capture_class_downgrade_accepted` (no penalty, user's choice). Reverse is never allowed.

### 4.2 False-positive / false-negative handling

- **False positive (detected class higher than reality):** e.g., someone crafts a fake C2PA manifest. Our trust-chain check fails → detection drops to CC0 with `downgradeReason`.
- **False negative (real capture looks CC0):** detector doesn't find expected signals. Upload accepted at CC0. Operator sees UI message: *"We didn't detect any capture signatures. Your evidence is accepted at CC0. If your device supports C2PA/Truepic/platform attestation, enable it in your capture app settings."*

### 4.3 Kernel self-report

`/api/kernels/:id/heartbeat` body gains `captureCapabilities: CaptureClass[]`. Kernels advertise which classes they can produce. Matchmaking routes jobs to kernels whose `captureCapabilities` meet or exceed the job's minimum class.

---

## 5. Verification protocol (common gates)

These apply regardless of class (run before class-specific checks):

**G1 — Authenticated submitter:** Bearer token valid; operator owns or is delegated to `jobId`'s kernel.
**G2 — Bytes–hash match:** `SHA256(uploadedBytes) === captureHash`.
**G3 — Manifest integrity:** `SHA256(canonicalJSON(manifest)) === manifestHash`.
**G4 — Declared class is supported:** `captureClass ∈ kernel.captureCapabilities`.
**G5 — Window check:** `capturedAt ∈ [jobStart, jobEnd + 600s]` (or global 24h if no job).
**G6 — No replay:** `captureHash` not already anchored in `CaptureClassRegistry`.

Any G-fail → `VerificationFinding{critical, passed: false}`. Because critical findings zero the assurance score, this is the hard floor.

Per-class checks run after common gates and add their own findings (listed in §1 per class).

---

## 6. On-chain protocol

### 6.1 `CaptureClassRegistry.sol` (new contract)

Purpose: anchor every accepted capture's hash + declared class + verifier attestations. Provides replay prevention + public auditability + dispute anchor.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract CaptureClassRegistry {
    struct CaptureAnchor {
        bytes32 captureHash;      // SHA256 of original bytes
        bytes32 manifestHash;     // SHA256 of canonical manifest
        uint8 declaredClass;      // 0..5 = CC0..CC5
        uint8 verifiedClass;      // 0..5 = CC0..CC5 (after detection)
        address submittedBy;
        bytes32 jobId;            // PCC jobId (hashed)
        bytes32 challengeId;      // For CC1+
        uint32 blockAnchor;       // Ethereum block at challenge time
        uint64 capturedAt;        // Unix seconds
        bytes32 attestationsRoot; // Merkle root over N-of-M attestations (0 if none)
        uint16 attesterCount;
    }

    event CaptureAnchored(
        bytes32 indexed captureHash,
        bytes32 indexed jobId,
        address indexed submittedBy,
        uint8 declaredClass,
        uint8 verifiedClass
    );

    event AttestationsUpdated(
        bytes32 indexed captureHash,
        bytes32 attestationsRoot,
        uint16 attesterCount
    );

    event CaptureDisputed(
        bytes32 indexed captureHash,
        address indexed disputer,
        string reason
    );

    mapping(bytes32 => CaptureAnchor) public anchors;     // captureHash -> anchor
    mapping(bytes32 => bool) public exists;                // replay prevention

    // Gateway-only anchor (enforced by role)
    address public immutable gatewayOracle;
    address public immutable verifierRegistry;

    constructor(address _gatewayOracle, address _verifierRegistry) {
        gatewayOracle = _gatewayOracle;
        verifierRegistry = _verifierRegistry;
    }

    function anchor(CaptureAnchor calldata a) external {
        require(msg.sender == gatewayOracle, "only gateway");
        require(!exists[a.captureHash], "replay");
        require(a.declaredClass <= 5 && a.verifiedClass <= 5, "invalid class");
        require(a.verifiedClass <= a.declaredClass, "verified > declared");
        exists[a.captureHash] = true;
        anchors[a.captureHash] = a;
        emit CaptureAnchored(
            a.captureHash, a.jobId, a.submittedBy,
            a.declaredClass, a.verifiedClass
        );
    }

    function updateAttestations(
        bytes32 captureHash,
        bytes32 attestationsRoot,
        uint16 attesterCount
    ) external {
        require(msg.sender == verifierRegistry, "only verifier registry");
        require(exists[captureHash], "no such capture");
        anchors[captureHash].attestationsRoot = attestationsRoot;
        anchors[captureHash].attesterCount = attesterCount;
        emit AttestationsUpdated(captureHash, attestationsRoot, attesterCount);
    }

    function dispute(bytes32 captureHash, string calldata reason) external {
        require(exists[captureHash], "no such capture");
        emit CaptureDisputed(captureHash, msg.sender, reason);
        // Actual slashing handled by MilestoneEscrow dispute flow, not here.
    }

    function getAnchor(bytes32 captureHash) external view returns (CaptureAnchor memory) {
        return anchors[captureHash];
    }
}
```

### 6.2 What's on-chain vs off-chain

| Data | Location | Why |
|---|---|---|
| `captureHash`, `manifestHash` | On-chain | Replay prevention + public auditability |
| `declaredClass`, `verifiedClass` | On-chain | Public record of the trust claim |
| `submittedBy`, `jobId`, `challengeId` | On-chain | Accountability routing |
| `blockAnchor`, `capturedAt` | On-chain | Time window bound |
| `attestationsRoot`, `attesterCount` | On-chain (Merkle root only) | Allows N-of-M proof without storing all attestations |
| Individual verifier attestations | Off-chain (IPFS + Gateway cache) | Storage cost |
| Raw capture bytes | Off-chain (IPFS/Storacha) | Cost; content-addressed via `captureHash` |
| Full `CaptureManifest` JSON | Off-chain (IPFS + Gateway cache) | Content-addressed via `manifestHash` |
| Platform attestation token | Off-chain (redacted store) | Privacy (device IDs) |
| `SessionKey` structs + signatures | Off-chain | Existing digital-verifier pattern |

**Cost estimate:** One `anchor` call costs ~80–100k gas. On Base Sepolia at 0.001 gwei: ~$0.000001 per capture. Negligible.

### 6.3 Gateway oracle

The gateway holds a single privileged EOA (`GATEWAY_ORACLE_KEY` env var, already in `.credentials.json`) that signs all `anchor(...)` calls. Operators don't anchor directly — they submit to `/api/capture/anchor`, the gateway validates, then the gateway's oracle calls the contract. This prevents a rogue operator from anchoring a capture with fake `verifiedClass`.

Existing pattern: `packages/a2a/src/oracle-wiring.ts` and `ProofRegistry` (Starknet) — CVP follows same model.

### 6.4 N-of-M verifier consensus (CC1+ optional, CC5 expected)

Uses existing `VerifierRegistry.sol` (stake-based, 100 USDC min). For high-tier jobs, the gateway can dispatch a capture to 3–5 registered verifiers. Each verifier's attestation (signed statement: "I ran the 32-step verifier on captureHash X and got passed=true, class=CC2") is stored off-chain, Merkle-rooted, and the root is posted via `updateAttestations`.

For Tier 3 jobs: `attesterCount >= 3` required; `attestationsRoot` must be non-zero before escrow releases.

---

## 7. Anti-spoof surface map

Per class × attack matrix:

|  | CC0 | CC1 | CC2 | CC3 | CC4 | CC5 |
|---|---|---|---|---|---|---|
| **Point camera at screen** | Pass | Partial: parallax + moiré catches trivial screens; flagship 4K screen + perfect angle still passes | Same as CC1 | Same as CC1 (enclave signs what sensor sees) | Same (CAI moiré heuristic helps) | Same + network-level scene cross-check (DePIN dashcam sees road, not screen) |
| **Replay prior capture** | Pass | Blocked (nonce + block anchor) | Blocked | Blocked | Blocked (capture timestamp window) | Blocked (on-DePIN-chain uniqueness) |
| **Swap image mid-upload** | Hard to detect (hash mismatch detectable only if attacker can't re-hash) | Blocked (hash signed by session key) | Blocked | Blocked | Blocked | Blocked |
| **Rooted / jailbroken device** | Pass | Partial (WebAuthn biometric usually requires Secure Enclave) | Blocked (Play Integrity / App Attest fails) | Blocked (enclave not available on rooted) | N/A (dedicated hardware) | N/A |
| **Mock GPS / fake IMU** | Pass | Self-consistency check catches most | Blocked at platform integrity layer | Blocked | N/A (camera doesn't use GPS) or blocked (camera has its own GPS) | Blocked (network observes real positions) |
| **Stolen operator credentials** | Pass | Requires WebAuthn credential too | Requires device-bound attestation key | Requires enclave key | Requires registered camera | Requires linked DePIN account |
| **Forged C2PA manifest** | Pass (no manifest) | N/A | N/A | Trust-chain check catches | Same | Same + DePIN cross-check |
| **Firmware CVE / TEE exploit** | Pass | Out of scope | Apple/Google firmware attestation required | Out of scope if recent firmware | Same (camera firmware policy) | Same + consensus layer |
| **Collusion with verifier** | Pass | N/A | N/A | N/A | N/A | Blocked (need >50% of DePIN attesters) |

### 7.1 Known unfixables + user disclosure

**Point-camera-at-screen across all classes.** This is physically unsolvable with current hardware; no camera can tell it's not pointed at reality. PCC discloses this in operator onboarding: *"No capture class except CC5 provides scene-level authenticity. All classes below CC5 trust the device but cannot prove what the device is looking at."* The CVP focuses on *everything around the capture* (who, when, where, with what) to raise the attack cost past economic rationality for most jobs.

**Operator-controlled DePIN account.** Nothing in CC5 prevents the operator from being the sole attester *on a small DePIN network*. PCC requires `attesterCount >= 3` and whitelists only DePIN sources with >1000 independent node operators (Hivemapper, DIMO both qualify).

---

## 8. ALCOA+ mapping

How capture class affects each ALCOA+ principle:

| Principle | CC0 | CC1 | CC2 | CC3 | CC4 | CC5 |
|---|---|---|---|---|---|---|
| **A**ttributable | Weak (bearer token only) | Strong (sessionKey → principalKey → WebAuthn) | Strong + platform-bound | Strong + silicon-bound | Strong + camera-bound | Strong + network-bound |
| **L**egible | ✅ (hash-verifiable) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **C**ontemporaneous | Weak (EXIF self-reported) | Strong (block anchor) | Strong | Strong | Strong | Strong |
| **O**riginal | Weak | Strong | Strong + platform attest | Strong + enclave | Strong + hardware | Strong + network consensus |
| **A**ccurate | Self-attested | Multi-sensor consistency | Platform-integrity backed | Enclave-backed | Hardware-backed | Network-backed |
| **+C**onsistent | — | Cross-sensor check | — | — | — | Cross-chain consensus |
| **+C**omplete | — | All sensor streams bundled | — | — | — | DePIN multi-node |
| **+C**redible | Low | Medium | High | High | High | Highest |
| **+E**nduring | IPFS | IPFS + on-chain anchor | Same | Same | Same | Same + DePIN chain |
| **+A**vailable | Gateway | Same | Same | Same | Same | Gateway + DePIN mirrors |

`ComplianceFacade.alcoaStatus` computes these bits. With `captureClass` available, the principles `Attributable`, `Original`, `Accurate`, `Credible` get a stronger computed verdict.

---

## 9. User experience — opt-in flows

### 9.1 First-time operator

1. Operator signs in at `/operator/mobile`, gets bearer token.
2. Dashboard prompts: *"Configure your capture defaults — what authenticity level do you want to use?"*
3. Operator chooses a tier from a dropdown: CC0 (fast, unsigned), **CC1 (recommended, default)**, CC2 (native app required), CC3/CC4/CC5 (shown grayed out with "Upgrade path" link).
4. If CC1 chosen → prompt to register WebAuthn credential (Touch ID / Windows Hello / phone biometric). One-time.
5. Operator preference saved to `/api/operator/policy` with `defaultCaptureClass` field.

### 9.2 Per-job capture flow (CC1 example)

1. Operator taps "Capture Evidence" on a job detail page.
2. Client calls `POST /api/capture/challenge` → gets `CaptureNonceChallenge` with `visualNonce` (QR code).
3. UI shows: *"Point camera at your work. The QR in the bottom corner must be visible in your shot. Move slightly for parallax."*
4. UI fetches `getUserMedia(video)` + starts recording DeviceMotion + Geolocation.
5. Operator shoots; UI captures N frames (default 30 over 3s window).
6. UI builds `CaptureManifest`, asks WebAuthn to sign the `captureHash`.
7. UI calls `SessionKeyService.sign` (loaded from local IndexedDB encrypted with WebAuthn-derived key).
8. UI POSTs to `/api/capture/upload` with multipart: `{frame0.jpg, ..., frameN.jpg, manifest.json, webauthnAssertion.json, sessionSignature}`.
9. Gateway runs detector → verifier → anchor. Returns `{captureHash, finalClass, assuranceDelta, anchorTxHash}`.

### 9.3 Downgrade path UX

If detector lowers class from declared:
- UI shows yellow badge: *"Declared CC2, verified CC1. Your submission is accepted but flagged for slightly lower assurance credit (0.92× multiplier). To reach CC2, install the PCC native app."*
- Operator can accept or re-capture with different device.
- Captures are never silently rejected without a UI explanation.

### 9.4 Operator policy page (new route)

`apps/dashboard/src/pages/OperatorCapturePolicyPage.tsx`:
- Dropdown: `defaultCaptureClass` (CC0..CC5)
- List of registered capture devices (cameras, platform-attested devices, DePIN accounts).
- Toggle: *"Auto-reject captures below my default class"* (defaults OFF — accepts with downgrade).
- "Test capture" button — runs full capture flow with a test job ID.

---

## 10. Auto-detection — already in use?

This answers the user's second half: *"verify they are already using one or more of those things"*.

### 10.1 Upload-time sniffers (happens per capture)

Detector §4 already runs auto-detection. Key point: operator doesn't need to *declare* the class. They can submit and detector picks the ceiling.

### 10.2 Account-level detection (runs on operator registration + periodic)

New endpoint: `GET /api/capture/detected-capabilities` returns the classes the operator has ever successfully submitted + registered devices:

```json
{
  "registeredClasses": ["CC1"],
  "registeredDevices": [
    {"type": "webauthn", "credentialId": "...", "registeredAt": "..."}
  ],
  "registeredCameras": [],
  "connectedDepinAccounts": [],
  "detectedFromHistory": ["CC1"],
  "suggestedUpgrades": [
    {"class": "CC2", "action": "Install PCC native app (iOS or Android)", "docs": "https://docs.capability.network/capture/cc2"},
    {"class": "CC3", "action": "Use Truepic Lens SDK or Numbers Capture app", "docs": "..."},
    {"class": "CC4", "action": "Connect your Leica M11-P, Sony A1, or Nikon Z9", "docs": "..."},
    {"class": "CC5", "action": "Link your Hivemapper, DIMO, or IoTeX account", "docs": "..."}
  ]
}
```

### 10.3 Kernel heartbeat self-report

Kernels already heartbeat. Extend heartbeat body with `captureCapabilities: CaptureClass[]`. Kernel operators explicitly list what their shop can produce (e.g., `["CC1", "CC4"]` for a shop with a WebAuthn-enabled laptop + a Leica). Capability-discovery UIs highlight which capture classes each kernel provides.

### 10.4 Passive device probing

On first login to `/operator/mobile`, the client runs:
- `navigator.credentials.get({...})` with `transports: ["internal"]` → detects platform authenticator availability (signals WebAuthn → CC1 ready).
- Feature probe for `DeviceMotion` permission and `PermissionsAPI.query({name: "geolocation"})` → signals multi-sensor capability.
- User-agent sniff for known PCC native clients → signals CC2.
- (Future) Deep link to Truepic/Numbers app probing → signals CC3.

Client POSTs findings to `/api/capture/probe-result` — server suggests upgrade path in UI.

---

## 11. PCC integration points (exhaustive file list)

This is the "list of every single thing" in implementation form. Any file not in this list is NOT touched by this work.

### 11.1 New files (authoritative list)

**Package: `@pcc/spec`**
- `packages/spec/src/types/capture.ts` — CaptureClass, CaptureManifest, CaptureNonceChallenge, DetectionResult, CAPTURE_CLASS_MULTIPLIERS
- `packages/spec/src/types/capture.test.ts`

**Package: `@pcc/verifier`**
- `packages/verifier/src/capture/detector.ts`
- `packages/verifier/src/capture/detector.test.ts`
- `packages/verifier/src/capture/verifier.ts`
- `packages/verifier/src/capture/verifier.test.ts`
- `packages/verifier/src/capture/liveness.ts`
- `packages/verifier/src/capture/liveness.test.ts`
- `packages/verifier/src/capture/adapters/platform.ts` (abstract)
- `packages/verifier/src/capture/adapters/apple-attestation.ts`
- `packages/verifier/src/capture/adapters/google-integrity.ts`
- `packages/verifier/src/capture/adapters/c2pa-base.ts`
- `packages/verifier/src/capture/adapters/truepic.ts`
- `packages/verifier/src/capture/adapters/numbers.ts`
- `packages/verifier/src/capture/adapters/starling.ts`
- `packages/verifier/src/capture/adapters/c2pa-hardware.ts`
- `packages/verifier/src/capture/adapters/leica.ts`
- `packages/verifier/src/capture/adapters/sony.ts`
- `packages/verifier/src/capture/adapters/nikon.ts`
- `packages/verifier/src/capture/adapters/canon.ts`
- `packages/verifier/src/capture/adapters/snapdragon-trusted-camera.ts`
- `packages/verifier/src/capture/adapters/depin/base.ts`
- `packages/verifier/src/capture/adapters/depin/hivemapper.ts`
- `packages/verifier/src/capture/adapters/depin/dimo.ts`
- `packages/verifier/src/capture/adapters/depin/iotex.ts`
- `packages/verifier/src/capture/adapters/depin/dephy.ts` (stub)
- `packages/verifier/src/capture/index.ts` — public exports
- `packages/verifier/trust-anchors/camera-roots.json`
- `packages/verifier/trust-anchors/capture-roots.json`

**Package: `@pcc/gateway`**
- `packages/gateway/src/routes/capture.ts`
- `packages/gateway/src/routes/capture.test.ts`
- `packages/gateway/src/services/capture-store.ts` (in-memory map, IPFS pin client)
- `packages/gateway/src/services/capture-oracle.ts` (on-chain anchor caller)

**Package: `@pcc/contracts`**
- `packages/contracts/src/CaptureClassRegistry.sol`
- `packages/contracts/test/CaptureClassRegistry.t.sol`
- `packages/contracts/script/DeployCaptureClassRegistry.s.sol`

**App: `apps/dashboard`**
- `apps/dashboard/src/components/capture/CaptureFlow.tsx`
- `apps/dashboard/src/components/capture/VisualNonceRenderer.tsx`
- `apps/dashboard/src/components/capture/CaptureStatusBadge.tsx`
- `apps/dashboard/src/hooks/useWebAuthn.ts`
- `apps/dashboard/src/hooks/useSensorFusion.ts`
- `apps/dashboard/src/hooks/useCaptureChallenge.ts`
- `apps/dashboard/src/pages/OperatorCapturePolicyPage.tsx`

### 11.2 Modified files

- `packages/spec/src/identity/ephemeral.ts` — `SessionAction += "capture_submit"`
- `packages/spec/src/types/evidence.ts` — 7 new `EvidenceEventType` values
- `packages/verifier/src/workflow/challenge-service.ts` — add `issueCaptureNonce` + `verifyCaptureNonce`
- `packages/verifier/src/workflow/challenge-service.test.ts` — new test cases
- `packages/verifier/src/workflow/assurance-score.ts` — `captureClass` input + multiplier
- `packages/verifier/src/workflow/assurance-score.test.ts` — new test cases
- `packages/gateway/src/routes/photo-verification.ts` — accept `captureClass`, default CC0, forward CC1+ to new capture routes
- `packages/gateway/src/app.ts` — register capture route
- `packages/gateway/src/routes/operator.ts` — add `captureCapabilities` to operator policy CRUD
- `packages/gateway/src/routes/kernels.ts` — accept `captureCapabilities` in heartbeat body
- `packages/spec/src/kernel/heartbeat.ts` — `captureCapabilities` field
- `apps/dashboard/src/pages/SystemDashboardPage.tsx` — add capture-class column to job list

### 11.3 Dependencies to vet (/vet required)

- `c2pa-node` (C2PA manifest parsing) — **Gate A required before install**
- `@simplewebauthn/server` (WebAuthn backend) — **Gate A required**
- `@simplewebauthn/browser` (WebAuthn client) — **Gate A required**
- `appattest-checker-node` (Apple App Attest) — **Gate A required**
- (If Play Integrity: `googleapis` if not already installed, or minimal JWT verifier)

### 11.4 Untouched / explicitly out-of-scope (document-only)

- `MilestoneEscrow.sol` — no changes. Capture registry is separate; escrow consumes assurance score.
- `VerifierRegistry.sol` — no changes. Used by the N-of-M flow as-is.
- `PhotoCaptureService` in existing `photo-verification.ts` — stays; its anti-spoof becomes the CC0 liveness heuristic.
- All existing evidence types unrelated to camera captures — no change.
- Existing digital-verifier primitives — extended, not replaced.

---

## 12. Failure modes + rollback

| Failure | Behavior | Rollback / mitigation |
|---|---|---|
| Detector throws (bad C2PA blob) | Fall back to CC0, emit `capture_detection_failed` finding (warning) | No rollback — accepted at CC0 |
| Verifier critical finding | Capture REJECTED at `/api/capture/upload` (HTTP 422); no anchor written | Operator re-captures with correct manifest |
| `CaptureClassRegistry.anchor()` reverts (replay or bad signer) | Gateway returns 409; capture not persisted; operator sees retry prompt | Capture is bytes-only stored in IPFS with `status=orphaned` for 24h manual review |
| N-of-M consensus never reaches quorum | After `max_attesters_wait=3600s`, anchor proceeds without attestationsRoot; Tier 3 jobs blocked on payout | Operator can dispute; `CaptureDisputed` event fires |
| Platform attestation server (Apple/Google) down | Verifier returns UNTESTABLE finding; upload accepted at CC1 (degrade) | No rollback |
| DePIN chain RPC down | UNTESTABLE for CC5 claim; operator sees "DePIN source unreachable; retry later" | Retry in 10 min |
| Operator's `principalKey` revoked mid-capture | All sessionKeys issued after revocation are rejected; capture fails G1 | Operator re-registers |
| WebAuthn credential lost | Operator registers new credential via `/api/capture/webauthn/register-replacement`; old captures still valid | — |
| `c2pa-node` fails Gate A (Trivy critical) | **Wave 3 blocked.** Fall back to manual manifest parse (we control the full JSON structure for CC1/CC2; CC3/CC4 deferred) | Document in `ai/research/landscape-pcc-alerts.md` style |

---

## 13. Rollout plan (wave-by-wave)

**Wave 1 — Foundation (1 agent, ~800 LOC):**
- `packages/spec/src/types/capture.ts` (all types)
- `packages/spec/src/identity/ephemeral.ts` — SessionAction extension
- `packages/spec/src/types/evidence.ts` — 7 new event types
- `packages/verifier/src/workflow/challenge-service.ts` — nonce methods
- `packages/verifier/src/workflow/assurance-score.ts` — captureClass input
- All associated tests
- **Ships `@pcc/spec` + `@pcc/verifier` types/primitives alone. No routes yet.**

**Wave 2 — Detection + Verifier + UI (3 parallel agents):**
- Agent 2a: `packages/verifier/src/capture/detector.ts` + `verifier.ts` + `liveness.ts` + tests
- Agent 2b: `apps/dashboard/src/components/capture/*` + `hooks/use*` + `pages/OperatorCapturePolicyPage.tsx`
- Agent 2c: `packages/verifier/src/capture/adapters/c2pa-base.ts` + `platform.ts` base (stubs for concrete adapters)
- **Integration gate:** detector detects CC1 from a test manifest end-to-end locally (no gateway).

**Wave 3 — Adapters + On-Chain (3 parallel agents):**
- Agent 3a: `adapters/truepic.ts + numbers.ts + starling.ts` (CC3); trust anchors JSON
- Agent 3b: `adapters/leica.ts + sony.ts + nikon.ts + canon.ts + snapdragon-trusted-camera.ts` (CC4)
- Agent 3c: `CaptureClassRegistry.sol` + Foundry tests + deploy script + `adapters/depin/*` (CC5 stubs)
- **Integration gate:** contract deployed to Base Sepolia + each adapter returns expected shape on test fixture.

**Wave 4 — Gateway routes (1 agent, ~600 LOC):**
- `packages/gateway/src/routes/capture.ts` — all `/api/capture/*` endpoints
- `packages/gateway/src/services/capture-oracle.ts` — on-chain anchor caller (viem)
- `packages/gateway/src/services/capture-store.ts` — IPFS pin + in-memory index
- `packages/gateway/src/routes/operator.ts` — policy extension
- `packages/gateway/src/routes/kernels.ts` — heartbeat extension
- Route tests with mocked chain
- **Integration gate:** full CC1 roundtrip via curl against local gateway → anchor on Base Sepolia.

**Wave 5 — Smoke + tests + ALCOA+ (1 agent):**
- End-to-end smoke script `scripts/capture-e2e-smoke.ts` (CC0, CC1, CC1-downgrade, CC1-replay-blocked paths)
- `ComplianceFacade.alcoaStatus` integration (captureClass contribution)
- Dashboard job-list column
- Bugfix pass on any integration-gate findings

**Post-wave — /vet + checkpoint + push:**
- `/vet` each new dep (must PASS before commit): `c2pa-node`, `@simplewebauthn/*`, `appattest-checker-node`.
- Full pnpm -r build + test on Spark.
- Checkpoint: `WORKING_MEMORY.md` + `DECISIONS.md` updated.
- Push `capture-verification-protocol` branch to `lamasu` remote.
- Open PR against `master` with this doc as the top of the PR description.

---

## 14. Open questions / followups

Deferred from this build, parked for future consideration:

1. **Native iOS/Android apps** (CC2 user-facing). Not in this build; CVP server side is ready for them.
2. **Live-video captures** (not just still frames). CVP design supports them via frame-count field; UI wave handles still-frames only.
3. **ZK-SNARK over C2PA manifest.** Could prove class without revealing which camera serial was used. Out of scope for this wave; the on-chain registry already hashes `cameraSerialHash`.
4. **Retroactive upgrade of existing uploads.** Backfill the ~1000 existing Photos stored in `photoStore` with CC0 anchors? Probably yes as a separate script, but not in this wave.
5. **Integrating with existing `ProofRegistry.cairo`** (Starknet). CaptureClassRegistry lives on Base Sepolia, parallel to existing ProofRegistry. Future: bridge.
6. **DePIN provider onboarding.** Hivemapper/DIMO require API-key pairs; operator OAuth flow is stub-only in wave 3.
7. **Audit trail export.** Regulators may ask for per-capture evidence with full chain-of-custody. Build a `GET /api/capture/:id/audit-trail` that assembles manifest + attestations + anchor tx + IPFS CIDs into a single regulator-friendly bundle. Deferred to wave 6.
8. **Upgrading `photo-verification.ts`'s `PhotoCaptureService` to CC0 canonical.** Keep existing behavior, add class tagging. Wave 4 handles.
9. **Quantum-resistance.** Ed25519 is not PQ-safe. Out of scope until the larger PCC identity migration.

---

## 15. TL;DR

- Six orthogonal capture classes (CC0–CC5), from "trust me bro bearer token" to "this is multi-attested on DePIN already."
- Each class declared by operator, **auto-verified** by detector against the submitted evidence, and auto-downgraded if the declaration is higher than evidence supports.
- New `CaptureClassRegistry.sol` anchors every accepted capture on Base Sepolia.
- Capture class feeds `computeAssuranceScore` via multiplicative multiplier (CC0=0.70 → CC5=1.00 with consensus bonus uncapped).
- Orthogonal to existing tier 0–3; CC0 is rejected at Tier 2+, all other classes allowed at all tiers.
- Operator opt-in via `/api/operator/policy` default; per-capture override.
- Auto-detection on upload (manifest/attestation/token/signature passes).
- Integrates cleanly with digital-verifier primitives (`SessionKey`, `WorkflowChallenge`, `AssuranceScore`, ALCOA+).
- 5 waves of implementation, ~40 new files, ~15 modified files, 3 new contracts, 3 new npm deps to `/vet`.
- Everything above is a hard spec; no hand-waving, no "TBD", no silent rejects.

*End of master design doc.*
