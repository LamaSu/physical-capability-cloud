# Landscape: ERC-4337 Account Abstraction + Coinbase Paymaster on Base

**Date**: 2026-03-24
**Scout**: wheel-scout
**Task**: Evaluate AA stack options for PCC gasless agent transactions (escrow, evidence commits, reputation) on Base mainnet and Base Sepolia.
**Constraint**: Codebase is all viem. Must integrate cleanly with existing `@pcc/bundler` package (`permissionless ^0.2.0`, `viem ^2.21.0`).

---

## TL;DR — Verdict

**Adopt permissionless.js (already in codebase) + Coinbase Paymaster (Bundler & Paymaster API).**

The stack is: `permissionless` (smart account client) + Pimlico's Alto bundler (or Coinbase's bundler) + Coinbase Paymaster (free gas credits on Base). All three are viem-native, Base-first, and actively maintained. The current `@pcc/bundler` has `permissionless ^0.2.0` declared as a dep but doesn't actually use its client factories — it hand-rolls UserOp construction and paymaster JSON-RPC calls. That needs to be replaced with the actual permissionless.js API.

**No new packages needed.** The entire gasless stack is already available via the existing dep.

---

## Evaluated Solutions

### 1. permissionless.js (Pimlico) — ADOPT

**Repo**: https://github.com/pimlicolabs/permissionless.js
**npm**: `permissionless` (already in `@pcc/bundler`)
**Last commit**: January 22, 2026 — actively maintained
**Version in codebase**: `^0.2.0`

**What it is**: TypeScript utilities built on viem for ERC-4337. Designed explicitly as a viem extension — same style, same primitives, no provider lock-in. It is the most viem-native AA library in existence.

**Viem compatibility**: Native. Built on viem. Uses viem transports, chains, accounts, and `walletClient` patterns. No wrappers or adapters needed.

**Coinbase Paymaster support**: Yes. Coinbase publishes official examples using permissionless.js (`github.com/coinbase/paymaster-bundler-examples`). The integration uses `createPimlicoPaymasterClient` pointed at the Coinbase CDP paymaster URL, or the Coinbase bundler URL directly as both bundler and paymaster.

**Smart account types supported**:
- `toSimpleSmartAccount` — eth-infinitism SimpleAccount (lightest, already used conceptually in @pcc/bundler)
- `toSafeSmartAccount` — Safe v1.4.1 (ERC-7579 optional)
- `toKernelSmartAccount` — ZeroDev Kernel (ERC-7579 + session keys)
- `toCoinbaseSmartAccount` — Coinbase Smart Wallet (Base-native, multi-owner, passkey support)
- `toNexusAccount` — Biconomy Nexus (ERC-7579)
- `toLightSmartAccount` — Alchemy LightAccount

**Session key support**: Depends on account type. With `toKernelSmartAccount`, full ERC-7579 session key plugins work through permissionless. The current `SessionKeyManager` in `@pcc/bundler` implements session constraint logic in TypeScript off-chain — that's a custom layer on top; it can remain as-is for now.

**Base Sepolia + mainnet support**: Yes. Both chains are in `viem/chains`. The entrypoint v0.7 `0x0000000071727De22E5E9d8BAf0edAc6f37da032` is already hardcoded in `@pcc/bundler/src/smart-account.ts` and is correct.

**Bundle size**: Permissionless.js has zero external dependencies — pure viem extension. Minimal impact.

**EIP-7702 support**: In progress. As of early 2026 permissionless.js supports EIP-7702 "hybrid" operations that let EOAs execute smart account logic without full deployment. Relevant post-Pectra (May 2025).

**Verdict**: ADOPT. Already in the codebase. The `@pcc/bundler/src/smart-account.ts` hand-rolls what permissionless.js does correctly. Replace the `SmartAccountClient` class with `createSmartAccountClient` from permissionless.js.

---

### 2. Coinbase Paymaster (CDP Bundler & Paymaster API) — ADOPT

**Docs**: https://docs.cdp.coinbase.com/paymaster/introduction/welcome
**Product page**: https://www.coinbase.com/developer-platform/products/paymaster

**What it is**: Coinbase Developer Platform's hosted ERC-4337 bundler and paymaster for Base. A single URL acts as both bundler (eth_sendUserOperation) and paymaster (pm_sponsorUserOperation).

**Free credits**: Developers get 0.25 ETH in gas credits on activation. Up to $15K via the Base Gasless Campaign. Billed at sponsored gas + 7% fee beyond credits, via monthly CDP invoice.

