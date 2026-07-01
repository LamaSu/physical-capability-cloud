# Option B — ERC-4337 Smart Wallet + Passkey Migration Plan

**Status**: Planned follow-up to PR #190. Timeline: ~10 focused workdays after
#190 merges + first-settlement E2E verified.

**Origin**: Coord bulletins 234 (A/B/C debate), 235 (strategic alignment), 239
(revenue routing landed for A).

## Purpose

Give operators **true on-chain ownership** of their ERC-8004 identity NFT from
mint, controlled by device passkey (Touch ID / Face ID / WebAuthn), with zero
key management on the operator's side. Replaces option A's gateway-custodied
EOA with a smart contract wallet that the operator alone can authorize.

Migration path from A → B is non-destructive: existing A-provisioned operators
call `setAgentWallet(agentId, newSmartWallet, deadline, sig)` from their new
smart wallet address to move `agentWallet` off the A-generated EOA onto their B
smart wallet. Retains operational continuity.

## Architecture

### SDK choice (leading candidate)

**ZeroDev Kernel V3 + Passkey Validator** (`@zerodev/sdk` + `@zerodev/passkey-validator`)

Why:
- Purpose-built for passkey-controlled smart accounts on Base Sepolia + mainnet
- Bundler + paymaster included in the ZeroDev platform (single vendor for MVP)
- Counterfactual smart-wallet address derivation from passkey credentialId (no
  deployment required until first userOp)
- Battle-tested Kernel v3 modular account
- MIT license, actively maintained

Alternates evaluated:
- **Coinbase Smart Wallet** — deployed at fixed address, passkey built-in, but
  requires assembling more AA plumbing yourself (separate bundler + paymaster).
  Reserve for v3 if we want to consolidate on Coinbase's rails.
- **Alchemy AA SDK** — good SDK but requires their bundler+paymaster subscription.
  Cost equivalent to ZeroDev, less passkey polish.
- **Raw Pimlico + own passkey signer** — most control, most work. Not for MVP.

### Flow

```
Operator opens /onboard → clicks Continue
  ↓
Frontend calls POST /onboard/passkey/register
  ↓ returns WebAuthn challenge (server-generated random 32 bytes + rpId)
Browser passkey ceremony: Touch ID / Face ID → creates credentialId + pubkey
  ↓
Frontend sends attestation to POST /api/auth/provision (extended)
  ↓
Gateway:
  1. @simplewebauthn/server verifies attestation (rpId, origin, challenge match)
  2. Derives counterfactual smart-wallet address from credentialId via ZeroDev
     Kernel factory + passkey validator
  3. Stores {smart_wallet_address, passkey_credential_id, passkey_public_key,
     rp_id} on api_keys row (new columns)
  4. Constructs userOp: register(agentURI) on IdentityRegistry with SW as
     msg.sender (deploys SW counterfactually + mints NFT in one userOp)
  5. Paymaster sponsors gas (ZeroDev paymaster funded from PCC_GATEWAY_PRIVATE_KEY
     or dedicated paymaster address)
  6. Bundler submits userOp
  7. Returns 201 with {api_key, smart_wallet_address, agent_id, tx_hash,
     no private_key — passkey is the only signer}
  ↓
Every subsequent operator action signs a userOp via passkey — 100% keyless UX
```

### Migration path from A → B

For existing operators provisioned via A (option A stopgap):

1. Gateway adds `/api/auth/upgrade-to-passkey` endpoint
2. Operator authenticates with API key + optional email OTP
3. Browser passkey ceremony creates credentialId
4. Gateway derives counterfactual SW address, records on api_keys
5. `setAgentWallet(agentId, newSW, deadline, sig)` — signature FROM the SW
   (built from the passkey signer) proves consent to become the new agentWallet
6. Once tx confirms, api_keys.operator_wallet_custody flips from "gateway" to
   "operator" (passkey-controlled SW)
7. Operator's per-operator EOA from A can be zeroed out or kept as a backup
   (owner's choice via a follow-up endpoint)

Zero downtime. Zero operator key exposure.

## Prereqs before starting B

1. **PR #190 merged** — A + revenue routing live in prod
2. **First real settlement E2E verified** — proves A + oracle + V3 factory work
   as a system. Blocked on V3 lane's oracle-v2 upgrade (bulletin 239's HIGH).
3. **Owner sign-off** on:
   - SDK choice (recommend ZeroDev Kernel V3 + passkey validator)
   - Paymaster funding source (~$10-20 USDC + ETH on Base Sepolia to seed)
   - Test infrastructure (mock bundler + paymaster vs real for tests)
4. **rpId decision** — what domain the passkey binds to. Recommend
   `capability.network` for prod (so passkeys work across all subdomains).

## Timeline (~10 focused workdays)

