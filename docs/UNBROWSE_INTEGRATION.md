# Unbrowse Integration — Technical Documentation

> PCC × Unbrowse: Direct API access for AI agents, 100x faster than browser automation.
> Updated: 2026-03-20

## Overview

Unbrowse gives PCC agents the ability to interact with any website's underlying APIs
without headless browser automation. Instead of clicking through UIs, agents make
direct API calls — reducing interaction time from 5-30s to 50-200ms and token usage
from ~8,000 to ~200 tokens per action.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  PCC Agent Layer                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │UserAgent │  │BrokerAgent│  │KernelAgent│                 │
│  └────┬─────┘  └────┬─────┘  └────┬──────┘                 │
│       │              │              │                        │
│       └──────────────┴──────────────┘                        │
│                      │                                       │
│              ┌───────┴────────┐                              │
│              │ UnbrowseClient │  (packages/agent-runtime)    │
│              └───────┬────────┘                              │
└──────────────────────┼──────────────────────────────────────┘
                       │ HTTP
              ┌────────┴─────────┐
              │ Unbrowse Server  │  (localhost:6969)
              │ Three-tier:      │
              │  1. Marketplace  │──→ beta-api.unbrowse.ai
              │  2. Live Capture │──→ Headless browser → API discovery
              │  3. DOM Fallback │──→ Structured HTML extraction
              └──────────────────┘
```

### Hackathon Track Alignment

This integration targets the **Agentic Funding and Coordination Track**:

| Requirement | PCC Implementation |
|---|---|
| Unbrowse as data/action layer | UnbrowseClient in agent-runtime, used by all 3 agent types |
| Autonomous decision-making | BrokerAgent routes based on real market data from Unbrowse |
| Real execution | On-chain settlement via MilestoneEscrow + DePIN rewards |
| Multi-agent coordination | Shared skill registry via A2A MessageBus |
| On-chain integration | Escrow, soulbound cNFTs, Starknet ZK anchoring |

## Setup

### Prerequisites

```bash
# Install Unbrowse globally
npm install -g unbrowse

# Run setup (registers agent, accepts ToS, starts server)
unbrowse setup

# Or start manually
UNBROWSE_ACCEPT_TOS=1 bun src/index.ts
```

### Environment Variables

```bash
# Unbrowse server URL (default: http://localhost:6969)
UNBROWSE_URL=http://localhost:6969
```

### PCC Configuration

Agents auto-detect Unbrowse via `UNBROWSE_URL` env var or constructor option:

```typescript
// Via env var (all agents auto-detect)
process.env.UNBROWSE_URL = "http://localhost:6969";

