# ERC-8004 Identity — Two-Step Trust Model

Status: implemented 2026-06-19 on branch `feat/erc8004-write-at-provision`
Audience: protocol integrators + operators provisioning API keys
Companion docs: `docs/ERC8004_DEPLOY_FINDINGS.md` (sierra2's 2026-06-18 audit)

## The shape of the trust commitment

PCC advertises an ERC-8004 IdentityRegistry on every agent-registration
file at `/.well-known/agent-registration.json`. Until 2026-06-19 that
advertisement was rhetorical: the **read path** pointed to the
Daydreams canonical singleton at
`0x8004A818BFB912233c491871b3d84c89A494BD9e` on Base Sepolia, but no
**write path** existed. Agents were on-chain non-existent.

This change adds the write path. When an agent provisions an API key
via `POST /api/auth/provision`, the gateway now:

1. Inserts the off-chain `api_keys` DB row and returns the raw key
2. Mints an ERC-8004 agent identity on Base Sepolia (best-effort)
3. Records the on-chain `agentId` + `txHash` against the DB row

The two records together form the trust commitment: off-chain
authentication AND on-chain attestation.

## Eventually-consistent semantics

The off-chain insert is the authoritative source at provision time.
The on-chain write is best-effort:

| What happens on-chain | DB columns set                                              | Response field                                |
|-----------------------|-------------------------------------------------------------|-----------------------------------------------|
| Success               | `onchain_status='written'`, `onchain_agent_id`, `onchain_tx_hash` | `{onchain: {status:'written', agentId, txHash, registryAddress, chainId}}` |
| Write throws (RPC fail, gas, nonce) | `onchain_status='pending'`, `onchain_error`        | `{onchain: {status:'pending', registryAddress}}` |
| Write disabled (no `PCC_GATEWAY_PRIVATE_KEY`) | unchanged                                  | `{onchain: {status:'disabled'}}`               |

A failed on-chain write **never** fails the HTTP request. The API key
is always issued. The retry sweeper picks up `pending` rows on the
next pass.

## Retry sweeper

`packages/gateway/src/services/erc8004-identity-sweeper.ts`. Starts at
gateway boot via `server.ts`. Configurable via env:

- `ERC8004_SWEEPER_DISABLED=true` — turn it off without un-setting the key
- `NODE_ENV=test` — auto-disabled (tests drive `runSweep` directly)
- Default interval: 5 minutes
- Default batch: 5 keys per pass

Each pass calls `ApiKeyRepository.listPendingOnchain(batchSize)` and
re-attempts. Repeated failures stay `pending`. The timer is `unref'd`
so it doesn't pin the event loop on shutdown.

## Verifying an agent's on-chain identity

Given an agentId N (returned from provision OR queried from the DB
row), read the agent's URI back from the registry:

```bash
# tokenURI is the standard ERC-721 read; on this registry it returns
# the URL of the agent's .well-known/agent-registration.json file.
cast call \
  0x8004A818BFB912233c491871b3d84c89A494BD9e \
  "tokenURI(uint256)(string)" \
  N \
  --rpc-url https://sepolia.base.org
```

`ownerOf(N)` returns the address that registered the agent — which is
the gateway's signer (set via `PCC_GATEWAY_PRIVATE_KEY`).

`getAgentWallet(N)` returns the wallet the agent operates under (set
separately via `setAgentWallet` after registration; not done by this
flow yet).

`getMetadata(N, "did")` returns the agent's DID as raw bytes. For
wallet-address operators the DID is `did:pcc:<lowercased-address>`;
for email operators it's `did:pcc:<api-key-id>`.

## Env vars

Required for the write path:

| Env var                     | Purpose                                                           |
|-----------------------------|-------------------------------------------------------------------|
| `PCC_GATEWAY_PRIVATE_KEY`   | 32-byte hex, gas-funded on Base Sepolia (only on the gateway host) |
| `PCC_GATEWAY_URL`           | Public base URL of this gateway (used to construct the agentURI)  |

Optional overrides:

| Env var                     | Default                                                 |
|-----------------------------|---------------------------------------------------------|
| `IDENTITY_REGISTRY_ADDRESS` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` (Daydreams) |
| `IDENTITY_REGISTRY_CHAIN_ID` | `84532` (Base Sepolia)                                  |
| `BASE_SEPOLIA_RPC`          | `https://sepolia.base.org`                              |
| `ERC8004_SWEEPER_DISABLED`  | `false`                                                 |

Also accepted as a fallback signer: `DEPLOYER_PRIVATE_KEY` (the same
key sierra2's audit referenced — `0x61B4e2a7347a529b8B19A2a3444Bd3500E693890`).

## Cost on Base Sepolia

Empirically: one `register(string)` call on the Daydreams singleton
costs ~0.0000051 ETH at the 0.1 gwei floor. The helper's pre-flight
`checkSignerFunding()` requires 5x headroom (25 µETH) before returning
`sufficientForOneRegister: true`. Sierra2 measured the canonical
deployer at 0.0000078 ETH on 2026-06-18 — funded for one register,
underfunded by the 5x-headroom check.

To top up, use the Coinbase Base Sepolia faucet:
https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet

## What this is NOT

- **NOT a ReputationRegistry write.** Reputation updates at
  job-completion time are a separate follow-up (`feat/composition-reputation-hooks`
  + `feat/reputation-propagation` branches assume registries exist).
- **NOT a KYC tier check.** Higher tiers (T2+ "Certified", T3 "Sovereign")
  may eventually require KYC verification BEFORE the on-chain write.
  This change wires the write unconditionally — gating is a follow-up.
- **NOT idempotent at the contract level.** Each call to `register()`
  mints a new agentId. The route checks `onchain_agent_id` is not
  already set before invoking the helper.
- **NOT a deploy of PCC's own registries.** The PCC bespoke
  IdentityRegistry / ReputationRegistry from `packages/contracts/` are
  still un-deployed (blocked by EIP-170 init-code size — see
  `docs/ERC8004_DEPLOY_FINDINGS.md`). This change adopts the Daydreams
  canonical instead (Option A in sierra2's strategic question).

## Follow-up work

| Task                                              | Why                                                  |
|---------------------------------------------------|------------------------------------------------------|
| ReputationRegistry write at job-completion        | Trust signal compounds across jobs                   |
| `setAgentWallet` after first job                  | Decouple operating wallet from registration wallet   |
| Gas-floor check before sweeper attempt            | Avoid burning gas during chain congestion            |
| KYC gate before T2+ writes                        | Higher-assurance tiers warrant explicit verification |
| Backfill historic keys (one-off sweep)            | All pre-2026-06-19 keys are off-chain only           |
| Deploy PCC's own bespoke registries (after EIP-170 fix) | Bespoke functionality (EntityType, granular events) |
