# Capture Verification — Landscape Report

**Agent**: scout-alpha (wheel-scout)
**Generated**: 2026-04-22
**Topic**: Capture authenticity — C2PA, secure-enclave SDKs, WebAuthn, platform attestation, multi-sensor fusion, DePIN, liveness/anti-spoof, known exploits
**Task**: Capture Verification Protocol for PCC (CC0-CC5 classes)
**Solutions evaluated**: 27 across 8 topics
**Verdict distribution**: 3 ADOPT / 5 EXTEND / 3 BUILD / 16 REFERENCE

---

## Constitutional Scan

No `constitution.md` found at repo root — no hard license/dep principles to block against. PCC CLAUDE.md requires `/vet` pass on any new npm dep (Gate A: 0 critical, ≤2 high, ≤10 medium, 0 secrets, no malware). All ADOPT/EXTEND candidates below are pre-queued for /vet before install.

---

## Topic 1 — C2PA (Coalition for Content Provenance and Authenticity)

### `@contentauth/c2pa-node` v0.5.4
- **License**: MIT
- **Maintained**: Yes — actively maintained by Adobe/Content Authenticity Initiative
- **Solves**: Server-side C2PA manifest parsing, verification, trust-chain validation
- **Verdict**: **ADOPT** (CC2 gateway-side verifier)
- **Gate A queue**: YES — /vet before install
- **Role in PCC**: `packages/verifier/src/capture/c2pa-verifier.ts` parses submitted photo manifests, verifies signing cert chains, extracts claim generator info. Input to verification gates G2 (signature valid) + G3 (trust chain valid).

### `@contentauth/c2pa-web` v0.7.1
- **License**: MIT
- **Maintained**: Yes
- **Solves**: Client-side C2PA manifest parsing and display in browser
- **Verdict**: **ADOPT** (CC1 browser-side hint detection)
- **Role in PCC**: PWA capture flow displays manifest details before submission ("This photo has a C2PA claim by iPhone 17 Pro"). Not authoritative — verifier side of house does actual validation.

### Truepic Lens SDK (iOS/Android)
- **License**: Proprietary, EULA requires MSA (Master Services Agreement)
- **Redistribution**: NOT PERMITTED without commercial license
- **Verdict**: **REFERENCE only — CANNOT redistribute**
- **Notes**: Can document "Truepic-compatible capture" path for operators who independently license Truepic. PCC itself can parse the C2PA output via `@contentauth/c2pa-node`, but cannot ship Truepic SDK.

### Numbers Protocol (Capture SDK + Numbers Mainnet)
- **License**: Mixed — SDK Apache-2.0, chain-specific infra varies
- **Verdict**: **REFERENCE** — architectural pattern only
- **Notes**: Numbers Mainnet has its own chain; cross-chain bridging to Base would add complexity. Use C2PA output from Numbers SDK via standard adapter.

### Nikon Z6 III C2PA (Jan 2025 vulnerability)
- **Status**: **CRITICAL — documented exploit**
- **Verdict**: **REFERENCE** — informs anti-spoof design
- **Exploit**: Signed C2PA manifests on fake photos via camera firmware modification. Confirms: C2PA signature alone does NOT prove capture authenticity. **The "pre-prepared scene" attack remains unfixable by C2PA in 2026.** DePIN multi-sensor cross-check (CC5) or secure-enclave camera (CC3/CC4) required to mitigate.

---

## Topic 2 — Secure-Enclave SDKs

### Apple Secure Enclave (iOS/macOS)
- **License**: Apple SDK terms
- **Access**: iOS 17+ via `AttestationService`, `DeviceCheck`, App Attest
- **Verdict**: **BUILD** — no redistributable npm wrapper for browser/PWA context; must build custom integration via WebAuthn + App Attest relay
- **PCC path**: CC3 requires native iOS helper app. PWA fallback is CC1 with WebAuthn + platform attestation hint.