// Via constructor option
const broker = new BrokerAgent(bus, walletConfig, {
  gatewayUrl: "http://localhost:3200",
  unbrowseUrl: "http://localhost:6969",
});
```

## Unbrowse API Reference

### Core Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Server health check |
| `/v1/intent/resolve` | POST | Resolve an intent (main entry point) |
| `/v1/search` | POST | Search marketplace for skills |
| `/v1/skills/{id}/execute` | POST | Execute a specific skill |
| `/v1/feedback` | POST | Rate a skill (1-5) |
| `/v1/auth/login` | POST | Handle auth for protected sites |

### Intent Resolution (`POST /v1/intent/resolve`)

```json
{
  "intent": "get CNC machining quotes for aluminum 6061",
  "params": { "url": "https://xometry.com" },
  "context": { "url": "https://xometry.com" },
  "dry_run": true
}
```

Response:
```json
{
  "skill_id": "sk_abc123",
  "data": { /* API response data */ },
  "source": "marketplace",
  "endpoint": {
    "method": "GET",
    "url": "https://xometry.com/api/v2/quotes"
  }
}
```

### Search (`POST /v1/search`)

```json
{
  "intent": "3D printing service pricing",
  "k": 10
}
```

Response:
```json
{
  "results": [
    {
      "id": "sk_xyz",
      "intent": "get 3D printing quotes",
      "domain": "xometry.com",
      "confidence": 0.92,
      "metadata": {
        "reliability": 0.95,
        "freshness": 0.88,
        "verified": true
      }
    }
  ],
  "total": 15
}
```

### Three-Tier Resolution

1. **Marketplace Search** — Semantic vector matching ranks candidates using:
   `score = similarity × reliability × freshness × verification_bonus`
   Response time: 50-200ms

2. **Live Capture** — If no marketplace match:
   - Launch headless browser
   - Record network traffic
   - Reverse-engineer API endpoints
   - Publish skill to marketplace
   Response time: 5-30s (first time), then cached

3. **DOM Fallback** — For static sites without API endpoints:
   - Extract structured data from rendered HTML
   Response time: 1-5s

## Integration 1: BrokerAgent — Market-Aware Routing

The BrokerAgent uses Unbrowse to pull real market data from external suppliers,
enabling pricing comparisons and intelligent capability routing.

### New Intent Handlers

| Intent | Handler | Description |
|---|---|---|
| `unbrowse_query` | `handleUnbrowseQuery()` | Query external data sources |
| `unbrowse_share_skill` | `handleUnbrowseShareSkill()` | Register + broadcast discovered skills |

### New Tools

| Tool | Description |
|---|---|
| `search_unbrowse` | Search marketplace for external capabilities/pricing |
| `resolve_supplier` | Fetch real-time data from a specific supplier URL |
| `list_shared_skills` | List all skills shared by agents on this network |

### Usage Pattern

```typescript
const broker = new BrokerAgent(bus, walletConfig, {
  unbrowseUrl: "http://localhost:6969",
});

// Agent queries external pricing
await userAgent.send(broker.id, {
  type: "unbrowse_query",
  query: "CNC machining quotes for aluminum 6061 bracket",
  targetUrl: "https://xometry.com",
  dryRun: true,
});
// → Broker resolves via Unbrowse, returns UnbrowseResultIntent
```

### Shared Skill Registry

The BrokerAgent maintains a shared skill registry. When any agent discovers
a useful Unbrowse skill, it can share it with the network:

```
Agent A discovers API for McMaster-Carr pricing
  → Sends unbrowse_share_skill to Broker
  → Broker adds to sharedSkills registry
  → Broker broadcasts unbrowse_skill_shared to all agents
  → Agent B can now use the same skill without re-discovering
```

## Integration 2: UserAgent — Capability Discovery Beyond PCC

The UserAgent uses Unbrowse to discover manufacturing capabilities outside
the PCC network when internal options are insufficient.

### New Methods

| Method | Description |
|---|---|
| `searchExternal(query, opts?)` | Search for capabilities outside PCC via broker |
| `shareSkill(skillId, domain, intent)` | Share a discovered skill with the network |
| `searchUnbrowseDirect(query)` | Direct local Unbrowse search (bypasses broker) |

### New Tools

| Tool | Description |
|---|---|
| `search_external` | Search for external manufacturing capabilities |
| `share_skill` | Share a discovered skill with all network agents |

### New Notification Types

| Type | Trigger |
|---|---|
| `unbrowse_results` | Unbrowse query results received from broker |
| `unbrowse_skill_shared` | Another agent shared a new skill |

### Usage Pattern

```typescript
const user = new UserAgent(bus, walletConfig, {
  unbrowseUrl: "http://localhost:6969",
});

// Search external suppliers
await user.searchExternal("injection molding for ABS housing", {
  targetUrl: "https://protolabs.com",
});

// Direct search (no broker needed)
const results = await user.searchUnbrowseDirect("3D printing in nylon");

// Share a useful discovery
await user.shareSkill("sk_abc123", "xometry.com", "get CNC quotes");
```

## Integration 3: Multi-Agent Shared Registry

Agents share discovered API endpoints via the A2A MessageBus, collectively
becoming smarter as they explore the web.

### New A2A Intent Types

```typescript
// Agent requests external data
interface UnbrowseQueryIntent {
  type: "unbrowse_query";
  query: string;
  targetUrl?: string;
  maxResults?: number;
  dryRun?: boolean;
}

