# Extending PCC — Permissionless Integration Guide

You don't need PCC team permission to add capabilities, hardware adapters, or services. This guide shows how to integrate, what's required, and where to publish your work.

## Three integration paths

| You have... | Build a... | Distribution |
|---|---|---|
| Hardware (printer, lab instrument, machine) | **Adapter package** + capability template | npm + Python wheel + bridge repo |
| Software service (analytics, AI, logistics) | **MCP server** OR **capability template** | npm + your own hosting |
| Code library used by adapters | **Backend author registry deployment** | On-chain on Base mainnet |

## Path 1: Hardware adapter

You have a piece of hardware. You want operators to be able to run jobs on it through PCC.

### Step 1: Pick a namespace

Choose a unique namespace (e.g., `mybrand`). This becomes the prefix for every capability your adapter exposes (`mybrand.print.fdm`, `mybrand.lab.pcr`, etc.).

Confirm it's free:
- Check `https://capability.network/bridges.json` for active bridges
- Check on-chain `BridgeDirectory.sol` (when Phase 2 deploys) — see `@pcc/bridge-directory` (available in v0.10)
- If both are clear, the namespace is yours when you submit (Step 6)

Reserved namespaces: `pcc`, `system`, `core`, `kernel`, `bridge` — don't use these.

### Step 2: Create your bridge repo

Use the `pcc-bridge-template` (public template repo, link forthcoming on `capability.network/extend`):

- `<vendor>-pcc-bridge` is the canonical naming (e.g., `acme-pcc-bridge`, `hp-pcc-bridge`)
- Repo can be public or private — operators only need access to the npm package + Python wheel
- Apache-2.0, MIT, or proprietary — your choice. PCC core is Apache-2.0.

Recommended structure:
```
acme-pcc-bridge/
  packages/
    adapter/          # @acme/pcc-adapter — TypeScript adapter
    python/           # acme-pcc — Python wheel (operator-side)
    capabilities/     # capability template JSON files
  contracts/          # (optional) BackendAuthorRegistry deployment
  docs/
  README.md
  LICENSE
```

### Step 3: Implement the adapter interface

Your adapter package exports a class implementing the `Adapter` interface from `@pcc/kernel`:

```typescript
import { Adapter, AdapterConfig, JobSpec, JobId, JobStatus, EvidenceBundle, registerAdapter } from "@pcc/kernel";

export class MyVendorAdapter implements Adapter {
  constructor(config: AdapterConfig) { /* ... */ }
  async start(): Promise<void> { /* connect to hardware, validate config */ }
  async submitJob(job: JobSpec): Promise<JobId> { /* queue/dispatch to hardware */ }
  async getJobStatus(id: JobId): Promise<JobStatus> { /* poll or stream */ }
  async getEvidence(id: JobId): Promise<EvidenceBundle> { /* gather logs, photos, sensor data */ }
  async stop(): Promise<void> { /* graceful shutdown */ }
}

// Self-register at module load
registerAdapter("mybrand", MyVendorAdapter);
```

The full interface (with all optional hooks for streaming events, mid-job cancellation, capability advertisement) is documented in `@pcc/kernel`'s README.

Tier requirements:
- **Tier 1 (basic)**: implement `start`, `submitJob`, `getJobStatus`, `getEvidence`, `stop`
- **Tier 2 (streaming)**: add `subscribeToJobEvents` for real-time updates
- **Tier 3 (verified)**: add `signEvidence` using a maintainer key registered via EAS — see `docs/STANDARDS.md` for attestation standards

### Step 4: Define your capability template

Each capability your adapter handles needs a template — a JSON-LD document describing inputs, outputs, pricing model, evidence requirements, and operator constraints.

See `docs/CAPABILITY_PROFILES.md` for the full schema and existing examples in `packages/capability-templates/`. Aligned with W3C WoT Thing Description semantics per `docs/STANDARDS.md`.

Minimum required fields:
- `@context` (must include PCC + WoT TD contexts)
- `id` (e.g., `mybrand.print.fdm.v1`)
- `inputs` (JSON Schema)
- `outputs` (JSON Schema)
- `evidence` (which artifacts the adapter will return)
- `pricing` (per-job, per-unit, or operator-set)

### Step 5: (Optional) Deploy your BackendAuthorRegistry instance

If you want to pay code authors who contribute to your adapter, deploy your own `BackendAuthorRegistry` with your namespace. This lets contributors earn a share of execution fees routed through your adapter.

See `docs/BACKEND_AUTHOR_REGISTRY.md` (available in v0.10 on branch `feat/backend-author-registry`) for the deployment recipe, fee-split mechanics, and the operator-side opt-in.

Not deploying one is fine — operators still pay you (the bridge maintainer) and your fees flow through standard escrow.

### Step 6: Submit to bridges directory

**Phase 1 (current)**: PR your entry to `apps/dashboard/public/bridges.json` on the LamaSu/physical-capability-cloud repo. Include:
- `namespace`
- `displayName`
- `maintainerDid` (must resolve via `did:web` or `did:pkh` per `docs/STANDARDS.md`)
- `repoUrl`
- `npmPackage`
- `capabilities[]` (list of capability template IDs you expose)
- `tier` (1, 2, or 3)

PCC maintainers review for namespace uniqueness only — not for adapter quality, business model, or content. Reviews target 7-day SLA.

**Phase 2 (planned, v0.10)**: Call `BridgeDirectory.addBridge()` on Base mainnet directly. The on-chain registry handles uniqueness via first-claim semantics. Maintainer multisig only intervenes for namespace disputes (squatting, trademark issues).

