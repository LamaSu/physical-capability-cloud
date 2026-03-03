# Physical Capability Cloud — Build Plan

## Vision
AWS for the physical world. Shops are Availability Zones. Capabilities are billable units. Assurance tiers are SLAs.

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    CONTROL PLANE (off-chain)                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Scheduler│  │ Router   │  │ Verifier │  │ x402 Gate  │  │
│  │ /Planner │  │          │  │ Market   │  │ (payments) │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬──────┘  │
│       │              │              │               │        │
│       └──────────────┴──────────────┴───────────────┘        │
│                          │                                    │
└──────────────────────────┼────────────────────────────────────┘
                           │  Capability API
              ┌────────────┴────────────┐
              │                         │
    ┌─────────▼──────────┐   ┌─────────▼──────────┐
    │   SHOP KERNEL A    │   │   SHOP KERNEL B    │
    │  ┌──────┐ ┌──────┐ │   │  ┌──────┐ ┌──────┐ │
    │  │ CNC  │ │ 3DP  │ │   │  │Lathe │ │ Mill │ │
    │  └──────┘ └──────┘ │   │  └──────┘ └──────┘ │
    │  ┌──────┐ ┌──────┐ │   │  ┌──────┐ ┌──────┐ │
    │  │Camera│ │Power │ │   │  │Camera│ │Vibr. │ │
    │  └──────┘ └──────┘ │   │  └──────┘ └──────┘ │
    │  Evidence Emitter   │   │  Evidence Emitter   │
    └─────────┬──────────┘   └─────────┬──────────┘
              │                         │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   SETTLEMENT LAYER      │
              │   (on-chain)            │
              │  ┌────────────────────┐ │
              │  │ Milestone Escrow   │ │
              │  │ Identity Registry  │ │
              │  │ Reputation Registry│ │
              │  │ Bonds + Slashing   │ │
              │  └────────────────────┘ │
              └─────────────────────────┘
```

## Milestones

### M0: Foundation (this session)
- [x] Repo scaffold (pnpm + turbo monorepo)
- [ ] Core schemas (CWM, Evidence, Capability, Custody)
- [ ] Architecture doc
- [ ] TypeScript types for all specs

### M1: Shop Kernel
- [ ] Capability API (OpenAPI spec + Fastify server)
- [ ] Mock device adapters (CNC, 3DP, Lathe)
- [ ] Mock sensor adapters (Camera, Power, Vibration)
- [ ] Evidence emitter (collects, hashes, signs evidence bundles)
- [ ] Custody event manager (tracks physical handoffs)

### M2: Settlement Layer
- [ ] Milestone escrow contract (Solidity)
- [ ] Bond + slashing mechanics
- [ ] Challenge window + dispute resolution
- [ ] Identity registry (ERC-8004 integration surface)
- [ ] Reputation registry

### M3: Control Plane
- [ ] Workflow compiler (CWM → execution plan)
- [ ] Scheduler/Router (match capabilities to shops)
- [ ] Verifier market (hybrid: open Tier0/1, curated Tier2/3)
- [ ] x402 payment gateway for digital microservices

### M4: Integration
- [ ] End-to-end simulation (submit → plan → execute → attest → settle)
- [ ] Dispute path test
- [ ] Courier/logistics integration surface

### M5: UI
- [ ] Operator dashboard
- [ ] User workflow submission + tracking
- [ ] Evidence viewer + dispute interface

## Repo Layout

```
physical-capability-cloud/
├── packages/
│   ├── spec/           # Schemas, types, validation (single source of truth)
│   ├── contracts/      # Solidity contracts + Foundry tests
│   ├── kernel/         # Shop kernel runtime
│   ├── payments/       # x402 middleware + payment helpers
│   ├── scheduler/      # Workflow compiler + router
│   ├── verifier/       # Hybrid verifier service
│   └── ui/             # Shared UI components
├── apps/
│   ├── operator/       # Operator dashboard
│   └── user/           # User-facing app
├── docs/
│   ├── PLAN.md
│   ├── ARCH.md
│   └── THREAT_MODEL.md
└── scripts/
```

## Invariants (must never be broken)

1. All schemas live in `packages/spec` — no other package defines wire types.
2. Every Evidence Bundle is content-addressed (SHA-256 hash of canonical JSON).
3. On-chain state only stores hashes/commitments, never raw data.
4. Shop Kernel is the only external interface to a physical site.
5. Every capability has an assurance tier; every tier has defined evidence requirements.
6. Escrow only settles when evidence meets the contract's tier requirements.
7. Any party can dispute within the challenge window.