### Android Keystore + Play Integrity
- **License**: Apache-2.0 (Play Integrity API is Google-terms)
- **Verdict**: **EXTEND** via `@n3arby/play-integrity-verifier`
- **See Topic 4 below**

### Trusted Execution Environment (TEE) SDKs (Intel SGX, ARM TrustZone)
- **License**: Varies (Intel SGX SDK BSD-style, OP-TEE BSD-2)
- **Verdict**: **REFERENCE** — not applicable to smartphone capture flow. Relevant for kernel-side (CC4 trusted camera station) but out of scope for user-device capture.

### `appattest-checker-node`
- **License**: Apache-2.0
- **Maintained**: **STALE** — last commit Oct 2024 (~18 months old as of April 2026)
- **Solves**: Server-side verification of Apple App Attest assertions
- **Verdict**: **EXTEND** — fork, audit, add missing 2025/2026 receipt formats
- **Gate A queue**: YES — audit for CVEs given staleness
- **PCC path**: CC2 iOS verification, replaces DIY receipt parser

---

## Topic 3 — WebAuthn / Passkeys

### `@simplewebauthn/server` v13.3.0
- **License**: MIT
- **Maintained**: Yes — highly active
- **Solves**: Registration + authentication ceremony server for WebAuthn/passkeys
- **Verdict**: **ADOPT** (CC1 resident credential + nonce-signing ceremony)
- **Gate A queue**: YES — /vet before install
- **PCC path**: `packages/verifier/src/capture/webauthn-verifier.ts` validates client assertions, parses attestation statements (Apple anonymous / Google SafetyNet / FIDO U2F), enforces user-verification flag. Backs G2 (signature valid) + G4 (user presence verified).

### `@simplewebauthn/browser` v13.3.0 (client companion)
- **License**: MIT
- **Verdict**: **ADOPT** (CC1 PWA capture flow)
- **PCC path**: Triggers `navigator.credentials.get()` with captureNonce challenge. Tied to resident credential created at operator onboarding.

### Native WebAuthn (no library)
- **Verdict**: **BUILD** possible but adds ~500 lines of ASN.1 + COSE parsing — use @simplewebauthn instead. BUILD only if library fails /vet.

---

## Topic 4 — Platform Attestation

### `@n3arby/play-integrity-verifier`
- **License**: UNCONFIRMED — needs manual check
- **Maintained**: Unknown
- **Solves**: Server-side Play Integrity token verification (Android)
- **Verdict**: **EXTEND** — pending license confirmation; if MIT/Apache, extend for our nonce-wrapping flow
- **Gate A queue**: YES — /vet + license audit before install
- **PCC path**: CC2 Android verification. Decodes integrity verdict (device, app, account), checks `requestHash` matches our issued nonce.

### Apple DeviceCheck / App Attest
- **License**: Apple-only
- **Verdict**: **BUILD** custom integration (see Topic 2)

### `tee-attestation-verifier` (Intel-specific)
- **License**: BSD-style
- **Verdict**: **REFERENCE** — kernel-side (CC4) not user-side

### Firebase App Check
- **License**: Google-terms
- **Verdict**: **REFERENCE** — adds Google dep; we'd prefer direct Play Integrity verification

---

## Topic 5 — Multi-Sensor Fusion & Liveness

### MediaPipe Face Landmarker (Google)
- **License**: Apache-2.0
- **Maintained**: Yes
- **Solves**: On-device face-landmark tracking, head-pose, liveness signals
- **Verdict**: **EXTEND** (CC1 browser liveness check)
- **Gate A queue**: YES — check bundle size, telemetry phone-home
- **PCC path**: PWA capture flow uses MediaPipe to detect subtle head parallax during multi-frame capture. Feeds into SensorFusionTrace → G5 (liveness OK).

### Native `DeviceMotionEvent` / `DeviceOrientationEvent`
- **License**: Browser standard, no dep
- **Verdict**: **EXTEND** via wrapper — emit a SensorFusionTrace with accel/gyro timeline during capture window
- **PCC path**: PWA records 2-5 seconds of motion data at capture time, signed over by WebAuthn, verifier checks coherence with photo EXIF timestamp and visual parallax cues.

