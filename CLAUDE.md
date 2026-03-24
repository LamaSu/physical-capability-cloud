## MANDATORY: DGX Spark Offload

**ALWAYS check Spark availability (`spark-check`) at session start and offload ALL builds, tests, and heavy work to the DGX Spark (192.168.108.72, 119GB RAM).** The local machine has only 16GB RAM and WILL OOM on builds, parallel tests, and multi-agent workloads. Use `spark-run` for everything. No exceptions.

- `spark-run "cd ~/projects/physical-capability-cloud && pnpm build --concurrency=1"` — build
- `spark-run "cd ~/projects/physical-capability-cloud && pnpm --workspace-concurrency=1 -r test"` — test
- `spark-run "cd ~/projects/physical-capability-cloud && pnpm install"` — install
- If Spark is down, use `--concurrency=1` locally and warn the user about OOM risk.

## MANDATORY: Security — Gate A Vetting Pipeline

All new tools, MCP servers, npm packages, and external dependencies MUST pass through Gate A vetting before being approved for use in this project.

### How to Vet
- Run `/vet <package-path>` on any new tool/package before integration
- Runs up to 7 scanners: Trivy (vulns+SBOM), Gitleaks (secrets), ClamAV (malware), npm audit, pip-audit, Semgrep (SAST), prompt injection detection
- Scanners degrade gracefully if not installed. Prompt injection scanner always runs.

### Policy Thresholds (from `~/.claude/plugins/vetting-policy.json`)
- Critical vulnerabilities: 0 allowed (auto-reject)
- High vulnerabilities: max 2 (warn on any)
- Medium vulnerabilities: max 10
- Secrets in source: 0 allowed (auto-reject)
- Malware: auto-reject, no override
- Prompt injection signals: max 1 (warn on any)

### Verdicts
- **PASS**: Clean, auto-approved
- **WARN**: Suspicious findings, human reviews before use
- **FAIL**: Critical vulns, secrets, or malware — auto-rejected

### When to Vet
- Before adding any new npm dependency to any package
- Before integrating any MCP server
- Before running any third-party script
- After forging a new MCP server with `/forge`
- Reports saved to `ai/supervisor/forge_approvals/`

## MANDATORY: Action Classification

Every tool call is classified by the tool-broker into one of 5 action classes:

| Class | Tools | Gate |
|-------|-------|------|
| read | Read, Glob, Grep, WebSearch, WebFetch | Open |
| write | Write, Edit, NotebookEdit | Role-checked |
| exec | Bash, Agent/Task | Role-checked + keyword scan |
| network | WebFetch, WebSearch, mcp__* | Role-checked |
| credential | Detected via keyword scoring in args | Always flagged |

Dangerous keywords (rm -rf, git reset --hard, git push --force, drop table, curl | sh) are scored 0.0-1.0. Actions scoring >0.5 are dual-logged and may be denied per agent allowlist.

### Per-Agent Allowlists (from `~/.claude/plugins/action-policy.json`)

| Agent | Allowed Tools | Action Classes |
|-------|--------------|----------------|
| supervisor | all | all |
| implementer | Bash, Read, Edit, Write, Glob, Grep | read, write, exec |
| researcher | Read, Glob, Grep, WebFetch, WebSearch | read, network |
| wheel-scout | Read, Glob, Grep, WebFetch, WebSearch | read, network |
| forger | Bash, Read, Edit, Write, Glob, Grep, WebFetch | read, write, exec, network |
| vet-scanner | Bash, Read, Write, Glob, Grep | read, write, exec |
| test-writer | Read, Write, Bash, Glob, Grep | read, write, exec |
| memory-scribe | Read, Write | read, write |
| context-hydrator | Read, Glob, Grep | read |
| skill-router | Read | read |
| browser | mcp__chrome-devtools__* | network |

# Physical Capability Cloud (PCC)

## What This Is

AWS for the physical world. A cloud control plane for physical manufacturing capabilities.

- **Shop Kernels** = Availability Zones (physical sites with equipment)
- **Capabilities** = billable units (not machines — what machines can DO)
- **Assurance Tiers** = SLAs (evidence depth + liability + dispute rules, 0-3)
- **Settlement** = milestone escrow on-chain; x402 for digital microservices
- **DePIN** = soulbound NFT certificates + reward epochs for infrastructure operators
- **IP Layer** = Story Protocol integration for CSD royalties and revenue splits