### Step 7: Announce

Operators install your bridge via:

```bash
pip install pcc-node
pcc-node start --enable-bridge mybrand
```

Or, if your adapter is npm-only:

```bash
pnpm add @acme/pcc-adapter
# then reference in pcc-node config
```

Submit your bridge to:
- AGNTCY directory (auto-syncs via `@pcc/oasf-bridge` once published)
- Your own social channels — there is no central PCC announcement queue you need to wait on

## Path 2: Software service / MCP server

You have a software service (analytics platform, AI model, logistics API). You want it accessible to PCC operators and agents.

Two options:

### Option A: Wrap as an MCP server (easiest)

Use the `forge` skill to auto-generate an MCP server from your existing API docs:

```bash
# from a PCC checkout
claude
/forge mybrand https://api.mybrand.com/docs/openapi.json
```

This generates a Node.js MCP server, runs it through `/vet` for security scanning, and emits an installable package. Drop it in any MCP-compatible host (Claude Desktop, Cursor, Goose, PCC's own MCP gateway).

PCC operators discover your tools through their MCP client's registry. No PCC team involvement needed.

See `~/.claude/rules/library/mcp-directories.md` for submission to the 8 main MCP directories (Anthropic Registry, Smithery, Glama, mcp.so, PulseMCP, mcp.directory, mcp.market, awesome-mcp-servers).

### Option B: Capability template only (no adapter)

If your service is consumed by other adapters (e.g., a vision model called by a print-quality adapter), you can publish just a capability template without an adapter package. Operators wire it into their PCC node config.

Same JSON-LD format as Step 4 above. Publish to npm under your own scope.

## Path 3: Backend author registry (deploy your own)

You're a library author whose code is used by PCC adapters. You want to earn a share of execution fees when adapters using your code run jobs.

Deploy a `BackendAuthorRegistry` contract with your namespace. The adapter that uses your code opts in by referencing your registry address; a configured percentage of each job's execution fee routes to you.

See `docs/BACKEND_AUTHOR_REGISTRY.md` (available in v0.10 on branch `feat/backend-author-registry`) for:
- Solidity deployment script
- Fee-split configuration (per-adapter, per-capability, or flat-rate)
- Adapter-side opt-in flow
- Claiming earnings via standard ERC-20 withdrawal

You can deploy on Base mainnet (production) or Base Sepolia (testing). PCC core never holds your fees in custody — funds flow directly from operator → escrow → your registry.

## Standards reference

See `docs/STANDARDS.md` for the full list of standards PCC adopts. Your bridge SHOULD comply:

- **Identity** via DIDs (`did:pkh` for wallet-derived, `did:web` for DNS-anchored)
- **Attestations** via EAS or W3C Verifiable Credentials
- **Capability descriptions** per W3C Web of Things Thing Description semantics
- **Release signing** via Sigstore `cosign`

Non-compliant bridges still work, but operators may filter them out and they won't earn the "verified" badge in the bridges directory.

## Compliance vs adoption

- **MUST**:
  - Implement the `Adapter` interface from `@pcc/kernel` (or the equivalent MCP server contract)
  - Register at module load with `registerAdapter(namespace, AdapterClass)`
  - Declare which capability types you handle (via capability templates)
  - Sign your release manifest with a maintainer key

- **SHOULD**:
  - Align capability schemas with W3C WoT Thing Description (see `docs/STANDARDS.md`)
  - Use EAS for tier attestation on Base mainnet
  - Publish a DID Document at `.well-known/did.json` on your bridge's website
  - Sign npm releases with Sigstore `cosign`

- **MAY**:
  - Deploy your own `BackendAuthorRegistry` to route fees to contributors
  - Register on the Phase 2 `BridgeDirectory.sol` (when v0.10 deploys) instead of the JSON-based Phase 1 directory
  - Issue Verifiable Credentials for your operators (e.g., "this operator completed our certification course")
  - Run a private fork of the PCC node for internal-only capabilities

## Common pitfalls

- **Don't fork PCC core to add a capability.** Add an adapter to your own repo. Forks become unmaintainable; adapters compose.
- **Don't hard-code your namespace into PCC source.** Adapter self-registration via `registerAdapter()` is the only supported integration mechanism.
- **Don't bundle operator secrets in your adapter package.** Operators inject credentials at runtime via PCC's standard secret management (env vars or vault integration).
- **Don't break semver.** Adapter interface changes are MAJOR bumps. Operators rely on your version constraint to know whether an upgrade is safe.

## Getting help

- **GitHub Discussions**: https://github.com/LamaSu/physical-capability-cloud/discussions
- **AGNTCY Slack**: link forthcoming on `capability.network/extend`
- **Direct**: `maintainer@capability.network`

For commercial bridge support, customer integrations, or co-marketing, contact the LamaSu team directly. For pure technical questions, GitHub Discussions has faster turnaround.

## Related documents

- `docs/STANDARDS.md` — full list of standards PCC adopts
- `docs/CAPABILITY_PROFILES.md` — capability template schema
- `docs/ADAPTER_BOUNTIES.md` — current bounty program for in-demand capabilities
- `docs/CONTRIBUTOR_ECONOMICS.md` — how fees flow through the system
- `docs/AGENT_INTEGRATION.md` — for AI agents discovering and using PCC capabilities
- `docs/CAPTURE_VERIFICATION.md` — evidence requirements for Tier 3 verified bridges
