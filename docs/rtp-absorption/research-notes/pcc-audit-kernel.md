# PCC Kernel Audit: Transport & Execution Path
**Agent:** auditor-kernel  
**Scope:** `packages/kernel/`, `packages/agent-kernel/`, `packages/agent-runtime/`, `packages/kernel-sdk/src/`  
**Goal:** Document how a kernel receives work, executes it, and returns results today — establishing the transport seams for RTP absorption.

---

## Checklist

- [x] Inbound work path documented with exact file:line cites
- [x] Execution path (device adapter routing) documented
- [x] Outbound result path documented
- [x] Transport coupling points identified
- [x] Connection lifecycle (heartbeat, registration, reconnect) documented
- [x] HAS vs LACKS table produced
- [x] Transport seams bullet list produced

---

## 1. Inbound Work Path

**There are two completely separate kernel runtime models in this codebase.** Understanding which one applies is the first step for transport abstraction work.

### Path A: Embedded-in-Gateway (production default)

The `KernelService` in `packages/gateway/src/services/kernel-service.ts` runs **inside the gateway process** as a singleton. The kernel package (`@pcc/kernel`) is imported and instantiated in-process — there is no network hop from gateway to kernel.

- **Job arrives**: `POST /api/jobs/submit` → `job.facade.ts:submit()` → checks if `kernelService.config.kernelId === job.kernelId` → if yes, calls `svc.submitJob(params)` directly in-process (`job.facade.ts:290`).
- **External kernel detection**: `job.facade.ts:268` checks `isExternalKernel = localKernelId && kernelId !== localKernelId`. If true, the job is written to the DB with `status: "queued"` and **returned immediately** (`job.facade.ts:264-285`). No HTTP dispatch to the external kernel happens — the gateway leaves the job in the DB and assumes "some daemon" will poll for it. **No polling client exists today.**
- **Transport assumption**: This path bakes in the assumption that the kernel runs in the same process as the gateway. The `kernel-service.ts` constructor calls `loadKernelConfig()` at line `76` using `process.env.KERNEL_CONFIG` / `KERNEL_CONFIG_FILE` / mock defaults (`kernel-config.ts:101-128`).

### Path B: Standalone Kernel HTTP Server

`packages/kernel/src/server.ts` is an independent Fastify HTTP server exposing job endpoints. The gateway does NOT talk to it — it is a second deployment model where the kernel runs as a separate process.

- **Inbound**: `POST /execute` at `server.ts:139` — the gateway (or any HTTP caller) sends `{capabilityId, jobId, stepId, cwmId, gcodeHash, assuranceTier}`.
- **No polling or SSE subscription**: The standalone kernel server listens passively. It does not register with the gateway, does not subscribe to an SSE stream, does not poll for queued jobs. Jobs arrive only via direct HTTP push.
- **No auto-reconnect, no store-and-forward**: If the HTTP connection drops mid-request, the job is lost.

### Path C: Agent Kernel (A2A network bus)

`packages/agent-kernel/src/kernel-agent.ts` is a third model where the kernel is a `KernelAgent` (extends `BaseAgent` at `agent-runtime/src/base-agent.ts:52`) that participates in an A2A message bus.

- **Inbound**: `KernelAgent.setupIntentHandlers()` at `kernel-agent.ts:172` registers bus subscriptions for intents: `request_quote`, `execute_job`, `cancel_job`, `request_handoff`, `job_status_query`, `text_message`.
- **Bus mechanism**: `base-agent.ts:100` calls `this.bus.subscribe(this.id, (msg) => this.handleMessage(msg))` — messages delivered by the `MessageBus` (in-memory) or `NetworkedBus` (WebSocket relay at `packages/a2a/src/networked-bus.ts`).
- **NetworkTransport**: `packages/a2a/src/network-transport.ts:32` — WebSocket to a central relay at `packages/a2a/src/network-transport.ts:71`: `ws://relay/ws/a2a?agentId=...&apiKey=...`. Send path is REST POST to `/api/a2a/send` (`network-transport.ts:113`). Auto-reconnects on close (`network-transport.ts:197-208`).
- **A2A kernel is a separate deployment**: `NanoClawAgent` (`nanoclaw-agent.ts`) wraps this for Opentrons OT-2 and connects to the relay via `NetworkedBus`.

---

## 2. Execution Path

Once a job is received (by any path above), execution follows the same pipeline:

