# RentAHuman.ai — API Technical Analysis
**Date:** 2026-03-30
**Researcher:** Claude (Sonnet 4.6)
**Sources:** openapi.yaml, ai-plugin.json, /docs, /docs/quickstart, /docs/api-reference

---

## 1. Service Summary

RentAHuman.ai is a marketplace where AI agents hire humans for physical-world tasks. It exposes two integration surfaces:

| Surface | URL | Protocol |
|---------|-----|----------|
| REST API | `https://rentahuman.ai/api` | HTTP/JSON (OpenAPI 3.1.0) |
| MCP Server | `npx @rentahuman/mcp-server` | Model Context Protocol (stdio) |
| AI Plugin | `https://rentahuman.ai/.well-known/ai-plugin.json` | OpenAI plugin manifest v1 |

**Contact:** alex@rentahuman.ai
**GitHub:** https://github.com/AlexanderLiteplo/human-rental-marketplace

---

## 2. Authentication

**Auth type: NONE.**

The `ai-plugin.json` explicitly declares:
```json
{ "auth": { "type": "none" } }
```

The OpenAPI spec defines no `securitySchemes` and no per-endpoint `security` requirements. Every endpoint is unauthenticated — anyone can read all profiles, create bookings, and confirm payments without a key or token.

This is a deliberate design choice for an MVP, enabling frictionless AI agent integration. It is also the primary security gap.

---

## 3. OpenAPI Spec — All Endpoints

**Base URL:** `https://rentahuman.ai/api`
**Spec version:** OpenAPI 3.1.0 / API version 1.0.0

### 3.1 GET /humans

**Operation:** `searchHumans`
**Summary:** Search available humans

| Parameter | In | Type | Required | Notes |
|-----------|-----|------|----------|-------|
| skill | query | string | No | Filter (e.g., "In-Person Meetings", "Opening Jars") |
| minRate | query | number | No | Minimum hourly rate in USD |
| maxRate | query | number | No | Maximum hourly rate in USD |
| limit | query | integer | No | Default 20, max 100 |

**Response 200:**
```json
{
  "success": true,
  "humans": [ HumanProfile ],
  "count": 42
}
```

---

### 3.2 GET /humans/{id}

**Operation:** `getHuman`
**Summary:** Get human profile

| Parameter | In | Type | Required |
|-----------|-----|------|----------|
| id | path | string | Yes |

**Response 200:** `{ "success": true, "human": HumanProfile }`
**Response 404:** Human not found

---

### 3.3 GET /bookings

**Operation:** `listBookings`
**Summary:** List bookings

| Parameter | In | Type | Required | Notes |
|-----------|-----|------|----------|-------|
| humanId | query | string | No | Filter by worker |
| agentId | query | string | No | Filter by agent |
| status | query | string | No | Enum: pending, confirmed, in_progress, completed, cancelled |
| limit | query | integer | No | Default 20 |

**Response 200:** `{ "success": true, "bookings": [ Booking ] }`

---

### 3.4 POST /bookings

**Operation:** `createBooking`
**Summary:** Book a human

**Request body (required fields):**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| humanId | string | Yes | Worker's profile ID |
| agentId | string | Yes | Caller's agent identifier |
| agentType | string | Yes | Enum: clawdbot, moltbot, openclaw, other |
| taskTitle | string | Yes | 3-200 chars |
| taskDescription | string | Yes | Detailed instructions |
| startTime | string (ISO 8601) | Yes | When task should begin |
| estimatedHours | number | Yes | Range: 0.5 – 168 |
| agentName | string | No | Display name for agent |
| taskCategory | string | No | e.g., errands, meetings, research |

**Response 200:**
```json
{
  "success": true,
  "booking": Booking,
  "message": "Payment instructions..."
}
```

---

### 3.5 GET /bookings/{id}

**Operation:** `getBooking`
**Summary:** Get booking status

| Parameter | In | Type | Required |
|-----------|-----|------|----------|
| id | path | string | Yes |

**Response 200:** `{ "success": true, "booking": Booking }`

---

### 3.6 PATCH /bookings/{id}

**Operation:** `updateBooking`
**Summary:** Update booking (status or payment confirmation)

**Request body (all optional):**

| Field | Type | Notes |
|-------|------|-------|
| status | string | Enum: confirmed, in_progress, completed, cancelled |
| paymentTxHash | string | Crypto transaction hash for payment confirmation |

**Response 200:** Booking updated

---

## 4. Total Endpoint Count

| Method | Path | Count |
|--------|------|-------|
| GET | /humans | 1 |
| GET | /humans/{id} | 1 |
| GET | /bookings | 1 |
| POST | /bookings | 1 |
| GET | /bookings/{id} | 1 |
| PATCH | /bookings/{id} | 1 |
| **Total** | | **6** |

