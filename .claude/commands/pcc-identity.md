# PCC Identity — CLI

Agent identity, ERC-8004 registration files, and reputation scores for machines and agents on the PCC network.

## When to use
- "Get agent identity"
- "Check registration status"
- "Show the ERC-8004 identity for kernel-01"
- "Get the agent registration file"
- "What's the reputation of this agent?"
- "Show me who I am on PCC"
- "Is my agent registered?"
- "Show reputation by tag"

## Prerequisites
- Build the CLI first: `cd packages/mcp-server && npx tsc`
- Gateway reachable at `PCC_URL` (default: https://pcc-gateway-production.up.railway.app)

## What is ERC-8004?

ERC-8004 is PCC's on-chain identity standard for machines and autonomous agents. It defines three registries:

| Registry | What It Stores |
|----------|---------------|
| **Identity Registry** | DID, capabilities list, service endpoints, owner address |
| **Reputation Registry** | Reputation scores, job history, dispute outcomes, verifier endorsements |
| **Validation Registry** | Certifications, assurance tier qualifications, third-party attestations |

Every Shop Kernel, User Agent, Broker Agent, and Evaluator Agent has an ERC-8004 identity. The `agent-registration.json` file (also called the Agent Registration File or ARF) is a standardized off-chain document that describes an agent's tools, capabilities, and A2A endpoints — analogous to a DNS record for agents.

## Commands

### Agents Identity — ERC-8004 Identity
```bash
node packages/mcp-server/dist/cli.js agents identity <agentId>
```
Returns the full ERC-8004 identity record for a given agent or kernel. Output includes:
- **DID** (did:pcc or did:key format)
- **Owner address** (on-chain wallet controlling this identity)
- **Agent type** (kernel / user / broker / evaluator / support)
- **Registered capabilities** (list of capability types this agent supports)
- **Service endpoints** (A2A intent endpoints, MCP endpoint, REST endpoint)
- **Validation certifications** (assurance tier qualifications from the Validation Registry)
- **Registration timestamp** and last-updated block

Replace `<agentId>` with a DID, on-chain address, or short name (e.g., `kernel-01`).

Example:
```bash
node packages/mcp-server/dist/cli.js agents identity kernel-01
node packages/mcp-server/dist/cli.js agents identity did:pcc:broker-west-01
node packages/mcp-server/dist/cli.js agents identity 0xAbCd...
```

### Agents Registration — Get Agent Registration File
```bash
node packages/mcp-server/dist/cli.js agents registration
```
Returns the gateway's `agent-registration.json` (Agent Registration File): the ERC-8004-compatible document listing all 56 MCP tools, A2A intent endpoints, capability types, and service endpoints. This is the canonical machine-readable identity document for the PCC gateway agent. It is also served at `/.well-known/agent-registration.json` on the gateway.

Use this to:
- Inspect what tools/capabilities the PCC gateway agent advertises
- Copy the ARF for use in agent discovery directories
- Verify what a client agent will see when it discovers the PCC gateway

### Reputation Get — Reputation Scores
```bash
node packages/mcp-server/dist/cli.js reputation get <agentId>
```
Fetches ERC-8004 Reputation Registry scores for a given agent. Output includes:
- **Overall score** (0-100)
- **Jobs completed** / **jobs failed** / **jobs disputed**
- **Evidence quality score** (average across all evidence bundles)
- **Challenge history**: disputes won, disputes lost, dispute rate
- **Verifier endorsements**: list of Evaluator Agents that have positively attested this agent
- **Tag-based scores**: reputation broken down by capability type (e.g., score for `hplc` separately from `cnc-3axis`)
- **Score staleness**: how many blocks ago this was last updated on-chain

Example:
```bash
node packages/mcp-server/dist/cli.js reputation get kernel-01
```

Filter by tag (capability type) for tag-scoped reputation:
```bash
node packages/mcp-server/dist/cli.js reputation get kernel-01 --tag hplc
```

## Workflow: Verify an Agent Before Trusting It

Before submitting a job to an unfamiliar kernel or agent:

1. Get its full ERC-8004 identity to confirm it's a registered, legitimate agent:
   ```bash
   node packages/mcp-server/dist/cli.js agents identity <agentId>
   ```
   - Verify the owner address matches what the operator claims
   - Verify it has the capability type you need in its registered capabilities
   - Check its service endpoints are real (not placeholder addresses)

2. Check its reputation score, especially for the capability type you need:
   ```bash
   node packages/mcp-server/dist/cli.js reputation get <agentId> --tag <capabilityType>
   ```
   - Score ≥ 80: Well-established, low risk
   - Score 60-79: Acceptable, monitor closely
   - Score < 60: Use caution or choose an alternative

3. Cross-check against network status to confirm it's online:
   ```bash
   node packages/mcp-server/dist/cli.js agents status
   ```

## Workflow: Inspect Your Own Agent's Identity

1. Get your kernel's identity:
   ```bash
   node packages/mcp-server/dist/cli.js agents identity <yourKernelId>
   ```

2. Check your current reputation scores:
   ```bash
   node packages/mcp-server/dist/cli.js reputation get <yourKernelId>
   ```

3. Verify the gateway's agent registration file to see what clients discover about PCC:
   ```bash
   node packages/mcp-server/dist/cli.js agents registration
   ```

## Tips
- DIDs are the stable long-term identifier for an agent. On-chain addresses can be rotated; DIDs persist.
- Reputation scores update on-chain with a block lag. A very recent job completion won't be reflected immediately.
- `--tag <capabilityType>` on `reputation get` gives a more precise signal than the overall score. A kernel might have excellent CNC scores but poor HPLC scores — tag filtering reveals this.
- The `agents registration` command returns the full ARF with all 49 tool definitions. If you only need a quick overview, check `/.well-known/agent-registration.json` on the gateway directly via WebFetch.
- Dispute rate is a key red flag in reputation output. A kernel with >10% dispute rate (even with a high overall score) is risky — high scores can mask a few excellent jobs hiding many problems.
- Validation certifications in the identity record are tier qualifications. A kernel without Tier 2 certification should not be trusted to fulfill a Tier 2 contract even if it claims it can.
