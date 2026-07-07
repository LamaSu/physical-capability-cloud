# SOTA Survey 2 — Device Transport Abstraction
# scout-sota-b | Physical Capability Cloud
# Date: 2026-06-22

## Checklist
- [x] Reverse tunnels (frp, cloudflared, ngrok)
- [x] LAN relay / mDNS / local-first discovery
- [x] Decentralized messaging (XMTP, Waku, libp2p)
- [x] Matter & Thread
- [x] ROS2 / DDS / zenoh cloud bridge
- [x] Comparison matrix
- [x] XMTP-vs-RTP-xmtp note
- [x] Waku-for-intermittent-drones note
- [x] PCC dht/federation overlap note

---

## 1. Reverse Tunnels / NAT Bypass

### 1.1 frp (Fast Reverse Proxy)
- **What:** Go binary pair — frps (public server) + frpc (client behind NAT). Apache-2.0.
- **Maturity:** Very mature; v0.69.1 as of June 2026, 113+ releases. Stars ~90k GitHub.
- **Self-hostable:** Yes, fully. frps runs on any Linux VPS.
- **Protocol support:** TCP, UDP, HTTP, HTTPS, STCP, XTCP.
- **Auth:** Token (shared secret) or OIDC Client Credentials.
- **NAT traversal:**
  - Default mode: frpc dials out to frps, frps proxies inbound → works behind any NAT.
  - XTCP mode: P2P hole-punch via STUN (configurable natHoleStunServer). Falls back to server relay if punch fails.
- **Offline/store-and-forward:** None. Connection-oriented. If frpc disconnects, inbound requests fail until reconnect.
- **Constrained device fit:** MARGINAL. Official tiny-frpc (~3.5 MB binary using SSH protocol) targets resource-limited devices. Stock frpc is Go binary, typically 10-20 MB. Not practical for 256 KB ESP32. Can run on Raspberry Pi class (512 MB+) acting as a LAN gateway.
- **Signature preservation:** Fully opaque transport. Application-level signatures in the payload pass through byte-for-byte unmodified.
- **License:** Apache-2.0 (OSS).
- **RTP conn type mapping:** BETTER than RTP webhook (webhook is one-way push, frp makes the device fully addressable). Replaces reverse-proxy use cases.
- **Device class fit:**
  - LAN robot behind NAT: EXCELLENT — this is the primary use case
  - ESP32: NO (binary too large; needs gateway device)
  - Drone intermittent: NO (requires persistent outbound TCP; link drops = broken tunnel)
  - Wallet-addressed: N/A (no on-chain identity concept)

### 1.2 Cloudflare Tunnel (cloudflared)
- **What:** cloudflared agent establishes outbound QUIC/HTTP2 connections to Cloudflare's edge. Traffic terminates at Cloudflare, is filtered by Zero Trust policies, then forwarded through the tunnel.
- **Maturity:** Production-grade, maintained by Cloudflare. Apache-2.0 open-source client.
- **Self-hostable:** NO. Tunnel traffic must flow through Cloudflare's network. Not air-gappable.
- **Auth:** mTLS at edge; Zero Trust policies (IdP, MFA, geo, IP allow/deny); certificate-based for IoT via mutual TLS.
- **NAT traversal:** 100% outbound-only from device perspective; no port-forwarding needed.
- **Offline/store-and-forward:** None. Requests to offline device → 502.
- **Constrained device fit:** MARGINAL. WARP Connector pattern: install on a single Linux gateway node, which then routes the entire subnet. Individual ESP32s are not addressable without a gateway. cloudflared binary is ~50-100 MB; not embeddable.
- **Signature preservation:** Transparent TCP proxy; payload bytes unmodified.
- **License:** Apache-2.0 client; service is SaaS (data passes through Cloudflare).
- **RTP conn type mapping:** BETTER than webhook for enterprise/managed fleets. Not self-hostable — a hard constraint for airgapped labs.
- **Device class fit:**
  - LAN robot behind NAT: GOOD (via WARP Connector subnet routing)
  - ESP32: NO (needs gateway)
  - Drone intermittent: NO (connection-oriented, no store-and-forward)
  - Wallet-addressed: NO