**Scale**: 22 packages + 1 dashboard app, 1514+ tests across 83 test files, 49 MCP tools, 65+ REST endpoints, 13 A2A intents, 5 SSE streams

**Live**: https://pcc-gateway-production.up.railway.app (Railway, healthcheck passing)

**Hackathon**: PL Genesis, deadline April 1, 2026 (Existing Code track). Push to `wingdingspenpal/poop` (SSH for `global-mysterysnailrevolution` not registered).

## Architecture

### Package Inventory

**Foundation**
| Package | Role |
|---------|------|
| `packages/spec` | Single source of truth for ALL types, schemas, Zod validation |
| `packages/contracts` | Solidity: MilestoneEscrow with bonds/slashing; Solana: soulbound NFTs, reward engine |
| `packages/db` | SQLite via better-sqlite3, shared database layer |

**Core Runtime**
| Package | Role |
|---------|------|
| `packages/kernel` | Shop Kernel runtime — device adapters (OctoPrint, Modbus, OPC-UA, SiLA), evidence emitter, Capability API |
| `packages/gateway` | Fastify HTTP gateway — 40+ route files, all REST endpoints, SSE streams |
| `packages/scheduler` | Workflow compiler + capability router |
| `packages/verifier` | Hybrid verifier market + evidence verification + Bittensor subnet |
| `packages/payments` | x402 middleware (server) + x402 client (auto-pay) + Meteora DLMM (capability pricing pools) |
| `packages/identity-8004` | ERC-8004 Trustless Agents — Identity/Reputation/Validation registry clients (viem), Agent Registration File generator, ABIs |

**Agent Layer (A2A)**
| Package | Role |
|---------|------|
| `packages/a2a` | Agent-to-Agent protocol — typed intents, message bus, conversations |
| `packages/agent-runtime` | Base agent framework — wallet (viem), tools, intent handlers, SmartAccountManager (ERC-4337) |
| `packages/agent-user` | User Agent — holds wallet, discovers, negotiates, submits workflows |
| `packages/agent-broker` | Broker Agent — routes capabilities, quotes, compiles workflows |
| `packages/agent-kernel` | Kernel Agent — wraps shop kernel, accepts jobs, emits evidence |
| `packages/agent-evaluator` | Evaluator Agent — third-party quality assessment, attestation VCs, ACP↔A2A bridge, reputation bridge |
| `packages/agent-support` | Support Agent — diagnostic engine, escalation manager, setup guidance |

**Tooling**
| Package | Role |
|---------|------|
| `packages/mcp-server` | 49 MCP tools over stdio; also CLI entry (`packages/mcp-server/dist/cli.js`) |
| `packages/contract-builder` | Interactive capability contract builder |
| `packages/onboard-kit` | Operator scaffolding CLI — generates kernel configs from templates |
| `packages/orchestrator` | Multi-instrument workflow orchestration |
| `packages/bundler` | Asset bundling utilities |

**Frontend**
| Package | Role |
|---------|------|
| `apps/ui` | Vite + React 19 dashboard — 52+ routes, setup wizard, onboarding wizard |

### Sovereign Infrastructure

- `packages/spec/src/identity/` — W3C DIDs (did:key + did:pcc) + Verifiable Credentials
- `packages/kernel/src/evidence-storage.ts` — IPFS evidence via Helia (ESM-only — import from dist path)
- `packages/kernel/src/lit-encryption-service.ts` — Lit Protocol mock with real AES-256-GCM
- `packages/kernel/src/lit-encryption-real.ts` — Real Lit Protocol via @lit-protocol/lit-node-client v6 (datil-test)
- `packages/agent-runtime/src/solana-wallet.ts` — Solana agent wallets + SPL token transfers
- `packages/agent-runtime/src/spending-policy.ts` — Budget-aware spending policies
- `packages/verifier/src/bittensor/` — Bittensor verification subnet (MockMiner, MockValidator, Yuma Consensus)
- `packages/contracts/ts/capability-certificates.ts` — Soulbound capability NFTs via Metaplex Core + PermanentFreezeDelegate
- `packages/contracts/ts/reward-engine.ts` — DePIN reward epoch scoring + distribution
- `packages/payments/src/meteora/` — Meteora DLMM pools for dynamic capability pricing

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
- **CSD**: Capability StructureDefinition — FHIR-inspired schema for defining capabilities with versioning and lifecycle (base/profile/extension/workflow)
- **A2A**: Agent-to-Agent typed intent bus — 13 intents across User/Broker/Kernel/Verifier/Settlement agents
- **Fiat Ramp**: Stripe (US/EU card/ACH) + Yellowcard (34 emerging market countries) + Wise (enterprise bank payouts)

