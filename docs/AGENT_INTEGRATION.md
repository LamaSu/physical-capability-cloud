# PCC Agent Integration Guide

Full API reference, DTOs, MCP tools, operator onboarding, and environment variables for agents integrating with the PCC gateway. For a quick primer + MANDATORY project rules, see `CLAUDE.md`.

## Contents
- §1. Complete API Reference
- §2. Operator Onboarding Guide
- §3. DTOs & Response Shapes
- §4. Facades & How They Work
- §5. Safety & Compliance
- §6. Settlement & Payments
- §7. MCP Server (56 Tools)
- §8. Agent Package (218 Tools)
- §9. Environment Variables
- §10. SSE Streams (Real-Time Events)
- §11. pcc-node (Python Operator Node)
- §12. Contributor Economics (NEW 2026-04)
- §13. Agent Workflows (Quick Reference)

> **What's new (2026-04)**: Contributor economics primitives (per-job royalties for adapter authors / protocol authors / model authors / dataset contributors / verifiers / insurers). 7 new MCP tools (50-56), 8 new REST endpoints under `/api/contributors`, full RateSchedule DSL. See §12.

---

## 1. Complete API Reference

All endpoints are under `https://capability.network`. All require `Authorization: Bearer <key>` except where noted as PUBLIC.

### Auth & Key Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/provision` | Create API key (PUBLIC). Body: `{email?, walletAddress?, name?, capability?}`. Returns `api_key`. |
| GET | `/api/auth/validate` | Validate current API key. Returns `{valid, operatorId}`. |
| GET | `/api/auth/keys` | List your active API keys with usage stats. |
| DELETE | `/api/auth/keys/:keyId` | Revoke an API key permanently. |
| GET | `/api/auth/nonce` | Get SIWE nonce for wallet login. |
| POST | `/api/auth/verify` | Verify SIWE signature, create session. |
| GET | `/api/auth/me` | Current session info. |
| POST | `/api/auth/logout` | Destroy session. |

### Discovery & Capabilities

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/capabilities/types` | List all capability type strings (PUBLIC). Returns `{types: string[]}`. |
| GET | `/api/capabilities/templates` | List all templates with pricing hints and parameter metadata. |
| GET | `/api/capabilities` | List all capability instances. Supports `?offset=&limit=`. Returns `PaginatedResult<CapabilityDTO>`. |
| GET | `/api/capabilities/by-kernel/:kernelId` | Capabilities for a specific kernel. Returns `{capabilities: CapabilityDTO[]}`. |
| GET | `/api/capabilities/by-type/:type` | Filter by capability type. Returns `{capabilities: CapabilityDTO[]}`. |
| GET | `/api/capabilities/search?q=` | Full-text search across names, types, materials. Returns `CapabilityDTO[]`. |
| GET | `/api/capabilities/:capId` | Single capability with full enrichment (reputation, availability, queue depth). |
| POST | `/api/capabilities` | Create/upsert a capability instance. Body: `{kernelId, type, name, ...}`. |
| GET | `/api/capabilities/:id/button` | Embeddable button (PUBLIC, CORS *). See §1.1 below. |

#### 1.1 Embeddable Button Endpoint

`GET /api/capabilities/:id/button?format=json|html|script&label=...&theme=dark|light`

Returns a button config that third-party sites can embed to let users launch PCC jobs directly.

- `?format=json` (default): Returns `{capability, button, html, embedScript}`.
- `?format=html`: Returns an `<claude-code-button>` HTML snippet.
- `?format=script`: Returns script tag + button HTML for drop-in embedding.

Example:
```bash
curl https://capability.network/api/capabilities/cap-123/button?format=script
```
```html
<script src="https://unpkg.com/claudebuttons/dist/index.js"></script>
<claude-code-button command="pcc negotiate --capability fdm --kernel kernel-abc" label="Run on Claude Code" context-url="https://capability.network/api/capabilities/cap-123"></claude-code-button>
```

### Contract Building

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/build/options` | Get config options for a capability type. Body: `{type, selections?, profileId?}`. |
| POST | `/api/build/price` | Calculate price for selections. Body: `{type, selections, profileId?}`. |
| POST | `/api/build/contract` | Build a complete contract. Body: `{type, selections, assuranceTier, profileId?}`. |

### Negotiation Sessions

State machine: `CREATED -> CONFIGURING -> QUOTED -> REVIEWING -> COMMITTED`. Sessions auto-expire after 30 minutes.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/negotiate/session` | Create session. Body: `{userAgentId, kernelId, capabilityType}`. |
| GET | `/api/negotiate/session/:id` | Get session state with all params and quote. |
| PATCH | `/api/negotiate/session/:id` | Update session (add selections, advance state). |
| POST | `/api/negotiate/session/:id/commit` | Commit session (creates escrow + job). |

### Kernels (Physical Sites)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/kernels` | List all kernels. Optional `?status=` filter. Returns `{kernels: KernelDTO[]}`. |
| GET | `/api/kernels/:kernelId` | Get kernel with health snapshot. Returns `{kernel: KernelHealthSnapshot}`. |
| GET | `/api/kernels/:kernelId/devices` | List devices. Returns `{devices: DeviceStatusDTO[]}`. |
| GET | `/api/kernels/:kernelId/jobs` | List jobs for kernel. Returns `{jobs: JobDTO[]}`. |
| POST | `/api/kernels` | Register/upsert a kernel. Body: `CreateKernelInput`. |
| POST | `/api/kernels/:kernelId/heartbeat` | Send heartbeat. |
| POST | `/api/kernels/:kernelId/announce` | Announce capabilities to the network. |