### 1.3 ngrok
- **What:** Cloud-hosted tunnel service with a lightweight agent. Provides stable URLs/TCP ports for local services.
- **Maturity:** Production SaaS, widely deployed. Proprietary service; open-source ngrok-go SDK.
- **Self-hostable:** NO. Proprietary backend. (Alternatives: ngrok-go-based self-hosted, or zrok/Pangolin/Wiredoor as true FOSS alternatives.)
- **Auth:** ngrok account API key; Traffic Policy for JWT, IP allowlists, rate limits at edge.
- **NAT traversal:** Outbound-only agent on port 443; works through any firewall.
- **Offline/store-and-forward:** None.
- **Constrained device fit:** NO for bare embedded. ngrok-go SDK embeddable in Go programs. Not for ESP32/Arduino. "Device Gateway" product specifically for IoT fleet management.
- **Signature preservation:** Transparent; payloads unmodified.
- **License:** Proprietary SaaS. SDK is MIT/Apache. Pricing escalates with fleet size.
- **RTP conn type mapping:** EQUAL to cloudflared for NAT bypass; worse for self-hostability; better for developer ergonomics.
- **Device class fit:**
  - LAN robot behind NAT: GOOD (better DX than frp, worse cost/sovereignty)
  - ESP32: NO
  - Drone intermittent: NO
  - Wallet-addressed: NO

---

## 2. LAN Relay / Local-First Discovery

### 2.1 mDNS + DNS-SD
- **What:** Multicast DNS (RFC 6762) + DNS Service Discovery (RFC 6763). Zero-configuration LAN service advertisement and lookup. No central server.
- **Maturity:** RFC-standardized, shipping in every major OS, ESP-IDF has native mDNS support.
- **Self-hostable:** Built into OS/firmware; no separate server.
- **NAT traversal:** NONE. Explicitly link-local only. Does not cross routers.
- **Offline/store-and-forward:** None (UDP multicast; ephemeral).
- **Constrained device fit:** YES. ESP32 has native mDNS in ESP-IDF. Very low overhead (multicast UDP, no persistent connection).
- **Signature preservation:** Discovery protocol only; not a transport. Application payloads sent over discovered endpoints are unmodified.
- **License:** Open standard.
- **Role in PCC architecture:** First-hop discovery on LAN. Answers "is there a kernel here?" before establishing any transport. Maps to the "announce" step in kernel registration. RTP wifi-relay likely uses mDNS for peer discovery on local segment, then WebSocket for actual data.
- **RTP conn type mapping:** Complements (not replaces) wifi-relay. EQUAL: it's the discovery layer, not transport.
- **Device class fit:**
  - LAN robot: EXCELLENT for discovery
  - ESP32: EXCELLENT for discovery
  - Drone intermittent: MARGINAL (useful on landing/docking)
  - Wallet-addressed: NO (layer mismatch)

### 2.2 Local Broker Pattern (MQTT-style LAN relay)
- **What:** A broker (Mosquitto, EMQX, HiveMQ) runs on the LAN or at network edge. Devices publish/subscribe over TCP. Cloud bridge connects the local broker to a cloud broker.
- **Maturity:** Very mature (MQTT v3.1.1, v5.0 widely supported). EMQX and Mosquitto are OSS.
- **Self-hostable:** YES — Mosquitto ~1 MB binary, runs on Raspberry Pi.
- **NAT traversal:** LAN broker is local-only. Cloud bridge (MQTT bridging or EMQX-to-cloud) punches out via persistent outbound TCP.
- **Offline/store-and-forward:** YES. MQTT QoS 1/2 with persistent sessions: broker queues messages for offline clients; delivered on reconnect. QoS 2 = exactly-once. Session persistence timeout configurable.
- **Constrained device fit:** YES. MQTT client runs on 8 KB RAM devices (ESP32, Arduino with MQTT library). This is the de facto IoT protocol.
- **Signature preservation:** MQTT payloads are opaque bytes. Application-level signatures pass through.
- **License:** Broker-dependent: Mosquitto EPL-2.0 (OSS), EMQX BSL/OSS, HiveMQ commercial.
- **RTP conn type mapping:** BETTER than RTP wifi-relay — MQTT provides QoS and durable sessions that plain WebSocket doesn't. wifi-relay likely bridges WebSocket↔MQTT.
- **Device class fit:**
  - LAN robot: EXCELLENT
  - ESP32: EXCELLENT
  - Drone intermittent: EXCELLENT (QoS 1/2 + persistent session = guaranteed delivery on reconnect)
  - Wallet-addressed: NO (no on-chain identity)

