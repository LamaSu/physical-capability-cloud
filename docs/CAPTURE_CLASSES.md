# Capture Classes (CC0 – CC5)

Quick reference for the six capture classes defined by the Capture Verification
Protocol. Each class describes a different level of *per-frame authenticity*
for operator-submitted visual/sensor evidence. The class multiplies into the
final assurance score; it is **orthogonal** to the existing `assuranceTier`
(0–3), which controls evidence *breadth*.

- **Authoritative design:** [`ai/research/capture-verification-protocol.md`](../ai/research/capture-verification-protocol.md)
- **Full operator guide:** [`docs/CAPTURE_VERIFICATION.md`](./CAPTURE_VERIFICATION.md)
- **Canonical types:** `packages/spec/src/types/capture.ts`
- **Multipliers in code:** `CAPTURE_CLASS_MULTIPLIERS` export from `@pcc/spec`

---

## Reference table

| Class | Multiplier | Hardware Example | Attestation Required | Detection Required | On-Chain Anchor |
|-------|-----------|------------------|----------------------|--------------------|-----------------|
| **CC0** | 0.70 | any device, operator self-attest | none | n/a | optional |
| **CC1** | 0.92 | any device, signed manifest | none | liveness (G4) | recommended |
| **CC2** | 0.96 | C2PA-capable camera | C2PA signature | liveness + EXIF | required |
| **CC3** | 1.00 | WebAuthn device | WebAuthn (packed) | liveness + consistency | required |
| **CC4** | 1.00 | iOS w/ AppAttest or Android w/ Play Integrity | Platform (G5) | G4 + G5 | required |
| **CC5** | 1.00 | DePIN camera + N-of-M verifier network | DePIN + consensus | G4 + G5 + G6 | required |

Multipliers are enforced in `packages/verifier/src/workflow/assurance-score.ts`
via `CAPTURE_CLASS_MULTIPLIERS[class]`. The final formula is:

```
final = clamp(0, 1, base * driftMultiplier * touchstoneMultiplier * captureClassMultiplier)
        + consensusBonus
```

CC3+ are "neutral" (1.00) because they already ship silicon-level provenance.
Lower classes take progressive penalties; CC0 takes the full 30 % haircut.

---

## Tier compatibility matrix

Class × assurance tier acceptance at upload time (from the design doc §2):

| | T0 Self | T1 Verified | T2 Certified | T3 Sovereign |
|---|---|---|---|---|
| **CC0** | allow | allow | **reject** | **reject** |
| **CC1** | allow | allow | allow | allow (warn badge) |
| **CC2** | allow | allow | allow | allow |
| **CC3** | allow | allow | allow | allow |
| **CC4** | allow | allow | allow | allow |
| **CC5** | allow | allow | allow | allow + consensus bonus |

`reject` happens inside `ComplianceFacade.checkTierCompliance` — CC0 evidence
cannot back a T2+ job, full stop. `warn` accepts the capture but the operator
sees a yellow badge and a soft penalty stacks on the multiplier.

---

## Which class should I pick?

Work through the decision tree top-to-bottom and stop at the first match.

**1. Is your capture coming off a DePIN-connected device** (Hivemapper dashcam,
DIMO-enrolled vehicle, IoTeX W3bstream, DePHY device ID)? The device is already
posting captures to a public chain with an N-of-M attester set.
→ **CC5.** Link your DePIN account via `/api/capture/depin-connect`, then
reference captures by `{depinSource, depinCaptureId}`.

**2. Are you shooting on a C2PA-compliant dedicated camera** — Leica M11-P,
Sony A1 / A7 IV / A9 III with CAI firmware, Nikon Z9 (firmware ≥ v3), Canon
R5 C with CAI firmware, Snapdragon 8 Gen 3 Trusted Camera phones? The sensor
signs bytes before userspace ever touches them.
→ **CC4.** Register the camera body with `/api/capture/camera-register`,
then upload JPEG/HEIC with the C2PA manifest preserved.

**3. Do you have access to a consumer phone running iOS or Android with a
platform-attested native app** (Apple App Attest / DeviceCheck, or Google
Play Integrity with `MEETS_STRONG_INTEGRITY`)? The OS vendor attests the
device is genuine, non-rooted, and running signed firmware.
→ **CC4** (yes, same class — platform-attested native capture and hardware
cameras both map to CC4 here). Install the PCC native app (ships separately),
register once via `/api/capture/platform-attest`, capture normally.

**4. Do you have a WebAuthn-capable browser** (Touch ID / Windows Hello / any
platform authenticator) plus a Truepic / Numbers Capture / Starling-Framework
app that signs bytes inside the Secure Enclave before release?
→ **CC3.** Register the enclave key once via `/api/capture/enclave-register`,
then upload the enclave-signed C2PA manifest.

**5. Do you have just a WebAuthn-capable browser** (no enclave app, no
native platform attestation, no dedicated camera) + `getUserMedia` + IMU /
geolocation permissions? This is the default PCC operator PWA flow.
→ **CC1.** Use `/operator/mobile` → "Capture Evidence" button. The flow
walks you through WebAuthn registration on first capture.

**6. Just a bearer token and raw bytes.** No WebAuthn, no platform attest,
no C2PA, no DePIN.
→ **CC0.** This is the legacy `/api/photo/upload` path. Acceptable for T0/T1
jobs only — `ComplianceFacade` rejects CC0 evidence on T2+.

---

## Quick reasoning cheats

- **"What's the cheapest class that still anchors on-chain?"** CC1. Browser
  + WebAuthn + multi-sensor + challenge nonce gives you full anchoring, no
  hardware investment beyond a modern laptop or phone.
- **"I want full score (no multiplier penalty) without buying a camera."**
  CC3 via Truepic Lens SDK or Numbers Capture app. Silicon-backed without a
  Leica.
- **"What's the minimum for a Tier 2 (Certified) job?"** CC1. Anything lower
  gets rejected by `ComplianceFacade.checkTierCompliance`.
- **"What's the minimum for a Tier 3 (Sovereign) job?"** CC2 (native
  platform attestation). CC1 will *accept* but carries a yellow warning badge
  and is not recommended for regulated workloads (medical, aerospace, pharma).
- **"Which class gets the consensus bonus?"** Only CC5 — and only when
  `attesterCount ≥ 5`. The bonus is `+0.05` on top of the final score.

---

## Related

- **Full operator guide** with API examples, UI embedding, gate reference, and
  troubleshooting: [`docs/CAPTURE_VERIFICATION.md`](./CAPTURE_VERIFICATION.md)
- **Anti-spoof attack matrix** (CC × attack vectors): see §7 of
  [`ai/research/capture-verification-protocol.md`](../ai/research/capture-verification-protocol.md)
- **ALCOA+ mapping per class:** see §8 of the same design doc, and the
  integration notes at [`ai/research/cvp-alcoa-integration.md`](../ai/research/cvp-alcoa-integration.md)