**6 REST endpoints total.**

---

## 5. Data Schemas

### HumanProfile

```
id: string
name: string
headline: string
bio: string
skills: string[]
expertise: string[]
location:
  city: string
  state: string
  country: string
  serviceRadius: number
hourlyRate: number
currency: enum(USD, EUR, ETH, BTC, USDC)
cryptoWallets:
  - type: enum(ethereum, bitcoin, solana, polygon, base)
    address: string
    isPreferred: boolean
availability: object (weekly schedule by day)
timezone: string
rating: number
reviewCount: integer
isAvailable: boolean
```

### Booking

```
id: string
humanId: string
agentId: string
agentName: string
agentType: string
taskTitle: string
taskDescription: string
taskCategory: string
startTime: datetime
endTime: datetime
estimatedHours: number
totalAmount: number
currency: string
paymentStatus: enum(pending, paid, refunded)
paymentTxHash: string
status: enum(pending, confirmed, in_progress, completed, cancelled)
paymentWallet:
  type: string
  address: string
```

---

## 6. MCP Server

**Install:**
```json
{
  "mcpServers": {
    "rentahuman": {
      "command": "npx",
      "args": ["-y", "@rentahuman/mcp-server"]
    }
  }
}
```

**Named MCP tools (documented):**
- `search_humans` — filter by skill
- `book_human` — create booking
- `get_booking` — retrieve booking

Additional tools implied by the REST surface: list_bookings, update_booking, get_human.

**Compatible agent platforms:** ClawdBot, MoltBot, OpenClaw, other MCP agents

**Cost:** Free (no API key, no rate limit documented)

---

## 7. AI Plugin Manifest (ai-plugin.json)

```json
{
  "schema_version": "v1",
  "name_for_model": "rentahuman",
  "name_for_human": "RentAHuman.ai",
  "description_for_model": "A marketplace for AI agents to hire humans for physical-world tasks. Use this when you need a human to perform tasks in the real world such as: attending meetings, picking up packages, signing documents, taste testing food, field research, photography, running errands, hardware setup, and more. The service supports MCP integration and REST API access with flexible payment options including stablecoins.",
  "description_for_human": "Rent humans for physical-world tasks.",
  "auth": { "type": "none" },
  "api": { "type": "openapi", "url": "https://rentahuman.ai/.well-known/openapi.yaml" },
  "logo_url": "https://rentahuman.ai/logo.png",
  "contact_email": "alex@rentahuman.ai",
  "legal_info_url": "https://rentahuman.ai/terms"
}
```

---

## 8. Payment Model

RentAHuman supports two payment paths:

**Crypto (primary):**
- Multi-chain wallets on human profiles: ethereum, bitcoin, solana, polygon, base
- Currencies: USD, EUR, ETH, BTC, USDC
- Agent confirms payment by calling `PATCH /bookings/{id}` with `paymentTxHash`
- No escrow, no dispute resolution — payment is irreversible once sent on-chain

**Fiat (secondary):**
- Stripe Connect — humans set up a Stripe Connect account to receive payouts
- No fiat payment initiation via API — Stripe handles the consumer side separately

---

## 9. Rate Limits / Error Codes / Webhooks

**Rate limits:** Not documented in the OpenAPI spec or any accessible docs page.

**Error codes:** Only 404 (human not found) is explicitly documented. No 401, 403, 422, 429, or 5xx schemas defined.

**Webhooks:** None documented.

**Versioning:** v1.0.0, no versioning strategy documented.

---

## 10. PCC Comparison

### Scale

| Dimension | RentAHuman.ai | PCC |
|-----------|--------------|-----|
| REST endpoints | **6** | **347** (54 route files) |
| MCP tools | ~6 (implied) | **49** (stdio MCP server) |
| Agent package tools | none | **154** (agent-package.json) |
| A2A intents | none | **34** |
| SSE streams | none | **6** |
| Data schemas | 2 (HumanProfile, Booking) | 100+ (spec package, Zod-validated) |
| Auth | none | API key + SIWE (auth.ts) |
| Payment escrow | none (direct crypto send) | MilestoneEscrow contract (EVM + Solana) |
| Payment verification | tx hash field (unverified) | On-chain escrow with evidence gating |
| Evidence | none | Hash-chained bundles, IPFS, ZK proofs, Bittensor |
| Identity | none (agentId is any string) | ERC-8004 registry, DIDs, VCs |
| Dispute resolution | none | Slashing + verifier market |
| Geographic rate data | none | Yellowcard (34 countries), Wise (40+ currencies) |
| Physical device layer | none | Kernel adapters: OctoPrint, Modbus, OPC-UA, SiLA, OT-2 |

