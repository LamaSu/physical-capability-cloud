# SOTA Survey — Transport/Device-Connection Protocols for PCC
# Agent: scout-sota-a  |  Date: 2026-06-22

## Checklist
- [x] MQTT (incl. MQTT-SN)
- [x] CoAP (RFC 7252 + OSCORE + Observe)
- [x] AMQP (0-9-1 / 1.0)
- [x] WebSocket
- [x] WebRTC data channels
- [x] AWS IoT Core device shadow / jobs pattern
- [x] Azure IoT Hub twin / direct methods pattern
- [x] DIDComm v2 (bonus — highly relevant for wallet-addressed class)
- [x] XMTP (RTP baseline conn type context)
- [x] MQTT 5.0 request-response / correlation pattern
- [x] Signature preservation analysis
- [x] Comparison matrix
- [x] Twin/shadow pattern recommendations for PCC
- [x] DONE

---

## 1. MQTT (incl. MQTT-SN)

### Maturity / License / Ecosystem
- MQTT 3.1.1 (ISO/IEC 20922:2016), MQTT 5.0 (OASIS 2019). Open standard, MIT/Apache implementations everywhere.  
- Brokers: Mosquitto (EPL), EMQX (Apache), HiveMQ (commercial+community), AWS IoT Core, Azure IoT Hub.  
- Client libs for every language, including esp-idf esp_mqtt component (C, TLS, QoS 0/1/2).  
- MQTT-SN 1.2 spec (OASIS). Very few native MQTT-SN brokers; typically requires gateway (transparent or aggregating).

### NAT/Firewall Traversal
- EXCELLENT. Client always initiates outbound TCP (port 1883 / 8883 TLS). Works behind any NAT without hole-punching.  
- MQTT-SN: UDP, so NAT binding expiry can be a problem for long-sleeping devices. Gateway is typically co-located on same LAN or 6LoWPAN network, so NAT is not the gateway's problem.