### DoubangoTelecom FaceLivenessDetection-SDK
- **License**: **NON-COMMERCIAL ONLY** — hard conflict for PCC commercial use
- **Verdict**: **REFERENCE / EXCLUDED** — document as rejected

### `@tensorflow-models/face-landmarks-detection`
- **License**: Apache-2.0
- **Verdict**: **REFERENCE** — alternative to MediaPipe but larger bundle

### BioID / FaceTec / iProov (commercial liveness)
- **License**: Commercial, paid
- **Verdict**: **REFERENCE** — document as "bring your own" for operators who need certified liveness (banking/medical)

---

## Topic 6 — DePIN Capture Hardware

### IoTeX W3bstream
- **License**: Apache-2.0
- **Maintained**: Yes
- **Solves**: DePIN data ingestion + on-chain proof framework
- **Verdict**: **EXTEND** — architectural reference for our CC5 flow; IoTeX-specific chain bridging not adopted
- **PCC path**: Model CC5 DePIN adapter interface after W3bstream publish pattern, but anchor to Base Sepolia directly.

### DePHY Network
- **License**: **AGPL-3.0** — hard conflict for PCC monorepo (MIT-compatible only)
- **Verdict**: **REFERENCE / EXCLUDED** — document as rejected

### Hivemapper SDK
- **License**: Proprietary
- **Verdict**: **REFERENCE** — dashcam capture model; inspiration for CC5 hardware registration

### Particle IoT
- **License**: Commercial SaaS
- **Verdict**: **REFERENCE**

### Witness Camera (Guardian Project, open source)
- **License**: GPLv3 — conflicts with MIT monorepo if linked; OK if run as external service
- **Verdict**: **REFERENCE** — mobile capture app reference, cannot vendor

---

## Topic 7 — Visual-Nonce / Anti-Replay (Screen Detection)

### No mature open-source library found
- Screen-capture detection (is this a photo of a monitor?) is an active research area.
- Commercial products exist (FaceTec screen-presentation-attack detection) but closed-source.
- Academic: moire-pattern detection, IR-filter analysis, specular highlight analysis.
- **Verdict**: **BUILD** — custom multi-modal detector combining:
  - Moire pattern FFT (browser-side canvas analysis)
  - Reflection specularity check (MediaPipe face + ambient light sensor)
  - Visual nonce: server-issued 4-digit PIN shown in operator's environment (a sign, a receipt, etc.) during capture — proves co-presence of display device
- **Gate A queue**: N/A (pure build)

---

## Topic 8 — Known Attacks & Anti-Spoof Research (2025-2026)

### Pre-prepared scene attack (fundamental limitation)
- **Status**: **Unfixable by C2PA, WebAuthn, or platform attestation alone in 2026**
- **Mitigation path**: Only CC4 (trusted camera hardware at operator kernel) or CC5 (DePIN cross-sensor corroboration across 2+ independent devices) defeats this.
- **Design implication**: CC1-CC3 scores plateau at 0.92-1.00 multiplier but CANNOT unlock AssuranceTier 3 alone — evidence must also pass independent workflow-step verification for Tier 3.

### Nikon Z6 III C2PA signing bypass (Jan 2025)
- **Exploit**: Firmware modification signs arbitrary content with factory cert
- **Mitigation**: Vendor cert revocation lag makes this practically unresolved; treat CC2 C2PA-only evidence as CC1-equivalent for Tier 2+ workflows pending vendor fix

### WebAuthn relay attacks (CVE-2024-xxxxx research)
- **Mitigation**: Include block-anchored challenge (SHA256(challengeId + blockHash + workOutputRoot)) — already in our ChallengeService design

### Play Integrity "rooted device with hidden root" bypass
- **Mitigation**: Require MEETS_STRONG_INTEGRITY verdict (not just MEETS_DEVICE_INTEGRITY) for CC2 on Android