1. **Safety preflight** (gateway path only): `kernel-service.ts:137` — `getSafetyGateway().validateAndRelay(preflightCmd, async () => undefined)`. The `SafetyGateway` (`safety/gateway.ts:52`) chains `CircuitBreaker.canExecute(deviceId)` → `SafetyGovernor.validateCommand(cmd)` (5-check pipeline). If either denies, throws before execution begins.

2. **Device adapter selection**: `kernel-service.ts:106-113` — `selectDevice(deviceId?)` picks the requested `deviceId` from `this.runners` map, or auto-selects the first machine. All runners are pre-built from `KernelConfig.devices[]` at init time via `createAdaptersFromConfig()` (`adapter-factory.ts:271`).

3. **Adapter registry dispatch**: `adapter-factory.ts:189` — `machineRegistry.get(effectiveType)` dispatches to the registered factory. Built-in factories registered at module load (`adapter-factory.ts:443-458`):
   - `"mock"` / `"generic-http"` → `MockFDMAdapter`
   - `"octoprint"` → `OctoPrintAdapter` (polls `http://<url>/api/...`)
   - `"opcua"` → `OPCUAAdapter` (polls `opc.tcp://<endpoint>`)
   - `"ipp"` → `IppAdapter`
   - `"opentrons"` → `OpentronsMachineAdapter` (polls `http://<url>:31950/...`)
   - `"hamilton"` → `HamiltonAdapter`
   - `"modbus"` (sensor) → `ModbusSensorAdapter`
   - `"sila"` (sensor) → `SiLAAdapter` shim
   - External adapters can be registered via `registerMachineAdapter(type, factory)` (`adapter-factory.ts:106`)

4. **JobRunner.run()**: `job-runner.ts:64` — orchestrates 9 phases:
   - Load G-code: `machine.execute({type:"load_gcode", ...})`
   - Start sensors (tier ≥1): `sensor.startRecording(jobId)`
   - Before snapshot (tier ≥2): `camera.captureSnapshot()`
   - Start execution: `machine.execute({type:"start"})`
   - **Poll for completion**: `job-runner.ts:207-220` — `while(true)` loop calling `machine.getProgress()` every 500ms with 120s timeout
   - Stop sensors: `sensor.stopRecording()`
   - CV inspection (tier ≥2): `camera.runInspection()`
   - Tier requirements check: `evidenceEmitter.checkTierRequirements(events, tier)`
   - Finalize bundle: `evidenceEmitter.finalizeBundle(jobId, stepId)`

5. **Adapter interface** (`adapters/types.ts`): `MachineAdapter` (`types.ts:28`), `SensorAdapter` (`types.ts:49`), `CameraAdapter` (`types.ts:70`) — all transport-agnostic interfaces. The adapter layer is the **correct seam** for non-HTTPS transports. New adapter types (serial, Bluetooth, MQTT, WebSerial) need only implement this interface and call `registerMachineAdapter(type, factory)`.

6. **Constitutional safety** (agent-kernel path): `kernel-agent.ts:263-295` — `evaluatePolicy(this.policy, policyCtx)` runs before queuing the job. Policy is an `OperatorPolicy` with rate limits, cost caps, escrow-funded requirements.

---

## 3. Outbound Result Path

### Gateway path (embedded kernel):

1. `JobRunner.run()` returns `JobResult` to the `.then()` callback in `kernel-service.ts:216`.
2. DB update: `repos.jobs.update(jobId, {status:"completed", evidenceBundleId})` at `kernel-service.ts:221-228`.
3. Evidence bundle (cached via `emitter.onBundle()` listener at `kernel-service.ts:83-85`) is passed to `settlementService.processEvidence(bundle, jobId, ...)` at `kernel-service.ts:243`.
4. **No outbound HTTP to gateway**: results stay in-process in DB and in-memory maps. Gateway API consumers poll `GET /api/jobs/:id/status` or subscribe to SSE stream (`/sse/stream/job/:jobId`).
5. Bundle signing: `evidence-emitter.ts:124-148` — `hashBundle(events)` → `signFn(bundleHashValue)`. Default signFn uses zero-address test key. Production: inject real Ed25519/secp256k1 wallet signFn.
6. IPFS archival (best-effort): `evidence-emitter.ts:154-174` — if `storageService.isReady()`, calls `storageService.archiveBundle(bundle)`.

### Standalone kernel server path (`server.ts`):

1. `POST /execute` fires `runner.run()` asynchronously, returns `{jobId, status:"executing"}` immediately.
2. Completion is stored in `bundles: Map<string, EvidenceBundle>` at `server.ts:51`.
3. **No push notification to gateway**: the caller must poll `GET /jobs/:id` and then `GET /jobs/:id/evidence`.
4. `server.ts:87-96` — `evidenceEmitter.onBundle(bundle => { bundles.set(bundle.jobId, bundle); job.status = "awaiting_pickup" })`.

