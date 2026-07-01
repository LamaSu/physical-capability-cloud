# @pcc/mcp-server

MCP server for the Physical Capability Cloud — invoke physical capabilities, query Shop Kernels, build contracts, manage milestone escrow, and run the full Capture Verification Protocol from any MCP-compatible client (Claude Desktop, Claude Code, Cursor, Goose, ChatGPT Apps).

PCC is AWS for the physical world. Shop Kernels are availability zones. Capabilities are billable units (3D printing, CNC milling, HPLC analysis). Assurance Tiers are SLAs. Settlement happens on-chain (Base Sepolia) when evidence meets tier requirements. This MCP server exposes 72 of the gateway's most-used endpoints over stdio so any agent can drive the network the same way a human dashboard would — discover a capability, negotiate a deal, commit it to escrow, and track settlement, all as tool calls.

Live gateway: **https://capability.network**

## Quick install

### From npm (once published)

```bash
npx -y @pcc/mcp-server
```

> The package is currently `private: true` in this monorepo and ships
> through the Smithery and MCP-directory channels. Until the npm publish
> step lands, install from source as shown at the bottom of this section.

### Claude Desktop / Claude Code

Add to `~/.claude/settings.json` (or your client's MCP config):

```json
{
  "mcpServers": {
    "pcc": {
      "command": "npx",
      "args": ["-y", "@pcc/mcp-server"],
      "env": {
        "PCC_URL": "https://capability.network"
      }
    }
  }
}
```

For local dev against a self-hosted gateway, point `PCC_URL` at your own
endpoint (e.g. `http://localhost:3200`).

### From source (this monorepo)

```bash
pnpm --filter @pcc/mcp-server build
node packages/mcp-server/dist/index.js
```

The package also ships a `pcc` CLI binary that exposes every MCP tool as a
subcommand for shell-driven workflows:

```bash
pcc capabilities list --pretty
pcc kernels list --status=online
pcc build options 3d-printing
PCC_URL=http://localhost:3200 pcc jobs list
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PCC_URL` | `https://pcc-gateway-production.up.railway.app` | Gateway base URL. Production is `https://capability.network`. |
| `PCC_API_KEY` | none | Bearer token sent on every API call (provisioned via `POST /api/auth/provision`). Optional for public endpoints; required for write operations. |

The server logs the resolved gateway URL to stderr on boot. MCP protocol
traffic uses stdin/stdout — stderr is safe for logs.

## Tool catalog (72 tools)

Organized by capability domain. Every tool name is prefixed `pcc_` so it does
not collide with other MCP servers in the same client.

The four **core agent-facing groups** — the surface most agents need to
transact end-to-end — are Discovery, Contract building, **Negotiation**, and
**Escrow & settlement**. A typical flow: `pcc_list_capabilities` →
`pcc_build_contract` (or the negotiation lifecycle) → `pcc_negotiate_commit` →
`pcc_get_escrow` to watch settlement.

### Discovery (8)

| Tool | One-line |
|---|---|
| `pcc_list_capabilities` | List canonical capability type strings recognized by the contract builder. |
| `pcc_search_capabilities` | Full capability templates with parameter groups and pricing hints. |
| `pcc_list_kernels` | List Shop Kernels, optionally filtered by status. |
| `pcc_get_kernel` | Full kernel record + devices + capability list. |
| `pcc_list_sensors` | Sensor channels for a kernel (temperature, pressure, flow, etc). |
| `pcc_get_sensor_data` | Recent sensor readings for a channel. |
| `pcc_discover_scan` | Scan local network for onboardable devices (mDNS/IPP). |
| `pcc_discover_onboard` | One-shot discover → generate CSD → register. |

### Contract building (3)

| Tool | One-line |
|---|---|
| `pcc_build_options` | Available configuration options for a capability type given partial selections. |
| `pcc_calculate_price` | Price quote for a complete parameter selection. |
| `pcc_build_contract` | Full contract object ready for escrow funding. |

### Negotiation (7)

The structured pre-commit lifecycle between a user agent and an operator's
kernel: `CREATED → CONFIGURING → QUOTED → REVIEWING → COMMITTED`. Sessions
auto-expire after 30 minutes; committed sessions are immutable. Requires
`PCC_API_KEY` for authenticated kernels.

| Tool | One-line |
|---|---|
| `pcc_negotiate_create` | Open a session for one capability type; snapshots operator constraints, issues a replay-resistant challenge. |
| `pcc_negotiate_get` | Read session state: status, selections, quote, contract terms, transitions. |
| `pcc_negotiate_select` | Merge parameter selections (→ configuring). |
| `pcc_negotiate_quote` | Lock params and compute a binding quote (→ quoted). |
| `pcc_negotiate_review` | Generate on-chain-ready contract terms from the quote (→ reviewing). |
| `pcc_negotiate_commit` | Lock in — creates the job, execution scope, and milestone escrow (→ committed). |
| `pcc_negotiate_cancel` | Cancel a non-committed session. |

### Workflows (1)

| Tool | One-line |
|---|---|
| `pcc_compile_workflow` | Compile a multi-step DAG of capability requirements into topologically sorted execution waves. |

### Jobs and evidence (5)

| Tool | One-line |
|---|---|
| `pcc_list_jobs` | List jobs across kernels with optional kernel/status filters. |
| `pcc_get_job` | Full job detail including evidence bundles and timeline. |
| `pcc_list_protocols` | Protocol templates (multi-step manufacturing workflows). |
| `pcc_list_evidence` | List all evidence bundles. |
| `pcc_get_evidence` | A specific bundle's IPFS CID, ZK proof status, Bittensor verification scores, evaluator attestations. |

### Escrow and settlement (3)

| Tool | One-line |
|---|---|
| `pcc_list_escrows` | List on-chain escrow contracts with milestone state. |
| `pcc_get_escrow` | Settlement status for one escrow by ID or 0x address — milestones, released/disputed counts, challenge-window state, `source` db/on-chain. |
| `pcc_get_escrow_events` | On-chain event log for an escrow contract address (Funded, MilestoneReleased, Disputed, …). |

### DePIN and reputation (4)

| Tool | One-line |
|---|---|
| `pcc_depin_stats` | DePIN reward epochs + kernel certificates + treasury balance. |
| `pcc_subnet_status` | PCC agent network status — active agents, types, conversations. |
| `pcc_get_agent_identity` | ERC-8004 identity for a kernel or agent. |
| `pcc_get_reputation` | Reputation scores by agent/tag (quality, uptime, assurance). |

### ERC-8004 agent registration (1)

| Tool | One-line |
|---|---|
| `pcc_agent_registration` | The gateway's machine-readable ERC-8004 Agent Registration File. |

### Setup (operator onboarding, 8)

| Tool | One-line |
|---|---|
| `pcc_setup_detect` | Detect current config state — env vars, DB, chain, adapters, storage. Start here. |
| `pcc_setup_generate_config` | Generate KERNEL_CONFIG JSON from device descriptions. |
| `pcc_setup_validate_config` | Validate a kernel config (or the currently loaded one). |
| `pcc_setup_register_device` | Register a physical device under a kernel. |
| `pcc_setup_health_check` | Health checks across devices (or a single device). |
| `pcc_setup_test_job` | Submit a test job end-to-end to verify the pipeline. |
| `pcc_setup_generate_env` | Generate a `.env` file (dev/testnet/mainnet profiles). Local, no gateway call. |
| `pcc_setup_status` | Status across all categories — gateway, DB, adapters, chain, storage, identity. |

### Capability StructureDefinitions (CSDs, 3)

| Tool | One-line |
|---|---|
| `pcc_csd_list` | List CSDs filtered by kind (base/profile/extension/workflow) and status. |
| `pcc_csd_get` | A CSD by canonical URI. |
| `pcc_csd_register` | Register a new CSD; validates against the CSD schema. |

### Story Protocol IP and royalties (5)

| Tool | One-line |
|---|---|
| `pcc_ip_register_capability` | Register a CSD as a Story Protocol IP Asset; enables programmable royalties. |
| `pcc_ip_revenue_snapshot` | Total accumulated revenue + unclaimed balance for an IP Asset. |
| `pcc_ip_claim` | Claim accumulated revenue from an IP Royalty Vault. |
| `pcc_ip_lineage` | Full ancestor + descendant lineage graph for an IP Asset. |
| `pcc_ip_set_splits` | Configure revenue splits across the 10-role ContributorRole taxonomy. |

### Sovereign Wealth Fund (3)

| Tool | One-line |
|---|---|
| `pcc_swf_summary` | Fund balance, accrued/distributed, allocation strategy, active proposals. |
| `pcc_swf_participant_dashboard` | A participant's SWF earnings, dividends, voting history. |
| `pcc_swf_list_proposals` | Governance proposals filtered by status. |

### Fiat ramp and wallet (7)

| Tool | One-line |
|---|---|
| `pcc_get_wallet_balance` | USDC balance, pending deposits, API credits. |
| `pcc_get_funding_options` | Available fiat-to-crypto rails (Stripe US/EU, Yellowcard 34 EM countries). |
| `pcc_create_onramp_session` | Create a funding session (card/ACH via Stripe; bank/mobile-money via Yellowcard). |
| `pcc_get_provider_rates` | Live Yellowcard exchange rates. |
| `pcc_submit_withdrawal` | Withdraw USDC to local fiat via Yellowcard (34 countries). |
| `pcc_get_ramp_activity` | Recent on/off-ramp activity across all providers. |
| `pcc_send_enterprise_payout` | Wise institutional payout in 40+ currencies, no crypto exposure. |

### Contributor economics (7)

| Tool | One-line |
|---|---|
| `pcc_contributor_register` | Register a contributor profile (DB-only; on-chain mint is separate). |
| `pcc_contributor_list` | All contributor profiles for an address across roles. |
| `pcc_schedule_publish` | Publish a sealed off-chain RateSchedule; idempotent by content hash. |
| `pcc_schedule_get` | Fetch a published RateSchedule by hash. |
| `pcc_schedule_evaluate` | Evaluate a schedule at a moment, return effective bps. |
| `pcc_training_manifest_set` | Set the TrainingManifest a `model-author` payout walks. |
| `pcc_training_manifest_get` | Fetch a model's TrainingManifest. |
| | |

### Capture Verification Protocol (CVP, 7)

| Tool | One-line |
|---|---|
| `pcc_capture_challenge` | Issue a block-anchored nonce so captures cannot be pre-computed. |
| `pcc_capture_upload` | Submit a capture + CaptureManifest for 6-gate verification; returns PASS/PARTIAL/FAIL verdict. |
| `pcc_capture_anchor` | Anchor a PASS verdict to CaptureClassRegistry on-chain. |
| `pcc_capture_status` | Combined verdict + on-chain anchor view for one verdict. |
| `pcc_list_verdicts` | Recent verdicts paginated, newest first, optional jobId filter. |
| `pcc_capture_class_registry` | On-chain anchor lookup by 32-byte captureHash. |
| `pcc_verifier_health` | CaptureVerifier adapter health — c2pa, webauthn, appattest, playintegrity. |

## Privacy and safety

Tools fall into four action classes — the same classification the broader
agent harness uses. Treat them accordingly when configuring an agent's
allowlist:

| Class | Tools | Notes |
|---|---|---|
| **read** | All `list_*`, `get_*`, `search_*`, `*_detect`, `*_status`, `*_health`, `*_lineage`, `*_summary`, `pcc_list_verdicts`, `pcc_capture_status`, `pcc_verifier_health` | Open. No side effects. |
| **write** | `pcc_setup_register_device`, `pcc_setup_generate_config`, `pcc_csd_register`, `pcc_contributor_register`, `pcc_schedule_publish`, `pcc_training_manifest_set`, `pcc_capture_upload`, `pcc_capture_anchor`, `pcc_negotiate_select`, `pcc_negotiate_quote`, `pcc_negotiate_review`, `pcc_negotiate_cancel` | DB / on-chain state change. Gate behind operator approval. |
| **exec** | `pcc_setup_test_job`, `pcc_discover_onboard`, `pcc_build_contract`, `pcc_compile_workflow`, `pcc_capture_challenge`, `pcc_negotiate_create`, `pcc_negotiate_commit` | Triggers gateway-side execution or compilation. `pcc_negotiate_commit` also creates a milestone escrow — treat as money-adjacent. |
| **credential / network** | `pcc_create_onramp_session`, `pcc_submit_withdrawal`, `pcc_send_enterprise_payout`, `pcc_ip_claim`, `pcc_ip_set_splits`, `pcc_ip_register_capability` | Moves real money or sets royalty splits. Always require explicit user approval. |

Tool inputs are validated twice — by Zod schemas in this server (which
generates JSON Schema for MCP clients) and again by the gateway server-side.
This server is a thin transport layer; it does not store credentials or
hold session state. Bearer tokens flow from `PCC_API_KEY` through the
request and are never persisted.

Every gateway call goes over HTTPS to `PCC_URL`. The server logs only the
resolved gateway URL on boot — never request bodies or response payloads.

## Larger agent package

The 63 MCP tools above are the most-used subset. For the full programmable
surface (219 tools across every gateway endpoint, with JSON Schema input
specs and HTTP endpoint mappings), fetch:

```
https://capability.network/agent-package.json
```

That file is consumable by any LLM that can speak HTTP — present
descriptions to the model, dispatch on the model's tool selection, make
the corresponding request to `https://capability.network` + the
endpoint path. The agent package includes a `system_prompt` field with
self-onboarding bootstrap instructions.

## Links

- Gateway: https://capability.network
- Agent integration guide: `docs/CLAUDE.md` (this repo, root)
- Agent package (219 tools): https://capability.network/agent-package.json
- ERC-8004 registration: https://capability.network/.well-known/agent-registration.json
- Source: `packages/mcp-server/src/` (this package)