## Deployed Infrastructure

- **Railway**: https://pcc-gateway-production.up.railway.app
- **Ethereum Sepolia contracts**:
  - MockUSDC: `0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb`
  - MilestoneEscrow: `0x9e81f5fd7cfa08e2a6a2a0a0128498bf8fd66454`
- **Deployer**: `0x61B4e2a7347a529b8B19A2a3444Bd3500E693890`
- **Agent Registration**: `/.well-known/agent-registration.json` (ERC-8004, 49 tools)

## MCP Server (49 Tools)

**Entry points**:
- MCP stdio: `node packages/mcp-server/dist/index.js` (set `PCC_URL` env var)
- Claude Code settings: `"pcc": { "command": "node", "args": ["packages/mcp-server/dist/index.js"] }`
- Gateway default: `https://pcc-gateway-production.up.railway.app`

**Tool groups** (49 tools total):

| # | Tool | What It Does |
|---|------|--------------|
| 1 | `pcc_list_capabilities` | List all registered capability types |
| 2 | `pcc_search_capabilities` | Search capability templates with full details |
| 3 | `pcc_list_kernels` | List Shop Kernels, filter by status |
| 4 | `pcc_get_kernel` | Get kernel details + devices |
| 5 | `pcc_list_jobs` | List jobs, filter by kernel/status |
| 6 | `pcc_get_job` | Get job details + evidence bundles |
| 7 | `pcc_build_options` | Get config options for a capability type |
| 8 | `pcc_calculate_price` | Calculate price for a capability contract |
| 9 | `pcc_build_contract` | Build complete contract ready for escrow |
| 10 | `pcc_list_escrows` | List escrow contracts, filter by status |
| 11 | `pcc_list_evidence` | List all evidence bundles |
| 12 | `pcc_list_protocols` | List multi-step workflow templates |
| 13 | `pcc_depin_stats` | DePIN reward epochs, certificates, treasury |
| 14 | `pcc_subnet_status` | Agent network status + conversations |
| 15 | `pcc_get_agent_identity` | ERC-8004 identity for kernel or agent |
| 16 | `pcc_get_reputation` | Reputation scores by agent/tag |
| 17 | `pcc_list_sensors` | List sensor channels for a kernel |
| 18 | `pcc_get_sensor_data` | Get recent sensor readings for a channel |
| 19 | `pcc_get_evidence` | Get evidence bundle: IPFS CID, ZK proof, Bittensor scores |
| 20 | `pcc_compile_workflow` | Compile DAG from steps with dependencies |
| 21 | `pcc_agent_registration` | Get ERC-8004 Agent Registration File |
| 22 | `pcc_setup_detect` | Auto-detect configuration state (START HERE for setup) |
| 23 | `pcc_setup_generate_config` | Generate KERNEL_CONFIG from device descriptions |
| 24 | `pcc_setup_validate_config` | Validate kernel configuration + adapter connectivity |
| 25 | `pcc_setup_register_device` | Register a physical device on the PCC network |
| 26 | `pcc_setup_health_check` | Run health checks on devices |
| 27 | `pcc_setup_test_job` | Submit a test job to verify full pipeline |
| 28 | `pcc_setup_generate_env` | Generate .env file for dev/testnet/mainnet |
| 29 | `pcc_setup_status` | Comprehensive setup status across all categories |
| 30 | `pcc_csd_list` | List CSD documents, filter by kind/status |
| 31 | `pcc_csd_get` | Get CSD by canonical URI |
| 32 | `pcc_csd_register` | Register a new CSD document |
| 33 | `pcc_discover_scan` | Scan local network for devices (mDNS/IPP) |
| 34 | `pcc_discover_onboard` | One-command: discover → generate CSD → register |
| 35 | `pcc_ip_register_capability` | Register CSD as Story Protocol IP Asset |
| 36 | `pcc_ip_revenue_snapshot` | Get IP Royalty Vault balance + unclaimed revenue |
| 37 | `pcc_ip_claim` | Claim accumulated IP royalty revenue |
| 38 | `pcc_ip_lineage` | Get IP provenance graph (ancestors + descendants) |
| 39 | `pcc_ip_set_splits` | Configure revenue splits (must sum to 100) |
| 40 | `pcc_swf_summary` | Sovereign Wealth Fund balance + strategy + proposals |
| 41 | `pcc_swf_participant_dashboard` | SWF participant earnings + dividends + voting |
| 42 | `pcc_swf_list_proposals` | List SWF governance proposals, filter by status |
| 43 | `pcc_get_wallet_balance` | USDC balance + pending deposits + API credits |
| 44 | `pcc_get_funding_options` | Fiat-to-crypto funding options (Stripe/Yellowcard) |
| 45 | `pcc_create_onramp_session` | Create fiat funding session (card/ACH/bank/mobile money) |
| 46 | `pcc_get_provider_rates` | Live Yellowcard exchange rates for emerging markets |
| 47 | `pcc_submit_withdrawal` | Withdraw USDC to local fiat (34 countries) |
| 48 | `pcc_get_ramp_activity` | Recent on/off ramp activity across providers |
| 49 | `pcc_send_enterprise_payout` | Wise enterprise bank payout (40+ currencies) |