### Jobs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs` | List jobs. Optional `?kernelId=&status=&offset=&limit=`. Returns `{jobs: JobDTO[]}`. |
| GET | `/api/jobs/:jobId` | Get job with evidence and timeline. Returns `{job: JobDetailDTO, evidence}`. |
| PATCH | `/api/jobs/:jobId/status` | Update job status. Body: `{status, progress?}`. |
| POST | `/api/jobs/submit` | Submit a job. Body: `{kernelId, capabilityId, params, assuranceTier}`. |

### Escrow & Settlement

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/escrow` | List escrows. Optional `?status=`. Returns `{escrows: EscrowSummaryDTO[]}`. |
| GET | `/api/escrow/:escrowId` | Get escrow by ID or on-chain address. |
| GET | `/api/escrow/chain/:address/events` | On-chain event log. Optional `?fromBlock=`. |
| GET | `/api/escrow/chain/token/:tokenAddress/balance/:account` | ERC-20 balance check. |
| POST | `/api/escrow/fund` | Fund an escrow with USDC. |
| POST | `/api/escrow/:id/release` | Release a milestone. |
| POST | `/api/escrow/:id/dispute` | File a dispute. |

### Evidence & Compliance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/evidence` | List all evidence bundles. |
| GET | `/api/capabilities/:capabilityId/compliance` | Full compliance report. Returns `ComplianceReportDTO`. |
| GET | `/api/jobs/:jobId/drift-alerts` | Real-time drift alerts. Returns `DriftAlertDTO[]`. |
| GET | `/api/jobs/:jobId/evidence` | Evidence bundles for a job. Returns `EvidenceSummaryDTO[]`. |
| GET | `/api/compliance/evidence/:bundleId` | Facade-enriched evidence bundle. |
| GET | `/api/compliance/evidence/:bundleId/tier-compliance` | Tier compliance check. Returns `TierComplianceResult`. |
| POST | `/api/jobs/:jobId/attestations/aggregate` | Aggregate verifier attestations. Body: `{attestations}`. Returns `AggregatedAttestationDTO`. |

### Setup & Detection

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/setup/detect` | Auto-detect config state (env vars, DB, adapters, chain, storage, identity). |
| POST | `/api/setup/generate-config` | Generate `KERNEL_CONFIG` JSON. Body: `{devices, kernelId?, mockMode?}`. |
| POST | `/api/setup/validate` | Validate a kernel config. Body: `{config?}` (JSON string, or reads env). |
| POST | `/api/setup/register-device` | Register a device. Body: `{kernelId, deviceId, type, adapterType, ...}`. |
| POST | `/api/setup/test-job` | Submit test job, polls for completion. Body: `{kernelId?, deviceId?, assuranceTier?}`. |
| GET | `/api/setup/status` | Comprehensive status across 6 categories: gateway, database, adapters, chain, storage, identity. |

### Onboarding & Registration

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/onboard/analyze` | Upload doc, get AI capability analysis. Returns `DocumentAnalysisResult`. |
| POST | `/api/onboard/register` | Submit machine registration. Body: `MachineRegistration`. |
| GET | `/api/onboard/registrations` | List all registrations. |
| GET | `/api/onboard/registrations/:id` | Get registration detail. |
| POST | `/api/onboard/registrations/:id/approve` | Approve a registration (admin). |
| POST | `/api/onboard/registrations/:id/reject` | Reject a registration. Body: `{reason?}`. |
| POST | `/api/onboard/registrations/:id/activate` | Activate an approved registration. |
| POST | `/api/onboard/registrations/:id/prove` | Submit evidence for auto-approval (fast-track). See §2.5. |
| POST | `/api/onboard/redeem` | One-click agent onboarding with invite code. Body: `{inviteCode, email, password}`. |
| GET | `/api/onboard/check/:code` | Validate invite code before redeeming. |
| GET | `/api/onboard/status` | Check what the agent has provisioned (requires Bearer token from redeem). |

### Wizard Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/wizard/sessions` | Create wizard session. Body: `{track}` where track is `platform-setup`, `machine-onboarding`, or `device-builder`. |
| GET | `/api/wizard/sessions/:id` | Get session state with step data and progress. |
| PUT | `/api/wizard/sessions/:id/steps/:step` | Save step data. Body: `{data: {...}}`. Step is 0-indexed. |
| POST | `/api/wizard/sessions/:id/complete` | Complete wizard (orchestrates backend operations). All steps must be completed first. |
| DELETE | `/api/wizard/sessions/:id` | Abandon a wizard session. |

**Wizard tracks and their steps**:

- `platform-setup` (5 steps): environment-detection, chain-configuration, storage-configuration, identity-configuration, review-and-deploy
- `machine-onboarding` (7 steps): machine-info, document-upload, capability-definition, space-requirements, pricing-configuration, operator-profile, review-and-submit
- `device-builder` (5 steps): device-selection, adapter-configuration, capability-mapping, test-connection, register-device

Sessions expire after 24 hours. Step data is merged (not replaced) on updates.

### Payments & Fiat Ramp

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/fiat-ramp/wallet/balance` | USDC balance + pending deposits. |
| GET | `/api/fiat-ramp/funding-options` | Available fiat-to-crypto options. |
| POST | `/api/fiat-ramp/onramp/session` | Create Stripe funding session (card/ACH). |
| POST | `/api/fiat-ramp/onramp/yellowcard` | Mobile money in 34 emerging market countries. |
| GET | `/api/fiat-ramp/rates` | Live Yellowcard exchange rates. |
| POST | `/api/fiat-ramp/offramp/withdraw` | Withdraw USDC to local fiat. |
| POST | `/api/fiat-ramp/payout` | Wise enterprise bank payout (40+ currencies). |
| GET | `/api/fiat-ramp/activity` | Recent on/off ramp activity. |

### DePIN, IP & Governance

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rewards/*` | DePIN epochs, certificates, claims, treasury. |
| GET/POST | `/api/ip/*` | Story Protocol IP registration, royalties, lineage, revenue splits. |
| GET/POST | `/api/swf/*` | Sovereign Wealth Fund governance, proposals, participant dashboard. |
| GET/POST | `/api/csd/*` | Capability StructureDefinition CRUD (FHIR-inspired schemas). |
| GET/POST | `/api/bounty/*` | Demand signals, bounties, leaderboard. |
| GET/POST | `/api/pool/*` | Investment pools, staking, earnings. |

