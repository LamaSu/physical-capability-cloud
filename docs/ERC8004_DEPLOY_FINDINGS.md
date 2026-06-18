# ERC-8004 Registry Deploy — Findings (implementer-sierra2, 2026-06-18)

Status: **BLOCKED** before broadcast. Verification phase completed. Strategic decision required from owner before continuing.

## What was asked

Deploy `IdentityRegistry` + `ReputationRegistry` to Base Sepolia (chain 84532), verify on-chain, wire addresses into gateway config, integrate into agent-registration flow, verify end-to-end. ≤ 0.05 ETH budget. Testnet only.

## What was found (verified, not inferred)

### Two parallel ERC-8004 implementations coexist in this repo

1. **PCC-bespoke contracts** at `packages/contracts/src/`
   - `IdentityRegistry.sol` — own ABI, numeric-id, `register(EntityType, bytes32 metadataHash) -> uint256`, entity types Agent/Machine/Operator/Verifier
   - `ReputationRegistry.sol` — own ABI, score 0-1000, attester-gated `recordJobCompletion` / `recordDisputeOutcome` / `recordSlash`
   - `ValidationRegistry.sol`, `VerifierRegistry.sol` — sibling registries
   - `PCCProtocol.sol` — root contract that holds all registry addresses + collects 2.35% fee
   - **NOT deployed** on Base Sepolia (no addresses recorded in `packages/contracts/ts/chain-config.ts` under `base-sepolia`)
   - Deploy script ready: `script/DeployProtocol.s.sol` — single forge invocation deploys all 6 contracts + wires them into PCCProtocol

2. **Daydreams canonical ERC-8004 singletons** referenced in `packages/identity-8004/src/constants.ts`
   - Identity: `0x8004A818BFB912233c491871b3d84c89A494BD9e` (Base Sepolia) — verified live, `cast call name()` returns `"AgentIdentity"`, ERC-721 based
   - Reputation: `0x8004B663056A597Dffe9eCcC1965A193B7388713` (Base Sepolia) — verified live (263-byte proxy bytecode present)
   - Different ABI: `register(string agentURI, MetadataEntry[]) -> bigint tokenId`, ERC-721 ownerOf, tokenURI
   - Gateway `packages/gateway/src/routes/well-known.ts` already defaults `PCC_REGISTRY_ADDRESS` to the Daydreams Identity singleton

### These TWO are NOT interchangeable

The PCC custom IdentityRegistry and the Daydreams canonical IdentityRegistry have **incompatible ABIs**. PCC's `register(EntityType, bytes32)` cannot be called against the Daydreams `register(string, MetadataEntry[])` and vice versa.

### Deploy-blockers I hit

1. **No `DEPLOYER_PRIVATE_KEY` available** — `.env` doesn't exist in this worktree; only `.env.example` placeholders.
2. **Known PCC deployer wallet underfunded** — `0x61B4e2a7347a529b8B19A2a3444Bd3500E693890` has 7,851,535,947,757 wei (0.0000078 ETH) on Base Sepolia. Simulation estimates ~0.000185 ETH gas needed. Insufficient by ~24x.
3. **EIP-170 contract size violation** — `forge script script/DeployProtocol.s.sol:DeployProtocol --rpc-url https://sepolia.base.org` simulation succeeded BUT logged: `Error: Unknown0 is above the contract size limit (26754 > 24576).` One of the contracts (most likely `PCCProtocol` — it owns 4 registry pointers + handles fee collection) exceeds the 24,576-byte EIP-170 init-code limit and would revert during broadcast on a chain that enforces it.

### What IS already wired (correctly)

- `packages/gateway/src/routes/well-known.ts` reads `PCC_REGISTRY_ADDRESS` and defaults to the Daydreams Identity singleton — agent-registration flow already CAN reach an on-chain registry today, just via the Daydreams ABI, not PCC's bespoke one.
- `packages/identity-8004/src/identity-registry.ts` has a complete viem-based client for the Daydreams ABI: `register`, `setAgentURI`, `setMetadata`, `getAgentWallet`, `ownerOf`, `getAgentURI`, `getMetadata`.
- `packages/contracts/ts/chain-config.ts` HAS slots for `identityRegistry`, `reputationRegistry`, `validationRegistry` under each network — currently all `undefined` for `base-sepolia`.

### Branches with related work (DO NOT DUPLICATE)

- `feat/composition-reputation-hooks` (HEAD `932df42`) — wires composition execution → reputation propagation. Assumes registries are deployed.
- `feat/reputation-propagation` (HEAD `510b860`) — per-step reputation propagation through compositions. Same assumption.