// Response with Unbrowse results
interface UnbrowseResultIntent {
  type: "unbrowse_result";
  query: string;
  results: Array<{
    skillId: string;
    domain: string;
    intent: string;
    confidence: number;
    data?: unknown;
    source?: "marketplace" | "capture" | "dom_fallback";
  }>;
  totalResults: number;
  durationMs: number;
}

// Share a discovered skill
interface UnbrowseShareSkillIntent {
  type: "unbrowse_share_skill";
  skillId: string;
  domain: string;
  intent: string;
  discoveredBy: string;
  discoveredAt: string;
}

// Acknowledgement
interface UnbrowseSkillSharedIntent {
  type: "unbrowse_skill_shared";
  skillId: string;
  networkReach: number;
}
```

### Flow

```
1. UserAgent discovers skill via searchExternal()
2. UserAgent calls shareSkill() → sends unbrowse_share_skill to BrokerAgent
3. BrokerAgent adds to sharedSkills registry
4. BrokerAgent broadcasts unbrowse_skill_shared to all connected agents
5. Next time any agent needs that skill, it's already in the registry
6. BrokerAgent can also use the skill for market-aware routing decisions
```

## Integration 4: KernelAgent — Supply Chain Automation

The KernelAgent uses Unbrowse to monitor supplier portals for stock levels,
pricing changes, and lead time updates.

### New Config Options

```typescript
interface KernelAgentConfig {
  // ... existing fields ...
  unbrowseUrl?: string;        // Unbrowse server URL
  supplierUrls?: string[];     // Supplier URLs to monitor
}
```

### New Tools

| Tool | Description |
|---|---|
| `check_supplier` | Check a specific supplier for stock/pricing |
| `monitor_suppliers` | Check ALL configured suppliers for a material |
| `search_materials` | Search Unbrowse marketplace for material vendors |

### Usage Pattern

```typescript
const kernel = new KernelAgent(bus, {
  kernelId: "kernel_lab_sf",
  name: "SF Fab Lab",
  location: { lat: 37.7749, lng: -122.4194 },
  capabilities: [...],
  unbrowseUrl: "http://localhost:6969",
  supplierUrls: [
    "https://mcmaster.com",
    "https://digikey.com",
    "https://matterhackers.com",
  ],
});

// Check a specific supplier
await kernel.executeTool("check_supplier", {
  url: "https://matterhackers.com",
  query: "PLA filament 1.75mm 1kg spool price",
});

// Monitor all suppliers for a material
await kernel.executeTool("monitor_suppliers", {
  material: "PLA filament 1.75mm",
});
```

## Files Modified

| File | Changes |
|---|---|
| `packages/agent-runtime/src/unbrowse-client.ts` | **NEW** — UnbrowseClient HTTP service (direct + gateway mode) |
| `packages/agent-runtime/src/index.ts` | Export UnbrowseClient |
| `packages/a2a/src/types.ts` | 4 new intent types (Unbrowse*) |
| `packages/agent-broker/src/broker-agent.ts` | Unbrowse client + 2 handlers + 3 tools + shared registry |
| `packages/agent-user/src/user-agent.ts` | Unbrowse client + 3 methods + 2 handlers + 2 tools |
| `packages/agent-kernel/src/kernel-agent.ts` | Unbrowse client + 3 tools + supplier config |
| `packages/gateway/src/routes/unbrowse.ts` | **NEW** — Gateway proxy routes (7 endpoints) |
| `packages/gateway/src/server.ts` | Register unbrowseRoutes |
| `packages/gateway/src/routes/onboard.ts` | Add `unbrowse_api` to agent onboard config |
| `apps/dashboard/public/unbrowse-skills.json` | Add `unbrowse_proxy` section with gateway endpoints |

## Gateway Proxy (Network-Wide Access)

The gateway proxies Unbrowse so agents anywhere on the network can use it
without running their own local Unbrowse instance.

### Architecture

```
┌────────────────────────┐     ┌──────────────────────────────────────────┐
│  Remote Agent          │     │  PCC Gateway (Railway)                   │
│  (any machine)         │     │                                         │
│                        │ HTTP│  /api/unbrowse/health   ──┐             │
│  UnbrowseClient        ├────→│  /api/unbrowse/search   ──┤  proxy to   │
│  (gateway mode)        │     │  /api/unbrowse/resolve  ──┼→ Unbrowse   │
│                        │     │  /api/unbrowse/execute  ──┤  server     │
│                        │     │  /api/unbrowse/feedback ──┘             │
│                        │     │                                         │
│                        │     │  /api/unbrowse/skills      (shared      │
│                        │     │  /api/unbrowse/skills/share  registry)  │
└────────────────────────┘     └──────────────────────────────────────────┘
```

### Gateway Routes

| Route | Method | Description |
|---|---|---|
| `/api/unbrowse/health` | GET | Check if Unbrowse is reachable through gateway |
| `/api/unbrowse/search` | POST | Search marketplace for skills |
| `/api/unbrowse/resolve` | POST | Resolve intent (search → capture → execute) |
| `/api/unbrowse/execute/:skillId` | POST | Execute a specific skill |
| `/api/unbrowse/feedback` | POST | Submit skill feedback (1-5) |
| `/api/unbrowse/skills` | GET | List skills shared through this gateway |
| `/api/unbrowse/skills/share` | POST | Share a discovered skill with the network |

### Agent Configuration

Agents receive the gateway proxy URL in their onboard config:

```json
{
  "agent_config": {
    "unbrowse_skills": "https://pcc-gateway-production.up.railway.app/unbrowse-skills.json",
    "unbrowse_api": "https://pcc-gateway-production.up.railway.app/api/unbrowse"
  }
}
```

### UnbrowseClient Gateway Mode

The client auto-detects gateway mode when the URL contains `/api/unbrowse`:

```typescript
// Direct mode (local Unbrowse)
const direct = new UnbrowseClient({ serverUrl: "http://localhost:6969" });