### Agent Network

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents/status` | Agent subnet status + conversations. |
| POST | `/api/agents/heartbeat` | Agent liveness heartbeat. |
| GET | `/api/agents/health` | Health status of all monitored agents. |

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Gateway healthcheck. |
| GET | `/api/status` | Detailed status. |
| GET | `/.well-known/agent-registration.json` | ERC-8004 Agent Registration File (PUBLIC). |
| GET | `/agent-package.json` | 218-tool agent package for any LLM (PUBLIC). |
| GET/POST | `/api/sensors/*` | Sensor channels, readings, anomalies. |
| GET/POST | `/api/zk/*` | ZK proof creation and verification. |
| GET/POST | `/api/logistics/*` | Shipments, bookings, installations. |
| GET/POST | `/api/spaces/*` | Equipment hosting spaces. |
| GET/POST | `/api/marketplace/*` | Capability marketplace listings. |
| GET/POST | `/api/discover/*` | Device discovery (mDNS/IPP) + auto-onboarding. |
| GET/POST | `/api/protocols/*` | Protocol templates (DAG workflows). |
| GET/POST | `/api/orchestrator/*` | Multi-instrument transfer graphs. |
| GET/POST | `/api/batches/*` | Batch manifests (HPLC, multi-sample). |

---

## 2. Operator Onboarding Guide

This section walks through onboarding a real device. Example: "I have a 3D printer running OctoPrint."

### 2.1 Provision an API key

```bash
curl -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email": "operator@myshop.com", "name": "PrintShop Alpha", "capability": "FDM 3D printing"}'
```

Save the `api_key` from the response. Set it for all subsequent requests:
```bash
export PCC_KEY="pcc_live_..."
```

### 2.2 Detect current state

```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/setup/detect
```

Returns a report of what is configured: env vars by category, DB state (kernels/devices/jobs), chain connectivity, storage type, identity status.

### 2.3 Generate kernel config and register

```bash
# Generate config for your printer
curl -X POST https://capability.network/api/setup/generate-config \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kernelId": "kernel_printshop_alpha",
    "devices": [{
      "name": "Prusa MK4",
      "type": "machine",
      "adapterType": "octoprint",
      "url": "http://192.168.1.50",
      "apiKey": "OCTOPRINT_API_KEY"
    }]
  }'
```

Returns `{config, envLine, configJson}`. The `envLine` is ready to paste into your `.env`.

Validate the config:
```bash
curl -X POST https://capability.network/api/setup/validate \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"config": "{\"kernelId\":\"kernel_printshop_alpha\",\"devices\":[...]}"}'
```

Returns `{valid, checks[], errors[], warnings[]}`. Each check has a name, status (pass/warn/fail), and message.

Register the kernel:
```bash
curl -X POST https://capability.network/api/kernels \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "PrintShop Alpha",
    "operatorAddress": "operator@myshop.com",
    "location": {"lat": 37.77, "lng": -122.42},
    "physicalAddress": "123 Maker St, SF CA",
    "maxAssuranceTier": 2
  }'
```

Register the device:
```bash
curl -X POST https://capability.network/api/setup/register-device \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "kernelId": "kernel_printshop_alpha",
    "deviceId": "dev-prusa-mk4-001",
    "type": "machine",
    "model": "Prusa MK4",
    "adapterType": "octoprint",
    "adapterConfig": {"url": "http://192.168.1.50", "apiKey": "OCTOPRINT_API_KEY"},
    "capabilities": ["3d-printing"]
  }'
```

Valid adapter types: `octoprint`, `modbus`, `opcua`, `sila`, `generic-http`, `mock`.
Valid device types: `machine`, `sensor`, `camera`.

### 2.4 Run a test job

```bash
curl -X POST https://capability.network/api/setup/test-job \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"kernelId": "kernel_printshop_alpha", "deviceId": "dev-prusa-mk4-001", "assuranceTier": 0}'
```

This submits a test job and polls for up to 10 seconds. Returns:
```json
{
  "jobId": "test-job-uuid",
  "deviceId": "dev-prusa-mk4-001",
  "status": "completed",
  "evidenceBundleId": "bundle-uuid",
  "duration": 5234
}
```

### 2.5 Prove and activate (fast-track)

If you registered via `/api/onboard/register`, you can skip manual approval by proving your device works:

```bash
curl -X POST https://capability.network/api/onboard/registrations/$REG_ID/prove \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "evidence": {
      "bundleHash": "sha256:abc123def456...",
      "events": [
        {"type": "execution_completed", "timestamp": "2026-04-03T12:00:00Z", "payload": {"jobType": "test", "pagesCount": 1}},
        {"type": "camera_snapshot", "timestamp": "2026-04-03T12:00:01Z", "payload": {"description": "Photo of test print"}}
      ],
      "deviceHealth": {"status": "idle", "model": "Prusa MK4", "firmware": "6.0.0"},
      "photoBase64": "iVBORw0KGgo..."
    }
  }'
```

Evidence determines assurance tier:
- **Tier 0**: Device health only (self-attested).
- **Tier 1**: Bundle hash + events with completion event.
- **Tier 2**: Photo + device health + events (full proof).

On success, the registration is auto-approved and activated immediately. No manual review.

### 2.6 Check setup status

```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/setup/status
```

Returns per-category status (`ready`, `partial`, `unconfigured`) for: gateway, database, adapters, chain, storage, identity. Plus an `overall` status.

### 2.7 Alternative: Wizard flow

For a guided multi-step experience, use wizard sessions:

```bash
# Create a device-builder wizard
curl -X POST https://capability.network/api/wizard/sessions \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"track": "device-builder"}'

# Save step 0 (device-selection)
curl -X PUT https://capability.network/api/wizard/sessions/$SESSION_ID/steps/0 \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"data": {"deviceName": "Prusa MK4", "deviceType": "machine", "adapterType": "octoprint"}}'

# ... save steps 1-4 ...

# Complete — orchestrates registration
curl -X POST https://capability.network/api/wizard/sessions/$SESSION_ID/complete \
  -H "Authorization: Bearer $PCC_KEY"
```

### 2.8 Alternative: pcc-node (one-command onboarding)

For operators who prefer CLI:
```bash
pip install pcc-node
pcc-node start
```

This auto-detects hardware, generates Ed25519 keys, provisions an API key, registers the kernel, announces capabilities, and starts a daemon. Set `PCC_BASE` and `PCC_API_KEY` env vars if not using defaults.

---

## 3. DTOs & Response Shapes

All facade responses use the `Result<T>` pattern: `{success: true, data: T}` or `{success: false, error: {code, message, httpStatus, details?}}`. Routes serialize success as the DTO directly and errors as `{error, message}` with the appropriate HTTP status.

### CapabilityDTO

```typescript
{
  id: string;                        // Unique capability ID
  kernelId: string;                  // Which kernel offers this
  type: string;                      // "3d-printing", "cnc", "hplc", etc.
  name: string;                      // Human-readable name
  description?: string;
  materials: string[];               // Supported materials
  tolerances?: ToleranceSpec;        // Dimensional tolerances
  envelope?: WorkEnvelope;           // Build volume
  assuranceTiers: (0|1|2|3)[];       // Which tiers this supports
  pricing: PricingModel;             // {currency, baseCost, minimum, ...}
  location: {lat, lng};
  tags?: string[];
  // Enrichment (populated by facades):
  reputation?: number;               // 0-1000, from ERC-8004
  queueDepth: number;                // Jobs currently waiting
  available: boolean;                // Currently taking jobs?
  estimatedWaitMinutes?: number;
  kernelName?: string;
  kernelStatus?: "online"|"offline"|"maintenance"|"stale";
}
```

### JobDTO / JobDetailDTO

```typescript
{
  id: string;
  capabilityId: string;
  kernelId: string;
  status: "queued"|"running"|"completed"|"failed"|"cancelled";
  progress?: number;                 // 0-100
  assuranceTier: 0|1|2|3;
  createdAt: string;                 // ISO timestamp
  updatedAt?: string;
  // Enrichment:
  kernelName?: string;
  capabilityType?: string;
  evidenceCount?: number;
  escrowStatus?: string;
  estimatedCompletion?: string;
  // JobDetailDTO adds:
  timeline: JobTimelineEvent[];      // [{type, timestamp, details}]
  evidenceBundles: EvidenceSummaryDTO[];
  escrow?: EscrowSummaryDTO;
}
```

### KernelDTO / KernelHealthSnapshot

```typescript
{
  id: string;
  name: string;
  operatorAddress: string;
  location: {lat, lng};
  physicalAddress: string;
  maxAssuranceTier: 0|1|2|3;
  status: "online"|"offline"|"maintenance"|"suspended";
  lastHeartbeat: string;
  version: string;
  // Enrichment:
  capabilityCount: number;
  capabilityTypes: string[];
  reputation?: number;               // 0-1000
  totalJobsCompleted: number;
  isStale: boolean;                  // Heartbeat >5min old while online
  activeJobCount?: number;
  // KernelHealthSnapshot adds:
  devices: DeviceStatusDTO[];
  recentJobs: JobDTO[];
  uptimePercent?: number;
}
```

### EscrowSummaryDTO

```typescript
{
  id: string;
  jobId: string;
  status: "created"|"funded"|"active"|"completed"|"disputed"|"refunded";
  totalAmount: string;               // USDC amount
  currency: string;
  milestoneCount: number;
  releasedCount: number;
  disputedCount: number;
  challengeWindowEnd?: string;
}
```

### ComplianceReportDTO

```typescript
{
  capabilityId: string;
  kernelId: string;
  satisfiedStandards: string[];      // ISO standards met
  alcoaStatus: ALCOAStatus;          // 10 boolean checks (see §5)
  tierCompliance: Record<0|1|2|3, boolean>;
  recentEvidence: EvidenceSummaryDTO[];
  driftAlerts: DriftAlertDTO[];
}
```

### DriftAlertDTO

```typescript
{
  type: "power_anomaly"|"temperature_excursion"|"duration_mismatch"|"sensor_gap";
  severity: "low"|"medium"|"high"|"critical";
  message: string;
  expectedValue?: string;
  actualValue?: string;
  timestamp: string;
}
```

### DeviceStatusDTO

```typescript
{
  id: string;
  type: string;                      // "machine", "sensor", "camera"
  model?: string;
  status: "idle"|"busy"|"error"|"offline"|"maintenance";
  healthStatus: "healthy"|"degraded"|"offline"|"unknown";
  adapterType?: string;
  capabilities: string[];            // Capability IDs this device serves
}
```

---

## 4. Facades & How They Work

Facades are a clean DTO layer between routes and the database. They handle enrichment (reputation scores, queue depths, compliance status) and return `Result<T>` — routes never throw.

### The 6 Facades

| Facade | Domain | Key Methods |
|--------|--------|-------------|
| CapabilityFacade | Discovery | `list()`, `listByKernel()`, `listByType()`, `search()`, `getById()`, `create()` |
| JobFacade | Execution | `list()`, `getById()`, `updateStatus()` |
| KernelFacade | Infrastructure | `list()`, `getById()`, `getDevices()`, `getJobs()`, `register()` |
| SettlementFacade | Payments | `listEscrows()`, `getEscrow()`, `getChainEvents()`, `getTokenBalance()` |
| ComplianceFacade | Compliance | `generateComplianceReport()`, `detectDrift()`, `getEvidenceForJob()`, `checkTierCompliance()`, `aggregateAttestations()` |
| AgentFacade | Identity/RBAC | Agent sessions, role permissions, Separation of Duties enforcement |

### PopulationContext

Control what enrichment facades perform by passing a PopulationContext:

```typescript
{
  viewerDid?: string;          // For personalized pricing/trust gates
  currency?: string;           // Price conversion currency
  includeReputation?: boolean; // Fetch ERC-8004 reputation scores
  includeCompliance?: boolean; // Include audit/compliance status
  includeHealth?: boolean;     // Real-time device health
  reputationCache?: Map;       // Pre-loaded scores (prevents N+1)
  queueDepthCache?: Map;       // Pre-loaded queue depths
  applyColdStartGate?: boolean; // Cap tier by reputation thresholds
}
```

---

## 5. Safety & Compliance

### Assurance Tiers

| Tier | Name | Evidence Required | Use Case |
|------|------|-------------------|----------|
| 0 | Self-Attested | Device health snapshot | Prototyping, non-critical |
| 1 | Verified | Bundle hash + completion events | Standard production |
| 2 | Certified | Photo + device health + event log + sensor data | Regulated manufacturing |
| 3 | Sovereign | Full evidence chain + ZK proofs + multi-verifier attestation + IPFS storage | Medical, aerospace, pharma |

### ALCOA+ Compliance (10 Principles)

Every evidence bundle is checked against these principles:

| Principle | Check |
|-----------|-------|
| **A**ttributable | source.deviceId + source.kernelId present |
| **L**egible | Data readable and hash-verifiable |
| **C**ontemporaneous | Timestamps within execution window |
| **O**riginal | Bundle from kernel (signature present, not test-signed) |
| **A**ccurate | Tier requirements satisfied, event hashes verified |
| **+C**onsistent | No high/critical duration_mismatch drift alerts |
| **+C**omplete | All required event types present, no sensor_gap alerts |
| **+C**redible | Verifier confidence >= 90% |
| **+E**nduring | Stored on IPFS/Storacha (durable reference) |
| **+A**vailable | Accessible via gateway and storage CID |

### Drift Detection

The compliance facade monitors for 4 drift types during job execution:
- `power_anomaly` — unexpected power consumption patterns
- `temperature_excursion` — temperature outside operational envelope
- `duration_mismatch` — job duration differs significantly from expected
- `sensor_gap` — missing sensor readings during execution

Check drift alerts:
```bash
curl -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/api/jobs/$JOB_ID/drift-alerts
```

### Constitutional Constraints

Every agent role has OWASP ASI01-10 hard rules that survive prompt injection. The SafetyGateway is the only path to hardware commands. Operations are classified into 4 classes:
- **READ** — always allowed
- **SAFE CONTROL** — allowed during active job (home, lights)
- **SCOPED WRITE** — requires an active execution scope
- **PRIVILEGED** — requires explicit operator approval

---

## 6. Settlement & Payments

### Escrow Lifecycle

```
CREATE -> FUND (deposit USDC) -> ACTIVE (job running) -> MILESTONES (evidence submitted)
  -> RELEASE (evidence meets tier) or DISPUTE (evidence insufficient)
```

Escrow contracts are on Base Sepolia (testnet). The protocol charges a 2.35% fee on every settlement, hardcoded in the smart contract.

### Default Payment Protocol (MPP)

MPP is the default payment rail. Milestone escrow with automatic release when evidence passes verification.

### Fiat On/Off Ramps

- **Stripe**: Visa/Mastercard/AMEX/ACH to USDC on Base
- **Yellowcard**: Mobile money in 34 emerging market countries to USDC
- **Wise**: Enterprise bank payouts in 40+ currencies (off-ramp)

---

## 7. MCP Server (56 Tools)

Connect the PCC MCP server to Claude Code or any MCP-compatible client.

**Configuration** (add to Claude Code settings or `~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "pcc": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {"PCC_URL": "https://capability.network"}
    }
  }
}
```

**All 56 MCP tools** (tools 50-56 are contributor-economics primitives — see §12):

| # | Tool | Description |
|---|------|-------------|
| 1 | `pcc_list_capabilities` | List registered capability types |
| 2 | `pcc_search_capabilities` | Search templates with details |
| 3 | `pcc_list_kernels` | List kernels, filter by status |
| 4 | `pcc_get_kernel` | Kernel details + devices |
| 5 | `pcc_list_jobs` | List jobs, filter by kernel/status |
| 6 | `pcc_get_job` | Job details + evidence bundles |
| 7 | `pcc_build_options` | Config options for a capability type |
| 8 | `pcc_calculate_price` | Calculate price for selections |
| 9 | `pcc_build_contract` | Build contract ready for escrow |
| 10 | `pcc_list_escrows` | List escrow contracts |
| 11 | `pcc_list_evidence` | List evidence bundles |
| 12 | `pcc_list_protocols` | List workflow templates |
| 13 | `pcc_depin_stats` | DePIN rewards, certificates, treasury |
| 14 | `pcc_subnet_status` | Agent network status |
| 15 | `pcc_get_agent_identity` | ERC-8004 identity for kernel/agent |
| 16 | `pcc_get_reputation` | Reputation scores by agent/tag |
| 17 | `pcc_list_sensors` | Sensor channels for a kernel |
| 18 | `pcc_get_sensor_data` | Sensor readings for a channel |
| 19 | `pcc_get_evidence` | Evidence bundle: IPFS CID, ZK proof, scores |
| 20 | `pcc_compile_workflow` | Compile DAG from steps |
| 21 | `pcc_agent_registration` | ERC-8004 Agent Registration File |
| 22 | `pcc_setup_detect` | Auto-detect configuration state |
| 23 | `pcc_setup_generate_config` | Generate KERNEL_CONFIG from descriptions |
| 24 | `pcc_setup_validate_config` | Validate kernel configuration |
| 25 | `pcc_setup_register_device` | Register a physical device |
| 26 | `pcc_setup_health_check` | Run device health checks |
| 27 | `pcc_setup_test_job` | Submit test job to verify pipeline |
| 28 | `pcc_setup_generate_env` | Generate .env file |
| 29 | `pcc_setup_status` | Comprehensive setup status |
| 30 | `pcc_csd_list` | List CSD documents |
| 31 | `pcc_csd_get` | Get CSD by URI |
| 32 | `pcc_csd_register` | Register a CSD document |
| 33 | `pcc_discover_scan` | Scan network for devices (mDNS/IPP) |
| 34 | `pcc_discover_onboard` | Discover, generate CSD, register in one call |
| 35 | `pcc_ip_register_capability` | Register CSD as Story Protocol IP |
| 36 | `pcc_ip_revenue_snapshot` | IP Royalty Vault balance |
| 37 | `pcc_ip_claim` | Claim accumulated royalties |
| 38 | `pcc_ip_lineage` | IP provenance graph |
| 39 | `pcc_ip_set_splits` | Configure revenue splits |
| 40 | `pcc_swf_summary` | Sovereign Wealth Fund overview |
| 41 | `pcc_swf_participant_dashboard` | SWF participant earnings |
| 42 | `pcc_swf_list_proposals` | List governance proposals |
| 43 | `pcc_get_wallet_balance` | USDC balance + pending + credits |
| 44 | `pcc_get_funding_options` | Fiat-to-crypto options |
| 45 | `pcc_create_onramp_session` | Create fiat funding session |
| 46 | `pcc_get_provider_rates` | Yellowcard exchange rates |
| 47 | `pcc_submit_withdrawal` | Withdraw USDC to fiat |
| 48 | `pcc_get_ramp_activity` | Recent ramp activity |
| 49 | `pcc_send_enterprise_payout` | Wise bank payout (40+ currencies) |
| 50 | `pcc_contributor_register` | Register a contributor profile (DB-only; on-chain `ContributorNFT` mint is a separate forge step — see §12.6) |
| 51 | `pcc_contributor_list` | List all profiles for an address |
| 52 | `pcc_schedule_publish` | Publish an immutable `RateSchedule` (canonicalized + sha256-keyed) |
| 53 | `pcc_schedule_get` | Fetch a published `RateSchedule` by hash |
| 54 | `pcc_schedule_evaluate` | Evaluate a `RateSchedule` at given time / jobValue / jobsPerDay → `bps` |
| 55 | `pcc_training_manifest_set` | Register a `ModelNFT`'s training manifest (dataset weights) |
| 56 | `pcc_training_manifest_get` | Fetch a model's training manifest |

For the full contributor-economics surface (REST endpoints, DSL, walkthrough), see §12.

---

## 8. Agent Package (218 Tools)

The agent package is a single JSON file any LLM can consume, containing 218 tools with input schemas and endpoint mappings (re-numbered in v2.8.0 — was 219 before contributor-economics consolidation).

**Fetch it**:
```bash
curl https://capability.network/agent-package.json
```

**Format**: Each tool has `name`, `description`, `input_schema` (JSON Schema), and `endpoint` (`{method, path}`).

**How to use**: Load the JSON, present tool descriptions to your LLM, and when the LLM selects a tool, make the corresponding HTTP request to `https://capability.network` + the endpoint path, passing the input as the request body (POST/PUT/PATCH) or query params (GET).

The `system_prompt` field in the package contains bootstrap instructions including the 5-step self-onboarding flow.

The package now includes the 7 contributor-economics tools (rows 50-56 in §7, fully described in §12).

---

## 9. Environment Variables

These are the operator-facing environment variables for configuring a PCC node or gateway:

| Variable | Description | Default |
|----------|-------------|---------|
| `PCC_URL` | Gateway URL (for MCP server and clients) | `https://capability.network` |
| `PCC_BASE` | Gateway URL (for pcc-node Python CLI) | `https://capability.network` |
| `PCC_API_KEY` | Bearer token for gateway API | none |
| `KERNEL_ID` | Override kernel ID | auto-generated |
| `KERNEL_CONFIG` | Inline JSON kernel configuration | mock |
| `KERNEL_CONFIG_FILE` | Path to kernel config JSON file | none |
| `PCC_NETWORK` | Blockchain network name | `base-sepolia` |
| `ESCROW_CONTRACT_ADDRESS` | Deployed MilestoneEscrow address | none |
| `EVIDENCE_STORAGE` | Evidence backend: `local`, `helia`, `storacha` | `local` |
| `LIT_PROTOCOL_REAL` | Enable Lit Protocol encryption | `false` |
| `SSE_AUTH_REQUIRED` | Enforce auth on SSE streams | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint for traces | none |
| `IDEMPOTENCY_TTL_MS` | Idempotency cache TTL in ms | `86400000` (24h) |

---

## 10. SSE Streams (Real-Time Events)

Subscribe to Server-Sent Events for real-time updates. Connect with `EventSource` or `curl`.

| Stream | URL | Events |
|--------|-----|--------|
| Job updates | `GET /sse/stream/job/:jobId` | Status changes, progress, evidence received |
| Kernel updates | `GET /sse/stream/kernel/:kernelId` | Heartbeat, device status, job assignments |
| Device updates | `GET /sse/stream/device/:deviceId` | Health changes, sensor readings |
| Batch updates | `GET /sse/stream/batch/:batchId` | Batch job progress |
| Notifications | `GET /sse/notifications` | Global notification stream |
| Camera stream | `GET /api/ot2/camera/stream` | Live camera frames from equipment |

Example:
```bash
curl -N -H "Authorization: Bearer $PCC_KEY" \
  https://capability.network/sse/stream/job/job-uuid-123
```

---

## 11. pcc-node (Python Operator Node)

`pcc-node` is a pip-installable Python CLI that turns any machine into a PCC operator node.

### Install and run

```bash
pip install pcc-node
pcc-node start
```

This single command:
1. Auto-detects connected hardware (printers, lab equipment, cameras)
2. Generates Ed25519 signing keys
3. Provisions an API key from the gateway
4. Registers a kernel and announces capabilities
5. Starts a daemon that processes jobs and emits evidence

### Commands

| Command | Description |
|---------|-------------|
| `pcc-node start` | Full auto-setup and daemon start |
| `pcc-node detect` | Hardware scan only (no registration) |
| `pcc-node status` | Check daemon status |
| `pcc-node import-job <file>` | Import G-code, STL, Opentrons protocol, or CSV plate layout |

### Configuration

Set these environment variables before running:
```bash
export PCC_BASE=https://capability.network
export PCC_API_KEY=pcc_live_...
export KERNEL_ID=my-kernel-001  # optional
```

---

## 12. Contributor Economics

> **What's new (2026-04)**: Adapter authors, protocol authors, model authors, dataset contributors, verifiers, and insurers can now earn per-job royalties via the Contributor Economics primitives. See §12.6 for an end-to-end walkthrough.

### 12.1 What contributor economics is

Contributor economics is the protocol layer that lets non-operator participants earn per-job royalties on PCC. Each contributor publishes an immutable `RateSchedule` (canonicalized + content-addressed) and mints a `ContributorNFT` that anchors their wallet address + role + schedule on-chain. At job settlement time, `MilestoneEscrow.splitPayout()` evaluates every attached contributor's schedule (current time + job value + adoption stats) and routes the on-chain Payout array directly to each contributor's wallet — no manual reconciliation, no off-chain bookkeeping.

### 12.2 The 8 new REST endpoints

All endpoints under `/api/contributors`. All require `Authorization: Bearer <key>` (same as other routes).

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/contributors` | Register a contributor profile (DB row). Body: `{address, role, scheduleHash, ipId?, metadataUri?, contributorNftTokenId?}`. Returns 201 with `{profile: ContributorProfile}` (the full upserted profile, not just an id). |
| GET | `/api/contributors/:address` | List all profiles for an address. Returns `{profiles: ContributorProfile[]}`. |
| GET | `/api/contributors/by-role/:role` | List all addresses with a given role. Returns `{profiles: ContributorProfile[]}` (the route does not echo the `role` parameter back). |
| POST | `/api/contributors/schedules` | Publish a rate schedule. Body: `{publishedBy, schedule: RateSchedule}`. The inner `schedule` may also carry `notes`, `scheduleHash`, `publishedAt` — all optional; the server recomputes the hash and rejects mismatches. Server canonicalizes JSON, computes sha256, persists. Returns `{scheduleHash, alreadyPublished}`. |
| GET | `/api/contributors/schedules/:scheduleHash` | Fetch a published schedule (Zod-validated). Returns `{schedule, publishedBy}` where `publishedAt` is nested INSIDE `schedule` (and `scheduleHash` is also embedded in `schedule`). |
| POST | `/api/contributors/schedules/:scheduleHash/evaluate` | Evaluate a schedule. Body: `{now, jobValueCents?, jobsPerDay?}`. Returns `{scheduleHash, bps, segmentKind, segmentIndex}`. |
| POST | `/api/contributors/training-manifests` | Register a model's training manifest. Body: `{modelIpId, baseModelIpId?, datasetWeights: [{datasetIpId, weightBps}], methodologyHash?}` (the optional `methodologyHash` is a 0x64hex reproducibility hash). Server computes `manifestHash`. Returns `{modelIpId, manifestHash}`. |
| GET | `/api/contributors/training-manifests/:modelIpId` | Fetch a training manifest. Returns `{manifest: {modelIpId, baseModelIpId, datasets, methodologyHash, manifestHash, createdAt}}` — note `manifestHash` is nested inside `manifest` (not a top-level field) and the timestamp field is `createdAt`, not `registeredAt`. |

### 12.3 The 7 new MCP tools

These are tools 50-56 in the MCP server (see §7).

| # | Tool | Description |
|---|------|-------------|
| 50 | `pcc_contributor_register` | Register a contributor profile (DB-only; on-chain `ContributorNFT` mint is a separate forge step — see §12.6) |
| 51 | `pcc_contributor_list` | List all profiles for an address |
| 52 | `pcc_schedule_publish` | Publish an immutable `RateSchedule` (canonicalized + sha256-keyed) |
| 53 | `pcc_schedule_get` | Fetch a published `RateSchedule` by hash |
| 54 | `pcc_schedule_evaluate` | Evaluate a `RateSchedule` at given time / jobValue / jobsPerDay → `bps` |
| 55 | `pcc_training_manifest_set` | Register a `ModelNFT`'s training manifest (dataset weights) |
| 56 | `pcc_training_manifest_get` | Fetch a model's training manifest |

### 12.4 The 10-role taxonomy

Contributor profiles must declare a `role` from this fixed taxonomy:

`operator` (residual recipient — gets whatever is left after splits) · `verifier` · `insurer` · `integrator` · `protocol-author` · `model-author` · `dataset-contributor` · `curator` · `assembler` · `network-treasury`

**Note (explicit, by design)**: there is no OEM royalty class. Hardware manufacturers do not get a built-in revenue stream — only the contributors who produce the executable assets running on top of that hardware. Full rationale: `docs/claros-layer4-amendment.md` and `ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md`.

**Footnote on legacy roles**: `packages/spec/src/types/story.ts` retains a deprecated `designer` member purely so legacy records still decode (see ADR-12 §2.2). Do not register new profiles with `designer`; pick the appropriate post-migration role instead (`protocol-author`, `assembler`, or `integrator`, depending on what the legacy record described).

### 12.5 RateSchedule segment DSL

A `RateSchedule` is a list of segments evaluated against `(now, jobValueCents, jobsPerDay)`. Six segment kinds are supported: `constant`, `step`, `linear-decay`, `exponential-decay`, `adoption-indexed`, `piecewise-value`.

Example — a tapering rate that decays from 80bp to 10bp over 18 months:

```typescript
const schedule = {
  version: 1,
  segments: [
    { kind: "constant", startTime: 0, endTime: 15552000, bps: 80 },        // 80bp first 6mo
    { kind: "constant", startTime: 15552000, endTime: 47174400, bps: 40 }, // 40bp mo 7-18
    { kind: "constant", startTime: 47174400, endTime: null, bps: 10 },     // 10bp forever after
  ],
};
```

Full DSL — including the other 5 segment kinds, validation rules, and the canonicalization spec — lives at `packages/spec/src/types/rate-schedule.ts`.

**Note on wire format vs evaluator input**: the example above is the *wire body* you POST to `/api/contributors/schedules` — the server canonicalizes the inner JSON, computes `scheduleHash`, and stamps `publishedAt` for you. If you instead want to call `evaluateRateSchedule(schedule, ctx)` directly (off-chain, in a script), `RateScheduleSchema` requires both `scheduleHash: 0x<64hex>` and `publishedAt: ISO-8601 string` to be present locally; either fill them in by hand or fetch the materialized schedule via `GET /api/contributors/schedules/:scheduleHash` first.

### 12.6 End-to-end walkthrough

How an integrator publishes a schedule, mints an NFT, and gets paid through a real job:

```bash
# 1. Publish the schedule (off-chain, canonicalized + content-addressed)
SCHEDULE='{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":40}]}'
curl -X POST https://capability.network/api/contributors/schedules \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"publishedBy\":\"0x000000000000000000000000000000000000dEaD\",\"schedule\":$SCHEDULE}"
# -> {"scheduleHash":"0xabc...","alreadyPublished":false}

# 2. (Optional) Publish on-chain so anyone can verify the bytes. The forge
#    script lives at `packages/contracts/script/PublishSchedule.s.sol` and
#    calls `RateScheduleRegistry.publish(bytes, expectedHash)`. For the
#    cast-send equivalent (no forge), see
#    `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` "Smoke-publish a schedule".
forge script script/PublishSchedule.s.sol --broadcast \
  --rpc-url $BASE_SEPOLIA_RPC

# 3. Register your contributor profile (pointing at the schedule)
curl -X POST https://capability.network/api/contributors \
  -H "Authorization: Bearer $PCC_KEY" \
  -d '{"address":"0x000000000000000000000000000000000000dEaD","role":"integrator","scheduleHash":"0xabc..."}'

# 4. (Optional) Mint a ContributorNFT on-chain. The forge script lives at
#    `packages/contracts/script/MintContributor.s.sol` and calls
#    `nft.mint(role, scheduleHash, ipId, metadataUri)` against the deployed
#    ContributorNFT.
forge script script/MintContributor.s.sol --broadcast --rpc-url $BASE_SEPOLIA_RPC

# 5. When a job uses your adapter, the payer's buildPayoutMap()
#    automatically evaluates your schedule and includes you in the on-chain
#    Payout[] passed to MilestoneEscrow.setPayoutMap().
#    On release(), splitPayout sends your share directly to your wallet.
#
#    `packages/contracts/ts/payouts.ts:buildPayoutMap()` consumes the
#    capability's CompositionManifest + each contributor's RateSchedule and
#    produces a Payout[] ready to feed setPayoutMap(). The full on-chain
#    setPayoutMap + splitPayout + release path is shipped.
```

> **Note**: `BASE_SEPOLIA_RPC` referenced in Steps 2 and 4 above defaults to
> `https://sepolia.base.org` (the same value used in
> `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`). Set it explicitly if you want to
> override (Alchemy / Infura / QuickNode endpoints work; pair with
> `--rpc-url $BASE_SEPOLIA_RPC` on every cast/forge call).

For deployment recipes (forge scripts, contract addresses, env vars), see `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md`. For end-user docs (how to register, how splits work, FAQ), see `docs/CONTRIBUTOR_ECONOMICS.md`.

---

## 13. Agent Workflows (Quick Reference)

**New operator setup**:
`provision key` -> `setup detect` -> `generate config` -> `validate` -> `register kernel` -> `register device` -> `test job` -> `prove`

**Build a contract**:
`list capability types` -> `build options` -> `calculate price` -> `build contract` -> `fund escrow` -> `submit job`

**Monitor a job**:
`get job` (poll) or `SSE /sse/stream/job/:id` (real-time) -> `get drift alerts` -> `get evidence`

**Check compliance**:
`GET /api/capabilities/:id/compliance` -> review `alcoaStatus` and `driftAlerts`

**Embed a button**:
`GET /api/capabilities/:id/button?format=script` -> paste HTML into any website

**Publish a contributor royalty schedule** (see §12):
`publish schedule` (POST `/api/contributors/schedules`) -> `register profile` (POST `/api/contributors`) -> `mint ContributorNFT` (forge) -> earn on every job
