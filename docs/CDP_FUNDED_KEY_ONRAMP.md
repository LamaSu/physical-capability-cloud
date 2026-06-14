# Spec — CDP Funded-Key On-Ramp (lane: funded-key, coord bulletin #017)

## Goal
A human attaches a card **once**. Everything after is automatic: a wallet is created, funded with USDC on Base, and the operator's agent receives a **scoped, revocable** spend authority. This is the funded operator key that the settlement loop (Lanes B/C) pays into and the agent spends from. A human never touches a seed phrase, a key, or gas.

## Custody invariant (non-negotiable)
**Never export or hand out a raw private key.** The agent receives a **Spend Permission / AA session key**: capped amount, allowed token (USDC), time-boxed, owner-revocable. Same one-card UX, zero blast radius. Handing an agent a raw funded key is unbounded spend with no revocation — a custody disaster. (Per the architecture review.)

## Provider — Coinbase CDP (decided)
Coinbase Developer Platform: **Embedded/Smart Wallet + Onramp + Paymaster (gasless USDC on Base) + Spend Permissions + x402.** One ecosystem, minimal vendor sprawl, and PCC is already on Base + x402.

Alternatives evaluated (wheel-scout):
- **Privy** (now Stripe-owned) — x402-native agent wallets + policy engine; strong, but two-vendor (wallet + MoonPay onramp).
- **Crossmint** — single-API wallet+onramp+KYC+chargeback; good fallback.
- **Stripe Onramp** — card→USDC only, **does not create wallets** (bring-your-own-address).
- **Turnkey** — key infra only, **no native onramp**.
CDP wins on Base + gasless-USDC + spend-permissions in one stack.

## Architecture — EXTEND the existing payments substrate (do not rebuild)
Mirror the Stripe/Yellowcard pattern exactly: a self-contained module + a lazy-init singleton in `fiat-ramp.ts` + mock-mode fallback when env is unset.

### `packages/payments/src/cdp/`
- `CdpWalletClient` — create/get a CDP smart wallet (server-managed, self-custodial); gasless USDC on Base via Paymaster.
- `CdpOnrampClient` — create an Onramp session (card → USDC into the wallet on Base); return hosted/embedded funding URL + session id.
- `CdpSpendPermissionService` — issue a scoped Spend Permission `{spender, token: USDC, allowance, periodSec, expiresAt}` bound to an operator/agent; revoke by id.
- Mock mode when `CDP_API_KEY` is unset (matches Stripe/Yellowcard).
- Export from `packages/payments/src/index.ts`.

### Gateway routes (`packages/gateway/src/routes/fiat-ramp.ts`, new `getCdp()` singleton)
- `POST /api/fiat-ramp/cdp/provision` — create wallet + onramp session → `{walletAddress, onrampUrl, sessionId}`. The only human step: open `onrampUrl`, pay by card.
- `GET  /api/fiat-ramp/cdp/wallet/:address/balance` — USDC balance + pending onramp.
- `POST /api/fiat-ramp/cdp/spend-permission` — issue scoped key `{walletAddress, spender, allowanceUSDC, periodSec, expiresAt}` → `{permissionId, scopedSigner}`.
- `DELETE /api/fiat-ramp/cdp/spend-permission/:id` — revoke.

### Frontend (dashboard)
An onramp flow: "Attach a card" → CDP Onramp widget → wallet funded → scoped spend-permission issued → agent receives the scoped signer. One human step; the rest automatic.

## Integration with settlement
The funded wallet + spend-permission **is** the operator's settlement endpoint: Lane B/C escrow release → x402 → operator wallet; the agent spends within the permission. Bound to the operator's ERC-8004 identity.

## Env (mock fallback when unset)
`CDP_API_KEY`, `CDP_API_SECRET`, `CDP_WALLET_SECRET` (sourced from the gatecraft vault), `CDP_NETWORK=base-sepolia|base`, paymaster on by default for USDC.

## Build / verify discipline
- TS written on the tablet (no OOM). Build/tests on Spark, **coordinated** — not contending with Lanes A/B while they serialize.
- Gate-A `/vet` the `@coinbase/cdp-sdk` dependency before adding it.
- **Verify the actual CDP SDK surface before writing integration code** — do not assume the API.

## Coordination
Lane: funded-key on-ramp (coord #017). Non-colliding with Lanes A/B/C (oracle/contracts/compose) and #113 (registry). Isolated branch `feat/cdp-funded-key` off `lamasu/master`.
