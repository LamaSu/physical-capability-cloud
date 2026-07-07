# PCC A2A / Signing / Directory / Identity / MCP Audit
# Agent: auditor-a2a | Date: 2026-06-22

## Status: DONE

---

## 1. A2A Protocol

### Spec alignment
PCC's A2A is an **internal custom implementation** that mirrors the Google A2A spec surface
(AgentCard, typed Intents, Conversations) but does NOT use Google's HTTP/JSON-RPC wire format.
The comment in `sign-card.ts` line 1 and the README cite "A2A v1.0 spec §4.4.7 + §8.4",
suggesting alignment with Google A2A (https://google.github.io/A2A/), but
the transport and serialization are PCC-specific.

### Wire envelope — A2AMessage
`packages/a2a/src/types.ts:51-77`

```
A2AMessage {
  id: Id                        // UUID
  conversationId: Id
  from: Id                      // sender agent ID
  to: Id                        // recipient agent ID (or "*" for broadcast)
  intent: Intent                // discriminated union (42+ types — see below)
  timestamp: string             // ISO-8601
  inReplyTo?: Id
  signature?: string            // Ed25519 sig (hex/base64 — see crypto.ts)
  encrypted?: EncryptedEnvelope // NaCl box ciphertext when present
  traceContext?: { traceparent?, tracestate? }  // W3C Trace Context
}
```

The `signature` field on A2AMessage is optional and, per the source, is set by callers manually
— there is no automatic signing middleware on the bus (only AgentCard signing is automatic).
The `encrypted` field carries X25519 NaCl box ciphertext for E2E encryption of the `intent`
payload.

### Intents — 42+ typed payload shapes
The `Intent` union (`types.ts:97-183`) includes:
- Job lifecycle: `submit_workflow`, `workflow_accepted`, `job_completed`, `job_status_*`
- Evidence: `request_verification`, `verification_result`, `request_evaluation`, `evaluation_result`
- Payment: `payment_request`, `payment_confirmation`, `escrow_funded`, NEAR cross-chain intents
- Discovery: `discover_capabilities`, `discover_hubs`
- Setup/device: `setup_detect`, `setup_configure`, `setup_validate`
- IP/SWF/anomaly: `ip_register`, `swf_*`, `anomaly_detected`, `protocol_failure`
- Evidence bundles are referenced by hash: `evidenceBundleHash: string` in `JobCompletedIntent` (line 369)

### Transports today
1. **InMemoryBackend** (`packages/a2a/src/backends/in-memory-backend.ts`) — default,
   single-process pub/sub, pure synchronous.
2. **NATSJetStreamBackend** (`packages/a2a/src/backends/nats-jetstream-backend.ts`) —
   selected by env `PCC_MESSAGE_BUS_BACKEND=nats`. Multi-process.
3. **NetworkTransport** (`packages/a2a/src/network-transport.ts`) — WebSocket + REST HTTP.
   Agents POST to `POST /api/a2a/send` and receive via `WS /ws/a2a?agentId=...`.
   The relay is implemented in `packages/a2a/src/relay-routes.ts` as a Fastify plugin.
4. **NetworkedBus** (`packages/a2a/src/networked-bus.ts`) — wraps NetworkTransport, fallback
   to in-memory if relay unreachable.
5. **EncryptedBus** (`packages/a2a/src/encrypted-bus.ts`) — layered wrapper that encrypts
   intents using NaCl box before calling the inner bus.

**Notably absent**: no XMTP, no LAN/mDNS, no ESP32/BLE, no WebRTC, no intermittent-link
store-and-forward transport. The transport layer is purely HTTP/WebSocket today.

### Can the A2A envelope carry a job or evidence payload?
Yes. `SubmitWorkflowIntent` carries a full CWM (Capability Work Manifest) and accepted
quotes. `JobCompletedIntent` carries the `evidenceBundleHash`. `VerificationResultIntent`
and `EvaluationResultIntent` carry attestation hashes and IPFS CIDs. The envelope itself
is JSON; large blobs are referenced by hash/CID, not inlined.

---

## 2. Signing (CRITICAL)

### TWO independent signing systems exist

#### System A — Ed25519 message signing (packages/a2a/src/crypto.ts)
Used for **capability announcements and A2A messages**.

Key functions (all in `packages/a2a/src/crypto.ts`):
- `generateSigningKeyPair()` (line 17): NaCl `sign.keyPair()` → `{ publicKey: string (hex), secretKey: string (hex) }`
- `sign(data: string, secretKey: string): string` (line 78): `nacl.sign.detached(message_bytes, sk)` → base64 signature
- `verify(data: string, signature: string, publicKey: string): boolean` (line 86): `nacl.sign.detached.verify(...)`
- `signAnnouncement(announcement, secretKey)` (line 96): signs `JSON.stringify(announcement, sorted_keys)` — NOT JCS, just sorted-key JSON stringify
- `verifyAnnouncement(announcement, publicKey)` (line 104): inverse

**Key type**: Ed25519 (via `tweetnacl`)
**Key encoding**: hex strings (both public and secret)
**Signature encoding**: base64
**What is signed**: the stringified data (for announcements: JSON with alphabetically sorted keys — note this is NOT RFC 8785 JCS; it's a simpler substitute)
**Keys come from**: `generateSigningKeyPair()` — generated at runtime; no env var loading for this path. Keys must be managed by the calling agent/kernel.

The `signature?: string` field on `A2AMessage` (types.ts:64) is the slot for this signature, but there is NO automatic signing middleware — callers must call `sign()` themselves and attach the result.

#### System B — ES256 (P-256 ECDSA) AgentCard signing (packages/a2a-signing/)
Used for **Agent Card identity documents** per A2A v1.0 spec §4.4.7 + §8.4.

Key functions:
- `loadSigningKey()` (key-management.ts:40): loads PKCS#8 PEM from env `PCC_AGENT_CARD_SIGNING_KEY`, derives public key by stripping `d` from exported JWK
- `signAgentCard(card, { privateKey, kid, jwksUrl })` (sign-card.ts:59): JCS-canonicalizes card body (RFC 8785 via `canonicalize` package), signs with `CompactSign` (jose library, ES256), embeds `{ protected, signature }` in `card.signatures[]`
- `verifyAgentCard(signedCard, { jwksUrl | jwks | key })` (verify-card.ts:62): re-canonicalizes body, reconstructs JWS compact, verifies via `compactVerify`; resolves key via kid lookup in JWKS (fetched from `jku` header)
- `generateJWKS(publicKey, kid)` (key-management.ts:90): exports public key as JWK, wraps in `{ keys: [...] }` for serving at `/.well-known/jwks.json`

**Key type**: P-256 ECDSA (ES256)
**Key encoding**: PEM (PKCS#8 private), JWK (public)
**Signature format**: JWS Flattened (`{ protected: base64url, signature: base64url }`) embedded in `card.signatures[]`
**What is signed**: JCS (RFC 8785) canonicalized card body (everything except the `signatures` field)
**Keys come from**: env var `PCC_AGENT_CARD_SIGNING_KEY` (PKCS#8 PEM)

#### System C — E2E encryption (packages/a2a/src/crypto.ts + encrypted-bus.ts)
- `generateEncryptionKeyPair()` (crypto.ts:26): NaCl `box.keyPair()` → X25519 key pair (hex)
- `encryptMessage(plaintext, recipientPublicKey, senderSecretKey)` (crypto.ts:37): NaCl box (X25519 + XSalsa20-Poly1305), returns `EncryptedEnvelope { ciphertext: base64, ephemeralPublicKey: hex, nonce: base64 }`
- `decryptMessage(envelope, senderPublicKey, recipientSecretKey)` (crypto.ts:60): `nacl.box.open`
- `EncryptedBus` wraps any bus and auto-encrypts outgoing intents when peer key is known

### Summary — reusable signing primitives for transport abstraction

| What | Function | File:line | Key type | What's signed |
|---|---|---|---|---|
| Message/announcement | `sign(data, sk)` | crypto.ts:78 | Ed25519 (NaCl) | Arbitrary string (caller serializes) |
| Announcement verify | `verify(data, sig, pk)` | crypto.ts:86 | Ed25519 (NaCl) | Same string |
| Announcement canonical | `signAnnouncement(ann, sk)` | crypto.ts:96 | Ed25519 (NaCl) | sorted-key JSON stringify |
| Agent Card sign | `signAgentCard(card, opts)` | sign-card.ts:59 | ES256 P-256 | JCS RFC 8785 body |
| Agent Card verify | `verifyAgentCard(card, opts)` | verify-card.ts:62 | ES256 P-256 | JCS RFC 8785 body |
| Load key (env) | `loadSigningKey()` | key-management.ts:40 | ES256 P-256 | — |

The `sign()` / `verify()` pair in `crypto.ts` are the most reusable primitives — they take
arbitrary strings, use Ed25519, and are pure functions. They could directly sign serialized
job payloads, evidence hashes, or transport envelopes over any medium (BLE, LoRa, XMTP, etc.)
as long as both ends share the public key.

**Gaps for provenance threading**:
- No automatic signing middleware on A2AMessage send — the `signature?` field must be populated manually
- `signAnnouncement` uses simple sorted-key JSON stringify, not JCS; inconsistency with AgentCard which uses proper JCS
- No chain-of-custody: there is no "evidence was produced by kernel K at time T under job J, signed by kernel's Ed25519 key" — the hash link exists (`evidenceBundleHash` in JobCompletedIntent) but no signed binding from kernel → evidence → transport envelope

---

## 3. Bridge Directory (packages/bridge-directory/)

### What it is
A catalog of "bridges" — hardware adapter packages that connect physical devices to PCC.
Phase 1 = JSON file at `https://capability.network/bridges.json`.
Phase 2 (planned) = on-chain `BridgeDirectory` contract on Base mainnet.

### BridgeEntry shape (`src/types.ts:50-104`)
```
BridgeEntry {
  namespace: string             // e.g. "hamilton", "octoprint"
  name: string
  repoUrl: string
  maintainerAddress: `0x${string}`  // EVM wallet address for on-chain auth
  adapterPackage: string        // npm or pypi package
  version: string
  status: "experimental" | "active" | "deprecated" | "removed"
  trustTier?: 0..3
  registries?: Record<chainId, `0x${string}`>  // BackendAuthorRegistry per chain
  configSchemaURI?: string       // IPFS CID or https URL to capability schema
  capabilityTypes?: string[]
  extensions?: Record<string, unknown>  // reverse-DNS keyed
}
```

### Lookup API (`src/resolver.ts`)
- `getBridgeDirectory(options?)` — fetches from JSON URL (default) or on-chain
- `lookupBridge(directory, namespace)` — O(n) namespace lookup
- `filterByCapabilityType(directory, type)` — filter by capability type

### What it does NOT do
The bridge directory catalogs adapters (npm packages) by namespace. It does NOT:
- Map wallet addresses or kernel IDs to network endpoints (no host/IP/port in BridgeEntry)
- Support RTP-style connection types (no webhook/xmtp/wifi-relay fields)
- Resolve addresses for RTP-style transport dispatch
- Store transport-level metadata (no `endpoint`, `host`, `port`, `xmtpAddress` fields)

### What could be extended
`extensions` (Record<string, unknown>, max 10 keys, reverse-DNS keys) is the designed
escape hatch. RTP transport metadata could live here:
```json
{
  "extensions": {
    "com.pcc.rtp.connectionType": "xmtp",
    "com.pcc.rtp.walletAddress": "0x...",
    "com.pcc.rtp.webhookUrl": "https://..."
  }
}
```
or as a first-class field in a Phase 3 schema bump.

---

## 4. Wallet Addressing / Identity

### packages/identity/ — W3C DID + VC
DID methods supported: `did:web`, `did:pkh`, `did:ens`

**did:pkh** (`src/methods/pkh.ts:88`) resolves deterministically (no network call):
- Format: `did:pkh:eip155:<chainId>:<checksummed-EVM-address>`
- Produces a DIDDocument with `EcdsaSecp256k1RecoveryMethod2020` verification method and `blockchainAccountId` = CAIP-10 identifier
- Also supports `bip122` (Bitcoin), `solana`, `tezos` namespaces

**Implication**: any EVM wallet address can be expressed as a DID (`did:pkh:eip155:8453:0x...`),
and a kernel or device addressed by its wallet address gets a fully resolvable DID for free.
This is the foundation for wallet-addressed device transport.

### packages/identity-8004/ — ERC-8004 on-chain registry
On-chain contract addresses (`src/constants.ts:12-24`):
- Sepolia: IdentityRegistry `0x8004A169FB4...`, ReputationRegistry `0x8004BAa17C55...`
- Base Sepolia: IdentityRegistry `0x8004A818BFB9...`, ReputationRegistry `0x8004B663056A...`

**IdentityRegistryClient** (`src/identity-registry.ts`):
- `register(agentURI, metadata?)` — mints ERC-721 NFT token = `agentId`, with URI pointing to `/.well-known/agent-registration.json`
- `getAgentWallet(agentId)` — maps on-chain agent ID → wallet address
- `ownerOf(agentId)` — ERC-721 owner (the kernel's operator wallet)
- `getMetadata(agentId, key)` — arbitrary key-value metadata on-chain

**AgentCard.walletAddress** (`packages/a2a/src/types.ts:36`): Every agent card carries an EVM wallet address. The AgentCard already links agent ID → wallet address.
**AgentCard.erc8004Id** (`types.ts:27`): optional `bigint` for on-chain registration.
**AgentCard.publicKey** (`types.ts:43`): hex-encoded Ed25519 public key for message verification.

### ERC-8004 Registration File (packages/identity-8004/src/registration-file.ts)
`generateRegistrationFile()` (line 41) advertises services:
- A2A: `${gatewayURL}/a2a`
- Web API: `${gatewayURL}/api`
- MCP: `${gatewayURL}/mcp`
- DID: `${gatewayURL}/api/identity`
- OASF: `${gatewayURL}/api/capabilities`

These are all HTTPS endpoints on the PCC gateway, not kernel-local endpoints. No wallet-addressed messaging endpoint (e.g. XMTP) is advertised.

### Wallet-addressed device gap
Currently: device addressing = kernel ID (string) → HTTP gateway URL. No wallet-to-transport mapping exists in the directory layer. To enable RTP-style xmtp wallet-addressed messaging:
1. The AgentCard already has `walletAddress` — that field can serve as the XMTP address
2. The ERC-8004 registration file needs an `xmtp` service entry
3. The bridge-directory `extensions` field can carry the wallet address for adapter lookup
4. The DID for a device can be derived as `did:pkh:eip155:<chainId>:<walletAddress>` deterministically

---

## 5. MCP as Transport (packages/mcp-server/)

### Architecture
`packages/mcp-server/src/index.ts` — 56 tools registered on a `McpServer` (Model Context Protocol SDK).
Transport: **`StdioServerTransport`** (line 1528) — the MCP server communicates over stdio (stdin/stdout JSON-RPC).

The server is a **thin HTTP proxy**: every tool calls `pccFetch(path, opts)` which makes an HTTP request to `PCC_URL` (the gateway). No direct DB or bus access.

### Job submission via MCP
`pcc_setup_test_job` (index.ts:610) — calls `POST /api/setup/test-job` which exercises the full pipeline. This is the closest to "submit a job via MCP channel."
`pcc_build_contract` (index.ts:190) → `POST /api/build/contract` — builds a contract.
There is no `pcc_submit_job` that submits to a specific kernel directly.

### MCP as a device transport
MCP is a **caller-side protocol** (LLM ↔ tool server). Its stdio channel is single-process; it cannot act as a device-facing transport for a kernel on the LAN. However:
- An MCP server on a device (e.g. Raspberry Pi attached to a 3D printer) could expose a PCC adapter via MCP, with Claude/another LLM as the orchestrating agent. This is the "MCP device adapter" pattern.
- The existing server runs outbound-only (fetches PCC gateway). No inbound agent-to-agent routing.

**Verdict**: MCP as currently implemented is a read/query transport for AI agents, not a kernel-facing job dispatch channel. It could be repurposed for device-local execution if an MCP server was deployed on the kernel node itself, but that would require a new package (e.g. `@pcc/kernel-mcp-adapter`).

---

## 6. Reuse Assessment — HAS vs LACKS

### HAS (directly reusable)

| Asset | What it provides | File |
|---|---|---|
| `sign(data, sk)` + `verify(data, sig, pk)` | Ed25519 sign/verify arbitrary bytes | a2a/src/crypto.ts:78,86 |
| `encryptMessage` + `decryptMessage` | X25519 authenticated encryption for any payload | a2a/src/crypto.ts:37,60 |
| `EncryptedBus` wrapper | Generic E2E encryption layer over any bus-like interface | a2a/src/encrypted-bus.ts |
| `A2AMessage` envelope | Structured intent envelope with signature slot + trace context | a2a/src/types.ts:51 |
| `JobCompletedIntent.evidenceBundleHash` | Hash-linked evidence reference in message | a2a/src/types.ts:364 |
| `AgentCard.walletAddress` | EVM wallet address per agent (= XMTP address) | a2a/src/types.ts:36 |
| `did:pkh` resolver | Deterministic DID from wallet address (no network needed) | identity/src/methods/pkh.ts:88 |
| `signAgentCard` + `verifyAgentCard` | JCS + ES256 signed identity cards with JWKS | a2a-signing/src/ |
| `BridgeEntry.extensions` | Escape hatch for transport metadata in bridge registry | bridge-directory/src/types.ts:96 |
| `IdentityRegistryClient.getAgentWallet` | On-chain agentId → wallet address lookup | identity-8004/src/identity-registry.ts:112 |

### LACKS (missing for transport abstraction)

| Missing | Impact | Notes |
|---|---|---|
| Transport abstraction interface | No pluggable transport API that alternatives (XMTP, BLE, LoRa, wifi-relay) can implement | NetworkTransport is WebSocket-specific (network-transport.ts); no `ITransport` interface |
| Auto-signing middleware | A2AMessage.signature is optional, never populated automatically | Manual `sign()` call required per message |
| Signed evidence binding | No kernel-to-evidence cryptographic chain: a signed receipt that says "kernel K produced evidence bundle E under job J" | evidenceBundleHash is in the intent but not signed by the kernel key |
| XMTP/wallet-addressed transport | No XMTP client; AgentCard.walletAddress is unused for routing | XMTP would be the RTP "xmtp" connection type |
| Intermittent-link store-and-forward | No durable queue at transport level; relay only queues 100 messages per agent in-memory (relay-routes.ts:25) | Would need persistence for LAN/drone scenarios |
| Transport metadata in directory | BridgeEntry has no endpoint/connection type fields | extensions field is the extension point |
| RTP connection-type dispatch | No router that selects transport (webhook/xmtp/wifi-relay/ws) by kernel/device type | Would need a TransportRegistry |
| Per-message signature verification gate | MessageBus.send() has security scanning (ContentScanner) but no signature verification | relay-routes.ts line 203 only checks from-field matches agentId, no sig verification |

---

## Key Files for Transport Abstraction Work

- `packages/a2a/src/types.ts` — A2AMessage envelope + all Intent shapes
- `packages/a2a/src/crypto.ts` — Ed25519 sign/verify + X25519 encrypt/decrypt (core reusable primitives)
- `packages/a2a/src/network-transport.ts` — WebSocket transport (model for new transports)
- `packages/a2a/src/networked-bus.ts` — Bus-with-transport pattern (model for transport-switching bus)
- `packages/a2a/src/encrypted-bus.ts` — Transport-agnostic encryption wrapper
- `packages/a2a/src/relay-routes.ts` — Gateway relay (offline queue, broadcast)
- `packages/a2a-signing/src/sign-card.ts` — ES256 JCS signing of Agent Cards
- `packages/a2a-signing/src/verify-card.ts` — ES256 JCS verification
- `packages/a2a-signing/src/key-management.ts` — Key loading + JWKS generation
- `packages/bridge-directory/src/types.ts` — BridgeEntry (extension point for transport metadata)
- `packages/identity/src/methods/pkh.ts` — did:pkh (wallet→DID, no network)
- `packages/identity-8004/src/registration-file.ts` — ERC-8004 agent registration file
- `packages/identity-8004/src/identity-registry.ts` — On-chain agentId↔wallet mapping
