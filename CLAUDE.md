# Physical Capability Cloud (PCC)

## What This Is
AWS for the physical world. A cloud control plane for physical manufacturing capabilities.
- Shop Kernels = Availability Zones (physical sites with equipment)
- Capabilities = billable units (not machines — what machines can DO)
- Assurance Tiers = SLAs (evidence depth + liability + dispute rules)
- Settlement = milestone escrow on-chain; x402 for digital microservices

## Architecture

### Core Packages
- **packages/spec**: Single source of truth for ALL types, schemas, validation (Zod)
- **packages/kernel**: Shop Kernel runtime — device adapters, evidence emitter, Capability API
- **packages/contracts**: Solidity contracts — MilestoneEscrow with bonds/slashing
- **packages/scheduler**: Workflow compiler + capability router
- **packages/verifier**: Hybrid verifier market + evidence verification
- **packages/payments**: x402 middleware (server) + x402 client (auto-pay) + Meteora DLMM (capability pricing pools)
- **packages/identity-8004**: ERC-8004 Trustless Agents — Identity/Reputation/Validation registry clients (viem), Agent Registration File generator, contract ABIs

### Agent Layer (A2A)
- **packages/a2a**: Agent-to-Agent protocol — typed intents, message bus, conversations
- **packages/agent-runtime**: Base agent framework — wallet (viem), tools, intent handlers
- **packages/agent-user**: User Agent — holds wallet, discovers, negotiates, submits workflows
- **packages/agent-broker**: Broker Agent — routes capabilities, quotes, compiles workflows
- **packages/agent-kernel**: Kernel Agent — wraps shop kernel, accepts jobs, emits evidence
- **packages/agent-evaluator**: Evaluator Agent — third-party quality assessment, attestation VCs, ACP↔A2A bridge, reputation bridge
- **packages/agent-runtime** also includes: SmartAccountManager (ERC-4337 session keys mapped to SpendingPolicy)

## Invariants
1. All schemas live in `packages/spec` — no other package defines wire types
2. Every Evidence Bundle is content-addressed (SHA-256 of canonical JSON)
3. On-chain state only stores hashes/commitments, never raw data
4. Shop Kernel is the only external interface to a physical site
5. Every capability has an assurance tier; every tier has defined evidence requirements
6. Escrow only settles when evidence meets the contract's tier requirements

## Protocols
- **ERC-8004**: Identity Registry + Reputation Registry + Validation Registry for machines/agents
- **x402**: HTTP 402 Payment Required protocol (Coinbase) for per-request micropayments

### Sovereign Infrastructure
- **packages/spec/src/identity/**: W3C DIDs (did:key + did:pcc) + Verifiable Credentials
- **packages/kernel/src/evidence-storage.ts**: IPFS evidence storage via Helia (ESM-only — import from dist path)
- **packages/kernel/src/lit-encryption-service.ts**: Lit Protocol encryption (mock with real AES-256-GCM)
- **packages/kernel/src/lit-encryption-real.ts**: Real Lit Protocol via @lit-protocol/lit-node-client v6 (datil-test)
- **packages/agent-runtime/src/solana-wallet.ts**: Solana agent wallets + SPL token transfers
- **packages/agent-runtime/src/spending-policy.ts**: Budget-aware spending policies
- **packages/verifier/src/bittensor/**: Bittensor verification subnet (MockMiner, MockValidator, Yuma Consensus)
- **packages/contracts/ts/capability-certificates.ts**: Soulbound capability NFTs via Metaplex Core (mpl-core) + PermanentFreezeDelegate
- **packages/contracts/ts/reward-engine.ts**: DePIN reward epoch scoring + distribution
- **packages/payments/src/meteora/**: Meteora DLMM pools for dynamic capability pricing (mock + production path)

## Dev Commands
- `pnpm install` — install all deps
- `pnpm build --concurrency=1` — build all 17 packages (sequential to avoid OOM on Windows)
- `pnpm --workspace-concurrency=1 -r test` — run all tests (858+ passing across 40+ test files)
- `npx tsx scripts/e2e-simulation.ts` — run kernel-level e2e simulation
- `npx tsx scripts/agent-e2e-simulation.ts` — run agent-to-agent e2e simulation
- `npx tsx scripts/sovereign-e2e-simulation.ts` — run sovereign infrastructure e2e (9 phases + IPFS)
- `npx tsx scripts/openclaw-print-deliver-e2e.ts` — OpenClaw print-and-deliver e2e (3 variations: default, --variation 2, --variation 3)
- `npx tsx scripts/lit-protocol-demo.ts` — Lit Protocol mock/real encryption demo
- `npx tsx scripts/generate-wallet.ts` — generate a deployer wallet for Base Sepolia
- `DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-base-sepolia.ts` — deploy contracts to Base Sepolia

## Environment Variables
- `LIT_PROTOCOL_REAL=true` — use real Lit Protocol network (datil-test) instead of mock
- `EVIDENCE_STORAGE=storacha` — use Storacha w3up instead of Helia for evidence storage
- `STORACHA_PROOF=...` — Storacha delegation proof (base64, required when EVIDENCE_STORAGE=storacha)
- `STORACHA_SPACE_DID=did:key:...` — Storacha space DID
- `STARKNET_ACCOUNT=...` — Starknet account address for ZK proof anchoring
- `STARKNET_PRIVATE_KEY=0x...` — Starknet account private key
- `STARKNET_NETWORK=goerli|mainnet` — Starknet network (default: goerli)
- `DEPLOYER_PRIVATE_KEY=0x...` — private key for contract deployment