### Agent-kernel path:

1. `KernelAgent.processQueue()` at `kernel-agent.ts:394` runs jobs sequentially from `jobQueue[]`.
2. On completion: `kernel-agent.ts:424` — `this.send(job.requesterId, {type:"job_completed", evidenceBundleHash, ...}, conversationId)` — A2A message via the bus.
3. Evidence auto-submitted to escrow via `SettlementClient.submitEvidence()` at `kernel-agent.ts:489` if escrow mapping registered.
4. **Transport**: A2A message delivered via `NetworkedBus` → WebSocket relay → to requesting broker agent.

---

## 4. Transport Coupling (Hard-Coded Seams)

| Location | Hard-coded assumption | Seam? |
|---|---|---|
| `kernel-service.ts:76` | `loadKernelConfig()` reads `KERNEL_CONFIG` env var / file — device URLs are HTTP strings embedded in config | Yes — `KernelConfig.devices[].config.url` |
| `adapter-factory.ts:339` | `OctoPrintAdapter` URL: `cfg.url ?? "http://localhost:5000"` | Yes — adapter config |
| `adapter-factory.ts:352` | `OPCUAAdapter` endpoint: `cfg.endpoint ?? "opc.tcp://localhost:4840"` | Yes — adapter config |
| `adapter-factory.ts:384` | `OpentronsMachineAdapter` URL: `cfg.url ?? "http://localhost:31950"` | Yes — adapter config |
| `adapter-factory.ts:396` | `HamiltonAdapter` URL: `cfg.url ?? "http://localhost"` | Yes — adapter config |
| `adapter-factory.ts:416` | `ModbusSensorAdapter` host: `cfg.host ?? "localhost"` | Yes — adapter config |
| `kernel-sdk/src/register.ts:62` | `registerKernel()` POSTs to `${gatewayUrl}/api/kernels/register` — assumes gateway is HTTPS reachable | Yes — `gatewayUrl` param |
| `kernel-sdk/src/register.ts:62` | `endpointURL must start with "https://"` — validated at `kernel-marketplace.ts:123` | Hard enforcement — blocks non-HTTPS kernels from marketplace |
| `job.facade.ts:268` | External kernel detection by comparing `localKernelId !== kernelId` — leaves job in DB, no dispatch | Missing — no client-side dispatch to external kernels |
| `network-transport.ts:63-71` | A2A relay URL hardcoded to WebSocket: `ws[s]://relay/ws/a2a?agentId=...` | Yes — `relayUrl` config |
| `job-runner.ts:207-219` | Completion polling loop: 500ms `setTimeout` over `machine.getProgress()` | Yes — adapter interface |
| `server.ts:24` | `PORT = parseInt(process.env.PORT ?? "3100")` — kernel always listens on HTTP | Yes — env var |
| `server.ts:239` | `app.listen({port: PORT, host:"0.0.0.0"})` — assumes TCP/IP network is available | Hard — no alternative |

---

## 5. Connection Lifecycle

| Component | Heartbeat | Registration | Reconnect | Offline behavior |
|---|---|---|---|---|
| **Embedded KernelService** | None — in-process | None — instantiated on gateway startup | N/A | Gateway restart = kernel restart |
| **Standalone kernel server** | `GET /health` responds passively | None — external callers discover by URL | None | Jobs lost on restart |
| **Opentrons operator** | `setInterval(60_000)` at `operator.ts:167` — calls `adapter.getStatus()` internally, updates `HealthTracker` | Manual: `operator.start()` connects to OT-2 | None — adapter.dispose() on stop | Queue in-memory, lost on crash |
| **KernelAgent / A2A** | Agent heartbeat: `POST /api/agents/heartbeat` (gateway route); monitor checks in `agent-heartbeat-monitor.ts` | `bus.register(card)` + `bus.subscribe(id, handler)` at `base-agent.ts:99-100` | `NetworkTransport.scheduleReconnect()` at `network-transport.ts:197` — exponential attempt with `reconnectInterval` (default 3s), up to `maxReconnectAttempts` (default Infinity) | Messages delivered during disconnect are lost — no store-and-forward in `NetworkedBus` |
| **NetworkTransport** | None | WS handshake to `/ws/a2a?agentId=...` | Auto-reconnect on `close` event | Messages sent while disconnected → REST POST fails → exception bubbles to caller |

---

## 6. HAS vs LACKS