## Strategic question for owner — needs decision before re-spawn

**Option A — Adopt Daydreams canonical singletons** (cheapest, fastest path to "trust layer is real")
  - No deploy needed for Identity + Reputation; they already exist
  - Write Base Sepolia entries into `packages/contracts/ts/chain-config.ts` pointing at the Daydreams addresses
  - Add `IDENTITY_REGISTRY_ADDRESS_BASE_SEPOLIA` + `REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA` to `.env.example`
  - Use `packages/identity-8004/IdentityRegistryClient` (already written) in the agent-registration route
  - **Caveat**: PCC loses bespoke functionality — no `EntityType` distinction (Agent/Machine/Operator/Verifier), no admin suspend, no granular reputation events (job/dispute/slash)

**Option B — Deploy PCC's own registries** (full feature parity, blocked today)
  - Fix EIP-170 violation FIRST: split `PCCProtocol` (storage + admin → core; setters/getters → satellite) OR enable optimizer/`--via-ir` in `foundry.toml`
  - Fund the deployer wallet (`0x61B4e2a7347a529b8B19A2a3444Bd3500E693890`) on Base Sepolia with at least 0.001 ETH from Coinbase faucet
  - Provide `DEPLOYER_PRIVATE_KEY` to the deploy environment
  - Then run `forge script script/DeployProtocol.s.sol:DeployProtocol --rpc-url https://sepolia.base.org --broadcast`

**Option C — Hybrid** (recommended if there's appetite)
  - Adopt Daydreams canonical Identity (it's already a working trust anchor; gateway already points to it)
  - Deploy PCC's own ReputationRegistry separately (smaller contract, fits EIP-170 without surgery)
  - Wire ReputationRegistry to Daydreams Identity via `agentExists` lookups

## What I did not do (and why)

- **Did not broadcast deploy** — no key, insufficient funds, contract size error would block it anyway. RULE 14 (verify before claiming): blind retry would have wasted gas on a known-bad deploy.
- **Did not edit `chain-config.ts`** — premature without owner pick from A/B/C above.
- **Did not push branch** — task rules forbid push.
- **Did not modify oracle, prod, Dockerfile, Railway** — task rules forbid.

## How to unblock (specific repro steps)

For **Option A** (fastest):
```
git checkout feat/erc8004-identity-reputation-base-sepolia
# Edit packages/contracts/ts/chain-config.ts:
#   deployments["base-sepolia"].contracts.identityRegistry = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
#   deployments["base-sepolia"].contracts.reputationRegistry = "0x8004B663056A597Dffe9eCcC1965A193B7388713"
# Edit .env.example to document the env override
# Wire agent-registration route to call IdentityRegistryClient.register()
# pnpm --workspace-concurrency=1 -r test
# Open PR
```

For **Option B** (full PCC deploy):
1. Fund deployer wallet to ≥ 0.001 ETH on Base Sepolia (faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet)
2. Either:
   - Add `optimizer = true`, `optimizer_runs = 200`, `via_ir = true` to `packages/contracts/foundry.toml` `[profile.default]` and retry; OR
   - Refactor `PCCProtocol.sol` to push fee logic into a satellite contract
3. Re-run simulation to confirm size < 24,576
4. `cd packages/contracts && DEPLOYER_PRIVATE_KEY=0x... ORACLE_VERIFIER_ADDRESS=0x... forge script script/DeployProtocol.s.sol:DeployProtocol --rpc-url https://sepolia.base.org --broadcast`
5. Record output addresses into `chain-config.ts`, `.env.example`, and the gateway config

## Verification artifacts captured (for next agent)

- `packages/contracts/out/IdentityRegistry.sol/IdentityRegistry.json` (compiled, ready)
- `packages/contracts/out/ReputationRegistry.sol/ReputationRegistry.json` (compiled, ready)
- `packages/contracts/broadcast/DeployProtocol.s.sol/84532/dry-run/run-latest.json` (simulation output, deterministic deploy addrs from CREATE nonce)
- `ai/supervisor/threads/implementer-sierra2.jsonl` (full event log)

## RULE 15 honest report

DONE means "watched it work." I did NOT deploy anything. I did NOT register an agent and read it back. I verified compile + simulation only. Anyone reading this should treat the "trust layer" status as: **on-chain trust anchor IS present via Daydreams singleton at `0x8004A818BFB912233c491871b3d84c89A494BD9e` — but PCC's bespoke registries are not deployed**.