// Gateway mode (auto-detected)
const gateway = new UnbrowseClient({
  serverUrl: "https://pcc-gateway-production.up.railway.app/api/unbrowse"
});

// Gateway mode (explicit)
const explicit = new UnbrowseClient({
  serverUrl: "https://gateway.example.com/api/unbrowse",
  gatewayMode: true,
});
```

Path mapping (transparent to the caller):

| Client calls | Direct path | Gateway path |
|---|---|---|
| `isAvailable()` | `/health` | `/health` |
| `search()` | `/v1/search` | `/search` |
| `resolve()` | `/v1/intent/resolve` | `/resolve` |
| `executeSkill()` | `/v1/skills/:id/execute` | `/execute/:id` |
| `feedback()` | `/v1/feedback` | `/feedback` |

### Deployment

Set `UNBROWSE_URL` on the gateway server to point to the Unbrowse instance:

```bash
# On the Railway deployment
UNBROWSE_URL=http://localhost:6969   # if Unbrowse runs alongside gateway
UNBROWSE_URL=http://10.0.0.5:6969   # if Unbrowse runs on a different host
```

### Production Options

| Setup | Description | Best For |
|---|---|---|
| **Same host** | Gateway + Unbrowse on same Railway instance | Hackathon demo |
| **Sidecar** | Unbrowse as a Docker sidecar to the gateway | Small deployments |
| **Dedicated** | Unbrowse on its own host, gateway proxies | Scale/isolation |
| **Per-kernel** | Each kernel runs local Unbrowse + shares via gateway | Distributed capture |

## Existing Integration (Pre-existing)

| File | What It Does |
|---|---|
| `apps/dashboard/public/unbrowse-skills.json` | Skill manifest (18 PCC endpoints) |
| `scripts/register-unbrowse.ts` | CLI to register PCC skills with Unbrowse |
| `packages/gateway/src/routes/onboard.ts:182` | Onboarding hands agents the `unbrowse_skills` URL |

## Critical Rules

1. **Always use `dry_run: true`** for read-only queries (pricing, stock checks)
2. **Confirm auth** before querying gated supplier sites
3. **Report broken skills** via `feedback()` to improve network-wide reliability
4. **Share useful skills** — the more agents share, the smarter the network gets
5. **Credentials stay local** — Unbrowse runs on localhost, no cloud proxy