## Gateway API Endpoints

The gateway (`packages/gateway`) exposes these REST route groups:

| Route File | Path Prefix | Domain |
|-----------|-------------|--------|
| capabilities.ts | /api/capabilities | Capability types + templates |
| kernels.ts | /api/kernels | Shop Kernels (list, get, create) |
| jobs.ts | /api/jobs | Job list, get, submit |
| build.ts | /api/build | Contract builder (options, price, contract) |
| escrow.ts | /api/escrow | Escrow contracts + milestones |
| evidence-encrypted.ts | /api/evidence | Encrypted evidence bundles |
| sensors.ts | /api/sensors | Sensor channels + readings + anomalies |
| protocols.ts | /api/protocols | Protocol templates (DAG workflows) |
| rewards.ts | /api/rewards | DePIN epochs, certificates, claims, treasury |
| registry.ts | /api/registry | ERC-8004 entity registry |
| csd.ts | /api/csd | Capability StructureDefinitions |
| discover.ts | /api/discover | Device discovery + auto-onboarding |
| ip.ts | /api/ip | Story Protocol IP registration + royalties |
| swf.ts | /api/swf | Sovereign Wealth Fund governance |
| fiat-ramp.ts | /api/fiat-ramp | Stripe, Yellowcard, Wise payment rails |
| setup.ts | /api/setup | Operator setup wizard endpoints |
| agents.ts | /api/agents | Agent subnet status |
| workflows.ts | /api/workflows | Workflow compile (DAG) |
| onboard.ts | /api/onboard | Onboarding wizard flow |
| marketplace.ts | /api/marketplace | Capability marketplace listings |
| batches.ts | /api/batches | Batch manifests (HPLC, multi-sample) |
| zk-proofs.ts | /api/zk | ZK proof creation + verification |
| spaces.ts | /api/spaces | Equipment hosting spaces |
| logistics.ts | /api/logistics | Shipments, bookings, installations |
| orchestrator.ts | /api/orchestrator | Multi-instrument transfer graphs |
| well-known.ts | /.well-known | agent-registration.json (ERC-8004) |
| status.ts | /health, /api/status | Healthcheck |

**SSE streams** (`/sse/stream/`): job/:jobId, kernel/:kernelId, device/:deviceId, batch/:batchId, /sse/notifications

## Dev Commands

