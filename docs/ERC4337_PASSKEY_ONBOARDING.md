# ERC-4337 Passkey Onboarding — Trust Model, Browser Matrix, A→B Migration

**Status**: Phase D docs (Option B). Phase A (real WebAuthn verify + DB
sessions + persist) merged in PR #198; Phase C (frontend widget) merged in
PR #199. Phase B (ERC-4337 smart-wallet mint) is the remaining code piece,
blocked on paymaster funding + owner SDK sign-off.

Companion: `ai/research/option-b-smart-wallet-passkey-plan.md` (the full
build plan). Coord bulletins 235 / 254 / 262 / 270.

---

## 1. What "Option B" buys, in one paragraph

Today (Option A, live behind flags) an operator's ERC-8004 identity NFT is
owned by the **gateway**, and the `agentWallet` field points at a per-operator
EOA whose key the **gateway custodies at bootstrap**. The operator never
touches a key — but they don't truly *own* the identity either; they trust the
gateway not to move it. Option B replaces that per-operator EOA with an
**ERC-4337 smart contract wallet controlled by the operator's device passkey**
(Touch ID / Windows Hello / Android biometric). The NFT is owned by the smart
wallet from mint; only the operator's passkey can authorize it. Still zero
key-management from the operator's side — the private key never exists in a
form they could lose — but ownership is real, not soft-promised.

---

## 2. Trust model

### 2.1 The three custody states

| State | NFT owner | agentWallet controlled by | Operator key exposure |
|-------|-----------|---------------------------|-----------------------|
| **A (custodial)** — live | gateway | gateway (bootstrap) → operator EOA (claimable) | gateway holds the EOA key until the operator exports it |
| **A′ (self-EOA)** — post-export | gateway | operator's own EOA | operator holds the EOA private key |
| **B (smart wallet)** — target | operator's smart wallet | operator's passkey (via the SW) | none — the passkey never leaves the device secure enclave |

State B is strictly stronger: the NFT owner *is* the operator (their smart
wallet), and authorization requires a hardware-backed biometric that cannot
be exfiltrated, phished into a text box, or lost like a seed phrase.

### 2.2 What the gateway can and cannot do under B

- **Can**: sponsor gas (via the paymaster), relay userOps to the bundler,
  read the operator's on-chain identity. The gateway is infrastructure.
- **Cannot**: move the NFT, sign as the operator, or recover the wallet
  without the passkey. The gateway holds *no* key that authorizes the smart
  wallet. If the gateway is fully compromised, an attacker still cannot act
  as the operator on-chain.

### 2.3 Threats and mitigations

| Threat | Vector | Mitigation |
|--------|--------|------------|
| **Credential-binding hijack** | An unauthenticated caller binds *their* passkey to *another* operator's row | **Closed in Phase A** (PR #198 vet High-1 fix): `register-challenge` requires a Bearer API key matching the claimed `operatorId`; 401 without, 403 on mismatch. Anonymous challenges never persist. |
| **rpId / origin spoofing** | Caller stuffs a foreign domain into the stored session to make the browser accept a cross-domain credential | **Closed in Phase A**: server-side allowlist on `rpId` + `expectedOrigin` (`capability.network` / `localhost` + env-extensible). WebAuthn's browser-side registrable-domain check is the second layer. |
| **Attestation replay** | Re-submit a captured attestation for a fresh challenge | Challenges are one-shot (deleted on verify) with a 60s TTL, stored in the `passkey_sessions` table. A replayed `sessionId` returns 404. |
| **Paymaster drain** | Attacker spams sponsored userOps to burn the gas budget | ZeroDev/Pimlico **gas policies** cap per-day / per-wallet spend; the endpoint is behind the per-IP rate limit (30/hour) + `PCC_PASSKEY_ENABLED` flag; a canary + balance alert (Phase D telemetry, below) pages on low balance. |
| **Session hijack of the challenge** | MITM steals the `sessionId` between challenge and verify | The challenge alone is useless without a valid authenticator response for it, and the operator-binding path additionally requires the Bearer key. TLS is assumed (prod is HTTPS-only). |
| **Bundler / paymaster outage** | The AA vendor is down mid-onboarding | Feature-detect + graceful fallback to Option A (gateway-custody EOA) so onboarding never hard-fails on vendor availability. `503 paymaster_unfunded` is surfaced, not swallowed. |
| **Lost device** | Operator's only passkey device is lost/wiped | Passkeys sync via the platform keychain (Apple iCloud Keychain / Google Password Manager) so the credential survives device loss on synced platforms. Physical security keys and non-synced platforms need a documented recovery path (a second registered passkey) — see §5. |