| Feature | HAS | LACKS |
|---|---|---|
| Inbound job delivery to in-process kernel | ✅ `kernel-service.ts` in-process call | |
| Inbound job delivery to remote kernel via HTTP push | ✅ Standalone `server.ts` `POST /execute` | |
| Inbound job delivery via A2A/WebSocket bus | ✅ `KernelAgent` + `NetworkedBus` | |
| Inbound job delivery via polling (kernel pulls from gateway) | | ❌ No polling client |
| Inbound job delivery via XMTP/wallet-addressed channel | | ❌ Not implemented |
| Inbound job delivery to LAN-only device (no inbound ports) | | ❌ No NAT traversal / outbound-only transport |
| Inbound job delivery to ESP32/microcontroller | | ❌ No lightweight protocol (no MQTT, no CoAP) |
| Device adapter plugin API | ✅ `registerMachineAdapter(type, factory)` in `adapter-factory.ts` | |
| Non-HTTPS kernel registration in marketplace | | ❌ Hard-blocked: `endpointURL must start with "https://"` (`kernel-marketplace.ts:123`) |
| External kernel dispatch (gateway → remote kernel) | | ❌ `job.facade.ts:270-285` leaves job in DB, no HTTP client dispatch |
| Store-and-forward on disconnect | | ❌ `NetworkedBus` drops messages on WS disconnect |
| Offline-capable kernel (reconnects, resumes queue) | Partial: WS reconnect in `NetworkTransport` | ❌ No message replay, no persistent queue |
| Durable job queue (survives kernel restart) | | ❌ `KernelAgent.jobQueue` and `server.ts` bundles are in-memory only |
| Signed evidence bundles | ✅ `EvidenceEmitter.finalizeBundle()` signs with Ed25519/secp256k1 | Default is test-only zero-address signer |
| Real signing key injection | Partial: constructor accepts `signFn` | ❌ No HSM / TEE signer wired in production |
| IPFS evidence archival | ✅ Best-effort via `storageService` in `evidence-emitter.ts` | |
| Connection-type abstraction (transport interface) | | ❌ No `ITransport` interface; each path is its own code branch |
| Intermittent-link / delayed-evidence support | | ❌ No async evidence delivery, no CID-based handoff |

---

## 7. Key Seams for RTP Transport Abstraction

The following are the precise insertion points where a pluggable transport layer should be inserted, ordered by importance:

- **`adapter-factory.ts:92-169` — machine/sensor/camera registries**: The existing `registerMachineAdapter(type, factory)` API is the correct bottom-half seam. New transport types (serial→ESP32, MQTT→IoT sensor, BLE→embedded device) register here. No changes to job-runner.ts needed.

- **`job.facade.ts:255-285` — external kernel dispatch gap**: When `isExternalKernel === true`, the facade currently leaves the job in DB with `status:"queued"` and returns. A `KernelDispatcher` interface should be inserted here to look up the kernel's registered `connectionType` and dispatch via the appropriate transport (webhook, xmtp, wifi-relay, websocket).

- **`kernel-marketplace.ts:123` — `endpointURL` HTTPS enforcement**: Hard-blocks non-HTTPS kernels. For RTP kernels (LAN-only, XMTP-addressed), the `endpointURL` field should be replaced/supplemented with a `connectionSpec: {type, config}` discriminated union. The validation must be relaxed for non-`"https"` connection types.

- **`kernel-sdk/src/register.ts:62` — `registerKernel()` POST to `/api/kernels/register`**: This is the kernel→gateway registration path. Currently assumes the kernel can reach the gateway via HTTPS. For offline-first kernels this registration may need to happen via a relay or be deferred.

- **`network-transport.ts:55-127` — WebSocket relay transport**: The `NetworkTransport` class is a clean transport implementation. It is one of the connection types RTP should absorb (maps to `"websocket"` in RTP spec). The `A2AMessage` structure is a natural carrier for `KernelJobRequest`.

- **`evidence-emitter.ts:49-65` — signing function injection**: `EvidenceEmitter` constructor accepts an optional `signFn: (data: string) => Promise<Signature>`. This is the correct seam for injecting wallet-based signers (XMTP identity, on-chain wallet) for evidence produced on NAT'd/offline devices.

- **`server.ts:235-240` — standalone kernel boot**: Only valid when the kernel is reachable as an HTTPS server. For outbound-only kernels, this entire server.ts model is inapplicable. An outbound-connect client loop (polling gateway DB, or connecting to XMTP channel) would replace it.

---

*Written by: auditor-kernel | Date: 2026-06-22*