### Apple App Attest replay within same DeviceID
- **Mitigation**: Bind attestation to per-capture nonce + TTL ≤120s — already in our CaptureNonceChallengePayload design

---

## Recommendation Summary

### ADOPT (3)
| Package | Version | License | Gate A Required |
|---------|---------|---------|----------------|
| `@contentauth/c2pa-node` | 0.5.4 | MIT | YES |
| `@contentauth/c2pa-web` | 0.7.1 | MIT | YES |
| `@simplewebauthn/server` + `@simplewebauthn/browser` | 13.3.0 | MIT | YES |

### EXTEND (5)
| Package | License | Notes |
|---------|---------|-------|
| `appattest-checker-node` | Apache-2.0 | Stale Oct 2024 — fork + audit |
| `@n3arby/play-integrity-verifier` | UNCONFIRMED | License audit required |
| MediaPipe Face Landmarker | Apache-2.0 | Bundle-size + telemetry check |
| IoTeX W3bstream (architectural) | Apache-2.0 | Pattern only, not vendored |
| Native `DeviceMotionEvent` wrapper | N/A | Thin wrapper for SensorFusionTrace |

### BUILD (3)
- **CC3 capture SDK integration** — no redistributable TEE SDK; custom iOS/Android helper apps
- **CC5 DePIN adapter** — no Base-chain end-to-end SDK; build custom adapter interface
- **Multi-modal screen-detection / visual-nonce** — no open-source option; custom canvas-FFT + MediaPipe + server-issued PIN

### EXCLUDED (hard license / policy conflicts)
- **DePHY Network** (AGPL-3.0)
- **DoubangoTelecom FaceLivenessDetection-SDK** (non-commercial)
- **Truepic Lens SDK** (EULA, no redistribution)
- **Witness Camera (Guardian)** (GPLv3 — cannot vendor)

---

## /vet Queue (BEFORE install)

1. `@contentauth/c2pa-node@0.5.4`
2. `@contentauth/c2pa-web@0.7.1`
3. `@simplewebauthn/server@13.3.0` + `@simplewebauthn/browser@13.3.0`
4. `appattest-checker-node` (fork, audit for staleness CVEs)
5. `@n3arby/play-integrity-verifier` (license confirm + /vet)
6. `@mediapipe/tasks-vision` (MediaPipe Face Landmarker bundle)

Run `/vet <package-path>` after `pnpm install` but before importing in any package.

---

## Cross-References to Design Doc

- §3 Capture Classes CC0-CC5 → ADOPT/EXTEND mapping:
  - CC0: no deps
  - CC1: `@simplewebauthn/*`, MediaPipe, DeviceMotionEvent wrapper
  - CC2: `@contentauth/c2pa-node`, `appattest-checker-node` (fork), `@n3arby/play-integrity-verifier`
  - CC3: BUILD iOS/Android helper apps
  - CC4: kernel-side trusted-camera spec (out of scope for Wave 1-4)
  - CC5: BUILD DePIN adapter interface + W3bstream-style architecture
- §7 Verification Gates G1-G6 → direct mapping (G2 uses c2pa-node + simplewebauthn, G4 uses WebAuthn user-verification flag, G5 uses MediaPipe + DeviceMotion)
- §11.1-11.2 exhaustive file list → UI/verifier/adapter packages enumerated

---

## Evidence Basis

- 15 WebSearch queries across C2PA libraries, TEE SDKs, WebAuthn servers, Play Integrity verifiers, MediaPipe liveness, DePIN capture frameworks, Nikon C2PA exploit, pre-prepared scene attack
- 15 WebFetch calls confirming license (SPDX), last-commit dates, open issue counts, npm install stats for top candidates
- Cross-referenced against PCC digital-verifier primitives on master (touchstone, ChallengeService, AssuranceScore) — no overlap with existing code

**Wheel-scout gate verdict**: PASS — 27 existing solutions evaluated, 3 adopted, 5 extended, 3 must-build identified. Build is justified only where no maintainable, correctly-licensed alternative exists.
