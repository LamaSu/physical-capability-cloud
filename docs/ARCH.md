# Architecture: Physical Capability Cloud

## The AWS Analogy

| AWS Concept | PCC Equivalent | Description |
|-------------|---------------|-------------|
| Region | Geographic Zone | Metro area with courier coverage |
| Availability Zone | Shop Kernel | Single physical site with equipment |
| EC2 Instance Type | Capability Type | "5-axis CNC Tier-2" or "FDM batch tray" |
| Instance (running) | Capability Slot | A reserved time window on a capability |
| S3 Request | Evidence Bundle | Immutable, content-addressed attestation |
| Lambda Invocation | Digital Microservice | Quote, route, simulate (x402-gated) |
| IAM | Identity Registry | ERC-8004 machine + operator identities |
| CloudWatch | Observability | Telemetry, events, evidence trails |
| SLA Tier | Assurance Tier | Evidence depth + liability + dispute rules |
| Spot vs On-Demand | Priority Levels | Economy vs Standard vs Premium scheduling |
| Billing | Settlement Layer | Milestone escrow + x402 micropayments |

## Core Abstractions

### 1. Shop Kernel

The Shop Kernel is the **boundary of trust** for a physical site. It is the only entity
the global protocol communicates with. Internally it may have any topology — one machine
or fifty, robots, humans, cameras, sensors. Externally it exposes:

- **Capability Endpoints**: What this shop can do, with specs and availability
- **Signed Evidence Bundles**: Cryptographic proof that work happened
- **Custody Events**: Handoff tracking for physical items

The Shop Kernel is analogous to an AWS Outpost — it runs the platform's agent locally
but is governed by the global control plane.

### 2. Capability

A Capability is the **unit of billing and routing**. Not "a machine" but "what a machine
can do at a certain quality level."

```
Capability = {
  type: "cnc-3axis" | "cnc-5axis" | "fdm" | "sla" | "lathe" | "laser-cut" | ...
  materials: ["aluminum-6061", "pla", "abs", ...],
  tolerances: { linear: "±0.05mm", surface: "Ra 1.6" },
  envelope: { x: 300, y: 300, z: 300, unit: "mm" },
  assuranceTiers: [0, 1, 2],
  availability: Schedule,
  pricing: PricingModel
}
```

### 3. Assurance Tiers

| Tier | Evidence Required | Dispute Window | Bond Required | Use Case |
|------|-------------------|----------------|---------------|----------|
| 0 | G-code hash match only | 1 hour | None | Low-value prototyping |
| 1 | + Power profile match | 4 hours | 5% of job value | Standard production |
| 2 | + Camera CV verification | 24 hours | 15% of job value | Quality-critical parts |
| 3 | + Independent inspector + TEE attestation | 72 hours | 25% of job value | Aerospace/medical |

### 4. Capability Workflow Manifest (CWM)

A CWM is a declarative description of a multi-step manufacturing workflow:

```json
{
  "version": "1.0",
  "id": "cwm_abc123",
  "steps": [
    {
      "id": "step_1",
      "capability": "fdm",
      "params": { "material": "pla", "infill": 20, "layer_height": 0.2 },
      "input": { "gcode_hash": "sha256:abc..." },
      "assuranceTier": 1,
      "dependsOn": []
    },
    {
      "id": "step_2",
      "capability": "courier-pickup",
      "params": { "from": "step_1.shop", "to": "user_address" },
      "assuranceTier": 0,
      "dependsOn": ["step_1"]
    }
  ],
  "settlement": {
    "currency": "USDC",
    "maxBudget": "50.00",
    "escrowContract": "0x..."
  }
}
```

### 5. Evidence System

Evidence is collected at multiple layers and bundled into content-addressed bundles:

```
EvidenceEvent = {
  id: string,
  type: "gcode_loaded" | "execution_started" | "power_profile" |
        "camera_snapshot" | "cv_result" | "vibration_signature" |
        "execution_completed" | "custody_handoff" | ...,
  timestamp: ISO8601,
  source: { deviceId: string, kernelId: string },
  payload: Record<string, unknown>,
  hash: SHA256
}

EvidenceBundle = {
  jobId: string,
  stepId: string,
  events: EvidenceEvent[],
  assuranceTier: 0 | 1 | 2 | 3,
  bundleHash: SHA256(canonical(events)),
  signature: KernelSignature
}
```

### 6. Settlement Flow

```
User submits CWM
  → Planner routes steps to Shop Kernels
  → User funds milestone escrow (per-step amounts)
  → For each step:
      → Shop Kernel executes capability
      → Evidence events emitted in real-time
      → Evidence bundle signed and submitted
      → Verifier(s) attest the bundle
      → Challenge window opens
      → If no dispute: escrow releases to shop operator
      → If dispute: evidence reviewed, arbitration, slashing if fraud
```

## Data Flow

### Happy Path
```
User → [x402: quote] → Scheduler → selects shops → returns plan + price
User → [fund escrow] → Settlement Contract
Settlement Contract → [job committed] → Shop Kernel A
Shop Kernel A → [execute] → Machine → [telemetry] → Evidence Emitter
Evidence Emitter → [bundle] → Verifier Market
Verifier → [attest] → Settlement Contract
Settlement Contract → [challenge window expires] → [release payment] → Shop Operator
Shop Kernel A → [custody handoff] → Courier
Courier → [delivery confirmed] → Settlement Contract → [release courier payment]
```

### Dispute Path
```
Evidence Bundle submitted → Challenge window opens
Disputer → [stake bond] → [submit challenge]
Arbitration Panel → [review evidence] → [vote]
  → If legitimate: challenger wins, operator slashed, job refunded
  → If frivolous: challenger bond slashed, operator compensated
```

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Monorepo | pnpm + turbo | Fast, workspace-aware |
| Language | TypeScript | Full-stack, strong typing |
| API Framework | Fastify | Fast, schema validation built-in |
| Contracts | Solidity + Foundry | Industry standard, fast tests |
| Chain | Base (L2) or Arbitrum | Low fees, EVM compatible |
| Database | SQLite (v1) → Postgres | Simple start, scale later |
| Event Store | Append-only SQLite table | Event sourcing for audit trail |
| Off-chain Storage | Filesystem (v1) → IPFS/S3 | Content-addressed blobs |
| Identity | ERC-8004 integration surface | Machine + operator DIDs |
| Digital Payments | x402 | Per-request micropayments |
| Physical Payments | Milestone escrow | Step-by-step release |
| Courier API | Uber Direct / Roadie | Last-mile delivery |

## Security Model

See [THREAT_MODEL.md](./THREAT_MODEL.md) for full threat model.

Key principles:
- **Assume good faith, design for disputes**: Most operators are honest. But any party can challenge.
- **Economic security**: Bonds make fraud unprofitable. Slashing exceeds potential gain.
- **Multi-signal verification**: No single evidence source is trusted alone at Tier 2+.
- **Shop Kernel as trust boundary**: The kernel signs evidence; its reputation is at stake.
- **Progressive trust**: New operators start at Tier 0/1 only. Earn access to higher tiers through track record.
