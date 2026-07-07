# RTP Absorption #02 — Device Connection & Transport Abstraction for PCC Kernels

> **Status:** Design proposal (research pass). **No source code is changed by this document.**
> **Scope of this pass:** research + design only. The only artifacts produced are this doc and
> the scratch notes under `docs/rtp-absorption/research-notes/`. No PCC source was modified, no
> dependencies installed, no third-party code executed (clean-room study of open-source projects).
> **Audience:** PCC core maintainers evaluating how kernels should connect to *real* physical devices
> that are not reachable as public cloud HTTPS endpoints.
> **Baseline to match-or-beat:** RTP (`github.com/plagtech/rtp-spec`) — PCC must do everything RTP
> does *plus* thread its signed-evidence/provenance model through the connection mechanism, which RTP
> does not.

All code/schema blocks below are **illustrative sketches for discussion only** — they are not real
source files and must not be copied verbatim into the tree. They use `// ILLUSTRATIVE` banners.

---

## Table of Contents

1. [Why this exists (problem statement)](#1-why-this-exists)
2. [PCC current-state audit (with file cites)](#2-pcc-current-state-audit)
3. [The RTP baseline — what we must match](#3-the-rtp-baseline)
4. [SOTA survey of transports](#4-sota-survey)
5. [Comparison table — OSS options rated vs RTP](#5-comparison-table-rated-vs-rtp)
6. [Recommended PCC-native design](#6-recommended-pcc-native-design)
7. [Illustrative interfaces & schemas](#7-illustrative-interfaces--schemas)
8. [Migration path](#8-migration-path)
9. [Open questions](#9-open-questions)
10. [Appendix — research notes & sources](#10-appendix)

---

## 1. Why this exists

PCC today treats a "kernel" as a thing the gateway can reach over **public HTTPS**. The SDK literally
refuses to build a manifest unless the kernel advertises an `https://` URL
(`packages/kernel-sdk/src/manifest-builder.ts:61-67`). That assumption excludes most of the physical
world we want to onboard:

| Device class | Why HTTPS-only fails it |
|---|---|
| **LAN-only robots** (ROS2 arms, lab instruments behind a home/factory router) | No public IP, no port-forward; sit behind NAT. |
| **ESP32 / Arduino-class microcontrollers** | Often no TLS stack, tiny RAM; cannot host an HTTPS server. |
| **Drones with intermittent links** | Offline for minutes-to-hours; a synchronous request/response dies. |
| **Wallet-addressed devices** | Identified by an on-chain address, not a DNS name; want crypto-native messaging. |

RTP solves *reachability* for these classes with four "connection types" (`webhook`, `xmtp`,
`wifi-relay`, `websocket`) but stops there: its result path is an **unsigned HTTP POST** and escrow
releases on the operator's self-reported `status: "COMPLETED"` (see §3). PCC's whole value is the
opposite — **cryptographically verifiable physical work**. So the abstraction we need is not just
"reach the device"; it is **"reach any device class over a pluggable transport while preserving the
signed evidence/provenance chain end-to-end."** That last clause is the entire differentiator.

---

## 2. PCC current-state audit

This section establishes *exactly* how a kernel receives work and returns results today, and which
transports already exist, before proposing anything. Citations are repo-relative paths from the
audit (`docs/rtp-absorption/research-notes/pcc-audit-*.md`).

### 2.1 How a kernel receives work today — three coexisting models

There is **no single canonical inbound path**. Three models live in the tree:

**Model A — gateway-embedded (production default).** The gateway instantiates `@pcc/kernel`
in-process. A job arrives at `POST /api/jobs/submit`, flows through the JobFacade, and is executed by
an in-process `JobRunner` — no network hop to a "kernel." Critically, when
`job.kernelId !== localKernelId` the facade detects an **external kernel**, writes the job to the DB
as `queued`, and returns — **with no dispatch mechanism to actually reach that remote kernel**
(`packages/gateway/src/facades/job.facade.ts` external-kernel branch, ~`:255-285`). This is the
single biggest hole: *PCC has no way to push a job to a kernel that isn't itself.*

**Model B — standalone HTTP kernel.** `packages/kernel/src/server.ts` is a Fastify server that
accepts `POST /execute {capabilityId, jobId, gcodeHash, assuranceTier}` and stores the resulting
bundle in an in-RAM `Map<jobId, bundle>` for the caller to poll. It does not register with, heartbeat
to, or subscribe to the gateway — a purely passive push receiver on a public port.

**Model C — A2A agent bus.** `packages/agent-kernel` (`KernelAgent`) subscribes to an A2A
`MessageBus`. When networked, `NetworkedBus`/`NetworkTransport` opens a WebSocket to
`ws://relay/ws/a2a?agentId=…` and auto-reconnects (`packages/a2a/src/network-transport.ts`). Inbound
intents (`execute_job`, `request_quote`, …) dispatch to handlers, and completion is sent back as a
`job_completed` intent carrying `evidenceBundleHash`.

**The SDK spine (verified first-hand).** Third-party kernels are built with `@pcc/kernel-sdk`:

- `buildManifest()` — **hard-codes `endpointURL` must start with `https://`**
  (`packages/kernel-sdk/src/manifest-builder.ts:61-67`). This is the SDK-level HTTPS coupling.
- `createKernelHandler()` — a *server-side request handler* the kernel exposes. It verifies an
  optional Ed25519 caller session signature, runs `execute(input)`, assembles an `EvidenceBundle`,
  signs it, and returns it **synchronously as the HTTP response**
  (`packages/kernel-sdk/src/job-handler.ts:127-359`). The model is therefore *gateway pushes → kernel
  responds in the same request*.
- `registerKernel()` — a thin `fetch` wrapper doing `POST ${gatewayUrl}/api/kernels/register`
  (`packages/kernel-sdk/src/register.ts:50-110`). Assumes kernel→gateway HTTPS reachability.
- `verifyBundleSignature(bundle, sessionPublicKey)` — Ed25519 verify of the bundle
  (`packages/kernel-sdk/src/job-handler.ts:362-373`).

So at the SDK level the contract is: **a kernel is an HTTPS endpoint the gateway calls; results come
back in the HTTP response.** Everything in this document exists to break that single assumption
without breaking the evidence guarantees.

### 2.2 How results & evidence are produced (the thing we must protect)

The evidence model is mature and is the asset to preserve across any transport (verified first-hand):

- **`EvidenceBundle`** (`packages/spec/src/types/evidence.ts:118-132`): `{ id, jobId, stepId,
  kernelId, assuranceTier, events[], bundleHash, kernelSignature, createdAt }`.
- **`EvidenceEvent`** (`:101-110`): `{ id, type, timestamp, source{deviceId,deviceType,kernelId,
  firmwareVersion?}, payload, hash }`, where `hash = sha256(canonicalize({type,timestamp,source,
  payload}))`.
- **`bundleHash = sha256(canonicalize(events.map(e=>e.hash).sort()))`** — order-independent because
  it sorts event hashes (`job-handler.ts:332-333`).
- **Kernel signing** (`job-handler.ts:182-351`): the kernel mints a fresh Ed25519 *session* keypair
  per job, authorizes it with the persistent `principalPrivateKey`, and signs the `bundleHash` with
  the session key. The session public key is returned **out-of-band** in
  `KernelJobResponse.kernelSessionPublicKey`.
- **Tier requirements** `DEFAULT_TIER_REQUIREMENTS` (`evidence.ts:168-211`): tiers 0–3 require
  specific event types (e.g. tier 1 needs `power_profile_summary`; tier 3 needs `tee_attestation`).
- **Anti-replay**: `WorkflowChallenge` + `ExecutionProof` + `BlockAnchor` (`evidence.ts:143-165`).
- **Verification**: `packages/verifier/src/evidence-verifier.ts` recomputes the bundle hash and each
  event hash, checks tier requirements, duration/power consistency, optional challenge freshness, and
  emits a signed `VerificationAttestation`. Multi-verifier **Yuma consensus** (stake-weighted median,
  outlier penalties) lives in `packages/verifier/src/network/consensus-engine.ts`.
- **On-chain tier bridge**: EAS off-chain EIP-712 attestations
  (`packages/attestations/src/off-chain.ts`, schema `"address bridgeMaintainer,uint8 tier,bytes32
  evidenceCID"`).
- **ALCOA+** (10 principles) is the integrity rubric (`docs/AGENT_INTEGRATION.md §7`); "Original"
  specifically means *kernel signature present, not test-signed* (test signer emits `test_sig_…`).

### 2.3 Transports that already exist in PCC

| Transport primitive | Where | What it is | Carries job/evidence payloads? |
|---|---|---|---|
| **HTTPS request/response** | `kernel-sdk`, `kernel/server.ts`, `gateway` | The default. Gateway → kernel push, synchronous bundle response. | Yes (the only real one today). |
| **`CoreTransport` (WebSocket)** | `packages/dht-core/src/transport.ts:63-221` | WS server+client with `listen/connect/adoptSocket/send/broadcast`. `CoreMessage{protocol,payload}` **multiplexes protocols on one socket** (`:31-36`). | Frame transport only; today carries gossip (`/pcc/cap-gossip/1.0.0`). **No store-and-forward** — `send()` drops if socket not OPEN (`:131-138`). |
| **Flood-gossip DHT** | `packages/dht` | Custom gossip (announce/query/query_result) over `CoreTransport`, live at `wss://capability.network/ws/dht`. | **Discovery/metadata only** — there is no DHT message type that gossips a job or an evidence blob. |
| **A2A bus** | `packages/a2a` | `A2AMessage{from,to,intent,signature?,encrypted?}`; backends InMemory / NATS JetStream / `NetworkTransport` (HTTP `POST /api/a2a/send` + `WS /ws/a2a`). | Yes, by hash-reference (`job_completed.evidenceBundleHash`). Relay queues only **100 msgs in-RAM** per offline agent (no durable store-and-forward). |
| **MCP server** | `packages/mcp-server` | 56 stdio JSON-RPC tools that proxy HTTP to the gateway. | Caller-side query interface; **not** a kernel-facing dispatch channel. |
| **Federation** | `packages/federation` | Phase-1 **CRDT scaffolding** (`PhaseOneReplicator.start()` is a no-op). | No network traffic yet; `Region` interface is the Phase-2 seam. |

### 2.4 Cryptographic primitives that already exist (reuse candidates)

- **Ed25519 `sign(data,sk)` / `verify(data,sig,pk)`** — pure, transport-agnostic, base64 sigs / hex
  keys (`packages/a2a/src/crypto.ts:78-91`). **This is the reusable hop-signing primitive.**
- **X25519 `encryptMessage`/`decryptMessage`** (NaCl box) (`crypto.ts:37-73`); `EncryptedBus` wraps
  any `{send,subscribe}` bus.
- **ES256 (P-256) JWS AgentCard signing** with **RFC 8785 JCS** canonicalization + JWKS
  (`packages/a2a-signing/src/{sign-card,verify-card,key-management}.ts`).
- **Wallet → identity**: `AgentCard.walletAddress` (`packages/a2a/src/types.ts:36`); `did:pkh`
  resolver, zero network calls (`packages/identity/src/methods/pkh.ts:88`); ERC-8004
  `IdentityRegistryClient.getAgentWallet(agentId)` on Base Sepolia (`packages/identity-8004`).
- **Adapter registry** `registerMachineAdapter(type, factory)` / `registerAdapter("namespace", …)`
  (`@pcc/kernel` adapter-factory; sanctioned extension point per `docs/EXTENDING_PCC.md`). **The
  transport registry should mirror this exact shape.**
- **Bundle storage CID** path (`docs/CID_STORAGE.md`, `@pcc/workflow` event store has a
  `kernel_signature`/CID slot).

### 2.5 PCC HAS vs LACKS — the honest ledger

**PCC already HAS:**

1. A complete, signed, content-addressed **evidence model** + verifier + multi-verifier consensus +
   on-chain tier attestations (§2.2). *RTP has none of this.*
2. A reusable **WebSocket frame transport with protocol multiplexing** (`CoreTransport`/`CoreMessage`)
   already wired into the gateway.
3. A reusable **A2A messaging layer** with an optional per-message signature slot and pluggable
   backends (InMemory / NATS / network).
4. Transport-agnostic **Ed25519 sign/verify** and **X25519 encryption** primitives.
5. **Wallet/DID identity** resolution (`did:pkh`, ERC-8004) — the raw material for wallet-addressed
   devices.
6. A proven **plugin-registry pattern** (`registerAdapter`) to copy for transports.
7. Per-job **session-key** signing and **challenge/proof** anti-replay scaffolding.

**PCC LACKS (the gap this design closes):**

1. **A `KernelTransport` interface.** Every inbound/outbound path is hard-bound to its concrete
   transport. There is no abstraction a new transport could implement.
2. **External-kernel dispatch.** The facade detects a remote kernel and then *does nothing*
   (`job.facade.ts:~255-285`). There is no dispatcher, no outbound-pull client, no queue.
3. **Non-HTTPS registration.** `manifest-builder.ts:61` forbids anything but `https://`.
4. **Store-and-forward / durable offline queue.** `CoreTransport` drops on closed socket; A2A relay
   caps at 100 in-RAM messages. Nothing survives a restart or a multi-hour drone outage.
5. **Wallet-addressed transport.** Identity exists; there is no XMTP/DIDComm client, and no
   wallet → endpoint resolution step.
6. **A transport-neutral envelope** that co-delivers the kernel session pubkey, anti-replay nonce, and
   CID refs so evidence stays verifiable off the HTTP happy-path.
7. **Auto-signing + signature-verification middleware** — `A2AMessage.signature` is optional and
   never set or checked automatically.
8. **Fragmentation/reassembly** for constrained links (an EvidenceBundle ≫ a LoRa/MQTT-SN frame).
9. **NAT traversal / reverse reachability** for LAN-only kernels.

---

## 3. The RTP baseline

RTP ("Robot Task Protocol", Spraay Protocol, MIT, draft 2026 — `github.com/plagtech/rtp-spec`) is the
thing to beat. Architecture: an **agent** sends a **Task Envelope** (capability verb, free-form params,
x402 payment proof, callback URL) to a **Gateway**, which validates payment, escrows funds, and routes
to a registered robot via one of four connection types; the robot returns a **Result Envelope**
(status, output string, data object, duration); the gateway releases escrow and fires the agent's
callback. Devices are addressed by `rtp://{gateway}/{robot_id}` and discovered via
`.well-known/x402.json`.

### 3.1 RTP's four connection types

| RTP type | Delivery | Result return | NAT / offline | Best-fit device class |
|---|---|---|---|---|
| **webhook** | Gateway HTTPS-POSTs the Task Envelope to the operator's `webhookUrl`, signed with HMAC-SHA256 (`X-RTP-Signature`). | Robot POSTs Result Envelope to `POST /robots/{id}/complete` (plain HTTP, **unsigned**). | None — robot needs a public HTTPS endpoint. | Internet-connected servers, RPi, industrial robots behind an "external server". The universal fallback. |
| **xmtp** | Gateway sends the envelope via XMTP to the robot's registered wallet address. | Via XMTP reply or gateway POST. | XMTP is store-and-forward; the wallet address is a permanent inbox. | Wallet-addressed robots, drones with companion computers. |
| **wifi-relay** | Gateway sends to an operator-hosted `relayUrl`; config carries `localAddress: "192.168.x.x:3100"`. | Gateway `…/complete`. | Operator's relay bridges internet→LAN. **The relay protocol itself is undefined** in the spec. | LAN robots without public IPs. |
| **websocket** | Gateway pushes the envelope over a persistent WSS the operator hosts. | Over the same socket (implied). | **No reconnection/keepalive specified.** | Low-latency bidirectional control. |

### 3.2 RTP's verification model — the gap

**RTP has no result-integrity model whatsoever.** The Result Envelope is an unsigned HTTP POST;
`result.data` is unvalidated free-form JSON; **escrow releases solely on the operator's self-reported
`status:"COMPLETED"`.** An operator can claim completion for work never done and get paid. There are no
evidence bundles, CIDs, signatures-over-results, attestations, tiers, ALCOA, drift detection, or ZK
proofs anywhere in the spec. (Source: `research-notes/rtp-spec-study.md`.)

### 3.3 The RTP capability checklist PCC must cover

To "match-or-beat", a PCC transport layer must provide all of: standardized task + result envelopes;
a task lifecycle state machine; escrow-backed pay-per-task with auto-refund on timeout; a resolvable
device URI; a well-known discovery doc; a filterable registry; HMAC-or-better signed inbound delivery;
the four connection styles (webhook, wallet-addressed, LAN-relay, websocket); custom-capability
extension; replay protection; operator auth. **PCC then adds, on top of every one of those:** signed
result envelopes, evidence bundles with CIDs, assurance tiers 0–3, ALCOA+, drift detection, ZK proofs
(tier 3), multi-verifier attestation, and on-chain dispute input. The rest of this document is how we
get all of that through a pluggable transport.

---

## 4. SOTA survey

Twelve+ technologies were studied clean-room across five domains (full notes:
`research-notes/sota-survey-1.md`, `sota-survey-2.md`). Summaries below; ratings consolidated in §5.

### 4.1 Pub/sub & IoT messaging

- **MQTT 5.0 (+ MQTT-SN)** — Broker-based pub/sub; **outbound-initiated TCP clears every NAT**; QoS 1/2
  + **persistent sessions** + retained messages + Last-Will give real store-and-forward; MQTT-SN runs
  on 8-bit MCUs with a 2-byte header and sleep mode; MQTT 5.0 *request/response* (Response Topic +
  Correlation Data) maps cleanly onto "dispatch job → receive evidence". Broker treats payload as
  **opaque bytes** → an external signature survives untouched. *Strongest all-round device transport.*
- **CoAP (+ OSCORE, + Observe)** — 4-byte header, great on constrained MCUs; but UDP binding decay
  makes **server-initiated push across NAT fragile** and it has **no native store-and-forward**.
  OSCORE is a good reference for application-layer signing. *Skip as primary; mine for ideas.*
- **AMQP 1.0** — Durable queues; OASIS spec **guarantees the "bare message" is immutable** across
  brokers → ideal for the *backend* gateway→verifier→IPFS pipeline. Too heavy device-side.

### 4.2 Persistent sockets & P2P

- **WebSocket** — Already in PCC (`CoreTransport`, A2A `NetworkTransport`). Outbound-initiated → NAT
  friendly; needs app-level reconnect/heartbeat. *Equal to RTP's `websocket`; we already have it.*
- **WebRTC data channels** — True P2P with ICE/STUN/TURN; heavy stack, ESP32-S3/PSRAM only, full ICE
  re-negotiation on reconnect. *Narrow niche (kernel-to-kernel streaming); not a general device
  transport.*
- **libp2p** — Production transport substrate: **DCUtR hole-punching + Circuit Relay v2** (NAT
  traversal without frp/ngrok), AutoNAT, GossipSub, multiaddr, PeerID = public-key identity. *Directly
  overlaps PCC's `dht`/`federation` ambitions; the most "absorb the substrate" option.*

### 4.3 Reverse tunnels / NAT bypass

- **frp** (Apache-2.0, self-hostable) — outbound TCP tunnel + optional STUN punch (XTCP); makes an
  outbound-only LAN box fully addressable. *Best self-hosted reverse tunnel.*
- **cloudflared** (Apache-2.0 client, but **requires Cloudflare**) — outbound QUIC, 100% NAT-agnostic,
  enterprise auth policies; **not self-hostable end-to-end.**
- **ngrok** (proprietary SaaS) — best DX, port-443 outbound; sovereignty cost.

### 4.4 Decentralized / wallet-addressed

- **XMTP** — Wallet-to-wallet messaging; **InboxID** lets one device hold multiple wallets; **~60-day
  message store** (offline inbox); MLS group encryption (forward secrecy); ERC-4337 smart-wallet
  support. *Strictly better than RTP's `xmtp` conn type for the wallet-addressed class.* Caveat:
  60-day TTL ≠ permanent evidence archive (anchor to IPFS).
- **DIDComm v2** (DIF) — **Transport-agnostic** secure messaging (runs over MQTT/WS/HTTP/BLE);
  ECDH-1PU authenticated encryption with Ed25519/X25519; **mediator pattern** = decentralized offline
  delivery. *The cleanest envelope standard for the wallet-addressed class; not tied to one network.*
- **Waku** (libp2p; go-waku/js-waku, MIT) — **Store v3 (≈48h)** = purpose-built store-and-forward for
  **intermittent drones**; Light Push (ACKed publish), Filter (content-topic subscribe), RLN
  (spam-resistance). *Best fit for class (c) intermittent links; pair with IPFS for permanence.*

### 4.5 LAN / robotics / commissioning

- **mDNS + DNS-SD** — Link-local discovery (native on ESP-IDF); the discovery layer beneath any
  `wifi-relay`. *Enabler, not a transport.*
- **Matter / Thread** — Matter's **commissioning + per-fabric certificate** model is a strong lesson
  for device identity onboarding; Thread (802.15.4 mesh, Border Router, Sleepy End Devices) is
  excellent for sub-GHz constrained meshes. *Complementary identity/last-mile layers, not a
  PCC↔gateway transport.*
- **DDS / ROS2** — LAN multicast + rich QoS (reliability/durability/history) + DDS-Security; **NAT-
  hostile**, doesn't survive a bridge. **zenoh** (+ `zenoh-bridge-dds`) fixes the egress problem —
  a zenoh router acts as a cloud relay and bridges ROS2/DDS LAN traffic outward. *Use zenoh as the
  LAN-robot bridge; DDS stays internal to the robot.*

### 4.6 Device-twin / shadow pattern (the assignment model, not a wire)

**AWS IoT Device Shadow** and **Azure IoT Hub Device Twin** converge on the same idea and it is *not*
proprietary — it is ~400 LOC over MQTT + a JSON column:

- Cloud writes **`desired`** state (`desired.currentJob = {jobId, spec, tier, deadline}`).
- Device, on (re)connect, reads the **delta** and acts — *so an offline drone picks up its job when it
  comes back*.
- Device writes **`reported`** state (`reported.currentJob = {status, evidenceCid, signature}`).
- **Version numbers** make delivery stale-proof (out-of-order messages are safely discarded).

This is the right **job-assignment abstraction** because it makes "online push" and "offline pull"
the *same* model, which is exactly what unifies our four device classes.

---

## 5. Comparison table — OSS options rated vs RTP

"Rating vs RTP" answers: *for PCC's needs (reach the device **and** preserve signed evidence), is this
option WORSE / EQUAL / BETTER than the corresponding RTP connection type?* Only EQUAL-or-better options
are recommended as PCC transport implementations.

| Option | RTP analog | NAT traversal | Offline / store-fwd | ESP32 fit | Preserves external sig? | Self-host / License | **vs RTP** |
|---|---|---|---|---|---|---|---|
| **MQTT 5.0 / MQTT-SN** | wifi-relay | Excellent (outbound TCP) | **Excellent** (QoS 1/2, persistent session, LWT) | **Excellent** (SN on 8-bit) | Yes (opaque payload) | Yes / EPL-2.0 (Mosquitto) | **BETTER** |
| **WebSocket (persistent)** | websocket | Excellent (outbound upgrade) | None native (app reconnect) | Marginal (TLS heavy) | Yes (opaque frame) | Yes / — (in PCC) | **EQUAL** |
| **libp2p (Circuit Relay v2 + DCUtR)** | wifi-relay / websocket | **Excellent** (hole-punch + relay) | None native (needs Waku layer) | Marginal | Yes (opaque) | Yes / MIT-Apache | **BETTER** |
| **Waku (Store v3)** | *(none — intermittent)* | Good (libp2p relay) | **Excellent** (≈48h store) | No (gateway-side) | Yes (opaque + `meta`) | Yes / MIT | **BETTER** (for drones) |
| **XMTP** | xmtp | Network-handled | **Good** (~60-day store) | No (gateway-side) | Yes (payload preserved) | Partial (decentralizing) | **BETTER** |
| **DIDComm v2** | xmtp | Per-underlying-transport | Good (mediator) | No native lib | Yes (JWE/JWS) | Yes / open spec | **BETTER** |
| **frp** | wifi-relay / webhook | Excellent (tunnel + STUN) | None | No (gateway host) | Yes (opaque TCP) | **Yes** / Apache-2.0 | **BETTER** |
| **cloudflared** | webhook | Excellent (QUIC) | None | No | Yes (TCP proxy) | No (needs Cloudflare) / Apache client | BETTER reach, **WORSE** sovereignty |
| **ngrok** | webhook | Excellent | None | No | Yes | No / proprietary | **EQUAL** |
| **AMQP 1.0** | *(backend only)* | Excellent (outbound) | Excellent (durable) | No | **Yes (explicit immutability)** | Yes / various | **BETTER** (backend pipeline) |
| **zenoh (+ DDS bridge)** | websocket / wifi-relay | Yes (router relay) | Partial (storage plugin) | Marginal (zenoh-pico) | App payload yes; RTPS sig not across bridge | Yes / Apache+EPL | **BETTER** (LAN-robot egress) |
| **CoAP + OSCORE** | webhook | **Poor** (UDP/NAT) | **None** | Excellent | Yes direct; OSCORE thru proxy | Yes / open | **WORSE** |
| **WebRTC data channel** | *(none)* | Excellent (needs TURN) | None | Poor | Yes (SCTP opaque) | Yes (TURN infra) | **WORSE** (general use) |
| **DDS / FastDDS** | *(LAN-internal)* | **None** (multicast) | Partial (TRANSIENT QoS) | No | Sig doesn't survive bridge | Yes / Apache | **WORSE** (as PCC transport) |
| **mDNS / DNS-SD** | (enables wifi-relay) | None (link-local) | None | Excellent | N/A (discovery) | Yes / open | **EQUAL** (enabler) |
| Device-twin/shadow (AWS/Azure) | *(pattern)* | n/a | **pattern for offline pull** | n/a | n/a | pattern (re-implement on MQTT) | **adopt the pattern** |

### 5.1 Mapping RTP's four types → recommended PCC transports

| RTP connection type | PCC transport (this design) | Recommended concrete implementation | Why it beats RTP |
|---|---|---|---|
| `webhook` | **`https`** (back-compat) + **`reverse-tunnel`** | Existing HTTPS handler; frp/cloudflared or libp2p Circuit Relay for outbound-only kernels | Adds NAT reach **and** a signed Dispatch/Result envelope instead of unsigned POSTs. |
| `wifi-relay` | **`lan-relay`** | mDNS discovery + local **MQTT broker** (or a small relay) bridging to gateway | RTP leaves the relay protocol undefined; PCC defines a signed, QoS-backed one. |
| `websocket` | **`persistent-websocket`** | Reuse `CoreTransport`/A2A `NetworkTransport` + add reconnect/backoff + a `/pcc/job-dispatch/1.0.0` protocol | RTP specifies no reconnect/keepalive; PCC does, and signs the channel. |
| `xmtp` | **`decentralized`** | **XMTP or DIDComm v2** for addressing/transport + **Waku Store** for intermittent backlog | Adds MLS/mediator offline delivery + threads the kernel-signed evidence bundle as payload. |

---

## 6. Recommended PCC-native design

### 6.1 Design principles

1. **One interface, many transports.** Introduce a `KernelTransport` plugin interface and a
   `TransportRegistry` that mirrors the existing `registerAdapter(...)` pattern
   (`docs/EXTENDING_PCC.md`). Transports are chosen per-kernel from its manifest `connection` spec.
2. **The transport is a dumb pipe; the payload is sacred.** A transport **moves bytes and never
   inspects, re-serializes, or re-signs the inner signed payload.** This is non-negotiable and is the
   only way the evidence chain survives arbitrary hops (see invariants, §6.4).
3. **Reuse before build.** Reuse `CoreTransport` (frame transport + protocol mux), `a2a` `sign/verify`
   (hop signatures), `did:pkh`/ERC-8004 (wallet addressing), the `EvidenceBundle`/verifier untouched.
   Add only: the interface, the envelope, a durable queue, NAT/relay glue, and the wallet transport.
4. **Push and pull are the same model.** A **device-twin/shadow** (`desired`/`reported`) sits above
   the transport so "online push" and "offline pull on reconnect" are unified — this is what makes
   intermittent drones first-class.
5. **Opt-in, zero-break.** Today's `https` kernels keep working unchanged; `connection` defaults to
   `{type:"https"}` derived from the existing `endpointURL`.

### 6.2 Layered architecture

```
ILLUSTRATIVE — conceptual layering, not a module map

 ┌──────────────────────────────────────────────────────────────────────┐
 │ L4  Evidence / Provenance      EvidenceBundle (kernel-signed, UNTOUCHED) │  ← @pcc/spec + verifier (unchanged)
 ├──────────────────────────────────────────────────────────────────────┤
 │ L3  Job Semantics (Shadow)     desired/reported twin, tier, challenge   │  ← new, transport-neutral
 ├──────────────────────────────────────────────────────────────────────┤
 │ L2  Transport Envelope         signed hop, nonce, sessionPubKey, cidRefs│  ← new (the contract)
 ├──────────────────────────────────────────────────────────────────────┤
 │ L1  KernelTransport plugin     https | persistent-websocket | lan-relay │  ← new interface; impls reuse CoreTransport, XMTP, MQTT…
 │                                | reverse-tunnel | decentralized          │
 ├──────────────────────────────────────────────────────────────────────┤
 │ L0  Wire                       TCP/TLS, WS, MQTT, libp2p, XMTP, Waku     │  ← OSS, clean-room studied
 └──────────────────────────────────────────────────────────────────────┘
```

L4 is exactly today's evidence bundle, **byte-for-byte unchanged**. L2 is the new contract that lets
L4 ride any L1 transport while staying verifiable. L3 makes offline devices first-class.

### 6.3 The five transports

| Transport `type` | Who initiates | Solves | Reuses | Builds |
|---|---|---|---|---|
| `https` *(default, = RTP webhook)* | Gateway → kernel | back-compat | `kernel-sdk` handler | nothing |
| `persistent-websocket` *(= RTP websocket)* | **Kernel → gateway** (outbound) | NAT for always-on LAN robots | `CoreTransport` + `CoreMessage` mux, A2A `NetworkTransport` | reconnect/backoff, `/pcc/job-dispatch/1.0.0`, dispatcher (fills `job.facade.ts` gap) |
| `lan-relay` *(= RTP wifi-relay)* | Relay ↔ gateway; device ↔ relay (LAN) | LAN devices + ESP32 | mDNS, MQTT/MQTT-SN broker, `CoreTransport` | relay protocol, fragmentation for SN |
| `reverse-tunnel` | Kernel dials out | NAT without app changes | — | frp/cloudflared **or** libp2p Circuit Relay v2 + DCUtR adapter |
| `decentralized` *(= RTP xmtp, + intermittent)* | Network-mediated | wallet-addressed + intermittent drones | `did:pkh`/ERC-8004, X25519/Ed25519 | XMTP **or** DIDComm v2 client; Waku Store light node; wallet→endpoint resolver |

### 6.4 Threading signed evidence & provenance through *every* transport

This is the heart of the design and the thing RTP cannot do. The transport carries a **`TransportEnvelope`**
that *wraps* PCC's existing signed payloads. The rules below are derived directly from the verifier's
requirements (`research-notes/pcc-audit-docs-evidence.md`) and are the **transport conformance spec**:

**Inner payload (untouched):**
- A **`DispatchPayload`** (gateway→kernel) is canonicalized and **signed by the dispatcher** (Ed25519
  via `a2a/crypto.ts:sign`), binding `{jobId, capabilityId, params, assuranceTier, challenge}`.
- A **`ResultPayload`** (kernel→gateway) **contains the `EvidenceBundle` exactly as
  `createKernelHandler` produces it** — `bundleHash` and `kernelSignature` are computed once at the
  kernel and never recomputed in transit.

**Transport conformance invariants (a transport is non-compliant if it violates any):**

1. **Signature bit-integrity** — `kernelSignature.value` and every `event.hash` arrive bit-identical.
2. **Byte-identity of hashed fields** — `{type,timestamp,source,payload}` per event must not be
   re-normalized (no key reordering, whitespace, or Unicode changes). Wire encoding is **canonical
   JSON, or CBOR that round-trips losslessly to the same canonical bytes** (`docs/STANDARDS.md`
   sanctions CBOR for constrained transports).
3. **Event completeness** — no dropped events (missing events fail both hash and tier checks).
4. **Timestamp preservation** — no clock/precision normalization (breaks contemporaneity + duration).
5. **No relay re-signing** — relays MUST NOT replace `kernelSignature`; ALCOA+ "Original" requires the
   original kernel signature. Relay integrity goes in a **separate envelope layer** (`hops[]`), never
   the bundle.
6. **Session pubkey co-delivery** — `verifyBundleSignature` needs the session pubkey, which is **not**
   inside `EvidenceBundle`. The envelope carries `sessionPubKey` (or it is resolvable from the manifest).
7. **Anti-replay co-delivery** — if a `WorkflowChallenge` was issued, the `ExecutionProof` rides along,
   within `maxAgeSeconds`.
8. **CID resolvability** — for ALCOA+ Enduring/Available, large blobs are uploaded first and the
   envelope carries `cidRefs`; the gateway fetches them (also the **fragmentation** mechanism for
   MQTT-SN/LoRa: chunk → CID → reassemble).
9. **Replay dedup** — envelope `nonce` + `jobId` let the gateway reject duplicates (note: the evidence
   submit endpoint does **not** dedup by `bundle.id` today — close this at the same time).
10. **Hop provenance (additive)** — each relay MAY append a signed `HopAttestation` (its own Ed25519
    sig over `{prevHopHash,nonce,ts}`) forming a verifiable relay chain *around* — never *over* — the
    sealed bundle.

The effect: **a bundle that arrives over MQTT, Waku, XMTP, or a frp tunnel verifies identically to one
that arrived over HTTPS**, because the verifier only ever sees the untouched inner bundle, and the
transport adds provenance in a disjoint layer. *That* is "everything RTP does, plus signed evidence."

### 6.5 Per-device-class playbook

| Class | Transport | Addressing | Offline story | Evidence path |
|---|---|---|---|---|
| **LAN-only robot** | `persistent-websocket` (kernel dials out) or `reverse-tunnel` | `did:pcc:<slug>` + gateway-issued kernel ID | Reconnect/backoff; shadow `desired` replays missed job on reconnect | Bundle signed at kernel, streamed over the same WS as a `ResultPayload`. |
| **ESP32 / Arduino** | `lan-relay` (MQTT-SN → local broker → gateway) | broker topic `kernel/{id}` (wallet as ClientID optional) | MQTT persistent session + QoS 1/2 | Device emits minimal events; **relay or companion signs** the bundle (key custody, see open Q); large blobs → CID fragmentation. |
| **Intermittent drone** | `decentralized` (Waku Store light node) + shadow | content-topic from kernel ID; optional wallet | **Waku Store (≈48h)** holds dispatch until reconnect; shadow version guards staleness | Companion computer signs bundle on landing; Light Push with ACK; IPFS anchor for permanence. |
| **Wallet-addressed** | `decentralized` (XMTP/DIDComm) | `did:pkh:eip155:…` → ERC-8004 → inbox | XMTP ~60-day inbox / DIDComm mediator | Bundle is the MLS/JWE payload; wallet key signs the hop; kernel session key still signs the bundle. |

---

## 7. Illustrative interfaces & schemas

> **These are discussion sketches, not source files.** Names/shapes are intentionally aligned with
> existing PCC types (`@pcc/spec`, `a2a/crypto`) so reviewers can judge fit. Do not paste into the tree.

### 7.1 The `KernelTransport` plugin interface

```ts
// ILLUSTRATIVE — proposed @pcc/kernel-sdk surface (NOT real source)

export type TransportType =
  | "https"                // back-compat (RTP: webhook)
  | "persistent-websocket" // RTP: websocket
  | "lan-relay"            // RTP: wifi-relay
  | "reverse-tunnel"       // (new) frp / cloudflared / libp2p relay
  | "decentralized";       // RTP: xmtp (+ Waku for intermittent)

export interface KernelTransport {
  readonly type: TransportType;

  /** Kernel side: begin receiving DispatchEnvelopes. Returns an unsubscribe fn. */
  listen(onDispatch: (env: TransportEnvelope) => Promise<void>): Promise<() => void>;

  /** Gateway/dispatcher side: deliver a (already-signed) dispatch to a kernel address. */
  send(to: KernelAddress, env: TransportEnvelope): Promise<DeliveryReceipt>;

  /** Durability hint so the dispatcher can pick a transport for an offline kernel. */
  readonly capabilities: {
    storeAndForward: boolean;   // MQTT QoS / Waku Store / XMTP inbox
    bidirectional: boolean;     // WS / libp2p stream
    maxFrameBytes: number;      // triggers cidRefs fragmentation below this
    natTraversal: "none" | "outbound-initiated" | "relay" | "holepunch";
  };
}

// Mirrors registerAdapter(...) from @pcc/kernel (docs/EXTENDING_PCC.md)
export function registerTransport(type: TransportType, factory: TransportFactory): void;
```

### 7.2 The `TransportEnvelope` (the contract that preserves evidence)

```ts
// ILLUSTRATIVE — the transport-neutral wrapper (NOT real source)

export interface TransportEnvelope {
  v: 1;
  transport: TransportType;
  msgType: "dispatch" | "result" | "ack" | "shadow_delta";
  to: KernelAddress;            // kernelId | did:pcc:… | did:pkh:eip155:… | peerId
  from: string;
  nonce: string;                // anti-replay (invariant 9)
  ts: string;                   // RFC3339; hop time, NOT evidence time

  /**
   * OPAQUE inner payload. For msgType:"result" this is the EvidenceBundle EXACTLY as
   * createKernelHandler produced it (packages/kernel-sdk/src/job-handler.ts:337-351).
   * Canonical JSON, or CBOR that round-trips to identical canonical bytes (invariant 2).
   */
  payload: unknown;
  payloadHash: string;          // sha256(canonical(payload)) — for fast integrity pre-check

  /** Provenance of THIS hop. Ed25519 via a2a/crypto.ts:sign over (payloadHash|nonce|ts|to|from). */
  senderSig: { alg: "ed25519"; signer: string; value: string };

  /** Co-delivered so verifyBundleSignature() can run off-HTTP (invariant 6). */
  sessionPubKey?: string;

  /** Anti-replay proof when a WorkflowChallenge was issued (invariant 7). */
  executionProof?: ExecutionProof;     // from @pcc/spec

  /** Large/blobby evidence uploaded out-of-band; gateway fetches & reassembles (invariant 8/fragmentation). */
  cidRefs?: { cid: string; bytes: number; part?: [number, number] }[];

  /** Relay chain — each hop appends; NEVER touches payload or kernelSignature (invariant 5/10). */
  hops?: { relay: string; ts: string; prevHopHash: string; sig: string }[];
}
```

### 7.3 The kernel `connection` spec (replaces the `https://`-only manifest field)

```ts
// ILLUSTRATIVE — proposed manifest change (NOT real source)
// Replaces the hard `endpointURL.startsWith("https://")` guard
// at packages/kernel-sdk/src/manifest-builder.ts:61-67

export type ConnectionSpec =
  | { type: "https"; url: `https://${string}` }                       // back-compat default
  | { type: "persistent-websocket"; dialOut: `wss://${string}`; protocol: "/pcc/job-dispatch/1.0.0" }
  | { type: "lan-relay"; relayId: string; broker: { mqtt: string; topic: string } }
  | { type: "reverse-tunnel"; provider: "frp" | "cloudflared" | "libp2p"; ref: string }
  | { type: "decentralized"; address: `did:pkh:${string}` | `xmtp:${string}`;
      store?: "xmtp" | "waku"; mediator?: string };

// buildManifest() would accept `connection: ConnectionSpec`, defaulting to
// { type: "https", url: endpointURL } when only the legacy field is present.
```

### 7.4 Device-twin / shadow (unifies push and offline-pull)

```jsonc
// ILLUSTRATIVE — kernel shadow doc; cloud writes `desired`, kernel writes `reported`
{
  "kernelId": "kernel_drone_alpha",
  "version": 42,                               // stale-guard (discard older deltas)
  "desired":  { "currentJob": { "jobId": "job-7", "capabilityId": "survey",
                                 "assuranceTier": 2, "deadline": "2026-06-23T00:00:00Z" } },
  "reported": { "currentJob": { "jobId": "job-7", "status": "completed",
                                 "evidenceCid": "bafy…", "bundleHash": "sha256:…",
                                 "sessionPubKey": "hex…" } }
}
```

### 7.5 A `result` envelope on the wire (evidence preserved verbatim)

```jsonc
// ILLUSTRATIVE — what arrives at the gateway over MQTT/Waku/XMTP/frp; verifies identically to HTTPS
{
  "v": 1, "transport": "decentralized", "msgType": "result",
  "to": "gateway", "from": "did:pkh:eip155:84532:0xRobot…",
  "nonce": "9f2c…", "ts": "2026-06-22T12:00:05Z",
  "payload": {                                  // ← EvidenceBundle, byte-identical to job-handler output
    "id": "bundle-…", "jobId": "job-7", "kernelId": "kernel_drone_alpha",
    "assuranceTier": 2,
    "events": [ /* each: {type,timestamp,source,payload,hash} — hashes UNCHANGED */ ],
    "bundleHash": "sha256:…",
    "kernelSignature": { "signer": "0x…", "algorithm": "ed25519", "value": "…" },  // ← sealed, never re-signed
    "createdAt": "2026-06-22T12:00:04Z"
  },
  "payloadHash": "sha256:…",
  "senderSig": { "alg": "ed25519", "signer": "did:pkh:…", "value": "…" },          // hop provenance
  "sessionPubKey": "hex…",                                                          // invariant 6
  "hops": [ { "relay": "waku-store-1", "ts": "…", "prevHopHash": "…", "sig": "…" } ]// invariant 5/10
}
```

---

## 8. Migration path

Phased, opt-in, and modeled on the `@pcc/workflow` adoption ladder already used in this repo
(`CLAUDE.md` → "Workflow Runtime"). Each phase is independently shippable; the verifier and evidence
model are **never** modified.

**Phase 0 — Interface + envelope, no behavior change (LOW risk).**
Add `KernelTransport`, `TransportRegistry`, `TransportEnvelope`, and `ConnectionSpec` to
`@pcc/spec` + `@pcc/kernel-sdk`. Implement only the `https` transport, which wraps today's
`createKernelHandler` path. `buildManifest` keeps accepting `endpointURL` and synthesizes
`{type:"https"}`. Add the **transport conformance test suite** (§6.4 invariants) — every future
transport must pass it. *No existing kernel changes.*

**Phase 1 — `persistent-websocket` + the missing dispatcher (MEDIUM risk).**
Implement the transport over `CoreTransport`/`CoreMessage` (new protocol `/pcc/job-dispatch/1.0.0`)
with reconnect/backoff. Add a gateway-side `KernelDispatcher` that fills the dead branch at
`job.facade.ts:~255-285` — when a job targets a connected outbound kernel, dispatch over its socket;
the kernel returns a signed `ResultPayload`. *Solves NAT for always-on LAN robots. In-flight HTTPS
kernels untouched.*

**Phase 2 — Durable queue + shadow + `lan-relay` (MEDIUM risk).**
Add a durable store-and-forward queue (SQLite or a Mosquitto broker) behind the dispatcher; add the
device-twin/shadow doc so a kernel that was offline pulls `desired` on reconnect. Implement `lan-relay`
(mDNS discovery + local MQTT/MQTT-SN broker) and the CID-fragmentation path for constrained frames.
*Brings ESP32/Arduino + restart-survival.*

**Phase 3 — `decentralized` (wallet + intermittent) (MEDIUM risk).**
Add the wallet→endpoint resolver (`did:pkh`/ERC-8004 → XMTP inbox or DIDComm service endpoint), an
XMTP **or** DIDComm v2 client transport, and a Waku Store light node for intermittent backlog. Anchor
evidence to IPFS for permanence beyond the messaging TTL. *Completes the four device classes and the
RTP `xmtp` parity-plus-evidence goal.*

**Phase 4 — `reverse-tunnel` + discovery polish (LOW risk).**
Offer frp/cloudflared adapters and/or a libp2p Circuit-Relay-v2 + DCUtR adapter for operators who want
turnkey NAT bypass. Optionally publish kernel connection metadata via the existing DHT and a
`.well-known` discovery doc to match RTP's discovery surface.

**Rollback:** every transport is a registry entry; disabling one reverts affected kernels to `https`.
Because L4 evidence is unchanged throughout, **no migration can corrupt or invalidate historical
evidence.**

---

## 9. Open questions

1. **Canonicalization unification.** `a2a/crypto.ts:100` signs `JSON.stringify(obj, keys.sort())`
   while `kernel-sdk`/`@pcc/spec` use RFC-8785-style `canonicalize()`, and `a2a-signing` uses true
   JCS. The envelope's `senderSig` and the bundle's `kernelSignature` **must** agree on one
   canonicalization or cross-transport verification will be flaky. *Decide a single canonical form
   (recommend RFC 8785 JCS) before Phase 0 ships.*
2. **Session-pubkey delivery vs. manifest resolution.** Should `sessionPubKey` always ride in the
   envelope (simple, larger frames) or be resolvable from the kernel manifest/identity (smaller
   frames, needs a lookup)? Affects constrained transports most.
3. **Key custody for ESP32/Arduino.** A microcontroller may not be able to hold an Ed25519 key or
   sign canonical JSON. Does the **local relay / companion computer** sign on the device's behalf, and
   if so, how is that delegation represented in `EvidenceSource`/provenance without weakening ALCOA+
   "Attributable/Original"? (Matter's commissioning-certificate model is a candidate.)
4. **CBOR vs JSON hash-stability.** `STANDARDS.md` allows CBOR for constrained links, but the bundle
   hash is defined over canonical JSON. Need a normative rule: CBOR is a *transport encoding* that must
   decode to identical canonical-JSON bytes before hashing.
5. **Async escrow release.** Today escrow logic assumes a timely result. With Waku/XMTP store-and-
   forward, a result may arrive hours later. How do challenge windows (`maxAgeSeconds`, default 600s)
   and escrow timeouts interact with legitimately-delayed intermittent devices?
6. **Relay trust & the `hops[]` chain.** Are relays untrusted carriers (we only trust the inner kernel
   signature) or semi-trusted (their `HopAttestation` counts toward something)? Define what, if
   anything, a hop attestation buys.
7. **Dedup gate location.** The evidence-submit endpoint does not dedup by `bundle.id`. Add dedup at
   the gateway, in the transport (nonce), or both?
8. **Adopt libp2p wholesale, or keep custom `dht-core`?** libp2p would give DCUtR/Circuit-Relay/
   GossipSub for free and collapse identity+routing+transport into PeerID, but it is a large dependency
   and a partial rewrite of `dht`/`federation`. Custom `CoreTransport` is lighter but we build NAT
   traversal ourselves. *Strategic call needed.*
9. **XMTP vs DIDComm for the `decentralized` transport.** XMTP is turnkey + wallet-native but
   centralizing today and TTL-limited; DIDComm is transport-agnostic + decentralized but has no mature
   embedded client. Pick one as primary (recommend DIDComm-over-MQTT for sovereignty, XMTP as a hosted
   convenience option).
10. **Discovery parity.** Do we publish a `.well-known` device-discovery doc + `pcc://` URI scheme to
    match RTP's `.well-known/x402.json` + `rtp://` ergonomics, and if so, does it live on the gateway
    or in the DHT?
11. **Backpressure & DoS on fragmentation.** CID-fragment reassembly is an obvious amplification/DoS
    vector for constrained transports — needs per-kernel quotas and a max-parts cap.

---

## 10. Appendix

### 10.1 Research notes produced this pass (`docs/rtp-absorption/research-notes/`)
- `pcc-audit-kernel.md` — inbound/exec/outbound paths, transport seams (auditor-kernel).
- `pcc-audit-p2p-federation.md` — `dht`/`dht-core`/`federation` reuse map (auditor-p2p).
- `pcc-audit-a2a-mcp.md` — a2a envelope, signing primitives, wallet addressing (auditor-a2a).
- `pcc-audit-docs-evidence.md` — evidence model + the transport MUST-preserve invariants (auditor-evidence).
- `rtp-spec-study.md` — RTP architecture, 4 conn types, verification gap, capability checklist (scout-rtp).
- `sota-survey-1.md` — MQTT/CoAP/AMQP/WS/WebRTC + AWS/Azure twins (scout-sota-a).
- `sota-survey-2.md` — tunnels/relays, XMTP/Waku/libp2p, Matter/Thread, ROS2/DDS/zenoh (scout-sota-b).

### 10.2 Key PCC files cited
- `packages/kernel-sdk/src/{manifest-builder,job-handler,register,index}.ts` *(verified first-hand)*
- `packages/spec/src/types/evidence.ts` *(verified first-hand)*
- `packages/a2a/src/crypto.ts` *(verified first-hand)*; `packages/a2a/src/{types,network-transport,encrypted-bus}.ts`
- `packages/dht-core/src/transport.ts` *(verified first-hand)*; `packages/dht/*`, `packages/federation/*`
- `packages/a2a-signing/src/*`, `packages/identity/src/methods/pkh.ts`, `packages/identity-8004/*`
- `packages/verifier/src/{evidence-verifier,network/consensus-engine}.ts`, `packages/attestations/src/*`
- `packages/gateway/src/facades/job.facade.ts`, `packages/kernel/src/server.ts`, `packages/agent-kernel/*`
- `docs/{ARCH,WORKFLOW_RUNTIME,AGENT_INTEGRATION,EXTENDING_PCC,STANDARDS,CID_STORAGE}.md`

### 10.3 External sources (clean-room; not installed/executed)
RTP: `github.com/plagtech/rtp-spec`, `docs.spraay.app`. MQTT/MQTT-SN: HiveMQ, EMQX. CoAP/OSCORE: RFC
7252, Nordic, EMQ. AMQP 1.0: OASIS messaging spec. WebSocket/WebRTC: RFC 8831, Nabto. Device twins:
AWS IoT Device Shadow docs, Azure IoT Hub C2D guidance. frp: `github.com/fatedier/frp`. cloudflared:
Cloudflare Tunnel docs. ngrok device-gateway docs. XMTP: `docs.xmtp.org`. Waku: `docs.waku.org`,
`blog.waku.org`. libp2p: DCUtR + hole-punching docs. DIDComm v2: DIF spec. Matter: CSA/Silicon Labs.
Thread: OpenThread. ROS2/DDS: design.ros2.org; zenoh: `zenoh.io`, `zenoh-plugin-dds`. (Full URLs in the
scratch notes.)

---

*End of design proposal. No PCC source code was modified in producing this document.*
