# PCC Standards Adoption

PCC is built to scale to every physical capability in the world. We adopt open standards so anyone can extend the platform without our involvement. This document is binding for future architectural decisions: when a choice exists between a standard and a custom format, the standard wins by default.

## Adopted standards

### Identity

- **W3C DIDs** (Decentralized Identifiers) — https://www.w3.org/TR/did-core/
  - Supported methods: `did:pkh` (wallet-based), `did:web` (DNS-based), `did:ens` (planned)
  - Implementation: `@pcc/identity` (available in v0.9; lands on branch `feat/identity-package`)
  - DID Documents resolve via standard libraries (`did-resolver`, `key-did-resolver`)
- **ERC-8004** (Trustless Agent Identity) — https://eips.ethereum.org/EIPS/eip-8004
  - PCC publishes `.well-known/agent-registration.json` at every node
  - Each adapter exposes its DID + signed capability claims at this path

### Capability description

- **W3C Web of Things Thing Description** — https://www.w3.org/TR/wot-thing-description/
  - PCC capability templates align with WoT TD semantics (properties, actions, events)
  - JSON-LD `@context` includes `https://www.w3.org/2022/wot/td/v1.1`
  - Future migration: full TD adoption with affordance-level operation maps
- **AGNTCY OASF** — https://docs.agntcy.org
  - Bidirectional bridge: source adapter consumes OASF capability descriptions; publisher emits PCC capabilities as OASF entries
  - Implementation: `@pcc/oasf-bridge` (available in v0.10)
- **MCP (Model Context Protocol)** — https://modelcontextprotocol.io
  - PCC ships an MCP server with 63+ tools spanning discovery, negotiation, escrow, settlement, and evidence retrieval
  - Stdio + HTTP transports supported

### Attestations & trust

- **EAS (Ethereum Attestation Service)** — https://attest.org
  - Implementation: `@pcc/attestations` (available in v0.9; lands on branch `feat/attestations-package`)
  - PCC tier attestations issued on Base mainnet; capability claims on Base Sepolia for testing
- **W3C Verifiable Credentials** — https://www.w3.org/TR/vc-data-model/
  - PCC accepts VCs as attestation format alongside EAS
  - Operator credentials, ISO/compliance certificates, and capability claims all expressible as VCs
- **Sigstore** — https://www.sigstore.dev
  - PCC uses `cosign` for release signing + verification of all npm packages and bridge images
  - Verification policy enforced in CI

### Discovery

- **DNS-AID / .well-known/** — Internet standards
  - PCC nodes publish `.well-known/capabilities.json` + `.well-known/did.json`
  - Operator-side discovery starts with DNS resolution
- **libp2p Kademlia DHT** — `@pcc/dht-core` (PR #53 lands the foundation)
  - Peer-to-peer capability advertisement and lookup
  - Falls back from on-chain registry when off-chain or rate-limited
- **The Graph subgraphs** — `@pcc/subgraph` (PR #49)
  - Indexed query layer over on-chain bridge directory, escrow events, and attestation issuance
  - Standard GraphQL interface

### Data models

- **JSON-LD** — Schema.org-compatible semantic markup
  - All capability descriptions include JSON-LD context
  - Enables interop with Google Knowledge Graph, structured-data crawlers, and W3C semantic-web tooling
- **OpenAPI 3.x** — REST API documentation
  - All PCC REST endpoints documented under `/openapi.json`
  - Client generation supported via `openapi-typescript`, `openapi-generator-cli`

## Out-of-scope (not adopted, with rationale)

- **DAO governance tokens** — premature for current scale; adds attack surface (token-vote capture, sybil resistance overhead) without solving a present problem. Revisit when third-party bridges outnumber first-party.
- **Centralized name service** (single registrar for capability namespaces) — defeats permissionless extension. Namespace uniqueness handled by on-chain `BridgeDirectory.sol` (Phase 2) with multisig dispute resolution only.
- **Custom serialization formats** — JSON for human-readable wire protocols, CBOR for size-constrained transport. No protobuf, no MessagePack, no custom binary.
- **Proprietary OAuth flows for operator authentication** — defer to W3C DIDs + EIP-4361 (Sign-In with Ethereum) for cryptographic auth.
- **Blockchain-of-the-month** — PCC anchors on Base mainnet for production attestations. Other L2s supported only when there's a concrete capability-class requirement (e.g., Flow EVM for NFT-bound physical assets).

## How this applies

When considering a new feature:

1. **Search for an existing standard** that solves it. Check W3C, IETF, ERC drafts, AGNTCY OASF registry, and the standards listed above.
2. **If found, use the standard** even if it requires more upfront work. The compounding benefit (third-party tooling, interop, longevity) outweighs short-term implementation cost.
3. **If no standard exists, design for future standardization.** Document the schema, version it, expose it via OpenAPI or JSON-LD. Submit to the relevant standards body once stable.
4. **Document why a custom approach was necessary** in `docs/DECISIONS.md`. Include: which standards were evaluated, why they didn't fit, and what migration path exists if a future standard emerges.

## Cross-reference matrix

| Standard | PCC package | Branch / PR | Status |
|---|---|---|---|
| W3C DIDs | `@pcc/identity` | `feat/identity-package` | v0.9 (in progress) |
| ERC-8004 | `@pcc/identity` (registration endpoint) | `feat/identity-package` | v0.9 (in progress) |
| W3C WoT TD | `@pcc/capability-templates` | merged in v0.8 | shipped (partial) |
| AGNTCY OASF | `@pcc/oasf-bridge` | `feat/oasf-bridge` | v0.10 (planned) |
| MCP | `@pcc/mcp-server` | merged | shipped (63+ tools) |
| EAS | `@pcc/attestations` | `feat/attestations-package` | v0.9 (in progress) |
| W3C VCs | `@pcc/attestations` (VC adapter) | `feat/attestations-package` | v0.9 (in progress) |
| Sigstore | CI workflow | `.github/workflows/release.yml` | shipped |
| libp2p DHT | `@pcc/dht-core` | PR #53 | in review |
| The Graph | `@pcc/subgraph` | PR #49 | in review |
| BridgeDirectory.sol | `@pcc/bridge-directory` | `feat/bridge-directory` | v0.10 (planned) |

## Revision

This document is amended via PR. Significant additions/removals require explicit orchestrator sign-off. Submitting an amendment:

1. Open a PR titled `standards: <change>`
2. Include rationale in the PR description: which problem the standard solves, what alternatives were considered, who else has adopted it
3. Update the cross-reference matrix
4. Tag `@LamaSu/maintainers` for review