---

## 3. Decentralized Messaging

### 3.1 XMTP
- **What:** Wallet-to-wallet E2E encrypted messaging protocol. Addresses = blockchain wallet addresses (EOA, smart contract wallets, ERC-4337). Uses MLS (IETF RFC 9420) for group encryption.
- **Maturity:** Production (XMTP Labs / Ephemera). Decentralized testnet launched Feb 2025, mainnet in progress. Series B ($20M) Jul 2024.
- **Self-hostable:** PARTIAL. xmtp-node-go is open-source. Current production run by Ephemera. Decentralized node network in progress.
- **Auth/addressing:** Wallet signature proves inbox ownership. Multiple wallet addresses link to one InboxID via cryptographic associations. Supports ENS, ERC-4337.
- **Offline/store-and-forward:** YES. Messages retained 60 days on decentralized network. Offline recipients retrieve from store on reconnect. No "push notification" guarantee — polling or persistent connection required.
- **Constrained device fit:** MARGINAL. libxmtp (Rust) exists; no official ESP32 port. Requires TLS, MLS state machine, and key storage — too heavy for bare microcontrollers. Feasible on gateway-class devices (Raspberry Pi, ESP32-S3 with PSRAM).
- **Signature preservation:** Wallet signatures authenticate XMTP identity/inbox management; they are administrative, not per-message. Application payload is MLS-encrypted opaque blob — if the sender embeds a cryptographic signature in the payload, it passes through unmodified to recipient.
- **License:** MIT/Apache (libxmtp and node).
- **Vs RTP xmtp conn type:** BETTER. RTP xmtp is likely a thin wrapper around XMTP for wallet-addressed job dispatch. Native XMTP gives:
  - Proper MLS group encryption (vs ad hoc)
  - Decentralized relay (vs single XMTP Labs node)
  - 60-day message retention
  - Multi-wallet inbox consolidation
  - Smart contract wallet support (ERC-4337) crucial for wallet-addressed devices
- **Device class fit:**
  - LAN robot: MARGINAL (overkill; heavyweight for local jobs)
  - ESP32: NO (library too heavy)
  - Drone intermittent: GOOD (60-day store handles link outages)
  - Wallet-addressed: EXCELLENT (native use case)

### 3.2 Waku
- **What:** Modular P2P messaging protocol stack built on libp2p. Protocols: Relay (GossipSub-based pub/sub), Filter (selective subscription for light nodes), Store (offline message retrieval), Light Push (low-bandwidth send with ACK), RLN Relay (rate-limited spam-proof relay).
- **Maturity:** Production; used by Status messenger. Waku v2 is stable. go-waku and js-waku maintained by Waku team (formerly Vac/Status).
- **Self-hostable:** YES. Any node can join the Waku network or run isolated.
- **Auth:** No per-node identity concept. RLN Relay adds ZK-proof rate limiting. Message-level encryption is application responsibility (e.g., Noise handshake).
- **NAT traversal:** Inherits libp2p Circuit Relay v2 + DCUtR hole punching. Light nodes (Filter/Light Push) don't relay — they connect to a service node.
- **Offline/store-and-forward:**
  - Store v3: nodes retain messages with configurable retention (default 48h). Light nodes query Store on reconnect.
  - Light Push: ACKs but does NOT guarantee network-wide propagation.
  - Store is best-effort (availability not guaranteed); not exactly-once.
- **Constrained device fit:** MARGINAL. js-waku for browser/Node. go-waku for servers. No native C/C++ port for ESP32. But: a gateway device running go-waku + Waku light protocols could bridge constrained devices.
- **Signature preservation:** Payload is opaque bytes. Waku Message struct has a `meta` field for application-level metadata. Application signatures embedded in payload pass through. No Waku-native per-message signing (application responsibility).
- **License:** MIT (go-waku, js-waku).
- **RTP conn type mapping:** BETTER than any single RTP conn type for the intermittent-link scenario. Uniquely suited for drones:
  - Store (48h default) survives typical drone mission durations
  - Light Push + Filter for bandwidth-constrained RF links
  - Decentralized relay: no single relay failure point