**Entrypoint support**: Only EntryPoint v0.6 (`0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`) as of the current docs. **This is a critical mismatch**: `@pcc/bundler` uses EntryPoint v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`). Verify this before wiring — Coinbase may have added v0.7 support by now, but it was not in their docs as of last confirmed state.

**Allowlist contracts**: Dashboard lets you add contract addresses that are eligible for sponsorship. PCC's `MilestoneEscrow`, `IdentityRegistry`, `ReputationRegistry` would be added there.

**Per-user limits**: Configurable dollar amount or UserOp count per user. Limit cycles: daily / weekly / monthly. Global sponsorship cap settable.

**Base Sepolia**: Supported (separate API key/URL from mainnet).

**Chains**: Base mainnet and Base Sepolia only. Not a multi-chain solution.

**Viem compatibility**: Uses standard ERC-4337 JSON-RPC methods (`pm_sponsorUserOperation`, `eth_sendUserOperation`). Works with any viem-compatible bundler client, including permissionless.js's `createPimlicoPaymasterClient` or `createBundlerClient`.

**Integration pattern** (matches existing `@pcc/bundler/src/paymaster.ts` approach):
```
Coinbase CDP URL = https://api.developer.coinbase.com/rpc/v1/base-sepolia/<API_KEY>
Method: pm_sponsorUserOperation
Params: [userOp, entrypointAddress]
Returns: { paymasterAndData, ... }
```

**Verdict**: ADOPT as primary paymaster. The `PaymasterClient` in `@pcc/bundler` already implements the right JSON-RPC pattern (`pm_sponsorUserOperation`). Wire `config.url` to the CDP URL and `config.policyId` is not needed (Coinbase uses contract allowlists instead). Verify EntryPoint version support before going live.

---

### 3. Pimlico Bundler — ADOPT as fallback / primary bundler

**Docs**: https://docs.pimlico.io
**npm**: bundler access is API-key based (no package install — just an RPC URL)
**GitHub**: https://github.com/pimlicolabs (active — permissionless.js Jan 2026)

**What it is**: The most widely-used third-party ERC-4337 bundler service. Pimlico also runs a Verifying Paymaster and an ERC-20 paymaster (gas in USDC/tokens). They are the authors of permissionless.js.

**Viem compatibility**: Native (permissionless.js is their library).

**Base support**: Yes. Multiple bundler contract addresses are visible on BaseScan (`0x4337001f...`). Both Base mainnet and Base Sepolia.

**EntryPoint support**: v0.6 and v0.7. No mismatch risk.

**Verifying Paymaster**: Available — `createPimlicoPaymasterClient` in permissionless.js. Policy-based sponsorship using a policy ID. Paid tier.

**ERC-20 Paymaster**: Pimlico's killer feature — let users pay gas in USDC. Useful for PCC if agents want to pay their own gas without ETH.

**Session keys**: Works with Kernel accounts on Pimlico bundler.

**Verdict**: ADOPT as primary bundler (over Coinbase bundler) because it supports EntryPoint v0.7, has deeper permissionless.js integration, and is more battle-tested across chains. Use Coinbase Paymaster (free) for sponsorship, Pimlico Bundler for bundling. They are independently configurable.

---

### 4. Alchemy Account Kit (`@account-kit/*`) — SKIP

**npm**: `@account-kit/core`, `@account-kit/infra`, `@account-kit/smart-contracts`, `@account-kit/signer`
**Latest**: v4.81.0 as of Oct 2025 release notes
**GitHub**: https://github.com/alchemyplatform/aa-sdk

**What it is**: Alchemy's vertically integrated AA platform — their bundler/paymaster infrastructure, plus LightAccount (a lean ERC-4337 account), plus social login (Alchemy Signer), all bundled. Formerly `@alchemy/aa-core`, rebranded to `@account-kit/*`.

**Viem compatibility**: Built on viem v2.x. Yes, viem-compatible.

**Coinbase Paymaster support**: Not a first-class feature. Alchemy has its own Gas Manager. Wiring Coinbase's paymaster through Account Kit is possible (swap out the paymaster middleware) but not documented.

**Session key support**: Via ERC-6900 plugins on their ModularAccount. More opinionated/proprietary than ERC-7579.

**Bundle size**: Large. `@account-kit/core` + `@account-kit/infra` + `@account-kit/smart-contracts` = multiple packages with sizeable combined footprint. Much heavier than adding nothing (we already have permissionless).

**Why skip**: Vendor lock-in to Alchemy infra. Multi-package install with no incremental value over permissionless.js + Coinbase Paymaster. PCC already has the right primitives.

---

### 5. ZeroDev Kernel (`@zerodev/*`) — EXTEND (if session keys needed on-chain)

**Docs**: https://docs.zerodev.app
**npm**: `@zerodev/sdk`, `@zerodev/permissions`, `@zerodev/session-key`
**GitHub**: https://github.com/zerodevapp/kernel (updated April 2025)
**Market share**: "More than 50% of all ERC-4337 accounts run on Kernel"

**What it is**: ZeroDev builds Kernel, the most-deployed modular smart account. ERC-7579 compliant, extensible via plugins. ZeroDev's SDK wraps permissionless.js (they are tight partners — pimlico docs even have a "how to use Kernel account" guide).

**Viem compatibility**: Yes. ZeroDev's SDK is built on viem and permissionless.js. The session key signer is "any Viem account object."

**Coinbase Paymaster support**: Works with any ERC-4337 paymaster, including Coinbase. ZeroDev provides their own bundler and paymaster but you can swap.

**Session key support**: This is ZeroDev's primary differentiator. Full on-chain session key enforcement with:
- `toPermissionValidator` — enforces allowed contracts, function selectors, spend limits on-chain in the smart account's validation logic
- Multiple policies: `toSudoPolicy`, `toCallPolicy`, `toSpendingLimitPolicy`, `toTimestampPolicy`, `toGasPolicy`
- The session key signer holds a temp keypair; constraints are enforced by the Kernel account on-chain, not just in TypeScript

**Why this matters for PCC**: The current `SessionKeyManager` in `@pcc/bundler/src/session-keys.ts` implements constraints in TypeScript only (off-chain). A rogue session key holder can ignore the constraints. ZeroDev Kernel enforces constraints in the smart account's EVM validation logic — you can't sign a UserOp that violates them even if you try.

**Dependencies**: `@zerodev/sdk` pulls in `@zerodev/permissions`, `@zerodev/session-key`, and other sub-packages. All build on permissionless.js (which is already in the codebase). Net new dep count is modest.

**Verdict**: EXTEND — don't add now, but when on-chain session key enforcement is required (likely before mainnet), swap `toSimpleSmartAccount` for `toKernelSmartAccount` and add ZeroDev Permissions. The TypeScript-only session constraint layer is fine for testnet but inadequate for production.

---

### 6. Biconomy Nexus (`@biconomy/abstractjs`) — SKIP

**Docs**: https://docs-devx.biconomy.io
**npm**: `@biconomy/abstractjs` (formerly `@biconomy/account`)
**GitHub**: https://github.com/bcnmy/sdk (128 repos in bcnmy org), dedicated `biconomy_viem_example` repo

**What it is**: Biconomy's Nexus is an ERC-7579 modular smart account. Their SDK (`abstractjs`) supports multichain operations (`toMultichainNexusAccount`). V4 SDK (abstractjs) is the current generation.

**Viem compatibility**: Full. They ship a dedicated `bcnmy/biconomy_viem_example` repo. Import from `viem/accounts`, `viem/chains` in all examples. Permissionless.js can create Nexus accounts via `toNexusAccount` (pimlico docs confirm this).

**Coinbase Paymaster support**: Works with any ERC-4337 paymaster.

**Session key support**: Via ERC-7579 modules (validation modules: session keys, passkeys, multi-chain validation).

**Why skip**: No advantage over permissionless.js + Kernel for PCC's use case. Biconomy adds a proprietary SDK layer on top of what permissionless.js already provides. Their bundler/paymaster requires a Biconomy API key and is not as well-integrated with Coinbase's ecosystem. More packages, more surface area, no PCC-specific advantage.

---

## Head-to-Head Comparison

| Dimension | permissionless.js | Coinbase Paymaster | Pimlico Bundler | Alchemy Kit | ZeroDev Kernel | Biconomy Nexus |
|-----------|------------------|--------------------|-----------------|-------------|----------------|----------------|
| Viem native | YES (built on viem) | Yes (std RPC) | Yes (via permissionless) | Yes (viem v2) | Yes (via permissionless) | Yes (viem examples) |
| Base / Base Sepolia | YES | YES (Base only) | YES | Yes | Yes | Yes |
| Coinbase Paymaster integration | YES (official examples) | N/A | Can use Coinbase PM | Possible (not documented) | Can use Coinbase PM | Can use Coinbase PM |
| Session keys (on-chain enforced) | Via Kernel plugin | N/A | Via Kernel plugin | Via ERC-6900 | YES (primary feature) | Via ERC-7579 modules |
| Actively maintained | YES (Jan 2026) | YES (CDP product) | YES (Jan 2026) | Yes | Yes (Apr 2025) | Yes |
| Already in codebase | YES (^0.2.0) | No (API key needed) | No (API key needed) | No | No | No |
| New packages needed | 0 | 0 (API key only) | 0 (API key only) | ~4 packages | 2-3 packages | 1-2 packages |
| EntryPoint v0.7 support | YES | VERIFY | YES | Yes | Yes | Yes |
| EIP-7702 support | In progress | Unknown | Unknown | Unknown | In progress | Unknown |
| Lock-in risk | Low | Medium (Base only) | Low | High (Alchemy infra) | Low | Medium |

---

## Recommended Architecture for PCC

### Immediate (testnet / hackathon submission)

```
Agent signer (EOA, viem privateKeyToAccount)
  → permissionless.js toSimpleSmartAccount (or toCoinbaseSmartAccount)
  → createSmartAccountClient (permissionless.js)
      bundlerTransport: http(PIMLICO_BUNDLER_URL)   // EntryPoint v0.7, reliable
      paymasterMiddleware: pm_sponsorUserOperation  // → Coinbase CDP URL
```

Config env vars:
- `PIMLICO_API_KEY` — from pimlico.io dashboard
- `COINBASE_CDP_PAYMASTER_URL` — from Coinbase Developer Platform

### Production path (mainnet)

Swap `toSimpleSmartAccount` → `toKernelSmartAccount` + `@zerodev/permissions` for on-chain session key enforcement. The `SessionKeyManager` TypeScript layer can remain as the off-chain constraint cache, but the smart account itself will reject out-of-policy ops.

### Changes to `@pcc/bundler`

The current `SmartAccountClient` class (303 lines of hand-rolled UserOp construction) should be replaced with `createSmartAccountClient` from permissionless.js. The library handles:
- Counterfactual address computation (real CREATE2, not the XOR hack currently in `computeCounterfactualAddress()`)
- Gas estimation via `eth_estimateUserOperationGas` with proper fallbacks
- UserOp signing using the ERC-4337 domain separator and typed data (the current `signUserOp` signs a raw JSON string — this is incorrect and will fail production bundlers)
- `paymasterAndData` integration via middleware

The `PaymasterClient` class and `SessionKeyManager` class can stay as the policy/rate-limiting layer but should delegate actual `pm_sponsorUserOperation` calls through permissionless.js middleware.

---

## Critical Finding: UserOp Signing Bug

The current `@pcc/bundler/src/smart-account.ts` `signUserOp` method signs `JSON.stringify(userOp fields)` using `signMessage`. This is **wrong**. ERC-4337 requires signing the `keccak256(abi.encode(userOpHash, entryPoint, chainId))` using `eth_sign` compatible format with the EntryPoint's domain. Production bundlers will reject signatures produced by the current method.

permissionless.js handles this correctly. This is the strongest argument for replacing the hand-rolled client immediately.

---

## Coinbase Paymaster Setup Checklist

1. Create account at https://www.coinbase.com/developer-platform
2. Create a new project → enable "Paymaster"
3. Get the API key and construct URL:
   - Testnet: `https://api.developer.coinbase.com/rpc/v1/base-sepolia/<API_KEY>`
   - Mainnet: `https://api.developer.coinbase.com/rpc/v1/base/<API_KEY>`
4. Allowlist PCC contracts:
   - `MilestoneEscrow` (Sepolia: `0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454`)
   - `IdentityRegistry` (when deployed)
   - `ReputationRegistry` (when deployed)
5. Set per-user limits (e.g., 10 UserOps/day for testnet)
6. Set global sponsorship cap (e.g., $100/day for testnet)
7. Verify EntryPoint version support — confirm v0.7 is supported or use v0.6 entrypoint address

---

## Sources

- https://github.com/pimlicolabs/permissionless.js — permissionless.js repo
- https://docs.pimlico.io/permissionless — permissionless.js docs
- https://docs.cdp.coinbase.com/paymaster/introduction/welcome — Coinbase CDP Paymaster
- https://docs.base.org/cookbook/account-abstraction/gasless-transactions-with-paymaster — Base gasless cookbook
- https://github.com/coinbase/paymaster-bundler-examples — Coinbase official examples
- https://docs.zerodev.app/sdk/advanced/session-keys — ZeroDev session keys
- https://docs.zerodev.app/sdk/permissions/intro — ZeroDev permissions system
- https://www.alchemy.com/blog/aa-sdk-v3 — Alchemy AA SDK v3 (Oct 2025)
- https://github.com/bcnmy/sdk — Biconomy SDK repo
- https://docs.pimlico.io/guides/how-to/accounts/comparison — Pimlico account comparison guide
- https://www.openfort.io/blog/zerodev-alternatives — ZeroDev alternatives analysis 2026
- https://docs.pimlico.io/guides/how-to/accounts/use-kernel-account — Kernel on Pimlico
- https://osec.io/blog/2025-12-02-paymasters-evm/ — Paymaster security analysis (Dec 2025)
