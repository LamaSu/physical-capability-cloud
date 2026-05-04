# Landscape Report: Embedded Wallet for PCC Zero-Friction Signup

**Generated**: 2026-04-30
**Researcher**: scout-alpha (wheel-scout, sonnet)
**Problem**: PCC needs server-managed smart wallets created from email/phone signup (no seed phrase, no MetaMask) for construction-worker-grade contributors who receive USDC royalty payouts on Base Sepolia / Base mainnet.

## Existing Solutions Found

| # | Solution | Embedded SW | Base support | Free tier | Server verify | Recommendation |
|---|----------|-------------|--------------|-----------|---------------|----------------|
| 1 | [Privy](https://privy.io) | ERC-4337 included | Native via Coinbase Smart Wallet | 0-499 MAU free | `@privy-io/server-auth` JWT (ES256) | **Adopt** |
| 2 | [Dynamic](https://dynamic.xyz) | EOA on free; SW on $249/mo | Yes | 1,000 MAU EOA-only | JWT | Skip (SW gated to paid) |
| 3 | [Web3Auth](https://web3auth.io) | MPC-based, no native SW | Yes | 1,000 MAW | Custom verifier | Skip (complexity, Consensys-owned) |
| 4 | [Magic](https://magic.link) | No native SW (bolt-on) | Yes | 1,000 MAU | JWT | Skip (no native SW, no onramp) |

## Top Pick: Privy

Acquired by Stripe in June 2025 → most financially stable. Embedded ERC-4337 smart wallets from email/SMS/passkey/social with no seed phrase on the free tier (0-499 MAU). Multiple ERC-4337 backends including Coinbase Smart Wallet (Base-native). Stripe Bridge gives first-class USDC onramp. Server-side verification = standard ES256 JWT verified via `@privy-io/server-auth`.

**Killer feature**: Stripe-backed onramp + ERC-4337 on free tier + clean server JWT.
**Killer concern**: Closed-source, but wallets are standard ERC-4337 contracts on-chain → migration always possible.

## Recommendation

**ADOPT: Privy**

Only vendor delivering all five must-haves on the free tier:
1. Email/phone signup, no seed phrase
2. Embedded ERC-4337 smart wallet auto-created on login
3. Base + Base Sepolia support via Coinbase Smart Wallet backend
4. Clean ES256 JWT server-side verification
5. USDC onramp (Stripe Bridge)

## Integration Plan

**Packages**:
- `@privy-io/react-auth` (frontend, wraps current wagmi config)
- `@privy-io/server-auth` (gateway JWT verification)

**Env vars** (server adds to `.env.example`, frontend adds to `apps/dashboard/.env`):
- `PRIVY_APP_ID` — public, set on server + client
- `PRIVY_APP_SECRET` — server-only, never exposed

**Frontend** (`apps/dashboard/src/providers/`):
- New `PrivyAuthProvider.tsx` wraps `<PrivyProvider>` around existing `<WalletProvider>` (which keeps wagmi for power users with MetaMask)
- `embeddedWallets.createOnLogin: 'users-without-wallets'` auto-creates a smart wallet on first login
- `defaultChain: baseSepolia` for dev; production switches to `base`

**Gateway** (`packages/gateway/src/auth/`):
- New `privy-auth.ts` exports `verifyPrivyToken(idToken)` that returns `{ privyDid, walletAddress, email }`
- Wired as an alternative to SIWE in the existing `siweAuthPlugin` — caller can authenticate with EITHER a SIWE signature OR a Privy ID token

**Migration path**:
- Existing wagmi + SIWE flows untouched (MetaMask users keep working)
- New `/start` (zero-friction) route uses Privy
- No big-bang migration — each route can opt in via `requireEither(siwe, privy)` middleware

## Stub-First Strategy

To unblock implementation BEFORE the user creates a Privy app:
1. Define an `EmbeddedWalletAdapter` interface in `packages/gateway/src/auth/embedded-wallet.ts`
2. Ship a `DemoWalletAdapter` (default when `PRIVY_APP_ID` is unset) that uses the existing `UnifiedKeychain` to deterministically derive an EOA from the email
3. Ship a `PrivyWalletAdapter` (active when `PRIVY_APP_ID` is set) that calls Privy's API
4. The route layer is unchanged — only the adapter swaps

This means the `/api/contributors/quickstart` endpoint and the `EarnFromYourWorkPage` ship today and work in demo mode; flipping the env var promotes them to production-grade Privy wallets.

## Sources

- https://docs.privy.io/wallets/using-wallets/evm-smart-wallets/overview
- https://www.privy.io/pricing
- https://privy.io/blog/announcing-our-acquisition-by-stripe
- https://docs.privy.io/authentication/user-authentication/access-tokens
- https://docs.privy.io/guide/server/authorization/verification
- https://www.dynamic.xyz/pricing
- https://web3auth.io/
- https://magic.link/pricing
- https://www.openfort.io/blog/top-10-embedded-wallets
