# RTP Spec Study — scout-rtp

## Checklist
- [x] Fetch rtp-spec README (https://github.com/plagtech/rtp-spec)
- [x] Fetch RTP-1.0.md raw spec (https://raw.githubusercontent.com/plagtech/rtp-spec/main/spec/RTP-1.0.md)
- [x] Fetch DEVICE-COMPATIBILITY.md
- [x] Fetch examples/agent-client.ts
- [x] Fetch examples/warehouse-robot.ts
- [x] Fetch Spraay docs (https://docs.spraay.app/)
- [x] Search spraay xmtp wifi-relay gateway

---

## Source: https://github.com/plagtech/rtp-spec (README)

### What RTP is
Robot Task Protocol (RTP) is an open standard that defines a common language for AI agents to discover, commission, and pay for physical robot tasks over the internet. RTP sits on top of the x402 payment protocol and provides:
- Standardized task envelope
- Capability vocabulary (15 core verbs)
- Identity scheme (rtp:// URIs)
- Lifecycle state machine
- Works across any robot hardware, connection type, or manufacturer

**Author:** Spraay Protocol (plagtech on GitHub)
**Status:** Draft, March 2026
**License:** MIT
**Reference implementation:** gateway.spraay.app

### Architecture
```
Agent discovers robot via .well-known/x402.json
       ↓
Agent sends Task Envelope + x402 USDC payment
       ↓
Gateway validates payment → holds in escrow
       ↓
Task dispatched to robot (webhook / xmtp / wifi / websocket)
       ↓
Robot executes → reports result
       ↓
Escrow releases to operator → agent receives result
```

### Protocol Stack
| Layer | Role | Example |
|---|---|---|
| Blockchain Infrastructure | Machine identity, on-chain state | peaq |
| Spatial Coordination | Physical-world awareness | Auki |
| Payment + Task Protocol | Agent-to-robot task dispatch & payment | RTP + Spraay |
| Payment Rails | HTTP-native micropayments | x402 |

---

## Source: https://raw.githubusercontent.com/plagtech/rtp-spec/main/spec/RTP-1.0.md

### Core Roles
- **Robot**: any physical or virtual actuator (arm, drone, 3D printer, CNC, lock, etc.)
- **Operator**: entity that owns/controls a robot; registers it, sets pricing, operates connection endpoint
- **Agent**: AI/software agent that discovers robots, submits task envelopes, pays via x402
- **Gateway**: registry + relay; maintains registrations, enforces x402 payment, holds escrow, routes envelopes

### Robot Identity
Format: `rtp://{gateway_host}/{robot_id}` — resolves to full profile via HTTPS
Registration returns: `robot_id`, `rtp_uri`, `x402_endpoint`, `registered_at`

External identity: RTP identities can link to peaq machine DIDs via `metadata` field.

### Capability Vocabulary (15 core verbs)
`move`, `pick`, `place`, `scan`, `sort`, `inspect`, `deliver`, `patrol`, `charge`, `capture`, `transmit`, `weld`, `assemble`, `dispense`, `print`

Custom capabilities via reverse-domain: `com.acmerobotics.palletize`

Each verb has standard parameter templates (Appendix B).

---

## Source: Connection Types (Spec Section 5)

### Connection Config at Registration

**webhook:**
```json
{
  "type": "webhook",
  "webhookUrl": "https://operator-server.com/rtp/task",
  "secret": "hmac-signing-secret"
}
```

**xmtp:**
```json
{
  "type": "xmtp",
  "xmtpAddress": "0xRobotWalletAddress"
}
```

**wifi (relay):**
```json
{
  "type": "wifi",
  "relayUrl": "https://relay.operator.com",
  "localAddress": "192.168.1.100:3100"
}
```

**websocket:**
```json
{
  "type": "websocket",
  "wsUrl": "wss://operator-server.com/rtp/ws"
}
```

Spec notes about each:
- **webhook**: HTTPS POST — "Any internet-connected robot or server"
- **xmtp**: XMTP encrypted messaging — "Crypto-native / wallet-addressed robots"
- **wifi**: HTTP via local relay — "LAN-connected robots without public endpoints"
- **websocket**: WSS persistent connection — "Real-time / low-latency bidirectional control"

**Important**: The spec does NOT elaborate further on these beyond the brief table descriptions and configuration examples. No section goes deeper on NAT handling, offline/delivery guarantees, or reconnection for any type. The DEVICE-COMPATIBILITY.md also explicitly says NAT traversal is NOT addressed.

---

## Source: Task Envelope (Spec Section 6)

```json
{
  "rtp_version": "1.0",
  "task_id": "task_xyz789",
  "robot_id": "robo_abc123",
  "task": "pick",
  "parameters": { "item": "SKU-00421", "from_location": "bin_A3", "to_location": "conveyor_1" },
  "payment": {
    "x402_token": "<x402_payment_payload>",
    "amount": "0.05",
    "currency": "USDC",
    "chain": "base"
  },
  "callback_url": "https://agent.example.com/task-complete",
  "timeout_seconds": 60,
  "issued_at": "2026-03-11T12:00:00Z"
}
```

Fields: rtp_version, task_id, robot_id, task (capability verb), parameters (free-form JSON), payment (x402_token, amount, currency, chain), callback_url (optional), timeout_seconds (optional), issued_at

---

## Source: Result Envelope (Spec Section 8)

```json
{
  "rtp_version": "1.0",
  "task_id": "task_xyz789",
  "robot_id": "robo_abc123",
  "status": "COMPLETED",
  "result": {
    "success": true,
    "output": "Item SKU-00421 moved from bin_A3 to conveyor_1",
    "data": {},
    "duration_seconds": 12
  },
  "completed_at": "2026-03-11T12:00:01Z"
}
```

**CRITICAL OBSERVATION**: The result envelope contains:
- status: COMPLETED/FAILED/TIMEOUT
- result.success: boolean
- result.output: string (human-readable)
- result.data: object (structured data — e.g., weight_grams, grip_force_n from warehouse example)
- result.duration_seconds
- result.error (on failure)

**There is NO cryptographic signature on the result envelope.** The robot POSTs to `POST /robots/{robot_id}/complete` with no signing requirement. The gateway has no mechanism to verify the result came from the actual robot hardware vs a fraudulent operator. There is no evidence bundle, no proof-of-work, no sensor attestation requirement.

The ONLY "security" in the result path is:
1. HMAC-SHA256 on INBOUND webhook (gateway → robot, `X-RTP-Signature`)
2. x402 signature on payment (agent → gateway)
The OUTBOUND result (robot → gateway) is unsigned plain HTTP POST.

---

## Source: Task Lifecycle (Spec Section 7)

```
PENDING → DISPATCHED → IN_PROGRESS → COMPLETED/FAILED
  ↓ (payment fails)     ↓ (no ack)        ↓ (exceeds timeout)
  FAILED              TIMEOUT            TIMEOUT
```

States:
- PENDING: Task received, x402 payment being validated on-chain
- DISPATCHED: Payment confirmed, task envelope sent to robot via connection
- IN_PROGRESS: Robot acknowledged receipt and begun execution
- COMPLETED: Robot confirmed successful completion
- FAILED: Robot reported failure or unrecoverable error
- TIMEOUT: Exceeded timeout_seconds without completion

On COMPLETED: escrow releases to operator, callback_url fired
On FAILED/TIMEOUT: funds returned to agent, callback_url fired

---

## Source: Payment Standard (Spec Section 9)

Mandates x402 exclusively. Flow:
1. Agent calls x402-protected endpoint → receives HTTP 402
2. Gateway returns accepted assets, amounts, target wallet
3. Agent signs x402 payload, resubmits with X-PAYMENT header
4. Gateway validates on-chain, holds funds in escrow
5. Task dispatches only after confirmation
6. Escrow releases on COMPLETED; refunds on FAILED/TIMEOUT

Supported assets (reference impl): USDC (Base, Arbitrum, Ethereum), USDT (Polygon)

---

## Source: Discovery (Spec Section 10)

- `GET /.well-known/x402.json` — REQUIRED endpoint listing all robots
- Each robot entry includes `rtp` extension object with version, robot_id, capabilities[], connection_type
- `GET /robots?capability=X&chain=Y&max_price=Z&tag=A&status=online` — filterable registry

---

## Source: Security Considerations (Spec Section 12)

- **Operator auth**: API key (`X-API-Key` header) for registration/management
- **Task auth**: x402 cryptographic signature (agent → gateway)
- **Webhook verification**: HMAC-SHA256, `X-RTP-Signature` header (gateway → robot, inbound)
- **Escrow safety**: Gateway holds funds until task resolution
- **Replay protection**: task_id is unique + single-use; issued_at freshness window (default 5 min)
- **Rate limiting**: 100 registrations/hour per operator, 1000 tasks/hour per agent

**NO result signing**: Robot POSTs result to gateway with no cryptographic proof.
**NO evidence model**: No mention of sensor data, photo attestation, CID storage, ZK proofs.
**NO integrity verification**: Gateway accepts operator's self-reported completion at face value.

---

## Source: Extensibility (Spec Section 14)

- Custom capabilities via reverse-domain notation
- Custom parameters in task envelope `parameters` field (free-form JSON)
- Custom result data in result envelope `data` field
- Custom metadata at registration via `metadata` field
- Version forward-compatibility via rtp_version increment

Extension negotiation: via `metadata.extensions` array at registration (e.g., `["rtp-streaming-v1"]`)

**Connection layer extensibility**: NOT discussed. There is no transport interface or plugin API. The spec defines exactly 4 connection types and no mechanism to add more beyond making a new version.

---

## Source: Device Compatibility (docs/DEVICE-COMPATIBILITY.md)

| Device Class | SDK Direct | Connection Method |
|---|---|---|
| Linux robots | Yes | webhook, websocket |
| Raspberry Pi | Yes | webhook, WiFi |
| Arduino/ESP32 | Bridge required (Pi intermediary) | webhook via bridge |
| Industrial robots | External server | webhook |
| DJI drones | External server | webhook |
| ArduPilot/PX4 | Companion computer | webhook, xmtp |
| IoT devices | Usually | webhook |

Bridge pattern for microcontrollers: Spraay Gateway ←WiFi→ Pi running RTP SDK ←USB/Serial→ Arduino/ESP32

NAT traversal: **NOT addressed in the spec or device guide.**

---

## Source: Examples

### warehouse-robot.ts
- Uses `RTPDevice` from `@spraay/rtp-sdk`
- Registers with `connection: { type: 'webhook', webhookUrl: '...', secret: '...' }`
- `robot.onTask('pick', async (params, task) => { ... await task.complete({ output, data }) })`
- `robot.listen(3100)` — starts webhook HTTP listener
- Result data is free-form JSON: `{ weight_grams: 450, grip_force_n: 12.5 }` — no schema, no signing

### agent-client.ts
- Uses `RTPClient` from `@spraay/rtp-sdk`
- `client.discover({ capability: 'pick', chain: 'base', maxPrice: '0.10' })` — hits GET /robots
- `client.hire(robots[0], { task, parameters, callbackUrl, timeoutSeconds })` — handles 402→pay→poll
- Result returned as plain JSON with status, result.output, result.data
- Multi-robot workflow possible (sequential hire calls)

---

## KEY FINDINGS SUMMARY

### What RTP Does
1. Standardized task envelope (JSON)
2. Standardized result envelope (JSON)
3. Capability vocabulary (15 verbs + custom)
4. rtp:// URI scheme for robot identity
5. .well-known/x402.json discovery
6. 4 connection types (webhook, xmtp, wifi-relay, websocket)
7. x402 payment with escrow (pay-per-task in USDC)
8. Task lifecycle state machine (6 states)
9. HMAC-SHA256 webhook signing (inbound only)
10. Replay protection (task_id uniqueness + timestamp freshness)
11. Filterable robot registry
12. Callback URL for async result delivery

### What RTP Does NOT Do
1. NO result signing — robot self-reports completion, gateway accepts at face value
2. NO evidence model — no sensor attestations, photos, ZK proofs, CID storage
3. NO provenance — result.data is free-form JSON with no schema or integrity check
4. NO assurance tiers — binary success/failure only
5. NO drift detection — no monitoring of execution vs expected parameters
6. NO ALCOA compliance — no attributability, contemporaneousness, or credibility checks
7. NO NAT traversal specification — wifi-relay mentions relayUrl but no relay protocol spec
8. NO pluggable transport interface — connection types are hardcoded, no extension mechanism
9. NO compliance reporting — no standards (ISO etc) checked
10. NO on-chain result recording — escrow release just checks COMPLETED status, doesn't verify what was done