```bash
# Install
spark-run "cd ~/projects/physical-capability-cloud && pnpm install"

# Build (ALL packages, sequential)
spark-run "cd ~/projects/physical-capability-cloud && pnpm build --concurrency=1"

# Test (ALL packages, sequential to prevent OOM)
spark-run "cd ~/projects/physical-capability-cloud && pnpm --workspace-concurrency=1 -r test"

# E2E simulations (run from repo root)
npx tsx scripts/e2e-simulation.ts                       # kernel-level e2e
npx tsx scripts/agent-e2e-simulation.ts                 # agent-to-agent e2e
npx tsx scripts/sovereign-e2e-simulation.ts             # sovereign infra e2e (9 phases + IPFS)
npx tsx scripts/openclaw-print-deliver-e2e.ts           # OpenClaw print-and-deliver
npx tsx scripts/openclaw-print-deliver-e2e.ts --variation 2
npx tsx scripts/openclaw-print-deliver-e2e.ts --variation 3
npx tsx scripts/lit-protocol-demo.ts                    # Lit Protocol encryption demo

# Contract deployment
npx tsx scripts/generate-wallet.ts                      # generate deployer wallet
DEPLOYER_PRIVATE_KEY=0x... npx tsx scripts/deploy-base-sepolia.ts  # deploy to Sepolia

# Onboard-kit CLI
node packages/onboard-kit/dist/cli.js quick-start       # generate kernel config interactively
```

## Testing

- **Framework**: vitest
- **Command**: `pnpm --workspace-concurrency=1 -r test` (sequential, prevents OOM)
- **Count**: 1514+ tests across 83 test files
- **ALWAYS use `spark-run`** for tests — local machine will OOM

## Environment Variables

| Variable | When Required | Description |
|----------|--------------|-------------|
| `PCC_URL` | MCP server | Gateway URL (default: production Railway URL) |
| `LIT_PROTOCOL_REAL=true` | Optional | Use real Lit Protocol datil-test instead of mock AES |
| `EVIDENCE_STORAGE=storacha` | Optional | Storacha w3up instead of Helia for evidence storage |
| `STORACHA_PROOF=...` | storacha mode | Storacha delegation proof (base64) |
| `STORACHA_SPACE_DID=did:key:...` | storacha mode | Storacha space DID |
| `STARKNET_ACCOUNT=...` | ZK anchoring | Starknet account address |
| `STARKNET_PRIVATE_KEY=0x...` | ZK anchoring | Starknet account private key |
| `STARKNET_NETWORK=goerli\|mainnet` | ZK anchoring | Default: goerli |
| `DEPLOYER_PRIVATE_KEY=0x...` | Contract deploy | Private key for contract deployment |
| `PCC_GATEWAY_PRIVATE_KEY=0x...` | On-chain writes | Gateway private key for settlement/rewards |
| `ESCROW_CONTRACT_ADDRESS=0x...` | Testnet/mainnet | Deployed MilestoneEscrow address |
| `KERNEL_CONFIG='{...}'` | Kernel runtime | JSON kernel configuration inline |
| `KERNEL_CONFIG_FILE=./...` | Kernel runtime | Path to kernel config JSON file |

## Orchestration Patterns

**For complex multi-step tasks**: Use `/go` — full autonomous pipeline with wheel-scout gate, context hydration, parallel wave execution, and memory checkpoint.

**For domain-specific workflows**: Use the A2A agent layer or the MCP tools directly.

**Preferred tool priority** (lowest cost first):
1. REST API directly — cheapest, no schema loading
2. MCP tools (`pcc_*`) — when in MCP-compatible client, structured tool calls
3. A2A intents — when agents need to negotiate or coordinate

**Setup workflow** (new operator): `pcc_setup_detect` → `pcc_setup_generate_config` → `pcc_setup_validate_config` → `pcc_setup_register_device` → `pcc_setup_test_job`

**Capability contract workflow**: `pcc_list_capabilities` → `pcc_build_options` → `pcc_calculate_price` → `pcc_build_contract` → (fund escrow) → `pcc_list_jobs`

**IP registration workflow**: `pcc_csd_register` → `pcc_ip_register_capability` → `pcc_ip_set_splits` → `pcc_ip_revenue_snapshot`

## Git Notes

- **Active remote**: `wingdingspenpal/poop` (all current work)
- **Broken remote**: `global-mysterysnailrevolution/physical-capability-cloud` (SSH key not registered)
- Always push to the `hackathon` remote: `git push hackathon`