### 2.4 Non-goals / assumptions

- HTTPS in production (prod is HTTPS-only; the origin allowlist assumes it).
- The gateway signer that *pays* for the mint (`PCC_GATEWAY_PRIVATE_KEY` /
  paymaster) is an infrastructure key, not an operator key — its compromise
  costs gas, not operator ownership.
- Recovery for non-synced authenticators is a documented operator
  responsibility (register a backup passkey), not an automatic gateway
  capability — the gateway deliberately has no override.

---

## 3. Browser / platform support matrix

Platform passkeys (`isUserVerifyingPlatformAuthenticatorAvailable`) are the
target. The Phase C widget feature-detects and falls back to Option A when a
platform authenticator isn't available.

| Platform | Support | Notes |
|----------|---------|-------|
| **macOS Safari 16+** | ✅ | Touch ID; synced via iCloud Keychain |
| **macOS Chrome/Edge 109+** | ✅ | Touch ID via the platform authenticator |
| **iOS/iPadOS 16+** | ✅ | Face ID / Touch ID; iCloud Keychain sync |
| **Windows 10/11 + Hello** | ✅ | Windows Hello (PIN/fingerprint/face); Chrome/Edge/Firefox |
| **Android 9+ (Chrome)** | ✅ | Fingerprint/face; Google Password Manager sync |
| **Firefox (desktop)** | ⚠️ partial | Platform authenticator support varies by OS + version; feature-detect, don't assume |
| **Linux desktop** | ⚠️ partial | Often no platform authenticator; may have a security key. Fallback to Option A likely. |
| **Older Safari (< 16) / iOS < 16** | ❌ | Fall back to Option A |
| **In-app webviews** (some) | ❌/⚠️ | WebAuthn is frequently disabled in embedded webviews; fall back to Option A |

**Rule the widget follows**: `available && platformAuthenticator` → offer
passkey; otherwise call `onUnsupported()` and the caller routes to Option A.
Never hard-block onboarding on passkey support.

---

## 4. Wire protocol (Phase A endpoints, live behind `PCC_PASSKEY_ENABLED`)

```
POST /api/onboard/passkey/register-challenge
  Auth: Bearer <api-key>   (REQUIRED only when binding an operatorId)
  Body: { operatorId?, rpId?, expectedOrigin? }
  201:  { sessionId, challenge, rpId, rpName, pubKeyCredParams,
          authenticatorSelection, ttl_ms, timeout_ms }
  401:  authentication_required_to_bind_operator   (operatorId w/o Bearer)
  403:  operator_mismatch                          (Bearer ≠ operatorId)
  429:  rate_limited                               (>30/hour per IP)
  503:  passkey_not_enabled                        (flag unset)

POST /api/onboard/passkey/verify-attestation
  Body: { sessionId, attestationResponse }         (browser PublicKeyCredential JSON)
  200:  { sessionId, credentialId, publicKey, rpId, persisted, verification:"verified" }
  400:  webauthn_verify_failed | webauthn_verify_rejected
  404:  session_not_found_or_expired
  410:  session_expired
```

Real cryptographic verification is done server-side by
`@simplewebauthn/server@13.3.0` (challenge / origin / rpID / signature /
attestation statement). Verified credentials persist to `api_keys.passkey_*`
when an `operatorId` was bound.

---

## 5. A → B migration path (when Phase B lands)

Existing Option-A operators upgrade without re-onboarding:

1. Operator authenticates (existing API key or session).
2. Browser passkey registration (the Phase C widget) → server verifies →
   the operator now has a passkey credential on their `api_keys` row.