| Day | Work | Deliverable |
|-----|------|-------------|
| 1 | SDK deep-dive: ZeroDev Kernel V3 + passkey validator quickstart on Base Sepolia; verify counterfactual address derivation matches deployment | Working spike + decision doc |
| 2 | Paymaster funding + ZeroDev API keys + test bundler mock strategy | Paymaster address funded; test infra plan |
| 3 | Backend: `@simplewebauthn/server` integration; `/onboard/passkey/register` challenge endpoint; passkey verify helper | Attestation verify passing unit tests |
| 4 | Backend: extend `/api/auth/provision` to accept passkey attestation; SW address derivation; userOp construction | Provision endpoint accepts passkey, returns SW address |
| 5 | Backend: paymaster wire-up; bundler submission; wait for userOp receipt; extract agentId + tx | Full mint via userOp works on Base Sepolia |
| 6 | Frontend: passkey signup step on OnboardChatPage; WebAuthn client integration; error UX (unsupported browser, cancelled prompt, etc.) | Chat flow onboards a real operator via passkey |
| 7 | Backend + frontend: signing subsequent ops (heartbeat, register-device, etc.) via passkey userOps | Every operator action signed by passkey |
| 8 | Migration endpoint `/api/auth/upgrade-to-passkey`: A → B path with `setAgentWallet` call from new SW | Existing A operators can migrate |
| 9 | Tests: mock bundler + mock passkey for CI; e2e test on Base Sepolia; migration test with a real A account | Tests green on CI |
| 10 | PR polish: docs update (`docs/AGENT_ONBOARDING_OBSERVABILITY.md`, `docs/AGENT_INTEGRATION_GUIDE.md`), agent-package.json system_prompt update, PR body, changelog | PR #192 ready for review |

Elapsed calendar time: 1-2 weeks depending on interruptions + review turnaround.

## Files that will change

**New**:
- `packages/gateway/src/services/passkey-verifier.ts` — WebAuthn attestation
- `packages/gateway/src/services/smart-wallet-account.ts` — ZeroDev Kernel + passkey signer wrappers
- `packages/gateway/src/services/user-op-builder.ts` — userOp construction + paymaster + bundler
- `packages/gateway/src/routes/passkey.ts` — challenge + register endpoints
- `apps/dashboard/src/components/PasskeySignup.tsx` — WebAuthn client
- `apps/dashboard/src/hooks/usePasskey.ts` — client-side passkey session
- `packages/gateway/src/__tests__/passkey-*.test.ts` — mocks + e2e
- `docs/ERC4337_PASSKEY_ONBOARDING.md` — trust model + operator FAQ

**Modified**:
- `packages/db/src/schema/auth.ts` — new columns (`smart_wallet_address`,
  `passkey_credential_id`, `passkey_public_key`, `passkey_rp_id`); deprecate
  ed25519 for new rows (kept for legacy)
- `packages/db/src/repositories/api-keys.ts` — new methods
- `packages/gateway/src/routes/provision.ts` — accept passkey attestation branch
- `packages/gateway/src/services/erc8004-identity-write.ts` — userOp-based
  register (replaces direct writeContract for B-provisioned agents)
- `apps/dashboard/src/pages/OnboardChatPage.tsx` — passkey step at start

**New deps**:
- `@zerodev/sdk`
- `@zerodev/passkey-validator`
- `@simplewebauthn/server`
- `viem/account-abstraction` (already in viem 2.x)

## Risk register

| Risk | Mitigation |
|------|-----------|
| Passkey UX breaks in a browser we care about (Safari on iOS < 16) | Feature-detect + fall back to A (EOA + gateway custody) for unsupported browsers |
| Paymaster runs out of funds mid-onboarding | Alert + auto-top-up cron; graceful `503 paymaster_unfunded` error with fallback to A |
| Cross-device passkey (operator uses phone then laptop) | Passkeys sync via Apple/Google keychain; document limits for physical security keys |
| Bundler outage | Multi-bundler fallback list; local status page |
| SDK breaking changes | Pin ZeroDev SDK version; watch releases |
| Regulatory / KYC | Not this PR — passkey doesn't change identity claims; still a normal ERC-721 NFT |

## Open questions

1. Which rpId for prod? `capability.network`?
2. Paymaster funded from `PCC_GATEWAY_PRIVATE_KEY` or a dedicated address?
3. Should A be deprecated at some point (say 6 months post-B GA), or maintained
   indefinitely as a compatibility path?
4. Do we want the smart wallet to be a modular Kernel account (extensible via
   plugins later — session keys, spending limits) or a minimal single-owner SW?
   Recommend modular for future-proofing.

## References

- Coord bulletin 234 — A/B/C debate
- Coord bulletin 235 — strategic alignment (composition + revenue)
- Coord bulletin 239 — revenue routing landed for A, HIGH oracle-v2 pivot
- ERC-8004 spec — https://eips.ethereum.org/EIPS/eip-8004
- ZeroDev Kernel — https://docs.zerodev.app/sdk
- Coinbase Smart Wallet — https://www.coinbase.com/wallet/smart-wallet
- SimpleWebAuthn — https://simplewebauthn.dev/