- **Device class fit:**
  - LAN robot: WORSE (overkill; DDS/MQTT better on LAN)
  - ESP32: NO direct; gateway pattern needed
  - Drone intermittent: EXCELLENT
  - Wallet-addressed: MARGINAL (no native wallet addressing; use XMTP instead)

### 3.3 libp2p
- **What:** Modular network stack: transports (TCP, QUIC, WebTransport, WebRTC), multiplexers (yamux, mplex), security (Noise, TLS), peer discovery (DHT, mDNS), routing (Kademlia DHT), pub/sub (GossipSub), NAT traversal (DCUtR, AutoNAT, Circuit Relay v2).
- **Maturity:** Production; used by IPFS, Ethereum, Filecoin, Polkadot. Go, Rust, JS, Python implementations.
- **Self-hostable:** YES (it's a framework, not a service).
- **Auth:** Noise XX protocol with peer ID (Ed25519/secp256k1 keys). PeerID is the address.
- **NAT traversal:**
  - AutoNAT: probes external reachability (like STUN).
  - Circuit Relay v2: fallback relay for unreachable peers; resource-limited (time+byte quotas).
  - DCUtR: upgrades relayed connection to direct via simultaneous TCP/UDP open (hole punching). Signal-based approach uses relay as signaling channel then punches through.
  - Fallback: stays on relay if punch fails.
- **Offline/store-and-forward:** None built-in (Waku Store is the layer that adds this). GossipSub has message cache (IWant/IHave) but not durable.
- **Constrained device fit:** MARGINAL. rust-libp2p compiles to embedded targets with no_std features. py-libp2p under development. Not practical for Arduino (512 KB flash). ESP32 with FreeRTOS + rust-libp2p is theoretically possible but complex.
- **Signature preservation:** PeerID-based authentication at transport layer. Application payloads are opaque. GossipSub message has `from`, `seqno`, and optional `signature` fields (deprecated in favor of application-level signing). Application-level signatures in payload pass through.
- **License:** MIT/Apache (go-libp2p, rust-libp2p, js-libp2p).
- **RTP conn type mapping:** BETTER than websocket/wifi-relay for P2P scenarios. libp2p IS the substrate for many of RTP's decentralized transports.
- **PCC dht/federation overlap:** HIGH — see Section 6.
- **Device class fit:**
  - LAN robot: GOOD (mDNS discovery + direct connection; DCUtR for NAT)
  - ESP32: MARGINAL (rust-libp2p no_std is the path; not trivial)
  - Drone intermittent: MARGINAL (no store-and-forward; needs Waku Store layer)
  - Wallet-addressed: MARGINAL (PeerID ≠ wallet address; needs bridge)

---

## 4. Matter & Thread

### 4.1 Matter
- **What:** Application-layer protocol for smart home/building IoT. Runs over IP (Ethernet, WiFi, Thread). Commissioning via BLE. Fabric-based trust model with X.509 certificates.
- **Maturity:** Production; CSA standard, major industry adoption (Apple, Google, Amazon, Samsung). SDK: connectedhomeip (Apache-2.0).
- **Self-hostable:** YES — Matter controller (commissioner) can be self-hosted (e.g., Home Assistant, chip-tool).
- **Auth/Commissioning:**
  - PASE: SPAKE2+ password-authenticated key exchange using onboarding QR code → establishes initial secure channel.
  - CASE: Certificate-Authenticated Session Establishment for operational communication post-commissioning.
  - Certificates: DAC (Device Attestation Certificate, burned at manufacturing), PAI, PAA chain. NOC (Node Operational Certificate) issued by commissioner and defines fabric membership.
  - DCL: Distributed Compliance Ledger verifies DAC chains.
- **NAT traversal:** Designed for local LAN; cloud access via Matter Controller with cloud bridge (Google Home, Apple Home, etc.). Not self-contained for WAN access.
- **Offline/store-and-forward:** None. Matter is synchronous request-response over LAN.
- **Constrained device fit:** GOOD for ESP32 with sufficient flash. Espressif's esp-matter SDK supports ESP32 natively. Requires ~3MB flash partition (significant). Arduino support exists via esp32-arduino-matter library. Memory-optimized variants use NimBLE (smaller BT stack).
- **Signature preservation:** Per-message AEAD (AES-CCM) authentication between fabric nodes. Application-level payload CAN include additional signatures; they pass through as opaque TLV data.
- **License:** Apache-2.0 (SDK).
- **PCC relevance:** The DAC/NOC/fabric commissioning model is directly applicable to PCC device identity provisioning. Key lessons: (a) two-certificate model (manufacturer cert + network-issued operational cert) maps to PCC's "kernel registration → operator cert"; (b) DCL ledger maps to PCC's on-chain device registry; (c) CASE session establishment with proof-of-possession is a pattern for PCC signed job dispatch.
- **RTP conn type mapping:** NOT a direct replacement. Matter handles device-side protocol only; no RTP conn type equivalent. EQUAL for device provisioning identity, N/A for transport.
- **Device class fit:**
  - LAN robot: GOOD (if robot runs Matter; uncommon in industrial settings)
  - ESP32: GOOD (official SDK support)
  - Drone intermittent: POOR (LAN-centric design)
  - Wallet-addressed: NO

### 4.2 Thread
- **What:** IPv6 mesh networking protocol built on IEEE 802.15.4. Low-power 802.15.4 radio. Border Router bridges Thread mesh to IP network (providing NAT64, mDNS proxy, service discovery). OpenThread is the reference implementation (BSD-3-Clause).
- **Maturity:** Production; chip-level support from Nordic, Silicon Labs, TI, Espressif (ESP32-H2, ESP32-C6).
- **Self-hostable:** YES — OpenThread Border Router on Raspberry Pi.
- **NAT traversal:** Border Router provides NAT64 (Thread devices → IPv4 internet). IPv6 native within Thread mesh.
- **Offline/store-and-forward:** None at Thread layer. MAC-layer ACKs provide reliability on the radio link. No application-layer store-and-forward.
- **Constrained device fit:** EXCELLENT for very constrained devices. Designed for ~64 KB RAM devices. End Devices can sleep and wake (SED - Sleepy End Device), polling parent for buffered messages.
- **Signature preservation:** Thread provides link-layer encryption (AES-CCM) and network-layer mesh authentication. Application payloads are encrypted at link layer but pass through as opaque bytes.
- **License:** OpenThread: BSD-3-Clause.
- **PCC relevance:** Thread directly solves the ESP32/constrained device LAN connectivity problem for devices with 802.15.4 radios. The Border Router pattern (one gateway device, many constrained devices on mesh) maps well to PCC's kernel architecture. Thread's Sleepy End Device model directly addresses intermittent-link constrained nodes. However, Thread is not TCP/IP — devices don't expose a WebSocket endpoint; bridging to PCC API requires an application-layer adapter at the Border Router.
- **RTP conn type mapping:** Complements, not replaces. Thread is below the RTP conn type layer. BETTER than wifi-relay for battery constrained devices on 802.15.4.
- **Device class fit:**
  - LAN robot: MARGINAL (robots typically WiFi/Ethernet; Thread = home/industrial sensors)
  - ESP32: GOOD (ESP32-H2, ESP32-C6 have native Thread support)
  - Drone intermittent: POOR (802.15.4 range ~100m; drone would leave mesh)
  - Wallet-addressed: NO

---

## 5. ROS2 / DDS

### 5.1 DDS (Data Distribution Service)
- **What:** OMG standard pub/sub middleware. RTPS (Real-Time Publish-Subscribe) over UDP. Auto-discovers participants via SPDP multicast. QoS policies control reliability, durability, history, deadline. Implementations: FastDDS (eProsima, Apache-2.0), CycloneDDS (Eclipse, Apache-2.0), RTI Connext (commercial).
- **Maturity:** Production; decades of use in industrial/military/robotics.
- **Self-hostable:** YES. FastDDS and CycloneDDS are fully OSS.
- **Auth (DDS-Security):** PKI-based: X.509 certs per domain participant, CA-signed. Three security plugins: Authentication (PKI-DH), Access Control (permissions XML), Cryptographic (AES-GCM-GMAC for encryption+signing). SROS2 tooling manages cert lifecycle for ROS2.
- **NAT traversal:** POOR. DDS relies on UDP multicast for discovery (link-local). RTPS does not cross NATs. Discovery database requires all-to-all knowledge — quadratic scaling. Not designed for WAN.
- **Offline/store-and-forward:** PARTIAL via QoS. TRANSIENT/PERSISTENT durability: DataWriter stores samples in HistoryCache; late-joining DataReaders can receive historical samples. But this is in-process/in-memory, not durable across restarts without backend.
- **Constrained device fit:** NO. DDS is heavyweight (10s of MB). Not suitable for microcontrollers. Micro-ROS (based on Micro-XRCE-DDS) is the constrained alternative.
- **Signature preservation:** DDS-Security signs RTPS messages (SIGN protection kind). But: signatures are per-DDS-domain-participant and NOT preserved across bridge boundaries (zenoh bridge re-serializes as a new DDS participant). Application payload bytes are forwarded opaquely by zenoh bridge.
- **License:** FastDDS: Apache-2.0. CycloneDDS: Apache-2.0.

### 5.2 zenoh (Cloud Bridge for ROS2/DDS)
- **What:** Pub/sub/query/storage protocol designed for WAN, routers, and low-bandwidth links. zenoh_bridge_dds transparently bridges ROS2/DDS topics to the zenoh network at internet scale.
- **Maturity:** Production; Eclipse project. Used by Autoware, Zenoh router, many robotics cloud bridges.
- **Self-hostable:** YES. Open-source (Apache-2.0 + EPL-2.0).
- **Auth:** TLS + token auth on zenoh router.
- **NAT traversal:** zenoh supports scouting (local discovery), routing (WAN), and peers (P2P). Works across NAT via zenoh router (cloud relay).
- **Offline/store-and-forward:** YES. zenoh queryables can implement storage backends. Persistent store plugin available.
- **Constrained device fit:** MARGINAL. zenoh-pico is a C implementation targeting embedded/RTOS. Compatible with ESP-IDF. MUCH lighter than full DDS.
- **Signature preservation:** zenoh bridge forwards DDS CDR payload opaquely. DDS-Security RTPS signatures do NOT survive the bridge (bridge acts as a new participant that re-serializes). Application-level signatures embedded in the payload DO survive.
- **License:** Apache-2.0 + EPL-2.0 (Eclipse dual).
- **RTP conn type mapping:** BETTER than websocket for LAN-robot-to-cloud. zenoh_bridge_dds enables ROS2 robots (LAN-only) to publish evidence topics that flow to a cloud zenoh router without any port-forwarding.
- **Device class fit:**
  - LAN robot: EXCELLENT (primary use case)
  - ESP32: MARGINAL (zenoh-pico supports it)
  - Drone intermittent: GOOD (zenoh router buffers; zenoh-pico for embedded drone compute)
  - Wallet-addressed: NO

---

## 6. PCC dht/federation Overlap

PCC already has a `dht` and `federation` layer. The following libp2p concepts directly overlap or extend this:

- **Kademlia DHT**: If PCC's DHT is Kademlia-style, the go-libp2p DHT implementation is a drop-in; peer routing and content routing are well-specified. PCC kernels could be published as DHT records for decentralized discovery without a central registry.
- **GossipSub**: If PCC's federation uses gossip-style propagation (kernel announcements, job availability broadcasts), GossipSub provides the mesh construction, score-based peer selection, and flood/prune mechanisms. IPFS, Ethereum, and Filecoin run production GossipSub.
- **PeerID / multiaddr**: libp2p PeerID (Ed25519 public key hash) is isomorphic to PCC's kernel identity concept. A kernel's PeerID IS its identity. Multiaddr allows composable addressing: `/ip4/1.2.3.4/tcp/4001/p2p/Qm...` covers LAN, WAN, and relay addresses in one format.
- **Circuit Relay v2 + DCUtR**: Directly maps to the planned "reverse-tunnel" and "LAN-relay" transport types. No custom code needed if PCC adopts libp2p transports.
- **Waku Store**: PCC federation + Waku Store nodes together would give PCC's DHT layer durable message delivery for the intermittent-drone case, without building a custom store.

Key recommendation: if PCC's DHT/federation is not yet finalized, strongly consider building it on go-libp2p with Waku Store for durability — this buys Circuit Relay, DCUtR, GossipSub, and Kademlia routing all at once, plus the full Waku protocol suite for store-and-forward.

---

## 7. Comparison Matrix

See final structured summary section below.