3. Phase B derives the **counterfactual smart-wallet address** from the
   passkey credential and mints/deploys it (gateway sponsors gas via the
   paymaster).
4. Gateway calls `setAgentWallet(agentId, smartWallet, deadline, signature)`
   — the signature comes from the new smart wallet (passkey-authorized) —
   moving `agentWallet` from the Option-A EOA onto the smart wallet.
5. `operator_wallet_custody` flips `gateway` → `smart_wallet`. The old
   per-operator EOA can be zeroed or kept as a backup at the operator's
   choice.

Zero downtime, zero operator key exposure, no NFT re-mint. The `setAgentWallet`
helper already exists (shipped Option A, PR #190); Phase B adds the smart-wallet
derivation + userOp path around it.

**Backup passkey (recovery)**: operators on non-synced authenticators should
register a second passkey (a second device or a hardware key) so device loss
isn't account loss. The gateway has no override by design — recovery is a
second credential, not a support ticket.

---

## 6. Phase B prerequisites (owner actions — links)

Before Phase B can be built and shipped:

1. **AA SDK account + gas policy** — create a ZeroDev project (Base Sepolia),
   set a gas-sponsorship policy, grab the bundler + paymaster keys.
   Dashboard: https://dashboard.zerodev.app/ · Gas policies:
   https://docs.zerodev.app/meta-infra/gas-policies · Sponsoring gas:
   https://docs.zerodev.app/sdk/core-api/sponsor-gas
2. **Fund the gas source** — Base Sepolia testnet ETH for the paymaster /
   gateway signer. Coinbase CDP faucet (0.1 ETH / 24h):
   https://www.coinbase.com/developer-platform/products/faucet · Base's
   faucet list: https://docs.base.org/base-chain/network-information/network-faucets ·
   Alchemy: https://www.alchemy.com/faucets/base-sepolia
3. **RP domain lock-in** — `capability.network`. Passkeys are
   domain-bound; changing this later forces every operator to re-register.
4. **Owner sign-off** — SDK choice (ZeroDev recommended) + paymaster funding
   source + the RP domain above.

Alternatives to ZeroDev if preferred: Pimlico (https://dashboard.pimlico.io/),
Alchemy Account Kit (https://dashboard.alchemy.com/), Coinbase Smart Wallet.

---

## 7. Config reference (Phase A live; Phase B additions marked)

| Env var | Phase | Purpose |
|---------|-------|---------|
| `PCC_PASSKEY_ENABLED` | A | Opt-in flag; endpoints 503 when unset |
| `PCC_PASSKEY_RP_ID` | A | Default rpId (else derived from hostname) |
| `PCC_PASSKEY_EXPECTED_ORIGIN` | A | Default expected origin |
| `PCC_PASSKEY_RP_ID_ALLOWLIST` | A | CSV, extends the built-in rpId allowlist |
| `PCC_PASSKEY_ORIGIN_ALLOWLIST` | A | CSV, extends the built-in origin allowlist |
| `VITE_PCC_URL` | C | Dashboard → gateway base URL |
| `ZERODEV_PROJECT_ID` | B | AA project (bundler/paymaster) |
| `ZERODEV_PAYMASTER_URL` | B | Paymaster RPC |
| `ZERODEV_BUNDLER_URL` | B | Bundler RPC |

---

## 8. Observability (Phase D design; wire alongside Phase B)

- **Trace correlation**: mint a `trace_id` on both passkey endpoints + the
  Phase-B smart-wallet mint; thread it through to the userOp submission.
- **OTel spans**: `passkey.challenge`, `passkey.verify`, `smart_wallet.mint`,
  `bundler.submit`.
- **Error taxonomy**: `passkey_unsupported_browser`, `paymaster_unfunded`,
  `bundler_timeout`, `webauthn_verify_failed`, `attestation_replay`.
- **Alerts**: paymaster balance low; bundler outage.
- **Funnel metric**: challenge → verify → (Phase B) mint success rate.
- **Canary**: a synthetic agent that runs the full passkey → mint loop
  against staging on a timer (pairs with the existing onboarding canary).

These are design notes; implementation lands with Phase B when there's a mint
to instrument.