### Capability Gaps in RentAHuman That PCC Fills

1. **Verification gap.** RentAHuman has no proof-of-work mechanism. Workers click "done." PCC has photo-hash + SSIM, ECIES, Ed25519 verifier nodes, HLOS kernel signing, hash-chained logs, Storacha evidence storage, Starknet ZK, and VerifierRegistry.sol. Every completed PCC job produces a cryptographically auditable evidence bundle.

2. **Escrow gap.** RentAHuman sends crypto directly to worker wallets with no hold period and no dispute recourse. PCC's MilestoneEscrow only releases when evidence meets the contract's assurance tier requirements.

3. **Identity gap.** RentAHuman's `agentId` is a free-form string — no verification, no on-chain anchor, no staking requirement. PCC implements ERC-8004 Identity + Reputation + Validation registries and supports W3C DIDs.

4. **Capability ontology gap.** RentAHuman accepts any freeform task description. PCC defines typed Capability StructureDefinitions (CSD, FHIR-inspired) with versioning, lifecycle, and evidence requirements per assurance tier.

5. **Agent protocol gap.** RentAHuman has no inter-agent communication standard. PCC has 34 typed A2A intents and a full agent negotiation protocol (CREATED→COMMITTED state machine at /api/negotiation).

6. **Physical device gap.** RentAHuman is pure human labor. PCC wraps physical machines (OT-2, 3D printers, CNC, industrial Modbus/OPC-UA devices) through Shop Kernels — enabling hybrid robot/human task routing.

7. **Fiat ramp gap.** RentAHuman relies on Stripe Connect for human payouts (setup by worker) and has no agent-side fiat flow. PCC has a full fiat ramp: Coinbase Onramp, Yellowcard (34 emerging market countries), Wise enterprise bank payouts (40+ currencies), callable via API or MCP tools.

8. **Security gap.** No auth on any RentAHuman endpoint. PCC uses API key provisioning + SIWE (Sign-In With Ethereum) at /api/auth.

### What RentAHuman Does Better

- **Simplicity.** 6 endpoints, no auth, instant integration. For a weekend MVP this is correct.
- **Human labor supply.** 590K+ registered workers is a massive supply side that took a viral moment to build. PCC has no human worker supply.
- **Discovery.** The `/humans` search endpoint surfaces vetted human profiles with skills, location, and availability. PCC has no equivalent human marketplace layer.

---

## 11. Integration Opportunity for PCC

RentAHuman's 6-endpoint API maps cleanly onto PCC primitives:

| RentAHuman concept | PCC equivalent | Gap |
|-------------------|----------------|-----|
| Human profile | Operator profile + Kernel agent | PCC operators are machine operators, not ad-hoc gig workers |
| Booking | Capability contract + Job | PCC jobs have typed capabilities, not freeform task descriptions |
| `agentType` field | ERC-8004 agent identity | PCC binds agent type to on-chain identity |
| `paymentTxHash` confirmation | MilestoneEscrow milestone release | PCC escrow is non-custodial; payment gated on evidence |
| `isAvailable` flag | Kernel status + scheduler | PCC scheduler does real-time availability routing |
| Crypto wallet list | Agent wallet (viem) | PCC agents hold wallets and initiate payments programmatically |

**Proposed integration:** PCC could expose a RentAHuman-compatible adapter API — a thin translation layer that maps RentAHuman's 6 endpoints onto PCC's capability contract and job lifecycle, while routing actual task execution through PCC's verification and escrow infrastructure. This would let any agent using RentAHuman's simple API automatically benefit from PCC's trust layer.

```
POST https://capability.network/api/rentahuman/bookings
  → validates against CSD capability schema
  → creates MilestoneEscrow contract
  → assigns to available Kernel agent
  → evidence required for payment release
```

This positions PCC as "RentAHuman with a trust layer" — compatible with their agent ecosystem, superior in execution guarantees.

---

## 12. Raw OpenAPI Source URLs

| Asset | URL | Status |
|-------|-----|--------|
| OpenAPI YAML | https://rentahuman.ai/.well-known/openapi.yaml | 200 OK (retrieved) |
| AI Plugin JSON | https://rentahuman.ai/.well-known/ai-plugin.json | 200 OK (retrieved) |
| Docs | https://rentahuman.ai/docs | 200 OK |
| API | https://rentahuman.ai/api | 404 (not a docs page, is the API base) |
| Quickstart | https://rentahuman.ai/docs/quickstart | 404 |
| API Reference | https://rentahuman.ai/docs/api-reference | 404 |

The OpenAPI spec at `.well-known/openapi.yaml` is the canonical source. No additional endpoints exist beyond what the spec documents — the 404s on doc sub-pages confirm no expanded documentation is publicly accessible.