### Offline / Store-and-Forward
- Persistent sessions (cleanSession=false): broker queues QoS 1/2 messages for offline clients. On reconnect, queued messages delivered immediately.  
- QoS 0 = fire-and-forget. QoS 1 = at-least-once. QoS 2 = exactly-once (4-way handshake).  
- Retained messages: broker stores last message per topic; new subscribers receive it immediately on subscribe (ideal for state-sync on reconnect).  
- LWT (Last Will and Testament): broker publishes a pre-configured message if client disconnects ungracefully — ideal for signaling "device offline" to PCC.  
- MQTT-SN adds sleep mode: device declares sleep duration, gateway caches messages, delivers on device's periodic poll. Designed for battery-constrained sensors.  
- MQTT 5.0: Message Expiry Interval (messages TTL-expire if device doesn't reconnect); Shared Subscriptions (load-balance workers); Request-Response with Response Topic + Correlation Data (formal request/reply — maps directly to PCC job dispatch + evidence receipt acknowledgment).

### Constrained-Device (ESP32/Arduino) Fit
- YES — native. esp-idf esp_mqtt component ships with ESP-IDF. Handles QoS 0/1/2, TLS (mbedTLS), persistent sessions.  
- MQTT-SN: even smaller. 2-byte topic IDs, UDP, no TLS. Designed for Zigbee/BLE/LoRa nodes with 8-bit MCUs.  
- MQTT-SN limitation: no username/password auth (Client ID only); relies on network-layer isolation or custom application auth.

### Payload Model / Message Size
- MQTT: payload is opaque bytes, up to 256 MB (MQTT 3.1.1 / 5.0). In practice <1MB recommended; typical IoT use is <1KB.  
- MQTT-SN: 2-byte topic ID. Practical limit for Zigbee/LoRa: ~127 bytes for data. Over UDP, practical limit ~64KB minus header.  
- Broker treats payload as opaque binary — does NOT modify payload bytes. A cryptographic signature embedded in the payload survives transit unmodified.

### Security / Auth
- TLS 1.2/1.3 for transport (mutually authenticated with client certs, or server cert + username/password).  
- MQTT itself has no application-layer signing; TLS terminates at broker. If end-to-end signing needed, signature is embedded in payload (broker doesn't strip it).  
- MQTT 5.0: enhanced auth mechanism, correlation data, user properties.  
- MQTT-SN: no username/password; Client ID only. Network isolation recommended.

### RTP Resemblance & Rating vs. RTP
- Closest RTP conn type: wifi-relay (device→broker→cloud).  
- BETTER than RTP: persistent sessions, LWT, retained state, QoS levels, mature ESP32 support, standard protocol with broad broker ecosystem. MQTT 5.0 request-response pattern is a direct fit for PCC job dispatch.

### Fit per Device Class
| Class | Fit | Reason |
|---|---|---|
| LAN robot behind NAT | EXCELLENT | Outbound TCP, no public IP needed |
| ESP32/Arduino | EXCELLENT (MQTT) / BEST (MQTT-SN) | Native esp-idf support; MQTT-SN for ultra-constrained |
| Drone (intermittent) | GOOD | Persistent session + QoS 1/2 + MQTT-SN sleep mode |
| Wallet-addressed device | GOOD | Wallet address as Client ID; payload carries signed evidence |

---

## 2. CoAP (RFC 7252 + OSCORE + Observe)

### Maturity / License / Ecosystem
- RFC 7252 (2014). RFC 7641 (Observe, 2015). RFC 7959 (Block-wise, 2016). RFC 8613 (OSCORE, 2019). IETF standards.  
- Implementations: libcoap (LGPLv2+), Californium (Eclipse/EPL, Java), CoAP.NET, tinyDTLS. LwM2M (OMA) uses CoAP as transport.  
- Smaller ecosystem than MQTT but strong in constrained/cellular IoT (LwM2M device management).

### NAT/Firewall Traversal
- PROBLEMATIC. CoAP uses UDP (port 5683 / 5684 DTLS). UDP NAT bindings expire quickly (30s–5min typical); if server tries to push data (observe), the binding may already be gone.  
- Devices behind NAT can only initiate outbound requests. Observe helps (device subscribes, server pushes to open binding), but long-lived observe is fragile behind symmetric NATs.  
- Hole-punching is impractical for constrained devices: "the hole punching technique is impractical and resource consuming for IoT devices."  
- DTLS makes NAT harder: DTLS requires connection state; proxy termination of DTLS loses end-to-end security.

### Offline / Store-and-Forward
- NONE NATIVE. CoAP is stateless UDP request/response — no broker, no queuing.  
- Observe subscriptions break if device goes offline; server must re-notify when device reconnects.  
- Store-and-forward requires a CoAP proxy/gateway (adds significant complexity).  
- NOT suitable for drones with intermittent links without a substantial gateway layer.

### Constrained-Device Fit
- EXCELLENT for the protocol itself: 4-byte header, runs on 8-bit MCUs, no TCP stack needed, designed for 6LoWPAN.  
- DTLS is moderately heavy (handshake cost, state). OSCORE (RFC 8613) is lighter: application-layer security using COSE/CBOR, no DTLS state per session.  
- Block-wise transfers (RFC 7959) allow large payloads split across multiple CoAP messages — necessary for evidence bundles.

### Payload Model / Message Size
- Base CoAP message: max 64KB (UDP limit). Block-wise transfers allow unlimited logical payloads split into blocks.  
- Proxy must re-assemble blocks (potential integrity issue if proxy is not trusted). OSCORE preserves end-to-end protection across blocks.

### Security / Auth
- Mode 1: PSK + DTLS. Mode 2: Raw public key (RPK) + DTLS. Mode 3: Certificates + DTLS.  
- OSCORE (RFC 8613): application-layer security using CBOR Object Signing and Encryption (COSE). Works end-to-end through any proxy. Preserves signatures end-to-end. Cost: ~45 bytes overhead per message; EDHOC handshake (RFC 9528).

### RTP Resemblance & Rating vs. RTP
- Closest: webhook (request/response model).  
- WORSE than MQTT for PCC's main needs: no offline queuing, NAT traversal problems, broker-less means PCC implements its own retry layer. Excellent for LAN-only constrained devices but fails for drones/intermittent.

### Fit per Device Class
| Class | Fit | Reason |
|---|---|---|
| LAN robot behind NAT | MARGINAL | Inbound observe works if device initiates; but server-push to NAT'd device is fragile |
| ESP32/Arduino | EXCELLENT | Lightest protocol; native UDP; no TCP stack |
| Drone (intermittent) | POOR | No store-and-forward; observe breaks on disconnect |
| Wallet-addressed device | MARGINAL | No auth beyond DTLS/OSCORE; wallet signing in payload only |

---

## 3. AMQP (0-9-1 / 1.0)

### Maturity / License / Ecosystem
- AMQP 0-9-1 (RabbitMQ, 2006). AMQP 1.0 (OASIS ISO/IEC 19464:2014). Two INCOMPATIBLE protocols sharing a name.  
- Brokers: RabbitMQ (0-9-1, Apache), Apache ActiveMQ Artemis (1.0), Azure Service Bus (1.0), Solace (both).  
- Client libs: amqplib (Node.js), rhea (JS, 1.0), python-qpid-proton, Microsoft AMQP.Net Lite.

### NAT/Firewall Traversal
- GOOD. Client initiates outbound TCP (port 5672 / 5671 TLS). Same NAT behavior as MQTT.

### Offline / Store-and-Forward
- EXCELLENT — core value proposition. Durable queues survive broker restart. Messages persist to disk. Exactly-once delivery across failures.  
- Message TTL, dead-letter queues, delayed delivery, consumer ack modes.  
- AMQP 1.0 bare message immutability (OASIS spec): "The exact encoding of sections of the bare message MUST NOT be modified, which preserves message hashes, HMACs and signatures based on the binary encoding of the bare message." End-to-end signing is a first-class feature.

### Constrained-Device Fit
- NO / MARGINAL. 8-byte frame header (vs MQTT's 2-byte). Complex wire format. No known lightweight ESP32 client library.  
- AMQP requires TCP, complex codec, significantly more RAM than MQTT. Not suitable for 8-bit MCUs or low-RAM ESP32.  
- AMQP makes sense for gateway-side (PCC server ↔ broker) or powerful edge nodes (RPi, industrial PLC).

### Payload Model / Message Size
- Payload up to 2 GB. Application data in body section (opaque bytes, value, or sequence).  
- Bare message immutability: properties + application-properties + body. Brokers MUST NOT modify. Best protocol for preserving externally-produced cryptographic signatures in the backend pipeline.

### Security / Auth
- SASL (PLAIN, EXTERNAL/cert, SCRAM). TLS for transport. Application-level signing natively supported via bare message immutability.

### RTP Resemblance & Rating vs. RTP
- No direct RTP equivalent (RTP is device-focused; AMQP is enterprise messaging).  
- BETTER than RTP for backend-to-backend: durable queuing, routing, exchanges.  
- Role in PCC: AMQP belongs in the PCC gateway → internal job queue → evidence pipeline path, NOT on devices.

### Fit per Device Class
| Class | Fit | Reason |
|---|---|---|
| LAN robot behind NAT | POOR (device-side) | Too heavy; gateway node could use AMQP as backend |
| ESP32/Arduino | NO | No lightweight client; too complex |
| Drone (intermittent) | POOR (device-side) | Same |
| Wallet-addressed device | N/A | Not a device-side protocol |

---

## 4. WebSocket

### Maturity / License / Ecosystem
- RFC 6455 (2011). IANA subprotocol registry. Universally supported.  
- Server libs: ws (Node.js, MIT), uWebSockets.js, FastAPI/Starlette. PCC gateway (Fastify) has native WS support.  
- Already in RTP as a conn type.

### NAT/Firewall Traversal
- EXCELLENT. Client initiates outbound HTTP upgrade to WS (port 80/443). Works through any NAT, corporate proxies, firewalls. WSS port 443 passes through virtually all enterprise firewalls.

### Offline / Store-and-Forward
- NONE native — WebSocket is a transport, not a messaging layer. No built-in persistence, QoS, or queuing.  
- Application layer must implement reconnect logic, message buffering, sequence numbers, replay on reconnect.  
- Typically combined with application protocols: STOMP over WS, MQTT over WS, JSON-RPC over WS.

### Constrained-Device Fit
- MARGINAL for ESP32. arduino-websocket and esp-idf websocket client exist. HTTP upgrade + TLS is heavier than MQTT's binary handshake.  
- Feasible on ESP32 with PSRAM; challenging on minimal RAM. Not suitable for Zigbee/Arduino Uno class.

### Payload Model / Message Size
- Text or binary frames. Implementation-limited (typically 1-16MB/frame max in servers).  
- Payload bytes passed through unmodified. Signatures in payload survive transit.

### Security / Auth
- TLS (WSS) for transport. Auth via Authorization header on upgrade handshake. No application-layer auth built in.

### RTP Resemblance & Rating vs. RTP
- This IS RTP's websocket conn type. EQUAL to RTP websocket.  
- Value-add: PCC can implement richer application-layer protocol on top (MQTT over WS, custom job dispatch with ack).

### Fit per Device Class
| Class | Fit | Reason |
|---|---|---|
| LAN robot behind NAT | EXCELLENT | Outbound WS, no public IP |
| ESP32/Arduino | MARGINAL | Heavy for minimal devices; feasible on ESP32-S3+ with PSRAM |
| Drone (intermittent) | POOR | No store-and-forward; reconnect must be app-implemented |
| Wallet-addressed device | GOOD | WS + JWT/Bearer carries wallet identity in upgrade header |

---

## 5. WebRTC Data Channels

### Maturity / License / Ecosystem
- W3C WebRTC 1.0 (2021). RFC 8831 (Data Channels), RFC 8832 (SCTP encapsulation). Major browsers native.  
- Server-side: libwebrtc (Google, BSD), Pion (Go, MIT), aiortc (Python). IoT: esp-webrtc-solution (Espressif, Apache 2.0, 2024).  
- Signaling NOT part of WebRTC spec — must implement separately (typically via WebSocket or HTTP).

### NAT/Firewall Traversal
- EXCELLENT but complex: ICE framework with STUN + TURN. ~99.9% connectivity.  
- P2P when STUN works (direct path). TURN relay when symmetric NAT blocks (costs TURN server bandwidth).  
- Requires: STUN server + TURN server (must self-host or pay). Signaling server for ICE candidate exchange. Additional infrastructure vs. MQTT.

### Offline / Store-and-Forward
- NONE. P2P connection. If peer disconnects, channel is gone. Must re-establish full ICE + signaling on reconnect.  
- NOT suitable for store-and-forward patterns. Drones with intermittent connectivity require complete re-negotiation on each reconnect.

### Constrained-Device Fit
- MARGINAL (ESP32-S3/P4 only). esp-webrtc-solution exists (2024). But:  
  - Requires ESP32-S3 or ESP32-P4 (PSRAM). Standard ESP32 lacks RAM.  
  - DTLS-SRTP + ICE + SCTP stack is very heavy.  
  - Data channels work but primary use case is A/V.  
- NOT suitable for Arduino Uno / Zigbee / 8-bit MCU class.

### Payload Model / Message Size
- SCTP over DTLS. Delivery modes: reliable-ordered, reliable-unordered, partial-reliable (maxRetransmits or maxPacketLifetime).  
- Partial-reliable / unordered avoids head-of-line blocking (important for telemetry streams).  
- Max message size: SCTP ~256KB per message. Large evidence bundles need application-level chunking.  
- Signatures in payload preserved: SCTP/DTLS do not modify application data bytes.

### Security / Auth
- DTLS-SRTP for transport. Auth: application-level (no built-in identity). DTLS fingerprint in SDP provides connection-level identity.  
- For wallet-addressed devices: wallet signature in application-layer payload.

### RTP Resemblance & Rating vs. RTP
- No direct RTP equivalent. Closest: webhook (P2P), but far more complex.  
- WORSE than MQTT for PCC device use cases: P2P model doesn't fit hub-to-many-devices topology; no offline queuing; heavy for constrained devices; requires STUN/TURN + signaling infrastructure.  
- NICHE ADVANTAGE: if PCC needs P2P drone-to-robot data transfer (bypassing cloud), WebRTC data channels are the right tool.

### Fit per Device Class
| Class | Fit | Reason |
|---|---|---|
| LAN robot behind NAT | GOOD | ICE/STUN handles NAT; but adds signaling complexity vs. MQTT |
| ESP32/Arduino | POOR-MARGINAL | Only ESP32-S3/P4 with PSRAM; too heavy for standard ESP32/Arduino |
| Drone (intermittent) | POOR | No store-and-forward; full ICE re-negotiation on every reconnect |
| Wallet-addressed device | MARGINAL | Possible but complex; identity in application layer |

---

## 6. AWS IoT Core — Device Shadow Pattern

### Architecture
- MQTT-based. Device connects via MQTT (or HTTP). Shadow = cloud-persisted JSON document per device.  
- Three-section shadow document:
  - desired: set by apps/services (what the device should do/be)
  - reported: set by device (what it currently is)
  - delta: computed by AWS — diff of desired vs. reported. Delivered to device as MQTT message.

### Offline Device Handling
- When device is offline, desired properties stored in cloud. On reconnect, device receives delta message containing everything it missed.  
- Persistent MQTT session caches delta messages during offline period.  
- Version numbers on shadow documents allow devices to safely discard stale/out-of-order messages.

### Jobs Pattern
- AWS IoT Jobs: cloud creates a job document, targets a device or fleet. Devices poll or receive push notification via MQTT. Job states: QUEUED → IN_PROGRESS → SUCCEEDED/FAILED.  
- Devices receive job document, execute, report status back. Job history persisted in cloud.  
- Exactly the pattern PCC needs for dispatching JOBS to physical devices.

### MQTT Topic Structure (Shadows)
- $aws/things/{name}/shadow/update — publish to update shadow  
- $aws/things/{name}/shadow/update/delta — subscribe to receive deltas  
- $aws/things/{name}/shadow/get — request current shadow  
- Named shadows: $aws/things/{name}/shadow/name/{shadowName}/...

### Applicability to PCC
- PCC can implement a "PCC shadow" per device/kernel: desired = next job assignment + config; reported = current state + evidence CID.  
- desired.job = {jobId, spec, assuranceTier} → device picks it up, executes, reports reported.evidence = {cid, signature}.  
- Offline-safe: device reconnects, picks up job from shadow delta, executes, uploads evidence.  
- NOT tied to AWS — pattern is implementable on any MQTT broker with a key-value store for shadow documents.

---

## 7. Azure IoT Hub — Twin / Direct Methods Pattern

### Three C2D Communication Options

| Option | Durability | Offline handling | Size limit | Use case |
|---|---|---|---|---|
| Direct methods | None (times out) | Disconnected: error returned | 128 KB req + 128 KB resp | Immediate interactive commands (e-stop) |
| Desired properties (twin) | Persisted in twin | Device reads on reconnect | 32 KB total twin | Long-running config / job assignment |
| C2D messages | 48h retention | Queued for 48h | 64 KB | One-way notifications |

### Key Insight: Three Delivery Modes for Different Job Types
- Direct methods = synchronous RPC. PCC equivalent: "abort current job now" (must be live).  
- Desired properties = declarative state. PCC equivalent: "when you next connect, use config X" / "your assigned job is Y."  
- C2D messages = async one-way. PCC equivalent: "your calibration window is in 10 minutes."

### Applicability to PCC
- Twin pattern maps cleanly: kernel twin = {desired: {assignedJob}, reported: {status, evidenceCid, signature}}.  
- Direct methods for emergency stop / abort (live-only). Desired properties for job assignment (survives offline). C2D messages for scheduling notifications.  
- Implementable with MQTT + Redis/SQLite for persistence (no Azure required).

---

## 8. DIDComm v2 — Bonus: Wallet-Addressed Device Class

### Why Relevant
- RTP's xmtp conn type uses XMTP (wallet-addressed messaging). XMTP is limited: centralized nodes, ~1MB message limit, no constrained device support, primarily browser/mobile SDKs.  
- DIDComm v2.0/v2.1 (DIF spec) is a transport-agnostic, standards-based alternative that directly addresses wallet-addressed devices.

### Architecture
- Message envelope: JWE (authenticated authcrypt with ECDH-1PU or anonymous anoncrypt with ECDH-ES). Optional JWS signing before encryption.  
- Transport bindings: HTTPS, WebSocket, Bluetooth, AMQP, SMTP, NFC, libp2p, sneakernet. Transport-agnostic by design.  
- Offline/store-and-forward: via mediators (routing protocol). Mediators forward encrypted messages without decrypting. Enables complex offline routing paths.  
- Identity: from/to headers contain DIDs. Recipients resolve sender DIDs to fetch public keys from DID Documents.  
- Encryption algorithms: X25519, P-384, P-256. Content encryption: A256CBC-HS512 (required), A256GCM (recommended).

### Constrained Device Support
- Better than XMTP: async message-based design tolerates mobile/embedded devices turning off unpredictably.  
- Devices disclose max_receive_bytes constraint; oversized messages rejected with problem code.  
- No native constrained library — implementors write lightweight DIDComm envelope handlers.

### Applicability to PCC (wallet-addressed class)
- Wallet-addressed device: DID Document maps wallet address → transport endpoint (e.g., MQTT topic, WebSocket URL, HTTP webhook).  
- Device signs evidence payload with wallet key; wraps in DIDComm JWS envelope; delivers via any transport.  
- Mediator pattern enables offline delivery: PCC sends job to mediator, device retrieves on reconnect.  
- Superior to XMTP for PCC: transport-agnostic (works over MQTT), open spec, constrained-device-compatible, no centralized intermediary.

---

## XMTP Context (RTP Baseline)
- XMTP: wallet-addressed E2EE messaging. Nodes hosted by XMTP Labs (centralized currently; mainnet transition in progress).  
- ~1MB message limit. Browser/Node/React Native/Android/iOS SDKs. No ESP32/Arduino support.  
- Messages stored encrypted indefinitely.  
- Offline: messages queued on XMTP network nodes until recipient retrieves.  
- Rating vs. DIDComm for PCC: WORSE (centralized, limited transports, no embedded support).

---

## SIGNATURE PRESERVATION SUMMARY

| Protocol | Payload preserved unmodified? | Explicit guarantee? |
|---|---|---|
| MQTT | YES — broker treats payload as opaque binary | Implicit (broker routes bytes) |
| MQTT-SN | YES — gateway does not modify application data | Implicit |
| CoAP direct | YES — if no proxy involved | Implicit |
| CoAP via proxy | RISK — block-wise reassembly; OSCORE protects E2E | OSCORE = explicit E2E protection |
| AMQP 1.0 | YES — bare message MUST NOT be modified by intermediaries | Explicit spec guarantee (OASIS) |
| WebSocket | YES — frame payload opaque binary | Implicit |
| WebRTC DataChannel | YES — SCTP application data not modified | Implicit |
| DIDComm v2 | YES — JWE/JWS envelope; mediators only see encrypted bytes | Explicit (E2E by design) |

---

## MASTER COMPARISON MATRIX

| Dimension | MQTT 3.1.1/5 | MQTT-SN | CoAP + OSCORE | AMQP 1.0 | WebSocket | WebRTC DC | DIDComm v2 |
|---|---|---|---|---|---|---|---|
| Maturity | Very High | Medium | High | High | Very High | High | Medium |
| Open standard | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| NAT traversal | EXCELLENT | N/A (LAN/GW) | POOR | EXCELLENT | EXCELLENT | EXCELLENT+infra | Per-transport |
| Offline/store-forward | EXCELLENT | EXCELLENT (sleep) | NONE | EXCELLENT | NONE | NONE | GOOD (mediators) |
| ESP32 fit | EXCELLENT | BEST | EXCELLENT | NO | MARGINAL | POOR | NO native lib |
| Arduino/8-bit fit | GOOD | BEST | EXCELLENT | NO | NO | NO | NO |
| Max payload | 256 MB | ~64 KB (UDP) | 64KB+block | 2 GB | impl-limited | ~256 KB/msg | <1 MB practical |
| Wire overhead (header) | 2 bytes min | compact | 4 bytes | 8 bytes | ~6 bytes | heavy (ICE+DTLS) | heavy (JWE) |
| Signature preservation | YES (implicit) | YES (implicit) | OSCORE required | YES (explicit spec) | YES (implicit) | YES (implicit) | YES (E2E design) |
| Broker/infra needed | Broker | Broker+GW | None/proxy | Broker | Server | STUN+TURN+signal | Mediator optional |
| RTP conn resemblance | wifi-relay | wifi-relay | webhook | (none) | websocket | (none) | xmtp |
| Rating vs. RTP | BETTER | BETTER | WORSE | BETTER (backend) | EQUAL | WORSE | BETTER (wallet class) |
| LAN robot | EXCELLENT | N/A | MARGINAL | POOR | EXCELLENT | GOOD | N/A |
| ESP32 | EXCELLENT | BEST | EXCELLENT | NO | MARGINAL | POOR | NO |
| Drone/intermittent | GOOD | GOOD | POOR | POOR | POOR | POOR | GOOD (mediator) |
| Wallet-addressed | GOOD | MARGINAL | MARGINAL | N/A | GOOD | MARGINAL | EXCELLENT |

---

## DEVICE TWIN / SHADOW PATTERN — HOW IT APPLIES TO PCC

### Core Pattern (vendor-agnostic)
A device twin is a cloud-persisted document with two halves: **desired** (what the cloud wants the device to be/do) and **reported** (what the device says it currently is). An event engine computes a **delta** (desired minus reported) and delivers it to the device on next connect. The device applies the delta, then updates its reported state.

**Why this is exactly right for PCC:**

1. **Job assignment to offline devices.** PCC creates a job: `desired.currentJob = {jobId, spec, assuranceTier, deadline}`. If the shop kernel is offline, the twin persists. On reconnect (MQTT persistent session), the broker delivers the delta. Kernel picks up job, executes, reports `reported.currentJob = {status: "completed", evidenceCid: "bafy...", signature: "0x..."}`. No polling required — delta delivery is push.

2. **Evidence upload is the reported-state update.** The signed evidence CID in reported state IS the job receipt. PCC cloud watches `shadow/update` topics; when reported.evidenceCid appears, it triggers verification. Atomic: delta delivery + evidence CID in one MQTT round-trip pattern.

3. **Three-tier delivery for different job urgency (Azure pattern applied to PCC):**
   - **Desired properties (shadow/twin)**: job assignment (survives device offline, no timeout). Use for all standard jobs.
   - **Direct method equivalent (MQTT RPC via request-response)**: emergency stop, abort, live telemetry request. Must be live; if device offline, PCC gets immediate failure signal (LWT or timeout).
   - **C2D message equivalent (QoS 1 with expiry)**: scheduling notifications, maintenance windows. Queued up to TTL.

4. **Version numbers prevent stale delivery.** Shadow version increments on each update. If a kernel receives delta version N but has already processed version N+1, it safely discards — exactly the stale-proof behavior needed for drones that may receive delayed messages.

5. **Named shadows for multi-capability kernels.** One shadow per capability type (shadow name = capability ID). Operator can subscribe to specific capability shadows. Avoids a single monolithic document growing without bound.

6. **Implementation without AWS/Azure.** The shadow pattern requires: (a) an MQTT broker (Mosquitto/EMQX), (b) a key-value store keyed by device ID (Redis/SQLite/PostgreSQL JSON column), (c) a delta-computation service, (d) a rule that publishes delta to `kernel/{id}/shadow/update/delta` when desired≠reported. ~400 LOC of application logic on top of standard MQTT. This is essentially what the PCC gateway already does with kernel status — it needs to be formalized into a shadow abstraction.

Sources consulted:
- MQTT essentials: https://www.hivemq.com/blog/mqtt-essentials-part-7-persistent-session-queuing-messages/
- MQTT-SN: https://www.emqx.com/en/blog/connecting-mqtt-sn-devices-using-emqx
- CoAP overview: https://academy.nordicsemi.com/...
- CoAP NAT: https://www.researchgate.net/publication/328114143...
- AMQP vs MQTT: https://www.emqx.com/en/blog/mqtt-vs-amqp-for-iot-communications + https://www.hivemq.com/blog/mqtt-vs-amqp-for-iot/
- AMQP 1.0 bare message spec: https://docs.oasis-open.org/amqp/core/v1.0/amqp-core-messaging-v1.0.html
- WebSocket vs WebRTC: https://www.nabto.com/webrtc-vs-websocket-for-iot/
- WebRTC data channels: RFC 8831 https://www.rfc-editor.org/rfc/rfc8831.html
- esp-webrtc-solution: https://deepwiki.com/espressif/esp-webrtc-solution
- AWS IoT shadows: https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html
- Azure IoT Hub C2D guidance: https://learn.microsoft.com/en-us/azure/iot-hub/iot-hub-devguide-c2d-guidance
- DIDComm v2.0: https://identity.foundation/didcomm-messaging/spec/v2.0/
- XMTP FAQ: https://docs.xmtp.org/intro/faq
- MQTT 5.0 request-response: https://www.hivemq.com/blog/mqtt5-essentials-part9-request-response-pattern/
- MQTT signature preservation: https://www.hivemq.com/blog/mqtt-security-fundamentals-mqtt-message-data-integrity/
